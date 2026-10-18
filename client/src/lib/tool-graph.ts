/**
 * Lay a run's steps out as a git graph.
 *
 * Pure, like `workspace/git-graph.ts`: the lane walk is the half worth
 * checking, the drawing lives in `components/thread-items/branch-gutter.tsx`.
 * Lane 0 is the thread's own line. A step that starts while an earlier one is
 * still running — parallel tool calls — forks off it into the first free lane
 * and merges back into the first later step that starts after it ended.
 * Steps with no timing (thoughts, old journals) stay on lane 0.
 */

export const MAX_BRANCH_LANES = 4

export interface StepSpan {
  /** Epoch ms; absent for anything that is not a timed call. */
  start?: number
  /** Absent while the call still runs. */
  end?: number
}

/** A vertical stretch of one lane through a row: from the top or the dot, to
    the bottom or the dot. */
export interface LaneLine {
  lane: number
  fromDot: boolean
  toDot: boolean
}

export interface BranchRow {
  /** The lane this step's dot sits in. */
  lane: number
  lines: LaneLine[]
  /** Lanes forking off lane 0 into this row's dot (0 or 1 entries). */
  forks: number[]
  /** Lanes merging into this row's dot on lane 0. */
  merges: number[]
}

export function layoutRun(spans: readonly StepSpan[]): BranchRow[] {
  const n = spans.length
  const laneEnd: number[] = [0]
  const lane = spans.map((span) => {
    if (span.start === undefined) return 0
    let k = laneEnd.findIndex((end) => end <= span.start!)
    if (k === -1) k = Math.min(laneEnd.length, MAX_BRANCH_LANES - 1)
    laneEnd[k] = span.end ?? Infinity
    return k
  })

  const rows: BranchRow[] = lane.map((l) => ({ lane: l, lines: [], forks: [], merges: [] }))
  const lastTrunk = lane.lastIndexOf(0)
  for (let i = 0; i <= lastTrunk; i++)
    rows[i].lines.push({ lane: 0, fromDot: i === 0, toDot: i === lastTrunk })

  for (let j = 0; j < n; j++) {
    const k = lane[j]
    if (k === 0) continue
    rows[j].forks.push(k)
    /* The branch runs until the first later step that starts after it ended. */
    const end = spans[j].end ?? Infinity
    let m = -1
    for (let i = j + 1; i < n; i++) {
      const s = spans[i].start
      if (s !== undefined && s >= end) { m = i; break }
    }
    const stop = m === -1 ? n : m
    if (stop > j + 1 || (m !== -1 && lane[m] === 0)) rows[j].lines.push({ lane: k, fromDot: true, toDot: false })
    for (let i = j + 1; i < stop; i++)
      rows[i].lines.push({ lane: k, fromDot: false, toDot: i === n - 1 })
    if (m !== -1 && lane[m] === 0) rows[m].merges.push(k)
  }
  return rows
}
