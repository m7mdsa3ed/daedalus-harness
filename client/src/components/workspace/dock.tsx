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
import * as React from "react"
import type { DockviewApi, DockviewGroupPanel, IDockviewPanel } from "dockview-react"

import {
  descriptorOf,
  TAB_GROUP_COLORS,
  type CloseGuard,
  type OpenPanelOptions,
  type PresetId,
  type TabGroupRow,
  type WorkspaceDock,
} from "@/components/workspace/dock-context"
import { navigateTo, threadPath } from "@/lib/router"
import { loadSettings } from "@/lib/settings"
import { useHotkey, useShortcut } from "@/hooks/use-hotkey"
import { MOBILE_BREAKPOINT } from "@/hooks/use-device"
import {
  deleteSavedLayout as forgetSavedLayout,
  listSavedLayouts,
  loadLayout,
  readSavedLayout,
  saveLayout,
  saveNamedLayout,
} from "@/lib/workspace/layout"
import { forgetPanelPin, isPanelPinned, pinnedPanels, togglePanelPin } from "@/lib/workspace/panel-pins"
import { setActiveChat, setChatFocusHandler, setOpenThreads } from "@/lib/workspace/open-threads"
import { PANEL_SPECS, panelId, pageKey, parsePanel, type PanelDescriptor } from "@/lib/workspace/panels"

const SAVE_DEBOUNCE_MS = 300
/** How many closed panels ⌘⇧T can walk back through. */
const REOPEN_DEPTH = 10
/** How long a strip's "+ ▸ New thread" aim waits for the thread's tab, which
    arrives a navigation later. Panels never use it — they pass `into`.
    ponytail: 2s window, thread `into` through the draft route if it misfires. */
const AIM_MS = 2000

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
  /** Drop panels whose session or project no longer exists. */
  prunePanels: (live: { sessions: Iterable<string>; projects: Iterable<string> }) => void
}

export function useWorkspaceDock(): DockController {
  const apiRef = React.useRef<DockviewApi | null>(null)
  const closedRef = React.useRef<{ panel: PanelDescriptor; title: string }[]>([])
  const guardsRef = React.useRef(new Map<string, CloseGuard>())
  /* Programmatic removals — a preset rebuild, a prune, replacing a tab — are
     not the user closing anything, so they must not land on the reopen stack
     or ⌘⇧T would resurrect a thread the server has already forgotten. */
  const silentRef = React.useRef(0)
  const serverIdRef = React.useRef<string | null>(null)
  if (serverIdRef.current === null) serverIdRef.current = loadSettings()?.id ?? "none"

  const silently = React.useCallback(<T,>(fn: () => T): T => {
    silentRef.current += 1
    try {
      return fn()
    } finally {
      silentRef.current -= 1
    }
  }, [])

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

  /* ── The browsing tab ──
     A page is a place you visit, not a thing you keep the way a thread is, so
     the dock holds one page tab and points it wherever the URL goes — the way
     a browser's sidebar links navigate the tab you are in. The first version
     of page tabs opened a tab per place, and reading settings, then the
     schedules, then a project left three tabs beside the chat that none of
     them were about.

     Three answers, in order: a tab already standing for this place (`pageKey`
     — the settings tab whose section moves, a project's own page) is pointed
     at the new path; else the unpinned page tab, whichever place it was on,
     is repointed; else a new one opens beside what you are looking at. A pin
     is how a page is *kept*: a pinned page tab is never repointed to another
     place, and the next page opens its own. The id therefore says nothing
     about the path — it is unique and nothing more. */
  const openPage = React.useCallback((path: string) => {
    const api = apiRef.current
    if (!api) return
    const key = pageKey(path)
    const pages = api.panels.filter((candidate) => candidate.api.component === "page")
    const placeOf = (candidate: IDockviewPanel): string | null => {
      const descriptor = descriptorOf(candidate)
      return descriptor?.kind === "page" ? pageKey(descriptor.path) : null
    }
    const target =
      pages.find((candidate) => placeOf(candidate) === key) ??
      pages.find((candidate) => candidate.api.isActive && !isPanelPinned(candidate.id)) ??
      pages.find((candidate) => !isPanelPinned(candidate.id))
    if (target) {
      const descriptor = descriptorOf(target)
      if (descriptor?.kind !== "page" || descriptor.path !== path)
        target.api.updateParameters({ kind: "page", path })
      target.api.setActive()
      return
    }
    const group = api.activeGroup?.activePanel?.group ?? api.activeGroup ?? undefined
    let id = `page:${key}`
    for (let n = 2; api.getPanel(id); n += 1) id = `page:${key}:${n}`
    api.addPanel({
      id,
      component: "page",
      title: PANEL_SPECS.page.defaultTitle,
      params: { kind: "page", path },
      position: group ? { referenceGroup: group.id, direction: "within" as const } : undefined,
    })
  }, [])

  const consumeConsole = React.useCallback(() => {
    const api = apiRef.current
    const active = api?.activeGroup?.activePanel
    if (!api || !active || active.api.component !== "page" || isPanelPinned(active.id)) return
    const descriptor = descriptorOf(active)
    if (descriptor?.kind !== "page" || pageKey(descriptor.path) !== "home") return
    silently(() => api.removePanel(active))
  }, [silently])

  const targetRef = React.useRef<{ group: string; at: number } | null>(null)
  const targetNext = React.useCallback((group: string) => {
    targetRef.current = { group, at: Date.now() }
  }, [])

  const openPanel = React.useCallback(
    (panel: PanelDescriptor, options?: OpenPanelOptions) => {
      /* The thread aim is spent by a chat and nothing else, so a page or a
         panel opened in between cannot take it. */
      let aim = options?.into
      if (!aim && panel.kind === "chat") {
        const pending = targetRef.current
        targetRef.current = null
        if (pending && Date.now() - pending.at < AIM_MS) aim = { group: pending.group }
      }
      const api = apiRef.current
      if (!api || !PANEL_SPECS[panel.kind].implemented) return
      /* One door for a page, whoever knocks — ⌘⇧T reopening one included. */
      if (panel.kind === "page") return openPage(panel.path)

      const id = panelId(panel)
      const existing = api.getPanel(id)
      if (existing) {
        /* Same id, different params is "the same surface, pointed somewhere
           else" — the Browser panel following a second source is the whole
           reason it can happen, since its `viewId` is its identity and the URL
           is not. Both sides normalized through `parsePanel`, so the order some
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
      const group = aimed ?? current?.group

      /* ── Opening never splits ──
         Every panel arrives the way a new thread does: a tab beside what you
         are looking at. The side a caller asked for is read as "and do not
         replace what is in front of me" and nothing more. Splitting is asked
         for by name (`splitActive`). */
      const newTab = options?.newTab || !!options?.direction

      /* Replace-in-place: the panel you came from goes away unless you asked
         for a new tab. Only same-kind panels — and never chats, which every
         caller opens with `newTab`. */
      const replace = !!current && current.api.component === panel.kind && !newTab
      const anchor = aim?.beside ? api.getPanel(aim.beside) : undefined
      const beside = anchor && anchor.group === group ? anchor : undefined
      const index = group
        ? beside
          ? group.panels.indexOf(beside) + 1
          : replace
            ? group.panels.indexOf(current) + 1
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

      if (replace && current && !beside) silently(() => api.removePanel(current))
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
    [silently, openPage]
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
    api.removePanel(panel)
    return true
  }, [])

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
    (direction: "right" | "below", id?: string) => {
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
     A popout is a real browser window holding this panel, rendered by the same
     React tree (Dockview reparents the DOM). A *user gesture* only: `window.open`
     off one is a popup, and a browser blocks it — which is also why a
     popped-out panel comes home rather than reopening on the next load
     (`dockPopouts`). */
  const popoutPanel = React.useCallback(
    async (id?: string) => {
      const api = apiRef.current
      const panel = panelFor(id)
      if (!api || !panel) return false
      try {
        return await api.addPopoutGroup(panel, { popoutUrl: `${import.meta.env.BASE_URL}popout.html` })
      } catch (error) {
        console.warn("Could not open the panel in its own window", error)
        return false
      }
    },
    [panelFor]
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
    (live: { sessions: Iterable<string>; projects: Iterable<string> }) => {
      const api = apiRef.current
      if (!api) return
      const sessions = new Set(live.sessions)
      const projects = new Set(live.projects)
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
                : descriptor.kind === "web"
                  ? descriptor.trust === "project" && !!descriptor.projectId && !projects.has(descriptor.projectId)
                  : !projects.has(descriptor.projectId)
          /* A pruned panel takes its guard and pin with it, or they would veto
             or pin a future panel that reuses the id. */
          if (gone) {
            guardsRef.current.delete(panel.id)
            forgetPanelPin(panel.id)
            api.removePanel(panel)
          }
        }
      })
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

      let saveTimer: ReturnType<typeof setTimeout> | undefined
      const flushSave = () => {
        if (saveTimer === undefined) return
        clearTimeout(saveTimer)
        saveTimer = undefined
        saveLayout(serverId, api.toJSON())
      }
      const disposables = [
        api.onDidAddPanel(publishDockState),
        api.onDidRemovePanel(publishDockState),
        api.onDidMovePanel(publishDockState),
        api.onDidActivePanelChange(({ panel }) => {
          publishActiveChat(panel)
          followActive(panel)
        }),
        /* A layout change is raised after the panels list has settled, and it
           covers tab-group changes too (dockview folds them into it). */
        api.onDidLayoutChange(() => {
          publishOpenThreads()
          clearTimeout(saveTimer)
          saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS)
        }),
      ]

      /* The debounce is a window a reload can land in: a tab closed and the
         page reloaded inside 300ms came back. Written on the way out instead. */
      window.addEventListener("pagehide", flushSave)

      cleanupRef.current = () => {
        clearTimeout(saveTimer)
        window.removeEventListener("pagehide", flushSave)
        disposables.forEach((disposable) => disposable.dispose())
        setChatFocusHandler(null)
        setActiveChat(null)
      }
    },
    [silently]
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
      consumeConsole,
      closePanel,
      closeOthers,
      closeToTheRight,
      closeGroup,
      splitActive,
      targetNext,
      toggleMaximize,
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
      consumeConsole,
      closePanel,
      closeOthers,
      closeToTheRight,
      closeGroup,
      splitActive,
      targetNext,
      toggleMaximize,
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
