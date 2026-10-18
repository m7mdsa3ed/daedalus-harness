/* ── The dock, drawn ──
   `DockSurface` is the dockview instance and its options; `WorkspaceDock` is
   what surrounds it: the component map every kind is registered in, the phone's one-stack rule, the header
   measurement's listeners and the contexts the panels read. What the dock
   *does* is `useWorkspaceDock` (`dock.tsx`); what it says to its panels is
   `dock-context.ts`. */
import * as React from "react"
import {
  DockviewReact,
  themeAbyss,
  themeLight,
  type DockviewApi,
  type GetTabGroupChipContextMenuItemsParams,
  type IDockviewPanelProps,
} from "dockview-react"
import "dockview-react/dist/styles/dockview.css"

import { ChatPanel, markSwipe, peeks, type Peek } from "@/components/workspace/chat-panel"
import {
  DockContext,
  DockOpenersContext,
  TAB_GROUP_COLORS,
  useDock,
  type DockOpeners,
  type WorkspaceDock as WorkspaceDockApi,
} from "@/components/workspace/dock-context"
import { syncHeaderOverlap } from "@/components/workspace/dock-header"
import { PanelContainer } from "@/components/workspace/panel-container"
import { PanelTab } from "@/components/workspace/panel-tab"
import { PagePanel } from "@/components/workspace/page-panel"
import { WebPanel } from "@/components/workspace/web-panel"
import { UnsupportedPanel } from "@/components/workspace/unsupported-panel"
import { TAB_GRID_EVENT, TabActions } from "@/components/workspace/tab-actions"
import type { Actions } from "@/lib/actions"
import { navigateTo } from "@/lib/router"
import { MOBILE_BREAKPOINT, useIsMobile } from "@/hooks/use-device"
import { useTheme } from "@/lib/theme"
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
    .TasksPanel as React.FC<IDockviewPanelProps & { actions: Actions }>,
}))
/**
 * The dockview surface: the tab, the strip's actions, the tab-group chips and
 * the options every strip shares. One instance — tabs are grouped by dockview's
 * own tab groups, not by a second dock inside a tab.
 */
export function DockSurface({
  components,
  onReady,
}: {
  components: Record<string, React.FC<IDockviewPanelProps>>
  /** May answer its own teardown. `DockviewReact` drops whatever `onReady`
      returns and never says when it disposes, so the surface keeps it: run on
      the next ready (StrictMode mounts the instance twice) and on unmount. */
  onReady: (api: DockviewApi) => void | (() => void)
}) {
  const { resolved } = useTheme()
  const dock = useDock()
  const isMobile = useIsMobile()
  const teardownRef = React.useRef<(() => void) | void>(undefined)
  React.useEffect(
    () => () => {
      teardownRef.current?.()
      teardownRef.current = undefined
    },
    []
  )
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

  /* The chip's own menu is dockview's (rename, colour, collapse) except for
     Close, which has to be ours: dockview's removes the panels outright, past
     a terminal's guard and the reopen stack. "Ungroup" keeps the tabs. */
  const chipMenu = React.useCallback(
    ({ tabGroup, group, api }: GetTabGroupChipContextMenuItemsParams) => [
      "rename" as const,
      "colorPicker" as const,
      "collapse" as const,
      "separator" as const,
      {
        label: "Ungroup",
        action: () => api.dissolveTabGroup({ groupId: group.id, tabGroupId: tabGroup.id }),
      },
      { label: "Close group", action: () => void dock.closeTabGroup(group.id, tabGroup.id) },
    ],
    [dock]
  )

  return (
    <DockviewReact
      className="session-dock h-full min-h-0 flex-1"
      components={components}
      tabGroupColors={TAB_GROUP_COLORS}
      getTabGroupChipContextMenuItems={chipMenu}
      defaultRenderer="always"
      /* A phone never drags a tab (see the stack rule below). Left on, the
         downward drag that opens the tab grid started dockview's own drag: the
         tab collapsed out of the strip, the pointer was cancelled and the
         strip's header remounted under the opening animation. */
      disableDnd={isMobile}
      defaultTabComponent={PanelTab}
      /* Floating groups are on: a panel over the dock, and — through
         `popoutPanel` — one in a window of its own. `floatingGroupBounds`
         keeps a float from being dragged off-screen, which on a laptop is a
         panel the user cannot get back without clearing the layout. */
      floatingGroupBounds="boundedWithinViewport"
      onReady={(event) => {
        teardownRef.current?.()
        teardownRef.current = onReady(event.api)
      }}
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

/* How far a finger travels before the gesture is read at all, and how far it
   must go sideways for a tab change. The lock is the first: a touch that has
   moved mostly vertically by then is a scroll and is let go for good. */
const SWIPE_LOCK_PX = 10
const SWIPE_COMMIT_PX = 56

/**
 * ── Swipe the strip to walk the tabs, on a phone ──
 * The one-stack rule leaves a phone one tab in view and the rest in a list, so
 * a sideways swipe *on the strip* is the thumb's way to the neighbour — left
 * for the next tab, right for the previous, wrapping like Alt+↓/↑, through the
 * same `cycleTab` the chords and palette rows call. Only the strip: on the
 * transcript a sideways drag is a text selection or a code block's own
 * horizontal scroll, and both have to keep working.
 *
 * Native pointer events on the document (a strip is created and destroyed by
 * dockview, and a nested group has its own), touch only. The strip carries
 * `touch-action: pan-y` below `md` (`index.css`) so the browser hands us the
 * horizontal half instead of scrolling the strip.
 */
function useTabSwipe(
  enabled: boolean,
  cycle: (delta: number) => void,
  getApi: () => DockviewApi | undefined
) {
  const cycleRef = React.useRef(cycle)
  cycleRef.current = cycle
  const apiRef = React.useRef(getApi)
  apiRef.current = getApi
  React.useEffect(() => {
    if (!enabled) return
    let start: {
      id: number
      x: number
      y: number
      axis: "x" | "y" | null
      grid?: boolean
      /* The pager, as the composer's swipe drives it (`chat-panel.tsx`): the
         thread in front follows the finger and the neighbour is dragged in
         beside it. Absent when either is not a thread — the swipe then
         changes tab on release, as it always did. */
      dir: number
      w: number
      me?: Peek
      nb?: Peek
      px: number
      pt: number
      v: number
    } | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let release: (() => void) | undefined
    /* Hands the overlays back to dockview once they have settled. */
    const hold = (a: Peek | undefined, b: Peek | undefined, ms: number) => {
      release?.()
      const done = () => {
        clearTimeout(timer)
        release = undefined
        a?.release()
        b?.release()
      }
      timer = setTimeout(done, ms)
      release = done
    }
    const home = (s: NonNullable<typeof start>) => {
      s.me?.settle(0, true)
      s.nb?.settle(s.dir * s.w, true)
      hold(s.me, s.nb, 300)
    }
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || !e.isPrimary) return
      const target = e.target as Element | null
      /* The thread dock's own strip scrolls sideways; a swipe there is not a tab switch. */
      if (!target?.closest(".dv-tabs-and-actions-container") || target.closest(".dock-nested")) return
      release?.()
      start = { id: e.pointerId, x: e.clientX, y: e.clientY, axis: null, dir: 0, w: 0, px: e.clientX, pt: e.timeStamp, v: 0 }
    }
    const move = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return
      const dxs = e.clientX - start.x
      const dx = Math.abs(dxs)
      const dy = Math.abs(e.clientY - start.y)
      if (!start.axis) {
        if (Math.max(dx, dy) < SWIPE_LOCK_PX) return
        start.axis = dx > dy * 1.5 ? "x" : "y"
        if (start.axis === "x") {
          start.dir = dxs < 0 ? 1 : -1
          const group = apiRef.current()?.activeGroup
          const panels = group?.panels ?? []
          const i = group?.activePanel ? panels.indexOf(group.activePanel) : -1
          const next = i >= 0 && panels.length > 1 ? panels[(i + start.dir + panels.length) % panels.length] : undefined
          start.me = group?.activePanel ? peeks.get(group.activePanel.id) : undefined
          start.nb = next ? peeks.get(next.id) : undefined
          const mine = start.me?.el()
          if (!mine || !start.nb) start.me = start.nb = undefined
          else {
            start.w = mine.offsetWidth
            const theirs = start.nb.el()
            /* A panel nobody has looked at since a resize holds stale geometry. */
            if (theirs) for (const k of ["left", "top", "width", "height"] as const) theirs.style[k] = mine.style[k]
          }
        }
      }
      /* Dragging the tab down opens the card grid, as on Chrome. Marked here,
         opened when the finger lifts (or the browser cancels the touch, which
         it may do to a vertical drag): opening under a live touch starts the
         morph while the strip is still taking pointer events. */
      if (start.axis === "y" && e.clientY - start.y >= SWIPE_COMMIT_PX / 2) start.grid = true
      if (start.axis === "x" && start.me && start.nb) {
        const dt = e.timeStamp - start.pt
        if (dt >= 50) {
          start.v = (e.clientX - start.px) / dt
          start.px = e.clientX
          start.pt = e.timeStamp
        }
        /* Dragging back past the start never reveals what is behind. */
        const x = -start.dir * Math.max(0, -start.dir * dxs)
        start.me.place(x)
        start.nb.place(x + start.dir * start.w)
      }
    }
    const up = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return
      const s = start
      const dx = e.clientX - s.x
      const horizontal = s.axis === "x"
      start = null
      if (s.grid) window.dispatchEvent(new Event(TAB_GRID_EVENT))
      const flick = Math.abs(dx) >= 24 && Math.abs(s.v) > 0.5 && s.v * dx > 0
      const commit = horizontal && dx * s.dir < 0 && (Math.abs(dx) >= SWIPE_COMMIT_PX || flick)
      if (!commit) return horizontal ? home(s) : undefined
      markSwipe(s.dir, !!s.nb)
      cycleRef.current(s.dir)
      if (s.me && s.nb) {
        /* Dockview hides the outgoing overlay as the tab changes; hold it up
           while it slides out and the neighbour lands. */
        s.me.settle(-s.dir * s.w)
        s.nb.settle(0)
        hold(s.me, s.nb, 240)
      }
    }
    const cancel = () => {
      const s = start
      start = null
      if (s?.grid) window.dispatchEvent(new Event(TAB_GRID_EVENT))
      if (s?.axis === "x") home(s)
    }
    document.addEventListener("pointerdown", down, true)
    document.addEventListener("pointermove", move, true)
    document.addEventListener("pointerup", up, true)
    document.addEventListener("pointercancel", cancel, true)
    return () => {
      clearTimeout(timer)
      document.removeEventListener("pointerdown", down, true)
      document.removeEventListener("pointermove", move, true)
      document.removeEventListener("pointerup", up, true)
      document.removeEventListener("pointercancel", cancel, true)
    }
  }, [enabled])
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
  const apiRef = React.useRef<DockviewApi | undefined>(undefined)
  useTabSwipe(isMobile, dock.cycleTab, () => apiRef.current)
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
    map.tasks = contained((props) => (
      <TasksPanel {...props} actions={actions} />
    ))
    map.web = contained(WebPanel as React.FC<IDockviewPanelProps>)
    map.page = contained(PagePanel as React.FC<IDockviewPanelProps>)
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
      apiRef.current = api
      onReady(api)
      /* Run by `DockSurface` on the next ready and on unmount. */
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
        <DockSurface components={components} onReady={handleReady} />
      </DockOpenersContext.Provider>
    </DockContext.Provider>
  )
}
