/* ── Progress ──
   One reading against a range, drawn as a bar or, with `dial`, as a half-dial.
   The two are one component because they are one thing to a reader — a figure
   and how far along it is — and they differ only in the shape and in how much
   room they take. `Gauge` was the dial; `min`/`max` and `unit` are what it
   needed, and a bar reads them too.

   The figure is the hint when there is one, because "412 / 500" is a better
   reading than "82%" and the model already worked it out. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Progress as UiProgress, ProgressLabel, ProgressValue } from "@/components/ui/progress"
import { Box, FIG, LABEL, META, PAD, TONES } from "@/lib/openui/kit"

const STROKE = {
  neutral: "stroke-foreground",
  info: "stroke-primary",
  success: "stroke-success",
  warn: "stroke-warning",
  error: "stroke-destructive",
} as const

export const Progress = defineComponent({
  name: "Progress",
  description:
    "One reading on a 0-100 meter, or a half-dial with `dial`: a label, a value within min..max, an optional unit, tone and hint.",
  props: z.object({
    label: z.string(),
    value: z.number(),
    min: z.number().optional(),
    max: z.number().optional(),
    unit: z.string().optional(),
    tone: z.enum(TONES).optional(),
    hint: z.string().optional(),
    /** Draw a half-dial instead of a bar: one reading against a range, taking
        more room. Good for a figure that is the point of its tile. */
    dial: z.boolean().optional(),
  }),
  component: ({ props }) => {
    const min = props.min ?? 0
    const max = props.max !== undefined && props.max > min ? props.max : min + 100
    if (!props.dial) {
      return (
        <UiProgress
          value={Math.min(100, Math.max(0, ((props.value - min) / (max - min)) * 100))}
          className="w-full min-w-0 gap-x-3 gap-y-2 [&_[data-slot=progress-track]]:h-2"
        >
          <ProgressLabel className={cn(LABEL, "min-w-0 font-normal")}>{props.label}</ProgressLabel>
          <ProgressValue className="shrink-0 text-xs font-medium text-foreground tabular-nums">
            {() => props.hint ?? `${formatReading(props.value, props.unit)}`}
          </ProgressValue>
        </UiProgress>
      )
    }
    const share = Math.min(1, Math.max(0, (props.value - min) / (max - min)))
    return (
      <Box className={cn(PAD, "flex flex-col items-center gap-1.5 text-center")}>
        <p className={LABEL}>{props.label}</p>
        <svg
          viewBox="0 0 120 68"
          role="img"
          aria-label={`${props.label}: ${formatReading(props.value, props.unit)}`}
          className="w-full max-w-[14rem]"
        >
          <path d="M10 60 A50 50 0 0 1 110 60" pathLength={1} fill="none" strokeWidth={9} strokeLinecap="round" className="stroke-muted" />
          {share > 0 && (
            <path
              d="M10 60 A50 50 0 0 1 110 60"
              pathLength={1}
              strokeDasharray={`${share} 1`}
              fill="none"
              strokeWidth={9}
              strokeLinecap="round"
              className={cn("transition-[stroke-dasharray] duration-700 ease-out motion-reduce:transition-none", STROKE[props.tone ?? "info"])}
            />
          )}
        </svg>
        <p className={cn(FIG, "-mt-7")}>
          {props.value}
          {props.unit && <span className="ms-0.5 text-[0.55em] text-muted-foreground">{props.unit}</span>}
        </p>
        <p className={cn(META, "flex w-full max-w-[14rem] justify-between px-1 tabular-nums")}>
          <span>{min}</span>
          <span>{max}</span>
        </p>
        {props.hint && <p className={cn(META, "text-pretty")}>{props.hint}</p>}
      </Box>
    )
  },
})

function formatReading(value: number, unit?: string): string {
  return `${Math.round(value)}${unit ?? "%"}`
}
