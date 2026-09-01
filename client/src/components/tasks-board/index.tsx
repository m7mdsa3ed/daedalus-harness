import * as React from "react"
import { MoreHorizontal, Pencil, Plus, SearchIcon, Trash2 } from "lucide-react"

import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { reportError } from "@/lib/errors"
import type { ServerSettings } from "@/lib/settings"
import {
  COLOR_DOT,
  statusesOf,
  type Board as BoardRow,
  type BoardColor,
  type BoardStatus,
} from "@/lib/boards"
import {
  PRIORITY_LABEL,
  TASK_PRIORITIES,
  type ReorderEntry,
  type Task,
  type TaskInput,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/tasks-board"
import {
  useBoards,
  useCreateBoard,
  useCreateStatus,
  useCreateTask,
  useDeleteBoard,
  useDeleteStatus,
  useDeleteTask,
  useReorderStatuses,
  useReorderTasks,
  useTasksQuery,
  useUpdateBoard,
  useUpdateStatus,
  useUpdateTask,
} from "@/lib/queries/boards"
import { Board } from "./task-board"
import { TaskFormDialog } from "./task-form"
import { DeleteBoardDialog, DeleteStatusDialog, NameDialog } from "./board-dialogs"

const BOARD_STORAGE_KEY = "ui.boardId"

/** Dialog state: whether it is open, and the task being edited (null = new). */
interface DialogState {
  open: boolean
  task: Task | null
}

/** Which name-and-colour question the shared dialog is currently asking. */
type NamingState =
  | { kind: "new-board" }
  | { kind: "rename-board"; board: BoardRow }
  | { kind: "new-column" }
  | { kind: "rename-column"; status: BoardStatus }
  | null

/**
 * Weave the tasks a filter is hiding back into a column's new order.
 *
 * The kanban only ever sees the tasks that pass the search and filter chips, so
 * the id list a drop produces is the *visible* order — and writing that back
 * verbatim would renumber the column from 0 while the tasks filtered out of it
 * kept their old positions, colliding with the new ones. (Before this, a drag
 * with any filter active quietly scrambled the column's order the moment the
 * filter was cleared.) Each hidden task is re-inserted after however many
 * visible tasks preceded it originally, so clearing the filter shows it roughly
 * where it was.
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

export function TasksBoard({ settings: _settings }: { settings: ServerSettings }) {
  /* Reads come from the cache (refreshed on focus, invalidated by the
     mutations below); every write applies the server's answer back into it,
     so there is no `loadTasks(settings, true)` to remember after each one. */
  const tasksQuery = useTasksQuery()
  const tasks = tasksQuery.data ?? []
  const { boards, statuses: allStatuses, loaded } = useBoards()
  const createTaskMut = useCreateTask()
  const updateTaskMut = useUpdateTask()
  const deleteTaskMut = useDeleteTask()
  const reorderTasksMut = useReorderTasks()
  const createBoardMut = useCreateBoard()
  const updateBoardMut = useUpdateBoard()
  const deleteBoardMut = useDeleteBoard()
  const createStatusMut = useCreateStatus()
  const updateStatusMut = useUpdateStatus()
  const deleteStatusMut = useDeleteStatus()
  const reorderStatusesMut = useReorderStatuses()
  const [dialog, setDialog] = React.useState<DialogState>({ open: false, task: null })
  const [creatingStatus, setCreatingStatus] = React.useState<TaskStatus>("")
  const [query, setQuery] = React.useState("")
  const [statusFilter, setStatusFilter] = React.useState<TaskStatus | "all">("all")
  const [priorityFilter, setPriorityFilter] = React.useState<TaskPriority | "all">("all")
  const [naming, setNaming] = React.useState<NamingState>(null)
  const [deletingStatus, setDeletingStatus] = React.useState<BoardStatus | null>(null)
  const [deletingBoard, setDeletingBoard] = React.useState(false)
  const [boardId, setBoardId] = React.useState<string>(
    () => localStorage.getItem(BOARD_STORAGE_KEY) ?? "",
  )

  /* Settle on a board once the list arrives: the remembered one if it still
     exists, else the first. Deleting the selected board therefore falls back
     rather than rendering nothing. */
  React.useEffect(() => {
    if (!loaded || boards.length === 0) return
    if (boards.some((b) => b.id === boardId)) return
    setBoardId(boards[0].id)
  }, [loaded, boards, boardId])

  React.useEffect(() => {
    if (boardId) localStorage.setItem(BOARD_STORAGE_KEY, boardId)
  }, [boardId])

  const board = boards.find((b) => b.id === boardId) ?? null
  const statuses = React.useMemo(
    () => (board ? statusesOf(allStatuses, board.id) : []),
    [allStatuses, board],
  )
  const boardTasks = React.useMemo(
    () => tasks.filter((task) => task.boardId === boardId),
    [tasks, boardId],
  )

  // A filter naming a column of the board we just left means nothing here.
  React.useEffect(() => {
    if (statusFilter !== "all" && !statuses.some((s) => s.id === statusFilter)) {
      setStatusFilter("all")
    }
  }, [statuses, statusFilter])

  const filtered = boardTasks.filter((task) => {
    if (statusFilter !== "all" && task.statusId !== statusFilter) return false
    if (priorityFilter !== "all" && task.priority !== priorityFilter) return false
    if (!query.trim()) return true
    const q = query.toLowerCase()
    return (
      task.title.toLowerCase().includes(q) ||
      (task.description ?? "").toLowerCase().includes(q) ||
      task.labels.some((l) => l.toLowerCase().includes(q)) ||
      (task.assignee ?? "").toLowerCase().includes(q)
    )
  })

  const openNew = (statusId: TaskStatus) => {
    setCreatingStatus(statusId || statuses[0]?.id || "")
    setDialog({ open: true, task: null })
  }

  const handleSave = async (input: TaskInput): Promise<void> => {
    if (dialog.task) {
      await updateTaskMut.mutateAsync({ id: dialog.task.id, input })
    } else {
      await createTaskMut.mutateAsync({
        input: { ...input, boardId, statusId: input.statusId || creatingStatus },
      })
    }
  }

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
        const inColumn = boardTasks
          .filter((task) => task.statusId === status.id)
          .sort((a, b) => a.order - b.order)
        const override = byStatus[status.id]
        const ids = override
          ? weaveHidden(inColumn, override, movedIds)
          : inColumn.filter((task) => !movedIds.has(task.id)).map((task) => task.id)
        ids.forEach((id, order) => entries.push({ id, statusId: status.id, order, boardId }))
      }
      await reorderTasksMut.mutateAsync({ entries, board: boardId })
    } catch (err) {
      reportError(err, "Couldn't move the task")
      // The board rendered the move optimistically; re-read so it stops showing
      // a position the server never accepted.
      tasksQuery.refetch()
    }
  }

  // ---- board and column edits ----

  const submitNaming = async ({ name, color }: { name: string; color: BoardColor | null }) => {
    if (!naming) return
    switch (naming.kind) {
      case "new-board": {
        const created = await createBoardMut.mutateAsync({ name, color })
        setBoardId(created.id)
        return
      }
      case "rename-board":
        return updateBoardMut.mutateAsync({ id: naming.board.id, input: { name, color } })
      case "new-column":
        if (!board) return
        return void (await createStatusMut.mutateAsync({ boardId: board.id, input: { name, color } }))
      case "rename-column":
        return updateStatusMut.mutateAsync({ id: naming.status.id, input: { name, color } })
    }
  }

  const moveColumn = async (status: BoardStatus, delta: -1 | 1) => {
    if (!board) return
    const ids = statuses.map((s) => s.id)
    const from = ids.indexOf(status.id)
    const to = from + delta
    if (from === -1 || to < 0 || to >= ids.length) return
    ids.splice(to, 0, ...ids.splice(from, 1))
    try {
      await reorderStatusesMut.mutateAsync({ boardId: board.id, ids })
    } catch (err) {
      reportError(err, "Couldn't move the column")
    }
  }

  const confirmDeleteStatus = async (moveTo: string | undefined) => {
    if (!deletingStatus) return
    await deleteStatusMut.mutateAsync({ id: deletingStatus.id, moveTo })
    // Its tasks were rehomed by the server; the invalidation that followed the
    // write re-reads them, so nothing on screen keeps a column that is gone.
  }

  const confirmDeleteBoard = async () => {
    if (!board) return
    await deleteBoardMut.mutateAsync(board.id)
  }

  const namingProps = namingDialogProps(naming)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar: board switcher, search, filters */}
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <div className="flex items-center gap-1">
          <Select value={boardId} onValueChange={(v) => v && setBoardId(v)}>
            <SelectTrigger className="h-9 min-w-40" aria-label="Board">
              <SelectValue>
                <span className="inline-flex items-center gap-2">
                  {board?.color && (
                    <span className={cn("size-2 rounded-full", COLOR_DOT[board.color])} />
                  )}
                  {board?.name ?? "Board"}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {boards.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  <span className="inline-flex items-center gap-2">
                    {option.color && (
                      <span className={cn("size-2 rounded-full", COLOR_DOT[option.color])} />
                    )}
                    {option.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Board options"
                  className="grid size-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <MoreHorizontal className="size-4" />
                </button>
              }
            />
            <DropdownMenuContent align="start" className="w-52">
              <DropdownMenuItem onClick={() => setNaming({ kind: "new-board" })}>
                <Plus className="size-4" /> New board…
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!board}
                onClick={() => board && setNaming({ kind: "rename-board", board })}
              >
                <Pencil className="size-4" /> Rename board…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                // The app's only view of a task is a board, so the last one
                // stays — the server refuses it too.
                disabled={!board || boards.length <= 1}
                onClick={() => setDeletingBoard(true)}
                className="text-destructive"
              >
                <Trash2 className="size-4" /> Delete board…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tasks, labels, assignees…"
            className="h-9 pl-8"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip active={statusFilter === "all"} onClick={() => setStatusFilter("all")}>
            All statuses
          </FilterChip>
          {statuses.map((status) => (
            <FilterChip
              key={status.id}
              active={statusFilter === status.id}
              onClick={() => setStatusFilter(statusFilter === status.id ? "all" : status.id)}
            >
              {status.name}
            </FilterChip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip active={priorityFilter === "all"} onClick={() => setPriorityFilter("all")}>
            Any priority
          </FilterChip>
          {TASK_PRIORITIES.map((priority) => (
            <FilterChip
              key={priority}
              active={priorityFilter === priority}
              onClick={() => setPriorityFilter(priorityFilter === priority ? "all" : priority)}
            >
              {PRIORITY_LABEL[priority]}
            </FilterChip>
          ))}
        </div>
      </div>

      <Board
        tasks={filtered}
        statuses={statuses}
        onMove={handleMove}
        onNew={openNew}
        onTaskClick={(task) => setDialog({ open: true, task })}
        onAddColumn={() => setNaming({ kind: "new-column" })}
        onRenameColumn={(status) => setNaming({ kind: "rename-column", status })}
        onDeleteColumn={setDeletingStatus}
        onMoveColumn={moveColumn}
      />

      <TaskFormDialog
        open={dialog.open}
        onOpenChange={(open) => {
          if (!open) setDialog({ open: false, task: null })
        }}
        task={dialog.task}
        statuses={statuses}
        defaultStatusId={creatingStatus}
        onSave={handleSave}
        onDelete={
          dialog.task
            ? async () => {
                await deleteTaskMut.mutateAsync(dialog.task!.id)
                setDialog({ open: false, task: null })
              }
            : undefined
        }
      />

      <NameDialog
        open={naming !== null}
        onOpenChange={(open) => {
          if (!open) setNaming(null)
        }}
        {...namingProps}
        onSubmit={submitNaming}
      />

      <DeleteStatusDialog
        open={deletingStatus !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingStatus(null)
        }}
        status={deletingStatus}
        siblings={statuses.filter((s) => s.id !== deletingStatus?.id)}
        taskCount={boardTasks.filter((t) => t.statusId === deletingStatus?.id).length}
        onConfirm={confirmDeleteStatus}
      />

      <DeleteBoardDialog
        open={deletingBoard}
        onOpenChange={setDeletingBoard}
        name={board?.name ?? ""}
        taskCount={boardTasks.length}
        onConfirm={confirmDeleteBoard}
      />
    </div>
  )
}

/** Copy for the one shared name-and-colour dialog, per question it is asking. */
function namingDialogProps(naming: NamingState): {
  title: string
  description: string
  submitLabel: string
  initialName: string
  initialColor: BoardColor | null
} {
  switch (naming?.kind) {
    case "rename-board":
      return {
        title: "Rename board",
        description: "The board's name and colour in the switcher.",
        submitLabel: "Save",
        initialName: naming.board.name,
        initialColor: naming.board.color,
      }
    case "new-column":
      return {
        title: "New column",
        description: "A column is a status a task can be in. It is added at the end.",
        submitLabel: "Add column",
        initialName: "",
        initialColor: null,
      }
    case "rename-column":
      return {
        title: "Rename column",
        description: "Tasks in this column keep their place.",
        submitLabel: "Save",
        initialName: naming.status.name,
        initialColor: naming.status.color,
      }
    default:
      return {
        title: "New board",
        description: "A board is its own kanban, with its own columns and tasks.",
        submitLabel: "Create board",
        initialName: "",
        initialColor: null,
      }
  }
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={`Filter by ${children}`}
      className={`rounded-pill border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-transparent bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  )
}
