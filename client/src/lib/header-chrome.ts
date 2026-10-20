/* ── What the app header's controls are made of ──

   The header is transparent by design: a transcript scrolls up *under* it and
   goes out of focus in the progressive blur, which is what makes the app feel
   like it has one continuous column rather than a bar stapled over a list. The
   cost is that everything sitting in the header has no ground of its own —
   a ghost icon button and a bare line of text both sat on whatever colour
   happened to be passing beneath them, and the four controls on the right read
   as four different things because three of them were invisible until hovered.

   Two shapes, because there are two kinds of occupant — a label that names
   something (`HEADER_BADGE`, a frosted capsule) and a control you press
   (`HEADER_CHIP`: a fully round ghost button at the chip height). Above `md`
   the strip box is transparent, so these sit as shapes on the shell's ground;
   below `md` each takes the shared mobile fill so a miss still lands on a
   shape, not the transcript.

   Kept here rather than in `app-shell` so the bell, the ⋯ menu and the context
   ring — each its own component, each drawn only in this header — can wear it
   without importing the shell that holds them. */

/** A label capsule: the project over the title, and the title itself. Pair it
    with the text size the line wants; this is the ground, not the type. */
export const HEADER_BADGE =
  "rounded-full bg-background/50 ring-1 ring-border/50 backdrop-blur-sm"

/** ── The material every strip control and tab is made of ──
 *
 * **The composer card's own edge and depth**, at chip scale: `ring-1 ring-edge`
 * and `shadow-glass` — the same two the box wears (`composer.tsx`). Shared by
 * the header's controls, the strip's (`STRIP_CONTROL`, `tab-actions.tsx`, the
 * tab-list switcher) and the tab itself (`index.css`), so a row is one family
 * of raised shapes rather than bare glyphs beside a filled tab.
 *
 * The strip box is transparent on every width — these are the shapes, not a bar
 * under them. Above `md` the ground stays off (the shell under the strip is
 * already a surface); below `md` the band overlays a blurred transcript, so a
 * translucent wash disappears into the blur. Each takes
 * `--dock-mobile-tab-ground`: the composer's own opaque ground — the colour the
 * sidebar and the box wear — so the toggle, the switcher and the tab are the
 * same surface as both, raised off the blur by the edge and the shadow.
 *
 * **The edge is a phone's.** Above `md` the buttons wear no ring (`md:ring-0`):
 * the shell under the strip is already a surface, and a hairline round a bare
 * glyph reads as a box where the desktop wants a button. The tab keeps its own.
 *
 * Fully round, as is the tab (`--dock-corner` is the pill). The header's stay
 * round at the chip's height (`--dock-chip-h`): a square-ish corner on a glyph
 * that size reads as a tab that failed to grow. */
export const STRIP_GROUND =
  "rounded-pill shadow-glass ring-1 ring-edge max-md:bg-[var(--dock-mobile-tab-ground)] md:ring-0"

/** The header's icon buttons — the sidebar toggle and the view-settings
    sliders beside it. The same material as every strip item: fully round,
    `ring-edge` + `shadow-glass` (the composer card's edge and depth). No fill
    above `md` — the strip box is transparent and the shell underneath is
    already a surface. Below `md` they take the shared mobile fill
    (`STRIP_GROUND`).

    Its height is the **tab's** (`--dock-chip-h`, spelled in `index.css`), which
    is the number that matters: these two controls and that group's tabs are one
    row whenever a group joins the band, and a 24px control beside a 28px tab
    reads as a strip tucked under the header rather than as the header's own
    line. It is the same token `WORKSPACE/DOCK`'s strip takes, so the three
    cannot drift apart. The sidebar header's own buttons are not bound by this —
    they stand on a surface of their own, with nothing to line up with. */
export const HEADER_CHIP = `size-[var(--dock-chip-h)] ${STRIP_GROUND}`
