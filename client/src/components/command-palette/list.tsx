/* Drawing the rows `rank.ts` ordered. One `CommandGroup` per heading, one
   `CommandItem` per row — cmdk still owns selection and ↑/↓; it just does not
   own the filter any more. */
import * as React from "react"

import { CommandGroup, CommandItem, CommandShortcut } from "@/components/ui/command"
import { Shortcut } from "@/components/shortcut"
import { cn } from "@/lib/utils"

import { type PaletteItem, rankItems } from "./rank"

export type { PaletteItem }
export { rankItems }

export function ItemList({
  items,
  query,
  recents,
}: {
  items: PaletteItem[]
  query: string
  /** Command ids this device used, newest first. Only the root page has a
      stable command vocabulary to remember, so only it passes them. */
  recents?: string[]
}) {
  const groups = React.useMemo(() => rankItems(items, query, recents), [items, query, recents])
  return (
    <>
      {groups.map((group) => (
        <CommandGroup key={group.name} heading={group.name || undefined}>
          {group.items.map((item) => (
            <Row key={item.id} item={item} />
          ))}
        </CommandGroup>
      ))}
    </>
  )
}

export function Row({ item }: { item: PaletteItem }) {
  return (
    <CommandItem
      value={item.id}
      data-checked={item.checked}
      onSelect={item.onSelect}
      className={cn(item.className)}
    >
      {item.icon}
      {item.render ?? <span className="truncate">{item.title}</span>}
      {item.trailing}
      {item.chord && (
        <CommandShortcut>
          <Shortcut chord={item.chord} />
        </CommandShortcut>
      )}
    </CommandItem>
  )
}
