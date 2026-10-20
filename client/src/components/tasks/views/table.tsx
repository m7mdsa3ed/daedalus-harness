import * as React from "react"
import { ArrowDown, ArrowUp, CalendarIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Empty } from "@/components/empty"
import type { Task } from "@/lib/tasks-board"
import { PRIORITY_LABEL, TYPE_LABEL, taskKey } from "@/lib/tasks-board"
import {
  COLUMN_LABEL,
  checklistProgress,
  dueLabel,
  isOverdue,
  type SortBy,
  type TableColumn,
} from "@/lib/tasks-view"
import {
  AssigneeAvatar,
  AssigneePicker,
  CHIP,
  DatePicker,
  EstimateBadge,
  LabelChip,
  LabelsPicker,
  NumberPicker,
  PriorityIcon,
  PriorityPicker,
  ProgressBar,
  SprintPicker,
  StatusPicker,
  StatusPill,
  TypeIcon,
  TypePicker,
} from "../fields"
import type { ViewProps } from "../types"

/** Which sort a column header toggles, when it has a natural one. */
const SORT_OF: Partial<Record<TableColumn, SortBy>> = {
  priority: "priority",
  due: "due",
  created: "created",
  updated: "updated",
  estimate: "estimate",
}

/* ── The frozen columns ──
   Key and Title are frozen so the row stays identifiable while the fields
   scroll. On a phone that inverted itself: checkbox + key + title is ~23rem of
   a 23rem viewport, so the whole screen was frozen and there was nothing left
   to scroll the other columns into. Below `@panel-sm` they scroll with
   everything else — the title is the first thing on the row anyway, so nothing
   is lost but the freeze.

   Their background cannot be the row's alpha tint, either: an alpha background
   lets the columns sliding underneath show through, which is what `bg-inherit`
   (inheriting a transparent `<tr>`) did at every width. Same colours, resolved
   against the page instead of stacked on it. */
const STUCK = "@panel-sm:sticky bg-background group-hover:bg-muted"
const STUCK_SELECTED = "bg-muted"

const fmtDate = (ms: number | null) =>
  ms == null ? "" : new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" })

/**
 * The table: every task a row, every field a column, edited in place. The
 * column set and its order are the view's (`view.columns`), so a saved view
 * remembers them; a header with a natural sort toggles it.
 */
export function TableView({ board, statuses, sprints, tasks, allTasks, view, ctx, facets, onOpen, onUpdate, onViewChange }: ViewProps) {
  const columns = view.columns as TableColumn[]
  const statusOf = (id: string) => statuses.find((s) => s.id === id)
  const sprintOf = (id: string | null) => (id ? sprints.find((s) => s.id === id) : undefined)
  const allSelected = tasks.length > 0 && tasks.every((t) => ctx.selected.has(t.id))

  const toggleSort = (col: TableColumn) => {
    const sortBy = SORT_OF[col]
    if (!sortBy) return
    if (view.sortBy === sortBy) onViewChange({ sortDir: view.sortDir === "asc" ? "desc" : "asc" })
    else onViewChange({ sortBy, sortDir: "asc" })
  }

  const patch = (task: Task, input: Parameters<typeof onUpdate>[1]) => void onUpdate(task.id, input)

  const cell = (task: Task, col: TableColumn): React.ReactNode => {
    switch (col) {
      case "type":
        return (
          <TypePicker
            value={task.type}
            onChange={(type) => patch(task, { type })}
            trigger={
              <button type="button" className={CHIP}>
                <TypeIcon type={task.type} /> {TYPE_LABEL[task.type]}
              </button>
            }
          />
        )
      case "status":
        return (
          <StatusPicker
            value={task.statusId}
            statuses={statuses}
            onChange={(statusId) => patch(task, { statusId })}
            trigger={
              <button type="button" className={cn(CHIP, "px-0.5")}>
                <StatusPill status={statusOf(task.statusId)} />
              </button>
            }
          />
        )
      case "priority":
        return (
          <PriorityPicker
            value={task.priority}
            onChange={(priority) => patch(task, { priority })}
            trigger={
              <button type="button" className={CHIP}>
                <PriorityIcon priority={task.priority} /> {PRIORITY_LABEL[task.priority]}
              </button>
            }
          />
        )
      case "assignee":
        return (
          <AssigneePicker
            value={task.assignee}
            suggestions={facets.assignees}
            onChange={(assignee) => patch(task, { assignee })}
            trigger={
              <button type="button" className={CHIP}>
                <AssigneeAvatar name={task.assignee} size="xs" />
                <span className="truncate">{task.assignee ?? "Unassigned"}</span>
              </button>
            }
          />
        )
      case "labels":
        return (
          <LabelsPicker
            value={task.labels}
            suggestions={facets.labels}
            onChange={(labels) => patch(task, { labels })}
            trigger={
              <button type="button" className={cn(CHIP, "flex-wrap gap-1")}>
                {task.labels.length === 0 && <span className="text-muted-foreground">—</span>}
                {task.labels.slice(0, 3).map((l) => (
                  <LabelChip key={l} label={l} />
                ))}
                {task.labels.length > 3 && <span className="text-xs text-muted-foreground">+{task.labels.length - 3}</span>}
              </button>
            }
          />
        )
      case "sprint":
        return (
          <SprintPicker
            value={task.sprintId}
            sprints={sprints}
            onChange={(sprintId) => patch(task, { sprintId })}
            trigger={
              <button type="button" className={CHIP}>
                <span className="truncate">{sprintOf(task.sprintId)?.name ?? <span className="text-muted-foreground">Backlog</span>}</span>
              </button>
            }
          />
        )
      case "parent": {
        const parent = ctx.parentOf(task)
        return parent ? (
          <button type="button" onClick={() => onOpen(parent)} className={cn(CHIP, "text-muted-foreground hover:text-foreground")}>
            <TypeIcon type={parent.type} />
            <span className="font-mono text-xs">{taskKey(parent, board.key)}</span>
            <span className="truncate">{parent.title}</span>
          </button>
        ) : (
          <span className="px-1.5 text-xs text-muted-foreground">—</span>
        )
      }
      case "estimate":
        return (
          <NumberPicker
            value={task.estimate}
            onChange={(estimate) => patch(task, { estimate })}
            trigger={
              <button type="button" className={CHIP}>
                {task.estimate == null ? <span className="text-muted-foreground">—</span> : <EstimateBadge estimate={task.estimate} />}
              </button>
            }
          />
        )
      case "start":
        return (
          <DatePicker
            value={task.startAt}
            onChange={(startAt) => patch(task, { startAt })}
            trigger={
              <button type="button" className={cn(CHIP, "tabular-nums")}>
                <CalendarIcon className="size-3 text-muted-foreground" /> {fmtDate(task.startAt) || <span className="text-muted-foreground">—</span>}
              </button>
            }
          />
        )
      case "due":
        return (
          <DatePicker
            value={task.dueAt}
            onChange={(dueAt) => patch(task, { dueAt })}
            trigger={
              <button type="button" className={cn(CHIP, "tabular-nums", isOverdue(task) && "text-destructive")}>
                <CalendarIcon className="size-3 text-muted-foreground" /> {dueLabel(task.dueAt) ?? <span className="text-muted-foreground">—</span>}
              </button>
            }
          />
        )
      case "progress": {
        const p = checklistProgress(task)
        return p.total ? <ProgressBar done={p.done} total={p.total} /> : <span className="px-1.5 text-xs text-muted-foreground">—</span>
      }
      case "created":
        return <span className="px-1.5 text-xs tabular-nums text-muted-foreground">{fmtDate(task.createdAt)}</span>
      case "updated":
        return <span className="px-1.5 text-xs tabular-nums text-muted-foreground">{fmtDate(task.updatedAt)}</span>
    }
  }

  return (
    /* `overscroll-x-contain`: this table is always wider than the panel, so a
       sideways swipe is the normal way to read it — and reaching the last
       column must not hand the gesture to the browser's back-navigation. */
    <div className="min-h-0 flex-1 overflow-auto overscroll-x-contain p-3 pb-[max(0.75rem,var(--safe-bottom))]">
      <table className="w-full min-w-[56rem] border-separate border-spacing-0 text-sm">
        <thead className="sticky top-0 z-10 bg-background">
          <tr className="text-left text-xs font-medium text-muted-foreground">
            <th className="w-8 border-b px-2 py-2">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => ctx.onToggleSelect?.(allSelected ? "!none" : "!all", false)}
                aria-label="Select all"
                className="size-3.5 accent-primary"
              />
            </th>
            <th className="@panel-sm:sticky left-8 z-20 w-20 border-b bg-background px-2 py-2">Key</th>
            <th className="@panel-sm:sticky left-28 z-20 min-w-[12rem] @panel-sm:min-w-[16rem] border-b bg-background px-2 py-2">Title</th>
            {columns.map((col) => {
              const sortable = SORT_OF[col]
              const active = sortable && view.sortBy === sortable
              return (
                <th key={col} className="border-b px-2 py-2 whitespace-nowrap">
                  {sortable ? (
                    <button type="button" onClick={() => toggleSort(col)} className={cn("inline-flex items-center gap-1 hover:text-foreground", active && "text-foreground")}>
                      {COLUMN_LABEL[col]}
                      {active && (view.sortDir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                    </button>
                  ) : (
                    COLUMN_LABEL[col]
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => {
            const selected = ctx.selected.has(task.id)
            return (
              <tr key={task.id} className={cn("group hover:bg-muted", selected && "bg-muted", task.archived && "opacity-60")}>
                <td className="border-b px-2 py-1">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={(e) => ctx.onToggleSelect?.(task.id, (e.nativeEvent as MouseEvent).shiftKey)}
                    aria-label={`Select ${task.title}`}
                    className="size-3.5 accent-primary"
                  />
                </td>
                <td className={cn("left-8 z-10 border-b px-2 py-1 font-mono text-xs tabular-nums text-muted-foreground", STUCK, selected && STUCK_SELECTED)}>{taskKey(task, board.key)}</td>
                <td className={cn("left-28 z-10 border-b px-2 py-1", STUCK, selected && STUCK_SELECTED)}>
                  <button
                    type="button"
                    onClick={() => onOpen(task)}
                    className={cn("max-w-[32rem] truncate text-left font-medium hover:underline", task.completedAt != null && "text-muted-foreground line-through")}
                    title={task.title}
                  >
                    {task.title}
                  </button>
                </td>
                {columns.map((col) => (
                  <td key={col} className="border-b px-1 py-0.5 whitespace-nowrap">
                    {cell(task, col)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
      {tasks.length === 0 && (
        <Empty className="mt-3">{allTasks.length === 0 ? "No tasks yet." : "No tasks match the current filters."}</Empty>
      )}
    </div>
  )
}
