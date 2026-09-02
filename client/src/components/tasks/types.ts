/* The contract between the workspace page and its views. Every view gets the
   same props: the board and its rows, the visible (filtered, sorted) tasks,
   the full list for resolving parents, and the verbs — so a view never talks
   to the query cache itself and the page is the one place that does. */
import type { Board, BoardStatus, Sprint } from "@/lib/boards"
import type { Task, TaskInput } from "@/lib/tasks-board"
import type { ViewState } from "@/lib/tasks-view"
import type { CardContext } from "./task-card"

export interface ViewProps {
  board: Board
  statuses: BoardStatus[]
  sprints: Sprint[]
  /** The tasks the current filters and sort let through. */
  tasks: Task[]
  /** Every task on the board, filters or not — for parents, children, epics. */
  allTasks: Task[]
  view: ViewState
  ctx: CardContext
  facets: { assignees: string[]; labels: string[] }
  onOpen: (task: Task) => void
  onCreate: (input: TaskInput & { title: string }) => Promise<Task>
  onUpdate: (id: string, input: TaskInput) => Promise<Task>
  onViewChange: (patch: Partial<ViewState>) => void
}

/** What the kanban may do to its columns; the page owns the dialogs. */
export interface ColumnOps {
  onAdd: () => void
  onEdit: (status: BoardStatus) => void
  onDelete: (status: BoardStatus) => void
  onMove: (status: BoardStatus, delta: -1 | 1) => void
}
