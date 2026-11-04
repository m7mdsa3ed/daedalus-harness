/* ── Bars ──
   Ranked values, one bar per row. A `Chart` is a plot over shared labels, and a
   `Breakdown` is the parts of one total; neither is "which of these is biggest",
   which is what hits per bug, tokens per tool and files per module all are. A
   horizontal bar leaves the label its full line (a name that is a sentence still
   reads) and puts the figure where the eye ends. Scaled to the largest value, not
   to a total: the bars compare, they do not divide. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { BODY, Box, BoxHeader, META, PAD, TONES, TONE_BAR } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

const number = new Intl.NumberFormat()

export const Bars = defineComponent({
  name: "Bars",
  description:
    "Ranked values as horizontal bars scaled to the largest, each with a label, a value, an optional hint and tone; the unit is appended to every value.",
  props: z.object({
    items: z.array(
      z.object({
        label: z.string(),
        value: z.number(),
        hint: z.string().optional(),
        tone: z.enum(TONES).optional(),
      })
    ),
    title: z.string().optional(),
    unit: z.string().optional(),
  }),
  component: ({ props }) => {
    const items = (props.items ?? []).filter((item) => item?.label && Number.isFinite(item.value))
    const max = Math.max(0, ...items.map((item) => item.value))
    const unit = props.unit ?? ""
    return (
      <Box>
        {props.title && <BoxHeader title={props.title} />}
        {items.length > 0 && (
          <ul className={cn("w-full min-w-0 list-none space-y-2", PAD)}>
            {items.map((item, index) => {
              // A value above zero never draws as nothing: a sliver still says "some".
              const width = max > 0 && item.value > 0 ? Math.max(2, (item.value / max) * 100) : 0
              return (
                <li key={index} className="min-w-0 space-y-1">
                  <div className="flex min-w-0 items-baseline justify-between gap-x-3">
                    <span className={cn(BODY, "min-w-0")}>
                      <RichText text={item.label} />
                    </span>
                    <span className="shrink-0 text-[length:calc(var(--text-sm,0.875rem)-0.0625rem)] font-medium tabular-nums text-foreground">
                      {number.format(item.value)}
                      {unit}
                    </span>
                  </div>
                  <div
                    role="img"
                    aria-label={`${item.label}: ${number.format(item.value)}${unit}`}
                    className="h-1 w-full min-w-0 overflow-hidden rounded-full bg-muted"
                  >
                    <span className={cn("block h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none", TONE_BAR[item.tone ?? "info"])} style={{ width: `${width}%` }} />
                  </div>
                  {item.hint && (
                    <p className={cn(META, "text-pretty")}>
                      <RichText text={item.hint} />
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Box>
    )
  },
})
