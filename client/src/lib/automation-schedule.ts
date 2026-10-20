/* ── The "When" of an automation ──
   A schedule trigger is stored as one of three clocks: a cron (+ zone), a fixed
   `intervalMs`, or a single `atMs`. The form speaks in presets instead, and
   this file is the whole translation both ways: `compilePlan` writes a preset
   as a clock, `readPlan` reads a stored trigger back into a preset (anything
   that matches none reads as Custom, which is a cron someone meant), and
   `describePlan` / `nextFires` are what the form prints under the picker so a
   person sees the sentence and the next three times before saving.

   Pure functions over plain values — the only dependency is `croner`, the same
   library the server evaluates a cron with, so the preview and the sweep agree
   on what an expression means. The server's deterministic stagger (a few
   minutes at most, per routine) is not applied to the preview. */
import { Cron } from "croner"

import type { RoutineTrigger, RoutineTriggerInput } from "@/lib/settings"

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE

export type Preset =
  | "manual"
  | "every"
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly"
  | "once"
  | "custom"

export const PRESET_LABEL: Record<Preset, string> = {
  manual: "Manual",
  every: "Every N min / hours",
  hourly: "Hourly",
  daily: "Daily",
  weekdays: "Weekdays",
  weekly: "Weekly",
  monthly: "Monthly",
  once: "Once",
  custom: "Custom cron",
}

export const DAY_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const

/** Everything the picker holds. One flat record so a preset switch keeps what
    was typed under the others. */
export interface SchedulePlan {
  preset: Preset
  every: number
  unit: "minutes" | "hours"
  /** Hourly: the minute past the hour. */
  minute: number
  /** "HH:MM", for daily, weekdays, weekly and monthly. */
  time: string
  /** 0 = Sunday … 6 = Saturday, for weekly. */
  days: number[]
  dayOfMonth: number
  /** A `datetime-local` value, for once. */
  at: string
  cron: string
  tz: string
}

/** The browser's own zone — a person setting "every day at 9" means 9 where
    they are, and the server's zone is rarely it. */
export const localZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || ""
  } catch {
    return ""
  }
}

const pad = (n: number) => String(n).padStart(2, "0")

export function toLocalInput(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** :07, not :00 — the top of the hour is where every automation on earth
    fires. A default, never an override. */
export const OFF_PEAK_TIME = "09:07"

export function defaultPlan(over: Partial<SchedulePlan> = {}): SchedulePlan {
  return {
    preset: "daily",
    every: 30,
    unit: "minutes",
    minute: 7,
    time: OFF_PEAK_TIME,
    days: [1],
    dayOfMonth: 1,
    at: toLocalInput(Date.now() + HOUR),
    cron: "7 9 * * *",
    tz: localZone(),
    ...over,
  }
}

const hm = (time: string): [number, number] => {
  const [h, m] = time.split(":").map((v) => Number(v))
  return [Number.isFinite(h) ? h! : 9, Number.isFinite(m) ? m! : 0]
}

/** What the plan is written as. `manual` has no clock at all. */
export type Compiled =
  | { kind: "manual" }
  | {
      kind: "schedule"
      cron: string | null
      tz: string | null
      atMs: number | null
      intervalMs: number | null
    }

export function compilePlan(plan: SchedulePlan): Compiled {
  const tz = plan.tz.trim() || null
  const clock = (cron: string): Compiled => ({ kind: "schedule", cron, tz, atMs: null, intervalMs: null })
  const [h, m] = hm(plan.time)
  switch (plan.preset) {
    case "manual":
      return { kind: "manual" }
    case "every":
      return {
        kind: "schedule",
        cron: null,
        tz: null,
        atMs: null,
        intervalMs: Math.round(plan.every) * (plan.unit === "hours" ? HOUR : MINUTE),
      }
    case "hourly":
      return clock(`${plan.minute} * * * *`)
    case "daily":
      return clock(`${m} ${h} * * *`)
    case "weekdays":
      return clock(`${m} ${h} * * 1-5`)
    case "weekly":
      return clock(`${m} ${h} * * ${[...plan.days].sort().join(",")}`)
    case "monthly":
      return clock(`${m} ${h} ${plan.dayOfMonth} * *`)
    case "once":
      return { kind: "schedule", cron: null, tz: null, atMs: new Date(plan.at).getTime(), intervalMs: null }
    case "custom":
      return clock(plan.cron.trim())
  }
}

/** The complaint that stops a save, or null. */
export function planProblem(plan: SchedulePlan, now = Date.now()): string | null {
  switch (plan.preset) {
    case "manual":
      return null
    case "every": {
      const ms = plan.every * (plan.unit === "hours" ? HOUR : MINUTE)
      return Number.isFinite(ms) && ms >= MINUTE ? null : "Repeat at most once a minute."
    }
    case "weekly":
      return plan.days.length === 0 ? "Pick at least one day." : null
    case "once": {
      const at = new Date(plan.at).getTime()
      if (Number.isNaN(at)) return "Pick a date and time."
      return at <= now ? "That time has already passed." : null
    }
    case "custom": {
      if (!plan.cron.trim()) return "Write a cron expression."
      try {
        new Cron(plan.cron.trim(), plan.tz.trim() ? { timezone: plan.tz.trim() } : {}).nextRun()
        return null
      } catch (err) {
        return err instanceof Error ? err.message : "That cron expression does not parse."
      }
    }
    default:
      return null
  }
}

/** The trigger input a plan creates; null for a plan with no clock to add
    beyond the `manual` marker. */
export function planToTrigger(plan: SchedulePlan): RoutineTriggerInput {
  const c = compilePlan(plan)
  return c.kind === "manual" ? { kind: "manual" } : { ...c }
}

/** The patch that moves an existing schedule trigger onto a plan. Every clock
    field is written, so switching from a cron to an interval clears the cron. */
export function planToPatch(plan: SchedulePlan) {
  const c = compilePlan(plan)
  return c.kind === "manual" ? null : { cron: c.cron, tz: c.tz, atMs: c.atMs, intervalMs: c.intervalMs }
}

/** A stored schedule trigger, back into the picker. */
export function readPlan(t: Pick<RoutineTrigger, "cron" | "tz" | "atMs" | "intervalMs">): SchedulePlan {
  const base = defaultPlan({ tz: t.tz ?? localZone() })
  if (t.atMs !== null && t.atMs !== undefined) return { ...base, preset: "once", at: toLocalInput(t.atMs) }
  if (t.intervalMs !== null && t.intervalMs !== undefined) {
    const hours = t.intervalMs >= HOUR && t.intervalMs % HOUR === 0
    return { ...base, preset: "every", unit: hours ? "hours" : "minutes", every: Math.round(t.intervalMs / (hours ? HOUR : MINUTE)) }
  }
  const cron = (t.cron ?? "").trim()
  if (!cron) return { ...base, preset: "daily" }
  const custom = { ...base, preset: "custom" as const, cron }
  const num = (v: string) => Number(v)
  let match = /^(\d{1,2}) \* \* \* \*$/.exec(cron)
  if (match) return { ...base, preset: "hourly", minute: num(match[1]!), cron }
  const time = (m: string, h: string) => `${pad(num(h))}:${pad(num(m))}`
  match = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cron)
  if (match) return { ...base, preset: "daily", time: time(match[1]!, match[2]!), cron }
  match = /^(\d{1,2}) (\d{1,2}) \* \* 1-5$/.exec(cron)
  if (match) return { ...base, preset: "weekdays", time: time(match[1]!, match[2]!), cron }
  match = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6](?:,[0-6])*)$/.exec(cron)
  if (match)
    return { ...base, preset: "weekly", time: time(match[1]!, match[2]!), days: match[3]!.split(",").map(num), cron }
  match = /^(\d{1,2}) (\d{1,2}) (\d{1,2}) \* \*$/.exec(cron)
  if (match) return { ...base, preset: "monthly", time: time(match[1]!, match[2]!), dayOfMonth: num(match[3]!), cron }
  return custom
}

/** "Africa/Cairo" → "Cairo time". Blank is the server's own zone. */
export const zoneLabel = (tz: string): string =>
  tz.trim() ? `${tz.split("/").pop()!.replace(/_/g, " ")} time` : "server time"

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

const onDate = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })

/** The sentence the form prints: "Weekdays at 09:07 Cairo time". */
export function describePlan(plan: SchedulePlan): string {
  const zone = zoneLabel(plan.tz)
  switch (plan.preset) {
    case "manual":
      return "Only when you press Run now"
    case "every":
      return `Every ${plan.every === 1 ? (plan.unit === "hours" ? "hour" : "minute") : plural(plan.every, plan.unit === "hours" ? "hour" : "minute")}`
    case "hourly":
      return `Every hour at :${pad(plan.minute)}`
    case "daily":
      return `Daily at ${plan.time} ${zone}`
    case "weekdays":
      return `Weekdays at ${plan.time} ${zone}`
    case "weekly":
      return `${[...plan.days].sort().map((d) => DAY_LABEL[d]).join(", ") || "No day"} at ${plan.time} ${zone}`
    case "monthly":
      return `Monthly on day ${plan.dayOfMonth} at ${plan.time} ${zone}`
    case "once":
      return `Once, ${onDate(new Date(plan.at).getTime())}`
    case "custom":
      return `Cron ${plan.cron.trim() || "—"}${plan.tz.trim() ? ` (${plan.tz.trim()})` : ""}`
  }
}

/** The next `count` fire times the clock gives, without the server's stagger. */
export function nextFires(plan: SchedulePlan, count = 3, from = Date.now()): number[] {
  const c = compilePlan(plan)
  if (c.kind === "manual") return []
  if (c.atMs !== null) return c.atMs > from ? [c.atMs] : []
  if (c.intervalMs !== null)
    return Number.isFinite(c.intervalMs) && c.intervalMs >= MINUTE
      ? Array.from({ length: count }, (_, i) => from + (i + 1) * c.intervalMs!)
      : []
  if (!c.cron) return []
  try {
    return new Cron(c.cron, c.tz ? { timezone: c.tz } : {}).nextRuns(count, new Date(from)).map((d) => d.getTime())
  } catch {
    return []
  }
}

/** True when the plan lands on minute 0 of an hour — the nudge's trigger. */
export function onTheHour(plan: SchedulePlan): boolean {
  switch (plan.preset) {
    case "hourly":
      return plan.minute === 0
    case "daily":
    case "weekdays":
    case "weekly":
    case "monthly":
      return hm(plan.time)[1] === 0
    default:
      return false
  }
}

/** The same plan moved to :07 past its hour. */
export function offPeak(plan: SchedulePlan): SchedulePlan {
  return plan.preset === "hourly" ? { ...plan, minute: 7 } : { ...plan, time: `${plan.time.split(":")[0]}:07` }
}

/** One trigger in a few words, for the list row. */
export function triggerLine(t: RoutineTrigger): string {
  switch (t.kind) {
    case "schedule":
      return describePlan(readPlan(t))
    case "api":
      return "API"
    case "git":
      return t.branch ? `On commit to ${t.branch}` : "On commit"
    case "manual":
      return "Manual"
  }
}
