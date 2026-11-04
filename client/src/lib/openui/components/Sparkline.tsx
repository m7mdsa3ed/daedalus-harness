/* ── Sparkline ──
   A compact metric with its trend beside it. Hand-drawn in SVG rather than a
   chart library: it is 100x32 of polyline, and a `ResponsiveContainer` inside
   every sparkline on a page is a resize observer per figure. The line is the
   tone's colour and the area under it is the same colour drained to nothing, so
   the shape is legible without the fill competing with it. */
import { useId } from "react"
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Box, FIG, LABEL, META, PAD } from "@/lib/openui/kit"

export const Sparkline = defineComponent({
  name: "Sparkline",
  description: "A compact metric with a value, optional change, and small trend line.",
  props: z.object({
    label: z.string(),
    value: z.string(),
    values: z.array(z.number()),
    change: z.string().optional(),
    tone: z.enum(["positive", "negative", "neutral"]).optional(),
  }),
  component: ({ props }) => {
    const gradientId = `spark-${useId().replace(/:/g, "")}`
    const values = props.values.filter(Number.isFinite)
    const min = Math.min(...values, 0)
    const max = Math.max(...values, 0)
    const range = max - min || 1
    const points = values.map((value, index) => {
      const x = values.length < 2 ? 50 : (index / (values.length - 1)) * 100
      const y = 27 - ((value - min) / range) * 22
      return `${x},${y}`
    })
    const tone = props.tone ?? "neutral"
    const color = tone === "positive" ? "var(--success)" : tone === "negative" ? "var(--destructive)" : "var(--chart-1)"
    return (
      <Box className={cn("flex min-w-0 flex-row items-center justify-between gap-3", PAD)}>
        <div className="min-w-0 space-y-0.5">
          <p className={cn(LABEL, "text-balance")}>{props.label}</p>
          <p className={cn(FIG, "break-words")}>{props.value}</p>
          {props.change && (
            <p className={cn(META, tone === "positive" && "text-success", tone === "negative" && "text-destructive")}>
              {props.change}
            </p>
          )}
        </div>
        <svg className="h-10 w-24 shrink-0 overflow-visible" viewBox="0 0 100 32" role="img" aria-label={`${props.label} trend`}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {values.length > 1 && <polygon points={`0,32 ${points.join(" ")} 100,32`} fill={`url(#${gradientId})`} />}
          {values.length > 1 ? (
            <polyline points={points.join(" ")} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          ) : values.length === 1 ? (
            <circle cx="50" cy="16" r="3" fill={color} />
          ) : (
            <line x1="2" y1="16" x2="98" y2="16" stroke="var(--border)" strokeWidth="2" strokeDasharray="3 4" />
          )}
          {values.length > 1 && <circle cx="100" cy={points.at(-1)?.split(",")[1]} r="2.5" fill={color} stroke="var(--card)" strokeWidth="1.5" />}
        </svg>
      </Box>
    )
  },
})
