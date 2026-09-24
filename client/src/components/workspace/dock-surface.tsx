/* ── The dock, drawn ──
   `DockSurface` is one dockview instance — the same components, tab and strip
   at either level — and `WorkspaceDock` is the top-level one: the component
   map every kind is registered in, the phone's one-stack rule, the header
   measurement's listeners and the contexts the panels read. What the dock
   *does* is `useWorkspaceDock` (`dock.tsx`); what it says to its panels is
   `dock-context.ts`. */
import * as React from "react"
import {
  DockviewReact,
  themeAbyss,
  themeLight,
  type DockviewApi,
  type IDockviewPanelProps,
} from "dockview-react"
import "dockview-react/dist/styles/dockview.css"

import { ChatPanel } from "@/components/workspace/chat-panel"
import {
  DockContext,
  DockOpenersContext,
  type DockOpeners,
  type WorkspaceDock as WorkspaceDockApi,
} from "@/components/workspace/dock-context"
import { syncHeaderOverlap } from "@/components/workspace/dock-header"
import { PanelContainer } from "@/components/workspace/panel-container"
import { PanelTab } from "@/components/workspace/panel-tab"
import { PagePanel } from "@/components/workspace/page-panel"
import { WebPanel } from "@/components/workspace/web-panel"
import { UnsupportedPanel } from "@/components/workspace/unsupported-panel"
import { TabActions } from "@/components/workspace/tab-actions"
import type { Actions } from "@/lib/actions"
import { navigateTo } from "@/lib/router"
import { MOBILE_BREAKPOINT, useIsMobile } from "@/hooks/use-device"
import { useTheme } from "@/lib/theme"
import { cn } from "@/lib/utils"
import { PANEL_KINDS } from "@/lib/workspace/panels"

/* The terminal and board carry libraries the rest of the app does not. The
   chat is what the dock opens with, so lazy loading it would only put a
   suspense boundary in front of the first paint. */
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
  dock: WorkspaceDockApi
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
