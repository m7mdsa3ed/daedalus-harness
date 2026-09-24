/* ── What the dock says to everything inside it ──
   The dock's public shape (`WorkspaceDock`, what `useDock` answers), the
   contexts it is handed down through, and the module store of open groups.
   Split from `dock.tsx` so a panel, a tab or a menu can ask for the dock
   without importing the controller that implements it. */
import * as React from "react"
import type { DockviewApi, IDockviewPanel } from "dockview-react"

import type { SavedLayout } from "@/lib/workspace/layout"
import { parsePanel, type PanelDescriptor, type PanelKind } from "@/lib/workspace/panels"

export interface OpenPanelOptions {
  /** Add beside the current panel instead of replacing it. */
  newTab?: boolean
  /**
   * Where the caller thinks this panel *belongs* — navigation left or streams
   * below, one panel at a time.
   *
   * **It no longer splits the dock, and reads as `newTab`.** Every panel opens
   * the way a new thread does: a tab beside what you are looking at. Opening a
   * terminal used to cut the dock in half under the transcript, so the answer
   * to "open something" depended on
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

export type PresetId = "focus"

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
  /** A panel's veto on its own closing — live terminals. */
  registerCloseGuard: (id: string, guard: CloseGuard) => () => void
  /** Descriptors currently open, in tab order, for menus and the palette. */
  listPanels: () => { id: string; panel: PanelDescriptor; title: string }[]
  isPanelOpen: (id: string) => boolean
  hasClosedPanels: () => boolean
  /** The descriptor of the panel in front of you — a nested group's own when a
      group tab is active. The route only follows chats and pages, so this is
      the one thing that can answer "which project am I looking at" while a
      terminal or a preview has the focus. */
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
  /** Open these panels in a new group, side by side (best-of-N). Answers the
      group panel's id. */
  openGroup: (panels: PanelDescriptor[]) => string | null
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

export function setDockGroups(rows: DockGroupRow[]): void {
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

export const DockContext = React.createContext<WorkspaceDock | null>(null)

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

export const DockOpenersContext = React.createContext<DockOpeners>({})

export function useDockOpeners(): DockOpeners {
  return React.useContext(DockOpenersContext)
}

/** The descriptor a live Dockview panel was opened with, or null. */
export function descriptorOf(panel: IDockviewPanel): PanelDescriptor | null {
  return parsePanel(panel.api.component, panel.params)
}
