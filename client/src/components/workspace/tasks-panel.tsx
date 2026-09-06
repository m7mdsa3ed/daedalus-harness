/* ── The board, in the dock ──
   The same workspace `/board` renders, hosted by a panel instead of a route.

   What makes that possible is that the board no longer reads the URL
   (`lib/tasks-location.ts`): a panel that navigated would take the page — and
   with it the dock and every other panel — off the thread it is docked beside.
   So the location lives in the panel's own descriptor, which is also what makes
   it survive a reload: params are how the dock stores a panel (see
   `lib/workspace/panels.ts`).

   Deliberately not a per-board panel. Opening a second board is moving this
   one, the way opening a second file moves the IDE — hence `panelId` returning
   the bare `"tasks"` and the board travelling in the params. */
import * as React from "react"
import type { IDockviewPanelProps } from "dockview-react"

import { ErrorBoundary } from "@/components/error-boundary"
import { BoardWorkspace } from "@/components/tasks"
import { useBoards } from "@/lib/queries/boards"
import type { BoardLocation } from "@/lib/tasks-location"

export function TasksPanel({
  api,
  params,
}: IDockviewPanelProps<{ boardId?: string; taskId?: string }>) {
  const { boards } = useBoards()
  const board = boards.find((entry) => entry.id === params.boardId)

  React.useEffect(() => {
    api.setTitle(board ? `${board.name} — Tasks` : "Tasks")
  }, [api, board])

  /* The descriptor IS the state. `updateParameters` is a write to the panel the
     dock then serializes, so moving to another board is one store — no local
     copy that could disagree with what a reload restores.

     Deliberately not memoised on `params`: Dockview hands a fresh params object
     down on every update, so a memo keyed on it would rebuild anyway, and the
     workspace reads the fields rather than the identity. The callbacks are
     memoised, because the workspace has them in effect dependencies. */
  const openBoard = React.useCallback(
    (boardId?: string, taskId?: string) => {
      api.updateParameters({ boardId, taskId })
    },
    [api]
  )
  const openTask = React.useCallback(
    (taskId: string | null) => {
      api.updateParameters({ boardId: params.boardId, taskId: taskId ?? undefined })
    },
    [api, params.boardId]
  )

  const location: BoardLocation = {
    boardId: params.boardId ?? "",
    taskId: params.taskId ?? null,
    openBoard,
    openTask,
  }

  return (
    <div className="flex h-full min-h-0 flex-col pt-[var(--dock-content-overlap,0px)]">
      <ErrorBoundary name="the board">
        <BoardWorkspace location={location} />
      </ErrorBoundary>
    </div>
  )
}
