/* The dot a panel's reading is drawn as — on its tab, and in the group's tab
   list. One component so a status cannot mean one colour in the strip and
   another in the dropdown.

   A dot and a title, not a word: a tab strip has room for one glyph, and the
   whole reading is in the `title`/`aria-label`, which is where a pointer and a
   screen reader both look. Each tone borrows the colour the rest of the app
   already gives that meaning, so a tab agrees with the sidebar row beside it. */
import type * as React from "react"

import type { PanelStatus, PanelTone } from "@/lib/workspace/panel-status"
import { cn } from "@/lib/utils"

const TONES: Record<PanelTone, string> = {
  /* Working. Pulsed rather than static: a turn that is streaming and a turn
     that stopped mid-stream would otherwise look identical. */
  running: "bg-primary animate-pulse",
  /* Waiting on the user — the one reading worth interrupting for. The same
     amber every other surface uses for it (the sidebar row, the composer). */
  attention: "bg-amber-500",
  warn: "bg-destructive",
  /* Unsaved work: present, not urgent. Hollow, like every other dirty mark. */
  dirty: "border border-current bg-transparent",
}

/* The `role`/`aria-label` pair is the default and not a fixture: on a tab the
   reading is already folded into the tab's own accessible name
   (`useTabLabel`), and a live region *inside* `role="tab"` is both invalid
   ARIA and a strip that talks over itself — so that caller passes
   `aria-hidden role={undefined}` and the rest keep the announcement. Spread
   last, which is what makes overriding them possible at all. */
export function PanelStatusDot({
  status,
  className,
  ...props
}: {
  status: PanelStatus | null
} & React.ComponentProps<"span">) {
  if (!status) return null
  return (
    <span
      role="status"
      aria-label={status.label}
      title={status.label}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        TONES[status.tone],
        // A pulse nobody asked for: the tone still says "running" by colour.
        "motion-reduce:animate-none",
        className
      )}
      {...props}
    />
  )
}
