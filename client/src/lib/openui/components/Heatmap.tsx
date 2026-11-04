/* ── Heatmap ──
   Values across two dimensions. The intensity is a `color-mix` of the chart's
   own hue over `--muted`, so a heatmap follows the reader's palette rather
   than a green-to-red ramp nobody chose; the number is written in every cell,
   because colour alone is not a reading.

   The grid finds the panel's width by itself: the tracks have floors in rem,
   so a narrow panel shrinks the label column and the cells rather than opening
   a scroller under a table nobody can see the end of. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Box, BoxHeader, BODY, LABEL, PAD } from "@/lib/openui/kit"

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })

export const Heatmap = defineComponent({
  name: "Heatmap",
  description: "A color-scaled grid showing values across row and column labels.",
  props: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.object({ label: z.string(), values: z.array(z.number()) })),
    title: z.string().optional(),
  }),
  component: ({ props }) => {
    const values = props.rows.flatMap((row) => row.values).filter(Number.isFinite)
    const min = Math.min(...values, 0)
    const max = Math.max(...values, 0)
    const range = max - min || 1
    const columns = Math.max(props.columns.length, 1)
    return (
      <Box className="w-full">
        {props.title && <BoxHeader title={props.title} />}
        <div className={cn("overflow-x-auto", PAD)}>
          <div
            className="grid w-full min-w-0 gap-0.5 @panel-sm:gap-1"
            style={{ gridTemplateColumns: `minmax(2.75rem, 0.7fr) repeat(${columns}, minmax(1.05rem, 1fr))` }}
          >
            <span aria-hidden="true" />
            {props.columns.map((column, index) => (
              <span
                key={`${column}-${index}`}
                className={cn(LABEL, "text-center text-[0.625rem] [overflow-wrap:anywhere] @panel-sm:truncate @panel-sm:text-[0.6875rem]")}
                title={column}
              >
                {column}
              </span>
            ))}
            {props.rows.map((row, rowIndex) => (
              <div key={`${row.label}-${rowIndex}`} className="contents">
                <span className={cn(BODY, "self-center truncate text-[0.6875rem] leading-tight")} title={row.label}>
                  {row.label}
                </span>
                {props.columns.map((column, columnIndex) => {
                  const value = row.values[columnIndex]
                  const live = Number.isFinite(value)
                  const intensity = live ? Math.round(14 + ((value - min) / range) * 86) : 0
                  return (
                    <span
                      key={`${rowIndex}-${column}-${columnIndex}`}
                      className="flex aspect-square min-h-4 items-center justify-center rounded-[3px] text-[0.625rem] tabular-nums text-foreground"
                      style={{
                        background: live ? `color-mix(in oklch, var(--chart-1) ${intensity}%, var(--muted))` : "var(--muted)",
                        opacity: live ? 1 : 0.45,
                      }}
                      title={`${row.label}, ${column}: ${live ? value : "no value"}`}
                      aria-label={`${row.label}, ${column}: ${live ? value : "no value"}`}
                    >
                      {live ? compact.format(value) : "–"}
                    </span>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      </Box>
    )
  },
})
