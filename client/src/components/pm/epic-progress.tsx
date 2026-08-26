/* ── Epic roll-up ──
   Epics ARE tasks (an issue type with `isEpic`), so an epic has no progress of
   its own — it has children pointing at it through `epicId`, and its progress
   is whatever they add up to. `rollUpEpic` is that sum and nothing else: pure,
   allocation-light, and callable from a view that wants the numbers without
   rendering a widget (a card badge, a table cell).

   Doneness is the board's own definition — a column whose `category` is "done"
   — with `completedAt` as the fallback for a task whose column is not in the
   passed board (a filtered/partial config). That is the same rule the server
   stamps `completedAt` by, so the two never disagree in practice.

   Kept here rather than in lib/pm/filtering.ts because filtering is about
   narrowing a list against a FilterSpec and this is an aggregate over one
   epic's children; if it ever needs a second consumer outside this folder,
   lib/pm/rollup.ts is the home, not filtering. */
import * as React from "react"

import type { Board, Task } from "@/lib/pm/types"
import { cn } from "@/lib/utils"

export interface EpicRollUp {
  /** Children counted (the array as given — the caller decides what is live). */
  totalTasks: number
  doneTasks: number
  /** Story points summed; a child without points contributes 0. */
  totalPoints: number
  donePoints: number
  /** 0–1, by task count; 0 when the epic has no children. */
  taskRatio: number
  /** 0–1, by story points; 0 when nothing carries points. */
  pointRatio: number
  /** One entry per board column that holds at least one child, in board order. */
  byStatus: Array<{
    columnId: string
    name: string
    color: string | null
    category: string
    count: number
    points: number
  }>
}

const points = (task: Task): number =>
  typeof task.storyPoints === "number" && Number.isFinite(task.storyPoints) ? task.storyPoints : 0

/** Roll one epic's children up into counts, point sums and a per-column
    breakdown. Pure — safe inside a `useMemo`, a table cell or a sort. */
export function rollUpEpic(children: Task[], board: Board): EpicRollUp {
  const columns = Array.isArray(board?.columns) ? board.columns : []
  const doneColumns = new Set(
    columns.filter((column) => column.category === "done").map((column) => column.id)
  )
  const known = new Set(columns.map((column) => column.id))

  const counts = new Map<string, { count: number; points: number }>()
  let doneTasks = 0
  let totalPoints = 0
  let donePoints = 0

  for (const task of children) {
    const value = points(task)
    totalPoints += value
    const isDone = known.has(task.columnId)
      ? doneColumns.has(task.columnId)
      : task.completedAt !== null
    if (isDone) {
      doneTasks += 1
      donePoints += value
    }
    const bucket = counts.get(task.columnId)
    if (bucket) {
      bucket.count += 1
      bucket.points += value
    } else {
      counts.set(task.columnId, { count: 1, points: value })
    }
  }

  const byStatus = columns
    .filter((column) => counts.has(column.id))
    .map((column) => ({
      columnId: column.id,
      name: column.name,
      color: column.color,
      category: column.category as string,
      count: counts.get(column.id)!.count,
      points: counts.get(column.id)!.points,
    }))

  const totalTasks = children.length
  return {
    totalTasks,
    doneTasks,
    totalPoints,
    donePoints,
    taskRatio: totalTasks === 0 ? 0 : doneTasks / totalTasks,
    pointRatio: totalPoints === 0 ? 0 : donePoints / totalPoints,
    byStatus,
  }
}

/** Chart tokens carry the palette's own hues, so a column with no colour of its
    own still reads as a distinct band in every theme. */
const BAND_TOKENS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

function EpicProgressImpl({
  board,
  epic,
  children,
  className,
}: {
  board: Board
  epic: Task
  children: Task[]
  className?: string
}) {
  const rollUp = React.useMemo(() => rollUpEpic(children, board), [children, board])
  const percent = Math.round(rollUp.taskRatio * 100)

  return (
    <section
      className={cn("rounded-lg border bg-card p-3 text-sm", className)}
      aria-label={`Progress of ${epic.key}`}
    >
      <header className="flex items-baseline justify-between gap-3">
        <span className="font-medium">Epic progress</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {rollUp.doneTasks}/{rollUp.totalTasks} tasks
          {rollUp.totalPoints > 0
            ? ` · ${rollUp.donePoints}/${rollUp.totalPoints} pts`
            : ""}
        </span>
      </header>

      <div
        className="mt-2 flex h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}% of ${rollUp.totalTasks} tasks done`}
      >
        {rollUp.byStatus.map((status, index) => (
          <span
            key={status.columnId}
            className={cn(
              "h-full",
              // Done reads solid, everything before it reads as progress made
              // but not banked — same hue, lighter weight.
              status.category === "done" ? "opacity-100" : "opacity-45"
            )}
            style={{
              width: `${(status.count / Math.max(rollUp.totalTasks, 1)) * 100}%`,
              backgroundColor: status.color ?? BAND_TOKENS[index % BAND_TOKENS.length],
            }}
          />
        ))}
      </div>

      {rollUp.totalTasks === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Nothing points at this epic yet — set a task's epic to roll it up here.
        </p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {rollUp.byStatus.map((status, index) => (
            <li key={status.columnId} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  status.category === "done" ? "opacity-100" : "opacity-45"
                )}
                style={{
                  backgroundColor: status.color ?? BAND_TOKENS[index % BAND_TOKENS.length],
                }}
              />
              <span className="text-foreground/80">{status.name}</span>
              <span className="tabular-nums">{status.count}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Rendered inside cards and lists, so it is memo'd: the roll-up only changes
    when the children array or the board config identity does. */
export const EpicProgress = React.memo(EpicProgressImpl)

export default EpicProgress
