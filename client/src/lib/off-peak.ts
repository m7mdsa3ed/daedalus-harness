/* ── When a model is cheaper, by the provider's own clock ──
   Some providers price a *window of the day* rather than a request: DeepSeek's
   off-peak discount is the well-known one, and there is nothing to send on the
   wire — the endpoint charges by wall-clock time. So a window is declared on
   the model beside its `pricing` (see the server's `OffPeakWindow`) and read
   back here as a live indicator; nothing in this file touches a turn.

   The window is stated in the provider's own zone, which is UTC for the
   provider this exists for, and may wrap past midnight (16:30 → 00:30 is one
   continuous span). Everything below is minutes-past-midnight arithmetic in
   that zone, so no Date is ever constructed from a wall-clock string — which is
   the whole reason there is no timezone library here. */

/** The hours a provider charges less for. Duplicated from the server's
    `OffPeakWindow` because the client holds its own model shape
    (`ModelOption`); the two are read together and must move together. */
export interface OffPeakWindow {
  /** "HH:MM", 24-hour, in `tz`. */
  from: string
  /** "HH:MM", 24-hour, in `tz`; earlier than `from` when it wraps. */
  to: string
  /** IANA zone the provider states the window in, e.g. "UTC". */
  tz: string
  /** Fraction of the list price charged inside the window: 0.5 = half off. */
  multiplier: number
}

/** The reading taken at one instant: which side of the window we are on, and
    when it next flips. */
export interface OffPeakState {
  active: boolean
  /** The "HH:MM" (in the window's zone) this state ends at. */
  until: string
  /** Whole minutes from now until that boundary. */
  inMinutes: number
  /** Percent off inside the window, rounded — 100 × (1 − multiplier). */
  percentOff: number
}

const MINUTES_PER_DAY = 24 * 60

/** "HH:MM" → minutes past midnight, or null when it is not a clock time. */
export function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/** Minutes past midnight *in `tz`* for `at`. `Intl` is the zone database; a
    zone it rejects falls back to `at`'s UTC reading, which is the provider's
    own clock for the window this exists for anyway. */
export function zoneMinutes(at: Date, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz || "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(at)
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0")
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0")
    // Some engines render midnight as "24" under `hour12: false`.
    return (hour % 24) * 60 + minute
  } catch {
    return at.getUTCHours() * 60 + at.getUTCMinutes()
  }
}

/** Minutes past midnight → "HH:MM", wrapping into one day. */
export function formatClock(minutes: number): string {
  const wrapped = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  const hours = Math.floor(wrapped / 60)
  const rest = wrapped % 60
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
}

/**
 * Which side of the window `at` falls on, and when that ends.
 *
 * An unusable window — an unparseable bound, or a zero-length one where `from`
 * equals `to` — reads as "no window": full price, nothing to say. A window that
 * fails to parse is a typo in the editor, not a reason to invent a discount.
 */
export function offPeakState(window: OffPeakWindow, at: Date): OffPeakState {
  const percentOff = Math.round((1 - window.multiplier) * 100)
  const start = parseClock(window.from)
  const end = parseClock(window.to)
  if (start === null || end === null || start === end) {
    return { active: false, until: "00:00", inMinutes: 0, percentOff }
  }
  const now = zoneMinutes(at, window.tz)
  const wraps = start > end
  const active = wraps ? now >= start || now < end : now >= start && now < end
  // Off-peak ends at `end`; peak ends at the window's opening. Either way the
  // distance is measured forward, so a wrapped window still counts correctly.
  const until = active ? end : start
  const inMinutes = (((until - now) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  return { active, until: formatClock(until), inMinutes, percentOff }
}

/** One sentence naming the state and what it costs — the readout's text. */
export function offPeakLabel(window: OffPeakWindow, at: Date): string {
  const state = offPeakState(window, at)
  const zone = window.tz || "UTC"
  return state.active
    ? `Off-peak right now — ${state.percentOff}% off until ${state.until} ${zone}`
    : `Peak — off-peak starts ${state.until} ${zone} (${state.percentOff}% off)`
}

/** The effective rate at `at`: the model's list price, discounted inside the
    window. Absent pricing or window returns the price unchanged. */
export function effectivePricing(
  pricing: { input: number; output: number } | undefined,
  window: OffPeakWindow | undefined,
  at: Date
): { input: number; output: number } | undefined {
  if (!pricing) return undefined
  if (!window || !offPeakState(window, at).active) return pricing
  const scale = window.multiplier
  return { input: pricing.input * scale, output: pricing.output * scale }
}

/** A rate as the profile editor states it — "$3 / $15 per Mtok" — for the
    readout beside the phase. Two decimals, trailing zeros trimmed. */
export function formatRate(pricing: { input: number; output: number }): string {
  const trim = (n: number) => String(Number(n.toFixed(2)))
  return `$${trim(pricing.input)} / $${trim(pricing.output)} per Mtok`
}
