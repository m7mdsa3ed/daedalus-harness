import * as React from "react"
import { useNavigate, useParams, useSearchParams } from "react-router"
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  FolderKanban,
  MoreHorizontal,
  Plus,
  Settings2,
  Trash2,
  X,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { reportError } from "@/lib/errors"
import { toast } from "@/lib/toast"
import { boardPath } from "@/lib/router"
import { useProjects } from "@/lib/queries/catalog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ProjectIcon } from "@/components/entity-icon"
import { COLOR_DOT, sprintsOf, statusesOf, viewsOf, type Board, type BoardStatus, type BoardView, type Sprint } from "@/lib/boards"
import { taskKey, type ReorderEntry, type Task, type TaskInput } from "@/lib/tasks-board"
import {
  DEFAULT_VIEW,
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
import { AssigneeAvatar, AssigneePicker, CHIP, PriorityIcon, PriorityPicker, SprintPicker, StatusPicker, StatusPill } from "./fields"
import type { CardContext } from "./task-card"
import { Toolbar, type WorkspaceMode } from "./toolbar"
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

/** The left rail: every board, the current one's sprints, and its saved views. */
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
  className,
}: {
  boards: Board[]
  current: Board | null
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
  className?: string
}) {
  const projects = useProjects()
  const active = sprints.find((s) => s.state === "active")
  const progress = active ? sprintProgress(allTasks, active.id, statuses) : null
  return (
    <aside className={cn("flex w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r bg-muted/20 px-2 py-3", className)}>
      <div className="grid gap-0.5">
        <div className="flex items-center justify-between px-2 pb-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Boards</span>
          <button type="button" onClick={onNewBoard} aria-label="New board" className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
            <Plus className="size-3.5" />
          </button>
        </div>
        {boards.map((b) => {
          const project = b.projectId ? projects.find((p) => p.id === b.projectId) : undefined
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => onPick(b)}
              aria-current={b.id === current?.id ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                b.id === current?.id && "bg-card font-medium shadow-xs",
              )}
            >
              {project ? <ProjectIcon project={project} className="size-4" /> : <span className={cn("size-2.5 shrink-0 rounded-full", b.color ? COLOR_DOT[b.color] : "bg-muted-foreground/40")} />}
              <span className="min-w-0 flex-1 truncate">{b.name}</span>
              <span className="font-mono text-[10px] text-muted-foreground">{b.key}</span>
              <span className="text-[10px] tabular-nums text-muted-foreground">{counts.get(b.id) ?? 0}</span>
            </button>
          )
        })}
      </div>
      {current && (
        <div className="grid gap-0.5">
          <span className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Sprint</span>
          {active && progress ? (
            <button type="button" onClick={onSprints} className="grid gap-1 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-accent">
              <span className="flex items-center justify-between">
                <span className="truncate font-medium">{active.name}</span>
                <span className="tabular-nums text-muted-foreground">
                  {progress.done}/{progress.total}
                </span>
              </span>
              <span className="h-1 overflow-hidden rounded-pill bg-muted">
                <span className="block h-full rounded-pill bg-emerald-500" style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} />
              </span>
              {active.endAt != null && <span className="text-[10px] text-muted-foreground">Ends {new Date(active.endAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>}
            </button>
          ) : (
            <button type="button" onClick={onSprints} className="rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent">
              No active sprint — plan one
            </button>
          )}
        </div>
      )}
      {current && views.length > 0 && (
        <div className="grid gap-0.5">
          <span className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Views</span>
          {views.map((v) => (
            <button key={v.id} type="button" onClick={() => onPickView(v)} className={cn("flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-accent", v.id === activeViewId && "bg-card font-medium shadow-xs")}>
              <span className="min-w-0 flex-1 truncate">{v.name}</span>
              <span className="text-[10px] uppercase text-muted-foreground">{v.kind}</span>
            </button>
          ))}
        </div>
      )}
    </aside>
  )
}

/** The bar that appears over a multi-select: the bulk verbs. */
function BulkBar({ count, statuses, sprints, facets, onPatch, onDelete, onClear }: { count: number; statuses: BoardStatus[]; sprints: Sprint[]; facets: { assignees: string[]; labels: string[] }; onPatch: (patch: Parameters<ReturnType<typeof useBulkUpdateTasks>["mutateAsync"]>[0]["patch"]) => void; onDelete: () => void; onClear: () => void }) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b bg-primary/5 px-3 py-1.5 text-xs sm:px-4">
      <span className="mr-1 shrink-0 font-medium">{count} selected</span>
      <StatusPicker value="" statuses={statuses} onChange={(statusId) => onPatch({ statusId })} trigger={<button type="button" className={CHIP}><StatusPill status={undefined} /> Status <ChevronDown className="size-3" /></button>} />
      <PriorityPicker value="medium" onChange={(priority) => onPatch({ priority })} trigger={<button type="button" className={CHIP}><PriorityIcon priority="medium" /> Priority <ChevronDown className="size-3" /></button>} />
      <AssigneePicker value={null} suggestions={facets.assignees} onChange={(assignee) => onPatch({ assignee })} trigger={<button type="button" className={CHIP}><AssigneeAvatar name={null} size="xs" /> Assignee <ChevronDown className="size-3" /></button>} />
      <SprintPicker value={null} sprints={sprints} onChange={(sprintId) => onPatch({ sprintId })} trigger={<button type="button" className={CHIP}>Sprint <ChevronDown className="size-3" /></button>} />
      <button type="button" onClick={() => onPatch({ archived: true })} className={CHIP}>
        <Archive className="size-3.5" /> Archive
      </button>
      <button type="button" onClick={() => onPatch({ archived: false })} className={CHIP}>
        <ArchiveRestore className="size-3.5" /> Restore
      </button>
      <button type="button" onClick={onDelete} className={cn(CHIP, "text-destructive hover:bg-destructive/10")}>
        <Trash2 className="size-3.5" /> Delete
      </button>
      <button type="button" onClick={onClear} className={cn(CHIP, "ml-auto shrink-0")}>
        <X className="size-3.5" /> Clear
      </button>
    </div>
  )
}

export function TasksWorkspace() {
  const navigate = useNavigate()
  const params = useParams<{ boardId?: string }>()
  const [search, setSearch] = useSearchParams()
  const projects = useProjects()

  const tasksQuery = useTasksQuery()
  const tasks = React.useMemo(() => tasksQuery.data ?? [], [tasksQuery.data])
  const { boards, statuses: allStatuses, sprints: allSprints, views: allViews, loaded } = useBoards()
  const createTaskMut = useCreateTask()
  const updateTaskMut = useUpdateTask()
  const deleteTaskMut = useDeleteTask()
  const bulkMut = useBulkUpdateTasks()
  const reorderTasksMut = useReorderTasks()
  const reorderStatusesMut = useReorderStatuses()
  const startSprintMut = useStartSprint()
  const deleteSprintMut = useDeleteSprint()
  const deleteViewMut = useDeleteView()

  /* ── which board ── the URL's, else the remembered one, else the first. */
  const boardId = params.boardId ?? ""
  React.useEffect(() => {
    if (!loaded || boards.length === 0) return
    if (boards.some((b) => b.id === boardId)) {
      localStorage.setItem(LAST_BOARD_KEY, boardId)
      return
    }
    const remembered = localStorage.getItem(LAST_BOARD_KEY)
    const target = boards.find((b) => b.id === remembered) ?? boards[0]
    void navigate(boardPath(target.id), { replace: true })
  }, [loaded, boards, boardId, navigate])

  const board = boards.find((b) => b.id === boardId) ?? null
  const statuses = React.useMemo(() => (board ? statusesOf(allStatuses, board.id) : []), [allStatuses, board])
  const sprints = React.useMemo(() => (board ? sprintsOf(allSprints, board.id) : []), [allSprints, board])
  const savedViews = React.useMemo(() => (board ? viewsOf(allViews, board.id) : []), [allViews, board])
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

  /* ── the open task ── a search param, so it survives reload and can be shared. */
  const openTaskId = search.get("task")
  const openTask = (task: Task | string | null) => {
    const id = typeof task === "string" ? task : task?.id
    setSearch(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (id) next.set("task", id)
        else next.delete("task")
        return next
      },
      { replace: true },
    )
  }
  // A task on another board opens that board.
  React.useEffect(() => {
    if (!openTaskId || !loaded) return
    const t = tasks.find((x) => x.id === openTaskId)
    if (t && t.boardId !== boardId) void navigate(boardPath(t.boardId, t.id), { replace: true })
  }, [openTaskId, tasks, boardId, loaded, navigate])

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
  const [newTask, setNewTask] = React.useState<{ open: boolean; defaults: Partial<TaskInput> }>({ open: false, defaults: {} })
  const [boardDialog, setBoardDialog] = React.useState<{ open: boolean; board: Board | null }>({ open: false, board: null })
  const [deletingBoard, setDeletingBoard] = React.useState(false)
  const [columnDialog, setColumnDialog] = React.useState(false)
  const [deletingStatus, setDeletingStatus] = React.useState<BoardStatus | null>(null)
  const [sprintDialog, setSprintDialog] = React.useState<{ open: boolean; sprint: Sprint | null }>({ open: false, sprint: null })
  const [completingSprint, setCompletingSprint] = React.useState<Sprint | null>(null)
  const [savingView, setSavingView] = React.useState(false)

  const ctx: CardContext = {
    boardKey: board?.key ?? "TASK",
    parentOf: (t) => (t.parentId ? byId.get(t.parentId) : undefined),
    childCount: (t) => childCounts.get(t.id) ?? 0,
    selected,
    onToggleSelect: toggleSelect,
  }

  if (!loaded || !board) {
    return (
      <div className="grid flex-1 place-items-center p-8 text-sm text-muted-foreground">
        {loaded && boards.length === 0 ? "No boards yet." : "Loading boards…"}
      </div>
    )
  }

  const viewProps: ViewProps = {
    board,
    statuses,
    sprints,
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

  return (
    <div className="@container flex min-h-0 flex-1">
      <BoardRail
        className="hidden @panel-md:flex"
        boards={boards}
        current={board}
        counts={counts}
        sprints={sprints}
        views={savedViews}
        activeViewId={activeViewId}
        allTasks={boardTasks}
        statuses={statuses}
        onPick={(b) => void navigate(boardPath(b.id))}
        onPickView={pickView}
        onNewBoard={() => setBoardDialog({ open: true, board: null })}
        onSprints={() => setMode("sprints")}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Board header. */}
        <header className="flex items-center gap-2 border-b px-3 py-2 sm:px-4">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button type="button" className="flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-accent">
                  <span className={cn("size-2.5 shrink-0 rounded-full", board.color ? COLOR_DOT[board.color] : "bg-muted-foreground/40")} />
                  <span className="truncate text-sm font-semibold">{board.name}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{board.key}</span>
                  <ChevronDown className="size-3.5 text-muted-foreground @panel-md:hidden" />
                </button>
              }
            />
            <DropdownMenuContent align="start" className="w-56 @panel-md:hidden">
              {boards.map((b) => (
                <DropdownMenuItem key={b.id} onClick={() => void navigate(boardPath(b.id))}>
                  <span className={cn("size-2 rounded-full", b.color ? COLOR_DOT[b.color] : "bg-muted-foreground/40")} />
                  <span className="flex-1 truncate">{b.name}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">{b.key}</span>
                  <span className="text-[10px] tabular-nums text-muted-foreground">{counts.get(b.id) ?? 0}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setBoardDialog({ open: true, board: null })}>
                <Plus className="size-4" /> New board…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {board.projectId && (() => {
            const project = projects.find((p) => p.id === board.projectId)
            return project ? (
              <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
                <ProjectIcon project={project} className="size-4" /> {project.name}
              </span>
            ) : null
          })()}
          {board.description && <span className="hidden truncate text-xs text-muted-foreground md:inline">{board.description}</span>}
          <span className="ml-auto flex items-center gap-1">
            <button type="button" onClick={() => setBoardDialog({ open: true, board })} aria-label="Board settings" title="Board settings" className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground">
              <Settings2 className="size-4" />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button type="button" aria-label="Board options" className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground">
                    <MoreHorizontal className="size-4" />
                  </button>
                }
              />
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={() => setBoardDialog({ open: true, board: null })}>
                  <Plus className="size-4" /> New board…
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setColumnDialog(true)}>
                  <FolderKanban className="size-4" /> Add column…
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setSprintDialog({ open: true, sprint: null })}>
                  <Plus className="size-4" /> New sprint…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={boards.length <= 1} onClick={() => setDeletingBoard(true)} className="text-destructive">
                  <Trash2 className="size-4" /> Delete board…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </header>

        <Toolbar
          mode={mode}
          onMode={setMode}
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
          onSaveView={() => setSavingView(true)}
          onDeleteView={(v) =>
            deleteViewMut
              .mutateAsync(v.id)
              .then(() => {
                if (activeViewId === v.id) pickView(null)
              })
              .catch((err) => reportError(err, "Couldn't delete the view"))
          }
          onNewTask={() => setNewTask({ open: true, defaults: {} })}
          visible={visible.length}
          total={boardTasks.filter((t) => !t.archived).length}
        />

        {selected.size > 0 && (
          <BulkBar
            count={selected.size}
            statuses={statuses}
            sprints={sprints}
            facets={facets}
            onPatch={(patch) =>
              bulkMut
                .mutateAsync({ ids: [...selected], patch })
                .then((rows) => toast.success(`${rows.length} ${rows.length === 1 ? "task" : "tasks"} updated`))
                .catch((err) => reportError(err, "Couldn't update the selection"))
            }
            onDelete={() => {
              if (!window.confirm(`Delete ${selected.size} ${selected.size === 1 ? "task" : "tasks"}? This cannot be undone.`)) return
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

        {mode === "board" && (
          <KanbanView
            {...viewProps}
            onMove={handleMove}
            columns={{
              onAdd: () => setColumnDialog(true),
              onEdit: () => setBoardDialog({ open: true, board }),
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
              onDelete: (sprint) => {
                if (!window.confirm(`Delete ${sprint.name}? Its tasks return to the backlog.`)) return
                deleteSprintMut.mutateAsync(sprint.id).catch((err) => reportError(err, "Couldn't delete the sprint"))
              },
            }}
          />
        )}
      </div>

      <TaskDetailDialog
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
        statuses={statuses}
        sprints={sprints}
        allTasks={boardTasks}
        facets={facets}
        defaults={newTask.defaults}
        onCreate={onCreate}
      />

      <BoardDialog
        open={boardDialog.open}
        onOpenChange={(open) => setBoardDialog((s) => ({ ...s, open }))}
        board={boardDialog.board}
        statuses={boardDialog.board ? statuses : []}
        projects={projects}
        onCreated={(b) => void navigate(boardPath(b.id))}
        onDeleteStatus={setDeletingStatus}
      />
      <DeleteBoardDialog open={deletingBoard} onOpenChange={setDeletingBoard} board={board} taskCount={boardTasks.length} onDeleted={() => void navigate(boardPath())} />
      <ColumnDialog open={columnDialog} onOpenChange={setColumnDialog} boardId={board.id} />
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
        open={savingView}
        onOpenChange={setSavingView}
        boardId={board.id}
        state={{ ...view, kind: mode === "sprints" ? "list" : mode }}
        existing={savedViews.find((v) => v.id === activeViewId) ?? null}
        onSaved={(v) => {
          setActiveViewId(v.id)
          localStorage.setItem(savedKey(board.id), v.id)
          toast.success(`View “${v.name}” saved`)
        }}
      />
    </div>
  )
}

