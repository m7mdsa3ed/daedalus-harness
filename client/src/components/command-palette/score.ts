/* ── The palette's matcher ──
   cmdk ships a fuzzy filter and the palette used to use it. It is dropped
   (`shouldFilter={false}`) for one reason: the palette needs to say where a row
   ranks, not just whether it matched. A "Start a new thread — “…”" row is
   *about* whatever is in the box, so it always matches, and with a scorer that
   only answers yes/no it can outrank the command somebody was actually typing.
   Ranking here means `rank: "bottom"` is a thing a row can declare (see
   `list.tsx`), which is what keeps ↵ off the expensive fallback until nothing
   else is left.

   The scale is arbitrary and only ever compared against itself: a prefix beats
   a word-start beats a mid-word hit beats a subsequence. Every term of a
   multi-word query has to land somewhere or the row is out — "new pro" should
   reach "New project" and nothing else. */

/** 0 when the query does not match at all; higher is a better match. */
export function score(text: string, query: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 1
  const hay = text.toLowerCase()
  let total = 0
  for (const term of q.split(/\s+/)) {
    const s = scoreTerm(hay, term)
    if (!s) return 0
    total += s
  }
  return total
}

const BOUNDARY = new Set([" ", "-", "_", "/", ".", ":", "…"])

function scoreTerm(hay: string, term: string): number {
  const at = hay.indexOf(term)
  if (at === 0) return 120
  if (at > 0) {
    const boundary = BOUNDARY.has(hay[at - 1])
    // A later hit is a weaker one, but never weaker than a subsequence.
    return (boundary ? 90 : 60) - Math.min(at, 40) / 4
  }
  // Scattered letters, in order — "cmt" for "Copy transcript markdown". Runs
  // score more than singles, so an acronym beats letters picked out of prose.
  let i = 0
  let run = 0
  let s = 0
  for (let j = 0; j < hay.length && i < term.length; j++) {
    if (hay[j] === term[i]) {
      i++
      run++
      s += 1 + run
    } else {
      run = 0
    }
  }
  return i === term.length ? Math.min(s, 40) : 0
}

/** A row's score: the printed title counts double, the hidden keywords once —
    what you can see is what you are most likely to be typing at. */
export function scoreItem(title: string, keywords: string | undefined, query: string): number {
  const own = score(title, query) * 2
  const all = keywords ? score(`${title} ${keywords}`, query) : 0
  return Math.max(own, all)
}
