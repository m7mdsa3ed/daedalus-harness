/* ── "Open in new tab" and "Open to the side" ──
   The two rows every place-shaped surface outside the dock offers, written
   once. A sidebar row, a project folder, a settings section and a nav
   destination all stand for a place, and clicking one navigates the tab in
   front — that is what a tab is for, and it is not going to change. What the
   row could not say until now is *the other two shapes*: a tab of its own, or
   a column beside what you are reading.

   Both are the dock's, reached through the module store in
   `lib/workspace/open-threads` because none of these surfaces are in the dock's
   tree. A window without a dock (a popout, before ready) has neither answer, so
   the fallback is the navigation the click would have done.

   **`beside` is the caller's to refuse.** A phone folds every split back into
   one strip on the next layout change, so offering the row there would be a
   menu item that undoes itself; the surfaces that know the width say so. */
import { Columns2, SquareArrowOutUpRight } from "lucide-react"

import type { MenuItemSpec } from "@/components/item-context-menu"
import { navigateTo } from "@/lib/router"
import { openBeside, openInNewTab } from "@/lib/workspace/open-threads"

export function openInItems(path: string, options: { beside?: boolean } = {}): MenuItemSpec[] {
  return [
    {
      label: "Open in new tab",
      icon: <SquareArrowOutUpRight />,
      onClick: () => {
        if (!openInNewTab(path)) navigateTo(path)
      },
    },
    ...(options.beside === false
      ? []
      : ([
          {
            label: "Open to the side",
            icon: <Columns2 />,
            onClick: () => {
              if (!openBeside(path)) navigateTo(path)
            },
          },
        ] satisfies MenuItemSpec[])),
  ]
}
