/**
 * One kind of tool as a submenu: the trigger that says how many of that kind
 * the thread carries, and the list behind it.
 *
 * Written once and invoked once per kind, because MCP servers, skills and
 * commands differ only in a title, an icon, a library and the one line each
 * entry prints under its name — everything else (what a draft may pick, what a
 * started thread lists, the counts, the locked profile rows) is the same
 * question three times. What it shows and counts is `sectionView`'s, shared
 * with the inline panel, so the two surfaces cannot disagree about a section.
 */
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"

import { ToolRow } from "./tool-row"
import { sectionView, unreadableNote, type ToolSectionModel } from "./use-thread-tools"

export function ToolSection({
  section,
  editable,
  needsAuth,
  agentName,
}: {
  section: ToolSectionModel
  editable: boolean
  needsAuth: (item: { id: string }) => boolean
  agentName: string | undefined
}) {
  const view = sectionView(section, editable)
  if (!view) return null
  const { shown, has, count } = view
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-2.5">
        {section.icon}
        <span className="truncate">{section.title}</span>
        <span className="ml-auto pl-2 text-xs tabular-nums text-muted-foreground">{count}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64">
        {section.unreadable && (
          <div className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
            {unreadableNote(agentName, section.unreadable)}
          </div>
        )}
        {shown.length === 0 ? (
          <DropdownMenuItem disabled className="text-xs">
            None in the library.
          </DropdownMenuItem>
        ) : (
          shown.map((item) => {
            const from = section.inherited.has(item.id)
            return (
              <ToolRow
                key={item.id}
                name={item.name}
                checked={has(item.id)}
                disabled={from || !editable}
                from={from}
                needsAuth={needsAuth(item)}
                hint={section.hint(item)}
                onCheckedChange={(checked) => {
                  if (editable) section.onToggle(item.id, checked === true)
                }}
              />
            )
          })
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
