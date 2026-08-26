/* ── Sprint burndown ──
   Ideal vs actual remaining points across the sprint window. The series is
   built server-side (`GET .../reports/burndown?sprintId=`) — a report is an
   aggregate, never a task list, so nothing here reduces over tasks and nothing
   enters the store: the chart owns the one response it asked for and forgets
   it when it unmounts.

   The server reconstructs the series from CURRENT sprint membership plus each
   task's completedAt, which is approximate for mid-sprint scope changes (see
   server/src/pm/reports.ts) — the footnote under the chart says so rather than
   letting the line imply a history the database does not keep.

   The fetch is `actions.fetchBurndown` — like every other PM call it goes
   through lib/actions.ts, and like comments and activity its answer never
   enters the store. */
import * as React from "react"
import { format } from "date-fns"
import {
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts"

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { usePmActions } from "@/components/pm/pm-sidebar-panels"
import type { Actions } from "@/lib/actions"
import { describeError } from "@/lib/errors"
import type { Burndown } from "@/lib/pm/types"
import { cn } from "@/lib/utils"

const CHART_CONFIG = {
  remaining: { label: "Remaining", color: "var(--chart-1)" },
  ideal: { label: "Ideal", color: "var(--chart-3)" },
} satisfies ChartConfig

/** A report field can be absent (an older server, a partial shape) — every
    number the chart plots goes through this rather than rendering NaN. */
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0)

interface Point {
  date: number
  remaining: number
  ideal: number
}

export function BurndownChart({
  boardId,
  sprintId,
  className,
  actions: provided,
}: {
  boardId: string
  sprintId: string | null | undefined
  className?: string
  /** pm-page hands its own down; otherwise the chart builds one, like every
      other router-rendered PM component. */
  actions?: Actions
}) {
  const own = usePmActions()
  const actions = provided ?? own
  const [report, setReport] = React.useState<Burndown | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!sprintId) {
      setReport(null)
      setError(null)
      return
    }
    let live = true
    setReport(null)
    setError(null)
    actions
      .fetchBurndown(boardId, sprintId)
      .then((data) => {
        if (live) setReport(data)
      })
      .catch((cause) => {
        if (!live) return
        // A report failing is not worth a toast over the whole app — it is one
        // panel, and it says so in place.
        setError(describeError(cause).title)
      })
    return () => {
      live = false
    }
  }, [actions, boardId, sprintId])

  const data = React.useMemo<Point[]>(() => {
    const series = Array.isArray(report?.series) ? report.series : []
    return series.map((point) => ({
      date: num(point?.date),
      remaining: num(point?.remaining),
      ideal: num(point?.ideal),
    }))
  }, [report])

  if (!sprintId) {
    return <BurndownEmpty title="No sprint selected" detail="Pick a sprint to see its burndown." />
  }
  if (error) {
    return <BurndownEmpty title="Couldn't load the burndown" detail={error} />
  }
  if (!report) {
    return (
      <div className={cn("space-y-3", className)}>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="aspect-video w-full" />
      </div>
    )
  }
  if (data.length === 0) {
    return (
      <BurndownEmpty
        title="Nothing to burn down yet"
        detail={
          num(report.totalPoints) === 0
            ? "The sprint's tasks have no story points."
            : "The sprint needs a start and an end date before it can be charted."
        }
      />
    )
  }

  return (
    <div className={cn("space-y-2", className)}>
      <ChartContainer config={CHART_CONFIG} className="w-full">
        <LineChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 4 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="date"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
            tickFormatter={(value) => format(num(value), "MMM d")}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            width={32}
            allowDecimals={false}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(_label, payload) =>
                  format(num(payload?.[0]?.payload?.date), "EEE, MMM d")
                }
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          <Line
            dataKey="ideal"
            type="linear"
            stroke="var(--color-ideal)"
            strokeDasharray="4 4"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            dataKey="remaining"
            type="monotone"
            stroke="var(--color-remaining)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ChartContainer>
      <p className="text-xs text-muted-foreground">
        {num(report.totalPoints)} points over {num(report.totalTasks)} tasks. Reconstructed from the
        sprint's current membership, so scope added mid-sprint reads as committed from day one.
      </p>
    </div>
  )
}

function BurndownEmpty({ title, detail }: { title: string; detail: string }) {
  return (
    <Empty className="border border-dashed bg-card">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{detail}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

export default BurndownChart
