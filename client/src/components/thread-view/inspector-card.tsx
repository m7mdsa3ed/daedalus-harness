/* ── The inspector's card ──
   The one shape every reading of the thread inspector draws its sections in. */
import * as React from "react"

import { Card } from "@/components/ui/card"

/** A figure tile inside an `InspectorCard` body: its corner is the card's
    less the body's padding (`frame-2xl` / `frame-p-3` → `rounded-inner`). */
export const INSPECTOR_TILE = "rounded-inner bg-muted px-3 py-2"

/** One card of an inspector reading (Details, Workflow runs, …): a caption strip — its
    mark, its title and a hint at the end — over the card's body. The one
    shape, so every reading's cards are the same card. */
export function InspectorCard({
  title,
  icon,
  hint,
  children,
}: {
  title: React.ReactNode
  icon?: React.ReactNode
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Card size="sm" className="frame-2xl gap-0 py-0">
      <div className="flex min-w-0 items-center gap-2 border-b px-3 py-2">
        <h2 className="flex min-w-0 flex-1 items-center gap-2 text-xs font-medium text-muted-foreground [&_svg:not([class*='size-'])]:size-3">
          {icon}
          {title}
        </h2>
        {hint && <span className="shrink-0 truncate text-xs text-muted-foreground">{hint}</span>}
      </div>
      <div className="frame-p-3">{children}</div>
    </Card>
  )
}
