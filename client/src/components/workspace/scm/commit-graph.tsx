/* ── The commit graph ──
   The history section drawn as the thing a log is actually a picture of: one
   row per commit, one lane per line of descent, a merge fanning out and a
   branch closing where two lines meet again.

   The lanes come from `lib/workspace/git-graph.ts`, which is the pure walk and
   the half worth testing; this file only turns a `GraphRow` into SVG. Colours
   are Tailwind's `stroke-*` / `fill-*` utilities rather than the `--chart-*`
   tokens, which are deliberately greyscale in this app's neutral palette and
   would make six lanes one indistinguishable smear. */
import * as React from "react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { GitCommit } from "@/lib/workspace/git-api"
import { graphWidth, laneX, layoutGraph } from "@/lib/workspace/git-graph"
import { shortAge } from "@/lib/time"

/** One height for every row, so the SVG and the list cannot disagree about
    where a commit's dot is. */
const ROW_HEIGHT = 44
const DOT_RADIUS = 3.5

/* One entry per lane, so the line and the dot on it cannot drift apart — and
   **spelled out in full**, never assembled from a hue name. Tailwind finds
   classes by scanning source text, so `stroke-${hue}-500` would generate
   nothing at all and every lane would draw in the current colour. */
const LANE_COLORS = [
  { stroke: "stroke-sky-500", fill: "fill-sky-500" },
  { stroke: "stroke-emerald-500", fill: "fill-emerald-500" },
  { stroke: "stroke-amber-500", fill: "fill-amber-500" },
  { stroke: "stroke-violet-500", fill: "fill-violet-500" },
  { stroke: "stroke-rose-500", fill: "fill-rose-500" },
  { stroke: "stroke-teal-500", fill: "fill-teal-500" },
] as const

export const strokeOf = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length].stroke
export const fillOf = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length].fill

export function CommitGraph({
  commits,
  onCopy,
  coarse,
  hint = "Click to copy the full hash",
}: {
  hint?: string
  commits: readonly GitCommit[]
  /** Clicking a row copies its hash — the one thing a log cannot give by look. */
  onCopy: (commit: GitCommit) => void
  coarse: boolean
}) {
  const rows = React.useMemo(() => layoutGraph(commits), [commits])
  const width = graphWidth(rows)

  return (
    <div className="relative">
      <svg
        aria-hidden
        className="pointer-events-none absolute top-0 left-0"
        width={width}
        height={rows.length * ROW_HEIGHT}
      >
        {rows.map((row, index) => {
          const y = index * ROW_HEIGHT + ROW_HEIGHT / 2
          return (
            <g key={row.commit.hash}>
              {row.incoming.map((lane) => (
                <line
                  key={`in-${lane}`}
                  x1={laneX(lane)}
                  y1={y - ROW_HEIGHT / 2}
                  x2={laneX(lane)}
                  y2={y}
                  strokeWidth={1.5}
                  className={cn(strokeOf(lane), "opacity-55")}
                />
              ))}
              {row.outgoing.map((lane) => (
                <line
                  key={`out-${lane}`}
                  x1={laneX(lane)}
                  y1={y}
                  x2={laneX(lane)}
                  y2={y + ROW_HEIGHT / 2}
                  strokeWidth={1.5}
                  className={cn(strokeOf(lane), "opacity-55")}
                />
              ))}
              {/* A merge's second parent leaves this row diagonally. */}
              {row.commit.parents.length > 1 &&
                row.outgoing
                  .filter((lane) => lane !== row.lane)
                  .map((lane) => (
                    <path
                      key={`merge-${lane}`}
                      d={`M ${laneX(row.lane)} ${y} C ${laneX(lane)} ${y}, ${laneX(lane)} ${y}, ${laneX(lane)} ${y + ROW_HEIGHT / 2}`}
                      fill="none"
                      strokeWidth={1.5}
                      className={cn(strokeOf(lane), "opacity-55")}
                    />
                  ))}
              <circle
                cx={laneX(row.lane)}
                cy={y}
                r={DOT_RADIUS}
                className={fillOf(row.lane)}
              />
            </g>
          )
        })}
      </svg>

      <ol style={{ paddingLeft: width + 4 }}>
        {rows.map((row) => (
          <li key={row.commit.hash} style={{ height: ROW_HEIGHT }}>
            <button
              type="button"
              onClick={() => onCopy(row.commit)}
              title={`${row.commit.hash}\n${row.commit.author} · ${new Date(row.commit.at * 1000).toLocaleString()}\n${row.commit.subject}\n\n${hint}`}
              className={cn(
                "flex h-full w-full flex-col justify-center gap-0.5 rounded-md pr-1 pl-1 text-left",
                "hover:bg-accent/40",
                coarse && "py-1"
              )}
            >
              <div className="flex min-w-0 items-center gap-1.5">
                {row.commit.refs.slice(0, 2).map((ref) => (
                  <Badge key={ref} variant="outline" className="shrink-0 px-1 text-[10px]">
                    {ref}
                  </Badge>
                ))}
                <span className="min-w-0 flex-1 truncate text-xs">{row.commit.subject}</span>
              </div>
              <div className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className="font-mono">{row.commit.short}</span>
                <span className="truncate">{row.commit.author}</span>
                <span className="ml-auto shrink-0 tabular-nums">
                  {shortAge(row.commit.at * 1000)}
                </span>
              </div>
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}
