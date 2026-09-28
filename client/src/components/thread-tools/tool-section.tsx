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

import { ToolRow } from "./tool-row"

export function ToolSection<T extends { id: string; name: string }>({
  title,
  icon,
  items,
  hint,
  inherited,
  own,
  editable,
  needsAuth,
  /** What this runtime does not read out of the workspace, in words ("skills"),
      or null when it reads this kind — see the menu, which decides it. */
  unreadable,
  agentName,
  onToggle,
}: {
  title: string
  icon: React.ReactNode
  items: T[]
  hint: (item: T) => string
  /** Linked by the profile: checked, locked, and not this menu's to clear. */
  inherited: Set<string>
  /** Linked by the thread itself. */
  own: string[]
  editable: boolean
  needsAuth: (item: { id: string }) => boolean
  unreadable: string | null
  agentName: string | undefined
  onToggle: (id: string, on: boolean) => void
}) {
  /* A draft offers the whole library to pick from; a started thread lists
     only what it is actually running — the rest is neither a choice it has
     nor a fact about it. */
  const shown = editable
    ? items
    : items.filter((item) => inherited.has(item.id) || own.includes(item.id))
  if (!editable && shown.length === 0) return null
  const on = shown.filter((item) => inherited.has(item.id) || own.includes(item.id)).length
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-2.5">
        {icon}
        <span className="truncate">{title}</span>
        {/* The count is the point of the row: it is what the flat menu made
            you open a group to learn. "2 of 9" while picking, a bare figure
            once the thread has spawned and the library is no longer a
            choice. */}
        <span className="ml-auto pl-2 text-xs tabular-nums text-muted-foreground">
          {editable ? (on === 0 ? `${shown.length}` : `${on} of ${shown.length}`) : on}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64">
        {unreadable && (
          <div className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
            {agentName} does not read {unreadable} from the project — these are linked, but it
            will not see them.
          </div>
        )}
        {shown.length === 0 ? (
          <DropdownMenuItem disabled className="text-xs">
            None in the library.
          </DropdownMenuItem>
        ) : (
          shown.map((item) => {
            const from = inherited.has(item.id)
            return (
              <ToolRow
                key={item.id}
                name={item.name}
                checked={from || own.includes(item.id)}
                disabled={from || !editable}
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
