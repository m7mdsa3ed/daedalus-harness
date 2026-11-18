/* ── Stat ──
   One metric: its name, the figure large and tabular, the delta
   and hint under it, and with `values` a small trend line beside it (what
   `Sparkline` was). A row of them is a `Grid` of Stats. On the page it is a
   `Box` — a metric tile like every other framed block, so a Grid of them is a
   row of tiles. Inside a frame (a `Card` that is already the tile) it is
   bare, never a well in a tile. The start hairline it used to wear was the
   one side stripe left in the library.

   The trend is hand-drawn SVG rather than a chart library: it is 100x32 of
   polyline, and a `ResponsiveContainer` per figure is a resize observer per
   figure. It takes the delta's colour, so the line and the number agree. */
import { useContext, useId } from "react"
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Box, FIG, META, PAD, SurfaceContext } from "@/lib/openui/kit"

export const Stat = defineComponent({
  name: "Stat",
  description:
    "A single metric: a label, a value, an optional hint, a delta (\"+12%\", \"-3\") whose sign colours it, and `values` for a small trend line beside it.",
  props: z.object({
    label: z.string(),
    value: z.string(),
    hint: z.string().optional(),
    delta: z.string().optional(),
    values: z.array(z.number()).optional(),
  }),
  component: ({ props }) => {
    const framed = useContext(SurfaceContext) === "page"
    // A delta opens with its direction: "+12%" is good news, "-3" is not, and
    // anything else is drawn neutral.
    const d = props.delta?.trim()
    const up = !!d && /^[+↑]/.test(d)
    const down = !!d && /^[-−↓]/.test(d)
    const ink = !d ? "" : up ? "text-success" : down ? "text-destructive" : "text-muted-foreground"
    const trend = (props.values ?? []).filter(Number.isFinite)
    const body = (
      <div className={cn("flex w-full min-w-0 items-center justify-between gap-3", framed && PAD)}>
        <div className="min-w-0 space-y-0.5">
          {/* The app's own metric tile: a `text-sm` muted name over the figure
              and a `text-xs` hint under it, so a `Stat` in an answer and a
              tile on a project page are read the same way. */}
          <p className="min-w-0 text-sm leading-snug break-words text-muted-foreground">{props.label}</p>
          <p className={cn(FIG, "break-words")}>{props.value}</p>
          {(d || props.hint) && (
            <p className={cn(META, "flex flex-wrap items-baseline gap-x-2 text-pretty")}>
              {d && <span className={cn("font-medium tabular-nums", ink)}>{d}</span>}
              {props.hint && <span>{props.hint}</span>}
            </p>
          )}
        </div>
        {trend.length > 0 && <Trend values={trend} label={props.label} color={up ? "var(--success)" : down ? "var(--destructive)" : "var(--chart-1)"} />}
      </div>
    )
    return framed ? <Box className="h-full">{body}</Box> : body
  },
})

function Trend({ values, label, color }: { values: number[]; label: string; color: string }) {
  const gradientId = `spark-${useId().replace(/:/g, "")}`
  const min = Math.min(...values, 0)
  const max = Math.max(...values, 0)
  const range = max - min || 1
  const points = values.map((value, index) => {
    const x = values.length < 2 ? 50 : (index / (values.length - 1)) * 100
    const y = 27 - ((value - min) / range) * 22
    return `${x},${y}`
  })
  return (
    <svg className="h-10 w-24 shrink-0 overflow-visible" viewBox="0 0 100 32" role="img" aria-label={`${label} trend`}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {values.length > 1 ? (
        <>
          <polygon points={`0,32 ${points.join(" ")} 100,32`} fill={`url(#${gradientId})`} />
          <polyline points={points.join(" ")} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="100" cy={points.at(-1)?.split(",")[1]} r="2.5" fill={color} stroke="var(--card)" strokeWidth="1.5" />
        </>
      ) : (
        <circle cx="50" cy="16" r="3" fill={color} />
      )}
    </svg>
  )
}
