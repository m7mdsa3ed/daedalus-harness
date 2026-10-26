/**
 * Peak / off-peak billing windows — one pure parser and one pure evaluator, run
 * at both ends.
 *
 * A module of its own for the reason `tps.ts` and `delivery.ts` are: the badge
 * on the composer and anything the server ever draws from the same schedule
 * must agree, so the grammar and the arithmetic are one file, not two.
 *
 * ## Why a free-form string
 *
 * Providers do not agree on this. DeepSeek charges double inside two weekday
 * windows named in UTC; Alibaba discounts a night window named in Beijing time;
 * a gateway may sell either. Encoding one of those shapes as columns would have
 * made the other unrepresentable, so the row stores the sentence a person would
 * have copied off the pricing page (`ModelDef.peak`) and this file reads it.
 *
 * Accepted, in any combination, case-insensitive, with `,` `;` `&` or `and`
 * between windows, an en dash or the word `to` as the range, and the day list
 * or the zone carrying forward to the windows that follow:
 *
 *   01:00-04:00, 06:00-10:00 UTC
 *   Mon-Fri 01:00-04:00 UTC
 *   mon-fri 01:00-04:00 UTC, weekdays 06:00-10:00 UTC
 *   weekdays 9-17 Europe/Berlin
 *   22:00-08:00 +08:00          (overnight, wraps midnight)
 *   22:00-08:00 UTC+8
 *   22:00-08:00 Asia/Shanghai
 *   1am-4am, 6am-10am UTC
 *   0100-0400 UTC
 *
 * A bare `a-b` is read as hours (that is what the field is for); days come from
 * words — `mon`…`sun`, `weekdays`, `weekends`, `daily`. A range that runs
 * backwards wraps midnight, and its start day governs.
 *
 * ## What the two ends mean
 *
 * `multiplier` is what the listed `pricing` becomes *inside* the windows when
 * `when: "peak"` (DeepSeek: 2), and *outside* them when `when: "off-peak"`
 * (Alibaba's night discount: 0.5). One field, both directions, because the
 * question a badge answers is "am I paying more than the number on the row".
 */

/** How the schedule's windows relate to the listed price. */
export type PeakKind = "peak" | "off-peak";

/**
 * Stored on a model (`ModelDef.peak`). Deliberately tiny: a sentence, which
 * side of it is dear, and by how much. Everything else is this file's business.
 */
export interface PeakSchedule {
  /** The windows, in any dialect `parsePeak` reads. */
  windows: string;
  /** Default `"peak"`: the windows are the expensive time. */
  when?: PeakKind;
  /** Price inside the windows as a multiple of the listed price. Default 2. */
  multiplier?: number;
}

/** A timezone as the schedule names it: a fixed offset, or an IANA zone whose
    offset is asked for at the instant in question (so DST is the zone's). */
export type PeakZone =
  | { kind: "offset"; minutes: number }
  | { kind: "iana"; name: string };

/** One parsed window. Minutes are from local midnight; `days` are ISO weekday
    numbers (1 = Monday) and null means every day. */
export interface PeakWindow {
  start: number;
  end: number;
  days: number[] | null;
}

/** A schedule that parsed. `raw` is what the row holds, for display. */
export interface PeakPlan {
  raw: string;
  windows: PeakWindow[];
  zone: PeakZone;
  when: PeakKind;
  multiplier: number;
}

/** Which way the schedule bends the listed price at one moment.
    `standard` is the row's own number, exactly. */
export type PeakBand = "premium" | "discount" | "standard";

/** What a plan says about a moment. */
export interface PeakState {
  /** Whether the schedule's windows are in force right now. The structural
      fact, as opposed to `band`, which is what it does to the price — a
      `peak` schedule outside its windows is `off-peak` and charges the listed
      price, and the badge should say so rather than go quiet. */
  inside: boolean;
  /** What the price is doing right now — the one thing a badge prints. */
  band: PeakBand;
  /** The price at `at`, as a multiple of the listed price. 1 when standard. */
  multiplier: number;
  /** Epoch ms the band next changes, or null when the schedule never says. */
  until: number | null;
  /** The window in force, when one is. */
  window: PeakWindow | null;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** ISO weekday (1 = Monday) of a `Date` read as UTC. */
const isoDay = (d: Date): number => d.getUTCDay() || 7;

const DAY_NAMES: Record<string, number> = {
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
  sun: 7, sunday: 7,
};

/** Windows within a day are cheap to combine; a schedule never needs more. */
const MAX_WINDOWS = 24;

/** `"UTC"`, `"+08:00"`, `"GMT-3"`, `"UTC+8"`, `"z"` — a fixed offset, when the
    sentence names one. Returns null when the token is not one of those. */
function parseZoneToken(token: string): PeakZone | null {
  const t = token.trim().toLowerCase();
  if (!t) return null;
  let m = /^(?:utc|gmt)(?:\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?)?$/.exec(t);
  if (m) {
    if (!m[1]) return { kind: "offset", minutes: 0 };
    const sign = m[1] === "-" ? -1 : 1;
    const hours = Number(m[2]);
    const mins = Number(m[3] ?? 0);
    if (hours > 14 || mins > 59) return null;
    return { kind: "offset", minutes: sign * (hours * 60 + mins) };
  }
  m = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(t);
  if (m) {
    const sign = m[1] === "-" ? -1 : 1;
    const hours = Number(m[2]);
    const mins = Number(m[3] ?? 0);
    if (hours > 14 || mins > 59) return null;
    return { kind: "offset", minutes: sign * (hours * 60 + mins) };
  }
  if (t === "z") return { kind: "offset", minutes: 0 };
  return null;
}

/** Whether the runtime knows this zone name. Asked once per parse, so a typo is
    a schedule that draws nothing rather than a crash mid-render. */
function ianaZone(name: string): PeakZone | null {
  try {
    /* `resolvedOptions` gives back the canonically-cased name, which matters:
       the schedule is lower-cased before it is parsed, and a badge reading
       "asia/shanghai" looks like a bug even when the clock is right. */
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
    return { kind: "iana", name: resolved };
  } catch {
    return null;
  }
}

/** `"01:00"` / `"1:00pm"` / `"0100"` / `"9am"` / `"2.30pm"` → minutes. */
function parseClock(hour: string, minute?: string, meridiem?: string): number | null {
  let h = Number(hour);
  const m = Number(minute ?? 0);
  if (!Number.isFinite(h) || !Number.isFinite(m) || m > 59) return null;
  if (meridiem === "pm" && h < 12) h += 12;
  if (meridiem === "am" && h === 12) h = 0;
  if (h > 24) return null;
  const total = h * 60 + m;
  // 24:00 is a legal *end*, so it stays 1440 here; the start side wraps below.
  return total >= 0 && total <= 24 * 60 ? total : null;
}

/** One range's text → `{start, end}`, or null. */
function parseRange(text: string): { start: number; end: number } | null {
  // `0100-0400`: four digits either side, no separator but the dash.
  let m = /^(\d{3,4})\s*-\s*(\d{3,4})$/.exec(text);
  if (m) {
    const a = parseClock(m[1].slice(0, -2), m[1].slice(-2));
    const b = parseClock(m[2].slice(0, -2), m[2].slice(-2));
    return a === null || b === null ? null : { start: a, end: b };
  }
  m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*-\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/.exec(text);
  if (!m) return null;
  /* A bare `9-5` is a guess between two readings (nine hours from nine, or
     nine to five), and a schedule is a billing fact — so it needs a colon, a
     dot, four digits or a meridiem before it counts as one. */
  if (!(m[2] || m[3] || m[5] || m[6] || m[1].length === 2 && m[4].length === 2)) return null;
  let start = parseClock(m[1], m[2], m[3]);
  const end = parseClock(m[4], m[5], m[6]);
  if (start === null || end === null) return null;
  /* "1-4pm" is 13:00-16:00: a meridiem written once belongs to both sides, and
     it is the start that has to be carried — unless doing so lands it after the
     end, which is what "11-1pm" would do, so that shape keeps the morning. */
  if (m[6] && !m[3]) {
    const carried = parseClock(m[1], m[2], m[6]);
    if (carried !== null && carried < end) start = carried;
  }
  return { start: start % (24 * 60), end: end % (24 * 60) };
}

/** A day list at the start of a segment, and what is left of the segment. */
function takeDays(text: string): { days: number[] | null; rest: string } | null {
  const t = text.trim();
  let m = /^(?:every day|everyday|daily|all days|all)\b\s*/.exec(t);
  if (m) return { days: null, rest: t.slice(m[0].length) };
  m = /^(weekdays|workdays|weekdays only)\b\s*/.exec(t);
  if (m) return { days: [1, 2, 3, 4, 5], rest: t.slice(m[0].length) };
  m = /^(weekends?|weekend days)\b\s*/.exec(t);
  if (m) return { days: [6, 7], rest: t.slice(m[0].length) };
  /* `mon`, `mon-fri`, `mon,wed,fri`, `mon/wed`. A comma inside a day list is
     joined to a slash by the caller before this runs — but only where the
     *following* word is also a day, so a list that ends the sentence keeps its
     commas and is read here. The list is days, and a single `-` between two of
     them is a range; anything else is a list in the order it was written. */
  m = /^((?:[a-z]{3,9})(?:(?:\s*[,/-]\s*|\s+and\s+)[a-z]{3,9})*)\s+(?=\S)/.exec(t);
  if (!m) return null;
  const words = m[1].split(/\s*[,/]\s*|\s+and\s+|\s*-\s*/);
  if (!words.every((w) => DAY_NAMES[w] !== undefined)) return null;
  const rest = t.slice(m[0].length);
  if (words.length === 1) return { days: [DAY_NAMES[words[0]]], rest };
  /* A range is written with a dash and nothing else — `mon-fri` — so the
     separator between the first two words is what decides: a comma or `and`
     makes it a list, and each word is taken as itself. */
  const ranged = /^[a-z]{3,9}\s*-\s*[a-z]{3,9}$/.test(m[1].trim());
  if (!ranged) {
    const set = new Set(words.map((w) => DAY_NAMES[w]));
    return { days: [...set].sort((a, b) => a - b), rest };
  }
  const a = DAY_NAMES[words[0]];
  const b = DAY_NAMES[words[1]];
  const days: number[] = [];
  for (let d = a; ; d = (d % 7) + 1) {
    days.push(d);
    if (d === b) break;
    if (days.length > 7) return null;
  }
  return { days, rest };
}

/**
 * The sentence → windows. Null when nothing in it is a window, which the UI
 * draws as "this schedule is not readable yet" rather than as "no schedule" —
 * the two are different answers and only one of them is the user's fault.
 */
export function parsePeak(schedule: PeakSchedule | null | undefined): PeakPlan | null {
  const raw = schedule?.windows?.trim();
  if (!raw) return null;
  const when: PeakKind = schedule?.when === "off-peak" ? "off-peak" : "peak";
  const multiplier =
    Number.isFinite(schedule?.multiplier) && (schedule?.multiplier ?? 0) > 0
      ? (schedule as PeakSchedule).multiplier!
      : 2;

  const text = raw
    .toLowerCase()
    .replace(/[–—−]/g, "-")
    .replace(/\bto\b/g, "-")
    .replace(/\buntil\b/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  // The zone, wherever it sits, belongs to the whole schedule: a person writes
  // it once and a segment may name it again, and either way it reads the same.
  let zone: PeakZone = { kind: "offset", minutes: 0 };
  let body = text;
  const zonePatterns: RegExp[] = [
    /\b([a-z_]+\/[a-z_]+(?:\/[a-z_]+)?)\b/,
    /\b(?:utc|gmt)\s*[+-]\s*\d{1,2}(?::?\d{2})?\b/,
    /* A bare offset needs air on both sides: `22:00-08:00` is a range whose dash
       is glued to a clock, and reading that as `-08:00` would eat the window. */
    /(?:^|\s)([+-]\d{1,2}(?::?\d{2})?)(?=\s|$)/,
    /\b(?:utc|gmt|z)\b/,
  ];
  for (const pattern of zonePatterns) {
    /* Every occurrence, not the first: a schedule that spells its zone once per
       window ("… UTC, … UTC") would otherwise leave the later one glued to a
       range and lose that window. */
    for (let guard = 0; guard < 8; guard += 1) {
      const found = pattern.exec(body);
      if (!found) break;
      const token = (found[1] ?? found[0]).trim();
      const parsed = parseZoneToken(token) ?? ianaZone(token);
      if (!parsed) break;
      zone = parsed;
      body = (body.slice(0, found.index) + " " + body.slice(found.index + found[0].length)).replace(/\s+/g, " ").trim();
    }
  }

  const windows: PeakWindow[] = [];
  // `mon,wed 10:00-12:00` splits into "mon" and "wed 10:00-12:00" at the comma,
  // so a day list is glued back together before the windows are read — every
  // comma between two day names, run to a fixed point so `mon,wed,fri` glues
  // both of its joins and not just the first.
  const DAY = "(?:mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)[a-z]*";
  const dayComma = new RegExp(`\\b(${DAY})\\s*,\\s*(?=${DAY}\\b)`, "g");
  let merged = body;
  for (let guard = 0; guard < 8; guard += 1) {
    const next = merged.replace(dayComma, "$1/");
    if (next === merged) break;
    merged = next;
  }
  let carryDays: number[] | null = null;
  let sawDays = false;
  for (const piece of merged.split(/\s*[,;&]\s*|\s+and\s+/).map((p) => p.trim()).filter(Boolean)) {
    let rest = piece;
    const days = takeDays(rest);
    if (days) {
      carryDays = days.days;
      sawDays = true;
      rest = days.rest.trim();
    }
    /* "peak"/"off-peak" noise a person copies off a pricing page, and a stray
       parenthetical, must not stop the range being read. */
    rest = rest
      .replace(/\([^)]*\)/g, "")
      .replace(/\b(?:peak|off-peak|off peak|hours?|pricing)\b/g, "")
      .trim();
    if (!rest) continue;
    const range = parseRange(rest);
    if (!range) continue;
    if (range.start === range.end) continue;
    // A day list named once governs the windows after it, exactly as the zone
    // does — the common sentence names days on the first window only.
    windows.push({ start: range.start, end: range.end, days: sawDays ? carryDays : null });
    if (windows.length >= MAX_WINDOWS) break;
  }

  if (windows.length === 0) return null;
  return { raw, windows, zone, when, multiplier };
}

/** The zone's offset at an instant, in ms east of UTC. */
function zoneOffsetMs(at: number, zone: PeakZone): number {
  if (zone.kind === "offset") return zone.minutes * MINUTE;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone.name,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** The wall clock the schedule is written in, at an instant. */
function localParts(at: number, zone: PeakZone): { day: number; minutes: number } {
  const local = new Date(at + zoneOffsetMs(at, zone));
  return { day: isoDay(local), minutes: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

/** The UTC instant of a local wall clock, at or after `near`. DST makes a local
    time ambiguous or absent twice a year; two corrections settle it, and the
    schedule is a billing hint rather than a contract. */
function localInstant(day: number, minutes: number, zone: PeakZone, near: number): number {
  const start = localParts(near, zone);
  let t = near - (start.minutes - minutes) * MINUTE + ((day - start.day + 7) % 7) * DAY;
  // An offset that moved under us (DST) leaves the wall clock short by up to an
  // hour; correcting from the new reading is what settles it.
  for (let i = 0; i < 2; i += 1) {
    const now = localParts(t, zone);
    const drift = minutes - now.minutes + ((day - now.day + 7) % 7) * 24 * 60;
    if (drift === 0) break;
    t += drift * MINUTE;
  }
  return t;
}

/** Whether `at` sits inside `window`, wrapping midnight when `end < start`. */
function insideWindow(at: number, window: PeakWindow, zone: PeakZone): boolean {
  const { day, minutes } = localParts(at, zone);
  const { start, end } = window;
  if (start < end) {
    return minutes >= start && minutes < end && (!window.days || window.days.includes(day));
  }
  // Wraps midnight: the start day owns the whole run.
  const stillTonight = minutes >= start;
  const yesterday = ((day + 5) % 7) + 1;
  return (
    (!window.days || window.days.includes(day)) && stillTonight
  ) || (!window.days || window.days.includes(yesterday)) && minutes < end;
}

/** The price at `at` as a multiple of the listed price: discounted inside an
    `off-peak` schedule's windows, raised inside a `peak` schedule's. */
export function peakMultiplier(plan: PeakPlan, at: number): number {
  const inside = plan.windows.some((w) => insideWindow(at, w, plan.zone));
  return inside ? plan.multiplier : 1;
}

/**
 * What the schedule says about an instant — the badge's whole input.
 *
 * `band` is the question a badge answers: is the number on this row what I am
 * paying, more than it, or less? A `peak` schedule raises the price inside its
 * windows; an `off-peak` one lowers it there (`multiplier` < 1), which is the
 * shape Alibaba's night discount takes. Outside the windows either schedule is
 * `standard`, so "cheap because it is not peak" is never said — a row's price
 * is the price, and a badge that claimed a discount for the absence of a
 * surcharge would be inventing one.
 */
export function peakState(plan: PeakPlan, at: number): PeakState {
  const window = plan.windows.find((w) => insideWindow(at, w, plan.zone)) ?? null;
  const multiplier = window ? plan.multiplier : 1;
  const band = bandFor(multiplier);
  return {
    inside: window !== null,
    band,
    multiplier,
    until: nextTransition(plan, at)?.at ?? null,
    window,
  };
}

/**
 * A band in the words a reading prints it in.
 *
 * The phase is **what the price is doing**, never which side of the schedule's
 * windows the clock is on — those are different facts the moment a card is an
 * `off-peak` one. Inside an `off-peak` card's windows the listed price is
 * *discounted*, so calling that hour "Peak" (as the badge did when it read
 * `inside` alone) named the exact opposite of what the reader was paying.
 *
 * A moment at the listed price is `Off-peak` only where the schedule's windows
 * are the dear ones — there, "off-peak" is precisely the absence of a surcharge.
 * On an `off-peak` card it is the absence of a *discount*, which is a dearer
 * hour by the card's own terms, so it says `Listed price` and names no phase the
 * provider never sold.
 */
export function bandLabel(band: PeakBand, plan: PeakPlan): string {
  if (band === "premium") return "Peak";
  if (band === "discount") return "Off-peak";
  return plan.when === "off-peak" ? "Listed price" : "Off-peak";
}

/** The phase a state stands in, in words — `bandLabel` for a whole reading. */
export function phaseLabel(state: PeakState, plan: PeakPlan): string {
  return bandLabel(state.band, plan);
}

/** One window's runs around `at`: every day it names, each shifted a day back
    and forward so a run that wraps midnight — and a zone whose offset moved
    under the window — is covered on both sides of the instant being asked
    about. Two consumers need these and they must agree: `nextChange` reads
    their boundaries, and the badge reads them as clocks in another zone. */
function windowRuns(
  window: PeakWindow,
  zone: PeakZone,
  at: number,
): { start: number; end: number }[] {
  const days = window.days ?? [1, 2, 3, 4, 5, 6, 7];
  const runs: { start: number; end: number }[] = [];
  for (const day of days) {
    /* This week's occurrence, which may already have started — a window that
       wraps midnight is still in force from yesterday's run — and next week's,
       which is what "the next opening" is when this week's is behind us. Both
       are resolved by weekday and then lengthened, never by shifting the
       weekday: an earlier version stepped the day index a day either way to
       cover a wrap, which put runs on days the window never names (a
       `Sat-Sun` schedule answered with a Monday) and made a `Mon-Fri` one
       report a boundary at the weekend. */
    for (const weeks of [0, 1]) {
      const start = localInstant(day, window.start, zone, at - DAY);
      const shifted = start + weeks * 7 * DAY;
      const end =
        window.end > window.start
          ? shifted + (window.end - window.start) * MINUTE
          : shifted + (24 * 60 - window.start + window.end) * MINUTE;
      runs.push({ start: shifted, end });
    }
  }
  return runs;
}

/** What a multiplier does to the price, as a band. One place, because "is this
    a surcharge or a discount" is asked from three. */
function bandFor(multiplier: number): PeakBand {
  return multiplier === 1 ? "standard" : multiplier > 1 ? "premium" : "discount";
}

/**
 * This window's run that is open now, else the next one, with both ends as
 * epoch ms — the reader's side of the schedule, which is what the badge prints
 * under "your time".
 *
 * A window's local reading is not a fixed shift: `Mon-Fri 01:00-04:00 UTC` is
 * three hours starting at 09:00 in Singapore and at 02:00 in Berlin, and in a
 * zone that keeps DST it moves twice a year — so the answer is an occurrence
 * found on the calendar rather than the window shifted by one offset.
 */
export function windowRun(
  window: PeakWindow,
  zone: PeakZone,
  at: number,
): { start: number; end: number } | null {
  const runs = windowRuns(window, zone, at);
  /* The run in force answers first: "when is this window open" is the same
     question whether it is open now or next, and asking only for openings
     made a badge inside a window quote tomorrow's hours. */
  const current = runs.find((run) => run.start <= at && at < run.end);
  if (current) return current;
  let best: { start: number; end: number } | null = null;
  for (const run of runs) {
    if (run.start < at) continue;
    if (best === null || run.start < best.start) best = run;
  }
  return best;
}

/** The multiple the schedule puts on a moment — what `peakState` computes,
    without the boundary scan, so a transition can be read a second past a cut. */
function multiplierAt(plan: PeakPlan, at: number): number {
  return plan.windows.some((w) => insideWindow(at, w, plan.zone)) ? plan.multiplier : 1;
}

/** A boundary of the schedule, and what the price is doing after it. */
export interface PeakTransition {
  /** Epoch ms of the boundary itself. */
  at: number;
  /** The band from `at` onwards. */
  band: PeakBand;
  /** Whether the price **rises** across this boundary — read from the two
      multipliers, so it is right for any card: a `peak` window opening raises
      it, and so does an `off-peak` window closing. */
  dearer: boolean;
}

/**
 * Every boundary of the schedule after `at`, in order, each with the band it
 * opens and whether the price rises across it.
 *
 * A boundary is any window edge, and the change is decided by reading a second
 * past it: the window that is *ending* has stopped answering by then and the one
 * that is *opening* has started. Each candidate is re-read as a band rather than
 * assumed from the edge's direction, because an `off-peak` card inverts the sign
 * — a window *closing* is the hour getting dearer there, and the badge would
 * otherwise tell the reader the opposite.
 */
export function upcomingTransitions(plan: PeakPlan, at: number): PeakTransition[] {
  const here = multiplierAt(plan, at);
  const found: PeakTransition[] = [];
  for (const window of plan.windows) {
    for (const { start, end } of windowRuns(window, plan.zone, at)) {
      for (const boundary of [start, end]) {
        if (boundary <= at) continue;
        const multiplier = multiplierAt(plan, boundary + 1_000);
        if (multiplier === here) continue;
        found.push({
          at: boundary,
          band: bandFor(multiplier),
          dearer: multiplier > here,
        });
      }
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

/** The first instant after `at` at which the price changes, and what it becomes. */
export function nextTransition(plan: PeakPlan, at: number): PeakTransition | null {
  return upcomingTransitions(plan, at)[0] ?? null;
}

/** `"UTC"`, `"+08:00"`, `"Asia/Shanghai"` — the zone as the badge names it. */
export function zoneLabel(zone: PeakZone): string {
  if (zone.kind === "iana") return zone.name;
  if (zone.minutes === 0) return "UTC";
  const sign = zone.minutes < 0 ? "-" : "+";
  const abs = Math.abs(zone.minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

/** A wall-clock time in the schedule's own zone, e.g. `"04:00 UTC"`. Used for
    "until", where the reader needs the schedule's clock rather than theirs. */
export function clockLabel(at: number, zone: PeakZone, withZone = true): string {
  const { minutes } = localParts(at, zone);
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return withZone ? `${hh}:${mm} ${zoneLabel(zone)}` : `${hh}:${mm}`;
}

/** `"01:00-04:00"` — one window as it would be written back. */
export function windowLabel(window: PeakWindow): string {
  const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return `${clock(window.start)}-${clock(window.end)}`;
}

/** `"Every day"`, `"Weekdays"`, `"Mon-Fri"`, `"Mon, Wed, Fri"` — the days a
    window applies to, in the schedule's own terms. A window that names none
    runs every day, which is a fact worth printing rather than an absence. */
export function daysLabel(days: number[] | null): string {
  if (!days || days.length === 7) return "Every day";
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 5 && sorted.every((d, i) => d === i + 1)) return "Weekdays";
  if (sorted.length === 2 && sorted[0] === 6 && sorted[1] === 7) return "Weekends";
  /* A run of consecutive days is a range, and the rest are a list — `Mon-Fri`
     is what the sentence said, and printing five names back at the reader is
     the same fact told longer. */
  const consecutive = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  if (consecutive && sorted.length > 2) return `${names[sorted[0] - 1]}-${names[sorted[sorted.length - 1] - 1]}`;
  return sorted.map((d) => names[d - 1]).join(", ");
}

/** Whether a window is in force at `at` — one window's reading, for a list of
    them, where `peakState` answers for the schedule as a whole. */
export function windowInForce(window: PeakWindow, zone: PeakZone, at: number): boolean {
  return insideWindow(at, window, zone);
}

/** A stretch of time over which the price does not move, as the badge draws it. */
export interface PeakSpan {
  from: number;
  to: number;
  band: PeakBand;
}

/**
 * The stretches between `from` and `to`, cut at every boundary the schedule has
 * — the shape of a day, for a bar that says when the cheap and dear hours
 * actually fall on the reader's own clock.
 *
 * Cut from the boundaries and then classified, rather than sampled: a sample
 * would land a window that opens at 09:30 in the wrong cell, and a schedule is
 * exact about its edges. Adjacent spans of the same band are merged, so the
 * answer is one segment per real stretch.
 */
export function peakSpans(plan: PeakPlan, from: number, to: number): PeakSpan[] {
  if (to <= from) return [];
  const cuts = new Set<number>([from, to]);
  for (const window of plan.windows) {
    for (const run of windowRuns(window, plan.zone, from)) {
      for (const boundary of [run.start, run.end]) {
        if (boundary > from && boundary < to) cuts.add(boundary);
      }
    }
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const spans: PeakSpan[] = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (b === a) continue;
    /* The band of a stretch is the band at any instant inside it — the cuts are
       every boundary, so nothing inside one can differ. */
    const band = bandFor(plan.windows.some((w) => insideWindow(a + 1, w, plan.zone)) ? plan.multiplier : 1);
    const last = spans[spans.length - 1];
    if (last && last.band === band && last.to === a) last.to = b;
    else spans.push({ from: a, to: b, band });
  }
  return spans;
}
