// Journal against a real (scratch) Postgres: seq assignment, ordering, concurrency, folding.
// Run: pnpm test:workflow-journal
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const { db, sessions: sessionsTable, wfRuns, wfEvents } = await import("../src/db/index.js");
const { Journal } = await import("../src/workflows/journal.js");
const { eq } = await import("drizzle-orm");

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

const spec = {
  source: "export const meta = { name: 'j', description: 'd', phases: [{ title: 'One' }] }\nreturn 1",
  meta: { name: "j", description: "d", phases: [{ title: "One" }] },
  args: {},
  budgets: {},
  flow: {},
  trigger: { kind: "agent" as const },
  onRestart: "resume" as const,
};

/** A parent thread row to hang runs on (wf_runs.parent_session_id is a real FK). */
async function parentRow(): Promise<string> {
  const id = randomUUID();
  await db.insert(sessionsTable).values({ id, profileId: "p1", projectId: "w1", agentId: "fake", model: "m", effort: "", title: "t", createdAt: Date.now() });
  return id;
}

async function newRun(): Promise<string> {
  const parent = await parentRow();
  const id = randomUUID();
  await Journal.createRun({ id, parentSessionId: parent, projectId: null, name: "j", spec, notify: false, createdAt: Date.now() });
  return id;
}

await test("createRun writes the header and run_started at seq 1", async () => {
  const id = await newRun();
  const events = await new Journal().events(id);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.seq, 1);
  assert.equal(events[0]!.payload.kind, "run_started");
});

await test("append assigns gap-free increasing seq", async () => {
  const id = await newRun();
  const j = new Journal();
  await j.append(id, null, { kind: "phase", title: "One" });
  await j.append(id, null, { kind: "log", message: "hi" });
  const seqs = (await j.events(id)).map((e) => e.seq);
  assert.deepEqual(seqs, [1, 2, 3]);
});

await test("concurrent appends never collide or skip", async () => {
  const id = await newRun();
  const j = new Journal();
  await Promise.all(Array.from({ length: 40 }, (_, i) => j.append(id, null, { kind: "log", message: `m${i}` })));
  const seqs = (await j.events(id)).map((e) => e.seq);
  assert.deepEqual(seqs, Array.from({ length: 41 }, (_, i) => i + 1));
});

await test("two Journal instances share the seq counter", async () => {
  const id = await newRun();
  await Promise.all([new Journal().append(id, null, { kind: "log", message: "a" }), new Journal().append(id, null, { kind: "log", message: "b" })]);
  const seqs = (await new Journal().events(id)).map((e) => e.seq);
  assert.deepEqual(seqs, [1, 2, 3]);
});

await test("events(since) returns only the tail, in order", async () => {
  const id = await newRun();
  const j = new Journal();
  for (let i = 0; i < 5; i++) await j.append(id, null, { kind: "log", message: `m${i}` });
  assert.deepEqual((await j.events(id, 3)).map((e) => e.seq), [4, 5, 6]);
});

await test("view folds steps, usage and the finish", async () => {
  const id = await newRun();
  const j = new Journal();
  await j.append(id, "k#0", { kind: "step_started", name: "a", phase: null, sessionId: "s1", attempt: 1, startedAt: 1 });
  await j.append(id, "k#0", { kind: "step_completed", name: "a", output: "done", sessionId: "s1", tokens: 10, toolUses: 2 });
  await j.append(id, null, { kind: "run_finished", status: "completed", error: null, result: { ok: true } });
  await j.setStatus(id, "completed", null, Date.now(), { ok: true });
  const view = await j.view(id);
  assert.ok(view);
  assert.equal(view.status, "completed");
  assert.equal(view.steps.length, 1);
  assert.equal(view.steps[0]!.status, "completed");
  assert.equal(view.usage.tokens, 10);
  assert.deepEqual(view.result, { ok: true });
});

await test("runningRuns lists running and paused only", async () => {
  const a = await newRun();
  const b = await newRun();
  const j = new Journal();
  await j.setStatus(b, "completed", null, Date.now());
  const ids = (await j.runningRuns()).map((r) => r.id);
  assert.ok(ids.includes(a));
  assert.ok(!ids.includes(b));
});

await test("deleting the parent cascades the run and its events", async () => {
  const parent = await parentRow();
  const id = randomUUID();
  await Journal.createRun({ id, parentSessionId: parent, projectId: null, name: "c", spec, notify: false, createdAt: Date.now() });
  await db.delete(sessionsTable).where(eq(sessionsTable.id, parent));
  assert.equal((await db.select().from(wfRuns).where(eq(wfRuns.id, id))).length, 0);
  assert.equal((await db.select().from(wfEvents).where(eq(wfEvents.runId, id))).length, 0);
});

await test("R6: a NUL in any payload, spec or result is replaced, not an insert failure", async () => {
  const parent = await parentRow();
  const id = randomUUID();
  const nulSpec = { ...spec, source: "return 'a\u0000b'", args: { "k\u0000": ["x\u0000y"] } };
  await Journal.createRun({ id, parentSessionId: parent, projectId: null, name: "n\u0000m", spec: nulSpec, notify: false, createdAt: Date.now() });
  const j = new Journal();
  await j.append(id, "sh:0", { kind: "shell", cmd: "c", cwd: null, exitCode: 0, stdout: "out\u0000put", stderr: "" });
  await j.append(id, "s#0", { kind: "step_completed", name: "s", output: { text: "x\u0000", "n\u0000": 1 }, sessionId: null, tokens: 0, toolUses: 0 });
  await j.setStatus(id, "completed", "bad\u0000", Date.now(), { r: "\u0000" });
  const events = await j.events(id);
  assert.equal(events.length, 3);
  const text = JSON.stringify(events);
  assert.ok(!text.includes("\\u0000"), "no NUL survives");
  const shell = events[1]!.payload as { stdout: string };
  assert.equal(shell.stdout, "out\uFFFDput");
  assert.equal((await j.header(id))!.name, "n\uFFFDm");
  assert.equal((await j.header(id))!.spec.source, "return 'a\uFFFDb'");
});

await test("B3: events() returns stored payloads as they are (canonicalising is the readers' job)", async () => {
  const id = await newRun();
  const j = new Journal();
  const written = await j.append(id, "s#0", { kind: "step_completed", name: "s", output: { zz: 1, a: { yy: 1, x: 2 } }, sessionId: null, tokens: 0, toolUses: 0 });
  const [, stored] = await j.events(id);
  assert.deepEqual(stored!.payload, written.payload, "same value; only jsonb's own key order may differ");
});

await db.delete(sessionsTable).where(eq(sessionsTable.projectId, "w1"));
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
process.exit(0);
