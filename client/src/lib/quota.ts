import type { QuotaAccount, QuotaSnapshot, QuotaWindow } from "@daedalus/protocol"

import { api, type AgentDef, type Profile, type ServerSettings } from "@/lib/settings"

/** Whether a profile names a plan of its own — the client twin of the server's
    `profileUsage` (usage-api.ts). A profile without one spends no plan at all:
    its threads are billed to an API key, and the reading an agent probe would
    return belongs to the machine's login, not to the profile — which is why the
    composer's Plan usage card is drawn for profiles that have this, and nowhere
    else. A disabled profile reads as having none: that is the half of
    "everywhere" the pickers are not. */
export const profileHasUsage = (profile: Pick<Profile, "usage" | "disabled"> | null | undefined): boolean => {
  if (profile?.disabled) return false
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
  profile: Pick<Profile, "id" | "usage" | "disabled"> | null | undefined,
  agent: Pick<AgentDef, "quotaProbe"> | null | undefined
): boolean {
  if (!profile) return false
  if (profile.disabled) return false
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

export type { QuotaAccount, QuotaSnapshot, QuotaWindow }

/** Every probe-capable agent, read on its Default profile — the machine's own
    `claude`/`codex login`, which is what a subscription is — plus every profile
    that names a usage provider of its own, which is the other kind of plan this
    machine spends. `quota.source` says which a given entry is. */
export const fetchAllQuota = (settings: ServerSettings, refresh = false, signal?: AbortSignal) =>
  api<QuotaSnapshot[]>(settings, `/api/quota${refresh ? "?refresh=1" : ""}`, { signal })

/** One agent, optionally under a named profile's credentials rather than the
    machine's. A thread asks this way: its profile is what it actually spawns on,
    and the honest answer there is often "an API key, so no plan". */
export function fetchQuota(
  settings: ServerSettings,
  agentId: string,
  { profileId, refresh, signal }: { profileId?: string; refresh?: boolean; signal?: AbortSignal } = {}
) {
  const query = new URLSearchParams()
  if (profileId) query.set("profileId", profileId)
  if (refresh) query.set("refresh", "1")
  const suffix = query.toString()
  return api<QuotaSnapshot>(settings, `/api/quota/${encodeURIComponent(agentId)}${suffix ? `?${suffix}` : ""}`, { signal })
}

/** One profile's provider plan, with no agent in the question — the account is
    the profile's, and every agent it serves shares the reading. */
export const fetchProfileQuota = (
  settings: ServerSettings,
  profileId: string,
  refresh = false,
  signal?: AbortSignal
) =>
  api<QuotaSnapshot>(
    settings,
    `/api/quota/profile/${encodeURIComponent(profileId)}${refresh ? "?refresh=1" : ""}`,
    { signal }
  )

/** A window's name where it is drawn in a flat list rather than under its own
    heading — the composer's popover, the sidebar's block, a one-line summary.

    A reading of one account is its label and nothing else. A reading of several
    (a 9Router gateway: many subscriptions behind one endpoint, `window.group`
    naming which) has to say which account, or four rows saying `session (5h)`
    are four unanswerable rows. The settings card is the exception and passes
    the bare label, because there the account is the heading the tiles sit
    under, and saying it again in every tile is the noise the sections removed. */
export const windowTitle = (window: QuotaWindow): string =>
  window.group?.trim() ? `${window.group.trim()} · ${window.label}` : window.label

/** The provider as words, for a heading or a subtitle: the label the adapter
    minted, else the slug itself. A reading taken before the adapter sent one
    still says something rather than nothing, and `providerLabel` is the
    adapter's because only it knows `vercel-ai-gateway` is "Vercel AI Gateway". */
export const providerLabelOf = (account: QuotaAccount): string | null =>
  account.providerLabel?.trim() || account.provider?.trim() || null

/** What an account inside a multi-account reading is called where it has to be
    one string — the sidebar popover's block title, the composer glance's
    heading. The Usage page draws the two halves itself, as a heading and a
    subtitle, and does not come through here. */
export const accountTitle = (account: QuotaAccount): string =>
  [account.name, providerLabelOf(account)].filter(Boolean).join(" · ")

/** A gateway's accounts filed under the provider they belong to, in first-seen
    order — which for 9Router is the gateway's own priority order, the order it
    will spend them in.

    The whole point of the reading: a gateway is not eight plans, it is three
    Claude logins and four Command Code seats and a Vercel key, and a flat list
    of sixteen makes the one that is exhausted a row among sixteen. Filed, each
    provider is a group with a count, and the accounts inside it are the
    interchangeable capacity they actually are. Keyed case-folded so `Codex` and
    `codex` are one provider; an account with no provider is its own group under
    "Other". */
export interface ProviderAccounts {
  /** The key to group by — the display label, which is what is drawn. */
  label: string
  accounts: QuotaAccount[]
}

export function accountsByProvider(accounts: QuotaAccount[]): ProviderAccounts[] {
  const groups = new Map<string, ProviderAccounts>()
  for (const account of accounts) {
    const label = providerLabelOf(account) ?? "Other"
    const key = label.toLowerCase()
    const held = groups.get(key)
    if (held) held.accounts.push(account)
    else groups.set(key, { label, accounts: [account] })
  }
  return [...groups.values()]
}

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
  if (percent >= 75) return { text: "text-warning", bar: "bg-warning" }
  return { text: "text-success", bar: "bg-success" }
}

/** Short display name for a provider usage kind — the card label when several
    accounts share one provider (two Z.AI keys, three Command Code seats). The
    only client-side copy: `profiles.tsx` keeps its own longer form labels for
    the setup form, so a new adapter adds its short name here too. */
export function providerKindLabel(kind: string): string {
  switch (kind) {
    case "zai":
      return "Z.AI"
    case "minimax":
      return "MiniMax"
    case "kimi":
      return "Kimi"
    case "synthetic":
      return "Synthetic"
    case "deepseek":
      return "DeepSeek"
    case "openrouter":
      return "OpenRouter"
    case "command-code":
      return "Command Code"
    case "9router":
      return "9Router"
    default:
      return kind || "Other"
  }
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

/** `0.47 / 6 credits`, when the provider gave the amounts the percentage came
    from. Null where it only ever printed a percentage (Claude Code, z.ai's token
    windows) — the bar already says that much, and a made-up denominator is the
    one thing `raw` exists to avoid. */
export function formatAmount(window: QuotaWindow): string | null {
  const { used, cap, unit } = window
  if (typeof used !== "number" || typeof cap !== "number" || cap <= 0) return null
  const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2))
  return `${n(used)} / ${n(cap)}${unit ? ` ${unit}` : ""}`
}

/** `2d 3h`, `1h 20m`, `14m`. The one duration format on these surfaces, so a
    reset countdown and a "hits the cap in" read as the same kind of number. */
export function formatDuration(ms: number): string | null {
  if (ms <= 0) return null
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** How long until it rolls over, beside the instant `formatReset` gives — "in
    2d 3h" is the number someone pacing a week actually reads. Only for a window
    with a real timestamp; a past one says nothing rather than counting up. */
export function formatResetIn(window: QuotaWindow): string | null {
  if (!window.resetsAt) return null
  const left = formatDuration(window.resetsAt - Date.now())
  return left && `in ${left}`
}

/** What is left, in the provider's own units — the other half of `formatAmount`,
    and the number someone deciding whether to start a long turn actually wants.
    Null on the same windows `formatAmount` is null on. */
export function formatRemaining(window: QuotaWindow): string | null {
  const { used, cap, unit } = window
  if (typeof used !== "number" || typeof cap !== "number" || cap <= 0) return null
  const left = Math.max(0, cap - used)
  return `${Number.isInteger(left) ? left : left.toFixed(2)}${unit ? ` ${unit}` : ""} left`
}

/**
 * Spend against the clock: where an evenly-paced spend would be right now, and
 * where this one lands if the rate holds.
 *
 * A percentage on its own is half a fact — 40% used is comfortable four hours
 * into a weekly window and alarming forty minutes into one. The window's length
 * (`windowMinutes`) and its rollover (`resetsAt`) are both already on the wire,
 * so elapsed time is a subtraction and the rest is one ratio.
 *
 * Null when either is missing (Claude Code's prose windows, z.ai's unrecognised
 * unit codes) and in the window's first tenth, where dividing by a nearly-zero
 * elapsed fraction turns one early request into "you will hit the cap in 3
 * minutes". Better to say nothing than to say that.
 *
 * ponytail: a rolling window is not a fixed bucket, so `elapsed` here is really
 * "time since the current window's notional start" and the projection is a
 * straight-line one. Good enough to pace by; if a provider ever hands us the
 * window's start directly, use that instead of deriving it.
 */
export interface WindowPace {
  /** 0–100: used-percent an even spend would show right now. */
  expectedPercent: number
  /** `usedPercent - expectedPercent`. Positive is spending fast. */
  deltaPoints: number
  /** Used-percent at the window's close if this rate holds. Uncapped, so >100
      is exactly the interesting case. */
  projectedPercent: number
  /** ms until the cap is hit at this rate, when that lands before the reset. */
  exhaustsInMs: number | null
}

/** Below this fraction of the window elapsed, the projection is noise. */
const PACE_FLOOR = 0.1

export function windowPace(window: QuotaWindow, now = Date.now()): WindowPace | null {
  const { windowMinutes, resetsAt, usedPercent } = window
  if (!windowMinutes || !resetsAt) return null
  const totalMs = windowMinutes * 60_000
  const leftMs = resetsAt - now
  if (leftMs <= 0 || leftMs > totalMs) return null
  const elapsed = (totalMs - leftMs) / totalMs
  if (elapsed < PACE_FLOOR) return null

  const used = Math.max(0, usedPercent)
  const expectedPercent = elapsed * 100
  const projectedPercent = used / elapsed
  /* Where the remaining budget runs out at the observed rate — only worth
     saying when it is before the reset, since after it the window rolls. */
  const rate = used / (totalMs - leftMs)
  const exhaustsInMs = rate > 0 && used < 100 ? (100 - used) / rate : null
  return {
    expectedPercent,
    deltaPoints: used - expectedPercent,
    projectedPercent,
    exhaustsInMs: exhaustsInMs !== null && exhaustsInMs < leftMs ? exhaustsInMs : null,
  }
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

