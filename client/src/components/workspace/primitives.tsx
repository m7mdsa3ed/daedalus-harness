import * as React from "react"

import { cn } from "@/lib/utils"

/** Shared chrome for compact workspace panels: the one strip of controls above a
    panel's body. Editors and terminal canvases remain edge-to-edge; only their
    controls use this rhythm.

    What a panel *says* is not here — a message is `components/notice.tsx` and an
    absence is `components/empty.tsx`, the app's two boxes, so a workspace panel
    reads like every other surface rather than like a second design language. */
export function PanelToolbar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-h-8 shrink-0 items-center gap-1 border-b px-2 py-1",
        className
      )}
      {...props}
    />
  )
}
