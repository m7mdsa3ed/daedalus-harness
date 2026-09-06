import { api, type ServerSettings } from "./settings"

/* ── Boards, columns, sprints, saved views ──
   The client half of server/src/boards.ts. A board is a project of work with
   its own key (`DAE-42`), columns, sprints, saved views and custom fields; a
   status is one of its columns — all rows, not constants, which is what makes
   "add a status" a button instead of a release.

   `GET /api/boards` answers with every board AND every column, sprint and view
   of every board in one request, so switching boards is a local filter rather
   than a round trip; the query cache (lib/queries/boards.ts) holds that
   payload and the verbs below let its mutations invalidate instead of patching
   local arrays — the server reorders siblings on insert and closes gaps on
   delete, so a local patch would have to reimplement those rules to stay in
   step.

   Column and sprint edits can move TASKS (deleting a column rehomes them,
   closing a sprint moves its open work, deleting a board takes them with it),
   which the boards cache deliberately does not model: the task list is
   invalidated after those, so there is exactly one place that knows what a
   task's position is. */

export const BOARD_COLORS = [
  "slate",
  "blue",
  "violet",
  "emerald",
  "amber",
  "rose",
  "cyan",
  "orange",
] as const
export type BoardColor = (typeof BOARD_COLORS)[number]

export const STATUS_CATEGORIES = ["todo", "in_progress", "done"] as const
export type StatusCategory = (typeof STATUS_CATEGORIES)[number]

export const VIEW_KINDS = ["board", "list", "table", "calendar", "timeline"] as const
export type ViewKind = (typeof VIEW_KINDS)[number]

export const FIELD_TYPES = ["text", "number", "select", "date", "checkbox", "url"] as const
export type FieldType = (typeof FIELD_TYPES)[number]

export interface CustomFieldDef {
  id: string
  name: string
  type: FieldType
  options?: string[]
}

export interface Board {
  id: string
  name: string
  /** Prefix of every task key on the board. */
  key: string
  description: string | null
  /** → `Project.id`, or null. */
  projectId: string | null
  color: BoardColor | null
  order: number
  nextNumber: number
  customFields: CustomFieldDef[]
  createdAt: number
  updatedAt: number
}

export interface BoardStatus {
  id: string
  boardId: string
  name: string
  color: BoardColor | null
  category: StatusCategory
  wipLimit: number | null
  order: number
  createdAt: number
  updatedAt: number
}

export type SprintState = "planned" | "active" | "closed"

export interface Sprint {
  id: string
  boardId: string
  name: string
  goal: string | null
  startAt: number | null
  endAt: number | null
  state: SprintState
  order: number
  createdAt: number
  updatedAt: number
}

/** What a saved view remembers — see `lib/tasks-view.ts` for the filter shape
    the page reads out of `filters`. */
export interface BoardViewConfig {
  filters?: Record<string, unknown>
  groupBy?: string
  sortBy?: string
  sortDir?: "asc" | "desc"
  columns?: string[]
}

export interface BoardView {
  id: string
  boardId: string
  name: string
  kind: ViewKind
  config: BoardViewConfig
  order: number
  createdAt: number
  updatedAt: number
}

/** Dot/tint classes per palette token. Kept here rather than in the components
    so a new token is one edit, and expressed as literal class names because
    Tailwind cannot see a template string. */
export const COLOR_DOT: Record<BoardColor, string> = {
  slate: "bg-slate-400",
  blue: "bg-blue-500",
  violet: "bg-violet-500",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  cyan: "bg-cyan-500",
  orange: "bg-orange-500",
}

/** Soft tint + text pair for pills (status chips, column headers). */
export const COLOR_TINT: Record<BoardColor, string> = {
  slate: "bg-slate-500/12 text-slate-700 dark:text-slate-300",
  blue: "bg-blue-500/12 text-blue-700 dark:text-blue-300",
  violet: "bg-violet-500/12 text-violet-700 dark:text-violet-300",
  emerald: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  amber: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
  rose: "bg-rose-500/12 text-rose-700 dark:text-rose-300",
  cyan: "bg-cyan-500/12 text-cyan-700 dark:text-cyan-300",
  orange: "bg-orange-500/12 text-orange-700 dark:text-orange-300",
}

export const COLOR_LABEL: Record<BoardColor, string> = {
  slate: "Slate",
  blue: "Blue",
  violet: "Violet",
  emerald: "Emerald",
  amber: "Amber",
  rose: "Rose",
  cyan: "Cyan",
  orange: "Orange",
}

export const CATEGORY_LABEL: Record<StatusCategory, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
}

export interface BoardsPayload {
  boards: Board[]
  statuses: BoardStatus[]
  sprints: Sprint[]
  views: BoardView[]
}

/** One board's columns, left to right. */
export function statusesOf(all: BoardStatus[], boardId: string): BoardStatus[] {
  return all.filter((s) => s.boardId === boardId).sort((a, b) => a.order - b.order)
}

export function sprintsOf(all: Sprint[], boardId: string): Sprint[] {
  return all.filter((s) => s.boardId === boardId).sort((a, b) => a.order - b.order)
}

export function viewsOf(all: BoardView[], boardId: string): BoardView[] {
  return all.filter((v) => v.boardId === boardId).sort((a, b) => a.order - b.order)
}

// ---- verbs ----
/* Read on their own through the query hooks in lib/queries/boards.ts; the
   verbs here are pure api calls that answer with the server's row (or the
   refreshed payload) and let the cache decide what to invalidate. */

export const fetchBoards = (settings: ServerSettings, signal?: AbortSignal) =>
  api<BoardsPayload>(settings, "/api/boards", { signal })

export interface BoardInput {
  name?: string
  key?: string
  description?: string | null
  projectId?: string | null
  color?: BoardColor | null
  order?: number
  customFields?: CustomFieldDef[]
}

export async function createBoard(
  settings: ServerSettings,
  input: BoardInput & { name: string; statuses?: string[] },
): Promise<Board> {
  return api<Board>(settings, "/api/boards", { method: "POST", body: JSON.stringify(input) })
}

export async function updateBoard(settings: ServerSettings, id: string, input: BoardInput): Promise<Board> {
  return api<Board>(settings, `/api/boards/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  })
}

/** Deletes the board's columns, sprints, views and tasks too — the
    invalidating hook re-reads the task list, which the board cache does not own. */
export async function deleteBoard(settings: ServerSettings, id: string): Promise<void> {
  await api<{ ok: boolean }>(settings, `/api/boards/${encodeURIComponent(id)}`, { method: "DELETE" })
}

export interface StatusInput {
  name?: string
  color?: BoardColor | null
  category?: StatusCategory
  wipLimit?: number | null
  order?: number
}

export async function createStatus(
  settings: ServerSettings,
  boardId: string,
  input: StatusInput & { name: string },
): Promise<BoardStatus> {
  return api<BoardStatus>(settings, `/api/boards/${encodeURIComponent(boardId)}/statuses`, {
    method: "POST",
    body: JSON.stringify(input),
  })
}

export async function updateStatus(settings: ServerSettings, id: string, input: StatusInput): Promise<void> {
  await api<BoardStatus>(settings, `/api/statuses/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  })
}

/** `moveTo` is where this column's tasks go; omitted, the board's first
    remaining column. Either way they move — the invalidating hook re-reads
    the tasks. */
export async function deleteStatus(settings: ServerSettings, id: string, moveTo?: string): Promise<void> {
  const query = moveTo ? `?moveTo=${encodeURIComponent(moveTo)}` : ""
  await api<{ ok: boolean }>(settings, `/api/statuses/${encodeURIComponent(id)}${query}`, {
    method: "DELETE",
  })
}

export async function reorderStatuses(settings: ServerSettings, boardId: string, ids: string[]): Promise<void> {
  await api<BoardStatus[]>(settings, `/api/boards/${encodeURIComponent(boardId)}/statuses/reorder`, {
    method: "POST",
    body: JSON.stringify({ ids }),
  })
}

export interface SprintInput {
  name?: string
  goal?: string | null
  startAt?: number | null
  endAt?: number | null
}

export async function createSprint(
  settings: ServerSettings,
  boardId: string,
  input: SprintInput & { name: string },
): Promise<Sprint> {
  return api<Sprint>(settings, `/api/boards/${encodeURIComponent(boardId)}/sprints`, {
    method: "POST",
    body: JSON.stringify(input),
  })
}

export async function updateSprint(settings: ServerSettings, id: string, input: SprintInput): Promise<Sprint> {
  return api<Sprint>(settings, `/api/sprints/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  })
}

export async function startSprint(settings: ServerSettings, id: string): Promise<Sprint> {
  return api<Sprint>(settings, `/api/sprints/${encodeURIComponent(id)}/start`, { method: "POST" })
}

export interface CompleteSprintResult {
  sprint: Sprint
  moved: number
  next: Sprint | null
}

/** Close a sprint; `moveTo` says where its unfinished tasks go. */
export async function completeSprint(
  settings: ServerSettings,
  id: string,
  moveTo: "backlog" | "next",
): Promise<CompleteSprintResult> {
  return api<CompleteSprintResult>(settings, `/api/sprints/${encodeURIComponent(id)}/complete`, {
    method: "POST",
    body: JSON.stringify({ moveTo }),
  })
}

export async function deleteSprint(settings: ServerSettings, id: string): Promise<void> {
  await api<{ ok: boolean }>(settings, `/api/sprints/${encodeURIComponent(id)}`, { method: "DELETE" })
}

export interface ViewInput {
  name?: string
  kind?: ViewKind
  config?: BoardViewConfig
  order?: number
}

export async function createView(
  settings: ServerSettings,
  boardId: string,
  input: ViewInput & { name: string; kind: ViewKind },
): Promise<BoardView> {
  return api<BoardView>(settings, `/api/boards/${encodeURIComponent(boardId)}/views`, {
    method: "POST",
    body: JSON.stringify(input),
  })
}

export async function updateView(settings: ServerSettings, id: string, input: ViewInput): Promise<BoardView> {
  return api<BoardView>(settings, `/api/views/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  })
}

export async function deleteView(settings: ServerSettings, id: string): Promise<void> {
  await api<{ ok: boolean }>(settings, `/api/views/${encodeURIComponent(id)}`, { method: "DELETE" })
}
