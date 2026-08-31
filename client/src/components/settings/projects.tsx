import * as React from "react"
import { BookOpenIcon, FolderIcon, PanelsTopLeft, Pencil, Plus, RefreshCwIcon, Trash2 } from "lucide-react"
import { Navigate, useNavigate, useParams } from "react-router"
import { reportError, describeError } from "@/lib/errors"
import { Button } from "@/components/ui/button"
import { ProjectIcon } from "@/components/entity-icon"
import { useConfirm } from "@/components/confirm-dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { PathInput } from "@/components/ui/suggesting-input"
import { api, type Project, type ServerSettings } from "@/lib/settings"
import { useStore } from "@/lib/store"
import { addKnowledge, deleteKnowledge, listKnowledge, type KnowledgeEntry } from "@/lib/workspace/knowledge-api"
import { FormPageHeader, PageForm, PageHeader, Group, Row, EmptyCard, Field, FormActions, FormSection } from "./primitives"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"
import { projectPath, settingsFormPath, settingsPath } from "@/lib/router"

export function ProjectsPage() {
  const { settings, actions } = useSettingsPage()
  const meta = sectionMeta("projects")
  const { state } = useStore()
  const confirm = useConfirm()
  const navigate = useNavigate()

  const remove = async (project: Project) => {
    if (!(await confirm({ title: `Delete project "${project.name}"?`, destructive: true, confirmLabel: "Delete" })))
      return
    try {
      await api(settings, `/api/projects/${project.id}`, { method: "DELETE" })
      await actions.refreshProjects()
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
      {state.projects.length === 0 ? (
        <EmptyCard icon={FolderIcon} text="No projects yet — a thread needs one to know where to run." action={newButton} />
      ) : (
        <Group>
          {state.projects.map((project) => (
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
  const { settings, actions } = useSettingsPage()
  const { state } = useStore()
  const project = entryId === "new" ? null : state.projects.find((item) => item.id === entryId)
  if (entryId !== "new" && !project) return <Navigate to={settingsPath("projects")} replace />
  return (
    <ProjectForm
      project={project ?? null}
      settings={settings}
      onDone={async (saved) => {
        if (saved) await actions.refreshProjects()
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
  }))
  const [busy, setBusy] = React.useState(false)
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const payload = {
        name: form.name,
        // Drilling through the path picker leaves a trailing slash behind.
        cwd: form.cwd === "/" ? form.cwd : form.cwd.replace(/\/+$/, ""),
        description: form.description.trim() || null,
        logoUrl: form.logoUrl.trim(),
      }
      if (project) {
        await api(settings, `/api/projects/${project.id}`, { method: "PUT", body: JSON.stringify(payload) })
      } else {
        await api(settings, "/api/projects", { method: "POST", body: JSON.stringify(payload) })
      }
      onDone(true)
    } catch (err) {
      reportError(err, "Couldn't save the project")
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
      <FormActions busy={busy} onCancel={() => onDone(false)} />
      </PageForm>
      <div className="mt-8 border-t pt-6">
        <KnowledgeSection project={project} />
      </div>
    </>
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
  const [entries, setEntries] = React.useState<KnowledgeEntry[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [title, setTitle] = React.useState("")
  const [content, setContent] = React.useState("")
  const [tags, setTags] = React.useState("")

  const projectId = project?.id ?? null

  const refresh = React.useCallback(async () => {
    if (!projectId) return
    try {
      setEntries(await listKnowledge(projectId))
      setError(null)
    } catch (err) {
      const { title, detail } = describeError(err)
      setError(detail ? `${title} — ${detail}` : title)
    }
  }, [projectId])

  React.useEffect(() => {
    setEntries([])
    setError(null)
    if (projectId) void refresh()
  }, [projectId, refresh])

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!projectId || saving) return
    setSaving(true)
    try {
      await addKnowledge(projectId, {
        title: title.trim(),
        content: content.trim(),
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      })
      setTitle("")
      setContent("")
      setTags("")
      await refresh()
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
      await deleteKnowledge(projectId, id)
      await refresh()
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
              <span className="text-xs text-muted-foreground">{entries.length} saved</span>
            </Field>
            <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()} disabled={busy}>
              <RefreshCwIcon /> Refresh
            </Button>
          </div>
          {error && (
            <p className="rounded-lg border border-destructive/30 px-3 py-2 text-xs text-destructive">
              {error}{" "}
              <button type="button" className="underline" onClick={() => void refresh()}>
                Try again
              </button>
            </p>
          )}
          {entries.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
              No knowledge entries yet — add the first one below.
            </p>
          ) : (
            <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border">
              {entries.map((entry) => (
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
