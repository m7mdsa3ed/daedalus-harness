/* Numbered how-to steps: instructions the reader follows, not events over time
   (Timeline) and not a checklist with a status (Plan). A step's command is a
   recessed well of its own, so it can be selected whole; nothing here runs it. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { BODY, Box, BoxHeader, PAD } from "@/lib/openui/kit"
import { cn } from "@/lib/utils"

export const Steps = defineComponent({
  name: "Steps",
  description: "Numbered how-to steps the reader follows, each with a title, optional explanation and an optional code or command block.",
  props: z.object({
    title: z.string(),
    steps: z.array(
      z.object({
        title: z.string(),
        text: z.string().optional(),
        code: z.string().optional(),
      })
    ),
  }),
  component: ({ props }) => {
    // The view streams in: a row may exist before its title does, and the array
    // before its first row.
    const steps = (props.steps ?? []).filter(Boolean)
    return (
      <Box>
        <BoxHeader title={props.title} />
        {steps.length > 0 && (
          <ol role="list" className={cn(PAD, "w-full min-w-0")}>
            {steps.map((step, index) => (
              <li key={index} className="relative flex min-w-0 gap-2.5 pb-4 last:pb-0 @panel-sm:gap-3">
                {index < steps.length - 1 && (
                  <span aria-hidden className="absolute top-6 bottom-1 left-2.5 w-px -translate-x-1/2 bg-border" />
                )}
                <span
                  aria-hidden
                  className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-medium text-primary tabular-nums ring-1 ring-primary ring-inset"
                >
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1 space-y-1.5 pt-px">
                  <div className="text-sm leading-snug font-medium break-words text-foreground">{step.title}</div>
                  {step.text && <p className={cn(BODY, "text-pretty")}>{step.text}</p>}
                  {step.code && (
                    <Box>
                      <pre
                        tabIndex={0}
                        className="overflow-auto px-3 py-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground"
                      >
                        {step.code}
                      </pre>
                    </Box>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Box>
    )
  },
})
