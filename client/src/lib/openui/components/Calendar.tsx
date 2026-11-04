/* ── Calendar ──
   One month as a grid with the marked days dotted, and the marks listed under
   it, because a dot says "something" and a 40px cell cannot say what. Days are
   1-based; weeks start on Monday. The list is the readable half on a phone. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Box, BoxHeader, META, PAD } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

const DAYS = ["M", "T", "W", "T", "F", "S", "S"]

export const Calendar = defineComponent({
  name: "Calendar",
  description: "One month grid: `year`, `month` (1-12) and marked days, each a `day` (1-31) and a `label`.",
  props: z.object({
    year: z.number(),
    month: z.number(),
    events: z.array(z.object({ day: z.number(), label: z.string() })).optional(),
  }),
  component: ({ props }) => {
    const month = Math.round(props.month)
    const year = Math.round(props.year)
    if (!(month >= 1 && month <= 12) || !Number.isFinite(year)) return null
    const first = new Date(Date.UTC(year, month - 1, 1))
    const length = new Date(Date.UTC(year, month, 0)).getUTCDate()
    const lead = (first.getUTCDay() + 6) % 7
    const marks = (props.events ?? []).filter((event) => event && event.day >= 1 && event.day <= length && event.label)
    const marked = new Set(marks.map((event) => Math.round(event.day)))
    const title = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(first)
    return (
      <Box>
        <BoxHeader title={title} />
        <div className={cn(PAD, "space-y-3")}>
          <div role="grid" aria-label={title} className="grid grid-cols-7 gap-1 text-center">
            {DAYS.map((day, index) => (
              <span key={index} aria-hidden className="py-1 text-[0.6875rem] font-medium tracking-wider text-muted-foreground">{day}</span>
            ))}
            {Array.from({ length: lead }, (_, index) => <span key={`b${index}`} aria-hidden />)}
            {Array.from({ length }, (_, index) => {
              const day = index + 1
              const on = marked.has(day)
              return (
                <span
                  key={day}
                  className={cn(
                    "relative flex aspect-square max-h-11 items-center justify-center rounded-md text-[length:calc(var(--text-sm,0.875rem)-0.0625rem)] tabular-nums",
                    on ? "bg-primary/10 font-semibold text-primary" : "text-foreground"
                  )}
                >
                  {day}
                  {on && <span aria-hidden className="absolute bottom-1 size-1 rounded-full bg-primary" />}
                </span>
              )
            })}
          </div>
          {marks.length > 0 && (
            <ul className="min-w-0 space-y-1.5 border-t border-rule pt-3">
              {[...marks].sort((a, b) => a.day - b.day).map((event, index) => (
                <li key={index} className="flex min-w-0 gap-3">
                  <span className="w-6 shrink-0 text-end text-[length:calc(var(--text-sm,0.875rem)-0.0625rem)] font-semibold text-primary tabular-nums">{Math.round(event.day)}</span>
                  <span className={cn(META, "min-w-0 text-foreground")}><RichText text={event.label} /></span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Box>
    )
  },
})
