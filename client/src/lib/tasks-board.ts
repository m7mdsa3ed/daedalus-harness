import * as React from "react"
import { api, type ServerSettings } from "./settings"

/* ── Tasks board ──
   The client half of the standalone tasks board (server: src/tasks-board.ts).
   Same reactive shape as task-events.ts, but this one IS server-persisted: the
   board is durable work shared across devices, not a live journal, so the verbs
   below call the REST API and reconcile the local list from the response.

   The store is deliberately a module-level reactive table rather than a slice
   in lib/store: the board never needs to be replayed, journaled or threaded,
   and keeping it out of the reducer means the board page owns its own lifecycle
   (load once on mount) without touching the rest of the app's state.

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

const PRIORITY_RANK: Record<TaskPriority, number> = { low: 0, medium: 1, high: 2, urgent: 3 }
export const priorityRank = (p: TaskPriority): number => PRIORITY_RANK[p]

// ---- reactive list ----

let tasks: Task[] = []
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) listener()
}

function setAll(next: Task[]) {
  tasks = next
  notify()
}

/* Replace a row in place, or append a new one. Deliberately does NOT re-sort:
   the list's order is the server's (board, column, position), and re-sorting by
   priority here made the list view jump into a different order after an edit
   than it had after a reload. Consumers that want another order say so. */
function upsert(row: Task) {
  const at = tasks.findIndex((t) => t.id === row.id)
  tasks = at === -1 ? [...tasks, row] : tasks.map((t) => (t.id === row.id ? row : t))
  notify()
}

function remove(id: string) {
  tasks = tasks.filter((t) => t.id !== id)
  notify()
}

export function tasksSnapshot(): Task[] {
  return tasks
}

export function subscribeTasks(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useTasks(): Task[] {
  return React.useSyncExternalStore(subscribeTasks, tasksSnapshot, tasksSnapshot)
}

// ---- verbs ----

let inflight: Promise<void> | null = null

/** Load every task, across every board — the page filters by board, so
    switching boards costs nothing. Deduped while a load is already in flight;
    `force` jumps that dedupe for a caller that has just written (deleting a
    column rehomes its tasks) and must not be handed a pre-write response. */
export function loadTasks(settings: ServerSettings, force = false): Promise<void> {
  if (force) inflight = null
  if (inflight) return inflight
  inflight = api<Task[]>(settings, "/api/tasks")
    .then(setAll)
    .finally(() => {
      inflight = null
    })
  return inflight
}

export function createTask(settings: ServerSettings, input: TaskInput): Promise<Task> {
  return api<Task>(settings, "/api/tasks", {
    method: "POST",
    body: JSON.stringify(input),
  }).then((row) => {
    upsert(row)
    return row
  })
}

export function updateTask(settings: ServerSettings, id: string, input: Partial<TaskInput>): Promise<Task> {
  return api<Task>(settings, `/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  }).then((row) => {
    upsert(row)
    return row
  })
}

export function deleteTask(settings: ServerSettings, id: string): Promise<void> {
  return api<{ ok: boolean }>(settings, `/api/tasks/${encodeURIComponent(id)}`, {
    method: "DELETE",
  }).then(() => {
    remove(id)
  })
}

/** Atomically commit a reorder / status move on the server, and adopt the
    authoritative list it returns. `board` scopes the entries that name no board
    of their own; the response is always the whole task list. */
export function reorderTasks(
  settings: ServerSettings,
  entries: ReorderEntry[],
  board: string,
): Promise<void> {
  return api<Task[]>(settings, "/api/tasks/reorder", {
    method: "POST",
    body: JSON.stringify({ entries, board }),
  }).then(setAll)
}
