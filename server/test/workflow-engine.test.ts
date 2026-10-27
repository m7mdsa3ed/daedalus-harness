// Self-check for the v2 engine's pure core (src/workflows/drive.ts): key
// computation, replay from the journal, occurrence counting, budgets, slots,
// parallel/map fan-out, resume from another run, deterministic step names and
// the mapping of a script's end to a run status.
//
// No database, no agent, no session manager: the store is an in-memory journal
// (a `RunStore`) and the step runner is a fake that records what it was asked
// to run and journals its own `step_*` events the way step.ts does.
// The WorkflowEngine lifecycle tests at the end import engine.ts, which opens the (scratch) database.
// Run: pnpm test:workflow-engine
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { stepTitle } from "../src/workflows/titles.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetTracker, FlowScheduler } from "../src/workflows/limits.js";
import {
  BudgetExceeded,
  drive,
  replayIndex,
  sanitizeStepName,
  usageOf,
  wallSecOf,
  type DriveOptions,
  type RunStore,
  type StepCall,
  type StepOutcome,
  type StepRunner,
} from "../src/workflows/drive.js";
import { foldRun } from "../src/workflows/fold.js";
import {
  ENGINE_LIMITS,
  callHash,
  keyFields,
  stepKey,
  type AgentSpec,
  type Budgets,
  type JournalEvent,
  type JournalPayload,
  type RunSpec,
  type RunStatus,
} from "../src/workflows/types.js";

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
}

// ---- fakes --------------------------------------------------------------------

/** An in-memory `RunStore`: the journal of every run, append-only with gapless seqs. */
class FakeStore implements RunStore {
  journals = new Map<string, JournalEvent[]>();
  headers = new Map<string, Awaited<ReturnType<RunStore["header"]>>>();
  now = 1_000;
  async createRun(row: Parameters<RunStore["createRun"]>[0]) {
    const event: JournalEvent = { runId: row.id, seq: 1, at: row.createdAt, key: null, payload: { kind: "run_started", spec: row.spec } };
    this.journals.set(row.id, [event]);
    this.headers.set(row.id, { ...row, status: "running", error: null, result: null, endedAt: null });
    return event;
  }
  async append(runId: string, key: string | null, payload: JournalPayload) {
    const list = this.journals.get(runId) ?? [];
    this.journals.set(runId, list);
    const event: JournalEvent = { runId, seq: list.length + 1, at: (this.now += 1), key, payload };
    list.push(event);
    return event;
  }
  async events(runId: string, since = 0) {
    return (this.journals.get(runId) ?? []).filter((e) => e.seq > since);
  }
  async header(runId: string) {
    return this.headers.get(runId) ?? null;
  }
  async setStatus(_id: string, _status: RunStatus, _error?: string | null, _endedAt?: number | null, _result?: unknown): Promise<void> {}
  async listRunsForParent() {
    return [];
  }
  async runningRuns(): Promise<NonNullable<Awaited<ReturnType<RunStore["header"]>>>[]> {
    return [];
  }
}

const META = "export const meta = { name: 'demo', description: 'a demo' };\n";

function specOf(body: string, over: Partial<RunSpec> = {}): RunSpec {
  return {
    source: META + body,
    meta: { name: "demo", description: "a demo", phases: [] },
    args: null,
    budgets: {},
    flow: {},
    trigger: { kind: "agent" },
    onRestart: "resume",
    ...over,
  };
}

interface Harness {
  store: FakeStore;
  runId: string;
  calls: StepCall[];
  started: string[];
  maxLive: { n: number };
  run(over?: Partial<DriveOptions>): ReturnType<typeof drive>;
  events(): JournalEvent[];
  view(): ReturnType<typeof foldRun>;
}

interface HarnessOpts {
  spec: RunSpec;
  /** What a step answers; default `out:<label>`. */
  reply?: (spec: AgentSpec, call: StepCall) => unknown | Promise<unknown>;
  /** Tokens each step reports. */
  tokens?: number;
  delayMs?: number;
  store?: FakeStore;
  runId?: string;
  priorEvents?: JournalEvent[];
  globalMax?: number;
}

async function harness(o: HarnessOpts): Promise<Harness> {
  const store = o.store ?? new FakeStore();
  const runId = o.runId ?? "run-1";
  if (!store.journals.has(runId)) await store.createRun({ id: runId, parentSessionId: "p", projectId: null, name: "demo", spec: o.spec, notify: false, createdAt: 1 });
  const calls: StepCall[] = [];
  const started: string[] = [];
  const live = { n: 0 };
  const maxLive = { n: 0 };
  const scheduler = new FlowScheduler(o.globalMax ?? 16);
  const abort = new AbortController();

  /* The fake runner journals what step.ts journals: step_started, then
     step_completed (or step_failed when the reply throws). */
  const runStep: StepRunner = async (call): Promise<StepOutcome> => {
    calls.push(call);
    started.push(call.name);
    live.n += 1;
    maxLive.n = Math.max(maxLive.n, live.n);
    try {
      await call.append({ kind: "step_started", name: call.name, phase: call.spec.phase, sessionId: `child-${call.name}`, attempt: 1, startedAt: 1 });
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      let output: unknown;
      try {
        output = o.reply ? await o.reply(call.spec, call) : `out:${call.spec.label}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await call.append({ kind: "step_failed", name: call.name, error: message, sessionId: `child-${call.name}`, tokens: o.tokens ?? 0, toolUses: 0 });
        throw Object.assign(new Error(message), { tokens: o.tokens ?? 0 });
      }
      const tokens = o.tokens ?? 0;
      await call.append({ kind: "step_completed", name: call.name, output, sessionId: `child-${call.name}`, tokens, toolUses: 1 });
      return { output, sessionId: `child-${call.name}`, tokens, toolUses: 1 };
    } finally {
      live.n -= 1;
    }
  };

  const make = (over: Partial<DriveOptions> = {}): DriveOptions => {
    const tracker = over.tracker ?? new BudgetTracker(o.spec.budgets);
    const events = store.journals.get(runId)!;
    return {
      runId,
      spec: o.spec,
      append: (key, payload) => store.append(runId, key, payload),
      events: () => events,
      ...(o.priorEvents ? { priorEvents: o.priorEvents } : {}),
      runStep,
      scheduler,
      tracker,
      gateHooks: {
        approve: async () => null,
        sleep: async () => {},
        until: async () => {},
        waitFor: async () => null,
        sh: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        artifact: async () => {},
        setState: () => {},
        getState: () => undefined,
      },
      signal: abort.signal,
      whenRunning: async () => {},
      ...over,
    };
  };

  return {
    store,
    runId,
    calls,
    started,
    maxLive,
    run: (over) => drive(make(over)),
    events: () => store.journals.get(runId)!,
    view: () =>
      foldRun(
        { id: runId, name: "demo", status: "running", error: null, createdAt: 1, endedAt: null, spec: o.spec },
        store.journals.get(runId)!,
      ),
  };
}

const keyOf = (spec: Partial<AgentSpec> & { prompt: string }, occurrence = 0): string =>
  stepKey(callHash(keyFields({ label: "x", phase: null, ...spec } as AgentSpec)), occurrence);

// ---- tests ----------------------------------------------------------------------

await test("a plain run: steps run, the result is returned, the journal holds them", async () => {
  const h = await harness({ spec: specOf("const a = await agent('one', {label: 'a'}); const b = await agent('two', {label: 'b'}); return {a, b};") });
  const out = await h.run();
  assert.equal(out.status, "completed");
  assert.deepEqual(out.result, { a: "out:a", b: "out:b" });
  assert.deepEqual(h.started, ["a", "b"]);
  const view = h.view();
  assert.deepEqual(view.steps.map((s) => [s.name, s.status]), [["a", "completed"], ["b", "completed"]]);
});

await test("keys: stepKey(callHash(keyFields(spec)), occurrence) is what the journal is keyed by", async () => {
  const h = await harness({ spec: specOf("await agent('same'); await agent('same'); await agent('other'); return null;") });
  await h.run();
  const keys = h.calls.map((c) => c.key);
  assert.equal(keys[0], keyOf({ prompt: "same", label: "agent-1" }, 0));
  assert.equal(keys[1], keyOf({ prompt: "same", label: "agent-2" }, 1));
  assert.equal(keys[2], keyOf({ prompt: "other", label: "agent-3" }, 0));
  // The label is not part of the key: the same prompt with another label is the same call.
  assert.equal(keyOf({ prompt: "same", label: "foo" }, 0), keyOf({ prompt: "same", label: "bar" }, 0));
});

await test("occurrence counting: repeated identical calls get #0, #1, #2 and all run", async () => {
  const h = await harness({
    spec: specOf("const r = []; for (let i = 0; i < 3; i++) r.push(await agent('ping', {label: 'p'})); return r;"),
    reply: (_s, c) => `answer@${c.key.split("#")[1]}`,
  });
  const out = await h.run();
  assert.deepEqual(out.result, ["answer@0", "answer@1", "answer@2"]);
  assert.equal(new Set(h.calls.map((c) => c.key)).size, 3);
});

await test("replay: completed keys answer from the journal WITHOUT calling the runner", async () => {
  const spec = specOf("const a = await agent('one', {label: 'a'}); const b = await agent('two', {label: 'b'}); return [a, b];");
  const first = await harness({ spec });
  await first.run();
  assert.equal(first.calls.length, 2);

  // The same journal, a fresh process: nothing may run.
  const second = await harness({ spec, store: first.store, runId: first.runId });
  const before = first.events().length;
  const out = await second.run({ tracker: new BudgetTracker({}) });
  assert.equal(out.status, "completed");
  assert.deepEqual(out.result, ["out:a", "out:b"]);
  assert.equal(second.calls.length, 0, "no step may run again");
  assert.equal(first.events().length, before, "a pure replay writes nothing");
});

await test("replay does not count a replayed step as an agent (budgets.agents)", async () => {
  const spec = specOf("await agent('one'); await agent('two'); await agent('three'); return 1;", { budgets: { agents: 3 } });
  const first = await harness({ spec });
  await first.run();
  const second = await harness({ spec, store: first.store, runId: first.runId });
  const tracker = new BudgetTracker({ agents: 3 });
  await second.run({ tracker });
  assert.equal(tracker.usage().agents, 0);
});

await test("a partial journal: the done step is served, only the missing one runs", async () => {
  const spec = specOf("const a = await agent('one', {label: 'a'}); const b = await agent('two', {label: 'b'}); return [a, b];");
  const first = await harness({ spec });
  await first.run();
  // Cut the journal after step a completed (as a crash would).
  const journal = first.store.journals.get(first.runId)!;
  const cut = journal.findIndex((e) => e.payload.kind === "step_started" && e.payload.name === "b");
  journal.splice(cut);
  const second = await harness({ spec, store: first.store, runId: first.runId });
  const out = await second.run();
  assert.deepEqual(out.result, ["out:a", "out:b"]);
  assert.deepEqual(second.started, ["b"]);
});

await test("an in-flight step (step_started, no outcome) reaches the runner as `recovered`", async () => {
  const spec = specOf("return await agent('long job', {label: 'job'});");
  const store = new FakeStore();
  await store.createRun({ id: "run-1", parentSessionId: "p", projectId: null, name: "demo", spec, notify: false, createdAt: 1 });
  const key = keyOf({ prompt: "long job", label: "job" }, 0);
  await store.append("run-1", key, { kind: "step_started", name: "job", phase: null, sessionId: "child-old", attempt: 2, startedAt: 5 });
  const h = await harness({ spec, store });
  const tracker = new BudgetTracker({ agents: 1 });
  tracker.seed(usageOf(store.journals.get("run-1")!));
  await h.run({ tracker });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].recovered, { sessionId: "child-old", attempt: 2 });
  assert.equal(h.calls[0].name, "job");
  // The agent was counted before the restart (seeded), not again.
  assert.equal(tracker.usage().agents, 1);
});

await test("a journaled failure replays as the same failure (the script may have branched on it)", async () => {
  const spec = specOf("try { await agent('boom', {label: 'b'}); return 'ok'; } catch (e) { return 'caught:' + e.message; }");
  const first = await harness({ spec, reply: () => { throw new Error("nope"); } });
  assert.equal((await first.run()).result, "caught:nope");
  const second = await harness({ spec, store: first.store, runId: first.runId, reply: () => "would-succeed-now" });
  assert.equal((await second.run()).result, "caught:nope");
  assert.equal(second.calls.length, 0);
});

await test("deterministic step names: sanitised, numbered on repeat, stable across replays", async () => {
  const body = "await agent('a', {label: 'Fix Bug #1'}); await agent('b', {label: 'Fix Bug #1'}); await agent('c', {label: '123'}); await agent('d', {label: 'Fix Bug #1'}); return 1;";
  const spec = specOf(body);
  const h = await harness({ spec });
  await h.run();
  assert.deepEqual(h.started, ["fix-bug-1", "fix-bug-1-2", "agent-123", "fix-bug-1-3"]);
  assert.equal(sanitizeStepName("  Hello, World!  "), "hello-world");
  assert.equal(sanitizeStepName("x".repeat(80)).length, 40);
  // Replay: the same call order gives the same names (the fold sees the same steps).
  const second = await harness({ spec, store: h.store, runId: h.runId });
  await second.run();
  assert.deepEqual(second.view().steps.map((s) => s.name), ["fix-bug-1", "fix-bug-1-2", "agent-123", "fix-bug-1-3"]);
});

await test("parallel(): concurrent hooks keep call order for keys; results in input order", async () => {
  const h = await harness({
    spec: specOf("const r = await parallel([() => agent('a', {label: 'a'}), () => agent('a', {label: 'a'}), () => agent('b', {label: 'b'})]); return r;"),
    delayMs: 5,
  });
  const out = await h.run();
  assert.deepEqual(out.result, ["out:a", "out:a", "out:b"]);
  assert.deepEqual(h.calls.map((c) => c.key.split("#")[1]), ["0", "1", "0"]);
});

await test("map(): bounded by the script's concurrency AND the run's flow width", async () => {
  const h = await harness({
    spec: specOf("return await map([1,2,3,4,5,6,7,8], (n) => agent('item ' + n, {label: 'i' + n}), {concurrency: 6});", { flow: { concurrency: 3 } }),
    delayMs: 15,
  });
  const out = await h.run();
  assert.equal((out.result as unknown[]).length, 8);
  assert.ok(h.maxLive.n <= 3, `run width 3 must hold, saw ${h.maxLive.n}`);
  assert.ok(h.maxLive.n >= 2, `should actually run side by side, saw ${h.maxLive.n}`);
});

await test("the engine-wide scheduler caps live steps across the run", async () => {
  const h = await harness({
    spec: specOf("return await map([1,2,3,4,5,6], (n) => agent('item ' + n), {concurrency: 6});", { flow: { concurrency: 16 } }),
    delayMs: 10,
    globalMax: 2,
  });
  await h.run();
  assert.ok(h.maxLive.n <= 2, `global max 2 must hold, saw ${h.maxLive.n}`);
});

await test("a failing map item is null, the run completes", async () => {
  const h = await harness({
    spec: specOf("return await map([1,2,3], (n) => agent('item ' + n, {label: 'i' + n}));"),
    reply: (s) => { if (s.prompt.endsWith("2")) throw new Error("bad"); return "ok"; },
  });
  const out = await h.run();
  assert.equal(out.status, "completed");
  assert.deepEqual(out.result, ["ok", null, "ok"]);
});

await test("budget agents: the Nth+1 agent is refused and the run ends budget_exceeded", async () => {
  const spec = specOf("const out = []; for (let i = 0; i < 5; i++) out.push(await agent('step ' + i, {label: 's' + i})); return out;", { budgets: { agents: 2 } });
  const h = await harness({ spec });
  const out = await h.run({ tracker: new BudgetTracker({ agents: 2 }) });
  assert.equal(out.status, "budget_exceeded");
  assert.equal(out.budget, "agents");
  assert.equal(h.calls.length, 2, "no third agent may start");
  assert.match(out.error ?? "", /agents/);
});

await test("budget tokens: crossing it stops NEW agents; the run ends budget_exceeded", async () => {
  const spec = specOf("const out = []; for (let i = 0; i < 5; i++) out.push(await agent('step ' + i, {label: 's' + i})); return out;", { budgets: { tokens: 150 } });
  const h = await harness({ spec, tokens: 100 });
  const out = await h.run({ tracker: new BudgetTracker({ tokens: 150 }) });
  assert.equal(out.status, "budget_exceeded");
  assert.equal(out.budget, "tokens");
  assert.equal(h.calls.length, 2, "100 then 200 tokens: the third is refused");
});

await test("a script that catches the budget error still ends budget_exceeded", async () => {
  const spec = specOf("const out = []; for (let i = 0; i < 4; i++) { try { out.push(await agent('s' + i)); } catch (e) { out.push('stopped'); } } return out;", { budgets: { agents: 1 } });
  const h = await harness({ spec });
  const out = await h.run({ tracker: new BudgetTracker({ agents: 1 }) });
  assert.equal(out.status, "budget_exceeded");
  assert.deepEqual(out.result, ["out:agent-1", "stopped", "stopped", "stopped"]);
});

await test("a failed step is still metered (tokens on the thrown error)", async () => {
  const spec = specOf("try { await agent('x'); } catch (e) {} return 1;");
  const h = await harness({ spec, tokens: 40, reply: () => { throw new Error("x"); } });
  const tracker = new BudgetTracker({});
  await h.run({ tracker });
  assert.equal(tracker.usage().tokens, 40);
});

await test("budget exceeded error class is exported and named", () => {
  const e = new BudgetExceeded("costUsd");
  assert.equal(e.kind, "costUsd");
  assert.equal(e.name, "BudgetExceeded");
});

await test("resumeFromRunId: completed keys come from the OLD journal and are copied into the new one", async () => {
  const spec = specOf("const a = await agent('one', {label: 'a'}); const b = await agent('two', {label: 'b'}); return [a, b];");
  const old = await harness({ spec, runId: "old", reply: (s) => (s.prompt === "two" ? (() => { throw new Error("flaky"); })() : "A") });
  const first = await old.run();
  assert.equal(first.status, "failed");
  // Relaunch: a new run id, the old journal as the answer source. `one` is served, `two` re-runs.
  const fresh = await harness({ spec, runId: "new", priorEvents: old.events(), reply: () => "B" });
  const out = await fresh.run();
  assert.equal(out.status, "completed");
  assert.deepEqual(out.result, ["A", "B"]);
  assert.deepEqual(fresh.started, ["b"], "only the failed step runs");
  const copied = fresh.events().find((e) => e.payload.kind === "step_completed" && e.payload.name === "a");
  assert.ok(copied, "the served answer is written to the new run's own journal");
  // The new journal is self-contained: replaying it alone answers everything.
  const third = await harness({ spec, store: fresh.store, runId: "new" });
  assert.deepEqual((await third.run()).result, ["A", "B"]);
  assert.equal(third.calls.length, 0);
});

await test("resumeFromRunId does not replay a prior FAILURE (a relaunch is how it is retried)", async () => {
  const spec = specOf("return await agent('only');");
  const old = await harness({ spec, runId: "old", reply: () => { throw new Error("down"); } });
  await old.run();
  const fresh = await harness({ spec, runId: "new", priorEvents: old.events(), reply: () => "fixed" });
  const out = await fresh.run();
  assert.equal(out.result, "fixed");
  assert.equal(fresh.calls.length, 1);
});

await test("a continued workflow resumes the FAILED step's own thread, not a fresh one", async () => {
  const spec = specOf("const a = await agent('one', {label: 'a'}); const b = await agent('two', {label: 'b'}); return [a, b];");
  const old = await harness({
    spec,
    runId: "old",
    reply: (s) => {
      if (s.prompt === "two") throw new Error("flaky");
      return "A";
    },
  });
  assert.equal((await old.run()).status, "failed");
  /* The failed attempt journaled its child; the continue must be handed that id
     so the step picks the conversation up instead of beginning again. */
  const failedChild = old
    .events()
    .find((e) => e.payload.kind === "step_failed" && e.payload.name === "b")?.payload as { sessionId: string } | undefined;
  assert.equal(failedChild?.sessionId, "child-b");

  const fresh = await harness({ spec, runId: "new", priorEvents: old.events(), reply: () => "B" });
  await fresh.run();
  const b = fresh.calls.find((c) => c.name === "b");
  assert.ok(b, "the failed step runs again");
  assert.equal(b.resume?.sessionId, "child-b", "on the SAME thread the failed attempt used");
  const a = fresh.calls.find((c) => c.name === "a");
  assert.equal(a, undefined, "and the completed step is served from the journal, not run");
});

await test("a step that was in flight when a run stopped is continued too", async () => {
  const spec = specOf("return await agent('only');");
  /* Hand-build the prior journal: a `step_started` with no outcome is what a
     stopped run leaves, and it is the case `onRestart` never sees (no restart
     happened — the run was relaunched). */
  const store = new FakeStore();
  await store.createRun({ id: "old", parentSessionId: "p", projectId: null, name: "demo", spec, notify: false, createdAt: 1 });
  const key = stepKey(callHash(keyFields({ prompt: "only", label: "agent-1", phase: null })), 0);
  await store.append("old", key, { kind: "step_started", name: "agent-1", phase: null, sessionId: "child-live", attempt: 1, startedAt: 1 });
  await store.append("old", null, { kind: "run_finished", status: "cancelled", error: "stopped by the user", result: null });

  const fresh = await harness({ spec, runId: "new", priorEvents: await store.events("old"), reply: () => "done" });
  await fresh.run();
  const only = fresh.calls.find((c) => c.name === "agent-1");
  assert.equal(only?.resume?.sessionId, "child-live");
});

await test("run_finished status mapping: completed / failed / cancelled", async () => {
  const done = await (await harness({ spec: specOf("return 7;") })).run();
  assert.deepEqual([done.status, done.result, done.error], ["completed", 7, null]);

  const threw = await (await harness({ spec: specOf("throw new Error('oops');") })).run();
  assert.equal(threw.status, "failed");
  assert.match(threw.error ?? "", /oops/);

  const bad = await (await harness({ spec: specOf("agent(") })).run();
  assert.equal(bad.status, "failed");
  assert.match(bad.error ?? "", /parse/);

  const abort = new AbortController();
  const h = await harness({ spec: specOf("return await agent('slow');"), delayMs: 50 });
  const running = h.run({ signal: abort.signal });
  setTimeout(() => abort.abort(), 10);
  const cancelled = await running;
  assert.equal(cancelled.status, "cancelled");
});

await test("the wall of the script does not leak a replayed log/phase: only NEW ones are journaled", async () => {
  const spec = specOf("phase('Plan'); log('hello'); const a = await agent('x'); log('after'); return a;");
  const h = await harness({ spec });
  const logs: string[] = [];
  await h.run({ onLog: (m) => logs.push(m) });
  assert.deepEqual(logs, ["hello", "after"]);
  const kinds = () => h.events().map((e) => e.payload.kind).filter((k) => k === "log" || k === "phase");
  assert.deepEqual(kinds(), ["phase", "log", "log"]);
  const again = await harness({ spec, store: h.store, runId: h.runId });
  const logs2: string[] = [];
  await again.run({ onLog: (m) => logs2.push(m) });
  assert.deepEqual(logs2, [], "a replay narrates nothing new");
  assert.deepEqual(kinds(), ["phase", "log", "log"]);
});

await test("a log written after the last await is durable before the run is called over", async () => {
  const h = await harness({ spec: specOf("log('last words'); return 1;") });
  await h.run();
  assert.ok(h.events().some((e) => e.payload.kind === "log" && e.payload.message === "last words"));
});

await test("the placement handed to the runner names the plan, phases and position", async () => {
  const h = await harness({
    spec: specOf("phase('Build'); await agent('a', {label: 'a'}); phase('Test'); await agent('b', {label: 'b'}); return 1;", {
      meta: { name: "demo", description: "d", phases: [{ title: "Build" }, { title: "Test" }] },
    }),
  });
  await h.run();
  const second = h.calls[1].placement;
  assert.equal(second.index, 1);
  assert.equal(second.total, 2);
  assert.deepEqual(second.phase, { index: 1, name: "Test" });
  assert.deepEqual(second.plan, [{ name: "Build", steps: ["a"] }, { name: "Test", steps: ["b"] }]);
});

await test("steps carry a readable title beside their slug: explicit, label, prompt, never keyed", async () => {
  const body = "await agent('Audit the auth routes. Look hard.', {label: 'read_auth'}); await agent('x', {label: 'read_auth', title: 'Check tokens'}); await agent('# Summarise findings\\nmore', {}); await agent('y', {label: 'read_auth'}); return 1;";
  const h = await harness({ spec: specOf(body) });
  await h.run();
  assert.deepEqual(h.calls.map((c) => c.placement.title), ["Read auth", "Check tokens", "Summarise findings", "Read auth (2)"]);
  assert.deepEqual(h.calls[3].placement.titles, { "read_auth": "Read auth", "read_auth-2": "Check tokens", "agent-3": "Summarise findings", "read_auth-3": "Read auth (2)" });
  assert.equal(stepTitle({ prompt: "  \n ", index: 7 }), "Agent 7");
  assert.equal(stepTitle({ prompt: "Fix the very long thing ".repeat(10), index: 1 }).length <= 60, true);
});

await test("replayed answers are released in their journaled order (race() picks the same winner)", async () => {
  // fast was journaled FIRST even though the script lists slow first.
  const spec = specOf("return await race([() => agent('slow', {label: 'slow'}), () => agent('fast', {label: 'fast'})]);");
  const store = new FakeStore();
  await store.createRun({ id: "run-1", parentSessionId: "p", projectId: null, name: "demo", spec, notify: false, createdAt: 1 });
  await store.append("run-1", keyOf({ prompt: "fast", label: "fast" }), { kind: "step_completed", name: "fast", output: "F", sessionId: null, tokens: 0, toolUses: 0 });
  await store.append("run-1", keyOf({ prompt: "slow", label: "slow" }), { kind: "step_completed", name: "slow", output: "S", sessionId: null, tokens: 0, toolUses: 0 });
  const h = await harness({ spec, store });
  assert.equal((await h.run()).result, "F");
  assert.equal(h.calls.length, 0);
});

await test("a held run parks before taking a slot and goes on when resumed", async () => {
  let held = true;
  const waiting: (() => void)[] = [];
  const h = await harness({ spec: specOf("return await agent('x');") });
  const running = h.run({
    whenRunning: () => (held ? new Promise<void>((r) => waiting.push(r)) : Promise.resolve()),
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.calls.length, 0, "nothing starts while held");
  held = false;
  for (const w of waiting.splice(0)) w();
  assert.equal((await running).status, "completed");
  assert.equal(h.calls.length, 1);
});

await test("replayIndex / usageOf read a journal the way the engine does", async () => {
  const h = await harness({ spec: specOf("await agent('a'); await agent('b'); log('x'); return 1;"), tokens: 10 });
  await h.run();
  const idx = replayIndex(h.events());
  assert.equal(idx.done.size, 2);
  assert.equal(idx.inFlight.size, 0);
  assert.equal(idx.logs, 1);
  const u = usageOf(h.events());
  assert.equal(u.agents, 2);
  assert.equal(u.tokens, 20);
});

// ---- review fixes: wall clock, jsonb key order, budget reads ---------------------------

const ev = (seq: number, at: number, payload: JournalPayload, key: string | null = null): JournalEvent => ({ runId: "r", seq, at, key, payload });
const H = 3600_000;

await test("B2 wallSecOf: the downtime before a run_recovered is not run time", () => {
  const spec = specOf("return 1;");
  const events = [
    ev(1, 0, { kind: "run_started", spec }),
    ev(2, 60_000, { kind: "log", message: "x" }), // ran 60s
    // the server was down for 5 hours, then recovered:
    ev(3, 5 * H, { kind: "run_recovered" }),
    ev(4, 5 * H + 30_000, { kind: "log", message: "y" }), // ran 30s more
  ];
  assert.equal(wallSecOf(events), 90);
  // Without the marker the gap would be run time.
  assert.equal(wallSecOf(events.filter((e) => e.payload.kind !== "run_recovered")), 5 * 3600 + 30);
  // Two recoveries, and a pause in between that is excluded as before.
  const more = [
    ...events,
    ev(5, 5 * H + 40_000, { kind: "run_paused" }), // +10s
    ev(6, 9 * H, { kind: "run_resumed" }),
    ev(7, 9 * H + 5_000, { kind: "run_recovered" }), // +5s
    ev(8, 9 * H + 25_000, { kind: "log", message: "z" }), // +20s
  ];
  assert.equal(wallSecOf(more), 90 + 10 + 5 + 20 - 5);
});

await test("B2 wallSecOf: a recovered-while-paused run stays paused; a huge journal does not blow the stack", () => {
  const spec = specOf("return 1;");
  const events = [
    ev(1, 0, { kind: "run_started", spec }),
    ev(2, 10_000, { kind: "run_paused" }),
    ev(3, 3 * H, { kind: "run_recovered" }),
  ];
  assert.equal(wallSecOf(events), 10);
  const many: JournalEvent[] = [ev(1, 0, { kind: "run_started", spec })];
  for (let i = 2; i <= 150_000; i++) many.push(ev(i, i, { kind: "log", message: "." }));
  assert.equal(wallSecOf(many), 150);
});

await test("B2 usageOf carries the corrected wall time (a resumed run's totalTimeout is not eaten by downtime)", () => {
  const spec = specOf("return 1;");
  const events = [
    ev(1, 0, { kind: "run_started", spec }),
    ev(2, 120_000, { kind: "log", message: "x" }),
    ev(3, 48 * H, { kind: "run_recovered" }),
  ];
  const u = usageOf(events);
  assert.equal(u.wallSec, 120);
  const total = 2 * 3600;
  assert.ok((total - u.wallSec) * 1000 > 1_000, "remaining is nowhere near the 1 s clamp");
});

/** What Postgres jsonb does to object keys: shorter first, then alphabetical. */
function jsonbOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonbOrder);
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))) out[k] = jsonbOrder(o[k]);
    return out;
  }
  return value;
}
/** A store whose journal has been through jsonb: the same events, keys reordered. */
function reorderedCopy(from: FakeStore, runId: string): FakeStore {
  const copy = new FakeStore();
  copy.headers = from.headers;
  copy.journals.set(
    runId,
    from.journals.get(runId)!.map((e) => ({ ...e, payload: jsonbOrder(e.payload) as JournalPayload })),
  );
  return copy;
}

await test("B3 canon: a step output has the same key order live and replayed from jsonb, so the next prompt keys the same", async () => {
  const spec = specOf("const r = await agent('make', {label: 'a'}); const t = await agent('use ' + JSON.stringify(r), {label: 'b'}); return {r, t};");
  const first = await harness({ spec, reply: (s) => (s.prompt === "make" ? { zeta: 1, a: 2, bb: 3, topic: { y: 1, x: 2 } } : "done") });
  const live = await first.run();
  const prompts = first.calls.map((c) => c.spec.prompt);
  assert.equal(prompts[1], 'use {"a":2,"bb":3,"topic":{"x":2,"y":1},"zeta":1}', "live side is canonical too");
  // A restart: the journal came back through jsonb with other key orders.
  const store = reorderedCopy(first.store, first.runId);
  const second = await harness({ spec, store, runId: first.runId });
  const again = await second.run();
  assert.equal(second.calls.length, 0, "same key => served from the journal, no re-run");
  assert.equal(JSON.stringify(again.result), JSON.stringify(live.result));
});

await test("B3 canon: args reach the script canonical, and the result is canonical", async () => {
  const spec = specOf("return {args, again: args};", { args: { zeta: 1, a: { d: 1, c: 2 } } });
  const h = await harness({ spec });
  const out = await h.run();
  assert.equal(JSON.stringify(out.result), '{"again":{"a":{"c":2,"d":1},"zeta":1},"args":{"a":{"c":2,"d":1},"zeta":1}}');
});

await test("B3 canon: a gate's value (signal / state / shell) is canonical before the script sees it", async () => {
  const spec = specOf("const v = await waitFor('go'); return JSON.stringify(v);");
  const h2 = await harness({ spec });
  const out = await h2.run({
    gateHooks: {
      approve: async () => null,
      sleep: async () => {},
      until: async () => {},
      waitFor: async () => ({ zeta: 1, a: 2 }),
      sh: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      artifact: async () => {},
      setState: () => {},
      getState: () => undefined,
    },
  });
  assert.equal(out.result, '{"a":2,"zeta":1}');
});

await test("B6 budget reads are replay-consistent: a `while (budget.remaining() > X)` loop makes the same calls on replay", async () => {
  const body = "let n = 0; while (budget.remaining() > 100) { await agent('s' + n, {label: 's' + n}); n++; } return n;";
  const spec = specOf(body, { budgets: { tokens: 350 } });
  const first = await harness({ spec, tokens: 100 });
  const live = await first.run({ tracker: new BudgetTracker({ tokens: 350 }) });
  assert.equal(live.result, 3);
  assert.equal(first.calls.length, 3);
  // Boot: the tracker is seeded with the journal's FINAL totals (300 tokens), as the engine does.
  const second = await harness({ spec, store: first.store, runId: first.runId, tokens: 100 });
  const tracker = new BudgetTracker({ tokens: 350 });
  tracker.seed(usageOf(first.store.journals.get(first.runId)!));
  const replay = await second.run({ tracker });
  assert.equal(replay.result, 3, "the replay reads the same remaining() at each point");
  assert.equal(second.calls.length, 0);
  // A cut journal: two steps done, the loop must go on to a third LIVE call, then stop.
  const journal = first.store.journals.get(first.runId)!;
  journal.splice(journal.findIndex((e) => e.payload.kind === "step_started" && e.payload.name === "s2"));
  const third = await harness({ spec, store: first.store, runId: first.runId, tokens: 100 });
  const t3 = new BudgetTracker({ tokens: 350 });
  t3.seed(usageOf(journal));
  const resumed = await third.run({ tracker: t3 });
  assert.equal(resumed.result, 3);
  assert.deepEqual(third.started, ["s2"]);
  // And the agents meter is replay-consistent too.
  const agentsSpec = specOf("let n = 0; while (budget.agents.remaining() > 0) { await agent('a' + n, {label: 'a' + n}); n++; } return n;", { budgets: { agents: 4 } });
  const a1 = await harness({ spec: agentsSpec });
  const al = await a1.run({ tracker: new BudgetTracker({ agents: 4 }) });
  assert.equal(al.result, 4);
  const a2 = await harness({ spec: agentsSpec, store: a1.store, runId: a1.runId });
  const at = new BudgetTracker({ agents: 4 });
  at.seed(usageOf(a1.store.journals.get(a1.runId)!));
  assert.equal((await a2.run({ tracker: at })).result, 4);
});

await test("N11 a step answered from the journal is reported to onReplayed (the parent re-says its end)", async () => {
  const spec = specOf("await agent('x', {label: 'x'}); return 1;");
  const first = await harness({ spec });
  await first.run();
  const second = await harness({ spec, store: first.store, runId: first.runId });
  const seen: unknown[] = [];
  await second.run({ onReplayed: (s) => seen.push(s) });
  assert.deepEqual(seen, [{ name: "x", sessionId: "child-x", kind: "completed" }]);
});

// ---- the engine class (lifecycle, caps, finalize, recovery) -----------------------------
// engine.ts opens the database through its imports, hence `require-temp-data` above. Nothing here
// touches it: the store, the step runner, the lookups and the notifier are all injected.

const { WorkflowEngine, WorkflowError, shellEnv } = await import("../src/workflows/engine.js");

type Engine = InstanceType<typeof WorkflowEngine>;
const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, what: string, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await tick(2);
  }
};

class LifeStore extends FakeStore {
  statuses: { id: string; status: string }[] = [];
  statusDelay: Record<string, number> = {};
  failStatus = false;
  createDelay = 0;
  running: NonNullable<Awaited<ReturnType<RunStore["header"]>>>[] = [];
  override async createRun(row: Parameters<RunStore["createRun"]>[0]) {
    if (this.createDelay) await tick(this.createDelay);
    return super.createRun(row);
  }
  override async setStatus(id: string, status: RunStatus) {
    const d = this.statusDelay[status];
    if (d) await tick(d);
    this.statuses.push({ id, status });
    if (this.failStatus) throw new Error("db down");
    const h = this.headers.get(id);
    if (h) h.status = status;
  }
  override async runningRuns() {
    return this.running;
  }
}

interface Rig {
  engine: Engine;
  store: LifeStore;
  parent: Record<string, unknown>;
  runsActive: [string, boolean][];
  notes: string[];
  emitted: unknown[];
  retired: unknown[];
  stepCalls: StepCall[];
  /** Resolve the step named `name`. */
  finish(name: string, output?: unknown): void;
}

function rig(o: { stepMode?: "pending" | "auto"; scheduler?: { acquire: FlowScheduler["acquire"]; dropRun?(id: string): void }; unwindMs?: number } = {}): Rig {
  const store = new LifeStore();
  const runsActive: [string, boolean][] = [];
  const notes: string[] = [];
  const emitted: unknown[] = [];
  const retired: unknown[] = [];
  const stepCalls: StepCall[] = [];
  const waiting = new Map<string, (v: unknown) => void>();
  const parent: Record<string, unknown> = {
    id: "parent-1",
    projectId: "proj",
    profileId: "prof",
    parentSessionId: null,
    askProfiles: {},
    bridge: null,
    exited: true,
    autonomy: null,
    deletedAt: null,
    worktree: null,
  };
  const manager = {
    ready: Promise.resolve(),
    get: (id: string) => (id === "parent-1" ? parent : undefined),
    setRunsActive: (id: string, active: boolean) => void runsActive.push([id, active]),
    emitOn: (_id: string, event: unknown) => void emitted.push(event),
    retire: (child: unknown) => void retired.push(child),
  };
  const stepRunner: StepRunner = async (call) => {
    stepCalls.push(call);
    await call.append({ kind: "step_started", name: call.name, phase: null, sessionId: `child-${call.name}`, attempt: 1, startedAt: 1 });
    const output = o.stepMode === "pending" ? await new Promise<unknown>((r) => waiting.set(call.name, r)) : `out:${call.name}`;
    await call.append({ kind: "step_completed", name: call.name, output, sessionId: `child-${call.name}`, tokens: 1, toolUses: 0 });
    return { output, sessionId: `child-${call.name}`, tokens: 1, toolUses: 0 };
  };
  const engine = new WorkflowEngine(manager as never, {
    port: 0,
    store,
    stepRunner,
    ...(o.scheduler ? { scheduler: o.scheduler as never } : {}),
    lookups: { project: async () => ({ id: "proj", cwd: tmpdir() }) as never, profile: async () => ({ id: "prof" }) },
    notify: (_id, text) => void notes.push(text),
    ...(o.unwindMs ? { unwindMs: o.unwindMs } : {}),
  });
  return { engine, store, parent, runsActive, notes, emitted, retired, stepCalls, finish: (name, out = `out:${name}`) => waiting.get(name)?.(out) };
}

const SCRIPT = META + "return await agent('hello', {label: 'one'});";
const privately = (e: Engine) => e as unknown as {
  runs: Map<string, { settled: boolean; finalized: boolean; children: Set<unknown>; inflight: Set<Promise<unknown>>; parked: Map<string, unknown>; events: JournalEvent[]; parent: Record<string, unknown> }>;
  launchAsk(parent: unknown, a: unknown): Promise<unknown>;
  park(run: unknown, q: { text: string; options: string[]; timeoutSec?: number }): { id: string; answer: Promise<string | null> };
  loadWorkflow(run: unknown, ref: unknown): Promise<string>;
};
const askArgs = (n: number) => ({
  name: `ask ${n}`,
  prompt: `p${n}`,
  pair: { agent: "A", profile: "P", agentId: "a", profileId: "p" },
  options: {},
});

await test("B4 caps hold under concurrent launches: 10 asks at once => exactly the cap, and releases afterwards", async () => {
  const r = rig({ stepMode: "pending" });
  r.store.createDelay = 5;
  const e = privately(r.engine);
  // Different object identity each time (N9): the cap is per parent ID.
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => e.launchAsk({ ...r.parent }, askArgs(i))));
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 4);
  const rejected = results.filter((x) => x.status === "rejected") as PromiseRejectedResult[];
  assert.equal(rejected.length, 6);
  assert.ok(rejected.every((x) => x.reason instanceof WorkflowError && x.reason.status === 409));
  // Runs: the cap is 3 and counted apart from asks.
  const runs = await Promise.allSettled(Array.from({ length: 8 }, () => r.engine.start({ ...r.parent } as never, { script: SCRIPT })));
  assert.equal(runs.filter((x) => x.status === "fulfilled").length, 3);
  // Cancel everything: the slots free up (a failed/finished launch is not leaked).
  for (const run of e.runs.values()) r.engine.cancel(run.events[0]!.runId);
  await until(() => [...e.runs.values()].every((x) => x.settled), "runs to settle");
  await r.engine.start({ ...r.parent } as never, { script: SCRIPT });
  r.engine.shutdown();
});

await test("the three caps are counted apart: asks, subagents and workflows never starve each other", async () => {
  const r = rig({ stepMode: "pending" });
  r.store.createDelay = 5;
  const e = privately(r.engine);
  /* One-step runs on the thread's OWN pair saturate their own bucket — which is
     `ENGINE_LIMITS.subagentsPerParent`, not the workflow one — and a workflow
     can still start beside them, which is the whole reason the caps are split. */
  const subagents = await Promise.allSettled(
    Array.from({ length: ENGINE_LIMITS.subagentsPerParent + 2 }, (_, i) =>
      r.engine.subagent({ ...r.parent } as never, { prompt: `s${i}` }),
    ),
  );
  assert.equal(subagents.filter((x) => x.status === "fulfilled").length, ENGINE_LIMITS.subagentsPerParent);
  const refused = subagents.filter((x) => x.status === "rejected") as PromiseRejectedResult[];
  assert.equal(refused.length, 2);
  assert.ok(refused.every((x) => x.reason instanceof WorkflowError && x.reason.status === 409));
  assert.match(String(refused[0]!.reason.message), /subagents running/);
  /* The buckets are independent: with the subagent cap full, a workflow still
     starts — and so does an ask, up to its own number. */
  await r.engine.start({ ...r.parent } as never, { script: SCRIPT });
  assert.equal(e.runs.size, ENGINE_LIMITS.subagentsPerParent + 1);
  for (const run of e.runs.values()) r.engine.cancel(run.events[0]!.runId);
  await until(() => [...e.runs.values()].every((x) => x.settled), "runs to settle");
  r.engine.shutdown();
});

await test("R11/R12 shutdown closes the door; a launch that dies after createRun fails its row instead of leaving it running", async () => {
  const r = rig({ stepMode: "pending" });
  r.store.createDelay = 20;
  const launching = r.engine.start(r.parent as never, { script: SCRIPT });
  const outcome = launching.then(() => null, (error: unknown) => error);
  await tick(5);
  r.engine.shutdown(); // lands while createRun is in flight
  const error = await outcome;
  assert.ok(error instanceof WorkflowError && error.status === 409, String(error));
  const row = [...r.store.headers.values()][0]!;
  assert.equal(row.status, "failed", "the row must not stay running with no driver");
  assert.ok(r.store.journals.get(row.id)!.some((e) => e.payload.kind === "run_finished"));
  for (const call of [() => r.engine.start(r.parent as never, { script: SCRIPT }), () => privately(r.engine).launchAsk(r.parent, askArgs(1)), () => r.engine.continueRun(r.parent as never, "x")]) {
    await assert.rejects(call(), (e: unknown) => e instanceof WorkflowError && e.status === 409);
  }
});

await test("B9 a wait() during finalize waits for the end and is told, so the notification is NOT sent as well", async () => {
  const r = rig();
  r.store.statusDelay = { completed: 80 };
  const view = await r.engine.start(r.parent as never, { script: SCRIPT, notify: true });
  const e = privately(r.engine);
  await until(() => e.runs.get(view.id)!.finalized, "finalize to start");
  assert.equal(e.runs.get(view.id)!.settled, false, "the end is still being written");
  const waited = await r.engine.wait(view.id, 5_000);
  assert.equal(waited?.status, "completed");
  await tick(20);
  assert.equal(r.notes.length, 0, "told by the tool answer, so no message");
  // And with nobody waiting the notification does go out, exactly once.
  const second = await r.engine.start(r.parent as never, { script: SCRIPT + " ", notify: true });
  await until(() => e.runs.get(second.id)!.settled, "second run to settle");
  assert.equal(r.notes.length, 1);
});

await test("B7 pause's status write is ordered before the run's final status", async () => {
  const r = rig({ stepMode: "pending" });
  r.store.statusDelay = { paused: 40 };
  const view = await r.engine.start(r.parent as never, { script: SCRIPT });
  await until(() => r.stepCalls.length === 1, "step to start");
  assert.ok(r.engine.pause(view.id));
  r.engine.cancel(view.id);
  await until(() => privately(r.engine).runs.get(view.id)!.settled, "settle");
  assert.deepEqual(r.store.statuses.filter((s) => s.id === view.id).map((s) => s.status), ["paused", "cancelled"]);
});

await test("R9 finalize always serves waiters and notifies, even when cleanup throws", async () => {
  const sched = new FlowScheduler(16);
  const r = rig({ scheduler: { acquire: (q) => sched.acquire(q), dropRun: () => { throw new Error("boom"); } } });
  r.store.failStatus = true;
  const view = await r.engine.start(r.parent as never, { script: SCRIPT, notify: true });
  await until(() => privately(r.engine).runs.get(view.id)!.settled, "settle despite the throw");
  assert.equal(r.notes.length, 1);
  assert.equal((await r.engine.wait(view.id, 100))?.status, "completed");
});

await test("R8 children that outlive the unwind window are retired and cleared", async () => {
  const r = rig({ stepMode: "pending", unwindMs: 20 });
  const view = await r.engine.start(r.parent as never, { script: SCRIPT });
  await until(() => r.stepCalls.length === 1, "step to start");
  const e = privately(r.engine);
  const run = e.runs.get(view.id)!;
  const child = { id: "wedged" };
  run.children.add(child);
  run.inflight.add(new Promise(() => {})); // a step that never unwinds
  r.engine.cancel(view.id);
  await until(() => run.settled, "settle");
  assert.deepEqual(r.retired, [child]);
  assert.equal(run.children.size, 0);
});

await test("B8/B2/B5 recovery: a journal that already finished only fixes the row; others get run_recovered first and re-assert runsActive", async () => {
  const r = rig({ stepMode: "pending" });
  const spec = specOf("return await agent('hello', {label: 'one'});");
  // run A: finished in the journal, row still running (crash between the two writes).
  await r.store.createRun({ id: "A", parentSessionId: "parent-1", projectId: "proj", name: "demo", spec, notify: true, createdAt: 1 });
  await r.store.append("A", null, { kind: "run_finished", status: "completed", error: null, result: "done" });
  // run B: genuinely in flight.
  await r.store.createRun({ id: "B", parentSessionId: "parent-1", projectId: "proj", name: "demo", spec, notify: true, createdAt: 1 });
  r.store.running = [r.store.headers.get("A")!, r.store.headers.get("B")!];
  await r.engine.recoverAtBoot({ resume: false });
  assert.deepEqual(r.store.statuses, [{ id: "A", status: "completed" }]);
  assert.equal(r.notes.length, 0, "no second notification for A");
  assert.ok(!privately(r.engine).runs.has("A"));
  const before = r.runsActive.length;
  // B is registered but not driven yet; the recovery marker is already in its journal.
  const kinds = r.store.journals.get("B")!.map((e) => e.payload.kind);
  assert.deepEqual(kinds, ["run_started", "run_recovered"]);
  assert.equal(r.stepCalls.length, 0);
  assert.equal(r.engine.hasLive("parent-1"), true);
  assert.equal(r.engine.hasLive("other"), false);
  r.engine.resumeRecovered();
  assert.ok(r.runsActive.slice(before).some(([id, on]) => id === "parent-1" && on), "re-asserted when the drive resumes");
  await until(() => r.stepCalls.length === 1, "B to be driven");
  r.engine.shutdown();
  assert.equal(r.engine.hasLive("parent-1"), false, "a detached run no longer pins the thread");
});

await test("B12 a question the SAME live bridge cancelled is a decline, not re-parked forever; a lost bridge re-parks", async () => {
  const r = rig({ stepMode: "pending" });
  const view = await r.engine.start(r.parent as never, { script: SCRIPT });
  const e = privately(r.engine);
  const run = e.runs.get(view.id)!;
  const flags: unknown[] = [];
  const pending = new Map<string, { payload: unknown }>();
  let answerWith: (v: unknown) => void = () => {};
  const bridge = {
    acpSessionId: "acp",
    pending,
    park: (_k: string, request: unknown, _t: unknown, opts: unknown) => {
      flags.push(opts);
      pending.set("r1", { payload: request });
      return new Promise((resolve) => (answerWith = resolve));
    },
    answer: () => {},
  };
  r.parent.bridge = bridge;
  r.parent.exited = false;
  const q = e.park(run, { text: "go?", options: ["yes", "no"] });
  assert.deepEqual(flags, [{ humanOnly: true }], "R3: an approval is a human's, whatever the parent's autonomy says");
  answerWith({ outcome: { outcome: "cancelled" } });
  assert.equal(await q.answer, null);
  // The bridge was replaced under the question: it is asked again on the next process.
  const q2 = e.park(run, { text: "again?", options: ["yes", "no"] });
  r.parent.bridge = { ...bridge, park: () => new Promise(() => {}) };
  answerWith({ outcome: { outcome: "cancelled" } });
  let settled = false;
  void q2.answer.then(() => (settled = true));
  await tick(20);
  assert.equal(settled, false, "still waiting for the next bridge");
  r.engine.cancel(view.id);
  await until(() => run.settled, "settle");
});

await test("R7 a saved workflow's source is journaled on first load and served from the journal after", async () => {
  const r = rig({ stepMode: "pending" });
  const view = await r.engine.start(r.parent as never, { script: SCRIPT });
  const e = privately(r.engine);
  const run = e.runs.get(view.id)!;
  const dir = mkdtempSync(join(tmpdir(), "wf-load-"));
  const file = join(dir, "w.js");
  writeFileSync(file, "return 1;");
  (run as unknown as { project: unknown }).project = { id: "proj", cwd: dir };
  const first = await e.loadWorkflow(run, { scriptPath: "w.js" });
  assert.equal(first, "return 1;");
  const logged = run.events.filter((x) => x.payload.kind === "workflow_loaded");
  assert.equal(logged.length, 1);
  writeFileSync(file, "return 2; // edited after the crash");
  assert.equal(await e.loadWorkflow(run, { scriptPath: "w.js" }), "return 1;", "the journal wins over the file");
  assert.equal(run.events.filter((x) => x.payload.kind === "workflow_loaded").length, 1, "journaled once");
  r.engine.cancel(view.id);
});

await test("R4 sh runs with a minimal env: no keys, tokens, database url or DAEDALUS_*", () => {
  const env = shellEnv({
    PATH: "/bin",
    HOME: "/h",
    LANG: "C",
    TERM: "x",
    USER: "u",
    SHELL: "/bin/sh",
    OPENAI_API_KEY: "k",
    DATABASE_URL: "postgres://x",
    DAEDALUS_TOKEN: "t",
    GITHUB_TOKEN: "g",
    SECRET_THING: "s",
    EDITOR: "vim",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH", "SHELL", "TERM", "USER"]);
});

// ---- done ---------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
void (0 as unknown as Budgets);
