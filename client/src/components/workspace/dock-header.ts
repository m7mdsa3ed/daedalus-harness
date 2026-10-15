import type { DockviewApi } from "dockview-react"

import { notifyDockLayout } from "@/lib/workspace/panel-overlap"

/* ── The floating header, as a measurement ──
   The app header is an overlay across the top of the whole column
   (`app-shell.tsx`), so whatever is under it has to hold its own content clear
   of it. Every panel did that with a constant — `pt-[var(--app-header-h)]` —
   and so did the tab strip, which was right for the group at the top and wrong
   for every other one: a terminal docked *below* a thread reserved three rems
   for a header that is nowhere near it, twice over (the strip's margin and the
   panel's own padding), which is the band of nothing that used to sit above
   every bottom-docked terminal.

   So it is measured, and this is the **tab strip's** half of it. A group the
   header covers does not clear it — it stands *in its row* (`data-header-band`,
   `index.css`), which is what makes the two bars one: the app's controls and
   this group's tabs on the same line. The overlap is then the safe-area inset
   alone, so the tabs sit below the notch rather than behind it. A group the
   header does not reach clears nothing and keeps its own 36px strip.

   Standing in the row costs the strip the width of whatever header control is
   above it, and that is per group for exactly the reason the vertical overlap
   is: with three columns split across the top, the toggle is above the first
   and the bell above the last, and a constant would have the middle one
   reserving room for both. So both ends are measured too — the intersection of
   this group's box with each cluster — and a group left too narrow to show a
   tab ducks back under the header instead.

   The other half — what a *panel's content* pads by — is deliberately not set
   here, even though it looks like the same sum. Panels are rendered with
   `defaultRenderer="always"`, which attaches their content to one overlay
   container at the dockview root rather than nesting it in the group, so a
   variable set on a group element reaches its strip and nothing else. Each
   panel measures its own box instead (`lib/workspace/panel-overlap.ts`); all
   this side owes it is a nudge whenever the layout moves. */
const HEADER_OVERLAP = "--dock-header-overlap"
const BAND_LEFT = "--dock-band-left"
const BAND_RIGHT = "--dock-band-right"

/**
 * Strip left over for tabs, below which a group does not join the header's band
 * at all and takes its own row under it instead.
 *
 * The same judgement a split threshold made: a column too narrow to share the
 * row shows a 40px sliver of one tab between two of the app's controls, which
 * reads as broken. One group out of step reads as deliberate.
 */
const BAND_MIN_TABS = 120

export function syncHeaderOverlap(api: DockviewApi): void {
  const header = document.querySelector<HTMLElement>("[data-app-header]")
  const band = header?.getBoundingClientRect()
  const bandBottom = band?.bottom ?? 0
  /* ── The band is the header's *content box* ──
     Not its border box, on any axis. The header's padding is where it already
     states what the window has claimed: the safe-area inset on top (a strip
     level with the notch is a strip behind it), and on the right the caption
     buttons — 148px under Electron on Windows and Linux, `titlebar-area-*`
     under the PWA's window-controls overlay (both in `index.css`, on
     `[data-drag-region]`, which this header is).
     Reading the padding rather than naming those numbers again is the whole
     point: the strip stands where the header's own occupants stand, so
     anything the header learns to make room for, the tabs make room for too.
     It is also the only thing left holding the right end, now that every
     control has moved to the sidebar and there is no `[data-header-right]`. */
  const style = header ? getComputedStyle(header) : undefined
  const pad = (side: "Top" | "Left" | "Right") =>
    style ? parseFloat(style[`padding${side}`] || "0") || 0 : 0
  const rowTop = band ? band.top + pad("Top") : 0
  const contentLeft = band ? band.left + pad("Left") : 0
  const contentRight = band ? band.right - pad("Right") : 0
  const cluster = (selector: string) =>
    header?.querySelector<HTMLElement>(selector)?.getBoundingClientRect()
  /* A cluster narrows the content box further; without one the box itself is
     the bound. `[data-header-left]` is the toggle and the sliders — the whole
     of what the header holds now that every route's title is on its tab. */
  const leftBound = Math.max(contentLeft, cluster("[data-header-left]")?.right ?? contentLeft)
  const rightBound = Math.min(contentRight, cluster("[data-header-right]")?.left ?? contentRight)

  for (const group of api.groups) {
    const element = group.element
    /* A popped-out group is in another window, where this document's header
       covers nothing. Measuring it against a rect from a different viewport is
       how a second monitor would inherit a phone's notch. */
    const detached = element.ownerDocument !== document
    const rect = element.getBoundingClientRect()
    const covered = !detached && bandBottom > rect.top
    /* What reaches *into* this group, never the bound's own width: a column the
       header's claim does not overlap owes it nothing. */
    const reach = (overlap: number) => Math.max(0, Math.min(overlap, rect.width))
    const padLeft = covered ? reach(leftBound - rect.left) : 0
    const padRight = covered ? reach(rect.right - rightBound) : 0
    const banded = covered && rect.width - padLeft - padRight >= BAND_MIN_TABS

    element.toggleAttribute("data-header-band", banded)
    element.style.setProperty(BAND_LEFT, `${Math.round(banded ? padLeft : 0)}px`)
    element.style.setProperty(BAND_RIGHT, `${Math.round(banded ? padRight : 0)}px`)
    element.style.setProperty(
      HEADER_OVERLAP,
      `${Math.round(
        banded
          ? Math.max(0, rowTop - rect.top)
          : covered
            ? Math.max(0, Math.min(bandBottom - rect.top, bandBottom))
            : 0
      )}px`
    )
  }
  notifyDockLayout()
}
