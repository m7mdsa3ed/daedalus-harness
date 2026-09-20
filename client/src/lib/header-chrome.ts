/* ── What the app header's controls are made of ──

   The header is transparent by design: a transcript scrolls up *under* it and
   goes out of focus in the progressive blur, which is what makes the app feel
   like it has one continuous column rather than a bar stapled over a list. The
   cost is that everything sitting in the header has no ground of its own —
   a ghost icon button and a bare line of text both sat on whatever colour
   happened to be passing beneath them, and the four controls on the right read
   as four different things because three of them were invisible until hovered.

   So every occupant of the header is a frosted capsule: the same translucent
   ground, the same hairline ring, its own `backdrop-blur` over the progressive
   blur behind it. Two shapes, because there are two kinds of occupant — a
   label that names something (`HEADER_BADGE`) and a control you press
   (`HEADER_CHIP`, which is the same ground on a `size="icon-sm"` button, whose
   `rounded-4xl` already makes the pill).

   Kept here rather than in `app-shell` so the bell, the ⋯ menu and the context
   ring — each its own component, each drawn only in this header — can wear it
   without importing the shell that holds them. */

/** A label capsule: the project over the title, and the title itself. Pair it
    with the text size the line wants; this is the ground, not the type. */
export const HEADER_BADGE =
  "rounded-full bg-background/50 ring-1 ring-border/50 backdrop-blur-sm"

/** ── A ground for a control in the strip, on a phone ──
 *
 * Above `md` the row's occupants stand on the shell's own ground beside the
 * tabs and need nothing: the strip is a row of shapes and they are more of
 * them. Below it the strip is an *overlay* — the transcript scrolls under the
 * bar and goes out of focus in the progressive blur (`app-shell.tsx`) — so a
 * bare glyph sits on whatever line happens to be passing beneath it, and with
 * the tab beside them taking the whole strip they are the only things in the
 * row without a shape.
 *
 * **The active tab's material, not a frosted capsule of its own**: `--background`
 * and the card's `shadow-sm`, which is what the tab beside them is made of
 * (`html .dock-tab[data-active]`, `index.css`). They stand in that tab's row, so
 * one material is what makes the row one bar — a translucent ring-and-blur
 * beside an opaque slab is two kinds of chrome sharing a line. No ring, for the
 * same reason the tab has none: the ground *is* the edge.
 *
 * Shared by the header's own two controls and the strip's (`STRIP_CONTROL`,
 * `tab-actions.tsx`). Round rather than the tab's `calc(--radius - 2px)`: these
 * are 28px icon buttons, and a square-ish corner on a glyph that size reads as a
 * tab that failed to grow. */
export const STRIP_GROUND = "max-md:rounded-full max-md:bg-background max-md:shadow-sm"

/** The header's icon buttons — the sidebar toggle and the view-settings
    sliders beside it. Bare ghost buttons, no ground: the row stands on the
    wrapper's ground now rather than over a transcript, so there is nothing to
    lift them off (the frosted chip they wore is the tab's alone, `index.css`).

    Its height is the **tab's** (`--dock-chip-h`, spelled in `index.css`), which
    is the number that matters: these two controls and that group's tabs are one
    row whenever a group joins the band, and a 24px control beside a 28px tab
    reads as a strip tucked under the header rather than as the header's own
    line. It is the same token `WORKSPACE/DOCK`'s strip takes, so the three
    cannot drift apart. The sidebar header's own buttons are not bound by this —
    they stand on a surface of their own, with nothing to line up with. */
export const HEADER_CHIP = `size-[var(--dock-chip-h)] ${STRIP_GROUND}`

/** The ground of a surface the app *raises over* its own content — what a
    capsule opens (the bell's glance) and what the app raises on its own (a
    toast). Frosted for the same reason the chip is: these float over a moving
    transcript, and a solid slab there reads as a second window rather than
    something belonging to the one you are in.

    `supports-[backdrop-filter]` keeps it nearly opaque where the filter is
    unavailable — a translucent panel with no blur behind it is unreadable.

    Kept beside the header's own two because it is the same recipe at a
    different scale, and one recipe is the point: a frosted surface that is
    frosted *differently* looks like a bug. */
export const GLASS_SURFACE =
  "bg-popover/95 backdrop-blur-xl supports-[backdrop-filter]:bg-popover/75"
