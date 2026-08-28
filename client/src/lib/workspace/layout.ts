/* ── Workspace layout persistence ──
   The saved dock, per connected server.

   v1 was one global key, which was fine while the dock only held threads: a
   thread id is unique, so the worst a second server could do was contribute
   panels that pruned themselves. Panels are not like that — an `explorer:{id}`
   or a `terminal:{id}` from one server means something else entirely on
   another, and restoring it would point a file tree at a project that does not
   exist there. So the key carries the server.

   What it is NOT keyed by is the project. The dock is already cross-project —
   the sidebar groups threads by project and any mix of them can be open at
   once, and there is no "active project" anywhere in this app — so a
   project-scoped layout would have to be swapped on a switch that never
   happens. Projects scope *panels*, and scope authorization on the server.

   Restoring is the untrusted path here: the JSON was written by some past build
   and names components and params this one may no longer have. `pruneLayout`
   drops exactly the panels that do not parse and keeps the rest, because the
   alternative — the try/catch that used to wrap `fromJSON` — threw away a whole
   workspace over one bad entry. */
import type { SerializedDockview } from "dockview-react"

import { isPanelKind, parsePanel } from "./panels"

const PREFIX = "daedalus.dock.v2"
const LEGACY_KEY = "daedalus.sessionDock.v1"

export function layoutKey(serverId: string): string {
  return `${PREFIX}:${serverId}`
}

type GridNode = { type: "leaf" | "branch"; data: unknown; size?: number; visible?: boolean }
type LeafData = { views: string[]; activeView?: string; id: string }

/**
 * Drop what cannot be restored; keep everything else.
 *
 * Returns null when nothing survives — the caller starts from an empty dock
 * rather than from a grid describing groups with no panels in them, which
 * Dockview renders as an unclosable blank frame.
 */
export function pruneLayout(layout: SerializedDockview): SerializedDockview | null {
  const panels = layout?.panels
  if (!panels || typeof panels !== "object") return null

  const kept: SerializedDockview["panels"] = {}
  for (const [id, state] of Object.entries(panels)) {
    const component = state?.contentComponent
    /* A kind this build does not have at all is dropped; a kind it has but has
       not built yet is kept, because it renders as the unsupported state and
       the user can close it themselves. Deleting it would silently discard a
       panel that a newer build (or the next phase) would understand. */
    if (!isPanelKind(component)) continue
    if (!parsePanel(component, state.params)) continue
    kept[id] = state
  }
  if (Object.keys(kept).length === 0) return null

  const walk = (node: GridNode | undefined): GridNode | null => {
    if (!node || typeof node !== "object") return null
    if (node.type === "branch") {
      const children = Array.isArray(node.data)
        ? (node.data as GridNode[]).map(walk).filter((child): child is GridNode => child !== null)
        : []
      if (children.length === 0) return null
      // A branch with one child left is that child — an empty split otherwise
      // stays in the grid as a sash with nothing on one side of it.
      if (children.length === 1) return { ...children[0], size: node.size }
      return { ...node, data: children }
    }
    const data = node.data as LeafData | undefined
    const views = Array.isArray(data?.views) ? data.views.filter((view) => view in kept) : []
    if (views.length === 0) return null
    const activeView = data?.activeView && views.includes(data.activeView) ? data.activeView : views[0]
    return { ...node, data: { ...data, views, activeView } }
  }

  const root = walk(layout.grid?.root as GridNode | undefined)
  if (!root) return null

  const activeGroup = layout.activeGroup
  return {
    ...layout,
    panels: kept,
    grid: { ...layout.grid, root: root as SerializedDockview["grid"]["root"] },
    ...(activeGroup ? { activeGroup } : {}),
    /* Floating and popout groups reference panels by id too, and this dock runs
       with `disableFloatingGroups`. Anything in them could not be shown, so it
       is not carried across. */
    floatingGroups: undefined,
    popoutGroups: undefined,
  }
}

/**
 * The layout for a server, already pruned, or null for a fresh dock.
 *
 * v1's key is read once as a fallback and left in place rather than deleted: it
 * held only chat panels, whose params this build still parses, and a user who
 * downgrades should find their tabs where they left them.
 */
export function loadLayout(serverId: string): SerializedDockview | null {
  const read = (key: string): SerializedDockview | null => {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return null
      return pruneLayout(JSON.parse(raw) as SerializedDockview)
    } catch {
      /* Corrupt JSON reads as no layout. There is nothing to tell the user —
         the dock they get is the one a first run gets. */
      return null
    }
  }
  return read(layoutKey(serverId)) ?? read(LEGACY_KEY)
}

export function saveLayout(serverId: string, layout: SerializedDockview): void {
  try {
    localStorage.setItem(layoutKey(serverId), JSON.stringify(layout))
  } catch (error) {
    // Quota, or private-mode storage. The dock still works; it just will not
    // come back. Not worth a toast on every layout change.
    console.warn("Could not persist the workspace layout", error)
  }
}

export function clearLayout(serverId: string): void {
  try {
    localStorage.removeItem(layoutKey(serverId))
  } catch {
    /* nothing to clear */
  }
}
