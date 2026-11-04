/* ── Waterfall ──
   How a set of changes builds to a total. Up is `--chart-2`, down is
   `--destructive`, and a total is `--chart-1` from the floor — the one bar
   that starts at zero, so the eye can find the answer at the end of the run.

   The width has a floor in rem for the bar count rather than a fixed size: a
   waterfall opens a scroller only when two bars no longer fit, and never at a
   phone panel's width. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Box, BoxHeader, META, PAD } from "@/lib/openui/kit"

export const Waterfall = defineComponent({
  name: "Waterfall",
  description: "A waterfall chart showing how positive and negative changes build to a total.",
  props: z.object({
    items: z.array(z.object({ label: z.string(), value: z.number(), total: z.boolean().optional() })),
    title: z.string().optional(),
  }),
  component: ({ props }) => {
    const running: number[] = []
    let current = 0
    for (const item of props.items) {
      const next = item.total ? item.value : current + item.value
      running.push(next)
      current = next
    }
    const bounds = props.items.flatMap((item, index) => [item.total ? 0 : index === 0 ? 0 : running[index - 1], running[index]])
    const min = Math.min(0, ...bounds)
    const max = Math.max(0, ...bounds)
    const range = max - min || 1
    const chartTop = 14
    const chartBottom = 158
    // The floor is a phone panel's content width, so a waterfall does not open a
    // scroller the reader has to drag to see the total at the end of it.
    const chartWidth = Math.max(300, props.items.length * 52)
    const y = (value: number) => chartTop + ((max - value) / range) * (chartBottom - chartTop)
    const step = props.items.length ? chartWidth / props.items.length : chartWidth
    const barWidth = Math.min(38, step * 0.56)
    return (
      <Box className="w-full overflow-hidden">
        {props.title && <BoxHeader title={props.title} />}
        {props.items.length === 0 ? (
          <div className={cn(META, PAD)}>No values to chart.</div>
        ) : (
          <div className="overflow-x-auto px-2 py-2 @panel-sm:px-3">
            <svg
              className="h-48 w-full"
              style={{ minWidth: `${chartWidth}px` }}
              viewBox={`0 0 ${chartWidth} 190`}
              role="img"
              aria-label={props.title ?? "Waterfall chart"}
            >
              <line x1="0" x2={chartWidth} y1={y(0)} y2={y(0)} stroke="var(--border)" strokeDasharray="3 4" />
              {props.items.map((item, index) => {
                const before = index === 0 ? 0 : running[index - 1]
                const after = running[index]
                const start = item.total ? 0 : before
                const top = Math.min(y(start), y(after))
                const height = Math.max(2, Math.abs(y(after) - y(start)))
                const x = index * step + (step - barWidth) / 2
                const fill = item.total ? "var(--chart-1)" : item.value < 0 ? "var(--destructive)" : "var(--chart-2)"
                return (
                  <g key={`${item.label}-${index}`}>
                    {index < props.items.length - 1 && (
                      <line
                        x1={x + barWidth}
                        x2={(index + 1) * step + (step - barWidth) / 2}
                        y1={y(after)}
                        y2={y(after)}
                        stroke="var(--muted-foreground)"
                        strokeOpacity="0.35"
                        strokeDasharray="3 3"
                      />
                    )}
                    <rect x={x} y={top} width={barWidth} height={height} rx="3" fill={fill}>
                      <title>{`${item.label}: ${new Intl.NumberFormat().format(item.value)}${item.total ? " (total)" : ""}`}</title>
                    </rect>
                    <text x={x + barWidth / 2} y={Math.max(11, top - 4)} textAnchor="middle" className="fill-muted-foreground" fontSize="10">
                      {new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(item.value)}
                    </text>
                    <text x={x + barWidth / 2} y="178" textAnchor="middle" className="fill-muted-foreground" fontSize="11">
                      {item.label.length > 11 ? `${item.label.slice(0, 10)}…` : item.label}
                    </text>
                  </g>
                )
              })}
            </svg>
          </div>
        )}
      </Box>
    )
  },
})
