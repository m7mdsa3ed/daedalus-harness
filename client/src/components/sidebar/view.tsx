/* ── Sort / filter, remembered on this device ──
   How the thread list is *read* is the reader's property, not the
   conversation's: the harness's session list is shared, and one person's
   sidebar must not reorder another's. The store below and the menu that writes
   it are one file because they are one setting. */
import { ListFilter } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { createLocalStore } from "@/lib/local-store"
import { cn } from "@/lib/utils"

export type SidebarSort = "recent" | "project"
export type SidebarFilter = "all" | "running" | "waiting"
export interface SidebarView {
  sort: SidebarSort
  filter: SidebarFilter
}
function parseView(raw: unknown): SidebarView {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<SidebarView>
  return {
    sort: r.sort === "project" ? "project" : "recent",
    filter: r.filter === "running" || r.filter === "waiting" ? r.filter : "all",
  }
}
// Same key and JSON shape as before, so a stored choice carries over.
const viewStore = createLocalStore<SidebarView>("ui.sidebarView", parseView, parseView(null))

function writeView(patch: Partial<SidebarView>) {
  viewStore.set({ ...viewStore.get(), ...patch })
}

export const useSidebarView = viewStore.use
export const setSidebarFilter = (filter: SidebarFilter) => writeView({ filter })

/** Sort and filter, in one small menu on the Threads label — the controls
    Claude Code desktop puts at the top of its session list. The trigger
    lights up while a filter is on so a short list is never mistaken for an
    empty install. */
export function ViewMenu({ view }: { view: SidebarView }) {
  const filtered = view.filter !== "all"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            title="Sort and filter"
            className={cn(
              "grid size-5 place-items-center rounded-sm transition-colors hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-popup-open:text-sidebar-foreground",
              filtered ? "text-primary hover:text-primary" : "text-muted-foreground"
            )}
          />
        }
      >
        <ListFilter className="size-3.5" />
        <span className="sr-only">Sort and filter threads</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" className="w-44">
        {/* The label is Base UI's Menu.GroupLabel: it reads its group from
            context and throws outside one, so it sits inside the radio group
            it names rather than loose in the content. */}
        <DropdownMenuRadioGroup
          value={view.sort}
          onValueChange={(value) => writeView({ sort: value as SidebarSort })}
        >
          <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Sort
          </DropdownMenuLabel>
          <DropdownMenuRadioItem value="recent">Recent first</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="project">By project</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={view.filter}
          onValueChange={(value) => writeView({ filter: value as SidebarFilter })}
        >
          <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Show
          </DropdownMenuLabel>
          <DropdownMenuRadioItem value="all">All threads</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="running">Running</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="waiting">Needs you</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
