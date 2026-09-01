/* The boards/tasks query hooks. The list is the cache; every mutation applies
   what the server answered back into it — create/update replace one row,
   reorder adopts the authoritative list verbatim — and the two writes that
   rehome tasks (column delete, board delete) invalidate the task list too,
   exactly as the page's `loadTasks(settings, true)` calls used to. */
import { useQuery, useQueryClient } from "@tanstack/react-query"

import type { Board, BoardStatus } from "@/lib/boards"
import {
  createBoard,
  createStatus,
  deleteBoard,
  deleteStatus,
  fetchBoards,
  reorderStatuses,
  updateBoard,
  updateStatus,
} from "@/lib/boards"
import type { ReorderEntry, Task, TaskInput } from "@/lib/tasks-board"
import { createTask, deleteTask, fetchTasks, reorderTasks, updateTask } from "@/lib/tasks-board"
import { useServer } from "@/lib/server-context"
import { boardsKey, tasksKey } from "./keys"
import { useApiMutation } from "./helpers"

/** Every board and every column of every board, one request — switching
    boards is a local filter rather than a round trip. */
export function useBoards() {
  const settings = useServer()
  const query = useQuery({
    queryKey: boardsKey(settings),
    queryFn: ({ signal }) => fetchBoards(settings, signal),
  })
  return {
    boards: query.data?.boards ?? [],
    statuses: query.data?.statuses ?? [],
    /** False until the first load answers — the page must not decide a board
        is empty (and offer to seed one) before it has heard from the server. */
    loaded: query.isSuccess,
  }
}

/** The board list, but only when the caller wants it — the routine form's
    on-finish editor asks lazily, since a board list is a request and most
    routines never add a task action. */
export function useBoardsEnabled(enabled: boolean) {
  const settings = useServer()
  const query = useQuery({
    queryKey: boardsKey(settings),
    queryFn: ({ signal }) => fetchBoards(settings, signal),
    enabled,
  })
  return {
    boards: query.data?.boards ?? [],
    statuses: query.data?.statuses ?? [],
    loaded: query.isSuccess,
  }
}

/** Every task, across every board — the page filters by board. */
export function useTasksQuery() {
  const settings = useServer()
  return useQuery({
    queryKey: tasksKey(settings),
    queryFn: ({ signal }) => fetchTasks(settings, signal),
    staleTime: 15_000,
  })
}

/* Apply-with-the-answer: the server's row is the authority, so the cache
   takes it rather than re-reading. The list is deliberately not re-sorted —
   its order is the server's (board, column, position), and re-sorting by
   priority here made the list view jump into a different order after an edit
   than it had after a reload. Consumers that want another order say so. */
function useTaskCache() {
  const settings = useServer()
  const qc = useQueryClient()
  return {
    upsert(row: Task) {
      qc.setQueryData<Task[]>(tasksKey(settings), (prev) => {
        const tasks = prev ?? []
        const at = tasks.findIndex((t) => t.id === row.id)
        return at === -1 ? [...tasks, row] : tasks.map((t) => (t.id === row.id ? row : t))
      })
    },
    remove(id: string) {
      qc.setQueryData<Task[]>(tasksKey(settings), (prev) => prev?.filter((t) => t.id !== id))
    },
    setAll(rows: Task[]) {
      qc.setQueryData<Task[]>(tasksKey(settings), rows)
    },
  }
}

export function useCreateTask() {
  const cache = useTaskCache()
  return useApiMutation<{ input: TaskInput }, Task>(
    [],
    (settings, { input }) => createTask(settings, input),
    (task) => cache.upsert(task)
  )
}

export function useUpdateTask() {
  const cache = useTaskCache()
  return useApiMutation<{ id: string; input: Partial<TaskInput> }, Task>(
    [],
    (settings, { id, input }) => updateTask(settings, id, input),
    (task) => cache.upsert(task)
  )
}

export function useDeleteTask() {
  const cache = useTaskCache()
  return useApiMutation<string, void>(
    [],
    (settings, id) => deleteTask(settings, id),
    (_void, id) => cache.remove(id)
  )
}

/** Atomically commit a reorder / status move; the server's authoritative list
    replaces the cache, so the client never invents an ordering. */
export function useReorderTasks() {
  const cache = useTaskCache()
  return useApiMutation<{ entries: ReorderEntry[]; board: string }, Task[]>(
    [],
    (settings, { entries, board }) => reorderTasks(settings, entries, board),
    (rows) => cache.setAll(rows)
  )
}

// ---- boards and columns ----

/* Board and column writes all invalidate the boards key: the server reorders
   siblings on insert and closes gaps on delete, so a local patch would have
   to reimplement those rules to stay in step. */

function useBoardKeys(rehomeTasks: boolean) {
  const settings = useServer()
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: boardsKey(settings) })
    // Column and board deletes move (or take) tasks; the list on screen still
    // has them in a column that may no longer exist.
    if (rehomeTasks) void qc.invalidateQueries({ queryKey: tasksKey(settings) })
  }
}

export function useCreateBoard() {
  const invalidate = useBoardKeys(false)
  return useApiMutation<
    { name: string; color?: Board["color"] | null; statuses?: string[] },
    Board
  >([], (settings, input) => createBoard(settings, input), invalidate)
}

export function useUpdateBoard() {
  const invalidate = useBoardKeys(false)
  return useApiMutation<
    { id: string; input: { name?: string; color?: Board["color"] | null; order?: number } },
    void
  >([], (settings, { id, input }) => updateBoard(settings, id, input), invalidate)
}

export function useDeleteBoard() {
  const invalidate = useBoardKeys(true)
  return useApiMutation<string, void>(
    [],
    (settings, id) => deleteBoard(settings, id),
    invalidate
  )
}

export function useCreateStatus() {
  const invalidate = useBoardKeys(false)
  return useApiMutation<
    { boardId: string; input: { name: string; color?: BoardStatus["color"] | null; order?: number } },
    BoardStatus
  >([], (settings, { boardId, input }) => createStatus(settings, boardId, input), invalidate)
}

export function useUpdateStatus() {
  const invalidate = useBoardKeys(false)
  return useApiMutation<
    { id: string; input: { name?: string; color?: BoardStatus["color"] | null } },
    void
  >([], (settings, { id, input }) => updateStatus(settings, id, input), invalidate)
}

/** `moveTo` is where this column's tasks go; omitted, the board's first
    remaining column. Either way they move. */
export function useDeleteStatus() {
  const invalidate = useBoardKeys(true)
  return useApiMutation<{ id: string; moveTo?: string }, void>(
    [],
    (settings, { id, moveTo }) => deleteStatus(settings, id, moveTo),
    invalidate
  )
}

export function useReorderStatuses() {
  const invalidate = useBoardKeys(false)
  return useApiMutation<{ boardId: string; ids: string[] }, void>(
    [],
    (settings, { boardId, ids }) => reorderStatuses(settings, boardId, ids),
    invalidate
  )
}
