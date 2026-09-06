/* ── A trigger in one line ──
   Read by the routine's overview and its list row, where a whole trigger card
   is too much and "3 triggers" is too little. The list page never reads
   triggers at all (they are one read per routine, owned by its page); the
   overview does, and this is what it prints. */
import { CalendarClockIcon, GitBranchIcon, WebhookIcon, type LucideIcon } from "lucide-react"

import type { RoutineTrigger, RoutineTriggerKind } from "@/lib/settings"

export const TRIGGER_KIND: Record<RoutineTriggerKind, { label: string; icon: LucideIcon }> = {
  schedule: { label: "Schedule", icon: CalendarClockIcon },
  api: { label: "Webhook", icon: WebhookIcon },
  git: { label: "Commit", icon: GitBranchIcon },
}

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })

/** The trigger's own terms, without its next fire: "every day at 09:00" is a
    property of the trigger where "fires in 3h" is a property of the clock. */
export function triggerTerms(trigger: RoutineTrigger): string {
  switch (trigger.kind) {
    case "schedule":
      if (trigger.atMs !== null) return `Once, ${when(trigger.atMs)}`
      return trigger.cron ? `Cron ${trigger.cron}${trigger.tz ? ` (${trigger.tz})` : ""}` : "No clock set"
    case "api":
      return trigger.hasToken ? "Token minted" : "No token yet — cannot fire from outside"
    case "git": {
      const branch = trigger.branch ?? "any branch"
      const paths = trigger.paths.length === 0 ? "" : ` · ${trigger.paths.length} path rule${trigger.paths.length === 1 ? "" : "s"}`
      return `HEAD moves on ${branch}${paths}`
    }
  }
}

/** The soonest armed clock across a routine's triggers, or null when nothing
    on it has one — an inert routine, or one that only fires from outside. */
export function nextFireOf(triggers: RoutineTrigger[] | undefined): number | null {
  if (!triggers) return null
  let next: number | null = null
  for (const t of triggers) {
    if (!t.enabled || t.nextFireAt === null) continue
    if (next === null || t.nextFireAt < next) next = t.nextFireAt
  }
  return next
}

/** "in 3h", "in 2d", "in 12m" — how far off a clock is. Past stamps read as
    "due": the sweep is what fires it, and a stamp a minute old is one the
    sweep has not reached yet, not one that was missed. */
export function untilLabel(at: number, now = Date.now()): string {
  const ms = at - now
  if (ms <= 0) return "due"
  const m = Math.round(ms / 60_000)
  if (m < 60) return `in ${m}m`
  const h = Math.round(ms / 3_600_000)
  if (h < 48) return `in ${h}h`
  return `in ${Math.round(ms / 86_400_000)}d`
}
