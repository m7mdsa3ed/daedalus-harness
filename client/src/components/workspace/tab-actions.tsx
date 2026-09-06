/* The right-hand end of a tab strip: the group's tab list, and nothing else.

   The + moved to the app header (`workspace/panel-items`), because a per-group
   copy meant a split dock had two of them with no obvious answer to which one
   you press, and the strip is the first thing to get cramped on a narrow screen
   — which is exactly where an affordance for opening panels matters most, there
   being no keyboard. Split went the other way and simply left: the strip stands
   in the app header's own band now, where every pixel is shared with the app's
   controls, and splitting is asked for by name in the palette (which says which
   group it means) or by its chord.

   The tab list is the opposite case, and belongs here for the same reason the +
   does not: it is *about this group*. Once tabs stop fitting, the strip scrolls
   and the tab you want is off the end of a row with no scrollbar to speak of —
   so the list is the way back to a panel you cannot see, and it says what each
   one is doing (`panel-status`) rather than only what it is called. */
import * as React from "react"
import type { IDockviewHeaderActionsProps, IDockviewPanel } from "dockview-react"
import { ChevronDownIcon, PinIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { PANEL_ICONS } from "@/components/workspace/panel-kinds"
import { PanelStatusDot } from "@/components/workspace/panel-status-dot"
import { useDock } from "@/components/workspace/dock"
import { usePanelPinned } from "@/lib/workspace/panel-pins"
import { usePanelStatus } from "@/lib/workspace/panel-status"
import { PANEL_SPECS, isPanelKind } from "@/lib/workspace/panels"
import { cn } from "@/lib/utils"

/** Below this many tabs the strip shows them all, and a list of what you can
    already see is a button that does nothing for you. */
const LIST_FROM = 3

function TabRow({ panel, onClose }: { panel: IDockviewPanel; onClose: () => void }) {
  const kind = panel.api.component
  const Icon = isPanelKind(kind) ? PANEL_ICONS[kind] : null
  const title = panel.title ?? (isPanelKind(kind) ? PANEL_SPECS[kind].defaultTitle : "Panel")
  const status = usePanelStatus(panel.id)
  const pinned = usePanelPinned(panel.id)

  return (
    <DropdownMenuItem
      onClick={() => panel.api.setActive()}
      className={cn("gap-2", panel.api.isActive && "bg-accent/60")}
    >
      {Icon && <Icon className="text-muted-foreground" />}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {pinned && <PinIcon className="size-3 shrink-0 text-muted-foreground" />}
      <PanelStatusDot status={status} />
      {/* Closing from the list, so a tab that has scrolled out of the strip can
          be got rid of without being brought back into it first. Pinned rows
          keep the pin instead — the same trade the tab itself makes. */}
      {!pinned && (
        <Button
          size="icon-xs"
          variant="ghost"
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
  /* Below `LIST_FROM` there is nothing here at all — no split button any more,
     so the row is the list or it is empty. Splitting is the palette's row and
     its chord: a button that has to be reached for in a strip that is now the
     app header's own band was the widest thing in it and the least asked for. */
  if (panels.length < LIST_FROM) return null

  return (
    <div className="flex h-full items-center gap-0.5 pr-1 pl-0.5">
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
    </div>
  )
}
