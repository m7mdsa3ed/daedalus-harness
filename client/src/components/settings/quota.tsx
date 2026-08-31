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
   `QuotaBody` draws windows, credits and the raw report the same either way. */
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
import { AgentIcon, ProfileIcon } from "@/components/entity-icon"
import { reportError } from "@/lib/errors"
import { profileAgentIds, type Profile } from "@/lib/settings"
import {
  fetchProfileQuota,
  fetchQuota,
  formatReset,
  quotaStatusText,
  quotaTone,
  type QuotaSnapshot,
  type QuotaWindow,
} from "@/lib/quota"
import { useAllQuota } from "@/lib/quota"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { EmptyCard, Group, PageHeader } from "./primitives"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"

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
        <span className="truncate text-sm">{window.label}</span>
        <span className={cn("text-sm font-medium tabular-nums", tone.text)}>{percent}%</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full transition-[width]", tone.bar)} style={{ width: `${percent}%` }} />
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
        <pre className="mt-2 max-h-64 overflow-auto rounded-lg border bg-muted/40 p-3 text-[11px] leading-relaxed whitespace-pre-wrap">
          {raw}
        </pre>
      </CollapsibleContent>
    </Collapsible>
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
    serves spends the same windows. */
function ProfileQuotaCard({ profile, initial }: { profile: Profile; initial: QuotaSnapshot }) {
  const { settings } = useSettingsPage()
  const [quota, setQuota] = React.useState(initial)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    setQuota(initial)
  }, [initial])

  const refresh = async () => {
    setBusy(true)
    try {
      setQuota(await fetchProfileQuota(settings, profile.id, true))
    } catch (err) {
      reportError(err, `Couldn't read ${profile.name}'s plan usage`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Group label={profile.name}>
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <ProfileIcon profile={profile} className="size-5" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{profile.name}</span>
              {quota.planName && (
                <Badge variant="secondary" className="capitalize">
                  {quota.planName}
                </Badge>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Read {new Date(quota.fetchedAt).toLocaleTimeString()} · shared by{" "}
              {profileAgentIds(profile).length === 1
                ? "1 agent"
                : `${profileAgentIds(profile).length} agents`}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void refresh()}
            aria-label={`Refresh ${profile.name}'s plan usage`}
          >
            <RefreshCwIcon className={cn("size-3.5", busy && "animate-spin")} />
            Refresh
          </Button>
        </div>
        <QuotaBody quota={quota} rawLabel="What the provider reported" />
      </div>
    </Group>
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
  initial: QuotaSnapshot
  /** The profiles that can spawn this agent, Default first. */
  profiles: { id: string; name: string }[]
}) {
  const { settings } = useSettingsPage()
  const [profileId, setProfileId] = React.useState(defaultProfileId(agentId))
  const [quota, setQuota] = React.useState(initial)
  const [busy, setBusy] = React.useState(false)

  /* The list route already read the Default profile, so that one is in hand;
     any other profile is a reading nobody has taken yet. */
  React.useEffect(() => {
    setQuota(initial)
  }, [initial])

  const load = React.useCallback(
    async (id: string, refresh: boolean) => {
      setBusy(true)
      try {
        setQuota(await fetchQuota(settings, agentId, { profileId: id, refresh }))
      } catch (err) {
        reportError(err, `Couldn't read ${agentName}'s usage`)
      } finally {
        setBusy(false)
      }
    },
    [settings, agentId, agentName]
  )

  const pick = (id: string) => {
    setProfileId(id)
    void load(id, false)
  }

  const profileName = profiles.find((p) => p.id === profileId)?.name ?? profileId
  const fetched = new Date(quota.fetchedAt)

  return (
    <Group label={agentName}>
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <AgentIcon agentId={agentId} className="size-5" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{agentName}</span>
              {quota.planName && (
                <Badge variant="secondary" className="capitalize">
                  {quota.planName}
                </Badge>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Read {fetched.toLocaleTimeString()} · {profileName}
            </p>
          </div>
          {profiles.length > 1 && (
            <Select value={profileId} onValueChange={(id) => pick(id ?? defaultProfileId(agentId))}>
              <SelectTrigger className="w-44">
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
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void load(profileId, true)}
            aria-label={`Refresh ${agentName}'s usage`}
          >
            <RefreshCwIcon className={cn("size-3.5", busy && "animate-spin")} />
            Refresh
          </Button>
        </div>

        <QuotaBody quota={quota} rawLabel="What the runtime reported" />
      </div>
    </Group>
  )
}

export function QuotaPage() {
  const { settings } = useSettingsPage()
  const { state } = useStore()
  const meta = sectionMeta("usage")
  const { quotas, busy, reload } = useAllQuota(settings)

  /* Default first, then the real profiles that name this agent — the same order
     the thread config menus use, and for the same reason: the agent as it ships
     is the baseline every other choice is a departure from. */
  const profilesFor = React.useCallback(
    (agentId: string) => [
      { id: defaultProfileId(agentId), name: "Default" },
      ...state.profiles
        .filter((profile) => !profile.id.startsWith("default:") && profile.agents?.[agentId])
        .map((profile) => ({ id: profile.id, name: profile.name })),
    ],
    [state.profiles]
  )

  const agentName = (id: string) => state.agents.find((agent) => agent.id === id)?.name ?? id

  return (
    <>
      <PageHeader
        meta={meta}
        action={
          <Button variant="outline" disabled={busy} onClick={() => void reload(true)}>
            <RefreshCwIcon className={cn("size-4", busy && "animate-spin")} />
            Refresh all
          </Button>
        }
      />
      {quotas === null ? (
        <p className="text-sm text-muted-foreground">Reading usage…</p>
      ) : quotas.length === 0 ? (
        <EmptyCard
          icon={GaugeIcon}
          text="Nothing here reports a plan. Claude Code and Codex report the machine's own login; a provider that sells a coding plan reports it when the profile names a usage provider in Settings › Profiles."
        />
      ) : (
        quotas.map((quota) => {
          /* `source` decides the card, not the shape of what came back: an
             agent reading with no windows is still an agent's. Readings taken
             before providers existed have no `source` and were all agents'. */
          if (quota.source !== "profile") {
            return (
              <AgentQuotaCard
                key={`agent:${quota.agentId}`}
                agentId={quota.agentId}
                agentName={agentName(quota.agentId)}
                initial={quota}
                profiles={profilesFor(quota.agentId)}
              />
            )
          }
          const profile = state.profiles.find((p) => p.id === quota.profileId)
          /* A profile the store has not caught up with yet — the list route
             reads the database directly. Skipped rather than drawn nameless. */
          if (!profile) return null
          return <ProfileQuotaCard key={`profile:${quota.profileId}`} profile={profile} initial={quota} />
        })
      )}
    </>
  )
}
