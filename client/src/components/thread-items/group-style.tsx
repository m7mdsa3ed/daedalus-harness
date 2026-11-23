/* ── How a group of calls is bracketed ──
   A parallel batch is one set of calls, and this module is the one answer for
   how a set is drawn, so `ToolRun` reads a treatment rather than spelling
   `bg-… divide-…` inline.

   The treatment is a **lane wash**: one tinted ground, no border, holding the
   header, a strip of lanes that draws each call's
   span against the batch's own clock, and the calls on the run's rail with a
   hairline between them. The ledger before it (rules above, below and between)
   said "these belong together" but not the one thing a batch is — calls that
   ran *at the same time*. The lanes say it without a word: overlapping bars
   are the overlap, a long bar is the slow call holding the batch up.

   ── One column ──
   The frame sits **flush on the transcript's column** — the same edge a step
   row's hover ground, a todo card, the thinking panel and the gap rule are on.
   It does not bleed (`docs/client.md`: a bleed beside cards that all sit on the
   column reads as a box that does not line up). */
import * as React from "react"
import { formatElapsed } from "@/components/step-row"
import type { ToolItem } from "@/lib/store"
import { cn } from "@/lib/utils"

export interface GroupTreatment {
  /** The box holding the header, the lanes and the calls — their ground,
   *  because the calls sit inside it. */
  frame: string
}

/* Marked by its ground, never by an edge: the wash is the `!` run's strength
   (`bg-primary/[0.04]`, one shape for "this stretch is marked"), so the batch
   reads as a highlighted stretch of the transcript rather than a card dropped
   into it. A live batch deepens the same wash, because it is the one thing on
   screen still happening — said by tone, not by a heavier box.
   `-mx-1 w-[calc(100%+0.5rem)] px-1`, and the numbers are not free: every step
   row carries the same `-mx-1 px-1`, holding its content on the column while
   its hover ground bleeds 4px out. The wash is that same ground and bleeds
   exactly as far, so its mark, title, chevron and inner rail sit on the same
   lines as the plain rows beside it. Without the bleed the wash's content sat
   4px in on both sides — a batch's mark and chevron out of line with every
   sibling row in the run. The clips that hold a group carry the room
   (`-mx-2 px-2` in `rows.tsx`, `thread-view.tsx`, `thread-cards.tsx`). */
export function groupTreatment(live: boolean): GroupTreatment {
  return {
    frame: cn(
      "-mx-1 w-[calc(100%+0.5rem)] rounded-xl bg-primary/[0.04] px-1 py-0.5 transition-colors duration-300",
      live && "bg-primary/[0.07]"
    ),
  }
}

/* More lanes than this and the strip stops being a reading and becomes a
   texture; past it the bars are drawn thinner so the strip keeps its height. */
const LANES_FULL = 6
const LANES_MAX = 12

/** Each call of a batch as a bar on the batch's own clock: where it started,
 *  how long it ran, whether it is still out or failed. Drawn under the header
 *  folded or open, because it is the summary of the batch's shape — a folded
 *  batch of four reads at a glance as "three quick, one slow". Calls with no
 *  start (a replayed `session/load`) are not drawn, and fewer than two drawable
 *  calls draws nothing: one bar is not a comparison. */
export function BatchLanes({ tools, now }: { tools: ToolItem[]; now: number | null }) {
  const lanes = React.useMemo(() => {
    const timed = tools.filter((tool) => tool.startedAt !== undefined).slice(0, LANES_MAX)
    if (timed.length < 2) return null
    const at = now ?? Date.now()
    const spans = timed.map((tool) => {
      const running = tool.status === "in_progress" || tool.status === "pending"
      const start = tool.startedAt as number
      const end = tool.endedAt ?? (running ? Math.max(at, start) : start)
      return { tool, start, end, running, failed: tool.status === "failed" }
    })
    const first = Math.min(...spans.map((span) => span.start))
    const last = Math.max(...spans.map((span) => span.end))
    const total = Math.max(1, last - first)
    return spans.map((span, index) => ({
      ...span,
      index,
      left: ((span.start - first) / total) * 100,
      width: ((span.end - span.start) / total) * 100,
    }))
  }, [tools, now])
  if (!lanes) return null
  const thin = lanes.length > LANES_FULL
  return (
    /* `ps-7` is the rail's indent (`RUN_RAIL_CLASS`), so the strip starts on
       the same edge as the call titles it summarises and ends before the
       header's chevron column. Decorative to a screen reader: the header
       already says how many ran and how long, and each row says its own. */
    <div aria-hidden className="pe-6 ps-7 pb-1.5 pt-1">
      <div className={cn("flex flex-col", thin ? "gap-[3px]" : "gap-1")}>
        {lanes.map((lane) => (
          <div
            key={lane.tool.id}
            title={`${lane.index + 1}/${lanes.length} · ${lane.tool.title}${lane.running ? " · running" : ` · ${formatElapsed(lane.end - lane.start)}`}`}
            className={cn("relative w-full rounded-full bg-foreground/[0.05]", thin ? "h-[3px]" : "h-1")}
          >
            <span
              className={cn(
                "harness-lane absolute inset-y-0 rounded-full",
                lane.failed ? "bg-destructive/70" : lane.running ? "harness-lane-live bg-primary/70" : "bg-primary/35"
              )}
              style={{
                insetInlineStart: `${lane.left}%`,
                /* A call that took no measurable time still draws a dot. */
                width: `max(${thin ? 3 : 4}px, ${lane.width}%)`,
                "--lane-i": lane.index,
              } as React.CSSProperties}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
