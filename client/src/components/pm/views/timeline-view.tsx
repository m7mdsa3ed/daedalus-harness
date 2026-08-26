import * as React from "react"
import {
  addDays,
  differenceInCalendarDays,
  eachDayOfInterval,
  eachMonthOfInterval,
  eachWeekOfInterval,
  eachYearOfInterval,
  format,
  startOfDay,
} from "date-fns"

import { Button } from "@/components/ui/button"
import { ColumnDot } from "@/components/pm/views/list-view"
import { useActions, type Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import { useBlockedTaskIds, useDependencyGraph } from "@/lib/pm/dependencies"
import type {
  Column,
  PmViewProps,
  Task,
  TaskPatch,
} from "@/lib/pm/types"
import { loadSettings } from "@/lib/settings"
import { cn } from "@/lib/utils"

/* ── Timeline / Gantt ──
   One row per task, a bar per scheduled task, and an SVG overlay drawing the
   dependency graph on top of them.

   The whole view is ONE date→x function (`xOf` below) shared by the bars, the
   date header, the today marker and the arrow overlay, so zooming or scrolling
   can never desynchronise them: the canvas is a plain block `origin` days wide
   at `pxPerDay`, everything inside is positioned by
   `differenceInCalendarDays(date, origin) * pxPerDay`, and scrolling is the
   browser's — no transform, nothing to recompute.

   Dragging is NATIVE Pointer Events with setPointerCapture (the sidebar
   resizer's idiom in app-shell.tsx), not dnd-kit: dnd-kit models "pick a thing
   up and drop it on another thing", and two thirds of the gestures here are
   edge resizes of the same element, which it has no shape for. A drag paints
   from local state only; pointerup fires exactly one `patchTask`, painted
   optimistically and rolled back if the server refuses. Escape cancels an
   in-flight drag with nothing sent. */

/** Zoom levels, in pixels per day. A day cell has to fit "31", a week cell
    "Mar 30", a month cell "Mar" — those widths are what set these numbers. */
const ZOOMS = [
  { id: "day", label: "Day", pxPerDay: 34 },
  { id: "week", label: "Week", pxPerDay: 13 },
  { id: "month", label: "Month", pxPerDay: 4.2 },
] as const

type ZoomId = (typeof ZOOMS)[number]["id"]

const ROW_H = 32
const HEADER_H = 44
const LEFT_W = 240
/** Days of air either side of the scheduled range, so a bar at the extreme
    edge still has somewhere to be dragged. */
const PAD_DAYS = 7
/** Past this many rows the view stops and offers "Show more" — the plain
    slice list-view and backlog-view use, no virtualization lib in v1. */
const WINDOW = 500
/** Grab zone on each end of a bar; below this a press is a move, not a resize. */
const EDGE = 8
const ARROW_MARKER = "pm-timeline-arrow"

type DragMode = "move" | "resize-start" | "resize-end"

interface Drag {
  taskId: string
  mode: DragMode
  /** Client x at pointerdown — the delta is measured against this, not against
      the previous move, so a drag never accumulates rounding error. */
  originX: number
  /** Whole days, snapped. */
  days: number
}

/** The dates a bar is actually drawn from. A task with only a due date is a
    single-day bar on that day; one with only a start date is a single-day bar
    on that day too — which is what makes both draggable and resizable into a
    real range. */
interface Span {
  start: number
  end: number
}

function spanOf(task: Task): Span | null {
  if (task.startDate !== null && task.dueDate !== null) {
    return { start: Math.min(task.startDate, task.dueDate), end: Math.max(task.startDate, task.dueDate) }
  }
  if (task.dueDate !== null) return { start: task.dueDate, end: task.dueDate }
  if (task.startDate !== null) return { start: task.startDate, end: task.startDate }
  return null
}

/** Apply a live drag to a span. Pure — the same function paints the preview and
    computes what gets committed, so what you see is what is sent. */
function previewSpan(span: Span, drag: Drag): Span {
  const shift = (ms: number, days: number) => addDays(new Date(ms), days).getTime()
  if (drag.mode === "move") {
    return { start: shift(span.start, drag.days), end: shift(span.end, drag.days) }
  }
  if (drag.mode === "resize-start") {
    return { start: Math.min(shift(span.start, drag.days), span.end), end: span.end }
  }
  return { start: span.start, end: Math.max(shift(span.end, drag.days), span.start) }
}

/** The patch a finished drag produces, or null when nothing moved. A task that
    had no start date gains one only by being resized from the left; a move
    never invents a date the task did not have. */
function patchFor(task: Task, drag: Drag): TaskPatch | null {
  const span = spanOf(task)
  if (!span || drag.days === 0) return null
  const next = previewSpan(span, drag)

  const hadStart = task.startDate !== null
  const hadDue = task.dueDate !== null

  let startDate = task.startDate
  let dueDate = task.dueDate

  if (drag.mode === "resize-start") {
    startDate = next.start
    // Resizing the left edge of a due-only bar is how a task gets a start date.
    if (!hadDue) dueDate = next.end
  } else if (drag.mode === "resize-end") {
    dueDate = next.end
    if (!hadStart && hadDue) startDate = null
    if (!hadDue && hadStart) startDate = next.start
  } else {
    if (hadStart) startDate = next.start
    if (hadDue) dueDate = next.end
    // A start-only task moved keeps being start-only; a due-only one likewise.
  }

  const patch: TaskPatch = {}
  if (startDate !== task.startDate) patch.startDate = startDate
  if (dueDate !== task.dueDate) patch.dueDate = dueDate
  return Object.keys(patch).length > 0 ? patch : null
}

export type TimelineViewProps = PmViewProps & {
  /** pm-page passes its Actions through; absent, the view makes its own (the
      hook is a memo over `api()` + dispatch, so a second one is free). */
  actions?: Actions
}

export function TimelineView({ board, tasks, onOpenTask, actions: actionsProp }: TimelineViewProps) {
  const [fallbackSettings] = React.useState(
    () => loadSettings() ?? { id: "", name: "", url: "", token: "" }
  )
  const fallbackActions = useActions(fallbackSettings)
  const actions = actionsProp ?? fallbackActions

  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const [zoom, setZoom] = React.useState<ZoomId>("week")
  const [limit, setLimit] = React.useState(WINDOW)
  const [drag, setDrag] = React.useState<Drag | null>(null)
  /** Optimistic dates, held from pointerup until the server answers. */
  const [pending, setPending] = React.useState<Record<string, Span & { startNull: boolean }>>({})
  /* The board's graph, fetched once for the whole page (lib/pm/dependencies):
     the arrows here and the blocked badges in the other views read the same
     object, and the picker's add/remove forces it to reload. */
  const graph = useDependencyGraph(actions, board.id)

  const pxPerDay = ZOOMS.find((z) => z.id === zoom)!.pxPerDay

  // A different board is a different plan; a narrowed filter is not.
  React.useEffect(() => setLimit(WINDOW), [board.id])

  const columns = React.useMemo(() => {
    const byId: Record<string, Column> = {}
    for (const column of board.columns) byId[column.id] = column
    return byId
  }, [board.columns])

  const blocked = useBlockedTaskIds(graph)

  /* Rows: scheduled first, in date order, then the unscheduled ones. A task
     with neither date is NOT filtered out — it is on the plan and being absent
     from the timeline is exactly the thing you came here to notice — it just
     gets a greyed row and no bar until it is given dates in the editor. */
  const rows = React.useMemo(() => {
    const patched = tasks.map((task) => {
      const override = pending[task.id]
      if (!override) return task
      return {
        ...task,
        startDate: override.startNull ? null : override.start,
        dueDate: override.end,
      }
    })
    const withSpan = patched.map((task) => ({ task, span: spanOf(task) }))
    withSpan.sort((a, b) => {
      if (a.span && b.span) return a.span.start - b.span.start || a.task.key.localeCompare(b.task.key)
      if (a.span) return -1
      if (b.span) return 1
      return a.task.key.localeCompare(b.task.key)
    })
    return withSpan
  }, [pending, tasks])

  const slice = React.useMemo(() => rows.slice(0, limit), [rows, limit])
  const truncated = Math.max(0, rows.length - slice.length)

  /* The canvas window: everything scheduled, padded, and always containing
     today so the "Today" button and marker have somewhere to point. */
  const { origin, dayCount } = React.useMemo(() => {
    const today = startOfDay(new Date())
    let min = today
    let max = today
    for (const { span } of rows) {
      if (!span) continue
      const s = startOfDay(new Date(span.start))
      const e = startOfDay(new Date(span.end))
      if (s < min) min = s
      if (e > max) max = e
    }
    const from = addDays(min, -PAD_DAYS)
    const to = addDays(max, PAD_DAYS)
    return { origin: from, dayCount: differenceInCalendarDays(to, from) + 1 }
  }, [rows])

  /** THE date→x contract: x is days-from-origin × pxPerDay, and its inverse
      rounds to a whole day. Bars, header ticks, the today line and every arrow
      endpoint go through these two and nothing else. */
  const xOf = React.useCallback(
    (ms: number) => differenceInCalendarDays(new Date(ms), origin) * pxPerDay,
    [origin, pxPerDay]
  )
  const widthOf = React.useCallback(
    (span: Span) =>
      (differenceInCalendarDays(new Date(span.end), new Date(span.start)) + 1) * pxPerDay,
    [pxPerDay]
  )

  const canvasW = dayCount * pxPerDay

  // Land on today rather than on whatever the oldest task is.
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollLeft = Math.max(0, xOf(Date.now()) - 160)
    // Board or zoom change re-centres; a scroll of one's own is left alone.
  }, [board.id, zoom, xOf])

  const ticks = React.useMemo(() => buildTicks(origin, dayCount, zoom), [origin, dayCount, zoom])

  // ---- drag ---------------------------------------------------------------

  const commit = React.useCallback(
    (task: Task, finished: Drag) => {
      const patch = patchFor(task, finished)
      if (!patch) return
      const span = previewSpan(spanOf(task)!, finished)
      const startNull =
        patch.startDate !== undefined ? patch.startDate === null : task.startDate === null
      setPending((prev) => ({ ...prev, [task.id]: { ...span, startNull } }))
      void (async () => {
        try {
          await actions.patchTask(board.id, task.id, patch)
        } catch (err) {
          reportError(err, "Couldn't reschedule the task")
        } finally {
          // Either the store now holds the server's answer or the drag is
          // rolled back — in both cases the override has done its job.
          setPending((prev) => {
            if (!(task.id in prev)) return prev
            const next = { ...prev }
            delete next[task.id]
            return next
          })
        }
      })()
    },
    [actions, board.id]
  )

  const onBarPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>, taskId: string, mode: DragMode) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.setPointerCapture(event.pointerId)
      setDrag({ taskId, mode, originX: event.clientX, days: 0 })
    },
    []
  )

  const onBarPointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const x = event.clientX
    setDrag((current) => {
      if (!current) return current
      const days = Math.round((x - current.originX) / pxPerDay)
      return days === current.days ? current : { ...current, days }
    })
  }, [pxPerDay])

  const onBarPointerUp = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      const finished = drag
      setDrag(null)
      if (!finished) return
      const row = rows.find((entry) => entry.task.id === finished.taskId)
      if (row && row.span) commit(row.task, finished)
    },
    [commit, drag, rows]
  )

  // Escape drops an in-flight drag: pointerup then finds no drag and sends
  // nothing, which is the whole cancel.
  React.useEffect(() => {
    if (!drag) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        setDrag(null)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [drag])

  const openTask = React.useCallback((id: string) => onOpenTask(id), [onOpenTask])

  // ---- geometry for the arrow overlay -------------------------------------

  /* Only rows inside the window have bars, so only edges with BOTH endpoints
     here can be drawn — an arrow to a row that is not mounted has no y. */
  const geometry = React.useMemo(() => {
    const map = new Map<string, { x: number; w: number; y: number }>()
    slice.forEach(({ task, span }, index) => {
      if (!span) return
      const shown = drag && drag.taskId === task.id ? previewSpan(span, drag) : span
      map.set(task.id, {
        x: xOf(shown.start),
        w: Math.max(pxPerDay, widthOf(shown)),
        y: index * ROW_H + ROW_H / 2,
      })
    })
    return map
  }, [drag, pxPerDay, slice, widthOf, xOf])

  const arrows = React.useMemo(() => {
    const out: Array<{ id: string; d: string }> = []
    for (const dep of graph.dependencies) {
      const from = geometry.get(dep.dependsOnId)
      const to = geometry.get(dep.taskId)
      if (!from || !to) continue
      const x1 = from.x + from.w
      const y1 = from.y
      const x2 = to.x
      const y2 = to.y
      const d =
        x2 >= x1 + 24
          ? `M${x1},${y1} H${(x1 + x2) / 2} V${y2} H${x2}`
          : `M${x1},${y1} H${x1 + 12} V${(y1 + y2) / 2} H${x2 - 12} V${y2} H${x2}`
      out.push({ id: `${dep.dependsOnId}->${dep.taskId}`, d })
    }
    return out
  }, [geometry, graph.dependencies])

  const todayX = xOf(Date.now())

  if (tasks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        No tasks match this view.
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2">
        <span className="text-xs text-muted-foreground">
          {rows.filter((row) => row.span !== null).length} scheduled
          {rows.some((row) => row.span === null) &&
            ` · ${rows.filter((row) => row.span === null).length} unscheduled`}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const el = scrollRef.current
              if (el) el.scrollLeft = Math.max(0, todayX - 160)
            }}
          >
            Today
          </Button>
          {ZOOMS.map((level) => (
            <Button
              key={level.id}
              size="sm"
              variant={zoom === level.id ? "secondary" : "ghost"}
              aria-pressed={zoom === level.id}
              onClick={() => setZoom(level.id)}
            >
              {level.label}
            </Button>
          ))}
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div
          className="relative grid"
          style={{ gridTemplateColumns: `${LEFT_W}px ${canvasW}px`, width: LEFT_W + canvasW }}
        >
          {/* Header: sticky vertically; its left cell is sticky horizontally too,
              so the task column keeps its corner. */}
          <div
            className="sticky top-0 left-0 z-30 border-r border-b bg-card px-3 text-xs font-medium text-muted-foreground"
            style={{ height: HEADER_H, lineHeight: `${HEADER_H}px` }}
          >
            Task
          </div>
          <div
            className="sticky top-0 z-20 border-b bg-card"
            style={{ height: HEADER_H, width: canvasW }}
          >
            <div className="relative h-full">
              {ticks.upper.map((tick) => (
                <div
                  key={`u${tick.at}`}
                  className="absolute top-0 border-l pl-1 text-[11px] leading-5 text-muted-foreground"
                  style={{ left: xOf(tick.at), height: 20 }}
                >
                  {tick.label}
                </div>
              ))}
              {ticks.lower.map((tick) => (
                <div
                  key={`l${tick.at}`}
                  className={cn(
                    "absolute border-l pl-1 text-[10px] leading-6 text-muted-foreground tabular-nums",
                    tick.muted && "bg-muted/40"
                  )}
                  style={{ left: xOf(tick.at), top: 20, height: HEADER_H - 20, width: tick.width }}
                >
                  {tick.label}
                </div>
              ))}
              {todayX >= 0 && todayX <= canvasW && (
                <div
                  aria-hidden
                  className="absolute top-0 bottom-0 w-px bg-primary/70"
                  style={{ left: todayX }}
                />
              )}
            </div>
          </div>

          {/* Rows */}
          {slice.map(({ task, span }) => {
            const shown = span && drag && drag.taskId === task.id ? previewSpan(span, drag) : span
            return (
              <TimelineRow
                key={task.id}
                task={task}
                span={span}
                shown={shown}
                column={columns[task.columnId]}
                blocked={blocked.has(task.id)}
                dragging={drag?.taskId === task.id}
                canvasW={canvasW}
                left={shown ? xOf(shown.start) : 0}
                width={shown ? Math.max(pxPerDay, widthOf(shown)) : 0}
                onOpen={openTask}
                onBarPointerDown={onBarPointerDown}
                onBarPointerMove={onBarPointerMove}
                onBarPointerUp={onBarPointerUp}
              />
            )
          })}

          {/* Arrow overlay: same coordinate space as the bars, inside the same
              scrolled block, so scroll and zoom need no recomputation of their
              own — the x math already moved. */}
          <svg
            aria-hidden
            className="pointer-events-none absolute z-10 text-muted-foreground"
            style={{
              left: LEFT_W,
              top: HEADER_H,
              width: canvasW,
              height: slice.length * ROW_H,
            }}
          >
            <defs>
              <marker
                id={ARROW_MARKER}
                markerWidth="7"
                markerHeight="7"
                refX="6"
                refY="3"
                orient="auto"
              >
                <path d="M0,0 L6,3 L0,6 z" fill="currentColor" />
              </marker>
            </defs>
            {arrows.map((arrow) => (
              <path
                key={arrow.id}
                d={arrow.d}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeOpacity="0.6"
                markerEnd={`url(#${ARROW_MARKER})`}
              />
            ))}
          </svg>

          {truncated > 0 && (
            <div
              className="sticky left-0 col-span-2 flex items-center justify-center gap-3 py-3"
              style={{ width: LEFT_W + canvasW }}
            >
              <span className="text-xs text-muted-foreground">
                Showing {slice.length} of {rows.length}
              </span>
              <Button variant="outline" size="sm" onClick={() => setLimit((n) => n + WINDOW)}>
                Show more
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Rows

interface TimelineRowProps {
  task: Task
  /** The task's own dates; null = unscheduled (greyed row, no bar). */
  span: Span | null
  /** `span` with any live drag applied — what is drawn. */
  shown: Span | null
  column?: Column
  blocked: boolean
  dragging?: boolean
  canvasW: number
  left: number
  width: number
  onOpen(id: string): void
  onBarPointerDown(event: React.PointerEvent<HTMLDivElement>, taskId: string, mode: DragMode): void
  onBarPointerMove(event: React.PointerEvent<HTMLDivElement>): void
  onBarPointerUp(event: React.PointerEvent<HTMLDivElement>): void
}

/** Memoized: a pointermove during a drag re-renders the view every few pixels,
    and only the row being dragged (plus whatever the store changed) should
    re-render with it. Every callback above is stable by construction. */
const TimelineRow = React.memo(function TimelineRow({
  task,
  span,
  shown,
  column,
  blocked,
  dragging,
  canvasW,
  left,
  width,
  onOpen,
  onBarPointerDown,
  onBarPointerMove,
  onBarPointerUp,
}: TimelineRowProps) {
  const done = task.completedAt !== null
  return (
    <>
      <button
        type="button"
        onClick={() => onOpen(task.id)}
        title={task.title}
        className={cn(
          "sticky left-0 z-20 flex items-center gap-2 border-r border-b bg-card px-3 text-left outline-none",
          "hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50",
          span === null && "opacity-55"
        )}
        style={{ height: ROW_H, width: LEFT_W }}
      >
        <ColumnDot color={column?.color} />
        <span className="w-16 shrink-0 truncate font-mono text-[11px] text-muted-foreground">
          {task.key}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs",
            done ? "text-muted-foreground line-through" : "text-foreground"
          )}
        >
          {task.title}
        </span>
      </button>

      <div className="relative border-b" style={{ height: ROW_H, width: canvasW }}>
        {shown !== null && (
          <div
            role="button"
            tabIndex={0}
            aria-label={`${task.key} ${format(shown.start, "MMM d")} – ${format(shown.end, "MMM d")}`}
            title={`${task.title}\n${format(shown.start, "PP")} – ${format(shown.end, "PP")}${
              blocked ? "\nBlocked by an unfinished dependency" : ""
            }`}
            onPointerDown={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              const offset = event.clientX - rect.left
              const mode: DragMode =
                offset <= EDGE ? "resize-start" : offset >= rect.width - EDGE ? "resize-end" : "move"
              onBarPointerDown(event, task.id, mode)
            }}
            onPointerMove={onBarPointerMove}
            onPointerUp={onBarPointerUp}
            onPointerCancel={onBarPointerUp}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                onOpen(task.id)
              }
            }}
            onDoubleClick={() => onOpen(task.id)}
            className={cn(
              "absolute top-1 flex touch-none items-center overflow-hidden rounded-md border px-1.5 text-[10px] outline-none select-none",
              "cursor-grab active:cursor-grabbing focus-visible:ring-[3px] focus-visible:ring-ring/50",
              done ? "bg-muted text-muted-foreground" : "bg-primary/25 text-foreground",
              blocked && "border-destructive/60 bg-destructive/20 ring-1 ring-destructive/40",
              dragging && "shadow-lg ring-2 ring-ring/60"
            )}
            style={{ left, width, height: ROW_H - 8 }}
          >
            {/* Edge affordances — cursor only; the hit test above is by offset,
                so a bar narrower than two grab zones still moves. */}
            <span aria-hidden className="absolute inset-y-0 left-0 w-2 cursor-ew-resize" />
            <span aria-hidden className="absolute inset-y-0 right-0 w-2 cursor-ew-resize" />
            <span className="truncate">{task.title}</span>
          </div>
        )}
      </div>
    </>
  )
})

// ---------------------------------------------------------------------------
// Header ticks

interface Tick {
  at: number
  label: string
  width?: number
  muted?: boolean
}

/** Two bands per zoom: a coarse one naming the period, a fine one marking the
    grid the bars snap to. All positions still go through `xOf` at render. */
function buildTicks(origin: Date, dayCount: number, zoom: ZoomId): { upper: Tick[]; lower: Tick[] } {
  const end = addDays(origin, Math.max(0, dayCount - 1))
  const interval = { start: origin, end }

  if (zoom === "day") {
    return {
      upper: eachMonthOfInterval(interval).map((date) => ({
        at: Math.max(date.getTime(), origin.getTime()),
        label: format(date, "MMMM yyyy"),
      })),
      lower: eachDayOfInterval(interval).map((date) => ({
        at: date.getTime(),
        label: format(date, "d"),
        muted: date.getDay() === 0 || date.getDay() === 6,
      })),
    }
  }

  if (zoom === "week") {
    return {
      upper: eachMonthOfInterval(interval).map((date) => ({
        at: Math.max(date.getTime(), origin.getTime()),
        label: format(date, "MMMM yyyy"),
      })),
      lower: eachWeekOfInterval(interval, { weekStartsOn: 1 })
        .filter((date) => date.getTime() >= origin.getTime())
        .map((date) => ({ at: date.getTime(), label: format(date, "MMM d") })),
    }
  }

  return {
    upper: eachYearOfInterval(interval).map((date) => ({
      at: Math.max(date.getTime(), origin.getTime()),
      label: format(date, "yyyy"),
    })),
    lower: eachMonthOfInterval(interval)
      .filter((date) => date.getTime() >= origin.getTime())
      .map((date) => ({ at: date.getTime(), label: format(date, "MMM") })),
  }
}

export default TimelineView
