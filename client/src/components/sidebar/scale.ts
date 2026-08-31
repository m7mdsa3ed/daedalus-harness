import { cn } from "@/lib/utils"

/* Group titles, not rows. A label used to be the same size, weight and colour
   as the threads under it, so "Recent" scanned as a thread called Recent.
   Smaller, uppercase, tracked out, and darker than the rows beneath — /80 over
   the sidebar surface keeps it legible while the rows stay full-strength.
   Shared by every sidebar group (the settings nav too) so the whole panel has
   one title voice. */
export const GROUP_LABEL =
  "flex h-7 gap-1.5 px-2 text-[11px] font-bold tracking-[0.06em] uppercase text-sidebar-foreground/80"

/* ── One spacing scale for the whole sidebar ──
   Every row, label and group in this panel draws from these, so nothing is
   a pixel off its neighbour:

     GROUP   the horizontal inset of a tier (`px-2`), no vertical padding of
             its own — TIER is the gap between tiers.
     LABEL   h-7 at the same `px-2` as a row, so label text and row icons
             share a left edge (GROUP_LABEL above).
     ROW     h-8, `px-2`, 13px text, `gap-2` between icon and title (from the
             menu-button base), every svg `size-4`. The one exception is the
             footer's two-line server row, which is h-11 on purpose.
     MENU    `gap-0.5` between rows — the base primitive's `gap-1` reads as
             a list of buttons, not an index.
     ACTION  a row's hover control (⋯, +) at `top-1.5 right-1`: centred in an
             h-8 row (the primitive's `top-1` for size=sm is for its h-7 rows).
             A folder row reserves `pr-8` for its + (the primitive's default);
             a thread row does NOT (`FLOAT_ROW`) — the title runs to the edge
             and the ⋯ floats over it on hover, painted in the row's own hover
             colour (`FLOAT_ACTION`), instead of stopping 32px early on
             every row for a control that is only there when the pointer is.
     NEST    a folder's threads, indented so a child's icon sits under the
             folder's own — the border is the folder chevron's centre line. */
export const ROW = "h-8 px-2 text-[13px]"
export const MENU = "gap-0.5"
export const GROUP = "px-2 py-0"
export const TIER = "mt-3"
export const ACTION = "top-1.5! right-1"
/* The thread row: no reserved gutter — see ACTION. The ⋯ then sits over the
   title, so it carries an opaque ground: `bg-sidebar-accent` is what the row
   itself is painted while hovered or active, the two states the button is
   visible in, so it reads as part of the row rather than a chip on it. */
export const FLOAT_ROW = "pr-2!"
export const FLOAT_ACTION = cn(ACTION, "bg-sidebar-accent hover:bg-sidebar-border")
export const NEST = "ml-4 border-l border-sidebar-border pl-2 py-0.5"

/** Rows a long-tail list (a project folder, Trash) shows before "Show more". */
export const PROJECT_PAGE_SIZE = 6
