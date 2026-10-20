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
  ChevronRight,
  Copy,
  Link2,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { ErrorNote } from "@/components/error-note"
import { Empty } from "@/components/empty"
import { useConfirm } from "@/components/confirm-dialog"
import { Count, Section } from "@/components/settings/primitives"
import { SkeletonText } from "@/components/ui/skeletons"
import { captureError, inlineFromQuery, reportError, type InlineError } from "@/lib/errors"
import { toast } from "@/lib/toast"
import { writeClipboard } from "@/lib/clipboard"
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
import { checklistProgress, dueLabel, isOverdue } from "@/lib/tasks-view"
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
  ICON_BTN,
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
  fromDateInput,
  toDateInput,
} from "./fields"
import { QuickAdd } from "./quick-add"
import { TaskRow, type CardContext } from "./task-card"
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

/** A property's value as the ghost trigger its picker opens from. */
const VALUE = "h-8 w-full min-w-0 justify-start px-2 font-normal pointer-coarse:h-11"

function Property({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-9 grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-2 text-sm">
      <span className="truncate text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

const ValueButton = ({ children, className, ...props }: React.ComponentProps<typeof Button>) => (
  <Button type="button" variant="ghost" size="sm" className={cn(VALUE, className)} {...props}>
    {children}
  </Button>
)

const Placeholder = ({ children }: { children: React.ReactNode }) => <span className="text-muted-foreground">{children}</span>

/** Whether a custom field holds anything — the "more properties" fold opens
    for a task that has something behind it. */
const hasValue = (v: unknown) => v != null && v !== "" && v !== false

function CustomFieldInput({ def, value, onChange }: { def: CustomFieldDef; value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = React.useState(value == null ? "" : String(value))
  React.useEffect(() => setText(value == null ? "" : String(value)), [value])
  const commit = () => {
    if (def.type === "number") onChange(text === "" ? null : Number(text))
    else onChange(text === "" ? null : text)
  }
  switch (def.type) {
    case "checkbox":
      return (
        <span className="flex h-8 items-center px-2 pointer-coarse:h-11">
          <Checkbox checked={value === true} onCheckedChange={(checked) => onChange(checked)} aria-label={def.name} />
        </span>
      )
    case "select": {
      const current = typeof value === "string" ? value : ""
      return (
        <Select value={current} onValueChange={(v) => onChange(v || null)}>
          <SelectTrigger size="sm" className="w-full pointer-coarse:h-11" aria-label={def.name}>
            <SelectValue>{current || <Placeholder>None</Placeholder>}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">None</SelectItem>
            {(def.options ?? []).map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    }
    case "date": {
      // Stored as "YYYY-MM-DD", as the date input wrote it.
      const ms = fromDateInput(typeof value === "string" ? value : undefined)
      return (
        <DatePicker
          value={ms}
          onChange={(next) => onChange(next == null ? null : toDateInput(next))}
          trigger={
            <ValueButton aria-label={def.name}>
              <CalendarIcon className="text-muted-foreground" />
              {ms != null ? new Date(ms).toLocaleDateString() : <Placeholder>None</Placeholder>}
            </ValueButton>
          }
        />
      )
    }
    default:
      return (
        <Input
          type={def.type === "number" ? "number" : def.type === "url" ? "url" : "text"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          className="h-8 pointer-coarse:h-11"
          aria-label={def.name}
          placeholder="—"
        />
      )
  }
}

/** The dialog before its task read answers: the loaded dialog's own frame —
    title, the property rows, the description — standing in for what is coming. */
function TaskDetailSkeleton() {
  return (
    <div aria-busy="true" className="grid gap-6 px-5 py-5 @panel-sm:px-6 @panel-md:grid-cols-[minmax(0,1fr)_17rem]">
      <div className="grid content-start gap-4">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-40 w-full rounded-xl" />
        <SkeletonText lines={3} />
      </div>
      <div className="grid content-start gap-2">
        {[...Array(5).keys()].map((index) => (
          <div key={index} className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-2">
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-8 w-full rounded-lg" />
          </div>
        ))}
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
  const confirm = useConfirm()
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
  /** Set by Escape, so the blur that follows the field's removal never saves. */
  const titleCancelled = React.useRef(false)
  const [draft, setDraft] = React.useState<{ id: string; text: string } | null>(null)
  const [comment, setComment] = React.useState("")
  const [editingComment, setEditingComment] = React.useState<{ id: string; body: string } | null>(null)
  const [linkKind, setLinkKind] = React.useState<LinkKind>("relates")
  const [error, setError] = React.useState<InlineError | null>(null)
  /** The narrow "more properties" fold, as the reader left it for this task;
      until they touch it, it is open when anything behind it has a value. */
  const [moreOpen, setMoreOpen] = React.useState<{ id: string; open: boolean } | null>(null)

  React.useEffect(() => {
    setEditingTitle(false)
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
        <ResponsiveDialogContent className="sm:max-w-4xl" bodyClassName="p-0 gap-0">
          {/* The loaded header's row, so the X has a header to sit in rather
              than landing on the error's Copy/Retry. */}
          <ResponsiveDialogHeader className="flex-row items-center gap-2 py-2.5">
            <ResponsiveDialogTitle className="sr-only">Task</ResponsiveDialogTitle>
            <ResponsiveDialogDescription className="sr-only">Loading</ResponsiveDialogDescription>
            <Skeleton aria-hidden className="h-7 w-40 rounded-md" />
          </ResponsiveDialogHeader>
          {loadError ? (
            <div className="px-5 py-5 @panel-sm:px-6">
              <ErrorNote error={loadError} onRetry={() => void detail.refetch()} />
            </div>
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
  const sprint = sprints.find((s) => s.id === task.sprintId)
  const links = detail.data?.links ?? []
  const comments = detail.data?.comments ?? []
  const activity = detail.data?.activity ?? []
  const done = task.completedAt != null
  const rowCtx: CardContext = {
    boardKey: board.key,
    parentOf: () => undefined,
    childCount: (t) => allTasks.filter((x) => x.parentId === t.id).length,
    selected: new Set(),
  }

  const extraCount = 4 + board.customFields.length
  const extraHasValue =
    task.startAt != null ||
    task.sprintId != null ||
    task.parentId != null ||
    task.estimate != null ||
    board.customFields.some((def) => hasValue(task.custom[def.id]))
  const extraOpen = moreOpen?.id === task.id ? moreOpen.open : extraHasValue

  const copyLink = () => {
    const url = `${location.origin}${boardPath(board.id, task.id)}`
    void writeClipboard(url).then(
      () => toast.success(`Copied a link to ${key}`),
      () => toast.error("Couldn't copy the link"),
    )
  }

  const deleteTask = async () => {
    const ok = await confirm({
      title: `Delete ${key}?`,
      description:
        children.length > 0
          ? `Its checklist, comments and history go with it, and its ${children.length} ${children.length === 1 ? "child is" : "children are"} detached. This cannot be undone.`
          : "Its checklist, comments and history go with it. This cannot be undone.",
      confirmLabel: "Delete",
      destructive: true,
    })
    if (!ok) return
    try {
      await onDelete(task.id)
      toast.success(`${key} deleted`)
      onClose()
    } catch (err) {
      reportError(err, "Couldn't delete the task")
    }
  }

  const workOnThis = () => {
    /* A draft on this task, in the board's project when it has one: the words
       are there to send as they are. The agent is briefed by the server and
       carries the harness MCP. */
    const id = actions.startThreadIn({
      projectId: board.projectId ?? undefined,
      taskId: task.id,
      text: `Work on ${key}: ${task.title}`,
    })
    if (!id) return toast.error("Set up a project first — a thread needs somewhere to run")
    close()
    void navigate(threadPath(id))
  }

  const saveTitle = async () => {
    if (titleCancelled.current) return
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

  const extraRows = (
    <>
      <Property label="Start">
        <DatePicker
          value={task.startAt}
          onChange={(startAt) => void patch({ startAt })}
          trigger={
            <ValueButton>
              <CalendarIcon className="text-muted-foreground" />
              {task.startAt != null ? new Date(task.startAt).toLocaleDateString() : <Placeholder>None</Placeholder>}
            </ValueButton>
          }
        />
      </Property>
      <Property label="Sprint">
        <SprintPicker
          value={task.sprintId}
          sprints={sprints}
          onChange={(sprintId) => void patch({ sprintId })}
          trigger={
            <ValueButton>
              <span className="truncate">{sprint?.name ?? "Backlog"}</span>
            </ValueButton>
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
            <ValueButton>
              {parent ? (
                <>
                  <TypeIcon type={parent.type} />
                  <span className="font-mono text-xs">{taskKey(parent, board.key)}</span>
                  <span className="truncate">{parent.title}</span>
                </>
              ) : (
                <Placeholder>None</Placeholder>
              )}
            </ValueButton>
          }
        />
      </Property>
      <Property label="Points">
        <NumberPicker
          value={task.estimate}
          onChange={(estimate) => void patch({ estimate })}
          trigger={<ValueButton className="tabular-nums">{task.estimate ?? <Placeholder>Unestimated</Placeholder>}</ValueButton>}
        />
      </Property>
      {board.customFields.map((def) => (
        <Property key={def.id} label={def.name}>
          <CustomFieldInput def={def} value={task.custom[def.id]} onChange={(v) => void patch({ custom: { [def.id]: v } })} />
        </Property>
      ))}
    </>
  )

  return (
    <ResponsiveDialog open={!!taskId} onOpenChange={(open) => !open && close()} tall>
      <ResponsiveDialogContent className="sm:max-w-4xl" bodyClassName="p-0 gap-0">
        {/* Header: where the task sits, its key and type, and what can be done
            to it. The dialog's X stays at the row's end. A container, because
            the header is outside the body's. */}
        <ResponsiveDialogHeader className="@container flex-row items-center gap-2 py-2.5">
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            {parent && (
              <>
                <button
                  type="button"
                  onClick={() => onOpen(parent)}
                  className="flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 hover:bg-muted hover:text-foreground"
                  title={`Open ${taskKey(parent, board.key)}`}
                >
                  <span className="shrink-0 font-mono">{taskKey(parent, board.key)}</span>
                  <span className="hidden max-w-48 truncate @panel-sm:inline">{parent.title}</span>
                </button>
                <ChevronRight className="size-3 shrink-0" aria-hidden />
              </>
            )}
            <button
              type="button"
              onClick={copyLink}
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-1 py-0.5 font-mono text-foreground hover:bg-muted"
              title="Copy link"
              aria-current="page"
            >
              {key} <Copy className="size-3 text-muted-foreground" />
            </button>
          </nav>
          <TypePicker
            value={task.type}
            onChange={(type) => void patch({ type })}
            trigger={
              <button type="button" className={cn(CHIP, "shrink-0")}>
                <TypeIcon type={task.type} /> {TYPE_LABEL[task.type]}
              </button>
            }
          />
          <span className="ms-auto flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void patch({ archived: !task.archived })}
              className={cn(ICON_BTN, "text-muted-foreground")}
              aria-label={task.archived ? "Restore" : "Archive"}
              title={task.archived ? "Restore" : "Archive"}
            >
              {task.archived ? <ArchiveRestore /> : <Archive />}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Task options" title="Task options" className={cn(ICON_BTN, "text-muted-foreground")}>
                    <MoreHorizontal />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onClick={copyLink}>
                  <Link2 /> Copy link
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => void deleteTask()}>
                  <Trash2 /> Delete…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </ResponsiveDialogHeader>

        {/* One render, placed by CSS: title, properties, body stacked on a narrow
            panel; from @panel-md the properties are a column beside the other two. */}
        <div className="grid @panel-md:grid-cols-[minmax(0,1fr)_17rem] @panel-md:grid-rows-[auto_1fr]">
          <div className="min-w-0 px-5 pt-5 @panel-sm:px-6 @panel-md:col-start-1">
            {editingTitle ? (
              <Textarea
                autoFocus
                rows={1}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => void saveTitle()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    void saveTitle()
                  }
                  if (e.key === "Escape") {
                    // The dialog would take Escape as close; here it only cancels the rename.
                    e.stopPropagation()
                    titleCancelled.current = true
                    setEditingTitle(false)
                  }
                }}
                aria-label="Title"
                className="-mx-2 min-h-0 w-[calc(100%+1rem)] px-2 py-1 font-heading text-xl leading-snug font-medium md:text-xl"
              />
            ) : (
              <ResponsiveDialogTitle
                render={
                  <button
                    type="button"
                    onClick={() => {
                      titleCancelled.current = false
                      setTitle(task.title)
                      setEditingTitle(true)
                    }}
                    className={cn(
                      "-mx-2 block w-[calc(100%+1rem)] rounded-lg px-2 py-1 text-left font-heading text-xl leading-snug font-medium text-pretty hover:bg-muted",
                      done && "text-muted-foreground line-through",
                    )}
                    title="Click to rename"
                  />
                }
              >
                {task.title}
              </ResponsiveDialogTitle>
            )}
            <ResponsiveDialogDescription className="sr-only">{key}</ResponsiveDialogDescription>
            {done && (
              <p className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Check className="size-3 text-success" /> Completed {fmtWhen(task.completedAt!)}
              </p>
            )}
            {task.archived && <p className="mt-1 text-xs text-muted-foreground">Archived — hidden from every view unless the filter includes it.</p>}
          </div>

          <aside
            aria-label="Properties"
            className="min-w-0 px-5 py-4 @panel-sm:px-6 @panel-md:sticky @panel-md:top-0 @panel-md:col-start-2 @panel-md:row-span-2 @panel-md:row-start-1 @panel-md:self-start @panel-md:border-s @panel-md:bg-muted/30 @panel-md:px-4 @panel-md:py-5"
          >
            <div className="grid gap-0.5">
              <Property label="Status">
                <StatusPicker
                  value={task.statusId}
                  statuses={statuses}
                  onChange={(statusId) => void patch({ statusId })}
                  trigger={
                    <ValueButton>
                      <StatusPill status={status} />
                    </ValueButton>
                  }
                />
              </Property>
              <Property label="Priority">
                <PriorityPicker
                  value={task.priority}
                  onChange={(priority) => void patch({ priority })}
                  trigger={
                    <ValueButton>
                      <PriorityIcon priority={task.priority} /> {PRIORITY_LABEL[task.priority]}
                    </ValueButton>
                  }
                />
              </Property>
              <Property label="Assignee">
                <AssigneePicker
                  value={task.assignee}
                  suggestions={facets.assignees}
                  onChange={(assignee) => void patch({ assignee })}
                  trigger={
                    <ValueButton>
                      <AssigneeAvatar name={task.assignee} size="xs" />
                      <span className="truncate">{task.assignee ?? <Placeholder>Unassigned</Placeholder>}</span>
                    </ValueButton>
                  }
                />
              </Property>
              <Property label="Labels">
                <div className="flex min-h-8 flex-wrap items-center gap-1 py-1 ps-2">
                  {task.labels.map((l) => (
                    <LabelChip key={l} label={l} onRemove={() => void patch({ labels: task.labels.filter((x) => x !== l) })} />
                  ))}
                  <LabelsPicker
                    value={task.labels}
                    suggestions={facets.labels}
                    onChange={(labels) => void patch({ labels })}
                    trigger={
                      task.labels.length === 0 ? (
                        <Button type="button" variant="ghost" size="sm" className="-ms-2 h-8 px-2 font-normal text-muted-foreground pointer-coarse:h-11">
                          Add labels
                        </Button>
                      ) : (
                        <Button type="button" variant="ghost" size="icon-sm" aria-label="Edit labels" title="Edit labels" className={cn(ICON_BTN, "size-6 text-muted-foreground")}>
                          <Plus />
                        </Button>
                      )
                    }
                  />
                </div>
              </Property>
              <Property label="Due">
                <DatePicker
                  value={task.dueAt}
                  onChange={(dueAt) => void patch({ dueAt })}
                  trigger={
                    <ValueButton className={cn(isOverdue(task) && "text-destructive")}>
                      <CalendarIcon className={cn(!isOverdue(task) && "text-muted-foreground")} />
                      {dueLabel(task.dueAt) ?? <Placeholder>None</Placeholder>}
                    </ValueButton>
                  }
                />
              </Property>

              {/* Below @panel-md the rest is a fold; from @panel-md it is simply
                  the rest of the list. A div rather than a Collapsible panel,
                  because a closed panel is `[hidden]` and the base layer's
                  `display: none !important` would win over the wide reveal. */}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={extraOpen}
                aria-controls="task-more-properties"
                onClick={() => setMoreOpen({ id: task.id, open: !extraOpen })}
                className="mt-1 justify-start px-2 text-muted-foreground pointer-coarse:h-11 @panel-md:hidden"
              >
                <ChevronDown className={cn("transition-transform", extraOpen && "rotate-180")} data-icon="inline-start" />
                {extraOpen ? "Fewer properties" : `${extraCount} more properties`}
              </Button>
              <div id="task-more-properties" className={cn("gap-0.5", extraOpen ? "grid" : "hidden", "@panel-md:grid")}>
                {extraRows}
              </div>
            </div>

            <dl className="mt-4 grid gap-1 border-t pt-4 text-xs text-muted-foreground">
              <div className="flex justify-between gap-2">
                <dt>Created</dt>
                <dd className="tabular-nums">{fmtWhen(task.createdAt)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Updated</dt>
                <dd className="tabular-nums">{fmtWhen(task.updatedAt)}</dd>
              </div>
              {task.completedAt != null && (
                <div className="flex justify-between gap-2">
                  <dt className="inline-flex items-center gap-1">
                    <Check className="size-3 text-success" /> Completed
                  </dt>
                  <dd className="tabular-nums">{fmtWhen(task.completedAt)}</dd>
                </div>
              )}
            </dl>
          </aside>

          <div className="min-w-0 px-5 pb-6 @panel-sm:px-6 @panel-md:col-start-1 @panel-md:pt-6">
            <Section label="Description">
              <TaskEditor
                key={task.id}
                value={task.description ?? ""}
                onChange={(text) => setDraft({ id: task.id, text })}
                placeholder="Add a description…"
                title={task.title}
                className="[&_.ProseMirror]:min-h-[12rem]"
              />
            </Section>

            <Section
              label="Checklist"
              action={
                progress.total > 0 ? (
                  <Count>
                    {progress.done}/{progress.total}
                  </Count>
                ) : null
              }
            >
              {progress.total > 0 && (
                <Progress
                  value={Math.round((progress.done / progress.total) * 100)}
                  aria-label="Checklist progress"
                  className="mb-2 px-1 [&_[data-slot=progress-track]]:h-1.5"
                />
              )}
              <ul className="grid">
                {task.checklist.map((item) => (
                  <li key={item.id} className="group/item flex min-h-9 items-center gap-2 rounded-lg px-1 hover:bg-muted/50 pointer-coarse:min-h-11">
                    <Checkbox checked={item.done} onCheckedChange={() => void toggleChecklist(item.id)} aria-label={item.text} />
                    <span className={cn("min-w-0 flex-1 text-sm", item.done && "text-muted-foreground line-through")}>{item.text}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => void removeChecklist(item.id)}
                      aria-label="Remove item"
                      title="Remove item"
                      className={cn(ICON_BTN, "text-muted-foreground opacity-0 group-hover/item:opacity-100 hover:text-destructive focus-visible:opacity-100 pointer-coarse:opacity-100")}
                    >
                      <X />
                    </Button>
                  </li>
                ))}
              </ul>
              <QuickAdd label="Add item" placeholder="Add a checklist item…" onCreate={addChecklist} />
            </Section>

            <Section label={task.type === "epic" ? "Child issues" : "Sub-issues"} count={children.length}>
              {children.length > 0 && (
                <div className="@container mb-2 divide-y overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/10">
                  {children.map((child) => {
                    const cs = statuses.find((s) => s.id === child.statusId)
                    return (
                      <TaskRow
                        key={child.id}
                        task={child}
                        status={cs ?? null}
                        ctx={rowCtx}
                        onClick={() => onOpen(child)}
                        trailing={
                          <StatusPicker
                            value={child.statusId}
                            statuses={statuses}
                            onChange={(statusId) => void onUpdate(child.id, { statusId }).catch((err) => reportError(err, "Couldn't move the sub-issue"))}
                            trigger={
                              <button type="button" className={cn(CHIP, "px-1")} aria-label={`Status: ${cs?.name ?? "none"}`} title={cs?.name}>
                                <StatusPill status={cs} compact />
                              </button>
                            }
                          />
                        }
                      />
                    )
                  })}
                </div>
              )}
              <QuickAdd
                label={task.type === "epic" ? "Add child issue" : "Add sub-issue"}
                placeholder={task.type === "epic" ? "Add a child issue…" : "Add a sub-issue…"}
                onCreate={async (t) => {
                  await onCreate({ title: t, parentId: task.id, sprintId: task.sprintId, statusId: statuses[0]?.id })
                }}
              />
            </Section>

            <Section label="Threads" count={threads.length}>
              {threads.length > 0 ? (
                <ul className="grid gap-0.5 rounded-2xl p-2 ring-1 ring-foreground/10">
                  {threads.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => {
                          close()
                          void navigate(threadPath(s.id))
                        }}
                        className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-muted pointer-coarse:min-h-11"
                      >
                        <AgentIcon agentId={s.agentId} className="size-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{s.title}</span>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{fmtWhen(s.createdAt)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty icon={Bot}>No agent has worked on this yet — “Work on this” starts a thread.</Empty>
              )}
            </Section>

            <Section label="Links" count={links.length}>
              <ul className="grid gap-0.5 rounded-2xl p-2 ring-1 ring-foreground/10">
                {links.map((link) => {
                  const outbound = link.fromId === task.id
                  const otherId = outbound ? link.toId : link.fromId
                  const other = allTasks.find((t) => t.id === otherId)
                  const label = outbound ? LINK_LABEL[link.kind].out : LINK_LABEL[link.kind].in
                  return (
                    <li key={link.id} className="group/link flex min-h-9 items-center gap-2 rounded-lg px-2 hover:bg-muted/50 pointer-coarse:min-h-11">
                      <span className="w-24 shrink-0 truncate text-xs text-muted-foreground">{label}</span>
                      {other ? (
                        <>
                          <TypeIcon type={other.type} />
                          <span className="shrink-0 font-mono text-xs text-muted-foreground">{taskKey(other, board.key)}</span>
                          <button
                            type="button"
                            onClick={() => onOpen(other)}
                            className={cn("min-w-0 flex-1 truncate text-left text-sm hover:underline", other.completedAt != null && "text-muted-foreground line-through")}
                          >
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
                        size="icon-sm"
                        aria-label="Remove link"
                        title="Remove link"
                        onClick={() => deleteLink.mutateAsync({ id: link.id, fromId: link.fromId, toId: link.toId }).catch((err) => reportError(err, "Couldn't remove the link"))}
                        className={cn(ICON_BTN, "text-muted-foreground opacity-0 group-hover/link:opacity-100 hover:text-destructive focus-visible:opacity-100 pointer-coarse:opacity-100")}
                      >
                        <X />
                      </Button>
                    </li>
                  )
                })}
                <li className="flex flex-wrap items-center gap-2 px-1 py-1">
                  <Select value={linkKind} onValueChange={(v) => v && setLinkKind(v as LinkKind)}>
                    <SelectTrigger size="sm" className="pointer-coarse:h-11" aria-label="Link kind">
                      <SelectValue>{LINK_LABEL[linkKind].out}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {LINK_KINDS.map((k) => (
                        <SelectItem key={k} value={k}>
                          {LINK_LABEL[k].out}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
                      <Button type="button" variant="ghost" size="sm" className="text-muted-foreground pointer-coarse:h-11">
                        <Plus data-icon="inline-start" /> Link a task
                      </Button>
                    }
                  />
                </li>
              </ul>
            </Section>

            <Section>
              <Tabs defaultValue="comments">
                <TabsList variant="line">
                  <TabsTrigger value="comments" className="pointer-coarse:h-11">
                    Comments {comments.length > 0 && <Count>{comments.length}</Count>}
                  </TabsTrigger>
                  <TabsTrigger value="activity" className="pointer-coarse:h-11">
                    Activity {activity.length > 0 && <Count>{activity.length}</Count>}
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="comments" className="grid gap-3 pt-2">
                  {comments.map((c) => (
                    <article key={c.id} className="group/comment rounded-2xl p-3 ring-1 ring-foreground/10">
                      <header className="flex items-center gap-2 text-xs text-muted-foreground">
                        <AssigneeAvatar name={c.author ?? "You"} size="xs" />
                        <span className="font-medium text-foreground">{c.author ?? "You"}</span>
                        <span className="tabular-nums">{fmtWhen(c.createdAt)}</span>
                        {c.updatedAt !== c.createdAt && <span>(edited)</span>}
                        <span className="ms-auto inline-flex gap-1 opacity-0 group-hover/comment:opacity-100 group-focus-within/comment:opacity-100 pointer-coarse:opacity-100">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => setEditingComment({ id: c.id, body: c.body })}
                            aria-label="Edit comment"
                            title="Edit comment"
                            className={ICON_BTN}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => deleteComment.mutateAsync({ id: c.id, taskId: task.id }).catch((err) => reportError(err, "Couldn't delete the comment"))}
                            aria-label="Delete comment"
                            title="Delete comment"
                            className={cn(ICON_BTN, "hover:text-destructive")}
                          >
                            <Trash2 />
                          </Button>
                        </span>
                      </header>
                      {editingComment?.id === c.id ? (
                        <div className="mt-2 grid gap-2">
                          <Textarea value={editingComment.body} onChange={(e) => setEditingComment({ id: c.id, body: e.target.value })} className="min-h-12 text-sm" aria-label="Edit comment" />
                          <div className="flex justify-end gap-2">
                            <Button size="sm" variant="outline" onClick={() => setEditingComment(null)} className="pointer-coarse:h-11">
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              className="pointer-coarse:h-11"
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
                        <div className="prose prose-sm mt-2 max-w-none dark:prose-invert">
                          <Markdown remarkPlugins={[remarkGfm]}>{c.body}</Markdown>
                        </div>
                      )}
                    </article>
                  ))}
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
                    className="grid gap-2"
                  >
                    <Textarea
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") e.currentTarget.form?.requestSubmit()
                      }}
                      placeholder="Write a comment… markdown works"
                      aria-label="Comment"
                      className="min-h-16 text-sm"
                    />
                    <div className="flex items-center justify-end gap-2">
                      <span className="text-xs text-muted-foreground pointer-coarse:hidden">
                        <Kbd>⌘↵</Kbd> to post
                      </span>
                      <Button size="sm" type="submit" disabled={!comment.trim() || addComment.isPending} className="pointer-coarse:h-11">
                        Comment
                      </Button>
                    </div>
                  </form>
                </TabsContent>
                <TabsContent value="activity" className="pt-2">
                  <ul className="grid gap-2 text-xs text-muted-foreground">
                    {activity.map((entry) => (
                      <li key={entry.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
                        <span>
                          {entry.actor && <span className="font-medium text-foreground">{entry.actor} </span>}
                          {describe(entry, { statuses, sprints, all: allTasks, boardKey: board.key })}
                        </span>
                        <span className="tabular-nums">{fmtWhen(entry.at)}</span>
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
                </TabsContent>
              </Tabs>
            </Section>

            <ErrorNote error={error} className="mt-6" />
          </div>
        </div>

        <ResponsiveDialogFooter>
          <Button type="button" variant="outline" onClick={workOnThis}>
            <Bot data-icon="inline-start" /> Work on this
          </Button>
          <Button type="button" onClick={close}>
            Done
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
