/* ── How a task list is read ──
   The pure half of the task workspace: filters, grouping, sorting and the
   derived facts (overdue, progress, key) every view draws from. No React, no
   DOM — a saved view is exactly one `ViewState`, so this file is what makes a
   saved view and the live toolbar the same thing.

   Every predicate takes the tasks it needs to know about (parents, statuses)
   as arguments rather than reaching for a store, so a view can be evaluated
   against any list — the page's, a sprint's, an epic's children. */
import type { BoardStatus, BoardViewConfig, Sprint, ViewKind } from "./boards"
import {
  PRIORITY_RANK,
  type Task,
  type TaskPriority,
  type TaskType,
} from "./tasks-board"

export type DueWindow = "overdue" | "today" | "week" | "none" | "any"

export interface TaskFilters {
  /** Free-text search over key, title, description, labels, assignee. */
  query: string
  statusIds: string[]
  priorities: TaskPriority[]
  types: TaskType[]
  assignees: string[]
  labels: string[]
  /** Sprint ids; the literal "backlog" means "no sprint". */
  sprintIds: string[]
  /** Parent ids; the literal "none" means "top-level only". */
  parentIds: string[]
  due: DueWindow
  /** Archived tasks are hidden unless asked for. */
  archived: "hide" | "only" | "all"
}

export const GROUP_BYS = ["none", "status", "priority", "type", "assignee", "label", "sprint", "epic"] as const
export type GroupBy = (typeof GROUP_BYS)[number]

export const SORT_BYS = ["manual", "priority", "due", "created", "updated", "title", "key", "estimate"] as const
export type SortBy = (typeof SORT_BYS)[number]

export interface ViewState {
  kind: ViewKind
  filters: TaskFilters
  groupBy: GroupBy
  sortBy: SortBy
  sortDir: "asc" | "desc"
  /** Table view: visible columns in order. */
  columns: string[]
}

export const GROUP_LABEL: Record<GroupBy, string> = {
  none: "No grouping",
  status: "Status",
  priority: "Priority",
  type: "Type",
  assignee: "Assignee",
  label: "Label",
  sprint: "Sprint",
  epic: "Epic",
}

export const SORT_LABEL: Record<SortBy, string> = {
  manual: "Manual",
  priority: "Priority",
  due: "Due date",
  created: "Created",
  updated: "Updated",
  title: "Title",
  key: "Key",
  estimate: "Estimate",
}

export const TABLE_COLUMNS = [
  "type",
  "status",
  "priority",
  "assignee",
  "labels",
  "sprint",
  "parent",
  "estimate",
  "start",
  "due",
  "progress",
  "created",
  "updated",
] as const
export type TableColumn = (typeof TABLE_COLUMNS)[number]

export const COLUMN_LABEL: Record<TableColumn, string> = {
  type: "Type",
  status: "Status",
  priority: "Priority",
  assignee: "Assignee",
  labels: "Labels",
  sprint: "Sprint",
  parent: "Parent",
  estimate: "Points",
  start: "Start",
  due: "Due",
  progress: "Checklist",
  created: "Created",
  updated: "Updated",
}

export const DEFAULT_COLUMNS: TableColumn[] = ["type", "status", "priority", "assignee", "labels", "due", "estimate"]

export const EMPTY_FILTERS: TaskFilters = {
  query: "",
  statusIds: [],
  priorities: [],
  types: [],
  assignees: [],
  labels: [],
  sprintIds: [],
  parentIds: [],
  due: "any",
  archived: "hide",
}

export const DEFAULT_VIEW: ViewState = {
  kind: "board",
  filters: EMPTY_FILTERS,
  groupBy: "none",
  sortBy: "manual",
  sortDir: "asc",
  columns: DEFAULT_COLUMNS,
}

/** How many filter facets are narrowing the list — the badge on the Filter button. */
export function activeFilterCount(f: TaskFilters): number {
  let n = 0
  if (f.statusIds.length) n++
  if (f.priorities.length) n++
  if (f.types.length) n++
  if (f.assignees.length) n++
  if (f.labels.length) n++
  if (f.sprintIds.length) n++
  if (f.parentIds.length) n++
  if (f.due !== "any") n++
  if (f.archived !== "hide") n++
  return n
}

// ---- saved views ↔ ViewState ----

const isString = (v: unknown): v is string => typeof v === "string"
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isString) : [])

/** Read a saved view's config defensively: it is free-form on the server and
    may have been written by an older client. */
export function viewStateFrom(kind: ViewKind, config: BoardViewConfig): ViewState {
  const f = (config.filters ?? {}) as Record<string, unknown>
  const groupBy = GROUP_BYS.includes(config.groupBy as GroupBy) ? (config.groupBy as GroupBy) : "none"
  const sortBy = SORT_BYS.includes(config.sortBy as SortBy) ? (config.sortBy as SortBy) : "manual"
  const columns = config.columns?.filter((c): c is TableColumn =>
    (TABLE_COLUMNS as readonly string[]).includes(c),
  )
  return {
    kind,
    groupBy,
    sortBy,
    sortDir: config.sortDir === "desc" ? "desc" : "asc",
    columns: columns?.length ? columns : DEFAULT_COLUMNS,
    filters: {
      query: isString(f.query) ? f.query : "",
      statusIds: strings(f.statusIds),
      priorities: strings(f.priorities) as TaskPriority[],
      types: strings(f.types) as TaskType[],
      assignees: strings(f.assignees),
      labels: strings(f.labels),
      sprintIds: strings(f.sprintIds),
      parentIds: strings(f.parentIds),
      due: (["overdue", "today", "week", "none", "any"] as const).includes(f.due as DueWindow)
        ? (f.due as DueWindow)
        : "any",
      archived: f.archived === "only" || f.archived === "all" ? f.archived : "hide",
    },
  }
}

export function viewConfigOf(state: ViewState): BoardViewConfig {
  return {
    filters: { ...state.filters },
    groupBy: state.groupBy,
    sortBy: state.sortBy,
    sortDir: state.sortDir,
    columns: state.columns,
  }
}

// ---- time ----

const DAY = 24 * 60 * 60_000

export function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function isOverdue(task: Pick<Task, "dueAt" | "completedAt">, now = Date.now()): boolean {
  return task.dueAt != null && task.completedAt == null && task.dueAt < startOfDay(now)
}

/** "Overdue · Sep 3", "Today", "Tomorrow", "Sep 12". */
export function dueLabel(dueAt: number | null, now = Date.now()): string | null {
  if (dueAt == null) return null
  const today = startOfDay(now)
  const day = startOfDay(dueAt)
  const label = new Date(dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })
  if (day < today) return `Overdue · ${label}`
  if (day === today) return "Today"
  if (day === today + DAY) return "Tomorrow"
  return label
}

// ---- filtering ----

function matchesDue(task: Task, due: DueWindow, now: number): boolean {
  if (due === "any") return true
  if (due === "none") return task.dueAt == null
  if (task.dueAt == null) return false
  const today = startOfDay(now)
  const day = startOfDay(task.dueAt)
  if (due === "overdue") return day < today && task.completedAt == null
  if (due === "today") return day === today
  return day >= today && day < today + 7 * DAY
}

export function matchesFilters(task: Task, f: TaskFilters, now = Date.now()): boolean {
  if (f.archived === "hide" && task.archived) return false
  if (f.archived === "only" && !task.archived) return false
  if (f.statusIds.length && !f.statusIds.includes(task.statusId)) return false
  if (f.priorities.length && !f.priorities.includes(task.priority)) return false
  if (f.types.length && !f.types.includes(task.type)) return false
  if (f.assignees.length && !f.assignees.includes(task.assignee ?? "")) return false
  if (f.labels.length && !f.labels.some((l) => task.labels.includes(l))) return false
  if (f.sprintIds.length && !f.sprintIds.includes(task.sprintId ?? "backlog")) return false
  if (f.parentIds.length && !f.parentIds.includes(task.parentId ?? "none")) return false
  if (!matchesDue(task, f.due, now)) return false
  return true
}

/** The text search, kept apart from the facets so the key (`DAE-42`) can be
    matched without the caller having to know the board's key. */
export function matchesQuery(task: Task, query: string, key: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    key.toLowerCase().includes(q) ||
    task.title.toLowerCase().includes(q) ||
    (task.description ?? "").toLowerCase().includes(q) ||
    task.labels.some((l) => l.toLowerCase().includes(q)) ||
    (task.assignee ?? "").toLowerCase().includes(q)
  )
}

// ---- sorting ----

function compare(a: Task, b: Task, sortBy: SortBy): number {
  switch (sortBy) {
    case "priority":
      return PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]
    case "due":
      return (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER)
    case "created":
      return a.createdAt - b.createdAt
    case "updated":
      return b.updatedAt - a.updatedAt
    case "title":
      return a.title.localeCompare(b.title)
    case "key":
      return (a.number ?? 0) - (b.number ?? 0)
    case "estimate":
      return (b.estimate ?? -1) - (a.estimate ?? -1)
    default:
      return a.order - b.order
  }
}

export function sortTasks(tasks: Task[], sortBy: SortBy, dir: "asc" | "desc"): Task[] {
  const sign = dir === "desc" ? -1 : 1
  return [...tasks].sort((a, b) => sign * compare(a, b, sortBy) || (a.number ?? 0) - (b.number ?? 0))
}

// ---- grouping ----

export interface TaskGroup {
  id: string
  label: string
  /** Palette token for the group's dot, if it has a natural one. */
  color?: string | null
  tasks: Task[]
}

export interface GroupContext {
  statuses: BoardStatus[]
  sprints: Sprint[]
  /** Every task on the board, for resolving epics by id. */
  all: Task[]
}

/** Group an already-filtered, already-sorted list. Empty groups are kept for
    status (a column is a drop target even when empty) and dropped otherwise. */
export function groupTasks(tasks: Task[], by: GroupBy, ctx: GroupContext): TaskGroup[] {
  if (by === "none") return [{ id: "all", label: "All tasks", tasks }]
  const buckets = new Map<string, Task[]>()
  const push = (id: string, task: Task) => {
    const list = buckets.get(id)
    if (list) list.push(task)
    else buckets.set(id, [task])
  }
  for (const task of tasks) {
    switch (by) {
      case "status":
        push(task.statusId, task)
        break
      case "priority":
        push(task.priority, task)
        break
      case "type":
        push(task.type, task)
        break
      case "assignee":
        push(task.assignee ?? "", task)
        break
      case "label":
        if (task.labels.length === 0) push("", task)
        for (const label of task.labels) push(label, task)
        break
      case "sprint":
        push(task.sprintId ?? "", task)
        break
      case "epic":
        push(task.parentId ?? "", task)
        break
    }
  }
  const groups: TaskGroup[] = []
  switch (by) {
    case "status":
      for (const s of ctx.statuses)
        groups.push({ id: s.id, label: s.name, color: s.color, tasks: buckets.get(s.id) ?? [] })
      break
    case "priority":
      for (const p of ["urgent", "high", "medium", "low", "lowest"] as const)
        if (buckets.has(p)) groups.push({ id: p, label: p[0]!.toUpperCase() + p.slice(1), tasks: buckets.get(p)! })
      break
    case "type":
      for (const t of ["epic", "story", "task", "bug"] as const)
        if (buckets.has(t)) groups.push({ id: t, label: t[0]!.toUpperCase() + t.slice(1), tasks: buckets.get(t)! })
      break
    case "sprint": {
      const active = ctx.sprints.filter((s) => s.state === "active")
      const planned = ctx.sprints.filter((s) => s.state === "planned")
      const closed = ctx.sprints.filter((s) => s.state === "closed")
      for (const s of [...active, ...planned, ...closed])
        if (buckets.has(s.id)) groups.push({ id: s.id, label: s.name, tasks: buckets.get(s.id)! })
      if (buckets.has("")) groups.push({ id: "", label: "Backlog", tasks: buckets.get("")! })
      break
    }
    case "epic": {
      const byId = new Map(ctx.all.map((t) => [t.id, t]))
      const ids = [...buckets.keys()].filter(Boolean).sort((a, b) => (byId.get(a)?.number ?? 0) - (byId.get(b)?.number ?? 0))
      for (const id of ids) groups.push({ id, label: byId.get(id)?.title ?? "Unknown parent", tasks: buckets.get(id)! })
      if (buckets.has("")) groups.push({ id: "", label: "No parent", tasks: buckets.get("")! })
      break
    }
    default: {
      const keys = [...buckets.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
      for (const k of keys)
        groups.push({ id: k, label: k || (by === "assignee" ? "Unassigned" : "No label"), tasks: buckets.get(k)! })
    }
  }
  return groups
}

// ---- derived facts ----

export function checklistProgress(task: Pick<Task, "checklist">): { done: number; total: number } {
  return { done: task.checklist.filter((c) => c.done).length, total: task.checklist.length }
}

/** Distinct assignees and labels in use on a list, for pickers and filters. */
export function facetsOf(tasks: Task[]): { assignees: string[]; labels: string[] } {
  const assignees = new Set<string>()
  const labels = new Set<string>()
  for (const t of tasks) {
    if (t.assignee) assignees.add(t.assignee)
    for (const l of t.labels) labels.add(l)
  }
  return {
    assignees: [...assignees].sort((a, b) => a.localeCompare(b)),
    labels: [...labels].sort((a, b) => a.localeCompare(b)),
  }
}

/** A sprint's count and points, split by the columns' done category. */
export function sprintProgress(
  tasks: Task[],
  sprintId: string,
  statuses: BoardStatus[],
): { total: number; done: number; points: number; donePoints: number } {
  const done = new Set(statuses.filter((s) => s.category === "done").map((s) => s.id))
  let total = 0
  let doneCount = 0
  let points = 0
  let donePoints = 0
  for (const t of tasks) {
    if (t.sprintId !== sprintId || t.archived) continue
    total++
    points += t.estimate ?? 0
    if (done.has(t.statusId)) {
      doneCount++
      donePoints += t.estimate ?? 0
    }
  }
  return { total, done: doneCount, points, donePoints }
}

/** Initials for an assignee avatar: "Mo Saeed" → "MS", "noah" → "N". */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase()
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
}

/** A stable hue per name, so the same assignee is the same colour everywhere. */
export function hueOf(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  return h
}
