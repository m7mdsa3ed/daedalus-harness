import * as React from "react"
import { ChevronLeft, ChevronRight, Plus } from "lucide-react"

import { cn } from "@/lib/utils"
import { COLOR_DOT } from "@/lib/boards"
import type { Task } from "@/lib/tasks-board"
import { startOfDay } from "@/lib/tasks-view"
import { PriorityIcon, TypeIcon } from "../fields"
import type { ViewProps } from "../types"

const DAY = 24 * 60 * 60_000
const MAX_PER_DAY = 4

function monthGrid(year: number, month: number): number[] {
  const first = new Date(year, month, 1)
  // Weeks start on Monday.
  const lead = (first.getDay() + 6) % 7
  const start = first.getTime() - lead * DAY
  const days: number[] = []
  for (let i = 0; i < 42; i++) days.push(startOfDay(start + i * DAY))
  // Drop a trailing week that is entirely next month.
  const lastRow = days.slice(35)
  if (lastRow.every((d) => new Date(d).getMonth() !== month)) days.length = 35
  return days
}

/**
 * The calendar: a month of due dates. A task lands on the day it is due; a
 * day's "+" makes a task due that day. The month is view-local state — it is
 * where the reader is looking, not a property of the board.
 */
export function CalendarView({ statuses, tasks, ctx, onOpen, onCreate }: ViewProps) {
  const [cursor, setCursor] = React.useState(() => {
    const d = new Date()
    return { year: d.getFullYear(), month: d.getMonth() }
  })
  const days = React.useMemo(() => monthGrid(cursor.year, cursor.month), [cursor])
  const today = startOfDay(Date.now())

  const byDay = React.useMemo(() => {
    const map = new Map<number, Task[]>()
    for (const t of tasks) {
      if (t.dueAt == null) continue
      const key = startOfDay(t.dueAt)
      const list = map.get(key)
      if (list) list.push(t)
      else map.set(key, [t])
    }
    return map
  }, [tasks])

  const shift = (delta: number) =>
    setCursor(({ year, month }) => {
      const d = new Date(year, month + delta, 1)
      return { year: d.getFullYear(), month: d.getMonth() }
    })

  const undated = tasks.filter((t) => t.dueAt == null).length
  const label = new Date(cursor.year, cursor.month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" })

  return (
    <div className="flex min-h-0 flex-1 flex-col p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div className="mb-2 flex items-center gap-2">
        <button type="button" onClick={() => shift(-1)} aria-label="Previous month" className="grid size-8 place-items-center rounded-lg hover:bg-accent">
          <ChevronLeft className="size-4" />
        </button>
        <button type="button" onClick={() => shift(1)} aria-label="Next month" className="grid size-8 place-items-center rounded-lg hover:bg-accent">
          <ChevronRight className="size-4" />
        </button>
        <h2 className="text-sm font-semibold">{label}</h2>
        <button
          type="button"
          onClick={() => {
            const d = new Date()
            setCursor({ year: d.getFullYear(), month: d.getMonth() })
          }}
          className="rounded-pill border px-2 py-0.5 text-xs hover:bg-accent"
        >
          Today
        </button>
        {undated > 0 && <span className="ml-auto text-xs text-muted-foreground">{undated} without a due date</span>}
      </div>
      <div className="grid grid-cols-7 text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="py-1">
            {d}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-7 gap-px overflow-y-auto rounded-xl border bg-border">
        {days.map((day) => {
          const inMonth = new Date(day).getMonth() === cursor.month
          const list = byDay.get(day) ?? []
          const isToday = day === today
          return (
            <div
              key={day}
              className={cn("group flex min-h-16 flex-col gap-0.5 bg-card p-1 sm:min-h-24", !inMonth && "bg-muted/40 text-muted-foreground", day < today && "bg-card/70")}
            >
              <div className="flex items-center justify-between">
                <span className={cn("grid size-5 place-items-center rounded-full text-[11px] tabular-nums", isToday && "bg-primary font-semibold text-primary-foreground")}>
                  {new Date(day).getDate()}
                </span>
                <button
                  type="button"
                  aria-label="Add task due this day"
                  onClick={() => {
                    const title = window.prompt("New task title")
                    if (title?.trim()) void onCreate({ title: title.trim(), dueAt: day + 12 * 60 * 60_000 })
                  }}
                  className="grid size-5 place-items-center rounded opacity-0 hover:bg-accent group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <Plus className="size-3" />
                </button>
              </div>
              {list.slice(0, MAX_PER_DAY).map((task) => {
                const status = statuses.find((s) => s.id === task.statusId)
                return (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => onOpen(task)}
                    title={task.title}
                    className={cn(
                      "flex items-center gap-1 truncate rounded-md border-l-2 bg-muted/60 px-1 py-0.5 text-left text-[11px] hover:bg-accent",
                      task.completedAt != null && "line-through opacity-60",
                      ctx.selected.has(task.id) && "ring-1 ring-primary",
                    )}
                    style={{ borderLeftColor: status?.color ? undefined : "var(--muted-foreground)" }}
                  >
                    <span className={cn("-ml-1 h-3 w-0.5 shrink-0", status?.color && COLOR_DOT[status.color])} />
                    <TypeIcon type={task.type} className="size-3" />
                    {/* A phone's day cell fits dots, not words — the title is
                        in `title` and the detail opens on tap. */}
                    <span className="hidden truncate sm:inline">{task.title}</span>
                    <PriorityIcon priority={task.priority} className="ml-auto size-3" />
                  </button>
                )
              })}
              {list.length > MAX_PER_DAY && (
                <span className="px-1 text-[10px] text-muted-foreground">+{list.length - MAX_PER_DAY} more</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
