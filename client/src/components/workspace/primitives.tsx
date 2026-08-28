import * as React from "react"

import { cn } from "@/lib/utils"

/** Shared chrome for compact workspace panels. Editors and terminal canvases
    remain edge-to-edge; only their controls and messages use this rhythm. */
export function PanelToolbar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-h-8 shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1",
        className
      )}
      {...props}
    />
  )
}

export function PanelNotice({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      className={cn(
        "shrink-0 border-b border-border/60 bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

export function PanelEmptyState({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center text-xs text-muted-foreground sm:p-8",
        className
      )}
      {...props}
    />
  )
}
