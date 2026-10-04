import * as React from "react"
import { Copy, ExternalLink, KeyRound, Pencil, Plus, RefreshCw, Search, Trash2 } from "lucide-react"
import { Navigate, useNavigate, useParams } from "react-router"
import { dropAgentOptions } from "@/lib/agent-options"
import { reportError } from "@/lib/errors"
import { useAsyncAction } from "@/hooks/use-async-action"
import { Button } from "@/components/ui/button"
import { useConfirm } from "@/components/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
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
import { Empty } from "@/components/empty"
import {
  api,
  profileAgentIds,
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
import { FormPageHeader, PageForm, PageHeader, EmptyCard, Field, FormActions, FormSection, INSET } from "./primitives"
import { SettingsList } from "./list"
import {
  ModelsSection,
  blankModelRow,
  candidateToRow,
  rowsToModels,
  toModelRows,
  type ModelRow,
} from "./profile-models"
import { sectionMeta } from "./sections"
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

export function ProfilesPage() {
  const { settings } = useSettingsPage()
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
    <Button onClick={() => void navigate(settingsFormPath("profiles"))}>
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
  const stored = profiles.filter((p) => !p.virtual)
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name

  /* Search and ordering are the list's own, not the server's: the whole
     catalog is already here (one `/api/profiles` read), so filtering it is a
     string match, and what a reader wants first is the profiles still in play
     — disabled last, hidden after shown, each group by name. */
  const [query, setQuery] = React.useState("")
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
  const needle = query.trim().toLowerCase()
  const hiddenCount = stored.filter((p) => p.hidden).length
  const rank = (p: Profile) => (p.disabled ? 2 : p.hidden ? 1 : 0)
  const shown = stored
    .filter((p) => showHidden || needle || !p.hidden)
    .filter(
      (p) =>
        !needle ||
        `${p.name} ${p.baseUrl} ${p.defaultModel} ${profileAgentIds(p).map((id) => agentName(id) ?? id).join(" ")} ${p.models.map((m) => `${m.id} ${m.label}`).join(" ")}`
          .toLowerCase()
          .includes(needle)
    )
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))

  return (
    <>
      <PageHeader meta={meta} action={newButton} />
      {/* The search box only once the list is long enough to need it — a filter
          over three rows costs more than it saves. The hidden switch appears
          whenever there is something folded away, however short the list. */}
      {(stored.length > 5 || hiddenCount > 0) && (
        <div className="mb-4 flex flex-col gap-2 @panel-sm:flex-row @panel-sm:items-center">
          {stored.length > 5 && (
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search profiles, agents, models…"
                aria-label="Search profiles"
                className="pl-9"
              />
            </div>
          )}
          {hiddenCount > 0 && (
            <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground @panel-sm:ml-auto">
              <Switch checked={showHidden} onCheckedChange={setShowHidden} />
              Show {hiddenCount} hidden
            </label>
          )}
        </div>
      )}
      <SettingsList
        rows={shown}
        rowId={(profile) => profile.id}
        /* No `search` here: the page owns its own box above (it also drives the
           "show hidden" switch), and two search fields over one list is one
           more than there is a list. */
        columns={[
          {
            id: "profile",
            header: "Profile",
            cell: (profile) => (
              <div className="flex min-w-0 items-center gap-2.5">
                <ProfileIcon profile={profile} className="size-5 shrink-0" />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={cn(
                        "truncate font-medium",
                        (profile.hidden || profile.disabled) && "text-muted-foreground"
                      )}
                    >
                      {profile.name}
                    </span>
                    {profile.disabled ? (
                      <Badge variant="secondary" className="text-[10px]">
                        Disabled
                      </Badge>
                    ) : profile.hidden ? (
                      <Badge variant="secondary" className="text-[10px]">
                        Hidden
                      </Badge>
                    ) : null}
                    {!profile.hasApiKey && (
                      <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground">
                        no key
                      </Badge>
                    )}
                  </div>
                  {/* The host, not the whole URL: which gateway this profile
                      points at is the question, and the path is what made the
                      row wrap. A URL that won't parse is said as it was typed. */}
                  {profile.baseUrl && (
                    <div className="truncate text-[11px] text-muted-foreground" title={profile.baseUrl}>
                      {URL.parse(profile.baseUrl)?.host ?? profile.baseUrl}
                    </div>
                  )}
                </div>
              </div>
            ),
          },
          {
            id: "agents",
            header: "Agents",
            secondary: true,
            cell: (profile) => (
              <div className="flex flex-wrap items-center gap-1.5">
                {profileAgentIds(profile).map((id) => (
                  <span
                    key={id}
                    className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-[11px]"
                  >
                    <AgentIcon agentId={id} className="size-3 shrink-0" />
                    <span className="truncate">{agentName(id) ?? id}</span>
                  </span>
                ))}
              </div>
            ),
          },
          {
            id: "model",
            header: "Model",
            secondary: true,
            cell: (profile) => (
              <div className="space-y-0.5 text-[11px] text-muted-foreground">
                {profile.defaultModel && (
                  <div className="font-mono break-all">{profile.defaultModel}</div>
                )}
                {profile.models.length > 1 && <div>{profile.models.length} models</div>}
                {profile.usage && profile.usage.kind !== "none" && <div>plan usage</div>}
              </div>
            ),
          },
          {
            id: "state",
            header: "State",
            align: "end",
            /* Kept, not deleted: either flag still leaves the profile spawning
               the threads already on it. Hiding is the pickers only — the usage
               page keeps reading the plan; disabling closes everywhere, usage
               included. State-labelled, since two bare switches would not say
               which was which. */
            cell: (profile) => (
              <div className="flex items-center justify-end gap-3">
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Switch
                    checked={!profile.hidden}
                    onCheckedChange={(on) =>
                      toggle(profile, { hidden: !on }, on ? "Profile shown" : "Profile hidden")
                    }
                    aria-label={profile.hidden ? `Show ${profile.name}` : `Hide ${profile.name}`}
                  />
                  Shown
                </label>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Switch
                    checked={!profile.disabled}
                    onCheckedChange={(on) =>
                      toggle(profile, { disabled: !on }, on ? "Profile enabled" : "Profile disabled")
                    }
                    aria-label={profile.disabled ? `Enable ${profile.name}` : `Disable ${profile.name}`}
                  />
                  Enabled
                </label>
              </div>
            ),
          },
        ]}
        actions={[
          {
            id: "duplicate",
            label: "Duplicate",
            icon: <Copy />,
            onClick: (profile) => void duplicate(profile),
          },
          {
            id: "sync",
            label: "Sync to server",
            icon: <RefreshCw />,
            onClick: startSync,
          },
          {
            id: "edit",
            label: "Edit",
            icon: <Pencil />,
            onClick: (profile) => void navigate(settingsFormPath("profiles", profile.id)),
          },
          {
            id: "delete",
            label: "Delete",
            icon: <Trash2 />,
            tone: "danger",
            onClick: (profile) => void remove(profile),
          },
        ]}
        renderCard={(profile) => (
          <>
            <div className="flex min-w-0 items-center gap-2.5">
              <ProfileIcon profile={profile} className="size-5 shrink-0" />
              <span
                className={cn(
                  "truncate text-sm font-medium",
                  (profile.hidden || profile.disabled) && "text-muted-foreground"
                )}
              >
                {profile.name}
              </span>
              {profile.disabled ? (
                <Badge variant="secondary" className="text-[10px]">
                  Disabled
                </Badge>
              ) : profile.hidden ? (
                <Badge variant="secondary" className="text-[10px]">
                  Hidden
                </Badge>
              ) : null}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              {profileAgentIds(profile).map((id) => (
                <span key={id} className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5">
                  <AgentIcon agentId={id} className="size-3 shrink-0" />
                  <span className="truncate">{agentName(id) ?? id}</span>
                </span>
              ))}
              {profile.defaultModel && (
                <span className="rounded bg-muted/60 px-1.5 py-0.5 font-mono break-all">
                  {profile.defaultModel}
                </span>
              )}
            </div>
          </>
        )}
        empty={
          stored.length === 0 ? (
            <EmptyCard
              icon={KeyRound}
              text="No profiles yet. Every agent already runs on its own defaults — add a profile to point one at your own gateway, key or model catalog."
              action={newButton}
            />
          ) : (
            <Empty size="lg">Nothing matches “{query.trim()}”.</Empty>
          )
        }
      />
      <ResponsiveDialog open={syncProfileRow !== null} onOpenChange={(open) => !open && setSyncProfileRow(null)}>
        <ResponsiveDialogContent className="@panel-sm:max-w-md">
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
    hidden: profile?.hidden ?? false,
    disabled: profile?.disabled ?? false,
  }))
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
        hidden: form.hidden,
        disabled: form.disabled,

      }
      const saved = profile
        ? await api<Profile>(settings, `/api/profiles/${profile.id}`, { method: "PUT", body: JSON.stringify(payload) })
        : await api<Profile>(settings, "/api/profiles", { method: "POST", body: JSON.stringify(payload) })
      onDone(saved)
    })
  }

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
              value={form.logoUrl}
              onChange={(e) => set({ logoUrl: e.target.value })}
              placeholder="https://models.dev/logos/openrouter.svg"
              className="font-mono text-xs min-w-0 flex-1"
            />
          </div>
        </Field>
      </div>
      <Field
        label="Shown"
        hint="Off, this profile is kept but not offered when starting a new thread. Its credentials, catalog and linked tools stay, the threads already on it keep running, and the usage page keeps tracking its plan — it is only out of the pickers."
      >
        <label className="flex items-start gap-2.5 text-sm cursor-pointer">
          <Switch
            className="mt-0.5 shrink-0"
            checked={!form.hidden}
            onCheckedChange={(on) => set({ hidden: !on })}
          />
          <span className="min-w-0 flex-1 leading-snug">Offer this profile when starting a thread</span>
        </label>
      </Field>
      <Field
        label="Enabled"
        hint="Off, the profile is disabled everywhere: out of the pickers and off the usage page too, for when a plan is paused or no longer worth watching. The threads already on it keep running — move them to another profile to close it fully."
      >
        <label className="flex items-start gap-2.5 text-sm cursor-pointer">
          <Switch
            className="mt-0.5 shrink-0"
            checked={!form.disabled}
            onCheckedChange={(on) => set({ disabled: !on })}
          />
          <span className="min-w-0 flex-1 leading-snug">Track and offer this profile everywhere</span>
        </label>
      </Field>
      {/* One provider, several runtimes: the same key and catalog reach each
          agent through its own env template, so a profile names every agent it
          serves rather than being made once per agent. The only thing that is
          per agent is the endpoint — a gateway often serves Claude Code and
          Codex at different paths. */}
      <Field
        label="Agents"
        hint="Which agents can run on this profile. Each may point at its own base URL when the provider serves it at a different path."
      >
        <div className="grid gap-2">
          {agentRows.map((agent) => {
            const link = links[agent.id]
            return (
              <div key={agent.id} className={cn("grid gap-2 p-2 @panel-sm:grid-cols-[minmax(10rem,auto)_1fr] @panel-sm:items-center", INSET)}>
                <label className="flex items-center gap-2 text-sm min-w-0 cursor-pointer">
                  <Switch className="shrink-0" checked={!!link} onCheckedChange={(on) => toggleAgent(agent.id, on)} />
                  <AgentIcon agentId={agent.id} className="size-4 shrink-0" />
                  <span className={cn("truncate min-w-0", "unregistered" in agent ? "font-mono text-muted-foreground" : "")}>
                    {agent.name}
                  </span>
                </label>
                {link && (
                  <Input
                    value={link.baseUrl}
                    onChange={(e) => setAgentBaseUrl(agent.id, e.target.value)}
                    placeholder={form.baseUrl || "Base URL override (optional)"}
                    aria-label={`${agent.name} base URL override`}
                    className="font-mono text-xs w-full min-w-0"
                  />
                )}
              </div>
            )
          })}
        </div>
      </Field>
      {/* Whose plan the threads on this profile actually spend. The agent's own
          probe asks the *runtime's* CLI about this machine's login, which is
          the right question for `claude login` and the wrong one for a gateway:
          a thread running Claude Code against a GLM Coding Plan burns Z.AI's
          windows while `claude -p /usage` reports an Anthropic account it never
          touched. Set here, this reader wins — and it is one account, so every
          agent on the profile shares one reading. */}
      <FormSection label="Plan usage">
        <Field
          label="Usage provider"
          hint={USAGE_PROVIDERS.find((p) => p.kind === form.usageKind)?.hint}
        >
          <Select
            value={form.usageKind}
            onValueChange={(kind) => set({ usageKind: (kind as ProfileUsageKind) ?? "none" })}
          >
            <SelectTrigger className="w-full">
              <SelectValue>
                {USAGE_PROVIDERS.find((p) => p.kind === form.usageKind)?.label ?? form.usageKind}
              </SelectValue>
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
                placeholder={USAGE_PROVIDERS.find((p) => p.kind === form.usageKind)?.hostPlaceholder}
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
      <Field
        label="Quiet Codex's model-metadata notice"
        hint="Codex warns when a custom model id has no built-in metadata and falls back to a made-up context window. On, this profile drops that notice before it reaches the transcript: the profile already carries the model's numbers, and the warning only appears when the written catalog did not reach the running codex build."
      >
        <label className="flex items-start gap-2.5 text-sm cursor-pointer">
          <Switch
            className="mt-0.5 shrink-0"
            checked={form.suppressModelMetadataWarning}
            onCheckedChange={(on) => set({ suppressModelMetadataWarning: on })}
          />
          <span className="min-w-0 flex-1 leading-snug">Hide "Model metadata … not found. Defaulting to fallback metadata"</span>
        </label>
      </Field>
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
        />
      </Field>
      <FormActions busy={busy} onCancel={() => onDone(null)} error={saveError} />
      </PageForm>
    </>
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
