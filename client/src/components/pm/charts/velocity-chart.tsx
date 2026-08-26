/* ── Velocity ──
   Committed vs completed story points per completed sprint, with the average
   completed line as the reference a plan is actually made against.

   `GET .../reports/velocity` returns one entry per COMPLETED sprint, oldest
   first, each flagged `exact`: true when it came from the snapshot frozen at
   /complete, false when the server had to reconstruct it from current rows
   (see server/src/pm/reports.ts). The footnote names how many are estimates
   instead of pretending the whole series is exact.

   Fetched through `actions.fetchVelocity`, and — being an aggregate — kept out
   of the store: the chart owns the answer for as long as it is mounted. */
import * as React from "react"
import { Bar, BarChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts"

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
import type { VelocityEntry } from "@/lib/pm/types"
import { cn } from "@/lib/utils"

const CHART_CONFIG = {
  committedPoints: { label: "Committed", color: "var(--chart-2)" },
  completedPoints: { label: "Completed", color: "var(--chart-1)" },
} satisfies ChartConfig

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0)

interface Bucket {
  name: string
  committedPoints: number
  completedPoints: number
  exact: boolean
}

export function VelocityChart({
  boardId,
  className,
  actions: provided,
}: {
  boardId: string
  className?: string
  /** pm-page hands its own down; otherwise the chart builds one. */
  actions?: Actions
}) {
  const own = usePmActions()
  const actions = provided ?? own
  const [entries, setEntries] = React.useState<VelocityEntry[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let live = true
    setEntries(null)
    setError(null)
    actions
      .fetchVelocity(boardId)
      .then((data) => {
        if (live) setEntries(Array.isArray(data) ? data : [])
      })
      .catch((cause) => {
        if (live) setError(describeError(cause).title)
      })
    return () => {
      live = false
    }
  }, [actions, boardId])

  const data = React.useMemo<Bucket[]>(
    () =>
      (entries ?? []).map((entry, index) => ({
        name: entry?.name || `Sprint ${index + 1}`,
        committedPoints: num(entry?.committedPoints),
        completedPoints: num(entry?.completedPoints),
        exact: entry?.exact === true,
      })),
    [entries]
  )

  const average = React.useMemo(() => {
    if (data.length === 0) return 0
    const sum = data.reduce((total, bucket) => total + bucket.completedPoints, 0)
    return sum / data.length
  }, [data])

  const estimated = data.filter((bucket) => !bucket.exact).length

  if (error) {
    return (
      <Empty className="border border-dashed bg-card">
        <EmptyHeader>
          <EmptyTitle>Couldn't load velocity</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  if (!entries) {
    return (
      <div className={cn("space-y-3", className)}>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="aspect-video w-full" />
      </div>
    )
  }
  if (data.length === 0) {
    return (
      <Empty className="border border-dashed bg-card">
        <EmptyHeader>
          <EmptyTitle>No completed sprints</EmptyTitle>
          <EmptyDescription>
            Velocity is measured from sprints that have been completed — finish one and it lands
            here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className={cn("space-y-2", className)}>
      <ChartContainer config={CHART_CONFIG} className="w-full">
        <BarChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 4 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="name"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            interval="preserveStartEnd"
          />
          <YAxis tickLine={false} axisLine={false} tickMargin={8} width={32} allowDecimals={false} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <ChartLegend content={<ChartLegendContent />} />
          <ReferenceLine
            y={average}
            stroke="var(--muted-foreground)"
            strokeDasharray="4 4"
            label={{
              value: `avg ${Math.round(average * 10) / 10}`,
              position: "insideTopRight",
              fill: "var(--muted-foreground)",
              fontSize: 11,
            }}
          />
          <Bar
            dataKey="committedPoints"
            fill="var(--color-committedPoints)"
            radius={[4, 4, 0, 0]}
            isAnimationActive={false}
          />
          <Bar
            dataKey="completedPoints"
            fill="var(--color-completedPoints)"
            radius={[4, 4, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ChartContainer>
      <p className="text-xs text-muted-foreground">
        Average {Math.round(average * 10) / 10} points across {data.length} completed{" "}
        {data.length === 1 ? "sprint" : "sprints"}.
        {estimated > 0
          ? ` ${estimated} of them predate a completion snapshot and are reconstructed from today's tasks.`
          : ""}
      </p>
    </div>
  )
}

export default VelocityChart
