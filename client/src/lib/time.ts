/* Short relative ages — "3m", "2h", "5d". Sidebar rows and palette rows have
   room for two or three characters, not for "3 minutes ago", and at a glance
   the unit is the information. The exact stamp goes in a title attribute. */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function shortAge(at: number, now = Date.now()): string {
  const ms = Math.max(0, now - at)
  if (ms < MINUTE) return "now"
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`
  if (ms < 7 * DAY) return `${Math.floor(ms / DAY)}d`
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}
