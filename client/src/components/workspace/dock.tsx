/* ── Workspace dock ──
   Dockview as a generic panel host. `chat` used to be the whole component map;
   it is now one registered kind among five (see `lib/workspace/panels.ts`),
   and everything the dock does — open, focus, split, close, restore, prune —
   speaks descriptors rather than session ids.

   Three rules hold this together:

   - **A panel id is its identity.** `panelId(descriptor)` is what makes
     reopening a resource focus the panel that already has it, and it is also
     what keeps one ACP connection per thread: two `thread:{id}` panels cannot
     exist, so a second view of a thread cannot mint a second connection.
   - **Params are storage.** Dockview serializes them verbatim, so a descriptor
     is a schema and `parsePanel` guards the way back in.
   - **Every close path is ours.** The default tab is replaced, so `closePanel`
     is the only door out — which is where a guarded panel gets to ask first.

   **One dockview instance.** Grouping tabs is dockview's own tab groups (a
   coloured chip over a run of tabs in one strip) and the bottom panel is its
   edge group. A second dockview inside a tab used to stand for both, and every
   question about "the panels" had to be asked of two instances — which is
   where the menu rows that did nothing on a grouped tab, and the drag between
   strips that dockview never accepted, came from.

   The controller is this file (`useWorkspaceDock`); the surface it drives is
   `dock-surface.tsx`, the shape and contexts every panel reads are
   `dock-context.ts`, and the header measurement is `dock-header.ts`. */
import { uuid } from "@/lib/uuid"
import { equalizeAround, watchSplits } from "@/components/workspace/dock-sizes"
import * as React from "react"
import type { DockviewApi, DockviewGroupPanel, IDockviewPanel, SerializedDockview } from "dockview-react"

import {
  descriptorOf,
  TAB_GROUP_COLORS,
  type CloseGuard,
  type OpenPanelOptions,
  type PresetId,
  type SplitSide,
  type TabGroupRow,
  type WorkspaceDock,
} from "@/components/workspace/dock-context"
import { navigateTo, routedThreadId, threadPath } from "@/lib/router"
import { loadSettings } from "@/lib/settings"
import { cancelPrewarm } from "@/lib/prewarm"
import { useStoreHandle } from "@/lib/store"
import { useHotkey, useShortcut } from "@/hooks/use-hotkey"
import { MOBILE_BREAKPOINT } from "@/hooks/use-device"
import {
  deleteSavedLayout as forgetSavedLayout,
  listSavedLayouts,
  loadLayout,
  readSavedLayout,
  saveLayout,
  stashPanels,
  takeStashedPanels,
  saveNamedLayout,
} from "@/lib/workspace/layout"
import { loadActiveSpace } from "@/lib/spaces"
import { toggleFullscreen as toggleThreadFullscreen } from "@/lib/workspace/fullscreen"
import { forgetPanelPin, isPanelPinned, pinnedPanels, togglePanelPin } from "@/lib/workspace/panel-pins"
import {
  setActiveChat,
  setBesideHandler,
  setChatFocusHandler,
  setLeaveHandler,
  setNewTabHandler,
  setOpenThreads,
  setRouteless,
} from "@/lib/workspace/open-threads"
import { PANEL_SPECS, panelId, pageKey, parsePanel, type PanelDescriptor } from "@/lib/workspace/panels"

const SAVE_DEBOUNCE_MS = 300
/** How many closed panels ⌘⇧T can walk back through. */
const REOPEN_DEPTH = 10
/** How far one press of ⌥⇧+arrow moves a divider, as a share of the dock. A held
    key repeats, so a press is a nudge and a hold is a drag. */
const RESIZE_STEP = 0.03

/** `KeyboardEvent.key` → where the divider is pushed, and the side it comes
    from when there is nothing that way. */
const PUSH = {
  ArrowLeft: ["left", "right"],
  ArrowRight: ["right", "left"],
  ArrowUp: ["up", "down"],
  ArrowDown: ["down", "up"],
} as const

const isNarrow = () => window.innerWidth < MOBILE_BREAKPOINT

const isGrid = (group: DockviewGroupPanel | undefined) => group?.api.location.type === "grid"

/** A strip in the grid — the active one if it is, else the first. Never a
    float or the bottom panel: nothing is split off those, and a phone's fold
    lands in the grid. */
function gridGroupOf(api: DockviewApi): DockviewGroupPanel | undefined {
  return isGrid(api.activeGroup) ? api.activeGroup : api.groups.find(isGrid)
}

/** The route a focused panel stands for — chats and pages only: focusing a
    terminal must not navigate away from the thread it belongs to. */
function routeOf(panel: IDockviewPanel): string | null {
  const descriptor = descriptorOf(panel)
  if (descriptor?.kind === "chat") return threadPath(descriptor.sessionId)
  if (descriptor?.kind === "page") return descriptor.path
  return null
}

/** Where a page tab was opened from — the route it replaced — so leaving the
    page (settings' "Back to threads") returns *this* tab to it. A tab is an
    outlet, and the thread it was showing is gone the moment a page takes its
    place; without this the only way back was some other tab, or the New tab page. */
const cameFrom = new WeakMap<IDockviewPanel, string>()

/** A tab come to the front: bring it into view in its strip (dockview scrolls
    for nothing — the one picked in the palette can be off the end of a narrow
    strip) and point the URL at it. */
function followActive(panel: IDockviewPanel | undefined): void {
  if (!panel || !panel.api.isActive) return
  panel.view.tab.element.scrollIntoView({ inline: "nearest", block: "nearest" })
  const path = routeOf(panel)
  if (path && location.pathname + location.search !== path) navigateTo(path, { replace: true })
}

/** The chat panels open in the dock, in the order they were opened — what the
    sidebar's "Opened" tier lists and what Recents leaves out. */
function openChatThreads(panels: IDockviewPanel[]): string[] {
  const ids: string[] = []
  for (const panel of panels) {
    const descriptor = descriptorOf(panel)
    if (descriptor?.kind === "chat") ids.push(descriptor.sessionId)
  }
  return ids
}

/** The first palette colour no tab group in `groups` wears yet. */
function freeColour(api: DockviewApi, groups: DockviewGroupPanel[]): string {
  const used = new Set(groups.flatMap((group) => api.getTabGroups({ groupId: group.id }).map((tg) => tg.color)))
  return (TAB_GROUP_COLORS.find((colour) => !used.has(colour.id)) ?? TAB_GROUP_COLORS[0]).id
}

export interface DockController extends WorkspaceDock {
  apiRef: React.RefObject<DockviewApi | null>
  onReady: (api: DockviewApi) => void
  /** Drop panels whose session or project no longer exists. A panel that is
      live but `foreign` (its project is in another space, answered as that
      space's id) is filed under that space instead — reopened by `switchSpace`
      when the space comes in front — and never on the reopen stack. */
  prunePanels: (
    live: { sessions: Iterable<string>; projects: Iterable<string> },
    foreign?: (panel: PanelDescriptor) => string | null
  ) => void
  /** Swap the dock to another space's tabs (`layout.ts` files each space's dock
      under its own key). `from`/`to` are space ids; `from` null is the first
      resolution, which adopts what is on screen rather than swapping it. */
  switchSpace: (from: string | null, to: string | null) => void
}

export function useWorkspaceDock(): DockController {
  const apiRef = React.useRef<DockviewApi | null>(null)
  const store = useStoreHandle()
  const closedRef = React.useRef<{ panel: PanelDescriptor; title: string }[]>([])
  const guardsRef = React.useRef(new Map<string, CloseGuard>())
  /* Programmatic removals — a preset rebuild, a prune, replacing a tab — are
     not the user closing anything, so they must not land on the reopen stack
     or ⌘⇧T would resurrect a thread the server has already forgotten. */
  const silentRef = React.useRef(0)
  const serverIdRef = React.useRef<string | null>(null)
  if (serverIdRef.current === null) serverIdRef.current = loadSettings()?.id ?? "none"
  /* The debounced save, reachable from `switchSpace` — a space swap must cancel
     a pending write rather than let it land under the wrong space. */
  const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /* The space whose tabs are on screen — moved only by `onReady` and
     `switchSpace`, never by the click. Every save files under this and not under
     the device's chosen space: that moves the instant a space is clicked, a
     render before the dock swaps, and a save landing in the gap wrote the old
     space's tabs under the new one (and pushed them to the server). */
  const heldSpaceRef = React.useRef("")

  const silently = React.useCallback(<T,>(fn: () => T): T => {
    silentRef.current += 1
    try {
      return fn()
    } finally {
      silentRef.current -= 1
    }
  }, [])

  /** A tab that can be navigated: a thread or a page. */
  const isNavigable = (panel: IDockviewPanel) =>
    panel.api.component === "chat" || panel.api.component === "page"

  /* ── A draft's warm process goes with the last tab showing it ──
     A prewarmed process belongs to the draft, not to a tab (`lib/prewarm.ts`),
     so the moment nobody can send it the server should stop holding it. Three
     things remove a chat tab — the reader's Close, a route repointing the tab in
     front, and a panel opened in a place another one occupied — and the last two
     go through `silently`, so this is a function they all call rather than a
     block inside one of them.

     Two tabs of one thread are legal (`openTab` shows a thread again), so the
     check is whether *another* panel still holds this session. And it is a
     draft or nothing: a thread with a row owns the process it spawned, which no
     tab closing may take away. Fire and forget, because the TTL and the cap are
     the guarantee and this is only promptness. */
  const releaseDraft = React.useCallback((panel: IDockviewPanel, api: DockviewApi) => {
    const descriptor = descriptorOf(panel)
    if (descriptor?.kind !== "chat") return
    const { sessionId } = descriptor
    if (!store.getState().sessions.find((s) => s.id === sessionId)?.draft) return
    const stillShown = api.panels.some((other) => {
      if (other === panel) return false
      const there = descriptorOf(other)
      return there?.kind === "chat" && there.sessionId === sessionId
    })
    if (stillShown) return
    const settings = loadSettings()
    if (settings) cancelPrewarm(settings, sessionId)
  }, [store])

  const findPanel = React.useCallback((id: string) => apiRef.current?.getPanel(id), [])

  /** The panel a tab's menu names, or the one in front of you. */
  const panelFor = React.useCallback(
    (id?: string): IDockviewPanel | undefined =>
      id ? findPanel(id) : (apiRef.current?.activeGroup?.activePanel ?? undefined),
    [findPanel]
  )

  const activeDescriptor = React.useCallback((): PanelDescriptor | undefined => {
    const panel = apiRef.current?.activeGroup?.activePanel
    return (panel && descriptorOf(panel)) ?? undefined
  }, [])

  /* ── A tab is an isolated outlet ──
     Like a browser's: it shows whatever you navigate it to, and it can show
     anything — including what another tab is already showing, which is the
     whole point of the word *isolated*. A tab is never found by what it holds:
     the same thread, the same settings section, the same project page can each
     stand in as many tabs as you open, and the ids are unique to say so.

     Two doors. **`navigateActive(path)`** is what the address bar does (a sidebar
     row, ⌘K, a link, a notification): the tab in front *becomes* that place, in
     the same spot in the strip — and does nothing when it is already there,
     which is also what makes switching tabs idempotent (the dock writes the
     focused tab's path to the URL, and the URL writes it back). A pinned tab, or
     no tab at all, gets a new one instead. **`openTab(path)`** is a new tab,
     always — the strip's +, "New tab" — which opens on the New tab page
     (`/`) unless it is told where. */
  const addTab = React.useCallback(
    (descriptor: PanelDescriptor, place?: { replace?: IDockviewPanel; group?: string; side?: SplitSide }) => {
      const api = apiRef.current
      if (!api) return undefined
      let desc = descriptor
      let id = panelId(desc)
      if (desc.kind === "chat") {
        while (api.getPanel(id)) {
          desc = { ...desc, tabId: uuid().slice(0, 6) }
          id = panelId(desc)
        }
      } else if (desc.kind === "page") {
        const key = pageKey(desc.path)
        id = `page:${key}`
        for (let n = 2; api.getPanel(id); n += 1) id = `page:${key}:${n}`
      }
      const anchor = place?.replace ?? api.activeGroup?.activePanel
      /* A strip named by the caller (a drop on *that* strip) wins over the one
         the tab in front stands in. */
      const named = place?.group ? api.groups.find((candidate) => candidate.id === place.group) : undefined
      const group = named ?? anchor?.group ?? api.activeGroup ?? undefined
      /* A split is made beside the strip it was asked of — the named one, else
         the one in front — and never on a phone, where the fold takes it away
         in the next microtask. */
      const side = place?.side
      const strip = named ?? api.activeGroup
      const split = side && strip && isGrid(strip) && !isNarrow() ? strip : undefined
      const added = api.addPanel({
        id,
        component: desc.kind,
        title: PANEL_SPECS[desc.kind].defaultTitle,
        params: desc as unknown as Record<string, unknown>,
        position: split && side
          ? { referenceGroup: split.id, direction: side }
          : group
            ? {
                referenceGroup: group.id,
                direction: "within" as const,
                index:
                  anchor && group.panels.includes(anchor) ? group.panels.indexOf(anchor) + 1 : undefined,
              }
            : undefined,
      })
      const replaced = place?.replace
      if (replaced) {
        releaseDraft(replaced, api)
        silently(() => api.removePanel(replaced))
      }
      return added
    },
    [releaseDraft, silently]
  )

  const navigateActive = React.useCallback(
    (path: string) => {
      const api = apiRef.current
      if (!api) return
      const [pathname, query] = path.split("?")
      const sessionId = routedThreadId(pathname, query ? `?${query}` : "")
      const target: PanelDescriptor = sessionId ? { kind: "chat", sessionId } : { kind: "page", path }
      const active = api.activeGroup?.activePanel
      if (active && isNavigable(active) && !isPanelPinned(active.id)) {
        const here = descriptorOf(active)
        if (target.kind === "chat" && here?.kind === "chat" && here.sessionId === target.sessionId) return
        if (target.kind === "page" && here?.kind === "page") {
          // A page repoints itself; only a different surface is a different panel.
          if (here.path !== path) active.api.updateParameters({ kind: "page", path })
          return
        }
        const added = addTab(target, { replace: active })
        const origin = routeOf(active)
        if (added && origin && target.kind === "page") cameFrom.set(added, origin)
        return
      }
      addTab(target)
    },
    [addTab]
  )

  /** Return the page in front to what it replaced. False when it replaced nothing. */
  const leavePage = React.useCallback(() => {
    const active = apiRef.current?.activeGroup?.activePanel
    const origin = active && !isPanelPinned(active.id) ? cameFrom.get(active) : undefined
    if (!origin) return false
    navigateActive(origin)
    return true
  }, [navigateActive])

  /* ── A route, by name ──
     The door every surface outside the dock knocks on: a sidebar row's "Open in
     new tab" (`lib/workspace/open-threads`), a place dropped on the dock
     (`dock-drop.tsx`), and `openTab` itself, which is the same thing with
     nothing said about where it lands. A thread is a route and a page is a
     route, so one function lands both and there is no third shape to forget. */
  const openRoute = React.useCallback(
    (path: string, options?: { side?: SplitSide; group?: string }) => {
      const [pathname, query] = path.split("?")
      const sessionId = routedThreadId(pathname, query ? `?${query}` : "")
      addTab(sessionId ? { kind: "chat", sessionId } : { kind: "page", path }, options)
    },
    [addTab]
  )

  const openTab = React.useCallback((path = "/") => openRoute(path), [openRoute])

  const openPage = React.useCallback(
    (path: string, options?: { newTab?: boolean }) => (options?.newTab ? openTab(path) : navigateActive(path)),
    [navigateActive, openTab]
  )

  const consumeConsole = React.useCallback(() => {
    const api = apiRef.current
    const active = api?.activeGroup?.activePanel
    if (!api || !active || active.api.component !== "page" || isPanelPinned(active.id)) return
    const descriptor = descriptorOf(active)
    if (descriptor?.kind !== "page" || pageKey(descriptor.path) !== "home") return
    silently(() => api.removePanel(active))
  }, [silently])

  const openPanel = React.useCallback(
    (panel: PanelDescriptor, options?: OpenPanelOptions) => {
      const aim = options?.into
      const api = apiRef.current
      if (!api || !PANEL_SPECS[panel.kind].implemented) return
      /* One door for a page, whoever knocks — ⌘⇧T reopening one included. */
      if (panel.kind === "page") return openPage(panel.path)

      /* Tabs are isolated: opening a thread that is already open is a second tab
         of it, not a refocus of the first. */
      if (panel.kind === "chat" && api.getPanel(panelId(panel)))
        panel = { ...panel, tabId: uuid().slice(0, 6) }
      const id = panelId(panel)
      const existing = api.getPanel(id)
      if (existing) {
        /* Same id, different params is "the same surface, pointed somewhere
           else" — the Preview panel following a second file is the case, since
           its `viewId` is its identity and the file is not. Both sides normalized through `parsePanel`, so the order some
           caller wrote its literal in does not count as a change. */
        if (JSON.stringify(descriptorOf(existing)) !== JSON.stringify(parsePanel(panel.kind, panel)))
          existing.api.updateParameters(panel as unknown as Record<string, unknown>)
        if (!options?.background) existing.api.setActive()
        return
      }

      /* Side by side, asked for by name: a new column or row beside the
         named strip — the only open that splits. */
      const aimedStrip = aim ? api.groups.find((group) => group.id === aim.group) : undefined
      if (aim?.split && aimedStrip && isGrid(aimedStrip) && !isNarrow()) {
        api.addPanel({
          id,
          component: panel.kind,
          title: PANEL_SPECS[panel.kind].defaultTitle,
          params: panel as unknown as Record<string, unknown>,
          inactive: options?.background,
          position: { referenceGroup: aimedStrip.id, direction: aim.split },
        })
        return
      }

      /* Where a new panel lands: the strip the caller named; else beside the
         panel of the same kind you were last looking at, because that is the
         strip that kind belongs to — a chat opens among the chats even when a
         terminal has focus. */
      const aimed = aimedStrip
      const siblings = api.panels.filter((candidate) => candidate.api.component === panel.kind)
      const current = aimed
        ? (aimed.activePanel ?? undefined)
        : (siblings.find((candidate) => candidate.api.isActive) ??
          siblings.find((candidate) => candidate.group.activePanel === candidate) ??
          siblings[0] ??
          api.activeGroup?.activePanel)
      /* ── Opening never splits ──
         Every panel arrives the way a new thread does: a tab beside what you
         are looking at. The side a caller asked for is read as "and do not
         replace what is in front of me" and nothing more. Splitting is asked
         for by name (`splitActive`). */
      const newTab = options?.newTab || !!options?.direction

      /* A thread navigates the tab in front like a page does: when it was not
         asked to open beside it, it takes the place of the active thread or
         page (never a pinned one, never a terminal or a board). */
      const active = api.activeGroup?.activePanel
      const navigates =
        panel.kind === "chat" && !newTab && !aimed && !!active && isNavigable(active) && !isPanelPinned(active.id)

      const group = aimed ?? (navigates ? active?.group : current?.group)

      /* Replace-in-place: the panel you came from goes away unless you asked
         for a new tab. Only same-kind panels — and never chats, which every
         caller opens with `newTab`. */
      const replace = navigates || (!!current && current.api.component === panel.kind && !newTab && panel.kind !== "chat")
      const anchor = aim?.beside ? api.getPanel(aim.beside) : undefined
      const beside = anchor && anchor.group === group ? anchor : undefined
      const index = group
        ? beside
          ? group.panels.indexOf(beside) + 1
          : replace
            ? group.panels.indexOf((navigates ? active : current) as IDockviewPanel) + 1
            : undefined
        : undefined

      api.addPanel({
        id,
        component: panel.kind,
        title: PANEL_SPECS[panel.kind].defaultTitle,
        params: panel as unknown as Record<string, unknown>,
        inactive: options?.background,
        position: group ? { referenceGroup: group.id, direction: "within" as const, index } : undefined,
      })

      const replaced = navigates ? active : current
      if (replace && replaced && !beside) {
        releaseDraft(replaced, api)
        silently(() => api.removePanel(replaced))
      }
      /* With the tab it was opened from: its tab group, made for the two of
         them if it has none — only now that the panel exists, so an open that
         failed upstream never left a group of one behind. */
      if (beside && group) {
        let tabGroup = api.getTabGroupForPanel({ groupId: group.id, panelId: beside.id })
        if (!tabGroup) {
          tabGroup = api.createTabGroup({ groupId: group.id, color: freeColour(api, [group]) })
          api.addPanelToTabGroup({ groupId: group.id, tabGroupId: tabGroup.id, panelId: beside.id })
        }
        /* The index counts within the tab group, not the strip. */
        api.addPanelToTabGroup({
          groupId: group.id,
          tabGroupId: tabGroup.id,
          panelId: id,
          index: tabGroup.indexOfPanel(beside.id) + 1,
        })
      }
    },
    [releaseDraft, silently, openPage]
  )

  const openChat = React.useCallback(
    (sessionId: string, options?: OpenPanelOptions) => openPanel({ kind: "chat", sessionId }, options),
    [openPanel]
  )

  /* Every panel can be closed, the last one included: an empty dock goes to
     the landing console (`onDidRemovePanel` in `dock-surface.tsx`). */
  const removeWithGuard = React.useCallback(async (panel: IDockviewPanel): Promise<boolean> => {
    const api = apiRef.current
    if (!api) return false
    const guard = guardsRef.current.get(panel.id)
    if (guard && !(await guard())) return false
    /* A pin belongs to a panel, not to an id: leaving it behind would pin
       whatever next earns that name. */
    forgetPanelPin(panel.id)
    const descriptor = descriptorOf(panel)
    if (descriptor && silentRef.current === 0) {
      closedRef.current = [
        { panel: descriptor, title: panel.title ?? PANEL_SPECS[descriptor.kind].defaultTitle },
        ...closedRef.current.filter((entry) => panelId(entry.panel) !== panel.id),
      ].slice(0, REOPEN_DEPTH)
    }
    releaseDraft(panel, api)
    api.removePanel(panel)
    return true
  }, [releaseDraft])

  const closePanel = React.useCallback(
    async (id: string) => {
      const panel = findPanel(id)
      if (panel) await removeWithGuard(panel)
    },
    [findPanel, removeWithGuard]
  )

  /** Panels sharing a strip with `id`, in tab order. Recomputed per call — a
      snapshot taken at render could close the wrong tabs after a drag. */
  const groupPanels = React.useCallback(
    (id: string): IDockviewPanel[] => [...(findPanel(id)?.group.panels ?? [])],
    [findPanel]
  )

  /* Bulk closes stop at the first refusal rather than skipping past it, and
     step over a pinned tab — you pinned it so the tidy-up would go around it.
     Closing it stays possible: its own Close, which names it. */
  const closeEach = React.useCallback(
    async (panels: IDockviewPanel[]) => {
      for (const panel of panels) {
        if (isPanelPinned(panel.id)) continue
        if (!(await removeWithGuard(panel))) return
      }
    },
    [removeWithGuard]
  )

  const closeOthers = React.useCallback(
    (id: string) => closeEach(groupPanels(id).filter((panel) => panel.id !== id)),
    [closeEach, groupPanels]
  )

  const closeToTheRight = React.useCallback(
    (id: string) => {
      const panels = groupPanels(id)
      const index = panels.findIndex((panel) => panel.id === id)
      return index < 0 ? Promise.resolve() : closeEach(panels.slice(index + 1))
    },
    [closeEach, groupPanels]
  )

  const closeGroup = React.useCallback((id: string) => closeEach(groupPanels(id)), [closeEach, groupPanels])

  const splitActive = React.useCallback(
    (direction: "right" | "below" | "left" | "above", id?: string) => {
      const api = apiRef.current
      /* One strip below `md`, by construction (the fold in `dock-surface.tsx`),
         so a split asked for on a phone is one the fold takes away. */
      if (!api || isNarrow()) return
      const panel = panelFor(id)
      /* Splitting moves the panel — a resource is its id, so a second view of
         it cannot exist — and only within the grid: a float or the bottom
         panel is not somewhere a column is added beside. */
      if (!panel || !isGrid(panel.group) || panel.group.panels.length === 1) return
      panel.api.moveTo({ group: api.addGroup({ referenceGroup: panel.group, direction }) })
    },
    [panelFor]
  )

  const toggleMaximize = React.useCallback(
    (id?: string) => {
      const api = apiRef.current
      const panel = panelFor(id)
      if (!api || !panel) return
      if (api.hasMaximizedGroup()) api.exitMaximizedGroup()
      else if (isGrid(panel.group)) api.maximizeGroup(panel)
    },
    [panelFor]
  )

  const toggleFullscreen = React.useCallback(
    (id?: string) => {
      const api = apiRef.current
      if (!api) return
      toggleThreadFullscreen(api, panelFor(id))
    },
    [panelFor]
  )

  /* Dockview's sashes take the mouse and nothing else, but `setSize` is a resize
     by any other name: along its parent's axis it moves the group's own edge,
     across it the branch the group sits in, so a nested split moves as well as
     a plain row. The arrow says where the divider goes — a pane with a
     neighbour that way grows toward it, one at the edge gives way and shrinks.
     With nothing on either side the key is declined, so ⌥⇧← still selects by
     word in a composer on a Mac when there is no split to resize. */
  const resizeActive = React.useCallback((key: string) => {
    const push = PUSH[key as keyof typeof PUSH]
    const api = apiRef.current
    const group = api?.activeGroup
    if (!push || !api || !group || !isGrid(group) || api.hasMaximizedGroup()) return false
    const [direction, opposite] = push
    const toward = api.adjacentGroupInDirection(group, direction)
    if (!toward && !api.adjacentGroupInDirection(group, opposite)) return false
    const horizontal = direction === "left" || direction === "right"
    const step = Math.round((horizontal ? api.width : api.height) * RESIZE_STEP)
    const delta = toward ? step : -step
    if (horizontal) group.api.setSize({ width: group.api.width + delta })
    else group.api.setSize({ height: group.api.height + delta })
  }, [])

  /* ── Moving the tab in front ──
     `moveTo` into the same strip re-opens the panel at the index it is given
     once it has been taken out, so `index` is where it ends up. A pin keeps its
     place at the front: a tab never crosses the line between the two kinds. */
  const moveTab = React.useCallback(
    (delta: -1 | 1) => {
      const panel = apiRef.current?.activePanel
      const group = panel?.group
      if (!panel || !group) return false
      const next = group.panels.indexOf(panel) + delta
      const over = group.panels[next]
      if (!over || isPanelPinned(panel.id) !== isPanelPinned(over.id)) return false
      panel.api.moveTo({ group, index: next })
      return true
    },
    []
  )

  const sendTab = React.useCallback((direction: "left" | "right" | "up" | "down") => {
    const api = apiRef.current
    const group = api?.activeGroup
    const panel = group?.activePanel
    if (!api || !group || !panel || isNarrow() || !isGrid(group) || api.hasMaximizedGroup()) return false
    const toward = api.adjacentGroupInDirection(group, direction)
    const target = toward && api.groups.find((candidate) => candidate.id === toward.id)
    if (target) {
      panel.api.moveTo({ group: target })
      return true
    }
    // Nothing that way: split one off, unless this is the strip's only tab.
    if (group.panels.length < 2) return false
    const side = { left: "left", right: "right", up: "above", down: "below" } as const
    panel.api.moveTo({ group: api.addGroup({ referenceGroup: group, direction: side[direction] }) })
    return true
  }, [])

  const equalizePanes = React.useCallback(() => {
    const api = apiRef.current
    const group = api?.activeGroup
    if (api && group) equalizeAround(api, group)
  }, [])

  /* Focus walks the grid's panes, wrapping — a float is not a column. Declined
     with fewer than two, so ⌥←/→ stays the browser's Back and Forward until
     there is a split to walk. */
  const walkPanes = React.useCallback((forward: boolean) => {
    const api = apiRef.current
    if (!api || !isGrid(api.activeGroup) || api.groups.filter(isGrid).length < 2) return false
    if (forward) api.activateNext()
    else api.activatePrevious()
  }, [])

  /** Everything into one strip of the grid, in the order it is laid out — the
      floats and the bottom panel included, which is what a phone needs. The
      tab in front stays in front. */
  const stackAll = React.useCallback(() => {
    const api = apiRef.current
    const target = api && gridGroupOf(api)
    if (!api || !target) return
    silently(() => {
      for (const panel of [...api.panels]) {
        if (panel.group !== target) panel.api.moveTo({ group: target, skipSetActive: true })
      }
      if (api.hasMaximizedGroup()) api.exitMaximizedGroup()
    })
  }, [silently])

  /** Presets are arrangements, not contents: nothing is opened or closed, only
      moved — stack everything, then deal the tabs round-robin into the
      preset's columns. */
  const applyPreset = React.useCallback(
    (preset: PresetId) => {
      const api = apiRef.current
      if (!api) return
      const active = api.activeGroup?.activePanel
      stackAll()
      const home = gridGroupOf(api)
      if (!home) return
      if (preset === "focus") {
        if (active) api.maximizeGroup(active)
        return
      }
      if (isNarrow()) return
      const panels = [...home.panels]
      const want = { columns: 2, rows: 2, columns3: 3, grid: 4 }[preset]
      const count = Math.min(want, panels.length)
      if (count < 2) return
      silently(() => {
        const groups = [home]
        const add = (referenceGroup: DockviewGroupPanel, direction: "right" | "below") =>
          groups.push(api.addGroup({ referenceGroup, direction }))
        if (preset === "rows") add(home, "below")
        else add(home, "right")
        if (preset === "columns3" && count > 2) add(groups[1], "right")
        if (preset === "grid" && count > 2) add(home, "below")
        if (preset === "grid" && count > 3) add(groups[1], "below")
        panels.forEach((panel, index) => {
          const group = groups[index % count]
          if (panel.group !== group) panel.api.moveTo({ group, skipSetActive: true })
        })
        /* `addGroup` halves its reference, so a third column lands at 50/25/25. */
        if (preset === "columns3" && count > 2)
          for (const group of groups) group.api.setSize({ width: api.width / 3 })
        active?.api.setActive()
      })
    },
    [silently, stackAll]
  )

  /* Reset means the arrangement, not the work: the panels that are open stay
     open and stack into one strip, and the debounced save writes that back. */
  const resetLayout = React.useCallback(() => stackAll(), [stackAll])

  const reopenClosed = React.useCallback(() => {
    const next = closedRef.current[0]
    if (!next) return
    closedRef.current = closedRef.current.slice(1)
    openPanel(next.panel, { newTab: true })
  }, [openPanel])

  /* ── Pinning ──
     Ours, not dockview's: its PinnedTabs is an enterprise module and inert in
     this build (`lib/workspace/panel-pins.ts`). What the dock adds is putting
     the tab where a pinned tab belongs — pinned tabs keep their relative order
     at the front of the strip, so pinning a second does not jump the first. */
  const togglePin = React.useCallback(
    (id: string) => {
      const panel = findPanel(id)
      if (!panel || !togglePanelPin(id)) return
      const pins = pinnedPanels()
      const ahead = panel.group.panels.filter((candidate) => candidate.id !== id && pins.has(candidate.id)).length
      if (panel.group.panels.indexOf(panel) !== ahead)
        panel.api.moveTo({ group: panel.group, index: ahead, skipSetActive: true })
    },
    [findPanel]
  )

  const isPinned = React.useCallback((id: string) => isPanelPinned(id), [])

  /* ── Its own window ──
     A sent thread opens as the whole app in a window of its own (its own dock,
     sidebar and socket; `lib/popout.ts` scopes its layout): Dockview's popout
     reparents the panel's DOM into a bare `popout.html` while this window's
     React tree keeps rendering it, so the window held one tab and nothing
     else, and every ResizeObserver/rAF the transcript is measured by belonged
     to *this* document — it drew nothing until a resize made Dockview lay the
     other window out. Every other panel (and a draft, which has no row a
     second window could load) keeps Dockview's popout. A *user gesture* only:
     `window.open` off one is a popup, and a browser blocks it — which is also
     why a popped-out panel comes home rather than reopening on the next load
     (`dockPopouts`). */
  const popoutPanel = React.useCallback(
    async (id?: string) => {
      const api = apiRef.current
      const panel = panelFor(id)
      if (!api || !panel) return false
      const descriptor = descriptorOf(panel)
      if (descriptor?.kind === "chat") {
        const { sessionId } = descriptor
        const meta = store.getState().sessions.find((session) => session.id === sessionId)
        if (meta && !meta.draft) {
          if (window.desktop?.openThreadWindow) return window.desktop.openThreadWindow(sessionId)
          const url = `${threadPath(sessionId)}?popout=1&windowId=${uuid()}`
          return !!window.open(url, "_blank", "popup,width=1100,height=820")
        }
      }
      try {
        return await api.addPopoutGroup(panel, { popoutUrl: `${import.meta.env.BASE_URL}popout.html` })
      } catch (error) {
        console.warn("Could not open the panel in its own window", error)
        return false
      }
    },
    [panelFor, store]
  )

  /* Floating is the same move without a window. Toggling back docks it into
     the grid, which is the only way out that does not close the panel. */
  const toggleFloat = React.useCallback(
    (id?: string) => {
      const api = apiRef.current
      const panel = panelFor(id)
      if (!api || !panel) return
      if (panel.group.api.location.type === "floating") {
        const home = gridGroupOf(api)
        panel.api.moveTo({ group: home ?? api.addGroup() })
        return
      }
      api.addFloatingGroup(panel)
    },
    [panelFor]
  )

  /* ── Tab groups ──
     Dockview's own, one strip each. What it cannot do is close through our
     guard, so the chip's Close comes here (`dock-surface.tsx`). */
  const addToTabGroup = React.useCallback(
    (id: string, tabGroupId: string | null): string | null => {
      const api = apiRef.current
      const panel = findPanel(id)
      if (!api || !panel) return null
      const groupId = panel.group.id
      const target =
        tabGroupId ?? api.createTabGroup({ groupId, color: freeColour(api, [panel.group]) }).id
      api.addPanelToTabGroup({ groupId, tabGroupId: target, panelId: id })
      return target
    },
    [findPanel]
  )

  const removeFromTabGroup = React.useCallback(
    (id: string) => {
      const panel = findPanel(id)
      if (panel) apiRef.current?.removePanelFromTabGroup({ groupId: panel.group.id, panelId: id })
    },
    [findPanel]
  )

  const tabGroupsBeside = React.useCallback(
    (id: string): { groups: TabGroupRow[]; current?: string } => {
      const api = apiRef.current
      const panel = findPanel(id)
      if (!api || !panel) return { groups: [] }
      const groupId = panel.group.id
      return {
        groups: api.getTabGroups({ groupId }).map((tabGroup) => ({
          id: tabGroup.id,
          label: tabGroup.label || "Unnamed group",
          hint: tabGroup.panelIds
            .map((panelId) => api.getPanel(panelId)?.title ?? "")
            .filter(Boolean)
            .join(", "),
        })),
        current: api.getTabGroupForPanel({ groupId, panelId: id })?.id,
      }
    },
    [findPanel]
  )

  const closeTabGroup = React.useCallback(
    (groupId: string, tabGroupId: string) => {
      const api = apiRef.current
      const tabGroup = api?.getTabGroups({ groupId }).find((candidate) => candidate.id === tabGroupId)
      return closeEach(
        (tabGroup?.panelIds ?? []).flatMap((id) => {
          const panel = api?.getPanel(id)
          return panel ? [panel] : []
        })
      )
    },
    [closeEach]
  )

  /* ── The bottom panel ──
     `revealEdgeGroupWithData` is dockview's create-or-fill: the first move
     makes the edge group (flagged to go away with its last panel), later ones
     add a tab to it. It is created collapsed, so it is expanded here — a panel
     you sent somewhere should be where you can see it — with its strip on top,
     where every other strip in the app is. */
  const moveToBottom = React.useCallback(
    (id: string) => {
      const api = apiRef.current
      const panel = findPanel(id)
      if (!api || !panel || panel.group.api.location.type === "edge" || isNarrow()) return
      api.revealEdgeGroupWithData("bottom", { groupId: panel.group.id, panelId: id })
      const bottom = api.getEdgeGroup("bottom")
      bottom?.setHeaderPosition("top")
      bottom?.expand()
      panel.api.setActive()
    },
    [findPanel]
  )

  const moveToMain = React.useCallback(
    (id: string) => {
      const api = apiRef.current
      const panel = findPanel(id)
      const home = api && gridGroupOf(api)
      if (panel && home && panel.group !== home) panel.api.moveTo({ group: home })
    },
    [findPanel]
  )

  const isInBottom = React.useCallback(
    (id: string) => findPanel(id)?.group.api.location.type === "edge",
    [findPanel]
  )

  const toggleBottom = React.useCallback(() => {
    const bottom = apiRef.current?.getEdgeGroup("bottom")
    if (!bottom) return false
    if (bottom.isCollapsed()) bottom.expand()
    else bottom.collapse()
    return true
  }, [])

  /* ── Named layouts ──
     `toJSON` is the whole dock — contents, arrangement, floats, tab groups and
     the bottom panel — so a saved layout is taken and given back in one piece,
     silently: every panel it replaces is the dock rebuilding itself, not the
     user closing anything. */
  const saveLayoutAs = React.useCallback((name: string) => {
    const api = apiRef.current
    return api ? saveNamedLayout(serverIdRef.current ?? "none", name, api.toJSON()) : null
  }, [])

  const applySavedLayout = React.useCallback(
    (id: string) => {
      const api = apiRef.current
      const saved = readSavedLayout(serverIdRef.current ?? "none", id)
      if (!api || !saved) return
      try {
        silently(() => api.fromJSON(saved))
      } catch (error) {
        /* The panels were pruned on the way out, so a throw here is the grid
           itself. Leave the dock that works alone. */
        console.warn("Could not apply the saved layout", error)
      }
    },
    [silently]
  )

  const deleteSavedLayout = React.useCallback((id: string) => {
    forgetSavedLayout(serverIdRef.current ?? "none", id)
  }, [])

  const savedLayouts = React.useCallback(() => listSavedLayouts(serverIdRef.current ?? "none"), [])

  const registerCloseGuard = React.useCallback((id: string, guard: CloseGuard) => {
    guardsRef.current.set(id, guard)
    return () => {
      if (guardsRef.current.get(id) === guard) guardsRef.current.delete(id)
    }
  }, [])

  const listPanels = React.useCallback(
    () =>
      (apiRef.current?.panels ?? []).flatMap((panel) => {
        const descriptor = descriptorOf(panel)
        return descriptor
          ? [{ id: panel.id, panel: descriptor, title: panel.title ?? PANEL_SPECS[descriptor.kind].defaultTitle }]
          : []
      }),
    []
  )

  const isPanelOpen = React.useCallback((id: string) => !!findPanel(id), [findPanel])
  const hasClosedPanels = React.useCallback(() => closedRef.current.length > 0, [])

  const prunePanels = React.useCallback(
    (live: { sessions: Iterable<string>; projects: Iterable<string> }, foreign?: (panel: PanelDescriptor) => string | null) => {
      const api = apiRef.current
      if (!api) return
      const serverId = serverIdRef.current ?? "none"
      const sessions = new Set(live.sessions)
      const projects = new Set(live.projects)
      const filed = new Map<string, PanelDescriptor[]>()
      /* An empty project list is indistinguishable from one that has not loaded,
         and pruning on it would close every project panel on a slow boot. */
      const pruneProjects = projects.size > 0
      silently(() => {
        for (const panel of [...api.panels]) {
          const descriptor = descriptorOf(panel)
          const gone = !descriptor
            ? true
            : descriptor.kind === "chat"
              ? !sessions.has(descriptor.sessionId)
              : /* Boards are the server's, not a project's, and a page is a
                   route — nothing in a prune of sessions and projects can say
                   either is stale. */
                descriptor.kind === "tasks" || descriptor.kind === "page" || !pruneProjects
                ? false
                : !projects.has(descriptor.projectId)
          /* Not gone, but another space's: closed here and owed there. */
          const owner = !gone && descriptor ? foreign?.(descriptor) : null
          if (owner && descriptor) filed.set(owner, [...(filed.get(owner) ?? []), descriptor])
          /* A pruned panel takes its guard and pin with it, or they would veto
             or pin a future panel that reuses the id. */
          if (gone || owner) {
            guardsRef.current.delete(panel.id)
            forgetPanelPin(panel.id)
            api.removePanel(panel)
          }
        }
      })
      for (const [space, panels] of filed) stashPanels(serverId, space, panels)
    },
    [silently]
  )

  /* ── The strip's own keys ──
     The digits, the walk and the close read the strip in front of you and
     nothing wider — on a split, one column of it. */
  const activeStrip = React.useCallback(() => {
    const api = apiRef.current
    return api?.activeGroup ?? api?.groups[0]
  }, [])

  const setTabIndex = React.useCallback(
    (index: number) => {
      activeStrip()?.panels[index]?.api.setActive()
    },
    [activeStrip]
  )

  const cycleTab = React.useCallback(
    (delta: number) => {
      const group = activeStrip()
      const panels = group?.panels ?? []
      if (panels.length < 2) return
      const current = group?.activePanel
      const index = current ? panels.indexOf(current) : 0
      /* Wrapping, and `%` after a `+ length` because a negative delta on the
         first tab is the whole point of walking backwards. */
      panels[(index + delta + panels.length) % panels.length]?.api.setActive()
    },
    [activeStrip]
  )

  const closeActiveTab = React.useCallback(async () => {
    const panel = activeStrip()?.activePanel
    if (panel) await removeWithGuard(panel)
  }, [activeStrip, removeWithGuard])

  /**
   * Swap the dock to another space's tabs.
   *
   * The outgoing layout is filed under the space it was in — under `from`
   * explicitly, because by the time this runs the active space has already
   * moved, and `saveLayout` would otherwise write it under the new one. The
   * debounced save is cancelled first for the same reason. The very first
   * resolution (`from` null: no space was chosen when the dock loaded) is not a
   * switch at all — whatever is on screen is adopted under the space it landed
   * in, so choosing a space on an existing install keeps its tabs.
   */
  const switchSpace = React.useCallback(
    (from: string | null, to: string | null) => {
      const api = apiRef.current
      if (!api) return
      const serverId = serverIdRef.current ?? "none"
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = undefined
      heldSpaceRef.current = to ?? ""
      const outgoing = api.toJSON()
      /* Tabs a prune filed under this space while another was in front. Opened
         through the ordinary door so they land where a new tab lands. */
      const owed = () => {
        for (const panel of takeStashedPanels(serverId, to ?? "")) openPanel(panel, { newTab: true })
      }
      if (!from) {
        saveLayout(serverId, outgoing, to ?? "")
        owed()
        return
      }
      saveLayout(serverId, outgoing, from)
      const next = loadLayout(serverId, to ?? "")
      silently(() => {
        try {
          if (next) api.fromJSON(next)
          else api.clear()
        } catch (error) {
          console.warn("Could not apply the workspace layout for that space", error)
          api.clear()
        }
      })
      owed()
      /* The front tab writes the URL only when it has a route (a terminal has
         none), and a URL still naming the last space's thread pulls a reload
         back there. Point it at a tab this space holds; an empty dock is the
         console's (`dock-surface.tsx`). */
      const routes = api.panels.map(routeOf).filter((path): path is string => !!path)
      if (routes[0] && !routes.includes(location.pathname + location.search))
        navigateTo(routes[0], { replace: true })
    },
    [silently, openPanel]
  )

  /** "Open to the side", asked from outside the dock: a column beside the strip
      in front. A phone folds it back into that strip, which is the tab the same
      menu row would have opened — so the row is not offered there. */
  const openBesideInFront = React.useCallback(
    (path: string) => openRoute(path, { side: "right" }),
    [openRoute]
  )

  const cleanupRef = React.useRef<(() => void) | null>(null)

  const onReady = React.useCallback(
    (api: DockviewApi) => {
      apiRef.current = api
      /* A second ready is StrictMode's double mount in development (a theme
         change is `updateOptions`, not a remount): dispose the previous run's
         listeners or every save and every route sync fires twice. */
      cleanupRef.current?.()

      const serverId = serverIdRef.current ?? "none"
      const saved = loadLayout(serverId)
      heldSpaceRef.current = loadActiveSpace(serverId) ?? ""
      if (saved) {
        try {
          silently(() => api.fromJSON(saved))
        } catch (error) {
          /* Pruning already dropped every panel this build cannot parse, so a
             throw here is the grid itself. Start clean rather than dead. */
          console.warn("Could not restore the workspace layout", error)
          silently(() => api.clear())
        }
      }

      /* The sidebar's thread rows are derived from the dock, never from a
         second route-based copy: open tabs and the active chat are published
         on layout changes and once for what restore put back. */
      const publishOpenThreads = () => setOpenThreads(openChatThreads(api.panels))
      const publishActiveChat = (panel: IDockviewPanel | undefined) => {
        const descriptor = panel ? descriptorOf(panel) : null
        setActiveChat(descriptor?.kind === "chat" ? descriptor.sessionId : null)
        setRouteless(!!panel && !routeOf(panel))
      }
      const focusOpenChat = (id: string) => {
        const panel = api.getPanel(panelId({ kind: "chat", sessionId: id }))
        if (!panel) return false
        panel.api.setActive()
        return true
      }
      const publishDockState = () => {
        publishOpenThreads()
        publishActiveChat(api.activeGroup?.activePanel)
      }
      publishDockState()
      setChatFocusHandler(focusOpenChat)
      setNewTabHandler(openTab)
      setBesideHandler(openBesideInFront)
      setLeaveHandler(leavePage)

      const flushSave = () => {
        if (saveTimerRef.current === undefined) return
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = undefined
        const layout = api.toJSON()
        const space = heldSpaceRef.current
        saveLayout(serverId, layout, space)
      }
      const disposables = [
        api.onDidAddPanel(publishDockState),
        api.onDidRemovePanel(publishDockState),
        api.onDidMovePanel(publishDockState),
        api.onDidActivePanelChange(({ panel }) => {
          publishActiveChat(panel)
          followActive(panel)
        }),
        /* Focus moving to another group — a click in its content, a split pane
           taken — is a change of the tab in front even though no tab changed
           in its own strip, and the sidebar (settings or threads) follows the
           route the focused tab writes. */
        api.onDidActiveGroupChange(() => {
          const panel = api.activeGroup?.activePanel
          publishActiveChat(panel)
          followActive(panel)
        }),
        /* A layout change is raised after the panels list has settled, and it
           covers tab-group changes too (dockview folds them into it). */
        api.onDidLayoutChange(() => {
          publishOpenThreads()
          clearTimeout(saveTimerRef.current)
          saveTimerRef.current = setTimeout(flushSave, SAVE_DEBOUNCE_MS)
        }),
      ]

      /* A split is an even split, and a double-click on a divider evens its row
         out again (`dock-sizes.ts`). Not while a layout is being restored. */
      const stopSplits = watchSplits(api, () => silentRef.current > 0)

      /* The debounce is a window a reload can land in: a tab closed and the
         page reloaded inside 300ms came back. Written on the way out instead. */
      window.addEventListener("pagehide", flushSave)

      cleanupRef.current = () => {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = undefined
        window.removeEventListener("pagehide", flushSave)
        stopSplits()
        disposables.forEach((disposable) => disposable.dispose())
        setChatFocusHandler(null)
        setNewTabHandler(null)
        setBesideHandler(null)
        setLeaveHandler(null)
        setActiveChat(null)
        setRouteless(false)
      }
    },
    [silently, openTab, openBesideInFront, leavePage]
  )

  /* Digits count the tabs in the strip you are looking at. Bound through
     `use-hotkey` so a dialog or the slash menu can out-rank it. */
  useHotkey("mod+1 mod+2 mod+3 mod+4 mod+5 mod+6 mod+7 mod+8 mod+9", (event) => {
    const index = Number(event.key) - 1
    if (!activeStrip()?.panels[index]) return
    event.preventDefault()
    setTabIndex(index)
  })

  /* ⌘W is never the close chord — Electron gives it to close-window — which is
     why the table binds Alt+W (`lib/shortcuts.ts`). */
  useShortcut("nextTab", () => cycleTab(1))
  useShortcut("prevTab", () => cycleTab(-1))
  useShortcut("closeTab", () => void closeActiveTab())
  useShortcut("splitRight", () => splitActive("right"))
  useShortcut("splitDown", () => splitActive("below"))
  useShortcut("fillPanel", () => toggleMaximize())
  useShortcut("fullscreen", () => toggleFullscreen())
  useShortcut("nextPane", () => walkPanes(true))
  useShortcut("prevPane", () => walkPanes(false))
  useShortcut("resizePane", (event) => resizeActive(event.key), { allowRepeat: true })
  useShortcut("moveTab", (event) => moveTab(event.key === "PageUp" ? -1 : 1), { allowRepeat: true })
  useShortcut("sendTab", (event) => sendTab(event.key.replace("Arrow", "").toLowerCase() as "left" | "right" | "up" | "down"))
  useShortcut("equalizePanes", () => equalizePanes())
  useShortcut("reopenPanel", () => reopenClosed())

  React.useEffect(
    () => () => {
      cleanupRef.current?.()
      cleanupRef.current = null
      apiRef.current = null
    },
    []
  )

  return React.useMemo(
    () => ({
      apiRef,
      onReady,
      openPanel,
      openChat,
      openPage,
      navigateActive,
      openTab,
      openRoute,
      consumeConsole,
      closePanel,
      closeOthers,
      closeToTheRight,
      closeGroup,
      splitActive,
      toggleMaximize,
      toggleFullscreen,
      moveTab,
      sendTab,
      equalizePanes,
      stackAll,
      resetLayout,
      reopenClosed,
      applyPreset,
      popoutPanel,
      toggleFloat,
      togglePin,
      isPinned,
      saveLayoutAs,
      applySavedLayout,
      deleteSavedLayout,
      savedLayouts,
      registerCloseGuard,
      listPanels,
      isPanelOpen,
      hasClosedPanels,
      activeDescriptor,
      prunePanels,
      switchSpace,
      setTabIndex,
      cycleTab,
      closeActiveTab,
      addToTabGroup,
      removeFromTabGroup,
      tabGroupsBeside,
      closeTabGroup,
      moveToBottom,
      moveToMain,
      isInBottom,
      toggleBottom,
    }),
    [
      onReady,
      openPanel,
      openChat,
      openPage,
      navigateActive,
      openTab,
      openRoute,
      consumeConsole,
      closePanel,
      closeOthers,
      closeToTheRight,
      closeGroup,
      splitActive,
      toggleMaximize,
      toggleFullscreen,
      moveTab,
      sendTab,
      equalizePanes,
      stackAll,
      resetLayout,
      reopenClosed,
      applyPreset,
      popoutPanel,
      toggleFloat,
      togglePin,
      isPinned,
      saveLayoutAs,
      applySavedLayout,
      deleteSavedLayout,
      savedLayouts,
      registerCloseGuard,
      listPanels,
      isPanelOpen,
      hasClosedPanels,
      activeDescriptor,
      prunePanels,
      switchSpace,
      setTabIndex,
      cycleTab,
      closeActiveTab,
      addToTabGroup,
      removeFromTabGroup,
      tabGroupsBeside,
      closeTabGroup,
      moveToBottom,
      moveToMain,
      isInBottom,
      toggleBottom,
    ]
  )
}

export type { DockviewApi }
