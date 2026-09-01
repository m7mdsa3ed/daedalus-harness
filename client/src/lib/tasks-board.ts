import { api, type ServerSettings } from "./settings"

/* ── Tasks board ──
   The client half of the standalone tasks board (server: src/tasks-board.ts).
   Same reactive shape as task-events.ts, but this one IS server-persisted: the
   board is durable work shared across devices, not a live journal, so the verbs
   below call the REST API and the query cache reconciles from the response.

   Every mutation that changes the set of tasks answers with the full list
   (create), or the single changed row (update), so reconciliation is defined by
   the server — the client never invents an ordering or a column.
*/

/* A task's column is an id into `board_statuses` (see lib/boards.ts), not a
   member of a union: the four statuses used to be hardcoded here, in the
   server's schema and zod, in the backup row and twice more inside the kanban's
   drag handlers, so adding one meant editing all six and pushing a schema.
   `TaskStatus` stays as a name for what the id *means* at a call site. */
export type TaskStatus = string

export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const
export type TaskPriority = (typeof TASK_PRIORITIES)[number]

export interface Task {
  id: string
  /** → `Board.id`. */
  boardId: string
  title: string
  description: string | null
  /** → `BoardStatus.id`, always a column of `boardId`. */
  statusId: TaskStatus
  priority: TaskPriority
  labels: string[]
  assignee: string | null
  dueAt: number | null
  note: string | null
  order: number
  createdAt: number
  updatedAt: number
}

export interface TaskInput {
  title: string
  description?: string | null
  boardId?: string
  statusId?: TaskStatus
  priority?: TaskPriority
  labels?: string[]
  assignee?: string | null
  dueAt?: number | null
  note?: string | null
}

export interface ReorderEntry {
  id: string
  statusId: TaskStatus
  /** Position *within its column*, 0-based. */
  order: number
  boardId?: string
}

export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
}


// ---- verbs ----
/* Pure api calls; the query cache (lib/queries/boards.ts) holds the list and
   its mutations apply what comes back. Every mutation that changes the set of
   tasks answers with the full list (reorder), or the single changed row
   (create/update), so reconciliation is defined by the server — the client
   never invents an ordering or a column. */

/** Every task, across every board — the page filters by board, so switching
    boards costs nothing. */
export const fetchTasks = (settings: ServerSettings, signal?: AbortSignal): Promise<Task[]> =>
  api<Task[]>(settings, "/api/tasks", { signal })

export function createTask(settings: ServerSettings, input: TaskInput): Promise<Task> {
  return api<Task>(settings, "/api/tasks", {
    method: "POST",
    body: JSON.stringify(input),
  })
}

export function updateTask(settings: ServerSettings, id: string, input: Partial<TaskInput>): Promise<Task> {
  return api<Task>(settings, `/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  })
}

export function deleteTask(settings: ServerSettings, id: string): Promise<void> {
  return api<{ ok: boolean }>(settings, `/api/tasks/${encodeURIComponent(id)}`, {
    method: "DELETE",
  }).then(() => undefined)
}

/** Atomically commit a reorder / status move on the server, which answers with
    the authoritative whole list — the cache adopts it verbatim. `board` scopes
    the entries that name no board of their own. */
export function reorderTasks(
  settings: ServerSettings,
  entries: ReorderEntry[],
  board: string,
): Promise<Task[]> {
  return api<Task[]>(settings, "/api/tasks/reorder", {
    method: "POST",
    body: JSON.stringify({ entries, board }),
  })
}
