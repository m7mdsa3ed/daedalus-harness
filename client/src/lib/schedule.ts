/* ── Schedule formatting ──
   Shared between the sidebar's Scheduled group and the /schedules page, so a
   row reads the same everywhere ("Jan 3, 09:00 · every day"). Pure functions
   over the ScheduledMessage rows the server lists — nothing here mutates. */
import type { ScheduledMessage } from "@/lib/settings"

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
export const WEEK = 7 * DAY

/** "2 week(s)" / "1 day(s)" / "3 hour(s)" / "45 min" for a recurrence. */
export function everyLabel(everyMs: number): string {
  return everyMs >= WEEK
    ? `${Math.round(everyMs / WEEK)} week(s)`
    : everyMs >= DAY
      ? `${Math.round(everyMs / DAY)} day(s)`
      : everyMs >= HOUR
        ? `${Math.round(everyMs / HOUR)} hour(s)`
        : `${Math.round(everyMs / MINUTE)} min`
}

/** "Jan 3, 09:00" (+ " · every day(s)" for a recurring row). */
export function scheduleWhen(nextAt: number, everyMs: number | null): string {
  const when = new Date(nextAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
  return everyMs === null ? when : `${when} · every ${everyLabel(everyMs)}`
}

/** Mirrors the server's MAX_SCHEDULE_SKIPS: at this many consecutive
    undeliverable sweeps the sweep stops selecting the row until a patch
    resets its skip state. */
export const MAX_SCHEDULE_SKIPS = 20

/** The sweep tried this row and could not deliver (trashed/vanished thread).
    The server stamps all three fields together, and any patch clears them. */
export const scheduleSkipped = (item: ScheduledMessage): boolean =>
  item.skippedAt !== null || item.lastError !== null || item.skipCount > 0

/** Skipped so many times the sweep has parked it entirely. */
export const scheduleParked = (item: ScheduledMessage): boolean =>
  item.skipCount >= MAX_SCHEDULE_SKIPS
