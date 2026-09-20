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
   somebody configured them on purpose. Everything below the header is shared:
   `QuotaBody` draws windows, credits and the raw report the same either way.

   A window is drawn as a **tile, not a line** (`WindowTile`), two up where the
   panel has room. The extra room is spent on the fields the wire was already
   carrying and the page was throwing away — `used`/`cap`/`unit` as a spent and a
   remaining, `resetsAt` as an instant *and* a countdown — plus the one reading
   that is derived rather than reported: pace. A percentage is half a fact (40%
   is comfortable four hours into a week and alarming forty minutes in), so
   `windowPace` divides the spend by the elapsed part of the window and the tile
   says the difference twice — as a tick on the bar where an even spend would
   stand, and as one line of words under it. Nothing new is asked of the server:
   every adapter in `usage-api.ts` was already sending this.

   Above the cards, `UsageOverview` answers the question no single card could:
   which limit on this machine is tightest, and when anything next rolls over. It
   reads the *list* route's snapshots only — the per-card queries belong to their
   cards, and a fourth reader of the same state is how two numbers start
   disagreeing.

   The sections are filed under one card per provider — the page's `Group`, the
   same captioned card every other settings list is built out of: two
   Z.AI keys share one Z.AI card, three Command Code seats one Command Code
   card — which is what makes a machine with five accounts readable as
   providers rather than five unrelated plans. Runtime logins are one card per
   runtime, headed by the runtime's own name. The sidebar popover draws the
   same shape at a glance's measure: one card per provider, each account a
   named section with its fullest window beside it. */
import * as React from "react"
import { CoinsIcon, GaugeIcon, MinusIcon, RefreshCwIcon, TrendingDownIcon, TrendingUpIcon } from "lucide-react"

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
import { profileAgentIds, type Profile } from "@/lib/settings"
import { useAgents, useProfiles } from "@/lib/queries/catalog"
import {
  formatAmount,
  formatDuration,
  formatRemaining,
  formatReset,
  formatResetIn,
  peakWindow,
  windowPace,
  profileHasUsage,
  providerKindLabel,
  quotaStatusText,
  quotaTone,
  windowTitle,
  type QuotaSnapshot,
  type QuotaWindow,
} from "@/lib/quota"
import {
  useAgentQuota,
  useAllQuotaQuery,
  useProfileQuota,
} from "@/lib/queries/surfaces"
import { cn } from "@/lib/utils"
import { EmptyCard, Group, INSET, PageHeader } from "./primitives"
import { sectionMeta } from "./sections"

/** The id of an agent's virtual Default profile — the server mints the same
    string (`DEFAULT_PROFILE_PREFIX + agentId`), and it is what a card asks for
    when nobody has picked a profile. */
const defaultProfileId = (agentId: string) => `default:${agentId}`

/** One window's pace, in the words someone deciding whether to start a long turn
    reads — and the only line on the tile that is a *judgement* rather than a
    reading, so it is the only one that takes a colour of its own.

    Three things it can say, in order of how much they matter: the cap arrives
    before the reset does, the spend is running fast enough to be worth knowing,
    or it is not. `windowPace` returns null where the window carries no clock, and
    then the tile simply has one line fewer. */
function PaceLine({ window }: { window: QuotaWindow }) {
  const pace = windowPace(window)
  if (!pace) return null

  if (pace.exhaustsInMs !== null) {
    const when = formatDuration(pace.exhaustsInMs)
    return (
      <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
        <TrendingUpIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">At this rate, the cap arrives in {when}</span>
      </p>
    )
  }

  const ahead = Math.round(pace.deltaPoints)
  /* Under ten points either way is the ordinary wobble of a rolling window, and
     narrating it would make every tile carry a line that never changes. */
  if (Math.abs(ahead) < 10) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <MinusIcon className="size-3.5 shrink-0" />
        On pace · {Math.round(pace.projectedPercent)}% projected
      </p>
    )
  }
  const fast = ahead > 0
  return (
    <p
      className={cn(
        "flex items-center gap-1.5 text-xs",
        fast ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
      )}
    >
      {fast ? <TrendingUpIcon className="size-3.5 shrink-0" /> : <TrendingDownIcon className="size-3.5 shrink-0" />}
      <span className="min-w-0 truncate">
        {fast ? `${ahead} pts ahead of pace` : `${-ahead} pts under pace`} · {Math.round(pace.projectedPercent)}%
        projected
      </span>
    </p>
  )
}

/** One limit window, as a tile rather than a line.

    The bar carries a second mark: a tick where an evenly-paced spend would stand
    right now. That is what turns a percentage into a reading — 40% is a
    comfortable four hours into a week and alarming forty minutes in, and the
    tick is the difference without a sentence. It is `windowPace`'s and is absent
    on a window with no clock, which is also the only case the tile loses a line. */
function WindowTile({ window }: { window: QuotaWindow }) {
  const percent = Math.min(100, Math.max(0, Math.round(window.usedPercent)))
  const tone = quotaTone(percent)
  const reset = formatReset(window)
  const amount = formatAmount(window)
  const remaining = formatRemaining(window)
  const resetIn = formatResetIn(window)
  const pace = windowPace(window)
  const marker = pace ? Math.min(100, Math.max(0, pace.expectedPercent)) : null

  return (
    <div className={cn("min-w-0 p-3", INSET)}>
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-xs font-medium">{window.label}</span>
        <span className={cn("shrink-0 text-base leading-none font-semibold tabular-nums", tone.text)}>
          {percent}%
        </span>
      </div>

      {/* `relative` so the pace tick can stand over the fill; the track itself is
          the same 1.5 the page has always drawn, thickened a hair so a 1px tick
          has something to sit in. */}
      <div className="relative mt-2 h-2 overflow-hidden rounded-pill bg-muted">
        <div className={cn("h-full rounded-pill transition-[width]", tone.bar)} style={{ width: `${percent}%` }} />
        {marker !== null && (
          <span
            aria-hidden
            title="Where an evenly-paced spend would be now"
            className="absolute inset-y-0 w-px bg-foreground/50"
            style={{ left: `${marker}%` }}
          />
        )}
      </div>

      <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
        {amount && (
          <div className="flex min-w-0 items-baseline justify-between gap-2">
            <dt className="shrink-0">Spent</dt>
            <dd className="min-w-0 truncate text-right tabular-nums text-foreground">{amount}</dd>
          </div>
        )}
        {remaining && (
          <div className="flex min-w-0 items-baseline justify-between gap-2">
            <dt className="shrink-0">Remaining</dt>
            <dd className="min-w-0 truncate text-right tabular-nums">{remaining}</dd>
          </div>
        )}
        {reset && (
          <div className="flex min-w-0 items-baseline justify-between gap-2">
            <dt className="shrink-0">Resets</dt>
            <dd className="min-w-0 truncate text-right">
              {reset}
              {resetIn && ` · ${resetIn}`}
            </dd>
          </div>
        )}
      </dl>

      <div className="mt-2 empty:mt-0">
        <PaceLine window={window} />
      </div>
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
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground">
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

/** One account's section header inside its kind's card, built the way every
    other settings list builds a row (`profiles.tsx`, `Row` in `primitives.tsx`):
    mark, name and a subtitle on the left, the controls on the right — stacked
    under the name on a phone, back on the header's own line at `sm+`.

    The one thing a settings row does not have is the fullest-window percentage,
    which rides at the end of the name line: the limit hit first is what the
    section is about, and it is the number the sidebar popover leads with too.

    Shared by both section kinds for the reason `QuotaBody` is — the two differ
    in what they name and whether they have a profile picker, not in how a
    section reads. */
function QuotaSectionHeader({
  icon,
  name,
  quota,
  meta,
  control,
  busy,
  onRefresh,
  refreshLabel,
}: {
  icon: React.ReactNode
  name: string
  quota: QuotaSnapshot
  meta: React.ReactNode
  /** The profile picker, on the section that has one. */
  control?: React.ReactNode
  busy: boolean
  onRefresh: () => void
  refreshLabel: string
}) {
  /* The fullest window — what the name line summarises, since the limit hit
     first is the one that matters. Missing when the reading has no windows,
     which draws no summary rather than a zero. */
  const peak =
    quota.windows.length > 0
      ? quota.windows.reduce((worst, window) => (window.usedPercent > worst.usedPercent ? window : worst))
      : null
  const peakPercent = peak ? Math.min(100, Math.max(0, Math.round(peak.usedPercent))) : null
  const peakTone = peakPercent !== null ? quotaTone(peakPercent) : null
  return (
    <div className="flex flex-col gap-3 @panel-sm:flex-row @panel-sm:items-center @panel-sm:justify-between">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {icon}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-x-2">
            <span className="truncate text-sm font-semibold">{name}</span>
            {quota.planName && (
              <Badge variant="secondary" className="shrink-0 capitalize">
                {quota.planName}
              </Badge>
            )}
            {peakPercent !== null && peakTone && (
              <span className={cn("ml-auto shrink-0 text-sm font-medium tabular-nums", peakTone.text)}>
                {peakPercent}%
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{meta}</p>
        </div>
      </div>
      {/* The picker takes the width on a phone and the button stays its own
          size: a truncated profile name says less than a narrower button does.
          At `sm+` both shrink to content and sit at the row's end. */}
      <div className="flex items-center gap-2 @panel-sm:shrink-0">
        {control && <div className="min-w-0 flex-1 @panel-sm:flex-none">{control}</div>}
        <Button
          variant="outline"
          size="sm"
          className="h-9 shrink-0"
          disabled={busy}
          onClick={onRefresh}
          aria-label={refreshLabel}
        >
          <RefreshCwIcon className={cn("size-3.5", busy && "animate-spin")} />
          Refresh
        </Button>
      </div>
    </div>
  )
}

/** One card while its own reading is in flight: the shape a reading draws —
    header line, window bars — rather than a sentence where a plan goes.

    The mark and the name are the real ones, because every card is drawn from
    the moment the page knows it exists: four providers on this machine means
    four named cards, each waiting on its own reader, and which one is slow is
    then something the page can show rather than something it hides behind a
    single page-wide spinner. Only the numbers are missing.

    It is a card *section* and not a `Group` of its own: the page draws one
    card per kind, so a border here would be a card inside a card. */
function QuotaSectionSkeleton({ icon, name }: { icon: React.ReactNode; name?: string }) {
  return (
    <div aria-busy="true" className="space-y-4 py-3.5">
      {/* The header the reading will draw, stacking the same way: identity
          first, the controls under it on a phone and beside it at `sm+`. */}
      <div className="flex flex-col gap-3 @panel-sm:flex-row @panel-sm:items-center @panel-sm:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {icon}
          <div className="min-w-0 flex-1">
            {name ? (
              <p className="truncate text-sm font-semibold">{name}</p>
            ) : (
              <Skeleton className="h-4 w-40 max-w-full" />
            )}
            <Skeleton className="mt-1.5 h-3 w-56 max-w-full" />
          </div>
        </div>
        <Skeleton className="h-9 w-24 shrink-0 rounded-lg @panel-sm:h-8" />
      </div>
      {[0, 1].map((bar) => (
        <div key={bar}>
          <div className="flex items-baseline justify-between gap-3">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-10" />
          </div>
          <Skeleton className="mt-1.5 h-1.5 w-full rounded-pill" />
        </div>
      ))}
    </div>
  )
}

/** Before the catalog answers nobody can be named and neither kind is known, so
    the wait is one anonymous group of two anonymous cards — the one moment the
    page has no identity to show. */
function QuotaCardsSkeleton() {
  return (
    <Group>
      {[0, 1].map((card) => (
        <QuotaSectionSkeleton key={card} icon={<Skeleton className="size-5 shrink-0 rounded-sm" />} />
      ))}
    </Group>
  )
}

/** A reading's windows.

    A grid, not a stack: a window is a tile of four facts, and two of them side
    by side is how a five-hour and a weekly limit get compared at a glance. The
    width asked is the *panel's* — settings squeezed beside a terminal is narrow
    for the same reason a phone is.

    **A window that names a `group` belongs to an account inside the reading,
    and an account is drawn as the plan it is**: a heading with its own bars
    under it, in the order the reader gave them, which for a gateway is the
    order it will spend the accounts in. Four subscriptions behind one 9Router
    endpoint are four sections in one card, each reading like the z.ai card next
    to it — where the flat grid put eight tiles of `<account> · session (5h)`
    beside each other and made none of them answerable.

    No component knows what a group *is*: this draws whatever the reading
    grouped, in first-seen order, and an ordinary plan — every window ungrouped
    — is the one flat grid it has always been. A reading that groups only some
    of its windows draws the ungrouped ones first, under no heading, because
    they belong to the reading itself and not to any account in it. */
function WindowGrid({ windows }: { windows: QuotaWindow[] }) {
  /* Insertion-ordered: `Map` keeps first-seen order, which is the reader's. */
  const sections = React.useMemo(() => {
    const byGroup = new Map<string, QuotaWindow[]>()
    for (const window of windows) {
      const key = window.group?.trim() || ""
      const held = byGroup.get(key)
      if (held) held.push(window)
      else byGroup.set(key, [window])
    }
    return [...byGroup.entries()]
  }, [windows])

  const grid = (group: QuotaWindow[]) => (
    <div className="grid gap-3 @panel-sm:grid-cols-2">
      {group.map((window) => (
        <WindowTile key={window.id} window={window} />
      ))}
    </div>
  )

  /* One section with no name is the ordinary plan, and it must not grow a
     wrapper that changes its spacing. */
  if (sections.length === 1 && !sections[0][0]) return grid(sections[0][1])

  return (
    <div className="space-y-5">
      {sections.map(([name, group]) => {
        if (!name) return <React.Fragment key="__ungrouped">{grid(group)}</React.Fragment>
        /* The account's own fullest window, beside its name — the same summary
           the card header gives the whole reading, so a section reads like the
           card it is modelled on and an exhausted account is visible without
           reading its tiles. */
        const peak = group.reduce((worst, window) => (window.usedPercent > worst.usedPercent ? window : worst))
        const percent = Math.min(100, Math.max(0, Math.round(peak.usedPercent)))
        const tone = quotaTone(percent)
        return (
          <section key={name} className="space-y-2.5">
            <div className="flex min-w-0 items-baseline gap-x-2">
              <h4 className="min-w-0 truncate text-xs font-semibold text-muted-foreground">{name}</h4>
              <span className={cn("ml-auto shrink-0 text-xs font-medium tabular-nums", tone.text)}>{percent}%</span>
            </div>
            {grid(group)}
          </section>
        )
      })}
    </div>
  )
}

/** Everything under a card's header, and the whole reason both cards can exist:
    a reading is a reading, whichever reader took it. */
function QuotaBody({ quota, rawLabel }: { quota: QuotaSnapshot; rawLabel: string }) {
  return (
    <>
      {quota.windows.length > 0 ? (
        <WindowGrid windows={quota.windows} />
      ) : (
        /* Never a zeroed bar: "no plan here" is a different statement from
           "0% used", and drawing the second for the first is a lie. */
        <p className="text-sm text-muted-foreground">{quotaStatusText(quota)}</p>
      )}

      {/* Credits are a balance, not a window — a pot that does not roll over — so
          it gets a row of its own rather than a bar that would imply one. On a
          plan with no windows at all (DeepSeek, an OpenRouter key with no cap)
          this is the whole reading, which is why it reads as a figure and not as
          a footnote. */}
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

/** The plan a *profile's* provider sells, read from that provider's own account
    API. No agent selector: the account is the profile's, and every runtime it
    serves spends the same windows.

    A card *section*: the border and the heading belong to the card the page
    files it under, which is the kind of plan it is (the page's `Group`). */
function ProfileQuotaSection({ profile, initial }: { profile: Profile; initial: QuotaSnapshot | null }) {
  /* Seeded when the list route happened to read this profile too, in which case
     the card is drawn at once; otherwise this query is the only reader, and the
     card is the skeleton until it answers. Refresh goes back to the provider
     either way (the `?refresh=1` bypass), rewriting this card's cache entry and
     the list's. */
  const { quota: reading, error, refetch, busy, refresh } = useProfileQuota(profile.id, initial)
  const quota = reading ?? initial

  if (!quota) {
    const icon = <ProfileIcon profile={profile} className="size-5 shrink-0" />
    /* A reading that failed is drawn, not sat on: there is no other section
       that would have carried this provider's failure, and a skeleton is a
       promise that something is still coming. */
    const failure = inlineFromQuery(error, `Couldn't read ${profile.name}'s plan usage`)
    if (failure) {
      return (
        <div className="p-3.5 @panel-sm:p-4">
          <ErrorNote error={failure} onRetry={refetch} />
        </div>
      )
    }
    return <QuotaSectionSkeleton icon={icon} name={profile.name} />
  }

  return (
    <div className="space-y-4 py-3.5">
      <QuotaSectionHeader
        icon={<ProfileIcon profile={profile} className="size-5 shrink-0" />}
        name={profile.name}
        quota={quota}
        meta={`Read ${new Date(quota.fetchedAt).toLocaleTimeString()} · shared by ${
          profileAgentIds(profile).length === 1 ? "1 agent" : `${profileAgentIds(profile).length} agents`
        }`}
        busy={busy}
        onRefresh={() => refresh()}
        refreshLabel={`Refresh ${profile.name}'s plan usage`}
      />
      <QuotaBody quota={quota} rawLabel="What the provider reported" />
    </div>
  )
}

function AgentQuotaSection({
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
  /* Seeded when the list route read this agent's Default profile too, which it
     usually has; picking another profile is a different cache entry and takes
     its own reading, and until either answers the card is its own skeleton. The
     query is keyed by the pair, so switching profiles does not disturb the
     reading the old one left in the cache. */
  const [profileId, setProfileId] = React.useState(defaultProfileId(agentId))
  const { quota: reading, error, refetch, busy, refresh } = useAgentQuota(agentId, profileId, initial)
  const quota = reading ?? initial

  if (!quota) {
    const icon = <AgentIcon agentId={agentId} className="size-5 shrink-0" />
    // Same as the provider card: a failure here is this card's to draw.
    const failure = inlineFromQuery(error, `Couldn't read ${agentName}'s usage`)
    if (failure) {
      return (
        <div className="p-3.5 @panel-sm:p-4">
          <ErrorNote error={failure} onRetry={refetch} />
        </div>
      )
    }
    return <QuotaSectionSkeleton icon={icon} name={agentName} />
  }

  const profileName = profiles.find((p) => p.id === profileId)?.name ?? profileId
  const fetched = new Date(quota.fetchedAt)

  return (
    <div className="space-y-4 py-3.5">
      <QuotaSectionHeader
        icon={<AgentIcon agentId={agentId} className="size-5 shrink-0" />}
        name={agentName}
        quota={quota}
        meta={`Read ${fetched.toLocaleTimeString()} · ${profileName}`}
        control={
          profiles.length > 1 ? (
            <Select
              value={profileId}
              onValueChange={(id) => setProfileId(id ?? defaultProfileId(agentId))}
            >
              <SelectTrigger className="h-9 w-full @panel-sm:w-44">
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
          ) : undefined
        }
        busy={busy}
        onRefresh={() => refresh()}
        refreshLabel={`Refresh ${agentName}'s usage`}
      />

      <QuotaBody quota={quota} rawLabel="What the runtime reported" />
    </div>
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

  /* One card per provider, runtimes last: providers are what somebody
     configured on purpose — two Z.AI keys share one Z.AI card, each still
     naming its own account — and a runtime login is the login this machine
     happens to have, headed by the runtime's own name. An account's `kind` is
     its profile's `usage.kind`, so a profile the catalog has not caught up
     with files under its own name rather than nowhere. */
  const groups = React.useMemo(() => {
    const byKind = new Map<string, { profiles: Profile[] }>()
    for (const profile of providerProfiles) {
      const kind = profile.usage?.kind && profile.usage.kind !== "none" ? profile.usage.kind : profile.id
      const group = byKind.get(kind) ?? { profiles: [] }
      group.profiles.push(profile)
      byKind.set(kind, group)
    }
    const providerGroups = [...byKind.entries()].map(([kind, group]) => ({
      key: `provider:${kind}`,
      label: providerKindLabel(kind),
      profiles: group.profiles,
      agents: [] as typeof agents,
    }))
    const runtimeGroups = probeAgents.map((agent) => ({
      key: `agent:${agent.id}`,
      label: agent.name,
      profiles: [] as typeof profiles,
      agents: [agent],
    }))
    return [...providerGroups, ...runtimeGroups].filter(
      (group) => group.profiles.length + group.agents.length > 0
    )
  }, [providerProfiles, probeAgents])

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
      {groups.length === 0 ? (
        /* Nothing to draw, and the list is the only thing that could still name
           something the catalog has not caught up with — so it is a wait until
           it answers, and an empty page after. */
        quotas === null ? (
          <QuotaCardsSkeleton />
        ) : (
          <EmptyCard
            icon={GaugeIcon}
            text="Nothing here reports a plan. Claude Code and Codex report the machine's own login; a provider that sells a coding plan reports it when the profile names a usage provider in Settings › Profiles."
          />
        )
      ) : (
        groups.map((group) => (
          <Group key={group.key} label={group.label}>
            {group.profiles.map((profile) => (
              <ProfileQuotaSection
                key={`profile:${profile.id}`}
                profile={profile}
                initial={readingFor((quota) => quota.source === "profile" && quota.profileId === profile.id)}
              />
            ))}
            {group.agents.map((agent) => (
              <AgentQuotaSection
                key={`agent:${agent.id}`}
                agentId={agent.id}
                agentName={agent.name}
                /* `source` decides which reading is the agent's, not the shape of
                   what came back: an agent reading with no windows is still an
                   agent's, and readings taken before providers existed have no
                   `source` at all. */
                initial={readingFor((quota) => quota.source !== "profile" && quota.agentId === agent.id)}
                profiles={profilesFor(agent.id)}
              />
            ))}
          </Group>
        ))
      )}
    </>
  )
}
