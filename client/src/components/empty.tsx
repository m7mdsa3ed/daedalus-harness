/* ── Nothing here yet ──
   The dashed box a surface draws when it has nothing to show — a list that is
   empty, a scan that found nothing, a filter that matched none of it. One box
   in the two densities the app actually uses:

   — `sm` is the inline one, inside a settings form or a picker: a rounded-lg
     line of text with a dashed edge, no glyph. It is a placeholder *in a
     layout* rather than a destination, so it stays small;
   — `lg` is the page one: rounded-xl, a glyph, room to breathe and, where the
     emptiness is a dead end, an action to get out of it (`EmptyCard` is this
     size, and has been for a while — it now delegates here rather than being a
     second spelling of the same box).

   The dashed edge is the whole vocabulary: a solid box is content, a dashed one
   is the absence of it. Nothing here is an alert — an empty state says "there is
   nothing", a `Notice` says "something happened" — so the two never share a
   component even though both are bordered boxes. */
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const emptyVariants = cva(
  "flex flex-col items-center border border-dashed text-center text-muted-foreground",
  {
    variants: {
      size: {
        sm: "gap-1.5 rounded-lg px-3 py-4 text-xs",
        lg: "gap-3 rounded-xl px-6 py-12 text-sm",
      },
    },
    defaultVariants: {
      size: "sm",
    },
  }
)

export interface EmptyProps
  extends React.ComponentProps<"div">,
    VariantProps<typeof emptyVariants> {
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
  return (
    <div className={cn(emptyVariants({ size }), className)} {...props}>
      {Icon && (
        <Icon
          aria-hidden
          className={cn("shrink-0 text-muted-foreground/60", size === "lg" ? "size-6" : "size-4")}
        />
      )}
      <p className="text-pretty">{children}</p>
      {action}
    </div>
  )
}
