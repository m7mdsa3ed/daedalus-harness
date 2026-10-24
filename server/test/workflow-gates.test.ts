// Self-check for the durable gates (src/workflows/gates.ts), against a fake GateHost — no database:
//   - approvals: answer, timeout => null, cancel leaves the gate resumable, route answers validate.
//   - replay from a journal performs no side effect (ask / timer / exec counted).
//   - unresolved approval / timer / signal are resumed, never re-opened.
//   - signals before and after the wait; waitFor timeout => null.
//   - sh: path escapes refused, output truncated; artifact: path escapes refused; state ordering.
//   - the produced events fold to the expected GateView statuses.
// Run: pnpm exec tsx test/workflow-gates.test.ts
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { Gates, SH_OUTPUT_CAP } = await import("../src/workflows/gates.js");
const { foldRun } = await import("../src/workflows/fold.js");
import type { GateHost, JournalEvent, JournalPayload, RunSpec } from "../src/workflows/types.js";

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? error.stack : String(error)}`);
  }
}

const spec: RunSpec = {
  source: "",
  meta: { name: "gates", description: "", phases: [] },
  args: null,
  budgets: {},
  flow: {},
  trigger: { kind: "agent" },
  onRestart: "resume",
};
const header = { id: "r1", name: "gates", status: "running" as const, error: null, createdAt: 0, endedAt: null, spec };
const fold = (events: readonly JournalEvent[]) => foldRun(header, [...events]);
const tick = () => new Promise<void>((r) => setImmediate(r));
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await tick();
};

interface Fake {
  host: GateHost;
  events: JournalEvent[];
  abort(): void;
  clock: { now: number };
  asks: { id: string; text: string; options: string[]; timeoutSec?: number; answer(v: string | null): void }[];
  withdrawn: string[];
  timers: { ms: number; fire(ok: boolean): void }[];
  execs: { cmd: string; cwd: string; timeoutSec: number }[];
  execResult: { exitCode: number; stdout: string; stderr: string };
  paused: { gate: Promise<void> | null };
  dirs: { artifacts: string; cwd: string };
  appendDelay: number;
}

function fake(initial: { key: string | null; payload: JournalPayload }[] = [], dirs?: { artifacts: string; cwd: string }): Fake {
  const events: JournalEvent[] = [];
  const ac = new AbortController();
  const clock = { now: 1_000_000 };
  const f: Fake = {
    events,
    abort: () => ac.abort(),
    clock,
    asks: [],
    withdrawn: [],
    timers: [],
    execs: [],
    execResult: { exitCode: 0, stdout: "ok", stderr: "" },
    paused: { gate: null },
    dirs: dirs ?? { artifacts: "/tmp/gt/art", cwd: "/tmp/gt/cwd" },
    appendDelay: 0,
    host: null as unknown as GateHost,
  };
  const push = (key: string | null, payload: JournalPayload): JournalEvent => {
    const event: JournalEvent = { runId: "r1", seq: events.length + 1, at: clock.now, key, payload };
    events.push(event);
    return event;
  };
  for (const e of initial) push(e.key, e.payload);
  f.host = {
    runId: "r1",
    append: async (key, payload) => {
      if (f.appendDelay) await new Promise((r) => setTimeout(r, f.appendDelay));
      return push(key, payload);
    },
    events: () => events,
    signal: ac.signal,
    whenRunning: () => f.paused.gate ?? Promise.resolve(),
    timer: (ms) =>
      new Promise<boolean>((resolve) => {
        const entry = { ms, fire: (ok: boolean) => resolve(ok) };
        f.timers.push(entry);
        ac.signal.addEventListener("abort", () => resolve(false), { once: true });
      }),
    now: () => clock.now,
    artifactDir: async () => f.dirs.artifacts,
    cwd: () => f.dirs.cwd,
    ask: (q) => {
      let resolve!: (v: string | null) => void;
      const answer = new Promise<string | null>((r) => (resolve = r));
      const entry = { id: `q${f.asks.length}`, ...q, answer: (v: string | null) => resolve(v) };
      f.asks.push(entry);
      return { id: entry.id, answer };
    },
    withdraw: (id) => void f.withdrawn.push(id),
    exec: async (cmd, o) => {
      f.execs.push({ cmd, ...o });
      return { ...f.execResult };
    },
  };
  return f;
}

const kinds = (f: Fake) => f.events.map((e) => `${e.key}:${e.payload.kind}`);
const rejects = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, re);

console.log("workflow-gates");

// ---- approvals ----
await test("approve: happy path journals asked then answered and folds resolved", async () => {
  const f = fake();
  const g = new Gates(f.host);
  const p = g.hooks().approve("ship it?", { options: ["yes", "no"] });
  await settle();
  assert.equal(f.asks.length, 1);
  assert.deepEqual(f.asks[0]!.options, ["yes", "no"]);
  f.asks[0]!.answer("yes");
  assert.equal(await p, "yes");
  assert.deepEqual(kinds(f), ["gate:0:approval_asked", "gate:0:approval_answered"]);
  const view = fold(f.events).gates[0]!;
  assert.deepEqual([view.key, view.status, view.choice, view.text], ["gate:0", "resolved", "yes", "ship it?"]);
});

await test("approve: waits while the run is paused", async () => {
  const f = fake();
  let release!: () => void;
  f.paused.gate = new Promise<void>((r) => (release = r));
  const g = new Gates(f.host);
  const p = g.hooks().approve("x", { options: ["a"] });
  await settle();
  assert.equal(f.asks.length, 0);
  assert.deepEqual(kinds(f), ["gate:0:approval_asked"]);
  release();
  await settle();
  assert.equal(f.asks.length, 1);
  f.asks[0]!.answer("a");
  assert.equal(await p, "a");
});

await test("approve: timeout => null, journaled as by:timeout, folds timed_out", async () => {
  const f = fake();
  const g = new Gates(f.host);
  const p = g.hooks().approve("quick?", { options: ["y"], timeoutSec: 5 });
  await settle();
  assert.equal(f.asks[0]!.timeoutSec, 5);
  f.asks[0]!.answer(null);
  assert.equal(await p, null);
  const answered = f.events[1]!.payload;
  assert.equal(answered.kind, "approval_answered");
  if (answered.kind === "approval_answered") assert.deepEqual([answered.choice, answered.by, answered.reason], [null, "timeout", "timed out"]);
  assert.equal(fold(f.events).gates[0]!.status, "timed_out");
});

await test("approve: cancel withdraws, journals no answer, and the gate resumes next time", async () => {
  const f = fake();
  const g = new Gates(f.host);
  const p = g.hooks().approve("keep?", { options: ["k", "d"], timeoutSec: 600 });
  await settle();
  f.abort();
  await rejects(p, /the run was cancelled/);
  assert.deepEqual(f.withdrawn, ["q0"]);
  assert.deepEqual(kinds(f), ["gate:0:approval_asked"]);
  assert.equal(fold(f.events).gates[0]!.status, "waiting");
  // restart: a new Gates over the same journal re-parks without a second asked event.
  const f2 = fake(f.events.map((e) => ({ key: e.key, payload: e.payload })));
  const g2 = new Gates(f2.host);
  const p2 = g2.hooks().approve("keep?", { options: ["k", "d"], timeoutSec: 600 });
  await settle();
  assert.equal(f2.asks.length, 1);
  assert.equal(f2.asks[0]!.text, "keep?");
  assert.deepEqual(f2.asks[0]!.options, ["k", "d"]);
  assert.equal(f2.asks[0]!.timeoutSec, 600);
  assert.equal(f2.events.filter((e) => e.payload.kind === "approval_asked").length, 1);
  f2.asks[0]!.answer("d");
  assert.equal(await p2, "d");
});

await test("approve: a resumed approval asks with the REMAINING timeout; an expired one times out without asking", async () => {
  const f = fake([{ key: "gate:0", payload: { kind: "approval_asked", text: "t", options: ["a"], timeoutSec: 100, askedAt: 1_000_000 - 40_000 } }]);
  const g = new Gates(f.host);
  const p = g.hooks().approve("t", { options: ["a"], timeoutSec: 100 });
  await settle();
  assert.ok(Math.abs(f.asks[0]!.timeoutSec! - 60) < 0.01);
  f.asks[0]!.answer("a");
  await p;
  const f2 = fake([{ key: "gate:0", payload: { kind: "approval_asked", text: "t", options: ["a"], timeoutSec: 10, askedAt: 1_000_000 - 40_000 } }]);
  assert.equal(await new Gates(f2.host).hooks().approve("t", { options: ["a"], timeoutSec: 10 }), null);
  assert.equal(f2.asks.length, 0);
  assert.equal(f2.events.at(-1)!.payload.kind, "approval_answered");
});

await test("approve: replay of an answered gate returns it with no ask", async () => {
  const f = fake([
    { key: "gate:0", payload: { kind: "approval_asked", text: "a", options: ["y", "n"], askedAt: 1 } },
    { key: "gate:0", payload: { kind: "approval_answered", choice: "n", by: "user" } },
    { key: "gate:1", payload: { kind: "approval_asked", text: "b", options: ["y"], askedAt: 1 } },
    { key: "gate:1", payload: { kind: "approval_answered", choice: null, by: "timeout", reason: "timed out" } },
  ]);
  const g = new Gates(f.host);
  assert.equal(await g.hooks().approve("a", { options: ["y", "n"] }), "n");
  assert.equal(await g.hooks().approve("b", { options: ["y"] }), null);
  assert.equal(f.asks.length, 0);
  assert.equal(f.events.length, 4);
});

await test("answerApproval: validates the choice, resolves the waiter, refuses a double answer", async () => {
  const f = fake();
  const g = new Gates(f.host);
  const p = g.hooks().approve("go?", { options: ["go", "stop"] });
  await settle();
  assert.equal(await g.answerApproval("gate:9", "go", "me"), false);
  assert.equal(await g.answerApproval("gate:0", "bogus", "me"), false);
  assert.equal(await g.answerApproval("gate:0", "stop", "alice"), true);
  assert.equal(await p, "stop");
  assert.deepEqual(f.withdrawn, ["q0"]);
  assert.equal(await g.answerApproval("gate:0", "go", "bob"), false);
  const answered = f.events.filter((e) => e.payload.kind === "approval_answered");
  assert.equal(answered.length, 1);
  assert.deepEqual((answered[0]!.payload as { by: string }).by, "alice");
});

await test("answerApproval: a double answer in the same tick has exactly one winner", async () => {
  const f = fake();
  const g = new Gates(f.host);
  const p = g.hooks().approve("go?", { options: ["go", "stop"] });
  await settle();
  const [a, b] = await Promise.all([g.answerApproval("gate:0", "go", "a"), g.answerApproval("gate:0", "stop", "b")]);
  assert.deepEqual([a, b], [true, false]);
  assert.equal(await p, "go");
});

await test("answerApproval: answers a journaled-but-not-yet-replayed gate straight into the journal", async () => {
  const f = fake([{ key: "gate:0", payload: { kind: "approval_asked", text: "t", options: ["a", "b"], askedAt: 1 } }]);
  const g = new Gates(f.host);
  assert.equal(await g.answerApproval("gate:0", "zz", "me"), false);
  assert.equal(await g.answerApproval("gate:0", "b", "me"), true);
  assert.equal(await g.answerApproval("gate:0", "a", "me"), false);
  assert.equal(await g.hooks().approve("t", { options: ["a", "b"] }), "b");
  assert.equal(f.asks.length, 0);
});

await test("approve: two gates in a row take gate:0 and gate:1", async () => {
  const f = fake();
  const g = new Gates(f.host);
  const p1 = g.hooks().approve("one", { options: ["x"] });
  const p2 = g.hooks().approve("two", { options: ["x"] });
  await settle();
  assert.deepEqual(
    f.events.map((e) => e.key),
    ["gate:0", "gate:1"],
  );
  f.asks[1]!.answer("x");
  f.asks[0]!.answer("x");
  await Promise.all([p1, p2]);
});

// ---- timers ----
await test("sleep: journals set then fired through host.timer; folds resolved", async () => {
  const f = fake();
  const g = new Gates(f.host);
  const p = g.hooks().sleep(30);
  await settle();
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0]!.ms, 30_000);
  assert.deepEqual(g.pendingTimers(), [{ key: "timer:0", fireAt: 1_030_000 }]);
  assert.equal(fold(f.events).gates[0]!.status, "waiting");
  f.timers[0]!.fire(true);
  await p;
  assert.deepEqual(kinds(f), ["timer:0:timer_set", "timer:0:timer_fired"]);
  assert.deepEqual(g.pendingTimers(), []);
  assert.equal(fold(f.events).gates[0]!.status, "resolved");
});

await test("sleep: cancel rejects without journaling a fire; replay resumes with the time left", async () => {
  const f = fake();
  const g = new Gates(f.host);
  const p = g.hooks().sleep(100);
  await settle();
  f.abort();
  await rejects(p, /the run was cancelled/);
  assert.deepEqual(kinds(f), ["timer:0:timer_set"]);
  const f2 = fake(f.events.map((e) => ({ key: e.key, payload: e.payload })));
  f2.clock.now += 60_000;
  const g2 = new Gates(f2.host);
  assert.deepEqual(g2.pendingTimers(), [{ key: "timer:0", fireAt: 1_100_000 }]);
  const p2 = g2.hooks().sleep(100);
  await settle();
  assert.equal(f2.timers.length, 1);
  assert.equal(f2.timers[0]!.ms, 40_000);
  assert.equal(f2.events.filter((e) => e.payload.kind === "timer_set").length, 1);
  f2.timers[0]!.fire(true);
  await p2;
  assert.equal(f2.events.at(-1)!.payload.kind, "timer_fired");
});

await test("sleep: replay of a fired timer arms nothing; an overdue one fires without arming", async () => {
  const f = fake([
    { key: "timer:0", payload: { kind: "timer_set", fireAt: 5, reason: "sleep 1s" } },
    { key: "timer:0", payload: { kind: "timer_fired" } },
    { key: "timer:1", payload: { kind: "timer_set", fireAt: 5, reason: "sleep 1s" } },
  ]);
  const g = new Gates(f.host);
  await g.hooks().sleep(1);
  await g.hooks().sleep(1);
  assert.equal(f.timers.length, 0);
  assert.deepEqual(kinds(f).slice(3), ["timer:1:timer_fired"]);
});

await test("until: invalid throws, past journals set+fired at once, future waits", async () => {
  const f = fake();
  const g = new Gates(f.host);
  await rejects(g.hooks().until("not a date"), /valid ISO/);
  assert.equal(f.events.length, 0);
  await g.hooks().until(new Date(f.clock.now - 1000).toISOString());
  assert.equal(f.timers.length, 0);
  assert.deepEqual(kinds(f), ["timer:0:timer_set", "timer:0:timer_fired"]);
  const p = g.hooks().until(new Date(f.clock.now + 5000).toISOString());
  await settle();
  assert.equal(f.timers[0]!.ms, 5000);
  f.timers[0]!.fire(true);
  await p;
  assert.equal(f.events.at(-1)!.key, "timer:1");
});

// ---- signals ----
await test("waitFor: signal after the wait resolves it; FIFO between two waiters", async () => {
  const f = fake();
  const g = new Gates(f.host);
  const a = g.hooks().waitFor("go", {});
  const b = g.hooks().waitFor("go", {});
  await settle();
  assert.equal(await g.signal("go", { n: 1 }), true);
  assert.equal(await g.signal("go", "two"), true);
  assert.deepEqual(await a, { n: 1 });
  assert.equal(await b, "two");
  assert.deepEqual(kinds(f).sort(), [
    "signal:go#0:signal_received",
    "signal:go#0:signal_waiting",
    "signal:go#1:signal_received",
    "signal:go#1:signal_waiting",
  ]);
  assert.ok(fold(f.events).gates.every((x) => x.kind === "signal" && x.status === "resolved" && x.signal === "go"));
});

await test("waitFor: a signal before the wait is buffered and consumed in order", async () => {
  const f = fake();
  const g = new Gates(f.host);
  assert.equal(await g.signal("evt", 1), true);
  assert.equal(await g.signal("evt", 2), true);
  assert.equal(f.events[0]!.key, "signal:evt#buffered0");
  assert.equal(await g.hooks().waitFor("evt", {}), 1);
  assert.equal(await g.hooks().waitFor("evt", {}), 2);
  const p = g.hooks().waitFor("evt", {});
  await settle();
  await g.signal("evt", 3);
  assert.equal(await p, 3);
  assert.equal(f.events.filter((e) => e.key === "signal:evt#0" && e.payload.kind === "signal_received").length, 1);
});

await test("signal: non-JSON value => false, journals nothing", async () => {
  const f = fake();
  const g = new Gates(f.host);
  const cyc: Record<string, unknown> = {};
  cyc.self = cyc;
  assert.equal(await g.signal("x", cyc), false);
  assert.equal(await g.signal("x", () => 1), false);
  assert.equal(f.events.length, 0);
});

await test("waitFor: timeout resolves null and journals signal_received under the wait key", async () => {
  const f = fake();
  const g = new Gates(f.host);
  const p = g.hooks().waitFor("never", { timeoutSec: 9 });
  await settle();
  assert.equal(f.timers[0]!.ms, 9000);
  f.timers[0]!.fire(true);
  assert.equal(await p, null);
  const last = f.events.at(-1)!;
  assert.equal(last.key, "signal:never#0");
  assert.deepEqual(last.payload, { kind: "signal_received", name: "never", value: null });
  assert.equal(fold(f.events).gates[0]!.status, "resolved");
  // the late signal is not delivered to the dead waiter; it buffers for the next wait.
  assert.equal(await g.signal("never", "late"), true);
  assert.equal(await g.hooks().waitFor("never", {}), "late");
});

await test("waitFor: replay returns the journaled value with no new events", async () => {
  const f = fake([
    { key: "signal:a#0", payload: { kind: "signal_waiting", name: "a", waitedAt: 1 } },
    { key: "signal:a#0", payload: { kind: "signal_received", name: "a", value: { v: 1 } } },
  ]);
  const g = new Gates(f.host);
  assert.deepEqual(await g.hooks().waitFor("a", {}), { v: 1 });
  assert.equal(f.events.length, 2);
  assert.equal(f.timers.length, 0);
});

await test("waitFor: an unresolved wait is resumed (no second waiting) with the remaining timeout", async () => {
  const f = fake([{ key: "signal:r#0", payload: { kind: "signal_waiting", name: "r", timeoutSec: 100, waitedAt: 1_000_000 - 70_000 } }]);
  const g = new Gates(f.host);
  const p = g.hooks().waitFor("r", { timeoutSec: 100 });
  await settle();
  assert.equal(f.events.length, 1);
  assert.ok(Math.abs(f.timers[0]!.ms - 30_000) < 1);
  await g.signal("r", "now");
  assert.equal(await p, "now");
  assert.equal(f.events.filter((e) => e.payload.kind === "signal_waiting").length, 1);
});

await test("waitFor: cancel rejects, journals nothing, and the signal arriving later is not lost", async () => {
  const f = fake();
  const g = new Gates(f.host);
  const p = g.hooks().waitFor("c", {});
  await settle();
  f.abort();
  await rejects(p, /the run was cancelled/);
  assert.equal(f.events.length, 1);
  assert.equal(await g.signal("c", 7), true); // no waiter any more: buffered
  assert.equal(f.events.at(-1)!.key, "signal:c#buffered0");
});

await test("signals buffered before a restart are served after it (once)", async () => {
  const f = fake([
    { key: "signal:s#buffered0", payload: { kind: "signal_received", name: "s", value: "A" } },
    { key: "signal:s#buffered1", payload: { kind: "signal_received", name: "s", value: "B" } },
    // A was already taken by wait #0 before the crash:
    { key: "signal:s#0", payload: { kind: "signal_received", name: "s", value: "A" } },
    { key: "signal:s#buffered0", payload: { kind: "signal_received", name: "s", value: "A" } },
  ]);
  const g = new Gates(f.host);
  assert.equal(await g.hooks().waitFor("s", {}), "A"); // replayed
  assert.equal(await g.hooks().waitFor("s", {}), "B"); // buffered
  assert.equal(await g.signal("s", "C"), true);
  assert.equal(f.events.at(-1)!.key, "signal:s#buffered2");
});

// ---- sh ----
await test("sh: runs once under the project cwd, journals, and replay never re-executes", async () => {
  const f = fake([], { artifacts: "/tmp/gt/art", cwd: "/tmp" });
  f.execResult = { exitCode: 3, stdout: "out", stderr: "err" };
  const g = new Gates(f.host);
  assert.deepEqual(await g.hooks().sh("ls", {}), { exitCode: 3, stdout: "out", stderr: "err" });
  assert.deepEqual(f.execs, [{ cmd: "ls", cwd: "/tmp", timeoutSec: 120 }]);
  assert.equal(f.events[0]!.key, "sh:0");
  const f2 = fake(f.events.map((e) => ({ key: e.key, payload: e.payload })), { artifacts: "/tmp/gt/art", cwd: "/tmp" });
  const again = await new Gates(f2.host).hooks().sh("ls", {});
  assert.deepEqual(again, { exitCode: 3, stdout: "out", stderr: "err" });
  assert.equal(f2.execs.length, 0);
});

await test("sh: a relative cwd resolves inside the project; escapes are refused before exec", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gates-sh-"));
  try {
    await writeFile(path.join(root, "f"), "x");
    const f = fake([], { artifacts: root, cwd: root });
    const g = new Gates(f.host);
    await g.hooks().sh("pwd", { cwd: "sub/dir", timeoutSec: 7 });
    assert.deepEqual(f.execs[0], { cmd: "pwd", cwd: path.join(root, "sub/dir"), timeoutSec: 7 });
    await rejects(g.hooks().sh("x", { cwd: "../outside" }), /outside the project/);
    await rejects(g.hooks().sh("x", { cwd: "a/../../b" }), /outside the project/);
    await rejects(g.hooks().sh("x", { cwd: "/etc" }), /outside the project/);
    assert.equal(await g.hooks().sh("x", { cwd: root }).then((r) => r.exitCode), 0);
    assert.equal(f.execs.length, 2);
    assert.equal(f.events.length, 4, "shell_started + shell, twice");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("sh: stdout and stderr are truncated to 64KB with a marker", async () => {
  const f = fake([], { artifacts: "/tmp/gt/art", cwd: "/tmp" });
  f.execResult = { exitCode: 0, stdout: "a".repeat(SH_OUTPUT_CAP + 500), stderr: "b".repeat(10) };
  const r = await new Gates(f.host).hooks().sh("big", {});
  assert.ok(r.stdout.startsWith("a".repeat(SH_OUTPUT_CAP)));
  assert.match(r.stdout, /\[stdout truncated: 500 more bytes\]$/);
  assert.equal(r.stderr, "b".repeat(10));
  assert.deepEqual((f.events.find((e) => e.payload.kind === "shell")!.payload as { stdout: string }).stdout, r.stdout);
});

// ---- artifacts ----
await test("artifact: strings as utf8, objects as JSON, journaled; replay skips a present file, rewrites a lost one", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gates-art-"));
  try {
    const f = fake([], { artifacts: dir, cwd: dir });
    const g = new Gates(f.host);
    await g.hooks().artifact("a.txt", "héllo");
    await g.hooks().artifact("b.json", { x: [1] });
    assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "héllo");
    assert.equal(await readFile(path.join(dir, "b.json"), "utf8"), JSON.stringify({ x: [1] }, null, 2));
    assert.deepEqual(f.events[0]!.payload, { kind: "artifact", name: "a.txt", relPath: "a.txt", bytes: Buffer.byteLength("héllo") });
    assert.deepEqual(fold(f.events).artifacts.map((x) => x.name), ["a.txt", "b.json"]);

    const seed = f.events.map((e) => ({ key: e.key, payload: e.payload }));
    await writeFile(path.join(dir, "a.txt"), "edited");
    const f2 = fake(seed, { artifacts: dir, cwd: dir });
    await new Gates(f2.host).hooks().artifact("a.txt", "héllo");
    assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "edited"); // present: not rewritten
    assert.equal(f2.events.length, 2); // nothing new
    await rm(path.join(dir, "b.json"));
    await new Gates(f2.host).hooks().artifact("a.txt", "héllo");
    await new Gates(f2.host).hooks().artifact("b.json", { x: [1] });
    assert.equal(await readFile(path.join(dir, "b.json"), "utf8"), JSON.stringify({ x: [1] }, null, 2));
    assert.equal(f2.events.length, 2); // rewritten, not re-recorded
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test("artifact: names that resolve outside the directory are refused", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gates-art-"));
  try {
    const f = fake([], { artifacts: dir, cwd: dir });
    const g = new Gates(f.host);
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "", ".", ".."]) {
      await rejects(g.hooks().artifact(bad, "no"), /outside|non-empty/);
    }
    assert.equal(f.events.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- state ----
await test("state: set is visible to get at once and journal order equals call order despite slow appends", async () => {
  const f = fake();
  f.appendDelay = 2;
  const g = new Gates(f.host);
  const h = g.hooks();
  h.setState("a.b", 1);
  assert.equal(h.getState("a.b"), 1);
  h.setState("a.b", 2);
  h.setState("c", { k: [1] });
  const got = h.getState("c") as { k: number[] };
  got.k.push(9); // a clone: the cache is untouched
  assert.deepEqual(h.getState("c"), { k: [1] });
  assert.equal(h.getState("nope.deeper"), undefined);
  await g.flush();
  assert.deepEqual(
    f.events.map((e) => [e.key, (e.payload as { path: string }).path, (e.payload as { value: unknown }).value]),
    [
      ["state:0", "a.b", 1],
      ["state:1", "a.b", 2],
      ["state:2", "c", { k: [1] }],
    ],
  );
  assert.deepEqual(fold(f.events).state, { a: { b: 2 }, c: { k: [1] } });
});

await test("state: replay does not append again and does not leak a later write to an earlier read", async () => {
  const f = fake();
  const g = new Gates(f.host);
  g.hooks().setState("n", 1);
  g.hooks().setState("n", 2);
  await g.flush();
  const f2 = fake(f.events.map((e) => ({ key: e.key, payload: e.payload })));
  const g2 = new Gates(f2.host);
  assert.equal(g2.hooks().getState("n"), undefined);
  g2.hooks().setState("n", 1);
  assert.equal(g2.hooks().getState("n"), 1);
  g2.hooks().setState("n", 2);
  g2.hooks().setState("n", 3); // beyond the journal: appended as state:2
  await g2.flush();
  assert.equal(g2.hooks().getState("n"), 3);
  assert.deepEqual(f2.events.map((e) => e.key), ["state:0", "state:1", "state:2"]);
});

await test("state: an append failure surfaces from flush", async () => {
  const f = fake();
  f.host.append = async () => {
    throw new Error("disk full");
  };
  const g = new Gates(f.host);
  g.hooks().setState("a", 1);
  await rejects(g.flush(), /disk full/);
});

// ---- a whole run, folded ----
await test("mixed run: events fold to one GateView per gate with the right statuses", async () => {
  const f = fake();
  const g = new Gates(f.host);
  const h = g.hooks();
  const a = h.approve("deploy?", { options: ["yes", "no"] });
  const t = h.sleep(1);
  const w = h.waitFor("hook", {});
  await settle();
  const mid = fold(f.events).gates.map((x) => `${x.key}:${x.kind}:${x.status}`);
  assert.deepEqual(mid, ["gate:0:approval:waiting", "timer:0:timer:waiting", "signal:hook#0:signal:waiting"]);
  f.asks[0]!.answer("yes");
  f.timers[0]!.fire(true);
  await g.signal("hook", 1);
  await Promise.all([a, t, w]);
  const done = fold(f.events).gates.map((x) => `${x.key}:${x.status}`);
  assert.deepEqual(done, ["gate:0:resolved", "timer:0:resolved", "signal:hook#0:resolved"]);
});

await test("mixed run: a full replay over the finished journal does nothing", async () => {
  const f = fake();
  const g = new Gates(f.host);
  const p = Promise.all([g.hooks().approve("q", { options: ["y"] }), g.hooks().sleep(1), g.hooks().waitFor("w", {})]);
  await settle();
  f.asks[0]!.answer("y");
  f.timers[0]!.fire(true);
  await g.signal("w", "v");
  await p;
  const seed = f.events.map((e) => ({ key: e.key, payload: e.payload }));
  const f2 = fake(seed);
  const g2 = new Gates(f2.host);
  const r = await Promise.all([g2.hooks().approve("q", { options: ["y"] }), g2.hooks().sleep(1), g2.hooks().waitFor("w", {})]);
  assert.deepEqual(r.slice(0, 1).concat(r.slice(2)), ["y", "v"]);
  assert.equal(f2.asks.length + f2.timers.length + f2.execs.length, 0);
  assert.equal(f2.events.length, seed.length);
  assert.deepEqual(g2.pendingTimers(), []);
});

// ---- review fixes ----

/** Postgres jsonb stores object keys by (length, alphabetical); a value that crossed the journal comes back so. */
function jsonbOrder<T>(value: T): T {
  if (Array.isArray(value)) return value.map(jsonbOrder) as unknown as T;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as object).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(keys.map((k) => [k, jsonbOrder((value as Record<string, unknown>)[k])])) as T;
  }
  return value;
}
/** A fake whose journal reorders keys on the way in AND out, like the real table. */
function jsonbFake(initial: { key: string | null; payload: JournalPayload }[] = []): Fake {
  const f = fake([]);
  const events: JournalEvent[] = [];
  const push = (key: string | null, payload: JournalPayload): JournalEvent => {
    const event: JournalEvent = { runId: "r1", seq: events.length + 1, at: f.clock.now, key, payload: jsonbOrder(payload) };
    events.push(event);
    return event;
  };
  for (const e of initial) push(e.key, e.payload);
  f.events.length = 0;
  f.host.append = async (key, payload) => push(key, payload);
  f.host.events = () => events;
  (f as unknown as { events: JournalEvent[] }).events = events;
  return f;
}

await test("B3: values handed to the script have the same key order live and after a jsonb round trip", async () => {
  const value = { zeta: 1, b: { yy: 1, x: 2, aaa: [{ q: 1, pp: 2 }] }, aa: 3, a: 4 };
  const f = jsonbFake();
  const g = new Gates(f.host);
  const w = g.hooks().waitFor("hook", {});
  await settle();
  await g.signal("hook", value);
  const live = await w;
  g.hooks().setState("cfg", value);
  const liveState = g.hooks().getState("cfg");
  f.execResult = { exitCode: 0, stdout: "o", stderr: "e" };
  const liveSh = await g.hooks().sh("echo", {});
  const seed = f.events.map((e) => ({ key: e.key, payload: e.payload }));
  await g.flush();
  const f2 = jsonbFake(f.events.map((e) => ({ key: e.key, payload: e.payload })));
  void seed;
  const g2 = new Gates(f2.host);
  const replayed = await g2.hooks().waitFor("hook", {});
  g2.hooks().setState("cfg", value);
  const replayState = g2.hooks().getState("cfg");
  const replaySh = await g2.hooks().sh("echo", {});
  assert.equal(JSON.stringify(replayed), JSON.stringify(live));
  assert.equal(JSON.stringify(replayState), JSON.stringify(liveState));
  assert.equal(JSON.stringify(replaySh), JSON.stringify(liveSh));
  assert.deepEqual(Object.keys(live as object), ["a", "aa", "b", "zeta"], "canonical order");
  assert.equal(f2.execs.length, 0, "replay ran nothing");
});

await test("B3: a buffered signal replays in canonical order too", async () => {
  const f = jsonbFake();
  const g = new Gates(f.host);
  await g.signal("early", { bb: 1, a: 2 });
  const f2 = jsonbFake(f.events.map((e) => ({ key: e.key, payload: e.payload })));
  const got = await new Gates(f2.host).hooks().waitFor("early", {});
  assert.equal(JSON.stringify(got), '{"a":2,"bb":1}');
});

await test("B10: a route answer a tick after the host's is refused, and the result is the host's", async () => {
  const f = fake();
  const g = new Gates(f.host);
  const p = g.hooks().approve("go?", { options: ["go", "stop"] });
  await settle();
  f.asks[0]!.answer("go");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(await g.answerApproval("gate:0", "stop", "late"), false);
  assert.equal(await p, "go");
  const answered = f.events.filter((e) => e.payload.kind === "approval_answered");
  assert.equal(answered.length, 1);
  assert.equal((answered[0]!.payload as { choice: string }).choice, "go");
});

await test("B10: host and route answering in one breath: exactly one counts and the callers are told truthfully", async () => {
  const f = fake();
  const g = new Gates(f.host);
  const p = g.hooks().approve("go?", { options: ["go", "stop"] });
  await settle();
  f.asks[0]!.answer("go");
  const route = g.answerApproval("gate:0", "stop", "bob");
  const chosen = await p;
  const routeSaid = await route;
  assert.equal(routeSaid, chosen === "stop", "the route is told true only if its choice is the one that counted");
  assert.equal(f.events.filter((e) => e.payload.kind === "approval_answered").length, 1);
  assert.equal(await g.answerApproval("gate:0", "go", "again"), false);
});

await test("N8: the parked question is withdrawn after every outcome, not only a route win", async () => {
  const f = fake();
  const g = new Gates(f.host);
  const p = g.hooks().approve("q", { options: ["y"] });
  await settle();
  f.asks[0]!.answer("y");
  await p;
  assert.deepEqual(f.withdrawn, ["q0"]);
  const f2 = fake();
  const g2 = new Gates(f2.host);
  const p2 = g2.hooks().approve("q", { options: ["y"], timeoutSec: 5 });
  await settle();
  f2.asks[0]!.answer(null);
  assert.equal(await p2, null);
  assert.deepEqual(f2.withdrawn, ["q0"]);
});

await test("R5: sh journals shell_started BEFORE it runs", async () => {
  const f = fake();
  let seen: string[] = [];
  const exec = f.host.exec;
  f.host.exec = async (cmd, o) => {
    seen = kinds(f);
    return exec(cmd, o);
  };
  await new Gates(f.host).hooks().sh("touch x", { cwd: undefined });
  assert.deepEqual(seen, ["sh:0:shell_started"]);
  assert.deepEqual(kinds(f), ["sh:0:shell_started", "sh:0:shell"]);
});

await test("R5: a started-but-unfinished sh is not re-run on replay unless idempotent", async () => {
  const seed = [{ key: "sh:0", payload: { kind: "shell_started", cmd: "deploy", cwd: null } as JournalPayload }];
  const f = fake(seed);
  await rejects(new Gates(f.host).hooks().sh("deploy", {}), /may have already run[\s\S]*idempotent: true/);
  assert.equal(f.execs.length, 0);
  const f2 = fake(seed);
  const r = await new Gates(f2.host).hooks().sh("deploy", { idempotent: true } as never);
  assert.equal(r.exitCode, 0);
  assert.equal(f2.execs.length, 1);
  assert.deepEqual(kinds(f2), ["sh:0:shell_started", "sh:0:shell"], "no second shell_started");
});

await test("R10: a timer set before a restart fires on wall clock — the downtime counts", async () => {
  const f = fake([{ key: "timer:0", payload: { kind: "timer_set", fireAt: 1_000_000 + 60_000, reason: "sleep 60s" } }]);
  f.clock.now += 3_600_000; // the server was down an hour
  await new Gates(f.host).hooks().sleep(60);
  assert.equal(f.timers.length, 0, "no wait: already due");
  assert.equal(f.events.at(-1)!.payload.kind, "timer_fired");
});

console.log(`\n${passed} passed${failures.length ? `, ${failures.length} failed: ${failures.join(", ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
