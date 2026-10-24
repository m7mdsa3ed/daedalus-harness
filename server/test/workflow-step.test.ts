// Self-check for one agent step (src/workflows/step.ts) against a fake session manager:
//   R1 the child id is minted and `step_started` journaled BEFORE the thread is created.
//   R2 a retry / resume cancels and awaits a child whose previous turn is still open before prompting.
//   N5 a turn that ended before `whenTurnSettled` registered cannot hang the step.
//   N1 the restart-`fail` policy is a typed error (one step_failed, not two).
//   N2 the journaled cancel reason is the engine's. N3 a config error still journals step_started first.
// Run: pnpm test:workflow-step
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { createProject } = await import("../src/projects.js");
const { createProfile } = await import("../src/profiles.js");
const { runAgentStep, StepRestartFailed, StepConfigError } = await import("../src/workflows/step.js");
import type { StepContext } from "../src/workflows/step.js";
import type { JournalPayload } from "../src/workflows/types.js";

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
}

const root = await mkdtemp(path.join(os.tmpdir(), "wf-step-"));
const project = await createProject({ name: "step", cwd: root, description: null, logoUrl: "" } as never);
const profile = await createProfile({ name: "step", agents: { stub: {} }, baseUrl: "", apiKey: "k", models: [], defaultModel: "", smallModel: "", logoUrl: "" } as never);

interface Rig {
  ctx: StepContext;
  log: string[];
  journal: { key: string; payload: JournalPayload }[];
  abort(): void;
  childEvents(fn: (emit: (e: unknown) => void) => void): void;
  manager: Record<string, unknown>;
  child: FakeChild;
  created: { id: string | undefined }[];
  prompts: string[];
}
interface FakeChild {
  id: string;
  parentSessionId: string;
  model: string;
  exited: boolean;
  bridge: {
    ready: Promise<void>;
    promptActive: boolean;
    currentTurnId: string | null;
    cancel(): Promise<void>;
    whenIdle(): Promise<void>;
    captureRestoreState(): unknown;
  };
  [k: string]: unknown;
}

type Behaviour = {
  /** What a prompt does: emit events, then return its turn id. */
  onPrompt?(ctx: { emit(e: unknown): void; child: FakeChild; settle(): void; text: string }): void;
  /** The thread already exists with a turn still open (a resume at boot). */
  openTurn?: boolean;
  recovered?: { sessionId: string; attempt: number } | null;
  profileId?: string;
  onRestart?: "resume" | "rerun" | "fail";
  cancelReason?: () => string | null;
  /** Never resolve `whenTurnSettled` (a turn that ended before the waiter registered). */
  neverSettle?: boolean;
};

function rig(b: Behaviour = {}): Rig {
  const log: string[] = [];
  const journal: { key: string; payload: JournalPayload }[] = [];
  const subs = new Set<(e: unknown) => void>();
  const emit = (e: unknown) => {
    for (const fn of [...subs]) fn(e);
  };
  const waiters: { turnId: string; resolve(o: { interrupted: boolean }): void }[] = [];
  const settle = () => {
    child.bridge.promptActive = false;
    for (const w of waiters.splice(0)) w.resolve({ interrupted: false });
  };
  const child: FakeChild = {
    id: "child-1",
    parentSessionId: "parent",
    model: "m",
    exited: false,
    profileId: profile.id,
    agentId: "stub",
    projectId: project.id,
    bridge: {
      ready: Promise.resolve(),
      promptActive: !!b.openTurn,
      currentTurnId: b.openTurn ? "t-old" : null,
      cancel: async () => {
        log.push("cancel");
        if (b.openTurn) setTimeout(settle, 5);
      },
      whenIdle: () => (child.bridge.promptActive ? new Promise<void>((r) => waiters.push({ turnId: "", resolve: () => r() })) : Promise.resolve()),
      captureRestoreState: () => ({ configOptions: [] }),
    },
  };
  const created: { id: string | undefined }[] = [];
  const prompts: string[] = [];
  const ac = new AbortController();
  const manager = {
    create: async (_p: unknown, _a: unknown, _w: unknown, _m: unknown, _e: unknown, id?: string) => {
      log.push("create");
      created.push({ id });
      child.id = id ?? child.id;
      return child;
    },
    respawn: async () => undefined,
    get: (id: string) => (id === child.id ? child : undefined),
    prompt: async (_id: string, text: string) => {
      log.push(`prompt:${child.bridge.promptActive ? "while-open" : "idle"}`);
      prompts.push(text);
      child.bridge.promptActive = true;
      child.bridge.currentTurnId = "t-1";
      b.onPrompt?.({ emit, child, settle, text });
      return { turnId: "t-1" };
    },
    subscribe: (_id: string, fn: (e: unknown) => void) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    whenTurnSettled: (_id: string, turnId: string) => (b.neverSettle ? new Promise<{ interrupted: boolean }>(() => {}) : new Promise<{ interrupted: boolean }>((resolve) => waiters.push({ turnId, resolve }))),
    retire: () => log.push("retire"),
    emitOn: () => undefined,
  };
  const parent = { id: "parent", profileId: b.profileId ?? profile.id, agentId: "stub", projectId: project.id, model: "m", effort: "", links: {}, bridge: child.bridge, askProfiles: {} };
  const ctx: StepContext = {
    runId: "r",
    runName: "run",
    manager: manager as never,
    parent: parent as never,
    signal: ac.signal,
    detached: () => false,
    ...(b.cancelReason ? { cancelReason: b.cancelReason } : {}),
    ask: null,
    defaultTimeoutSec: 5,
    defaultOnRestart: b.onRestart ?? "resume",
    recovered: b.recovered ?? null,
    placement: () => ({ index: 0, total: 1, phase: null, plan: [], title: "Step", titles: {} }),
    whenRunning: async () => undefined,
    timer: (ms, fn) => {
      const t = setTimeout(fn, ms);
      return { clear: () => clearTimeout(t) };
    },
    append: async (key, payload) => {
      log.push(`append:${payload.kind}`);
      journal.push({ key, payload });
      return { runId: "r", seq: journal.length, at: 0, key, payload };
    },
    track: () => undefined,
    untrack: () => undefined,
  };
  return { ctx, log, journal, abort: () => ac.abort(), childEvents: (fn) => fn(emit), manager, child, created, prompts };
}

const text = (t: string) => ({ ev: "update", seq: 0, historyReplay: false, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } } });
const ended = { ev: "turn_ended", seq: 0, turnId: "t-1", usage: null };
const spec = { prompt: "do it", label: "s", phase: null } as never;
const kinds = (r: Rig) => r.journal.map((j) => j.payload.kind);

console.log("workflow-step");

await test("R1: step_started is journaled with a minted id BEFORE manager.create, and create is given that id", async () => {
  const r = rig({ onPrompt: ({ emit, settle }) => (emit(text("done")), emit(ended), settle()) });
  const out = await runAgentStep(r.ctx, spec, "k#0", "s");
  assert.equal(out.output, "done");
  assert.ok(r.log.indexOf("append:step_started") < r.log.indexOf("create"), r.log.join(","));
  const started = r.journal.find((j) => j.payload.kind === "step_started")!.payload as { sessionId: string };
  assert.ok(started.sessionId.length > 8);
  assert.equal(r.created[0]!.id, started.sessionId);
  assert.equal(r.journal.filter((j) => j.payload.kind === "step_started").length, 1, "not journaled twice for the first attempt");
  assert.equal(kinds(r).at(-1), "step_completed");
});

await test("R2: a resumed child whose turn is still open is cancelled and awaited before the prompt", async () => {
  const r = rig({
    openTurn: true,
    recovered: { sessionId: "child-1", attempt: 1 },
    onPrompt: ({ emit, settle }) => (emit(text("ok")), emit(ended), settle()),
  });
  await runAgentStep(r.ctx, spec, "k#0", "s");
  const iCancel = r.log.indexOf("cancel");
  const iPrompt = r.log.findIndex((l) => l.startsWith("prompt:"));
  assert.ok(iCancel >= 0 && iCancel < iPrompt, r.log.join(","));
  assert.equal(r.log[iPrompt], "prompt:idle", "prompted only after the old turn settled");
});

await test("N5: a turn that already ended when whenTurnSettled registers cannot hang the step", async () => {
  const r = rig({ neverSettle: true, onPrompt: ({ emit, child }) => (emit(text("fast")), emit(ended), (child.bridge.promptActive = false)) });
  const out = await Promise.race([runAgentStep(r.ctx, spec, "k#0", "s"), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("step hung")), 2000))]);
  assert.equal(out.output, "fast");
});

await test("N1: restart policy fail journals exactly one step_failed and throws the typed error", async () => {
  const r = rig({ recovered: { sessionId: "child-1", attempt: 1 }, onRestart: "fail" });
  await assert.rejects(runAgentStep(r.ctx, spec, "k#0", "s"), (e: unknown) => e instanceof StepRestartFailed);
  assert.equal(kinds(r).filter((k) => k === "step_failed").length, 1);
  assert.equal(r.log.includes("create"), false);
});

await test("N1: a message that merely starts with the old sentence is still journaled", async () => {
  const r = rig({ onPrompt: () => { throw new Error("the server restarted while this step was running (says the model)"); } });
  await assert.rejects(runAgentStep(r.ctx, spec, "k#0", "s"));
  assert.equal(kinds(r).filter((k) => k === "step_failed").length, 1);
});

await test("N2: a cancel journals the engine's reason, defaulting to 'cancelled'", async () => {
  const run = async (reason: (() => string | null) | undefined) => {
    const r = rig({ ...(reason ? { cancelReason: reason } : {}), onPrompt: () => setTimeout(() => r.abort(), 5) });
    await assert.rejects(runAgentStep(r.ctx, spec, "k#0", "s"));
    return (r.journal.find((j) => j.payload.kind === "step_failed")!.payload as { error: string }).error;
  };
  assert.equal(await run(() => "stopped by the user"), "stopped by the user");
  assert.equal(await run(undefined), "cancelled");
});

await test("N3: a config error still journals step_started first, so the agent is counted", async () => {
  const r = rig({ profileId: "no-such-profile" });
  await assert.rejects(runAgentStep(r.ctx, spec, "k#0", "s"), (e: unknown) => e instanceof StepConfigError);
  assert.deepEqual(kinds(r), ["step_started", "step_failed"]);
  const { foldRun } = await import("../src/workflows/fold.js");
  const view = foldRun(
    { id: "r", name: "n", status: "running", error: null, createdAt: 0, endedAt: null, spec: { meta: { phases: [] }, budgets: {} } as never },
    r.journal.map((j, i) => ({ runId: "r", seq: i + 1, at: 0, key: j.key, payload: j.payload })),
  );
  assert.equal(view.usage.agents, 1);
  assert.equal(view.steps[0]!.status, "failed");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
