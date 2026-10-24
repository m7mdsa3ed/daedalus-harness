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
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  setLayoutOption,
  type SidebarFilter,
  type SidebarSort,
  type SidebarSubs,
  type SidebarWithin,
} from "@/lib/layout-options"
import { settingsPath } from "@/lib/router"
import { cn } from "@/lib/utils"
import { MENU_ROW, MENU_WIDTH } from "@/components/menu-row"

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
  hidden: "Hidden",
}
export const SUBS_LABELS: Record<SidebarSubs, string> = {
  all: "All sub threads",
  active: "Active only",
  off: "Hidden",
}
export const WITHIN_LABELS: Record<SidebarWithin, string> = {
  any: "Any time",
  day: "Last 24 hours",
  week: "Last 7 days",
  month: "Last 30 days",
}

/** One reading of the list as a submenu: the trigger names it and says what it
    is set to, the radio group inside picks. */
function ChoiceSub<T extends string>({
  title,
  labels,
  value,
  onChange,
}: {
  title: string
  labels: Record<T, string>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className={MENU_ROW}>
        <span className="flex-1">{title}</span>
        <span className="text-xs text-muted-foreground">{labels[value]}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className={MENU_WIDTH}>
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as T)}>
          {(Object.keys(labels) as T[]).map((key) => (
            <DropdownMenuRadioItem key={key} value={key}>
              {labels[key]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/** Sort and filter, in one small menu on the Threads label — the controls
    Claude Code desktop puts at the top of its session list. The trigger
    lights up while a filter is on so a short list is never mistaken for an
    empty install. */
export function ViewMenu({
  sort,
  filter,
  within,
  subs,
  compact,
}: {
  sort: SidebarSort
  filter: SidebarFilter
  within: SidebarWithin
  subs: SidebarSubs
  compact: boolean
}) {
  const navigate = useNavigate()
  const filtered = filter !== "all" || within !== "any" || subs !== "all"
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
        {/* One submenu per reading, its current value on the trigger, so the
            top level stays four rows and a filter that is on can be seen
            without opening anything. */}
        <ChoiceSub
          title="Sort"
          labels={SORT_LABELS}
          value={sort}
          onChange={(value) => setLayoutOption("sidebarSort", value)}
        />
        <ChoiceSub
          title="Show"
          labels={FILTER_LABELS}
          value={filter}
          onChange={(value) => setLayoutOption("sidebarFilter", value)}
        />
        <ChoiceSub
          title="Active in"
          labels={WITHIN_LABELS}
          value={within}
          onChange={(value) => setLayoutOption("sidebarWithin", value)}
        />
        <ChoiceSub
          title="Sub threads"
          labels={SUBS_LABELS}
          value={subs}
          onChange={(value) => setLayoutOption("sidebarSubThreads", value)}
        />
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={compact} onCheckedChange={(checked) => setLayoutOption("sidebarCompact", checked)}>
          Compact rows
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void navigate(`${settingsPath("appearance")}#interface`)}>
          {/* No glyph: every other row here is words alone, and one text column. */}
          Sidebar settings…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
