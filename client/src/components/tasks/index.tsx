import { MENU_WIDTH } from "@/components/menu-row"
import * as React from "react"
import { useNavigate, useParams, useSearchParams } from "react-router"
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  FolderKanban,
  MoreHorizontal,
  Plus,
  Rocket,
  Settings2,
  Signal,
  SquareKanban,
  Trash2,
  X,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { inlineFromQuery, reportError } from "@/lib/errors"
import { toast } from "@/lib/toast"
import type { Actions } from "@/lib/actions"
import { boardPath } from "@/lib/router"
import { useServer } from "@/lib/server-context"
import { loadNewTaskDraft } from "@/lib/task-drafts"
import type { BoardLocation } from "@/lib/tasks-location"
import { useProjects } from "@/lib/queries/catalog"
import { useIsNarrow } from "@/hooks/use-device"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ProjectIcon } from "@/components/entity-icon"
import { ErrorNote } from "@/components/error-note"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { Item } from "@/components/ui/item"
import { Progress } from "@/components/ui/progress"
import { Empty } from "@/components/empty"
import { useConfirm } from "@/components/confirm-dialog"
import { Count, TabBar } from "@/components/settings/primitives"
import { COLOR_DOT, listsOf, sprintsOf, statusesOf, viewsOf, type Board, type BoardStatus, type BoardView, type Sprint } from "@/lib/boards"
import { taskKey, type ReorderEntry, type Task, type TaskInput } from "@/lib/tasks-board"
import {
  DEFAULT_VIEW,
  EMPTY_FILTERS,
  activeFilterCount,
  facetsOf,
  matchesFilters,
  matchesQuery,
  sortTasks,
  sprintProgress,
  viewStateFrom,
  type ViewState,
} from "@/lib/tasks-view"
import {
  useBoards,
  useBulkUpdateTasks,
  useCreateTask,
  useDeleteTask,
  useDeleteView,
  useReorderStatuses,
  useReorderTasks,
  useStartSprint,
  useTasksQuery,
  useUpdateTask,
  useDeleteSprint,
} from "@/lib/queries/boards"
import { AssigneeAvatar, AssigneePicker, ICON_BTN, PriorityIcon, PriorityPicker, SprintPicker, StatusPicker, StatusPill } from "./fields"
import type { CardContext } from "./task-card"
import { Toolbar } from "./toolbar"
import { INSET_X, MODES, type WorkspaceMode } from "./modes"
import { KanbanView } from "./views/kanban"
import { ListView } from "./views/list"
import { TableView } from "./views/table"
import { CalendarView } from "./views/calendar"
import { TimelineView } from "./views/timeline"
import { BacklogView } from "./views/backlog"
import { TaskDetailDialog } from "./task-detail"
import { NewTaskDialog } from "./new-task-dialog"
import {
  BoardDialog,
  ColumnDialog,
  CompleteSprintDialog,
  DeleteBoardDialog,
  DeleteStatusDialog,
  SaveViewDialog,
  SprintDialog,
} from "./board-dialogs"
import type { ViewProps } from "./types"

/* ── Device-local reading state ──
   Which board was last open, and per board: which layout, the live view state
   (filters, grouping, sort, columns) and which saved view it came from. How a
   board is read is a property of the reader, not of the board, so it lives in
   localStorage, never on the server (a saved view is the deliberate exception). */
const LAST_BOARD_KEY = "ui.tasks.board"
const modeKey = (id: string) => `ui.tasks.mode.${id}`
const viewKey = (id: string) => `ui.tasks.view.${id}`
const savedKey = (id: string) => `ui.tasks.saved.${id}`

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback
  } catch {
    return fallback
  }
}

/** One kanban column's width — the skeleton draws its columns at it too. */
const COLUMN_W = "w-[min(18rem,calc(100cqw-3rem))]"

/**
 * Weave the tasks a filter is hiding back into a column's new order.
 *
 * The kanban only ever sees the tasks that pass the search and filter chips, so
 * the id list a drop produces is the *visible* order — and writing that back
 * verbatim would renumber the column from 0 while the tasks filtered out of it
 * kept their old positions, colliding with the new ones. Each hidden task is
 * re-inserted after however many visible tasks preceded it originally, so
 * clearing the filter shows it roughly where it was.
 */
function weaveHidden(fullOrder: Task[], visibleNewOrder: string[], moved: Set<string>): string[] {
  const staying = new Set(visibleNewOrder)
  const hidden: { id: string; anchor: number }[] = []
  let seen = 0
  for (const task of fullOrder) {
    if (moved.has(task.id)) continue
    if (staying.has(task.id)) seen++
    else hidden.push({ id: task.id, anchor: seen })
  }
  if (hidden.length === 0) return visibleNewOrder
  const out: string[] = []
  let next = 0
  for (let i = 0; i < visibleNewOrder.length; i++) {
    while (next < hidden.length && hidden[next].anchor === i) out.push(hidden[next++].id)
    out.push(visibleNewOrder[i])
  }
  while (next < hidden.length) out.push(hidden[next++].id)
  return out
}

/** A board's face: its project's mark, else its colour dot. */
function BoardMark({ board }: { board: Board }) {
  const projects = useProjects()
  const project = board.projectId ? projects.find((p) => p.id === board.projectId) : undefined
  return project ? (
    <ProjectIcon project={project} className="size-4" />
  ) : (
    <span className={cn("size-2.5 shrink-0 rounded-full", board.color ? COLOR_DOT[board.color] : "bg-muted-foreground/40")} />
  )
}

const RAIL_ROW = "w-full rounded-lg text-start hover:bg-muted"
const RAIL_HEAD = "px-3 pb-1 text-xs font-medium text-muted-foreground"

/** The left rail, from `@panel-lg`: every board, the current one's sprint, and its saved views. */
function BoardRail({
  boards,
  current,
  counts,
  sprints,
  views,
  activeViewId,
  allTasks,
  statuses,
  onPick,
  onPickView,
  onNewBoard,
  onSprints,
}: {
  boards: Board[]
  current: Board
  counts: Map<string, number>
  sprints: Sprint[]
  views: BoardView[]
  activeViewId: string | null
  allTasks: Task[]
  statuses: BoardStatus[]
  onPick: (board: Board) => void
  onPickView: (view: BoardView) => void
  onNewBoard: () => void
  onSprints: () => void
}) {
  const active = sprints.find((s) => s.state === "active")
  const progress = active ? sprintProgress(allTasks, active.id, statuses) : null
  const pct = progress?.total ? Math.round((progress.done / progress.total) * 100) : 0
  return (
    <aside className="hidden min-h-0 flex-col gap-6 overflow-y-auto border-e p-2 @panel-lg:flex">
      <nav aria-label="Boards" className="grid gap-0.5">
        <span className={RAIL_HEAD}>Boards</span>
        {boards.map((b) => (
          <Item
            key={b.id}
            size="xs"
            render={<button type="button" />}
            onClick={() => onPick(b)}
            aria-current={b.id === current.id ? "page" : undefined}
            className={cn(RAIL_ROW, "flex-nowrap", b.id === current.id && "bg-muted font-medium")}
          >
            <BoardMark board={b} />
            <span className="min-w-0 flex-1 truncate">{b.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{b.key}</span>
            <Count>{counts.get(b.id) ?? 0}</Count>
          </Item>
        ))}
        <Item size="xs" render={<button type="button" />} onClick={onNewBoard} className={cn(RAIL_ROW, "flex-nowrap text-muted-foreground")}>
          <Plus className="size-4" /> New board
        </Item>
      </nav>
      <div className="grid gap-0.5">
        <span className={RAIL_HEAD}>Sprint</span>
        <Item size="xs" render={<button type="button" />} onClick={onSprints} className={cn(RAIL_ROW, "grid gap-1.5")}>
          {active && progress ? (
            <>
              <span className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium">{active.name}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {progress.done}/{progress.total}
                </span>
              </span>
              <Progress value={pct} aria-label="Sprint progress" className="[&_[data-slot=progress-track]]:h-1.5" />
              {active.endAt != null && (
                <span className="text-xs text-muted-foreground">Ends {new Date(active.endAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
              )}
            </>
          ) : (
            <span className="text-xs text-muted-foreground">No active sprint — plan one</span>
          )}
        </Item>
      </div>
      {views.length > 0 && (
        <nav aria-label="Saved views" className="grid gap-0.5">
          <span className={RAIL_HEAD}>Views</span>
          {views.map((v) => {
            const Icon = MODES.find((m) => m.id === v.kind)?.icon ?? SquareKanban
            return (
              <Item
                key={v.id}
                size="xs"
                render={<button type="button" />}
                onClick={() => onPickView(v)}
                aria-current={v.id === activeViewId ? "true" : undefined}
                className={cn(RAIL_ROW, "flex-nowrap", v.id === activeViewId && "bg-muted font-medium")}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{v.name}</span>
              </Item>
            )
          })}
        </nav>
      )}
    </aside>
  )
}

type BulkPatch = Parameters<ReturnType<typeof useBulkUpdateTasks>["mutateAsync"]>[0]["patch"]

/** The value every task in `tasks` shares, else undefined (a mixed picker). */
function shared<T>(tasks: Task[], pick: (t: Task) => T): T | undefined {
  if (tasks.length === 0) return undefined
  const first = pick(tasks[0])
  return tasks.every((t) => pick(t) === first) ? first : undefined
}

const BULK_BTN = "pointer-coarse:h-11"

/** A selection's verbs, floating over the foot of the view at every width. */
function BulkBar({
  tasks,
  statuses,
  sprints,
  facets,
  onPatch,
  onDelete,
  onClear,
}: {
  tasks: Task[]
  statuses: BoardStatus[]
  sprints: Sprint[]
  facets: { assignees: string[]; labels: string[] }
  onPatch: (patch: BulkPatch) => void
  onDelete: () => void
  onClear: () => void
}) {
  const statusId = shared(tasks, (t) => t.statusId)
  const priority = shared(tasks, (t) => t.priority)
  const assignee = shared(tasks, (t) => t.assignee)
  const sprintId = shared(tasks, (t) => t.sprintId)
  const status = statuses.find((s) => s.id === statusId)
  return (
    <div
      role="toolbar"
      aria-label="Selection"
      className="absolute inset-x-0 bottom-[calc(var(--safe-bottom,0px)+0.75rem)] z-20 mx-auto flex w-fit max-w-[calc(100%-1.5rem)] items-center gap-1 rounded-2xl bg-popover p-1.5 shadow-lg ring-1 ring-foreground/10"
    >
      <span className="flex shrink-0 items-center gap-1.5 px-1.5 text-sm font-medium">
        <Count>{tasks.length}</Count>
        <span className="hidden @panel-sm:inline">selected</span>
      </span>
      <StatusPicker
        value={statusId}
        statuses={statuses}
        onChange={(statusId) => onPatch({ statusId })}
        trigger={
          <Button type="button" variant="ghost" size="sm" title="Status" className={BULK_BTN}>
            {status ? <StatusPill status={status} compact /> : <StatusPill status={undefined} />}
            <span className="hidden @panel-sm:inline">Status</span>
          </Button>
        }
      />
      <PriorityPicker
        value={priority}
        onChange={(priority) => onPatch({ priority })}
        trigger={
          <Button type="button" variant="ghost" size="sm" title="Priority" className={BULK_BTN}>
            {priority ? <PriorityIcon priority={priority} /> : <Signal className="text-muted-foreground" />}
            <span className="hidden @panel-sm:inline">Priority</span>
          </Button>
        }
      />
      <AssigneePicker
        value={assignee}
        suggestions={facets.assignees}
        onChange={(assignee) => onPatch({ assignee })}
        trigger={
          <Button type="button" variant="ghost" size="sm" title="Assignee" className={BULK_BTN}>
            <AssigneeAvatar name={assignee ?? null} size="xs" />
            <span className="hidden @panel-sm:inline">Assignee</span>
          </Button>
        }
      />
      <SprintPicker
        value={sprintId}
        sprints={sprints}
        onChange={(sprintId) => onPatch({ sprintId })}
        trigger={
          <Button type="button" variant="ghost" size="sm" title="Sprint" className={BULK_BTN}>
            <Rocket className="text-muted-foreground" />
            <span className="hidden @panel-sm:inline">Sprint</span>
          </Button>
        }
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button type="button" variant="ghost" size="icon-sm" aria-label="More actions" className={ICON_BTN}>
              <MoreHorizontal />
            </Button>
          }
        />
        <DropdownMenuContent align="end" side="top" className="w-44">
          <DropdownMenuItem onClick={() => onPatch({ archived: true })}>
            <Archive /> Archive
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onPatch({ archived: false })}>
            <ArchiveRestore /> Restore
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 /> Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button type="button" variant="ghost" size="icon-sm" onClick={onClear} aria-label="Clear selection" title="Clear selection" className={ICON_BTN}>
        <X />
      </Button>
    </div>
  )
}

/** The board as a page: the location is the URL, so a board and a task are
    both things that can be linked to and reloaded. The dock's own host is
    `components/workspace/tasks-panel.tsx`; both render the workspace below. */
export function TasksWorkspace({ actions }: { actions: Actions }) {
  return <BoardWorkspace location={useRouteBoardLocation()} actions={actions} />
}

/** The route's answer to "where am I": `/board/:boardId`, with the open task
    as `?task=`. Replaces the three router hooks the workspace used to call
    itself — see `lib/tasks-location.ts` for why that had to stop. */
function useRouteBoardLocation(): BoardLocation {
  const navigate = useNavigate()
  const params = useParams<{ boardId?: string }>()
  const [search, setSearch] = useSearchParams()
  return {
    boardId: params.boardId ?? "",
    taskId: search.get("task"),
    openBoard: (boardId, taskId, options) =>
      void navigate(boardPath(boardId, taskId), { replace: options?.replace }),
    openTask: (taskId) =>
      setSearch(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (taskId) next.set("task", taskId)
          else next.delete("task")
          return next
        },
        { replace: true }
      ),
  }
}

/** Columns of cards at the kanban's own width — the shape the board view
    fills, so the frame is already where it will be when the task read answers. */
function BoardColumnsSkeleton() {
  return (
    <div aria-busy="true" className={cn("flex h-full gap-3 overflow-hidden pb-3", INSET_X)}>
      {[...Array(4).keys()].map((column) => (
        <div key={column} className={cn(COLUMN_W, "flex shrink-0 flex-col gap-2 self-start rounded-2xl bg-muted/50 p-2")}>
          <Skeleton className="m-1 h-4 w-24" />
          {[...Array(column === 0 ? 3 : 2).keys()].map((card) => (
            <Skeleton key={card} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      ))}
    </div>
  )
}

/** The list, table, calendar and sprint modes while the task read is out: one card of rows. */
function BoardRowsSkeleton() {
  return (
    <div aria-busy="true" className={cn("mx-auto w-full max-w-6xl py-3", INSET_X)}>
      <div className="divide-y overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/10">
        {[...Array(8).keys()].map((index) => (
          <div key={index} className="flex h-11 items-center gap-3 px-3">
            <Skeleton className="size-4 rounded-sm" />
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="size-6 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  )
}

/** The board's frame before its reads answer: the rail, the header, the tab
    bar, the toolbar and the columns in their sizes. A pending board used to
    draw as a board with no cards, which is a claim about the data rather than
    about the read. */
function BoardSkeleton() {
  return (
    <>
      <div aria-busy="true" className="hidden flex-col gap-1 border-e p-2 @panel-lg:flex">
        {[...Array(4).keys()].map((index) => (
          <div key={index} className="flex h-9 items-center gap-2 px-3">
            <Skeleton className="size-3.5 shrink-0 rounded-full" />
            <Skeleton className="h-3 flex-1" />
          </div>
        ))}
      </div>
      <div aria-busy="true" className="flex min-h-0 min-w-0 flex-col">
        <div className={cn("flex h-12 items-center gap-2", INSET_X)}>
          <Skeleton className="h-4 w-40" />
          <Skeleton className="ms-auto h-8 w-24" />
        </div>
        <div className={cn("flex h-9 items-center gap-4 border-b", INSET_X)}>
          {[...Array(4).keys()].map((index) => (
            <Skeleton key={index} className="h-3 w-14" />
          ))}
        </div>
        <div className={cn("flex items-center gap-2 py-3", INSET_X)}>
          <Skeleton className="h-9 w-full max-w-sm" />
          <Skeleton className="h-9 w-24" />
        </div>
        <div className="min-h-0 flex-1">
          <BoardColumnsSkeleton />
        </div>
      </div>
    </>
  )
}

/** One board, however it is being hosted. */
export function BoardWorkspace({ location, actions }: { location: BoardLocation; actions: Actions }) {
  const server = useServer()
  const projects = useProjects()
  const confirm = useConfirm()
  /* The root is the container every `@panel-*` in the workspace measures, and
     the box `useIsNarrow` watches — so it is mounted in every state. */
  const rootRef = React.useRef<HTMLDivElement>(null)
  const narrow = useIsNarrow(rootRef)

  const tasksQuery = useTasksQuery()
  const tasks = React.useMemo(() => tasksQuery.data ?? [], [tasksQuery.data])
  const tasksError = React.useMemo(() => inlineFromQuery(tasksQuery.error, "Couldn't read the tasks"), [tasksQuery.error])
  const { boards, statuses: allStatuses, sprints: allSprints, views: allViews, lists: allLists, loaded, error: boardsError } = useBoards()
  const createTaskMut = useCreateTask()
  const updateTaskMut = useUpdateTask()
  const deleteTaskMut = useDeleteTask()
  const bulkMut = useBulkUpdateTasks()
  const reorderTasksMut = useReorderTasks()
  const reorderStatusesMut = useReorderStatuses()
  const startSprintMut = useStartSprint()
  const deleteSprintMut = useDeleteSprint()
  const deleteViewMut = useDeleteView()

  /* ── which board ── the host's, else the remembered one, else the first. */
  const { boardId, openBoard, openTask: setOpenTask } = location
  React.useEffect(() => {
    if (!loaded || boards.length === 0) return
    if (boards.some((b) => b.id === boardId)) {
      localStorage.setItem(LAST_BOARD_KEY, boardId)
      return
    }
    const remembered = localStorage.getItem(LAST_BOARD_KEY)
    const target = boards.find((b) => b.id === remembered) ?? boards[0]
    openBoard(target.id, undefined, { replace: true })
  }, [loaded, boards, boardId, openBoard])

  const board = boards.find((b) => b.id === boardId) ?? null
  const statuses = React.useMemo(() => (board ? statusesOf(allStatuses, board.id) : []), [allStatuses, board])
  const sprints = React.useMemo(() => (board ? sprintsOf(allSprints, board.id) : []), [allSprints, board])
  const savedViews = React.useMemo(() => (board ? viewsOf(allViews, board.id) : []), [allViews, board])
  const lists = React.useMemo(() => (board ? listsOf(allLists, board.id) : []), [allLists, board])
  const boardTasks = React.useMemo(() => tasks.filter((t) => t.boardId === boardId), [tasks, boardId])
  const counts = React.useMemo(() => {
    const m = new Map<string, number>()
    for (const t of tasks) if (!t.archived) m.set(t.boardId, (m.get(t.boardId) ?? 0) + 1)
    return m
  }, [tasks])

  /* ── how it is read ── per board, device-local. */
  const [mode, setModeState] = React.useState<WorkspaceMode>("board")
  const [view, setViewState] = React.useState<ViewState>(DEFAULT_VIEW)
  const [activeViewId, setActiveViewId] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!boardId) return
    setModeState((localStorage.getItem(modeKey(boardId)) as WorkspaceMode | null) ?? "board")
    setViewState(readJson<ViewState>(viewKey(boardId), DEFAULT_VIEW))
    setActiveViewId(localStorage.getItem(savedKey(boardId)))
  }, [boardId])
  const setMode = (m: WorkspaceMode) => {
    setModeState(m)
    if (boardId) localStorage.setItem(modeKey(boardId), m)
    if (m !== "sprints") onViewChange({ kind: m })
  }
  const onViewChange = (patch: Partial<ViewState>) => {
    setViewState((v) => {
      const next = { ...v, ...patch }
      if (boardId) localStorage.setItem(viewKey(boardId), JSON.stringify(next))
      return next
    })
  }
  const pickView = (v: BoardView | null) => {
    setActiveViewId(v?.id ?? null)
    if (boardId) {
      if (v) localStorage.setItem(savedKey(boardId), v.id)
      else localStorage.removeItem(savedKey(boardId))
    }
    if (v) {
      const state = viewStateFrom(v.kind, v.config)
      setViewState(state)
      if (boardId) localStorage.setItem(viewKey(boardId), JSON.stringify(state))
      setMode(v.kind)
    }
  }

  /* ── the visible list ── */
  const facets = React.useMemo(() => facetsOf(boardTasks), [boardTasks])
  const visible = React.useMemo(() => {
    if (!board) return []
    const passing = boardTasks.filter((t) => matchesFilters(t, view.filters) && matchesQuery(t, view.filters.query, taskKey(t, board.key)))
    return sortTasks(passing, view.sortBy, view.sortDir)
  }, [board, boardTasks, view])
  const epics = React.useMemo(() => boardTasks.filter((t) => t.type === "epic" || boardTasks.some((c) => c.parentId === t.id)), [boardTasks])
  const byId = React.useMemo(() => new Map(boardTasks.map((t) => [t.id, t])), [boardTasks])
  const childCounts = React.useMemo(() => {
    const m = new Map<string, number>()
    for (const t of boardTasks) if (t.parentId) m.set(t.parentId, (m.get(t.parentId) ?? 0) + 1)
    return m
  }, [boardTasks])

  /* ── selection ── */
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set())
  const lastPicked = React.useRef<string | null>(null)
  React.useEffect(() => setSelected(new Set()), [boardId, mode])
  const toggleSelect = (id: string, additive: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (id === "!all") return new Set(visible.map((t) => t.id))
      if (id === "!none") return new Set()
      if (additive && lastPicked.current) {
        // Shift-range over the visible order.
        const ids = visible.map((t) => t.id)
        const a = ids.indexOf(lastPicked.current)
        const b = ids.indexOf(id)
        if (a !== -1 && b !== -1) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(ids[i]!)
          return next
        }
      }
      if (next.has(id)) next.delete(id)
      else next.add(id)
      lastPicked.current = id
      return next
    })
  }

  /* ── the open task ── part of the location, so on the page it survives a
     reload and can be shared, and in a panel it survives the layout. */
  const openTaskId = location.taskId
  const openTask = (task: Task | string | null) =>
    setOpenTask(typeof task === "string" ? task : (task?.id ?? null))
  // A task on another board opens that board.
  React.useEffect(() => {
    if (!openTaskId || !loaded) return
    const t = tasks.find((x) => x.id === openTaskId)
    if (t && t.boardId !== boardId) openBoard(t.boardId, t.id, { replace: true })
  }, [openTaskId, tasks, boardId, loaded, openBoard])

  /* ── verbs ── */
  const onCreate = async (input: TaskInput & { title: string }) =>
    createTaskMut.mutateAsync({ input: { boardId, statusId: statuses[0]?.id, ...input } })
  const onUpdate = (id: string, input: TaskInput) => updateTaskMut.mutateAsync({ id, input })
  const onDelete = (id: string) => deleteTaskMut.mutateAsync(id)

  const handleMove = async (byStatus: Record<string, string[]>) => {
    if (!board) return
    try {
      /* Rebuild the whole board's ordered ids. Columns the drag did not touch
         keep their current order; a task that moved columns is taken out of its
         old column here, since the authoritative `tasks` still lists it there.
         `order` is the index WITHIN a column — the server writes it verbatim. */
      const movedIds = new Set(Object.values(byStatus).flat())
      const entries: ReorderEntry[] = []
      for (const status of statuses) {
        const inColumn = boardTasks.filter((t) => t.statusId === status.id).sort((a, b) => a.order - b.order)
        const override = byStatus[status.id]
        const ids = override ? weaveHidden(inColumn, override, movedIds) : inColumn.filter((t) => !movedIds.has(t.id)).map((t) => t.id)
        ids.forEach((id, order) => entries.push({ id, statusId: status.id, order, boardId }))
      }
      await reorderTasksMut.mutateAsync({ entries, board: boardId })
    } catch (err) {
      reportError(err, "Couldn't move the task")
      tasksQuery.refetch()
    }
  }

  const moveColumn = (status: BoardStatus, delta: -1 | 1) => {
    if (!board) return
    const ids = statuses.map((s) => s.id)
    const from = ids.indexOf(status.id)
    const to = from + delta
    if (from === -1 || to < 0 || to >= ids.length) return
    ids.splice(to, 0, ...ids.splice(from, 1))
    reorderStatusesMut.mutateAsync({ boardId: board.id, ids }).catch((err) => reportError(err, "Couldn't move the column"))
  }

  /* ── dialogs ── */
  const [newTask, setNewTask] = React.useState<{ open: boolean; defaults: Partial<TaskInput> }>(() => ({
    open: !!loadNewTaskDraft(server.id, boardId),
    defaults: {},
  }))
  React.useEffect(() => {
    if (loadNewTaskDraft(server.id, boardId)) setNewTask((state) => ({ ...state, open: true }))
  }, [server.id, boardId])
  const [boardDialog, setBoardDialog] = React.useState<{ open: boolean; board: Board | null }>({ open: false, board: null })
  const [deletingBoard, setDeletingBoard] = React.useState(false)
  const [columnDialog, setColumnDialog] = React.useState<{ open: boolean; status: BoardStatus | null }>({ open: false, status: null })
  const [deletingStatus, setDeletingStatus] = React.useState<BoardStatus | null>(null)
  const [sprintDialog, setSprintDialog] = React.useState<{ open: boolean; sprint: Sprint | null }>({ open: false, sprint: null })
  const [completingSprint, setCompletingSprint] = React.useState<Sprint | null>(null)
  /** "new" saves a view of its own; "update" rewrites the active one. */
  const [savingView, setSavingView] = React.useState<"new" | "update" | null>(null)

  const ctx: CardContext = {
    boardKey: board?.key ?? "TASK",
    parentOf: (t) => (t.parentId ? byId.get(t.parentId) : undefined),
    childCount: (t) => childCounts.get(t.id) ?? 0,
    selected,
    onToggleSelect: toggleSelect,
  }

  const newBoard = () => setBoardDialog({ open: true, board: null })
  /* Mounted in every state, the "no boards yet" one included — its action is
     the only way out of it. */
  const boardDialogEl = (
    <BoardDialog
      open={boardDialog.open}
      onOpenChange={(open) => setBoardDialog((s) => ({ ...s, open }))}
      board={boardDialog.board}
      statuses={boardDialog.board ? statuses : []}
      projects={projects}
      onCreated={(b) => openBoard(b.id)}
      onDeleteStatus={setDeletingStatus}
    />
  )
  const ROOT = "@container relative grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] @panel-lg:grid-cols-[15rem_minmax(0,1fr)]"

  if (boardsError || !loaded || !board) {
    return (
      <div ref={rootRef} className={ROOT}>
        {boardsError ? (
          /* A read that failed is a failure, not a wait: the skeleton would
             otherwise shimmer forever over a page that is never going to fill. */
          <div className="col-span-full p-6">
            <ErrorNote error={inlineFromQuery(boardsError, "Couldn't read the boards")} />
          </div>
        ) : loaded && boards.length === 0 ? (
          /* A board that genuinely has none is the only case that gets words. */
          <div className="col-span-full grid place-items-center p-8">
            <Empty
              size="lg"
              icon={SquareKanban}
              action={
                <Button type="button" size="sm" onClick={newBoard} className="pointer-coarse:h-11">
                  <Plus data-icon="inline-start" /> New board
                </Button>
              }
            >
              No boards yet.
            </Empty>
          </div>
        ) : (
          <BoardSkeleton />
        )}
        {boardDialogEl}
      </div>
    )
  }

  const viewProps: ViewProps = {
    board,
    statuses,
    sprints,
    lists,
    tasks: visible,
    allTasks: boardTasks,
    view,
    ctx,
    facets,
    onOpen: openTask,
    onCreate,
    onUpdate,
    onViewChange,
  }

  const doneIds = new Set(statuses.filter((s) => s.category === "done").map((s) => s.id))
  const completing = completingSprint ? boardTasks.filter((t) => t.sprintId === completingSprint.id && !t.archived) : []
  const liveCount = boardTasks.filter((t) => !t.archived).length
  const project = board.projectId ? projects.find((p) => p.id === board.projectId) : undefined
  const selectedTasks = boardTasks.filter((t) => selected.has(t.id))
  const clearFilters = () => onViewChange({ filters: { ...EMPTY_FILTERS, query: view.filters.query } })
  const openNewTask = () => setNewTask({ open: true, defaults: {} })

  /* What the shell says instead of a view: a board with nothing on it, or
     filters that let nothing through. The kanban keeps its columns either way
     (they are where a first card goes), and so do the sprints (where a first
     sprint is planned). */
  const emptyState =
    mode === "board" || mode === "sprints" ? null : liveCount === 0 && activeFilterCount(view.filters) === 0 && !view.filters.query ? (
      <Empty
        size="lg"
        icon={SquareKanban}
        action={
          <Button type="button" size="sm" onClick={openNewTask} className="pointer-coarse:h-11">
            <Plus data-icon="inline-start" /> New task
          </Button>
        }
      >
        No tasks yet.
      </Empty>
    ) : visible.length === 0 ? (
      <Empty
        action={
          activeFilterCount(view.filters) > 0 ? (
            <Button type="button" variant="outline" size="sm" onClick={clearFilters} className="pointer-coarse:h-11">
              Clear filters
            </Button>
          ) : undefined
        }
      >
        No tasks match these filters.
      </Empty>
    ) : null

  return (
    <div ref={rootRef} className={ROOT}>
      <BoardRail
        boards={boards}
        current={board}
        counts={counts}
        sprints={sprints}
        views={savedViews}
        activeViewId={activeViewId}
        allTasks={boardTasks}
        statuses={statuses}
        onPick={(b) => openBoard(b.id)}
        onPickView={pickView}
        onNewBoard={newBoard}
        onSprints={() => setMode("sprints")}
      />
      <div className="flex min-h-0 min-w-0 flex-col">
        {/* Board header. */}
        <header className={cn("flex h-12 shrink-0 items-center gap-2", INSET_X)}>
          <DropdownMenu>
            {/* The board is the page: its name is the page's heading, and the
                switcher it opens is the heading's own control. */}
            <h1 className="flex min-w-0">
              <DropdownMenuTrigger
                render={
                  <Button type="button" variant="ghost" size="sm" className="max-w-[min(24rem,60cqw)] font-heading pointer-coarse:h-11">
                    <BoardMark board={board} />
                    <span className="truncate">{board.name}</span>
                    <ChevronDown data-icon="inline-end" className="text-muted-foreground" />
                  </Button>
                }
              />
            </h1>
            <DropdownMenuContent align="start" className="w-64">
              {boards.map((b) => (
                <DropdownMenuItem key={b.id} onClick={() => openBoard(b.id)}>
                  <BoardMark board={b} />
                  <span className="flex-1 truncate">{b.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{b.key}</span>
                  <Count>{counts.get(b.id) ?? 0}</Count>
                </DropdownMenuItem>
              ))}
              {savedViews.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  {savedViews.map((v) => {
                    const Icon = MODES.find((m) => m.id === v.kind)?.icon ?? SquareKanban
                    return (
                      <DropdownMenuItem key={v.id} onClick={() => pickView(v)}>
                        <Icon />
                        <span className={cn("flex-1 truncate", v.id === activeViewId && "font-medium")}>{v.name}</span>
                      </DropdownMenuItem>
                    )
                  })}
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={newBoard}>
                <Plus /> New board…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {project && (
            <span className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground @panel-sm:inline-flex">
              <ProjectIcon project={project} className="size-4" /> {project.name}
            </span>
          )}
          {board.description && <span className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground @panel-lg:block">{board.description}</span>}
          <span className="ms-auto flex shrink-0 items-center gap-1">
            <Button type="button" size="sm" onClick={openNewTask} title="New task" className="pointer-coarse:h-11">
              <Plus data-icon="inline-start" />
              <span className="hidden @panel-sm:inline">New task</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setBoardDialog({ open: true, board })}
              aria-label="Board settings"
              title="Board settings"
              className={cn("hidden text-muted-foreground @panel-sm:inline-flex", ICON_BTN)}
            >
              <Settings2 />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Board options" title="Board options" className={cn("text-muted-foreground", ICON_BTN)}>
                    <MoreHorizontal />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className={MENU_WIDTH}>
                {narrow && (
                  <DropdownMenuItem onClick={() => setBoardDialog({ open: true, board })}>
                    <Settings2 /> Board settings…
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={newBoard}>
                  <Plus /> New board…
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setColumnDialog({ open: true, status: null })}>
                  <FolderKanban /> Add column…
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setSprintDialog({ open: true, sprint: null })}>
                  <Rocket /> New sprint…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={boards.length <= 1} onClick={() => setDeletingBoard(true)} variant="destructive">
                  <Trash2 /> Delete board…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </header>

        <TabBar
          label="Layout"
          items={MODES.map((m) => ({ id: m.id, label: m.label, icon: m.icon, count: narrow && m.id === mode ? visible.length : undefined }))}
          value={mode}
          onChange={(id) => setMode(id as WorkspaceMode)}
          className={cn("mb-0 shrink-0", INSET_X)}
        />

        <Toolbar
          mode={mode}
          view={view}
          onChange={onViewChange}
          statuses={statuses}
          sprints={sprints}
          epics={epics}
          facets={facets}
          boardKey={board.key}
          savedViews={savedViews}
          activeViewId={activeViewId}
          onPickView={pickView}
          onSaveView={(update) => setSavingView(update ? "update" : "new")}
          onDeleteView={(v) =>
            deleteViewMut
              .mutateAsync(v.id)
              .then(() => {
                if (activeViewId === v.id) pickView(null)
              })
              .catch((err) => reportError(err, "Couldn't delete the view"))
          }
          visible={visible.length}
          total={liveCount}
          narrow={narrow}
        />

        <div
          className="relative min-h-0 flex-1 overflow-hidden"
          /* What a view's end pads past: the home indicator, and the floating bulk bar while a selection exists. */
          style={{ "--tasks-foot": selected.size > 0 ? "calc(var(--safe-bottom, 0px) + 5rem)" : "var(--safe-bottom, 0px)" } as React.CSSProperties}
        >
          {tasksError && !tasksQuery.data ? (
            <div className={cn("py-3", INSET_X)}>
              <ErrorNote error={tasksError} onRetry={() => void tasksQuery.refetch()} />
            </div>
          ) : tasksQuery.isPending ? (
            /* The board and its columns are known; the cards are not. Drawing
               them empty says "no tasks", which is the one thing it must not. */
            mode === "board" ? (
              <BoardColumnsSkeleton />
            ) : (
              <BoardRowsSkeleton />
            )
          ) : emptyState ? (
            <div className={cn("mx-auto grid h-full w-full max-w-6xl content-start py-3", INSET_X)}>{emptyState}</div>
          ) : (
            <>
              {mode === "board" && (
                <KanbanView
                  {...viewProps}
                  onMove={handleMove}
                  columns={{
                    onAdd: () => setColumnDialog({ open: true, status: null }),
                    onEdit: (status) => setColumnDialog({ open: true, status }),
                    onDelete: setDeletingStatus,
                    onMove: moveColumn,
                  }}
                />
              )}
              {mode === "list" && <ListView {...viewProps} />}
              {mode === "table" && <TableView {...viewProps} />}
              {mode === "calendar" && <CalendarView {...viewProps} />}
              {mode === "timeline" && <TimelineView {...viewProps} />}
              {mode === "sprints" && (
                <BacklogView
                  {...viewProps}
                  sprintOps={{
                    onCreate: () => setSprintDialog({ open: true, sprint: null }),
                    onEdit: (sprint) => setSprintDialog({ open: true, sprint }),
                    onStart: (sprint) =>
                      startSprintMut
                        .mutateAsync(sprint.id)
                        .then(() => toast.success(`${sprint.name} started`))
                        .catch((err) => reportError(err, "Couldn't start the sprint")),
                    onComplete: setCompletingSprint,
                    // The sprints view asks first (useConfirm on its ⋯ row).
                    onDelete: (sprint) =>
                      void deleteSprintMut.mutateAsync(sprint.id).catch((err) => reportError(err, "Couldn't delete the sprint")),
                  }}
                />
              )}
            </>
          )}

          {selected.size > 0 && (
            <BulkBar
              tasks={selectedTasks}
              statuses={statuses}
              sprints={sprints}
              facets={facets}
              onPatch={(patch) =>
                bulkMut
                  .mutateAsync({ ids: [...selected], patch })
                  .then((rows) => toast.success(`${rows.length} ${rows.length === 1 ? "task" : "tasks"} updated`))
                  .catch((err) => reportError(err, "Couldn't update the selection"))
              }
              onDelete={async () => {
                const n = selected.size
                if (!(await confirm({ title: `Delete ${n} ${n === 1 ? "task" : "tasks"}?`, description: "This cannot be undone.", confirmLabel: "Delete", destructive: true }))) return
                Promise.all([...selected].map((id) => deleteTaskMut.mutateAsync(id)))
                  .then(() => {
                    toast.success("Deleted")
                    setSelected(new Set())
                  })
                  .catch((err) => reportError(err, "Couldn't delete the selection"))
              }}
              onClear={() => setSelected(new Set())}
            />
          )}
        </div>
      </div>

      <TaskDetailDialog
        actions={actions}
        taskId={openTaskId}
        onClose={() => openTask(null)}
        board={board}
        statuses={statuses}
        sprints={sprints}
        allTasks={boardTasks}
        facets={facets}
        onOpen={openTask}
        onCreate={onCreate}
        onUpdate={onUpdate}
        onDelete={onDelete}
      />

      <NewTaskDialog
        open={newTask.open}
        onOpenChange={(open) => setNewTask((s) => ({ ...s, open }))}
        board={board}
        serverId={server.id}
        statuses={statuses}
        sprints={sprints}
        allTasks={boardTasks}
        facets={facets}
        defaults={newTask.defaults}
        onCreate={onCreate}
      />

      {boardDialogEl}
      <DeleteBoardDialog open={deletingBoard} onOpenChange={setDeletingBoard} board={board} taskCount={boardTasks.length} onDeleted={() => openBoard()} />
      <ColumnDialog
        open={columnDialog.open}
        onOpenChange={(open) => setColumnDialog((s) => ({ ...s, open }))}
        boardId={board.id}
        status={columnDialog.status}
      />
      <DeleteStatusDialog
        open={deletingStatus !== null}
        onOpenChange={(open) => !open && setDeletingStatus(null)}
        status={deletingStatus}
        siblings={statuses.filter((s) => s.id !== deletingStatus?.id)}
        taskCount={boardTasks.filter((t) => t.statusId === deletingStatus?.id).length}
      />
      <SprintDialog open={sprintDialog.open} onOpenChange={(open) => setSprintDialog((s) => ({ ...s, open }))} boardId={board.id} sprint={sprintDialog.sprint} />
      <CompleteSprintDialog
        open={completingSprint !== null}
        onOpenChange={(open) => !open && setCompletingSprint(null)}
        sprint={completingSprint}
        openCount={completing.filter((t) => !doneIds.has(t.statusId)).length}
        doneCount={completing.filter((t) => doneIds.has(t.statusId)).length}
      />
      <SaveViewDialog
        open={savingView !== null}
        onOpenChange={(open) => !open && setSavingView(null)}
        boardId={board.id}
        state={{ ...view, kind: mode === "sprints" ? "list" : mode }}
        existing={savingView === "update" ? (savedViews.find((v) => v.id === activeViewId) ?? null) : null}
        onSaved={(v) => {
          setActiveViewId(v.id)
          localStorage.setItem(savedKey(board.id), v.id)
          toast.success(`View “${v.name}” saved`)
        }}
      />
    </div>
  )
}
