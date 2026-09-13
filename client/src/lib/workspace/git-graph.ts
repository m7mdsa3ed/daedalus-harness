/**
 * Lay a commit list out into graph lanes.
 *
 * Pure — no DOM, no server — so the walk can be tested without rendering an
 * SVG, which is the half of a commit graph that is actually easy to get wrong.
 * The drawing lives in `components/workspace/scm/commit-graph.tsx`; this file
 * only decides which lane a commit sits in and which lanes run past it.
 *
 * The walk is the one `git log --graph` does, newest first: an open lane is
 * waiting for a particular hash, a commit claims the first lane expecting it
 * (or opens a new one), hands that lane to its first parent, and appends the
 * rest of its parents as extra lanes. That last part is the whole of what makes
 * a merge fan out rather than collapse onto one line.
 */

/** A lane occupies this much horizontal room. */
export const LANE_WIDTH = 14
/** The drawing is clamped here: past it, lanes overlap rather than widen the
    column, which in a 320px source-control pane is the only sane answer. */
export const MAX_LANES = 6

export interface GraphRow<T> {
  commit: T
  /** The lane this commit's dot sits in. */
  lane: number
  /** Lanes holding an edge *above* this row. */
  incoming: number[]
  /** Lanes holding an edge *below* this row. */
  outgoing: number[]
}

/**
 * The lane a commit's dot sits in, and the lanes crossing each row.
 *
 * `lane` is clamped for *drawing* only — the returned lane is the real one, so
 * two commits may share an x when there are more lanes than `MAX_LANES`; the
 * caller clamps with `laneX`. Keeping the true lane here means the walk still
 * merges correctly when the picture is compressed.
 */
export function layoutGraph<T extends { hash: string; parents: string[] }>(
  commits: readonly T[]
): GraphRow<T>[] {
  /** Each entry is the hash that lane is still waiting for, or null if free. */
  const lanes: (string | null)[] = []
  const rows: GraphRow<T>[] = []

  for (const commit of commits) {
    const incoming = lanes.flatMap((hash, index) => (hash ? [index] : []))

    let lane = lanes.indexOf(commit.hash)
    if (lane === -1) {
      lane = lanes.findIndex((hash) => hash === null)
      if (lane === -1) lane = lanes.length
    }

    /* The first parent continues this lane; the rest are merges and get lanes
       of their own. */
    lanes[lane] = commit.parents[0] ?? null

    /* Any *other* lane also waiting for this commit merges into it and closes —
       two branches that both reach one commit are one line from here down. */
    for (let index = 0; index < lanes.length; index += 1) {
      if (index !== lane && lanes[index] === commit.hash) lanes[index] = null
    }

    for (const parent of commit.parents.slice(1)) {
      const free = lanes.findIndex((hash) => hash === null)
      if (free === -1) lanes.push(parent)
      else lanes[free] = parent
    }

    rows.push({
      commit,
      lane,
      incoming,
      outgoing: lanes.flatMap((hash, index) => (hash ? [index] : [])),
    })
  }

  return rows
}

/** The x a lane sits at, clamped so the drawing never grows past `MAX_LANES`. */
export const laneX = (lane: number): number =>
  Math.min(lane, MAX_LANES - 1) * LANE_WIDTH + LANE_WIDTH / 2

/** How wide the drawing needs to be for these rows, clamped like `laneX`. */
export function graphWidth<T>(rows: readonly GraphRow<T>[]): number {
  let lanes = 1
  for (const row of rows) lanes = Math.max(lanes, row.incoming.length, row.outgoing.length)
  return Math.min(lanes, MAX_LANES) * LANE_WIDTH
}
