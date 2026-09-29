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
   one is doing (`panel-status`) rather than only what it is called. */
import * as React from "react"
import type { IDockviewHeaderActionsProps, IDockviewPanel } from "dockview-react"
import { ChevronDownIcon, LayoutGrid, PinIcon, PlusIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useIsMobile } from "@/hooks/use-device"
import { STRIP_GROUND } from "@/lib/header-chrome"
import { MENU_ROW, MENU_WIDTH, MenuRow } from "@/components/menu-row"
import { PANEL_ICONS } from "@/components/workspace/panel-kinds"
import { PanelStatusDot } from "@/components/workspace/panel-status-dot"
import { LAYOUT_PRESETS, WorkspacePanelItems } from "@/components/workspace/panel-items"
import { useDock, useDockOpeners } from "@/components/workspace/dock-context"
import { usePanelPinned } from "@/lib/workspace/panel-pins"
import { usePanelStatus } from "@/lib/workspace/panel-status"
import { PANEL_SPECS, isPanelKind } from "@/lib/workspace/panels"
import { cn } from "@/lib/utils"

/** Below this many tabs the strip shows them all, and a list of what you can
    already see is a button that does nothing for you. A phone's bar is two: its
    strip is the one tab you are on, so with a second tab open the list is the
    only place that one is by name — which is what makes it the switcher. */
const LIST_FROM = 3

/* The strip's own two controls: bare glyphs, like the header's (`HEADER_CHIP`
   beside them) and like the tab's mark, on the one line-height everything in a
   strip takes (`--dock-chip-h` in `index.css`). They were `size-6` in a 32px
   bar — a 24px target to hit for the two controls a strip is used through, and
   the third height in a row that had one. */
const STRIP_CONTROL = cn(
  "size-[var(--dock-chip-h)] rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
  /* On a phone they wear the header controls' ground for the same reason those
     do — the strip is an overlay over a moving transcript there. One recipe,
     named once (`lib/header-chrome.ts`). */
  STRIP_GROUND
)

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
      className={cn("gap-2", active && "bg-accent/60")}
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
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Open something in this group"
                      className={STRIP_CONTROL}
                    >
                      <PlusIcon className="size-3.5" />
                    </Button>
                  }
                />
              }
            />
            <TooltipContent side="bottom">New thread or panel</TooltipContent>
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
      {!isMobile && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Arrange this dock"
                      className={STRIP_CONTROL}
                    >
                      <LayoutGrid className="size-3.5" />
                    </Button>
                  }
                />
              }
            />
            <TooltipContent side="bottom">Layout</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className={MENU_WIDTH}>
            {LAYOUT_PRESETS.map(({ id, label, Icon }) => (
              <DropdownMenuItem
                key={id}
                onClick={() => dock.applyPreset(id)}
                className={MENU_ROW}
              >
                <MenuRow icon={<Icon />} label={label} />
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {/* Below `LIST_FROM` the list is a button that does nothing for you — the
          tabs are all on screen. On a phone the strip is the one tab you are on
          and nothing else, so the list is the switcher from two tabs up: it is
          the only place the other one is, by name. The + stays either way, which
          is the whole reason this row no longer returns null. */}
      {panels.length >= (isMobile ? 2 : LIST_FROM) && (
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="All tabs in this group"
                    className={STRIP_CONTROL}
                  >
                    <ChevronDownIcon className="size-3.5" />
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
          className="w-auto max-w-[min(22rem,calc(100vw-1.5rem))] min-w-56"
        >
          {panels.map((panel) => (
            <TabRow key={panel.id} panel={panel} onClose={() => void dock.closePanel(panel.id)} />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      )}
    </div>
  )
}
