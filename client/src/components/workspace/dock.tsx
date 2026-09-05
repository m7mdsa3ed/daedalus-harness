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
     is the only door out — which is where a guarded panel gets to ask first. */
import * as React from "react"
import {
  DockviewReact,
  themeAbyss,
  themeLight,
  type DockviewApi,
  type IDockviewPanel,
  type IDockviewPanelProps,
} from "dockview-react"
import "dockview-react/dist/styles/dockview.css"

import { ChatPanel } from "@/components/workspace/chat-panel"
import { forgetProjectEditors } from "@/lib/ide/editors"
import { IdePanel } from "@/components/workspace/ide-panel"
import { PanelContainer } from "@/components/workspace/panel-container"
import { PanelTab } from "@/components/workspace/panel-tab"
import { TasksPanel } from "@/components/workspace/tasks-panel"
import { TerminalPanel } from "@/components/workspace/terminal-panel"
import { WebPanel } from "@/components/workspace/web-panel"
import { UnsupportedPanel } from "@/components/workspace/unsupported-panel"
import { makeTabActions } from "@/components/workspace/tab-actions"
import type { Actions } from "@/lib/actions"
import { navigateTo, threadPath } from "@/lib/router"
import { loadSettings } from "@/lib/settings"
import { notifyDockLayout } from "@/lib/workspace/panel-overlap"
import { useHotkey, useShortcut } from "@/hooks/use-hotkey"
import { KEYS } from "@/lib/shortcuts"
import { useTheme } from "@/lib/theme"
import {
  deleteSavedLayout as forgetSavedLayout,
  listSavedLayouts,
  loadLayout,
  readSavedLayout,
  saveLayout,
  saveNamedLayout,
  type SavedLayout,
} from "@/lib/workspace/layout"
import { forgetPanelPin, isPanelPinned, pinnedPanels, togglePanelPin } from "@/lib/workspace/panel-pins"
import {
  PANEL_KINDS,
  PANEL_SPECS,
  panelId,
  parsePanel,
  type PanelDescriptor,
  type PanelKind,
} from "@/lib/workspace/panels"

const SAVE_DEBOUNCE_MS = 300

/* ── The floating header, as a measurement ──
   The app header is an overlay across the top of the whole column
   (`app-shell.tsx`), so whatever is under it has to hold its own content clear
   of it. Every panel did that with a constant — `pt-[var(--app-header-h)]` —
   and so did the tab strip, which was right for the group at the top and wrong
   for every other one: a terminal docked *below* a thread reserved three rems
   for a header that is nowhere near it, twice over (the strip's margin and the
   panel's own padding), which is the band of nothing that used to sit above
   every bottom-docked terminal.

   So it is measured. This half is the **tab strip's** offset
   (`--dock-header-overlap`, read by `index.css`): how much of the group's own
   box the header covers, zero for every group that is not at the top.

   The other half — what a *panel's content* pads by — is deliberately not set
   here, even though it looks like the same sum. Panels are rendered with
   `defaultRenderer="always"`, which attaches their content to one overlay
   container at the dockview root rather than nesting it in the group, so a
   variable set on a group element reaches its strip and nothing else. Each
   panel measures its own box instead (`lib/workspace/panel-overlap.ts`); all
   this side owes it is a nudge whenever the layout moves. */
const HEADER_OVERLAP = "--dock-header-overlap"

function syncHeaderOverlap(api: DockviewApi): void {
  const header = document.querySelector<HTMLElement>("[data-app-header]")
  const bottom = header ? header.getBoundingClientRect().bottom : 0
  for (const group of api.groups) {
    const element = group.element
    /* A popped-out group is in another window, where this document's header
       covers nothing. Measuring it against a rect from a different viewport is
       how a second monitor would inherit a phone's notch. */
    const detached = element.ownerDocument !== document
    const top = element.getBoundingClientRect().top
    const overlap = detached ? 0 : Math.max(0, Math.min(bottom - top, bottom))
    element.style.setProperty(HEADER_OVERLAP, `${Math.round(overlap)}px`)
  }
  notifyDockLayout()
}
/** How many closed panels ⌘⇧T can walk back through. */
const REOPEN_DEPTH = 10

export interface OpenPanelOptions {
  /** Add beside the current panel instead of replacing it. */
  newTab?: boolean
  /**
   * Put it in a new group beside the active one. Navigation panels go left,
   * streams go below — the IDE preset's arrangement, one panel at a time.
   *
   * A **preference**, not an instruction: see `SPLIT_MIN_WIDTH`. Below that
   * width, and once a group of the same kind already exists, it degrades to a
   * tab. Callers say where a panel *belongs* and the dock decides whether the
   * window can afford it — which is the only way the + menu, the chords and
   * every transcript link can share one answer.
   */
  direction?: "left" | "right" | "above" | "below"
  /** Open it without taking focus. */
  background?: boolean
}

/**
 * Narrower than this and a split is two useless columns, so a panel that asked
 * to open *beside* something opens as a **tab** instead.
 *
 * The window, deliberately, and not the panel's own container: what is being
 * decided here is whether the dock can be cut in two, which is a question about
 * the screen. (The rule the rest of the app follows — width is the panel's, the
 * pointer is the device's — is about laying out *inside* a panel; this is the
 * one place where the window genuinely is the subject.) Read at click time
 * rather than subscribed to: a layout the user is looking at must not rearrange
 * itself because a phone was turned sideways.
 *
 * The same 768px as `useIsMobile`, so "phone" means one thing in this app.
 */
const SPLIT_MIN_WIDTH = 768

export type PresetId = "ide" | "focus"

/** Asked before a panel closes. `false` cancels the close. */
export type CloseGuard = () => boolean | Promise<boolean>

export interface WorkspaceDock {
  openPanel: (panel: PanelDescriptor, options?: OpenPanelOptions) => void
  openChat: (sessionId: string, options?: OpenPanelOptions) => void
  closePanel: (id: string) => Promise<void>
  closeOthers: (id: string) => Promise<void>
  closeToTheRight: (id: string) => Promise<void>
  closeGroup: (id: string) => Promise<void>
  splitActive: (direction: "right" | "below") => void
  toggleMaximize: () => void
  stackAll: () => void
  resetLayout: () => void
  reopenClosed: () => void
  applyPreset: (preset: PresetId) => void
  /** Move a panel into a window of its own. Resolves false when the browser
      refused the window — a popup blocker, or a runtime with no `window.open`. */
  popoutPanel: (id?: string) => Promise<boolean>
  /** Move a panel into a floating group over the dock, or back into the grid
      if it is already floating. */
  toggleFloat: (id?: string) => void
  /** Keep a tab: it goes to the front of its group, loses its close button and
      is stepped over by every bulk close. */
  togglePin: (id: string) => void
  isPinned: (id: string) => boolean
  /** Keep the dock as it stands, contents and all, under a name. Unlike a
      preset, applying one opens and closes panels — see `lib/workspace/layout`. */
  saveLayoutAs: (name: string) => SavedLayout | null
  applySavedLayout: (id: string) => void
  deleteSavedLayout: (id: string) => void
  savedLayouts: () => SavedLayout[]
  /** A panel's veto on its own closing — live terminals. The IDE keeps its
      own dirty buffers across a close, so it never vetoes one. */
  registerCloseGuard: (id: string, guard: CloseGuard) => () => void
  /** Descriptors currently open, in tab order, for menus and the palette. */
  listPanels: () => { id: string; panel: PanelDescriptor; title: string }[]
  isPanelOpen: (id: string) => boolean
  hasClosedPanels: () => boolean
}

const DockContext = React.createContext<WorkspaceDock | null>(null)

export function useDock(): WorkspaceDock {
  const dock = React.useContext(DockContext)
  if (!dock) throw new Error("useDock outside the workspace dock")
  return dock
}

/** The descriptor a live Dockview panel was opened with, or null. */
export function descriptorOf(panel: IDockviewPanel): PanelDescriptor | null {
  return parsePanel(panel.api.component, panel.params)
}

const isChat = (panel: IDockviewPanel) => panel.api.component === "chat"

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

  const openPanel = React.useCallback(
    (panel: PanelDescriptor, options?: OpenPanelOptions) => {
      const api = apiRef.current
      if (!api) return
      if (!PANEL_SPECS[panel.kind].implemented) return

      const id = panelId(panel)
      const existing = api.getPanel(id)
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
        if (!options?.background) existing.api.setActive()
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

      /* The side preference, resolved against what the window and the dock can
         actually do — the one place it is decided, so every caller gets the
         same answer.

         It is dropped in two cases. On a **phone**, where a split is two
         columns of nothing: the panel opens as a tab in the group you are in,
         which is what "beside the thread" means on a screen that can only show
         one thing at a time. And when a group of that kind is **already open**,
         because a second panel asking to open on the right would split the
         dock a second time — the first one established where that kind lives,
         and the second belongs in it. */
      const roomToSplit = window.innerWidth >= SPLIT_MIN_WIDTH && siblings.length === 0
      const direction = options?.direction && roomToSplit ? options.direction : undefined
      /* A panel that wanted its own side and cannot have one must still not
         REPLACE what is in front of it — it was never asking to navigate. */
      const newTab = options?.newTab || (!!options?.direction && !direction)

      /* Replace-in-place is what makes clicking through the sidebar feel like
         navigation rather than tab-hoarding: the panel you came from goes away
         unless you asked for a new tab. Only same-kind panels are replaced. */
      const replace = !!current && current.api.component === panel.kind && !newTab && !direction
      const index = replace && group ? group.panels.indexOf(current) + 1 : undefined

      api.addPanel({
        id,
        component: panel.kind,
        title: PANEL_SPECS[panel.kind].defaultTitle,
        params: panel as unknown as Record<string, unknown>,
        inactive: options?.background,
        position: (() => {
          const reference = group?.id ?? api.activeGroup?.id
          if (direction)
            return reference ? { referenceGroup: reference, direction } : undefined
          return group ? { referenceGroup: group.id, direction: "within" as const, index } : undefined
        })(),
      })

      if (replace && current) silently(() => api.removePanel(current))
    },
    [silently]
  )

  const openChat = React.useCallback(
    (sessionId: string, options?: OpenPanelOptions) => openPanel({ kind: "chat", sessionId }, options),
    [openPanel]
  )

  /* The last chat cannot be closed: the route always points at a thread, and a
     dock with no chat in it would re-open one on the next render anyway. Every
     other kind is always closable. */
  const isClosable = React.useCallback((panel: IDockviewPanel): boolean => {
    const api = apiRef.current
    if (!api) return false
    return !isChat(panel) || api.panels.filter(isChat).length > 1
  }, [])

  const removeWithGuard = React.useCallback(async (panel: IDockviewPanel): Promise<boolean> => {
    const api = apiRef.current
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
  }, [])

  const closePanel = React.useCallback(
    async (id: string) => {
      const api = apiRef.current
      const panel = api?.getPanel(id)
      if (!panel || !isClosable(panel)) return
      await removeWithGuard(panel)
    },
    [isClosable, removeWithGuard]
  )

  /** Panels sharing a group with `id`, in tab order. Recomputed per call — a
      snapshot taken at render could close the wrong tabs after a drag. */
  const groupPanels = React.useCallback((id: string): IDockviewPanel[] => {
    const panel = apiRef.current?.getPanel(id)
    return panel ? [...panel.group.panels] : []
  }, [])

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
    (preset: PresetId) => {
      const api = apiRef.current
      if (!api) return
      const active = api.activeGroup?.activePanel
      if (api.hasMaximizedGroup()) api.exitMaximizedGroup()

      if (preset === "focus") {
        stackAll()
        if (active) api.maximizeGroup(active)
        return
      }

      /* IDE: work centre, streams below. A kind with nothing open contributes
         no group, so a dock holding only threads is one centre group, which is
         exactly right. */
      const BOTTOM: PanelKind[] = ["terminal"]
      const bucket = (panel: IDockviewPanel) =>
        BOTTOM.includes(panel.api.component as PanelKind) ? "bottom" : "centre"
      silently(() => {
        stackAll()
        const centre = api.activeGroup ?? api.groups[0]
        if (!centre) return
        let bottom: ReturnType<DockviewApi["addGroup"]> | undefined
        for (const panel of [...api.panels]) {
          if (bucket(panel) === "centre") continue
          bottom ??= api.addGroup({ referenceGroup: centre, direction: "below" })
          panel.api.moveTo({ group: bottom })
        }
      })
      active?.api.setActive()
    },
    [silently, stackAll]
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
    const api = apiRef.current
    if (!api) return []
    return api.panels.flatMap((panel) => {
      const descriptor = descriptorOf(panel)
      return descriptor
        ? [{ id: panel.id, panel: descriptor, title: panel.title ?? PANEL_SPECS[descriptor.kind].defaultTitle }]
        : []
    })
  }, [])

  const isPanelOpen = React.useCallback((id: string) => !!apiRef.current?.getPanel(id), [])
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
        for (const panel of [...api.panels]) {
          const descriptor = descriptorOf(panel)
          if (!descriptor) {
            api.removePanel(panel)
            continue
          }
          const gone =
            descriptor.kind === "chat"
              ? !sessions.has(descriptor.sessionId)
              : /* Boards belong to the server, not to a project, so nothing in
                   a prune of sessions and projects can say a tasks panel is
                   stale — a deleted board resolves to another one from inside
                   the panel (`lib/tasks-location.ts`). */
                descriptor.kind === "tasks"
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
             panel that happens to reuse the id. An IDE panel takes its open
             tabs too: they outlive the panel on purpose (`lib/ide/editors.ts`),
             which for a project that no longer exists would be a set of tabs
             pointing at a directory the server will not read. */
          if (gone) {
            guardsRef.current.delete(panel.id)
            forgetPanelPin(panel.id)
            if (descriptor.kind === "ide") forgetProjectEditors(descriptor.projectId)
            api.removePanel(panel)
          }
        }
      })
    },
    [silently]
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

    /* The strip stays. It used to hide itself when the dock held a single
       panel — chrome with nothing to choose between — but the only way to open
       a second tab was then the sidebar, from a menu on a thread you were not
       looking at. The strip is where "another tab" belongs, so it has to be
       there before there is one. */
    let saveTimer: ReturnType<typeof setTimeout> | undefined
    const disposables = [
      /* The route follows the focused chat, and only a chat: focusing a
         terminal must not navigate away from the thread it belongs to. */
      api.onDidActivePanelChange(({ panel }) => {
        if (!panel || !panel.api.isActive || !isChat(panel)) return
        const descriptor = descriptorOf(panel)
        if (descriptor?.kind !== "chat") return
        if (location.pathname !== threadPath(descriptor.sessionId))
          navigateTo(threadPath(descriptor.sessionId), { replace: true })
      }),
      api.onDidLayoutChange(() => {
        clearTimeout(saveTimer)
        saveTimer = setTimeout(() => saveLayout(serverId, api.toJSON()), SAVE_DEBOUNCE_MS)
      }),
    ]

    cleanupRef.current = () => {
      clearTimeout(saveTimer)
      disposables.forEach((disposable) => disposable.dispose())
    }
  }, [silently])

  /* Bound through `use-hotkey` like every other key in the app, not on a raw
     window listener as this used to be: that bypassed the defaultPrevented
     check, so a dialog or the slash menu could not out-rank it, and it lived in
     a different file from the table that prints it.

     Digits count the tabs in the group you are looking at. While the dock is
     one group — which it is until something is split — that is the same set as
     "every open thread", and once it is not, following the strip in front of
     you beats following a global order you cannot see. */
  useHotkey("mod+1 mod+2 mod+3 mod+4 mod+5 mod+6 mod+7 mod+8 mod+9", (event) => {
    const api = apiRef.current
    const group = api?.activeGroup ?? api?.groups[0]
    const panel = group?.panels[Number(event.key) - 1]
    if (!panel) return
    event.preventDefault()
    panel.api.setActive()
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
      closePanel,
      closeOthers,
      closeToTheRight,
      closeGroup,
      splitActive,
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
      prunePanels,
    }),
    [
      onReady,
      openPanel,
      openChat,
      closePanel,
      closeOthers,
      closeToTheRight,
      closeGroup,
      splitActive,
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
      prunePanels,
    ]
  )
}

export type { DockviewApi }

export function WorkspaceDock({
  actions,
  dock,
  onReady,
}: {
  actions: Actions
  dock: WorkspaceDock
  onReady: (api: DockviewApi) => void
}) {
  const { resolved } = useTheme()
  const theme = React.useMemo(() => (resolved === "dark" ? themeAbyss : themeLight), [resolved])

  /* Every kind gets an entry, including the ones this build has not written
     yet: Dockview throws on an unknown component name, so a layout saved by a
     newer build would take the whole dock down instead of showing one panel it
     cannot draw.

     Every one of them is wrapped, in this one place, in `PanelContainer` — a
     panel's contents are laid out against the panel, and the wrap is the only
     thing that makes that true (see the file for which half of "mobile" it
     answers and which half stays the window's). */
  const components = React.useMemo(() => {
    const map: Record<string, React.FC<IDockviewPanelProps>> = {}
    const contained =
      (Panel: React.FC<IDockviewPanelProps>): React.FC<IDockviewPanelProps> =>
      (props) => (
        <PanelContainer>
          <Panel {...props} />
        </PanelContainer>
      )
    for (const kind of PANEL_KINDS) map[kind] = contained(UnsupportedPanel)
    map.chat = contained((props) => (
      <ChatPanel {...(props as IDockviewPanelProps<{ sessionId: string }>)} actions={actions} />
    ))
    map.ide = contained(IdePanel as React.FC<IDockviewPanelProps>)
    map.terminal = contained(TerminalPanel as React.FC<IDockviewPanelProps>)
    map.tasks = contained(TasksPanel as React.FC<IDockviewPanelProps>)
    /* The preview mode hands errors and picked elements to a thread, which
       is a send — so the web panel takes `actions` the way the chat does. */
    map.web = contained((props) => (
      <WebPanel {...(props as React.ComponentProps<typeof WebPanel>)} actions={actions} />
    ))
    return map
  }, [actions])

  const tabActions = React.useMemo(
    () => makeTabActions({ onSplit: () => dock.splitActive("right") }),
    [dock]
  )

  /* One panel in the whole dock: the entire strip goes, not just the tab chip.

     It used to stay because the + lived in it, and hiding the row left that
     with nowhere to be. The + is in the app header now, and split hides itself
     when there is nothing to split — so at one panel the row has no contents at
     all, and an empty 36px band above every thread is worse than no band. */
  const handleReady = React.useCallback(
    (api: DockviewApi) => {
      /* Measured after the frame that changed the layout: a group's box is not
         its new one until the browser has laid it out, and a rect read inside
         the event that moved it is the rect it is leaving. Coalesced, because a
         sash drag fires a layout change per pointer frame. */
      let overlapFrame: number | undefined
      const syncOverlap = () => {
        if (overlapFrame !== undefined) cancelAnimationFrame(overlapFrame)
        overlapFrame = requestAnimationFrame(() => {
          overlapFrame = undefined
          syncHeaderOverlap(api)
        })
      }
      const sync = () => {
        const single = api.groups.length === 1 && api.panels.length === 1
        for (const group of api.groups) {
          if (group.header.hidden !== single) group.header.hidden = single
        }
        /* After the strip's own visibility, never before: what a panel has to
           pad by depends on whether there is a strip above it. */
        syncOverlap()
      }
      const disposables = [
        api.onDidAddPanel(sync),
        api.onDidRemovePanel(sync),
        api.onDidAddGroup(sync),
        api.onDidRemoveGroup(sync),
        /* Dragging a tab into another group has to be listened for separately,
           and it is the case that gets this wrong in both directions. Dockview
           runs a move under a lock that suppresses the panel add/remove events
           — but it removes the emptied source group *outside* that lock, at the
           one instant when the panel has left its old group and not yet joined
           its new one. So the counts read one group and one panel, `single` is
           true, and the surviving group's header is hidden; the re-add is back
           under the lock, so nothing fires again to take it back. `onDidMovePanel`
           is raised once the move has settled, which is the only point where the
           counts describe the dock the user is actually looking at. */
        api.onDidMovePanel(sync),
        /* Every other way a group's top can move: a sash drag, a maximize, a
           float, the window itself. The strip's visibility has not changed in
           any of them, so this is the overlap alone. */
        api.onDidLayoutChange(syncOverlap),
      ]
      window.addEventListener("resize", syncOverlap)
      queueMicrotask(sync)
      onReady(api)
      /* Dockview does not tell us when it tears the component down, and
         `onReady` runs again on a theme remount — the dock's own cleanup path
         disposes its listeners the same way. */
      return () => {
        if (overlapFrame !== undefined) cancelAnimationFrame(overlapFrame)
        window.removeEventListener("resize", syncOverlap)
        disposables.forEach((disposable) => disposable.dispose())
      }
    },
    [onReady]
  )

  return (
    <DockContext.Provider value={dock}>
      <DockviewReact
        className="session-dock h-full min-h-0 flex-1"
        components={components}
        defaultRenderer="always"
        defaultTabComponent={PanelTab}
        /* Floating groups are on: a panel over the dock, and — through
           `popoutPanel` — one in a window of its own. `floatingGroupBounds`
           keeps a float from being dragged off-screen, which on a laptop is a
           panel the user cannot get back without clearing the layout. */
        floatingGroupBounds="boundedWithinViewport"
        onReady={(event) => handleReady(event.api)}
        rightHeaderActionsComponent={tabActions}
        theme={theme}
      />
    </DockContext.Provider>
  )
}
