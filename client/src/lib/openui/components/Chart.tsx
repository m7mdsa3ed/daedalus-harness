/* ── Chart ──
   `labels` on the x-axis, `series` one mark each, the value at index `i`
   belonging to `labels[i]`. Colours are the app's `--chart-*` tokens, so a
   drawn chart follows the reader's palette; the legend wraps, because six
   series in a 320px panel is a row of names, not a row of chips.

   `pie`/`donut` read the first series only — a slice per label. */
import { useId } from "react"
import { z } from "zod/v4"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  XAxis,
  YAxis,
} from "recharts"
import { defineComponent } from "@openuidev/react-lang"
import { Box, BoxHeader, chartColor } from "@/lib/openui/kit"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"

export const Chart = defineComponent({
  name: "Chart",
  description:
    "A full-width chart over shared labels: line, bar, area, radar, or pie/donut (first series only, one slice per label), with an optional title.",
  props: z.object({
    kind: z.enum(["line", "bar", "area", "pie", "donut", "radar"]),
    labels: z.array(z.string()),
    series: z.array(
      z.object({
        name: z.string(),
        values: z.array(z.number()),
      })
    ),
    height: z.number().optional(),
    stacked: z.boolean().optional(),
    title: z.string().optional(),
  }),
  component: ({ props }) => {
    const round = props.kind === "pie" || props.kind === "donut"
    const data = props.labels.map((label, index) => {
      const row: Record<string, string | number> = { label }
      for (const series of props.series) row[series.name] = series.values[index] ?? 0
      return row
    })
    // One series has nothing to be told apart from, and `--chart-1` is the palette's
    // palest step in the stock theme, so it draws in the theme's primary instead.
    const single = !round && props.series.length === 1
    const colorOf = (index: number) => (single ? "var(--primary)" : chartColor(index))
    const config = Object.fromEntries(
      round
        ? props.labels.map((label, index) => [label, { label, color: chartColor(index) }])
        : props.series.map((series, index) => [series.name, { label: series.name, color: colorOf(index) }])
    )
    const chartId = useId().replace(/:/g, "")
    const stack = props.stacked ? "a" : undefined
    const chartHeight = Math.min(480, Math.max(160, props.height ?? (round || props.kind === "radar" ? 260 : 220)))
    const axes = (
      <>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={6} interval="preserveStartEnd" />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={32}
          tickFormatter={(value: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value)}
        />
        <ChartTooltip content={<ChartTooltipContent />} />
      </>
    )
    const margin = { left: 0, right: 8, top: 10, bottom: 0 }
    const legend = <ChartLegend content={<ChartLegendContent nameKey={round ? "label" : undefined} className="flex-wrap gap-x-3 gap-y-1" />} />
    return (
      <Box className="w-full">
        {props.title && <BoxHeader title={props.title} />}
        <div className="w-full min-w-0 px-1.5 pt-3 pb-1.5 @panel-sm:px-3">
          <ChartContainer config={config} className="aspect-auto w-full min-w-0" style={{ height: `${chartHeight}px` }}>
            {round ? (
              <PieChart>
                <ChartTooltip content={<ChartTooltipContent nameKey="label" hideLabel />} />
                <Pie
                  data={props.labels.map((label, index) => ({ label, value: props.series[0]?.values[index] ?? 0 }))}
                  dataKey="value"
                  nameKey="label"
                  innerRadius={props.kind === "donut" ? "60%" : 0}
                  outerRadius="80%"
                  isAnimationActive={false}
                >
                  {props.labels.map((label, index) => (
                    <Cell key={`${label}-${index}`} fill={chartColor(index)} />
                  ))}
                </Pie>
                {legend}
              </PieChart>
            ) : props.kind === "radar" ? (
              <RadarChart data={data} outerRadius="76%">
                <PolarGrid />
                <PolarAngleAxis dataKey="label" tick={{ fill: "var(--muted-foreground)" }} />
                <ChartTooltip content={<ChartTooltipContent />} />
                {props.series.map((series, index) => (
                  <Radar key={series.name} isAnimationActive={false} dataKey={series.name} stroke={colorOf(index)} fill={colorOf(index)} fillOpacity={0.3} />
                ))}
                {legend}
              </RadarChart>
            ) : props.kind === "bar" ? (
              <BarChart data={data} margin={margin}>
                {axes}
                {props.series.map((series, index) => (
                  <Bar
                    key={series.name}
                    dataKey={series.name}
                    stackId={stack}
                    fill={colorOf(index)}
                    radius={stack ? 0 : 4}
                    maxBarSize={props.series.length > 1 ? 24 : 40}
                    isAnimationActive={false}
                  />
                ))}
                {legend}
              </BarChart>
            ) : props.kind === "area" ? (
              <AreaChart data={data} margin={margin}>
                <defs>
                  {props.series.map((series, index) => (
                    <linearGradient key={series.name} id={`${chartId}-area-${index}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={colorOf(index)} stopOpacity={0.7} />
                      <stop offset="95%" stopColor={colorOf(index)} stopOpacity={0.05} />
                    </linearGradient>
                  ))}
                </defs>
                {axes}
                {props.series.map((series, index) => (
                  <Area
                    key={series.name}
                    type="monotone"
                    dataKey={series.name}
                    stackId={stack}
                    isAnimationActive={false}
                    stroke={colorOf(index)}
                    fill={`url(#${chartId}-area-${index})`}
                  />
                ))}
                {legend}
              </AreaChart>
            ) : (
              <LineChart data={data} margin={margin}>
                {axes}
                {props.series.map((series, index) => (
                  <Line key={series.name} isAnimationActive={false} type="monotone" dataKey={series.name} stroke={colorOf(index)} strokeWidth={1.75} dot={data.length < 2} />
                ))}
                {legend}
              </LineChart>
            )}
          </ChartContainer>
        </div>
      </Box>
    )
  },
})
