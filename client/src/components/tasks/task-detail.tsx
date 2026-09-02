import * as React from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  Archive,
  ArchiveRestore,
  CalendarIcon,
  Check,
  ChevronDown,
  Copy,
  CornerDownRight,
  History,
  Link2,
  ListChecks,
  ListTree,
  MessageSquare,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { ErrorNote } from "@/components/error-note"
import { captureError, reportError, type InlineError } from "@/lib/errors"
import { toast } from "@/lib/toast"
import type { Board, BoardStatus, CustomFieldDef, Sprint } from "@/lib/boards"
import {
  LINK_KINDS,
  LINK_LABEL,
  PRIORITY_LABEL,
  TYPE_LABEL,
  taskKey,
  type LinkKind,
  type Task,
  type TaskActivity,
  type TaskInput,
} from "@/lib/tasks-board"
import { boardPath } from "@/lib/router"
import { checklistProgress, dueLabel } from "@/lib/tasks-view"
import {
  useAddComment,
  useAddLink,
  useDeleteComment,
  useDeleteLink,
  useTaskDetail,
  useUpdateComment,
} from "@/lib/queries/boards"
import {
  AssigneeAvatar,
  AssigneePicker,
  CHIP,
  DatePicker,
  LabelChip,
  LabelsPicker,
  NumberPicker,
  ParentPicker,
  PriorityIcon,
  PriorityPicker,
  SprintPicker,
  StatusPicker,
  StatusPill,
  TypeIcon,
  TypePicker,
} from "./fields"
import { QuickAdd } from "./quick-add"
import { TaskEditor } from "./task-editor"

const fmtWhen = (ms: number) => {
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  })
}

function Section({ icon: Icon, title, count, action, children }: { icon: React.ComponentType<{ className?: string }>; title: string; count?: number; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="grid gap-2">
      <header className="flex items-center gap-2">
        <Icon className="size-3.5 text-muted-foreground" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
        {count != null && count > 0 && <span className="rounded-pill bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">{count}</span>}
        <span className="ml-auto">{action}</span>
      </header>
      {children}
    </section>
  )
}

function Property({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[6rem_minmax(0,1fr)]">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/**
 * The property aside, ordered before the main column on a phone and collapsed
 * under a "Details" toggle: status, assignee and dates are the frequent edits,
 * and burying them past the comments would cost four screens of scrolling. On
 * a desktop that is wide enough for two panes it renders open as the right
 * column, exactly where it was.
 */
function PropertiesDisclosure({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  return (
    <div className="order-first min-w-0 md:order-none">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 border-b bg-muted/30 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground md:hidden"
      >
        Details
        <ChevronDown className={cn("ml-auto size-3.5 transition-transform", open && "rotate-180")} />
      </button>
      <div className={cn(!open && "hidden", "md:block")}>{children}</div>
    </div>
  )
}

/** All the ids under a task, so the parent picker never offers a descendant. */
function descendantsOf(id: string, all: Task[]): Set<string> {
  const out = new Set<string>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const t of all) {
      if (t.parentId && out.has(t.parentId) && !out.has(t.id)) {
        out.add(t.id)
        grew = true
      }
    }
  }
  return out
}

/** One activity row in words. Ids are resolved here, against the board. */
function describe(entry: TaskActivity, ctx: { statuses: BoardStatus[]; sprints: Sprint[]; all: Task[]; boardKey: string }): string {
  const status = (id: unknown) => ctx.statuses.find((s) => s.id === id)?.name ?? "another column"
  const sprint = (id: unknown) => (id ? (ctx.sprints.find((s) => s.id === id)?.name ?? "a sprint") : "the backlog")
  const key = (id: unknown) => {
    const t = ctx.all.find((x) => x.id === id)
    return t ? taskKey(t, ctx.boardKey) : "a task"
  }
  const date = (v: unknown) => (typeof v === "number" ? new Date(v).toLocaleDateString() : "none")
  switch (entry.field) {
    case "created":
      return "created the task"
    case "commented":
      return "commented"
    case "description":
      return "edited the description"
    case "statusId":
      return `moved from ${status(entry.from)} to ${status(entry.to)}`
    case "title":
      return `renamed to “${String(entry.to)}”`
    case "priority":
      return `set priority to ${PRIORITY_LABEL[entry.to as keyof typeof PRIORITY_LABEL] ?? String(entry.to)}`
    case "type":
      return `changed type to ${TYPE_LABEL[entry.to as keyof typeof TYPE_LABEL] ?? String(entry.to)}`
    case "assignee":
      return entry.to ? `assigned to ${String(entry.to)}` : "unassigned"
    case "labels":
      return `set labels to ${Array.isArray(entry.to) && entry.to.length ? entry.to.join(", ") : "none"}`
    case "parentId":
      return entry.to ? `moved under ${key(entry.to)}` : "detached from its parent"
    case "sprintId":
      return `moved to ${sprint(entry.to)}`
    case "estimate":
      return entry.to == null ? "cleared the estimate" : `estimated ${String(entry.to)} points`
    case "startAt":
      return `set the start to ${date(entry.to)}`
    case "dueAt":
      return `set the due date to ${date(entry.to)}`
    case "archived":
      return entry.to ? "archived the task" : "restored the task"
    case "boardId":
      return "moved to another board"
    case "linked": {
      const to = entry.to as { kind?: LinkKind; taskId?: string; inbound?: boolean } | null
      if (!to?.kind) return "linked a task"
      const label = to.inbound ? LINK_LABEL[to.kind].in : LINK_LABEL[to.kind].out
      return `${label.toLowerCase()} ${key(to.taskId)}`
    }
    default:
      return `changed ${entry.field}`
  }
}

function CustomFieldInput({ def, value, onChange }: { def: CustomFieldDef; value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = React.useState(value == null ? "" : String(value))
  React.useEffect(() => setText(value == null ? "" : String(value)), [value])
  const commit = () => {
    if (def.type === "number") onChange(text === "" ? null : Number(text))
    else onChange(text === "" ? null : text)
  }
  switch (def.type) {
    case "checkbox":
      return <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-primary" aria-label={def.name} />
    case "select":
      return (
        <select value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)} className="h-7 w-full rounded-lg border bg-background px-2 text-xs" aria-label={def.name}>
          <option value="">—</option>
          {(def.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )
    case "date":
      return <Input type="date" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)} className="h-7 text-xs" aria-label={def.name} />
    default:
      return (
        <Input
          type={def.type === "number" ? "number" : def.type === "url" ? "url" : "text"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          className="h-7 text-xs"
          aria-label={def.name}
          placeholder="—"
        />
      )
  }
}

export function TaskDetailDialog({
  taskId,
  onClose,
  board,
  statuses,
  sprints,
  allTasks,
  facets,
  onOpen,
  onCreate,
  onUpdate,
  onDelete,
}: {
  taskId: string | null
  onClose: () => void
  board: Board
  statuses: BoardStatus[]
  sprints: Sprint[]
  allTasks: Task[]
  facets: { assignees: string[]; labels: string[] }
  onOpen: (task: Task) => void
  onCreate: (input: TaskInput & { title: string }) => Promise<Task>
  onUpdate: (id: string, input: TaskInput) => Promise<Task>
  onDelete: (id: string) => Promise<void>
}) {
  const detail = useTaskDetail(taskId)
  const task = detail.data?.task ?? allTasks.find((t) => t.id === taskId) ?? null
  const addComment = useAddComment()
  const updateComment = useUpdateComment()
  const deleteComment = useDeleteComment()
  const addLink = useAddLink()
  const deleteLink = useDeleteLink()

  const [title, setTitle] = React.useState("")
  const [editingTitle, setEditingTitle] = React.useState(false)
  const [editingDesc, setEditingDesc] = React.useState(false)
  const [desc, setDesc] = React.useState("")
  const [comment, setComment] = React.useState("")
  const [editingComment, setEditingComment] = React.useState<{ id: string; body: string } | null>(null)
  const [linkKind, setLinkKind] = React.useState<LinkKind>("relates")
  const [error, setError] = React.useState<InlineError | null>(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)

  React.useEffect(() => {
    setEditingTitle(false)
    setEditingDesc(false)
    setConfirmDelete(false)
    setError(null)
    setEditingComment(null)
  }, [taskId])

  if (!task) {
    return (
      <ResponsiveDialog open={!!taskId} onOpenChange={(open) => !open && onClose()}>
        <ResponsiveDialogContent className="sm:max-w-lg">
          <ResponsiveDialogTitle className="sr-only">Task</ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="sr-only">Loading</ResponsiveDialogDescription>
          <div className="text-sm text-muted-foreground">{detail.isError ? "This task could not be loaded." : "Loading…"}</div>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    )
  }

  const key = taskKey(task, board.key)
  const patch = async (input: TaskInput) => {
    try {
      await onUpdate(task.id, input)
    } catch (err) {
      setError(captureError(err, "Couldn't save the change"))
    }
  }
  const parent = task.parentId ? allTasks.find((t) => t.id === task.parentId) : undefined
  const children = detail.data?.children ?? allTasks.filter((t) => t.parentId === task.id)
  const progress = checklistProgress(task)
  const status = statuses.find((s) => s.id === task.statusId)
  const links = detail.data?.links ?? []
  const comments = detail.data?.comments ?? []
  const activity = detail.data?.activity ?? []

  const copyLink = () => {
    const url = `${location.origin}${boardPath(board.id, task.id)}`
    void navigator.clipboard.writeText(url).then(
      () => toast.success(`Copied a link to ${key}`),
      () => toast.error("Couldn't copy the link"),
    )
  }

  const saveTitle = async () => {
    setEditingTitle(false)
    const next = title.trim()
    if (next && next !== task.title) await patch({ title: next })
  }

  const toggleChecklist = (id: string) =>
    patch({ checklist: task.checklist.map((c) => (c.id === id ? { ...c, done: !c.done } : c)) })
  const removeChecklist = (id: string) => patch({ checklist: task.checklist.filter((c) => c.id !== id) })
  const addChecklist = async (text: string) => {
    await patch({ checklist: [...task.checklist, { text, done: false }] })
  }

  return (
    <ResponsiveDialog open={!!taskId} onOpenChange={(open) => !open && onClose()} tall>
      <ResponsiveDialogContent className="sm:max-w-3xl" bodyClassName="p-0">
        {/* Header: key, type, actions — the dialog's own close button takes the corner. */}
        <ResponsiveDialogHeader className="flex-row items-center gap-2 py-2.5">
          <TypePicker
            value={task.type}
            onChange={(type) => void patch({ type })}
            trigger={
              <button type="button" className={CHIP}>
                <TypeIcon type={task.type} /> {TYPE_LABEL[task.type]}
              </button>
            }
          />
          <button type="button" onClick={copyLink} className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground" title="Copy link">
            {key} <Copy className="size-3" />
          </button>
          {parent && (
            <button type="button" onClick={() => onOpen(parent)} className="hidden items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground sm:inline-flex">
              <CornerDownRight className="size-3" /> {taskKey(parent, board.key)} {parent.title}
            </button>
          )}
          <span className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => void patch({ archived: !task.archived })}
              className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={task.archived ? "Restore" : "Archive"}
              title={task.archived ? "Restore" : "Archive"}
            >
              {task.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
            </button>
            {confirmDelete ? (
              <span className="inline-flex items-center gap-1 text-xs">
                <span className="text-muted-foreground">Delete {key}?</span>
                <Button
                  size="xs"
                  variant="destructive"
                  onClick={async () => {
                    try {
                      await onDelete(task.id)
                      toast.success(`${key} deleted`)
                      onClose()
                    } catch (err) {
                      reportError(err, "Couldn't delete the task")
                    }
                  }}
                >
                  Delete
                </Button>
                <Button size="xs" variant="outline" onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmDelete(true)} className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label="Delete task" title="Delete">
                <Trash2 className="size-4" />
              </button>
            )}
          </span>
        </ResponsiveDialogHeader>

        {/* Title block spans full width above the two panes. */}
        <div className="w-full px-4 pt-4 sm:px-6">
          {editingTitle ? (
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => void saveTitle()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveTitle()
                if (e.key === "Escape") setEditingTitle(false)
              }}
              aria-label="Title"
              className="w-full rounded-lg border border-input bg-background px-2 py-1 text-lg font-semibold leading-snug outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          ) : (
            <ResponsiveDialogTitle
              render={
                <button
                  type="button"
                  onClick={() => {
                    setTitle(task.title)
                    setEditingTitle(true)
                  }}
                  className={cn("-mx-2 rounded-lg px-2 py-1 text-left text-lg font-semibold leading-snug hover:bg-accent/50", task.completedAt != null && "text-muted-foreground line-through")}
                  title="Click to rename"
                />
              }
            >
                {task.title}
            </ResponsiveDialogTitle>
          )}
          <ResponsiveDialogDescription className="sr-only">{key}</ResponsiveDialogDescription>
          {task.archived && <p className="pt-1 text-xs text-muted-foreground">Archived — hidden from every view unless the filter includes it.</p>}
        </div>

        <div className="grid w-full content-start md:grid-cols-[minmax(0,1fr)_17rem]">
          {/* Main column. */}
          <div className="grid content-start gap-6 px-4 py-4 sm:px-6">
            <Section
              icon={Pencil}
              title="Description"
              action={
                !editingDesc && (
                  <button
                    type="button"
                    onClick={() => {
                      setDesc(task.description ?? "")
                      setEditingDesc(true)
                    }}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    {task.description ? "Edit" : "Add"}
                  </button>
                )
              }
            >
              {editingDesc ? (
                <div className="grid gap-2">
                  <TaskEditor value={desc} onChange={setDesc} className="[&_.ProseMirror]:min-h-[10rem]" />
                  <div className="flex justify-end gap-2">
                    <Button size="xs" variant="outline" onClick={() => setEditingDesc(false)}>
                      Cancel
                    </Button>
                    <Button
                      size="xs"
                      onClick={async () => {
                        await patch({ description: desc.trim() || null })
                        setEditingDesc(false)
                      }}
                    >
                      Save
                    </Button>
                  </div>
                </div>
              ) : task.description ? (
                <div className="prose prose-sm max-w-none rounded-xl border bg-muted/20 px-4 py-3 dark:prose-invert">
                  <Markdown remarkPlugins={[remarkGfm]}>{task.description}</Markdown>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setDesc("")
                    setEditingDesc(true)
                  }}
                  className="rounded-xl border border-dashed px-4 py-3 text-left text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground"
                >
                  Add a description…
                </button>
              )}
            </Section>

            <Section icon={ListChecks} title="Checklist" count={progress.total} action={progress.total > 0 ? <span className="text-xs tabular-nums text-muted-foreground">{progress.done}/{progress.total}</span> : null}>
              {progress.total > 0 && (
                <div className="h-1.5 overflow-hidden rounded-pill bg-muted">
                  <div className="h-full rounded-pill bg-primary transition-[width]" style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
                </div>
              )}
              <ul className="grid gap-0.5">
                {task.checklist.map((item) => (
                  <li key={item.id} className="group flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-accent/40">
                    <input type="checkbox" checked={item.done} onChange={() => void toggleChecklist(item.id)} className="size-4 accent-primary" aria-label={item.text} />
                    <span className={cn("flex-1 text-sm", item.done && "text-muted-foreground line-through")}>{item.text}</span>
                    <button type="button" onClick={() => void removeChecklist(item.id)} aria-label="Remove item" className="grid size-6 place-items-center rounded text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100">
                      <X className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
              <QuickAdd compact placeholder="Add a checklist item…" onCreate={addChecklist} />
            </Section>

            <Section icon={ListTree} title={task.type === "epic" ? "Child issues" : "Subtasks"} count={children.length}>
              <ul className="grid gap-0.5">
                {children.map((child) => {
                  const cs = statuses.find((s) => s.id === child.statusId)
                  return (
                    <li key={child.id} className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-accent/40">
                      <TypeIcon type={child.type} />
                      <span className="font-mono text-[11px] text-muted-foreground">{taskKey(child, board.key)}</span>
                      <button type="button" onClick={() => onOpen(child)} className={cn("min-w-0 flex-1 truncate text-left text-sm hover:underline", child.completedAt != null && "text-muted-foreground line-through")}>
                        {child.title}
                      </button>
                      <StatusPicker
                        value={child.statusId}
                        statuses={statuses}
                        onChange={(statusId) => void onUpdate(child.id, { statusId }).catch((err) => reportError(err, "Couldn't move the subtask"))}
                        trigger={
                          <button type="button" className={cn(CHIP, "px-0.5")}>
                            <StatusPill status={cs} />
                          </button>
                        }
                      />
                      <AssigneeAvatar name={child.assignee} size="xs" />
                    </li>
                  )
                })}
              </ul>
              <QuickAdd
                compact
                placeholder={task.type === "epic" ? "Add a child issue…" : "Add a subtask…"}
                onCreate={async (t) => {
                  await onCreate({ title: t, parentId: task.id, sprintId: task.sprintId, statusId: statuses[0]?.id })
                }}
              />
            </Section>

            <Section
              icon={Link2}
              title="Linked tasks"
              count={links.length}
              action={
                <span className="inline-flex items-center gap-1">
                  <select value={linkKind} onChange={(e) => setLinkKind(e.target.value as LinkKind)} className="h-6 rounded-md border bg-background px-1 text-[11px]" aria-label="Link kind">
                    {LINK_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {LINK_LABEL[k].out}
                      </option>
                    ))}
                  </select>
                  <ParentPicker
                    value={null}
                    candidates={allTasks}
                    boardKey={board.key}
                    exclude={new Set([task.id])}
                    onChange={(toId) => {
                      if (!toId) return
                      addLink.mutateAsync({ fromId: task.id, toId, kind: linkKind }).catch((err) => reportError(err, "Couldn't link the task"))
                    }}
                    trigger={
                      <button type="button" className="inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-[11px] hover:bg-accent">
                        <Plus className="size-3" /> Link
                      </button>
                    }
                  />
                </span>
              }
            >
              <ul className="grid gap-0.5">
                {links.map((link) => {
                  const outbound = link.fromId === task.id
                  const otherId = outbound ? link.toId : link.fromId
                  const other = allTasks.find((t) => t.id === otherId)
                  const label = outbound ? LINK_LABEL[link.kind].out : LINK_LABEL[link.kind].in
                  return (
                    <li key={link.id} className="group flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-accent/40">
                      <span className="w-24 shrink-0 text-[11px] text-muted-foreground">{label}</span>
                      {other ? (
                        <>
                          <TypeIcon type={other.type} />
                          <span className="font-mono text-[11px] text-muted-foreground">{taskKey(other, board.key)}</span>
                          <button type="button" onClick={() => onOpen(other)} className={cn("min-w-0 flex-1 truncate text-left text-sm hover:underline", other.completedAt != null && "text-muted-foreground line-through")}>
                            {other.title}
                          </button>
                          <StatusPill status={statuses.find((s) => s.id === other.statusId)} compact />
                        </>
                      ) : (
                        <span className="flex-1 text-sm text-muted-foreground">A task on another board</span>
                      )}
                      <button
                        type="button"
                        aria-label="Remove link"
                        onClick={() => deleteLink.mutateAsync({ id: link.id, fromId: link.fromId, toId: link.toId }).catch((err) => reportError(err, "Couldn't remove the link"))}
                        className="grid size-6 place-items-center rounded text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
                      >
                        <X className="size-3.5" />
                      </button>
                    </li>
                  )
                })}
                {links.length === 0 && <li className="text-xs text-muted-foreground">No links yet.</li>}
              </ul>
            </Section>

            <Section icon={MessageSquare} title="Comments" count={comments.length}>
              <ul className="grid gap-2">
                {comments.map((c) => (
                  <li key={c.id} className="group rounded-xl border bg-card px-3 py-2">
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <AssigneeAvatar name={c.author ?? "You"} size="xs" />
                      <span className="font-medium text-foreground">{c.author ?? "You"}</span>
                      <span>{fmtWhen(c.createdAt)}</span>
                      {c.updatedAt !== c.createdAt && <span>(edited)</span>}
                      <span className="ml-auto inline-flex gap-1 opacity-0 group-hover:opacity-100">
                        <button type="button" onClick={() => setEditingComment({ id: c.id, body: c.body })} aria-label="Edit comment" className="rounded p-0.5 hover:text-foreground">
                          <Pencil className="size-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteComment.mutateAsync({ id: c.id, taskId: task.id }).catch((err) => reportError(err, "Couldn't delete the comment"))}
                          aria-label="Delete comment"
                          className="rounded p-0.5 hover:text-destructive"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </span>
                    </div>
                    {editingComment?.id === c.id ? (
                      <div className="mt-1 grid gap-1">
                        <Textarea value={editingComment.body} onChange={(e) => setEditingComment({ id: c.id, body: e.target.value })} className="min-h-12 text-sm" />
                        <div className="flex justify-end gap-1">
                          <Button size="xs" variant="outline" onClick={() => setEditingComment(null)}>
                            Cancel
                          </Button>
                          <Button
                            size="xs"
                            onClick={() =>
                              updateComment
                                .mutateAsync({ id: c.id, taskId: task.id, body: editingComment.body.trim() })
                                .then(() => setEditingComment(null))
                                .catch((err) => reportError(err, "Couldn't save the comment"))
                            }
                          >
                            Save
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="prose prose-sm mt-1 max-w-none dark:prose-invert">
                        <Markdown remarkPlugins={[remarkGfm]}>{c.body}</Markdown>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  const body = comment.trim()
                  if (!body) return
                  addComment
                    .mutateAsync({ taskId: task.id, body })
                    .then(() => setComment(""))
                    .catch((err) => reportError(err, "Couldn't post the comment"))
                }}
                className="grid gap-1"
              >
                <Textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") e.currentTarget.form?.requestSubmit()
                  }}
                  placeholder="Write a comment… markdown works, ⌘↵ to post"
                  className="min-h-14 text-sm"
                />
                <div className="flex justify-end">
                  <Button size="xs" type="submit" disabled={!comment.trim() || addComment.isPending}>
                    Comment
                  </Button>
                </div>
              </form>
            </Section>

            <Section icon={History} title="Activity" count={activity.length}>
              <ul className="grid gap-1 text-xs text-muted-foreground">
                {activity.map((entry) => (
                  <li key={entry.id} className="flex gap-2">
                    <span className="w-28 shrink-0 tabular-nums">{fmtWhen(entry.at)}</span>
                    <span>{describe(entry, { statuses, sprints, all: allTasks, boardKey: board.key })}</span>
                  </li>
                ))}
                {activity.length === 0 && !detail.isLoading && <li>No history recorded.</li>}
              </ul>
            </Section>

            <ErrorNote error={error} />
          </div>

          {/* Properties — a collapsed "Details" section on a phone, the right column on desktop. */}
          <PropertiesDisclosure>
          <aside className="grid content-start gap-3 border-b bg-muted/30 px-4 py-4 md:border-b-0 md:border-l">
            <Property label="Status">
              <StatusPicker
                value={task.statusId}
                statuses={statuses}
                onChange={(statusId) => void patch({ statusId })}
                trigger={
                  <button type="button" className={cn(CHIP, "px-0.5")}>
                    <StatusPill status={status} />
                  </button>
                }
              />
            </Property>
            <Property label="Priority">
              <PriorityPicker
                value={task.priority}
                onChange={(priority) => void patch({ priority })}
                trigger={
                  <button type="button" className={CHIP}>
                    <PriorityIcon priority={task.priority} /> {PRIORITY_LABEL[task.priority]}
                  </button>
                }
              />
            </Property>
            <Property label="Assignee">
              <AssigneePicker
                value={task.assignee}
                suggestions={facets.assignees}
                onChange={(assignee) => void patch({ assignee })}
                trigger={
                  <button type="button" className={CHIP}>
                    <AssigneeAvatar name={task.assignee} size="xs" /> <span className="truncate">{task.assignee ?? "Unassigned"}</span>
                  </button>
                }
              />
            </Property>
            <Property label="Labels">
              <LabelsPicker
                value={task.labels}
                suggestions={facets.labels}
                onChange={(labels) => void patch({ labels })}
                trigger={
                  <button type="button" className={cn(CHIP, "h-auto min-h-7 flex-wrap gap-1 py-1")}>
                    {task.labels.length === 0 && <span className="text-muted-foreground">None</span>}
                    {task.labels.map((l) => (
                      <LabelChip key={l} label={l} />
                    ))}
                  </button>
                }
              />
            </Property>
            <Property label="Sprint">
              <SprintPicker
                value={task.sprintId}
                sprints={sprints}
                onChange={(sprintId) => void patch({ sprintId })}
                trigger={
                  <button type="button" className={CHIP}>
                    <span className="truncate">{sprints.find((s) => s.id === task.sprintId)?.name ?? "Backlog"}</span>
                  </button>
                }
              />
            </Property>
            <Property label="Parent">
              <ParentPicker
                value={task.parentId}
                candidates={allTasks}
                boardKey={board.key}
                exclude={descendantsOf(task.id, allTasks)}
                onChange={(parentId) => void patch({ parentId })}
                trigger={
                  <button type="button" className={CHIP}>
                    {parent ? (
                      <>
                        <TypeIcon type={parent.type} /> <span className="truncate">{taskKey(parent, board.key)}</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                  </button>
                }
              />
            </Property>
            <Property label="Points">
              <NumberPicker
                value={task.estimate}
                onChange={(estimate) => void patch({ estimate })}
                trigger={
                  <button type="button" className={CHIP}>
                    {task.estimate ?? <span className="text-muted-foreground">Unestimated</span>}
                  </button>
                }
              />
            </Property>
            <Property label="Start">
              <DatePicker
                value={task.startAt}
                onChange={(startAt) => void patch({ startAt })}
                trigger={
                  <button type="button" className={CHIP}>
                    <CalendarIcon className="size-3.5 text-muted-foreground" />
                    {task.startAt != null ? new Date(task.startAt).toLocaleDateString() : <span className="text-muted-foreground">None</span>}
                  </button>
                }
              />
            </Property>
            <Property label="Due">
              <DatePicker
                value={task.dueAt}
                onChange={(dueAt) => void patch({ dueAt })}
                trigger={
                  <button type="button" className={CHIP}>
                    <CalendarIcon className="size-3.5 text-muted-foreground" />
                    {dueLabel(task.dueAt) ?? <span className="text-muted-foreground">None</span>}
                  </button>
                }
              />
            </Property>
            {board.customFields.length > 0 && (
              <>
                <hr className="my-1" />
                {board.customFields.map((def) => (
                  <Property key={def.id} label={def.name}>
                    <CustomFieldInput def={def} value={task.custom[def.id]} onChange={(v) => void patch({ custom: { [def.id]: v } })} />
                  </Property>
                ))}
              </>
            )}
            <hr className="my-1" />
            <dl className="grid gap-1 text-[11px] text-muted-foreground">
              <div className="flex justify-between">
                <dt>Created</dt>
                <dd className="tabular-nums">{fmtWhen(task.createdAt)}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Updated</dt>
                <dd className="tabular-nums">{fmtWhen(task.updatedAt)}</dd>
              </div>
              {task.completedAt != null && (
                <div className="flex justify-between">
                  <dt className="inline-flex items-center gap-1">
                    <Check className="size-3 text-emerald-500" /> Completed
                  </dt>
                  <dd className="tabular-nums">{fmtWhen(task.completedAt)}</dd>
                </div>
              )}
            </dl>
          </aside>
          </PropertiesDisclosure>
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
