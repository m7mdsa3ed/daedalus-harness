/* ── The Branch layout's gutter ──
   One run of steps drawn as the commit graph beside it is: lanes, a dot per
   step, a fork curving off the trunk and a merge curving back. The lanes come
   from `lib/tool-graph.ts`; this only turns a `BranchRow` into SVG, in the
   commit graph's own lane colours.

   The SVG reaches 2px past its row at both ends (rows are 2px apart), so the
   lines join from one row to the next instead of breaking in the gap. */
import { cn } from "@/lib/utils"
import type { ToolVariant } from "@/lib/view-options"
import type { BranchRow } from "@/lib/tool-graph"
import { fillOf, strokeOf } from "@/components/workspace/scm/commit-graph"

const LANE_W = 10
const PAD = 7
/** The dot's centre, in the SVG's own coordinates (the row's 14px + the 2px overhang). */
const DOT_Y = 16

/** Fork hangs every step off the trunk, so its dots sit one lane to the right. */
const shift = (variant: ToolVariant) => (variant === "fork" ? 1 : 0)
const laneX = (lane: number, variant: ToolVariant) => PAD + (lane + shift(variant)) * LANE_W

export function gutterWidth(maxLane: number, variant: ToolVariant) {
  return PAD * 2 + (maxLane + shift(variant)) * LANE_W
}

/** A line leaving the trunk at the row's top and arriving at the dot flat. */
const elbow = (x0: number, x1: number) =>
  `M ${x0} 0 L ${x0} ${DOT_Y - 6} Q ${x0} ${DOT_Y} ${x0 + 6} ${DOT_Y} L ${x1} ${DOT_Y}`
const curve = (x0: number, x1: number) => `M ${x0} 0 C ${x0} ${DOT_Y * 0.6}, ${x1} ${DOT_Y * 0.4}, ${x1} ${DOT_Y}`

export function BranchGutter({
  row,
  width,
  variant,
  status,
  last,
}: {
  row: BranchRow
  width: number
  variant: ToolVariant
  status: string
  last: boolean
}) {
  const fork = variant === "fork"
  const trunk = laneX(0, variant) - (fork ? LANE_W : 0)
  const x = (lane: number) => laneX(lane, variant)
  const stroke = "fill-none opacity-70 [stroke-width:1.5]"
  const failed = status === "failed"
  const live = status === "in_progress" || status === "pending"
  const hollow = variant === "hollow" && status !== "completed" && !failed
  const dotX = x(row.lane)

  return (
    <svg
      aria-hidden
      width={width}
      className="pointer-events-none absolute start-0 -top-0.5 overflow-visible rtl:-scale-x-100"
      style={{ height: "calc(100% + 4px)" }}
    >
      {/* Fork's trunk is one unbroken line the whole run, each step an elbow off it. */}
      {fork && !last && <line x1={trunk} x2={trunk} y1={0} y2="100%" className={cn(stroke, strokeOf(0))} />}
      {row.lines
        .filter((line) => !(fork && line.lane === 0))
        .map((line) => (
          <line
            key={line.lane}
            x1={x(line.lane)}
            x2={x(line.lane)}
            y1={line.fromDot ? DOT_Y : 0}
            y2={line.toDot ? DOT_Y : "100%"}
            className={cn(stroke, strokeOf(line.lane))}
          />
        ))}
      {fork && row.lane === 0 && <path d={elbow(trunk, dotX)} className={cn(stroke, strokeOf(0))} />}
      {row.forks.map((lane) => (
        <path key={`f${lane}`} d={fork ? elbow(trunk, x(lane)) : curve(x(0), x(lane))} className={cn(stroke, strokeOf(lane))} />
      ))}
      {row.merges.map((lane) => (
        <path key={`m${lane}`} d={curve(x(lane), dotX)} className={cn(stroke, strokeOf(lane))} />
      ))}
      <circle
        cx={dotX}
        cy={DOT_Y}
        r={3.5}
        strokeWidth={1.5}
        className={cn(
          failed ? "fill-destructive stroke-destructive" : cn(strokeOf(row.lane), hollow ? "fill-background" : fillOf(row.lane)),
          live && "animate-pulse"
        )}
      />
    </svg>
  )
}
