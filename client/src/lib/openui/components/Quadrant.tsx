/* ── Quadrant ──
   A 2x2 matrix: points placed by x and y (0-100) between two labelled axes. The
   plot carries numbered dots only and the names ride a legend beneath it —
   labels written onto the plot collide the moment two points are near, and the
   panel's width is the one thing the model cannot control. The plot is
   decoration for a screen reader (`aria-hidden`); the legend is the same data as
   text, with coordinates. A view streams in, so every prop may be missing or
   half-written: a point without a finite x and y is skipped, not drawn at 0. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { BODY, Box, BoxHeader, chartColor, HAIRLINE, LABEL, META, PAD } from "@/lib/openui/kit"
import { cn } from "@/lib/utils"

const clamp = (n: number) => Math.min(100, Math.max(0, n))

export const Quadrant = defineComponent({
  name: "Quadrant",
  description: "A 2x2 matrix placing labelled points by x and y (0-100) between two labelled axes, with optional corner captions ordered top-left, top-right, bottom-left, bottom-right.",
  props: z.object({
    title: z.string(),
    xLabel: z.string(),
    yLabel: z.string(),
    points: z.array(z.object({ label: z.string(), x: z.number(), y: z.number() })),
    corners: z.array(z.string()).optional(),
  }),
  component: ({ props }) => {
    const points = (props.points ?? []).flatMap((point, index) =>
      point && Number.isFinite(point.x) && Number.isFinite(point.y) ? [{ ...point, x: clamp(point.x), y: clamp(point.y), index }] : []
    )
    const corners = props.corners ?? []
    return (
      <Box className="w-full">
        {props.title && <BoxHeader title={props.title} />}
        <div className={cn("space-y-3", PAD)}>
          <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1.5">
            <span className={cn(LABEL, "self-center text-center [writing-mode:vertical-rl] rotate-180")}>{props.yLabel}</span>
            <div aria-hidden="true" className={cn("relative aspect-square max-h-[26rem] w-full overflow-hidden rounded-md border", HAIRLINE)}>
              <div className={cn("absolute inset-y-0 left-1/2 border-l border-dashed", HAIRLINE)} />
              <div className={cn("absolute inset-x-0 top-1/2 border-t border-dashed", HAIRLINE)} />
              {[0, 1, 2, 3].map((slot) =>
                corners[slot] ? (
                  <span
                    key={slot}
                    className={cn(
                      LABEL,
                      "absolute max-w-[46%] p-1.5 text-[9px] @panel-sm:text-[10.5px]",
                      slot < 2 ? "top-0" : "bottom-0",
                      slot % 2 === 0 ? "left-0 text-left" : "right-0 text-right"
                    )}
                  >
                    {corners[slot]}
                  </span>
                ) : null
              )}
              <div className="absolute inset-3">
                {points.map((point, n) => (
                  <span
                    key={point.index}
                    className="absolute flex size-5 -translate-x-1/2 translate-y-1/2 items-center justify-center rounded-full text-[10px] leading-none font-semibold text-background tabular-nums shadow-xs"
                    style={{ left: `${point.x}%`, bottom: `${point.y}%`, background: chartColor(n) }}
                  >
                    {n + 1}
                  </span>
                ))}
              </div>
            </div>
            <span aria-hidden="true" />
            <span className={cn(LABEL, "text-center")}>{props.xLabel}</span>
          </div>
          {points.length > 0 && (
            <ol className="grid gap-x-4 gap-y-1.5 @panel-sm:grid-cols-2">
              {points.map((point, n) => (
                <li key={point.index} className="flex min-w-0 items-baseline gap-2">
                  <span className="mt-0.5 size-2.5 shrink-0 self-center rounded-full" style={{ background: chartColor(n) }} aria-hidden="true" />
                  <span className={cn(BODY, "min-w-0 flex-1 text-xs")}>
                    <span className="tabular-nums">{n + 1}. </span>
                    {point.label}
                  </span>
                  <span className={cn(META, "shrink-0 tabular-nums")}>
                    <span className="sr-only">{`${props.xLabel} `}</span>
                    {Math.round(point.x)}
                    <span className="sr-only">{`, ${props.yLabel} `}</span>
                    <span aria-hidden="true">, </span>
                    {Math.round(point.y)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </Box>
    )
  },
})
