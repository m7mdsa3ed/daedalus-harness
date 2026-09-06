/* `CommandInput` with a slot before the caret.

   The palette has pages, so which list you are typing into has to be visible
   rather than inferred from what it contains — that breadcrumb chip sits
   between the magnifier and the caret, inside the input row and so out of
   reach of any wrapper. It used to be a `prefix` prop patched into
   `ui/command.tsx`, and a `shadcn add command` took it back out. So it is a
   copy of that component with the one slot added, living here where a
   re-install cannot reach it. Keep it in step with `ui/command.tsx`'s own
   `CommandInput`; nothing but the addon's children differs. */
import type * as React from "react"
import { Command as CommandPrimitive } from "cmdk"

import { cn } from "@/lib/utils"
import { HugeiconsIcon } from "@hugeicons/react"
import { SearchIcon } from "@hugeicons/core-free-icons"

export function PaletteInput({
  className,
  prefix,
  ...props
}: Omit<React.ComponentProps<typeof CommandPrimitive.Input>, "prefix"> & {
  /** Drawn between the magnifier and the caret. */
  prefix?: React.ReactNode
}) {
  return (
    <div
      data-slot="command-input-wrapper"
      className="flex h-9 items-center gap-2 border-b px-3"
    >
      <HugeiconsIcon icon={SearchIcon} strokeWidth={2} className="size-4 shrink-0 opacity-50" />
      {prefix}
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
    </div>
  )
}
