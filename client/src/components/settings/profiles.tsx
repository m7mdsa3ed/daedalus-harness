import * as React from "react"
import { KeyRound, Pencil, Plus, Trash2 } from "lucide-react"
import { Navigate, useNavigate, useParams } from "react-router"
import { dropAgentOptions } from "@/lib/agent-options"
import { reportError } from "@/lib/errors"
import { useAsyncAction } from "@/hooks/use-async-action"
import { Button } from "@/components/ui/button"
import { useConfirm } from "@/components/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { AgentIcon, ProfileIcon } from "@/components/entity-icon"
import {
  api,
  mcpSubtitle,
  profileAgentIds,
  type Profile,
  type ProfileAgentLink,
  type ProfileUsageKind,
  type ServerSettings,
} from "@/lib/settings"
import { useStoreSelect } from "@/lib/store"
import { FormPageHeader, PageForm, PageHeader, Group, Row, EmptyCard, Field, FormActions, FormSection, Picker } from "./primitives"
import {
  ModelsSection,
  blankModelRow,
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
]

export function ProfilesPage() {
  const { settings, actions } = useSettingsPage()
  const meta = sectionMeta("profiles")
  const profiles = useStoreSelect((store) => store.profiles)
  const agents = useStoreSelect((store) => store.agents)
  const confirm = useConfirm()
  const navigate = useNavigate()

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
      await actions.refreshProfiles()
    } catch (err) {
      reportError(err, "Couldn't delete the profile")
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

  return (
    <>
      <PageHeader meta={meta} action={newButton} />
      {stored.length === 0 ? (
        <EmptyCard
          icon={KeyRound}
          text="No profiles yet. Every agent already runs on its own defaults — add a profile to point one at your own gateway, key or model catalog."
          action={newButton}
        />
      ) : (
        <Group>
          {stored.map((profile) => (
              <Row
                key={profile.id}
                /* The profile's own logo when it has one; the agent's mark
                   otherwise (which is what every virtual Default shows). */
                icon={<ProfileIcon profile={profile} className="size-4 shrink-0" />}
                title={profile.name}
                subtitle={
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    {/* Every agent this profile serves. One the server no
                        longer registers is shown by id, in mono, so a broken
                        profile is visible rather than silently narrowed. */}
                    {profileAgentIds(profile).map((id) => (
                      <span key={id} className="flex items-center gap-1">
                        <AgentIcon agentId={id} className="size-3" />
                        {agentName(id) ?? <span className="font-mono">{id}</span>}
                      </span>
                    ))}
                    {profile.defaultModel && <span className="font-mono">· {profile.defaultModel}</span>}
                    {profile.models.length > 1 && <span>· {profile.models.length} models</span>}
                    {profile.mcpServerIds.length > 0 && <span>· {profile.mcpServerIds.length} MCP</span>}
                    {profile.skillIds.length > 0 && <span>· {profile.skillIds.length} skills</span>}
                    {profile.commandIds.length > 0 && <span>· {profile.commandIds.length} commands</span>}
                  </span>
                }
              >
                {!profile.hasApiKey && (
                  <Badge variant="outline" className="text-muted-foreground">
                    no key
                  </Badge>
                )}
                <Button variant="ghost" size="icon-lg" title="Edit" onClick={() => void navigate(settingsFormPath("profiles", profile.id))}>
                  <Pencil />
                </Button>
                <Button variant="ghost" size="icon-lg" title="Delete" onClick={() => remove(profile)}>
                  <Trash2 />
                </Button>
              </Row>
          ))}
        </Group>
      )}
    </>
  )
}

export function ProfileFormPage() {
  const { entryId } = useParams()
  const navigate = useNavigate()
  const { settings, actions } = useSettingsPage()
  const profiles = useStoreSelect((store) => store.profiles)
  const agents = useStoreSelect((store) => store.agents)
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
        if (saved) await actions.refreshProfiles()
        void navigate(settingsPath("profiles"))
      }}
    />
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
  // The library the pickers below draw from.
  const mcpServers = useStoreSelect((store) => store.mcpServers)
  const skills = useStoreSelect((store) => store.skills)
  const commands = useStoreSelect((store) => store.commands)
  const [form, setForm] = React.useState(() => ({
    name: profile?.name ?? "",
    baseUrl: profile?.baseUrl ?? "",
    apiKey: "",
    defaultModel: profile?.defaultModel ?? "",
    logoUrl: profile?.logoUrl ?? "",
    mcpServerIds: profile?.mcpServerIds ?? [],
    skillIds: profile?.skillIds ?? [],
    commandIds: profile?.commandIds ?? [],
    /* The usage reader, flattened into the form the way `apiKey` is: the token
       is write-only (the server sends back a boolean), so an empty field means
       "keep the stored one" here too. */
    usageKind: (profile?.usage?.kind ?? "none") as ProfileUsageKind,
    usageBaseUrl: profile?.usage?.baseUrl ?? "",
    usageApiKey: "",
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
        mcpServerIds: form.mcpServerIds,
        skillIds: form.skillIds,
        commandIds: form.commandIds,
      }
      if (profile) {
        await api<Profile>(settings, `/api/profiles/${profile.id}`, { method: "PUT", body: JSON.stringify(payload) })
      } else {
        await api<Profile>(settings, "/api/profiles", { method: "POST", body: JSON.stringify(payload) })
      }
      onDone(true)
    })
  }

  return (
    <>
      <FormPageHeader
        title={profile ? `Edit ${profile.name}` : "New profile"}
        description="Credentials, model catalog, which agents run on it, and what every thread on it brings along."
        onBack={() => onDone(false)}
      />
      <PageForm onSubmit={save}>
      <div className="grid gap-4 sm:grid-cols-2">
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
              className="size-5"
            />
            <Input
              value={form.logoUrl}
              onChange={(e) => set({ logoUrl: e.target.value })}
              placeholder="https://models.dev/logos/openrouter.svg"
              className="font-mono text-xs"
            />
          </div>
        </Field>
      </div>
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
              <div key={agent.id} className="grid gap-2 rounded-md border border-border/60 p-2 sm:grid-cols-[minmax(10rem,auto)_1fr] sm:items-center">
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={!!link} onCheckedChange={(on) => toggleAgent(agent.id, on)} />
                  <AgentIcon agentId={agent.id} className="size-4" />
                  <span className={"unregistered" in agent ? "font-mono text-muted-foreground" : ""}>
                    {agent.name}
                  </span>
                </label>
                {link && (
                  <Input
                    value={link.baseUrl}
                    onChange={(e) => setAgentBaseUrl(agent.id, e.target.value)}
                    placeholder={form.baseUrl || "Base URL override (optional)"}
                    aria-label={`${agent.name} base URL override`}
                    className="font-mono text-xs"
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
          <div className="grid gap-4 sm:grid-cols-2">
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
      />
      {/* The same three a project links. A project's say what the workspace
          brings; a profile's say what the provider setup brings, to every
          thread started on it whichever project it is in. The thread adds its
          own on top (the Tools menu on a new thread's composer), and the
          agent is spawned with the union of all three. */}
      <FormSection label="Capabilities">
        <Field label="MCP servers" hint="Manage the definitions in Settings › MCP servers.">
          <Picker
            items={mcpServers}
            selected={form.mcpServerIds}
            onToggle={(mcpServerIds) => set({ mcpServerIds })}
            subtitle={mcpSubtitle}
            empty="No MCP servers defined yet."
          />
        </Field>
        <Field label="Skills" hint="Manage the paths in Settings › Skills.">
          <Picker
            items={skills}
            selected={form.skillIds}
            onToggle={(skillIds) => set({ skillIds })}
            subtitle={(s) => s.path}
            empty="No skills defined yet."
          />
        </Field>
        <Field label="Slash commands" hint="Manage the prompts in Settings › Commands.">
          <Picker
            items={commands}
            selected={form.commandIds}
            onToggle={(commandIds) => set({ commandIds })}
            subtitle={(c) => `/${c.name}`}
            empty="No commands defined yet."
          />
        </Field>
      </FormSection>
      <FormActions busy={busy} onCancel={() => onDone(false)} error={saveError} />
      </PageForm>
    </>
  )
}
