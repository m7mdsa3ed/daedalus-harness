/**
 * The peak-schedule grammar one case at a time — run before trusting a badge.
 *
 *     pnpm test:peak   (from server/)
 *
 * Every sentence in here is one a provider's pricing page actually writes, and
 * the point of the table is that the *same* plan comes out of all the spellings
 * of it. `until` is checked against a known answer rather than against itself.
 */
import assert from "node:assert/strict";
import {
  bandLabel,
  clockLabel,
  daysLabel,
  nextTransition,
  parsePeak,
  peakMultiplier,
  peakSpans,
  peakState,
  upcomingTransitions,
  windowLabel,
  windowRun,
  zoneLabel,
} from "../src/peak.js";
/* Loaded for `knownPeakFor` alone. The module also holds the boot backfill, and
   this file runs without a database — the import is fine because the backfill
   is only *called* at boot, but keep this test on the pure matcher. */
import { knownPeakFor } from "../src/peak-schedules.js";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push(`${name}\n    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}

/** Monday 2026-08-17, so every weekday case is unambiguous. */
const MON = (hh: number, mm = 0) => Date.UTC(2026, 7, 17, hh, mm);
const SAT = (hh: number, mm = 0) => Date.UTC(2026, 7, 22, hh, mm);

const plan = (windows: string, extra: { when?: "peak" | "off-peak"; multiplier?: number } = {}) => {
  const parsed = parsePeak({ windows, ...extra });
  assert.ok(parsed, `did not parse: ${windows}`);
  return parsed;
};

test("deepseek: two UTC windows, weekdays", () => {
  const p = plan("01:00-04:00, 06:00-10:00 UTC");
  assert.deepEqual(p.windows.map(windowLabel), ["01:00-04:00", "06:00-10:00"]);
  assert.equal(p.zone.kind === "offset" && p.zone.minutes, 0);
  assert.equal(peakState(p, MON(2)).band, "premium");
  assert.equal(peakState(p, MON(5)).band, "standard");
  assert.equal(peakState(p, MON(6, 30)).band, "premium");
  assert.equal(peakState(p, MON(10)).band, "standard");
  assert.equal(peakMultiplier(p, MON(2)), 2);
  assert.equal(peakMultiplier(p, MON(5)), 1);
  // A weekend is off-peak when the weekdays are named.
  assert.equal(peakState(plan("Mon-Fri 01:00-04:00 UTC"), SAT(2)).band, "standard");
});

test("the same schedule, spelled four ways", () => {
  const canonical = plan("01:00-04:00, 06:00-10:00 UTC");
  const spellings = [
    "mon-fri 01:00-04:00 UTC, weekdays 06:00-10:00 UTC",
    "MON-FRI 1am-4am, 6am-10am UTC",
    "Weekdays 0100-0400 UTC; 0600-1000 UTC",
    "Mon-Fri 01.00-04.00 UTC and 06.00-10.00 UTC",
  ];
  for (const spelling of spellings) {
    const p = plan(spelling);
    assert.deepEqual(
      p.windows.map(windowLabel),
      canonical.windows.map(windowLabel),
      `windows differ for ${spelling}`,
    );
    /* Weekdays only: the canonical sentence names no days at all, so the two
       agree inside the working week and deliberately differ on a weekend. */
    assert.deepEqual(
      [MON(2), MON(5), MON(7), MON(11)].map((t) => peakState(p, t).band),
      [MON(2), MON(5), MON(7), MON(11)].map((t) => peakState(canonical, t).band),
      `states differ for ${spelling}`,
    );
  }
});

test("a named zone is not a UTC window", () => {
  // 09:00 Beijing is 01:00 UTC.
  const p = plan("22:00-08:00 Asia/Shanghai");
  assert.equal(zoneLabel(p.zone), "Asia/Shanghai");
  // 23:00 UTC is 07:00 in Shanghai, inside the window; 14:00 UTC is 22:00.
  assert.equal(peakState(p, MON(23)).band, "premium");
  assert.equal(peakState(p, MON(14)).band, "premium");
  // 08:00 UTC is 16:00 there — outside.
  assert.equal(peakState(p, MON(8)).band, "standard");
});

test("overnight window wraps midnight and the start day governs", () => {
  const p = plan("Mon-Fri 22:00-08:00 UTC");
  // Monday 23:00 is inside Monday's window; Tuesday 02:00 is Monday's tail.
  assert.equal(peakState(p, MON(23)).band, "premium");
  assert.equal(peakState(p, MON(2)).band, "standard", "Monday 02:00 is Sunday's tail");
  const tue = MON(23) + 24 * 3600_000;
  assert.equal(peakState(p, tue + 3 * 3600_000).band, "premium", "Tuesday 02:00 is Monday's tail");
  // Saturday 07:00 is still inside Friday's 22:00-08:00 run — the start day
  // governs, which is the whole reason the wrap is spelled out.
  assert.equal(peakState(p, SAT(7)).band, "premium");
});

test("off-peak schedules discount, and the badge asks about price not windows", () => {
  const p = plan("22:00-08:00 +08:00", { when: "off-peak", multiplier: 0.5 });
  assert.equal(zoneLabel(p.zone), "+08:00");
  // 15:00 UTC is 23:00 in +08:00 — inside, so half price and *not* dear.
  const inside = peakState(p, MON(15));
  assert.equal(inside.band, "discount");
  assert.equal(inside.multiplier, 0.5);
  // 04:00 UTC is 12:00 in +08:00 — outside, so the listed price stands. That is
  // `standard`, not "premium": absence of a discount is not a surcharge.
  const outside = peakState(p, MON(4));
  assert.equal(outside.band, "standard");
  assert.equal(outside.multiplier, 1);
});

test("until names the next boundary in the schedule's own clock", () => {
  const p = plan("01:00-04:00, 06:00-10:00 UTC");
  // At 02:00 the peak ends at 04:00.
  assert.equal(peakState(p, MON(2)).until, MON(4));
  assert.equal(clockLabel(MON(4), p.zone), "04:00 UTC");
  // At 05:00 the next boundary is the 06:00 window opening.
  assert.equal(peakState(p, MON(5)).until, MON(6));
  // At 11:00 the next change is tomorrow's 01:00.
  assert.equal(peakState(p, MON(11)).until, MON(25));
  // Nothing further to say on a schedule with no windows at all.
  assert.equal(parsePeak({ windows: "   " }), null);
  assert.equal(parsePeak(null), null);
});

test("unreadable is null, never a guess", () => {
  for (const bad of ["whenever we feel like it", "9-5", "peak hours", "25:00-26:00 UTC"]) {
    assert.equal(parsePeak({ windows: bad }), null, `should not parse: ${bad}`);
  }
  // A bare "9-5" is two readings at once (09:00 to 17:00, or nine hours from
  // nine), so it is refused rather than guessed at; two digits either side is
  // unambiguous and reads as a clock.
  assert.equal(parsePeak({ windows: "09-17 UTC" })?.windows.length, 1);
});

test("a range written backwards wraps midnight", () => {
  const p = plan("23:00-02:00 UTC");
  assert.equal(peakState(p, MON(23, 30)).band, "premium");
  assert.equal(peakState(p, MON(0, 30)).band, "premium");
  assert.equal(peakState(p, MON(12)).band, "standard");
});

test("defaults: peak, double, UTC", () => {
  const p = plan("02:00-03:00");
  assert.equal(p.when, "peak");
  assert.equal(p.multiplier, 2);
  assert.equal(zoneLabel(p.zone), "UTC");
});

test("the published rate cards match a family, not an id", () => {
  /* The two families that actually bill by the clock (peak-schedules.ts). Ids
     come from the gateways this harness is pointed at, so the `cmd/`, `cc/`
     and `cl/cline-free/` prefixes are real. */
  const deepseek = knownPeakFor("cmd/deepseek/deepseek-v4.1-flash");
  assert.deepEqual(deepseek, {
    windows: "Mon-Fri 01:00-04:00, 06:00-10:00 UTC",
    when: "peak",
    multiplier: 2,
  });
  assert.equal(knownPeakFor("deepseek-v4-pro")?.windows, deepseek?.windows);
  assert.equal(knownPeakFor("cmc/deepseek/deepseek-v4.1-flash")?.windows, deepseek?.windows);

  const glm = knownPeakFor("cmd/z-ai/glm-5.3-flash");
  assert.equal(glm?.windows, "Mon-Fri 14:00-18:00 Asia/Singapore");
  assert.equal(knownPeakFor("glm-5.3")?.windows, glm?.windows);

  /* Families that do NOT bill by the clock must not be stamped. Anthropic
     removed its peak-hour reduction on 2026-05-06; OpenAI and Mistral vary by
     tier, not by hour. See the module's own note. */
  for (const flat of ["cc/claude-sonnet-5-5", "cc/claude-opus-5-5", "cmc/gpt-6-luna", "codestral-latest"]) {
    assert.equal(knownPeakFor(flat), null, `${flat} has no time-of-day price`);
  }
  /* A free tier bills nothing, so a multiplier on it would be a badge about a
     price nobody pays. */
  assert.equal(knownPeakFor("oc/deepseek-v4.1-flash-free"), null);
  assert.equal(knownPeakFor("oc/glm-5.3-flash-free"), null);
});

test("both phases of a peak schedule are named, and off-peak is silent on price", () => {
  const p = plan("Mon-Fri 14:00-18:00 Asia/Singapore");
  // 06:00 UTC is 14:00 in Singapore: the window just opened.
  const atOpen = peakState(p, MON(6));
  assert.equal(atOpen.inside, true);
  assert.equal(atOpen.band, "premium");
  // 10:00 UTC is 18:00 there: it just closed, at the listed price.
  const atClose = peakState(p, MON(10));
  assert.equal(atClose.inside, false, "the phase the badge prints");
  assert.equal(atClose.band, "standard", "…and what it costs: the listed price");
});

test("the phase is named for what the price is doing, not which side of the windows", () => {
  /* The bug this holds: the badge read `state.inside`, so every hour inside an
     `off-peak` card's window — the *cheap* half — printed "Peak". The words come
     from the band, and a moment at the listed price is only "Off-peak" where the
     windows are the dear ones. */
  const peak = plan("Mon-Fri 14:00-18:00 Asia/Singapore");
  assert.equal(bandLabel(peakState(peak, MON(6)).band, peak), "Peak");
  assert.equal(bandLabel(peakState(peak, MON(10)).band, peak), "Off-peak");

  const night = plan("22:00-08:00 +08:00", { when: "off-peak", multiplier: 0.5 });
  assert.equal(bandLabel(peakState(night, MON(15)).band, night), "Off-peak");
  // Outside the discount is not a phase the card ever sold — it is the listed price.
  assert.equal(bandLabel(peakState(night, MON(4)).band, night), "Listed price");
});

test("a transition is read off the band each edge opens, so an off-peak card inverts", () => {
  const peak = plan("Mon-Fri 14:00-18:00 Asia/Singapore");
  // 08:00 UTC is 16:00 there: in force, so the change ahead is the window closing.
  const inside = upcomingTransitions(peak, MON(8));
  assert.equal(inside[0].at, MON(10));
  assert.equal(inside[0].band, "standard");
  assert.equal(inside[0].dearer, false, "the peak ends, it does not start");
  // Nothing dearer is ahead while the dear hour is the one we are in.
  assert.equal(inside.some((t) => t.dearer), false);

  // 10:30 UTC is 18:30 there: at the listed price, and tomorrow's 14:00 is next.
  const outside = upcomingTransitions(peak, MON(10, 30));
  assert.equal(outside[0].at, MON(30), "tomorrow's opening, on today's clock");
  assert.equal(outside[0].dearer, true);

  /* The same edges on an `off-peak` card mean the opposite: the window closing
     is the hour getting *dearer*, which is what a reader waiting to send wants
     named — and it is the same boundary `peakState` reports. */
  const night = plan("22:00-08:00 +08:00", { when: "off-peak", multiplier: 0.5 });
  // 15:00 UTC is 23:00 there — inside, cheap, and it ends at 08:00 local.
  const transitions = upcomingTransitions(night, MON(15));
  assert.equal(transitions[0].dearer, true);
  assert.equal(nextTransition(night, MON(15))?.band, "standard");
  assert.equal(peakState(night, MON(15)).until, transitions[0].at);
});

test("a weekday card names Monday morning from the middle of the weekend", () => {
  const p = plan("Mon-Fri 01:00-04:00 UTC");
  // Saturday noon is the listed price, and the next change is Monday 01:00 —
  // the answer a reader about to spend money needs, however far away it is.
  const next = nextTransition(p, SAT(12));
  assert.equal(next?.at, Date.UTC(2026, 7, 24, 1));
  assert.equal(next?.dearer, true);
});

test("a window's run is the one in force, else the next one", () => {
  const p = plan("01:00-04:00, 06:00-10:00 UTC");
  const first = p.windows[0];
  // Inside the window: the run being read is the one that is open, not tomorrow's.
  const open = windowRun(first, p.zone, MON(2));
  assert.equal(open?.start, MON(1));
  assert.equal(open?.end, MON(4));
  // After it: the next opening, tomorrow.
  const next = windowRun(first, p.zone, MON(5));
  assert.equal(next?.start, MON(25));
  assert.equal(next?.end, MON(28));
  // A weekend-only window seen on a Monday is five days off, not one.
  const weekend = plan("Sat-Sun 02:00-03:00 UTC").windows[0];
  assert.equal(windowRun(weekend, { kind: "offset", minutes: 0 }, MON(0))?.start, Date.UTC(2026, 7, 22, 2));
});

test("days are named the way the sentence wrote them", () => {
  const days = (windows: string) => daysLabel(parsePeak({ windows })!.windows[0].days);
  assert.equal(days("01:00-04:00 UTC"), "Every day");
  assert.equal(days("Mon-Fri 01:00-04:00 UTC"), "Weekdays");
  assert.equal(days("Sat-Sun 01:00-04:00 UTC"), "Weekends");
  assert.equal(days("Mon-Wed 01:00-04:00 UTC"), "Mon-Wed");
  assert.equal(days("Mon, Wed, Fri 01:00-04:00 UTC"), "Mon, Wed, Fri");
});

test("the day is cut into the stretches the price actually holds", () => {
  const p = plan("Mon-Fri 01:00-04:00, 06:00-10:00 UTC");
  const spans = peakSpans(p, MON(0), MON(24));
  // Hours since midnight, not `getUTCHours()`: the last stretch ends at 24:00,
  // which is 00:00 of the next day and would read back as zero.
  const hour = (t: number) => (t - MON(0)) / 3_600_000;
  assert.deepEqual(
    spans.map((s) => [hour(s.from), hour(s.to), s.band]),
    [
      [0, 1, "standard"],
      [1, 4, "premium"],
      [4, 6, "standard"],
      [6, 10, "premium"],
      [10, 24, "standard"],
    ],
  );
  // Nothing to draw over nothing.
  assert.deepEqual(peakSpans(p, MON(0), MON(0)), []);
});

if (failures.length) {
  console.error(`\npeak: ${failures.length} failed, ${passed} passed\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}\n`);
  process.exit(1);
}
console.log(`peak: ok (${passed} passed)`);
