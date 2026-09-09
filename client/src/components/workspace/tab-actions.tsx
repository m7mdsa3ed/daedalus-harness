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

   Split went the other way and simply left: the strip stands in the app
   header's own band, where every pixel is shared with the app's controls, and
   splitting is asked for by name in the palette (which says which group it
   means) or by its chord.

   The tab list is the opposite case, and belongs here for the same reason the +
   does not: it is *about this group*. Once tabs stop fitting, the strip scrolls
   and the tab you want is off the end of a row with no scrollbar to speak of —
   so the list is the way back to a panel you cannot see, and it says what each
   one is doing (`panel-status`) rather than only what it is called. */
import * as React from "react"
import type { IDockviewHeaderActionsProps, IDockviewPanel } from "dockview-react"
import { ChevronDownIcon, PinIcon, PlusIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useIsMobile } from "@/hooks/use-device"
import { MENU_WIDTH } from "@/components/menu-row"
import { PANEL_ICONS } from "@/components/workspace/panel-kinds"
import { PanelStatusDot } from "@/components/workspace/panel-status-dot"
import { WorkspacePanelItems } from "@/components/workspace/panel-items"
import { useDock, useDockOpeners } from "@/components/workspace/dock"
import { usePanelPinned } from "@/lib/workspace/panel-pins"
import { usePanelStatus } from "@/lib/workspace/panel-status"
import { PANEL_SPECS, isPanelKind } from "@/lib/workspace/panels"
import { cn } from "@/lib/utils"

/** Below this many tabs the strip shows them all, and a list of what you can
    already see is a button that does nothing for you. A phone's bar is two: there
    the tabs are marks, half of them off the end of the strip, and the list is the
    only place every name is legible at once. */
const LIST_FROM = 3

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
      <span className="min-w-0 flex-1 truncate">{title}</span>
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

export function TabActions({ panels }: IDockviewHeaderActionsProps) {
  const dock = useDock()
  const { onNewTab, onOpenPanel } = useDockOpeners()
  const isMobile = useIsMobile()

  return (
    <div className="flex h-full items-center gap-0.5 pr-1 pl-0.5">
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
                      className="size-6 text-muted-foreground hover:text-foreground"
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
              onNewTab={onNewTab}
              onOpen={(kind) => onOpenPanel?.(kind)}
              canOpenPanels={!!onOpenPanel}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {/* Below `LIST_FROM` the list is a button that does nothing for you — the
          tabs are all on screen. On a phone the tabs are marks and half of them
          are off the end of a 360px strip, so the list is the switcher from two
          tabs up: it is the only place every thread's *name* is legible at once.
          The + stays either way, which is the whole reason this row no longer
          returns null. */}
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
                    className="size-6 text-muted-foreground hover:text-foreground"
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
