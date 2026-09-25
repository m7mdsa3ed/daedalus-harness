/* ── What the dock says to everything inside it ──
   The dock's public shape (`WorkspaceDock`, what `useDock` answers), the
   contexts it is handed down through.
   Split from `dock.tsx` so a panel, a tab or a menu can ask for the dock
   without importing the controller that implements it. */
import * as React from "react"
import type { IDockviewPanel } from "dockview-react"

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
  /** Exactly where it lands, said by the caller rather than remembered: a
      strip's + and a tab's own menu know the strip, and the open behind them
      can be a server round trip away. */
  into?: PanelTarget
}

/** A strip (dockview group id), and optionally the tab to land beside. */
export interface PanelTarget {
  group: string
  /** Right after this tab. Without `split`, in its tab group — made for the
      two of them if it has none, once the new panel exists, so a failed open
      leaves nothing behind. */
  beside?: string
  /** A new column or row beside the strip instead: the way to *see* both at
      once, which a tab group never does. Asked for by name, so it may split. */
  split?: "right" | "below"
}

/** `focus` is one group, maximised; the rest deal the open tabs round-robin
    across that many groups (never more groups than tabs). */
export type PresetId = "focus" | "columns" | "rows" | "columns3" | "grid"

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
  /** Move a panel (`id`, or the one in front of you) into a new column or row
      beside its own. */
  splitActive: (direction: "right" | "below", id?: string) => void
  /** Aim the next *thread* opened at a strip — the strip's "+ ▸ New thread",
      whose tab arrives a navigation later, so it cannot be passed along the
      way a panel's `into` is. Spent by the next chat open, within 2s. */
  targetNext: (group: string) => void
  toggleMaximize: (id?: string) => void
  /** Every panel into one strip — the phone's rule and Reset layout. */
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
  /** The descriptor of the panel in front of you. The route only follows
      chats and pages, so this is
      the one thing that can answer "which project am I looking at" while a
      terminal or a preview has the focus. */
  activeDescriptor: () => PanelDescriptor | undefined

  /* ── The strip you are looking at ──
     All three act on the strip in front of you, because following it beats
     following a global order the reader cannot see. */
  /** Jump to the nth tab (0-based) of the group in front of you. */
  setTabIndex: (index: number) => void
  /** Walk that group's tabs, wrapping at both ends. */
  cycleTab: (delta: number) => void
  /** Close the tab in front of you, through the same guarded door its ✕ uses. */
  closeActiveTab: () => Promise<void>

  /* ── Tab groups ──
     Dockview's own: a coloured, labelled, collapsible run of tabs inside one
     strip. The chip carries rename, colour and collapse (dockview's menu); the
     dock owns what has to go through a guarded close. */
  /** Put a tab in a tab group of its strip — an existing one by id, or `null`
      for a new one. Answers the tab group's id. */
  addToTabGroup: (id: string, tabGroupId: string | null) => string | null
  removeFromTabGroup: (id: string) => void
  /** The tab groups of the strip a tab stands in, and which one holds it. */
  tabGroupsBeside: (id: string) => { groups: TabGroupRow[]; current?: string }
  /** Close every tab of a tab group through the guarded door, pins excepted. */
  closeTabGroup: (groupId: string, tabGroupId: string) => Promise<void>
  /** Open these panels side by side, one column each, labelled as one set by a
      shared tab-group colour (best-of-N). Asked for by name, so it may split;
      on a phone it is one strip of tabs in one tab group. */
  openSideBySide: (panels: PanelDescriptor[], label: string) => void

  /* ── The bottom panel ──
     A dockview edge group: a panel moved there leaves the grid for a strip
     along the bottom that collapses to its tabs, and goes away with its last
     panel. Never where anything *opens* — only where a tab is sent. */
  moveToBottom: (id: string) => void
  /** Back into the grid, beside the panel in front of you. */
  moveToMain: (id: string) => void
  isInBottom: (id: string) => boolean
  /** Collapse or expand the bottom panel. False when there is none. */
  toggleBottom: () => boolean
}

export interface TabGroupRow {
  id: string
  label: string
  /** Its tabs' titles, for a row that would otherwise be three "Group" lines. */
  hint: string
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
  /** `reuse` shows the one you have (the chords); `target` says where a new
      one lands and whose project it acts on (a tab's menu, a strip's +). */
  onOpenPanel?: (kind: PanelKind, reuse?: boolean, target?: OpenerTarget) => void
}

export interface OpenerTarget {
  into?: PanelTarget
  /** The project the panel acts on — the tab it was asked from, not whatever
      happens to be in front. */
  projectId?: string
}

export const DockOpenersContext = React.createContext<DockOpeners>({})

export function useDockOpeners(): DockOpeners {
  return React.useContext(DockOpenersContext)
}

/** The descriptor a live Dockview panel was opened with, or null. */
export function descriptorOf(panel: IDockviewPanel): PanelDescriptor | null {
  return parsePanel(panel.api.component, panel.params)
}

/** The tab-group palette, from the theme's own tokens rather than dockview's
    fixed hues, so a group's colour follows every built-in and generated theme
    (`pnpm themes` already gates `--chart-*` for contrast). The id is what a
    layout stores; the value is resolved live, so a theme switch recolours
    every chip without touching a saved layout. */
export const TAB_GROUP_COLORS = [
  { id: "accent", value: "var(--primary)", label: "Accent" },
  ...[1, 2, 3, 4, 5].map((n) => ({ id: `chart-${n}`, value: `var(--chart-${n})`, label: `Chart ${n}` })),
]
