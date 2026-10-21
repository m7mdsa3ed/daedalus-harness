/* ── Dropping a place on the dock ──
   A sidebar row dragged over the dock asks the pointer the same question the
   dock already answers for its own tabs — *where does this land?* — and the
   answer is read off the group under the pointer, never off a drop zone drawn
   for it:

     - over a group's **strip**, or its middle, it joins that strip as a tab;
     - near an **edge**, it makes a column or a row beside that group, which is
       the only way to see two things at once.

   The hit test walks the grid groups' own boxes (`DockviewGroupPanel.element`),
   so floats and the bottom panel are not somewhere a drop lands: a float would
   cover the very strip the dropped tab is supposed to join, and the bottom
   panel is where a tab is *sent* (`moveToBottom`), not where one opens.

   **The mark is drawn on the half the drop would take**, which is the one thing
   that makes a side drop believable before the button is released: a tint over
   the left half is a column on the left. `within` gets the whole group, because
   the whole group is what the tab joins. */
import * as React from "react"
import type { DockviewApi, DockviewGroupPanel } from "dockview-react"

import type { DockController } from "@/components/workspace/dock"
import type { SplitSide } from "@/components/workspace/dock-context"
import { carriesRoute, draggedRoute, endRouteDrag } from "@/lib/workspace/route-drag"

/** Where a drop would put the place, and the box it was asked of. */
export interface DropPlan {
  group: DockviewGroupPanel
  side: SplitSide | "within"
  rect: DOMRect
}

/** How much of a group's width or height counts as "beside" rather than "in". */
const EDGE = 0.25
/** The strip at the top of a group — its tabs and their two controls. Measured
    rather than asked of dockview: it is one band high at every width. */
const STRIP_PX = 56

function sideAt(rect: DOMRect, x: number, y: number): SplitSide | "within" {
  if (y - rect.top <= STRIP_PX) return "within"
  const dx = Math.min(x - rect.left, rect.right - x) / Math.max(rect.width, 1)
  const dy = Math.min(y - rect.top, rect.bottom - y) / Math.max(rect.height, 1)
  /* The nearer edge wins, within the margin — a drop in a corner is a column
     and not a row, because a column is the smaller change to read. */
  if (dx <= dy && dx <= EDGE) return x - rect.left < rect.right - x ? "left" : "right"
  if (dy < dx && dy <= EDGE) return y - rect.top < rect.bottom - y ? "above" : "below"
  return "within"
}

/** The grid group under a point, and where in it a drop would land. */
export function planDrop(api: DockviewApi | null, x: number, y: number): DropPlan | null {
  if (!api) return null
  for (const group of api.groups) {
    if (group.api.location.type !== "grid") continue
    const rect = group.element.getBoundingClientRect()
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue
    return { group, side: sideAt(rect, x, y), rect }
  }
  return null
}

const samePlan = (a: DropPlan | null, b: DropPlan | null) =>
  a === b || (!!a && !!b && a.group.id === b.group.id && a.side === b.side)

/**
 * The dock's drop target: the handlers for the box the dock is drawn in, the ref
 * it needs for its own coordinates, and the mark to render inside it.
 */
export function useRouteDrop(dock: DockController) {
  const [plan, setPlan] = React.useState<DropPlan | null>(null)
  const box = React.useRef<HTMLDivElement>(null)

  /* The drag's own end is the one thing the dock cannot see: it settles on the
     row that started it, or on a drop outside the window — so the mark the
     stylesheet keys off (`route-drag.ts`) is cleared from here, where the dock
     is mounted whether or not a drop ever arrives. */
  React.useEffect(() => {
    /* Both the mark and the document flag: a drag cancelled with Escape settles
       on the row that started it and never reaches this box, so a mark left
       standing would be a panel highlighted by nothing. */
    const done = () => {
      endRouteDrag()
      setPlan(null)
    }
    window.addEventListener("dragend", done, true)
    window.addEventListener("drop", done, true)
    return () => {
      window.removeEventListener("dragend", done, true)
      window.removeEventListener("drop", done, true)
      endRouteDrag()
    }
  }, [])

  const handlers = React.useMemo(
    () => ({
      onDragOver: (event: React.DragEvent) => {
        if (!carriesRoute(event.dataTransfer)) return
        /* Only a prevented `dragover` makes the box a drop target at all, and
           only a `copy` effect draws the "+" the reader expects of a drag that
           adds something rather than moves it. */
        event.preventDefault()
        event.dataTransfer.dropEffect = "copy"
        /* `dragover` fires while the pointer is still, so the state is only set
           when the answer changed — a mark re-rendered per event is a mark that
           flickers under a steady hand. */
        const next = planDrop(dock.apiRef.current, event.clientX, event.clientY)
        setPlan((previous) => (samePlan(previous, next) ? previous : next))
      },
      onDragLeave: (event: React.DragEvent) => {
        /* A leave is also raised on the way into a child of the box; only a
           pointer that has really gone clears the mark. */
        if (box.current?.contains(event.relatedTarget as Node | null)) return
        setPlan(null)
      },
      onDrop: (event: React.DragEvent) => {
        const path = draggedRoute(event.dataTransfer)
        const at = planDrop(dock.apiRef.current, event.clientX, event.clientY)
        setPlan(null)
        endRouteDrag()
        if (!path) return
        event.preventDefault()
        dock.openRoute(
          path,
          at ? { group: at.group.id, ...(at.side === "within" ? {} : { side: at.side }) } : undefined
        )
      },
    }),
    [dock]
  )

  return {
    ref: box,
    handlers,
    indicator: plan ? <RouteDropMark plan={plan} box={box.current} /> : null,
  }
}

function RouteDropMark({ plan, box }: { plan: DropPlan; box: HTMLDivElement | null }) {
  if (!box) return null
  const outer = box.getBoundingClientRect()
  const r = plan.rect
  /* The half the drop would take. `within` takes the group. */
  const half = (() => {
    switch (plan.side) {
      case "left":
        return { x: r.left, y: r.top, w: r.width / 2, h: r.height }
      case "right":
        return { x: r.left + r.width / 2, y: r.top, w: r.width / 2, h: r.height }
      case "above":
        return { x: r.left, y: r.top, w: r.width, h: r.height / 2 }
      case "below":
        return { x: r.left, y: r.top + r.height / 2, w: r.width, h: r.height / 2 }
      default:
        return { x: r.left, y: r.top, w: r.width, h: r.height }
    }
  })()
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-20 rounded-lg border-2 border-primary/60 bg-primary/10 transition-[left,top,width,height] duration-100"
      style={{
        left: half.x - outer.left,
        top: half.y - outer.top,
        width: half.w,
        height: half.h,
      }}
    />
  )
}
