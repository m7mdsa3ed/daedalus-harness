/* ── Even splits, and a double-click to make them even again ──
   Dockview halves the group a split lands beside, so a second split leaves a
   half and two quarters, and a third something nobody chose. Two rules put that
   right, the way the sidebar's divider resets on a double-click:

   - **A new group is the same size as its siblings.** When a group is added
     (the split chords, a tab dropped on an edge, the layout presets), every
     group in the same row — or column — becomes an equal share of what the row
     holds. Not while a layout is being restored: that is the saved sizes, and
     the caller says so (`isRestoring`).
   - **A double-click on a divider evens out its row (or column)**: every view
     the divider sits between takes an equal share.

   Both go through `group.api.setSize`, which is how the keyboard resize works
   too: along its parent's axis it moves the group's own edge, and across it the
   branch the group sits in, so a nested split is handled by the same call. The
   groups are told apart by their boxes (the same top and height are a row; the
   same left and width, a column) rather than by walking dockview's tree. */
import type { DockviewApi, DockviewGroupPanel } from "dockview-react"

const TOL = 3

const isGrid = (group: DockviewGroupPanel) => group.api.location.type === "grid"

function box(group: DockviewGroupPanel) {
  return group.element.getBoundingClientRect()
}

/** Make `groups` (in order along `axis`) equal shares of the room they hold. */
function share(groups: DockviewGroupPanel[], axis: "x" | "y") {
  if (groups.length < 2) return
  const size = (g: DockviewGroupPanel) => (axis === "x" ? box(g).width : box(g).height)
  const total = groups.reduce((sum, g) => sum + size(g), 0)
  const each = Math.round(total / groups.length)
  // The last takes the remainder, so the split sizes it is told sum to what is there.
  for (const g of groups.slice(0, -1))
    g.api.setSize(axis === "x" ? { width: each } : { height: each })
}

/** The grid groups level with `group` along an axis — its row (`x`) or column (`y`). */
function peers(api: DockviewApi, group: DockviewGroupPanel, axis: "x" | "y"): DockviewGroupPanel[] {
  const r = box(group)
  return api.groups
    .filter(isGrid)
    .filter((g) => {
      const q = box(g)
      return axis === "x"
        ? Math.abs(q.top - r.top) < TOL && Math.abs(q.height - r.height) < TOL
        : Math.abs(q.left - r.left) < TOL && Math.abs(q.width - r.width) < TOL
    })
    .sort((a, b) => (axis === "x" ? box(a).left - box(b).left : box(a).top - box(b).top))
}

/** Even out the row and the column a group stands in. */
export function equalizeAround(api: DockviewApi, group: DockviewGroupPanel): void {
  if (!isGrid(group) || api.hasMaximizedGroup()) return
  share(peers(api, group, "x"), "x")
  share(peers(api, group, "y"), "y")
}

/** Make the views a divider separates equal. */
function equalizeSash(api: DockviewApi, sash: Element): boolean {
  const container = sash.closest(".dv-split-view-container")
  if (!container) return false
  const horizontal = container.classList.contains("dv-horizontal")
  const views = Array.from(container.querySelectorAll(":scope > .dv-view-container > .dv-view"))
  const groups = views.flatMap((view) => {
    const group = api.groups.find((g) => isGrid(g) && view.contains(g.element))
    return group ? [group] : []
  })
  if (groups.length < 2 || groups.length !== views.length) return false
  share(groups, horizontal ? "x" : "y")
  return true
}

/** A double-click on one of this instance's dividers evens its row out. Returns the teardown. */
export function watchSashReset(api: DockviewApi): () => void {
  const root = () => api.groups[0]?.element.closest(".dv-dockview") ?? null
  const onDoubleClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null
    const sash = target?.closest(".dv-sash")
    const mine = root()
    // This instance's own dividers only: a nested dock has its own listener.
    if (!sash || !mine || sash.closest(".dv-dockview") !== mine) return
    if (equalizeSash(api, sash)) event.preventDefault()
  }
  document.addEventListener("dblclick", onDoubleClick)
  return () => document.removeEventListener("dblclick", onDoubleClick)
}

/**
 * Watch the main dock: every new group is an equal share, and a divider resets
 * on a double-click. Returns the teardown.
 *
 * @param isRestoring true while the caller is putting a saved layout back, when
 *   a group appearing is not a split and its size is not ours to touch.
 */
export function watchSplits(api: DockviewApi, isRestoring: () => boolean = () => false): () => void {
  let frame = 0
  const added = api.onDidAddGroup((group) => {
    if (isRestoring()) return
    cancelAnimationFrame(frame)
    // Two frames: the group has its box once the grid has laid it out.
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (!isRestoring()) equalizeAround(api, group)
      })
    })
  })
  const stopReset = watchSashReset(api)
  return () => {
    cancelAnimationFrame(frame)
    added.dispose()
    stopReset()
  }
}
