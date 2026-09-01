import * as React from "react"
import { BookOpen, Plus, RefreshCwIcon, Trash2 } from "lucide-react"
import { useConfirm } from "@/components/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { ErrorNote } from "@/components/error-note"
import { captureError, reportError, type InlineError } from "@/lib/errors"
import { useStoreSelect } from "@/lib/store"
import {
  addKnowledge,
  deleteKnowledge,
  listAllKnowledge,
  type KnowledgeEntryAcross,
} from "@/lib/workspace/knowledge-api"
import { EmptyCard, Field, Group, PageHeader, Row } from "./primitives"
import { sectionMeta } from "./sections"

const ALL = "__all__"

/* ── Knowledge base ──
   Everything the agents have written through the built-in `knowledge` MCP
   server, across every project, in one place. The per-project view inside a
   project's form still exists; this page is for the question that view cannot
   answer — "what has been learned, anywhere?" — and for pruning it. One
   fetch (`GET /api/knowledge`, entries already carry their project's name),
   grouped by project on screen, with a filter to narrow to one. */
export function KnowledgePage() {
  const meta = sectionMeta("knowledge")
  const projects = useStoreSelect((store) => store.projects)
  const confirm = useConfirm()
  const [entries, setEntries] = React.useState<KnowledgeEntryAcross[] | null>(null)
  const [projectId, setProjectId] = React.useState(ALL)
  const [adding, setAdding] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  const refresh = React.useCallback(async () => {
    try {
      setEntries(await listAllKnowledge())
    } catch (err) {
      reportError(err, "Couldn't load the knowledge base")
      setEntries((current) => current ?? [])
    }
  }, [])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const remove = async (entry: KnowledgeEntryAcross) => {
    if (
      !(await confirm({
        title: `Delete "${entry.title}"?`,
        description:
          "The entry is removed from this project's knowledge base, so agents working in it stop seeing it. This cannot be undone.",
        destructive: true,
        confirmLabel: "Delete",
      }))
    )
      return
    setBusy(true)
    try {
      await deleteKnowledge(entry.projectId, entry.id)
      await refresh()
    } catch (err) {
      reportError(err, "Couldn't delete the knowledge entry")
    } finally {
      setBusy(false)
    }
  }

  const shown = (entries ?? []).filter((e) => projectId === ALL || e.projectId === projectId)
  /* Grouped in the order projects are listed, so the page reads like the
     projects page; entries within a group keep the server's newest-first. */
  const groups = projects
    .map((project) => ({ project, entries: shown.filter((e) => e.projectId === project.id) }))
    .filter((g) => g.entries.length > 0)
  // Entries whose project is not in the store (a race with a deletion) still show.
  const orphaned = shown.filter((e) => !projects.some((p) => p.id === e.projectId))

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name

  const actions = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Select value={projectId} onValueChange={(value) => setProjectId(value ?? ALL)}>
        {/* Full width on a phone, where the header's action block is the whole
            column and a 176px trigger beside two buttons leaves neither room. */}
        <SelectTrigger className="w-full max-sm:h-9 sm:w-44">
          <SelectValue>{projectId === ALL ? "All projects" : (projectName(projectId) ?? "Project")}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All projects</SelectItem>
          {projects.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button variant="ghost" size="icon-lg" title="Refresh" disabled={busy} onClick={() => void refresh()}>
        <RefreshCwIcon />
      </Button>
      <Button onClick={() => setAdding(true)} disabled={projects.length === 0}>
        <Plus className="size-4" /> Add entry
      </Button>
    </div>
  )

  return (
    <>
      <PageHeader meta={meta} action={actions} />
      {entries === null ? (
        <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
          Loading…
        </p>
      ) : shown.length === 0 ? (
        <EmptyCard
          icon={BookOpen}
          text={
            projectId === ALL
              ? "Nothing in the knowledge base yet. Link the built-in knowledge MCP server to a profile or a thread and the agent can start writing to it — or add an entry by hand."
              : "Nothing recorded for this project yet."
          }
          action={
            projects.length > 0 ? (
              <Button onClick={() => setAdding(true)}>
                <Plus className="size-4" /> Add entry
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {groups.map(({ project, entries }) => (
            <Group key={project.id} label={project.name}>
              {entries.map((entry) => (
                <EntryRow key={entry.id} entry={entry} busy={busy} onDelete={() => void remove(entry)} />
              ))}
            </Group>
          ))}
          {orphaned.length > 0 && (
            <Group label="Other">
              {orphaned.map((entry) => (
                <EntryRow key={entry.id} entry={entry} busy={busy} onDelete={() => void remove(entry)} />
              ))}
            </Group>
          )}
        </>
      )}
      {adding && (
        <AddEntryDialog
          projects={projects}
          initialProjectId={projectId === ALL ? (projects[0]?.id ?? "") : projectId}
          onClose={() => setAdding(false)}
          onAdded={async () => {
            setAdding(false)
            await refresh()
          }}
        />
      )}
    </>
  )
}

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })

function EntryRow({
  entry,
  busy,
  onDelete,
}: {
  entry: KnowledgeEntryAcross
  busy: boolean
  onDelete: () => void
}) {
  return (
    <Row
      icon={BookOpen}
      title={entry.title}
      subtitle={
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="line-clamp-2 break-words">{entry.content}</span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
            <span>{timeFormat.format(entry.updatedAt)}</span>
            {entry.tags.map((tag) => (
              <Badge key={tag} variant="outline" className="font-normal text-muted-foreground">
                {tag}
              </Badge>
            ))}
          </span>
        </span>
      }
    >
      <Button variant="ghost" size="icon-lg" title="Delete" disabled={busy} onClick={onDelete}>
        <Trash2 />
      </Button>
    </Row>
  )
}

/** A hand-written entry. The same route the project form posts to; the only
    extra decision here is which project it belongs to. */
function AddEntryDialog({
  projects,
  initialProjectId,
  onClose,
  onAdded,
}: {
  projects: { id: string; name: string }[]
  initialProjectId: string
  onClose: () => void
  onAdded: () => Promise<void>
}) {
  const [projectId, setProjectId] = React.useState(initialProjectId)
  const [title, setTitle] = React.useState("")
  const [content, setContent] = React.useState("")
  const [tags, setTags] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<InlineError | null>(null)
  const canSave = Boolean(projectId && title.trim() && content.trim()) && !saving

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      await addKnowledge(projectId, {
        title: title.trim(),
        content: content.trim(),
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      })
      await onAdded()
    } catch (err) {
      setError(captureError(err, "Couldn't add the knowledge entry"))
      setSaving(false)
    }
  }

  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent className="sm:max-w-lg">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Add knowledge entry</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Written to the project's knowledge base, where the agent's own entries go.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <div className="space-y-4">
          <Field label="Project">
            <Select value={projectId} onValueChange={(value) => setProjectId(value ?? "")}>
              <SelectTrigger className="w-full">
                <SelectValue>{projects.find((p) => p.id === projectId)?.name ?? "Pick a project"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Title">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What this is about" autoFocus />
          </Field>
          <Field label="Content">
            <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={5} placeholder="What to remember." />
          </Field>
          <Field label="Tags" hint="Optional — comma-separated.">
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="architecture, decisions" />
          </Field>
        </div>
        <ErrorNote error={error} />
        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!canSave}>
            {saving ? "Saving…" : "Add entry"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
