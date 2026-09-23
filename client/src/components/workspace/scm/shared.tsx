/* ── The vocabulary source control is read in ──
   What every part of the view agrees on: what a repository's read is worth so
   far, and the one icon button the toolbar, the header and the rows all use.
   Nothing here talks to the server and nothing here holds state.

   What a *row* is no longer lives here: the four-groups-of-rows model it used
   to describe is gone, and one entry per path with a staged tri-state is
   `lib/workspace/working-set.ts`. */
import * as React from "react"
import { PlusSignIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useCoarsePointer } from "@/hooks/use-device"
import { cn } from "@/lib/utils"
import type { GitStatus } from "@/lib/workspace/git-api"

export interface RepoState {
  status: GitStatus | null
  error: string | null
  loading: boolean
}

/** An icon button with its label as a tooltip — the row actions are icon-only
    for room, and an icon with no name is a guess. The tap target is 44px on a
    finger and 24px with a mouse; both draw the same 14px glyph, so the row's
    rhythm does not change with the pointer. */
export function IconAction({
  label,
  icon,
  onClick,
  disabled,
  className,
  variant = "ghost",
}: {
  label: string
  icon: typeof PlusSignIcon
  onClick: () => void
  disabled?: boolean
  className?: string
  variant?: React.ComponentProps<typeof Button>["variant"]
}) {
  const coarse = useCoarsePointer()
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={variant}
            size="icon-xs"
            disabled={disabled}
            onClick={onClick}
            aria-label={label}
            className={cn(coarse ? "size-11" : "size-6", className)}
          >
            <HugeiconsIcon icon={icon} strokeWidth={2} className="size-3.5" />
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
