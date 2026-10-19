import * as React from "react"
import { arrayMove } from "@dnd-kit/sortable"
import {
  ArrowDown,
  ArrowUp,
  BookOpenIcon,
  FolderIcon,
  GlobeIcon,
  PanelsTopLeft,
  Pencil,
  Plus,
  RefreshCwIcon,
  SquareTerminal,
  Trash2,
} from "lucide-react"
import { Navigate, useNavigate, useParams } from "react-router"
import { captureError, reportError, type InlineError, errorText } from "@/lib/errors"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable, TitleCell, type TableAction } from "@/components/ui/data-table"
import type { ColumnDef } from "@/lib/table"
import { Empty } from "@/components/empty"
import { ProjectIcon } from "@/components/entity-icon"
import { ErrorNote } from "@/components/error-note"
import { Notice } from "@/components/notice"
import { useConfirm } from "@/components/confirm-dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { PathInput } from "@/components/ui/suggesting-input"
import { api, type HelperCommand, type Project, type ServerSettings } from "@/lib/settings"
import type { KnowledgeEntry } from "@/lib/workspace/knowledge-api"
import {
  useActiveSpace,
  useCreateRule,
  useDeleteRule,
  useInvalidateCatalog,
  useProjectRules,
  useProjects,
  useUpdateRule,
} from "@/lib/queries/catalog"
import {
  useAddKnowledge,
  useDeleteHelper,
  useDeleteKnowledge,
  useProjectKnowledge,
  useReorderProjects,
} from "@/lib/queries/surfaces"
import { cn } from "@/lib/utils"
import {
  Field,
  FormActions,
  FormPageHeader,
  FormSection,
  FormShell,
  INSET,
  LogoUpload,
  PageForm,
  Picker,
  PageHeader,
  SectionHead,
  StatStrip,
} from "./primitives"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"
import { projectPath, settingsFormPath, settingsPath } from "@/lib/router"
import { HelperForm } from "@/components/helper-form"
import { VoiceBackendField } from "./voice"
import { saveProjectDefaults } from "@/lib/project-defaults"
import { useQueryClient } from "@tanstack/react-query"
import { useTableFilter } from "@/lib/use-table-filter"

/* ── The collection ──
   One DataTable: a project is a name over its path, then what hangs off it
   (description, preview, helper count). Order is the user's — the sidebar draws
   it — so the table keeps a Move up / Move down pair in the row menu in place
   of the old drag grip (a table's rows are not a sortable list). Both are
   withheld while a search filters the list: a reorder of a subset has no
   meaning for the whole. */

const PROJECT_COLUMNS: ColumnDef<Project, unknown>[] = [
  {
    id: "project",
    header: "Project",
    meta: { title: true, className: "min-w-56" },
    cell: ({ row }) => (
      <TitleCell
        title={row.original.name}
        subtitle={
          <span className="font-mono text-[11px]" title={row.original.cwd}>
            {row.original.cwd}
          </span>
        }
      />
    ),
  },
  {
    id: "description",
    header: "Description",
    meta: { className: "hidden @panel-md:table-cell max-w-64" },
    cell: ({ row }) => <span className="block truncate text-muted-foreground">{row.original.description}</span>,
  },
  {
    id: "preview",
    header: "Preview",
    meta: { className: "hidden @panel-lg:table-cell max-w-56" },
    cell: ({ row }) =>
      row.original.previewUrl ? (
        <span className="inline-flex max-w-full items-center gap-1 text-primary">
          <GlobeIcon className="size-3 shrink-0" />
          <span className="truncate font-mono text-xs">{row.original.previewUrl}</span>
        </span>
      ) : null,
  },
  {
    id: "helpers",
    header: "Helpers",
    meta: { align: "end", className: "w-24" },
    cell: ({ row }) => {
      const n = row.original.helpers?.length ?? 0
      return n > 0 ? (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <SquareTerminal className="size-3.5" /> {n}
        </span>
      ) : (
        <span className="text-muted-foreground/50">—</span>
      )
    },
  },
]

export function ProjectsPage() {
  const { settings } = useSettingsPage()
  const invalidate = useInvalidateCatalog()
  const meta = sectionMeta("projects")
  const projects = useProjects()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const reorder = useReorderProjects()

  /* The new arrangement is drawn immediately and the server is told; the local
     copy is dropped once the refetched list agrees with it, so the row never
     jumps back to the old order for a frame while the write is in flight. A
     failed write leaves the stale arrangement on screen only until the list
     refreshes — the error is what says it did not take. */
  const [dragged, setDragged] = React.useState<Project[] | null>(null)
  const list = dragged ?? projects
  const ids = projects.map((p) => p.id).join()
  React.useEffect(() => {
    setDragged((d) => (d && d.map((p) => p.id).join() === ids ? null : d))
  }, [ids])

  const f = useTableFilter(list, {
    text: (p) => `${p.name} ${p.cwd} ${p.description ?? ""}`,
    placeholder: "Search projects...",
  })

  const move = (project: Project, delta: -1 | 1) => {
    const from = list.findIndex((p) => p.id === project.id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= list.length) return
    const next = arrayMove(list, from, to)
    setDragged(next)
    reorder.mutate(next.map((p) => p.id), {
      onError: (err) => reportError(err, "Couldn't save the project order"),
    })
  }

  const remove = async (project: Project) => {
    if (
      !(await confirm({
        title: `Delete project "${project.name}"?`,
        description:
          "The directory on disk is left alone — this removes the harness's record of it, along with its knowledge entries and previews. Threads started in it keep their transcripts but lose their folder.",
        destructive: true,
        confirmLabel: "Delete",
      }))
    )
      return
    try {
      await api(settings, `/api/projects/${project.id}`, { method: "DELETE" })
      await invalidate("projects")
    } catch (err) {
      reportError(err, "Couldn't delete the project")
    }
  }

  /* The row actions read the latest of all this through one ref, so the
     table's memoised rows are not rebuilt on every keystroke in the search. */
  const live = React.useRef({ move, remove, navigate })
  React.useLayoutEffect(() => {
    live.current = { move, remove, navigate }
  })
  /* Whether a row can move is read off the list, so the actions are rebuilt when
     the ends or the filter change — never trusted to a ref the rows may not
     re-read. */
  const firstId = list[0]?.id
  const lastId = list.at(-1)?.id
  const filtered = f.narrowed

  const actions = React.useMemo<TableAction<Project>[]>(
    () => [
      {
        id: "open",
        label: "Open overview",
        icon: <PanelsTopLeft />,
        // The overview is the project as a *place* — its threads, its numbers —
        // where this page is the project as a record.
        onClick: (p) => void live.current.navigate(projectPath(p.id)),
        position: "left",
      },
      {
        id: "edit",
        label: "Edit",
        icon: <Pencil />,
        onClick: (p) => void live.current.navigate(settingsFormPath("projects", p.id)),
      },
      {
        id: "up",
        label: "Move up",
        icon: <ArrowUp />,
        onClick: (p) => live.current.move(p, -1),
        hidden: (p) => filtered || firstId === p.id,
      },
      {
        id: "down",
        label: "Move down",
        icon: <ArrowDown />,
        onClick: (p) => live.current.move(p, 1),
        hidden: (p) => filtered || lastId === p.id,
      },
      {
        id: "delete",
        label: "Delete",
        icon: <Trash2 />,
        tone: "danger",
        onClick: (p) => void live.current.remove(p),
      },
    ],
    [filtered, firstId, lastId],
  )

  const newButton = (
    <Button className="h-11 @panel-sm:h-9" onClick={() => void navigate(settingsFormPath("projects"))}>
      <Plus className="size-4" /> New project
    </Button>
  )

  return (
    <>
      <PageHeader meta={meta} action={newButton} />
      {projects.length === 0 ? (
        <Empty
          size="lg"
          icon={FolderIcon}
          action={newButton}
        >
          No projects yet — a thread needs one to know where to run.
        </Empty>
      ) : (
        <DataTable
          columns={PROJECT_COLUMNS}
          data={f.rows}
          getRowId={(p) => p.id}
          pageSize={50}
          mark={(p) => <ProjectIcon project={p} className="size-5" />}
          actions={actions}
          onRowClick={(p) => void navigate(settingsFormPath("projects", p.id))}
          emptyIcon={<FolderIcon />}
          emptyMessage="Nothing matches."
          filtering={f.filtering}
        />
      )}
    </>
  )
}

export function ProjectFormPage() {
  const { entryId } = useParams()
  const navigate = useNavigate()
  const { settings } = useSettingsPage()
  const invalidate = useInvalidateCatalog()
  const projects = useProjects()
  const project = entryId === "new" ? null : projects.find((item) => item.id === entryId)
  if (entryId !== "new" && !project) return <Navigate to={settingsPath("projects")} replace />
  return (
    <ProjectForm
      project={project ?? null}
      settings={settings}
      onDone={async (saved) => {
        if (saved) await invalidate("projects")
        void navigate(settingsPath("projects"))
      }}
    />
  )
}

export function ProjectForm({
  project,
  settings,
  onDone,
  dialog = false,
}: {
  project: Project | null
  settings: ServerSettings
  /** The saved row, so a caller that opened this to *pick* a project can
      select what it just made; null when the form was cancelled. */
  onDone: (saved: Project | null) => void
  /** Drawn inside a dialog rather than as a settings route: the page header is
      the dialog's own, and the sections that need a saved id (helpers,
      knowledge) have nothing to say about a project being created. */
  dialog?: boolean
}) {
  const [form, setForm] = React.useState(() => ({
    name: project?.name ?? "",
    cwd: project?.cwd ?? "",
    spaceIds: project?.spaceIds ?? [],
    description: project?.description ?? "",
    logoUrl: project?.logoUrl ?? "",
    previewUrl: project?.previewUrl ?? "",
    voiceProvider: project?.defaults?.voiceProvider ?? "",
  }))
  const qc = useQueryClient()
  const [busy, setBusy] = React.useState(false)
  const [saveError, setSaveError] = React.useState<InlineError | null>(null)
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))
  /* The spaces this project is filed under — one or several. A new project
     defaults to the space you are in ("make a project while working in Work"
     means a project in Work), and the picker is what moves an existing one
     between spaces or adds it to more. A project is always in at least one, so
     the last box cannot be unticked; an untouched new project shows the space
     it will land in as ticked. */
  const { spaces, id: activeSpaceId } = useActiveSpace()
  /* The at-a-glance strip reads the same cached queries the sections below
     draw from, so it costs no request of its own. */
  const ruleCount = useProjectRules(project?.id ?? null).length
  const knowledgeCount = useProjectKnowledge(project?.id ?? null).data?.length

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setSaveError(null)
    try {
      const payload = {
        name: form.name,
        // Drilling through the path picker leaves a trailing slash behind.
        cwd: form.cwd === "/" ? form.cwd : form.cwd.replace(/\/+$/, ""),
        description: form.description.trim() || null,
        logoUrl: form.logoUrl.trim(),
        previewUrl: form.previewUrl.trim(),
        spaceIds: form.spaceIds.length > 0 ? form.spaceIds : activeSpaceId ? [activeSpaceId] : undefined,
      }
      const saved = project
        ? await api<Project>(settings, `/api/projects/${project.id}`, { method: "PUT", body: JSON.stringify(payload) })
        : await api<Project>(settings, "/api/projects", { method: "POST", body: JSON.stringify(payload) })
      onDone(saved)
    } catch (err) {
      setSaveError(captureError(err, "Couldn't save the project"))
      setBusy(false)
    }
  }

  /* Name and space are short, the path and notes want the whole width, and the
     rest take the row — the pair answers to the panel (`@panel-sm`), so the
     dialog (no panel above it) stays one column. A card is not a container and does not clip: the path picker's popup hangs below its field. */
  const fields = (
    <div className="grid gap-4 @panel-sm:grid-cols-2">
        <div className="@panel-sm:col-span-2">
          <Field label="Name">
            <Input value={form.name} onChange={(e) => set({ name: e.target.value })} required />
          </Field>
        </div>
        {/* The scope above the project: which spaces this one is filed under,
            and so where you find it. A project can be in several. */}
        {spaces.length > 0 && (
          <div className="@panel-sm:col-span-2">
            <Field label="Spaces" hint="Where this project is filed. Switching spaces switches the projects, and their threads, the sidebar shows. A project can be in more than one.">
              <Picker
                items={spaces}
                selected={form.spaceIds.length > 0 ? form.spaceIds : activeSpaceId ? [activeSpaceId] : []}
                onToggle={(ids) => ids.length > 0 && set({ spaceIds: ids })}
                subtitle={() => null}
                empty="No spaces yet."
              />
            </Field>
          </div>
        )}
        <div className="@panel-sm:col-span-2">
          <Field label="Working directory" hint="Path on the server, not on this device.">
            <PathInput
              value={form.cwd}
              onValueChange={(cwd) => set({ cwd })}
              settings={settings}
              placeholder="/home/me/project"
              required
            />
          </Field>
        </div>
        <div className="@panel-sm:col-span-2">
          <Field label="Description" hint="Optional — notes about what this workspace is for.">
            <Textarea
              value={form.description}
              onChange={(e) => set({ description: e.target.value })}
              rows={2}
              placeholder="What runs here, and why."
            />
          </Field>
        </div>
        <div className="@panel-sm:col-span-2">
          <Field label="Logo URL" hint="Optional — shown next to this project in the sidebar and pickers. Empty shows the project's initial.">
            <div className="flex items-center gap-2">
              {/* Live preview — the same component the sidebar renders. */}
              <ProjectIcon project={{ name: form.name, logoUrl: form.logoUrl }} className="size-5" />
              <Input
                onChange={(e) => set({ logoUrl: e.target.value })}
                value={form.logoUrl.startsWith("data:") ? "" : form.logoUrl}
                placeholder={form.logoUrl.startsWith("data:") ? "Uploaded image" : "https://example.com/logo.svg"}
                className="min-w-0 flex-1 font-mono text-xs"
              />
              <LogoUpload value={form.logoUrl} onChange={(logoUrl) => set({ logoUrl })} />
            </div>
          </Field>
        </div>
        <div className="@panel-sm:col-span-2">
          <Field
            label="Preview URL"
            hint="The project's dev server, as the Browser panel opens it. Reachable from this device: localhost on the server's own machine, a LAN or tunnel address from a phone. The dev server must be running — mark a helper command below and the panel can start it for you."
          >
            <div className="flex items-center gap-2">
              <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />
              <Input
                value={form.previewUrl}
                onChange={(e) => set({ previewUrl: e.target.value })}
                placeholder="http://localhost:5173"
                className="min-w-0 flex-1 font-mono text-xs"
              />
            </div>
          </Field>
        </div>
        {/* Written through the defaults door at once, like the composer's picks;
            a project being created has no row to write to yet. */}
        {project && (
          <div className="@panel-sm:col-span-2">
            <VoiceBackendField
              value={form.voiceProvider}
              onChange={(voiceProvider) => {
                set({ voiceProvider })
                saveProjectDefaults(settings, qc, project.id, { voiceProvider })
              }}
            />
          </div>
        )}
    </div>
  )
  const actions = <FormActions busy={busy} onCancel={() => onDone(null)} error={saveError} />

  /* A dialog has no room for a rail and nothing to jump to: just the one card. */
  if (dialog) {
    return (
      <PageForm onSubmit={save}>
        <FormSection label="Workspace">{fields}</FormSection>
        {actions}
      </PageForm>
    )
  }

  /* A page: the kit's form shell — a jump rail beside the sections where the
     panel is wide, above them where it is not. The save bar belongs to the
     workspace form alone (the sections below carry forms of their own), so it
     is the column's, not the page's: the rail is not under it. */
  return (
    <>
      <FormPageHeader
        title={project ? `Edit ${project.name}` : "New project"}
        description="Configure the workspace, linked capabilities, and project knowledge."
        onBack={() => onDone(null)}
      />
      <FormShell sections={SECTIONS}>
        {project && (
          <StatStrip
            stats={[
              { label: "Rules", value: ruleCount },
              { label: "Helpers", value: project.helpers?.length ?? 0 },
              { label: "Knowledge", value: knowledgeCount ?? "—" },
              { label: "Preview", value: project.previewUrl ? "Set" : "None", tone: project.previewUrl ? "ok" : "default" },
            ]}
          />
        )}
        <PageForm onSubmit={save} className="@panel-lg:[&>footer]:mx-0 @panel-lg:[&>footer]:px-0">
          <FormSection id="workspace" label="Workspace" hint="Name, where it lives on the server, and how it looks in the sidebar.">
            {fields}
          </FormSection>
          {actions}
        </PageForm>
        <RulesSection project={project} />
        <HelpersSection project={project} />
        <KnowledgeSection project={project} />
      </FormShell>
    </>
  )
}

const SECTIONS = [
  { id: "workspace", label: "Workspace" },
  { id: "rules", label: "Rules" },
  { id: "helpers", label: "Helper commands" },
  { id: "knowledge", label: "Knowledge base" },
]

/** A form block whose content is a table: the kit's heading without the card
    `FormSection` would wrap it in, because the table is already a surface and
    a frame inside a frame is two identical borders. */
function Block({
  id,
  label,
  hint,
  action,
  children,
}: {
  id: string
  label: string
  hint: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section id={id} data-kit-block className="mt-8 scroll-mt-[calc(var(--app-header-h)+1rem)]">
      <SectionHead label={label} hint={hint} action={action} />
      <div className="min-w-0 space-y-3">{children}</div>
    </section>
  )
}

const Count = ({ n }: { n: number }) => <Badge variant="secondary" className="tabular-nums">{n}</Badge>

/**
 * Standing instructions for threads started in this project, spawned after the
 * global rules (server/src/rules.ts). The same rows and editing as the global
 * Rules page, scoped by `projectId`. Only for an existing project.
 */
function RulesSection({ project }: { project: Project | null }) {
  const projectId = project?.id ?? null
  const rules = useProjectRules(projectId)
  const createRule = useCreateRule()
  const updateRule = useUpdateRule()
  const deleteRule = useDeleteRule()
  const [error, setError] = React.useState<InlineError | null>(null)

  const add = () => {
    if (!projectId) return
    createRule.mutate({ projectId, title: "New rule", content: "" }, {
      onError: (err) => setError(captureError(err, "Couldn't add the rule")),
    })
  }

  const updateField = (id: string, field: "title" | "content", value: string) => {
    updateRule.mutate({ id, [field]: value }, {
      onError: (err) => setError(captureError(err, "Couldn't update the rule")),
    })
  }

  const remove = (id: string) => {
    deleteRule.mutate({ id }, {
      onError: (err) => setError(captureError(err, "Couldn't delete the rule")),
    })
  }

  return (
    <FormSection
      id="rules"
      label="Rules"
      hint="Standing instructions for every thread started in this project, after the global rules."
      action={projectId ? <Count n={rules.length} /> : undefined}
    >
      {!projectId ? (
        <p className="text-xs text-muted-foreground">Save the project first to manage its rules.</p>
      ) : (
        <div className="space-y-3">
          <ErrorNote error={error} />
          {rules.length === 0 ? (
            <Empty>No rules for this project yet — add one below.</Empty>
          ) : (
            rules.map((rule) => (
              <div key={rule.id} className={cn("space-y-2 p-3", INSET)}>
                <div className="flex items-center gap-2">
                  <Input
                    value={rule.title}
                    onChange={(e) => updateField(rule.id, "title", e.target.value)}
                    placeholder="Rule title"
                    className="font-medium"
                  />
                  <Button type="button" variant="ghost" size="icon-sm" className="shrink-0 pointer-coarse:size-11" title="Delete rule" aria-label={`Delete rule ${rule.title}`} onClick={() => remove(rule.id)}>
                    <Trash2 />
                  </Button>
                </div>
                <Textarea
                  value={rule.content}
                  onChange={(e) => updateField(rule.id, "content", e.target.value)}
                  rows={3}
                  className="font-mono text-xs"
                  placeholder="Standing instruction for the agent…"
                />
              </div>
            ))
          )}
          <div className="flex justify-end">
            <Button type="button" size="sm" className="pointer-coarse:h-11" onClick={add} disabled={createRule.isPending}>
              <Plus /> Add rule
            </Button>
          </div>
        </div>
      )}
    </FormSection>
  )
}

/**
 * Helper commands a person runs against this workspace from the header
 * dropdown ("Restart server", "Run migrations", "Seed database").
 *
 * Each is a name and a shell command run in the project's cwd. Only for an
 * existing project — a new form has no id yet, so there is nowhere to attach.
 */
function HelpersSection({ project }: { project: Project | null }) {
  const projectId = project?.id ?? null
  const helpers = project?.helpers ?? []
  const deleteHelperMutation = useDeleteHelper()
  /* The helper in the form below: one being edited, or null for a new one.
     The form is keyed on it, so switching remounts it with that row's fields. */
  const [editing, setEditing] = React.useState<HelperCommand | null>(null)

  const remove = async (helperId: string) => {
    if (!projectId) return
    try {
      await deleteHelperMutation.mutateAsync({ projectId, helperId })
      if (editing?.id === helperId) setEditing(null)
    } catch (err) {
      reportError(err, "Couldn't delete helper command")
    }
  }

  /* Stable columns and actions: the table memoises its rows against them, and
     `remove` closes over the row being edited. */
  /* The form sits below the table: Edit brings it into view. */
  const formRef = React.useRef<HTMLDivElement>(null)
  const edit = (h: HelperCommand) => {
    setEditing(h)
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }))
  }
  const live = React.useRef({ remove, edit })
  React.useLayoutEffect(() => {
    live.current = { remove, edit }
  })
  const actions = React.useMemo<TableAction<HelperCommand>[]>(
    () => [
      { id: "edit", label: "Edit", icon: <Pencil />, onClick: (h) => live.current.edit(h) },
      { id: "delete", label: "Delete", icon: <Trash2 />, tone: "danger", onClick: (h) => void live.current.remove(h.id) },
    ],
    [],
  )

  const f = useTableFilter(helpers, {
    text: (h) => `${h.name} ${h.command} ${h.description ?? ""} ${h.cwd ?? ""}`,
    placeholder: "Search helpers...",
    fields: [{ id: "behaviour", label: "Behaviour", of: (h) => (h.preview ? "Preview" : h.confirm ? "Asks first" : "Plain") }],
  })

  return (
    <Block
      id="helpers"
      label="Helper commands"
      hint="Commands you can run from the project page’s header dropdown, in the project’s working directory."
      action={projectId ? <Count n={helpers.length} /> : undefined}
    >
      {!projectId ? (
        <p className="text-xs text-muted-foreground">Save the project first to manage helper commands.</p>
      ) : (
        <>
          {helpers.length === 0 ? (
            <Empty>No helper commands yet — add one below.</Empty>
          ) : (
            <DataTable
              columns={HELPER_COLUMNS}
              data={f.rows}
              filtering={f.filtering}
              getRowId={(h) => h.id}
              pageSize={25}
              maxHeight={420}
              mark={() => <SquareTerminal />}
              actions={actions}
              emptyIcon={<SquareTerminal />}
              emptyMessage={f.narrowed ? "Nothing matches." : "No helper commands."}
            />
          )}
          <div ref={formRef} className={cn("space-y-3 p-3", INSET)}>
            <div className="text-xs font-medium">
              {editing ? "Edit helper command" : "New helper command"}
            </div>
            <HelperForm
              key={editing?.id ?? "new"}
              projectId={projectId}
              initial={editing ?? undefined}
              onDone={() => setEditing(null)}
              onCancel={editing ? () => setEditing(null) : undefined}
            />
          </div>
        </>
      )}
    </Block>
  )
}

const HELPER_COLUMNS: ColumnDef<HelperCommand, unknown>[] = [
  {
    id: "helper",
    header: "Helper",
    meta: { title: true, className: "min-w-56" },
    cell: ({ row }) => (
      <TitleCell
        title={row.original.name}
        subtitle={<span className="font-mono text-[11px]" title={row.original.command}>{row.original.command}</span>}
      />
    ),
  },
  {
    id: "notes",
    header: "Notes",
    meta: { className: "hidden @panel-md:table-cell max-w-56" },
    cell: ({ row }) => <span className="block truncate text-muted-foreground">{row.original.description}</span>,
  },
  {
    id: "cwd",
    header: "Runs in",
    meta: { className: "hidden @panel-lg:table-cell max-w-40" },
    cell: ({ row }) =>
      row.original.cwd ? <span className="block truncate font-mono text-xs text-muted-foreground">{row.original.cwd}</span> : null,
  },
  {
    id: "flags",
    header: "Behaviour",
    meta: { align: "end" },
    cell: ({ row }) => (
      <span className="inline-flex flex-wrap items-center justify-end gap-1">
        {row.original.preview && (
          <Badge variant="secondary" className="gap-1 text-primary">
            <GlobeIcon className="size-3" /> preview
          </Badge>
        )}
        {row.original.confirm && <Badge variant="secondary">asks first</Badge>}
      </span>
    ),
  },
]

/**
 * The project's knowledge base, seen and edited by a person.
 *
 * The agent reaches the same `knowledge` table through its `knowledge` MCP
 * server; this is the REST half (see knowledge-api.ts) so the user can review
 * and curate what the project has learned. Only for an existing project — a new
 * `ProjectForm` has no `project_id` yet, so there is nothing to load and the rows
 * would have nowhere to attach.
 */
function KnowledgeSection({ project }: { project: Project | null }) {
  /* The cache owns the read (per project, keyed); add/delete invalidate it,
     which is the refresh. */
  const projectId = project?.id ?? null
  const { data: entries, error: queryError, refetch } = useProjectKnowledge(projectId)
  const rows = entries ?? []
  const addEntry = useAddKnowledge()
  const deleteKnowledgeRow = useDeleteKnowledge()
  const [busy, setBusy] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [title, setTitle] = React.useState("")
  const [content, setContent] = React.useState("")
  const [tags, setTags] = React.useState("")
  const error = queryError ? errorText(queryError) : null

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!projectId || saving) return
    setSaving(true)
    try {
      await addEntry.mutateAsync({
        projectId,
        body: {
          title: title.trim(),
          content: content.trim(),
          tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        },
      })
      setTitle("")
      setContent("")
      setTags("")
    } catch (err) {
      reportError(err, "Couldn't add the knowledge entry")
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: string) => {
    if (!projectId || busy) return
    setBusy(true)
    try {
      await deleteKnowledgeRow.mutateAsync({ projectId, id })
    } catch (err) {
      reportError(err, "Couldn't delete the knowledge entry")
    } finally {
      setBusy(false)
    }
  }

  const f = useTableFilter(rows, {
    text: (e) => `${e.title} ${e.content} ${e.tags.join(" ")}`,
    placeholder: "Search knowledge...",
  })
  const live = React.useRef({ remove })
  React.useLayoutEffect(() => {
    live.current = { remove }
  })
  const actions = React.useMemo<TableAction<KnowledgeEntry>[]>(
    () => [
      {
        id: "delete",
        label: "Delete",
        icon: <Trash2 />,
        tone: "danger",
        onClick: (e) => void live.current.remove(e.id),
      },
    ],
    [],
  )

  return (
    <Block
      id="knowledge"
      label="Knowledge base"
      hint="What the project has learned — the agent reads and writes the same entries."
      action={
        projectId ? (
          <>
            <Count n={rows.length} />
            <Button type="button" variant="ghost" size="sm" className="pointer-coarse:h-11" onClick={() => void refetch()} disabled={busy}>
              <RefreshCwIcon /> Refresh
            </Button>
          </>
        ) : undefined
      }
    >
      {!projectId ? (
        <p className="text-xs text-muted-foreground">Save the project first to manage its knowledge base.</p>
      ) : (
        <>
          {error && (
            <Notice tone="error">
              {error}{" "}
              <button type="button" className="underline" onClick={() => void refetch()}>
                Try again
              </button>
            </Notice>
          )}
          {rows.length === 0 ? (
            <Empty>No knowledge entries yet — add the first one below.</Empty>
          ) : (
            <DataTable
              columns={KNOWLEDGE_COLUMNS}
              data={f.rows}
              getRowId={(e) => e.id}
              pageSize={25}
              maxHeight={420}
              mark={() => <BookOpenIcon />}
              actions={actions}
              emptyIcon={<BookOpenIcon />}
              emptyMessage="Nothing matches."
              filtering={f.filtering}
            />
          )}
          <form onSubmit={add} className={cn("space-y-4 p-3", INSET)}>
            <div className="grid gap-4 @panel-sm:grid-cols-2">
              <Field label="Title">
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What this is about" required />
              </Field>
              <Field label="Tags" hint="Comma-separated, optional.">
                <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="api, auth, deploy" />
              </Field>
            </div>
            <Field label="Content">
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={3}
                placeholder="The reference material, notes or prose to remember."
                required
              />
            </Field>
            <div className="flex justify-end">
              <Button type="submit" size="sm" className="pointer-coarse:h-11" disabled={saving || busy}>
                <Plus /> {saving ? "Adding…" : "Add entry"}
              </Button>
            </div>
          </form>
        </>
      )}
    </Block>
  )
}

const KNOWLEDGE_COLUMNS: ColumnDef<KnowledgeEntry, unknown>[] = [
  {
    id: "entry",
    header: "Entry",
    meta: { title: true, className: "min-w-56" },
    cell: ({ row }) => <TitleCell title={row.original.title} subtitle={row.original.content} />,
  },
  {
    id: "tags",
    header: "Tags",
    meta: { className: "hidden @panel-md:table-cell max-w-48" },
    cell: ({ row }) => (
      <span className="block truncate text-xs text-muted-foreground">{row.original.tags.join(", ")}</span>
    ),
  },
]
