/* ── How a group of calls is bracketed ──
   A parallel batch is one set of calls and there is more than one honest way to
   draw a set. This module is the answer for each (`GROUP_STYLES` in
   `lib/layout-options`), so `ToolRun` reads a treatment rather than spelling
   `bg-… ring-…` inline and the three cannot drift apart.

   It owns two things per style and nothing else:

   - the **frame**: the class on the box that holds the header and the calls —
     the frame and their ground at once, because the calls sit inside it.
   - the **layout**: whether the calls are a list or a grid, how wide the grid's
     columns are, and what a cell looks like when there are cells.

   ── One column, every style ──
   All three frames sit **flush on the transcript's column** — the same edge a
   step row's hover ground, a todo card, the thinking panel and the gap rule are
   on. None of them bleeds.

   It used to, and that was the bug this file now prevents: `-mx-2` with `px-2`
   holds its *content* on the column (the padding puts it back), but it put the
   *frame* 8px outside every other turn part. In one turn that read as three
   different columns — the thinking panel at +4, the todo card and step rows at
   0, the batch at −8 — so the batch's header started left of the card above it
   and its chevron ran past the prose below it. A bleed is only free when it is
   the one thing on screen that has an edge; beside cards and rules that all sit
   on the column, it reads as a box that does not line up.

   So: no bleed, and the frame is the column. The paint room in the clips that
   can hold a group (`-mx-2 px-2` in `thread-view.tsx`, `rows.tsx`,
   `thread-cards.tsx`) is still there and costs nothing — it is room, not an
   offset — and a style added tomorrow that does want to bleed may use it. */
import * as React from "react"

import type { GroupStyle } from "@/lib/layout-options"
import { cn } from "@/lib/utils"

export interface GroupTreatment {
  /** The box holding the header and the calls — the frame *and* their ground,
   *  because the calls sit inside it. Empty for a style that draws no box. */
  frame: string
  /** The element the calls are laid into: a list for two styles, a grid for
   *  `columns`. */
  list: string
  /** The calls are placed by a grid rather than stacked on the run's rail —
   *  which also means no trunk, no elbow and no rail indent. */
  grid?: boolean
  /** One call's cell, in `columns` — a box of its own, since side-by-side calls
   *  share the frame's ground and need an edge to separate them. Absent for the
   *  list styles, where a call is a row on the rail. */
  cell?: string
}

/* ── The frame, per style ──
   A live batch takes the accent's colour on the same weight, because it is the
   one thing on screen still happening — the bargain the running badge makes,
   not a heavier box. The resting weight is the transcript's, never a badge's:
   the tint is the `!` run's `/[0.06]` and the edge is `ring-foreground/10`, the
   app's own border tone. A first version reached for `bg-primary/10` and
   `ring-primary/25`, which put one row's frame 56 levels below every other edge
   on screen — a box shouting over its own contents. */
/* `px-1`, not `px-2`, and the number is not free: the header and every call row
   inside a frame carry StepRow's `-mx-1 px-1`, which holds their content on the
   column while their hover ground bleeds 4px out. The frame supplies exactly
   that 4px, so the content lands on the column and the hover ground meets the
   frame's own edge. A wider frame padding pushed the whole group 4px right of
   every step row beside it. */
const frame = (style: GroupStyle, live: boolean): string => {
  if (style === "card") {
    /* The app's inset ground (`INSET`'s border + `bg-muted/50`), flush with the
       column: a card is a box you can see the edges of. */
    return cn("rounded-xl border bg-muted/50 px-1 py-1", live && "border-primary/30")
  }
  /* Three frames draw no box: a bracket is a rule, a ledger is two hairlines and
     tiles leave the ground to each call. All keep the column's 4px (`px-1`) so
     the content lands where every other style puts it. */
  if (style === "bracket") {
    return cn(
      "relative px-1 py-1 before:absolute before:inset-y-1 before:start-0 before:w-0.5 before:rounded-full before:bg-foreground/15",
      live && "before:bg-primary/60"
    )
  }
  if (style === "ledger") {
    return cn("border-y border-foreground/10 px-1 py-1", live && "border-primary/30")
  }
  if (style === "tiles") return "px-1 py-1"
  /* `wash` and `columns` share the marked-stretch frame — the tint says the set
     is one stretch, and only the *inside* differs (a rail or a grid). Both are
     flush with the column too: the tint and the edge are enough to draw the set
     without pushing it off the line every other turn part is on. */
  return cn(
    "ring-1 ring-foreground/10 ring-inset rounded-xl bg-primary/[0.06] px-1 py-1",
    live && "ring-primary/30"
  )
}

export function groupTreatment(style: GroupStyle, live: boolean): GroupTreatment {
  switch (style) {
    case "card":
      return { frame: frame("card", live), list: "space-y-0 divide-y" }
    case "columns":
      /* The calls side by side, because they ran side by side. `@panel-sm` is
         the panel's width, never the viewport's: a chat squeezed beside a
         terminal is narrow for the same reason a phone is, and two columns of
         step rows in half a panel is two columns of truncated titles. Below it
         the grid falls back to one column, which is the list layout. */
      return {
        frame: frame("columns", live),
        list: "grid grid-cols-1 gap-1 @panel-sm:grid-cols-2",
        grid: true,
        /* A cell carries its own padding so two calls never share a hover
           ground — a gutter that lit up as one row would undo "side by side". */
        cell: "min-w-0 rounded-lg px-1",
      }
    case "bracket":
      /* No ground at all: a rule down the start edge is the whole mark. The
         calls take the grid placement (no rail, no elbow) because the bracket
         is the line they hang from. */
      return { frame: frame("bracket", live), list: "", grid: true, cell: "min-w-0" }
    case "ledger":
      return { frame: frame("ledger", live), list: "divide-y divide-foreground/10", grid: true, cell: "min-w-0 py-0.5" }
    case "tiles":
      return {
        frame: frame("tiles", live),
        list: "flex flex-col gap-1 pt-1",
        grid: true,
        cell: cn("min-w-0 rounded-lg border bg-muted/40 px-1", live && "border-primary/20"),
      }
    case "wash":
    default:
      return { frame: frame("wash", live), list: "" }
  }
}
