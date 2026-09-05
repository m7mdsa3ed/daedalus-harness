import * as React from "react"
import {
  BookOpenIcon,
  FolderIcon,
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
import { ProjectIcon } from "@/components/entity-icon"
import { useConfirm } from "@/components/confirm-dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { PathInput } from "@/components/ui/suggesting-input"
import { api, type HelperCommand, type Project, type ServerSettings } from "@/lib/settings"
import { useInvalidateCatalog, useProjects } from "@/lib/queries/catalog"
import {
  useAddHelper,
  useAddKnowledge,
  useDeleteHelper,
  useDeleteKnowledge,
  useProjectKnowledge,
  useUpdateHelper,
} from "@/lib/queries/surfaces"
import { FormPageHeader, PageForm, PageHeader, Group, Row, EmptyCard, Field, FormActions, FormSection } from "./primitives"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"
import { projectPath, settingsFormPath, settingsPath } from "@/lib/router"

export function ProjectsPage() {
  const { settings } = useSettingsPage()
  const invalidate = useInvalidateCatalog()
  const meta = sectionMeta("projects")
  const projects = useProjects()
  const confirm = useConfirm()
  const navigate = useNavigate()

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
        <Group>
          {projects.map((project) => (
            <Row
              key={project.id}
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
            </Row>
          ))}
        </Group>
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
}: {
  project: Project | null
  settings: ServerSettings
  onDone: (saved: boolean) => void
}) {
  const [form, setForm] = React.useState(() => ({
    name: project?.name ?? "",
    cwd: project?.cwd ?? "",
    description: project?.description ?? "",
    logoUrl: project?.logoUrl ?? "",
    devCommand: project?.devCommand ?? "",
  }))
  const [busy, setBusy] = React.useState(false)
  const [saveError, setSaveError] = React.useState<InlineError | null>(null)
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

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
        devCommand: form.devCommand.trim() || null,
        /* Round-tripped, not edited: the template a project came from is a
           record, and a PUT that left it out would null it. */
        templateId: project?.templateId ?? null,
      }
      if (project) {
        await api(settings, `/api/projects/${project.id}`, { method: "PUT", body: JSON.stringify(payload) })
      } else {
        await api(settings, "/api/projects", { method: "POST", body: JSON.stringify(payload) })
      }
      onDone(true)
    } catch (err) {
      setSaveError(captureError(err, "Couldn't save the project"))
      setBusy(false)
    }
  }

  return (
    <>
      <FormPageHeader
        title={project ? `Edit ${project.name}` : "New project"}
        description="Configure the workspace, linked capabilities, and project knowledge."
        onBack={() => onDone(false)}
      />
      <PageForm onSubmit={save}>
      <FormSection label="Workspace">
        <Field label="Name">
          <Input value={form.name} onChange={(e) => set({ name: e.target.value })} required />
        </Field>
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
        <Field
          label="Dev command"
          hint="Optional — what the harness runs to serve the app in the preview panel. It gets PORT and BASE_PATH in its environment; empty means no preview."
        >
          <Input
            value={form.devCommand}
            onChange={(e) => set({ devCommand: e.target.value })}
            placeholder="pnpm dev"
            className="font-mono text-xs"
            spellCheck={false}
          />
        </Field>
        <Field label="Logo URL" hint="Optional — shown next to this project in the sidebar and pickers. Empty shows the project's initial.">
          <div className="flex items-center gap-2">
            {/* Live preview — the same component the sidebar renders. */}
            <ProjectIcon project={{ name: form.name, logoUrl: form.logoUrl }} className="size-5" />
            <Input
              value={form.logoUrl}
              onChange={(e) => set({ logoUrl: e.target.value })}
              placeholder="https://example.com/logo.svg"
              className="font-mono text-xs"
            />
          </div>
        </Field>
      </FormSection>
      <FormActions busy={busy} onCancel={() => onDone(false)} error={saveError} />
      </PageForm>
      <div className="mt-8 border-t pt-6 space-y-8">
        <HelpersSection project={project} />
        <KnowledgeSection project={project} />
      </div>
    </>
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
  const addHelperMutation = useAddHelper()
  const updateHelperMutation = useUpdateHelper()
  const deleteHelperMutation = useDeleteHelper()

  const [saving, setSaving] = React.useState(false)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [name, setName] = React.useState("")
  const [command, setCommand] = React.useState("")

  const startEdit = (helper: HelperCommand) => {
    setEditingId(helper.id)
    setName(helper.name)
    setCommand(helper.command)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setName("")
    setCommand("")
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!projectId || saving) return
    const trimmedName = name.trim()
    const trimmedCmd = command.trim()
    if (!trimmedName || !trimmedCmd) return

    setSaving(true)
    try {
      if (editingId) {
        await updateHelperMutation.mutateAsync({
          projectId,
          helperId: editingId,
          input: { name: trimmedName, command: trimmedCmd },
        })
      } else {
        await addHelperMutation.mutateAsync({
          projectId,
          input: { name: trimmedName, command: trimmedCmd },
        })
      }
      cancelEdit()
    } catch (err) {
      reportError(err, editingId ? "Couldn't update helper command" : "Couldn't add helper command")
    } finally {
      setSaving(false)
    }
  }

  const remove = async (helperId: string) => {
    if (!projectId) return
    try {
      await deleteHelperMutation.mutateAsync({ projectId, helperId })
      if (editingId === helperId) cancelEdit()
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
            <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
              No helper commands yet — add one below.
            </p>
          ) : (
            <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border">
              {helpers.map((h) => (
                <li key={h.id} className="flex items-start gap-3 px-3 py-2">
                  <SquareTerminal className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium break-words">{h.name}</div>
                    <div className="mt-0.5 font-mono text-xs break-all text-muted-foreground">
                      {h.command}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    title="Edit"
                    disabled={saving}
                    onClick={() => startEdit(h)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    title="Delete"
                    disabled={saving}
                    onClick={() => void remove(h.id)}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={save} className="space-y-3 rounded-lg border p-3">
            <div className="text-xs font-medium">
              {editingId ? "Edit helper command" : "New helper command"}
            </div>
            <Field label="Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Restart server, Run migrations, Seed database"
                required
              />
            </Field>
            <Field label="Command" hint="Run with the shell in the project's cwd. Up to 2 minutes.">
              <Input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npm run db:migrate"
                className="font-mono text-xs"
                spellCheck={false}
                required
              />
            </Field>
            <div className="flex justify-end gap-2">
              {editingId && (
                <Button type="button" variant="ghost" size="sm" onClick={cancelEdit} disabled={saving}>
                  Cancel
                </Button>
              )}
              <Button type="submit" size="sm" disabled={saving}>
                <Plus /> {saving ? "Saving…" : editingId ? "Save changes" : "Add command"}
              </Button>
            </div>
          </form>
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
            <p className="rounded-lg border border-destructive/30 px-3 py-2 text-xs text-destructive">
              {error}{" "}
              <button type="button" className="underline" onClick={() => void refetch()}>
                Try again
              </button>
            </p>
          )}
          {rows.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
              No knowledge entries yet — add the first one below.
            </p>
          ) : (
            <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border">
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
          <form onSubmit={add} className="space-y-4 rounded-lg border p-3">
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
