/* ── How much of a panel the floating app header covers ──
   A measurement, published as a CSS variable, because it is different for every
   panel and changes whenever the layout does.

   The app header is an overlay across the top of the whole column
   (`app-shell.tsx`), so anything under it holds its own content clear. That was
   the constant `--app-header-h` everywhere, which is right for the group at the
   top and wrong for every other one: a terminal docked *below* a thread
   reserved three rems for a header nowhere near it — and, under a visible tab
   strip, reserved it a second time on top of the strip's own margin.

   **The panel measures itself, and that is the whole reason this is a module
   rather than a line in the dock.** The dock renders panels with
   `defaultRenderer="always"`, which attaches their content to one overlay
   container at the dockview root instead of nesting it inside the group — so a
   variable set on the group element reaches the tab strip and *nothing else*.
   The strip's own offset is still the dock's to set (it is a real child of the
   group); everything below it is answered here, from the panel's own box.

   The dock still has to say *when*: a group can move without changing size — a
   sash drag settling, a maximize, a panel moved between groups — and an element
   that only watches its own size never hears about it. `notifyDockLayout` is
   that signal, and the subscription is what a panel container listens on. */

/** Set on a panel's container; read by the panel's own root padding. */
export const CONTENT_OVERLAP = "--dock-content-overlap"

const listeners = new Set<() => void>()

/** Tell every mounted panel container to measure itself again. Called by the
    dock on every layout change (already coalesced into a frame there). */
export function notifyDockLayout(): void {
  for (const listener of [...listeners]) listener()
}

export function subscribeDockLayout(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The bottom edge of the floating header, in this document. 0 when there is
    none — a popout window, or a surface rendered before the shell exists. */
function headerBottom(doc: Document): number {
  const header = doc.querySelector<HTMLElement>("[data-app-header]")
  return header ? header.getBoundingClientRect().bottom : 0
}

/**
 * Measure `element` against the header and publish the overlap on it.
 *
 * A hidden panel measures 0×0 — the dock keeps every panel mounted — and that
 * is not "the header covers all of me", it is "I am not on screen". Writing it
 * would pad the top of a transcript nobody is looking at, so a zero-height box
 * keeps whatever it last measured; the observer fires again on the way back in.
 */
export function applyContentOverlap(element: HTMLElement): void {
  const rect = element.getBoundingClientRect()
  if (rect.height === 0) return
  /* A popped-out panel is in another window, where this document's header
     covers nothing — `ownerDocument` is what tells the two apart. */
  const bottom = headerBottom(element.ownerDocument)
  const overlap = Math.max(0, Math.min(bottom - rect.top, bottom))
  element.style.setProperty(CONTENT_OVERLAP, `${Math.round(overlap)}px`)
}
