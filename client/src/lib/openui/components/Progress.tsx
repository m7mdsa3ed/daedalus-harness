/* ── Progress ──
   A labelled 0-100 meter: label and figure on one line, the bar under them. The
   figure is the hint when there is one, because "412 / 500" is a better reading
   than "82%" and the model already worked it out. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { Progress as UiProgress, ProgressLabel, ProgressValue } from "@/components/ui/progress"

export const Progress = defineComponent({
  name: "Progress",
  description: "A labelled 0–100 meter.",
  props: z.object({
    label: z.string(),
    value: z.number(),
    hint: z.string().optional(),
  }),
  component: ({ props }) => (
    <UiProgress value={Math.min(100, Math.max(0, props.value))} className="w-full min-w-0 gap-x-3 gap-y-2 [&_[data-slot=progress-track]]:h-2">
      <ProgressLabel className="min-w-0 text-[length:calc(var(--text-sm,0.875rem)-0.0625rem)] break-words font-normal">{props.label}</ProgressLabel>
      <ProgressValue className="shrink-0 text-[length:calc(var(--text-sm,0.875rem)-0.0625rem)] font-medium text-foreground tabular-nums">
        {() => props.hint ?? `${Math.round(props.value)}%`}
      </ProgressValue>
    </UiProgress>
  ),
})
