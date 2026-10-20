/* ── Sort / filter, remembered on this device ──
   How the thread list is *read* is the reader's property, not the
   conversation's: the harness's session list is shared, and one person's
   sidebar must not reorder another's. The values live with every other layout
   option (`lib/layout-options`: `sidebarSort`, `sidebarFilter`,
   `sidebarWithin`), so Settings › Appearance › Sidebar edits the same ones;
   this is the quick menu on the Threads label. */
import { ListFilter } from "lucide-react"
import { useNavigate } from "react-router"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  setLayoutOption,
  type SidebarFilter,
  type SidebarSort,
  type SidebarWithin,
} from "@/lib/layout-options"
import { settingsPath } from "@/lib/router"
import { cn } from "@/lib/utils"
import { MENU_WIDTH } from "@/components/menu-row"

export const SORT_LABELS: Record<SidebarSort, string> = {
  recent: "Recent activity",
  created: "Newest created",
  title: "Title (A–Z)",
  project: "By project",
}
export const FILTER_LABELS: Record<SidebarFilter, string> = {
  all: "All threads",
  running: "Running",
  waiting: "Needs you",
  unread: "Unread",
}
export const WITHIN_LABELS: Record<SidebarWithin, string> = {
  any: "Any time",
  day: "Last 24 hours",
  week: "Last 7 days",
  month: "Last 30 days",
}

/** Sort and filter, in one small menu on the Threads label — the controls
    Claude Code desktop puts at the top of its session list. The trigger
    lights up while a filter is on so a short list is never mistaken for an
    empty install. */
export function ViewMenu({
  sort,
  filter,
  within,
}: {
  sort: SidebarSort
  filter: SidebarFilter
  within: SidebarWithin
}) {
  const navigate = useNavigate()
  const filtered = filter !== "all" || within !== "any"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            title="Sort and filter"
            className={cn(filtered ? "text-primary" : "text-muted-foreground")}
          />
        }
      >
        <ListFilter />
        <span className="sr-only">Sort and filter threads</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" className={MENU_WIDTH}>
        {/* The label is Base UI's Menu.GroupLabel: it reads its group from
            context and throws outside one, so it sits inside the radio group
            it names rather than loose in the content. */}
        <DropdownMenuRadioGroup value={sort} onValueChange={(value) => setLayoutOption("sidebarSort", value as SidebarSort)}>
          <DropdownMenuLabel>Sort</DropdownMenuLabel>
          {(Object.keys(SORT_LABELS) as SidebarSort[]).map((value) => (
            <DropdownMenuRadioItem key={value} value={value}>
              {SORT_LABELS[value]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={filter} onValueChange={(value) => setLayoutOption("sidebarFilter", value as SidebarFilter)}>
          <DropdownMenuLabel>Show</DropdownMenuLabel>
          {(Object.keys(FILTER_LABELS) as SidebarFilter[]).map((value) => (
            <DropdownMenuRadioItem key={value} value={value}>
              {FILTER_LABELS[value]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={within} onValueChange={(value) => setLayoutOption("sidebarWithin", value as SidebarWithin)}>
          <DropdownMenuLabel>Active in</DropdownMenuLabel>
          {(Object.keys(WITHIN_LABELS) as SidebarWithin[]).map((value) => (
            <DropdownMenuRadioItem key={value} value={value}>
              {WITHIN_LABELS[value]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void navigate(`${settingsPath("appearance")}#interface`)}>
          {/* No glyph: every other row here is words alone, and one text column. */}
          Sidebar settings…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
