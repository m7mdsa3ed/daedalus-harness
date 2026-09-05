/* ── Workspace layout persistence ──
   The saved dock, per connected server.

   v1 was one global key, which was fine while the dock only held threads: a
   thread id is unique, so the worst a second server could do was contribute
   panels that pruned themselves. Panels are not like that — an `editor:{id}`
   or a `terminal:{id}` from one server means something else entirely on
   another, and restoring it would point an editor at a project that does not
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
/** Dockview writes a float or a popout either as one group (`data`) or as a
    whole grid of them (`grid`) — the same two shapes for both. */
type WindowEntry = { data?: unknown; grid?: unknown; gridReferenceGroup?: string }

/** Every panel id a serialized window names, whichever of the two shapes it
    was written in. Order is the tab order within each group it holds. */
function viewsOf(entry: WindowEntry | undefined): string[] {
  const found: string[] = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return
    const candidate = node as { views?: unknown; data?: unknown; root?: unknown }
    if (Array.isArray(candidate.views)) {
      for (const view of candidate.views) if (typeof view === "string") found.push(view)
    }
    if (Array.isArray(candidate.data)) for (const child of candidate.data) walk(child)
    else if (candidate.data) walk(candidate.data)
    if (candidate.root) walk(candidate.root)
  }
  walk(entry?.data)
  walk(entry?.grid)
  return found
}

/**
 * Bring every popped-out panel back into the grid, and drop the popout entries.
 *
 * Where they land is the group they were torn from (`gridReferenceGroup`,
 * which Dockview records for exactly this), and failing that the first leaf —
 * the same answer "close the window" gives while the app is running. The panels
 * themselves are untouched; only which leaf names them changes.
 */
function dockPopouts(layout: SerializedDockview): SerializedDockview {
  const popouts = layout?.popoutGroups
  if (!Array.isArray(popouts) || popouts.length === 0) return layout

  const homeless: string[] = []
  const byGroup = new Map<string, string[]>()
  for (const entry of popouts) {
    const views = viewsOf(entry as WindowEntry)
    if (views.length === 0) continue
    const reference = (entry as WindowEntry).gridReferenceGroup
    if (reference) byGroup.set(reference, [...(byGroup.get(reference) ?? []), ...views])
    else homeless.push(...views)
  }
  if (byGroup.size === 0 && homeless.length === 0) return { ...layout, popoutGroups: undefined }

  /* Panels from a window that no longer names the group it came from go to the
     first leaf — where the dock would have put them anyway. Found in its own
     pass so the walk below stays a pure rebuild. */
  const firstLeafId = ((): string | undefined => {
    const find = (node: GridNode | undefined): LeafData | undefined => {
      if (!node || typeof node !== "object") return undefined
      if (node.type === "branch") {
        for (const child of Array.isArray(node.data) ? (node.data as GridNode[]) : []) {
          const leaf = find(child)
          if (leaf) return leaf
        }
        return undefined
      }
      return node.data as LeafData | undefined
    }
    return find(layout.grid?.root as GridNode | undefined)?.id
  })()

  const walk = (node: GridNode | undefined): GridNode | undefined => {
    if (!node || typeof node !== "object") return node
    if (node.type === "branch") {
      const children = Array.isArray(node.data) ? (node.data as GridNode[]).map(walk) : node.data
      return { ...node, data: children }
    }
    const data = node.data as LeafData | undefined
    if (!data) return node
    const extra = [
      ...(data.id ? (byGroup.get(data.id) ?? []) : []),
      ...(data.id && data.id === firstLeafId ? homeless : []),
    ]
    if (extra.length === 0) return node
    /* A group that was emptied by the popout is serialized with no views, and
       the panels coming home are what make it a group again — so it is filled
       before the prune above counts leaves, not after. */
    const views = [...(Array.isArray(data.views) ? data.views : []), ...extra]
    return { ...node, data: { ...data, views } }
  }

  const root = walk(layout.grid?.root as GridNode | undefined)

  return {
    ...layout,
    grid: { ...layout.grid, root: root as SerializedDockview["grid"]["root"] },
    popoutGroups: undefined,
  }
}

/**
 * Drop what cannot be restored; keep everything else.
 *
 * Returns null when nothing survives — the caller starts from an empty dock
 * rather than from a grid describing groups with no panels in them, which
 * Dockview renders as an unclosable blank frame.
 */
export function pruneLayout(layout: SerializedDockview): SerializedDockview | null {
  /* A popped-out window cannot be reopened on a page load — `window.open`
     without a gesture is a popup, and a browser blocks it — so a restore never
     starts one. Its panels come home to the grid first, before anything is
     counted: dropping the entry on its own would leave them in `panels` with
     no leaf naming them, which is a panel the dock holds and cannot show. */
  const source = dockPopouts(layout)
  const panels = source.panels
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

  const root = walk(source.grid?.root as GridNode | undefined)
  if (!root) return null

  const activeGroup = source.activeGroup
  /* A floating group survives a reload — it is drawn inside this page, so
     nothing has to be reopened for it to come back. It is kept whole or not at
     all: a float is a window the user placed, and one with half its tabs
     missing is not the window they placed. */
  const floatingGroups = (source.floatingGroups ?? []).filter((entry) =>
    viewsOf(entry).every((view) => view in kept)
  )
  return {
    ...source,
    panels: kept,
    grid: { ...source.grid, root: root as SerializedDockview["grid"]["root"] },
    ...(activeGroup ? { activeGroup } : {}),
    ...(floatingGroups.length > 0 ? { floatingGroups } : { floatingGroups: undefined }),
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

/* ── Named layouts ──
   The dock above is the *current* one — written on every change, restored on
   every boot, one per server. A named layout is a different thing: a snapshot
   the user asked to keep, with the panels it had open, taken back by name.

   Which is the line between this and a preset. A preset (`applyPreset`) is an
   arrangement and never opens or closes anything — the same panels, put
   somewhere else. A saved layout is *contents plus arrangement*, so applying
   one opens what it held and closes what it did not, and that is exactly why
   it has to be asked for by name rather than offered as a tidy-up.

   Same key discipline as above: per server, pruned on the way back in, and a
   corrupt store reads as an empty list rather than taking the dock with it. */

const LAYOUTS_PREFIX = "daedalus.dock.layouts.v1"

export interface SavedLayout {
  id: string
  name: string
  /** When it was saved or last overwritten, for ordering the list. */
  at: number
  layout: SerializedDockview
}

const layoutsKey = (serverId: string): string => `${LAYOUTS_PREFIX}:${serverId}`

function readLayouts(serverId: string): SavedLayout[] {
  try {
    const raw = localStorage.getItem(layoutsKey(serverId))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is SavedLayout =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as SavedLayout).id === "string" &&
        typeof (entry as SavedLayout).name === "string" &&
        !!(entry as SavedLayout).layout
    )
  } catch {
    return []
  }
}

function writeLayouts(serverId: string, entries: SavedLayout[]): void {
  try {
    localStorage.setItem(layoutsKey(serverId), JSON.stringify(entries))
  } catch (error) {
    console.warn("Could not save the layout", error)
  }
}

/** Newest first — the list a menu and the palette both show. */
export function listSavedLayouts(serverId: string): SavedLayout[] {
  return [...readLayouts(serverId)].sort((a, b) => b.at - a.at)
}

/**
 * Keep the current dock under `name`, replacing a layout of the same name.
 *
 * Same name means the same layout, deliberately: "Review" saved twice is one
 * arrangement the user refined, not two rows they now have to tell apart. The
 * id survives the overwrite so anything holding one still resolves.
 */
export function saveNamedLayout(
  serverId: string,
  name: string,
  layout: SerializedDockview
): SavedLayout | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  const entries = readLayouts(serverId)
  const existing = entries.find((entry) => entry.name.toLowerCase() === trimmed.toLowerCase())
  const saved: SavedLayout = {
    id: existing?.id ?? `layout-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: trimmed,
    at: Date.now(),
    layout,
  }
  writeLayouts(serverId, [saved, ...entries.filter((entry) => entry.id !== saved.id)])
  return saved
}

/** The layout to restore, already pruned, or null if the id is unknown or
    nothing in it survived this build. */
export function readSavedLayout(serverId: string, id: string): SerializedDockview | null {
  const entry = readLayouts(serverId).find((candidate) => candidate.id === id)
  if (!entry) return null
  try {
    return pruneLayout(entry.layout)
  } catch {
    return null
  }
}

export function renameSavedLayout(serverId: string, id: string, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) return
  writeLayouts(
    serverId,
    readLayouts(serverId).map((entry) => (entry.id === id ? { ...entry, name: trimmed } : entry))
  )
}

export function deleteSavedLayout(serverId: string, id: string): void {
  writeLayouts(
    serverId,
    readLayouts(serverId).filter((entry) => entry.id !== id)
  )
}
