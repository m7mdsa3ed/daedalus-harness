// Self-check for the workflow flow-control module (src/workflows/limits.ts):
//   - PausableTimer fires, pauses, resumes with the time left, clears.
//   - FlowScheduler never exceeds the global, run or key pool, orders by
//     priority then FIFO, never blocks behind a waiter its own pool holds
//     back, drops aborted waiters, releases idempotently, forgets on dropRun.
//   - BudgetTracker meters tokens, cost, agents and wall time (pause-aware,
//     seedable).
// Pure module: no database, so no temp-data guard.
// Run: pnpm exec tsx test/workflow-limits.test.ts
import assert from "node:assert/strict";

const { PausableTimer, FlowScheduler, BudgetTracker, estimateCostUsd } = await import("../src/workflows/limits.js");

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

console.log("PausableTimer");
await test("fires after its time and reports 0", async () => {
  let n = 0;
  const t = new PausableTimer(15, () => (n += 1));
  assert.ok(t.remaining() > 0 && t.remaining() <= 15);
  await sleep(45);
  assert.equal(n, 1);
  assert.equal(t.remaining(), 0);
  t.resume();
  t.pause();
  await sleep(10);
  assert.equal(n, 1);
});
await test("pause holds the remaining time and does not fire", async () => {
  let n = 0;
  const t = new PausableTimer(40, () => (n += 1));
  await sleep(15);
  t.pause();
  const left = t.remaining();
  assert.ok(left > 0 && left < 40, `left=${left}`);
  await sleep(60);
  assert.equal(n, 0);
  assert.equal(t.remaining(), left);
});
await test("resume fires after only the time that was left", async () => {
  let n = 0;
  const t = new PausableTimer(40, () => (n += 1));
  await sleep(20);
  t.pause();
  await sleep(40);
  t.resume();
  await sleep(10);
  assert.equal(n, 0);
  await sleep(50);
  assert.equal(n, 1);
});
await test("clear cancels and reports -1; resume stays dead", async () => {
  let n = 0;
  const t = new PausableTimer(15, () => (n += 1));
  t.clear();
  assert.equal(t.remaining(), -1);
  t.resume();
  await sleep(35);
  assert.equal(n, 0);
  assert.equal(t.remaining(), -1);
});
await test("pause twice and resume twice are harmless", async () => {
  let n = 0;
  const t = new PausableTimer(30, () => (n += 1));
  t.pause();
  t.pause();
  t.resume();
  t.resume();
  await sleep(60);
  assert.equal(n, 1);
});

await test("a delay past 2^31-1 ms is sliced, not clamped to 1 ms (sleep(30 days) must not fire at once)", async () => {
  const THIRTY_DAYS = 30 * 24 * 3600 * 1000;
  let n = 0;
  const t = new PausableTimer(THIRTY_DAYS, () => (n += 1));
  await sleep(40);
  assert.equal(n, 0, "Node would have fired a >2^31-1 delay after 1 ms");
  assert.ok(t.remaining() > THIRTY_DAYS - 5_000, `remaining=${t.remaining()}`);
  t.pause();
  assert.ok(t.remaining() > THIRTY_DAYS - 5_000);
  t.resume();
  t.clear();
  assert.equal(t.remaining(), -1);
});
await test("sliced timer re-arms between slices, fires once at the end, remaining stays right", () => {
  const realSet = globalThis.setTimeout;
  const armed: { fn: () => void; ms: number }[] = [];
  (globalThis as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms: number) => {
    armed.push({ fn, ms });
    return { unref() {} };
  }) as unknown;
  try {
    const MAX = 2 ** 31 - 1;
    let n = 0;
    const total = MAX * 2 + 1234;
    const t = new PausableTimer(total, () => (n += 1));
    assert.equal(armed.length, 1);
    assert.equal(armed[0].ms, MAX, "first slice is capped");
    armed[0].fn();
    assert.equal(n, 0, "a slice end is not the end");
    assert.equal(armed.length, 2);
    assert.equal(armed[1].ms, MAX);
    assert.ok(Math.abs(t.remaining() - (total - MAX)) < 50, `remaining=${t.remaining()}`);
    armed[1].fn();
    assert.equal(n, 0);
    assert.equal(armed.length, 3);
    assert.equal(armed[2].ms, 1234, "last slice is what is left");
    armed[2].fn();
    assert.equal(n, 1);
    assert.equal(t.remaining(), 0);
  } finally {
    globalThis.setTimeout = realSet;
  }
});

console.log("FlowScheduler");
const ac = () => new AbortController();
const req = (runId: string, over: Record<string, unknown> = {}) => ({
  runId,
  priority: 0,
  runConcurrency: 99,
  signal: ac().signal,
  ...over,
});
/** Has the promise settled yet? */
function watch<T>(p: Promise<T>) {
  const s: { done: boolean; value?: T; error?: Error } = { done: false };
  p.then(
    (v) => ((s.done = true), (s.value = v)),
    (e) => ((s.done = true), (s.error = e)),
  );
  return s;
}

await test("global cap holds waiters until a release", async () => {
  const s = new FlowScheduler(2);
  const a = await s.acquire(req("r1"));
  await s.acquire(req("r2"));
  const third = watch(s.acquire(req("r3")));
  await tick();
  assert.equal(third.done, false);
  assert.deepEqual([s.stats().global, s.stats().waiting], [2, 1]);
  a();
  await tick();
  assert.equal(third.done, true);
  assert.deepEqual([s.stats().global, s.stats().waiting], [2, 0]);
});
await test("run cap holds a run to its own width while others proceed", async () => {
  const s = new FlowScheduler(10);
  const a = await s.acquire(req("r1", { runConcurrency: 1 }));
  const second = watch(s.acquire(req("r1", { runConcurrency: 1 })));
  const other = watch(s.acquire(req("r2", { runConcurrency: 1 })));
  await tick();
  assert.equal(second.done, false);
  assert.equal(other.done, true);
  assert.deepEqual(s.stats().byRun, { r1: 1, r2: 1 });
  a();
  await tick();
  assert.equal(second.done, true);
  assert.equal(s.stats().byRun.r1, 1);
});
await test("key cap serialises a shared key across runs; keyLimit widens it", async () => {
  const s = new FlowScheduler(10);
  const a = await s.acquire(req("r1", { key: "repo", keyLimit: 1 }));
  const b = watch(s.acquire(req("r2", { key: "repo", keyLimit: 1 })));
  const free = watch(s.acquire(req("r3", { key: "other", keyLimit: 1 })));
  await tick();
  assert.equal(b.done, false);
  assert.equal(free.done, true);
  assert.deepEqual(s.stats().byKey, { repo: 1, other: 1 });
  a();
  await tick();
  assert.equal(b.done, true);

  const w = new FlowScheduler(10);
  await w.acquire(req("r1", { key: "k", keyLimit: 2 }));
  const second = watch(w.acquire(req("r2", { key: "k", keyLimit: 2 })));
  const third = watch(w.acquire(req("r3", { key: "k", keyLimit: 2 })));
  await tick();
  assert.equal(second.done, true);
  assert.equal(third.done, false);
});
await test("never exceeds any pool under churn", async () => {
  const s = new FlowScheduler(3);
  let live = 0;
  let peak = 0;
  const perRun: Record<string, number> = {};
  const work = async (run: string, i: number) => {
    const release = await s.acquire(req(run, { runConcurrency: 2, priority: i % 3, key: "k", keyLimit: 2 }));
    live += 1;
    perRun[run] = (perRun[run] ?? 0) + 1;
    peak = Math.max(peak, live);
    assert.ok(perRun[run] <= 2, "run cap");
    assert.ok(s.stats().global <= 3, "global cap");
    assert.ok((s.stats().byKey.k ?? 0) <= 2, "key cap");
    await sleep(2);
    live -= 1;
    perRun[run] -= 1;
    release();
  };
  await Promise.all(Array.from({ length: 24 }, (_, i) => work(`r${i % 4}`, i)));
  assert.ok(peak <= 2, `peak ${peak}`); // key cap of 2 is the tightest
  assert.deepEqual(s.stats(), { global: 0, waiting: 0, byRun: {}, byKey: {} });
});
await test("higher priority first, FIFO within a priority", async () => {
  const s = new FlowScheduler(1);
  const hold = await s.acquire(req("r0"));
  const order: string[] = [];
  const releases: (() => void)[] = [];
  const queue = (name: string, priority: number, run: string) =>
    s.acquire(req(run, { priority })).then((r) => {
      order.push(name);
      releases.push(r);
    });
  const all = [queue("low1", 0, "a"), queue("hi1", 5, "b"), queue("low2", 0, "c"), queue("hi2", 5, "d"), queue("mid", 2, "e")];
  hold();
  for (let i = 0; i < 5; i++) {
    await tick();
    releases.shift()?.();
  }
  await Promise.all(all);
  assert.deepEqual(order, ["hi1", "hi2", "mid", "low1", "low2"]);
});
await test("a high-priority waiter blocked by its own run pool does not block others", async () => {
  const s = new FlowScheduler(2);
  const held = await s.acquire(req("busy", { runConcurrency: 1, priority: 9 }));
  const blocked = watch(s.acquire(req("busy", { runConcurrency: 1, priority: 9 })));
  const low = watch(s.acquire(req("other", { priority: 0 })));
  await tick();
  assert.equal(blocked.done, false);
  assert.equal(low.done, true, "lower-priority waiter of another run proceeds");
  assert.equal(s.stats().global, 2);
  held();
  await tick();
  assert.equal(blocked.done, true, "admitted once its own run pool frees and the global has room");
  assert.deepEqual(s.stats().byRun, { busy: 1, other: 1 });
});
await test("a priority waiter blocked by its key does not block lower ones", async () => {
  const s = new FlowScheduler(5);
  await s.acquire(req("w", { key: "f", keyLimit: 1 }));
  const blocked = watch(s.acquire(req("x", { key: "f", keyLimit: 1, priority: 5 })));
  const free = watch(s.acquire(req("y", { priority: 0 })));
  await tick();
  assert.equal(blocked.done, false);
  assert.equal(free.done, true);
});
await test("abort while waiting rejects with AbortError and leaves the queue", async () => {
  const s = new FlowScheduler(1);
  const hold = await s.acquire(req("r1"));
  const c = ac();
  const waiting = s.acquire(req("r2", { signal: c.signal }));
  const later = watch(s.acquire(req("r3")));
  await tick();
  assert.equal(s.stats().waiting, 2);
  c.abort();
  await assert.rejects(waiting, (e: Error) => e.name === "AbortError" && e.message === "aborted");
  assert.equal(s.stats().waiting, 1);
  hold();
  await tick();
  assert.equal(later.done, true, "slot went to the live waiter, not the aborted one");
  assert.deepEqual(s.stats().byRun, { r3: 1 });
});
await test("an already-aborted signal rejects at once and takes nothing", async () => {
  const s = new FlowScheduler(1);
  const c = ac();
  c.abort();
  await assert.rejects(s.acquire(req("r1", { signal: c.signal })), (e: Error) => e.name === "AbortError");
  assert.deepEqual(s.stats(), { global: 0, waiting: 0, byRun: {}, byKey: {} });
});
await test("abort after admission is harmless", async () => {
  const s = new FlowScheduler(1);
  const c = ac();
  const release = await s.acquire(req("r1", { signal: c.signal }));
  c.abort();
  assert.equal(s.stats().global, 1);
  release();
  assert.equal(s.stats().global, 0);
});
await test("release is idempotent", async () => {
  const s = new FlowScheduler(1);
  const a = await s.acquire(req("r1"));
  const waiting = watch(s.acquire(req("r2")));
  a();
  a();
  a();
  await tick();
  assert.equal(waiting.done, true);
  assert.equal(s.stats().global, 1, "double release did not free a second slot");
});
await test("dropRun forgets a run's bookkeeping; its held slot still releases the global pool", async () => {
  const s = new FlowScheduler(1);
  const a = await s.acquire(req("r1", { key: "k", keyLimit: 1 }));
  const waiting = watch(s.acquire(req("r2")));
  s.dropRun("r1");
  assert.deepEqual(s.stats().byRun, {});
  assert.equal(s.stats().global, 1);
  assert.deepEqual(s.stats().byKey, { k: 1 });
  await tick();
  assert.equal(waiting.done, false, "dropRun does not free a held slot");
  a();
  await tick();
  assert.equal(waiting.done, true);
  assert.deepEqual(s.stats().byKey, {});
  assert.deepEqual(s.stats().byRun, { r2: 1 });
});
await test("dropRun wakes a waiter whose run pool was stale", async () => {
  const s = new FlowScheduler(5);
  await s.acquire(req("r1", { runConcurrency: 1 }));
  const waiting = watch(s.acquire(req("r1", { runConcurrency: 1 })));
  await tick();
  assert.equal(waiting.done, false);
  s.dropRun("r1");
  await tick();
  assert.equal(waiting.done, true);
});

console.log("BudgetTracker");
function clock() {
  let t = 1_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}
await test("no budgets: nothing is exceeded and agents are unlimited", () => {
  const b = new BudgetTracker({});
  b.addUsage({ tokens: 1e9, costUsd: 1e6 });
  for (let i = 0; i < 100; i++) assert.equal(b.tryStartAgent(), true);
  assert.equal(b.exceeded(), null);
});
await test("tokens", () => {
  const b = new BudgetTracker({ tokens: 100 });
  b.addUsage({ tokens: 100 });
  assert.equal(b.exceeded(), null);
  b.addUsage({ tokens: 1 });
  assert.equal(b.exceeded(), "tokens");
  assert.equal(b.usage().tokens, 101);
});
await test("costUsd", () => {
  const b = new BudgetTracker({ costUsd: 0.5 });
  b.addUsage({ costUsd: 0.3 });
  assert.equal(b.exceeded(), null);
  b.addUsage({ costUsd: 0.3, tokens: 5 });
  assert.equal(b.exceeded(), "costUsd");
  assert.equal(b.usage().tokens, 5);
});
await test("agents: tryStartAgent refuses past the cap and counts nothing", () => {
  const b = new BudgetTracker({ agents: 2 });
  assert.equal(b.tryStartAgent(), true);
  assert.equal(b.tryStartAgent(), true);
  assert.equal(b.tryStartAgent(), false);
  assert.equal(b.usage().agents, 2);
  assert.equal(b.exceeded(), null, "at the cap is not over it");
  assert.equal(new BudgetTracker({ agents: 0 }).tryStartAgent(), false);
});
await test("wallSec follows the injected clock", () => {
  const c = clock();
  const b = new BudgetTracker({ wallSec: 10 }, c.now);
  c.advance(9_000);
  assert.equal(b.usage().wallSec, 9);
  assert.equal(b.exceeded(), null);
  c.advance(1_500);
  assert.equal(b.exceeded(), "wallSec");
});
await test("wallSec excludes paused time", () => {
  const c = clock();
  const b = new BudgetTracker({ wallSec: 10 }, c.now);
  c.advance(4_000);
  b.pauseClock();
  b.pauseClock();
  c.advance(60_000);
  assert.equal(b.usage().wallSec, 4);
  assert.equal(b.exceeded(), null);
  b.resumeClock();
  b.resumeClock();
  c.advance(5_000);
  assert.equal(b.usage().wallSec, 9);
  assert.equal(b.exceeded(), null);
  c.advance(2_000);
  assert.equal(b.exceeded(), "wallSec");
});
await test("seed restores totals and the wall time spent so far", () => {
  const c = clock();
  const b = new BudgetTracker({ tokens: 1000, agents: 3, wallSec: 10 }, c.now);
  c.advance(500);
  b.seed({ tokens: 400, costUsd: 0.2, agents: 3, wallSec: 8 });
  assert.deepEqual(b.usage(), { tokens: 400, costUsd: 0.2, agents: 3, wallSec: 8 });
  assert.equal(b.tryStartAgent(), false, "seeded agents count against the cap");
  c.advance(1_000);
  assert.equal(b.usage().wallSec, 9);
  c.advance(1_500);
  assert.equal(b.exceeded(), "wallSec");
});
await test("seed while paused keeps the clock paused", () => {
  const c = clock();
  const b = new BudgetTracker({ wallSec: 10 }, c.now);
  b.pauseClock();
  b.seed({ tokens: 0, costUsd: 0, agents: 0, wallSec: 6 });
  c.advance(30_000);
  assert.equal(b.usage().wallSec, 6);
  b.resumeClock();
  c.advance(1_000);
  assert.equal(b.usage().wallSec, 7);
});
await test("exceeded reports the first in tokens, costUsd, agents, wallSec order", () => {
  const c = clock();
  const b = new BudgetTracker({ tokens: 1, costUsd: 1, agents: 1, wallSec: 1 }, c.now);
  c.advance(5_000);
  b.seed({ tokens: 5, costUsd: 5, agents: 5 });
  assert.equal(b.exceeded(), "tokens");
  b.seed({ tokens: 0, costUsd: 5, agents: 5 });
  assert.equal(b.exceeded(), "costUsd");
  b.seed({ tokens: 0, costUsd: 0, agents: 5 });
  assert.equal(b.exceeded(), "agents");
  b.seed({ tokens: 0, costUsd: 0, agents: 0 });
  assert.equal(b.exceeded(), "wallSec");
  assert.deepEqual(b.budgets(), { tokens: 1, costUsd: 1, agents: 1, wallSec: 1 });
});
await test("estimateCostUsd", () => {
  assert.equal(estimateCostUsd(1_000_000), 15);
  assert.equal(estimateCostUsd(1_000_000, 3), 3);
  assert.equal(estimateCostUsd(0), 0);
  assert.ok(Math.abs(estimateCostUsd(2_000) - 0.03) < 1e-12);
});

console.log(`\n${passed} passed${failures.length ? `, ${failures.length} failed: ${failures.join(", ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
