/* ── PM wire types ──
   Hand-mirrored from the server: rows come from Drizzle tables in
   server/src/db/pm.ts, inputs/json shapes from server/src/pm/schema.ts, and
   the assembled Board / Task wire shapes from server/src/pm/boards.ts and
   server/src/pm/tasks.ts. The client and server never import each other, so
   these are twins — change both sides together (the server files carry the
   matching pointer comments). */

// ---------------------------------------------------------------------------
// Shared value shapes (json columns — mirrored from server/src/pm/schema.ts)

export const VIEW_NAMES = [
  "kanban",
  "list",
  "table",
  "backlog",
  "calendar",
  "timeline",
  "dashboard",
] as const
export type ViewName = (typeof VIEW_NAMES)[number]

export interface ChecklistItem {
  id: string
  text: string
  done: boolean
}

export interface Checklist {
  id: string
  name: string
  items: ChecklistItem[]
}

/** Spawn-on-complete: completing a recurring task clones it with dates
    advanced by `interval` × `freq`. */
export interface Recurrence {
  freq: "daily" | "weekly" | "monthly" | "yearly"
  interval: number
}

/** Every filter is optional and they AND together; the same spec drives the
    task-list SQL on the server and `applyFilters` (lib/pm/filtering) here. */
export interface FilterSpec {
  q?: string
  columnIds?: string[]
  assignees?: string[]
  labelIds?: string[]
  typeIds?: string[]
  /** "none" = backlog (no sprint). */
  sprint?: "none" | (string & {})
  epicId?: string
  parentId?: string
  milestoneId?: string
  priorityGte?: number
  due?: "overdue" | "today" | "week"
  archived?: boolean
  trashed?: boolean
}

export interface SavedView {
  id: string
  name: string
  view?: ViewName
  filter: FilterSpec
}

// ---------------------------------------------------------------------------
// Automations: WHEN trigger → IF conditions → THEN actions

export type AutomationTrigger =
  | { type: "task_created" }
  | { type: "task_moved" }
  | { type: "task_completed" }
  /** Fires when the named task field appears in the mutation's changes. */
  | { type: "field_changed"; field: string }

export interface AutomationCondition {
  /** Task field name, read from the task AFTER the patch. */
  field: string
  op: "eq" | "neq" | "gte" | "lte" | "set" | "unset"
  value?: unknown
}

/** A whitelist of field-setting ops — an action only ever produces a patch
    that goes back through the server's mutation pipeline. */
export type AutomationAction =
  | { type: "set_column"; columnId: string }
  | { type: "set_priority"; priority: number }
  | { type: "set_assignees"; assignees: string[] }
  | { type: "add_label"; labelId: string }
  | { type: "remove_label"; labelId: string }
  | { type: "set_sprint"; sprintId: string | null }
  | { type: "set_milestone"; milestoneId: string | null }
  | { type: "set_type"; typeId: string }
  | { type: "set_due_date"; dueDate: number | null }
  | { type: "archive" }

export interface AutomationRule {
  id: string
  name: string
  enabled: boolean
  when: AutomationTrigger
  if: AutomationCondition[]
  then: AutomationAction[]
}

/** What a matched rule wants applied — the twin of `AutomationPatch` in
    server/src/pm/automations.ts, flattened from the whitelisted actions. It
    only ever reaches the client through the `/automations/test` dry run. */
export interface AutomationPatch {
  columnId?: string
  priority?: number
  assignees?: string[]
  labelIds?: string[]
  sprintId?: string | null
  milestoneId?: string | null
  typeId?: string
  dueDate?: number | null
  archive?: boolean
}

/** `POST /api/boards/:id/automations/test` — matched plus what WOULD be
    applied. Nothing is written; `effects` is empty when the rule misses. */
export interface AutomationTestResult {
  matched: boolean
  effects: Array<{ ruleId: string; patch: AutomationPatch }>
}

/** One changed field in a mutation — the shape pm_activity journals. */
export interface ChangeRecord {
  field: string
  from: unknown
  to: unknown
}

// ---------------------------------------------------------------------------
// Rows (the wire shape of a fetched entity IS the row — server/src/db/pm.ts)

export type ColumnCategory = "open" | "active" | "done"

export interface Column {
  id: string
  boardId: string
  name: string
  color: string | null
  /** Drives completedAt stamping and burndown, not just display. */
  category: ColumnCategory
  wipLimit: number | null
  /** Gap-1000 rank — see lib/pm/rank. */
  order: number
}

export interface Label {
  id: string
  boardId: string
  name: string
  color: string | null
}

export interface IssueType {
  id: string
  boardId: string
  name: string
  icon: string | null
  /** Epics ARE tasks — a task of an epic type collects children via `epicId`. */
  isEpic: boolean
  order: number
}

export type CustomFieldType =
  | "text"
  | "number"
  | "select"
  | "multiselect"
  | "date"
  | "checkbox"
  | "url"

export interface CustomFieldDef {
  id: string
  boardId: string
  name: string
  type: CustomFieldType
  /** Choices for select/multiselect; null for the other types. */
  options: string[] | null
  order: number
}

/** A task's values, keyed by CustomFieldDef id; the value shape depends on the
    field's type (string | number | boolean | string[]), validated server-side. */
export type CustomFieldValues = Record<string, unknown>

export type SprintState = "planned" | "active" | "completed"

/** Frozen at sprint /complete — committed vs done — so velocity stays exact. */
export interface SprintSnapshot {
  committedPoints: number
  completedPoints: number
  committedTasks: number
  completedTasks: number
  completedAt: number
}

export interface Sprint {
  id: string
  boardId: string
  name: string
  goal: string | null
  startDate: number | null
  endDate: number | null
  state: SprintState
  snapshot: SprintSnapshot | null
}

export interface Milestone {
  id: string
  boardId: string
  name: string
  date: number | null
  reachedAt: number | null
}

/** The board row alone — what `GET /api/boards` lists. The full `Board` below
    adds the per-board config tables. */
export interface BoardSummary {
  id: string
  name: string
  description: string | null
  color: string | null
  /** Human task keys are `<keyPrefix>-<n>`. */
  keyPrefix: string
  nextKey: number
  defaultView: ViewName
  savedViews: SavedView[]
  automations: AutomationRule[]
  /** Epoch ms; null = live. Archive hides, trash (`deletedAt`) is restorable. */
  archivedAt: number | null
  deletedAt: number | null
  /** Board id this template was duplicated from; null for ordinary boards. */
  templateFor: string | null
}

/** The wire Board `GET /api/boards/:id` returns: the row plus every per-board
    config table. Tasks are NOT here — they have their own list endpoint.
    NOTE: entries hydrated from the list endpoint carry empty config arrays
    until `actions.loadBoard` fetches the full shape. */
export type Board = BoardSummary & {
  columns: Column[]
  labels: Label[]
  issueTypes: IssueType[]
  customFields: CustomFieldDef[]
  sprints: Sprint[]
  milestones: Milestone[]
}

/** The wire shape of a task: the row plus its label ids (labels live in a join
    table — the only denormalization the client gets). Slim on purpose:
    comments and activity are lazy-fetched by the task editor. */
export interface Task {
  id: string
  boardId: string
  /** `<keyPrefix>-<n>`, unique per board. */
  key: string
  title: string
  descriptionMd: string | null
  columnId: string
  typeId: string | null
  /** 0 (none) … 4 (urgent). */
  priority: number
  /** Free-form names — single bearer token, no accounts. */
  assignees: string[]
  startDate: number | null
  dueDate: number | null
  storyPoints: number | null
  estimateMinutes: number | null
  epicId: string | null
  parentId: string | null
  sprintId: string | null
  milestoneId: string | null
  recurrence: Recurrence | null
  customFieldValues: CustomFieldValues
  checklists: Checklist[]
  /** Gap-1000 rank within the column. */
  order: number
  /** Gap-1000 rank in the backlog / sprint lane. */
  backlogRank: number
  createdAt: number
  updatedAt: number
  /** Stamped by a move into a done-category column, cleared by a move out. */
  completedAt: number | null
  archivedAt: number | null
  deletedAt: number | null
  /** Task this one was spawned from on recurrence completion. */
  recurrenceParentId: string | null
  labelIds: string[]
}

export interface Comment {
  id: string
  taskId: string
  author: string
  bodyMd: string
  createdAt: number
}

/** One row per changed field per mutation; `seq` is monotonic per task and is
    the `?after=` cursor. Label changes journal under the pseudo-field "labels". */
export interface ActivityEntry {
  taskId: string
  seq: number
  at: number
  actor: string
  field: string
  from: unknown
  to: unknown
}

/** `taskId` depends on (is blocked by) `dependsOnId`. */
export interface TaskDep {
  taskId: string
  dependsOnId: string
}

// ---------------------------------------------------------------------------
// HTTP inputs (the server fills defaults via zod — optionals here)

export interface BoardInput {
  name: string
  description?: string | null
  color?: string | null
  /** Uppercased human key prefix ("DAE" → DAE-1). Collision → 400. */
  keyPrefix: string
  defaultView?: ViewName
}

export interface ColumnInput {
  name: string
  color?: string | null
  category?: ColumnCategory
  wipLimit?: number | null
}

export interface LabelInput {
  name: string
  color?: string | null
}

export interface IssueTypeInput {
  name: string
  icon?: string | null
  isEpic?: boolean
}

export interface CustomFieldInput {
  name: string
  type: CustomFieldType
  /** Required (non-empty) for select/multiselect. */
  options?: string[] | null
}

export interface SprintInput {
  name: string
  goal?: string | null
  startDate?: number | null
  endDate?: number | null
}

export interface MilestoneInput {
  name: string
  date?: number | null
}

export interface TaskCreateInput {
  title: string
  descriptionMd?: string | null
  /** Defaults to the board's first column. */
  columnId?: string
  typeId?: string | null
  priority?: number
  assignees?: string[]
  startDate?: number | null
  dueDate?: number | null
  storyPoints?: number | null
  estimateMinutes?: number | null
  epicId?: string | null
  parentId?: string | null
  sprintId?: string | null
  milestoneId?: string | null
  labelIds?: string[]
  recurrence?: Recurrence | null
  customFieldValues?: CustomFieldValues
  checklists?: Checklist[]
}

/** PATCH body: every field optional, absent = untouched. Moves go through
    MoveOp (they also rank); archive/trash through their endpoints. */
export interface TaskPatch {
  title?: string
  descriptionMd?: string | null
  typeId?: string | null
  priority?: number
  assignees?: string[]
  startDate?: number | null
  dueDate?: number | null
  storyPoints?: number | null
  estimateMinutes?: number | null
  epicId?: string | null
  parentId?: string | null
  sprintId?: string | null
  milestoneId?: string | null
  labelIds?: string[]
  recurrence?: Recurrence | null
  customFieldValues?: CustomFieldValues
  checklists?: Checklist[]
}

/** Kanban drop: target column + position; `sprintId` present = also (re)assign
    the sprint (backlog lanes), absent = leave it alone. */
export interface MoveOp {
  columnId: string
  index: number
  sprintId?: string | null
}

/** Rewrite one rank list wholesale (sorts, multi-drag gestures). `scope` names
    which gap-1000 rank the ids reorder. */
export interface BulkReorder {
  scope:
    | { kind: "column"; columnId: string }
    | { kind: "backlog" }
    | { kind: "sprint"; sprintId: string }
    | { kind: "columns" }
  orderedIds: string[]
}

/** The fields the table's bulk bar offers — a subset of TaskPatch plus
    columnId (bulk moves append at the target column's end). */
export interface BulkPatch {
  columnId?: string
  typeId?: string | null
  priority?: number
  assignees?: string[]
  sprintId?: string | null
  milestoneId?: string | null
  dueDate?: number | null
  labelIds?: string[]
}

/** Multi-select toolbar: one op over many tasks, one transaction, one response. */
export interface BulkOp {
  ids: string[]
  op:
    | { type: "patch"; patch: BulkPatch }
    | { type: "archive" }
    | { type: "unarchive" }
    | { type: "trash" }
    | { type: "restore" }
}

export interface CommentInput {
  author: string
  bodyMd: string
}

// ---------------------------------------------------------------------------
// Response envelopes

export interface TaskPage {
  total: number
  tasks: Task[]
}

export interface CommentPage {
  total: number
  comments: Comment[]
}

/** `GET /api/boards/:id/dependencies` — arrows plus the blocked badge set. */
export interface DependencyGraph {
  dependencies: TaskDep[]
  blockedTaskIds: string[]
}

// ---------------------------------------------------------------------------
// Reports (mirrored from server/src/pm/reports.ts)

export interface BurndownPoint {
  /** Epoch ms of the day's UTC midnight. */
  date: number
  completed: number
  remaining: number
  /** Linear reference line from full commitment to zero. */
  ideal: number
}

export interface Burndown {
  sprint: Sprint
  totalPoints: number
  totalTasks: number
  series: BurndownPoint[]
}

export interface VelocityEntry {
  sprintId: string
  name: string
  completedAt: number | null
  committedPoints: number
  completedPoints: number
  committedTasks: number
  completedTasks: number
  /** true = from the frozen /complete snapshot; false = reconstructed. */
  exact: boolean
}

export interface DashboardStats {
  totalTasks: number
  byCategory: { open: number; active: number; done: number }
  overdue: number
  pointsTotal: number
  pointsDone: number
  byAssignee: Array<{ assignee: string; count: number }>
}

/** `GET /api/search?q=` — cross-board LIKE over title/key/description. */
export interface SearchHit {
  id: string
  boardId: string
  key: string
  title: string
  columnId: string
  boardName: string
}

// ---------------------------------------------------------------------------
// View contract

/** Every board view component (kanban/list/table/…) takes exactly this —
    pm-page owns fetching, filtering and the editor dialog; a view only lays
    the given tasks out and reports which one was opened. */
export interface PmViewProps {
  board: Board
  tasks: Task[]
  onOpenTask(id: string): void
}
