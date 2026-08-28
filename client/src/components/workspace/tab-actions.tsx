/* The right-hand end of a tab strip.

   Only the split action now: the + moved to the app header
   (`open-panel-menu`), because a per-group copy meant a split dock had two of
   them with no obvious answer to which one you press, and the strip is the
   first thing to get cramped on a narrow screen — which is exactly where an
   affordance for opening panels matters most, there being no keyboard. */
import type { IDockviewHeaderActionsProps } from "dockview-react"
import { SplitSquareHorizontalIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { KEYS, formatChord } from "@/lib/shortcuts"

export function makeTabActions({ onSplit }: { onSplit: () => void }) {
  return function TabActions({ group, containerApi }: IDockviewHeaderActionsProps) {
    /* Splitting a group with one tab in it would only move that tab into a new
       group and leave the old one empty, so the action is offered where it can
       actually do something — which also means a single-panel dock shows no
       chrome here at all. */
    const canSplit = group.panels.length > 1 || containerApi.panels.length > 1
    if (!canSplit) return null

    return (
      <div className="flex h-full items-center pr-1 pl-0.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Split right"
                className="size-6 text-muted-foreground hover:text-foreground"
                onClick={onSplit}
              >
                <SplitSquareHorizontalIcon className="size-3.5" />
              </Button>
            }
          />
          <TooltipContent side="bottom">Split right · {formatChord(KEYS.splitRight)}</TooltipContent>
        </Tooltip>
      </div>
    )
  }
}
