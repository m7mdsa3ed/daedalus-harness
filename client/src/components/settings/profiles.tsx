import * as React from "react"
import { KeyRound, Pencil, Plus, Trash2 } from "lucide-react"
import { reportError } from "@/lib/errors"
import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { useConfirm } from "@/components/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { api, type ModelCandidate, type Profile, type ServerSettings } from "@/lib/settings"
import { useStore } from "@/lib/store"
import { PageHeader, Group, Row, EmptyCard, Field, FormActions } from "./primitives"
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

const UNREGISTERED = "__unregistered"

export function ProfilesPage() {
  const { settings, actions } = useSettingsPage()
  const meta = sectionMeta("profiles")
  const { state } = useStore()
  const confirm = useConfirm()
  const [editing, setEditing] = React.useState<Profile | "new" | null>(null)

  const remove = async (profile: Profile) => {
    if (!(await confirm({ title: `Delete profile "${profile.name}"?`, destructive: true, confirmLabel: "Delete" })))
      return
    try {
      await api(settings, `/api/profiles/${profile.id}`, { method: "DELETE" })
      await actions.refreshProfiles()
    } catch (err) {
      reportError(err, "Couldn't delete the profile")
    }
  }

  const newButton = (
    <Button size="lg" onClick={() => setEditing("new")}>
      <Plus className="size-4" /> New profile
    </Button>
  )

  // One card per registered agent, in registry order; profiles whose agent is
  // gone from data/agents.json land in a trailing group instead of vanishing.
  const groups = [
    ...state.agents.map((agent) => ({
      key: agent.id,
      label: agent.name,
      profiles: state.profiles.filter((p) => p.agentId === agent.id),
    })),
    {
      key: UNREGISTERED,
      label: "Unregistered agents",
      profiles: state.profiles.filter((p) => !state.agents.some((a) => a.id === p.agentId)),
    },
  ].filter((group) => group.profiles.length > 0)

  return (
    <>
      <PageHeader meta={meta} action={newButton} />
      {state.profiles.length === 0 ? (
        <EmptyCard icon={KeyRound} text="No profiles yet — a thread needs one to know which agent to run." action={newButton} />
      ) : (
        groups.map((group) => (
          <Group key={group.key} label={group.label}>
            {group.profiles.map((profile) => (
              <Row
                key={profile.id}
                icon={KeyRound}
                title={profile.name}
                subtitle={
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    {group.key === UNREGISTERED && <span className="font-mono">{profile.agentId}</span>}
                    {profile.defaultModel && <span className="font-mono">{profile.defaultModel}</span>}
                    {profile.models.length > 1 && <span>· {profile.models.length} models</span>}
                  </span>
                }
              >
                {/* The agent's own defaults, synthesized rather than stored —
                    there is nothing here to edit, and deleting it would only
                    make the server hand it back. Adding a real profile for this
                    agent is what overrides it. */}
                {profile.virtual ? (
                  <Badge variant="outline" className="text-muted-foreground">
                    from the agent
                  </Badge>
                ) : (
                  <>
                    {!profile.hasApiKey && (
                      <Badge variant="outline" className="text-muted-foreground">
                        no key
                      </Badge>
                    )}
                    <Button variant="ghost" size="icon-lg" title="Edit" onClick={() => setEditing(profile)}>
                      <Pencil />
                    </Button>
                    <Button variant="ghost" size="icon-lg" title="Delete" onClick={() => remove(profile)}>
                      <Trash2 />
                    </Button>
                  </>
                )}
              </Row>
            ))}
          </Group>
        ))
      )}
      <ResponsiveDialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <ResponsiveDialogContent className="sm:max-w-xl">
          {editing !== null && (
            <ProfileForm
              profile={editing === "new" ? null : editing}
              agents={state.agents}
              settings={settings}
              onDone={async (saved) => {
                if (saved) await actions.refreshProfiles()
                setEditing(null)
              }}
            />
          )}
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  )
}

/* ── model rows live in ./profile-models.tsx ──
   The form owns the state (rows, defaultModel) and the bookkeeping that keeps
   the default honest; that module owns the row shapes, conversions and UI. */

function ProfileForm({
  profile,
  agents,
  settings,
  onDone,
}: {
  profile: Profile | null
  agents: { id: string; name: string }[]
  settings: ServerSettings
  onDone: (saved: boolean) => void
}) {
  const [form, setForm] = React.useState(() => ({
    name: profile?.name ?? "",
    agentId: profile?.agentId ?? agents[0]?.id ?? "",
    baseUrl: profile?.baseUrl ?? "",
    apiKey: "",
    defaultModel: profile?.defaultModel ?? "",
    webSearch: profile?.webSearch?.enabled ?? false,
    searchApiBaseUrl: profile?.webSearch?.searchApiBaseUrl ?? "",
    searchApiToken: "",
    searchModel: profile?.webSearch?.searchModel ?? "",
    fetchModel: profile?.webSearch?.fetchModel ?? "",
    memories: profile?.memories?.enabled ?? false,
    knowledge: profile?.knowledge?.enabled ?? false,
  }))
  const [hasWebSearchToken, setHasWebSearchToken] = React.useState(
    (profile?.webSearch as { hasWebSearchToken?: boolean } | undefined)?.hasWebSearchToken ?? false,
  )
  const [rows, setRows] = React.useState<ModelRow[]>(() => toModelRows(profile?.models ?? []))
  const [busy, setBusy] = React.useState(false)
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
  /** Imports never clobber: a candidate whose id is already listed is skipped. */
  const importModels = (candidates: ModelCandidate[]) =>
    setRows((r) => {
      const have = new Set(r.map((row) => row.id.trim()).filter(Boolean))
      return [...r, ...candidates.filter((c) => c.id && !have.has(c.id)).map(candidateToRow)]
    })

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const models = rowsToModels(rows)
      const payload = {
        name: form.name,
        agentId: form.agentId,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
        models,
        // A default that no longer exists in the list is dropped.
        defaultModel: models.some((m) => m.id === form.defaultModel) ? form.defaultModel : "",
        webSearch: {
          enabled: form.webSearch,
          ...(form.searchApiBaseUrl ? { searchApiBaseUrl: form.searchApiBaseUrl } : {}),
          ...(form.searchApiToken ? { searchApiToken: form.searchApiToken } : {}),
          ...(form.searchModel ? { searchModel: form.searchModel } : {}),
          ...(form.fetchModel ? { fetchModel: form.fetchModel } : {}),
        },
        memories: { enabled: form.memories },
        knowledge: { enabled: form.knowledge },
      }
      const saved = profile
        ? await api<Profile>(settings, `/api/profiles/${profile.id}`, { method: "PUT", body: JSON.stringify(payload) })
        : await api<Profile>(settings, "/api/profiles", { method: "POST", body: JSON.stringify(payload) })
      setHasWebSearchToken((saved.webSearch as { hasWebSearchToken?: boolean } | undefined)?.hasWebSearchToken ?? false)
      setForm((f) => ({ ...f, searchApiToken: "" }))
      onDone(true)
    } catch (err) {
      reportError(err, "Couldn't save the profile")
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <ResponsiveDialogHeader>
        <ResponsiveDialogTitle>{profile ? `Edit ${profile.name}` : "New profile"}</ResponsiveDialogTitle>
      </ResponsiveDialogHeader>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input value={form.name} onChange={(e) => set({ name: e.target.value })} required />
        </Field>
        <Field label="Agent">
          <Select value={form.agentId} onValueChange={(agentId) => set({ agentId: agentId ?? "" })}>
            <SelectTrigger className="w-full">
              <SelectValue>{agents.find((a) => a.id === form.agentId)?.name}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Base URL" hint="Optional — defaults to the provider's own.">
          <Input
            value={form.baseUrl}
            onChange={(e) => set({ baseUrl: e.target.value })}
            placeholder="https://api.anthropic.com"
            className="font-mono text-xs"
          />
        </Field>
        <Field label="API key" hint={profile?.hasApiKey ? "Stored — leave empty to keep it." : "Never sent back to clients."}>
          <Input type="password" value={form.apiKey} onChange={(e) => set({ apiKey: e.target.value })} />
        </Field>
      </div>
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
      />
      <Field
        label="Web search via MCP"
        hint="Replaces Claude Code's built-in WebSearch/WebFetch with the harness's own web-search tools. Unset fields inherit the server default in Settings › Web search."
      >
        <Switch checked={form.webSearch} onCheckedChange={(checked) => set({ webSearch: checked })} />
      </Field>
      {form.webSearch && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Search API base URL" hint="Optional — overrides the server default.">
            <Input
              value={form.searchApiBaseUrl}
              onChange={(e) => set({ searchApiBaseUrl: e.target.value })}
              placeholder="http://localhost:20128"
              className="font-mono text-xs"
            />
          </Field>
          <Field label="Search API token" hint={hasWebSearchToken ? "Stored — leave empty to keep it." : "Optional — overrides the server default."}>
            <Input
              type="password"
              value={form.searchApiToken}
              onChange={(e) => set({ searchApiToken: e.target.value })}
            />
          </Field>
          <Field label="Search model" hint="Optional — overrides the server default.">
            <Input
              value={form.searchModel}
              onChange={(e) => set({ searchModel: e.target.value })}
              placeholder="search-combo"
              className="font-mono text-xs"
            />
          </Field>
          <Field label="Fetch model" hint="Optional — overrides the server default.">
            <Input
              value={form.fetchModel}
              onChange={(e) => set({ fetchModel: e.target.value })}
              placeholder="fetch-combo"
              className="font-mono text-xs"
            />
          </Field>
        </div>
      )}
      <Field
        label="Memories via MCP"
        hint="Gives the agent a durable cross-turn memory for this profile's projects. Off by default."
      >
        <Switch checked={form.memories} onCheckedChange={(checked) => set({ memories: checked })} />
      </Field>
      <Field
        label="Knowledge base via MCP"
        hint="Gives the agent a per-project knowledge base for this profile's projects. Off by default."
      >
        <Switch checked={form.knowledge} onCheckedChange={(checked) => set({ knowledge: checked })} />
      </Field>
      <FormActions busy={busy} onCancel={() => onDone(false)} />
    </form>
  )
}
