import { api, type ServerSettings } from "./settings"

/* ── Tasks ──
   The client half of the task workspace (server: src/tasks-board.ts). Same
   reactive shape as task-events.ts, but this one IS server-persisted: the
   board is durable work shared across devices, not a live journal, so the verbs
   below call the REST API and the query cache reconciles from the response.

   Every mutation that changes the set of tasks answers with the full list
   (reorder), the changed rows (bulk) or the single changed row
   (create/update), so reconciliation is defined by the server — the client
   never invents an ordering or a column. */

/* A task's column is an id into `board_statuses` (see lib/boards.ts), not a
   member of a union. `TaskStatus` stays as a name for what the id *means* at a
   call site. */
export type TaskStatus = string

export const TASK_PRIORITIES = ["lowest", "low", "medium", "high", "urgent"] as const
export type TaskPriority = (typeof TASK_PRIORITIES)[number]

export const TASK_TYPES = ["task", "bug", "story", "epic"] as const
export type TaskType = (typeof TASK_TYPES)[number]

export const LINK_KINDS = ["blocks", "relates", "duplicates"] as const
export type LinkKind = (typeof LINK_KINDS)[number]

export interface ChecklistItem {
  id: string
  text: string
  done: boolean
}

export interface Task {
  id: string
  /** → `Board.id`. */
  boardId: string
  /** Per-board sequence; with the board's key it is the task's `KEY-n`. Null
      only on a row the server has not numbered yet (it does so at boot). */
  number: number | null
  type: TaskType
  title: string
  description: string | null
  /** → `BoardStatus.id`, always a column of `boardId`. */
  statusId: TaskStatus
  priority: TaskPriority
  labels: string[]
  assignee: string | null
  /** → `Task.id` of the epic or parent task; null = top level. */
  parentId: string | null
  /** → `Sprint.id`; null = backlog. */
  sprintId: string | null
  estimate: number | null
  startAt: number | null
  dueAt: number | null
  completedAt: number | null
  /** Null reads as false. */
  archived: boolean | null
  checklist: ChecklistItem[]
  custom: Record<string, unknown>
  note: string | null
  order: number
  createdAt: number
  updatedAt: number
}

export interface TaskInput {
  title?: string
  description?: string | null
  boardId?: string
  statusId?: TaskStatus
  type?: TaskType
  priority?: TaskPriority
  labels?: string[]
  assignee?: string | null
  parentId?: string | null
  sprintId?: string | null
  estimate?: number | null
  startAt?: number | null
  dueAt?: number | null
  archived?: boolean
  checklist?: { id?: string; text: string; done: boolean }[]
  custom?: Record<string, unknown>
  note?: string | null
  order?: number
}

/** The subset of fields a multi-select may set at once. */
export type BulkPatch = Pick<
  TaskInput,
  | "statusId"
  | "type"
  | "priority"
  | "labels"
  | "assignee"
  | "parentId"
  | "sprintId"
  | "estimate"
  | "startAt"
  | "dueAt"
  | "archived"
>

export interface ReorderEntry {
  id: string
  statusId: TaskStatus
  /** Position *within its column*, 0-based. */
  order: number
  boardId?: string
}

export interface TaskComment {
  id: string
  taskId: string
  body: string
  author: string | null
  createdAt: number
  updatedAt: number
}

export interface TaskActivity {
  id: string
  taskId: string
  at: number
  /** A task field name, or `created` / `commented` / `linked` / `description`. */
  field: string
  from: unknown
  to: unknown
}

export interface TaskLink {
  id: string
  fromId: string
  toId: string
  kind: LinkKind
  createdAt: number
}

export interface TaskDetail {
  task: Task
  comments: TaskComment[]
  activity: TaskActivity[]
  links: TaskLink[]
  children: Task[]
}

export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  lowest: "Lowest",
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
}

/** Sort weight, highest first. */
export const PRIORITY_RANK: Record<TaskPriority, number> = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1,
  lowest: 0,
}

export const TYPE_LABEL: Record<TaskType, string> = {
  task: "Task",
  bug: "Bug",
  story: "Story",
  epic: "Epic",
}

export const LINK_LABEL: Record<LinkKind, { out: string; in: string }> = {
  blocks: { out: "Blocks", in: "Blocked by" },
  relates: { out: "Relates to", in: "Relates to" },
  duplicates: { out: "Duplicates", in: "Duplicated by" },
}

/** `KEY-12` for a task, given its board's key. */
export const taskKey = (task: Pick<Task, "number">, boardKey: string) => `${boardKey}-${task.number ?? "?"}`

// ---- verbs ----

/** Every task, across every board — the page filters by board, so switching
    boards costs nothing. */
export const fetchTasks = (settings: ServerSettings, signal?: AbortSignal): Promise<Task[]> =>
  api<Task[]>(settings, "/api/tasks", { signal })

export const fetchTaskDetail = (settings: ServerSettings, id: string, signal?: AbortSignal) =>
  api<TaskDetail>(settings, `/api/tasks/${encodeURIComponent(id)}`, { signal })

export const fetchTaskByKey = (settings: ServerSettings, key: string) =>
  api<Task>(settings, `/api/tasks/by-key/${encodeURIComponent(key)}`)

export function createTask(settings: ServerSettings, input: TaskInput & { title: string }): Promise<Task> {
  return api<Task>(settings, "/api/tasks", { method: "POST", body: JSON.stringify(input) })
}

export function updateTask(settings: ServerSettings, id: string, input: TaskInput): Promise<Task> {
  return api<Task>(settings, `/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  })
}

export function bulkUpdateTasks(settings: ServerSettings, ids: string[], patch: BulkPatch): Promise<Task[]> {
  return api<Task[]>(settings, "/api/tasks/bulk", {
    method: "POST",
    body: JSON.stringify({ ids, patch }),
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
export function reorderTasks(settings: ServerSettings, entries: ReorderEntry[], board: string): Promise<Task[]> {
  return api<Task[]>(settings, "/api/tasks/reorder", {
    method: "POST",
    body: JSON.stringify({ entries, board }),
  })
}

export function addComment(
  settings: ServerSettings,
  taskId: string,
  input: { body: string; author?: string | null },
): Promise<TaskComment> {
  return api<TaskComment>(settings, `/api/tasks/${encodeURIComponent(taskId)}/comments`, {
    method: "POST",
    body: JSON.stringify(input),
  })
}

export function updateComment(settings: ServerSettings, id: string, body: string): Promise<TaskComment> {
  return api<TaskComment>(settings, `/api/comments/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ body }),
  })
}

export function deleteComment(settings: ServerSettings, id: string): Promise<void> {
  return api<{ ok: boolean }>(settings, `/api/comments/${encodeURIComponent(id)}`, { method: "DELETE" }).then(
    () => undefined,
  )
}

export function addLink(
  settings: ServerSettings,
  fromId: string,
  input: { toId: string; kind: LinkKind },
): Promise<TaskLink> {
  return api<TaskLink>(settings, `/api/tasks/${encodeURIComponent(fromId)}/links`, {
    method: "POST",
    body: JSON.stringify(input),
  })
}

export function deleteLink(settings: ServerSettings, id: string): Promise<void> {
  return api<{ ok: boolean }>(settings, `/api/links/${encodeURIComponent(id)}`, { method: "DELETE" }).then(
    () => undefined,
  )
}
