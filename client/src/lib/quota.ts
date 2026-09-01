import { useCallback, useEffect, useState } from "react"
import type { QuotaSnapshot, QuotaWindow } from "@daedalus/protocol"

import { api, type AgentDef, type Profile, type ServerSettings } from "@/lib/settings"

/** Whether a profile names a plan of its own — the client twin of the server's
    `profileUsage` (usage-api.ts). A profile without one spends no plan at all:
    its threads are billed to an API key, and the reading an agent probe would
    return belongs to the machine's login, not to the profile — which is why the
    composer's Plan usage card is drawn for profiles that have this, and nowhere
    else. */
export const profileHasUsage = (profile: Pick<Profile, "usage"> | null | undefined): boolean => {
  const usage = profile?.usage
  return Boolean(usage && usage.kind && usage.kind !== "none")
}

/**
 * Whether this (profile, agent) pair has a plan a *thread* can be told about —
 * the client twin of the server's `planReadable` (quota.ts), and the gate on
 * every per-thread plan surface.
 *
 * True two ways. A profile that names a usage provider has a plan whatever
 * runtime spends it: that is the account the turn is billed to. And a thread on
 * an agent's **Default** profile has one too — a Default carries no
 * credentials, so the runtime runs on the machine's own `claude`/`codex login`,
 * which is exactly what the agent's own probe reads.
 *
 * False for the case these surfaces were first written around: a *stored*
 * profile with no usage provider. That is a gateway or an API key, metered per
 * token, and the machine's subscription says nothing about what it spent.
 */
export function planReadable(
  profile: Pick<Profile, "id" | "usage"> | null | undefined,
  agent: Pick<AgentDef, "quotaProbe"> | null | undefined
): boolean {
  if (!profile) return false
  if (profileHasUsage(profile)) return true
  return profile.id.startsWith("default:") && Boolean(agent?.quotaProbe)
}

/* ── Subscription quota, client side ──
   What Claude Code's `/usage` and Codex's `/status` report, as the server
   normalized it. The shape itself lives in `server/src/protocol.ts` and arrives
   here type-only, like every other wire type — there is deliberately no second
   copy of it to keep in step.

   Everything in this file is display: how to fetch a reading, how to colour it,
   and how to say when it resets. No component matches on an agent id; a runtime
   whose windows are named differently just renders its own labels. */

export type { QuotaSnapshot, QuotaWindow }

/** Every probe-capable agent, read on its Default profile — the machine's own
    `claude`/`codex login`, which is what a subscription is — plus every profile
    that names a usage provider of its own, which is the other kind of plan this
    machine spends. `quota.source` says which a given entry is. */
export const fetchAllQuota = (settings: ServerSettings, refresh = false) =>
  api<QuotaSnapshot[]>(settings, `/api/quota${refresh ? "?refresh=1" : ""}`)

/** One agent, optionally under a named profile's credentials rather than the
    machine's. A thread asks this way: its profile is what it actually spawns on,
    and the honest answer there is often "an API key, so no plan". */
export function fetchQuota(
  settings: ServerSettings,
  agentId: string,
  { profileId, refresh }: { profileId?: string; refresh?: boolean } = {}
) {
  const query = new URLSearchParams()
  if (profileId) query.set("profileId", profileId)
  if (refresh) query.set("refresh", "1")
  const suffix = query.toString()
  return api<QuotaSnapshot>(settings, `/api/quota/${encodeURIComponent(agentId)}${suffix ? `?${suffix}` : ""}`)
}

/** One profile's provider plan, with no agent in the question — the account is
    the profile's, and every agent it serves shares the reading. */
export const fetchProfileQuota = (settings: ServerSettings, profileId: string, refresh = false) =>
  api<QuotaSnapshot>(
    settings,
    `/api/quota/profile/${encodeURIComponent(profileId)}${refresh ? "?refresh=1" : ""}`
  )

/** Whether this snapshot has anything to draw a bar for. */
export const hasWindows = (quota: QuotaSnapshot | null | undefined): quota is QuotaSnapshot =>
  Boolean(quota && quota.windows.length > 0)

/** The fullest window — what a one-line summary is about, since the limit you
    hit first is the one that matters. */
export function peakWindow(quota: QuotaSnapshot | null | undefined): QuotaWindow | null {
  if (!hasWindows(quota)) return null
  return quota.windows.reduce((worst, w) => (w.usedPercent > worst.usedPercent ? w : worst))
}

/**
 * Urgency colour for a used-percentage.
 *
 * Deliberately the same three bands and the same class pairs as `contextTone`
 * in composer-status.tsx — the two dials sit in one popover, and a bar that
 * turned amber at a different point from the ring beside it would read as two
 * different scales. Inverted in meaning, though: context fills toward a
 * compaction the agent handles, quota fills toward a wall it does not.
 */
export function quotaTone(percent: number): { text: string; bar: string } {
  if (percent >= 90) return { text: "text-destructive", bar: "bg-destructive" }
  if (percent >= 75) return { text: "text-amber-600 dark:text-amber-400", bar: "bg-amber-500" }
  return { text: "text-emerald-600 dark:text-emerald-400", bar: "bg-emerald-500" }
}

/**
 * When this window rolls over, in words.
 *
 * `resetsAt` wins because it is an instant and can be shown in *this device's*
 * timezone — a phone in another country should not be told a reset time from the
 * server's clock. `resetsLabel` is the fallback for the runtime that only ever
 * printed a formatted string (Claude Code), and it is passed through untouched
 * rather than re-parsed: it already names its own timezone.
 */
export function formatReset(window: QuotaWindow): string | null {
  if (window.resetsAt) {
    const when = new Date(window.resetsAt)
    const sameDay = when.toDateString() === new Date().toDateString()
    return when.toLocaleString(undefined, {
      ...(sameDay ? {} : { month: "short", day: "numeric" }),
      hour: "numeric",
      minute: "2-digit",
    })
  }
  return window.resetsLabel ?? null
}

/** One line for a snapshot with no windows — the common case, and one the UI has
    to say in words rather than draw as an empty dial. */
export function quotaStatusText(quota: QuotaSnapshot): string {
  switch (quota.status) {
    case "api-key":
      return "Running on an API key — usage is metered per token, with no plan limits to report."
    case "unauthenticated":
      return "Not signed in to a subscription on the server."
    case "unsupported":
      return "This runtime does not report subscription usage."
    case "error":
      return quota.error || "Couldn't read the usage report."
    default:
      return "No limit windows reported."
  }
}

/**
 * A snapshot per agent for the settings page, refetched on demand.
 *
 * Plain state rather than one of the device-local reactive stores (`pins.ts`,
 * `view-options.ts`): this is server data with a server-side cache in front of
 * it, so there is nothing to persist here and nothing a second tab could
 * disagree about.
 */
export function useAllQuota(settings: ServerSettings) {
  const [quotas, setQuotas] = useState<QuotaSnapshot[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const load = useCallback(
    async (refresh = false) => {
      setBusy(true)
      try {
        setQuotas(await fetchAllQuota(settings, refresh))
        setError(null)
      } catch (err) {
        setError(err)
      } finally {
        setBusy(false)
      }
    },
    [settings]
  )

  useEffect(() => {
    void load()
  }, [load])

  return { quotas, busy, error, reload: load }
}
