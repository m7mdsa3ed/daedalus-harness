/* ── Stepper ──
   Where a process stands: a run of stages with one current. Horizontal where
   the panel allows, a vertical rail below it. `current` is a 1-based stage. */
import { z } from "zod/v4"
import { Check } from "lucide-react"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { META } from "@/lib/openui/kit"

export const Stepper = defineComponent({
  name: "Stepper",
  description: "Stages of a process with the current one marked: labels and a 1-based `current`.",
  props: z.object({ stages: z.array(z.string()), current: z.number() }),
  component: ({ props }) => {
    const stages = (props.stages ?? []).filter(Boolean)
    const at = Math.round(props.current ?? 0)
    return (
      <ol className="flex w-full min-w-0 flex-col gap-3 @panel-sm:flex-row @panel-sm:gap-0">
        {stages.map((stage, index) => {
          const n = index + 1
          const done = n < at
          const now = n === at
          return (
            <li key={index} aria-current={now ? "step" : undefined} className="flex min-w-0 flex-1 items-center gap-2.5 @panel-sm:flex-col @panel-sm:items-start @panel-sm:gap-2">
              <div className="flex items-center @panel-sm:w-full">
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full text-[0.75rem] font-semibold tabular-nums ring-1 ring-inset",
                    done && "bg-primary text-primary-foreground ring-primary",
                    now && "bg-primary/10 text-primary ring-2 ring-primary",
                    !done && !now && "text-muted-foreground ring-border"
                  )}
                >
                  {done ? <Check className="size-3.5" strokeWidth={3} /> : n}
                </span>
                {index < stages.length - 1 && <span aria-hidden className={cn("ms-2 hidden h-px flex-1 @panel-sm:block", done ? "bg-primary" : "bg-border")} />}
              </div>
              <span className={cn(META, "pe-2 text-pretty", now && "font-medium text-foreground")}>{stage}</span>
            </li>
          )
        })}
      </ol>
    )
  },
})
