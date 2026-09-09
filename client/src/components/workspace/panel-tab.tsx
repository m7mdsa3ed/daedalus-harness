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
   at. The project it runs in is NOT among them — that is the composer's scope
   band, where it is a name rather than a mark. Nor is the thread's context
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
import { PanelIcon } from "@/components/workspace/panel-kinds"
import { PanelStatusDot } from "@/components/workspace/panel-status-dot"
import { useDock } from "@/components/workspace/dock"
import { useIsMobile } from "@/hooks/use-mobile"
import { writeClipboard } from "@/lib/clipboard"
import { reportError } from "@/lib/errors"
import { useProjects } from "@/lib/queries/catalog"
import { settingsFormPath, threadPath } from "@/lib/router"
import { useSessionMeta } from "@/lib/store"
import { initialsOf } from "@/lib/tasks-view"
import { toast } from "@/lib/toast"
import { usePanelPinned } from "@/lib/workspace/panel-pins"
import { usePanelStatus } from "@/lib/workspace/panel-status"
import { useRunHelper } from "@/lib/workspace/use-run-helper"
import { PANEL_SPECS, isPanelKind, parsePanel } from "@/lib/workspace/panels"
import { cn } from "@/lib/utils"

type PanelApi = IDockviewPanelHeaderProps["api"]
type ContainerApi = IDockviewPanelHeaderProps["containerApi"]
type Descriptor = ReturnType<typeof parsePanel>

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
 * Dragging a tab between groups changes the siblings without adding or
 * removing a panel, which is why the layout event is in here too.
 */
function useTabNeighbours(
  api: PanelApi,
  containerApi: ContainerApi
): { hasOthers: boolean; hasRightward: boolean } {
  const [state, setState] = React.useState({ hasOthers: false, hasRightward: false })
  React.useEffect(() => {
    const sync = () => {
      const siblings = containerApi.getPanel(api.id)?.group.panels ?? []
      const index = siblings.findIndex((panel) => panel.id === api.id)
      setState({
        hasOthers: siblings.length > 1,
        hasRightward: index >= 0 && index < siblings.length - 1,
      })
    }
    sync()
    const disposables = [
      containerApi.onDidAddPanel(sync),
      containerApi.onDidRemovePanel(sync),
      containerApi.onDidLayoutChange(sync),
    ]
    return () => disposables.forEach((disposable) => disposable.dispose())
  }, [api, containerApi])
  return state
}

/** Dockview writes the plain title into the tab's `aria-label`; this puts back
    everything the face says and the name does not. Re-applied whenever any part
    of it changes, which is also what recovers it from dockview rewriting the
    label on its own `setTitle`. */
function useTabLabel(
  ref: React.RefObject<HTMLElement | null>,
  parts: Array<string | undefined | false>
): void {
  const label = parts.filter(Boolean).join(", ")
  React.useEffect(() => {
    tabElementOf(ref.current)?.setAttribute("aria-label", label)
  }, [ref, label])
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

export function PanelTab({ api, containerApi, params }: IDockviewPanelHeaderProps) {
  const dock = useDock()
  const ref = React.useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const compact = useIsMobile()

  const descriptor = parsePanel(api.component, params)
  const fallback = isPanelKind(api.component) ? PANEL_SPECS[api.component].defaultTitle : "Panel"
  const title = api.title ?? fallback

  const active = useTabActive(api)
  const pinned = usePanelPinned(api.id)
  const status = usePanelStatus(api.id)
  const neighbours = useTabNeighbours(api, containerApi)

  const close = React.useCallback(() => void dock.closePanel(api.id), [dock, api.id])

  useTabLabel(ref, [title, status?.label, pinned && "pinned"])
  useTabKeys(ref, { onClose: close, onMenu: () => setMenuOpen(true) })

  const items = useTabMenuItems({ api, dock, descriptor, title, pinned, ...neighbours })

  return (
    <ItemContextMenu items={items}>
      {/* Air on all four sides: the chip is a rounded surface *in* the strip,
          not a shape cut out of it, so it needs the room its corners imply. */}
      <div className="flex h-full min-w-0 flex-1 items-center p-0.5">
        <div
          /* The ref lives here and not on the box above, which is the one
             `ItemContextMenu` merges its trigger onto: a `render` prop composes
             refs, and a ref that has to resolve to find `.dv-tab` should not
             depend on another library getting that composition right. This
             element is ours alone and is still a descendant of the tab. */
          ref={ref}
          data-active={active || undefined}
          className={cn(
            /* `h-7` — the height of the sidebar toggle and the view-settings
               sliders beside it (`HEADER_CHIP`), because in the header's band
               all three stand on the same line: a tab shorter than the controls
               next to it reads as a strip tucked under the header rather than
               as the header's own row. */
            "dock-tab flex h-7 min-w-0 flex-1 items-center gap-1.5 px-2 text-xs",
            active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
          )}
        >
          <TabMark descriptor={descriptor} title={title} compact={compact} />
          {/* A grid of one column, because a grid column is the one width that
              animates to nothing: `index.css` takes it to `0fr` on a narrow
              strip's inactive tabs. `truncate` goes on the inner span — the
              grid item is what overflows. */}
          <span data-tab-title className="grid min-w-0 flex-1">
            <span title={title} className="truncate">
              {title}
            </span>
          </span>
          {/* What the panel is doing, for a panel you cannot see. Decorative
              here: the reading is folded into the tab's accessible name above,
              and a live region per tab inside `role="tab"` is both invalid and
              a strip that talks over itself. */}
          <PanelStatusDot status={status} aria-hidden role={undefined} />
          <span data-tab-controls className="flex shrink-0 items-center">
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

/**
 * The mark a tab wears.
 *
 * Wide, it is the panel's own (`PanelIcon`) — a chat's is its agent's, which is
 * what stops four threads from being four identical speech bubbles. Narrow, a
 * chat trades that for the **initials of its title**, because down there the
 * mark IS the tab and four threads on one runtime would otherwise be four
 * identical agent logos.
 *
 * Chosen in JS rather than by a CSS swap, and that is safe here for a reason
 * worth stating: the choice depends on the *viewport*, not on which tab is
 * active, so it changes on a resize and never on a click. (What a narrow strip
 * animates is the title, not the mark — see `index.css`.)
 */
function TabMark({
  descriptor,
  title,
  compact,
}: {
  descriptor: Descriptor
  title: string
  compact: boolean
}) {
  return (
    <span
      data-tab-mark
      aria-hidden
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded-[calc(var(--radius)*0.8)]",
        /* A tile only where the mark stands alone: beside a title it is a
           glyph, and a ground around it would be a button that is not one. */
        compact && "bg-foreground/[0.07]"
      )}
    >
      {compact && descriptor?.kind === "chat" ? (
        <span className="text-[11px] font-semibold tracking-tight">{initialsOf(title)}</span>
      ) : (
        <PanelIcon panel={descriptor} className="size-3.5" />
      )}
    </span>
  )
}

const TAB_CONTROL = "size-5 shrink-0 rounded-full text-muted-foreground hover:text-foreground"

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
}: {
  api: PanelApi
  dock: ReturnType<typeof useDock>
  descriptor: Descriptor
  title: string
  pinned: boolean
  hasOthers: boolean
  hasRightward: boolean
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

  return [
    /* Close comes first and names *this* tab, so a pinned panel still has a way
       out — the bulk closes below are the ones pinning is a defence against.
       Every tab closes, the last one included: an empty dock goes to the
       landing console (`dock.tsx`). */
    { label: "Close", onClick: () => void dock.closePanel(api.id) },
    { label: "Close others", disabled: !hasOthers, onClick: () => void dock.closeOthers(api.id) },
    {
      label: "Close to the right",
      disabled: !hasRightward,
      onClick: () => void dock.closeToTheRight(api.id),
    },
    { label: "Close group", disabled: !hasOthers, onClick: () => void dock.closeGroup(api.id) },
    { type: "separator" },
    { label: pinned ? "Unpin" : "Pin", onClick: () => dock.togglePin(api.id) },
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
