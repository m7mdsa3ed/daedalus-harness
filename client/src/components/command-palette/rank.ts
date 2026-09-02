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

/** A tone a badge can wear. `custom` hands the colours to `className`, for a
    chip whose colours are decided elsewhere (a run status). */
export type BadgeTone = "neutral" | "primary" | "warn" | "danger" | "success"

export interface PaletteBadge {
  label: string
  tone?: BadgeTone
  /** Colour classes that replace `tone`'s. */
  className?: string
}

/** One fact in the row's right-hand column: a short label, optionally led by
    a small picture (a project's mark, an agent's). Drawn `a · b · c`, the
    whole column truncating from the right as a unit. */
export interface PaletteMeta {
  label: string
  icon?: ReactNode
  /** Monospace — a path, a URL, a size. */
  mono?: boolean
  /** Fainter than the rest of the column: an age, a count. */
  dim?: boolean
}

/* A row is data. Every field below is a *slot* the renderer in `list.tsx`
   knows where to put, which is what keeps forty rows built by nine functions
   lined up: no row brings its own markup or its own `ml-auto`. */
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
  /** The glyph in the leading tile. */
  icon?: ReactNode
  /** A second line under the title — a snippet, a verdict, what the row does
      when its title alone does not say. */
  subtitle?: ReactNode
  /** Small chips after the title: a state ("Disabled"), a status, "Last used". */
  badges?: PaletteBadge[]
  /** The right-hand column: where the row goes, what it is currently set to. */
  meta?: PaletteMeta[]
  chord?: string
  /** Draws the tick. */
  checked?: boolean
  /** The title shimmers: a thread whose turn is running. */
  running?: boolean
  /** A dot before the title: unseen since this device last looked. */
  fresh?: boolean
  /** Drawn faded: an exited thread, a disabled routine. Still selectable. */
  muted?: boolean
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

/** The heading recently used commands are lifted under, before anything else.
    They are *moved* rather than copied: a row drawn twice is two rows with one
    id, which is cmdk's selection value, and a list that repeats itself is one
    you have to read twice to be sure. */
export const RECENT_GROUP = "Recently used"

/** How many of the remembered ids are offered. The list is a shortcut past the
    first screenful, not a history — past about this many, scanning it costs
    more than typing the name. */
const RECENT_SHOWN = 5

/* A recency nudge, applied *after* `named` has been decided so it can never
   promote a scattered-letters match into a row the query is treated as naming.
   Small on purpose: it settles ties and lifts a habit past an equal match, and
   loses outright to a better one — a palette that answers the last thing you
   did rather than the thing you typed is worse than one that never learned. */
const RECENCY_BONUS = 6

/** Score, drop the misses, then order rows within a group and groups against
    each other. Both sorts are stable, so a tie is the order things were
    declared in. */
export function rankItems(
  items: PaletteItem[],
  query: string,
  /** Command ids this device used, newest first — see `lib/palette-recents`. */
  recents: string[] = []
): { name: string; items: PaletteItem[] }[] {
  const q = query.trim()
  /* Rank by recency, resolved against the rows that are actually on offer: a
     remembered id whose command does not apply right now matches nothing here
     and simply does not appear. `always`/pinned rows are left out — those are
     about the query or placed by hand, and neither is a habit. */
  const byId = new Map(items.map((item) => [item.id, item]))
  const recent = recents
    .map((id) => byId.get(id))
    .filter((item): item is PaletteItem => !!item && !item.always && !item.rank)
  const order = new Map(recent.map((item, index) => [item.id, index]))
  const lifted = q ? new Set<string>() : new Set(recent.slice(0, RECENT_SHOWN).map((i) => i.id))

  const groupOf = (item: PaletteItem) => (lifted.has(item.id) ? RECENT_GROUP : item.group)

  const groups = new Map<string, Ranked[]>()
  // Recents first, then declared order — kept even for a group whose rows all
  // scored out.
  if (lifted.size > 0) groups.set(RECENT_GROUP, [])
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
    const rank = order.get(item.id)
    const recency = rank === undefined ? 0 : RECENCY_BONUS - rank / recent.length
    groups.get(groupOf(item))!.push({ item, score: row.score + bias + recency })
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
  } else {
    /* Nothing is typed, so every row scored 1 and only the recency nudge tells
       them apart — which is exactly the order the lifted group wants, and no
       order at all for the rest, whose declared sequence must survive. */
    const recentGroup = out.find((group) => group.name === RECENT_GROUP)
    recentGroup?.rows.sort((a, b) => b.score - a.score)
  }
  return out.map((group) => ({ name: group.name, items: group.rows.map((row) => row.item) }))
}

