import * as React from "react"
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core"
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  BookOpenIcon,
  FolderIcon,
  GripVertical,
  GlobeIcon,
  PanelsTopLeft,
  Pencil,
  PlayIcon,
  Plus,
  RefreshCwIcon,
  SquareTerminal,
  Trash2,
} from "lucide-react"
import { Navigate, useNavigate, useParams } from "react-router"
import { captureError, reportError, type InlineError, errorText } from "@/lib/errors"
import { Button } from "@/components/ui/button"
import { Empty } from "@/components/empty"
import { ProjectIcon } from "@/components/entity-icon"
import { Notice } from "@/components/notice"
import { useConfirm } from "@/components/confirm-dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { PathInput } from "@/components/ui/suggesting-input"
import { api, type HelperCommand, type Project, type ServerSettings } from "@/lib/settings"
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
import { FormPageHeader, PageForm, PageHeader, Group, Row, EmptyCard, Field, FormActions, FormSection, INSET, LogoUpload } from "./primitives"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"
import { projectPath, settingsFormPath, settingsPath } from "@/lib/router"
import { HelperForm } from "@/components/helper-form"

export function ProjectsPage() {
  const { settings } = useSettingsPage()
  const invalidate = useInvalidateCatalog()
  const meta = sectionMeta("projects")
  const projects = useProjects()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const reorder = useReorderProjects()

  /* The dragged arrangement is drawn immediately and the server is told; the
     local copy is dropped once the refetched list agrees with it, so the row
     never jumps back to the old order for a frame while the write is in
     flight. A failed write leaves the stale arrangement on screen only until
     the list refreshes — the error is what says it did not take. */
  const [dragged, setDragged] = React.useState<Project[] | null>(null)
  const list = dragged ?? projects
  const ids = projects.map((p) => p.id).join()
  React.useEffect(() => {
    setDragged((d) => (d && d.map((p) => p.id).join() === ids ? null : d))
  }, [ids])

  /* A grip is its own target, so there is no swipe-versus-drag ambiguity to
     resolve and one pointer sensor covers mouse and touch alike. */
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const from = list.findIndex((p) => p.id === active.id)
    const to = list.findIndex((p) => p.id === over.id)
    if (from < 0 || to < 0) return
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

  const newButton = (
    <Button onClick={() => void navigate(settingsFormPath("projects"))}>
      <Plus className="size-4" /> New project
    </Button>
  )

  return (
    <>
      <PageHeader meta={meta} action={newButton} />
      {projects.length === 0 ? (
        <EmptyCard
          icon={FolderIcon}
          text="No projects yet — a thread needs one to know where to run."
          action={newButton}
        />
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={list.map((p) => p.id)} strategy={verticalListSortingStrategy}>
            <Group label={`${list.length} project${list.length === 1 ? "" : "s"}`}>
              {list.map((project) => (
                <SortableProjectRow key={project.id} project={project}>
                  {/* The overview is the project as a *place* — its threads, its
                      numbers — where this page is the project as a record. */}
                  <Button variant="ghost" size="icon-lg" title="Open overview" onClick={() => void navigate(projectPath(project.id))}>
                    <PanelsTopLeft />
                  </Button>
                  <Button variant="ghost" size="icon-lg" title="Edit" onClick={() => void navigate(settingsFormPath("projects", project.id))}>
                    <Pencil />
                  </Button>
                  <Button variant="ghost" size="icon-lg" title="Delete" onClick={() => remove(project)}>
                    <Trash2 />
                  </Button>
                </SortableProjectRow>
              ))}
            </Group>
          </SortableContext>
        </DndContext>
      )}
    </>
  )
}

/** One project as a draggable row. The wrapper is what moves; only the grip
    starts a drag, so every button in the row still takes a plain click. */
function SortableProjectRow({ project, children }: { project: Project; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.id,
  })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "relative z-10 bg-background opacity-90 shadow-lg" : undefined}
    >
      <Row
        handle={
          <button
            type="button"
            className="mt-0.5 shrink-0 cursor-grab touch-none text-muted-foreground hover:text-foreground"
            aria-label={`Reorder ${project.name}`}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="size-4" />
          </button>
        }
        icon={<ProjectIcon project={project} className="size-4 shrink-0" />}
        title={project.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="font-mono">{project.cwd}</span>
            {project.description && (
              <span className="basis-full truncate break-normal">{project.description}</span>
            )}
          </span>
        }
      >
        {children}
      </Row>
    </div>
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
    spaceId: project?.spaceId ?? "",
    description: project?.description ?? "",
    logoUrl: project?.logoUrl ?? "",
    previewUrl: project?.previewUrl ?? "",
  }))
  const [busy, setBusy] = React.useState(false)
  const [saveError, setSaveError] = React.useState<InlineError | null>(null)
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))
  /* The space this project is filed under. A new project defaults to the space
     you are in — "make a project while working in Work" means a project in
     Work" — and the picker is what moves an existing one between spaces. */
  const { spaces, id: activeSpaceId } = useActiveSpace()

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
        spaceId: form.spaceId || activeSpaceId || undefined,
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

  return (
    <>
      {!dialog && (
        <FormPageHeader
          title={project ? `Edit ${project.name}` : "New project"}
          description="Configure the workspace, linked capabilities, and project knowledge."
          onBack={() => onDone(null)}
        />
      )}
      <PageForm onSubmit={save}>
      <FormSection label="Workspace">
        <Field label="Name">
          <Input value={form.name} onChange={(e) => set({ name: e.target.value })} required />
        </Field>
        {/* The scope above the project: which space this one is filed under, and
            so which one you find it in. Moved here rather than created on — a
            project is filed once and repointed when the work moves. */}
        {spaces.length > 0 && (
          <Field label="Space" hint="Where this project is filed. Switching spaces switches the projects, and their threads, the sidebar shows.">
            <Select
              value={form.spaceId || activeSpaceId || undefined}
              onValueChange={(value) => set({ spaceId: value ?? "" })}
            >
              <SelectTrigger className="h-9 w-full @panel-sm:w-56">
                <SelectValue>
                  {spaces.find((space) => space.id === (form.spaceId || activeSpaceId))?.name ?? "Pick a space"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {spaces.map((space) => (
                  <SelectItem key={space.id} value={space.id}>
                    {space.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
        <Field label="Working directory" hint="Path on the server, not on this device.">
          <PathInput
            value={form.cwd}
            onValueChange={(cwd) => set({ cwd })}
            settings={settings}
            placeholder="/home/me/project"
            required
          />
        </Field>
        <Field label="Description" hint="Optional — notes about what this workspace is for.">
          <Textarea
            value={form.description}
            onChange={(e) => set({ description: e.target.value })}
            rows={2}
            placeholder="What runs here, and why."
          />
        </Field>
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
              className="font-mono text-xs"
            />
          </div>
        </Field>
      </FormSection>
      <FormActions busy={busy} onCancel={() => onDone(null)} error={saveError} />
      </PageForm>
      {!dialog && (
        <div className="mt-8 border-t pt-6 space-y-8">
          <RulesSection project={project} />
          <HelpersSection project={project} />
          <KnowledgeSection project={project} />
        </div>
      )}
    </>
  )
}

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
    <FormSection label="Rules">
      {!projectId ? (
        <p className="text-xs text-muted-foreground">Save the project first to manage its rules.</p>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Standing instructions for every thread started in this project, after the global rules.
          </p>
          {error && <Notice tone="error">{error.text}</Notice>}
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
                  <Button type="button" variant="ghost" size="icon-sm" title="Delete rule" onClick={() => remove(rule.id)}>
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
            <Button type="button" size="sm" onClick={add} disabled={createRule.isPending}>
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

  return (
    <FormSection label="Helper commands">
      {!projectId ? (
        <p className="text-xs text-muted-foreground">Save the project first to manage helper commands.</p>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Commands you can run from the project page&rsquo;s header dropdown. Run in the project&rsquo;s working directory.
          </p>
          {helpers.length === 0 ? (
            <Empty>No helper commands yet — add one below.</Empty>
          ) : (
            <ul className={cn("max-h-64 divide-y divide-border/60 overflow-y-auto", INSET)}>
              {helpers.map((h) => (
                <li key={h.id} className="flex items-start gap-3 px-3 py-2">
                  <SquareTerminal className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium break-words">{h.name}</div>
                    {h.description && (
                      <div className="mt-0.5 text-xs break-words text-muted-foreground">
                        {h.description}
                      </div>
                    )}
                    <div className="mt-0.5 font-mono text-xs break-all text-muted-foreground">
                      {h.command}
                    </div>
                    {(h.cwd || h.confirm || h.preview) && (
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                        {h.cwd && <span className="font-mono">cwd: {h.cwd}</span>}
                        {h.preview && (
                          <span className="inline-flex items-center gap-1 text-primary">
                            <GlobeIcon className="size-3" /> starts the preview
                          </span>
                        )}
                        {h.confirm && <span>asks first</span>}
                      </div>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    title="Edit"
                    onClick={() => setEditing(h)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    title="Delete"
                    onClick={() => void remove(h.id)}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className={cn("space-y-3 p-3", INSET)}>
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
        </div>
      )}
    </FormSection>
  )
}

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

  return (
    <FormSection label="Knowledge base">
      {!projectId ? (
        <p className="text-xs text-muted-foreground">Save the project first to manage its knowledge base.</p>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Field label="Entries">
              <span className="text-xs text-muted-foreground">{rows.length} saved</span>
            </Field>
            <Button type="button" variant="ghost" size="sm" onClick={() => void refetch()} disabled={busy}>
              <RefreshCwIcon /> Refresh
            </Button>
          </div>
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
            <ul className={cn("max-h-64 divide-y divide-border/60 overflow-y-auto", INSET)}>
              {rows.map((entry) => (
                <li key={entry.id} className="flex items-start gap-3 px-3 py-2">
                  <BookOpenIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium break-words">{entry.title}</div>
                    <div className="mt-0.5 line-clamp-2 text-xs break-words text-muted-foreground">{entry.content}</div>
                    {entry.tags.length > 0 && (
                      <div className="mt-1 text-[11px] text-muted-foreground">{entry.tags.join(", ")}</div>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    title="Delete"
                    disabled={busy}
                    onClick={() => void remove(entry.id)}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={add} className={cn("space-y-4 p-3", INSET)}>
            <Field label="Title">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What this is about" required />
            </Field>
            <Field label="Content">
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={3}
                placeholder="The reference material, notes or prose to remember."
                required
              />
            </Field>
            <Field label="Tags" hint="Comma-separated, optional.">
              <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="api, auth, deploy" />
            </Field>
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={saving || busy}>
                <Plus /> {saving ? "Adding…" : "Add entry"}
              </Button>
            </div>
          </form>
        </div>
      )}
    </FormSection>
  )
}
