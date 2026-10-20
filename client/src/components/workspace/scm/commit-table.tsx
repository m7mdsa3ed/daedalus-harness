/* ── The commit table ──
   Sublime Merge's top pane: one line per commit with the lanes at its left, ref
   badges and the subject, then author, date and hash as columns. The first row
   is not a commit but "Working Directory" - what is outstanding right now - and
   selecting it is how the detail pane below becomes the staging area.

   Lanes are `lib/workspace/git-graph.ts` and the lane colours are
   `commit-graph.tsx`'s; only the row height differs, because a table row is one
   line where the sidebar's history row was two. */
import * as React from "react"

import { fillOf, strokeOf } from "@/components/workspace/scm/commit-graph"
import { PanelRowsSkeleton } from "@/components/ui/skeletons"
import { shortAge } from "@/lib/time"
import { cn } from "@/lib/utils"
import type { GitCommit } from "@/lib/workspace/git-api"
import { graphWidth, laneX, layoutGraph } from "@/lib/workspace/git-graph"

const ROW = 24

/** Local branch, remote branch and tag each read differently at a glance. */
function refClass(ref: string, current: string | null): string {
  if (ref.startsWith("tag: ")) return "border-warning/40 bg-warning/10 text-warning"
  if (ref === current || ref === "HEAD") return "border-primary bg-primary font-medium text-primary-foreground"
  if (ref.includes("/")) return "border-primary/40 bg-primary/10 text-primary"
  return "border-success/40 bg-success/10 text-success"
}

export function CommitTable({
  commits,
  current,
  changes,
  selected,
  onSelect,
  onMore,
  loading,
}: {
  commits: readonly GitCommit[]
  /** The checked-out branch, to emphasise its badge. */
  current: string | null
  /** Files outstanding; 0 still draws the row, it is where staging lives. */
  changes: number
  /** A commit hash, or null for the Working Directory. */
  selected: string | null
  onSelect: (commit: GitCommit | null) => void
  /** Present while there may be older commits to load. */
  onMore?: () => void
  loading?: boolean
}) {
  const rows = React.useMemo(() => layoutGraph(commits), [commits])
  const width = graphWidth(rows) + 4
  const box = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    box.current?.querySelector(selected ? `[data-hash="${selected}"]` : "[data-hash='']")?.scrollIntoView({ block: "nearest" })
  }, [selected])

  /* Older commits load as the foot comes into view - the same bargain as the
     Locations lists - so the server is asked for a page, not the history. */
  const foot = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const node = foot.current
    if (!node || !onMore || loading) return
    const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && onMore(), { rootMargin: "160px" })
    observer.observe(node)
    return () => observer.disconnect()
  }, [onMore, loading, commits.length])

  /* Column widths are shared with the rows below, which is what keeps the
     titles over their columns. */
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div aria-hidden style={{ paddingLeft: width }} className="flex h-6 shrink-0 items-center gap-2 overflow-hidden border-b bg-muted/50 pr-3 text-xs font-medium text-muted-foreground [scrollbar-gutter:stable]">
        <span className="min-w-0 flex-1 pl-1">Message</span>
        <span className="hidden w-28 shrink-0 @panel-sm:block">Author</span>
        <span className="hidden w-14 shrink-0 text-right @panel-sm:block">Date</span>
        <span className="hidden w-14 shrink-0 @panel-md:block">Commit</span>
      </div>
    <div ref={box} className="relative min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable]">
      <svg aria-hidden className="pointer-events-none absolute top-0 left-0" width={width} height={(rows.length + 1) * ROW}>
        {/* The working directory hangs off the tip of the first lane. */}
        <line x1={laneX(0)} y1={ROW / 2} x2={laneX(0)} y2={ROW * 1.5} strokeWidth={2} strokeDasharray="3 2" className="stroke-muted-foreground/60" />
        <circle cx={laneX(0)} cy={ROW / 2} r={4} strokeWidth={2} className="fill-background stroke-muted-foreground" />
        {rows.map((row, i) => {
          const y = (i + 1) * ROW + ROW / 2
          return (
            <g key={row.commit.hash}>
              {row.incoming.map((lane) => (
                <line key={`i${lane}`} x1={laneX(lane)} y1={y - ROW / 2} x2={laneX(lane)} y2={y} strokeWidth={2} className={cn(strokeOf(lane), "opacity-80")} />
              ))}
              {row.outgoing.map((lane) => (
                <line key={`o${lane}`} x1={laneX(lane)} y1={y} x2={laneX(lane)} y2={y + ROW / 2} strokeWidth={2} className={cn(strokeOf(lane), "opacity-80")} />
              ))}
              {row.commit.parents.length > 1 &&
                row.outgoing.filter((lane) => lane !== row.lane).map((lane) => (
                  <path key={`m${lane}`} d={`M ${laneX(row.lane)} ${y} C ${laneX(lane)} ${y}, ${laneX(lane)} ${y}, ${laneX(lane)} ${y + ROW / 2}`} fill="none" strokeWidth={2} className={cn(strokeOf(lane), "opacity-80")} />
                ))}
              <circle cx={laneX(row.lane)} cy={y} r={4} strokeWidth={2} className={cn(fillOf(row.lane), "stroke-background")} />
            </g>
          )
        })}
      </svg>

      <ol style={{ paddingLeft: width }}>
        <li style={{ height: ROW }}>
          <button type="button" data-hash="" aria-current={selected === null} onClick={() => onSelect(null)} className={cn("flex h-full w-full items-center gap-2 pr-3 pl-1 text-left text-sm hover:bg-muted", selected === null && "bg-muted")}>
            <span className="font-medium italic">Working Directory</span>
            <span className="text-xs text-muted-foreground">{changes === 0 ? "clean" : `${changes} ${changes === 1 ? "file" : "files"} changed`}</span>
          </button>
        </li>
        {rows.map(({ commit }) => (
          <li key={commit.hash} style={{ height: ROW }}>
            <button type="button" data-hash={commit.hash} aria-current={selected === commit.hash} onClick={() => onSelect(commit)} title={`${commit.hash}\n${commit.subject}`} className={cn("flex h-full w-full items-center gap-2 pr-3 pl-1 text-left text-sm hover:bg-muted", selected === commit.hash && "bg-muted")}>
              {commit.refs.map((ref) => (
                <span key={ref} className={cn("shrink-0 rounded-md border px-1.5 text-xs leading-4", refClass(ref, current))}>{ref.replace(/^tag: /, "")}</span>
              ))}
              <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
              <span className="hidden w-28 shrink-0 truncate text-xs text-muted-foreground @panel-sm:block">{commit.author}</span>
              <span className="hidden w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground @panel-sm:block">{shortAge(commit.at * 1000)}</span>
              <span className="hidden w-14 shrink-0 font-mono text-xs text-muted-foreground @panel-md:block">{commit.short}</span>
            </button>
          </li>
        ))}
      </ol>
      {onMore && <div ref={foot} className="h-6">{loading && <PanelRowsSkeleton rows={1} className="px-2 py-1.5" />}</div>}
    </div>
    </div>
  )
}
