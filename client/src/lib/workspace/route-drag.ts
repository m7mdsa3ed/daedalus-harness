/* ── A place, dragged ──
   A row in the sidebar stands for a place the dock can show, and dragging it
   into the dock is the pointer's version of "open this there" — the same two
   shapes the row's menu offers, chosen by where the drop lands: on a strip it
   joins that strip as a tab, on a group's edge it makes a column or a row
   beside it (`components/workspace/dock-drop.tsx` reads it).

   **The payload is the route, not a descriptor.** A page is a path and a thread
   is a path, so one MIME carries both and the dock lands it through the door
   its own opening already uses (`openRoute` in `dock.tsx`) — a drag cannot
   invent a panel shape that a click could not have opened.

   Native HTML5 drag, deliberately: dockview's own drag is pointer-based and
   internal to its panels, and the rows being dragged here are not dockview's.
   `text/plain` rides along so a drag that ends outside the app leaves the
   address behind rather than nothing. */

import type * as React from "react"

/** What a dragged row carries. Read by the dock and by nothing else. */
export const ROUTE_MIME = "application/x-daedalus-route"

/** Arm a native drag from a row that stands for `path`. */
export function startRouteDrag(event: React.DragEvent, path: string): void {
  event.dataTransfer.setData(ROUTE_MIME, path)
  event.dataTransfer.setData("text/plain", path)
  event.dataTransfer.effectAllowed = "copy"
  /* Marked for the stylesheet's sake: a preview panel is an iframe, and an
     iframe takes the drag events before the dock under it can (`index.css`). */
  document.documentElement.dataset.routeDrag = ""
}

/** Drop the mark. Called when the drag settles, wherever it settles. */
export function endRouteDrag(): void {
  delete document.documentElement.dataset.routeDrag
}

/** Whether a drag in flight is one of ours. `dragover` may read the types and
    not the data — the browser withholds the payload until the drop. */
export function carriesRoute(data: DataTransfer | null): boolean {
  return !!data && Array.from(data.types).includes(ROUTE_MIME)
}

/** The route a drop carries, or null when the drag was something else — a file,
    a selection, a link from another app. */
export function draggedRoute(data: DataTransfer | null): string | null {
  if (!data) return null
  const path = data.getData(ROUTE_MIME) || data.getData("text/plain")
  /* Only what this app can show. An absolute or protocol URL dropped from a
     browser is not a route, and opening it as one would be a blank page tab. */
  return path.startsWith("/") ? path : null
}
