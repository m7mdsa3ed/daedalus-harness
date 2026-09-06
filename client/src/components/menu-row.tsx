/* ── One shape for a menu row ──
   Every row of the app header's menu — the workspace rows, the layouts, a
   project's helper commands, the thread's own actions, and every submenu
   trigger that opens onto them — is drawn by this. Before, each list built its
   own JSX: some icons were muted and some were not, one list wrote its label
   as a bare string and another wrapped it in a `truncate` span, hints existed
   only on the panel rows, and three submenus each picked their own width. The
   result was a menu whose rows changed shape as you walked down it.

   So the parts are stated once: a muted icon, a label that never wraps, an
   optional second line under it, and the trailing edge — a control or a chord.
   `MENU_ROW` is the class both `DropdownMenuItem` and `DropdownMenuSubTrigger`
   take so a trigger and an item are the same row, and `MENU_WIDTH` is the one
   answer to how wide a popup is, so a submenu is as wide as the menu that
   opened it.

   **A chord is only drawn where a chord can be pressed.** The keycaps are
   `useCoarsePointer`'s, the *device's* question, not `useIsMobile`'s width one:
   a narrow panel on a desktop still has a keyboard, and a tablet in landscape
   is wide and still has none. On a touch device the caps are not dimmed or
   shrunk, they are absent — they name a key that surface cannot offer. */
import * as React from "react"

import { Shortcut } from "@/components/shortcut"
import { useCoarsePointer } from "@/hooks/use-mobile"
import type { ShortcutId } from "@/lib/shortcuts"

/** The row's own metrics — `items-start` because a row may carry a hint, and a
    two-line row hangs its icon and its chord from the first line.

    The last selector is for a submenu trigger: the chevron the menu primitive
    appends is the row's only *direct* svg child (a `MenuRow` icon is wrapped),
    so it is the one thing `items-start` would hang off the first line when the
    row has two. Stated here rather than in the shadcn part, which stays
    stock. */
export const MENU_ROW =
  "items-start gap-2.5 py-2 [&>svg:last-child]:self-center [&>svg:last-child]:text-muted-foreground"

/** How wide a menu popup is. `w-auto` undoes the anchor-width sizing (the
    header's trigger is a 28px icon button, which would squeeze every row); the
    max is the escape hatch for a narrow phone, where a menu wider than the
    screen is clipped rather than merely wide. */
export const MENU_WIDTH = "w-auto max-w-[min(20rem,calc(100vw-1.5rem))] min-w-60"

export type MenuRowProps = {
  icon?: React.ReactNode
  label: string
  /** The second line: what the row does, for a name that cannot say it alone. */
  hint?: string
  /** A named binding, printed only where there are keys to press it with. */
  shortcut?: ShortcutId
  /** A control that belongs to the row rather than to the list — the delete on
      a saved layout. Sits before the chord; the two never both appear. */
  trailing?: React.ReactNode
}

/**
 * The inside of a row, for whichever menu part is holding it: put it in a
 * `DropdownMenuItem`, a `DropdownMenuSubTrigger` or a `ContextMenuItem` with
 * `className={MENU_ROW}` and the three read as one list.
 */
export function MenuRow({ icon, label, hint, shortcut, trailing }: MenuRowProps) {
  /* The device, not the width — see the note at the top of the file. */
  const coarse = useCoarsePointer()
  return (
    <>
      {icon && (
        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {icon}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate leading-5 whitespace-nowrap">{label}</span>
        {hint && (
          <span className="truncate text-xs leading-4 whitespace-nowrap text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground/70 group-focus/context-menu-item:text-accent-foreground/70">
            {hint}
          </span>
        )}
      </span>
      {trailing}
      {shortcut && !coarse && (
        <Shortcut id={shortcut} className="mt-0.5 ms-2 self-start" />
      )}
    </>
  )
}
