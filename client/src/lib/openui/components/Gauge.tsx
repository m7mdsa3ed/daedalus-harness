/* ── Gauge ──
   One reading against a range: a half-dial with the figure under its arc. The
   tone follows the model's call (`tone`), never a threshold we invent. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Box, FIG, LABEL, META, PAD, TONES } from "@/lib/openui/kit"

const STROKE = { neutral: "stroke-foreground", info: "stroke-primary", success: "stroke-success", warn: "stroke-warning", error: "stroke-destructive" } as const

export const Gauge = defineComponent({
  name: "Gauge",
  description: "One reading on a half-dial: label, value within min..max (default 0..100), optional unit, tone and hint.",
  props: z.object({
    label: z.string(),
    value: z.number(),
    min: z.number().optional(),
    max: z.number().optional(),
    unit: z.string().optional(),
    tone: z.enum(TONES).optional(),
    hint: z.string().optional(),
  }),
  component: ({ props }) => {
    const min = props.min ?? 0
    const max = props.max !== undefined && props.max > min ? props.max : min + 100
    const share = Math.min(1, Math.max(0, (props.value - min) / (max - min)))
    return (
      <Box className={cn(PAD, "flex flex-col items-center gap-1 text-center")}>
        <p className={LABEL}>{props.label}</p>
        <svg viewBox="0 0 120 68" role="img" aria-label={`${props.label}: ${props.value}${props.unit ?? ""}`} className="w-full max-w-[14rem]">
          <path d="M10 60 A50 50 0 0 1 110 60" pathLength={1} fill="none" strokeWidth={9} strokeLinecap="round" className="stroke-muted" />
          {share > 0 && <path d="M10 60 A50 50 0 0 1 110 60" pathLength={1} strokeDasharray={`${share} 1`} fill="none" strokeWidth={9} strokeLinecap="round" className={cn("transition-[stroke-dasharray] duration-700 ease-out motion-reduce:transition-none", STROKE[props.tone ?? "info"])} />}
        </svg>
        <p className={cn(FIG, "-mt-8")}>{props.value}{props.unit && <span className="ms-0.5 text-[0.5em] text-muted-foreground">{props.unit}</span>}</p>
        <p className={cn(META, "flex w-full max-w-[14rem] justify-between tabular-nums")}><span>{min}</span><span>{max}</span></p>
        {props.hint && <p className={cn(META, "text-pretty")}>{props.hint}</p>}
      </Box>
    )
  },
})
