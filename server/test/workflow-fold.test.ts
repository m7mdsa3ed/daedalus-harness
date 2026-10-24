// Self-check for the workflow journal fold (src/workflows/fold.ts), pure — no database:
//   - a happy path folds steps, phases, logs, state, artifacts and usage.
//   - retry returns to running and then completes; failures keep their error.
//   - approvals resolve, or time out on a null choice; timers and signals are gates.
//   - a duplicate seq is ignored, out-of-order seqs are sorted.
//   - run_finished carries the result and wins over the header status.
// Run: pnpm exec tsx test/workflow-fold.test.ts
import "./require-temp-data.js";
import assert from "node:assert/strict";

const { foldRun, stepOutputs, LOG_CAP } = await import("../src/workflows/fold.js");
import type { JournalEvent, JournalPayload, RunSpec, RunStatus } from "../src/workflows/types.js";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`);
  }
}

const spec: RunSpec = {
  source: "",
  meta: { name: "demo", description: "", phases: [{ title: "Plan", detail: "think" }, { title: "Build" }] },
  args: null,
  budgets: { tokens: 1000 },
  flow: {},
  trigger: { kind: "agent" },
  onRestart: "resume",
};

function header(over: Partial<{ status: RunStatus; error: string | null; endedAt: number | null }> = {}) {
  return { id: "r1", name: "demo", status: "running" as RunStatus, error: null, createdAt: 100, endedAt: null, spec, ...over };
}

let seq = 0;
function ev(key: string | null, payload: JournalPayload, at = 1000 + seq, forceSeq?: number): JournalEvent {
  seq += 1;
  return { runId: "r1", seq: forceSeq ?? seq, at, key, payload };
}
const reset = () => {
  seq = 0;
};

const started = (name: string, attempt = 1, phase: string | null = null): JournalPayload => ({
  kind: "step_started", name, phase, sessionId: `s-${name}`, attempt, startedAt: 500,
});
const completed = (name: string, output: unknown, tokens: number, costUsd?: number): JournalPayload => ({
  kind: "step_completed", name, output, sessionId: `s-${name}`, tokens, toolUses: 2, ...(costUsd === undefined ? {} : { costUsd }),
});

test("happy path folds everything", () => {
  reset();
  const events = [
    ev(null, { kind: "run_started", spec }),
    ev(null, { kind: "phase", title: "Plan" }),
    ev(null, { kind: "phase", title: "Ship" }),
    ev("a#0", started("a", 1, "Plan")),
    ev(null, { kind: "log", message: "hello" }),
    ev("a#0", completed("a", { x: 1 }, 100, 0.5)),
    ev("b#0", started("b")),
    ev(null, { kind: "state_set", path: "a.b.c", value: 7 }),
    ev(null, { kind: "state_set", path: "a.d", value: "x" }),
    ev(null, { kind: "artifact", name: "out", relPath: "out.txt", bytes: 3 }),
    ev("b#0", completed("b", "done", 50)),
  ];
  const view = foldRun(header(), events);
  assert.equal(view.steps.length, 2);
  assert.equal(view.steps[0]!.status, "completed");
  assert.deepEqual(view.steps[0]!.output, { x: 1 });
  assert.equal(view.steps[0]!.phase, "Plan");
  assert.equal(view.steps[0]!.attempt, 1);
  assert.equal(view.steps[0]!.endedAt, events[5]!.at);
  assert.equal(view.steps[1]!.output, "done");
  assert.deepEqual(view.phases, [{ name: "Plan", detail: "think" }, { name: "Build" }, { name: "Ship" }]);
  assert.deepEqual(view.logs, ["hello"]);
  assert.deepEqual(view.state, { a: { b: { c: 7 }, d: "x" } });
  assert.deepEqual(view.artifacts, [{ name: "out", relPath: "out.txt", bytes: 3 }]);
  assert.deepEqual(view.usage, { tokens: 150, costUsd: 0.5, agents: 2 });
  assert.deepEqual(view.budgets, { tokens: 1000 });
  assert.equal(view.result, undefined);
  assert.equal(view.status, "running");
});

test("state_set replaces a non-object parent and refuses prototype keys", () => {
  reset();
  const view = foldRun(header(), [
    ev(null, { kind: "state_set", path: "a", value: 1 }),
    ev(null, { kind: "state_set", path: "a.b", value: 2 }),
    ev(null, { kind: "state_set", path: "__proto__.polluted", value: true }),
  ]);
  assert.deepEqual(view.state, { a: { b: 2 } });
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("log keeps the newest LOG_CAP lines", () => {
  reset();
  const events: JournalEvent[] = [];
  for (let i = 0; i < LOG_CAP + 20; i += 1) events.push(ev(null, { kind: "log", message: `l${i}` }));
  const view = foldRun(header(), events);
  assert.equal(view.logs.length, LOG_CAP);
  assert.equal(view.logs[0], "l20");
  assert.equal(view.logs.at(-1), `l${LOG_CAP + 19}`);
});

test("retry then completion", () => {
  reset();
  const events = [
    ev("a#0", started("a", 1)),
    ev("a#0", { kind: "step_retry", name: "a", attempt: 1, error: "boom", backoffSec: 2 }),
  ];
  let view = foldRun(header(), events);
  assert.equal(view.steps[0]!.status, "retrying");
  assert.equal(view.steps[0]!.error, "boom");
  events.push(ev("a#0", started("a", 2)), ev("a#0", completed("a", "ok", 10)));
  view = foldRun(header(), events);
  assert.equal(view.steps[0]!.status, "completed");
  assert.equal(view.steps[0]!.attempt, 2);
  assert.equal(view.steps[0]!.error, null);
  assert.equal(view.usage.agents, 1);
});

test("failed and skipped steps; failed tokens count, skipped do not", () => {
  reset();
  const view = foldRun(header(), [
    ev("a#0", started("a")),
    ev("a#0", { kind: "step_failed", name: "a", error: "nope", sessionId: null, tokens: 30, toolUses: 1 }),
    ev("b#0", { kind: "step_skipped", name: "b", reason: "upstream failed" }),
  ]);
  assert.equal(view.steps[0]!.status, "failed");
  assert.equal(view.steps[0]!.error, "nope");
  assert.equal(view.steps[0]!.sessionId, "s-a");
  assert.equal(view.steps[1]!.status, "skipped");
  assert.equal(view.usage.tokens, 30);
  assert.equal(view.usage.agents, 1);
});

test("approval asked, then answered", () => {
  reset();
  const asked = ev("gate:1", { kind: "approval_asked", text: "ship?", options: ["yes", "no"], askedAt: 1 });
  let view = foldRun(header(), [asked]);
  assert.equal(view.gates.length, 1);
  assert.deepEqual(view.gates[0], { key: "gate:1", kind: "approval", status: "waiting", text: "ship?", options: ["yes", "no"] });
  assert.equal(view.steps.length, 0);
  view = foldRun(header(), [asked, ev("gate:1", { kind: "approval_answered", choice: "yes", by: "me" })]);
  assert.equal(view.gates[0]!.status, "resolved");
  assert.equal(view.gates[0]!.choice, "yes");
  assert.equal(view.gates[0]!.text, "ship?");
});

test("approval asked, then timed out", () => {
  reset();
  const view = foldRun(header(), [
    ev("gate:1", { kind: "approval_asked", text: "ship?", options: ["yes"], timeoutSec: 5, askedAt: 1 }),
    ev("gate:1", { kind: "approval_answered", choice: null, by: "timeout" }),
  ]);
  assert.equal(view.gates[0]!.status, "timed_out");
  assert.equal(view.gates[0]!.choice, null);
});

test("timer gate", () => {
  reset();
  const set = ev("timer:1", { kind: "timer_set", fireAt: 9000, reason: "sleep 5s" });
  let view = foldRun(header(), [set]);
  assert.equal(view.gates[0]!.kind, "timer");
  assert.equal(view.gates[0]!.status, "waiting");
  assert.equal(view.gates[0]!.fireAt, 9000);
  view = foldRun(header(), [set, ev("timer:1", { kind: "timer_fired" })]);
  assert.equal(view.gates[0]!.status, "resolved");
  assert.equal(view.gates[0]!.fireAt, 9000);
});

test("signal gate", () => {
  reset();
  const waiting = ev("signal:go", { kind: "signal_waiting", name: "go", waitedAt: 1 });
  let view = foldRun(header(), [waiting]);
  assert.equal(view.gates[0]!.kind, "signal");
  assert.equal(view.gates[0]!.signal, "go");
  assert.equal(view.gates[0]!.status, "waiting");
  view = foldRun(header(), [waiting, ev("signal:go", { kind: "signal_received", name: "go", value: 1 })]);
  assert.equal(view.gates[0]!.status, "resolved");
  assert.equal(view.gates.length, 1);
});

test("duplicate seq is ignored", () => {
  reset();
  const begun = ev("a#0", started("a"));
  const done = ev("a#0", completed("a", "ok", 10));
  const view = foldRun(header(), [begun, done, { ...done }, { ...done, payload: completed("a", "other", 999) }]);
  assert.equal(view.steps[0]!.output, "ok");
  assert.equal(view.usage.tokens, 10);
});

test("out-of-order seq is sorted first", () => {
  reset();
  const a = ev("a#0", started("a"));
  const b = ev("a#0", completed("a", "ok", 10));
  const c = ev(null, { kind: "log", message: "1" });
  const d = ev(null, { kind: "log", message: "2" });
  const view = foldRun(header(), [d, b, c, a]);
  assert.equal(view.steps[0]!.status, "completed");
  assert.deepEqual(view.logs, ["1", "2"]);
});

test("run_finished carries the result and wins over the header", () => {
  reset();
  const events = [
    ev("a#0", started("a")),
    ev(null, { kind: "run_finished", status: "budget_exceeded", error: "tokens", result: { partial: true } }, 7777),
  ];
  const view = foldRun(header({ status: "running" }), events);
  assert.equal(view.status, "budget_exceeded");
  assert.equal(view.error, "tokens");
  assert.deepEqual(view.result, { partial: true });
  assert.equal(view.endedAt, 7777);
  const withHeaderEnd = foldRun(header({ status: "completed", endedAt: 5 }), events);
  assert.equal(withHeaderEnd.status, "budget_exceeded");
  assert.equal(withHeaderEnd.endedAt, 5);
});

test("without run_finished the header status and error win", () => {
  reset();
  const view = foldRun(header({ status: "paused", error: "held" }), [ev(null, { kind: "run_paused" })]);
  assert.equal(view.status, "paused");
  assert.equal(view.error, "held");
  const failed = foldRun(header({ status: "failed", error: "x", endedAt: 9 }), []);
  assert.equal(failed.status, "failed");
  assert.equal(failed.endedAt, 9);
  assert.deepEqual(failed.phases, [{ name: "Plan", detail: "think" }, { name: "Build" }]);
});

test("stepOutputs lists completed steps only", () => {
  reset();
  const map = stepOutputs([
    ev("a#0", started("a")),
    ev("a#0", completed("a", { v: 1 }, 1)),
    ev("b#0", started("b")),
    ev("c#0", { kind: "step_failed", name: "c", error: "e", sessionId: null, tokens: 0, toolUses: 0 }),
    ev("d#0", { kind: "step_completed", name: "d", output: 4, sessionId: null, tokens: 0, toolUses: 0 }),
  ]);
  assert.deepEqual([...map.keys()], ["a#0", "d#0"]);
  assert.deepEqual(map.get("a#0"), { output: { v: 1 }, sessionId: "s-a" });
  assert.deepEqual(map.get("d#0"), { output: 4, sessionId: null });
});

test("the new kinds are accepted and change nothing; an unknown future kind never throws", () => {
  const base = foldRun(header(), [ev(null, { kind: "run_started", spec }), ev("s#0", started("s"))]);
  const more = foldRun(header(), [
    ev(null, { kind: "run_started", spec }),
    ev(null, { kind: "run_recovered" }),
    ev("sh:0", { kind: "shell_started", cmd: "ls", cwd: null }),
    ev(null, { kind: "workflow_loaded", ref: "x", sha: "abc", source: "s" }),
    ev("s#0", started("s")),
    ev(null, { kind: "from_the_future", whatever: 1 } as unknown as JournalPayload),
  ]);
  assert.deepEqual(more.steps.map((s) => [s.name, s.status]), base.steps.map((s) => [s.name, s.status]));
  assert.deepEqual(more.gates, []);
  assert.equal(more.usage.agents, 1);
  assert.deepEqual(stepOutputs([ev(null, { kind: "from_the_future" } as unknown as JournalPayload)]).size, 0);
});

test("B3: folded values are in canonical key order whatever order the journal stored them in", () => {
  const view = foldRun(header(), [
    ev("a#0", started("a")),
    ev("a#0", { kind: "step_completed", name: "a", output: { zz: 1, b: { yy: 1, x: 2 }, a: 0 }, sessionId: null, tokens: 0, toolUses: 0 }),
    ev("state:0", { kind: "state_set", path: "cfg", value: { bb: 1, a: 2 } }),
    ev(null, { kind: "run_finished", status: "completed", error: null, result: { yy: 1, x: 2 } }),
  ]);
  assert.equal(JSON.stringify(view.steps[0]!.output), '{"a":0,"b":{"x":2,"yy":1},"zz":1}');
  assert.equal(JSON.stringify(view.state), '{"cfg":{"a":2,"bb":1}}');
  assert.equal(JSON.stringify(view.result), '{"x":2,"yy":1}');
  assert.equal(JSON.stringify(stepOutputs([ev("a#0", { kind: "step_completed", name: "a", output: { zz: 1, a: 0 }, sessionId: null, tokens: 0, toolUses: 0 })]).get("a#0")!.output), '{"a":0,"zz":1}');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
