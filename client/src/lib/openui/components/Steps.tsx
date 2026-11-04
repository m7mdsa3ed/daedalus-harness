/* Numbered how-to steps: instructions the reader follows, not events over time
   (Timeline) and not a checklist with a status (Plan). A step's command is a
   recessed well of its own, so it can be selected whole; nothing here runs it.

   The number is a muted figure in the rail, the same geometry as a `Timeline`'s
   marker, so a how-to and a history are read as the same column of steps. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { BODY, Box, BoxHeader, CodeWell, WELL_PAD } from "@/lib/openui/kit"
import { cn } from "@/lib/utils"

export const Steps = defineComponent({
  name: "Steps",
  description: "Numbered how-to steps the reader follows, each with a title, optional explanation and an optional code or command block that can be copied.",
  props: z.object({
    title: z.string(),
    steps: z.array(
      z.object({
        title: z.string(),
        text: z.string().optional(),
        code: z.string().optional(),
        language: z.string().optional(),
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
          <ol role="list" className={cn(WELL_PAD, "w-full min-w-0")}>
            {steps.map((step, index) => (
              <li key={index} className="relative flex min-w-0 gap-2 pb-3 last:pb-0 @panel-sm:gap-2.5">
                {index < steps.length - 1 && (
                  <span aria-hidden className="absolute top-5 bottom-0.5 left-2 w-px bg-border" />
                )}
                <span
                  aria-hidden
                  className="mt-px flex size-4 shrink-0 items-center justify-center rounded-full text-[0.625rem] font-medium text-muted-foreground tabular-nums ring-1 ring-border ring-inset"
                >
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="text-[length:calc(var(--text-sm,0.875rem)-0.0625rem)] leading-snug font-medium break-words text-foreground">{step.title}</div>
                  {step.text && <p className={cn(BODY, "text-pretty text-muted-foreground")}>{step.text}</p>}
                  {step.code && (
                    /* The same well `Code` and `Terminal` draw through: a step's
                       command is the one thing in a how-to the reader copies. */
                    <Box>
                      <CodeWell code={step.code} language={step.language} />
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
