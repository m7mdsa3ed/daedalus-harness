import { api, type ServerSettings } from "./settings"

/* ── Boards and their columns ──
   The client half of server/src/boards.ts. A board is a kanban and a status is
   one of its columns — both rows, not constants, which is what makes "add a
   status" a button instead of a release.

   `GET /api/boards` answers with every board AND every column of every board
   in one request, so switching boards is a local filter rather than a round
   trip; the query cache (lib/queries/boards.ts) holds that payload and the
   verbs below let its mutations invalidate instead of patching local arrays —
   the server reorders siblings on insert and closes gaps on delete, so a local
   patch would have to reimplement those rules to stay in step.

   Column edits can move TASKS (deleting a column rehomes them; deleting a board
   takes them with it), which the boards cache deliberately does not model: the
   task list is invalidated after those two, so there is exactly one place that
   knows what a task's position is. */

export interface Board {
  id: string
  name: string
  color: BoardColor | null
  order: number
  createdAt: number
  updatedAt: number
}

export interface BoardStatus {
  id: string
  boardId: string
  name: string
  color: BoardColor | null
  order: number
  createdAt: number
  updatedAt: number
}

export const BOARD_COLORS = ["slate", "blue", "violet", "emerald", "amber", "rose"] as const
export type BoardColor = (typeof BOARD_COLORS)[number]

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
}

export const COLOR_LABEL: Record<BoardColor, string> = {
  slate: "Slate",
  blue: "Blue",
  violet: "Violet",
  emerald: "Emerald",
  amber: "Amber",
  rose: "Rose",
}

export interface BoardsPayload {
  boards: Board[]
  statuses: BoardStatus[]
}

/** One board's columns, left to right. */
export function statusesOf(all: BoardStatus[], boardId: string): BoardStatus[] {
  return all.filter((s) => s.boardId === boardId).sort((a, b) => a.order - b.order)
}

// ---- verbs ----
/* Read on their own through the query hooks in lib/queries/boards.ts; the
   verbs here are pure api calls that answer with the server's row (or the
   refreshed payload) and let the cache decide what to invalidate. */

/** Every board and every column of every board, one request — switching
    boards is a local filter rather than a round trip. */
export const fetchBoards = (settings: ServerSettings, signal?: AbortSignal) =>
  api<BoardsPayload>(settings, "/api/boards", { signal })

export async function createBoard(
  settings: ServerSettings,
  input: { name: string; color?: BoardColor | null; statuses?: string[] },
): Promise<Board> {
  return api<Board>(settings, "/api/boards", {
    method: "POST",
    body: JSON.stringify(input),
  })
}

export async function updateBoard(
  settings: ServerSettings,
  id: string,
  input: { name?: string; color?: BoardColor | null; order?: number },
): Promise<void> {
  await api<Board>(settings, `/api/boards/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  })
}

/** Deletes the board's columns and tasks too — the invalidating hook re-reads
    the task list, which the board cache does not own. */
export async function deleteBoard(settings: ServerSettings, id: string): Promise<void> {
  await api<{ ok: boolean }>(settings, `/api/boards/${encodeURIComponent(id)}`, {
    method: "DELETE",
  })
}

export async function createStatus(
  settings: ServerSettings,
  boardId: string,
  input: { name: string; color?: BoardColor | null; order?: number },
): Promise<BoardStatus> {
  return api<BoardStatus>(
    settings,
    `/api/boards/${encodeURIComponent(boardId)}/statuses`,
    { method: "POST", body: JSON.stringify(input) },
  )
}

export async function updateStatus(
  settings: ServerSettings,
  id: string,
  input: { name?: string; color?: BoardColor | null },
): Promise<void> {
  await api<BoardStatus>(settings, `/api/statuses/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  })
}

/** `moveTo` is where this column's tasks go; omitted, the board's first
    remaining column. Either way they move — the invalidating hook re-reads
    the tasks. */
export async function deleteStatus(
  settings: ServerSettings,
  id: string,
  moveTo?: string,
): Promise<void> {
  const query = moveTo ? `?moveTo=${encodeURIComponent(moveTo)}` : ""
  await api<{ ok: boolean }>(settings, `/api/statuses/${encodeURIComponent(id)}${query}`, {
    method: "DELETE",
  })
}

export async function reorderStatuses(
  settings: ServerSettings,
  boardId: string,
  ids: string[],
): Promise<void> {
  await api<BoardStatus[]>(settings, `/api/boards/${encodeURIComponent(boardId)}/statuses/reorder`, {
    method: "POST",
    body: JSON.stringify({ ids }),
  })
}
