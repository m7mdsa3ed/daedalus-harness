import * as React from "react"
import { format } from "date-fns"
import { AlertTriangleIcon, ChevronDownIcon, ChevronRightIcon, FlagIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { byRank } from "@/lib/pm/filtering"
import { toggleColumnCollapsed, usePmPrefs } from "@/lib/pm/prefs"
import type { Column, Label, PmViewProps, Task } from "@/lib/pm/types"
import { cn } from "@/lib/utils"

/* ── List view ──
   The board as one flat, scannable column of rows, grouped by status. Same
   tasks the kanban lays out, already filtered by pm-page (a view never calls
   applyFilters) — only the shape differs: a row per task instead of a card, so
   a hundred of them fit on screen and the eye reads down a single line.

   Group folds are device-local (lib/pm/prefs), the same preference the kanban
   reads, so a column folded here is folded there.

   This file also owns the small row atoms the table view reuses — priority,
   labels, assignees, due — because the two list-shaped views are one design and
   a third file for four spans would be ceremony. */

/** Past this many rendered rows the view stops and offers "Show more" — a 5k
    board would otherwise mount 5k row components on open. No virtualization in
    v1: a plain slice is one state variable and never fights the scroll. */
const WINDOW = 500

// ---------------------------------------------------------------------------
// Shared row atoms (imported by table-view)

export const PRIORITY_NAMES = ["None", "Low", "Medium", "High", "Urgent"] as const

/** 0 is "no priority" and renders nothing; 1–4 climb the chart ramp, which is
    the one palette guaranteed to exist in every theme (built-in or custom). */
const PRIORITY_CLASS = [
  "",
  "text-[var(--chart-4)]",
  "text-[var(--chart-3)]",
  "text-[var(--chart-2)]",
  "text-[var(--chart-1)]",
]

export function PriorityFlag({ priority, className }: { priority: number; className?: string }) {
  if (!priority) return null
  const name = PRIORITY_NAMES[priority] ?? String(priority)
  return (
    <span title={`Priority: ${name}`} className="inline-flex shrink-0 items-center">
      <FlagIcon
        aria-label={`Priority ${name}`}
        className={cn("size-3.5", PRIORITY_CLASS[priority] ?? "text-muted-foreground", className)}
      />
    </span>
  )
}

/** A label's colour is user data, not a theme token, so it rides in a style
    attribute on a dot — the chip itself stays semantic and readable in both
    themes whatever colour was picked. */
export function LabelChips({
  labelIds,
  labels,
  max = 3,
  className,
}: {
  labelIds: string[]
  labels: Map<string, Label>
  max?: number
  className?: string
}) {
  const known = labelIds.map((id) => labels.get(id)).filter((label): label is Label => !!label)
  if (known.length === 0) return null
  const shown = known.slice(0, max)
  const rest = known.length - shown.length
  return (
    <span className={cn("flex min-w-0 items-center gap-1", className)}>
      {shown.map((label) => (
        <span
          key={label.id}
          title={label.name}
          className="flex max-w-28 items-center gap-1 rounded-4xl bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
        >
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full bg-muted-foreground"
            style={label.color ? { backgroundColor: label.color } : undefined}
          />
          <span className="truncate">{label.name}</span>
        </span>
      ))}
      {rest > 0 && <span className="text-[11px] text-muted-foreground">+{rest}</span>}
    </span>
  )
}

/** No accounts in this harness — assignees are free-form strings, so an avatar
    is initials in a circle. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
}

export function Assignees({
  assignees,
  max = 3,
  className,
}: {
  assignees: string[]
  max?: number
  className?: string
}) {
  if (assignees.length === 0) return null
  const shown = assignees.slice(0, max)
  const rest = assignees.length - shown.length
  return (
    <span className={cn("flex shrink-0 items-center -space-x-1", className)}>
      {shown.map((name) => (
        <span
          key={name}
          title={name}
          className="flex size-5 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground ring-1 ring-background"
        >
          {initials(name)}
        </span>
      ))}
      {rest > 0 && <span className="pl-2 text-[11px] text-muted-foreground">+{rest}</span>}
    </span>
  )
}

/** Overdue is only overdue while the task is still open — a task finished late
    is finished, and painting it red forever is noise. */
export function DueDate({
  task,
  className,
}: {
  task: Pick<Task, "dueDate" | "completedAt">
  className?: string
}) {
  if (task.dueDate === null) return null
  const overdue = task.completedAt === null && task.dueDate < Date.now()
  return (
    <span
      title={new Date(task.dueDate).toLocaleString()}
      className={cn(
        "shrink-0 text-xs tabular-nums",
        overdue ? "text-destructive" : "text-muted-foreground",
        className
      )}
    >
      {format(task.dueDate, "MMM d")}
    </span>
  )
}

/** The column's own colour, same treatment as a label's. */
export function ColumnDot({ color }: { color?: string | null }) {
  return (
    <span
      aria-hidden
      className="size-2 shrink-0 rounded-full bg-muted-foreground"
      style={color ? { backgroundColor: color } : undefined}
    />
  )
}

// ---------------------------------------------------------------------------
// Rows

interface RowProps {
  task: Task
  labels: Map<string, Label>
  /** Waiting on an unfinished dependency — from the board's one graph fetch. */
  blocked?: boolean
  onOpen: (id: string) => void
}

/** Memoized: a bulk op or a filter keystroke re-renders the view, and only the
    handful of rows whose task object actually changed should re-render with
    it. `labels` and `onOpen` are stable by construction upstream. */
const ListRow = React.memo(function ListRow({ task, labels, blocked, onOpen }: RowProps) {
  return (
    <button
      type="button"
      onClick={() => onOpen(task.id)}
      className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <span className="w-20 shrink-0 truncate font-mono text-[11px] text-muted-foreground">
        {task.key}
      </span>
      <PriorityFlag priority={task.priority} />
      {blocked && (
        <AlertTriangleIcon
          aria-label="Blocked by an unfinished task"
          className="size-3.5 shrink-0 text-destructive"
        />
      )}
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm",
          task.completedAt !== null ? "text-muted-foreground line-through" : "text-foreground"
        )}
      >
        {task.title}
      </span>
      <LabelChips labelIds={task.labelIds} labels={labels} className="hidden md:flex" />
      <Assignees assignees={task.assignees} />
      <DueDate task={task} />
    </button>
  )
})

// ---------------------------------------------------------------------------

interface Group {
  column: Column | null
  tasks: Task[]
}

export type ListViewProps = PmViewProps & {
  /** The board's blocked set — pm-page fetches the graph once for every view. */
  blockedTaskIds?: ReadonlySet<string>
}

export function ListView({ board, tasks, onOpenTask, blockedTaskIds }: ListViewProps) {
  const prefs = usePmPrefs()
  const collapsed = React.useMemo(
    () => new Set(prefs.collapsed[board.id] ?? []),
    [prefs.collapsed, board.id]
  )
  const [limit, setLimit] = React.useState(WINDOW)

  // A different board is a different list; a narrowed filter is not, so the
  // window only resets when the board does.
  React.useEffect(() => setLimit(WINDOW), [board.id])

  const labels = React.useMemo(
    () => new Map(board.labels.map((label) => [label.id, label])),
    [board.labels]
  )

  const groups = React.useMemo<Group[]>(() => {
    const byColumn = new Map<string, Task[]>()
    for (const task of tasks) {
      const bucket = byColumn.get(task.columnId)
      if (bucket) bucket.push(task)
      else byColumn.set(task.columnId, [task])
    }
    const ordered = [...board.columns].sort((a, b) => a.order - b.order)
    const known = new Set(ordered.map((column) => column.id))
    const out: Group[] = ordered.map((column) => ({
      column,
      tasks: byRank(byColumn.get(column.id) ?? []),
    }))
    // A task whose column the board no longer lists still has to be reachable.
    const orphans = tasks.filter((task) => !known.has(task.columnId))
    if (orphans.length > 0) out.push({ column: null, tasks: byRank(orphans) })
    return out
  }, [board.columns, tasks])

  const onOpen = React.useCallback((id: string) => onOpenTask(id), [onOpenTask])

  // Spend the window top-down: folded groups cost nothing, so folding one lets
  // the next group's rows in.
  let budget = limit
  const rendered = groups.map((group) => {
    const folded = group.column !== null && collapsed.has(group.column.id)
    const slice = folded ? [] : group.tasks.slice(0, Math.max(0, budget))
    budget -= slice.length
    return { group, folded, slice }
  })
  const total = groups.reduce(
    (sum, group) =>
      sum + (group.column !== null && collapsed.has(group.column.id) ? 0 : group.tasks.length),
    0
  )
  const used = limit - budget
  const truncated = Math.max(0, total - used)

  if (tasks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        No tasks match this view.
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
        {rendered.map(({ group, folded, slice }) => {
          const column = group.column
          const id = column?.id ?? "__unassigned"
          const over =
            column?.wipLimit != null && group.tasks.length > column.wipLimit ? column.wipLimit : null
          return (
            <section key={id}>
              <button
                type="button"
                aria-expanded={!folded}
                disabled={column === null}
                onClick={() => column && toggleColumnCollapsed(board.id, column.id)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/60 disabled:pointer-events-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                {column !== null &&
                  (folded ? (
                    <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  ))}
                <ColumnDot color={column?.color} />
                <span className="text-sm font-medium text-foreground">
                  {column?.name ?? "Unassigned"}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {group.tasks.length}
                  {column?.wipLimit != null && ` / ${column.wipLimit}`}
                </span>
                {over !== null && (
                  <span className="text-xs font-medium text-destructive">over WIP limit</span>
                )}
              </button>
              {!folded && (
                <div className="mt-1 flex flex-col border-t pt-1">
                  {slice.map((task) => (
                    <ListRow
                      key={task.id}
                      task={task}
                      labels={labels}
                      blocked={blockedTaskIds?.has(task.id)}
                      onOpen={onOpen}
                    />
                  ))}
                  {slice.length === 0 && group.tasks.length === 0 && (
                    <p className="px-2 py-2 text-xs text-muted-foreground">Empty</p>
                  )}
                </div>
              )}
            </section>
          )
        })}
        {truncated > 0 && (
          <div className="flex items-center justify-center gap-3 py-2">
            <span className="text-xs text-muted-foreground">
              Showing {used} of {total}
            </span>
            <Button variant="outline" size="sm" onClick={() => setLimit((n) => n + WINDOW)}>
              Show more
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

export default ListView
