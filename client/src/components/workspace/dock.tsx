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
import { forgetScmFilter } from "@/lib/ide/scm-filter"
import { PanelContainer } from "@/components/workspace/panel-container"
import { PanelTab } from "@/components/workspace/panel-tab"
import { PagePanel } from "@/components/workspace/page-panel"
import { WebPanel } from "@/components/workspace/web-panel"
import { UnsupportedPanel } from "@/components/workspace/unsupported-panel"
import { TabActions } from "@/components/workspace/tab-actions"

/* The three panels that carry a library the rest of the app does not: Monaco
   (the IDE), xterm (the terminal) and the whole board (the tasks tree). The
   chat is not one of them — it is what the dock opens with, so lazy loading it
   would only put a suspense boundary in front of the first paint.

   They are the kind of thing dockview's own `defaultRenderer="always"` keeps
   mounted once opened, so the chunk is fetched once per session at most, when
   the reader opens the panel. Anything else importing these modules statically
   puts them back in the entry chunk — Rollup calls it INEFFECTIVE_DYNAMIC_IMPORT
   and says so in the build output, which is the check on this. */
const IdePanel = React.lazy(async () => ({
  default: (await import("@/components/workspace/ide-panel")).IdePanel as React.FC<IDockviewPanelProps>,
}))
const TerminalPanel = React.lazy(async () => ({
  default: (await import("@/components/workspace/terminal-panel"))
    .TerminalPanel as React.FC<IDockviewPanelProps>,
}))
const TasksPanel = React.lazy(async () => ({
  default: (await import("@/components/workspace/tasks-panel"))
    .TasksPanel as React.FC<IDockviewPanelProps>,
}))
/* The group panel is lazy for a second reason on top of the chunk: it imports
   `DockSurface` from *this* file, so a static import would be a module cycle
   evaluated at load. A dynamic one is resolved when a group is first drawn, by
   which time this module is whole. */
const GroupPanel = React.lazy(async () => ({
  default: (await import("@/components/workspace/group-panel")).GroupPanel as React.FC<IDockviewPanelProps>,
}))
import type { Actions } from "@/lib/actions"
import { navigateTo, threadPath } from "@/lib/router"
import { loadSettings } from "@/lib/settings"
import { notifyDockLayout } from "@/lib/workspace/panel-overlap"
import { useHotkey, useShortcut } from "@/hooks/use-hotkey"
import { MOBILE_BREAKPOINT, useIsMobile } from "@/hooks/use-device"
import { KEYS } from "@/lib/shortcuts"
import { useTheme } from "@/lib/theme"
import { cn } from "@/lib/utils"
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
import { setOpenThreads } from "@/lib/workspace/open-threads"
import {
  PANEL_KINDS,
  PANEL_SPECS,
  panelId,
  parsePanel,
  pageKey,
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

   So it is measured, and this is the **tab strip's** half of it. A group the
   header covers does not clear it — it stands *in its row* (`data-header-band`,
   `index.css`), which is what makes the two bars one: the app's controls and
   this group's tabs on the same line. The overlap is then the safe-area inset
   alone, so the tabs sit below the notch rather than behind it. A group the
   header does not reach clears nothing and keeps its own 36px strip.

   Standing in the row costs the strip the width of whatever header control is
   above it, and that is per group for exactly the reason the vertical overlap
   is: with three columns split across the top, the toggle is above the first
   and the bell above the last, and a constant would have the middle one
   reserving room for both. So both ends are measured too — the intersection of
   this group's box with each cluster — and a group left too narrow to show a
   tab ducks back under the header instead.

   The other half — what a *panel's content* pads by — is deliberately not set
   here, even though it looks like the same sum. Panels are rendered with
   `defaultRenderer="always"`, which attaches their content to one overlay
   container at the dockview root rather than nesting it in the group, so a
   variable set on a group element reaches its strip and nothing else. Each
   panel measures its own box instead (`lib/workspace/panel-overlap.ts`); all
   this side owes it is a nudge whenever the layout moves. */
const HEADER_OVERLAP = "--dock-header-overlap"
const BAND_LEFT = "--dock-band-left"
const BAND_RIGHT = "--dock-band-right"

/**
 * Strip left over for tabs, below which a group does not join the header's band
 * at all and takes its own row under it instead.
 *
 * The same judgement a split threshold made: a column too narrow to share the
 * row shows a 40px sliver of one tab between two of the app's controls, which
 * reads as broken. One group out of step reads as deliberate.
 */
const BAND_MIN_TABS = 120

function syncHeaderOverlap(api: DockviewApi): void {
  const header = document.querySelector<HTMLElement>("[data-app-header]")
  const band = header?.getBoundingClientRect()
  const bandBottom = band?.bottom ?? 0
  /* ── The band is the header's *content box* ──
     Not its border box, on any axis. The header's padding is where it already
     states what the window has claimed: the safe-area inset on top (a strip
     level with the notch is a strip behind it), and on the right the caption
     buttons — 148px under Electron on Windows and Linux, `titlebar-area-*`
     under the PWA's window-controls overlay (both in `index.css`, on
     `[data-drag-region]`, which this header is).
     Reading the padding rather than naming those numbers again is the whole
     point: the strip stands where the header's own occupants stand, so
     anything the header learns to make room for, the tabs make room for too.
     It is also the only thing left holding the right end, now that every
     control has moved to the sidebar and there is no `[data-header-right]`. */
  const style = header ? getComputedStyle(header) : undefined
  const pad = (side: "Top" | "Left" | "Right") =>
    style ? parseFloat(style[`padding${side}`] || "0") || 0 : 0
  const rowTop = band ? band.top + pad("Top") : 0
  const contentLeft = band ? band.left + pad("Left") : 0
  const contentRight = band ? band.right - pad("Right") : 0
  const cluster = (selector: string) =>
    header?.querySelector<HTMLElement>(selector)?.getBoundingClientRect()
  /* A cluster narrows the content box further; without one the box itself is
     the bound. `[data-header-left]` is the toggle and the sliders — the whole
     of what the header holds now that every route's title is on its tab. */
  const leftBound = Math.max(contentLeft, cluster("[data-header-left]")?.right ?? contentLeft)
  const rightBound = Math.min(contentRight, cluster("[data-header-right]")?.left ?? contentRight)

  for (const group of api.groups) {
    const element = group.element
    /* A popped-out group is in another window, where this document's header
       covers nothing. Measuring it against a rect from a different viewport is
       how a second monitor would inherit a phone's notch. */
    const detached = element.ownerDocument !== document
    const rect = element.getBoundingClientRect()
    const covered = !detached && bandBottom > rect.top
    /* What reaches *into* this group, never the bound's own width: a column the
       header's claim does not overlap owes it nothing. */
    const reach = (overlap: number) => Math.max(0, Math.min(overlap, rect.width))
    const padLeft = covered ? reach(leftBound - rect.left) : 0
    const padRight = covered ? reach(rect.right - rightBound) : 0
    const banded = covered && rect.width - padLeft - padRight >= BAND_MIN_TABS

    element.toggleAttribute("data-header-band", banded)
    element.style.setProperty(BAND_LEFT, `${Math.round(banded ? padLeft : 0)}px`)
    element.style.setProperty(BAND_RIGHT, `${Math.round(banded ? padRight : 0)}px`)
    element.style.setProperty(
      HEADER_OVERLAP,
      `${Math.round(
        banded
          ? Math.max(0, rowTop - rect.top)
          : covered
            ? Math.max(0, Math.min(bandBottom - rect.top, bandBottom))
            : 0
      )}px`
    )
  }
  notifyDockLayout()
}
/** How many closed panels ⌘⇧T can walk back through. */
const REOPEN_DEPTH = 10

export interface OpenPanelOptions {
  /** Add beside the current panel instead of replacing it. */
  newTab?: boolean
  /**
   * Where the caller thinks this panel *belongs* — navigation left, streams
   * below, the IDE preset's arrangement one panel at a time.
   *
   * **It no longer splits the dock, and reads as `newTab`.** Every panel opens
   * the way a new thread does: a tab beside what you are looking at. Opening a
   * terminal used to cut the dock in half under the transcript and opening the
   * IDE cut it in half beside it, so the answer to "open something" depended on
   * which something — and a layout the reader had arranged rearranged itself
   * under them. Splitting is still available and is now only ever *asked for*:
   * `splitActive` (the strip's chord and the palette's row), which names the
   * panel it moves.
   *
   * Kept as an option rather than deleted from a dozen call sites because it is
   * the one thing those callers know that the dock does not — if a preset or a
   * "restore this layout" ever wants to honour it again, it is still said. It
   * was always documented as a *preference*, not an instruction; this is the
   * dock exercising that.
   */
  direction?: "left" | "right" | "above" | "below"
  /** Open it without taking focus. */
  background?: boolean
}

export type PresetId = "ide" | "focus"

/** Asked before a panel closes. `false` cancels the close. */
export type CloseGuard = () => boolean | Promise<boolean>

export interface WorkspaceDock {
  openPanel: (panel: PanelDescriptor, options?: OpenPanelOptions) => void
  openChat: (sessionId: string, options?: OpenPanelOptions) => void
  /** Show a route in the app's browsing tab — see `openPage` for the rule. */
  openPage: (path: string) => void
  /** Spend the landing console's tab: the thread started from it takes its
      place rather than standing beside a "New thread" tab that has nothing
      left to do. A no-op unless the console is the active, unpinned tab. */
  consumeConsole: () => void
  closePanel: (id: string) => Promise<void>
  closeOthers: (id: string) => Promise<void>
  closeToTheRight: (id: string) => Promise<void>
  closeGroup: (id: string) => Promise<void>
  splitActive: (direction: "right" | "below") => void
  /** Lands the next panel opened in `api` rather than the outer dock — a nested
      strip's +. A group panel's *id* aims at that group whether or not its
      instance has mounted yet, which is what lets a tab group itself with the
      panel it is about to open. */
  targetNext: (api: DockviewApi | string) => void
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
  /** The descriptor of the panel in front of you — a nested group's own when a
      group tab is active. The route only follows chats and pages, so this is
      the one thing that can answer "which project am I looking at" while a
      terminal or an IDE has the focus. */
  activeDescriptor: () => PanelDescriptor | undefined

  /* ── The strip you are looking at ──
     All three act on the *active* instance — the nested dock when a group tab
     is in front, the top level otherwise — because following the strip in
     front of you beats following a global order the reader cannot see. */
  /** Jump to the nth tab (0-based) of the group in front of you. */
  setTabIndex: (index: number) => void
  /** Walk that group's tabs, wrapping at both ends. */
  cycleTab: (delta: number) => void
  /** Close the tab in front of you, through the same guarded door its ✕ uses. */
  closeActiveTab: () => Promise<void>

  /* ── A dock inside a tab ──
     One level, never a tree (`group-panel.tsx`). */
  /** Register a nested instance against its group panel; returns its detach. */
  attachNested: (groupPanelId: string, api: DockviewApi) => () => void
  /** The group panel a tab's own instance stands in, or undefined at the top
      level — which is what tells a tab menu whether it has a way out. */
  groupIdOf: (api: DockviewApi) => string | undefined
  /** Move a panel into a group — an existing one, or `null` for a new one.
      Answers the group panel's id, so a caller can aim the next open at it. */
  moveToGroup: (id: string, groupPanelId: string | null) => string | null
  /** Move a panel out of its group, back beside the group's own tab. */
  unnestPanel: (id: string) => void
}

/* ── The groups that are open, as a store ──
   A tab in one group cannot hear another group appear — they are separate
   dockview instances and separate React trees — so "Move to group ▸" reads a
   version-bumped module store rather than a walk it would have to re-run on
   every render. Bumped from the dock's own layout listeners.

   The snapshot is replaced only when it *differs*, because `useSyncExternalStore`
   compares by identity: a fresh array per layout change would re-render every
   tab in the app on every sash drag. */
export interface DockGroupRow {
  id: string
  title: string
  /** What it holds, for a menu row that would otherwise be three identical
      "Group" lines. */
  hint: string
}

let groupRows: DockGroupRow[] = []
const groupSubscribers = new Set<() => void>()

function setDockGroups(rows: DockGroupRow[]): void {
  if (
    rows.length === groupRows.length &&
    rows.every((row, index) => {
      const previous = groupRows[index]
      return previous.id === row.id && previous.title === row.title && previous.hint === row.hint
    })
  )
    return
  groupRows = rows
  for (const notify of groupSubscribers) notify()
}

export function useDockGroups(): DockGroupRow[] {
  return React.useSyncExternalStore(
    React.useCallback((notify: () => void) => {
      groupSubscribers.add(notify)
      return () => groupSubscribers.delete(notify)
    }, []),
    () => groupRows,
    () => groupRows
  )
}

const DockContext = React.createContext<WorkspaceDock | null>(null)

export function useDock(): WorkspaceDock {
  const dock = React.useContext(DockContext)
  if (!dock) throw new Error("useDock outside the workspace dock")
  return dock
}

/* ── What the strip's + can open ──
   Dockview renders the tab strip from components it is handed by name, so
   `TabActions` sits inside this tree with nothing but its own group's props.
   The two things a + opens — a thread, a panel — are decided in `app-shell`
   (which project a panel belongs to is the routed thread's, and toggling rather
   than stacking is the same rule the chords follow), so they come down as a
   context rather than being written a second time here.

   Deliberately the *callbacks* and not the dock: every surface that opens a
   panel — the header menu, the chords, the palette, this + — calls the one
   `openWorkspacePanel`, which is what keeps them from disagreeing about which
   side a panel docks on. */
export interface DockOpeners {
  onNewTab?: () => void
  onOpenPanel?: (kind: PanelKind) => void
}

const DockOpenersContext = React.createContext<DockOpeners>({})

export function useDockOpeners(): DockOpeners {
  return React.useContext(DockOpenersContext)
}

/** The descriptor a live Dockview panel was opened with, or null. */
export function descriptorOf(panel: IDockviewPanel): PanelDescriptor | null {
  return parsePanel(panel.api.component, panel.params)
}

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
             panel that happens to reuse the id. An IDE panel takes its open
             tabs too: they outlive the panel on purpose (`lib/ide/editors.ts`),
             which for a project that no longer exists would be a set of tabs
             pointing at a directory the server will not read. */
          if (gone) {
            guardsRef.current.delete(panel.id)
            forgetPanelPin(panel.id)
            if (descriptor.kind === "ide") {
              forgetProjectEditors(descriptor.projectId)
              forgetScmFilter(descriptor.projectId)
            }
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

/* The component map, as a context: a nested dock is rendered from inside a
   panel and cannot be handed props by the outer one, and it must draw the same
   panels — a tab in a group is the same object it was outside one. Built once
   in `WorkspaceDock` (it closes over `actions`) and read here. */
const DockComponentsContext = React.createContext<Record<string, React.FC<IDockviewPanelProps>>>({})

/**
 * One dockview surface — the same components, the same tab, the same strip, at
 * either level (`group-panel.tsx`). Everything that differs between the two is
 * CSS on the class the caller passes (`.dock-nested`, `index.css`).
 */
export function DockSurface({
  className,
  onReady,
}: {
  className?: string
  onReady: (api: DockviewApi) => void
}) {
  const { resolved } = useTheme()
  const components = React.useContext(DockComponentsContext)
  /* ── Reordering a tab is a reorder, not a target picker ──
     Dockview's default is a half-width fill over every tab — a row of slabs
     the size of half a tab, which is what "multiple spots, wrong size" was.
     `smooth` is its own Chrome-style reorder: the dragged tab collapses out of
     the strip, the rest slide apart to open the gap where it would land, and
     they FLIP to their final positions on drop. `line` turns the remaining
     drop overlay into the 1px insertion rule at the tab edge that a strip
     doing its own sliding wants (index.css keeps that variant's border and
     drops the fill). Both are the installed dockview's, not ours — the CSS
     side of it is two declarations there. */
  const theme = React.useMemo(
    () => ({
      ...(resolved === "dark" ? themeAbyss : themeLight),
      tabAnimation: "smooth" as const,
      dndTabIndicator: "line" as const,
    }),
    [resolved]
  )

  return (
    <DockviewReact
      className={cn("session-dock h-full min-h-0 flex-1", className)}
      components={components}
      defaultRenderer="always"
      defaultTabComponent={PanelTab}
      /* Floating groups are on: a panel over the dock, and — through
         `popoutPanel` — one in a window of its own. `floatingGroupBounds`
         keeps a float from being dragged off-screen, which on a laptop is a
         panel the user cannot get back without clearing the layout. */
      floatingGroupBounds="boundedWithinViewport"
      onReady={(event) => onReady(event.api)}
      /* Dockview draws its own overflow chevron once the tabs stop fitting,
         and `TabActions` already draws one at the same end of the same strip
         — two dropdowns side by side, answering the same question. Ours is
         the one that stays: it lists every tab rather than only the hidden
         ones, says what each is doing (`panel-status`) and closes one without
         bringing it back into the strip first. */
      disableTabsOverflowList
      /* No `singleTabMode`: a browser tab is the width of a tab whether it is
         alone or one of nine (`index.css` gives it the same 15rem ceiling and
         lets it shrink), and the strip beside it is the run of emptiness the
         window is dragged by. A lone tab stretched to the whole band used to
         be how that emptiness stayed pressable — it is the void container's
         again now, which is what it is for. */
      rightHeaderActionsComponent={TabActions}
      theme={theme}
    />
  )
}

export function WorkspaceDock({
  actions,
  dock,
  onReady,
  onNewTab,
  onOpenPanel,
}: DockOpeners & {
  actions: Actions
  dock: WorkspaceDock
  onReady: (api: DockviewApi) => void
}) {
  /* ── One group on a phone ──
     Two panels side by side in 390px is two panels nobody can read, so below
     `md` the dock is one stack of tabs: every group folds into the active one
     when the window narrows, and any group that appears while it is narrow —
     a restored layout, a tab dragged to an edge, the split chord — folds the
     same way (`onDidAddGroup` below). A width, not a pointer: a tablet in
     landscape can hold a split. Nothing is remembered for the way back; the
     layout the wide window had is whatever the stack is by then. */
  const isMobile = useIsMobile()
  React.useEffect(() => {
    if (isMobile) dock.stackAll()
  }, [isMobile, dock])

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
    /* The Suspense is here for the same reason the container is: three of the
       panels are lazy chunks (see the top of this file), and a boundary per
       panel is a boundary that cannot be forgotten when a fourth is added.
       The fallback is empty on purpose — the panel is already framed by its
       tab and its container, so a spinner inside it is a second thing moving
       in a box that just appeared. */
    const contained =
      (Panel: React.FC<IDockviewPanelProps>): React.FC<IDockviewPanelProps> =>
      (props) => (
        <PanelContainer>
          <React.Suspense fallback={null}>
            <Panel {...props} />
          </React.Suspense>
        </PanelContainer>
      )
    for (const kind of PANEL_KINDS) map[kind] = contained(UnsupportedPanel)
    map.chat = contained((props) => (
      <ChatPanel {...(props as IDockviewPanelProps<{ sessionId: string }>)} actions={actions} />
    ))
    map.ide = contained(IdePanel)
    map.terminal = contained(TerminalPanel)
    map.tasks = contained(TasksPanel)
    map.web = contained(WebPanel as React.FC<IDockviewPanelProps>)
    map.page = contained(PagePanel as React.FC<IDockviewPanelProps>)
    map.group = contained(GroupPanel)
    return map
  }, [actions])

  /* The strip is always shown, because it now says what the panel *is*.

     A single-panel dock used to hide it: the app header said the thread's name
     above it, so the row held nothing but an empty 36px band. In the header's
     own band the tab **is** that name — icon, title and status — so there is no
     count at which hiding it is right.

     A loop rather than a deletion, and it stays wired to the group events:
     dockview serializes a hidden header (`hideHeader` in its `toJSON`), so
     every layout saved by the build that hid it would restore headerless, with
     nothing left in this build to turn it back on. It costs one comparison per
     group and un-stalls those layouts the first time they are read. */
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
        for (const group of api.groups) {
          if (group.header.hidden) group.header.hidden = false
        }
        /* After the strip's own visibility, never before: what a panel has to
           pad by depends on whether there is a strip above it. */
        syncOverlap()
      }
      const disposables = [
        api.onDidAddPanel(sync),
        api.onDidRemovePanel(sync),
        /* Closing the last tab lands on the landing console rather than on an
           empty dock. A microtask later, because `fromJSON` empties the dock
           on its way to refilling it — a reload at `/t/x` clears, then adds,
           and a navigation fired between the two would take the URL away from
           the thread being restored. By the microtask the restore is done. */
        api.onDidRemovePanel(() => {
          queueMicrotask(() => {
            if (api.panels.length === 0 && location.pathname !== "/") navigateTo("/")
          })
        }),
        api.onDidAddGroup(sync),
        api.onDidAddGroup(() => {
          if (window.innerWidth < MOBILE_BREAKPOINT && api.groups.length > 1)
            queueMicrotask(dock.stackAll)
        }),
        api.onDidRemoveGroup(sync),
        /* Dragging a tab into another group has to be listened for separately:
           dockview runs a move under a lock that suppresses the panel
           add/remove events, so nothing above fires for it. It is raised once
           the move has settled, which is also the only point at which the
           groups have the boxes the user is looking at — a move that empties a
           column widens every other one, and with it what each owes the
           header's clusters. */
        api.onDidMovePanel(sync),
        /* Every other way a group's top can move: a sash drag, a maximize, a
           float, the window itself. The strip's visibility has not changed in
           any of them, so this is the overlap alone. */
        api.onDidLayoutChange(syncOverlap),
      ]
      window.addEventListener("resize", syncOverlap)
      /* The header is the other half of the measurement and it moves on its
         own: its left cluster is a 128px skeleton while the app is loading and
         nothing while a thread is routed, and the dock's layout does not change
         when that resolves. Without this the band keeps the reservation it was
         first measured with — on a phone, half the width, which draws the tab
         over against the right edge and never corrects itself. */
      const headerResize = new ResizeObserver(syncOverlap)
      const header = document.querySelector<HTMLElement>("[data-app-header]")
      if (header) {
        headerResize.observe(header)
        for (const cluster of header.querySelectorAll<HTMLElement>(
          "[data-header-left], [data-header-right]"
        ))
          headerResize.observe(cluster)
      }
      queueMicrotask(sync)
      onReady(api)
      /* Dockview does not tell us when it tears the component down, and
         `onReady` runs again on a theme remount — the dock's own cleanup path
         disposes its listeners the same way. */
      return () => {
        if (overlapFrame !== undefined) cancelAnimationFrame(overlapFrame)
        window.removeEventListener("resize", syncOverlap)
        headerResize.disconnect()
        disposables.forEach((disposable) => disposable.dispose())
      }
    },
    [onReady, dock]
  )

  /* Memoised, or every render of the dock hands the strip a new object and
     redraws each group's actions row. */
  const openers = React.useMemo(() => ({ onNewTab, onOpenPanel }), [onNewTab, onOpenPanel])

  return (
    <DockContext.Provider value={dock}>
      <DockOpenersContext.Provider value={openers}>
        <DockComponentsContext.Provider value={components}>
          <DockSurface onReady={handleReady} />
        </DockComponentsContext.Provider>
      </DockOpenersContext.Provider>
    </DockContext.Provider>
  )
}
