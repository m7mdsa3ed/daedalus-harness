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

export const TASK_STATUSES = ["todo", "in_progress", "done", "blocked"] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const
export type TaskPriority = (typeof TASK_PRIORITIES)[number]

export interface Task {
  id: string
  board: string
  title: string
  description: string | null
  status: TaskStatus
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
  status?: TaskStatus
  priority?: TaskPriority
  labels?: string[]
  assignee?: string | null
  dueAt?: number | null
  note?: string | null
}

export interface ReorderEntry {
  id: string
  status: TaskStatus
  order: number
}

/** Human label for a status — the schema knows them as slugs. */
export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
  blocked: "Blocked",
}

export const STATUS_ORDER: TaskStatus[] = ["todo", "in_progress", "blocked", "done"]

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

function upsert(row: Task) {
  tasks = [...tasks.filter((t) => t.id !== row.id), row].sort(
    (a, b) => priorityRank(b.priority) - priorityRank(a.priority),
  )
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

/** Load the whole board. Deduped while a load is already in flight. */
export function loadTasks(settings: ServerSettings): Promise<void> {
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
    authoritative list it returns. */
export function reorderTasks(settings: ServerSettings, entries: ReorderEntry[]): Promise<void> {
  return api<Task[]>(settings, "/api/tasks/reorder", {
    method: "POST",
    body: JSON.stringify({ entries }),
  }).then(setAll)
}
