import * as React from "react"
import {
  Cpu,
  Download,
  FolderIcon,
  KeyRound,
  Monitor,
  Moon,
  Palette,
  Pencil,
  Plug,
  Plus,
  RotateCcw,
  Server,
  Sparkles,
  Sun,
  Trash2,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { useConfirm } from "@/components/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Textarea } from "@/components/ui/textarea"
import type { Actions } from "@/lib/actions"
import {
  api,
  clearSettings,
  type ImportCandidates,
  type McpServerDef,
  type Profile,
  type Project,
  type ServerSettings,
  type SkillDef,
} from "@/lib/settings"
import { useStore } from "@/lib/store"
import {
  FONT_SIZE_DEFAULT,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  SCALE_DEFAULT,
  SCALE_MAX,
  SCALE_MIN,
  useFontSize,
  useScale,
  useTheme,
} from "@/lib/theme"
import { cn } from "@/lib/utils"

/** The settings sections — rendered as sidebar nav, not as horizontal tabs.
    Add an entry (id + icon + copy) and it appears in both the nav and here. */
export const SETTINGS_SECTIONS = [
  {
    id: "general",
    label: "General",
    icon: Server,
    title: "Connection",
    description:
      "The harness server this client talks to. Projects, profiles and agents live there, shared by every connected client.",
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: Palette,
    title: "Appearance",
    description: "How the harness looks on this device. Stored locally, never synced.",
  },
  {
    id: "projects",
    label: "Projects",
    icon: FolderIcon,
    title: "Projects",
    description:
      "A project is the workspace a thread runs in: directory, MCP servers and skills.",
  },
  {
    id: "mcp",
    label: "MCP servers",
    icon: Plug,
    title: "MCP servers",
    description:
      "Reusable MCP server definitions. Attach them to a project; the client sends them to the agent in ACP session/new.",
  },
  {
    id: "skills",
    label: "Skills",
    icon: Sparkles,
    title: "Skills",
    description:
      "Reusable skill directories on the server. Attach them to a project; they are symlinked into <cwd>/.claude/skills at spawn.",
  },
  {
    id: "profiles",
    label: "Profiles",
    icon: KeyRound,
    title: "Profiles",
    description: "A profile is the agent configuration a thread runs with: runtime, credentials and models.",
  },
  {
    id: "agents",
    label: "Agents",
    icon: Cpu,
    title: "Agents",
    description: "ACP runtimes registered on the server (data/agents.json).",
  },
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"]
type SectionMeta = (typeof SETTINGS_SECTIONS)[number]

export function SettingsPage({
  section,
  settings,
  actions,
}: {
  section: SettingsSectionId
  settings: ServerSettings
  actions: Actions
}) {
  const meta = SETTINGS_SECTIONS.find((s) => s.id === section) ?? SETTINGS_SECTIONS[0]

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-16 sm:px-8">
        {meta.id === "general" && <GeneralSection meta={meta} settings={settings} />}
        {meta.id === "appearance" && <AppearanceSection meta={meta} />}
        {meta.id === "projects" && <ProjectsSection meta={meta} settings={settings} actions={actions} />}
        {meta.id === "mcp" && <McpSection meta={meta} settings={settings} actions={actions} />}
        {meta.id === "skills" && <SkillsSection meta={meta} settings={settings} actions={actions} />}
        {meta.id === "profiles" && <ProfilesSection meta={meta} settings={settings} actions={actions} />}
        {meta.id === "agents" && <AgentsSection meta={meta} />}
      </div>
    </div>
  )
}

// ---- layout primitives ----

/** Page title block: icon + title + description, with room for one action. */
function PageHeader({ meta, action }: { meta: SectionMeta; action?: React.ReactNode }) {
  const Icon = meta.icon
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4 border-b pb-5">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border bg-card text-muted-foreground">
          <Icon className="size-4.5" />
        </span>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{meta.title}</h1>
          <p className="mt-1 text-sm text-pretty text-muted-foreground">{meta.description}</p>
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  )
}

/** Grouped card with an optional caption above it. */
function Group({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 last:mb-0">
      {label && (
        <h2 className="mb-2 px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </h2>
      )}
      <div className="divide-y overflow-hidden rounded-xl border bg-card">{children}</div>
    </section>
  )
}

/** One line in a Group: label/description on the left, control on the right. */
function Row({
  icon: Icon,
  title,
  subtitle,
  children,
}: {
  icon?: LucideIcon
  title: React.ReactNode
  subtitle?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" />}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{title}</div>
        {subtitle && <div className="mt-0.5 text-xs break-all text-muted-foreground">{subtitle}</div>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-1.5">{children}</div>}
    </div>
  )
}

function EmptyCard({ icon: Icon, text, action }: { icon: LucideIcon; text: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center">
      <Icon className="size-6 text-muted-foreground/60" />
      <p className="text-sm text-muted-foreground">{text}</p>
      {action}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

const lines = (value: string) => value.split("\n").map((l) => l.trim()).filter(Boolean)

/** "NAME=value" / "Name: value" lines -> the {name, value} pairs ACP expects. */
const pairs = (value: string, sep: string) =>
  lines(value).map((line) => {
    const at = line.indexOf(sep)
    return at === -1
      ? { name: line, value: "" }
      : { name: line.slice(0, at).trim(), value: line.slice(at + sep.length).trim() }
  })

/** Checkbox list for linking library entries (MCP servers, skills) to a project. */
function Picker<T extends { id: string; name: string }>({
  items,
  selected,
  onToggle,
  subtitle,
  empty,
}: {
  items: T[]
  selected: string[]
  onToggle: (ids: string[]) => void
  subtitle: (item: T) => React.ReactNode
  empty: string
}) {
  if (items.length === 0) {
    return <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">{empty}</p>
  }
  return (
    <div className="max-h-64 divide-y overflow-y-auto rounded-lg border">
      {items.map((item) => (
        <label key={item.id} className="flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-accent/50">
          <Checkbox
            className="mt-0.5"
            checked={selected.includes(item.id)}
            onCheckedChange={(checked) =>
              onToggle(checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))
            }
          />
          <span className="min-w-0 flex-1">
            <span className="block text-sm break-words">{item.name}</span>
            <span className="mt-0.5 block font-mono text-[11px] break-all text-muted-foreground">
              {subtitle(item)}
            </span>
          </span>
        </label>
      ))}
    </div>
  )
}

// ---- general ----

function GeneralSection({ meta, settings }: { meta: SectionMeta; settings: ServerSettings }) {
  const { state } = useStore()
  return (
    <>
      <PageHeader meta={meta} />
      <Group>
        <Row title="Server" subtitle={<span className="font-mono">{settings.url}</span>}>
          <Badge variant="secondary" className="gap-1.5">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            Connected
          </Badge>
        </Row>
        <Row title="Disconnect" subtitle="Forget the server URL and token stored on this device.">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              clearSettings()
              location.reload()
            }}
          >
            Disconnect
          </Button>
        </Row>
      </Group>
      <Group label="Workspace">
        <Row title="Projects" subtitle="Workspaces threads can run in.">
          <Badge variant="secondary">{state.projects.length}</Badge>
        </Row>
        <Row title="Profiles" subtitle="Agent configurations available to new threads.">
          <Badge variant="secondary">{state.profiles.length}</Badge>
        </Row>
        <Row title="MCP servers" subtitle="Definitions projects can attach.">
          <Badge variant="secondary">{state.mcpServers.length}</Badge>
        </Row>
        <Row title="Skills" subtitle="Skill directories projects can attach.">
          <Badge variant="secondary">{state.skills.length}</Badge>
        </Row>
        <Row title="Threads" subtitle="Sessions currently held by the server.">
          <Badge variant="secondary">{state.sessions.length}</Badge>
        </Row>
      </Group>
    </>
  )
}

// ---- appearance ----

const THEMES = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const

/** Slider + live value + reset, on its own row so the track gets real width. */
function SliderRow({
  title,
  subtitle,
  value,
  onChange,
  min,
  max,
  step = 1,
  fallback,
  unit,
}: {
  title: string
  subtitle: string
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  step?: number
  fallback: number
  unit: string
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{title}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{subtitle}</div>
        </div>
        <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 font-mono text-xs tabular-nums">
          {value}
          {unit}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          title="Reset"
          disabled={value === fallback}
          onClick={() => onChange(fallback)}
        >
          <RotateCcw className="size-3.5" />
        </Button>
      </div>
      <Slider
        className="mt-3"
        value={value}
        min={min}
        max={max}
        step={step}
        onValueChange={(next) => onChange(Array.isArray(next) ? next[0] : next)}
      />
    </div>
  )
}

function AppearanceSection({ meta }: { meta: SectionMeta }) {
  const { theme, setTheme } = useTheme()
  const [fontSize, setFontSize] = useFontSize()
  const [scale, setScale] = useScale()

  return (
    <>
      <PageHeader meta={meta} />
      <Group label="Theme">
        <div className="grid grid-cols-3 gap-2 p-2">
          {THEMES.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => setTheme(value)}
              aria-pressed={theme === value}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-lg border border-transparent px-3 py-4 text-xs font-medium transition-colors",
                theme === value
                  ? "border-border bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50"
              )}
            >
              <Icon className="size-4.5" />
              {label}
            </button>
          ))}
        </div>
      </Group>
      <Group label="Density">
        <SliderRow
          title="Font size"
          subtitle="Root text size — the whole layout scales from it."
          value={fontSize}
          onChange={setFontSize}
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          fallback={FONT_SIZE_DEFAULT}
          unit="px"
        />
        <SliderRow
          title="Spacing"
          subtitle="Paddings, gaps and control heights, without touching text size."
          value={scale}
          onChange={setScale}
          min={SCALE_MIN}
          max={SCALE_MAX}
          step={5}
          fallback={SCALE_DEFAULT}
          unit="%"
        />
      </Group>
    </>
  )
}

// ---- projects ----

function ProjectsSection({
  meta,
  settings,
  actions,
}: {
  meta: SectionMeta
  settings: ServerSettings
  actions: Actions
}) {
  const { state } = useStore()
  const confirm = useConfirm()
  const [editing, setEditing] = React.useState<Project | "new" | null>(null)

  const remove = async (project: Project) => {
    if (!(await confirm({ title: `Delete project "${project.name}"?`, destructive: true, confirmLabel: "Delete" })))
      return
    try {
      await api(settings, `/api/projects/${project.id}`, { method: "DELETE" })
      await actions.refreshProjects()
    } catch (err) {
      toast.error(String(err))
    }
  }

  const newButton = (
    <Button size="sm" onClick={() => setEditing("new")}>
      <Plus className="size-4" /> New project
    </Button>
  )

  return (
    <>
      <PageHeader meta={meta} action={newButton} />
      {state.projects.length === 0 ? (
        <EmptyCard icon={FolderIcon} text="No projects yet — a thread needs one to know where to run." action={newButton} />
      ) : (
        <Group>
          {state.projects.map((project) => (
            <Row
              key={project.id}
              icon={FolderIcon}
              title={project.name}
              subtitle={
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="font-mono">{project.cwd}</span>
                  {project.mcpServerIds.length > 0 && <span>· {project.mcpServerIds.length} MCP</span>}
                  {project.skillIds.length > 0 && <span>· {project.skillIds.length} skills</span>}
                </span>
              }
            >
              <Button variant="ghost" size="icon" className="size-8" title="Edit" onClick={() => setEditing(project)}>
                <Pencil className="size-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="size-8" title="Delete" onClick={() => remove(project)}>
                <Trash2 className="size-3.5" />
              </Button>
            </Row>
          ))}
        </Group>
      )}
      <ResponsiveDialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <ResponsiveDialogContent>
          {editing !== null && (
            <ProjectForm
              project={editing === "new" ? null : editing}
              settings={settings}
              onDone={async (saved) => {
                if (saved) await actions.refreshProjects()
                setEditing(null)
              }}
            />
          )}
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  )
}

function FormActions({ busy, onCancel }: { busy: boolean; onCancel: () => void }) {
  return (
    <div className="sticky bottom-0 -mx-1 mt-2 flex justify-end gap-2 bg-gradient-to-t from-popover via-popover to-transparent px-1 pt-3 pb-1">
      <Button type="button" variant="outline" onClick={onCancel}>
        Cancel
      </Button>
      <Button type="submit" disabled={busy}>
        {busy ? "Saving…" : "Save"}
      </Button>
    </div>
  )
}

/** Also used by the sidebar's "New project" action. */
export function ProjectForm({
  project,
  settings,
  onDone,
}: {
  project: Project | null
  settings: ServerSettings
  onDone: (saved: boolean) => void
}) {
  const { state } = useStore()
  const [form, setForm] = React.useState(() => ({
    name: project?.name ?? "",
    cwd: project?.cwd ?? "",
    mcpServerIds: project?.mcpServerIds ?? [],
    skillIds: project?.skillIds ?? [],
  }))
  const [busy, setBusy] = React.useState(false)
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const payload = {
        name: form.name,
        cwd: form.cwd,
        mcpServerIds: form.mcpServerIds,
        skillIds: form.skillIds,
      }
      if (project) {
        await api(settings, `/api/projects/${project.id}`, { method: "PUT", body: JSON.stringify(payload) })
      } else {
        await api(settings, "/api/projects", { method: "POST", body: JSON.stringify(payload) })
      }
      onDone(true)
    } catch (err) {
      toast.error(String(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <ResponsiveDialogHeader>
        <ResponsiveDialogTitle>{project ? `Edit ${project.name}` : "New project"}</ResponsiveDialogTitle>
      </ResponsiveDialogHeader>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input value={form.name} onChange={(e) => set({ name: e.target.value })} required />
        </Field>
        <Field label="Working directory" hint="Path on the server, not on this device.">
          <Input
            value={form.cwd}
            onChange={(e) => set({ cwd: e.target.value })}
            placeholder="/home/me/project"
            className="font-mono text-xs"
            required
          />
        </Field>
      </div>
      <Field label="MCP servers" hint="Manage the definitions in Settings › MCP servers.">
        <Picker
          items={state.mcpServers}
          selected={form.mcpServerIds}
          onToggle={(mcpServerIds) => set({ mcpServerIds })}
          subtitle={(s) => (s.type === "http" ? s.url : s.command)}
          empty="No MCP servers defined yet."
        />
      </Field>
      <Field label="Skills" hint="Manage the paths in Settings › Skills.">
        <Picker
          items={state.skills}
          selected={form.skillIds}
          onToggle={(skillIds) => set({ skillIds })}
          subtitle={(s) => s.path}
          empty="No skills defined yet."
        />
      </Field>
      <FormActions busy={busy} onCancel={() => onDone(false)} />
    </form>
  )
}

// ---- library: MCP servers + skills ----

/** List + create/edit dialog for a library registry. Both registries share it. */
function LibrarySection<T extends { id: string; name: string }>({
  meta,
  items,
  endpoint,
  importKind,
  noun,
  subtitle,
  settings,
  refresh,
  renderForm,
}: {
  meta: SectionMeta
  items: T[]
  endpoint: string
  /** Which side of GET /api/import this section imports from. */
  importKind: "mcpServers" | "skills"
  noun: string
  subtitle: (item: T) => string
  settings: ServerSettings
  refresh: () => Promise<void>
  renderForm: (item: T | null, onDone: (saved: boolean) => void) => React.ReactNode
}) {
  const confirm = useConfirm()
  const [editing, setEditing] = React.useState<T | "new" | null>(null)
  const [importing, setImporting] = React.useState(false)

  const remove = async (item: T) => {
    if (!(await confirm({ title: `Delete "${item.name}"?`, destructive: true, confirmLabel: "Delete" }))) return
    try {
      await api(settings, `${endpoint}/${item.id}`, { method: "DELETE" })
      await refresh()
    } catch (err) {
      toast.error(String(err))
    }
  }

  const newButton = (
    <Button size="sm" onClick={() => setEditing("new")}>
      <Plus className="size-4" /> New {noun}
    </Button>
  )
  const actions = (
    <div className="flex flex-wrap justify-end gap-2">
      <Button size="sm" variant="outline" onClick={() => setImporting(true)}>
        <Download className="size-4" /> Import
      </Button>
      {newButton}
    </div>
  )

  return (
    <>
      <PageHeader meta={meta} action={actions} />
      {items.length === 0 ? (
        <EmptyCard icon={meta.icon} text={`No ${noun}s yet — add one, or import from the agents' own configs.`} action={actions} />
      ) : (
        <Group>
          {items.map((item) => (
            <Row key={item.id} icon={meta.icon} title={item.name} subtitle={<span className="font-mono">{subtitle(item)}</span>}>
              <Button variant="ghost" size="icon" className="size-8" title="Edit" onClick={() => setEditing(item)}>
                <Pencil className="size-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="size-8" title="Delete" onClick={() => remove(item)}>
                <Trash2 className="size-3.5" />
              </Button>
            </Row>
          ))}
        </Group>
      )}
      <ResponsiveDialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <ResponsiveDialogContent>
          {editing !== null &&
            renderForm(editing === "new" ? null : editing, async (saved) => {
              if (saved) await refresh()
              setEditing(null)
            })}
        </ResponsiveDialogContent>
      </ResponsiveDialog>
      <ResponsiveDialog open={importing} onOpenChange={setImporting}>
        <ResponsiveDialogContent className="sm:max-w-xl">
          {importing && (
            <ImportDialog
              kind={importKind}
              endpoint={endpoint}
              noun={noun}
              settings={settings}
              onDone={async (imported) => {
                if (imported) await refresh()
                setImporting(false)
              }}
            />
          )}
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  )
}

/**
 * Pick from what the agents on the server already have configured
 * (~/.claude.json, ~/.codex/config.toml, skill directories) and copy the
 * selection into the library. Entries already in the library are filtered out
 * server-side.
 */
function ImportDialog({
  kind,
  endpoint,
  noun,
  settings,
  onDone,
}: {
  kind: "mcpServers" | "skills"
  endpoint: string
  noun: string
  settings: ServerSettings
  onDone: (imported: boolean) => void
}) {
  const [found, setFound] = React.useState<({ id: string; name: string; source: string } & Record<string, unknown>)[] | null>(
    null
  )
  const [selected, setSelected] = React.useState<string[]>([])
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    api<ImportCandidates>(settings, "/api/import")
      .then((r) => setFound(r[kind].map((item, i) => ({ ...item, id: String(i) }))))
      .catch((err) => {
        toast.error(String(err))
        setFound([])
      })
  }, [settings, kind])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      for (const id of selected) {
        const item = found?.find((f) => f.id === id)
        if (!item) continue
        const { id: _id, source: _source, ...payload } = item
        await api(settings, endpoint, { method: "POST", body: JSON.stringify(payload) })
      }
      toast.success(`Imported ${selected.length} ${noun}${selected.length === 1 ? "" : "s"}`)
      onDone(true)
    } catch (err) {
      toast.error(String(err))
      setBusy(false)
    }
  }

  const all = found?.map((f) => f.id) ?? []

  return (
    <form onSubmit={save} className="space-y-4">
      <ResponsiveDialogHeader>
        <ResponsiveDialogTitle>Import {noun}s</ResponsiveDialogTitle>
      </ResponsiveDialogHeader>
      {found === null ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Scanning the server…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="min-w-0 flex-1 text-xs text-pretty text-muted-foreground">
              Found in Claude and Codex config on the server. Already-imported entries are hidden.
            </p>
            {found.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSelected(selected.length === all.length ? [] : all)}
              >
                {selected.length === all.length ? "None" : "All"}
              </Button>
            )}
          </div>
          <Picker
            items={found}
            selected={selected}
            onToggle={setSelected}
            subtitle={(item) => (
              <>
                <span className="font-sans text-muted-foreground/70">{item.source}</span>
                <br />
                {(item.url as string) ?? (item.path as string) ?? (item.command as string) ?? ""}
              </>
            )}
            empty={`Nothing left to import — the library already has every ${noun} found on the server.`}
          />
        </>
      )}
      <div className="sticky bottom-0 -mx-1 mt-2 flex justify-end gap-2 bg-gradient-to-t from-popover via-popover to-transparent px-1 pt-3 pb-1">
        <Button type="button" variant="outline" onClick={() => onDone(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || selected.length === 0}>
          {busy ? "Importing…" : selected.length ? `Import ${selected.length}` : "Import"}
        </Button>
      </div>
    </form>
  )
}

/** POST when creating, PUT when editing — every library form does this. */
async function saveLibraryEntry(
  settings: ServerSettings,
  endpoint: string,
  id: string | undefined,
  payload: unknown
) {
  await api(settings, id ? `${endpoint}/${id}` : endpoint, {
    method: id ? "PUT" : "POST",
    body: JSON.stringify(payload),
  })
}

function McpSection({
  meta,
  settings,
  actions,
}: {
  meta: SectionMeta
  settings: ServerSettings
  actions: Actions
}) {
  const { state } = useStore()
  return (
    <LibrarySection
      meta={meta}
      items={state.mcpServers}
      endpoint="/api/mcp-servers"
      importKind="mcpServers"
      noun="MCP server"
      subtitle={(s) => (s.type === "http" ? s.url : [s.command, ...s.args].join(" "))}
      settings={settings}
      refresh={actions.refreshMcpServers}
      renderForm={(server, onDone) => <McpForm server={server} settings={settings} onDone={onDone} />}
    />
  )
}

function McpForm({
  server,
  settings,
  onDone,
}: {
  server: McpServerDef | null
  settings: ServerSettings
  onDone: (saved: boolean) => void
}) {
  const [form, setForm] = React.useState(() => ({
    name: server?.name ?? "",
    type: server?.type ?? "stdio",
    command: server?.type === "stdio" ? server.command : "",
    args: server?.type === "stdio" ? server.args.join("\n") : "",
    env: server?.type === "stdio" ? server.env.map((e) => `${e.name}=${e.value}`).join("\n") : "",
    url: server?.type === "http" ? server.url : "",
    headers: server?.type === "http" ? server.headers.map((h) => `${h.name}: ${h.value}`).join("\n") : "",
  }))
  const [busy, setBusy] = React.useState(false)
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const payload =
        form.type === "http"
          ? { type: "http", name: form.name, url: form.url, headers: pairs(form.headers, ":") }
          : {
              type: "stdio",
              name: form.name,
              command: form.command,
              args: lines(form.args),
              env: pairs(form.env, "="),
            }
      await saveLibraryEntry(settings, "/api/mcp-servers", server?.id, payload)
      onDone(true)
    } catch (err) {
      toast.error(String(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <ResponsiveDialogHeader>
        <ResponsiveDialogTitle>{server ? `Edit ${server.name}` : "New MCP server"}</ResponsiveDialogTitle>
      </ResponsiveDialogHeader>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" hint="How the agent addresses the server.">
          <Input value={form.name} onChange={(e) => set({ name: e.target.value })} required />
        </Field>
        <Field label="Transport">
          <Select value={form.type} onValueChange={(type) => set({ type: (type as "stdio" | "http") ?? "stdio" })}>
            <SelectTrigger className="w-full">
              <SelectValue>{form.type === "http" ? "HTTP" : "stdio"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stdio">stdio</SelectItem>
              <SelectItem value="http">HTTP</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      {form.type === "http" ? (
        <>
          <Field label="URL">
            <Input
              value={form.url}
              onChange={(e) => set({ url: e.target.value })}
              placeholder="https://mcp.example.com/sse"
              className="font-mono text-xs"
              required
            />
          </Field>
          <Field label="Headers" hint="One per line: Name: value">
            <Textarea
              value={form.headers}
              onChange={(e) => set({ headers: e.target.value })}
              rows={3}
              className="font-mono text-xs"
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="Command" hint="Runs on the server, spawned by the agent.">
            <Input
              value={form.command}
              onChange={(e) => set({ command: e.target.value })}
              placeholder="npx"
              className="font-mono text-xs"
              required
            />
          </Field>
          <Field label="Arguments" hint="One per line.">
            <Textarea
              value={form.args}
              onChange={(e) => set({ args: e.target.value })}
              rows={3}
              className="font-mono text-xs"
            />
          </Field>
          <Field label="Environment" hint="One per line: NAME=value">
            <Textarea
              value={form.env}
              onChange={(e) => set({ env: e.target.value })}
              rows={2}
              className="font-mono text-xs"
            />
          </Field>
        </>
      )}
      <FormActions busy={busy} onCancel={() => onDone(false)} />
    </form>
  )
}

function SkillsSection({
  meta,
  settings,
  actions,
}: {
  meta: SectionMeta
  settings: ServerSettings
  actions: Actions
}) {
  const { state } = useStore()
  return (
    <LibrarySection
      meta={meta}
      items={state.skills}
      endpoint="/api/skills"
      importKind="skills"
      noun="skill"
      subtitle={(s) => s.path}
      settings={settings}
      refresh={actions.refreshSkills}
      renderForm={(skill, onDone) => <SkillForm skill={skill} settings={settings} onDone={onDone} />}
    />
  )
}

function SkillForm({
  skill,
  settings,
  onDone,
}: {
  skill: SkillDef | null
  settings: ServerSettings
  onDone: (saved: boolean) => void
}) {
  const [form, setForm] = React.useState(() => ({ name: skill?.name ?? "", path: skill?.path ?? "" }))
  const [busy, setBusy] = React.useState(false)
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await saveLibraryEntry(settings, "/api/skills", skill?.id, form)
      onDone(true)
    } catch (err) {
      toast.error(String(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <ResponsiveDialogHeader>
        <ResponsiveDialogTitle>{skill ? `Edit ${skill.name}` : "New skill"}</ResponsiveDialogTitle>
      </ResponsiveDialogHeader>
      <Field label="Name">
        <Input value={form.name} onChange={(e) => set({ name: e.target.value })} required />
      </Field>
      <Field label="Directory" hint="Path on the server holding SKILL.md — symlinked into the project.">
        <Input
          value={form.path}
          onChange={(e) => set({ path: e.target.value })}
          placeholder="/home/me/.claude/skills/my-skill"
          className="font-mono text-xs"
          required
        />
      </Field>
      <FormActions busy={busy} onCancel={() => onDone(false)} />
    </form>
  )
}

// ---- profiles ----

const UNREGISTERED = "__unregistered"

function ProfilesSection({
  meta,
  settings,
  actions,
}: {
  meta: SectionMeta
  settings: ServerSettings
  actions: Actions
}) {
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
      toast.error(String(err))
    }
  }

  const newButton = (
    <Button size="sm" onClick={() => setEditing("new")}>
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
                {!profile.hasApiKey && (
                  <Badge variant="outline" className="text-muted-foreground">
                    no key
                  </Badge>
                )}
                <Button variant="ghost" size="icon" className="size-8" title="Edit" onClick={() => setEditing(profile)}>
                  <Pencil className="size-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="size-8" title="Delete" onClick={() => remove(profile)}>
                  <Trash2 className="size-3.5" />
                </Button>
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
          size="sm"
          className="h-8 shrink-0 text-xs"
          title={isDefault ? "This is the default model" : "Make default"}
          onClick={onSetDefault}
        >
          {isDefault ? "Default" : "Set default"}
        </Button>
        <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" title="Remove model" onClick={onRemove}>
          <Trash2 className="size-3.5" />
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
      toast.error(String(err))
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
          <Button type="button" variant="outline" size="sm" onClick={() => setRows((r) => [...r, blankModelRow()])}>
            <Plus className="size-4" /> Add model
          </Button>
        </div>
      </Field>
      <FormActions busy={busy} onCancel={() => onDone(false)} />
    </form>
  )
}

// ---- agents ----

function AgentsSection({ meta }: { meta: SectionMeta }) {
  const { state } = useStore()
  return (
    <>
      <PageHeader meta={meta} />
      {state.agents.length === 0 ? (
        <EmptyCard icon={Cpu} text="The server has no agents registered." />
      ) : (
        <Group>
          {state.agents.map((agent) => {
            const uses = state.profiles.filter((p) => p.agentId === agent.id).length
            return (
              <Row
                key={agent.id}
                icon={Cpu}
                title={agent.name}
                subtitle={<span className="font-mono">{agent.id}</span>}
              >
                <Badge variant="secondary">
                  {uses} profile{uses === 1 ? "" : "s"}
                </Badge>
              </Row>
            )
          })}
        </Group>
      )}
    </>
  )
}
