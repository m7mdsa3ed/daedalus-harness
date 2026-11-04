/* ── Plan ──
   A goal over a checklist, with a done count. It is the kit's `StatusRows`, the
   same row a `Checks` result is — a plan is the list before the work and checks
   are the list after it — rather than the composer's `TodoChecklist`, whose
   outlined pills are a frame per step inside the view's own frame. The count and
   the goal are the header's line, and the tally bar is how far it has got. */
import { z } from "zod/v4"
import { ArrowRight, Check } from "lucide-react"
import { defineComponent } from "@openuidev/react-lang"
import { Box, BoxHeader, StatusRows, TallyBar, ToneChip, type StatusRow } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

const STATUS = {
  done: { Icon: Check, tone: "success", word: "done" },
  active: { Icon: ArrowRight, tone: "info", word: "in progress" },
  pending: { Icon: undefined, tone: "neutral", word: "to do" },
} as const satisfies Record<string, Pick<StatusRow, "Icon" | "tone" | "word">>

export const Plan = defineComponent({
  name: "Plan",
  description: "A plan: a title and goal over checklist steps, each pending, active or done, with an optional note and priority, and a done count.",
  props: z.object({
    title: z.string(),
    steps: z.array(
      z.object({
        text: z.string(),
        status: z.enum(["done", "active", "pending"]).optional(),
        note: z.string().optional(),
        priority: z.enum(["high", "medium", "low"]).optional(),
      })
    ),
    goal: z.string().optional(),
  }),
  component: ({ props }) => {
    const steps = (props.steps ?? []).filter((step) => step?.text)
    const count = (status: keyof typeof STATUS) => steps.filter((step) => (step.status ?? "pending") === status).length
    const done = count("done")
    return (
      <Box>
        <BoxHeader
          title={props.title}
          meta={[`${done} of ${steps.length} done`, props.goal].filter(Boolean).join(" · ")}
        />
        <TallyBar parts={[{ tone: "success", count: done }, { tone: "info", count: count("active") }]} total={steps.length} />
        <StatusRows
          items={steps.map((step) => {
            const status = step.status ?? "pending"
            return {
              ...STATUS[status],
              name: <RichText text={step.text} />,
              detail: step.note ? <RichText text={step.note} /> : undefined,
              end: step.priority === "high" && status !== "done" ? <ToneChip text="high" tone="error" /> : undefined,
              dim: status === "done",
            }
          })}
        />
      </Box>
    )
  },
})
