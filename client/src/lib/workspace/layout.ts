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

import { isPanelKind, panelId as panelIdOf, parsePanel, type PanelDescriptor } from "./panels"
import { loadActiveSpace } from "../spaces"
import { IS_POPOUT, POPOUT_WINDOW_ID } from "../popout"

const PREFIX = "daedalus.dock.v2"
const LEGACY_KEY = "daedalus.sessionDock.v1"

/** The dock's key for one server, space, and (for Electron thread windows)
    window. Each workspace has its own tabs and never overwrites the main dock.
    `spaceId` is omitted only before the active space is resolved. */
export function layoutKey(serverId: string, spaceId?: string): string {
  const windowScope = IS_POPOUT && POPOUT_WINDOW_ID ? `:window:${POPOUT_WINDOW_ID}` : ""
  return spaceId
    ? `${PREFIX}:${serverId}:${spaceId}${windowScope}`
    : `${PREFIX}:${serverId}${windowScope}`
}

/** This device's space for a server, or "" when none is chosen yet — the
    space-less key, which is what a first boot before the spaces list answers
    reads and writes, and what adoption then re-files under the first space. */
const spaceOf = (serverId: string, spaceId?: string): string =>
  spaceId ?? loadActiveSpace(serverId) ?? ""

type GridNode = { type: "leaf" | "branch"; data: unknown; size?: number; visible?: boolean }
type LeafData = {
  views: string[]
  activeView?: string
  id: string
  tabGroups?: { id: string; panelIds: string[]; label?: string; collapsed?: boolean }[]
}

/** A leaf's own copy with only the panels in `kept`, its active view and its
    tab groups following — or null when nothing in it survived. */
function pruneLeaf(data: LeafData | undefined, kept: Record<string, unknown>): LeafData | null {
  const views = Array.isArray(data?.views) ? data.views.filter((view) => view in kept) : []
  if (!data || views.length === 0) return null
  const activeView = data.activeView && views.includes(data.activeView) ? data.activeView : views[0]
  const tabGroups = (Array.isArray(data.tabGroups) ? data.tabGroups : [])
    .map((group) => ({
      ...group,
      panelIds: (Array.isArray(group.panelIds) ? group.panelIds : []).filter((id) => views.includes(id)),
    }))
    .filter((group) => group.panelIds.length > 0)
  return { ...data, views, activeView, ...(tabGroups.length > 0 ? { tabGroups } : { tabGroups: undefined }) }
}

/** Rewrite every leaf (`{ views }`) anywhere in a serialized window — the
    grid, a float, a popout or an edge group, whichever shape it was written
    in. Substitution only: nothing here collapses a branch. */
function mapLeaves(node: unknown, fn: (leaf: LeafData) => LeafData): unknown {
  if (Array.isArray(node)) return node.map((child) => mapLeaves(child, fn))
  if (!node || typeof node !== "object") return node
  const record = node as Record<string, unknown>
  if (Array.isArray(record.views)) return fn(record as unknown as LeafData)
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) out[key] = mapLeaves(value, fn)
  return out
}

/**
 * ── The old dock-in-a-tab, unpacked ──
 * A `group` panel was a second dockview inside a tab, carrying its whole
 * layout on its params. Tabs are grouped natively now (dockview's tab groups,
 * one strip), so a layout saved by that build has each group tab replaced by
 * the tabs it held — in its place in the strip, as one tab group — rather than
 * dropped with everything inside it, which is what an unknown kind gets.
 */
function unpackGroupPanels(layout: SerializedDockview): SerializedDockview {
  const panels = layout?.panels
  if (!panels || typeof panels !== "object") return layout
  const unpacked = new Map<string, string[]>()
  const next: Record<string, unknown> = {}
  for (const [id, state] of Object.entries(panels)) {
    if (state?.contentComponent !== "group") {
      next[id] = state
      continue
    }
    const inner = (state.params as { layout?: SerializedDockview } | undefined)?.layout
    const innerPanels = (inner?.panels ?? {}) as Record<string, { contentComponent?: string }>
    const views = [
      ...viewsOf({ grid: inner?.grid }),
      ...(inner?.floatingGroups ?? []).flatMap((entry) => viewsOf(entry as WindowEntry)),
    ].filter(
      (view, index, all) =>
        all.indexOf(view) === index &&
        view in innerPanels &&
        innerPanels[view]?.contentComponent !== "group" &&
        !(view in panels)
    )
    for (const view of views) next[view] = innerPanels[view]
    unpacked.set(id, views)
  }
  if (unpacked.size === 0) return layout
  const expand = (leaf: LeafData): LeafData => {
    const hits = leaf.views.filter((view) => unpacked.has(view))
    if (hits.length === 0) return leaf
    const views = leaf.views.flatMap((view) => unpacked.get(view) ?? [view])
    const activeView =
      leaf.activeView && unpacked.has(leaf.activeView) ? unpacked.get(leaf.activeView)?.[0] : leaf.activeView
    const tabGroups = [
      ...(leaf.tabGroups ?? []),
      ...hits
        .filter((hit) => (unpacked.get(hit)?.length ?? 0) > 0)
        .map((hit) => ({ id: `tg-${hit}`, label: "Group", collapsed: false, panelIds: unpacked.get(hit) ?? [] })),
    ]
    return { ...leaf, views, activeView, tabGroups }
  }
  return {
    ...layout,
    panels: next as SerializedDockview["panels"],
    grid: mapLeaves(layout.grid, expand) as SerializedDockview["grid"],
    ...(layout.floatingGroups
      ? { floatingGroups: mapLeaves(layout.floatingGroups, expand) as SerializedDockview["floatingGroups"] }
      : {}),
    ...(layout.popoutGroups
      ? { popoutGroups: mapLeaves(layout.popoutGroups, expand) as SerializedDockview["popoutGroups"] }
      : {}),
  }
}
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
  const source = dockPopouts(unpackGroupPanels(layout))
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

  const walk = (node: GridNode | undefined, isRoot = false): GridNode | null => {
    if (!node || typeof node !== "object") return null
    if (node.type === "branch") {
      const children = Array.isArray(node.data)
        ? (node.data as GridNode[]).map((child) => walk(child)).filter((child): child is GridNode => child !== null)
        : []
      if (children.length === 0) return null
      /* A branch with one child left is that child — an empty split otherwise
         stays in the grid as a sash with nothing on one side of it. Never at
         the root, though: `fromJSON` refuses a root that is not a branch
         ("dockview: root must be of type branch"), and the ordinary dock is
         exactly one branch over one group — opening a panel never splits it
         (see `openPanel`). Collapsing the root turned every such layout into
         something the dock could not read back, so the restore threw, the dock
         was cleared, and the debounced save wrote that emptiness over the tabs
         on the next refresh. */
      if (children.length === 1 && !isRoot) return { ...children[0], size: node.size }
      return { ...node, data: children }
    }
    const data = pruneLeaf(node.data as LeafData | undefined, kept)
    return data ? { ...node, data } : null
  }

  const root = walk(source.grid?.root as GridNode | undefined, true)
  if (!root || root.type !== "branch") return null

  const activeGroup = source.activeGroup
  /* A floating group survives a reload — it is drawn inside this page, so
     nothing has to be reopened for it to come back. It is kept whole or not at
     all: a float is a window the user placed, and one with half its tabs
     missing is not the window they placed. */
  const floatingGroups = (source.floatingGroups ?? []).filter((entry) =>
    viewsOf(entry).every((view) => view in kept)
  )
  /* The bottom panel (an edge group) is a leaf of its own outside the grid:
     pruned like one, and dropped when nothing in it survived — dockview removes
     an emptied revealed edge group itself, so an empty entry is only ever a
     stale one. */
  const edgeGroups = Object.fromEntries(
    Object.entries(source.edgeGroups ?? {}).flatMap(([position, entry]) => {
      const group = entry?.group ? pruneLeaf(entry.group as LeafData, kept) : null
      return group ? [[position, { ...entry, group }]] : []
    })
  ) as SerializedDockview["edgeGroups"]
  return {
    ...source,
    panels: kept,
    grid: { ...source.grid, root: root as SerializedDockview["grid"]["root"] },
    edgeGroups: edgeGroups && Object.keys(edgeGroups).length > 0 ? edgeGroups : undefined,
    ...(activeGroup ? { activeGroup } : {}),
    ...(floatingGroups.length > 0 ? { floatingGroups } : { floatingGroups: undefined }),
    popoutGroups: undefined,
  }
}

/**
 * The layout for a server and space, already pruned, or null for a fresh dock.
 * Electron thread windows include their stable per-window scope so they can
 * navigate and persist tabs without reading or overwriting the main dock.
 *
 * v1's key is read once as a fallback rather than deleted for the main window.
 */
export function loadLayout(serverId: string, spaceId?: string): SerializedDockview | null {
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
  const space = spaceOf(serverId, spaceId)
  if (IS_POPOUT && !POPOUT_WINDOW_ID) return null
  /* The v1 key is read only for the space-less case — once a space is chosen,
     the dock is that space's. Kept in place rather than deleted so a downgrade
     finds its tabs where it left them. */
  if (IS_POPOUT) return read(layoutKey(serverId, space))
  return read(layoutKey(serverId, space)) ?? (space ? null : read(LEGACY_KEY))
}

export function saveLayout(serverId: string, layout: SerializedDockview, spaceId?: string): void {
  if (IS_POPOUT && !POPOUT_WINDOW_ID) return
  try {
    localStorage.setItem(layoutKey(serverId, spaceOf(serverId, spaceId)), JSON.stringify(layout))
  } catch (error) {
    // Quota, or private-mode storage. The dock still works; it just will not
    // come back. Not worth a toast on every layout change.
    console.warn("Could not persist the workspace layout", error)
  }
}

/* ── Tabs filed away for another space ──
   A prune that evicts a tab because its project lives in another space is not a
   close: the tab is owed to that space, and is reopened by `switchSpace` when it
   next comes in front. Kept beside the layout (same prefix, so `clearLayout`
   sweeps it) as plain descriptors — building them into a serialized grid would
   mean inventing a leaf for a space that has no layout yet. */
const stashKey = (serverId: string, spaceId: string) => `${layoutKey(serverId, spaceId)}:pending`

export function stashPanels(serverId: string, spaceId: string, panels: PanelDescriptor[]): void {
  if (!spaceId || panels.length === 0) return
  try {
    const kept = takeStashedPanels(serverId, spaceId, { keep: true })
    const ids = new Set(kept.map(panelIdOf))
    localStorage.setItem(
      stashKey(serverId, spaceId),
      JSON.stringify([...kept, ...panels.filter((panel) => !ids.has(panelIdOf(panel)))])
    )
  } catch (error) {
    console.warn("Could not file the tab under its space", error)
  }
}

/** The tabs owed to a space, cleared on read unless `keep`. */
export function takeStashedPanels(serverId: string, spaceId: string, opts?: { keep?: boolean }): PanelDescriptor[] {
  if (!spaceId) return []
  try {
    const raw = localStorage.getItem(stashKey(serverId, spaceId))
    if (!opts?.keep) localStorage.removeItem(stashKey(serverId, spaceId))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? parsed.filter((p): p is PanelDescriptor => !!p && typeof p === "object" && isPanelKind((p as { kind?: unknown }).kind))
      : []
  } catch {
    return []
  }
}

/** Forget every space's dock for a server — a forgotten server's space ids name
    rows nothing can reach again, so a swept key is the only honest answer. */
export function clearLayout(serverId: string): void {
  try {
    const prefix = `${PREFIX}:${serverId}`
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && (key === prefix || key.startsWith(`${prefix}:`))) doomed.push(key)
    }
    for (const key of doomed) localStorage.removeItem(key)
  } catch {
    /* nothing to clear */
  }
}

/**
 * Every thread id a saved dock on this server still names — the active space,
 * the other spaces, whatever was filed to one, and the legacy key.
 *
 * The thread list is a *page* now (the sidebar pages it), so a restored tab can
 * point at a thread past the window — and boot's own prune closes any chat panel
 * whose session the store does not hold. This is what boot reads to load those
 * threads before the prune runs, so the restore keeps every tab it had. Chat
 * panels only: nothing else in a dock is a thread.
 */
export function savedThreadIds(serverId: string): string[] {
  if (IS_POPOUT && !POPOUT_WINDOW_ID) return []
  const ids = new Set<string>()
  const add = (panels: unknown) => {
    if (!panels || typeof panels !== "object") return
    for (const state of Object.values(
      panels as Record<string, { contentComponent?: unknown; params?: unknown }>
    )) {
      const descriptor = parsePanel(state?.contentComponent, state?.params)
      if (descriptor?.kind === "chat") ids.add(descriptor.sessionId)
    }
  }
  try {
    const prefix = `${PREFIX}:${serverId}`
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (
        IS_POPOUT &&
        (!POPOUT_WINDOW_ID || !key?.includes(`:window:${POPOUT_WINDOW_ID}`))
      ) continue
      const isCurrentLayout = key === prefix || key?.startsWith(`${prefix}:`)
      const isLegacyMainLayout = !IS_POPOUT && key === LEGACY_KEY
      if (!key || (!isCurrentLayout && !isLegacyMainLayout)) continue
      const raw = localStorage.getItem(key)
      if (!raw) continue
      const parsed: unknown = JSON.parse(raw) as unknown
      /* A stash is a plain descriptor list; a layout is a grid whose `panels`
         carry the descriptors (a group's own layout is already unpacked out of
         them by `pruneLayout`). */
      if (Array.isArray(parsed)) {
        for (const panel of parsed) {
          if (!panel || typeof panel !== "object" || (panel as { kind?: unknown }).kind !== "chat") continue
          const id = (panel as { sessionId?: unknown }).sessionId
          if (typeof id === "string" && id) ids.add(id)
        }
        continue
      }
      add(pruneLayout(parsed as SerializedDockview)?.panels)
    }
  } catch {
    /* Unreadable storage reads as no saved tabs; the dock still opens. */
  }
  return [...ids]
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

const layoutsKey = (serverId: string): string =>
  IS_POPOUT && POPOUT_WINDOW_ID
    ? `${LAYOUTS_PREFIX}:${serverId}:window:${POPOUT_WINDOW_ID}`
    : `${LAYOUTS_PREFIX}:${serverId}`

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
