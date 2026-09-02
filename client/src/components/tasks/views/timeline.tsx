import * as React from "react"

import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/use-mobile"
import { COLOR_DOT } from "@/lib/boards"
import { taskKey, type Task } from "@/lib/tasks-board"
import { startOfDay } from "@/lib/tasks-view"
import { AssigneeAvatar, TypeIcon } from "../fields"
import type { ViewProps } from "../types"

const DAY = 24 * 60 * 60_000
const DAY_PX = 28
/* The sticky task column: room to breathe on desktop, a narrow rail on a
   phone — where 260px would leave half the bars off-screen. */
const LABEL_W = 260
const LABEL_W_MOBILE = 148

interface Bar {
  task: Task
  start: number
  end: number
  /** True when only one of start/due is set — drawn as a marker, not a span. */
  point: boolean
}

/**
 * The timeline: a Gantt-shaped read of every task with a date. A task with
 * both a start and a due date is a bar; one with only a due date is a
 * one-day marker on it; one with neither is listed underneath as unscheduled.
 * Rows are grouped under their parent (epic) when they have one.
 */
export function TimelineView({ board, statuses, tasks, ctx, onOpen }: ViewProps) {
  const today = startOfDay(Date.now())
  const isMobile = useIsMobile()
  const labelW = isMobile ? LABEL_W_MOBILE : LABEL_W

  const bars = React.useMemo<Bar[]>(() => {
    const out: Bar[] = []
    for (const t of tasks) {
      if (t.startAt == null && t.dueAt == null) continue
      const start = startOfDay(t.startAt ?? t.dueAt!)
      const end = startOfDay(t.dueAt ?? t.startAt!)
      out.push({ task: t, start: Math.min(start, end), end: Math.max(start, end), point: t.startAt == null || t.dueAt == null })
    }
    return out
  }, [tasks])

  const unscheduled = tasks.filter((t) => t.startAt == null && t.dueAt == null)

  const range = React.useMemo(() => {
    if (bars.length === 0) return { from: today - 7 * DAY, to: today + 21 * DAY }
    let from = Math.min(today, ...bars.map((b) => b.start))
    let to = Math.max(today, ...bars.map((b) => b.end))
    from -= 3 * DAY
    to += 7 * DAY
    // Snap to Mondays so the week header lines up.
    const lead = (new Date(from).getDay() + 6) % 7
    from -= lead * DAY
    return { from, to }
  }, [bars, today])

  const dayCount = Math.round((range.to - range.from) / DAY) + 1
  const width = dayCount * DAY_PX
  const x = (ms: number) => Math.round((ms - range.from) / DAY) * DAY_PX

  /* Group rows under their parent so an epic's bar sits above its children. */
  const ordered = React.useMemo(() => {
    const byParent = new Map<string | null, Bar[]>()
    for (const b of bars) {
      const key = b.task.parentId && bars.some((p) => p.task.id === b.task.parentId) ? b.task.parentId : null
      const list = byParent.get(key)
      if (list) list.push(b)
      else byParent.set(key, [b])
    }
    const rows: { bar: Bar; depth: number }[] = []
    const top = (byParent.get(null) ?? []).sort((a, b) => a.start - b.start)
    for (const bar of top) {
      rows.push({ bar, depth: 0 })
      for (const child of (byParent.get(bar.task.id) ?? []).sort((a, b) => a.start - b.start)) rows.push({ bar: child, depth: 1 })
    }
    return rows
  }, [bars])

  const weeks: number[] = []
  for (let d = range.from; d <= range.to; d += 7 * DAY) weeks.push(d)

  const scroller = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    // Open with today in view rather than the far left.
    const el = scroller.current
    if (el) el.scrollLeft = Math.max(0, x(today) - el.clientWidth / 3)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto rounded-xl border bg-card">
        <div style={{ width: labelW + width }} className="relative">
          {/* Header: weeks, then days. */}
          <div className="sticky top-0 z-20 flex border-b bg-background/95 backdrop-blur">
            <div className="sticky left-0 z-30 shrink-0 border-r bg-background px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" style={{ width: labelW }}>
              Task
            </div>
            <div className="relative" style={{ width }}>
              <div className="flex h-5">
                {weeks.map((w) => (
                  <div key={w} style={{ width: 7 * DAY_PX }} className="shrink-0 border-r px-1 text-[10px] text-muted-foreground">
                    {new Date(w).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </div>
                ))}
              </div>
              <div className="flex h-5">
                {Array.from({ length: dayCount }, (_, i) => {
                  const d = range.from + i * DAY
                  const weekend = [0, 6].includes(new Date(d).getDay())
                  return (
                    <div
                      key={d}
                      style={{ width: DAY_PX }}
                      className={cn("shrink-0 text-center text-[10px] tabular-nums text-muted-foreground", weekend && "bg-muted/50", d === today && "font-bold text-primary")}
                    >
                      {new Date(d).getDate()}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {/* Body rows. */}
          {ordered.map(({ bar, depth }) => {
            const status = statuses.find((s) => s.id === bar.task.statusId)
            const left = x(bar.start)
            const w = bar.point ? DAY_PX : x(bar.end) - left + DAY_PX
            const done = bar.task.completedAt != null
            return (
              <div key={bar.task.id} className="flex h-9 border-b last:border-b-0 hover:bg-accent/30">
                <button
                  type="button"
                  onClick={() => onOpen(bar.task)}
                  className={cn("sticky left-0 z-10 flex shrink-0 items-center gap-1.5 truncate border-r bg-card px-3 text-left text-xs hover:underline", ctx.selected.has(bar.task.id) && "bg-primary/5")}
                  style={{ width: labelW, paddingLeft: `${0.75 + depth}rem` }}
                >
                  <TypeIcon type={bar.task.type} />
                  <span className="font-mono text-[10px] text-muted-foreground">{taskKey(bar.task, board.key)}</span>
                  <span className={cn("truncate", done && "text-muted-foreground line-through")}>{bar.task.title}</span>
                </button>
                <div className="relative" style={{ width }}>
                  {/* Today line. */}
                  <span className="absolute inset-y-0 w-px bg-primary/50" style={{ left: x(today) + DAY_PX / 2 }} />
                  <button
                    type="button"
                    onClick={() => onOpen(bar.task)}
                    title={`${bar.task.title} · ${new Date(bar.start).toLocaleDateString()} → ${new Date(bar.end).toLocaleDateString()}`}
                    className={cn(
                      "absolute top-2 flex h-5 items-center gap-1 overflow-hidden rounded-md px-1.5 text-[10px] font-medium text-white shadow-xs",
                      status?.color ? COLOR_DOT[status.color] : "bg-slate-500",
                      bar.point && "rounded-full",
                      done && "opacity-50",
                      bar.end < today && !done && "ring-2 ring-destructive/60",
                    )}
                    style={{ left, width: Math.max(w, DAY_PX) }}
                  >
                    {!bar.point && w > 80 && <span className="truncate">{bar.task.title}</span>}
                    {bar.task.assignee && w > 120 && <AssigneeAvatar name={bar.task.assignee} size="xs" className="ml-auto" />}
                  </button>
                </div>
              </div>
            )
          })}
          {ordered.length === 0 && (
            <p className="sticky left-0 px-4 py-8 text-center text-sm text-muted-foreground">
              Nothing scheduled — give a task a start or due date to see it here.
            </p>
          )}
        </div>
      </div>
      {unscheduled.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {unscheduled.length} {unscheduled.length === 1 ? "task has" : "tasks have"} no dates and {unscheduled.length === 1 ? "is" : "are"} not drawn.
        </p>
      )}
    </div>
  )
}
