import * as React from "react"
import { createPortal } from "react-dom"
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable"
import {
  addMonths,
  addWeeks,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  isToday,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns"
import { ChevronLeftIcon, ChevronRightIcon, FlagIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useActions, type Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import type { Label as PmLabel, Milestone, PmViewProps, Task } from "@/lib/pm/types"
import { loadSettings } from "@/lib/settings"
import { cn } from "@/lib/utils"

/* ── Calendar ──
   The due-date view: one cell per day, every task painted on the day its
   `dueDate` falls on. A task with a start date is NOT spanned here — a bar
   across days is the timeline's job; this view answers "what is due when".
   Tasks with no due date are simply absent: an "unscheduled" lane would be a
   second backlog, and the board already has one.

   Tasks arrive already filtered (pm-page owns the FilterSpec) — this view only
   buckets them by local day.

   Dragging a chip onto another cell reschedules it: `actions.patchTask({
   dueDate })`, painted before the round trip through a local override map
   (patchTask itself is not optimistic, unlike moveTask) and rolled back with a
   toast if the server refuses. The time of day is carried over — a drop moves
   the day, never the hour.

   Same dnd-kit house rules as the kanban: PointerSensor with a distance-6
   activation constraint so a click still opens a task, KeyboardSensor for
   drag-by-keyboard, DragOverlay portaled to document.body, and no
   `transition-transform` class anywhere near a draggable node. */

/** Chips a cell shows before it folds the rest into a "+k more" popover. */
const CHIPS_PER_CELL = 3

type CalendarScale = "month" | "week"

const dayKey = (ts: number) => format(ts, "yyyy-MM-dd")
const dayDropId = (key: string) => `day:${key}`

/** Priority 0–4 → the tone the chip's rail is painted in. 0 is not a tone:
    "no priority" is the plain card, exactly as the kanban card treats it. */
const PRIORITY_TONE: Array<string | null> = [
  null,
  "var(--muted-foreground)",
  "var(--chart-2)",
  "var(--chart-4)",
  "var(--destructive)",
]

export type CalendarViewProps = PmViewProps & {
  /** pm-page passes its Actions through; absent, the view makes its own (the
      hook is a memo over `api()` + dispatch, so a second one is free). */
  actions?: Actions
}

export function CalendarView({
  board,
  tasks,
  onOpenTask,
  actions: actionsProp,
}: CalendarViewProps) {
  const [fallbackSettings] = React.useState(
    () => loadSettings() ?? { id: "", name: "", url: "", token: "" }
  )
  const fallbackActions = useActions(fallbackSettings)
  const actions = actionsProp ?? fallbackActions

  const [scale, setScale] = React.useState<CalendarScale>("month")
  /** The day the visible window is anchored on — "today" resets it. */
  const [anchor, setAnchor] = React.useState(() => startOfDay(Date.now()).getTime())
  const [activeId, setActiveId] = React.useState<string | null>(null)
  /** taskId → optimistic dueDate, held only until the PATCH settles. */
  const [pending, setPending] = React.useState<Record<string, number>>({})

  // A different board is a different calendar; a narrowed filter is not.
  React.useEffect(() => {
    setAnchor(startOfDay(Date.now()).getTime())
    setPending({})
  }, [board.id])

  const sensors = useSensors(
    // Distance 6: below that a press is a click and opens the task editor.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const labels = React.useMemo(() => {
    const byId: Record<string, PmLabel> = {}
    for (const label of board.labels) byId[label.id] = label
    return byId
  }, [board.labels])

  /** The rendered window: whole weeks covering the anchor's month, or the
      anchor's single week. Both are a flat day list — the grid does the rest. */
  const days = React.useMemo(() => {
    const at = new Date(anchor)
    const [from, to] =
      scale === "month"
        ? [startOfWeek(startOfMonth(at)), endOfWeek(endOfMonth(at))]
        : [startOfWeek(at), endOfWeek(at)]
    return eachDayOfInterval({ start: from, end: to }).map((day) => day.getTime())
  }, [anchor, scale])

  /** The due date a task is currently painted on — the optimistic value while a
      reschedule is in flight, the stored one otherwise. */
  const dueOf = React.useCallback(
    (task: Task) => pending[task.id] ?? task.dueDate,
    [pending]
  )

  const byDay = React.useMemo(() => {
    const buckets: Record<string, Task[]> = {}
    for (const task of tasks) {
      const due = pending[task.id] ?? task.dueDate
      if (due === null) continue
      ;(buckets[dayKey(due)] ??= []).push(task)
    }
    // Within a day: urgent first, then by time of day, then by key — stable
    // enough that a repaint never reshuffles a cell under the pointer.
    for (const key of Object.keys(buckets)) {
      buckets[key].sort(
        (a, b) =>
          b.priority - a.priority ||
          (pending[a.id] ?? a.dueDate ?? 0) - (pending[b.id] ?? b.dueDate ?? 0) ||
          a.key.localeCompare(b.key)
      )
    }
    return buckets
  }, [pending, tasks])

  /** Milestones are markers, not editable here — the milestone editor owns
      them. A dated milestone renders as a pill on its day. */
  const milestonesByDay = React.useMemo(() => {
    const buckets: Record<string, Milestone[]> = {}
    for (const milestone of board.milestones) {
      if (milestone.date === null) continue
      ;(buckets[dayKey(milestone.date)] ??= []).push(milestone)
    }
    return buckets
  }, [board.milestones])

  const visibleCount = React.useMemo(() => {
    let count = 0
    for (const ts of days) count += byDay[dayKey(ts)]?.length ?? 0
    return count
  }, [byDay, days])

  const activeTask = activeId ? tasks.find((task) => task.id === activeId) ?? null : null

  const handleOpen = React.useCallback((id: string) => onOpenTask(id), [onOpenTask])

  const onDragStart = React.useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id))
  }, [])

  const onDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      setActiveId(null)
      const { active, over } = event
      if (!over) return

      const overData = over.data.current as { type?: string; ts?: number } | undefined
      if (overData?.type !== "day" || typeof overData.ts !== "number") return

      const taskId = String(active.id)
      const task = tasks.find((candidate) => candidate.id === taskId)
      if (!task) return

      const current = pending[taskId] ?? task.dueDate
      if (current === null) return
      if (dayKey(current) === dayKey(overData.ts)) return

      // The day moves, the hour does not: a task due at 17:00 stays due at
      // 17:00 on whatever day it lands on.
      const timeOfDay = current - startOfDay(current).getTime()
      const dueDate = startOfDay(overData.ts).getTime() + timeOfDay

      // patchTask is not optimistic (only moveTask is), so the chip is painted
      // here and the override dropped once the server answers either way.
      setPending((prev) => ({ ...prev, [taskId]: dueDate }))
      void (async () => {
        try {
          await actions.patchTask(board.id, taskId, { dueDate })
        } catch (err) {
          reportError(err, "Couldn't reschedule the task")
        } finally {
          setPending((prev) => {
            if (!(taskId in prev)) return prev
            const next = { ...prev }
            delete next[taskId]
            return next
          })
        }
      })()
    },
    [actions, board.id, pending, tasks]
  )

  const title =
    scale === "month"
      ? format(anchor, "MMMM yyyy")
      : `${format(days[0] ?? anchor, "MMM d")} – ${format(
          days[days.length - 1] ?? anchor,
          "MMM d, yyyy"
        )}`

  const step = React.useCallback(
    (direction: -1 | 1) =>
      setAnchor((at) =>
        (scale === "month" ? addMonths(at, direction) : addWeeks(at, direction)).getTime()
      ),
    [scale]
  )

  const weekdayLabels = React.useMemo(
    () =>
      eachDayOfInterval({
        start: startOfWeek(new Date()),
        end: endOfWeek(new Date()),
      }).map((day) => format(day, "EEE")),
    []
  )

  return (
    <DndContext
      sensors={sensors}
      // Cells tile the grid edge to edge, so the pointer is the only honest
      // arbiter of which day a chip was dropped on.
      collisionDetection={pointerWithin}
      // A cell with no chips has nothing to measure; measure droppables always
      // so a first drop into an empty day still registers.
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <span className="text-sm font-medium text-foreground">{title}</span>

          <div className="flex items-center gap-1">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={scale === "month" ? "Previous month" : "Previous week"}
              onClick={() => step(-1)}
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={scale === "month" ? "Next month" : "Next week"}
              onClick={() => step(1)}
            >
              <ChevronRightIcon />
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAnchor(startOfDay(Date.now()).getTime())}
            >
              Today
            </Button>
          </div>

          <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground tabular-nums">
            {visibleCount} {visibleCount === 1 ? "task due" : "tasks due"}
          </span>

          <div className="flex items-center gap-0.5 rounded-lg border p-0.5">
            {(["month", "week"] as const).map((option) => (
              <Button
                key={option}
                size="sm"
                variant={scale === option ? "secondary" : "ghost"}
                aria-pressed={scale === option}
                onClick={() => setScale(option)}
                className="capitalize"
              >
                {option}
              </Button>
            ))}
          </div>
        </header>

        <div className="grid shrink-0 grid-cols-7 border-b bg-muted/30">
          {weekdayLabels.map((day) => (
            <span
              key={day}
              className="px-2 py-1 text-center text-[11px] font-medium text-muted-foreground"
            >
              {day}
            </span>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div
            className={cn(
              "grid h-full grid-cols-7",
              scale === "week" ? "grid-rows-1" : "auto-rows-fr"
            )}
          >
            {days.map((ts) => (
              <DayCell
                key={ts}
                ts={ts}
                tasks={byDay[dayKey(ts)] ?? []}
                milestones={milestonesByDay[dayKey(ts)] ?? []}
                labels={labels}
                dimmed={scale === "month" && !isSameMonth(ts, anchor)}
                dueOf={dueOf}
                onOpenTask={handleOpen}
              />
            ))}
          </div>
        </div>

        {visibleCount === 0 && (
          <p className="shrink-0 border-t px-3 py-2 text-center text-xs text-muted-foreground">
            Nothing due {scale === "month" ? "this month" : "this week"} — tasks appear here
            once they have a due date.
          </p>
        )}
      </div>

      {/* Outside every scroll container, or a lifted chip gets clipped. */}
      {createPortal(
        <DragOverlay dropAnimation={null}>
          {activeTask && (
            <TaskChip
              task={activeTask}
              labels={labels}
              due={dueOf(activeTask)}
              onOpen={handleOpen}
              overlay
              className="w-48"
            />
          )}
        </DragOverlay>,
        document.body
      )}
    </DndContext>
  )
}

// ---------------------------------------------------------------------------
// Cells

interface DayCellProps {
  ts: number
  tasks: Task[]
  milestones: Milestone[]
  labels: Record<string, PmLabel>
  /** A trailing/leading day of a neighbouring month in the month grid. */
  dimmed: boolean
  dueOf(task: Task): number | null
  onOpenTask(id: string): void
}

function DayCellImpl({ ts, tasks, milestones, labels, dimmed, dueOf, onOpenTask }: DayCellProps) {
  const key = dayKey(ts)
  const { setNodeRef, isOver } = useDroppable({
    id: dayDropId(key),
    data: { type: "day", ts },
  })
  const today = isToday(ts)
  const overflow = tasks.slice(CHIPS_PER_CELL)

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex min-h-24 flex-col gap-1 border-r border-b p-1 last:border-r-0",
        dimmed && "bg-muted/20",
        isOver && "bg-muted/60 ring-1 ring-ring/40 ring-inset"
      )}
    >
      <div className="flex items-center gap-1">
        <span
          className={cn(
            "flex size-5 items-center justify-center rounded-full text-[11px] tabular-nums",
            today
              ? "bg-primary text-primary-foreground font-medium"
              : dimmed
                ? "text-muted-foreground/60"
                : "text-muted-foreground"
          )}
        >
          {format(ts, "d")}
        </span>
        {tasks.length > 0 && (
          <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
            {tasks.length}
          </span>
        )}
      </div>

      {milestones.map((milestone) => (
        <span
          key={milestone.id}
          title={
            milestone.reachedAt !== null
              ? `Milestone reached: ${milestone.name}`
              : `Milestone: ${milestone.name}`
          }
          className={cn(
            "inline-flex items-center gap-1 truncate rounded-4xl border px-1.5 py-px text-[10px] leading-4",
            milestone.reachedAt !== null
              ? "border-transparent bg-muted text-muted-foreground line-through"
              : "border-ring/40 bg-primary/10 text-foreground"
          )}
        >
          <FlagIcon className="size-2.5 shrink-0" />
          <span className="truncate">{milestone.name}</span>
        </span>
      ))}

      {tasks.slice(0, CHIPS_PER_CELL).map((task) => (
        <DraggableTaskChip
          key={task.id}
          task={task}
          labels={labels}
          due={dueOf(task)}
          onOpen={onOpenTask}
        />
      ))}

      {overflow.length > 0 && (
        <Popover>
          <PopoverTrigger
            render={
              <button
                type="button"
                className="rounded-md px-1 py-px text-left text-[10px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                +{overflow.length} more
              </button>
            }
          />
          {/* The folded chips are click-to-open only — a drag out of a popover
              would close it mid-lift; reschedule from the cell instead. */}
          <PopoverContent align="start" className="w-64 gap-2">
            <span className="text-xs font-medium text-foreground">{format(ts, "EEEE, MMM d")}</span>
            <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
              {overflow.map((task) => (
                <TaskChip
                  key={task.id}
                  task={task}
                  labels={labels}
                  due={dueOf(task)}
                  onOpen={onOpenTask}
                />
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}

/** Memoized: a filter keystroke or a board refresh re-renders the grid, and
    only the cells whose task list actually changed should repaint with it. */
const DayCell = React.memo(DayCellImpl)

// ---------------------------------------------------------------------------
// Chips

export interface TaskChipProps {
  task: Task
  /** The board's labels keyed by id — built once per render by the view. */
  labels: Record<string, PmLabel>
  /** The painted due date (optimistic while a reschedule is in flight). */
  due: number | null
  onOpen(id: string): void
  /** Painted while the real chip is lifted, and by the DragOverlay clone. */
  dragging?: boolean
  overlay?: boolean
  className?: string
}

/** React 19 takes `ref` as a plain prop — no forwardRef for the draggable node. */
type TaskChipDivProps = TaskChipProps &
  Omit<React.HTMLAttributes<HTMLDivElement>, "onClick" | "children"> & {
    ref?: React.Ref<HTMLDivElement>
  }

function TaskChipImpl({
  task,
  labels,
  due,
  onOpen,
  dragging,
  overlay,
  className,
  ...rest
}: TaskChipDivProps) {
  const tone = PRIORITY_TONE[task.priority] ?? null
  const label = task.labelIds.map((id) => labels[id]).find((entry): entry is PmLabel => !!entry)
  const overdue = due !== null && task.completedAt === null && due < Date.now()

  return (
    <div
      role="button"
      tabIndex={0}
      title={`${task.key} · ${task.title}`}
      /* dnd-kit's own keyboard listener (drag) arrives in `rest` and wins —
         Enter lifts the chip there; a chip with no listeners opens instead. */
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onOpen(task.id)
        }
      }}
      {...rest}
      /* After the spread on purpose: the PointerSensor's distance-6 constraint
         means a click is never a drag, so click always opens the task. */
      onClick={() => onOpen(task.id)}
      className={cn(
        // touch-action lives on the drag surface only — the chip IS the handle.
        "flex touch-none items-center gap-1 rounded-md border border-transparent bg-card/70 px-1 py-0.5 text-left text-[11px] outline-none",
        "hover:border-ring/40 hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50",
        dragging && "opacity-40",
        overlay && "border-border bg-card shadow-lg",
        className
      )}
    >
      {/* Priority as a rail, label as a dot — a chip is two lines of pixels
          wide, so tone carries what a badge would not fit. */}
      <span
        className={cn("h-3.5 w-0.5 shrink-0 rounded-full", !tone && "bg-border")}
        style={tone ? { backgroundColor: tone } : undefined}
      />
      {label && (
        <span
          className="size-1.5 shrink-0 rounded-full"
          title={label.name}
          style={{ backgroundColor: label.color ?? "var(--muted-foreground)" }}
        />
      )}
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          task.completedAt !== null
            ? "text-muted-foreground line-through"
            : overdue
              ? "text-destructive"
              : "text-foreground"
        )}
      >
        {task.title}
      </span>
    </div>
  )
}

/** Memoized: a month holds hundreds of these and a drag repaints the grid. */
export const TaskChip = React.memo(TaskChipImpl)

/** The draggable wrapper. No `transition-transform` class anywhere near it:
    dnd-kit sets `transform` imperatively and a CSS transition fights it. */
function DraggableTaskChipImpl(chip: TaskChipProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: chip.task.id,
    data: { type: "task" },
  })

  return (
    <TaskChip
      {...chip}
      dragging={isDragging}
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      /* The lifted chip is the DragOverlay's clone — the source stays put, so
         no transform is applied here at all. */
    />
  )
}

const DraggableTaskChip = React.memo(DraggableTaskChipImpl)

export default CalendarView
