/* ── Funnel ──
   Stages of one run, each as wide as the share of the first that reached it,
   and the dropped share written as a percentage. The bar is a `TONE_BAR` step
   rather than a rainbow: a funnel is one quantity narrowing, not four
   different things. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Box, BoxHeader, BODY, META, PAD } from "@/lib/openui/kit"

export const Funnel = defineComponent({
  name: "Funnel",
  description: "A staged funnel showing volume and retention through each step.",
  props: z.object({
    stages: z.array(z.object({ label: z.string(), value: z.number() })),
    title: z.string().optional(),
  }),
  component: ({ props }) => {
    const first = Math.max(0, props.stages[0]?.value ?? 0)
    return (
      <Box className="w-full">
        {props.title && <BoxHeader title={props.title} />}
        <div className={cn("space-y-2.5", PAD)}>
          {props.stages.map((stage, index) => {
            const value = Math.max(0, stage.value)
            const width = first > 0 ? Math.min(100, (value / first) * 100) : 0
            const retained = first > 0 ? Math.round((value / first) * 100) : 0
            return (
              <div key={`${stage.label}-${index}`} className="min-w-0 space-y-1">
                <div className="flex min-w-0 items-baseline justify-between gap-3">
                  <span className={cn(BODY, "min-w-0 truncate font-medium")} title={stage.label}>
                    {stage.label}
                  </span>
                  <span className={cn(META, "shrink-0 tabular-nums")}>
                    {new Intl.NumberFormat().format(value)}
                    {index > 0 && first > 0 ? ` · ${retained}%` : ""}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none" style={{ width: `${width}%`, background: "var(--primary)" }} />
                </div>
              </div>
            )
          })}
        </div>
      </Box>
    )
  },
})
