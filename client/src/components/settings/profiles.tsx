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
import { api, type Profile, type ServerSettings } from "@/lib/settings"
import { useStore } from "@/lib/store"
import { PageHeader, Group, Row, EmptyCard, Field, FormActions } from "./primitives"
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

/* ── model rows (reference: profile-models.ts) ──
   The form edits rows and converts to ModelOption[] on save. Numbers live as
   strings in the rows: a half-typed number is a normal editing state. */

interface ModelRow {
  uid: string
  id: string
  label: string
  contextWindow: string
  maxOutputTokens: string
  /** Comma-separated effort levels; empty = the model has no effort control. */
  efforts: string
}

let modelUid = 0
const blankModelRow = (): ModelRow => ({
  uid: `model-${++modelUid}`,
  id: "",
  label: "",
  contextWindow: "",
  maxOutputTokens: "",
  efforts: "",
})

const toModelRows = (models: Profile["models"]): ModelRow[] =>
  models.map((m) => ({
    uid: `model-${++modelUid}`,
    id: m.id,
    // The id doubles as the label when there is nothing better; don't echo it
    // into the field, or clearing it becomes impossible.
    label: m.label && m.label !== m.id ? m.label : "",
    contextWindow: m.contextWindow ? String(m.contextWindow) : "",
    maxOutputTokens: m.maxOutputTokens ? String(m.maxOutputTokens) : "",
    efforts: m.reasoningEfforts.join(", "),
  }))

function rowsToModels(rows: ModelRow[]): Profile["models"] {
  const models: Profile["models"] = []
  for (const row of rows) {
    const id = row.id.trim()
    if (!id) continue
    const context = Number(row.contextWindow.trim())
    const maxOut = Number(row.maxOutputTokens.trim())
    models.push({
      id,
      label: row.label.trim() || id,
      ...(row.contextWindow.trim() && context > 0 ? { contextWindow: Math.round(context) } : {}),
      ...(row.maxOutputTokens.trim() && maxOut > 0 ? { maxOutputTokens: Math.round(maxOut) } : {}),
      reasoningEfforts: row.efforts
        .split(/[,\s]+/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    })
  }
  return models
}

function ModelRowEditor({
  row,
  isDefault,
  onChange,
  onSetDefault,
  onRemove,
}: {
  row: ModelRow
  isDefault: boolean
  onChange: (patch: Partial<ModelRow>) => void
  onSetDefault: () => void
  onRemove: () => void
}) {
  return (
    <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
      <div className="flex items-center gap-2">
        <Input
          value={row.id}
          onChange={(e) => onChange({ id: e.target.value })}
          placeholder="model id (claude-opus-5)"
          className="flex-1 font-mono text-xs"
        />
        <Input
          value={row.label}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Display name"
          className="flex-1 text-xs"
        />
        <Button
          type="button"
          variant={isDefault ? "secondary" : "ghost"}
          size="lg"
          className="shrink-0"
          title={isDefault ? "This is the default model" : "Make default"}
          onClick={onSetDefault}
        >
          {isDefault ? "Default" : "Set default"}
        </Button>
        <Button type="button" variant="ghost" size="icon-lg" className="shrink-0" title="Remove model" onClick={onRemove}>
          <Trash2 />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="number"
          value={row.contextWindow}
          onChange={(e) => onChange({ contextWindow: e.target.value })}
          placeholder="context"
          title="Context window (tokens)"
          className="w-28 text-right font-mono text-xs"
        />
        <Input
          type="number"
          value={row.maxOutputTokens}
          onChange={(e) => onChange({ maxOutputTokens: e.target.value })}
          placeholder="max output"
          title="Max output tokens"
          className="w-28 text-right font-mono text-xs"
        />
        <Input
          value={row.efforts}
          onChange={(e) => onChange({ efforts: e.target.value })}
          placeholder="efforts: low, medium, high"
          title="Reasoning efforts the model accepts (comma-separated)"
          className="min-w-40 flex-1 font-mono text-xs"
        />
      </div>
    </div>
  )
}

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
  }))
  const [rows, setRows] = React.useState<ModelRow[]>(() => toModelRows(profile?.models ?? []))
  const [busy, setBusy] = React.useState(false)
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))
  const patchRow = (uid: string, patch: Partial<ModelRow>) =>
    setRows((r) => r.map((row) => (row.uid === uid ? { ...row, ...patch } : row)))

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
      }
      if (profile) {
        await api(settings, `/api/profiles/${profile.id}`, { method: "PUT", body: JSON.stringify(payload) })
      } else {
        await api(settings, "/api/profiles", { method: "POST", body: JSON.stringify(payload) })
      }
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
      <Field
        label="Models"
        hint="What the provider behind this profile serves. Efforts only for models that accept a reasoning-effort setting."
      >
        <div className="space-y-2">
          {rows.map((row) => (
            <ModelRowEditor
              key={row.uid}
              row={row}
              isDefault={row.id.trim() !== "" && row.id.trim() === form.defaultModel}
              onChange={(patch) => {
                // Renaming the default row's id keeps it the default.
                if (patch.id !== undefined && row.id.trim() === form.defaultModel) {
                  set({ defaultModel: patch.id.trim() })
                }
                patchRow(row.uid, patch)
              }}
              onSetDefault={() => set({ defaultModel: row.id.trim() === form.defaultModel ? "" : row.id.trim() })}
              onRemove={() => {
                if (row.id.trim() === form.defaultModel) set({ defaultModel: "" })
                setRows((r) => r.filter((x) => x.uid !== row.uid))
              }}
            />
          ))}
          <Button type="button" variant="outline" size="lg" onClick={() => setRows((r) => [...r, blankModelRow()])}>
            <Plus className="size-4" /> Add model
          </Button>
        </div>
      </Field>
      <FormActions busy={busy} onCancel={() => onDone(false)} />
    </form>
  )
}
