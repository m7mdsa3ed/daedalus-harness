/* ── Settings › Templates ──
   The library page for project templates: the list, and the form that writes
   one. Modelled on `settings/commands.tsx` — the closest existing form (name /
   description / a long text body) — with the three library pickers the profile
   form uses, because the kit is half of what a template *is*: it says "start
   from this repo" *and* "with these tools".

   Two things it does not share with the other library pages. It keeps its own
   list rather than reading the store, since nothing else in the client needs
   templates loaded on connect; and it therefore draws its own list instead of
   `LibrarySection`, so that a fetch that failed reads as a failure rather than
   as an empty library — the two are the same screen otherwise, told apart only
   by a toast, which is exactly the confusion `captureError`/`ErrorNote` exist
   to stop. The delete copy is its own for the same reason: deleting a template
   unlinks nothing and changes no running thread — a project already made from
   it is a project like any other. */
import * as React from "react"
import { LayoutTemplate, Pencil, Plus, Trash2 } from "lucide-react"
import { Navigate, useNavigate, useParams } from "react-router"
import { ErrorNote } from "@/components/error-note"
import { EntityIcon } from "@/components/entity-icon"
import { useConfirm } from "@/components/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { PickerSkeleton } from "@/components/ui/skeletons"
import { captureError, reportError, type InlineError } from "@/lib/errors"
import { settingsFormPath, settingsPath } from "@/lib/router"
import { mcpSubtitle } from "@/lib/settings"
import {
  createTemplate,
  deleteTemplate,
  listTemplates,
  updateTemplate,
  type Template,
  type TemplateInput,
} from "@/lib/templates"
import { useStore } from "@/lib/store"
import {
  EmptyCard,
  Field,
  FormActions,
  FormPageHeader,
  FormSection,
  Group,
  PageForm,
  PageHeader,
  Picker,
  Row,
} from "./primitives"
import { sectionMeta } from "./sections"

/* ── The API ──
   `lib/templates.ts` is the one module that talks to `/api/templates`; the
   Studio's gallery reads the same calls. They carry their own connection (a
   `loadSettings()` inside, like `lib/workspace/previews.ts`) rather than taking
   the `ServerSettings` the other library pages thread through, which is why
   nothing on this page passes one. `TemplateDef` stays as an alias: the shape
   is the same row, and the name is what the rest of this file was written in. */

/** A row of `project_templates` plus its kit. */
export type TemplateDef = Template

/** What POST/PUT take — every field of the form, none of the row's history. */
export type TemplateFormInput = Required<TemplateInput>

/** The page's own copy of the list. `null` is "not asked yet" — which is a
    spinner, where an error is an error and `[]` is genuinely no templates. */
function useTemplates() {
  const [templates, setTemplates] = React.useState<TemplateDef[] | null>(null)
  const [loadError, setLoadError] = React.useState<InlineError | null>(null)

  const refresh = React.useCallback(async () => {
    try {
      setTemplates(await listTemplates())
      setLoadError(null)
    } catch (err) {
      setLoadError(captureError(err, "Couldn't load the templates"))
      setTemplates([])
    }
  }, [])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  return { templates, loadError, refresh }
}

/** `owner/repo` out of an https or ssh remote, so a card says which starter it
    is rather than a URL that wraps. Anything unrecognised is printed whole. */
function repoLabel(template: TemplateDef): string {
  const url = template.repoUrl.trim()
  const match = /^(?:git@[^:]+:|[a-z+]+:\/\/[^/]+\/)(.+?)(?:\.git)?\/?$/i.exec(url)
  const base = match ? match[1] : url
  const ref = template.repoRef ? `#${template.repoRef}` : ""
  const subdir = template.repoSubdir ? ` · ${template.repoSubdir}` : ""
  return `${base}${ref}${subdir}`
}

const TemplateMark = ({ template }: { template: { name: string; logoUrl?: string } }) => (
  <EntityIcon
    src={template.logoUrl}
    className="size-5"
    fallback={<LayoutTemplate aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
  />
)

export function TemplatesPage() {
  const meta = sectionMeta("templates")
  const navigate = useNavigate()
  const confirm = useConfirm()
  const { templates, loadError, refresh } = useTemplates()

  const remove = async (template: TemplateDef) => {
    if (
      !(await confirm({
        title: `Delete "${template.name}"?`,
        description:
          "The template is removed from the library. Projects already started from it are untouched — a project is a directory and a row, and it stops referring to the template the moment it exists.",
        destructive: true,
        confirmLabel: "Delete",
      }))
    )
      return
    try {
      await deleteTemplate(template.id)
      await refresh()
    } catch (err) {
      reportError(err, "Couldn't delete the template")
    }
  }

  const newButton = (
    <Button onClick={() => void navigate(settingsFormPath(meta.id))}>
      <Plus className="size-4" /> New template
    </Button>
  )

  return (
    <>
      <PageHeader meta={meta} action={newButton} />
      {templates === null ? (
        <div className="py-2">
          <PickerSkeleton rows={3} />
        </div>
      ) : loadError ? (
        <ErrorNote error={loadError} />
      ) : templates.length === 0 ? (
        <EmptyCard icon={meta.icon} text="No templates yet — add one pointing at a starter repo." action={newButton} />
      ) : (
        <Group>
          {templates.map((template) => (
            <Row
              key={template.id}
              icon={<TemplateMark template={template} />}
              title={
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{template.name}</span>
                  {template.runtime && (
                    <Badge variant="secondary" className="shrink-0 font-normal">
                      {template.runtime}
                    </Badge>
                  )}
                </span>
              }
              subtitle={
                <>
                  <span className="font-mono">{repoLabel(template)}</span>
                  {kitLabel(template) && <span className="font-sans"> · {kitLabel(template)}</span>}
                </>
              }
            >
              <Button
                variant="ghost"
                size="icon-lg"
                title="Edit"
                onClick={() => void navigate(settingsFormPath(meta.id, template.id))}
              >
                <Pencil />
              </Button>
              <Button variant="ghost" size="icon-lg" title="Delete" onClick={() => void remove(template)}>
                <Trash2 />
              </Button>
            </Row>
          ))}
        </Group>
      )}
    </>
  )
}

/** "2 MCP · 1 skill" — what the template brings besides the repo, which is the
    half a repo URL does not say. Empty when it brings nothing. */
function kitLabel(template: TemplateDef): string {
  const parts: string[] = []
  if (template.mcpServerIds.length) parts.push(`${template.mcpServerIds.length} MCP`)
  if (template.skillIds.length)
    parts.push(`${template.skillIds.length} skill${template.skillIds.length === 1 ? "" : "s"}`)
  if (template.commandIds.length)
    parts.push(`${template.commandIds.length} command${template.commandIds.length === 1 ? "" : "s"}`)
  return parts.join(" · ")
}

export function TemplateFormPage() {
  const { entryId } = useParams()
  const navigate = useNavigate()
  const { templates, loadError } = useTemplates()
  const creating = entryId === "new"

  // The list is what the form reads an existing row out of, so an edit route
  // waits for it — and says so if it never arrives, rather than redirecting as
  // though the template were gone.
  if (!creating && templates === null) {
    return (
      <div className="py-2">
        <PickerSkeleton rows={4} />
      </div>
    )
  }
  if (!creating && loadError) return <ErrorNote error={loadError} />
  const template = creating ? null : templates?.find((item) => item.id === entryId)
  if (!creating && !template) return <Navigate to={settingsPath("templates")} replace />

  return (
    <TemplateForm
      template={template ?? null}
      onDone={() => void navigate(settingsPath("templates"))}
    />
  )
}

/** Tags are edited as one comma-separated line — they are a handful of short
    words and a line per tag would be a textarea for six characters. */
const parseTags = (value: string) =>
  value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)

function TemplateForm({
  template,
  onDone,
}: {
  template: TemplateDef | null
  onDone: (saved: boolean) => void
}) {
  const { state } = useStore()
  const [form, setForm] = React.useState(() => ({
    name: template?.name ?? "",
    description: template?.description ?? "",
    logoUrl: template?.logoUrl ?? "",
    repoUrl: template?.repoUrl ?? "",
    repoRef: template?.repoRef ?? "",
    repoSubdir: template?.repoSubdir ?? "",
    runtime: template?.runtime ?? "",
    tags: (template?.tags ?? []).join(", "),
    setup: template?.setup ?? "",
    prompt: template?.prompt ?? "",
    mcpServerIds: template?.mcpServerIds ?? [],
    skillIds: template?.skillIds ?? [],
    commandIds: template?.commandIds ?? [],
  }))
  const [busy, setBusy] = React.useState(false)
  const [saveError, setSaveError] = React.useState<InlineError | null>(null)
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setSaveError(null)
    try {
      const input: TemplateFormInput = {
        name: form.name.trim(),
        description: form.description.trim(),
        logoUrl: form.logoUrl.trim(),
        repoUrl: form.repoUrl.trim(),
        // Empty is "the repo's own default" / "the repo root", which the column
        // spells `null` — not an empty string that would render as a ref.
        repoRef: form.repoRef.trim() || null,
        repoSubdir: form.repoSubdir.trim() || null,
        runtime: form.runtime.trim(),
        tags: parseTags(form.tags),
        setup: form.setup,
        prompt: form.prompt,
        mcpServerIds: form.mcpServerIds,
        skillIds: form.skillIds,
        commandIds: form.commandIds,
      }
      await (template ? updateTemplate(template.id, input) : createTemplate(input))
      onDone(true)
    } catch (err) {
      setSaveError(captureError(err, "Couldn't save the template"))
      setBusy(false)
    }
  }

  return (
    <>
      <FormPageHeader
        title={template ? `Edit ${template.name}` : "New template"}
        description="A starting point for a new project: a repo to clone, a kit of tools to bring, and the instruction the agent carries out in the thread's first turn. The harness creates the directory and records the project — it runs none of this itself."
        onBack={() => onDone(false)}
      />
      <PageForm onSubmit={save}>
        <FormSection label="Card">
          <Field label="Name" hint="Shown on the gallery card and used to default the new project's name.">
            <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="TypeScript service" required />
          </Field>
          <Field label="Description" hint="One line about what this starting point is.">
            <Input
              value={form.description}
              onChange={(e) => set({ description: e.target.value })}
              placeholder="Hono + Drizzle service with tests wired up."
            />
          </Field>
          <Field label="Logo URL" hint="Optional — the mark on the card. Empty draws a neutral glyph.">
            <div className="flex items-center gap-2">
              <TemplateMark template={{ name: form.name, logoUrl: form.logoUrl }} />
              <Input
                value={form.logoUrl}
                onChange={(e) => set({ logoUrl: e.target.value })}
                placeholder="https://example.com/logo.svg"
                className="font-mono text-xs"
              />
            </div>
          </Field>
        </FormSection>

        <FormSection label="Starter">
          <Field
            label="Repository"
            hint="Whatever the agent will pass to git clone — an https or ssh remote, or a path on the server."
          >
            <Input
              value={form.repoUrl}
              onChange={(e) => set({ repoUrl: e.target.value })}
              placeholder="https://github.com/owner/starter"
              className="font-mono text-xs"
              required
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Ref" hint="Branch or tag. Empty clones the repo's own default.">
              <Input
                value={form.repoRef}
                onChange={(e) => set({ repoRef: e.target.value })}
                placeholder="main"
                className="font-mono text-xs"
              />
            </Field>
            <Field label="Subdirectory" hint="For a starter that lives inside a monorepo. Empty is the repo root.">
              <Input
                value={form.repoSubdir}
                onChange={(e) => set({ repoSubdir: e.target.value })}
                placeholder="packages/starter"
                className="font-mono text-xs"
              />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Runtime" hint="A free-text label the gallery groups by — node, python, go. Nothing switches on it.">
              <Input
                value={form.runtime}
                onChange={(e) => set({ runtime: e.target.value })}
                placeholder="node"
                className="font-mono text-xs"
              />
            </Field>
            <Field label="Tags" hint="Comma separated. What the gallery filters on.">
              <Input
                value={form.tags}
                onChange={(e) => set({ tags: e.target.value })}
                placeholder="typescript, react, web"
                className="font-mono text-xs"
              />
            </Field>
          </div>
          {parseTags(form.tags).length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {parseTags(form.tags).map((tag) => (
                <Badge key={tag} variant="secondary" className="font-normal">
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </FormSection>

        <FormSection label="What the agent is told">
          <Field
            label="Prompt"
            hint="The body that lands in the composer of the thread the Studio opens — prefilled and editable, and nothing is sent until you send it. {name}, {cwd}, {repo}, {ref} and {subdir} are filled in by the server."
          >
            <Textarea
              value={form.prompt}
              onChange={(e) => set({ prompt: e.target.value })}
              rows={6}
              className="font-mono text-xs"
              placeholder={"Set up {name} in {cwd} from {repo}."}
            />
          </Field>
          <Field
            label="Setup"
            hint="Appended under the prompt: what to do once the repo is there — install, env file, dev command. Same placeholders."
          >
            <Textarea
              value={form.setup}
              onChange={(e) => set({ setup: e.target.value })}
              rows={8}
              className="font-mono text-xs"
              placeholder={"1. git clone {repo} .\n2. pnpm install\n3. Report the dev command."}
            />
          </Field>
        </FormSection>

        {/* The kit — the same three the profile form links, and the reason a
            template is more than a repo URL. These ids ride the draft's picks
            into POST /api/sessions when the first message is sent, so the
            thread spawns with them like any other thread's own picks. */}
        <FormSection label="Kit">
          <Field label="MCP servers" hint="Manage the definitions in Settings › MCP servers.">
            <Picker
              items={state.mcpServers}
              selected={form.mcpServerIds}
              onToggle={(mcpServerIds) => set({ mcpServerIds })}
              subtitle={mcpSubtitle}
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

        <FormActions busy={busy} onCancel={() => onDone(false)} error={saveError} />
      </PageForm>
    </>
  )
}
