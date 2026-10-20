import { useProjects } from "@/lib/queries/catalog"
import * as React from "react"
import { BookOpen, ChevronDown, Plus, RefreshCwIcon, Trash2 } from "lucide-react"
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
import {
  DataTable,
  TitleCell,
  type DataTableColumnMeta,
  type DataTableExpand,
  type DataTableMobile,
  type TableAction,
} from "@/components/ui/data-table"
import type { ColumnDef } from "@/lib/table"
import { cn } from "@/lib/utils"
import { Empty } from "@/components/empty"
import { ErrorNote } from "@/components/error-note"
import { captureError, inlineFromQuery, reportError, type InlineError } from "@/lib/errors"
import { useAddKnowledge, useAllKnowledge, useDeleteKnowledge } from "@/lib/queries/surfaces"
import type { KnowledgeEntryAcross } from "@/lib/workspace/knowledge-api"
import { Field, PageHeader, ROW_CONTROL, Section, StatStrip } from "./primitives"
import { sectionMeta } from "./sections"

const ALL = "__all__"

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" })

/** Characters, not bytes — it is a reading size for an entry, not a quota. */
const sizeOf = (e: KnowledgeEntryAcross) =>
  e.content.length >= 1000 ? `${(e.content.length / 1000).toFixed(1)}k chars` : `${e.content.length} chars`

/** The entry's body and tags, opened under its row (desktop) or inside it (list). */
function EntryDetail({ entry, withMeta = true }: { entry: KnowledgeEntryAcross; withMeta?: boolean }) {
  return (
    <div className="min-w-0 space-y-3" onClick={(e) => e.stopPropagation()}>
      <p className="text-sm/relaxed break-words whitespace-pre-wrap select-text">{entry.content}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted-foreground">
        {withMeta && (
          <>
            <span>{entry.projectName}</span>
            <span>Updated {timeFormat.format(entry.updatedAt)}</span>
            <span>{sizeOf(entry)}</span>
          </>
        )}
        {entry.tags.map((tag) => (
          <Badge key={tag} variant="outline" className="font-normal text-muted-foreground">
            {tag}
          </Badge>
        ))}
      </div>
    </div>
  )
}

/* ── Knowledge base ──
   Everything the agents have written through the built-in `knowledge` MCP
   server, across every project, in one place. The per-project view inside a
   project's form still exists; this page is for the question that view cannot
   answer — "what has been learned, anywhere?" — and for pruning it. One
   fetch (`GET /api/knowledge`, entries already carry their project's name),
   one table, a project filter and a search beside it. A row opens in place to
   its full text — on the table as a detail row, on the phone inside the list
   row itself (the table only draws a detail row on desktop). */
export function KnowledgePage() {
  const meta = sectionMeta("knowledge")
  const projects = useProjects()
  const confirm = useConfirm()
  /* The cache owns the read; the delete's invalidation is the refresh, and
     `busy` only covers the await so a double click cannot fire twice. */
  const { data: entries, error: loadError, refetch } = useAllKnowledge()
  const addEntry = useAddKnowledge()
  const deleteEntry = useDeleteKnowledge()
  const [pickedId, setProjectId] = React.useState(ALL)
  const [search, setSearch] = React.useState("")
  const [adding, setAdding] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [openId, setOpenId] = React.useState<string | null>(null)

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
      await deleteEntry.mutateAsync({ projectId: entry.projectId, id: entry.id })
    } catch (err) {
      reportError(err, "Couldn't delete the knowledge entry")
    } finally {
      setBusy(false)
    }
  }
  // The table memoises rows against `actions`, so the handler it holds is a ref's.
  const removeRef = React.useRef(remove)
  removeRef.current = remove

  // A picked project that has since been deleted falls back to All.
  const projectId = pickedId === ALL || projects.some((p) => p.id === pickedId) ? pickedId : ALL
  const needle = search.trim().toLowerCase()
  const shown = React.useMemo(
    () =>
      (entries ?? []).filter(
        (e) =>
          (projectId === ALL || e.projectId === projectId) &&
          (!needle || `${e.title} ${e.content} ${e.tags.join(" ")}`.toLowerCase().includes(needle))
      ),
    [entries, projectId, needle]
  )

  const countOf = (id: string) => (entries ?? []).filter((e) => e.projectId === id).length
  const total = entries?.length ?? 0
  const stats = [
    { label: "Entries", value: total, loading: !entries && !loadError },
    { label: "Projects", value: new Set((entries ?? []).map((e) => e.projectId)).size, hint: "with entries", loading: !entries && !loadError },
    { label: "Tags", value: new Set((entries ?? []).flatMap((e) => e.tags)).size, loading: !entries && !loadError },
  ]

  const actions = (
    <>
      <Button variant="outline" size="icon" title="Refresh" disabled={busy} onClick={() => void refetch()}>
        <RefreshCwIcon />
      </Button>
      <Button onClick={() => setAdding(true)} disabled={projects.length === 0}>
        <Plus data-icon="inline-start" /> New entry
      </Button>
    </>
  )

  const columns = React.useMemo<ColumnDef<KnowledgeEntryAcross, unknown>[]>(
    () => [
      {
        id: "title",
        header: "Entry",
        cell: ({ row }) => (
          <TitleCell
            title={row.original.title}
            subtitle={<span className="block max-w-[56ch] truncate">{row.original.content}</span>}
          />
        ),
        meta: { title: true, className: "min-w-64" } satisfies DataTableColumnMeta,
      },
      {
        id: "project",
        header: "Project",
        cell: ({ row }) => <span className="block max-w-40 truncate text-muted-foreground">{row.original.projectName}</span>,
        meta: { className: "hidden @panel-md:table-cell" } satisfies DataTableColumnMeta,
      },
      {
        id: "updated",
        header: "Updated",
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-muted-foreground tabular-nums">{dayFormat.format(row.original.updatedAt)}</span>
        ),
        meta: { className: "hidden @panel-sm:table-cell" } satisfies DataTableColumnMeta,
      },
      {
        id: "size",
        header: "Size",
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-muted-foreground tabular-nums">{sizeOf(row.original)}</span>
        ),
        meta: { align: "end", className: "hidden @panel-md:table-cell" } satisfies DataTableColumnMeta,
      },
    ],
    []
  )

  const tableActions = React.useMemo<TableAction<KnowledgeEntryAcross>[]>(
    () => [
      {
        id: "delete",
        label: "Delete",
        icon: <Trash2 />,
        tone: "danger",
        disabled: () => busy,
        onClick: (entry) => void removeRef.current(entry),
      },
    ],
    [busy]
  )

  const toggle = React.useCallback((id: string) => setOpenId((cur) => (cur === id ? null : id)), [])
  const expand = React.useMemo<DataTableExpand<KnowledgeEntryAcross>>(
    () => ({
      render: (entry) => (
        <div className="px-1 py-1 @panel-sm:ps-12">
          <EntryDetail entry={entry} />
        </div>
      ),
      rowId: openId,
      onRowIdChange: setOpenId,
    }),
    [openId]
  )
  // On desktop `expand` wins the click; this is the list's tap.
  const onRowClick = React.useCallback((entry: KnowledgeEntryAcross) => toggle(entry.id), [toggle])

  const mobile = React.useMemo<DataTableMobile<KnowledgeEntryAcross>>(
    () => ({
      renderRow: (entry) => {
        const open = openId === entry.id
        return (
          <div className="min-w-0 py-0.5">
            <div className="flex min-w-0 items-start gap-3">
              <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <BookOpen className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{entry.title}</div>
                {!open && <div className="mt-0.5 line-clamp-2 text-sm break-words text-muted-foreground">{entry.content}</div>}
                <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                  <span className="max-w-32 truncate">{entry.projectName}</span>
                  <span>{dayFormat.format(entry.updatedAt)}</span>
                  <span>{sizeOf(entry)}</span>
                </div>
              </div>
              <span className="sr-only">{open ? "Expanded" : "Collapsed"}</span>
              <ChevronDown
                aria-hidden
                className={cn("mt-2 size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
              />
            </div>
            {open && (
              <div className="mt-3 border-t pt-3">
                <EntryDetail entry={entry} withMeta={false} />
              </div>
            )}
          </div>
        )
      },
    }),
    [openId]
  )

  const projectFilter = (
    <Select value={projectId} onValueChange={(value) => setProjectId(value ?? ALL)}>
      <SelectTrigger className={cn(ROW_CONTROL, "pointer-coarse:h-11")} aria-label="Project">
        <SelectValue>
          {projectId === ALL
            ? `All projects (${total})`
            : `${projects.find((p) => p.id === projectId)?.name ?? "Project"} (${countOf(projectId)})`}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All projects ({total})</SelectItem>
        {projects.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name} ({countOf(p.id)})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  return (
    <>
      <PageHeader meta={meta} action={actions} />
      <StatStrip stats={stats} />
      {loadError ? (
        <Section>
          <ErrorNote error={inlineFromQuery(loadError, "Couldn't read the knowledge base")} onRetry={() => void refetch()} />
        </Section>
      ) : entries && total === 0 ? (
        <Empty
          size="lg"
          icon={BookOpen}
          action={
            projects.length > 0 ? (
              <Button className="pointer-coarse:h-11" onClick={() => setAdding(true)}>
                <Plus data-icon="inline-start" /> New entry
              </Button>
            ) : undefined
          }
        >
          Nothing in the knowledge base yet. Link the built-in knowledge MCP server to a profile or a thread
          and the agent can start writing to it — or add an entry by hand.
        </Empty>
      ) : (
        <DataTable
          columns={columns}
          data={shown}
          getRowId={(entry) => entry.id}
          isLoading={entries === undefined}
          skeletonRows={5}
          pageSize={25}
          mark={() => <BookOpen />}
          actions={tableActions}
          expand={expand}
          onRowClick={onRowClick}
          mobile={mobile}
          toolbar={projectFilter}
          filtering={{
            search: { value: search, onChange: setSearch, placeholder: "Search entries..." },
            // The project pick narrows too, so the toolbar says "n of N" for it.
            count: projectId === ALL ? 0 : 1,
            totalCount: total,
          }}
          emptyIcon={<BookOpen />}
          emptyMessage={!needle && projectId !== ALL ? "Nothing recorded for this project yet." : undefined}
        />
      )}
      {adding && (
        <AddEntryDialog
          projects={projects}
          initialProjectId={projectId === ALL ? (projects[0]?.id ?? "") : projectId}
          onClose={() => setAdding(false)}
          onAdded={async (input) => {
            setAdding(false)
            await addEntry.mutateAsync(input)
          }}
        />
      )}
    </>
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
  onAdded: (input: { projectId: string; body: { title: string; content: string; tags?: string[] } }) => Promise<void>
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
      await onAdded({
        projectId,
        body: {
          title: title.trim(),
          content: content.trim(),
          tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        },
      })
    } catch (err) {
      setError(captureError(err, "Couldn't add the knowledge entry"))
      setSaving(false)
    }
  }

  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Add knowledge entry</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Written to the project's knowledge base, where the agent's own entries go.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <>
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
        </>
        <ErrorNote error={error} />
        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!canSave} loading={saving}>
            Add entry
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
