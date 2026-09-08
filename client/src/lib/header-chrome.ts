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

/** A control capsule, for the header's icon buttons — the sidebar toggle and
    the view-settings sliders beside it.

    **The ground and the radius are the tab's, and they are in `index.css`**
    (`.header-chip`, written beside `.panel-tab-chip` and out of the same
    values). These controls and the tabs stand on the same line whenever a group
    joins the header's band, and a pill of `--background` next to a rounded
    rectangle of `--composer` is two materials pretending to be one bar. Only
    the size is here, because only the size is layout.

    It is deliberately an unlayered CSS class and not utilities: it has to beat
    the button's own `rounded-4xl`, which the utilities layer would not.

    `size-8` is the **tab's** height (`h-8` in `workspace/panel-tab`), which is
    the number that matters: these two controls and that group's tabs are one
    row whenever a group joins the band, and a 24px control beside a 32px tab
    reads as a strip tucked under the header rather than as the header's own
    line. The sidebar header's own buttons are not bound by this — they stand on
    a surface of their own, with nothing to line up with. */
export const HEADER_CHIP = "header-chip size-8"

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
