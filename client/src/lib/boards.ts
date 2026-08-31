import * as React from "react"
import { api, type ServerSettings } from "./settings"

/* ── Boards and their columns ──
   The client half of server/src/boards.ts. A board is a kanban and a status is
   one of its columns — both rows, not constants, which is what makes "add a
   status" a button instead of a release.

   Same module-level reactive shape as tasks-board.ts, and loaded the same way:
   `GET /api/boards` answers with every board AND every column of every board in
   one request, so switching boards is a local filter rather than a round trip.
   Mutations re-read that one endpoint instead of patching the local arrays —
   the server reorders siblings on insert and closes gaps on delete, so a local
   patch would have to reimplement those rules to stay in step.

   Column edits can move TASKS (deleting a column rehomes them; deleting a board
   takes them with it), which this store deliberately does not model: the page
   reloads the task list after those two, so there is exactly one place that
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

export interface BoardsState {
  boards: Board[]
  statuses: BoardStatus[]
  /** False until the first load answers — the page must not decide a board is
      empty (and offer to seed one) before it has heard from the server. */
  loaded: boolean
}

// ---- reactive state ----

let state: BoardsState = { boards: [], statuses: [], loaded: false }
const listeners = new Set<() => void>()

function set(next: Partial<BoardsState>) {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

export function boardsSnapshot(): BoardsState {
  return state
}

export function subscribeBoards(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useBoards(): BoardsState {
  return React.useSyncExternalStore(subscribeBoards, boardsSnapshot, boardsSnapshot)
}

/** One board's columns, left to right. */
export function statusesOf(all: BoardStatus[], boardId: string): BoardStatus[] {
  return all.filter((s) => s.boardId === boardId).sort((a, b) => a.order - b.order)
}

// ---- verbs ----

interface BoardsPayload {
  boards: Board[]
  statuses: BoardStatus[]
}

let inflight: Promise<void> | null = null

/** Load every board and column. Deduped while a load is already in flight. */
export function loadBoards(settings: ServerSettings): Promise<void> {
  if (inflight) return inflight
  inflight = api<BoardsPayload>(settings, "/api/boards")
    .then((payload) => set({ ...payload, loaded: true }))
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** Re-read after a mutation, jumping the in-flight dedupe: the point of the
    call is to see the write, so joining a request that started before it would
    return the state we just changed. */
function refresh(settings: ServerSettings): Promise<void> {
  inflight = null
  return loadBoards(settings)
}

export async function createBoard(
  settings: ServerSettings,
  input: { name: string; color?: BoardColor | null; statuses?: string[] },
): Promise<Board> {
  const board = await api<Board>(settings, "/api/boards", {
    method: "POST",
    body: JSON.stringify(input),
  })
  await refresh(settings)
  return board
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
  await refresh(settings)
}

/** Deletes the board's columns and tasks too — the caller reloads the task
    list, which this store does not own. */
export async function deleteBoard(settings: ServerSettings, id: string): Promise<void> {
  await api<{ ok: boolean }>(settings, `/api/boards/${encodeURIComponent(id)}`, {
    method: "DELETE",
  })
  await refresh(settings)
}

export async function createStatus(
  settings: ServerSettings,
  boardId: string,
  input: { name: string; color?: BoardColor | null; order?: number },
): Promise<BoardStatus> {
  const status = await api<BoardStatus>(
    settings,
    `/api/boards/${encodeURIComponent(boardId)}/statuses`,
    { method: "POST", body: JSON.stringify(input) },
  )
  await refresh(settings)
  return status
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
  await refresh(settings)
}

/** `moveTo` is where this column's tasks go; omitted, the board's first
    remaining column. Either way they move — the caller reloads the tasks. */
export async function deleteStatus(
  settings: ServerSettings,
  id: string,
  moveTo?: string,
): Promise<void> {
  const query = moveTo ? `?moveTo=${encodeURIComponent(moveTo)}` : ""
  await api<{ ok: boolean }>(settings, `/api/statuses/${encodeURIComponent(id)}${query}`, {
    method: "DELETE",
  })
  await refresh(settings)
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
  await refresh(settings)
}
