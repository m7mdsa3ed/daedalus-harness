/* ── Nothing here yet ──
   The dashed box a surface draws when it has nothing to show — a list that is
   empty, a scan that found nothing, a filter that matched none of it. One box
   in the two densities the app actually uses:

   It is the registry's `Empty` with its dashed edge switched on (`border`):

   — `sm` is the one *inside a surface* — a card, a panel, a section's body,
     a picker: a compact line of text with a dashed edge, no glyph. It is a
     placeholder in a layout rather than a destination, so it stays small;
   — `lg` is the one *on the page ground*, standing alone where a list with no
     rows at all would be (no table, no toolbar, never inside a card): the
     stock padding, the stock icon tile, and, where the emptiness is a dead
     end, an action to get out of it.

   A filter that matched nothing is neither: it is `DataTableEmpty`, inside
   the table. A popover or menu says it in a muted line. Pass no `border-0`:
   the dashed edge is what makes it an absence.

   The dashed edge is the whole vocabulary: a solid box is content, a dashed one
   is the absence of it. Nothing here is an alert — an empty state says "there is
   nothing", a `Notice` says "something happened" — so the two never share a
   component even though both are bordered boxes. */
import * as React from "react"

import {
  Empty as EmptyRoot,
  EmptyContent,
  EmptyDescription,
  EmptyMedia,
} from "@/components/ui/empty"
import { cn } from "@/lib/utils"

export interface EmptyProps extends React.ComponentProps<"div"> {
  size?: "sm" | "lg" | null
  /** A glyph above the words. Usually only the `lg` box has one. */
  icon?: React.ElementType
  /** The way out, where the emptiness is a dead end (a filter that matched
      nothing, a list with an obvious first entry to add). */
  action?: React.ReactNode
}

export function Empty({
  size = "sm",
  icon: Icon,
  action,
  className,
  children,
  ...props
}: EmptyProps) {
  const lg = size === "lg"
  return (
    <EmptyRoot
      className={cn("flex-none border", lg ? "gap-3 p-12" : "gap-2 p-4", className)}
      {...props}
    >
      {Icon &&
        (lg ? (
          <EmptyMedia variant="icon" className="mb-0">
            <Icon aria-hidden />
          </EmptyMedia>
        ) : (
          <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        ))}
      <EmptyDescription className="text-pretty">{children}</EmptyDescription>
      {action && <EmptyContent>{action}</EmptyContent>}
    </EmptyRoot>
  )
}
