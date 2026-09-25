/* ── Settings › Usage ──
   What is left of the subscription each runtime is spending — Claude Code's
   `/usage` and Codex's `/status`, read by the server (quota.ts) and normalized
   to one shape.

   The page draws windows, not runtimes: a card knows an agent's name and mark
   and nothing else about it, and every bar comes from `quota.windows`. A
   runtime that meters differently — three windows, or one named something the
   harness has never heard of — renders correctly with no edit here.

   The default reading per agent is the machine's: its virtual Default profile,
   which carries no credentials, so the agent runs on whatever `claude` /
   `codex login` gave it — and *that* is what a subscription is. The profile
   selector is for the other question: a gateway profile spends an API key, and
   asking it says so in as many words rather than leaving the user to infer it.

   There are two kinds of card, because there are two kinds of plan, and
   `quota.source` is what says which a reading is. An **agent** card is the one
   above. A **provider** card is a profile that names a usage API of its own
   (Z.AI's GLM Coding Plan and its like) — the plan the threads on that profile
   are genuinely billed to, read from the provider's account API rather than
   from any runtime. It has no agent selector because it has no agent: one
   account, shared by every runtime the profile serves. Those come first, since
   somebody configured them on purpose. Everything below the header is shared —
   the card body draws windows, credits and the raw report the same either way.

   The layout is 9Router's own: a grid of cards, two up where the column has
   room, one per reading, and a gateway's accounts as sections of its one card. A
   window is one line in its card (`WindowRow`): the name, spent of cap, a bar
   and what is **left**, and when it rolls over — ten to a page, because a
   gateway account can carry a dozen model windows. Pace is derived rather than
   reported (`windowPace`) and survives where it changes the answer: a spend
   that reaches the cap before the reset says so in the reset's place.

   Above the cards, `UsageOverview` answers the question no single card could:
   which limit on this machine is tightest, and when anything next rolls over. It
   reads the *list* route's snapshots only — the per-card queries belong to their
   cards, and a fourth reader of the same state is how two numbers start
   disagreeing. */
import * as React from "react"
import { CoinsIcon, GaugeIcon, RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { AgentIcon, ProfileIcon } from "@/components/entity-icon"
import { ErrorNote } from "@/components/error-note"
import { inlineFromQuery } from "@/lib/errors"
import type { Profile } from "@/lib/settings"
import { useAgents, useProfiles } from "@/lib/queries/catalog"
import {
  formatAmount,
  formatDuration,
  formatReset,
  formatResetIn,
  peakWindow,
  windowPace,
  profileHasUsage,
  providerKindLabel,
  quotaStatusText,
  quotaTone,
  windowTitle,
  type QuotaAccount,
  type QuotaSnapshot,
  type QuotaWindow,
} from "@/lib/quota"
import {
  useAgentQuota,
  useAllQuotaQuery,
  useProfileQuota,
} from "@/lib/queries/surfaces"
import { cn } from "@/lib/utils"
import { EmptyCard, INSET, PageHeader } from "./primitives"
import { sectionMeta } from "./sections"

/** The id of an agent's virtual Default profile — the server mints the same
    string (`DEFAULT_PROFILE_PREFIX + agentId`), and it is what a card asks for
    when nobody has picked a profile. */
const defaultProfileId = (agentId: string) => `default:${agentId}`

/** Rows a card lists before it pages — a gateway account can carry a dozen
    model windows, and a card that grows to fit them all pushes its neighbour in
    the other column out of line. */
const PAGE_SIZE = 10

/** The one card every reading is drawn in: a header naming whose plan it is,
    with its actions at the end, and the body under a hairline.

    `@container` so the rows answer to the *card's* width — two cards side by
    side are each half the column, and a row that asked the panel would lay out
    for a width it does not have. */
function UsageCard({
  icon,
  title,
  subtitle,
  badges,
  actions,
  busy,
  className,
  children,
}: {
  icon: React.ReactNode
  title: React.ReactNode
  subtitle?: React.ReactNode
  badges?: React.ReactNode
  actions?: React.ReactNode
  busy?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      aria-busy={busy || undefined}
      className={cn("@container flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm", className)}
    >
      <div className="flex min-w-0 items-center gap-3 px-3.5 py-3">
        {icon}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{title}</div>
          {subtitle && <div className="truncate text-xs text-muted-foreground">{subtitle}</div>}
          {badges && <div className="mt-1 flex flex-wrap gap-1">{badges}</div>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      <div className="flex flex-1 flex-col gap-2.5 border-t border-border/60 p-3">{children}</div>
    </div>
  )
}

function RefreshAction({ busy, onClick, label }: { busy: boolean; onClick: () => void; label: string }) {
  return (
    <Button variant="ghost" size="icon-sm" disabled={busy} onClick={onClick} aria-label={label} title={label}>
      <RefreshCwIcon className={cn("size-3.5", busy && "animate-spin")} />
    </Button>
  )
}

/** A body with no rows says why in words, centred where the rows would be.
    Never a zeroed bar: "no plan here" is a different statement from "0% used". */
function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="py-5 text-center text-xs text-muted-foreground">{children}</p>
}

/** One limit window, as one line: dot, name, the amounts, a bar, what is left
    and when it rolls over.

    The figure is what is **left**, not what is spent — a full green bar is a
    fresh window — while the tone still comes from the spend, so an exhausted
    window is a red 0%. The pace survives only where it changes the answer: a
    spend that reaches the cap before the reset takes the reset's column. What
    the row cannot hold (the spent-of-cap on a narrow card, the bar under ~28rem)
    is dropped by the card's own width, never by the viewport. */
function WindowRow({ window }: { window: QuotaWindow }) {
  const used = Math.min(100, Math.max(0, Math.round(window.usedPercent)))
  const tone = quotaTone(used)
  const amount = formatAmount(window)
  const pace = windowPace(window)
  const exhausts = pace?.exhaustsInMs != null ? formatDuration(pace.exhaustsInMs) : null
  const reset = formatResetIn(window) ?? formatReset(window)
  /* A window nothing is counted against has a figure but no wall: a full track
     would read as "there is a limit and you are nowhere near it". */
  const metered = window.unlimited === true

  return (
    <li
      className="flex min-w-0 items-center gap-2.5 px-3 py-1.5 text-xs"
      title={`${windowTitle(window)} · ${used}% used${reset ? ` · resets ${reset}` : ""}`}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", metered ? "bg-muted-foreground/50" : tone.bar)} />
      <span className="min-w-0 flex-1 truncate font-medium @md:w-36 @md:flex-none">{window.label}</span>
      {amount && <span className="hidden shrink-0 text-muted-foreground tabular-nums @sm:inline">{amount}</span>}
      {metered ? (
        <span className="hidden flex-1 @md:block" />
      ) : (
        <div className="hidden h-1 min-w-8 flex-1 overflow-hidden rounded-pill bg-muted @md:block">
          <div className={cn("h-full rounded-pill transition-[width]", tone.bar)} style={{ width: `${100 - used}%` }} />
        </div>
      )}
      <span
        className={cn(
          "w-10 shrink-0 text-right font-semibold tabular-nums",
          metered ? "text-muted-foreground" : tone.text
        )}
      >
        {metered ? "∞" : `${100 - used}%`}
      </span>
      <span
        className={cn(
          "w-24 shrink-0 truncate text-right tabular-nums",
          exhausts ? "text-destructive" : "text-muted-foreground"
        )}
      >
        {exhausts ? `cap in ${exhausts}` : (reset ?? "")}
      </span>
    </li>
  )
}

/** A card's windows, ten to a page. The page resets to what still exists when a
    refresh brings back fewer windows than the one being read. */
function WindowList({ windows, bare }: { windows: QuotaWindow[]; bare?: boolean }) {
  const [page, setPage] = React.useState(0)
  const pages = Math.ceil(windows.length / PAGE_SIZE)
  const current = Math.min(page, pages - 1)
  const start = current * PAGE_SIZE
  const shown = windows.slice(start, start + PAGE_SIZE)
  return (
    <div className="space-y-1.5">
      <p className="px-0.5 text-[11px] text-muted-foreground">
        {windows.length === 1 ? "1 quota" : `${windows.length} quotas`}
      </p>
      {/* `bare` inside a box that is already inset — a second frame on the
          same ground is two identical frames one inside the other. */}
      <ul className={cn("divide-y divide-border/60 overflow-hidden", !bare && INSET)}>
        {shown.map((window) => (
          <WindowRow key={window.id} window={window} />
        ))}
      </ul>
      {pages > 1 && (
        <div className="flex items-center justify-between gap-2 px-0.5 text-[11px] text-muted-foreground">
          <span className="tabular-nums">
            Showing {start + 1}–{start + shown.length} of {windows.length}
          </span>
          <div className="flex items-center gap-1.5">
            <span className="tabular-nums">
              Page {current + 1} / {pages}
            </span>
            <Button variant="outline" size="xs" disabled={current === 0} onClick={() => setPage(current - 1)}>
              Prev
            </Button>
            <Button variant="outline" size="xs" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/** What answered, folded away. It is here for the case the parser misses a
    line — one adapter reads prose and another reads an undocumented JSON API —
    so it is always offered, never only on failure. */
function RawReport({ raw, label }: { raw: string; label: string }) {
  if (!raw.trim()) return null
  return (
    <Collapsible>
      <CollapsibleTrigger
        render={
          <Button variant="ghost" size="xs" className="text-muted-foreground">
            {label}
          </Button>
        }
      />
      <CollapsibleContent>
        {/* `break-words` and not `overflow-x-auto`: a report is prose and long
            paths, and a horizontally scrolling block inside a vertically
            scrolling page is a gesture fight on a phone. */}
        <pre className="mt-2 max-h-64 overflow-y-auto rounded-lg border bg-muted/40 p-3 text-[11px] leading-relaxed break-words whitespace-pre-wrap">
          {raw}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** What a reading carries besides its windows. Credits are a balance, not a
    window — a pot that does not roll over — so they are a row of their own; on
    a plan with no windows at all (DeepSeek, an uncapped OpenRouter key) this is
    the whole reading. */
function ReadingExtras({ quota, rawLabel }: { quota: QuotaSnapshot; rawLabel: string }) {
  return (
    <>
      {quota.credits && (
        <div className={cn("flex items-baseline justify-between gap-3 px-3 py-2", INSET)}>
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <CoinsIcon className="size-3.5" />
            Balance
          </span>
          <span className="min-w-0 truncate text-right text-sm font-medium tabular-nums">
            {quota.credits.unlimited ? "Unlimited" : (quota.credits.balance ?? "—")}
          </span>
        </div>
      )}
      <RawReport raw={quota.raw} label={rawLabel} />
    </>
  )
}

const PlanBadge = ({ plan }: { plan?: string | null }) =>
  plan ? (
    <Badge variant="secondary" className="m-0 capitalize">
      {plan}
    </Badge>
  ) : null

/** A card while its own reading is in flight. The mark and the name are the
    real ones — every card is drawn from the moment the page knows it exists, so
    which provider is slow is something the page shows. Only the rows wait. */
function UsageCardSkeleton({ icon, title }: { icon: React.ReactNode; title?: React.ReactNode }) {
  return (
    <UsageCard
      busy
      icon={icon}
      title={title ?? <Skeleton className="h-4 w-32 max-w-full" />}
      subtitle={<Skeleton className="mt-1 h-3 w-44 max-w-full" />}
    >
      {[0, 1, 2].map((row) => (
        <Skeleton key={row} className="h-6 w-full rounded-md" />
      ))}
    </UsageCard>
  )
}

/** Before the catalog answers nobody can be named, so the wait is two
    anonymous cards. */
function QuotaCardsSkeleton() {
  return (
    <>
      {[0, 1].map((card) => (
        <UsageCardSkeleton key={card} icon={<Skeleton className="size-7 shrink-0 rounded-md" />} />
      ))}
    </>
  )
}

/** The plan a *profile's* provider sells, read from that provider's own account
    API. No agent selector: the account is the profile's, and every runtime it
    serves spends the same windows.

    **A gateway is one card, the full width of the grid, with a section per
    account** — two up where the card has room, each drawn the way 9Router draws
    its own. One card, because the accounts are one endpoint's: one refresh, one
    balance, one raw report, and windows no account claims sit above them.
    Accounts are filed under their provider, one captioned group each. Accounts come from `quota.accounts`,
    in the gateway's order (the order it will spend them in), and each finds its
    rows by `group`; an account with no windows is drawn too, with its own state,
    because a page listing only the accounts that reported never says the silent
    one exists. */
function ProfileQuotaCards({ profile, initial }: { profile: Profile; initial: QuotaSnapshot | null }) {
  /* Seeded when the list route happened to read this profile too; otherwise
     this query is the only reader. Refresh goes back to the provider either way. */
  const { quota: reading, error, refetch, busy, refresh } = useProfileQuota(profile.id, initial)
  const quota = reading ?? initial
  const icon = <ProfileIcon profile={profile} className="size-7 shrink-0" />
  const kind = profile.usage?.kind && profile.usage.kind !== "none" ? providerKindLabel(profile.usage.kind) : null

  if (!quota) {
    /* A reading that failed is drawn, not sat on: a skeleton is a promise that
       something is still coming. */
    const failure = inlineFromQuery(error, `Couldn't read ${profile.name}'s plan usage`)
    if (failure) {
      return (
        <UsageCard icon={icon} title={profile.name} subtitle={kind}>
          <ErrorNote error={failure} onRetry={refetch} />
        </UsageCard>
      )
    }
    return <UsageCardSkeleton icon={icon} title={profile.name} />
  }

  const actions = (
    <RefreshAction busy={busy} onClick={() => refresh()} label={`Refresh ${profile.name}'s plan usage`} />
  )
  const read = `Read ${new Date(quota.fetchedAt).toLocaleTimeString()}`
  const accounts = quota.accounts ?? []

  if (accounts.length === 0) {
    return (
      <UsageCard
        icon={icon}
        title={profile.name}
        subtitle={[kind, read].filter(Boolean).join(" · ")}
        badges={quota.planName && <PlanBadge plan={quota.planName} />}
        actions={actions}
        busy={busy}
      >
        {quota.windows.length > 0 ? (
          <WindowList windows={quota.windows} />
        ) : (
          <EmptyNote>{quotaStatusText(quota)}</EmptyNote>
        )}
        <ReadingExtras quota={quota} rawLabel="What the provider reported" />
      </UsageCard>
    )
  }

  const groupOf = (window: QuotaWindow) => window.group?.trim() || ""
  const ungrouped = quota.windows.filter((window) => !groupOf(window))
  /* Accounts filed under their provider — every Antigravity login together,
     every Command Code seat together — in first-seen order, which is the
     gateway's. Keyed case-folded so `Codex` and `codex` are one group. */
  const byProvider = [
    ...accounts
      .reduce((groups, account) => {
        const key = account.provider?.trim() ?? ""
        const held = groups.get(key.toLowerCase())
        if (held) held[1].push(account)
        else groups.set(key.toLowerCase(), [key, [account]])
        return groups
      }, new Map<string, [string, QuotaAccount[]]>())
      .values(),
  ]
  return (
    <UsageCard
      icon={icon}
      title={profile.name}
      subtitle={`${accounts.length === 1 ? "1 account" : `${accounts.length} accounts`} · ${read}`}
      actions={actions}
      busy={busy}
      className="@2xl:col-span-2"
    >
      {ungrouped.length > 0 && <WindowList windows={ungrouped} />}
      {byProvider.map(([provider, members]) => (
        <section key={provider || "__other"} className="space-y-2">
          <h3 className="flex items-baseline gap-2 px-0.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
            {provider || "Other"}
            <span className="font-normal tabular-nums normal-case">
              {members.length === 1 ? "1 account" : `${members.length} accounts`}
            </span>
          </h3>
          <div className="grid gap-3 @2xl:grid-cols-2">
            {members.map((account) => {
              const windows = quota.windows.filter((window) => groupOf(window) === account.group)
              return (
                <div key={account.id} className={cn("@container min-w-0 space-y-2 p-2.5", INSET)}>
                  {/* The provider is the heading above, so a section is named
                      by whose account it is. */}
                  <div className="flex min-w-0 items-center gap-2">
                    <h4 className="min-w-0 flex-1 truncate text-xs font-semibold">{account.name}</h4>
                    <PlanBadge plan={account.plan} />
                    {account.disabled && (
                      <Badge variant="outline" className="m-0">
                        Off
                      </Badge>
                    )}
                  </div>
                  {windows.length > 0 ? (
                    <WindowList windows={windows} bare />
                  ) : (
                    <EmptyNote>
                      {account.disabled
                        ? "Turned off in the gateway — not being spent"
                        : (account.state ?? "No quota reported")}
                    </EmptyNote>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      ))}
      <ReadingExtras quota={quota} rawLabel="What the gateway reported" />
    </UsageCard>
  )
}

function AgentQuotaCard({
  agentId,
  agentName,
  initial,
  profiles,
}: {
  agentId: string
  agentName: string
  initial: QuotaSnapshot | null
  /** The profiles that can spawn this agent, Default first. */
  profiles: { id: string; name: string }[]
}) {
  /* Keyed by the (agent, profile) pair, so switching profiles does not disturb
     the reading the old one left in the cache. */
  const [profileId, setProfileId] = React.useState(defaultProfileId(agentId))
  const { quota: reading, error, refetch, busy, refresh } = useAgentQuota(agentId, profileId, initial)
  const quota = reading ?? initial
  const icon = <AgentIcon agentId={agentId} className="size-7 shrink-0" />

  if (!quota) {
    const failure = inlineFromQuery(error, `Couldn't read ${agentName}'s usage`)
    if (failure) {
      return (
        <UsageCard icon={icon} title={agentName}>
          <ErrorNote error={failure} onRetry={refetch} />
        </UsageCard>
      )
    }
    return <UsageCardSkeleton icon={icon} title={agentName} />
  }

  const profileName = profiles.find((p) => p.id === profileId)?.name ?? profileId

  return (
    <UsageCard
      icon={icon}
      title={agentName}
      subtitle={`${profileName} · Read ${new Date(quota.fetchedAt).toLocaleTimeString()}`}
      badges={quota.planName && <PlanBadge plan={quota.planName} />}
      busy={busy}
      actions={
        <>
          {profiles.length > 1 && (
            <Select value={profileId} onValueChange={(id) => setProfileId(id ?? defaultProfileId(agentId))}>
              <SelectTrigger size="sm" className="w-28 text-xs" aria-label={`Profile ${agentName} is read through`}>
                <SelectValue>{profileName}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {profiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <RefreshAction busy={busy} onClick={() => refresh()} label={`Refresh ${agentName}'s usage`} />
        </>
      }
    >
      {quota.windows.length > 0 ? (
        <WindowList windows={quota.windows} />
      ) : (
        <EmptyNote>{quotaStatusText(quota)}</EmptyNote>
      )}
      <ReadingExtras quota={quota} rawLabel="What the runtime reported" />
    </UsageCard>
  )
}

/** The whole machine in four figures, above the cards.
 *
 * The cards answer "how is this account doing"; the question they could not
 * answer between them is "is anything about to run out", which on a machine with
 * five accounts meant reading five cards to find the one number that mattered.
 * So: the tightest window anywhere and what it belongs to, the headroom left in
 * it, when the next reset of any kind lands, and how much was read at all.
 *
 * Derived from the list route's readings only — the per-card queries are each
 * card's own, and reaching across them would make this a fourth owner of state
 * the page already has two of. A card refreshed on its own updates that card;
 * "Refresh all" is what moves this. */
function UsageOverview({
  quotas,
  nameOf,
}: {
  quotas: QuotaSnapshot[]
  /** What to call a reading. The snapshot carries ids, not names — the catalog
      is what turns one into the other, and it is the page's, not this box's. */
  nameOf: (quota: QuotaSnapshot) => string
}) {
  const readings = quotas.filter((quota) => quota.windows.length > 0)
  if (readings.length === 0) return null

  /* The tightest window on the machine, carrying the name of what it belongs to
     — a percentage with nothing attached is not actionable. */
  let tightest: { window: QuotaWindow; who: string } | null = null
  let soonest: QuotaWindow | null = null
  for (const quota of readings) {
    const peak = peakWindow(quota)
    if (peak && (!tightest || peak.usedPercent > tightest.window.usedPercent)) {
      tightest = { window: peak, who: nameOf(quota) }
    }
    for (const window of quota.windows) {
      if (!window.resetsAt || window.resetsAt <= Date.now()) continue
      if (!soonest?.resetsAt || window.resetsAt < soonest.resetsAt) soonest = window
    }
  }
  if (!tightest) return null

  const percent = Math.min(100, Math.max(0, Math.round(tightest.window.usedPercent)))
  const tone = quotaTone(percent)
  const pace = windowPace(tightest.window)
  const stat = "min-w-0 flex-1 py-3 @panel-sm:px-4 @panel-sm:first:ps-0 @panel-sm:last:pe-0"
  const label = "truncate text-xs text-muted-foreground"
  const figure = "mt-1 truncate text-xl leading-none font-semibold tabular-nums"
  const under = "mt-1.5 truncate text-xs text-muted-foreground"

  return (
    <div className="mb-8 flex flex-col divide-y divide-border/60 border-y border-border/60 @panel-sm:flex-row @panel-sm:divide-x @panel-sm:divide-y-0">
      <div className={stat}>
        <p className={label}>Tightest limit</p>
        <p className={cn(figure, tone.text)}>{percent}%</p>
        <p className={under}>
          {tightest.who} · {windowTitle(tightest.window)}
        </p>
      </div>
      <div className={stat}>
        <p className={label}>Headroom</p>
        <p className={figure}>{100 - percent}%</p>
        <p className={under}>
          {pace
            ? pace.exhaustsInMs !== null
              ? `Gone in ${formatDuration(pace.exhaustsInMs)} at this rate`
              : `${Math.round(pace.projectedPercent)}% projected at reset`
            : /* No clock on that window, so no projection — say what the figure
                 is rather than leaving the line empty. */
              "Of the tightest window"}
        </p>
      </div>
      <div className={stat}>
        <p className={label}>Next reset</p>
        <p className={figure}>{soonest ? (formatDuration(soonest.resetsAt! - Date.now()) ?? "now") : "—"}</p>
        <p className={under}>{soonest ? `${windowTitle(soonest)} · ${formatReset(soonest)}` : "No reset time reported"}</p>
      </div>
      <div className={stat}>
        <p className={label}>Plans read</p>
        <p className={figure}>{readings.length}</p>
        <p className={under}>{readings.reduce((n, quota) => n + quota.windows.length, 0)} limit windows</p>
      </div>
    </div>
  )
}

export function QuotaPage() {
  const profiles = useProfiles()
  const agents = useAgents()
  const meta = sectionMeta("usage")
  const { quotas, busy, reload } = useAllQuotaQuery()

  /* Default first, then the real profiles that name this agent — the same order
     the thread config menus use, and for the same reason: the agent as it ships
     is the baseline every other choice is a departure from. */
  const profilesFor = React.useCallback(
    (agentId: string) => [
      { id: defaultProfileId(agentId), name: "Default" },
      ...profiles
        .filter((profile) => !profile.id.startsWith("default:") && profile.agents?.[agentId])
        .map((profile) => ({ id: profile.id, name: profile.name })),
    ],
    [profiles]
  )

  /* Which cards there are is the *catalog's* answer, not the list route's: a
     profile that names a usage provider and an agent that carries a probe are
     both known before anything is read. So every card is drawn at once and each
     takes its own reading — a provider that is slow, or wedged, holds up its own
     card and nothing else, and the page says which one it is waiting on instead
     of replacing all of them with one skeleton.

     The list route still runs, and is still worth running: it seeds the cards
     whose readings it already took (an agent's Default, every provider), so the
     ordinary page load draws finished cards rather than waiting on a second
     round of calls. */
  /* A snapshot carries ids; the overview wants a name. Resolved here, where the
     catalog already is — a provider reading is its profile's, an agent reading
     its runtime's, and an id neither list knows falls back to itself. */
  const nameOf = React.useCallback(
    (quota: QuotaSnapshot) =>
      quota.source === "profile"
        ? (profiles.find((profile) => profile.id === quota.profileId)?.name ?? quota.profileId)
        : (agents.find((agent) => agent.id === quota.agentId)?.name ?? quota.agentId),
    [profiles, agents]
  )

  const providerProfiles = profiles.filter((profile) => profileHasUsage(profile))
  const probeAgents = agents.filter((agent) => agent.quotaProbe)
  const readingFor = (match: (quota: QuotaSnapshot) => boolean) => quotas?.find(match) ?? null

  return (
    <>
      <PageHeader
        meta={meta}
        action={
          <Button variant="outline" disabled={busy} onClick={() => reload(true)}>
            <RefreshCwIcon className={cn("size-4", busy && "animate-spin")} />
            Refresh all
          </Button>
        }
      />
      {quotas && <UsageOverview quotas={quotas} nameOf={nameOf} />}
      {providerProfiles.length + probeAgents.length === 0 && quotas !== null ? (
        /* Nothing to draw, and the list is the only thing that could still name
           something the catalog has not caught up with — so a wait until it
           answers, and an empty page after. */
        <EmptyCard
          icon={GaugeIcon}
          text="Nothing here reports a plan. Claude Code and Codex report the machine's own login; a provider that sells a coding plan reports it when the profile names a usage provider in Settings › Profiles."
        />
      ) : (
        /* Providers first — somebody configured them on purpose — then the
           runtime logins. The grid asks its own width, not the panel's: the
           settings column is narrower than the panel it sits in. */
        <div className="@container">
          <div className="grid gap-3 @2xl:grid-cols-2">
            {providerProfiles.length + probeAgents.length === 0 && <QuotaCardsSkeleton />}
            {providerProfiles.map((profile) => (
              <ProfileQuotaCards
                key={`profile:${profile.id}`}
                profile={profile}
                initial={readingFor((quota) => quota.source === "profile" && quota.profileId === profile.id)}
              />
            ))}
            {probeAgents.map((agent) => (
              <AgentQuotaCard
                key={`agent:${agent.id}`}
                agentId={agent.id}
                agentName={agent.name}
                /* `source` decides which reading is the agent's, not the shape of
                   what came back: readings taken before providers existed have
                   no `source` at all. */
                initial={readingFor((quota) => quota.source !== "profile" && quota.agentId === agent.id)}
                profiles={profilesFor(agent.id)}
              />
            ))}
          </div>
        </div>
      )}
    </>
  )
}
