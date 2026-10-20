import * as React from "react"
import { ChevronLeft, ChevronRight, Plus } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Empty } from "@/components/empty"
import { useIsNarrow } from "@/hooks/use-device"
import { COLOR_DOT } from "@/lib/boards"
import type { Task } from "@/lib/tasks-board"
import { startOfDay } from "@/lib/tasks-view"
import { TaskRow } from "../task-card"
import { QuickAdd } from "../quick-add"
import { ICON_BTN } from "../fields"
import { INSET_X } from "../modes"
import type { ViewProps } from "../types"

const DAY = 24 * 60 * 60_000
const NOON = 12 * 60 * 60_000
const MAX_PER_DAY = 3
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

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

const dayLabel = (day: number) => new Date(day).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })

/**
 * The calendar: a month of due dates. A task lands on the day it is due; a
 * day's "+" makes a task due that day (at noon). The month is view-local
 * state — it is where the reader is looking, not a property of the board. A
 * narrow panel reads the same month as an agenda: the days that have
 * something, and today.
 */
export function CalendarView({ statuses, tasks, ctx, onOpen, onCreate }: ViewProps) {
  const [cursor, setCursor] = React.useState(() => {
    const d = new Date()
    return { year: d.getFullYear(), month: d.getMonth() }
  })
  const root = React.useRef<HTMLDivElement>(null)
  const narrow = useIsNarrow(root)
  const days = React.useMemo(() => monthGrid(cursor.year, cursor.month), [cursor])
  const today = startOfDay(Date.now())
  const statusOf = (id: string) => statuses.find((s) => s.id === id) ?? null

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
  const inMonth = (day: number) => new Date(day).getMonth() === cursor.month

  /** A day's "+": the quick add in a popover, due that day at noon. */
  const addOn = (day: number, className?: string) => (
    <Popover>
      <PopoverTrigger
        render={
          <Button type="button" variant="ghost" size="icon-sm" title={`Add task due ${dayLabel(day)}`} className={cn(ICON_BTN, "text-muted-foreground", className)}>
            <Plus />
          </Button>
        }
      />
      <PopoverContent align="end" className="w-72 gap-2 p-2">
        <QuickAdd open label="Add task" onCreate={async (title) => void (await onCreate({ title, dueAt: day + NOON }))} />
      </PopoverContent>
    </Popover>
  )

  const rows = (list: Task[]) => (
    <div className="divide-y overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/10">
      {list.map((task) => (
        <TaskRow key={task.id} task={task} status={statusOf(task.statusId)} ctx={ctx} onClick={() => onOpen(task)} />
      ))}
    </div>
  )

  const header = (
    <div className="flex items-center gap-2 py-2">
      <h2 className="min-w-0 truncate font-heading text-base font-medium">{label}</h2>
      {undated > 0 && <span className="hidden text-xs text-muted-foreground @panel-sm:inline">{undated} without a due date</span>}
      <ButtonGroup className="ms-auto">
        <Button type="button" variant="outline" size="icon-sm" className={ICON_BTN} onClick={() => shift(-1)} title="Previous month">
          <ChevronLeft />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="pointer-coarse:h-11"
          onClick={() => {
            const d = new Date()
            setCursor({ year: d.getFullYear(), month: d.getMonth() })
          }}
        >
          Today
        </Button>
        <Button type="button" variant="outline" size="icon-sm" className={ICON_BTN} onClick={() => shift(1)} title="Next month">
          <ChevronRight />
        </Button>
      </ButtonGroup>
    </div>
  )

  if (narrow) {
    const agenda = days.filter((d) => inMonth(d) && (byDay.has(d) || d === today))
    const anyDated = days.some((d) => inMonth(d) && byDay.has(d))
    return (
      <div ref={root} className="h-full overflow-y-auto">
        <div className={cn("mx-auto grid w-full max-w-6xl gap-3 pb-[calc(var(--tasks-foot,0px)+0.75rem)]", INSET_X)}>
          {header}
          {!anyDated && <Empty>Nothing due in {new Date(cursor.year, cursor.month, 1).toLocaleDateString(undefined, { month: "long" })}.</Empty>}
          {agenda.map((day) => {
            const list = byDay.get(day) ?? []
            return (
              <section key={day} className="grid gap-2">
                <header className="sticky top-0 z-10 flex h-9 items-center gap-2 bg-background/95 px-1 backdrop-blur">
                  <span className={cn("text-sm font-medium", day === today && "text-primary")}>{dayLabel(day)}</span>
                  {day === today && <span className="text-xs text-muted-foreground">Today</span>}
                  {addOn(day, "ms-auto")}
                </header>
                {list.length > 0 && rows(list)}
              </section>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div ref={root} className="h-full overflow-y-auto">
      <div className={cn("flex min-h-full flex-col pb-[calc(var(--tasks-foot,0px)+0.75rem)]", INSET_X)}>
        {header}
        <div className="grid grid-cols-7 text-center text-xs font-medium text-muted-foreground">
          {WEEKDAYS.map((d) => (
            <div key={d} className="py-1">
              {d}
            </div>
          ))}
        </div>
        <div className="grid flex-1 auto-rows-[minmax(7rem,1fr)] grid-cols-7 gap-px overflow-hidden rounded-2xl bg-border ring-1 ring-foreground/10">
          {days.map((day) => {
            const list = byDay.get(day) ?? []
            const isToday = day === today
            return (
              <div key={day} className={cn("group/day flex min-w-0 flex-col gap-0.5 bg-card p-1.5", !inMonth(day) && "bg-muted/50 text-muted-foreground")}>
                <div className="flex items-center justify-between">
                  <span className={cn("grid size-6 place-items-center rounded-full text-xs tabular-nums", isToday && "bg-primary font-medium text-primary-foreground")}>
                    {new Date(day).getDate()}
                  </span>
                  {addOn(day, "opacity-0 group-hover/day:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100 pointer-coarse:opacity-100")}
                </div>
                {list.slice(0, MAX_PER_DAY).map((task) => {
                  const status = statusOf(task.statusId)
                  return (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => onOpen(task)}
                      title={task.title}
                      className={cn(
                        "flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-xs outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50",
                        task.completedAt != null && "text-muted-foreground line-through",
                        ctx.selected.has(task.id) && "ring-1 ring-primary",
                      )}
                    >
                      <span className={cn("size-1.5 shrink-0 rounded-full", status?.color ? COLOR_DOT[status.color] : "bg-muted-foreground/40")} />
                      <span className="truncate">{task.title}</span>
                    </button>
                  )
                })}
                {list.length > MAX_PER_DAY && (
                  <Popover>
                    <PopoverTrigger
                      render={
                        <Button type="button" variant="ghost" size="sm" className="h-6 justify-start px-1.5 text-xs text-muted-foreground pointer-coarse:h-9">
                          +{list.length - MAX_PER_DAY} more
                        </Button>
                      }
                    />
                    <PopoverContent align="start" className="max-h-96 w-80 gap-2 overflow-y-auto p-2">
                      <p className="px-1 text-sm font-medium">{dayLabel(day)}</p>
                      {rows(list)}
                    </PopoverContent>
                  </Popover>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
