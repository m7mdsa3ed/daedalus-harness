/**
 * One kind of tool as a submenu: the trigger that says how many of that kind
 * the thread carries, and the list behind it.
 *
 * Written once and invoked once per kind, because MCP servers, skills and
 * commands differ only in a title, an icon, a library and the one line each
 * entry prints under its name — everything else (what a draft may pick, what a
 * started thread lists, the counts, the locked profile rows) is the same
 * question three times. It is handed the thread's links for its own kind as a
 * set and a list rather than a `LinkKey`, so it never learns which one it is.
 */
import * as React from "react"

import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"

import { MenuSearchInput, menuFilter } from "@/components/config-menu"

import { ToolRow } from "./tool-row"

/** Past this many entries the submenu grows a filter box — the same threshold
    and the same box as the model and effort rows. */
const SEARCH_THRESHOLD = 8

export function ToolSection<T extends { id: string; name: string }>({
  title,
  icon,
  items,
  itemIcon,
  hint,
  inherited,
  own,
  editable,
  needsAuth,
  /** What this runtime does not read out of the workspace, in words ("skills"),
      or null when it reads this kind — see the menu, which decides it. */
  unreadable,
  /** Every item is available to invoke, without a per-thread selection. */
  alwaysAvailable = false,
  agentName,
  onToggle,
}: {
  title: string
  icon?: React.ReactNode
  items: T[]
  itemIcon?: (item: T) => React.ReactNode
  hint: (item: T) => string
  /** Linked by the profile: checked, locked, and not this menu's to clear. */
  inherited: Set<string>
  /** Linked by the thread itself. */
  own: string[]
  editable: boolean
  needsAuth: (item: { id: string }) => boolean
  unreadable: string | null
  alwaysAvailable?: boolean
  agentName: string | undefined
  onToggle: (id: string, on: boolean) => void
}) {
  /* A draft or an editable thread can pick from the catalog; a read-out only
     lists what the thread actually carries. */
  const shown = editable || alwaysAvailable
    ? items
    : items.filter((item) => inherited.has(item.id) || own.includes(item.id))
  if (!editable && !alwaysAvailable && shown.length === 0) return null
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  // The box is about *this* opening of the submenu, never the last one.
  React.useEffect(() => {
    if (!open) setQuery("")
  }, [open])
  const searchable = shown.length > SEARCH_THRESHOLD
  const matching = searchable
    ? menuFilter(
        shown.map((item) => ({ item, value: item.id, name: item.name, hint: hint(item) })),
        query
      ).map((row) => row.item)
    : shown
  const on = shown.filter((item) => inherited.has(item.id) || own.includes(item.id)).length
  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger className="gap-2.5">
        {icon}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {/* The count is the point of the row: it is what the flat menu made
            you open a group to learn. "2 of 9" while picking, a bare figure
            once the thread has spawned and the library is no longer a
            choice. It takes the label's leftover space rather than its own
            `ml-auto` — the trigger's chevron is the one auto margin, so the
            figures sit in a single column beside it instead of being pushed
            to a midpoint that depends on how wide each count happens to be. */}
        <span className="text-xs tabular-nums text-muted-foreground">
          {alwaysAvailable ? shown.length : editable ? (on === 0 ? `${shown.length}` : `${on} of ${shown.length}`) : on}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64">
        {unreadable && (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            {alwaysAvailable
              ? `${agentName} does not support library ${unreadable}.`
              : `${agentName} does not read ${unreadable} from the project — these are linked, but it will not see them.`}
          </div>
        )}
        {alwaysAvailable && !unreadable && (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            Available to invoke with /name; command text is only sent when invoked.
          </div>
        )}
        {searchable && <MenuSearchInput label={title} value={query} onChange={setQuery} />}
        {shown.length === 0 ? (
          <DropdownMenuItem disabled>
            None in the library.
          </DropdownMenuItem>
        ) : matching.length === 0 ? (
          <DropdownMenuItem disabled>
            No match
          </DropdownMenuItem>
        ) : (
          matching.map((item) => {
            const from = inherited.has(item.id)
            return (
              <ToolRow
                key={item.id}
                name={item.name}
                icon={itemIcon?.(item)}
                checked={alwaysAvailable || from || own.includes(item.id)}
                disabled={alwaysAvailable || from || !editable}
                from={from}
                needsAuth={needsAuth(item)}
                hint={hint(item)}
                onCheckedChange={(checked) => {
                  if (editable) onToggle(item.id, checked === true)
                }}
              />
            )
          })
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
