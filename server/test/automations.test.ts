// Self-check for the folded automations model (docs/plans/automations.md,
// phases 1-2) against the fake agent:
//   - a `session`-mode routine delivers into its existing thread through the
//     engine, deriving profile/agent/project from that thread
//   - every skipped run carries a skip_reason code (disabled, thread-missing,
//     thread-trashed, overlap, missed)
//   - catch-up: the latest missed slot runs once, older ones are logged as one
//     "missed" row; `catchup: "none"` and slots older than 7 days only log
//   - five failed/undeliverable runs in a row switch the routine off and push
//   - the scheduled_messages boot migration is idempotent
//   - the legacy createScheduled/listScheduled/updateScheduled/deleteScheduled
//     surface still works over the routine model, and a one-shot is spent
// Run: pnpm test:automations
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { rmSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson } from "../src/config.js";
import type { Profile } from "../src/profiles.js";

rmSync(process.env.DAEDALUS_DATA_DIR!, { recursive: true, force: true });
mkdirSync("/tmp/daedalus-test-automations/ws", { recursive: true });
writeJson(join(process.env.DAEDALUS_DATA_DIR!, "agents.json"), [
  {
    id: "fake",
    name: "Fake",
    command: "node",
    args: [join(dirname(fileURLToPath(import.meta.url)), "fake-agent.mjs")],
    env: {},
  },
]);

const { SessionManager } = await import("../src/sessions.js");
const { RoutineEngine, createRoutine, createTrigger, getRoutine, getRun, listRoutines, listRuns, listTriggers } = await import("../src/routines.js");
const { sweepNow, createScheduled, listScheduled, updateScheduled, deleteScheduled, fire } = await import("../src/scheduler.js");
const { migrateScheduledMessages } = await import("../src/scheduled-migration.js");
const { emptyLinks } = await import("../src/db/links.js");
const { db, schema } = await import("../src/db/index.js");
const { eq } = await import("drizzle-orm");

const profile: Profile = {
  id: "p1", name: "test", agents: { fake: {} }, baseUrl: "", apiKey: "", models: [], defaultModel: "", smallModel: "", logoUrl: "",
};
const project = { id: "w1", name: "test-ws", cwd: "/tmp/daedalus-test-automations/ws", description: null };
await db.insert(schema.profiles).values({ ...profile } as never).onConflictDoNothing();
await db.insert(schema.projects).values({ id: "w1", name: "test-ws", cwd: project.cwd, description: null, logoUrl: "" } as never).onConflictDoNothing();

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? error.stack : String(error)}`);
  }
}
const waitFor = async (predicate: () => boolean | Promise<boolean>, what: string, ms = 20_000) => {
  for (let i = 0; i < ms / 25 && !(await predicate()); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(await predicate(), `timed out waiting for ${what}`);
};
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

const notified: { title: string; body: string }[] = [];
const manager = await new SessionManager({ onProcessGone: (s) => engine.cancelForSession(s.id, "process gone") }, 60);
const engine = new RoutineEngine(manager, {
  port: 4997,
  notify: async (title, body) => {
    notified.push({ title, body });
  },
});

const makeThread = async (title: string) =>
  await manager.create(profile, "fake", project as never, undefined, undefined, undefined, {}, emptyLinks(), { title });
const turnsOf = async (id: string) => ((await manager.journal(id))?.events ?? []).filter((e) => e.ev === "turn_started").length;
const runDone = async (id: string) => (await getRun(id))!.status !== "running";

console.log("automations");

const thread = await makeThread("target");
// A first turn so the thread has a persisted row (the migration test needs one).
await manager.prompt(thread.id, "echo:hello");
await waitFor(async () => (await turnsOf(thread.id)) >= 1, "the first turn");

let seq = 0;
const sessionRoutine = async (sessionId: string, over: Record<string, unknown> = {}) =>
  await createRoutine({
    name: `s${++seq}`,
    runsIn: "session",
    sessionId,
    body: { kind: "prompt", text: "echo:ping" },
    ...over,
  } as never);

await test("a session-mode routine derives its owner from the thread and delivers into it", async () => {
  const r = await sessionRoutine(thread.id);
  assert.equal(r.runsIn, "session");
  assert.equal(r.profileId, "p1");
  assert.equal(r.agentId, "fake");
  assert.equal(r.projectId, "w1");
  const before = await turnsOf(thread.id);
  const started = await engine.fire(r.id, { source: "manual" });
  assert.equal(started.status, "running");
  await waitFor(() => runDone(started.id), "the delivery");
  const run = (await getRun(started.id))!;
  assert.equal(run.status, "completed", run.error ?? "");
  assert.equal(run.sessionId, thread.id);
  assert.equal(run.skipReason, null);
  await waitFor(async () => (await turnsOf(thread.id)) > before, "the thread to take the prompt");
});

await test("a session-mode routine needs a sessionId and a prompt body", async () => {
  await assert.rejects(createRoutine({ name: "x", runsIn: "session", body: { kind: "prompt", text: "a" } } as never), /sessionId/);
  await assert.rejects(
    createRoutine({ name: "x", runsIn: "session", sessionId: thread.id, body: { kind: "workflow", definition: {} } } as never),
    /prompt body/,
  );
  await assert.rejects(createRoutine({ name: "x", body: { kind: "prompt", text: "a" } } as never), /required/);
});

await test("skipped runs carry a reason code", async () => {
  const gone = await sessionRoutine("no-such-thread");
  const a = await engine.fire(gone.id, { source: "manual" });
  assert.equal(a.status, "skipped");
  assert.equal(a.skipReason, "thread-missing");
  assert.ok(a.error);

  const trashedThread = await makeThread("trashed");
  const t = await sessionRoutine(trashedThread.id);
  manager.get(trashedThread.id)!.deletedAt = Date.now();
  const b = await engine.fire(t.id, { source: "manual" });
  assert.equal(b.skipReason, "thread-trashed");

  const off = await sessionRoutine(thread.id, { enabled: false });
  const c = await engine.fire(off.id, { source: "manual" });
  assert.equal(c.status, "skipped");
  assert.equal(c.skipReason, "disabled");

  const slow = await createRoutine({
    name: "slow", projectId: "w1", profileId: "p1", agentId: "fake", body: { kind: "prompt", text: "echo:x" },
  });
  const first = await engine.fire(slow.id, { source: "manual" });
  const second = await engine.fire(slow.id, { source: "manual" });
  assert.equal(second.skipReason, "overlap");
  await waitFor(() => runDone(first.id), "the first run");
});

await test("an on-time slot fires without a missed row; the clock rolls forward", async () => {
  const r = await sessionRoutine(thread.id);
  const t = await createTrigger(r.id, { kind: "schedule", intervalMs: 3600_000 });
  await db.update(schema.routineTriggers).set({ nextFireAt: Date.now() - 1000 }).where(eq(schema.routineTriggers.id, t.id));
  await sweepNow();
  await waitFor(async () => (await listRuns(r.id)).length === 1 && (await runDone((await listRuns(r.id))[0]!.id)), "the scheduled run");
  const runs = await listRuns(r.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.source, "schedule");
  assert.equal(runs[0]!.status, "completed");
  const after = (await listTriggers(r.id))[0]!;
  assert.ok(after.nextFireAt! > Date.now() + 3000_000, "anchored one interval ahead");
  assert.ok(after.lastFiredAt);
});

await test("catch-up runs the latest missed slot once and logs the older ones", async () => {
  const r = await sessionRoutine(thread.id);
  const t = await createTrigger(r.id, { kind: "schedule", intervalMs: 3600_000 });
  await db.update(schema.routineTriggers).set({ nextFireAt: Date.now() - 3 * 3600_000 - 5000 }).where(eq(schema.routineTriggers.id, t.id));
  await sweepNow();
  await waitFor(async () => (await listRuns(r.id)).length === 2, "two rows");
  const runs = await listRuns(r.id);
  const missed = runs.find((x) => x.skipReason === "missed")!;
  const ran = runs.find((x) => x.skipReason === null)!;
  assert.equal(missed.status, "skipped");
  assert.match(missed.error!, /^3 scheduled run/);
  assert.equal(ran.source, "schedule");
  await waitFor(() => runDone(ran.id), "the catch-up run");
  assert.equal((await getRun(ran.id))!.status, "completed");
});

await test("catchup none and slots past 7 days only log", async () => {
  const none = await sessionRoutine(thread.id, { catchup: "none" });
  const t1 = await createTrigger(none.id, { kind: "schedule", intervalMs: 3600_000 });
  await db.update(schema.routineTriggers).set({ nextFireAt: Date.now() - 2 * 3600_000 }).where(eq(schema.routineTriggers.id, t1.id));
  const old = await sessionRoutine(thread.id);
  const t2 = await createTrigger(old.id, { kind: "schedule", intervalMs: 24 * 3600_000 });
  await db.update(schema.routineTriggers).set({ nextFireAt: Date.now() - 8 * 24 * 3600_000 }).where(eq(schema.routineTriggers.id, t2.id));
  await sweepNow();
  await waitFor(async () => (await listRuns(none.id)).length === 1 && (await listRuns(old.id)).length === 1, "the missed rows");
  for (const id of [none.id, old.id]) {
    const runs = await listRuns(id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, "skipped");
    assert.equal(runs[0]!.skipReason, "missed");
    assert.equal(runs[0]!.sessionId, null);
  }
  for (const id of [t1.id, t2.id]) {
    const t = (await db.select().from(schema.routineTriggers).where(eq(schema.routineTriggers.id, id)))[0]!;
    assert.ok(t.nextFireAt! > Date.now(), "the clock still rolled forward");
  }
});

await test("a one-off fires once and is spent", async () => {
  const r = await sessionRoutine(thread.id);
  const t = await createTrigger(r.id, { kind: "schedule", atMs: Date.now() - 1000 });
  await db.update(schema.routineTriggers).set({ nextFireAt: Date.now() - 1000 }).where(eq(schema.routineTriggers.id, t.id));
  await sweepNow();
  await sweepNow();
  await waitFor(async () => (await listRuns(r.id)).length === 1, "the run");
  await settle(100);
  assert.equal((await listRuns(r.id)).length, 1, "not fired twice");
  assert.equal((await listTriggers(r.id))[0]!.enabled, false);
});

await test("an ephemeral notice is never listed and is gone once it fires", async () => {
  const s = await createScheduled({ sessionId: thread.id, text: "echo:notice", nextAt: Date.now() - 1000, ephemeral: true });
  assert.ok(!(await listRoutines()).some((r) => r.id === s.id), "hidden from the list");
  await sweepNow();
  await waitFor(async () => (await getRoutine(s.id)) === undefined, "the delete");
});

await test("five undeliverable runs in a row switch the routine off and say so", async () => {
  const r = await sessionRoutine("also-gone");
  notified.length = 0;
  for (let i = 0; i < 5; i++) {
    await settle(5);
    await engine.fire(r.id, { source: "manual" });
  }
  await waitFor(async () => (await getRoutine(r.id))!.enabled === false, "the auto-disable");
  assert.equal(notified.length, 1);
  assert.match(notified[0]!.title, /paused/);
});

await test("the scheduled_messages migration is idempotent", async () => {
  const now = Date.now();
  await db.insert(schema.scheduledMessages).values([
    { id: "legacy-every", sessionId: thread.id, text: "echo:legacy loop", nextAt: now + 60_000, everyMs: 600_000, enabled: 1, skippedAt: now, lastError: "the thread is in the trash", skipCount: 2, createdAt: now - 1000 },
    { id: "legacy-once", sessionId: thread.id, text: "echo:legacy once", nextAt: now + 120_000, everyMs: null, enabled: 0, skippedAt: null, lastError: null, skipCount: 0, createdAt: now - 1000 },
    { id: "legacy-parked", sessionId: thread.id, text: "echo:parked", nextAt: now + 1, everyMs: null, enabled: 1, skippedAt: now, lastError: "the thread no longer exists", skipCount: 20, createdAt: now - 1000 },
  ] as never);
  assert.equal(await migrateScheduledMessages(), 3);
  const every = (await getRoutine("legacy-every"))!;
  assert.equal(every.runsIn, "session");
  assert.equal(every.sessionId, thread.id);
  assert.equal(every.profileId, "p1");
  assert.deepEqual(every.body, { kind: "prompt", text: "echo:legacy loop" });
  assert.equal(every.enabled, true);
  const et = (await listTriggers("legacy-every"))[0]!;
  assert.equal(et.kind, "schedule");
  assert.equal(et.intervalMs, 600_000);
  assert.equal(et.atMs, null);
  assert.equal(et.nextFireAt, now + 60_000);
  assert.equal(et.lastError, "the thread is in the trash");
  const once = (await getRoutine("legacy-once"))!;
  assert.equal(once.enabled, false);
  const ot = (await listTriggers("legacy-once"))[0]!;
  assert.equal(ot.atMs, now + 120_000);
  assert.equal(ot.intervalMs, null);
  assert.equal((await getRoutine("legacy-parked"))!.enabled, false, "a row the old sweep had parked stays off");

  assert.equal(await migrateScheduledMessages(), 0, "the marker stops a second pass");
  await db.delete(schema.appSettings).where(eq(schema.appSettings.key, "scheduledToRoutines"));
  assert.equal(await migrateScheduledMessages(), 0, "and so do the ids, without it");
  assert.equal((await listTriggers("legacy-every")).length, 1);
});

await test("the legacy scheduled surface works over the routine model", async () => {
  const before = (await listScheduled()).length;
  const row = await createScheduled({ sessionId: thread.id, text: "echo:old api", nextAt: Date.now() + 3600_000, everyMs: 900_000 });
  assert.equal(row.sessionId, thread.id);
  assert.equal(row.everyMs, 900_000);
  assert.equal(row.enabled, 1);
  assert.equal((await listScheduled()).length, before + 1);
  const paused = (await updateScheduled(row.id, { enabled: false, text: "echo:edited" }))!;
  assert.equal(paused.enabled, 0);
  assert.equal(paused.text, "echo:edited");
  const moved = (await updateScheduled(row.id, { nextAt: Date.now() + 7200_000, everyMs: null }))!;
  assert.equal(moved.everyMs, null);
  assert.equal(await updateScheduled("nope", { enabled: true }), undefined);
  assert.equal(await deleteScheduled(row.id), true);
  assert.equal(await deleteScheduled(row.id), false);

  // A one-shot due now is delivered by the sweep and then hidden, as the old table deleted it.
  const turns = await turnsOf(thread.id);
  const once = await createScheduled({ sessionId: thread.id, text: "echo:now", nextAt: Date.now() });
  await sweepNow();
  await waitFor(async () => (await turnsOf(thread.id)) > turns, "the one-shot's turn");
  assert.equal((await listScheduled()).some((s) => s.id === once.id), false);

  const direct = await turnsOf(thread.id);
  await fire(thread.id, "echo:direct", manager);
  await waitFor(async () => (await turnsOf(thread.id)) > direct, "fire()'s turn");
});

engine.shutdown();
for (const s of manager.list()) if (!s.exited) manager.retire(manager.get(s.id)!);
manager.shutdown();
console.log(`\n${passed} passed${failures.length ? `, ${failures.length} failed: ${failures.join(", ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
