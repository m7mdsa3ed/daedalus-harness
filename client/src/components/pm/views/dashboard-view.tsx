/* ── Dashboard ──
   The board's answer to "where does this stand", in one screen: stat tiles
   across the top, the two sprint reports underneath, and a distribution of the
   work by assignee.

   Two sources of numbers, and the view is explicit about which is which:

   - `GET /api/boards/:id/dashboard` (`actions.fetchDashboard`) aggregates in
     SQL over the WHOLE board — every live task, archived and trashed excluded,
     and NOT narrowed by the filter bar. That is the honest number for
     "open/active/done", "overdue", "points" and the assignee split, and it is
     one request for all of them: no tile fetches anything of its own.
   - Unassigned and the active sprint's progress have no server aggregate, so
     they are computed from the `tasks` prop — which pm-page has already
     filtered. Those two tiles say "in view" rather than pretending otherwise.

   If the request fails the tiles fall back to the same local computation and
   the caption downgrades to "in view" — a dashboard that shows the numbers it
   can stand behind beats one that shows a spinner forever.

   Charts are the existing ones (charts/burndown-chart, charts/velocity-chart);
   they fetch their own report and are not rewritten here. */
import * as React from "react"
import { Bar, BarChart, Cell, LabelList, XAxis, YAxis } from "recharts"

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { BurndownChart } from "@/components/pm/charts/burndown-chart"
import { VelocityChart } from "@/components/pm/charts/velocity-chart"
import { usePmActions } from "@/components/pm/pm-sidebar-panels"
import type { Actions } from "@/lib/actions"
import { describeError } from "@/lib/errors"
import type { Board, DashboardStats, PmViewProps, Sprint, Task } from "@/lib/pm/types"
import { cn } from "@/lib/utils"

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

/** Bars past this many assignees are folded into one "Other" bar — five is
    exactly how many palette tokens a theme guarantees. */
const TOP_ASSIGNEES = 5

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0

const points = (task: Task): number => num(task.storyPoints)

/** Live = not archived, not trashed. The server's aggregate uses the same
    rule, so the two halves of a tile row cannot disagree about the denominator. */
const isLive = (task: Task): boolean => task.archivedAt === null && task.deletedAt === null

/** The board's own definition of done (a column whose category is "done"),
    with `completedAt` as the fallback for a task whose column is not in the
    given config — the same rule epic-progress.tsx uses. */
function makeIsDone(board: Board): (task: Task) => boolean {
  const columns = Array.isArray(board?.columns) ? board.columns : []
  const done = new Set(columns.filter((column) => column.category === "done").map((c) => c.id))
  const known = new Set(columns.map((column) => column.id))
  return (task) =>
    known.has(task.columnId) ? done.has(task.columnId) : task.completedAt !== null
}

function startOfToday(): number {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return now.getTime()
}

interface Computed {
  totalTasks: number
  byCategory: { open: number; active: number; done: number }
  overdue: number
  unassigned: number
  pointsTotal: number
  pointsDone: number
  byAssignee: Array<{ assignee: string; count: number }>
  sprint: { total: number; done: number; points: number; donePoints: number }
}

/** One pass over the given tasks for every locally-derived number — the
    fallback for the server aggregate and the only source for the two tiles it
    does not carry. */
function computeStats(board: Board, tasks: Task[], sprint: Sprint | null): Computed {
  const columns = Array.isArray(board?.columns) ? board.columns : []
  const category = new Map(columns.map((column) => [column.id, column.category]))
  const isDone = makeIsDone(board)
  const today = startOfToday()

  const result: Computed = {
    totalTasks: 0,
    byCategory: { open: 0, active: 0, done: 0 },
    overdue: 0,
    unassigned: 0,
    pointsTotal: 0,
    pointsDone: 0,
    byAssignee: [],
    sprint: { total: 0, done: 0, points: 0, donePoints: 0 },
  }
  const assignees = new Map<string, number>()

  for (const task of tasks) {
    if (!isLive(task)) continue
    result.totalTasks += 1
    const done = isDone(task)
    const bucket = category.get(task.columnId) ?? (done ? "done" : "open")
    if (bucket === "done") result.byCategory.done += 1
    else if (bucket === "active") result.byCategory.active += 1
    else result.byCategory.open += 1

    if (!done && task.dueDate !== null && task.dueDate < today) result.overdue += 1
    if (task.assignees.length === 0) result.unassigned += 1
    for (const name of task.assignees) assignees.set(name, (assignees.get(name) ?? 0) + 1)

    result.pointsTotal += points(task)
    if (done) result.pointsDone += points(task)

    if (sprint && task.sprintId === sprint.id) {
      result.sprint.total += 1
      result.sprint.points += points(task)
      if (done) {
        result.sprint.done += 1
        result.sprint.donePoints += points(task)
      }
    }
  }

  result.byAssignee = [...assignees.entries()]
    .map(([assignee, count]) => ({ assignee, count }))
    .sort((a, b) => b.count - a.count || a.assignee.localeCompare(b.assignee))
  return result
}

export type DashboardViewProps = PmViewProps & {
  /** pm-page hands its own Actions down; absent, the view builds one — same
      contract every other PM view has. */
  actions?: Actions
  /** Which sprint the burndown charts. Defaults to the board's active sprint,
      then to its most recently planned one. */
  sprintId?: string | null
}

export function DashboardView({ board, tasks, onOpenTask, actions: provided, sprintId }: DashboardViewProps) {
  void onOpenTask // A dashboard reports; it does not open tasks.
  const own = usePmActions()
  const actions = provided ?? own

  const [stats, setStats] = React.useState<DashboardStats | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [settled, setSettled] = React.useState(false)

  React.useEffect(() => {
    let live = true
    setStats(null)
    setError(null)
    setSettled(false)
    actions
      .fetchDashboard(board.id)
      .then((data) => {
        if (!live) return
        setStats(data)
        setSettled(true)
      })
      .catch((cause) => {
        if (!live) return
        // One panel failing is not worth a toast over the whole app: the tiles
        // fall back to the loaded tasks and say so.
        setError(describeError(cause).title)
        setSettled(true)
      })
    return () => {
      live = false
    }
  }, [actions, board.id])

  /** The sprint the burndown is about: the caller's, then the active one, then
      the newest planned one — a board with no sprint at all gets the chart's
      own "no sprint selected" empty state. */
  const sprint = React.useMemo<Sprint | null>(() => {
    const sprints = Array.isArray(board.sprints) ? board.sprints : []
    if (sprintId) return sprints.find((entry) => entry.id === sprintId) ?? null
    return (
      sprints.find((entry) => entry.state === "active") ??
      sprints.filter((entry) => entry.state === "planned").at(-1) ??
      null
    )
  }, [board.sprints, sprintId])

  const local = React.useMemo(() => computeStats(board, tasks, sprint), [board, tasks, sprint])

  /* Server aggregate where there is one, the local pass where there is not. */
  const boardWide = stats !== null
  const byCategory = stats?.byCategory ?? local.byCategory
  const overdue = boardWide ? num(stats?.overdue) : local.overdue
  const pointsTotal = boardWide ? num(stats?.pointsTotal) : local.pointsTotal
  const pointsDone = boardWide ? num(stats?.pointsDone) : local.pointsDone
  const scope = boardWide ? "Board-wide" : "In view"

  const distribution = React.useMemo(() => {
    const source = stats?.byAssignee?.length ? stats.byAssignee : local.byAssignee
    const rows = source
      .filter((entry) => entry && typeof entry.assignee === "string")
      .map((entry) => ({ name: entry.assignee || "Unassigned", count: num(entry.count) }))
      .sort((a, b) => b.count - a.count)
    if (rows.length <= TOP_ASSIGNEES) return rows
    const rest = rows.slice(TOP_ASSIGNEES).reduce((total, row) => total + row.count, 0)
    return [...rows.slice(0, TOP_ASSIGNEES), { name: `Other (${rows.length - TOP_ASSIGNEES})`, count: rest }]
  }, [stats, local.byAssignee])

  const totalTasks = boardWide ? num(stats?.totalTasks) : local.totalTasks

  if (!settled) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Skeleton className="aspect-video rounded-xl" />
          <Skeleton className="aspect-video rounded-xl" />
        </div>
      </div>
    )
  }

  if (totalTasks === 0 && local.totalTasks === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <Empty className="border border-dashed bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <span aria-hidden className="text-lg">◔</span>
            </EmptyMedia>
            <EmptyTitle>Nothing to report yet</EmptyTitle>
            <EmptyDescription>
              {error
                ? error
                : "This board has no tasks — the dashboard fills in as work lands on it."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Open"
          value={byCategory.open}
          hint={`${scope} · not started`}
          accent="var(--chart-3)"
        />
        <StatTile
          label="Active"
          value={byCategory.active}
          hint={`${scope} · in progress`}
          accent="var(--chart-1)"
        />
        <StatTile
          label="Done"
          value={byCategory.done}
          hint={`${scope} · ${totalTasks} tasks total`}
          accent="var(--chart-2)"
          ratio={totalTasks > 0 ? byCategory.done / totalTasks : 0}
        />
        <StatTile
          label="Overdue"
          value={overdue}
          hint={overdue === 0 ? `${scope} · nothing past due` : `${scope} · past their due date`}
          accent="var(--destructive)"
        />
        <StatTile
          label="Unassigned"
          value={local.unassigned}
          hint="In view · nobody on them"
          accent="var(--chart-4)"
        />
        <StatTile
          label="Points"
          value={pointsDone}
          suffix={` / ${pointsTotal}`}
          hint={`${scope} · story points done`}
          accent="var(--chart-5)"
          ratio={pointsTotal > 0 ? pointsDone / pointsTotal : 0}
        />
        <StatTile
          label={sprint ? sprint.name : "Sprint"}
          value={sprint ? local.sprint.done : 0}
          suffix={sprint ? ` / ${local.sprint.total}` : ""}
          hint={
            sprint
              ? `In view · ${local.sprint.donePoints}/${local.sprint.points} points`
              : "No active sprint"
          }
          accent="var(--chart-1)"
          ratio={sprint && local.sprint.total > 0 ? local.sprint.done / local.sprint.total : 0}
        />
        <StatTile
          label="Backlog"
          value={local.totalTasks - local.sprint.total}
          hint="In view · not in this sprint"
          accent="var(--muted-foreground)"
        />
      </div>

      {error && (
        <p className="pt-3 text-xs text-muted-foreground">
          Board totals unavailable ({error}) — every tile is counted from the tasks loaded here,
          which the filter bar narrows.
        </p>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="Burndown" subtitle={sprint?.name}>
          <BurndownChart boardId={board.id} sprintId={sprint?.id ?? null} actions={actions} />
        </Panel>
        <Panel title="Velocity">
          <VelocityChart boardId={board.id} actions={actions} />
        </Panel>
        <Panel
          title="Work by assignee"
          subtitle={boardWide ? "board-wide" : "in view"}
          className="lg:col-span-2"
        >
          <AssigneeChart data={distribution} />
        </Panel>
      </div>
    </div>
  )
}

/** A tile is a pure function of four numbers — memo'd so a filter keystroke
    upstream does not re-render eight of them for nothing. */
const StatTile = React.memo(function StatTile({
  label,
  value,
  suffix,
  hint,
  accent,
  ratio,
}: {
  label: string
  value: number
  suffix?: string
  hint: string
  accent: string
  /** 0–1; draws the thin progress rule under the number when given. */
  ratio?: number
}) {
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-center gap-2">
        <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: accent }} />
        <span className="truncate text-xs font-medium text-muted-foreground">{label}</span>
      </div>
      <p className="pt-1 text-2xl font-semibold tabular-nums">
        {value}
        {suffix ? <span className="text-base font-normal text-muted-foreground">{suffix}</span> : null}
      </p>
      {typeof ratio === "number" && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full"
            style={{
              width: `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`,
              backgroundColor: accent,
            }}
          />
        </div>
      )}
      <p className="pt-1.5 text-xs text-muted-foreground">{hint}</p>
    </div>
  )
})

function Panel({
  title,
  subtitle,
  className,
  children,
}: {
  title: string
  subtitle?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <section className={cn("rounded-xl border bg-card/40 p-3", className)}>
      <h3 className="mb-2 text-sm font-medium">
        {title}
        {subtitle && (
          <span className="ml-1.5 text-xs font-normal text-muted-foreground">{subtitle}</span>
        )}
      </h3>
      {children}
    </section>
  )
}

const DISTRIBUTION_CONFIG = {
  count: { label: "Tasks" },
} satisfies ChartConfig

/** Horizontal bars: assignees are free-form names (no accounts), so the axis
    holds arbitrary-length strings and vertical layout is the only one that can
    show them. Colours come from the five palette tokens every theme defines. */
const AssigneeChart = React.memo(function AssigneeChart({
  data,
}: {
  data: Array<{ name: string; count: number }>
}) {
  if (data.length === 0) {
    return (
      <Empty className="border border-dashed bg-card">
        <EmptyHeader>
          <EmptyTitle>Nobody assigned</EmptyTitle>
          <EmptyDescription>
            Tasks carry free-form assignee names — add one and the split appears here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <ChartContainer
      config={DISTRIBUTION_CONFIG}
      className="w-full"
      style={{ height: Math.max(160, data.length * 40 + 24) }}
    >
      <BarChart data={data} layout="vertical" margin={{ left: 4, right: 32, top: 4, bottom: 4 }}>
        <XAxis type="number" dataKey="count" hide allowDecimals={false} />
        <YAxis
          type="category"
          dataKey="name"
          width={120}
          tickLine={false}
          axisLine={false}
          tickMargin={6}
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar dataKey="count" radius={[0, 4, 4, 0]} isAnimationActive={false}>
          {data.map((entry, index) => (
            <Cell key={entry.name} fill={CHART_COLORS[index % CHART_COLORS.length]} />
          ))}
          <LabelList
            dataKey="count"
            position="right"
            className="fill-muted-foreground"
            fontSize={11}
          />
        </Bar>
      </BarChart>
    </ChartContainer>
  )
})

export default DashboardView
