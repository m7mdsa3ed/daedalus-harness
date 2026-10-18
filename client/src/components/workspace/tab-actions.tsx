/* The right-hand end of a tab strip: the + and the group's tab list.

   The + is back, and it is the browser's affordance — the one control every tab
   strip has ever had, at the end of the tabs, where a reader who wants another
   one looks first. It went to the app header once because a split dock has one
   per group with no obvious answer to which you press; the answer it has now is
   that there is no ambiguity to resolve — a + on *this* strip opens into *this*
   group, which is the same thing every tab beside it is about. Its rows are
   `WorkspacePanelItems`, the header menu's own, so the two cannot drift; the
   openers come down through the dock (`useDockOpeners`) because which project a
   panel belongs to is `app-shell`'s answer, not a strip's.

   The layout button is the + for arrangement: it deals the dock's tabs into a
   preset (`LAYOUT_PRESETS`, the Layouts menu's own list). Not on a phone,
   which folds every split back into one strip.

   The tab list is the opposite case, and belongs here for the same reason the +
   does not: it is *about this group*. Once tabs stop fitting, the strip scrolls
   and the tab you want is off the end of a row with no scrollbar to speak of —
   so the list is the way back to a panel you cannot see, and it says what each
   one is doing (`panel-status`) rather than only what it is called. It also
   carries the group's own **Close all** at its foot, so tidying a strip is not a
   hunt through one tab's ⋮ menu — and the phone's grid carries the same row. */
import * as React from "react"
import type { IDockviewHeaderActionsProps, IDockviewPanel } from "dockview-react"
import { ChevronDownIcon, HistoryIcon, LayoutGrid, PinIcon, PlusIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useStoreSelect } from "@/lib/store"
import { useIsMobile } from "@/hooks/use-device"
import { HEADER_CHIP } from "@/lib/header-chrome"
import { MENU_ROW, MENU_WIDTH, MenuRow } from "@/components/menu-row"
import { PANEL_ICONS, PanelIcon } from "@/components/workspace/panel-kinds"
import { PanelStatusDot } from "@/components/workspace/panel-status-dot"
import type { PresetId } from "@/components/workspace/dock-context"
import { LAYOUT_PRESETS, WorkspacePanelItems } from "@/components/workspace/panel-items"
import { descriptorOf, useDock, useDockOpeners } from "@/components/workspace/dock-context"
import { useOpenThreads } from "@/lib/workspace/open-threads"
import { activityAt, isListed, relativeAge } from "@/lib/settings"
import { usePanelPinned } from "@/lib/workspace/panel-pins"
import { usePanelStatus } from "@/lib/workspace/panel-status"
import { PANEL_SPECS, isPanelKind } from "@/lib/workspace/panels"
import { cn } from "@/lib/utils"

/** Below this many tabs the strip shows them all, and a list of what you can
    already see is a button that does nothing for you. A phone's bar is two: its
    strip is the one tab you are on, so with a second tab open the list is the
    only place that one is by name — which is what makes it the switcher. */
const LIST_FROM = 3

/** Fired by a downward drag on the phone strip (`dock-surface.tsx`). */
export const TAB_GRID_EVENT = "daedalus:tab-grid"

/* The strip's own two controls are the sidebar toggle, exactly: the same
   ghost `Button` at `icon-sm`, the same `HEADER_CHIP` (round, `ring-edge` +
   `shadow-glass`, the composer's ground on a phone), the same foreground glyph
   at 16px. One recipe, so the toggle, the + and the switcher cannot drift. */
const STRIP_CONTROL = HEADER_CHIP

function TabRow({ panel, onClose }: { panel: IDockviewPanel; onClose: () => void }) {
  const kind = panel.api.component
  const Icon = isPanelKind(kind) ? PANEL_ICONS[kind] : null
  const title = panel.title ?? (isPanelKind(kind) ? PANEL_SPECS[kind].defaultTitle : "Panel")
  const status = usePanelStatus(panel.id)
  const pinned = usePanelPinned(panel.id)
  const active = panel.api.isActive

  return (
    <DropdownMenuItem
      onClick={() => panel.api.setActive()}
      /* What the ✕ beside the row does, for the reader who arrowed here rather
         than pointed at it — the same key the tab strip itself answers to. */
      onKeyDown={(event) => {
        if (pinned || event.key !== "Delete") return
        event.preventDefault()
        onClose()
      }}
      /* The row for the tab you are already on. `aria-current` and not
         `aria-selected`: this is a menu, and a menu row that says "selected"
         claims a state a `menuitem` does not have. The tint is the same fact
         for a reader who is looking rather than listening. */
      aria-current={active ? "true" : undefined}
      className={cn("gap-2 max-md:min-h-11", active && "bg-accent/60")}
    >
      {Icon && <Icon className="text-muted-foreground" />}
      <span className={cn("min-w-0 flex-1 truncate", status?.tone === "running" && "harness-shimmer")}>{title}</span>
      {pinned && <PinIcon aria-label="Pinned" className="size-3 shrink-0 text-muted-foreground" />}
      <PanelStatusDot status={status} />
      {/* Closing from the list, so a tab that has scrolled out of the strip can
          be got rid of without being brought back into it first. Pinned rows
          keep the pin instead — the same trade the tab itself makes.

          `tabIndex={-1}` for the reason the tab's own controls carry it: a
          focusable child of a `menuitem` is a second stop inside a widget whose
          arrow keys own the movement. It keeps its name, so it is still read
          out as part of the row and still reachable in a screen reader's browse
          mode; the `Delete` above is the way to it from the arrow keys. */}
      {!pinned && (
        <Button
          size="icon-xs"
          variant="ghost"
          tabIndex={-1}
          aria-label={`Close ${title}`}
          className="-mr-1 size-5 opacity-60 hover:opacity-100"
          onClick={(event) => {
            event.stopPropagation()
            event.preventDefault()
            onClose()
          }}
        >
          <XIcon className="size-3" />
        </Button>
      )}
    </DropdownMenuItem>
  )
}

/* The phone's switcher, Chrome Android's: the strip's button is a rounded square
   holding the tab count, and it opens a full panel of rows. */
function TabGrid({
  panels,
  onClose,
  onCloseAll,
  onNew,
  onOpenThread,
}: {
  panels: IDockviewPanel[]
  onClose: (id: string) => void
  onCloseAll: () => void
  onNew?: () => void
  onOpenThread: (id: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  /* Recents, as the sidebar draws them: listed threads with no tab open, newest
     activity first. Only read while the grid is open. */
  const sessions = useStoreSelect((state) => state.sessions)
  const openIds = useOpenThreads()
  const recent = React.useMemo(() => {
    if (!open) return []
    const taken = new Set(openIds)
    return sessions
      .filter((s) => isListed(s) && !s.deletedAt && !taken.has(s.id))
      .sort((a, b) => activityAt(b) - activityAt(a))
      .slice(0, 6)
  }, [open, sessions, openIds])
  /* The strip's drag-down (`dock-surface.tsx`) opens the same grid. */
  React.useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener(TAB_GRID_EVENT, show)
    return () => window.removeEventListener(TAB_GRID_EVENT, show)
  }, [])
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            title={`Switch tabs (${panels.length})`}
            aria-label={`Switch tabs, ${panels.length} open`}
            className={STRIP_CONTROL}
          />
        }
      >
        {/* The count is the glyph: bare, like the toggle's icon, never a tile. */}
        <span className="text-[13px] leading-none font-semibold tabular-nums">{panels.length}</span>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="flex h-[calc(var(--float-h)-1rem)] w-[calc(var(--float-w)-1rem)] max-w-none flex-col gap-0 overflow-hidden p-0"
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border/60 py-2.5 pr-2 pl-4">
          <DialogTitle className="text-base font-semibold tracking-tight">Tabs</DialogTitle>
          <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[11px] leading-none font-semibold text-muted-foreground tabular-nums">
            {panels.length}
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            {/* The same tidy-up the desktop list carries, for the strip a phone
                folds to one tab: the grid is the only place the others are, so it
                is the only place the group can be closed from. Closing the grid
                first keeps the panel from standing over a dock that is now empty. */}
            {panels.length > 1 && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  onCloseAll()
                }}
                className="rounded-full px-3 py-1.5 text-[13px] font-medium text-muted-foreground active:bg-foreground/10"
              >
                Close all
              </button>
            )}
            <DialogClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close tabs"
                  className="text-muted-foreground"
                />
              }
            >
              <XIcon className="size-4" />
            </DialogClose>
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-2 py-2">
          {panels.map((panel) => (
            <TabCard key={panel.id} panel={panel} onPick={() => setOpen(false)} onClose={() => onClose(panel.id)} />
          ))}
          {recent.length > 0 && (
            <>
              <div className="mt-3 flex h-6 items-center gap-1.5 px-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                <HistoryIcon className="size-3" />
                Recent
              </div>
              {recent.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    onOpenThread(s.id)
                  }}
                  className="flex min-h-11 items-center gap-2 rounded-xl px-3 text-left active:bg-foreground/5"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px]">{s.title || "Untitled thread"}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {relativeAge(activityAt(s))}
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
        {onNew && (
          <footer className="shrink-0 border-t border-border/60 p-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onNew()
              }}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-foreground/5 text-sm font-medium text-foreground active:bg-foreground/10"
            >
              <PlusIcon className="size-4" />
              New tab
            </button>
          </footer>
        )}
      </DialogContent>
    </Dialog>
  )
}

function TabCard({ panel, onPick, onClose }: { panel: IDockviewPanel; onPick: () => void; onClose: () => void }) {
  const kind = panel.api.component
  const Icon = isPanelKind(kind) ? PANEL_ICONS[kind] : null
  /* The *open* panel's mark, not the kind's: a chat wears its agent and its
     project, a page the mark its sidebar row wears — the same `PanelIcon` the
     tab in the strip carries, so a row and the tab it stands for agree. The kind
     glyph is the fallback for a panel whose params did not parse. */
  const descriptor = descriptorOf(panel)
  const title = panel.title ?? (isPanelKind(kind) ? PANEL_SPECS[kind].defaultTitle : "Panel")
  const status = usePanelStatus(panel.id)
  const pinned = usePanelPinned(panel.id)
  const active = panel.api.isActive
  return (
    <div
      className={cn(
        "flex min-h-12 items-center rounded-xl transition-colors",
        active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "active:bg-foreground/5"
      )}
    >
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        onClick={() => {
          panel.api.setActive()
          onPick()
        }}
        className="flex min-h-12 min-w-0 flex-1 items-center gap-2.5 pr-1 pl-3 text-left"
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {descriptor ? <PanelIcon panel={descriptor} className="size-4" /> : Icon && <Icon className="size-4 text-muted-foreground" />}
        </span>
        <span className={cn("min-w-0 flex-1 truncate text-[13px]", status?.tone === "running" && "harness-shimmer")}>
          {title}
        </span>
        <PanelStatusDot status={status} />
      </button>
      {/* Pinned rows keep the pin instead of a ✕ — the trade the strip's own list
          makes too. The ✕ stands *beside* the switch button rather than inside
          it, so closing a tab never switches to it on the way out. */}
      {pinned ? (
        <PinIcon aria-label="Pinned" className="mr-3 size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <button
          type="button"
          aria-label={`Close ${title}`}
          onClick={onClose}
          className={cn(
            "mr-1.5 grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground active:bg-foreground/10",
            active && "text-sidebar-accent-foreground/70"
          )}
        >
          <XIcon className="size-4" />
        </button>
      )}
    </div>
  )
}

/** The layout menu: it arranges the whole dock, so it stands once in the app
    header beside the sidebar toggle rather than in every strip. */
export function LayoutMenu({ onPick, className }: { onPick: (preset: PresetId) => void; className?: string }) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button size="icon-xs" variant="ghost" aria-label="Arrange this dock" className={className}>
                  <LayoutGrid className="size-3.5" />
                </Button>
              }
            />
          }
        />
        <TooltipContent side="bottom">Layout</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className={MENU_WIDTH}>
        {LAYOUT_PRESETS.map(({ id, label, Icon }) => (
          <DropdownMenuItem key={id} onClick={() => onPick(id)} className={MENU_ROW}>
            <MenuRow icon={<Icon />} label={label} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TabActions({ panels, group }: IDockviewHeaderActionsProps) {
  const dock = useDock()
  const { onNewTab, onOpenPanel } = useDockOpeners()
  const isMobile = useIsMobile()

  /* ── One gutter in the row ──
     Everything standing in a strip keeps the same 4px between it and its
     neighbour: two tabs are their own `mx-0.5` twice over, so these pay the
     other half of it against the last tab (`pl-0.5`) and a full one between
     themselves (`gap-1`). They used to be flush — two 28px targets with no
     seam, reading as one wide control — while the tabs beside them were
     spaced, which is the inconsistency this is. */
  return (
    <div className="flex h-full items-center gap-1 pl-0.5">
      {onNewTab && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Open something in this group"
                      className={STRIP_CONTROL}
                    >
                      <PlusIcon className="size-4" />
                    </Button>
                  }
                />
              }
            />
            <TooltipContent side="bottom">New tab</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className={MENU_WIDTH}>
            {/* Flat: the + already asked "open what?", so answering with one
                row and a submenu is a hop for nothing. The rows themselves are
                the header menu's, unchanged. */}
            <WorkspacePanelItems
              flat
              onNewTab={() => {
                dock.targetNext(group.id)
                onNewTab()
              }}
              /* Said, not aimed: the terminal behind this is a round trip away,
                 and the strip goes along with it. */
              onOpen={(kind) => onOpenPanel?.(kind, false, { into: { group: group.id } })}
              canOpenPanels={!!onOpenPanel}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {/* Below `LIST_FROM` the list is a button that does nothing for you — the
          tabs are all on screen. On a phone the strip is the one tab you are on
          and nothing else, so the list is the switcher from two tabs up: it is
          the only place the other one is, by name. The + stays either way, which
          is the whole reason this row no longer returns null. */}
      {isMobile && (
        <TabGrid
          panels={panels}
          onClose={(id) => void dock.closePanel(id)}
          onCloseAll={() => panels[0] && void dock.closeGroup(panels[0].id)}
          onOpenThread={(id) => dock.openChat(id, { newTab: true, into: { group: group.id } })}
          onNew={
            onNewTab &&
            (() => {
              dock.targetNext(group.id)
              onNewTab()
            })
          }
        />
      )}
      {!isMobile && panels.length >= LIST_FROM && (
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="All tabs in this group"
                    className={STRIP_CONTROL}
                  >
                    <ChevronDownIcon className="size-4" />
                  </Button>
                }
              />
            }
          />
          <TooltipContent side="bottom">{panels.length} tabs</TooltipContent>
        </Tooltip>
        {/* Sized to its rows, not to the 24px button it hangs off — the same
            fix `workspace/panel-items` needed for the same reason. */}
        <DropdownMenuContent
          align="end"
          className="w-auto max-w-[min(22rem,calc(var(--float-w)-1.5rem))] min-w-56"
        >
          {panels.map((panel) => (
            <TabRow key={panel.id} panel={panel} onClose={() => void dock.closePanel(panel.id)} />
          ))}
          {/* The group's own close-all, at the foot of its list. The per-tab ⋮
              carries the same row; a reader tidying a strip should not have to
              open one tab's menu to close the rest of them. It closes the tabs
              of *this* strip — the +'s own group — and steps over pinned tabs,
              exactly as the row in the tab menu does. Named for a lone tab it
              is meaningless, so it is disabled rather than hidden: a list whose
              actions move as tabs close is worse than a row that says "not yet". */}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={panels.length < 2}
            onClick={() => panels[0] && void dock.closeGroup(panels[0].id)}
            className={MENU_ROW}
          >
            <MenuRow icon={<XIcon />} label="Close all" />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      )}
    </div>
  )
}
