// Self-check for the routine trigger clock (src/scheduler.ts):
//   - the stagger is deterministic, bounded by the interval, and never a flat
//     offset that could outrun a short period.
//   - a cron slot is computed forward from now, so missed slots collapse to one
//     fire rather than replaying a night of them.
//   - the one-minute floor stops a slot being returned twice.
//   - a one-off is spent by its own last_fired_at, and is not staggered.
//   - a bad expression and a bad timezone are recorded, never thrown.
//   - DST: the hour that does not exist fires once, and the hour that happens
//     twice fires once. This is the bug nobody debugs, because it happens twice
//     a year and is gone by the time anyone looks.
// Run: pnpm test:routine-triggers
import assert from "node:assert/strict";

const { fnv1a, nextSlot, staggerMs } = await import("../src/scheduler.js");

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

const ROUTINE = "11111111-2222-3333-4444-555555555555";
const DAY = 24 * 3600_000;

/** A schedule trigger with nothing set. Every case below overrides one field,
    which is also the assertion that nothing else on the row is consulted. */
const base = {
  routineId: ROUTINE,
  kind: "schedule" as const,
  cron: null as string | null,
  tz: null as string | null,
  atMs: null as number | null,
  lastFiredAt: null as number | null,
};

const at = (iso: string) => new Date(iso).getTime();

// ---- the stagger ----

test("fnv1a is stable and mixes", () => {
  assert.equal(fnv1a("a"), fnv1a("a"));
  assert.notEqual(fnv1a("a"), fnv1a("b"));
});

test("the stagger is bounded by the interval, never a flat offset", () => {
  // The failure this guards: a flat five minutes is longer than the period of
  // anything scheduled more often than every five minutes, so every fire would
  // land past its own next slot and walk out of its schedule for good.
  for (const interval of [60_000, 120_000, 300_000, 3600_000, DAY]) {
    const offset = staggerMs(ROUTINE, interval);
    assert.ok(offset >= 0 && offset < Math.min(300_000, interval), `${interval}: ${offset}`);
  }
});

test("the stagger is deterministic across calls and per routine", () => {
  assert.equal(staggerMs(ROUTINE, DAY), staggerMs(ROUTINE, DAY));
  assert.notEqual(staggerMs(ROUTINE, DAY), staggerMs("another-routine-id", DAY));
});

// ---- slots ----

test("a daily cron answers with the next slot plus this routine's stagger", () => {
  const from = at("2026-03-01T12:00:00Z");
  const slot = nextSlot({ ...base, cron: "0 9 * * *", tz: "UTC" }, from);
  assert.equal(slot.error, undefined);
  assert.equal(slot.at, at("2026-03-02T09:00:00Z") + staggerMs(ROUTINE, DAY));
});

test("missed slots collapse to one fire", () => {
  // A month of overnight downtime is one fire on the next slot, not thirty.
  const slot = nextSlot({ ...base, cron: "0 9 * * *", tz: "UTC", lastFiredAt: at("2026-02-01T09:00:00Z") }, at("2026-03-01T12:00:00Z"));
  assert.equal(slot.at, at("2026-03-02T09:00:00Z") + staggerMs(ROUTINE, DAY));
});

test("a slot whose stagger has not arrived yet is not skipped", () => {
  // Armed mid-window: 09:00 has passed but 09:00 + stagger has not, so today's
  // fire is still owed. The search starts a stagger's width in the past for it.
  const offset = staggerMs(ROUTINE, DAY);
  assert.ok(offset > 1000, "fixture needs a non-zero stagger");
  const from = at("2026-03-02T09:00:00Z") + offset - 1000;
  const slot = nextSlot({ ...base, cron: "0 9 * * *", tz: "UTC" }, from);
  assert.equal(slot.at, at("2026-03-02T09:00:00Z") + offset);
});

test("the one-minute floor stops a slot being returned twice", () => {
  // A minutely cron just fired: the next answer must be a minute away, not the
  // same slot again fifteen seconds later.
  const now = at("2026-03-02T09:00:30Z");
  const slot = nextSlot({ ...base, cron: "* * * * *", lastFiredAt: now }, now);
  assert.ok(slot.at !== null && slot.at > now + 60_000, String(slot.at));
});

test("a one-off answers once and is then spent", () => {
  const when = at("2026-03-02T09:00:00Z");
  // Not staggered: there is no interval to bound an offset by, and an instant a
  // person named should be the instant it fires.
  assert.equal(nextSlot({ ...base, atMs: when }, at("2026-03-01T00:00:00Z")).at, when);
  assert.equal(nextSlot({ ...base, atMs: when, lastFiredAt: when }, when + 1000).at, null);
});

test("a trigger with no clock answers null", () => {
  assert.equal(nextSlot({ ...base, kind: "api" as const, cron: "0 9 * * *" }).at, null);
  assert.equal(nextSlot({ ...base }).at, null);
});

test("a bad expression and a bad timezone are recorded, not thrown", () => {
  const bad = nextSlot({ ...base, cron: "nonsense" });
  assert.equal(bad.at, null);
  assert.ok(bad.error, "expected a reason");
  // croner accepts an unknown zone at construction and throws on the first date
  // conversion, so the catch has to wrap the evaluation and not just the parse.
  const zone = nextSlot({ ...base, cron: "0 9 * * *", tz: "Nowhere/Nope" });
  assert.equal(zone.at, null);
  assert.ok(zone.error, "expected a reason");
});

// ---- DST ----

test("the hour that does not exist fires once", () => {
  // 2026-03-08, America/New_York: clocks jump 02:00 -> 03:00, so 02:30 is never
  // on the wall. A daily 02:30 routine must fire that day (at 03:30 EDT) and
  // must not fire twice or drift into the following day.
  const t = { ...base, cron: "30 2 * * *", tz: "America/New_York" };
  const first = nextSlot(t, at("2026-03-07T12:00:00Z"));
  assert.equal(first.at, at("2026-03-08T07:30:00Z") + staggerMs(ROUTINE, DAY));
  const second = nextSlot({ ...t, lastFiredAt: first.at }, first.at!);
  assert.equal(second.at, at("2026-03-09T06:30:00Z") + staggerMs(ROUTINE, DAY));
});

test("the hour that happens twice fires once", () => {
  // 2026-11-01, America/New_York: 01:30 occurs at 05:30Z (EDT) and again at
  // 06:30Z (EST). A daily 01:30 routine takes the first and then goes to the
  // next day — the floor is what makes the second occurrence unreachable even
  // if the expression offered it.
  const t = { ...base, cron: "30 1 * * *", tz: "America/New_York" };
  const first = nextSlot(t, at("2026-10-31T12:00:00Z"));
  assert.equal(first.at, at("2026-11-01T05:30:00Z") + staggerMs(ROUTINE, DAY));
  const second = nextSlot({ ...t, lastFiredAt: first.at }, first.at!);
  assert.equal(second.at, at("2026-11-02T06:30:00Z") + staggerMs(ROUTINE, DAY));
});

console.log(`\n${passed} passed${failures.length ? `, ${failures.length} failed: ${failures.join(", ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
