import * as React from "react"
import { FolderIcon, Pencil, Plus, Trash2 } from "lucide-react"
import { reportError } from "@/lib/errors"
import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { useConfirm } from "@/components/confirm-dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { PathInput } from "@/components/ui/suggesting-input"
import { api, type Project, type ServerSettings } from "@/lib/settings"
import { useStore } from "@/lib/store"
import { PageHeader, Group, Row, EmptyCard, Field, FormActions, FormSection, Picker } from "./primitives"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"

export function ProjectsPage() {
  const { settings, actions } = useSettingsPage()
  const meta = sectionMeta("projects")
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
      reportError(err, "Couldn't delete the project")
    }
  }

  const newButton = (
    <Button size="lg" onClick={() => setEditing("new")}>
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
                  {project.commandIds.length > 0 && <span>· {project.commandIds.length} commands</span>}
                  {project.description && (
                    <span className="basis-full truncate break-normal">{project.description}</span>
                  )}
                </span>
              }
            >
              <Button variant="ghost" size="icon-lg" title="Edit" onClick={() => setEditing(project)}>
                <Pencil />
              </Button>
              <Button variant="ghost" size="icon-lg" title="Delete" onClick={() => remove(project)}>
                <Trash2 />
              </Button>
            </Row>
          ))}
        </Group>
      )}
      <ResponsiveDialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <ResponsiveDialogContent className="sm:max-w-xl">
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
    description: project?.description ?? "",
    mcpServerIds: project?.mcpServerIds ?? [],
    skillIds: project?.skillIds ?? [],
    commandIds: project?.commandIds ?? [],
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
        mcpServerIds: form.mcpServerIds,
        skillIds: form.skillIds,
        commandIds: form.commandIds,
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
    <form onSubmit={save} className="space-y-4">
      <ResponsiveDialogHeader>
        <ResponsiveDialogTitle>{project ? `Edit ${project.name}` : "New project"}</ResponsiveDialogTitle>
      </ResponsiveDialogHeader>
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
      </FormSection>
      <FormSection label="Capabilities">
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
        <Field label="Slash commands" hint="Manage the prompts in Settings › Commands.">
          <Picker
            items={state.commands}
            selected={form.commandIds}
            onToggle={(commandIds) => set({ commandIds })}
            subtitle={(c) => `/${c.name}`}
            empty="No commands defined yet."
          />
        </Field>
      </FormSection>
      <FormActions busy={busy} onCancel={() => onDone(false)} />
    </form>
  )
}
