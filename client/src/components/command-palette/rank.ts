/* ── Rows as data, and the order they come out in ──
   Every page that is a *list of things you can do* declares `PaletteItem[]`;
   this file scores, orders and groups it, and `list.tsx` draws the result. The
   pages that are a list of *results* (search) draw their own rows, because
   their order is the server's and not a match score.

   Declaring rows as data rather than as JSX is what makes ranking possible at
   all: a row can say it belongs at the bottom whatever it scores, and the group
   headings can be reordered to follow their best row without moving any markup.
   With no query the declared order is kept exactly — a palette that reshuffles
   itself before you have typed anything is a palette you have to read.

   Kept free of React and of the store so it can be reasoned about — and run —
   on its own: the ordering rules below are the palette's whole behaviour under
   the keyboard, and they are the part a rendered list makes hardest to see. */
import type { ReactNode } from "react"

import { scoreItem } from "./score"

export interface PaletteItem {
  /** Unique within the page; also cmdk's item value, so selection survives a
      re-render that reorders the list. */
  id: string
  /** The heading this row sits under. First appearance fixes group order. */
  group: string
  /** What the row says, and what the query is scored against. */
  title: string
  /** Extra words that should match but are not printed. */
  keywords?: string
  /** Drawn instead of the title, for a row that needs more than one line. */
  render?: ReactNode
  icon?: ReactNode
  /** Trailing content — bring your own `ml-auto`. */
  trailing?: ReactNode
  chord?: string
  /** Draws the tick. */
  checked?: boolean
  className?: string
  /** Pinned regardless of score: `"bottom"` is for a row that is *about* the
      query (start a thread with it, search for it) and must never take ↵ from a
      command the query actually names. */
  rank?: "top" | "bottom"
  /** Never filtered out — the row answers for any query, or was ranked by
      somebody else already. */
  always?: boolean
  onSelect: () => void
}

interface Ranked {
  item: PaletteItem
  score: number
}

const PIN = 1e6

/* What counts as "the query names this row": the query, or every word of it,
   appears in the row's title or keywords at a word boundary. Below that a row
   only matched as scattered letters — "fix the deploy" reaching "Reset text
   size" because the letters happen to be in order somewhere. The distinction is
   load-bearing for exactly one decision: a query nothing is *named* by is prose,
   and prose belongs to the rows that are about the query rather than to the
   weakest command on the list (see the note in `root-page.tsx`). */
const NAMED = 85

/** Score, drop the misses, then order rows within a group and groups against
    each other. Both sorts are stable, so a tie is the order things were
    declared in. */
export function rankItems(items: PaletteItem[], query: string): { name: string; items: PaletteItem[] }[] {
  const q = query.trim()
  const groups = new Map<string, Ranked[]>()
  // Declared order, kept even for a group whose rows all scored out.
  for (const item of items) if (!groups.has(item.group)) groups.set(item.group, [])

  const scored: Ranked[] = []
  for (const item of items) {
    const base = !q || item.always ? 1 : scoreItem(item.title, item.keywords, q)
    if (!base) continue
    scored.push({ item, score: base })
  }
  const named = scored.some((row) => !row.item.always && row.score >= NAMED)

  for (const row of scored) {
    const { item } = row
    /* A query-shaped fallback (`always` + bottom) is last while a command is
       being named and first once nothing is — the only row that moves, and it
       moves because what the box holds stopped being a command. */
    const floating = item.always && item.rank === "bottom" && !named
    const bias = item.rank === "top" || floating ? PIN : item.rank === "bottom" ? -PIN : 0
    groups.get(item.group)!.push({ item, score: row.score + bias })
  }

  const out = [...groups]
    .filter(([, rows]) => rows.length > 0)
    .map(([name, rows]) => ({
      name,
      rows,
      score: Math.max(...rows.map((row) => row.score)),
    }))

  if (q) {
    out.sort((a, b) => b.score - a.score)
    for (const group of out) group.rows.sort((a, b) => b.score - a.score)
  }
  return out.map((group) => ({ name: group.name, items: group.rows.map((row) => row.item) }))
}

