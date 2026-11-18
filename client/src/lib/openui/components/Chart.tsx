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
  Scatter,
  ScatterChart,
  LabelList,
  XAxis,
  YAxis,
} from "recharts"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { BODY, chartColor, formatCompact, formatNumber, LABEL, META, Meter, TitledFrame } from "@/lib/openui/kit"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"

export const Chart = defineComponent({
  name: "Chart",
  description:
    "A full-width chart over shared labels: line, bar, area, radar, or pie/donut (first series only, one slice per label), with an optional title. `scatter` plots each label as one point at (first series, second series), the two series' names titling the axes.",
  props: z.object({
    /* `heatmap`, `funnel` and `waterfall` are the three shapes that used to be
       components of their own. They are plots over shared labels and one series
       like every other kind here, so they take the same props: a heatmap's rows
       are its labels and its series is each column, a funnel's stages are
       labels and its one series is the volume reaching each, and a waterfall's
       items are labels whose values are the changes. `scatter` keeps the same
       bargain rather than adding an `{x, y}` point list: each label is a point,
       the first series its x and the second its y, and their names are the
       axes' — so a scatter costs the model no shape it has not written. */
    kind: z.enum(["line", "bar", "area", "pie", "donut", "radar", "scatter", "heatmap", "funnel", "waterfall"]),
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
    const scatterAxes = { x: props.series[0]?.name ?? "x", y: props.series[1]?.name ?? "y" }
    const scatterPoints =
      props.kind === "scatter"
        ? props.labels.flatMap((label, index) => {
            const x = props.series[0]?.values[index]
            const y = props.series[1]?.values[index]
            // A point missing a coordinate is not at zero; it is not drawn.
            return typeof x === "number" && typeof y === "number" ? [{ label, x, y }] : []
          })
        : []
    const config = props.kind === "scatter"
      ? { x: { label: scatterAxes.x }, y: { label: scatterAxes.y } }
      : Object.fromEntries(
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
          tickFormatter={(value: number) => formatCompact(value)}
        />
        <ChartTooltip content={<ChartTooltipContent />} />
      </>
    )
    const margin = { left: 0, right: 8, top: 10, bottom: 0 }
    const legend = <ChartLegend content={<ChartLegendContent nameKey={round ? "label" : undefined} className="flex-wrap gap-x-3 gap-y-1" />} />
    return (
      <TitledFrame title={props.title} pad={false} className="px-2 pt-3 pb-2 @panel-sm:px-3">
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
                  {props.labels.map((_, index) => (
                    <Cell key={index} fill={chartColor(index)} />
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
                  <Radar key={index} isAnimationActive={false} dataKey={series.name} stroke={colorOf(index)} fill={colorOf(index)} fillOpacity={0.3} />
                ))}
                {legend}
              </RadarChart>
            ) : props.kind === "bar" ? (
              <BarChart data={data} margin={margin}>
                {axes}
                {props.series.map((series, index) => (
                  <Bar
                    key={index}
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
                  {props.series.map((_, index) => (
                    <linearGradient key={index} id={`${chartId}-area-${index}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={colorOf(index)} stopOpacity={0.7} />
                      <stop offset="95%" stopColor={colorOf(index)} stopOpacity={0.05} />
                    </linearGradient>
                  ))}
                </defs>
                {axes}
                {props.series.map((series, index) => (
                  <Area
                    key={index}
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
            ) : props.kind === "scatter" ? (
              <ScatterChart margin={{ ...margin, top: 16 }}>
                <CartesianGrid />
                <XAxis
                  type="number"
                  dataKey="x"
                  name={scatterAxes.x}
                  domain={["auto", "auto"]}
                  tickLine={false}
                  axisLine={false}
                  tickMargin={6}
                  tickFormatter={(value: number) => formatCompact(value)}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name={scatterAxes.y}
                  domain={["auto", "auto"]}
                  tickLine={false}
                  axisLine={false}
                  width={32}
                  tickFormatter={(value: number) => formatCompact(value)}
                />
                <ChartTooltip
                  cursor={{ strokeDasharray: "3 3" }}
                  content={<ChartTooltipContent labelFormatter={(_, payload) => String(payload?.[0]?.payload?.label ?? "")} />}
                />
                <Scatter data={scatterPoints} fill="var(--primary)" isAnimationActive={false}>
                  {/* Named points are the point of a scatter of a dozen things;
                      past that the names are a smear, and the tooltip names each. */}
                  {scatterPoints.length <= 12 && <LabelList dataKey="label" position="top" offset={8} fill="var(--muted-foreground)" fontSize={10} />}
                </Scatter>
              </ScatterChart>
            ) : props.kind === "heatmap" ? (
              <HeatmapPlot labels={props.labels} series={props.series} />
            ) : props.kind === "funnel" ? (
              <FunnelPlot labels={props.labels} values={props.series[0]?.values ?? []} />
            ) : props.kind === "waterfall" ? (
              <WaterfallPlot labels={props.labels} values={props.series[0]?.values ?? []} />
            ) : (
              <LineChart data={data} margin={margin}>
                {axes}
                {props.series.map((series, index) => (
                  <Line key={index} isAnimationActive={false} type="monotone" dataKey={series.name} stroke={colorOf(index)} strokeWidth={1.75} dot={data.length < 2} />
                ))}
                {legend}
              </LineChart>
            )}
          </ChartContainer>
          {props.kind === "scatter" && (
            <p className={cn(META, "px-1 pt-1 text-center")}>
              x: {scatterAxes.x} · y: {scatterAxes.y}
            </p>
          )}
      </TitledFrame>
    )
  },
})

/* ── The three plots that used to be components ──
   Each is a series over shared labels, which is what a `Chart` already is; they
   draw inside its frame rather than one of their own, so `title` and the frame's
   inset are shared with every other kind.

   `heatmap` reads the labels as the row names and one series as one column, so
   the grid is `labels × series` and a row is a label with a value per series.
   `funnel` and `waterfall` read one series: a stage's volume and a change's
   amount. Bare `<svg>` and a plain grid, like `Sparkline` — these are small
   drawings that should not cost a chart library's renderer. */

function HeatmapPlot({ labels, series }: { labels: string[]; series: { name: string; values: number[] }[] }) {
  const values = series.flatMap((s) => s.values).filter(Number.isFinite)
  const min = Math.min(...values, 0)
  const max = Math.max(...values, 0)
  const range = max - min || 1
  if (labels.length === 0 || series.length === 0) return null
  return (
    <div
      role="table"
      className="grid w-full min-w-0 gap-0.5 p-1 @panel-sm:gap-1"
      style={{ gridTemplateColumns: `minmax(2.75rem, 0.7fr) repeat(${series.length}, minmax(1.05rem, 1fr))` }}
    >
      <span aria-hidden />
      {series.map((s, index) => (
        <span key={index} className={cn("truncate text-center", LABEL)} title={s.name}>
          {s.name}
        </span>
      ))}
      {labels.map((label, rowIndex) => (
        <div key={rowIndex} role="row" className="contents">
          <span role="rowheader" className="self-center truncate text-xs leading-tight text-foreground" title={label}>
            {label}
          </span>
          {series.map((s, columnIndex) => {
            const value = s.values[rowIndex]
            const live = Number.isFinite(value)
            const intensity = live ? Math.round(14 + ((value - min) / range) * 86) : 0
            return (
              <span
                key={columnIndex}
                role="cell"
                className="flex aspect-square min-h-4 items-center justify-center rounded-[4px] text-[0.6875rem] tabular-nums text-foreground"
                style={{
                  background: live ? `color-mix(in oklch, var(--chart-1) ${intensity}%, var(--muted))` : "var(--muted)",
                  opacity: live ? 1 : 0.45,
                }}
                title={`${label}, ${s.name}: ${live ? value : "no value"}`}
              >
                {live ? formatCompact(value) : "–"}
              </span>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function FunnelPlot({ labels, values }: { labels: string[]; values: number[] }) {
  const first = Math.max(0, values[0] ?? 0)
  if (labels.length === 0) return null
  return (
    <ul className="min-w-0 list-none space-y-2.5 p-1">
      {labels.map((label, index) => {
        const value = Math.max(0, values[index] ?? 0)
        const retained = first > 0 ? Math.round((value / first) * 100) : 0
        return (
          <li key={index} className="min-w-0 space-y-1">
            <div className="flex min-w-0 items-baseline justify-between gap-3">
              <span className={cn("min-w-0 truncate font-medium text-foreground", BODY)} title={label}>
                {label}
              </span>
              <span className={cn("shrink-0 tabular-nums", META)}>
                {formatNumber(value)}
                {index > 0 && first > 0 ? ` · ${retained}%` : ""}
              </span>
            </div>
            <Meter value={value} max={first} height="h-1.5" color="var(--primary)" floor={0} />
          </li>
        )
      })}
    </ul>
  )
}

function WaterfallPlot({ labels, values }: { labels: string[]; values: number[] }) {
  const running: number[] = []
  let current = 0
  for (const value of values) {
    current += value
    running.push(current)
  }
  const bounds = values.flatMap((_, index) => [index === 0 ? 0 : running[index - 1], running[index]])
  const min = Math.min(0, ...bounds)
  const max = Math.max(0, ...bounds)
  const range = max - min || 1
  const top = 14
  const bottom = 158
  const width = Math.max(300, labels.length * 52)
  const y = (value: number) => top + ((max - value) / range) * (bottom - top)
  const step = labels.length ? width / labels.length : width
  const bar = Math.min(38, step * 0.56)
  if (labels.length === 0) return null
  return (
    <div className="overflow-x-auto">
      <svg className="h-48 w-full" style={{ minWidth: `${width}px` }} viewBox={`0 0 ${width} 190`} role="img" aria-label="Waterfall chart">
        <line x1="0" x2={width} y1={y(0)} y2={y(0)} stroke="var(--border)" strokeDasharray="3 4" />
        {labels.map((label, index) => {
          const before = index === 0 ? 0 : running[index - 1]
          const after = running[index]
          const barTop = Math.min(y(before), y(after))
          const height = Math.max(2, Math.abs(y(after) - y(before)))
          const x = index * step + (step - bar) / 2
          const fill = values[index] < 0 ? "var(--destructive)" : "var(--chart-2)"
          return (
            <g key={index}>
              {index < labels.length - 1 && (
                <line x1={x + bar} x2={(index + 1) * step + (step - bar) / 2} y1={y(after)} y2={y(after)} stroke="var(--muted-foreground)" strokeOpacity="0.35" strokeDasharray="3 3" />
              )}
              <rect x={x} y={barTop} width={bar} height={height} rx="3" fill={fill}>
                <title>{`${label}: ${formatNumber(values[index])}`}</title>
              </rect>
              <text x={x + bar / 2} y={Math.max(11, barTop - 4)} textAnchor="middle" className="fill-muted-foreground" fontSize="10">
                {formatCompact(values[index])}
              </text>
              <text x={x + bar / 2} y="178" textAnchor="middle" className="fill-muted-foreground" fontSize="11">
                {label.length > 11 ? `${label.slice(0, 10)}…` : label}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
