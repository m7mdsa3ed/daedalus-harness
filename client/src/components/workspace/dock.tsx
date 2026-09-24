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

   The controller is this file (`useWorkspaceDock`); the surface it drives is
   `dock-surface.tsx`, the shape and contexts every panel reads are
   `dock-context.ts`, and the header measurement is `dock-header.ts`. */
import * as React from "react"
import type { DockviewApi, IDockviewPanel } from "dockview-react"

import {
  descriptorOf,
  setDockGroups,
  type CloseGuard,
  type OpenPanelOptions,
  type WorkspaceDock,
} from "@/components/workspace/dock-context"
import { navigateTo, threadPath } from "@/lib/router"
import { loadSettings } from "@/lib/settings"
import { notifyDockLayout } from "@/lib/workspace/panel-overlap"
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
import { setOpenThreads } from "@/lib/workspace/open-threads"
import {
  PANEL_SPECS,
  panelId,
  parsePanel,
  pageKey,
  type PanelDescriptor,
} from "@/lib/workspace/panels"

const SAVE_DEBOUNCE_MS = 300
/** How many closed panels ⌘⇧T can walk back through. */
const REOPEN_DEPTH = 10

const isChat = (panel: IDockviewPanel) => panel.api.component === "chat"

/** The chat panels open in the dock, in the order they were opened — what the
    sidebar's "Opened" tier lists and what Recents leaves out. Only chats: every
    other kind is a panel, not a thread, and a session id is unique per panel, so
    this cannot hold a duplicate. */
function openChatThreads(panels: IDockviewPanel[]): string[] {
  const ids: string[] = []
  for (const panel of panels) {
    if (!isChat(panel)) continue
    const descriptor = descriptorOf(panel)
    if (descriptor?.kind === "chat") ids.push(descriptor.sessionId)
  }
  return ids
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

  /* ── The two levels ──
     A group panel holds a whole second dockview (`group-panel.tsx`), which
     registers itself here on ready. Everything that asks a question about "the
     panels" asks it across every instance — a nested `thread:{id}` is still the
     one there is, so opening that thread must focus it rather than mint a
     second connection. */
  const nestedRef = React.useRef(new Map<string, DockviewApi>())
  /* Panels promised to a group that does not have an instance yet: minting the
     group panel and filling it are two frames apart (`attachNested` drains
     this). */
  const pendingNestRef = React.useRef(new Map<string, { panel: PanelDescriptor; title: string }[]>())

  /** Every live instance, the top level first. */
  const instances = React.useCallback((): DockviewApi[] => {
    const api = apiRef.current
    return api ? [api, ...nestedRef.current.values()] : [...nestedRef.current.values()]
  }, [])

  const allPanels = React.useCallback(
    (): IDockviewPanel[] => instances().flatMap((api) => api.panels),
    [instances]
  )

  const findPanel = React.useCallback(
    (id: string): IDockviewPanel | undefined => {
      for (const api of instances()) {
        const panel = api.getPanel(id)
        if (panel) return panel
      }
      return undefined
    },
    [instances]
  )

  /** The instance a panel belongs to. */
  const ownerOf = React.useCallback(
    (panel: IDockviewPanel): DockviewApi | undefined =>
      instances().find((api) => api.panels.includes(panel)),
    [instances]
  )

  const isNested = React.useCallback((api: DockviewApi) => api !== apiRef.current, [])

  /** The top-level group panel an instance is drawn inside. */
  const groupPanelOf = React.useCallback((api: DockviewApi): IDockviewPanel | undefined => {
    for (const [groupPanelId, nested] of nestedRef.current)
      if (nested === api) return apiRef.current?.getPanel(groupPanelId) ?? undefined
    return undefined
  }, [])

  const groupIdOf = React.useCallback(
    (api: DockviewApi) => (isNested(api) ? groupPanelOf(api)?.id : undefined),
    [isNested, groupPanelOf]
  )

  /** The instance in front of you: the nested one when a group tab is active. */
  const activeApi = React.useCallback((): DockviewApi | undefined => {
    const api = apiRef.current
    const active = api?.activeGroup?.activePanel
    if (active && active.api.component === "group") {
      const nested = nestedRef.current.get(active.id)
      if (nested) return nested
    }
    return api ?? undefined
  }, [])

  const activeDescriptor = React.useCallback((): PanelDescriptor | undefined => {
    const panel = activeApi()?.activeGroup?.activePanel
    return (panel && descriptorOf(panel)) ?? undefined
  }, [activeApi])

  const notifyGroups = React.useCallback(() => {
    const api = apiRef.current
    setDockGroups(
      (api?.panels ?? [])
        .filter((panel) => panel.api.component === "group")
        .map((panel) => ({
          id: panel.id,
          title: panel.title ?? PANEL_SPECS.group.defaultTitle,
          hint: (nestedRef.current.get(panel.id)?.panels ?? [])
            .map((held) => held.title ?? "")
            .filter(Boolean)
            .join(", "),
        }))
    )
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

  /* A nested strip's + names its own instance. Read by the next open and
     spent by it; the thread path gets there a navigation later, hence a
     window rather than the same tick.
     ponytail: 2s window, pass the instance down the thread path if it misfires. */
  const targetRef = React.useRef<{ api: DockviewApi | string; at: number } | null>(null)
  const targetNext = React.useCallback((api: DockviewApi | string) => {
    targetRef.current = { api, at: Date.now() }
  }, [])

  /* Put a panel in a named group, whether or not that group has an instance
     yet: the group a "+ into a group" row mints is one render old when the
     open arrives, so an unattached one takes the same pending list the move
     that minted it uses. Already there — focus it; anywhere else — it is the
     close-and-open every crossing between two instances is. */
  const intoGroup = React.useCallback(
    (groupPanelId: string, panel: PanelDescriptor) => {
      const root = apiRef.current
      const nested = nestedRef.current.get(groupPanelId)
      const existing = findPanel(panelId(panel))
      const owner = existing ? ownerOf(existing) : undefined
      const title = existing?.title ?? PANEL_SPECS[panel.kind].defaultTitle
      if (existing && owner && owner === nested) {
        existing.api.setActive()
      } else {
        silently(() => {
          if (existing && owner) owner.removePanel(existing)
          if (nested)
            nested.addPanel({
              id: panelId(panel),
              component: panel.kind,
              title,
              params: panel as unknown as Record<string, unknown>,
            })
        })
        if (!nested)
          pendingNestRef.current.set(groupPanelId, [
            ...(pendingNestRef.current.get(groupPanelId) ?? []),
            { panel, title },
          ])
      }
      root?.getPanel(groupPanelId)?.api.setActive()
    },
    [findPanel, ownerOf, silently]
  )

  const openPanel = React.useCallback(
    (panel: PanelDescriptor, options?: OpenPanelOptions) => {
      const target = targetRef.current
      targetRef.current = null
      const aimed = target && Date.now() - target.at < 2000 ? target.api : null
      /* Aimed at a group by id: the one path that can land somewhere that does
         not exist yet, so it is answered before anything reads an instance. */
      if (typeof aimed === "string" && panel.kind !== "page" && panel.kind !== "group") {
        if (PANEL_SPECS[panel.kind].implemented) intoGroup(aimed, panel)
        return
      }
      /* No aim: the instance in front of you, which is the nested one while a
         group tab is active — a thread started from ⌘N, the sidebar or the
         palette while you are reading a group belongs in that group, not
         behind it at the top level. */
      const api =
        aimed && typeof aimed !== "string" && instances().includes(aimed) ? aimed : activeApi()
      if (!api) return
      if (!PANEL_SPECS[panel.kind].implemented) return
      /* One door for a page, whoever knocks — ⌘⇧T reopening one included. */
      if (panel.kind === "page") return openPage(panel.path)

      const id = panelId(panel)
      /* Across both levels: a panel inside a group is still the one that holds
         this resource, so opening it again focuses it — through its group's own
         tab, which is the only way it can be seen. */
      const existing = findPanel(id)
      if (existing) {
        /* Same id, different params is "the same surface, pointed somewhere
           else" — the Browser panel following a second source is the whole
           reason it can happen, since its `viewId` is its identity and the URL
           is not. Anything the id already distinguishes (a file's path, a
           terminal) cannot reach here with a different descriptor at all, so
           this is not a way to smuggle one panel into being another. */
        /* Both sides normalized through `parsePanel`, so the comparison is of
           the fields and not of the order some caller wrote its literal in. */
        const current = descriptorOf(existing)
        const next = parsePanel(panel.kind, panel)
        if (!current || JSON.stringify(current) !== JSON.stringify(next)) {
          existing.api.updateParameters(panel as unknown as Record<string, unknown>)
        }
        if (!options?.background) {
          const owner = ownerOf(existing)
          if (owner && isNested(owner)) groupPanelOf(owner)?.api.setActive()
          existing.api.setActive()
        }
        return
      }

      /* Where a new panel lands: beside the panel of the same kind you were
         last looking at, because that is the group that kind belongs to. A
         chat opens among the chats even when a terminal has focus. */
      const siblings = api.panels.filter((candidate) => candidate.api.component === panel.kind)
      const current =
        siblings.find((candidate) => candidate.api.isActive) ??
        siblings.find((candidate) => candidate.group.activePanel === candidate) ??
        siblings[0] ??
        api.activeGroup?.activePanel
      const group = current?.group

      /* ── Opening never splits ──
         Every panel arrives the way a new thread does: a tab beside what you
         are looking at. The side a caller asked for is read as "and do not
         replace what is in front of me" and nothing more — the one place it is
         decided, so the + menu, the chords, the palette and every transcript
         link give the same answer.

         What this replaced was a rule that split the dock when the window was
         wide enough and no group of that kind existed yet. It meant "open a
         terminal" cut the dock in half under the transcript, "open the IDE" cut
         it in half beside it, and the *second* of each landed as a tab — so the
         same click did two different things depending on the state of a layout
         the reader had arranged themselves. Splitting is a thing you ask for by
         name now: `splitActive`, the chord and the palette row, both of which
         say which panel they move. */
      const newTab = options?.newTab || !!options?.direction

      /* Replace-in-place: the panel you came from goes away unless you asked
         for a new tab. Only same-kind panels are replaced — and no longer
         chats, which every caller now opens with `newTab` (a thread you opened
         is one you meant to keep; see the route effect in `app-shell`). What is
         left on it is the kind whose "open another" genuinely means "point this
         one somewhere else". */
      const replace = !!current && current.api.component === panel.kind && !newTab
      const index = replace && group ? group.panels.indexOf(current) + 1 : undefined

      api.addPanel({
        id,
        component: panel.kind,
        title: PANEL_SPECS[panel.kind].defaultTitle,
        params: panel as unknown as Record<string, unknown>,
        inactive: options?.background,
        /* Always *within* a group — the one above if there is one, otherwise
           dockview's own answer for an empty dock. Nothing here opens a group
           any more; `splitActive` and `toggleFloat` are what make one. */
        position: group
          ? { referenceGroup: group.id, direction: "within" as const, index }
          : undefined,
      })

      if (replace && current) silently(() => api.removePanel(current))
    },
    [silently, openPage, findPanel, ownerOf, isNested, groupPanelOf, instances, activeApi, intoGroup]
  )

  const openChat = React.useCallback(
    (sessionId: string, options?: OpenPanelOptions) => openPanel({ kind: "chat", sessionId }, options),
    [openPanel]
  )

  /* Every panel can be closed, the last one included: an empty dock goes to
     the landing console (`onDidRemovePanel` in `handleReady`), which is the
     app's own empty state — the last chat used to be pinned open because a
     route always named a thread, and it no longer has to. */
  const isClosable = React.useCallback(
    (panel: IDockviewPanel): boolean => !!ownerOf(panel),
    [ownerOf]
  )

  const removeWithGuard = React.useCallback(async (panel: IDockviewPanel): Promise<boolean> => {
    /* The instance that *holds* it, never the top level: a tab inside a group
       is removed by its own dock, and asking the outer one to remove it is a
       no-op that leaves the tab on screen. */
    const api = ownerOf(panel)
    if (!api) return false
    const guard = guardsRef.current.get(panel.id)
    if (guard && !(await guard())) return false
    /* A pin belongs to a panel, not to an id: leaving it behind would pin
       whatever next earns that name — a new terminal in the same project, a
       thread restored from Trash. */
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
  }, [ownerOf])

  const closePanel = React.useCallback(
    async (id: string) => {
      const panel = findPanel(id)
      if (!panel || !isClosable(panel)) return
      await removeWithGuard(panel)
    },
    [findPanel, isClosable, removeWithGuard]
  )

  /** Panels sharing a group with `id`, in tab order. Recomputed per call — a
      snapshot taken at render could close the wrong tabs after a drag. */
  const groupPanels = React.useCallback(
    (id: string): IDockviewPanel[] => {
      const panel = findPanel(id)
      return panel ? [...panel.group.panels] : []
    },
    [findPanel]
  )

  /* Bulk closes stop at the first refusal rather than skipping past it: a
     "close others" that silently leaves one guarded panel behind, in a group
     that no longer looks the way you left it, is worse than stopping where the
     question was asked. */
  const closeEach = React.useCallback(
    async (panels: IDockviewPanel[]) => {
      for (const panel of panels) {
        if (!isClosable(panel)) continue
        /* A pinned tab is the one thing "close others" is for: you pinned it so
           that the tidy-up would go around it. Closing it stays possible — its
           own Close, which names it. */
        if (isPanelPinned(panel.id)) continue
        if (!(await removeWithGuard(panel))) return
      }
    },
    [isClosable, removeWithGuard]
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

  const splitActive = React.useCallback((direction: "right" | "below") => {
    const api = apiRef.current
    /* One group below `md`, by construction (the stack effect above), so a
       split asked for on a phone is a group the fold-back takes away in the
       next microtask. Refused at the source, which is also the chord's path —
       the palette's rows are simply not offered there. */
    if (window.innerWidth < MOBILE_BREAKPOINT) return
    const panel = api?.activeGroup?.activePanel
    const descriptor = panel && descriptorOf(panel)
    if (!api || !panel || !descriptor) return
    /* Splitting duplicates a *resource*, and a resource is its id — so a second
       view of the same panel cannot exist. Move it instead: the group it lands
       in is new, the panel is the one you were looking at, and the group it
       left closes itself if that emptied it. */
    if (panel.group.panels.length === 1) return
    panel.api.moveTo({ group: api.addGroup({ referenceGroup: panel.group, direction }) })
  }, [])

  const toggleMaximize = React.useCallback(() => {
    const api = apiRef.current
    const panel = api?.activeGroup?.activePanel
    if (!api || !panel) return
    if (api.hasMaximizedGroup()) api.exitMaximizedGroup()
    else api.maximizeGroup(panel)
  }, [])

  /** Everything into one group, in the order it is laid out. */
  const stackAll = React.useCallback(() => {
    const api = apiRef.current
    if (!api) return
    const target = api.activeGroup ?? api.groups[0]
    if (!target) return
    silently(() => {
      for (const panel of [...api.panels]) {
        if (panel.group !== target) panel.api.moveTo({ group: target })
      }
      if (api.hasMaximizedGroup()) api.exitMaximizedGroup()
    })
  }, [silently])

  /** Rebuild the dock from the panels that are open. Presets are arrangements,
      not contents: nothing is opened or closed, only moved. */
  const applyPreset = React.useCallback(
    () => {
      const api = apiRef.current
      if (!api) return
      const active = api.activeGroup?.activePanel
      if (api.hasMaximizedGroup()) api.exitMaximizedGroup()

      stackAll()
      if (active) api.maximizeGroup(active)
    },
    [stackAll]
  )

  const resetLayout = React.useCallback(() => {
    /* Reset means the arrangement, not the work: the panels that are open stay
       open and stack into one group. The debounced save then writes that back,
       so there is no separate "forget the saved layout" step — the tidy one
       replaces the bad one on disk a moment later. */
    stackAll()
  }, [stackAll])

  const reopenClosed = React.useCallback(() => {
    const next = closedRef.current[0]
    if (!next) return
    closedRef.current = closedRef.current.slice(1)
    openPanel(next.panel, { newTab: true })
  }, [openPanel])

  /* ── Pinning ──
     The set is `lib/workspace/panel-pins`; what the dock adds is the one thing
     a store cannot do — putting the tab where a pinned tab belongs. Pinned
     panels keep their relative order at the front of the group, so pinning a
     second one does not jump it in front of the first. */
  const togglePin = React.useCallback((id: string) => {
    const api = apiRef.current
    const panel = api?.getPanel(id)
    if (!panel) return
    const pinned = togglePanelPin(id)
    if (!pinned) return
    const pins = pinnedPanels()
    const ahead = panel.group.panels.filter(
      (candidate) => candidate.id !== id && pins.has(candidate.id)
    ).length
    if (panel.group.panels.indexOf(panel) !== ahead)
      panel.api.moveTo({ group: panel.group, index: ahead, skipSetActive: true })
  }, [])

  const isPinned = React.useCallback((id: string) => isPanelPinned(id), [])

  /* ── Its own window ──
     A popout is a real browser window holding this panel, rendered by the same
     React tree (Dockview reparents the DOM), so a terminal or a preview can sit
     on a second monitor. It is a *user gesture* only: `window.open` off one is a
     popup, and a browser blocks it — which is also why a popped-out panel comes
     home rather than reopening on the next load (see `dockPopouts`). */
  const popoutPanel = React.useCallback(async (id?: string) => {
    const api = apiRef.current
    const panel = id ? api?.getPanel(id) : api?.activeGroup?.activePanel
    if (!api || !panel) return false
    try {
      return await api.addPopoutGroup(panel, {
        popoutUrl: `${import.meta.env.BASE_URL}popout.html`,
      })
    } catch (error) {
      console.warn("Could not open the panel in its own window", error)
      return false
    }
  }, [])

  /* Floating is the same move without a window: a group over the dock, dragged
     and resized in the page. Toggling back docks it into the grid, which is the
     only way out that does not close the panel. */
  const toggleFloat = React.useCallback((id?: string) => {
    const api = apiRef.current
    const panel = id ? api?.getPanel(id) : api?.activeGroup?.activePanel
    if (!api || !panel) return
    if (panel.group.api.location.type === "floating") {
      panel.api.moveTo({ group: api.addGroup() })
      return
    }
    api.addFloatingGroup(panel)
  }, [])

  /* ── Named layouts ──
     `toJSON` is the whole dock — contents, arrangement and the floats — so a
     saved layout is taken and given back in one piece. Applying one is
     `fromJSON`, done silently: every panel it replaces is the dock rebuilding
     itself, not the user closing anything, so none of it lands on ⌘⇧T. */
  const saveLayoutAs = React.useCallback((name: string) => {
    const api = apiRef.current
    if (!api) return null
    return saveNamedLayout(serverIdRef.current ?? "none", name, api.toJSON())
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
           itself. The dock the user is looking at is the one that works —
           leave it alone rather than clearing it out from under them. */
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

  const listPanels = React.useCallback(() => {
    return allPanels().flatMap((panel) => {
      const descriptor = descriptorOf(panel)
      return descriptor
        ? [{ id: panel.id, panel: descriptor, title: panel.title ?? PANEL_SPECS[descriptor.kind].defaultTitle }]
        : []
    })
  }, [allPanels])

  const isPanelOpen = React.useCallback((id: string) => !!findPanel(id), [findPanel])
  const hasClosedPanels = React.useCallback(() => closedRef.current.length > 0, [])

  const prunePanels = React.useCallback(
    (live: { sessions: Iterable<string>; projects: Iterable<string> }) => {
      const api = apiRef.current
      if (!api) return
      const sessions = new Set(live.sessions)
      const projects = new Set(live.projects)
      /* An empty project list is indistinguishable from one that has not loaded,
         and pruning on it would close every project panel on a slow boot. There
         is always at least one project once bootstrap is done. */
      const pruneProjects = projects.size > 0
      silently(() => {
        /* Both levels: a thread closed on the server is stale wherever its tab
           happens to be sitting. A group panel itself is never stale — it names
           no session and no project — and emptying one closes it (`attachNested`). */
        for (const panel of allPanels()) {
          const owner = ownerOf(panel)
          if (!owner) continue
          const descriptor = descriptorOf(panel)
          if (!descriptor) {
            owner.removePanel(panel)
            continue
          }
          if (descriptor.kind === "group") continue
          const gone =
            descriptor.kind === "chat"
              ? !sessions.has(descriptor.sessionId)
              : /* Boards belong to the server, not to a project, so nothing in
                   a prune of sessions and projects can say a tasks panel is
                   stale — a deleted board resolves to another one from inside
                   the panel (`lib/tasks-location.ts`). */
                descriptor.kind === "tasks" || descriptor.kind === "page"
                ? false
                : !pruneProjects
                  ? false
                  : descriptor.kind === "web"
                    ? descriptor.trust === "project" &&
                      !!descriptor.projectId &&
                      !projects.has(descriptor.projectId)
                    : !projects.has(descriptor.projectId)
          /* A pruned panel takes its guard with it — the panel is gone, so
             there is nothing left to ask, and a stale entry would veto a future
             panel that happens to reuse the id. */
          if (gone) {
            guardsRef.current.delete(panel.id)
            forgetPanelPin(panel.id)
            owner.removePanel(panel)
          }
        }
      })
    },
    [silently, allPanels, ownerOf]
  )

  /* ── The strip's own keys ──
     All three read the group in front of you and nothing wider: the digits, the
     walk and the close act on the strip the reader is looking at, which on a
     split is one column of it and inside a group tab is the nested strip. */
  const activeStrip = React.useCallback(() => {
    const api = activeApi()
    return api?.activeGroup ?? api?.groups[0]
  }, [activeApi])

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
    if (!panel || !isClosable(panel)) return
    await removeWithGuard(panel)
  }, [activeStrip, isClosable, removeWithGuard])

  /* ── The doors between the two levels ── */

  /* A tab dragged from one instance's strip onto another's: dockview only moves
     within an instance, so the foreign drop arrives unhandled and is the same
     close-and-open every menu row is. The transfer names the panel; which
     instance it came from is ours to find. */
  const dropForeign = React.useCallback(
    (target: DockviewApi, droppedId: string, group?: { id: string }) => {
      const panel = findPanel(droppedId)
      const source = panel && ownerOf(panel)
      const descriptor = panel && descriptorOf(panel)
      if (!panel || !source || !descriptor || source === target) return
      /* One level: a group cannot be dropped into a group. */
      if (descriptor.kind === "group" && isNested(target)) return
      const title = panel.title ?? PANEL_SPECS[descriptor.kind].defaultTitle
      silently(() => {
        source.removePanel(panel)
        target.addPanel({
          id: droppedId,
          component: descriptor.kind,
          title,
          params: descriptor as unknown as Record<string, unknown>,
          position: group ? { referenceGroup: group.id, direction: "within" as const } : undefined,
        })
      })
    },
    [findPanel, ownerOf, isNested, silently]
  )

  const attachNested = React.useCallback(
    (groupPanelId: string, api: DockviewApi) => {
      nestedRef.current.set(groupPanelId, api)
      const owner = () => apiRef.current?.getPanel(groupPanelId)
      /* The inner layout rides on the group panel's params. To dockview a
         params change *is* a layout change of the outer, so this is what puts
         the nested tabs into the outer's debounced save with no second store
         and no second key. The title is the count, and only written when it
         changes — a title change is a layout change too. */
      const persist = () => {
        const panel = owner()
        const descriptor = panel && descriptorOf(panel)
        if (!panel || descriptor?.kind !== "group") return
        panel.api.updateParameters({ ...descriptor, layout: api.toJSON() } as unknown as Record<string, unknown>)
        const title = `Group · ${api.panels.length}`
        if (panel.title !== title) panel.api.setTitle(title)
        notifyGroups()
      }

      /* Anything promised to this group before it had an instance — the move
         that minted it. Drained once, here, because the panel was removed from
         its old dock in the same breath and this is the only thing holding it. */
      const pending = pendingNestRef.current.get(groupPanelId)
      pendingNestRef.current.delete(groupPanelId)
      if (pending?.length) {
        silently(() => {
          for (const entry of pending) {
            if (api.getPanel(panelId(entry.panel))) continue
            api.addPanel({
              id: panelId(entry.panel),
              component: entry.panel.kind,
              title: entry.title,
              params: entry.panel as unknown as Record<string, unknown>,
            })
          }
        })
      }

      const disposables = [
        api.onDidLayoutChange(() => {
          persist()
          /* The inner groups moved; every panel measures its own overlap. */
          notifyDockLayout()
        }),
        api.onDidAddPanel(persist),
        api.onDidMovePanel(persist),
        api.onDidRemovePanel(() => {
          persist()
          /* An empty group is a tab with nothing to show, so it goes with its
             last panel — silently, because the panel's own close is what landed
             on ⌘⇧T. A microtask later, for the reason the outer's own
             last-tab rule waits: a restore empties before it refills. */
          queueMicrotask(() => {
            if (api.panels.length > 0) return
            const panel = owner()
            if (panel) silently(() => apiRef.current?.removePanel(panel))
          })
        }),
        /* The same two things the top level does with its own strip: a tab
           dropped in from outside, and the route following the chat you
           focused — a thread in a group is still the thread on screen. */
        api.onDidDrop((event) => {
          const transfer = event.getData()
          if (transfer?.panelId) dropForeign(api, transfer.panelId, event.group ?? undefined)
        }),
        api.onDidActivePanelChange(({ panel }) => {
          const descriptor = panel && descriptorOf(panel)
          const path =
            descriptor?.kind === "chat"
              ? threadPath(descriptor.sessionId)
              : descriptor?.kind === "page"
                ? descriptor.path
                : null
          if (path && location.pathname + location.search !== path) navigateTo(path, { replace: true })
        }),
      ]
      persist()
      notifyGroups()

      return () => {
        disposables.forEach((disposable) => disposable.dispose())
        if (nestedRef.current.get(groupPanelId) === api) nestedRef.current.delete(groupPanelId)
        notifyGroups()
      }
    },
    [silently, notifyGroups, dropForeign]
  )

  /* ── In, across and out ──
     Every one of them is a close and an open of the same descriptor, silently:
     dockview's own `moveTo` cannot cross two instances. A panel *is* its
     descriptor (`panels.ts`), so nothing is lost — a terminal reattaches to its
     PTY by id, a thread to its session, the IDE to its own tab store. The title
     is carried so a thread does not flash "Thread" on the way. */
  const moveToGroup = React.useCallback(
    (id: string, groupPanelId: string | null): string | null => {
      const panel = findPanel(id)
      const source = panel && ownerOf(panel)
      const descriptor = panel && descriptorOf(panel)
      const root = apiRef.current
      if (!panel || !source || !descriptor || !root || descriptor.kind === "group") return null

      /* Into a group that exists: straight across, and the group's own tab is
         brought to the front so the move is seen. The source, if it was a
         group emptied by this, closes itself. */
      if (groupPanelId) {
        const target = nestedRef.current.get(groupPanelId)
        if (!target || target === source) return null
        const title = panel.title ?? PANEL_SPECS[descriptor.kind].defaultTitle
        silently(() => {
          source.removePanel(panel)
          target.addPanel({
            id,
            component: descriptor.kind,
            title,
            params: descriptor as unknown as Record<string, unknown>,
          })
        })
        root.getPanel(groupPanelId)?.api.setActive()
        return groupPanelId
      }

      /* Into a new group: minted at the top level — in the tab's place when
         it is a top-level tab, beside the group it is leaving otherwise — and
         filled once its instance is ready (`attachNested`). */
      const groupId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      const newId = panelId({ kind: "group", groupId })
      pendingNestRef.current.set(newId, [
        { panel: descriptor, title: panel.title ?? PANEL_SPECS[descriptor.kind].defaultTitle },
      ])
      const anchor = isNested(source) ? groupPanelOf(source) : panel
      const group = anchor?.group
      silently(() => {
        root.addPanel({
          id: newId,
          component: "group",
          title: PANEL_SPECS.group.defaultTitle,
          params: { kind: "group", groupId },
          position: group
            ? {
                referenceGroup: group.id,
                direction: "within",
                index: group.panels.indexOf(anchor!) + (anchor === panel ? 0 : 1),
              }
            : undefined,
        })
        source.removePanel(panel)
      })
      return newId
    },
    [findPanel, ownerOf, isNested, groupPanelOf, silently]
  )

  const unnestPanel = React.useCallback(
    (id: string) => {
      const panel = findPanel(id)
      const source = panel && ownerOf(panel)
      const descriptor = panel && descriptorOf(panel)
      const root = apiRef.current
      if (!panel || !source || !descriptor || !root || !isNested(source)) return
      /* Out beside the group's own tab, which is where it went in from. */
      const anchor = groupPanelOf(source)
      const group = anchor?.group
      const title = panel.title ?? PANEL_SPECS[descriptor.kind].defaultTitle
      silently(() => {
        source.removePanel(panel)
        root.addPanel({
          id,
          component: descriptor.kind,
          title,
          params: descriptor as unknown as Record<string, unknown>,
          position:
            group && anchor
              ? { referenceGroup: group.id, direction: "within", index: group.panels.indexOf(anchor) + 1 }
              : undefined,
        })
      })
    },
    [findPanel, ownerOf, isNested, groupPanelOf, silently]
  )

  const cleanupRef = React.useRef<(() => void) | null>(null)

  const onReady = React.useCallback((api: DockviewApi) => {
    apiRef.current = api
    // Re-ready happens on a theme change (DockviewReact remounts): dispose the
    // previous run's listeners or every save and every route sync fires twice.
    cleanupRef.current?.()

    const serverId = serverIdRef.current ?? "none"
    const saved = loadLayout(serverId)
    if (saved) {
      try {
        silently(() => api.fromJSON(saved))
      } catch (error) {
        /* Pruning already dropped every panel this build cannot parse, so a
           throw here is the grid itself — a shape from a future dockview, or a
           size that no longer fits. Start clean rather than dead. */
        console.warn("Could not restore the workspace layout", error)
        silently(() => api.clear())
      }
    }

    /* The sidebar's "Opened" tier is derived from the dock, never a second copy
       of it: publish on every add, remove and move, and once now for what the
       restored layout just put back. This is what makes a refresh bring the
       same tabs back *and* the same rows into the sidebar. */
    const publishOpenThreads = () => {
      /* Both levels: a thread in a group is open, and the sidebar's "Opened"
         tier is a reading of the dock, not of one instance. */
      setOpenThreads(openChatThreads(allPanels()))
      /* A group tab appearing or closing is news to every other tab's menu,
         which reads the store rather than this instance (`useDockGroups`). */
      notifyGroups()
    }
    publishOpenThreads()

    /* The strip stays. It used to hide itself when the dock held a single
       panel — chrome with nothing to choose between — but the only way to open
       a second tab was then the sidebar, from a menu on a thread you were not
       looking at. The strip is where "another tab" belongs, so it has to be
       there before there is one. */
    let saveTimer: ReturnType<typeof setTimeout> | undefined
    const disposables = [
      api.onDidAddPanel(publishOpenThreads),
      api.onDidRemovePanel(publishOpenThreads),
      /* A tab dragged into another group keeps its panel and changes its place;
         the tier follows the dock, so a move republishes too. */
      api.onDidMovePanel(publishOpenThreads),
      /* The route follows the focused chat or page, and only those: focusing
         a terminal must not navigate away from the thread it belongs to. */
      api.onDidActivePanelChange(({ panel }) => {
        if (!panel || !panel.api.isActive) return
        /* The tab you switched to is on screen. Dockview scrolls the strip
           for nothing — the one you tapped in the palette or the sidebar could
           be off the end of a narrow window, with no sign of which tab is the
           one that is now speaking. `nearest` so a tab already in view moves
           the strip by nothing. */
        panel.view.tab.element.scrollIntoView({ inline: "nearest", block: "nearest" })
        const descriptor = descriptorOf(panel)
        const path =
          descriptor?.kind === "chat"
            ? threadPath(descriptor.sessionId)
            : descriptor?.kind === "page"
              ? descriptor.path
              : null
        if (path && location.pathname + location.search !== path)
          navigateTo(path, { replace: true })
      }),
      api.onDidLayoutChange(() => {
        /* Belt and braces with the add/remove listeners above: a layout change
           is raised after the dock's own `panels` list has settled, so the tier
           is correct even if a remove event arrived mid-mutation. `setOpenThreads`
           is a no-op when nothing moved. */
        publishOpenThreads()
        clearTimeout(saveTimer)
        saveTimer = setTimeout(() => saveLayout(serverId, api.toJSON()), SAVE_DEBOUNCE_MS)
      }),
    ]

    /* A tab dragged from another instance's strip: dockview could not handle
       it, so it arrives here. Both directions are the same call — this is the
       top level's half, `attachNested` wires the nested one. */
    disposables.push(
      api.onDidDrop((event) => {
        const transfer = event.getData()
        if (transfer?.panelId) dropForeign(api, transfer.panelId, event.group ?? undefined)
      })
    )

    cleanupRef.current = () => {
      clearTimeout(saveTimer)
      disposables.forEach((disposable) => disposable.dispose())
    }
  }, [silently, allPanels, notifyGroups, dropForeign])

  /* Bound through `use-hotkey` like every other key in the app, not on a raw
     window listener as this used to be: that bypassed the defaultPrevented
     check, so a dialog or the slash menu could not out-rank it, and it lived in
     a different file from the table that prints it.

     Digits count the tabs in the group you are looking at. While the dock is
     one group — which it is until something is split — that is the same set as
     "every open thread", and once it is not, following the strip in front of
     you beats following a global order you cannot see. */
  useHotkey("mod+1 mod+2 mod+3 mod+4 mod+5 mod+6 mod+7 mod+8 mod+9", (event) => {
    const index = Number(event.key) - 1
    if (!activeStrip()?.panels[index]) return
    event.preventDefault()
    setTabIndex(index)
  })

  /* The strip's walk and its close, on the group in front of you. ⌘W is never
     the close chord — Electron gives it to close-window — which is why the
     table binds Alt+W (`lib/shortcuts.ts`). */
  useShortcut("nextTab", () => {
    cycleTab(1)
  })

  useShortcut("prevTab", () => {
    cycleTab(-1)
  })

  useShortcut("closeTab", () => {
    void closeActiveTab()
  })

  useShortcut("splitRight", () => {
    splitActive("right")
  })

  useShortcut("reopenPanel", () => {
    reopenClosed()
  })

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
      attachNested,
      groupIdOf,
      moveToGroup,
      unnestPanel,
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
      attachNested,
      groupIdOf,
      moveToGroup,
      unnestPanel,
    ]
  )
}

export type { DockviewApi }
