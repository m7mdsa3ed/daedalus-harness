/* ── Stat and StatRow ──
   One metric: its name in small caps, the figure large and tabular, the hint
   under it. On its own it is a frame; inside a `StatRow` it is a cell of the
   row's frame — which is why `Box` is asked where it is rather than told.

   The row draws each cell's right and bottom hairline as a 1px shadow, and the
   frame's `overflow-hidden` clips the ones on its outer edge, so a row that
   wraps short leaves card ground in the gap rather than the grey block a
   `gap-px` grid would. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Box, FIG, LABEL, META, PAD, SurfaceContext } from "@/lib/openui/kit"

export const Stat = defineComponent({
  name: "Stat",
  description: "A single metric: a label, a value, an optional delta (\"+12%\", \"-3\") and a hint.",
  props: z.object({
    label: z.string(),
    value: z.string(),
    hint: z.string().optional(),
    delta: z.string().optional(),
  }),
  component: ({ props }) => {
    // A delta opens with its direction: "+12%" is good news, "-3" is not, and
    // anything else is drawn neutral.
    const d = props.delta?.trim()
    const ink = !d ? "" : /^[+↑]/.test(d) ? "text-success" : /^[-−↓]/.test(d) ? "text-destructive" : "text-muted-foreground"
    return (
      <Box className={cn(PAD, "space-y-1.5")}>
        <p className={cn(LABEL, "text-balance")}>{props.label}</p>
        <p className={cn(FIG, "break-words")}>{props.value}</p>
        {(d || props.hint) && (
          <p className={cn(META, "flex flex-wrap items-baseline gap-x-2 text-pretty")}>
            {d && <span className={cn("font-medium tabular-nums", ink)}>{d}</span>}
            {props.hint && <span>{props.hint}</span>}
          </p>
        )}
      </Box>
    )
  },
})

export const StatRow = defineComponent({
  name: "StatRow",
  description: "A row of metrics across the width of the page.",
  props: z.object({
    stats: z.array(Stat.ref),
  }),
  component: ({ props, renderNode }) => (
    <Box
      className={cn(
        "grid [&>*]:shadow-[1px_0_0_0_var(--border),0_1px_0_0_var(--border)]",
        props.stats.length > 1
          ? "grid-cols-2 @panel-sm:grid-cols-[repeat(auto-fit,minmax(10rem,1fr))]"
          : "grid-cols-1"
      )}
    >
      <SurfaceContext.Provider value="cell">{renderNode(props.stats)}</SurfaceContext.Provider>
    </Box>
  ),
})
