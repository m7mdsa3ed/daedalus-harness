import * as React from "react"
import {
  DndContext,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core"
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { List, Plus, SquareKanban } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  STATUS_LABEL,
  STATUS_ORDER,
  type Task,
  type TaskStatus,
} from "@/lib/tasks-board"
import { TaskCard, TaskRow } from "./task-card"

const VIEW_STORAGE_KEY = "ui.boardView"

function statusOf(tasks: Task[], id: unknown): TaskStatus | undefined {
  return tasks.find((t) => t.id === id)?.status
}

/** Ordered task ids per status. */
function groupByStatus(tasks: Task[]): Record<TaskStatus, Task[]> {
  const grouped: Record<TaskStatus, Task[]> = {
    todo: [],
    in_progress: [],
    blocked: [],
    done: [],
  }
  for (const task of tasks) grouped[task.status].push(task)
  for (const key of Object.keys(grouped) as TaskStatus[]) {
    grouped[key].sort((a, b) => a.order - b.order)
  }
  return grouped
}

/** One kanban column (a status): the drop target for its tasks. */
function Column({
  status,
  tasks,
  onNew,
  onTaskClick,
}: {
  status: TaskStatus
  tasks: Task[]
  onNew: (status: TaskStatus) => void
  onTaskClick: (task: Task) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `column:${status}` })
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex w-72 shrink-0 flex-col rounded-xl border bg-muted/30",
        isOver && "border-primary/40 bg-muted/60",
      )}
    >
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {STATUS_LABEL[status]}
          <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
            {tasks.length}
          </span>
        </span>
        <button
          type="button"
          onClick={() => onNew(status)}
          aria-label={`Add task to ${STATUS_LABEL[status]}`}
          title={`Add task to ${STATUS_LABEL[status]}`}
          className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="size-4" />
        </button>
      </div>
      <div className="flex min-h-[2rem] flex-1 flex-col gap-2 p-2">
        <SortableContext
          items={tasks.map((t) => t.id)}
          strategy={verticalListSortingStrategy}
        >
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} onClick={() => onTaskClick(task)} />
          ))}
        </SortableContext>
        {tasks.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-3 py-8 text-center text-xs text-muted-foreground">
            <SquareKanban className="size-5 opacity-50" />
            <p>Drop tasks here</p>
          </div>
        )}
      </div>
    </div>
  )
}

export function Board({
  tasks,
  onMove,
  onNew,
  onTaskClick,
}: {
  tasks: Task[]
  /** `{status: orderedTaskIds}` for the columns the drag touched. */
  onMove: (byStatus: Partial<Record<TaskStatus, string[]>>) => void
  onNew: (status: TaskStatus) => void
  onTaskClick: (task: Task) => void
}) {
  const [view, setView] = React.useState<"board" | "list">(() =>
    localStorage.getItem(VIEW_STORAGE_KEY) === "list" ? "list" : "board",
  )
  React.useEffect(() => {
    localStorage.setItem(VIEW_STORAGE_KEY, view)
  }, [view])

  const [draft, setDraft] = React.useState<Record<TaskStatus, Task[]>>(() => groupByStatus(tasks))
  React.useEffect(() => {
    setDraft(groupByStatus(tasks))
  }, [tasks])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const reset = () => setDraft(groupByStatus(tasks))

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event
    if (!over) return
    const fromStatus = statusOf(tasks, active.id)
    const overId = String(over.id)
    const targetStatus = overId.startsWith("column:")
      ? (overId.slice("column:".length) as TaskStatus)
      : statusOf(tasks, overId)
    if (!fromStatus || !targetStatus || fromStatus === targetStatus) return
    setDraft((prev) => {
      const next: Record<TaskStatus, Task[]> = {
        todo: [...prev.todo],
        in_progress: [...prev.in_progress],
        blocked: [...prev.blocked],
        done: [...prev.done],
      }
      const moving = prev[fromStatus].find((t) => t.id === active.id)
      if (!moving) return prev
      next[fromStatus] = prev[fromStatus].filter((t) => t.id !== active.id)
      next[targetStatus] = [...next[targetStatus], moving]
      return next
    })
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    setDraft(groupByStatus(tasks))
    if (!over || !active.id) return
    const movedId = String(active.id)
    const overId = String(over.id)
    const fromStatus = statusOf(tasks, active.id)
    const targetStatus = overId.startsWith("column:")
      ? (overId.slice("column:".length) as TaskStatus)
      : statusOf(tasks, overId)
    if (!fromStatus || !targetStatus) return

    if (fromStatus === targetStatus) {
      // Reorder within one column: dnd-kit's canonical array-move of the
      // current column order using the two items' indices.
      const ids = draft[fromStatus].map((t) => t.id)
      const fromIndex = ids.indexOf(movedId)
      const toIndex = ids.indexOf(overId)
      if (fromIndex === -1 || toIndex === -1) return
      onMove({ [fromStatus]: arrayMove(ids, fromIndex, toIndex) })
      return
    }

    // Cross-column move: place the task where the over card sits in the target
    // column (the moved task was appended to the target by onDragOver).
    const targetTasks = draft[targetStatus]
    const rest = targetTasks.filter((t) => t.id !== movedId).map((t) => t.id)
    const overIndex = rest.indexOf(overId)
    rest.splice(overIndex === -1 ? rest.length : overIndex, 0, movedId)
    onMove({ [targetStatus]: rest })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2">
        <ViewToggle view={view} onChange={setView} />
        <button
          type="button"
          onClick={() => onNew("todo")}
          className="inline-flex h-9 items-center gap-1.5 rounded-4xl bg-primary px-3 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="size-4" /> New task
        </button>
      </div>

      {view === "board" ? (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={reset}
          >
            {STATUS_ORDER.map((status) => (
              <Column
                key={status}
                status={status}
                tasks={draft[status]}
                onNew={onNew}
                onTaskClick={onTaskClick}
              />
            ))}
          </DndContext>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              selected={false}
              onClick={() => onTaskClick(task)}
            />
          ))}
          {tasks.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No tasks match the current filters.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function ViewToggle({
  view,
  onChange,
}: {
  view: "board" | "list"
  onChange: (v: "board" | "list") => void
}) {
  return (
    <div className="inline-flex items-center rounded-4xl border bg-muted/30 p-0.5 text-xs font-medium" aria-label="Board view">
      {(["board", "list"] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          aria-pressed={view === v}
          aria-label={`${v} view`}
          className={cn(
            "rounded px-2.5 py-1 capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            view === v
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {v === "board" ? <SquareKanban className="size-3.5" /> : <List className="size-3.5" />}
          <span className="capitalize">{v}</span>
        </button>
      ))}
    </div>
  )
}
