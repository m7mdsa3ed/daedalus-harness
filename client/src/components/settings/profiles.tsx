import * as React from "react"
import { Copy, Cpu, ExternalLink, Eye, EyeOff, KeyRound, Pencil, Plus, Power, PowerOff, RefreshCw, Trash2 } from "lucide-react"
import { Navigate, useNavigate, useParams } from "react-router"
import { dropAgentOptions } from "@/lib/agent-options"
import { reportError } from "@/lib/errors"
import { VoiceBackendField } from "./voice"
import { useAsyncAction } from "@/hooks/use-async-action"
import { Button } from "@/components/ui/button"
import { useConfirm } from "@/components/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Checkbox } from "@/components/ui/checkbox"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { AgentIcon, ProfileIcon } from "@/components/entity-icon"
import { DataTable, TitleCell, type TableAction } from "@/components/ui/data-table"
import type { ColumnDef } from "@/lib/table"
import {
  api,
  ApiError,
  profileAgentIds,
  type ModelKind,
  type Profile,
  type ProfileAgentLink,
  type ProfilePreset,
  type ProfileUsageKind,
  loadServers,
  type ServerSettings,
} from "@/lib/settings"
import {
  useAgents,
  useInvalidateProfileCatalog,
  useProfilePresets,
  useProfiles,
  useSetProfileFlags,
} from "@/lib/queries/catalog"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import {
  Field,
  FormActions,
  FormPageHeader,
  FormSection,
  FormShell,
  LogoUpload,
  PageForm,
  PageHeader,
  StatStrip,
  StatusBadge,
  pairs,
} from "./primitives"
import {
  ModelsSection,
  blankModelRow,
  candidateToRow,
  rowsToModels,
  toModelRows,
  type ModelRow,
} from "./profile-models"
import { sectionMeta } from "./sections"
import { useTableFilter } from "@/lib/use-table-filter"
import { useSettingsPage } from "./layout"
import { settingsFormPath, settingsPath } from "@/lib/router"

/* The providers whose plan usage the server can read, and what to call them.
   One entry per adapter in `server/src/usage-api.ts` — the labels are the only
   part of this that is the client's, which is why there is no route to list
   them: a `kind` this build does not know is a build that also could not draw
   its fields. */
const USAGE_PROVIDERS: { kind: ProfileUsageKind; label: string; hint: string; hostPlaceholder: string }[] = [
  {
    kind: "none",
    label: "None",
    hint: "This provider meters per token, or has no usage API. The agent's own /usage — your claude/codex login — answers instead.",
    hostPlaceholder: "",
  },
  {
    kind: "zai",
    label: "Z.AI / Zhipu — GLM Coding Plan",
    hint: "Reads the plan's rolling 5-hour and weekly token windows, and the monthly MCP tool allowance, from the provider's own monitor API. The platform (api.z.ai or open.bigmodel.cn) is picked from the base URL above unless you name a host.",
    hostPlaceholder: "https://api.z.ai",
  },
  {
    kind: "minimax",
    label: "MiniMax — Coding Plan",
    hint: "Reads each model's rolling 5-hour and weekly request counters from the plan's own remains route, and shows the fullest. The platform (minimax.io or minimaxi.com) is picked from the base URL above unless you name a host.",
    hostPlaceholder: "https://api.minimax.io",
  },
  {
    kind: "kimi",
    label: "Moonshot — Kimi For Coding",
    hint: "Reads the plan's weekly request allowance and its shorter rolling windows from the coding API's usages route, on the same key.",
    hostPlaceholder: "https://api.kimi.com",
  },
  {
    kind: "synthetic",
    label: "Synthetic",
    hint: "Reads the plan's rolling 5-hour request quota and the hourly search allowance from the quotas route, on the same key.",
    hostPlaceholder: "https://api.synthetic.new",
  },
  {
    kind: "deepseek",
    label: "DeepSeek — account balance",
    hint: "Pay-as-you-go: no windows, only the account balance from the documented balance route.",
    hostPlaceholder: "https://api.deepseek.com",
  },
  {
    kind: "openrouter",
    label: "OpenRouter — key limit and credits",
    hint: "Reads the key's own spend limit (when one is set) as a window, and the account's credit balance underneath. Both are documented routes.",
    hostPlaceholder: "https://openrouter.ai/api/v1",
  },
  {
    kind: "command-code",
    label: "Command Code — plan credits",
    hint: "Reads the plan's rolling 5-hour and weekly credit windows, the monthly plan pot, and the credits left in the cycle, from the same account routes the CLI's /usage panel calls — it has no non-interactive form. The plan's name and its monthly allowance come from the CLI's own table, so a brand-new plan may read as unknown. The staging platform is picked from the base URL above unless you name a host.",
    hostPlaceholder: "https://api.commandcode.ai",
  },
  {
    kind: "9router",
    label: "9Router — every linked account",
    hint: "A self-hosted 9Router gateway is many accounts behind one endpoint that falls back between them, so each is drawn as its own plan, in the order the gateway will spend them — never pooled, because a five-hour window is a different five hours per account. Every account it can report on is listed, including the ones that are turned off or no longer answer, each saying its own state. The gateway is taken from the base URL above unless you name a host. Its sk- key does not open the dashboard API: if the dashboard asks for a login, put its password in the token field below.",
    hostPlaceholder: "http://localhost:20128",
  },
]

/* ── the list's cells ──
   Module-level, so a cell's identity is stable across renders: the table draws
   a cell as a component, and a function rebuilt per render would remount its
   Switch on every flip. */

const hostOf = (url: string) => URL.parse(url)?.host ?? url

/* The switches act at once, so a click on one must not also be the row's own
   click (which opens the editor). */

function KeyStatus({ profile }: { profile: Profile }) {
  return <StatusBadge tone={profile.hasApiKey ? "ok" : "warn"}>{profile.hasApiKey ? "Key set" : "No key"}</StatusBadge>
}

function AgentBadges({ profile, nameOf }: { profile: Profile; nameOf: (id: string) => string | undefined }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {profileAgentIds(profile).map((id) => (
        <Badge key={id} variant="outline" className="max-w-full font-normal">
          <AgentIcon agentId={id} className="size-3 shrink-0" />
          <span className="truncate">{nameOf(id) ?? id}</span>
        </Badge>
      ))}
    </span>
  )
}

/** Disabled outranks hidden, as the sort does, and the word beside the name is
    the whole state reading now that the two switches are menu items. */
function StateBadge({ profile }: { profile: Profile }) {
  if (!profile.disabled && !profile.hidden) return null
  return (
    <StatusBadge tone={profile.disabled ? "bad" : "neutral"} dot={false}>
      {profile.disabled ? "Disabled" : "Hidden"}
    </StatusBadge>
  )
}

const hasPlanUsage = (profile: Profile) => !!profile.usage && profile.usage.kind !== "none"

const profileMark = (p: Profile) => <ProfileIcon profile={p} className="size-5" />
const profileRowId = (p: Profile) => p.id

/** The kinds a catalogue can hold, in the order they are drawn: a thread's own
    model first, then the two lanes that answer something else. */
const KINDS: ModelKind[] = ["chat", "decision", "completion"]
const KIND_LABEL: Record<ModelKind, string> = { chat: "Chat", decision: "Decision", completion: "Completion" }

/** What this provider can be asked for, and how much of it — the one fact a
    catalogue's length hides. `kind` is absent on every model saved before kinds
    existed, and absent means chat. */
const kindsOf = (profile: Profile): { kind: ModelKind; count: number }[] => {
  const counts = new Map<ModelKind, number>()
  for (const model of profile.models) {
    const kind = model.kind ?? "chat"
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return KINDS.filter((kind) => counts.has(kind)).map((kind) => ({ kind, count: counts.get(kind) ?? 0 }))
}

/** One kind a profile holds, with how many of it. */
function KindChip({ kind, count }: { kind: ModelKind; count: number }) {
  return (
    <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[11px] font-normal text-muted-foreground">
      <span className="tabular-nums text-foreground">{count}</span>
      {KIND_LABEL[kind].toLowerCase()}
    </Badge>
  )
}

export function ProfilesPage() {
  const { settings, actions } = useSettingsPage()
  const invalidate = useInvalidateProfileCatalog()
  const meta = sectionMeta("profiles")
  const profiles = useProfiles()
  const agents = useAgents()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const setFlags = useSetProfileFlags()

  /* The switches act at once, as the routines list's does: hiding, showing,
     disabling and enabling are all reversible, so there is nothing to ask
     about first. */
  const toggle = (profile: Profile, flags: { hidden?: boolean; disabled?: boolean }, message: string) =>
    setFlags.mutate(
      { id: profile.id, ...flags },
      {
        onSuccess: () => toast.success(message),
        onError: (err) => reportError(err, "Couldn't update the profile"),
      }
    )

  const remove = async (profile: Profile) => {
    if (
      !(await confirm({
        title: `Delete profile "${profile.name}"?`,
        description:
          "Its credentials, model catalog and linked tools are removed from this server. Threads on it keep their transcripts, but have to be moved to another profile before they can run again.",
        destructive: true,
        confirmLabel: "Delete",
      }))
    )
      return
    try {
      await api(settings, `/api/profiles/${profile.id}`, { method: "DELETE" })
      await invalidate()
    } catch (err) {
      /* Threads still on the profile: the server names them, the user confirms
         the reset, and the retry moves them all to their agent's Default —
         profile, model and effort — keeping every transcript. */
      if (err instanceof ApiError && err.status === 409) {
        const threads = (err.body as { threads?: { id: string; title: string; agentId: string }[] } | null)?.threads
        if (threads?.length) {
          const names = threads.slice(0, 5).map((t) => `“${t.title}”`).join(", ")
          const more = threads.length > 5 ? ` and ${threads.length - 5} more` : ""
          if (
            await confirm({
              title: `Reset ${threads.length} thread${threads.length === 1 ? "" : "s"} to Default?`,
              description: `${names}${more} still run${threads.length === 1 ? "s" : ""} on "${profile.name}". Deleting moves each to its agent's Default profile with the default model — transcripts are kept, and the next message revives them there.`,
              destructive: true,
              confirmLabel: `Reset and delete`,
            })
          ) {
            try {
              const reply = await api<{ moved?: string[] }>(settings, `/api/profiles/${profile.id}?force=1`, {
                method: "DELETE",
              })
              await invalidate()
              /* The sidebar rows still name the deleted profile until re-read. */
              await actions.refreshSessions().catch(() => {})
              const moved = reply.moved?.length ?? threads.length
              toast.success(`Deleted “${profile.name}” — ${moved} thread${moved === 1 ? "" : "s"} reset to Default`)
              return
            } catch (forceErr) {
              reportError(forceErr, "Couldn't delete the profile")
              return
            }
          }
          return
        }
      }
      reportError(err, "Couldn't delete the profile")
    }
  }

  /* Duplicating is server-side (`POST …/duplicate`) because the credentials
     are: the client holds `hasApiKey` and never the key, so a copy assembled
     here would come back keyless. The copy lands hidden and opens in the
     editor — a duplicate exists to be changed, and two identical names in the
     composer's picker is the one outcome nobody wants. */
  const duplicate = async (profile: Profile) => {
    try {
      const copy = await api<Profile>(settings, `/api/profiles/${profile.id}/duplicate`, { method: "POST" })
      await invalidate()
      toast.success(`Copied “${profile.name}” — hidden until you show it`)
      void navigate(settingsFormPath("profiles", copy.id))
    } catch (err) {
      reportError(err, "Couldn't duplicate the profile")
    }
  }

  const newButton = (
    <Button className="h-11 @panel-sm:h-9" onClick={() => void navigate(settingsFormPath("profiles"))}>
      <Plus className="size-4" /> New profile
    </Button>
  )

  /* One list, not one group per agent: a profile is a provider and may serve
     several agents, so grouping by agent would list it more than once. The
     agents it serves are named on the row instead. The virtual Defaults are
     left out: they are the agents as they ship, synthesized per agent and
     neither editable nor deletable, so here they would be one identical
     "Default" row per agent with nothing to do on it. They still show up
     wherever a thread picks a profile, which is the only place they matter. */
  const stored = React.useMemo(() => profiles.filter((p) => !p.virtual), [profiles])
  const agentName = React.useCallback((id: string) => agents.find((a) => a.id === id)?.name, [agents])

  /* Search and ordering are the list's own, not the server's: the whole
     catalog is already here (one `/api/profiles` read), so filtering it is a
     string match, and what a reader wants first is the profiles still in play
     — disabled last, hidden after shown, each group by name. */
  /* Hidden profiles are folded away by default and the switch says how many, so
     the only way back to one is never a thing you have to already know about.
     A search reaches them regardless: a needle that matches nothing *visible*
     would otherwise answer "nothing matches" about a profile that is right
     there. Disabled rows are not folded — disabled is a state to see. */
  const [showHidden, setShowHidden] = React.useState(false)
  const [syncing, setSyncing] = React.useState<string | null>(null)
  const [syncProfileRow, setSyncProfileRow] = React.useState<Profile | null>(null)
  const [syncDestination, setSyncDestination] = React.useState("")
  const [includeSecrets, setIncludeSecrets] = React.useState(false)
  const servers = loadServers().filter((server) => server.id !== settings.id)

  const syncProfileTo = async () => {
    if (!syncProfileRow || !syncDestination) return
    const destination = servers.find((server) => server.id === syncDestination)
    if (!destination) return
    const profile = syncProfileRow
    const secrets = includeSecrets
    let missingAgents: string[] = []
    try {
      const destinationAgents = await api<{ id: string }[]>(destination, "/api/agents")
      missingAgents = profileAgentIds(profile).filter((id) => !destinationAgents.some((agent) => agent.id === id))
    } catch (err) {
      reportError(err, "Couldn't check destination agents")
      return
    }
    const agentWarning = missingAgents.length > 0
      ? ` The destination does not have these source agents: ${missingAgents.join(", ")}. The copied profile may not be usable for them.`
      : ""
    const ok = await confirm({
      title: `Sync ${profile.name} to ${destination.name}?`,
      description: `${secrets
        ? "This replaces the matching destination profile and includes both the profile API key and usage API key."
        : "This replaces the matching destination profile. Credentials are excluded; any stored destination credentials are kept."} Sync is a one-way push; future changes are not automatic.${agentWarning}`,
      confirmLabel: "Sync profile",
    })
    if (!ok) return

    setSyncing(profile.id)
    try {
      const exported = await api<Record<string, unknown>>(
        settings,
        `/api/profiles/${encodeURIComponent(profile.id)}/sync-export${secrets ? "?secrets=1" : ""}`
      )
      const destinationId = `sync:${profile.id}`
      await api(destination, `/api/profiles/${encodeURIComponent(destinationId)}/sync`, {
        method: "PUT",
        body: JSON.stringify({ profile: exported, includeSecrets: secrets }),
      })
      toast.success(`Synced ${profile.name} to ${destination.name}`)
      setSyncProfileRow(null)
    } catch (err) {
      reportError(err, "Couldn't sync the profile")
    } finally {
      setSyncing(null)
    }
  }

  const startSync = (profile: Profile) => {
    if (servers.length === 0) {
      toast.error("Add another server connection before syncing profiles")
      return
    }
    setSyncProfileRow(profile)
    setSyncDestination(servers[0]?.id ?? "")
    setIncludeSecrets(false)
  }

  const hiddenCount = stored.filter((p) => p.hidden).length
  const ranked = React.useMemo(() => {
    const rank = (p: Profile) => (p.disabled ? 2 : p.hidden ? 1 : 0)
    return [...stored].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  }, [stored])
  const f = useTableFilter(ranked, {
    text: (p) =>
      `${p.name} ${p.baseUrl} ${p.defaultModel} ${profileAgentIds(p).map((id) => agentName(id) ?? id).join(" ")} ${p.models.map((m) => `${m.id} ${m.label}`).join(" ")}`,
    placeholder: "Search profiles, agents, models…",
    fields: [
      { id: "state", label: "State", of: (p) => (p.disabled ? "Disabled" : p.hidden ? "Hidden" : "Active") },
      { id: "key", label: "Key", of: (p) => (p.hasApiKey ? "Has key" : "Needs key") },
      /* A profile answers several kinds at once and matches when any picked one
         is among them; the hook draws the field only when more than one kind
         exists in the list at all. */
      { id: "kinds", label: "Model type", of: (p) => kindsOf(p).map(({ kind }) => KIND_LABEL[kind]) },
    ],
  })
  /* A search or a pick reaches hidden profiles too (see showHidden). */
  const shown = React.useMemo(
    () => (showHidden || f.narrowed ? f.rows : f.rows.filter((p) => !p.hidden)),
    [f.rows, f.narrowed, showHidden],
  )

  const totalModels = stored.reduce((n, p) => n + p.models.length, 0)
  const needKey = stored.filter((p) => !p.hasApiKey && !p.disabled).length
  const live = stored.filter((p) => !p.hidden && !p.disabled).length

  /* Columns and actions are memoised (the table memoises its rows against
     them), so the handlers they call are read through a ref that is refreshed
     every render: the closures above change identity, the table never sees it. */
  const verbs = React.useRef<{
    edit: (p: Profile) => void
    duplicate: (p: Profile) => void
    sync: (p: Profile) => void
    remove: (p: Profile) => void
    toggle: typeof toggle
  }>(null!)
  verbs.current = {
    edit: (p) => void navigate(settingsFormPath("profiles", p.id)),
    duplicate: (p) => void duplicate(p),
    sync: startSync,
    remove: (p) => void remove(p),
    toggle,
  }

  const editRow = React.useCallback((p: Profile) => verbs.current.edit(p), [])

  const columns = React.useMemo<ColumnDef<Profile, unknown>[]>(
    () => [
      {
        id: "profile",
        header: "Profile",
        accessorFn: (p) => p.name,
        cell: ({ row }) => {
          const p = row.original
          return (
            <TitleCell
              title={
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className={cn("truncate", (p.hidden || p.disabled) && "text-muted-foreground")}>{p.name}</span>
                  <StateBadge profile={p} />
                </span>
              }
              /* The host, not the whole URL: which gateway this profile points
                 at is the question. A URL that won't parse is said as typed. */
              subtitle={p.baseUrl ? <span title={p.baseUrl}>{hostOf(p.baseUrl)}</span> : undefined}
            />
          )
        },
        meta: { title: true, className: "min-w-52" },
      },
      {
        id: "agents",
        header: "Agents",
        cell: ({ row }) => <AgentBadges profile={row.original} nameOf={agentName} />,
        meta: { className: "hidden @panel-md:table-cell" },
      },
      {
        id: "models",
        header: "Models",
        accessorFn: (p) => p.models.length,
        cell: ({ row }) => {
          const p = row.original
          const kinds = kindsOf(p)
          return (
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-1">
                {kinds.length === 0 ? (
                  <span className="text-xs text-muted-foreground">No models</span>
                ) : (
                  kinds.map(({ kind, count }) => <KindChip key={kind} kind={kind} count={count} />)
                )}
                {hasPlanUsage(p) && (
                  <Badge variant="ghost" className="h-5 px-1.5 text-[11px] font-normal text-muted-foreground">
                    plan usage
                  </Badge>
                )}
              </div>
              {p.defaultModel && (
                <div className="truncate font-mono text-[11px] text-muted-foreground" title={p.defaultModel}>
                  {p.defaultModel}
                </div>
              )}
            </div>
          )
        },
        meta: { className: "hidden @panel-sm:table-cell min-w-40" },
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (p) => Number(p.hasApiKey),
        cell: ({ row }) => <KeyStatus profile={row.original} />,
        meta: { align: "end", className: "w-28" },
      },
    ],
    [agentName]
  )

  /* Edit and Duplicate stay on the row; everything else folds into its menu (the
     table keeps the first two calm actions inline, destructive last). On a phone
     the same six are swipe rails and the row's "more" menu — which is why the
     two flags are actions here rather than a column of switches: a phone never
     had room for them, and a desktop no longer needs two columns saying what
     `StateBadge` already says beside the name. */
  const rowActions = React.useMemo<TableAction<Profile>[]>(
    () => [
      { id: "edit", label: "Edit", icon: <Pencil />, position: "left", onClick: (p) => verbs.current.edit(p) },
      { id: "duplicate", label: "Duplicate", icon: <Copy />, position: "left", onClick: (p) => verbs.current.duplicate(p) },
      /* Show/Hide and Enable/Disable are row state, not a second column: they
         read as the action they perform on the row they are opened on, and the
         state itself is already said beside the name (`StateBadge`). */
      {
        id: "visibility",
        label: (p) => (p.hidden ? "Show" : "Hide"),
        icon: (p) => (p.hidden ? <Eye /> : <EyeOff />),
        onClick: (p) => verbs.current.toggle(p, { hidden: !p.hidden }, p.hidden ? "Profile shown" : "Profile hidden"),
      },
      {
        id: "enabled",
        label: (p) => (p.disabled ? "Enable" : "Disable"),
        icon: (p) => (p.disabled ? <Power /> : <PowerOff />),
        onClick: (p) => verbs.current.toggle(p, { disabled: !p.disabled }, p.disabled ? "Profile enabled" : "Profile disabled"),
      },
      { id: "sync", label: "Sync to server", icon: <RefreshCw />, onClick: (p) => verbs.current.sync(p) },
      { id: "delete", label: "Delete", icon: <Trash2 />, tone: "danger", onClick: (p) => verbs.current.remove(p) },
    ],
    []
  )

  const mobile = React.useMemo(
    () => ({
      renderRow: (p: Profile) => {
        const kinds = kindsOf(p)
        return (
          <div className="flex min-w-0 items-start gap-3">
            <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
              <ProfileIcon profile={p} className="size-5" />
            </div>
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className={cn("truncate text-sm font-medium", (p.hidden || p.disabled) && "text-muted-foreground")}>
                    {p.name}
                  </span>
                  <StateBadge profile={p} />
                </span>
                <span className="shrink-0">
                  <KeyStatus profile={p} />
                </span>
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {p.baseUrl ? hostOf(p.baseUrl) : "No endpoint"}
              </div>
              {/* The kinds on their own line, as chips: a card has the width for
                  them, and "what can this provider answer" is the question the
                  row exists to answer. */}
              <div className="flex flex-wrap items-center gap-1">
                {kinds.length === 0 ? (
                  <span className="text-xs text-muted-foreground">No models</span>
                ) : (
                  kinds.map(({ kind, count }) => <KindChip key={kind} kind={kind} count={count} />)
                )}
                {hasPlanUsage(p) && (
                  <Badge variant="ghost" className="h-5 px-1.5 text-[11px] font-normal text-muted-foreground">
                    plan usage
                  </Badge>
                )}
              </div>
              <AgentBadges profile={p} nameOf={agentName} />
            </div>
          </div>
        )
      },
    }),
    [agentName]
  )

  return (
    <>
      <PageHeader meta={meta} action={newButton} />
      {stored.length > 0 && (
        <StatStrip
          stats={[
            { label: "Profiles", value: stored.length },
            { label: "Offered", value: live },
            { label: "Models", value: totalModels },
            { label: "Need a key", value: needKey, tone: needKey > 0 ? "warn" : "default" },
          ]}
        />
      )}
      <DataTable
        columns={columns}
        data={shown}
        getRowId={profileRowId}
        actions={rowActions}
        mobile={mobile}
        mark={profileMark}
        pageSize={25}
        onRowClick={editRow}
        filtering={stored.length > 0 ? f.filtering : undefined}
        toolbar={
          hiddenCount > 0 ? (
            <label className="flex min-h-11 shrink-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground @panel-sm:min-h-0">
              <Switch checked={showHidden} onCheckedChange={setShowHidden} />
              Show {hiddenCount} hidden
            </label>
          ) : undefined
        }
        emptyIcon={<KeyRound />}
        emptyMessage={
          stored.length === 0
            ? "No profiles yet. Every agent already runs on its own defaults — add a profile to point one at your own gateway, key or model catalog."
            : f.narrowed
              ? "No profile matches."
              : `Every profile is hidden. Turn on “Show ${hiddenCount} hidden” to see ${hiddenCount === 1 ? "it" : "them"}.`
        }
        emptyAction={stored.length === 0 ? newButton : undefined}
      />
      <ResponsiveDialog open={syncProfileRow !== null} onOpenChange={(open) => !open && setSyncProfileRow(null)}>
        <ResponsiveDialogContent className="sm:max-w-md">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Sync profile to another server</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              Push this profile to one connected server. It creates or updates a dedicated copy there; future changes need another manual sync.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <Field label="Destination server">
            <Select value={syncDestination} onValueChange={(value) => value && setSyncDestination(value)}>
              <SelectTrigger className="w-full">
                <SelectValue>{servers.find((server) => server.id === syncDestination)?.name ?? "Choose a server"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {servers.map((server) => (
                  <SelectItem key={server.id} value={server.id}>{server.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
            <Checkbox checked={includeSecrets} onCheckedChange={(checked) => setIncludeSecrets(checked === true)} />
            <span>
              Include API keys
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Transfers the profile key and separate usage key. Off by default; existing destination keys are preserved.
              </span>
            </span>
          </label>
          <ResponsiveDialogFooter>
            <Button variant="outline" onClick={() => setSyncProfileRow(null)} disabled={syncing !== null}>
              Cancel
            </Button>
            <Button onClick={() => void syncProfileTo()} disabled={!syncDestination || syncing !== null}>
              {syncing ? "Syncing…" : "Sync profile"}
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  )
}

export function ProfileFormPage() {
  const { entryId } = useParams()
  const navigate = useNavigate()
  const { settings } = useSettingsPage()
  const invalidateProfile = useInvalidateProfileCatalog()
  const profiles = useProfiles()
  const agents = useAgents()
  const profile = entryId === "new" ? null : profiles.find((item) => item.id === entryId)
  if (entryId !== "new" && !profile) return <Navigate to={settingsPath("profiles")} replace />
  return (
    <ProfileForm
      profile={profile ?? null}
      agents={agents}
      settings={settings}
      onDone={async (saved) => {
        /* The saved profile's credentials, endpoint and catalog are what decide
           what its agents advertise, so what this device remembered describes a
           profile that no longer exists. The server evicts its own probe cache
           on the same PUT; this is the device-local half, and it is also what
           lets the pair be asked again before the page is reloaded. */
        if (saved && profile) dropAgentOptions(profile.id)
        if (saved) await invalidateProfile()
        void navigate(settingsPath("profiles"))
      }}
    />
  )
}

/* ── model rows live in ./profile-models.tsx ──
   The form owns the state (rows, defaultModel) and the bookkeeping that keeps
   the default honest; that module owns the row shapes, conversions and UI. */

/** The form's body without the jump rail — a dialog's. Module-level so its
    identity is stable across renders and the inputs inside keep focus. */
function PlainShell({ children }: { sections: { id: string; label: string }[]; children: React.ReactNode }) {
  return <div>{children}</div>
}

/* ── the agents matrix ──
   One row per agent: a switch for whether the profile serves it, and — only
   once it does — that agent's own base URL. The cells are module-level and read
   the form through a context, because the inputs live inside table cells and a
   cell rebuilt per render would remount the input on every keystroke. */

interface AgentRowData {
  id: string
  name: string
  unregistered?: boolean
}

const AgentLinksContext = React.createContext<{
  links: Record<string, { baseUrl: string }>
  placeholder: string
  toggle: (id: string, on: boolean) => void
  setBaseUrl: (id: string, baseUrl: string) => void
} | null>(null)

function useAgentLinks() {
  const ctx = React.useContext(AgentLinksContext)
  if (!ctx) throw new Error("AgentLinksContext is missing")
  return ctx
}

function AgentToggle({ agent }: { agent: AgentRowData }) {
  const { links, toggle } = useAgentLinks()
  return (
    <label className="flex min-h-9 min-w-0 cursor-pointer items-center gap-2 text-sm pointer-coarse:min-h-11">
      <Switch className="shrink-0" checked={!!links[agent.id]} onCheckedChange={(on) => toggle(agent.id, on)} />
      <AgentIcon agentId={agent.id} className="size-4 shrink-0" />
      <span className={cn("min-w-0 truncate", agent.unregistered && "font-mono text-muted-foreground")}>{agent.name}</span>
    </label>
  )
}

function AgentOverride({ agent }: { agent: AgentRowData }) {
  const { links, placeholder, setBaseUrl } = useAgentLinks()
  const link = links[agent.id]
  if (!link) return <span className="text-xs text-muted-foreground">Not served</span>
  return (
    <Input
      value={link.baseUrl}
      onChange={(e) => setBaseUrl(agent.id, e.target.value)}
      placeholder={placeholder}
      aria-label={`${agent.name} base URL override`}
      className="w-full min-w-0 font-mono text-xs"
    />
  )
}

const AGENT_COLUMNS: ColumnDef<AgentRowData, unknown>[] = [
  {
    id: "agent",
    header: "Agent",
    cell: ({ row }) => <AgentToggle agent={row.original} />,
    meta: { title: true, className: "w-64" },
  },
  {
    id: "override",
    header: "Base URL override",
    cell: ({ row }) => <AgentOverride agent={row.original} />,
  },
]

const AGENT_MOBILE = {
  renderRow: (agent: AgentRowData) => (
    /* The row swallows the context menu (long-press selects); the input inside
       must keep its own, or paste is out of reach on a phone. */
    <div className="min-w-0 space-y-2 py-1" onContextMenu={(e) => e.stopPropagation()}>
      <AgentToggle agent={agent} />
      <AgentOverride agent={agent} />
    </div>
  ),
}

export function ProfileForm({
  profile,
  agents,
  settings,
  onDone,
  dialog = false,
}: {
  profile: Profile | null
  agents: { id: string; name: string }[]
  settings: ServerSettings
  /** The saved row, so a caller that opened this to *pick* a profile can
      select what it just made; null when the form was cancelled. */
  onDone: (saved: Profile | null) => void
  /** Drawn inside a dialog rather than as a settings route — the page header
      is the dialog's own. */
  dialog?: boolean
}) {
  // The library the pickers below draw from.
  const [form, setForm] = React.useState(() => ({
    name: profile?.name ?? "",
    baseUrl: profile?.baseUrl ?? "",
    apiKey: "",
    defaultModel: profile?.defaultModel ?? "",
    logoUrl: profile?.logoUrl ?? "",

    /* The usage reader, flattened into the form the way `apiKey` is: the token
       is write-only (the server sends back a boolean), so an empty field means
       "keep the stored one" here too. */
    usageKind: (profile?.usage?.kind ?? "none") as ProfileUsageKind,
    usageBaseUrl: profile?.usage?.baseUrl ?? "",
    usageApiKey: "",
    /* Codex's fallback-metadata notice is per profile: the profile is what
       carries the custom models the notice would be nagging about. Absent on
       older servers (and the virtual Default), which is the same as off. */
    suppressModelMetadataWarning: profile?.suppressModelMetadataWarning ?? false,
    /* A string while it is typed; blank = the server's default. */
    upstreamTimeoutSeconds: profile?.upstreamTimeoutSeconds ? String(profile.upstreamTimeoutSeconds) : "",
    /* One "Name: value" a line, like the MCP library's headers box — parsed
       into pairs by `pairs(...)` on save, never stored as the text. */
    headers: (profile?.headers ?? []).map((h) => `${h.name}: ${h.value}`).join("\n"),
    hidden: profile?.hidden ?? false,
    disabled: profile?.disabled ?? false,
  }))
  const setFlags = useSetProfileFlags()
  const [voiceProvider, setVoiceProvider] = React.useState(profile?.voiceProvider ?? "")
  /* Which agents this profile serves, and each one's optional base-URL
     override. A new profile starts on the first registered agent, so the form
     never saves a profile no thread could start on. */
  const [links, setLinks] = React.useState<Record<string, { baseUrl: string }>>(() => {
    const initial = Object.entries(profile?.agents ?? {}).map(
      ([id, link]) => [id, { baseUrl: link?.baseUrl ?? "" }] as const
    )
    if (initial.length === 0 && agents[0]) return { [agents[0].id]: { baseUrl: "" } }
    return Object.fromEntries(initial)
  })
  const toggleAgent = (id: string, on: boolean) =>
    setLinks((current) => {
      if (on) return current[id] ? current : { ...current, [id]: { baseUrl: "" } }
      const { [id]: _dropped, ...rest } = current
      return rest
    })
  const setAgentBaseUrl = (id: string, baseUrl: string) =>
    setLinks((current) => ({ ...current, [id]: { ...current[id], baseUrl } }))
  /* Agents this profile names that the server no longer registers: kept on the
     form (and saved back) so editing an unrelated field cannot silently drop
     them, and shown by id so the user can see what is dangling. */
  const agentRows = [
    ...agents,
    ...Object.keys(links)
      .filter((id) => !agents.some((a) => a.id === id))
      .map((id) => ({ id, name: id, unregistered: true })),
  ]
  const agentFilter = useTableFilter(agentRows, {
    text: (a) => `${a.name} ${a.id}`,
    placeholder: "Search agents…",
    fields: [
      { id: "linked", label: "Linked", of: (a) => (links[a.id] ? "Linked" : "Not linked") },
      { id: "registered", label: "Registered", of: (a) => ("unregistered" in a && a.unregistered ? "Missing" : "Registered") },
    ],
  })
  const [rows, setRows] = React.useState<ModelRow[]>(() => toModelRows(profile?.models ?? []))
  /* The coding plan this new profile started from, if any. Only the form
     remembers it — the saved profile carries no preset id (see
     server/src/profile-presets.ts) — and only for the link to where the key
     comes from. Editing an existing profile offers no presets: filling over a
     stored key and catalog is not "start from". */
  const [preset, setPreset] = React.useState<ProfilePreset | null>(null)
  const { busy, error: saveError, run } = useAsyncAction()
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))
  const patchRow = (uid: string, patch: Partial<ModelRow>) =>
    setRows((r) => r.map((row) => (row.uid === uid ? { ...row, ...patch } : row)))

  /** Renaming the default row's id keeps it the default. */
  const handlePatch = (uid: string, patch: Partial<ModelRow>) => {
    const row = rows.find((r) => r.uid === uid)
    if (patch.id !== undefined && row && row.id.trim() === form.defaultModel) {
      set({ defaultModel: patch.id.trim() })
    }
    patchRow(uid, patch)
  }
  const handleSetDefault = (uid: string) => {
    const row = rows.find((r) => r.uid === uid)
    if (row) set({ defaultModel: row.id.trim() === form.defaultModel ? "" : row.id.trim() })
  }
  const handleRemove = (uid: string) => {
    const row = rows.find((r) => r.uid === uid)
    if (row?.id.trim() === form.defaultModel) set({ defaultModel: "" })
    setRows((r) => r.filter((x) => x.uid !== uid))
  }
  /** Copy a plan into the form: every field the preset names, replacing what
      was there (the form is new, so "there" is empty or a previous preset).
      The key is the one thing a preset cannot supply, and the one thing left
      alone. Agents the server does not register were already dropped by the
      route, so the links are exactly what the plan serves here. */
  const applyPreset = (next: ProfilePreset | null) => {
    setPreset(next)
    if (!next) return
    const models = next.models.map(candidateToRow)
    set({
      name: next.name,
      baseUrl: next.baseUrl,
      logoUrl: next.logoUrl,
      usageKind: next.usage,
      usageBaseUrl: "",
      defaultModel: models.some((m) => m.id === next.defaultModel) ? next.defaultModel : (models[0]?.id ?? ""),
    })
    setLinks(Object.fromEntries(Object.entries(next.agents).map(([id, link]) => [id, { baseUrl: link.baseUrl ?? "" }])))
    setRows(models)
  }
  /** Imports never clobber: a row whose id is already listed is skipped. */
  const importModels = (imported: ModelRow[]) =>
    setRows((r) => {
      const have = new Set(r.map((row) => row.id.trim()).filter(Boolean))
      return [...r, ...imported.filter((row) => row.id.trim() && !have.has(row.id.trim()))]
    })

  const save = (e: React.FormEvent) => {
    e.preventDefault()
    void run("Couldn't save the profile", async () => {
      const models = rowsToModels(rows)
      if (Object.keys(links).length === 0) {
        throw new Error("Pick at least one agent this profile can run.")
      }
      const payload = {
        name: form.name,
        // An empty override means "the shared base URL" and is left out.
        agents: Object.fromEntries(
          Object.entries(links).map(([id, link]): [string, ProfileAgentLink] => [
            id,
            link.baseUrl.trim() ? { baseUrl: link.baseUrl.trim() } : {},
          ])
        ),
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
        models,
        // A default that no longer exists in the list is dropped.
        defaultModel: models.some((m) => m.id === form.defaultModel) ? form.defaultModel : "",
        logoUrl: form.logoUrl.trim(),
        /* Null rather than `{kind:"none"}` so "no reader" is one state on the
           wire and not two the server would both have to mean nothing by. */
        usage:
          form.usageKind === "none"
            ? null
            : { kind: form.usageKind, baseUrl: form.usageBaseUrl.trim(), apiKey: form.usageApiKey },
        suppressModelMetadataWarning: form.suppressModelMetadataWarning,
        upstreamTimeoutSeconds: Number(form.upstreamTimeoutSeconds) > 0 ? Math.round(Number(form.upstreamTimeoutSeconds)) : null,
        /* A nameless line is dropped rather than sent: the server's schema
           needs a name, and one stray colon would fail the whole save. */
        headers: pairs(form.headers, ":").filter((h) => h.name),
        hidden: form.hidden,
        disabled: form.disabled,

      }
      const saved = profile
        ? await api<Profile>(settings, `/api/profiles/${profile.id}`, { method: "PUT", body: JSON.stringify(payload) })
        : await api<Profile>(settings, "/api/profiles", { method: "POST", body: JSON.stringify(payload) })
      onDone(saved)
    })
  }

  const usageProvider = USAGE_PROVIDERS.find((p) => p.kind === form.usageKind)
  /* The jump rail's entries, in page order. Voice is written at once through the
     flags door, so a profile being created has no row to write to and no block. */
  const sections = [
    { id: "profile-provider", label: "Provider" },
    { id: "profile-agents", label: "Agents" },
    { id: "profile-models", label: "Models" },
    { id: "profile-usage", label: "Plan usage" },
    ...(profile ? [{ id: "profile-voice", label: "Voice" }] : []),
    { id: "profile-behaviour", label: "Behaviour" },
  ]
  const aside = (text?: string) =>
    text ? (
      <Badge variant="secondary" className="max-w-[40vw] truncate text-[11px] font-normal">
        {text}
      </Badge>
    ) : undefined

  const Shell = dialog ? PlainShell : FormShell
  return (
    <>
      {!dialog && (
        <FormPageHeader
          title={profile ? `Edit ${profile.name}` : "New profile"}
          description="Credentials, model catalog, which agents run on it, and what every thread on it brings along."
          onBack={() => onDone(null)}
        />
      )}
      <PageForm onSubmit={save}>
        {/* A dialog gets no jump rail — it is a pick-and-go surface, and a rail
            in a modal is chrome on top of chrome. */}
        <Shell sections={sections}>
          <FormSection id="profile-provider" label="Provider" hint="Where requests go and the key they carry.">
            {!profile && <PresetPicker value={preset} onPick={applyPreset} />}
            <div className="grid gap-4 @panel-sm:grid-cols-2">
              <Field label="Name">
                <Input value={form.name} onChange={(e) => set({ name: e.target.value })} required />
              </Field>
              <Field label="Base URL" hint="Optional — defaults to the provider's own. An agent below can override it.">
                <Input
                  value={form.baseUrl}
                  onChange={(e) => set({ baseUrl: e.target.value })}
                  placeholder="https://api.anthropic.com"
                  className="font-mono text-xs"
                />
              </Field>
              <Field label="API key" hint={profile?.hasApiKey ? "Stored — leave empty to keep it." : "Never sent back to clients."}>
                <Input type="password" value={form.apiKey} onChange={(e) => set({ apiKey: e.target.value })} />
                {preset?.keyUrl && (
                  <a
                    href={preset.keyUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline break-words max-w-full"
                  >
                    Get a {preset.name} key <ExternalLink className="size-3" />
                  </a>
                )}
              </Field>
              <Field
                label="Logo URL"
                hint="Optional — shown next to this profile in pickers. models.dev serves provider marks: https://models.dev/logos/<provider>.svg"
              >
                <div className="flex items-center gap-2">
                  {/* Live preview — the same component the pickers render, so what
                      you see here is what the composer shows. Empty falls back to
                      the agent's own mark. */}
                  <ProfileIcon
                    profile={{ logoUrl: form.logoUrl, agents: links }}
                    className="size-5 shrink-0"
                  />
                  <Input
                    value={form.logoUrl.startsWith("data:") ? "" : form.logoUrl}
                    onChange={(e) => set({ logoUrl: e.target.value })}
                    placeholder={form.logoUrl.startsWith("data:") ? "Uploaded image" : "https://models.dev/logos/openrouter.svg"}
                    className="font-mono text-xs min-w-0 flex-1"
                  />
                  <LogoUpload value={form.logoUrl} onChange={(logoUrl) => set({ logoUrl })} />
                </div>
              </Field>
            </div>
          </FormSection>

          {/* One provider, several runtimes: the same key and catalog reach each
              agent through its own env template, so a profile names every agent it
              serves rather than being made once per agent. The only thing that is
              per agent is the endpoint — a gateway often serves Claude Code and
              Codex at different paths. */}
          <FormSection
            id="profile-agents"
            label="Agents"
            hint="Which agents can run on this profile. Each may point at its own base URL when the provider serves it at a different path."
            action={aside(`${Object.keys(links).length} of ${agentRows.length}`)}
          >
            <AgentLinksContext.Provider
              value={{ links, placeholder: form.baseUrl || "Base URL override (optional)", toggle: toggleAgent, setBaseUrl: setAgentBaseUrl }}
            >
              <DataTable
                columns={AGENT_COLUMNS}
                data={agentFilter.rows}
                getRowId={(agent) => agent.id}
                mobile={AGENT_MOBILE}
                mark={() => <Cpu className="size-4" />}
                filtering={agentFilter.filtering}
                pageSize={50}
                emptyIcon={<Cpu />}
                emptyMessage={agentFilter.narrowed ? "No agent matches." : "No agents are registered on this server."}
              />
            </AgentLinksContext.Provider>
          </FormSection>

          <FormSection
            id="profile-models"
            label="Models"
            hint="What the provider behind this profile serves. A model with no efforts has no reasoning-effort setting."
            action={aside(rows.length > 0 ? `${rows.length} model${rows.length === 1 ? "" : "s"}` : undefined)}
          >
            <ModelsSection
              rows={rows}
              defaultModel={form.defaultModel}
              settings={settings}
              profileId={profile?.id ?? "new"}
              baseUrl={form.baseUrl}
              apiKey={form.apiKey}
              onPatch={handlePatch}
              onSetDefault={handleSetDefault}
              onRemove={handleRemove}
              onAdd={() => setRows((r) => [...r, blankModelRow()])}
              onImport={importModels}
              onReorder={(newRows) => setRows(() => newRows)}
            />
          </FormSection>

          {/* Whose plan the threads on this profile actually spend. The agent's own
              probe asks the *runtime's* CLI about this machine's login, which is
              the right question for `claude login` and the wrong one for a gateway:
              a thread running Claude Code against a GLM Coding Plan burns Z.AI's
              windows while `claude -p /usage` reports an Anthropic account it never
              touched. Set here, this reader wins — and it is one account, so every
              agent on the profile shares one reading. */}
          <FormSection
            id="profile-usage"
            label="Plan usage"
            hint="Which provider's plan the threads on this profile spend. Set here, it outranks the agent's own /usage reading."
            action={aside(form.usageKind !== "none" ? (usageProvider?.label.split(" — ")[0] ?? form.usageKind) : undefined)}
          >
            <Field label="Usage provider" hint={usageProvider?.hint}>
              <Select
                value={form.usageKind}
                onValueChange={(kind) => set({ usageKind: (kind as ProfileUsageKind) ?? "none" })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>{usageProvider?.label ?? form.usageKind}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {USAGE_PROVIDERS.map((provider) => (
                    <SelectItem key={provider.kind} value={provider.kind}>
                      {provider.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {form.usageKind !== "none" && (
              <div className="grid gap-4 @panel-sm:grid-cols-2">
                <Field label="Usage host" hint="Optional — the provider's default unless it is served somewhere else.">
                  <Input
                    value={form.usageBaseUrl}
                    onChange={(e) => set({ usageBaseUrl: e.target.value })}
                    placeholder={usageProvider?.hostPlaceholder}
                    className="font-mono text-xs"
                  />
                </Field>
                <Field
                  label="Usage API key"
                  hint={
                    profile?.usage?.hasApiKey
                      ? "Stored — leave empty to keep it."
                      : "Optional — leave empty to use this profile's own API key, which is the usual case."
                  }
                >
                  <Input
                    type="password"
                    value={form.usageApiKey}
                    onChange={(e) => set({ usageApiKey: e.target.value })}
                  />
                </Field>
              </div>
            )}
          </FormSection>

          {/* Written at once through the flags door, like the list's switches; a
              profile being created has no row to write to yet. */}
          {profile && (
            <FormSection id="profile-voice" label="Voice" hint="The realtime model a voice call on this profile's threads uses.">
              <VoiceBackendField
                value={voiceProvider}
                onChange={(v) => {
                  setVoiceProvider(v)
                  setFlags.mutate({ id: profile.id, voiceProvider: v }, { onError: (err) => reportError(err, "Couldn't set the voice backend") })
                }}
                hint="Which realtime model a voice call on threads using this profile uses. A project's own pick beats it."
              />
            </FormSection>
          )}

          <FormSection
            id="profile-behaviour"
            label="Behaviour"
            hint="Where the profile is offered, and the limits and notices every thread on it lives with."
            action={aside(form.disabled ? "Disabled" : form.hidden ? "Hidden" : undefined)}
          >
            <div className="divide-y divide-border/60 *:py-3 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
              <ToggleRow
                title="Shown"
                hint="Off, this profile is kept but not offered when starting a new thread. Its credentials, catalog and linked tools stay, the threads already on it keep running, and the usage page keeps tracking its plan — it is only out of the pickers."
                label="Offer this profile when starting a thread"
                checked={!form.hidden}
                onChange={(on) => set({ hidden: !on })}
              />
              <ToggleRow
                title="Enabled"
                hint="Off, the profile is disabled everywhere: out of the pickers and off the usage page too, for when a plan is paused or no longer worth watching. The threads already on it keep running — move them to another profile to close it fully."
                label="Track and offer this profile everywhere"
                checked={!form.disabled}
                onChange={(on) => set({ disabled: !on })}
              />
              <ToggleRow
                title="Quiet Codex's model-metadata notice"
                hint="Codex warns when a custom model id has no built-in metadata and falls back to a made-up context window. On, this profile drops that notice before it reaches the transcript: the profile already carries the model's numbers, and the warning only appears when the written catalog did not reach the running codex build."
                label={'Hide "Model metadata … not found. Defaulting to fallback metadata"'}
                checked={form.suppressModelMetadataWarning}
                onChange={(on) => set({ suppressModelMetadataWarning: on })}
              />
              <Field
                label="Response timeout (seconds)"
                hint="How long the server waits for this provider to start answering before it gives up and the agent retries. Some gateways send nothing until the first token, which a reasoning model on a large context can take minutes to reach. Blank uses the default (600). Allowed: 10 to 3600."
              >
                <Input
                  type="number"
                  inputMode="numeric"
                  min={10}
                  max={3600}
                  placeholder="600"
                  value={form.upstreamTimeoutSeconds}
                  onChange={(e) => set({ upstreamTimeoutSeconds: e.target.value })}
                  className="@panel-sm:max-w-48"
                />
              </Field>
              <Field
                label="Request headers"
                hint="One per line, Name: value. Added by the server to every request it makes to this provider, on top of the agent's own — a relay that only accepts the official client's User-Agent is fixed by naming it here."
              >
                <Textarea
                  value={form.headers}
                  onChange={(e) => set({ headers: e.target.value })}
                  rows={3}
                  placeholder="User-Agent: claude-cli/2.1.158 (external, sdk-cli)"
                  className="font-mono text-xs"
                />
              </Field>
            </div>
          </FormSection>
        </Shell>
        <FormActions busy={busy} onCancel={() => onDone(null)} error={saveError} />
      </PageForm>
    </>
  )
}

/** A switch with its sentence beside it: the title and the hint are the label,
    so the whole row is the target. */
function ToggleRow({
  title,
  hint,
  label,
  checked,
  onChange,
}: {
  title: string
  hint: string
  /** What the switch says when it is read on its own. */
  label: string
  checked: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 pointer-coarse:min-h-11">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block max-w-[68ch] text-xs/relaxed text-muted-foreground">{hint}</span>
      </span>
      <Switch className="mt-0.5 shrink-0" checked={checked} onCheckedChange={onChange} aria-label={label} />
    </label>
  )
}

/* ── Presets ──
   The coding plans a new profile can start from, read from the server
   (`GET /api/profile-presets`) because the server is what knows which usage
   readers it has and what models.dev lists for each plan. Picking one is a
   copy into the form above; nothing about the choice is saved. A preset whose
   catalog could not be read is still offered — its endpoints and usage reader
   are most of the value — and says so, because an empty model list is a
   different thing from a plan with no models. */

/* A sentinel rather than "" for the blank choice: Base UI reads an empty
   value as "nothing selected", which would blank the trigger's label. */
const BLANK = "blank"

function PresetPicker({ value, onPick }: { value: ProfilePreset | null; onPick: (preset: ProfilePreset | null) => void }) {
  const { presets, loading, error } = useProfilePresets()
  if (error && presets.length === 0) return null
  const hint = value
    ? value.modelsUnavailable
      ? `${value.description} The model catalog couldn't be read from models.dev — use "Fetch from endpoint" below once the key is in.`
      : value.description
    : "Optional — a coding plan's endpoints, model catalog and usage reader, filled in for you. Only the key is yours to add."
  return (
    <Field label="Start from a plan" hint={hint}>
      <Select value={value?.id ?? BLANK} onValueChange={(id) => onPick(presets.find((p) => p.id === id) ?? null)}>
        <SelectTrigger className="w-full min-w-0" disabled={loading}>
          <SelectValue>
            {value ? (
              <span className="flex items-center gap-2 min-w-0">
                <ProfileIcon profile={{ logoUrl: value.logoUrl, agents: value.agents }} className="size-4 shrink-0" />
                <span className="truncate">{value.name}</span>
              </span>
            ) : loading ? (
              "Loading plans…"
            ) : (
              "Blank profile"
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={BLANK}>Blank profile</SelectItem>
          {presets.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              <span className="flex items-center gap-2 min-w-0">
                <ProfileIcon profile={{ logoUrl: p.logoUrl, agents: p.agents }} className="size-4 shrink-0" />
                <span className="truncate">{p.name}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}
