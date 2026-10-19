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

   The layout is a stat strip over one block per reading. A block is a head (the
   mark, the name, the plan, a refresh) over a `DataTable` of the reading's
   windows: Account | Window | Used | Resets | Status, a gateway's accounts filed
   under their provider with `grouping`. A window is one row (`UsageRow`), and an
   account that reported none is a row too, carrying its own state, because a
   page listing only the accounts that reported never says the silent one
   exists. On a narrow panel a row is the window, its meter and when it rolls
   over. Pace is derived rather than reported (`windowPace`) and survives where
   it changes the answer: a spend that reaches the cap before the reset says so
   in the reset's place.

   Above the blocks, `UsageOverview` answers the question no single card could:
   which limit on this machine is tightest, and when anything next rolls over. It
   reads the *list* route's snapshots only — the per-block queries belong to their
   blocks, and a fourth reader of the same state is how two numbers start
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
import { Empty } from "@/components/empty"
import { useTableFilter } from "@/lib/use-table-filter"
import {
  DataTable,
  TitleCell,
  type DataTableColumnMeta,
  type DataTableGrouping,
  type DataTableMobile,
} from "@/components/ui/data-table"
import type { ColumnDef } from "@/lib/table"
import { cn } from "@/lib/utils"
import { EmptyCard, INSET, PageHeader, Section, StatStrip, StatusBadge, type StatusTone } from "./primitives"
import { sectionMeta } from "./sections"

/** The id of an agent's virtual Default profile — the server mints the same
    string (`DEFAULT_PROFILE_PREFIX + agentId`), and it is what a card asks for
    when nobody has picked a profile. */
const defaultProfileId = (agentId: string) => `default:${agentId}`

function RefreshAction({ busy, onClick, label }: { busy: boolean; onClick: () => void; label: string }) {
  return (
    <Button variant="ghost" size="icon-sm" className="pointer-coarse:size-11" loading={busy} onClick={onClick} aria-label={label} title={label}>
      <RefreshCwIcon className={cn("size-3.5", busy && "animate-spin")} />
    </Button>
  )
}

/** A body with no rows says why in words, centred where the rows would be.
    Never a zeroed bar: "no plan here" is a different statement from "0% used". */
function EmptyNote({ children }: { children: React.ReactNode }) {
  return <Empty icon={GaugeIcon}>{children}</Empty>
}

/** One row of a usage table: a window, or — for an account that reported none —
    the account alone with the state it gave. `provider` is the group the row is
    filed under (undefined = above every group: windows no account claims). */
interface UsageRow {
  id: string
  window: QuotaWindow | null
  account: QuotaAccount | null
  provider?: string
  /** What a window-less account says in the meter's place. */
  note?: string
}

const OTHER = "Other"

/** The kit's tone for a spend, and the meter fill that goes with it. The app
    has no success/warning tokens, so a fill is a theme token: the two ends are
    primary and destructive, and the middle band is told apart by the badge. */
const toneOf = (used: number): StatusTone => (used >= 90 ? "bad" : used >= 75 ? "warn" : "ok")
const BAR: Record<StatusTone, string> = {
  ok: "bg-primary",
  warn: "bg-foreground/60",
  bad: "bg-destructive",
  info: "bg-primary",
  neutral: "bg-muted-foreground/50",
}

/** Everything a row draws from its window, worked out once. The figure is the
    **spend**, and the tone comes from it, so an exhausted window is a full red
    bar. A window nothing is counted against has a figure but no wall: a full
    track would read as "there is a limit and you are nowhere near it". */
function readWindow(window: QuotaWindow) {
  const used = Math.min(100, Math.max(0, Math.round(window.usedPercent)))
  const pace = windowPace(window)
  return {
    used,
    tone: toneOf(used),
    unlimited: window.unlimited === true,
    amount: formatAmount(window),
    reset: formatResetIn(window) ?? formatReset(window),
    exhausts: pace?.exhaustsInMs != null ? formatDuration(pace.exhaustsInMs) : null,
  }
}

function statusOf(row: UsageRow): { label: string; tone: StatusTone } {
  if (row.account?.disabled) return { label: "Off", tone: "neutral" }
  if (!row.window) return { label: "No reading", tone: "neutral" }
  const { used, tone, unlimited } = readWindow(row.window)
  if (unlimited) return { label: "Unlimited", tone: "neutral" }
  if (used >= 100) return { label: "Exhausted", tone }
  if (used >= 90) return { label: "Critical", tone }
  if (used >= 75) return { label: "Near limit", tone }
  return { label: "OK", tone }
}

/** The state an account without windows gives instead of a meter. */
const accountNote = (account: QuotaAccount) =>
  account.disabled ? "Turned off in the gateway — not being spent" : (account.state ?? "No quota reported")

/** The meter: a bar filled with what is spent, and the figure. */
function Meter({ window, className }: { window: QuotaWindow; className?: string }) {
  const { used, tone, unlimited } = readWindow(window)
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      {unlimited ? (
        <span className="flex-1 text-xs text-muted-foreground">No cap</span>
      ) : (
        <div className="h-1.5 min-w-10 flex-1 overflow-hidden rounded-pill bg-muted">
          <div className={cn("h-full rounded-pill transition-[width]", BAR[tone])} style={{ width: `${used}%` }} />
        </div>
      )}
      <span className={cn("w-9 shrink-0 text-right text-xs font-semibold tabular-nums", unlimited || tone !== "bad" ? "text-muted-foreground" : "text-destructive")}>
        {unlimited ? "∞" : `${used}%`}
      </span>
    </div>
  )
}

/** When the window rolls over — or, when the spend reaches the cap first, that. */
function ResetText({ window }: { window: QuotaWindow }) {
  const { exhausts, reset } = readWindow(window)
  return exhausts ? (
    <span className="text-destructive">cap in {exhausts}</span>
  ) : (
    <span className="text-muted-foreground">{reset ?? "—"}</span>
  )
}

/** The table's columns. With accounts the title is the account and the window
    is a column of its own; without, the window is the title and its amount the
    line under it. Stable per shape: the table memoises rows against them. */
function usageColumns(withAccounts: boolean): ColumnDef<UsageRow, unknown>[] {
  const windowCol: ColumnDef<UsageRow, unknown> = {
    id: "window",
    header: "Window",
    meta: { title: !withAccounts } satisfies DataTableColumnMeta,
    cell: ({ row }) => {
      const { window, account } = row.original
      /* A window-less account is named by the Account column when there is one. */
      if (!window) return withAccounts || !account ? null : <TitleCell title={account.name} subtitle={account.plan} />
      return withAccounts ? (
        <span className="block truncate text-sm">{window.label}</span>
      ) : (
        <TitleCell title={window.label} subtitle={readWindow(window).amount} />
      )
    },
  }
  const accountCol: ColumnDef<UsageRow, unknown> = {
    id: "account",
    header: "Account",
    meta: { title: true } satisfies DataTableColumnMeta,
    cell: ({ row }) => {
      const { account, provider } = row.original
      return (
        <TitleCell
          title={account?.name ?? "All accounts"}
          subtitle={[account?.plan, account?.disabled ? "Off" : null, !account ? null : provider].filter(Boolean).join(" · ") || undefined}
        />
      )
    },
  }
  const rest: ColumnDef<UsageRow, unknown>[] = [
    {
      id: "used",
      header: "Used",
      meta: { className: "w-56 min-w-40" } satisfies DataTableColumnMeta,
      cell: ({ row }) =>
        row.original.window ? (
          <Meter window={row.original.window} />
        ) : (
          <span className="block truncate text-xs text-muted-foreground">{row.original.note}</span>
        ),
    },
    {
      id: "amount",
      header: "Spent",
      meta: { className: "hidden @panel-md:table-cell" } satisfies DataTableColumnMeta,
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground tabular-nums">
          {(row.original.window && readWindow(row.original.window).amount) ?? ""}
        </span>
      ),
    },
    {
      id: "resets",
      header: "Resets",
      meta: { className: "w-32 whitespace-nowrap text-xs" } satisfies DataTableColumnMeta,
      cell: ({ row }) => (row.original.window ? <ResetText window={row.original.window} /> : null),
    },
    {
      id: "status",
      header: "Status",
      meta: { align: "end", className: "w-24" } satisfies DataTableColumnMeta,
      cell: ({ row }) => {
        const status = statusOf(row.original)
        return <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
      },
    },
  ]
  return withAccounts ? [accountCol, windowCol, ...rest] : [windowCol, ...rest]
}

/** The narrow row: the window and who it belongs to, the meter, and the reset. */
function renderUsageRow(row: UsageRow) {
  const { window, account, note } = row
  if (!window) {
    return (
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{account?.name}</div>
        <div className="truncate text-xs text-muted-foreground">{note}</div>
      </div>
    )
  }
  const { amount } = readWindow(window)
  const status = statusOf(row)
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {window.label}
          {account && <span className="font-normal text-muted-foreground"> · {account.name}</span>}
        </span>
        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
      </div>
      <Meter window={window} />
      <div className="flex min-w-0 items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate tabular-nums">{amount ?? ""}</span>
        <span className="shrink-0 tabular-nums">
          <ResetText window={window} />
        </span>
      </div>
    </div>
  )
}

const COLUMNS_FLAT = usageColumns(false)
const COLUMNS_ACCOUNTS = usageColumns(true)

const markOf = (row: UsageRow) => {
  const dot = !row.window
    ? "bg-muted-foreground/30"
    : row.window.unlimited
      ? "bg-muted-foreground/50"
      : BAR[readWindow(row.window).tone]
  return <span aria-hidden className={cn("size-2.5 rounded-full", dot)} />
}

/** A reading's rows. Accounts are filed under their provider — every
    Antigravity login together, every Command Code seat together — in
    first-seen order, which is the gateway's (the order it will spend them in),
    keyed case-folded so `Codex` and `codex` are one group. Each account finds
    its windows by `group`; windows no account claims lead, ungrouped. */
function usageRows(quota: QuotaSnapshot): UsageRow[] {
  const accounts = quota.accounts ?? []
  if (accounts.length === 0) {
    return quota.windows.map((window) => ({ id: window.id, window, account: null }))
  }
  const groupOf = (window: QuotaWindow) => window.group?.trim() || ""
  const rows: UsageRow[] = quota.windows
    .filter((window) => !groupOf(window))
    .map((window) => ({ id: window.id, window, account: null }))
  const byProvider = new Map<string, [string, QuotaAccount[]]>()
  for (const account of accounts) {
    const key = account.provider?.trim() ?? ""
    const held = byProvider.get(key.toLowerCase())
    if (held) held[1].push(account)
    else byProvider.set(key.toLowerCase(), [key, [account]])
  }
  for (const [provider, members] of byProvider.values()) {
    for (const account of members) {
      const windows = quota.windows.filter((window) => groupOf(window) === account.group)
      if (windows.length === 0) {
        rows.push({ id: `account:${account.id}`, window: null, account, provider: provider || OTHER, note: accountNote(account) })
      }
      for (const window of windows) {
        rows.push({ id: `${account.id}:${window.id}`, window, account, provider: provider || OTHER })
      }
    }
  }
  return rows
}

/** The heading of one group of accounts. */
function ProviderHead({ provider, accounts }: { provider: string; accounts: number }) {
  return (
    <div className="flex items-baseline gap-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
      {provider}
      <span className="font-normal tabular-nums normal-case">{accounts === 1 ? "1 account" : `${accounts} accounts`}</span>
    </div>
  )
}

/** A reading's windows as a table. Search appears once there is enough to
    search — a gateway account can carry a dozen model windows. */
function UsageTable({ quota, loading }: { quota: QuotaSnapshot | null; loading?: boolean }) {
  const rows = React.useMemo(() => (quota ? usageRows(quota) : []), [quota])
  const withAccounts = (quota?.accounts?.length ?? 0) > 0
  const f = useTableFilter(rows, {
    matches: (row, needle) =>
      [row.window?.label, row.account?.name, row.account?.plan, row.provider].some((text) => text?.toLowerCase().includes(needle)),
    placeholder: "Search quotas…",
    fields: [{ id: "provider", label: "Provider", of: (row) => row.provider }],
  })
  /* Accounts per provider, for the group heading. */
  const counts = React.useMemo(() => {
    const seen = new Map<string, Set<string>>()
    for (const row of rows) {
      if (!row.provider || !row.account) continue
      const held = seen.get(row.provider) ?? new Set<string>()
      held.add(row.account.id)
      seen.set(row.provider, held)
    }
    return seen
  }, [rows])
  const grouping = React.useMemo<DataTableGrouping<UsageRow> | undefined>(
    () =>
      withAccounts
        ? {
            by: (row) => row.provider,
            renderHeader: (key) => <ProviderHead provider={key} accounts={counts.get(key)?.size ?? 0} />,
            renderMobileHeader: (key) => <ProviderHead provider={key} accounts={counts.get(key)?.size ?? 0} />,
          }
        : undefined,
    [withAccounts, counts]
  )
  return (
    <DataTable
      columns={withAccounts ? COLUMNS_ACCOUNTS : COLUMNS_FLAT}
      data={f.rows}
      getRowId={(row) => row.id}
      isLoading={loading}
      skeletonRows={3}
      pageSize={50}
      mark={markOf}
      grouping={grouping}
      mobile={MOBILE}
      emptyIcon={<GaugeIcon />}
      emptyMessage={f.narrowed ? `Nothing matches “${f.query.trim()}”.` : "No quotas reported."}
      filtering={f.filtering}
    />
  )
}

const MOBILE: DataTableMobile<UsageRow> = { renderRow: renderUsageRow }

/** What answered, folded away. It is here for the case the parser misses a
    line — one adapter reads prose and another reads an undocumented JSON API —
    so it is always offered, never only on failure. */
function RawReport({ raw, label }: { raw: string; label: string }) {
  if (!raw.trim()) return null
  return (
    <Collapsible>
      <CollapsibleTrigger
        render={
          <Button variant="ghost" size="xs" className="text-muted-foreground pointer-coarse:h-11">
            {label}
          </Button>
        }
      />
      <CollapsibleContent>
        {/* `break-words` and not `overflow-x-auto`: a report is prose and long
            paths, and a horizontally scrolling block inside a vertically
            scrolling page is a gesture fight on a phone. */}
        <pre className={cn("mt-2 max-h-64 overflow-y-auto p-3 text-[11px] leading-relaxed break-words whitespace-pre-wrap", INSET)}>
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

/** One reading: a head (mark, name, plan, what it was read through, its
    controls) over the windows. The head is drawn from the moment the page knows
    the reading exists — which provider is slow is something the page shows —
    and only the rows wait. A failure takes the table's place, with its retry;
    a reading with no windows says why in words. Controls live in the head and
    not the table's toolbar, so a refresh survives a reading that has no table. */
function UsageBlock({
  icon,
  name,
  subtitle,
  plan,
  controls,
  quota,
  failure,
  rawLabel,
}: {
  icon: React.ReactNode
  name: React.ReactNode
  subtitle?: React.ReactNode
  plan?: string | null
  controls?: React.ReactNode
  quota: QuotaSnapshot | null
  failure?: React.ReactNode
  rawLabel: string
}) {
  return (
    <section data-kit-block aria-busy={!quota && !failure ? true : undefined} className="@container min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1">
        <div className="flex min-w-0 flex-1 basis-48 items-center gap-3">
          {icon}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="min-w-0 truncate text-sm font-semibold tracking-tight">{name}</h3>
              <PlanBadge plan={plan} />
            </div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</div>
          </div>
        </div>
        {controls && <div className="ml-auto flex shrink-0 items-center gap-1.5">{controls}</div>}
      </div>
      {failure ? (
        failure
      ) : quota && quota.windows.length === 0 ? (
        <EmptyNote>{quotaStatusText(quota)}</EmptyNote>
      ) : (
        <UsageTable quota={quota} loading={!quota} />
      )}
      {quota && <ReadingExtras quota={quota} rawLabel={rawLabel} />}
    </section>
  )
}

const readAt = (quota: QuotaSnapshot) => `Read ${new Date(quota.fetchedAt).toLocaleTimeString()}`
const countOf = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`

/** Before the catalog answers nobody can be named, so the wait is two
    anonymous blocks. */
function UsageSkeleton() {
  return (
    <div className="space-y-8">
      {[0, 1].map((block) => (
        <UsageBlock
          key={block}
          icon={<Skeleton className="size-7 shrink-0 rounded-md" />}
          name={<Skeleton className="h-4 w-32 max-w-full" />}
          subtitle={<Skeleton className="h-3 w-44 max-w-full" />}
          quota={null}
          rawLabel=""
        />
      ))}
    </div>
  )
}

/** The plan a *profile's* provider sells, read from that provider's own account
    API. No agent selector: the account is the profile's, and every runtime it
    serves spends the same windows. A gateway is one block with its accounts as
    rows — one endpoint, so one refresh, one balance, one raw report. */
function ProfileUsage({ profile, initial }: { profile: Profile; initial: QuotaSnapshot | null }) {
  /* Seeded when the list route happened to read this profile too; otherwise
     this query is the only reader. Refresh goes back to the provider either way. */
  const { quota: reading, error, refetch, busy, refresh } = useProfileQuota(profile.id, initial)
  const quota = reading ?? initial
  const kind = profile.usage?.kind && profile.usage.kind !== "none" ? providerKindLabel(profile.usage.kind) : null
  /* A reading that failed is drawn, not sat on: a skeleton is a promise that
     something is still coming. */
  const failure = quota ? null : inlineFromQuery(error, `Couldn't read ${profile.name}'s plan usage`)
  const accounts = quota?.accounts?.length ?? 0

  return (
    <UsageBlock
      icon={<ProfileIcon profile={profile} className="size-7 shrink-0" />}
      name={profile.name}
      subtitle={[kind, accounts > 0 ? countOf(accounts, "account") : null, quota ? readAt(quota) : null].filter(Boolean).join(" · ")}
      plan={quota?.planName}
      controls={
        quota && <RefreshAction busy={busy} onClick={() => refresh()} label={`Refresh ${profile.name}'s plan usage`} />
      }
      quota={quota}
      failure={failure && <ErrorNote error={failure} onRetry={refetch} />}
      rawLabel={accounts > 0 ? "What the gateway reported" : "What the provider reported"}
    />
  )
}

function AgentUsage({
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
  const profileName = profiles.find((p) => p.id === profileId)?.name ?? profileId
  const failure = quota ? null : inlineFromQuery(error, `Couldn't read ${agentName}'s usage`)

  return (
    <UsageBlock
      icon={<AgentIcon agentId={agentId} className="size-7 shrink-0" />}
      name={agentName}
      subtitle={quota ? `${profileName} · ${readAt(quota)}` : undefined}
      plan={quota?.planName}
      controls={
        <>
          {profiles.length > 1 && (
            <Select value={profileId} onValueChange={(id) => setProfileId(id ?? defaultProfileId(agentId))}>
              <SelectTrigger size="sm" className="w-28 text-xs pointer-coarse:h-11" aria-label={`Profile ${agentName} is read through`}>
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
          {quota && <RefreshAction busy={busy} onClick={() => refresh()} label={`Refresh ${agentName}'s usage`} />}
        </>
      }
      quota={quota}
      failure={failure && <ErrorNote error={failure} onRetry={refetch} />}
      rawLabel="What the runtime reported"
    />
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
  const pace = windowPace(tightest.window)
  /* Near the wall = the warn band `toneOf` starts at, by each plan's own
     fullest window — one plan with a dozen model windows counts once. */
  const near = readings.filter((quota) => (peakWindow(quota)?.usedPercent ?? 0) >= 75).length
  const lastRead = Math.max(...readings.map((quota) => new Date(quota.fetchedAt).getTime()))

  return (
    <StatStrip
      stats={[
        {
          label: "Tightest limit",
          value: `${percent}%`,
          hint: `${tightest.who} · ${windowTitle(tightest.window)}${
            pace?.exhaustsInMs != null ? ` · gone in ${formatDuration(pace.exhaustsInMs)}` : ""
          }`,
          tone: percent >= 90 ? "bad" : percent >= 75 ? "warn" : "ok",
        },
        {
          label: "Nearing limit",
          value: `${near} / ${readings.length}`,
          tone: near > 0 ? "warn" : "default",
          hint: near === 1 ? "plan above 75%" : "plans above 75%",
        },
        {
          label: "Next reset",
          value: soonest ? (formatDuration(soonest.resetsAt! - Date.now()) ?? "now") : "—",
          hint: soonest ? `${windowTitle(soonest)} · ${formatReset(soonest)}` : "No reset time reported",
        },
        {
          label: "Last read",
          value: new Date(lastRead).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
          hint: countOf(readings.length, "plan") + " read",
        },
      ]}
    />
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
          <Button variant="outline" className="h-11 @panel-sm:h-9" loading={busy} onClick={() => reload(true)}>
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
           runtime logins. */
        <div>
          {providerProfiles.length + probeAgents.length === 0 && <UsageSkeleton />}
          {providerProfiles.length > 0 && (
            <Section label="Providers" hint="Plans read from a profile's own provider account.">
              <div className="space-y-8">
                {providerProfiles.map((profile) => (
                  <ProfileUsage
                    key={`profile:${profile.id}`}
                    profile={profile}
                    initial={readingFor((quota) => quota.source === "profile" && quota.profileId === profile.id)}
                  />
                ))}
              </div>
            </Section>
          )}
          {probeAgents.length > 0 && (
            <Section label="Runtime logins" hint="What each agent's own subscription has left on this machine.">
              <div className="space-y-8">
                {probeAgents.map((agent) => (
                  <AgentUsage
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
            </Section>
          )}
        </div>
      )}
    </>
  )
}
