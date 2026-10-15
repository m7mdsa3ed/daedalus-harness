/* ── The dock's tab ──
   One tab for every panel kind. It replaces Dockview's default tab, which is
   what makes `dock.closePanel` the only way a panel closes — and therefore the
   only place a dirty editor gets asked.

   ── Dockview owns the ARIA; this file owns the face ──
   dockview-core 8.2 already implements the WAI-ARIA Tabs pattern on the DOM it
   builds around us: `role="tablist"` + `aria-orientation` on the strip,
   `role="tab"` + `aria-selected` + `aria-controls` on each tab,
   `role="tabpanel"` on the content, a **roving tabindex** (the active tab is
   the list's one tab stop) and the keyboard the pattern asks for —
   ArrowLeft/Right, Home, End, Enter/Space with manual activation.

   All of that is load-bearing on one condition, and it is the condition the
   tab this replaces broke: **nothing rendered inside `role="tab"` may be
   focusable.** Dockview routes its key handling with
   `tabs.findIndex(tab => tab.element === event.target)`, so focus landing on a
   nested `<button>` answers -1 and every arrow key goes dead — and a tablist
   with two extra tab stops per tab is not a single tab stop, which is the
   whole point of a roving tabindex. So the ⋮ and the close are `tabIndex={-1}`
   and the keyboard reaches them the way VS Code and Chrome do it: on the tab
   itself, `Delete`/`Backspace` closes and `Shift`+`F10` (or the Menu key)
   opens the actions.

   The one thing dockview cannot know is what the panel is *doing*. Its
   `aria-label` is the plain title, so `useTabLabel` rewrites it with the
   reading and the pin state folded in — a screen reader gets "Fix the reducer,
   running, pinned" where a sighted reader gets a title, an amber dot and a pin.

   ── What the face draws ──
   The mark, the title, the reading, and two controls that appear when pointed
   at. A chat's mark pairs its agent and project so both the runtime and workspace
   are recognizable. Nor is the thread's context
   reading: a tab subscribed to a value written on every streamed token is a
   strip that re-renders per token.

   Narrow screens collapse the title of every tab but the one you are on
   (`index.css`). Four titles sharing a 360px strip are four tabs truncated to
   "Fix th…", which is four identical tabs; a mark is short enough to be whole,
   and a whole thing can be told apart and pressed. */
import * as React from "react"
import type { IDockviewPanelHeaderProps } from "dockview-react"
import { useNavigate } from "react-router"
import { MoreVerticalIcon, PinOffIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MENU_WIDTH } from "@/components/menu-row"
import {
  ItemContextMenu,
  renderMenuItems,
  type MenuItemSpec,
} from "@/components/item-context-menu"
import { PanelStatusDot } from "@/components/workspace/panel-status-dot"
import { useDock, useDockOpeners, type TabGroupRow } from "@/components/workspace/dock-context"
import { useIsMobile } from "@/hooks/use-device"
import { writeClipboard } from "@/lib/clipboard"
import { reportError } from "@/lib/errors"
import { pageKey } from "@/lib/workspace/panels"
import { usePageHeadingFor } from "@/components/workspace/page-panel"
import { activityAt, relativeAge } from "@/lib/settings"
import { useAgents, useProjects } from "@/lib/queries/catalog"
import { settingsFormPath, threadPath } from "@/lib/router"
import { useSessionMeta } from "@/lib/store"
import { toast } from "@/lib/toast"
import { usePanelPinned } from "@/lib/workspace/panel-pins"
import { usePanelStatus } from "@/lib/workspace/panel-status"
import { useRunHelper } from "@/lib/workspace/use-run-helper"
import { PANEL_SPECS, isPanelKind, parsePanel } from "@/lib/workspace/panels"
import { cn } from "@/lib/utils"

/** What a tab can open beside itself in its tab group — everything the +
    offers but a thread, which the composer's own doors open. */
const GROUPABLE = ["terminal", "web", "tasks"] as const

type PanelApi = IDockviewPanelHeaderProps["api"]
type ContainerApi = IDockviewPanelHeaderProps["containerApi"]
type Descriptor = ReturnType<typeof parsePanel>

/** The tab `delta` away from this one, wrapping — the strip's own "next" and
    "previous", for the two menu rows. The chord (`dock.tsx`) walks from the
    *active* tab; a menu row opened on a tab that is not the active one walks
    from the one it is on, which is what "next" means in a menu you opened by
    pointing at a tab. */
function stepTabInGroup(api: PanelApi, delta: 1 | -1): void {
  const siblings = api.group?.panels ?? []
  if (siblings.length < 2) return
  const index = siblings.findIndex((panel) => panel.id === api.id)
  const next = siblings[(Math.max(index, 0) + delta + siblings.length) % siblings.length]
  next.api.setActive()
}

/** Dockview's own tab element — the one carrying `role="tab"`, the roving
    tabindex and the `aria-*`. Our content is a child of it, so anything that
    has to be true of the *tab* is reached from here. */
const tabElementOf = (node: HTMLElement | null): HTMLElement | null =>
  node?.closest<HTMLElement>(".dv-tab") ?? null

/** Whether this tab is the one in front. Dockview owns the answer and pushes
    it, so it is a subscription and not a read: `api.isActive` at render time is
    a value that never changes again. */
function useTabActive(api: PanelApi): boolean {
  return React.useSyncExternalStore(
    React.useCallback(
      (onChange) => {
        const disposable = api.onDidActiveChange(onChange)
        return () => disposable.dispose()
      },
      [api]
    ),
    () => api.isActive,
    () => false
  )
}

/**
 * Which sibling closes are possible — "close others" with nothing else in the
 * group is a row that does nothing, and a disabled row says so before it is
 * pressed rather than after.
 *
 * `hasOtherGroups` and `maximized` are the same question asked of the *dock*:
 * a pair of tabs is two groups of one, so `hasOthers` is false for both of them
 * and "fill the dock" is not the row it disables. Whether this tab's group is
 * the maximized one comes from dockview, which is what makes the row able to
 * name the direction it will go.
 *
 * Dragging a tab between groups changes the siblings without adding or
 * removing a panel, which is why the layout event is in here too.
 */
interface TabNeighbours {
  hasOthers: boolean
  hasRightward: boolean
  hasOtherGroups: boolean
  maximized: boolean
  /** The tab groups of this strip, and the one holding this tab. */
  tabGroups: { groups: TabGroupRow[]; current?: string }
  inBottom: boolean
}

function useTabNeighbours(api: PanelApi, containerApi: ContainerApi): TabNeighbours {
  const dock = useDock()
  const [state, setState] = React.useState<TabNeighbours>({
    hasOthers: false,
    hasRightward: false,
    hasOtherGroups: false,
    maximized: false,
    tabGroups: { groups: [] },
    inBottom: false,
  })
  React.useEffect(() => {
    const sync = () => {
      const panel = containerApi.getPanel(api.id)
      const siblings = panel?.group.panels ?? []
      const index = siblings.findIndex((candidate) => candidate.id === api.id)
      setState({
        hasOthers: siblings.length > 1,
        hasRightward: index >= 0 && index < siblings.length - 1,
        hasOtherGroups: containerApi.groups.length > 1,
        maximized: !!panel?.api.isMaximized(),
        /* Tab-group changes are folded into dockview's layout change, which is
           what keeps a menu opened after a rename from naming the old label. */
        tabGroups: dock.tabGroupsBeside(api.id),
        inBottom: dock.isInBottom(api.id),
      })
    }
    sync()
    const disposables = [
      containerApi.onDidAddPanel(sync),
      containerApi.onDidRemovePanel(sync),
      containerApi.onDidLayoutChange(sync),
      containerApi.onDidMaximizedGroupChange(sync),
    ]
    return () => disposables.forEach((disposable) => disposable.dispose())
  }, [api, containerApi, dock])
  return state
}

/** Dockview writes the plain title into the tab's `aria-label`; this puts back
    everything the face says and the name does not. Re-applied whenever any part
    of it changes, which is also what recovers it from dockview rewriting the
    label on its own `setTitle`. */
function useTabLabel(
  ref: React.RefObject<HTMLElement | null>,
  hoverDetails: string,
  parts: Array<string | undefined | false>
): void {
  const label = parts.filter(Boolean).join(", ")
  React.useEffect(() => {
    const tab = tabElementOf(ref.current)
    tab?.setAttribute("aria-label", label)
    tab?.setAttribute("title", hoverDetails)
  }, [ref, label, hoverDetails])
}

/**
 * The keyboard a tab answers to on its own, for the controls that may not be
 * focus stops (see the header comment). Bound on dockview's tab element and
 * gated on `event.target` being it, so a key pressed inside the panel — or in
 * the menu this opens — is never claimed. Modified presses are left alone:
 * `Ctrl`/`Cmd` combinations belong to the app's own shortcut table.
 */
function useTabKeys(
  ref: React.RefObject<HTMLElement | null>,
  handlers: { onClose: () => void; onMenu: () => void }
): void {
  const latest = React.useRef(handlers)
  latest.current = handlers
  React.useEffect(() => {
    const tab = tabElementOf(ref.current)
    if (!tab) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target !== tab || event.altKey || event.ctrlKey || event.metaKey) return
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault()
        latest.current.onClose()
      } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
        event.preventDefault()
        latest.current.onMenu()
      }
    }
    tab.addEventListener("keydown", onKeyDown)
    return () => tab.removeEventListener("keydown", onKeyDown)
  }, [ref])
}

/* ── Activation is dockview's, and it must stay dockview's ──
   A tab used to be opened by its click rather than its press: a capture-phase
   `pointerdown` listener called `preventDefault()`, which is the one thing
   dockview's own handler steps aside for (`if (event.defaultPrevented) return`),
   and the click put the panel in front afterwards. It was written for a real
   complaint — pressing a background tab to drag it swapped the panel you were
   looking at before the drag even began — and it cost the whole of drag and
   drop: **a native HTML5 drag is the default action of the `mousedown` that
   arms it**, and preventing a `pointerdown` suppresses that compatibility
   `mousedown` outright. `.dv-tab` is natively `draggable`, so with the press
   prevented no tab could be dragged anywhere — not across a strip, not between
   two groups, not into a nested one.

   Nothing replaces it, because the complaint is upstream's now:
   `_activateOnPointerDown` defers the activation by a frame precisely so
   `dragstart` arms first (dockview #932), and activating on press is what a
   browser tab does anyway. */

export function PanelTab({ api, containerApi, params }: IDockviewPanelHeaderProps) {
  const dock = useDock()
  const ref = React.useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = React.useState(false)

  const descriptor = parsePanel(api.component, params)
  const fallback = isPanelKind(api.component) ? PANEL_SPECS[api.component].defaultTitle : "Panel"
  const title = api.title ?? fallback

  const active = useTabActive(api)
  const pinned = usePanelPinned(api.id)
  const status = usePanelStatus(api.id)
  const neighbours = useTabNeighbours(api, containerApi)
  const meta = useSessionMeta(descriptor?.kind === "chat" ? descriptor.sessionId : "")
  const projects = useProjects()
  const agents = useAgents()
  const projectId =
    descriptor && "projectId" in descriptor
      ? descriptor.projectId
      : descriptor?.kind === "chat"
        ? meta?.projectId
        : undefined
  const project = projects.find((candidate) => candidate.id === projectId)
  const agent = meta ? agents.find((candidate) => candidate.id === meta.agentId) : undefined
  /* The tab's second row: the facts a title cannot carry. A thread names its
     project and the model it runs on (its agent is the mark); a page names the
     section it is in; a shell its directory and a preview its address. Short on
     purpose — the hover card has the rest. */
  const headingFor = usePageHeadingFor()
  const subtitle =
    descriptor?.kind === "chat"
      ? [meta?.draft ? "Draft" : undefined, project?.name, meta?.model].filter(Boolean).join(" · ")
      : descriptor?.kind === "page"
        ? (headingFor(descriptor.path)?.crumb ?? (pageKey(descriptor.path) === "home" ? "Quick actions" : ""))
        : descriptor?.kind === "terminal"
          ? (descriptor.cwd ?? project?.cwd ?? "")
          : descriptor?.kind === "web"
            ? (descriptor.file ?? descriptor.url ?? "")
            : ""
  /* When the thread last did anything. The age only moves by the minute, so one
     re-render a minute keeps it honest and a tab nobody looks at costs nothing. */
  const [, tick] = React.useReducer((n: number) => n + 1, 0)
  React.useEffect(() => {
    const id = window.setInterval(tick, 60_000)
    return () => window.clearInterval(id)
  }, [])
  const age = descriptor?.kind === "chat" && meta && !meta.draft ? relativeAge(activityAt(meta)) : ""
  const hoverDetails = [
    title,
    status?.label,
    pinned && "Pinned",
    agent?.name && `Agent: ${agent.name}`,
    project?.name && `Project: ${project.name}`,
    descriptor?.kind === "terminal" && (descriptor.cwd ?? project?.cwd) &&
      `Directory: ${descriptor.cwd ?? project?.cwd}`,
    descriptor?.kind === "web" && (descriptor.file ?? descriptor.url) &&
      `Location: ${descriptor.file ?? descriptor.url}`,
    descriptor?.kind === "page" && `Page: ${descriptor.path}`,
    descriptor?.kind === "chat" && meta?.model && `Model: ${meta.model}`,
    descriptor?.kind === "chat" && meta?.effort && `Effort: ${meta.effort}`,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .filter((part, index, parts) => parts.indexOf(part) === index)
    .join("\n")

  const close = React.useCallback(() => void dock.closePanel(api.id), [dock, api.id])

  useTabLabel(ref, hoverDetails, [title, status?.label, pinned && "pinned"])
  useTabKeys(ref, { onClose: close, onMenu: () => setMenuOpen(true) })

  const items = useTabMenuItems({
    api,
    dock,
    descriptor,
    title,
    pinned,
    ...neighbours,
  })

  return (
    <ItemContextMenu items={items}>
      {/* Air above and below, and none to the sides: the strip's `gap` is
          gone and the chip's own inset is the whole of the space between two
          tabs — one number for one distance (`index.css`). The chip is a slab
          *of the row* on a docked strip, so it takes the row's height with a
          2px inset, which is what `py-0.5` here and `h-full` + `m-0.5` below
          add up to.

          `pl-2.5`: the leading side is paid for the active tab's 2px rail
          (`index.css`), which sits at the slab's left edge — at `pl-2` the mark
          would start *on* the rail. The padding is unconditional so the mark
          does not jump 2px when a tab becomes active. */}
      <div className="flex h-full min-w-0 flex-1 items-center py-0.5">
        <div
          /* The ref lives here and not on the box above, which is the one
             `ItemContextMenu` merges its trigger onto: a `render` prop composes
             refs, and a ref that has to resolve to find `.dv-tab` should not
             depend on another library getting that composition right. This
             element is ours alone and is still a descendant of the tab. */
          ref={ref}
          data-active={active || undefined}
          className={cn(
            /* `--dock-chip-h` and not a height of its own: in the header's band
               the chip is the height of the sidebar toggle and the view-settings
               sliders beside it (`HEADER_CHIP`, the same token), because all
               three stand on the one line; on a docked strip it is the row minus
               the 2px of air the cell keeps above and below it. */
            "dock-tab relative mx-0.5 flex h-[var(--dock-tab-h)] min-w-0 flex-1 items-center gap-1.5 py-0 pr-1.5 pl-2.5 text-[13px] leading-4",
            active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
          )}
        >
          {/* The title is the whole of what the tab lays out — the two controls
              are floating (`index.css`), so nothing reserves a gutter for a pair
              of things that only exist while you point at one tab. The title and
              its reading are **one box**: the mask below fades this box's right
              end, so what the controls cover when they arrive is this box, and
              the reading is what they replace there. Leaving the dot outside it
              put the ✕ on top of the dot on hover, which is why it is in here.

              `flex-1 min-w-0` on both this box and the text gives the text a
              real column to truncate in — the grid-of-one this used to be was
              the same idea spelled with `grid-template-columns`. */}
          <span data-tab-title className="flex min-w-0 flex-1 flex-col justify-center">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={cn("min-w-0 flex-1 truncate", status?.tone === "running" && "harness-shimmer")}>
                {title}
              </span>
              {/* What the panel is doing, for a panel you cannot see. Decorative
                  here: the reading is folded into the tab's accessible name above,
                  and a live region per tab inside `role="tab"` is both invalid and
                  a strip that talks over itself. */}
              <PanelStatusDot status={status} aria-hidden role={undefined} />
            </span>
            {(subtitle || age) && (
              <span className="flex min-w-0 items-center gap-1.5 text-[10px] leading-3 font-normal text-muted-foreground/80">
                <span className="min-w-0 flex-1 truncate">{subtitle}</span>
                {age && <span className="shrink-0 tabular-nums">{age}</span>}
              </span>
            )}
          </span>
          {/* **Floating, and laid out in no row at all** (`index.css`): two
              absolutely positioned controls against the chip's trailing inset,
              so the title owns the whole of the tab's width. What they cover
              when they appear, the title no longer says — it fades under them
              instead, and to the same width the pin takes when there is one. */}
          <span data-tab-controls className="absolute inset-y-0 right-1 flex items-center">
            {/* One array, two surfaces: this and the right-click (long-press on
                a touch screen). A context menu is a gesture you have to already
                know is there, and on a touch screen it competes with the drag
                that reorders the tab — the ⋮ is how the menu is *found*. */}
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger
                render={
                  <Button
                    data-tab-action="menu"
                    size="icon-xs"
                    variant="ghost"
                    tabIndex={-1}
                    aria-label={`Actions for ${title}`}
                    className={TAB_CONTROL}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <MoreVerticalIcon className="size-3.5" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className={MENU_WIDTH}>
                {renderMenuItems(items, {
                  Item: DropdownMenuItem,
                  Separator: DropdownMenuSeparator,
                  Sub: DropdownMenuSub,
                  SubTrigger: DropdownMenuSubTrigger,
                  SubContent: DropdownMenuSubContent,
                })}
              </DropdownMenuContent>
            </DropdownMenu>
            {/* A pinned tab trades its close for the pin that undoes the
                pinning — the same width, and the gesture that got you here gets
                you back. It is the one control drawn without being pointed at:
                pinning is a *state*, and a pinned tab that looked like any
                other until you hovered it is most of what pinning is for. */}
            {pinned ? (
              <TabControl
                data-tab-action="pin"
                label={`Unpin ${title}`}
                icon={PinOffIcon}
                onClick={() => dock.togglePin(api.id)}
              />
            ) : (
              <TabControl
                data-tab-action="close"
                label={`Close ${title}`}
                icon={XIcon}
                onClick={close}
              />
            )}
          </span>
        </div>
      </div>
    </ItemContextMenu>
  )
}

/* `--dock-control-h` square and fully round, so the two of them read as
   controls *inside* the slab rather than as two more small slabs: a 20px box
   in a 28px chip is a button, and two rounded squares at the end of a rounded
   rectangle is a tab made of three rounded rectangles. */
const TAB_CONTROL =
  "size-[var(--dock-control-h)] shrink-0 rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground active:bg-foreground/15"

/**
 * A tab's close / unpin control.
 *
 * `tabIndex={-1}` is the load-bearing prop: a focusable descendant of
 * `role="tab"` breaks both the roving tabindex and dockview's arrow keys (see
 * the header comment). `useTabKeys` is what gives them back a keyboard.
 *
 * The press is stopped and not merely the click, because the press is what
 * starts dockview's drag — without it, aiming at the close and moving two
 * pixels tears the tab out of its group instead of closing it.
 */
function TabControl({
  label,
  icon: Icon,
  onClick,
  ...props
}: {
  label: string
  icon: React.ComponentType<{ className?: string }>
  onClick: () => void
} & Omit<React.ComponentProps<typeof Button>, "onClick">) {
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      tabIndex={-1}
      aria-label={label}
      title={label}
      className={TAB_CONTROL}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      {...props}
    >
      <Icon className="size-3.5" />
    </Button>
  )
}

/**
 * The tab's actions, as data. Built once and rendered into both the ⋮ and the
 * right-click menu, so the two cannot drift.
 */
function useTabMenuItems({
  api,
  dock,
  descriptor,
  title,
  pinned,
  hasOthers,
  hasRightward,
  hasOtherGroups,
  maximized,
  tabGroups,
  inBottom,
}: TabNeighbours & {
  api: PanelApi
  dock: ReturnType<typeof useDock>
  descriptor: Descriptor
  title: string
  pinned: boolean
}): MenuItemSpec[] {
  const navigate = useNavigate()
  const runHelper = useRunHelper(dock)
  /* Floating and popping out are wide-window gestures: on a phone a float covers
     the whole dock and a popout is a second browser window, neither of which is
     the "panel beside a panel" these rows exist for. */
  const isMobile = useIsMobile()
  /* The thread's row, for the project it belongs to — not drawn on the face,
     but "Project commands" below is this thread's project's. A row keeps its
     identity unless it changes (see `useSessionMeta`), so this is not a
     subscription to anything a turn writes. */
  const meta = useSessionMeta(descriptor?.kind === "chat" ? descriptor.sessionId : "")
  const projects = useProjects()
  const project = meta ? projects.find((candidate) => candidate.id === meta.projectId) : undefined
  /* The project a panel opened *from this tab* acts on: its own, or its
     thread's. A board or a page has none, and the opener falls back. */
  const projectId =
    descriptor && "projectId" in descriptor ? descriptor.projectId : (meta?.projectId ?? undefined)
  /* The same opener the strip's + and the chords call, so "open it with this
     tab" and "open it" differ in where it lands and in nothing else. */
  const { onOpenPanel } = useDockOpeners()

  return [
    /* Close comes first and names *this* tab, so a pinned panel still has a way
       out — the bulk closes below are the ones pinning is a defence against.
       Every tab closes, the last one included: an empty dock goes to the
       landing console (`dock-surface.tsx`). */
    { label: "Close", shortcut: "closeTab", onClick: () => void dock.closePanel(api.id) },
    { label: "Close others", disabled: !hasOthers, onClick: () => void dock.closeOthers(api.id) },
    {
      label: "Close to the right",
      disabled: !hasRightward,
      onClick: () => void dock.closeToTheRight(api.id),
    },
    { label: "Close all", disabled: !hasOthers, onClick: () => void dock.closeGroup(api.id) },
    /* ── Side by side ──
       The dock's own rows, on a tab rather than in a menu behind the app's
       chrome, because a tab is the thing the reader is pointing at. On a phone a
       split is a column the fold-back takes away in the next microtask, so the
       rows are not offered — the same answer the palette gives. */
    ...(isMobile
      ? []
      : ([
          { type: "separator" },
          {
            label: "Split right",
            shortcut: "splitRight",
            /* A lone tab has nothing to leave behind — the move would make a
               new group and empty this one. */
            disabled: !hasOthers,
            onClick: () => dock.splitActive("right", api.id),
          },
          {
            label: "Split down",
            shortcut: "splitDown",
            disabled: !hasOthers,
            onClick: () => dock.splitActive("below", api.id),
          },
          /* One row, and it says which way it will go: filling a pair takes the
             fill away, so "Fill the dock" on an already-filled group would name
             the state it is about to leave. The chord toggles, because a key
             cannot know which of the two is true from where it fires. */
          {
            label: maximized ? "Restore the columns" : "Fill the dock",
            shortcut: "fillPanel",
            disabled: !hasOtherGroups,
            onClick: () => dock.toggleMaximize(api.id),
          },
        ] satisfies MenuItemSpec[])),
    /* The strip's two walking keys are not about *this* tab, but the menu is
       where a reader who has not found the sheet asks what the tabs answer to —
       and the row prints whatever chord they are bound to, so it cannot go
       stale the way a written-down one would. */
    { type: "separator" },
    {
      label: "Next tab",
      shortcut: "nextTab",
      disabled: !hasOthers,
      onClick: () => stepTabInGroup(api, 1),
    },
    {
      label: "Previous tab",
      shortcut: "prevTab",
      disabled: !hasOthers,
      onClick: () => stepTabInGroup(api, -1),
    },
    { type: "separator" },
    { label: pinned ? "Unpin" : "Pin", onClick: () => dock.togglePin(api.id) },
    /* ── Tab groups ──
       Dockview's own: a coloured chip over a run of tabs in this strip, which
       the chip renames, recolours and collapses. A tab joins one by its menu or
       by being dragged into the run. The menu lists this strip's groups only —
       a tab group never spans two strips. */
    {
      type: "sub",
      label: "Add to tab group",
      items: [
        { label: "New tab group", onClick: () => dock.addToTabGroup(api.id, null) },
        ...(tabGroups.groups.length > 0
          ? ([
              { type: "separator" },
              ...tabGroups.groups.map(
                (group): MenuItemSpec => ({
                  label: group.label,
                  hint: group.hint || undefined,
                  disabled: group.id === tabGroups.current,
                  onClick: () => dock.addToTabGroup(api.id, group.id),
                })
              ),
            ] satisfies MenuItemSpec[])
          : []),
      ],
    },
    ...(tabGroups.current
      ? ([{ label: "Remove from tab group", onClick: () => dock.removeFromTabGroup(api.id) }] satisfies MenuItemSpec[])
      : []),
    /* ── Open something *with* this tab ──
       Two ways, and the difference is whether you see both. "Terminal" joins
       this tab's tab group, right after it — one strip, one visible at a time.
       "Terminal below" / "… to the right" is a split beside this tab's strip,
       which is the only way to watch a shell and a transcript together; each
       kind keeps the side it already opens toward. The project is this tab's,
       not the one in front, and the destination travels with the call — the
       terminal is a server round trip away. No splits on a phone. */
    ...(onOpenPanel
      ? ([
          {
            type: "sub",
            label: "Open with this tab",
            items: [
              ...GROUPABLE.map(
                (kind): MenuItemSpec => ({
                  label: PANEL_SPECS[kind].defaultTitle,
                  onClick: () =>
                    onOpenPanel(kind, false, { into: { group: api.group.id, beside: api.id }, projectId }),
                })
              ),
              ...(isMobile
                ? []
                : ([
                    { type: "separator" },
                    ...GROUPABLE.map(
                      (kind): MenuItemSpec => ({
                        label: `${PANEL_SPECS[kind].defaultTitle} ${kind === "terminal" ? "below" : "to the right"}`,
                        onClick: () =>
                          onOpenPanel(kind, false, {
                            into: { group: api.group.id, split: kind === "terminal" ? "below" : "right" },
                            projectId,
                          }),
                      })
                    ),
                  ] satisfies MenuItemSpec[])),
            ],
          },
        ] satisfies MenuItemSpec[])
      : []),
    /* ── The bottom panel ──
       A strip along the bottom of the dock (dockview's edge group) that
       collapses to its tabs — somewhere a terminal can sit under every column
       at once. Sent there by name only; nothing opens there. The way back is
       never withheld, phone included, because a narrow window folds it. */
    ...(inBottom
      ? ([{ label: "Move to the main area", onClick: () => dock.moveToMain(api.id) }] satisfies MenuItemSpec[])
      : isMobile
        ? []
        : ([{ label: "Move to the bottom panel", onClick: () => dock.moveToBottom(api.id) }] satisfies MenuItemSpec[])),
    ...(isMobile
      ? []
      : ([
          { label: "Move to a floating window", onClick: () => dock.toggleFloat(api.id) },
          {
            label: "Open in a new window",
            onClick: () => {
              void dock.popoutPanel(api.id).then((opened) => {
                /* A blocked popup is silent otherwise — the click appears to do
                   nothing at all, which reads as a broken menu item rather than
                   as a browser setting the user can change. */
                if (!opened) toast.error("The browser blocked the new window")
              })
            },
          },
        ] satisfies MenuItemSpec[])),
    /* The project's saved shell lines, on the tab of a thread that belongs to
       it: a helper acts on one project, and which project that is, is a fact
       about this tab. A helper runs in a terminal panel, so the dock is already
       the thing it needs. */
    ...(project?.helpers?.length
      ? ([
          { type: "separator" },
          {
            type: "sub",
            label: "Project commands",
            hint: `Saved shell lines for ${project.name}`,
            items: [
              ...project.helpers.map(
                (helper): MenuItemSpec => ({
                  label: helper.name,
                  onClick: () => void runHelper(helper, project.id),
                })
              ),
              { type: "separator" },
              {
                label: "Manage helpers…",
                onClick: () => void navigate(settingsFormPath("projects", project.id)),
              },
            ],
          },
        ] satisfies MenuItemSpec[])
      : []),
    { type: "separator" },
    /* A tab is an isolated outlet, so the same place may stand in two of them. */
    {
      label: "Duplicate tab",
      disabled: descriptor?.kind !== "chat" && descriptor?.kind !== "page",
      onClick: () => {
        if (descriptor?.kind === "chat") dock.openTab(threadPath(descriptor.sessionId))
        else if (descriptor?.kind === "page") dock.openTab(descriptor.path)
      },
    },
    {
      label: "Copy link",
      disabled: descriptor?.kind !== "chat",
      onClick: () => {
        if (descriptor?.kind !== "chat") return
        writeClipboard(new URL(threadPath(descriptor.sessionId), window.location.origin).toString())
          .then(() => toast.success("Link copied"))
          .catch((err) => reportError(err, `Couldn't copy the link to ${title}`))
      },
    },
  ]
}
