import * as React from "react"
import { ArrowDown, ArrowUp, CalendarIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Checkbox } from "@/components/ui/checkbox"
import { useIsNarrow } from "@/hooks/use-device"
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
import { TaskRow } from "../task-card"
import { INSET_X } from "../modes"
import type { ViewProps } from "../types"

/** Which sort a header click toggles: every column `SORT_BYS` knows. */
const SORT_OF: Partial<Record<TableColumn | "key" | "title", SortBy>> = {
  key: "key",
  title: "title",
  priority: "priority",
  due: "due",
  created: "created",
  updated: "updated",
  estimate: "estimate",
}

/** Each column's width, so the table is as wide as its columns and no wider. */
const COL_WIDTH: Record<TableColumn, string> = {
  type: "w-36",
  status: "w-36",
  priority: "w-36",
  assignee: "w-36",
  labels: "w-36",
  sprint: "w-36",
  parent: "w-36",
  estimate: "w-36",
  progress: "w-36",
  start: "w-28",
  due: "w-28",
  created: "w-28",
  updated: "w-28",
}

/* ── The frozen columns ──
   Select, Key and Title are frozen from `@panel-sm` so the row stays
   identifiable while the fields scroll; below it the narrow form is drawn
   instead. Their background cannot be the row's alpha tint: an alpha
   background lets the columns sliding underneath show through. Same colours,
   resolved against the page instead of stacked on it. */
const STUCK = "@panel-sm:sticky bg-background group-hover:bg-muted"
const STUCK_SELECTED = "bg-muted"
const STICK_SELECT = "left-0 w-10"
const STICK_KEY = "left-10 w-24"
const STICK_TITLE = "left-34 w-[28rem] min-w-72"

const fmtDate = (ms: number | null) =>
  ms == null ? "" : new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" })

/**
 * The table: every task a row, every field a column, edited in place. The
 * column set and its order are the view's (`view.columns`), so a saved view
 * remembers them; a header with a sort toggles it. On a narrow panel it is a
 * card of rows instead — the chosen columns read as text, edited in the detail.
 */
export function TableView({ board, statuses, sprints, tasks, view, ctx, facets, onOpen, onUpdate, onViewChange }: ViewProps) {
  const columns = view.columns as TableColumn[]
  const statusOf = (id: string) => statuses.find((s) => s.id === id)
  const sprintOf = (id: string | null) => (id ? sprints.find((s) => s.id === id) : undefined)
  const allSelected = tasks.length > 0 && tasks.every((t) => ctx.selected.has(t.id))
  /** Whether the press that toggled a row's box held shift: a range select. */
  const shift = React.useRef(false)
  const root = React.useRef<HTMLDivElement>(null)
  const narrow = useIsNarrow(root)

  const toggleSort = (sortBy: SortBy) => {
    if (view.sortBy === sortBy) onViewChange({ sortDir: view.sortDir === "asc" ? "desc" : "asc" })
    else onViewChange({ sortBy, sortDir: "asc" })
  }

  /** A header cell's words, as a sort toggle where the column has one. */
  const head = (col: TableColumn | "key" | "title", label: string) => {
    const sortBy = SORT_OF[col]
    if (!sortBy) return label
    const active = view.sortBy === sortBy
    return (
      <button
        type="button"
        onClick={() => toggleSort(sortBy)}
        className={cn("inline-flex items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50", active && "text-foreground")}
      >
        {label}
        {active && (view.sortDir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    )
  }

  /** A column's value as plain words, for the narrow form's second line. */
  const text = (task: Task, col: TableColumn): string | null => {
    switch (col) {
      case "type":
        return TYPE_LABEL[task.type]
      case "status":
        return statusOf(task.statusId)?.name ?? null
      case "priority":
        return PRIORITY_LABEL[task.priority]
      case "assignee":
        return task.assignee
      case "labels":
        return task.labels.length ? task.labels.join(", ") : null
      case "sprint":
        return sprintOf(task.sprintId)?.name ?? null
      case "parent": {
        const parent = ctx.parentOf(task)
        return parent ? taskKey(parent, board.key) : null
      }
      case "estimate":
        return task.estimate == null ? null : `${task.estimate} pts`
      case "start":
        return task.startAt == null ? null : `Starts ${fmtDate(task.startAt)}`
      case "due":
        return dueLabel(task.dueAt)
      case "progress": {
        const p = checklistProgress(task)
        return p.total ? `${p.done}/${p.total} checked` : null
      }
      case "created":
        return `Created ${fmtDate(task.createdAt)}`
      case "updated":
        return `Updated ${fmtDate(task.updatedAt)}`
    }
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

  if (narrow) {
    /* The row already says key, status and due; the line under it says the
       rest of what the reader chose to see. */
    const extra = columns.filter((c) => c !== "status" && c !== "due")
    return (
      <div ref={root} className="h-full overflow-y-auto">
        <div className={cn("mx-auto grid w-full max-w-6xl gap-6 py-3 pb-[calc(var(--tasks-foot,0px)+0.75rem)]", INSET_X)}>
          <div className="divide-y overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/10">
            {tasks.map((task) => {
              const line = extra.map((c) => text(task, c)).filter(Boolean).join(" · ")
              return (
                <div key={task.id}>
                  <TaskRow task={task} status={statusOf(task.statusId) ?? null} ctx={ctx} onClick={() => onOpen(task)} />
                  {line && (
                    <p onClick={() => onOpen(task)} className="-mt-1 cursor-pointer truncate px-3 pb-2 ps-18 text-xs text-muted-foreground">
                      {line}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  return (
    /* `overscroll-x-contain`: this table is often wider than the panel, so a
       sideways swipe is the normal way to read it — and reaching the last
       column must not hand the gesture to the browser's back-navigation. */
    <div ref={root} className="h-full overflow-auto overscroll-x-contain">
      {/* The inset is the inner box's, not the scroller's: sticky cells stick
          to the scroller's padding edge, so padding there would let rows show
          through above the header and beside the frozen columns. */}
      <div className={cn("w-max min-w-full py-3 pb-[calc(var(--tasks-foot,0px)+0.75rem)]", INSET_X)}>
      <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
        <thead className="sticky top-0 z-20">
          <tr className="h-9 text-left text-xs font-medium text-muted-foreground">
            <th className={cn("z-30 border-b bg-background px-2", STUCK, STICK_SELECT)}>
              <Checkbox
                checked={allSelected}
                onCheckedChange={() => ctx.onToggleSelect?.(allSelected ? "!none" : "!all", false)}
                aria-label="Select all"
              />
            </th>
            <th className={cn("z-30 border-b bg-background px-2", STUCK, STICK_KEY)}>{head("key", "Key")}</th>
            <th className={cn("z-30 border-b bg-background px-2", STUCK, STICK_TITLE)}>{head("title", "Title")}</th>
            {columns.map((col) => (
              <th key={col} className={cn("border-b bg-background px-2 whitespace-nowrap", COL_WIDTH[col])}>
                {head(col, COLUMN_LABEL[col])}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => {
            const selected = ctx.selected.has(task.id)
            return (
              <tr key={task.id} className={cn("group hover:bg-muted", selected && "bg-muted", task.archived && "opacity-60")}>
                <td
                  className={cn(
                    "relative z-10 border-b px-2 py-1 before:pointer-events-none before:absolute before:inset-y-0 before:start-0 before:w-0.5 before:bg-primary before:opacity-0",
                    STUCK,
                    STICK_SELECT,
                    selected && cn(STUCK_SELECTED, "before:opacity-100"),
                  )}
                >
                  <Checkbox
                    checked={selected}
                    /* The change arrives from the control's hidden input, which
                       carries no modifier keys — the shift is read off the
                       press that caused it. */
                    onPointerDown={(e) => (shift.current = e.shiftKey)}
                    onKeyDown={(e) => (shift.current = e.shiftKey)}
                    onCheckedChange={() => ctx.onToggleSelect?.(task.id, shift.current)}
                    aria-label={`Select ${task.title}`}
                  />
                </td>
                <td className={cn("z-10 border-b px-2 py-1 font-mono text-xs tabular-nums text-muted-foreground", STUCK, STICK_KEY, selected && STUCK_SELECTED)}>
                  {taskKey(task, board.key)}
                </td>
                <td className={cn("z-10 border-b px-2 py-1", STUCK, STICK_TITLE, selected && STUCK_SELECTED)}>
                  <button
                    type="button"
                    onClick={() => onOpen(task)}
                    className={cn("block max-w-[27rem] truncate text-left font-medium hover:underline", task.completedAt != null && "text-muted-foreground line-through")}
                    title={task.title}
                  >
                    {task.title}
                  </button>
                </td>
                {columns.map((col) => (
                  <td key={col} className={cn("border-b px-1 py-0.5 whitespace-nowrap", COL_WIDTH[col])}>
                    {cell(task, col)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>
    </div>
  )
}
