import type { FilterSpec, Task } from "./types"

/* ── Client-side filtering ──
   The twin of `queryTasks`'s SQL (server/src/pm/tasks.ts): the same FilterSpec,
   the same AND-ing, the same due buckets. The server filters the fetch; this
   filters the board already in memory, so typing in the filter bar costs no
   round trip and every view (kanban, list, table, calendar…) narrows from one
   shared function rather than each rolling its own.

   Pure — no React, no fetch. Views memoize the call. */

const DAY_MS = 86_400_000

const norm = (value: string) => value.toLowerCase()

/** `q` matches title or key, case-insensitively — same two columns the SQL
    LIKEs over (description is searched only by the cross-board /api/search). */
function matchesQuery(task: Task, q: string): boolean {
  const needle = norm(q)
  return norm(task.title).includes(needle) || norm(task.key).includes(needle)
}

function matchesDue(task: Task, due: NonNullable<FilterSpec["due"]>, now: number): boolean {
  if (task.dueDate === null) return false
  const dayStart = new Date(now).setHours(0, 0, 0, 0)
  if (due === "overdue") return task.dueDate < now && task.completedAt === null
  const span = due === "today" ? DAY_MS : 7 * DAY_MS
  return task.dueDate >= dayStart && task.dueDate < dayStart + span
}

/**
 * Narrow a task list. Every field of the spec is optional and they AND
 * together; an absent field is not a filter.
 *
 * `archived`/`trashed` are shelf switches, not filters: by default only live
 * tasks come through, `archived` swaps to the archive and `trashed` to the
 * trash — exactly what the SQL does.
 */
export function applyFilters(tasks: Task[], spec: FilterSpec = {}, now = Date.now()): Task[] {
  const labelIds = spec.labelIds?.length ? new Set(spec.labelIds) : null
  const columnIds = spec.columnIds?.length ? new Set(spec.columnIds) : null
  const typeIds = spec.typeIds?.length ? new Set(spec.typeIds) : null
  const assignees = spec.assignees?.length ? new Set(spec.assignees) : null

  return tasks.filter((task) => {
    if (spec.trashed) {
      if (task.deletedAt === null) return false
    } else {
      if (task.deletedAt !== null) return false
      if (spec.archived ? task.archivedAt === null : task.archivedAt !== null) return false
    }
    if (spec.q && !matchesQuery(task, spec.q)) return false
    if (columnIds && !columnIds.has(task.columnId)) return false
    if (assignees && !task.assignees.some((name) => assignees.has(name))) return false
    if (labelIds && !task.labelIds.some((id) => labelIds.has(id))) return false
    if (typeIds && (task.typeId === null || !typeIds.has(task.typeId))) return false
    if (spec.sprint !== undefined) {
      if (spec.sprint === "none" ? task.sprintId !== null : task.sprintId !== spec.sprint) return false
    }
    if (spec.epicId !== undefined && task.epicId !== spec.epicId) return false
    if (spec.parentId !== undefined && task.parentId !== spec.parentId) return false
    if (spec.milestoneId !== undefined && task.milestoneId !== spec.milestoneId) return false
    if (spec.priorityGte !== undefined && task.priority < spec.priorityGte) return false
    if (spec.due && !matchesDue(task, spec.due, now)) return false
    return true
  })
}

/** True when the spec would narrow anything — drives the filter bar's "clear". */
export function isFilterActive(spec: FilterSpec): boolean {
  return (
    !!spec.q ||
    !!spec.columnIds?.length ||
    !!spec.assignees?.length ||
    !!spec.labelIds?.length ||
    !!spec.typeIds?.length ||
    spec.sprint !== undefined ||
    spec.epicId !== undefined ||
    spec.parentId !== undefined ||
    spec.milestoneId !== undefined ||
    spec.priorityGte !== undefined ||
    !!spec.due
  )
}

// ---------------------------------------------------------------------------
// Sorting

export type SortKey =
  | "rank"
  | "backlogRank"
  | "priority"
  | "dueDate"
  | "createdAt"
  | "updatedAt"
  | "title"
  | "storyPoints"

export interface SortSpec {
  key: SortKey
  dir: "asc" | "desc"
}

/** Nulls sink to the end of an ascending sort — an undated task is not "first". */
const nullsLast = (a: number | null, b: number | null) =>
  (a ?? Number.POSITIVE_INFINITY) - (b ?? Number.POSITIVE_INFINITY)

function compare(a: Task, b: Task, key: SortKey): number {
  switch (key) {
    case "rank":
      return a.order - b.order || a.createdAt - b.createdAt
    case "backlogRank":
      return a.backlogRank - b.backlogRank || a.createdAt - b.createdAt
    case "priority":
      return a.priority - b.priority
    case "dueDate":
      return nullsLast(a.dueDate, b.dueDate)
    case "storyPoints":
      return nullsLast(a.storyPoints, b.storyPoints)
    case "createdAt":
      return a.createdAt - b.createdAt
    case "updatedAt":
      return a.updatedAt - b.updatedAt
    case "title":
      return a.title.localeCompare(b.title)
  }
}

/** Copies — a view must never reorder the array the store handed it. */
export function sortTasks(tasks: Task[], sort: SortSpec = { key: "rank", dir: "asc" }): Task[] {
  const sign = sort.dir === "desc" ? -1 : 1
  return [...tasks].sort((a, b) => sign * compare(a, b, sort.key))
}

/** Kanban lane order: the column rank the server maintains. */
export const byRank = (tasks: Task[]): Task[] => sortTasks(tasks, { key: "rank", dir: "asc" })

/** Backlog / sprint-lane order. */
export const byBacklogRank = (tasks: Task[]): Task[] =>
  sortTasks(tasks, { key: "backlogRank", dir: "asc" })

/** Tasks of one column, in rank order — what a kanban lane renders. */
export function tasksInColumn(tasks: Task[], columnId: string): Task[] {
  return byRank(tasks.filter((task) => task.columnId === columnId))
}
