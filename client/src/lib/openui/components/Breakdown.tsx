/**
 * A whole split into its parts: one bar, each segment as wide as its share,
 * and the shares listed under it. The compact answer to "where do these add
 * up" — a pie wants a chart's height and asks the reader to compare angles on
 * a phone, and six `Stat`s say the counts without ever saying they are one
 * number's parts.
 *
 * The legend is a wrapped list of dot, name, value and share, so the numbers
 * are the same at any width and the bar is the only thing that reflows.
 */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Box, LABEL, META, PAD, TONE_BAR, TONE_DOT } from "@/lib/openui/kit"

export const Breakdown = defineComponent({
  name: "Breakdown",
  description: "One bar split into its parts, each part's share listed under the total.",
  props: z.object({
    items: z.array(
      z.object({
        label: z.string(),
        value: z.number(),
        tone: z.enum(["neutral", "info", "success", "warn", "error"]).optional(),
      })
    ),
    title: z.string().optional(),
  }),
  component: ({ props }) => {
    const total = props.items.reduce((sum, item) => sum + Math.max(0, item.value), 0)
    const spoken = props.items.map((item) => `${item.label} ${item.value}`).join(", ")
    return (
      <Box className={cn(PAD, "space-y-2")}>
        {props.title && (
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3">
            <p className={LABEL}>{props.title}</p>
            <p className="text-[0.75rem] font-medium tabular-nums text-foreground">{total}</p>
          </div>
        )}
        <div
          className="flex h-1.5 w-full min-w-0 overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={props.title ? `${props.title}: ${spoken}` : spoken}
        >
          {total > 0 &&
            props.items.map((item, index) => (
              <span
                key={index}
                className={cn("h-full transition-[width] duration-500 ease-out motion-reduce:transition-none", TONE_BAR[item.tone ?? "neutral"])}
                style={{ width: `${(Math.max(0, item.value) / total) * 100}%` }}
              />
            ))}
        </div>
        <ul className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
          {props.items.map((item, index) => (
            <li key={index} className="flex min-w-0 items-center gap-1">
              <span className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[item.tone ?? "neutral"])} />
              <span className={cn(META, "min-w-0 break-words")}>{item.label}</span>
              <span className="text-[0.75rem] font-medium tabular-nums text-foreground">{item.value}</span>
              {total > 0 && (
                <span className={cn(META, "tabular-nums")}>{Math.round((Math.max(0, item.value) / total) * 100)}%</span>
              )}
            </li>
          ))}
        </ul>
      </Box>
    )
  },
})
