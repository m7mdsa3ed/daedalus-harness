import * as React from "react"
import { useNavigate } from "react-router"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  Archive,
  ArchiveRestore,
  Bot,
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
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Separator } from "@/components/ui/separator"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { ErrorNote } from "@/components/error-note"
import { Checkbox } from "@/components/ui/checkbox"
import { captureError, inlineFromQuery, reportError, type InlineError } from "@/lib/errors"
import { Empty } from "@/components/empty"
import { SkeletonText } from "@/components/ui/skeletons"
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
import type { Actions } from "@/lib/actions"
import { AgentIcon } from "@/components/entity-icon"
import { boardPath, threadPath } from "@/lib/router"
import { isListed } from "@/lib/settings"
import { useStoreSelect } from "@/lib/store"
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

const FIELD_CHIP = buttonVariants({ variant: "outline" })

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
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        {count != null && count > 0 && <Badge variant="secondary" className="tabular-nums">{count}</Badge>}
        <span className="ml-auto">{action}</span>
      </header>
      {children}
    </section>
  )
}

function Property({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 @panel-sm:grid-cols-[6rem_minmax(0,1fr)]">
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
        className="flex w-full items-center gap-2 border-b bg-muted/50 px-4 py-3 text-xs font-medium text-muted-foreground md:hidden"
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
    case "thread":
      return "started a thread on this task"
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
      return <Checkbox checked={value === true} onCheckedChange={(checked) => onChange(checked)} aria-label={def.name} />
    case "select":
      return (
        <NativeSelect size="sm" className="w-full" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)} aria-label={def.name}>
          <NativeSelectOption value="">—</NativeSelectOption>
          {(def.options ?? []).map((o) => (
            <NativeSelectOption key={o} value={o}>
              {o}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )
    case "date":
      return <Input type="date" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)} className="h-8" aria-label={def.name} />
    default:
      return (
        <Input
          type={def.type === "number" ? "number" : def.type === "url" ? "url" : "text"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          className="h-8"
          aria-label={def.name}
          placeholder="—"
        />
      )
  }
}

/** The dialog before its task read answers. A deep link has no card in the list
    to stand in, and "Loading…" was a sentence where the dialog's own frame —
    title, meta, description — is the thing that is coming. */
function TaskDetailSkeleton() {
  return (
    <div aria-busy="true" className="space-y-4">
      <Skeleton className="h-5 w-2/3" />
      <div className="flex flex-wrap gap-2">
        {[...Array(4).keys()].map((index) => (
          <Skeleton key={index} className="h-6 w-24 rounded-full" />
        ))}
      </div>
      <Skeleton className="h-24 w-full rounded-xl" />
      <div className="space-y-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
        <Skeleton className="h-3 w-3/5" />
      </div>
    </div>
  )
}

export function TaskDetailDialog({
  actions,
  taskId,
  onClose,
  board,
  statuses,
  sprints,
  allTasks,
  facets,
  onOpen: openTask,
  onCreate,
  onUpdate,
  onDelete,
}: {
  actions: Actions
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
  const navigate = useNavigate()
  const sessions = useStoreSelect((state) => state.sessions)
  /* The threads that were started on this task, newest first. The link is the
     thread's (`sessions.taskId`), so this is a read of the list the sidebar
     already holds — the board never fetches threads. */
  const threads = React.useMemo(
    () =>
      sessions
        .filter((s) => s.taskId === taskId && isListed(s) && !s.deletedAt)
        .sort((a, b) => b.createdAt - a.createdAt),
    [sessions, taskId],
  )
  const task = detail.data?.task ?? allTasks.find((t) => t.id === taskId) ?? null
  const loadError = React.useMemo(() => inlineFromQuery(detail.error, "Couldn't load this task"), [detail.error])
  const addComment = useAddComment()
  const updateComment = useUpdateComment()
  const deleteComment = useDeleteComment()
  const addLink = useAddLink()
  const deleteLink = useDeleteLink()

  const [title, setTitle] = React.useState("")
  const [editingTitle, setEditingTitle] = React.useState(false)
  const [draft, setDraft] = React.useState<{ id: string; text: string } | null>(null)
  const [tag, setTag] = React.useState("")
  const [comment, setComment] = React.useState("")
  const [editingComment, setEditingComment] = React.useState<{ id: string; body: string } | null>(null)
  const [linkKind, setLinkKind] = React.useState<LinkKind>("relates")
  const [error, setError] = React.useState<InlineError | null>(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)

  React.useEffect(() => {
    setEditingTitle(false)
    setConfirmDelete(false)
    setError(null)
    setEditingComment(null)
  }, [taskId])

  /* The description saves itself: a draft is only pending while it differs from
     the row, and it is written after a pause or on the way out. */
  const pendingDesc = task && draft?.id === task.id && draft.text !== (task.description ?? "") ? draft.text : null
  const saveDesc = (text: string) => {
    if (!task) return
    onUpdate(task.id, { description: text.trim() || null }).catch((err) => setError(captureError(err, "Couldn't save the description")))
  }
  React.useEffect(() => {
    if (pendingDesc == null) return
    const timer = setTimeout(() => saveDesc(pendingDesc), 700)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDesc])
  const flushDesc = () => {
    if (pendingDesc != null) saveDesc(pendingDesc)
  }
  const close = () => {
    flushDesc()
    onClose()
  }
  const onOpen = (t: Task) => {
    flushDesc()
    openTask(t)
  }

  if (!task) {
    return (
      <ResponsiveDialog open={!!taskId} onOpenChange={(open) => !open && onClose()} tall>
        <ResponsiveDialogContent className="sm:max-w-3xl">
          {/* The loaded header's row, so the corner X has a header to sit in
              rather than landing on the error's Copy/Retry. */}
          <ResponsiveDialogHeader className="flex-row items-center gap-2 py-2.5">
            <ResponsiveDialogTitle className="sr-only">Task</ResponsiveDialogTitle>
            <ResponsiveDialogDescription className="sr-only">Loading</ResponsiveDialogDescription>
            <Skeleton aria-hidden className="h-8 w-40 rounded-full" />
          </ResponsiveDialogHeader>
          {loadError ? (
            <ErrorNote error={loadError} onRetry={() => void detail.refetch()} />
          ) : (
            <TaskDetailSkeleton />
          )}
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
    void writeClipboard(url).then(
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
    <ResponsiveDialog open={!!taskId} onOpenChange={(open) => !open && close()} tall>
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
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void patch({ archived: !task.archived })}
              className="text-muted-foreground"
              aria-label={task.archived ? "Restore" : "Archive"}
              title={task.archived ? "Restore" : "Archive"}
            >
              {task.archived ? <ArchiveRestore /> : <Archive />}
            </Button>
          </span>
        </ResponsiveDialogHeader>

        {/* Title block spans full width above the two panes. */}
        <div className="w-full px-4 pt-4 @panel-sm:px-6">
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
              className="w-full rounded-lg border border-input bg-transparent px-2 py-1 font-heading text-base font-medium leading-snug outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
                  className={cn("-mx-2 rounded-lg px-2 py-1 text-left font-heading text-base font-medium leading-snug hover:bg-muted", task.completedAt != null && "text-muted-foreground line-through")}
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

        {/* The task itself, as one column: the three facts that place it, its tags, its text. */}
        <div className="grid gap-3 px-4 pt-3 pb-4 @panel-sm:px-6">
          <div className="flex flex-wrap gap-2">
            <StatusPicker
              value={task.statusId}
              statuses={statuses}
              onChange={(statusId) => void patch({ statusId })}
              trigger={
                <button type="button" className={FIELD_CHIP}>
                  <span className="text-muted-foreground">Status</span>
                  <StatusPill status={status} />
                  <ChevronDown className="size-3.5 text-muted-foreground" />
                </button>
              }
            />
            <PriorityPicker
              value={task.priority}
              onChange={(priority) => void patch({ priority })}
              trigger={
                <button type="button" className={FIELD_CHIP}>
                  <span className="text-muted-foreground">Priority</span>
                  <PriorityIcon priority={task.priority} /> {PRIORITY_LABEL[task.priority]}
                  <ChevronDown className="size-3.5 text-muted-foreground" />
                </button>
              }
            />
            <AssigneePicker
              value={task.assignee}
              suggestions={facets.assignees}
              onChange={(assignee) => void patch({ assignee })}
              trigger={
                <button type="button" className={FIELD_CHIP}>
                  <span className="text-muted-foreground">Assignee</span>
                  <span className="truncate">{task.assignee ?? "Unassigned"}</span>
                  <ChevronDown className="size-3.5 text-muted-foreground" />
                </button>
              }
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {task.labels.map((l) => (
              <LabelChip key={l} label={l} onRemove={() => void patch({ labels: task.labels.filter((x) => x !== l) })} />
            ))}
            <input
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== ",") return
                e.preventDefault()
                const next = tag.trim()
                setTag("")
                if (next && !task.labels.includes(next)) void patch({ labels: [...task.labels, next] })
              }}
              list="task-label-suggestions"
              placeholder="Add tag"
              aria-label="Add tag"
              className="h-6 w-24 bg-transparent px-1 text-xs outline-none placeholder:text-muted-foreground"
            />
            <datalist id="task-label-suggestions">
              {facets.labels.filter((l) => !task.labels.includes(l)).map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </div>

          <TaskEditor
            key={task.id}
            value={task.description ?? ""}
            onChange={(text) => setDraft({ id: task.id, text })}
            placeholder="Add a description…"
            title={task.title}
            className="[&_.ProseMirror]:min-h-[12rem]"
          />
        </div>

        <div className="grid w-full content-start border-t md:grid-cols-[minmax(0,1fr)_17rem]">
          {/* Main column. */}
          <div className="grid content-start gap-6 px-4 py-4 @panel-sm:px-6">
            <Section icon={ListChecks} title="Checklist" count={progress.total} action={progress.total > 0 ? <span className="text-xs tabular-nums text-muted-foreground">{progress.done}/{progress.total}</span> : null}>
              {progress.total > 0 && (
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
                </div>
              )}
              <ul className="grid gap-0.5">
                {task.checklist.map((item) => (
                  <li key={item.id} className="group flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-muted">
                    <Checkbox checked={item.done} onCheckedChange={() => void toggleChecklist(item.id)} aria-label={item.text} />
                    <span className={cn("flex-1 text-sm", item.done && "text-muted-foreground line-through")}>{item.text}</span>
                    <Button type="button" variant="ghost" size="icon-xs" onClick={() => void removeChecklist(item.id)} aria-label="Remove item" className="text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100">
                      <X />
                    </Button>
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
                    <li key={child.id} className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-muted">
                      <TypeIcon type={child.type} />
                      <span className="font-mono text-xs text-muted-foreground">{taskKey(child, board.key)}</span>
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
              icon={Bot}
              title="Threads"
              count={threads.length}
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    /* A draft on this task, in the board's project when it has
                       one: the words are there to send as they are. The agent is
                       briefed by the server and carries the harness MCP. */
                    const id = actions.startThreadIn({
                      projectId: board.projectId ?? undefined,
                      taskId: task.id,
                      text: `Work on ${key}: ${task.title}`,
                    })
                    if (!id) return toast.error("Set up a project first — a thread needs somewhere to run")
                    close()
                    void navigate(threadPath(id))
                  }}
                >
                  <Bot data-icon="inline-start" /> Work on this
                </Button>
              }
            >
              <ul className="grid gap-0.5">
                {threads.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => {
                        close()
                        void navigate(threadPath(s.id))
                      }}
                      className="flex w-full min-w-0 items-center gap-2 rounded-lg px-1 py-1 text-left text-sm hover:bg-muted"
                    >
                      <AgentIcon agentId={s.agentId} className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{s.title}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{fmtWhen(s.createdAt)}</span>
                    </button>
                  </li>
                ))}
                {threads.length === 0 && (
                  <li>
                    <Empty>No agent has worked on this yet.</Empty>
                  </li>
                )}
              </ul>
            </Section>

            <Section
              icon={Link2}
              title="Linked tasks"
              count={links.length}
              action={
                <span className="inline-flex items-center gap-1">
                  <NativeSelect size="sm" value={linkKind} onChange={(e) => setLinkKind(e.target.value as LinkKind)} aria-label="Link kind">
                    {LINK_KINDS.map((k) => (
                      <NativeSelectOption key={k} value={k}>
                        {LINK_LABEL[k].out}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
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
                      <Button type="button" variant="outline" size="sm">
                        <Plus data-icon="inline-start" /> Link
                      </Button>
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
                    <li key={link.id} className="group flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-muted">
                      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
                      {other ? (
                        <>
                          <TypeIcon type={other.type} />
                          <span className="font-mono text-xs text-muted-foreground">{taskKey(other, board.key)}</span>
                          <button type="button" onClick={() => onOpen(other)} className={cn("min-w-0 flex-1 truncate text-left text-sm hover:underline", other.completedAt != null && "text-muted-foreground line-through")}>
                            {other.title}
                          </button>
                          <StatusPill status={statuses.find((s) => s.id === other.statusId)} compact />
                        </>
                      ) : (
                        <span className="flex-1 text-sm text-muted-foreground">A task on another board</span>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Remove link"
                        onClick={() => deleteLink.mutateAsync({ id: link.id, fromId: link.fromId, toId: link.toId }).catch((err) => reportError(err, "Couldn't remove the link"))}
                        className="text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                      >
                        <X />
                      </Button>
                    </li>
                  )
                })}
                {links.length === 0 && (
                  <li>
                    <Empty>No links yet.</Empty>
                  </li>
                )}
              </ul>
            </Section>

            <Section icon={MessageSquare} title="Comments" count={comments.length}>
              <ul className="grid gap-2">
                {comments.map((c) => (
                  <li key={c.id} className="group rounded-xl border px-3 py-2">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <AssigneeAvatar name={c.author ?? "You"} size="xs" />
                      <span className="font-medium text-foreground">{c.author ?? "You"}</span>
                      <span>{fmtWhen(c.createdAt)}</span>
                      {c.updatedAt !== c.createdAt && <span>(edited)</span>}
                      <span className="ml-auto inline-flex gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100">
                        <Button type="button" variant="ghost" size="icon-xs" onClick={() => setEditingComment({ id: c.id, body: c.body })} aria-label="Edit comment">
                          <Pencil />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => deleteComment.mutateAsync({ id: c.id, taskId: task.id }).catch((err) => reportError(err, "Couldn't delete the comment"))}
                          aria-label="Delete comment"
                          className="hover:text-destructive"
                        >
                          <Trash2 />
                        </Button>
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
                    <span>
                      {entry.actor && <span className="font-medium text-foreground">{entry.actor} </span>}
                      {describe(entry, { statuses, sprints, all: allTasks, boardKey: board.key })}
                    </span>
                  </li>
                ))}
                {activity.length === 0 &&
                  (detail.isLoading ? (
                    <li>
                      <SkeletonText lines={3} />
                    </li>
                  ) : (
                    <li>
                      <Empty>No history recorded.</Empty>
                    </li>
                  ))}
              </ul>
            </Section>

            <ErrorNote error={error} />
          </div>

          {/* Properties — a collapsed "Details" section on a phone, the right column on desktop. */}
          <PropertiesDisclosure>
          <aside className="grid content-start gap-3 border-b bg-muted/50 px-4 py-4 md:border-b-0 md:border-l">
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
                <Separator className="my-1" />
                {board.customFields.map((def) => (
                  <Property key={def.id} label={def.name}>
                    <CustomFieldInput def={def} value={task.custom[def.id]} onChange={(v) => void patch({ custom: { [def.id]: v } })} />
                  </Property>
                ))}
              </>
            )}
            <Separator className="my-1" />
            <dl className="grid gap-1 text-xs text-muted-foreground">
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
                    <Check className="size-3 text-success" /> Completed
                  </dt>
                  <dd className="tabular-nums">{fmtWhen(task.completedAt)}</dd>
                </div>
              )}
            </dl>
          </aside>
          </PropertiesDisclosure>
        </div>

        <footer className="sticky bottom-0 flex items-center gap-2 border-t bg-background px-4 py-3 @panel-sm:px-6">
          {confirmDelete ? (
            <>
              <span className="text-xs text-muted-foreground">Delete {key}?</span>
              <Button
                size="sm"
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
              <Button size="sm" variant="outline" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button size="sm" variant="destructive" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          )}
          <span className="ml-auto mr-2 hidden text-xs text-muted-foreground @panel-sm:inline">
            {comments.length} comment{comments.length === 1 ? "" : "s"}
          </span>
          <Button size="sm" onClick={close}>
            Done
          </Button>
        </footer>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
import { writeClipboard } from "@/lib/clipboard"
