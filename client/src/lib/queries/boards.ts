/* The boards/tasks query hooks. The list is the cache; every mutation applies
   what the server answered back into it — create/update replace one row,
   reorder adopts the authoritative list verbatim, bulk merges its rows — and
   the writes that rehome tasks (column delete, board delete, sprint close or
   delete) invalidate the task list too. A task's detail (comments, activity,
   links, children) is its own key, invalidated by anything that touches it. */
import { useQuery, useQueryClient } from "@tanstack/react-query"

import type { Board, BoardStatus, BoardView, Sprint, ViewKind } from "@/lib/boards"
import {
  completeSprint,
  createBoard,
  createSprint,
  createStatus,
  createView,
  deleteBoard,
  deleteSprint,
  deleteStatus,
  deleteView,
  fetchBoards,
  reorderStatuses,
  startSprint,
  updateBoard,
  updateSprint,
  updateStatus,
  updateView,
  type BoardInput,
  type BoardViewConfig,
  type CompleteSprintResult,
  type SprintInput,
  type StatusInput,
} from "@/lib/boards"
import type {
  BulkPatch,
  LinkKind,
  ReorderEntry,
  Task,
  TaskComment,
  TaskDetail,
  TaskInput,
  TaskLink,
} from "@/lib/tasks-board"
import {
  addComment,
  addLink,
  bulkUpdateTasks,
  createTask,
  deleteComment,
  deleteLink,
  deleteTask,
  fetchTaskDetail,
  fetchTasks,
  reorderTasks,
  updateComment,
  updateTask,
} from "@/lib/tasks-board"
import { useServer } from "@/lib/server-context"
import { boardsKey, taskDetailKey, tasksKey } from "./keys"
import { useApiMutation } from "./helpers"

const EMPTY: never[] = []

/** Every board and every column, sprint and view of every board, one request
    — switching boards is a local filter rather than a round trip. */
export function useBoards() {
  const settings = useServer()
  const query = useQuery({
    queryKey: boardsKey(settings),
    queryFn: ({ signal }) => fetchBoards(settings, signal),
  })
  return {
    boards: query.data?.boards ?? (EMPTY as Board[]),
    statuses: query.data?.statuses ?? (EMPTY as BoardStatus[]),
    sprints: query.data?.sprints ?? (EMPTY as Sprint[]),
    views: query.data?.views ?? (EMPTY as BoardView[]),
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
    boards: query.data?.boards ?? (EMPTY as Board[]),
    statuses: query.data?.statuses ?? (EMPTY as BoardStatus[]),
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

/** One task's comments, activity, links and children — what the detail panel
    opens on. `id` null = closed, no request. */
export function useTaskDetail(id: string | null) {
  const settings = useServer()
  return useQuery({
    queryKey: taskDetailKey(settings, id ?? ""),
    queryFn: ({ signal }) => fetchTaskDetail(settings, id!, signal),
    enabled: !!id,
    staleTime: 5_000,
  })
}

/* Apply-with-the-answer: the server's row is the authority, so the cache
   takes it rather than re-reading. The list is deliberately not re-sorted —
   its order is the server's (board, column, position). Consumers that want
   another order say so. */
function useTaskCache() {
  const settings = useServer()
  const qc = useQueryClient()
  return {
    upsert(rows: Task | Task[]) {
      const list = Array.isArray(rows) ? rows : [rows]
      qc.setQueryData<Task[]>(tasksKey(settings), (prev) => {
        let tasks = prev ?? []
        for (const row of list) {
          const at = tasks.findIndex((t) => t.id === row.id)
          tasks = at === -1 ? [...tasks, row] : tasks.map((t) => (t.id === row.id ? row : t))
        }
        return tasks
      })
      for (const row of list) {
        qc.setQueryData<TaskDetail>(taskDetailKey(settings, row.id), (prev) =>
          prev ? { ...prev, task: row } : prev,
        )
      }
    },
    remove(id: string) {
      qc.setQueryData<Task[]>(tasksKey(settings), (prev) =>
        prev?.filter((t) => t.id !== id).map((t) => (t.parentId === id ? { ...t, parentId: null } : t)),
      )
      qc.removeQueries({ queryKey: taskDetailKey(settings, id) })
    },
    setAll(rows: Task[]) {
      qc.setQueryData<Task[]>(tasksKey(settings), rows)
    },
    invalidateDetail(id: string) {
      void qc.invalidateQueries({ queryKey: taskDetailKey(settings, id) })
    },
    invalidateAllDetails() {
      void qc.invalidateQueries({ queryKey: taskDetailKey(settings) })
    },
  }
}

export function useCreateTask() {
  const cache = useTaskCache()
  return useApiMutation<{ input: TaskInput & { title: string } }, Task>(
    [],
    (settings, { input }) => createTask(settings, input),
    (task) => {
      cache.upsert(task)
      // A new child changes its parent's detail.
      if (task.parentId) cache.invalidateDetail(task.parentId)
    },
  )
}

export function useUpdateTask() {
  const cache = useTaskCache()
  return useApiMutation<{ id: string; input: TaskInput }, Task>(
    [],
    (settings, { id, input }) => updateTask(settings, id, input),
    (task) => {
      cache.upsert(task)
      // The activity log grew; the parent may have gained or lost a child.
      cache.invalidateDetail(task.id)
      if (task.parentId) cache.invalidateDetail(task.parentId)
    },
  )
}

export function useBulkUpdateTasks() {
  const cache = useTaskCache()
  return useApiMutation<{ ids: string[]; patch: BulkPatch }, Task[]>(
    [],
    (settings, { ids, patch }) => bulkUpdateTasks(settings, ids, patch),
    (rows) => {
      cache.upsert(rows)
      cache.invalidateAllDetails()
    },
  )
}

export function useDeleteTask() {
  const cache = useTaskCache()
  return useApiMutation<string, void>(
    [],
    (settings, id) => deleteTask(settings, id),
    (_void, id) => {
      cache.remove(id)
      cache.invalidateAllDetails()
    },
  )
}

/** Atomically commit a reorder / status move; the server's authoritative list
    replaces the cache, so the client never invents an ordering. */
export function useReorderTasks() {
  const cache = useTaskCache()
  return useApiMutation<{ entries: ReorderEntry[]; board: string }, Task[]>(
    [],
    (settings, { entries, board }) => reorderTasks(settings, entries, board),
    (rows) => cache.setAll(rows),
  )
}

// ---- detail: comments and links ----

export function useAddComment() {
  const settings = useServer()
  return useApiMutation<{ taskId: string; body: string }, TaskComment>(
    (row) => [taskDetailKey(settings, row.taskId)],
    (s, { taskId, body }) => addComment(s, taskId, { body }),
  )
}

export function useUpdateComment() {
  const settings = useServer()
  return useApiMutation<{ id: string; taskId: string; body: string }, TaskComment>(
    (row) => [taskDetailKey(settings, row.taskId)],
    (s, { id, body }) => updateComment(s, id, body),
  )
}

export function useDeleteComment() {
  const settings = useServer()
  return useApiMutation<{ id: string; taskId: string }, void>(
    (_void, input) => [taskDetailKey(settings, input.taskId)],
    (s, { id }) => deleteComment(s, id),
  )
}

export function useAddLink() {
  const settings = useServer()
  return useApiMutation<{ fromId: string; toId: string; kind: LinkKind }, TaskLink>(
    (row) => [taskDetailKey(settings, row.fromId), taskDetailKey(settings, row.toId)],
    (s, { fromId, toId, kind }) => addLink(s, fromId, { toId, kind }),
  )
}

export function useDeleteLink() {
  const settings = useServer()
  return useApiMutation<{ id: string; fromId: string; toId: string }, void>(
    (_void, input) => [taskDetailKey(settings, input.fromId), taskDetailKey(settings, input.toId)],
    (s, { id }) => deleteLink(s, id),
  )
}

// ---- boards, columns, sprints, views ----

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
  return useApiMutation<BoardInput & { name: string; statuses?: string[] }, Board>(
    [],
    (settings, input) => createBoard(settings, input),
    invalidate,
  )
}

export function useUpdateBoard() {
  const invalidate = useBoardKeys(false)
  return useApiMutation<{ id: string; input: BoardInput }, Board>(
    [],
    (settings, { id, input }) => updateBoard(settings, id, input),
    invalidate,
  )
}

export function useDeleteBoard() {
  const invalidate = useBoardKeys(true)
  return useApiMutation<string, void>([], (settings, id) => deleteBoard(settings, id), invalidate)
}

export function useCreateStatus() {
  const invalidate = useBoardKeys(false)
  return useApiMutation<{ boardId: string; input: StatusInput & { name: string } }, BoardStatus>(
    [],
    (settings, { boardId, input }) => createStatus(settings, boardId, input),
    invalidate,
  )
}

/** A category change re-stamps the column's tasks, so those are re-read too. */
export function useUpdateStatus() {
  const invalidate = useBoardKeys(true)
  return useApiMutation<{ id: string; input: StatusInput }, void>(
    [],
    (settings, { id, input }) => updateStatus(settings, id, input),
    invalidate,
  )
}

/** `moveTo` is where this column's tasks go; omitted, the board's first
    remaining column. Either way they move. */
export function useDeleteStatus() {
  const invalidate = useBoardKeys(true)
  return useApiMutation<{ id: string; moveTo?: string }, void>(
    [],
    (settings, { id, moveTo }) => deleteStatus(settings, id, moveTo),
    invalidate,
  )
}

export function useReorderStatuses() {
  const invalidate = useBoardKeys(false)
  return useApiMutation<{ boardId: string; ids: string[] }, void>(
    [],
    (settings, { boardId, ids }) => reorderStatuses(settings, boardId, ids),
    invalidate,
  )
}

export function useCreateSprint() {
  const invalidate = useBoardKeys(false)
  return useApiMutation<{ boardId: string; input: SprintInput & { name: string } }, Sprint>(
    [],
    (settings, { boardId, input }) => createSprint(settings, boardId, input),
    invalidate,
  )
}

export function useUpdateSprint() {
  const invalidate = useBoardKeys(false)
  return useApiMutation<{ id: string; input: SprintInput }, Sprint>(
    [],
    (settings, { id, input }) => updateSprint(settings, id, input),
    invalidate,
  )
}

export function useStartSprint() {
  const invalidate = useBoardKeys(false)
  return useApiMutation<string, Sprint>([], (settings, id) => startSprint(settings, id), invalidate)
}

/** Closing a sprint moves its open tasks — the task list is re-read. */
export function useCompleteSprint() {
  const invalidate = useBoardKeys(true)
  return useApiMutation<{ id: string; moveTo: "backlog" | "next" }, CompleteSprintResult>(
    [],
    (settings, { id, moveTo }) => completeSprint(settings, id, moveTo),
    invalidate,
  )
}

export function useDeleteSprint() {
  const invalidate = useBoardKeys(true)
  return useApiMutation<string, void>([], (settings, id) => deleteSprint(settings, id), invalidate)
}

export function useCreateView() {
  const invalidate = useBoardKeys(false)
  return useApiMutation<
    { boardId: string; input: { name: string; kind: ViewKind; config?: BoardViewConfig } },
    BoardView
  >([], (settings, { boardId, input }) => createView(settings, boardId, input), invalidate)
}

export function useUpdateView() {
  const invalidate = useBoardKeys(false)
  return useApiMutation<
    { id: string; input: { name?: string; kind?: ViewKind; config?: BoardViewConfig; order?: number } },
    BoardView
  >([], (settings, { id, input }) => updateView(settings, id, input), invalidate)
}

export function useDeleteView() {
  const invalidate = useBoardKeys(false)
  return useApiMutation<string, void>([], (settings, id) => deleteView(settings, id), invalidate)
}
