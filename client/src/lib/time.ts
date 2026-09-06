/* Short relative ages — "3m", "2h", "5d". Sidebar rows and palette rows have
   room for two or three characters, not for "3 minutes ago", and at a glance
   the unit is the information. The exact stamp goes in a title attribute. */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/* Which bucket a timestamp falls in, for a list that is grouped by period —
   the sidebar's project folders. Counted in *calendar* days, not in elapsed
   hours: something written at 23:50 is "Yesterday" at 00:10, not "Today",
   which is what anyone reading the list means by the word. The two start-of-day
   stamps are rounded rather than floored because a DST boundary makes one of
   the days 23 or 25 hours long. */
export function periodLabel(at: number, now = Date.now()): string {
  const startOfDay = (t: number) => {
    const d = new Date(t)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY)
  if (days <= 0) return "Today"
  if (days === 1) return "Yesterday"
  if (days < 7) return "Previous 7 days"
  if (days < 30) return "Previous 30 days"
  const then = new Date(at)
  // Older than a month reads by month, and the year is only said when it is
  // not this one.
  return then.getFullYear() === new Date(now).getFullYear()
    ? then.toLocaleDateString(undefined, { month: "long" })
    : then.toLocaleDateString(undefined, { month: "long", year: "numeric" })
}

export function shortAge(at: number, now = Date.now()): string {
  const ms = Math.max(0, now - at)
  if (ms < MINUTE) return "now"
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`
  if (ms < 7 * DAY) return `${Math.floor(ms / DAY)}d`
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}
