import * as React from "react"
import { createPortal } from "react-dom"
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable"

import { KanbanColumn } from "@/components/pm/views/kanban-column"
import { TaskCard } from "@/components/pm/views/task-card"
import { useActions, type Actions } from "@/lib/actions"
import { byRank } from "@/lib/pm/filtering"
import { toggleColumnCollapsed, usePmPrefs } from "@/lib/pm/prefs"
import type { Label as PmLabel, PmViewProps, Task } from "@/lib/pm/types"
import { loadSettings } from "@/lib/settings"

/* ── Kanban board ──
   The only place in the kanban trio that knows about dragging: one DndContext
   over every lane, so a card can cross columns without each lane owning a
   context of its own.

   Tasks arrive already filtered (pm-page owns the FilterSpec) — this view only
   buckets them by column and paints them in rank order. A drop calls
   `actions.moveTask`, which is optimistic and does the rank math itself
   (lib/pm/rank); nothing here waits for the round trip.

   dnd-kit house rules the plan set: PointerSensor with a distance-6
   activation constraint so a click still opens a card, KeyboardSensor for
   drag-by-keyboard, and the DragOverlay portaled to document.body so it is
   never clipped by a scrolling lane. */

export type KanbanViewProps = PmViewProps & {
  /** pm-page passes its Actions through; absent, the view makes its own (the
      hook is a memo over `api()` + dispatch, so a second one is free). */
  actions?: Actions
  onNewTask?(columnId: string): void
  /** Tasks waiting on an unfinished dependency — pm-page fetches the board's
      graph once and hands the set down; a card never asks for itself. */
  blockedTaskIds?: ReadonlySet<string>
}

export function KanbanView({
  board,
  tasks,
  onOpenTask,
  actions: actionsProp,
  onNewTask,
  blockedTaskIds,
}: KanbanViewProps) {
  const [fallbackSettings] = React.useState(
    () => loadSettings() ?? { id: "", name: "", url: "", token: "" }
  )
  const fallbackActions = useActions(fallbackSettings)
  const actions = actionsProp ?? fallbackActions

  const prefs = usePmPrefs()
  const collapsed = React.useMemo(
    () => new Set(prefs.collapsed[board.id] ?? []),
    [prefs.collapsed, board.id]
  )
  const [activeId, setActiveId] = React.useState<string | null>(null)

  const sensors = useSensors(
    // Distance 6: below that a press is a click and opens the task editor.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const columns = React.useMemo(
    () => [...board.columns].sort((a, b) => a.order - b.order),
    [board.columns]
  )

  const labels = React.useMemo(() => {
    const byId: Record<string, PmLabel> = {}
    for (const label of board.labels) byId[label.id] = label
    return byId
  }, [board.labels])

  /** One pass over the board for the card roll-ups, instead of a lookup per
      card: subtask counts keyed by parent id, epic counts keyed by epic id.
      Epics ARE tasks, so an epic card's progress is whatever points at it —
      counted here, not looked up per card. */
  const { subtaskCounts, epicCounts } = React.useMemo(() => {
    const subtaskCounts: Record<string, { done: number; total: number }> = {}
    const epicCounts: Record<string, { done: number; total: number }> = {}
    for (const task of tasks) {
      if (task.parentId) {
        const entry = (subtaskCounts[task.parentId] ??= { done: 0, total: 0 })
        entry.total += 1
        if (task.completedAt !== null) entry.done += 1
      }
      if (task.epicId) {
        const entry = (epicCounts[task.epicId] ??= { done: 0, total: 0 })
        entry.total += 1
        if (task.completedAt !== null) entry.done += 1
      }
    }
    return { subtaskCounts, epicCounts }
  }, [tasks])

  const tasksByColumn = React.useMemo(() => {
    const buckets: Record<string, Task[]> = {}
    for (const column of columns) buckets[column.id] = []
    for (const task of tasks) buckets[task.columnId]?.push(task)
    for (const id of Object.keys(buckets)) buckets[id] = byRank(buckets[id])
    return buckets
  }, [columns, tasks])

  const activeTask = activeId ? tasks.find((task) => task.id === activeId) ?? null : null

  // Stable across renders — the memo on KanbanColumn/TaskCard is only worth
  // anything if the callbacks it receives do not change every drag frame.
  const onToggleCollapsed = React.useCallback(
    (columnId: string) => toggleColumnCollapsed(board.id, columnId),
    [board.id]
  )
  const handleOpen = React.useCallback((id: string) => onOpenTask(id), [onOpenTask])

  const onDragStart = React.useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id))
  }, [])

  const onDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      setActiveId(null)
      const { active, over } = event
      if (!over) return

      const taskId = String(active.id)
      const task = tasks.find((candidate) => candidate.id === taskId)
      if (!task) return

      // `over` is either a lane (dropped on empty space) or another card.
      const overData = over.data.current as { type?: string; columnId?: string } | undefined
      const targetColumnId =
        overData?.type === "column" ? String(over.id) : overData?.columnId ?? task.columnId
      const lane = tasksByColumn[targetColumnId]
      if (!lane) return

      // Same arithmetic arrayMove does: the index is read on the lane as it
      // stands, and the server (and lib/pm/rank) splice the task out first.
      const overIndex = lane.findIndex((candidate) => candidate.id === String(over.id))
      const index = overIndex === -1 ? lane.length : overIndex

      // A same-column drop is measured against the lane minus the dragged card
      // (what the server and lib/pm/rank both rank against), so a drop past the
      // end while already last is a no-op, not a rank rewrite + activity row.
      const currentIndex = lane.findIndex((candidate) => candidate.id === taskId)
      if (targetColumnId === task.columnId && Math.min(index, lane.length - 1) === currentIndex)
        return

      // moveTask paints the card, reconciles with the server row and rolls
      // back with its own toast — nothing to catch here.
      void actions.moveTask(board.id, taskId, { columnId: targetColumnId, index }).catch(() => {})
    },
    [actions, board.id, tasks, tasksByColumn]
  )

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      // Empty lanes have no items to measure; measure droppables always so a
      // first drop into one still registers.
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className="flex h-full min-h-0 items-stretch gap-3 overflow-x-auto p-3">
        {columns.map((column) => (
          <KanbanColumn
            key={column.id}
            column={column}
            tasks={tasksByColumn[column.id] ?? []}
            labels={labels}
            subtaskCounts={subtaskCounts}
            epicCounts={epicCounts}
            blockedTaskIds={blockedTaskIds}
            collapsed={collapsed.has(column.id)}
            onToggleCollapsed={onToggleCollapsed}
            onOpenTask={handleOpen}
            onNewTask={onNewTask}
          />
        ))}
        {columns.length === 0 && (
          <p className="m-auto text-sm text-muted-foreground">
            This board has no columns yet.
          </p>
        )}
      </div>

      {/* Outside every scroll container, or a lifted card gets clipped. */}
      {createPortal(
        <DragOverlay dropAnimation={null}>
          {activeTask && (
            <TaskCard
              task={activeTask}
              labels={labels}
              subtasks={subtaskCounts[activeTask.id]}
              epic={epicCounts[activeTask.id]}
              blocked={blockedTaskIds?.has(activeTask.id)}
              onOpen={handleOpen}
              overlay
              className="w-72"
            />
          )}
        </DragOverlay>,
        document.body
      )}
    </DndContext>
  )
}

export default KanbanView
