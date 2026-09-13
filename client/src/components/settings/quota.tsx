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

   The sections are filed under one card per provider (`QuotaKindCard`): two
   Z.AI keys share one Z.AI card, three Command Code seats one Command Code
   card — which is what makes a machine with five accounts readable as
   providers rather than five unrelated plans. Runtime logins are one card per
   runtime, headed by the runtime's own name. The sidebar popover draws the
   same shape at a glance's measure: one card per provider, each account a
   named section with its fullest window beside it. */
import * as React from "react"
import { GaugeIcon, RefreshCwIcon } from "lucide-react"

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
  formatReset,
  profileHasUsage,
  providerKindLabel,
  quotaStatusText,
  quotaTone,
  type QuotaSnapshot,
  type QuotaWindow,
} from "@/lib/quota"
import {
  useAgentQuota,
  useAllQuotaQuery,
  useProfileQuota,
} from "@/lib/queries/surfaces"
import { cn } from "@/lib/utils"
import { EmptyCard, Group, PageHeader } from "./primitives"
import { sectionMeta } from "./sections"

/** The id of an agent's virtual Default profile — the server mints the same
    string (`DEFAULT_PROFILE_PREFIX + agentId`), and it is what a card asks for
    when nobody has picked a profile. */
const defaultProfileId = (agentId: string) => `default:${agentId}`

function WindowBar({ window }: { window: QuotaWindow }) {
  const percent = Math.min(100, Math.max(0, Math.round(window.usedPercent)))
  const tone = quotaTone(percent)
  const reset = formatReset(window)
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-sm">{window.label}</span>
        <span className={cn("shrink-0 text-sm font-medium tabular-nums", tone.text)}>{percent}%</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-pill bg-muted">
        <div className={cn("h-full rounded-pill transition-[width]", tone.bar)} style={{ width: `${percent}%` }} />
      </div>
      {reset && <p className="mt-1 text-xs text-muted-foreground">Resets {reset}</p>}
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

/** One account's section header inside its kind's card: name and fullest-window
    summary on the name line (the sidebar popover's block leads with the same
    pair), plan badge and freshness under it, and the controls on their own
    line. Sections wrap in exactly one place: on a phone the picker and button
    take the line under the name, on `sm+` they sit back on the header's own
    line, right-aligned.

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
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
      {icon}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-medium">{name}</span>
            {quota.planName && (
              <Badge variant="secondary" className="capitalize">
                {quota.planName}
              </Badge>
            )}
          </div>
          {peakPercent !== null && peakTone && (
            <span className={cn("shrink-0 text-sm font-medium tabular-nums", peakTone.text)}>
              {peakPercent}%
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{meta}</p>
      </div>
      <div className="flex w-full items-center gap-2 sm:w-auto">
        {control && <div className="min-w-0 flex-1 sm:flex-none">{control}</div>}
        <Button
          variant="outline"
          size="sm"
          /* Alone on the line it fills it; beside a picker the picker gets the
             width, since a truncated model/profile name says less than a
             narrower button does. */
          className={cn("shrink-0 max-sm:h-9", !control && "max-sm:flex-1")}
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
    <div aria-busy="true" className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
        {icon}
        <div className="min-w-0 flex-1">
          {name ? (
            <p className="truncate text-sm font-medium">{name}</p>
          ) : (
            <Skeleton className="h-4 w-40 max-w-full" />
          )}
          <Skeleton className="mt-1.5 h-3 w-56 max-w-full" />
        </div>
        <Skeleton className="h-8 w-24 shrink-0 rounded-lg" />
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

/** Everything under a card's header, and the whole reason both cards can exist:
    a reading is a reading, whichever reader took it. */
function QuotaBody({ quota, rawLabel }: { quota: QuotaSnapshot; rawLabel: string }) {
  return (
    <>
      {quota.windows.length > 0 ? (
        <div className="space-y-3">
          {quota.windows.map((window) => (
            <WindowBar key={window.id} window={window} />
          ))}
        </div>
      ) : (
        /* Never a zeroed bar: "no plan here" is a different statement from
           "0% used", and drawing the second for the first is a lie. */
        <p className="text-sm text-muted-foreground">{quotaStatusText(quota)}</p>
      )}

      {quota.credits && (
        <p className="text-xs text-muted-foreground">
          Credits: {quota.credits.unlimited ? "unlimited" : (quota.credits.balance ?? "—")}
        </p>
      )}

      <RawReport raw={quota.raw} label={rawLabel} />
    </>
  )
}

/** The plan a *profile's* provider sells, read from that provider's own account
    API. No agent selector: the account is the profile's, and every runtime it
    serves spends the same windows.

    A card *section*: the border and the heading belong to the card the page
    files it under, which is the kind of plan it is (see `QuotaKindCard`). */
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
        <div className="p-4">
          <ErrorNote error={failure} onRetry={refetch} />
        </div>
      )
    }
    return <QuotaSectionSkeleton icon={icon} name={profile.name} />
  }

  return (
    <div className="space-y-4 p-4">
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
        <div className="p-4">
          <ErrorNote error={failure} onRetry={refetch} />
        </div>
      )
    }
    return <QuotaSectionSkeleton icon={icon} name={agentName} />
  }

  const profileName = profiles.find((p) => p.id === profileId)?.name ?? profileId
  const fetched = new Date(quota.fetchedAt)

  return (
    <div className="space-y-4 p-4">
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
              <SelectTrigger className="w-full max-sm:h-9 sm:w-44">
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

/** One card per provider — or per runtime for a machine login: the provider as
    the card's own header, and each account a section divided off from the
    next — name, fullest-window summary, bars, raw report. The same shape the
    sidebar popover draws at a glance's measure, at the density a page can
    hold. */
function QuotaKindCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 last:mb-0">
      <div className="overflow-hidden rounded-xl border bg-card">
        <h2 className="border-b px-4 py-2.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </h2>
        <div className="divide-y">{children}</div>
      </div>
    </section>
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
          <QuotaKindCard key={group.key} label={group.label}>
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
          </QuotaKindCard>
        ))
      )}
    </>
  )
}
