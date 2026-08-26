/* ── Optimistic rank math ──
   The twin of the server's rank arithmetic (`moveTask` / `bulkReorder` in
   server/src/pm/tasks.ts): ranks are integers spaced RANK_GAP apart, an insert
   lands halfway between its neighbours, and when that gap has closed the whole
   list renormalizes to `i * RANK_GAP`.

   It exists here so a drag can paint the new order before the round trip
   resolves — the server still recomputes authoritatively and its answer
   replaces this one (`actions.moveTask` reconciles). Pure: no React, no fetch. */

export const RANK_GAP = 1000

/** A gap of ≤1 has no integer left in it — the slice must renormalize first.
    Same test the server makes before it rewrites the column. */
export function needsRenormalize(prev?: number, next?: number): boolean {
  return prev !== undefined && next !== undefined && next - prev <= 1
}

/** The rank between two neighbours; either side may be absent (list ends). */
export function rankBetween(prev?: number, next?: number): number {
  if (prev === undefined && next === undefined) return 0
  if (prev === undefined) return next! - RANK_GAP
  if (next === undefined) return prev + RANK_GAP
  return prev + Math.floor((next - prev) / 2)
}

/** Append to the end of a ranked list. */
export function appendRank(ranks: number[]): number {
  return ranks.length === 0 ? 0 : Math.max(...ranks) + RANK_GAP
}

/**
 * The rank a task gets when dropped at `index` of `siblings` — the moving task
 * itself must already be excluded, exactly as the server excludes it.
 *
 * `renormalized` reports the case the server handles by rewriting the whole
 * column: when it is true the caller's optimistic list should be re-ranked with
 * `renormalize` too, or its own neighbours will disagree with the ranks the
 * server is about to hand back.
 */
export function rankForIndex(
  siblings: number[],
  index: number
): { order: number; renormalized: boolean } {
  const at = Math.min(Math.max(index, 0), siblings.length)
  let prev = at > 0 ? siblings[at - 1] : undefined
  let next = at < siblings.length ? siblings[at] : undefined
  if (needsRenormalize(prev, next)) {
    prev = (at - 1) * RANK_GAP
    next = at * RANK_GAP
    return { order: rankBetween(prev, next), renormalized: true }
  }
  return { order: rankBetween(prev, next), renormalized: false }
}

/** `i * RANK_GAP` for a whole list — the shape `POST /reorder` wants back
    (`{ scope, orderedIds }`) plus the ranks to paint locally meanwhile. */
export function renormalize(orderedIds: string[]): {
  orderedIds: string[]
  ranks: Record<string, number>
} {
  const ranks: Record<string, number> = {}
  orderedIds.forEach((id, i) => {
    ranks[id] = i * RANK_GAP
  })
  return { orderedIds, ranks }
}

/** Move `id` to `index` within `ids` — the id list a reorder gesture produces. */
export function moveInList(ids: string[], id: string, index: number): string[] {
  const without = ids.filter((other) => other !== id)
  const at = Math.min(Math.max(index, 0), without.length)
  return [...without.slice(0, at), id, ...without.slice(at)]
}
