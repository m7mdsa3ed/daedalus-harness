import * as React from "react"
import {
  ArrowUpDown,
  Bookmark,
  CalendarDays,
  Check,
  ChartGantt,
  Columns3,
  Filter,
  Group,
  List,
  Plus,
  Rocket,
  SearchIcon,
  SquareKanban,
  Table2,
  Trash2,
  X,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { COLOR_DOT, type BoardStatus, type BoardView, type Sprint, type ViewKind } from "@/lib/boards"
import {
  PRIORITY_LABEL,
  TASK_PRIORITIES,
  TASK_TYPES,
  TYPE_LABEL,
  taskKey,
  type Task,
  type TaskPriority,
  type TaskType,
} from "@/lib/tasks-board"
import {
  COLUMN_LABEL,
  EMPTY_FILTERS,
  GROUP_BYS,
  GROUP_LABEL,
  SORT_BYS,
  SORT_LABEL,
  TABLE_COLUMNS,
  activeFilterCount,
  type DueWindow,
  type GroupBy,
  type SortBy,
  type TableColumn,
  type TaskFilters,
  type ViewState,
} from "@/lib/tasks-view"
import { AssigneeAvatar, LabelChip, PriorityIcon, TypeIcon } from "./fields"

export type WorkspaceMode = ViewKind | "sprints"

const MODES: { id: WorkspaceMode; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "board", label: "Board", icon: SquareKanban },
  { id: "list", label: "List", icon: List },
  { id: "table", label: "Table", icon: Table2 },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "timeline", label: "Timeline", icon: ChartGantt },
  { id: "sprints", label: "Sprints", icon: Rocket },
]

const TOOL =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

function ModeSwitch({ mode, onChange }: { mode: WorkspaceMode; onChange: (m: WorkspaceMode) => void }) {
  return (
    <div className="inline-flex shrink-0 items-center gap-0.5 rounded-4xl border bg-muted/30 p-0.5 text-xs font-medium" aria-label="View">
      {MODES.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          aria-pressed={mode === id}
          title={label}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-4xl px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            mode === id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="size-3.5 shrink-0" />
          <span className="hidden @panel-md:inline">{label}</span>
        </button>
      ))}
    </div>
  )
}

/** A facet inside the filter popover: a heading and a wrapping row of chips. */
function Facet<T extends string>({
  title,
  options,
  value,
  onChange,
  render,
}: {
  title: string
  options: { id: T; label: React.ReactNode }[]
  value: T[]
  onChange: (next: T[]) => void
  render?: (id: T) => React.ReactNode
}) {
  if (options.length === 0) return null
  const toggle = (id: T) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id])
  return (
    <div className="grid gap-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => toggle(o.id)}
            aria-pressed={value.includes(o.id)}
            className={cn(
              "inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-xs transition-colors",
              value.includes(o.id) ? "border-primary/40 bg-primary/10 text-primary" : "border-transparent bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {render ? render(o.id) : o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

const DUE_OPTIONS: { id: DueWindow; label: string }[] = [
  { id: "overdue", label: "Overdue" },
  { id: "today", label: "Today" },
  { id: "week", label: "Next 7 days" },
  { id: "none", label: "No date" },
]

export function FilterPopover({
  filters,
  onChange,
  statuses,
  sprints,
  epics,
  facets,
  boardKey,
}: {
  filters: TaskFilters
  onChange: (next: TaskFilters) => void
  statuses: BoardStatus[]
  sprints: Sprint[]
  epics: Task[]
  facets: { assignees: string[]; labels: string[] }
  boardKey: string
}) {
  const count = activeFilterCount(filters)
  const set = <K extends keyof TaskFilters>(key: K, value: TaskFilters[K]) => onChange({ ...filters, [key]: value })
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button type="button" className={cn(TOOL, count > 0 && "border-primary/40 text-primary")}>
            <Filter className="size-3.5" />
            <span className="hidden @panel-sm:inline">Filter</span>
            {count > 0 && <span className="rounded-pill bg-primary px-1.5 text-[10px] text-primary-foreground">{count}</span>}
          </button>
        }
      />
      <PopoverContent align="start" className="w-[22rem] gap-4 p-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Filters</p>
          {count > 0 && (
            <button type="button" onClick={() => onChange({ ...EMPTY_FILTERS, query: filters.query })} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <X className="size-3" /> Clear all
            </button>
          )}
        </div>
        <div className="grid max-h-[60vh] gap-4 overflow-y-auto">
          <Facet
            title="Status"
            options={statuses.map((s) => ({ id: s.id, label: s.name }))}
            value={filters.statusIds}
            onChange={(v) => set("statusIds", v)}
            render={(id) => {
              const s = statuses.find((x) => x.id === id)!
              return (
                <>
                  <span className={cn("size-1.5 rounded-full", s.color ? COLOR_DOT[s.color] : "bg-muted-foreground/40")} />
                  {s.name}
                </>
              )
            }}
          />
          <Facet
            title="Priority"
            options={[...TASK_PRIORITIES].reverse().map((p) => ({ id: p, label: PRIORITY_LABEL[p] }))}
            value={filters.priorities}
            onChange={(v) => set("priorities", v as TaskPriority[])}
            render={(id) => (
              <>
                <PriorityIcon priority={id} className="size-3" />
                {PRIORITY_LABEL[id]}
              </>
            )}
          />
          <Facet
            title="Type"
            options={TASK_TYPES.map((t) => ({ id: t, label: TYPE_LABEL[t] }))}
            value={filters.types}
            onChange={(v) => set("types", v as TaskType[])}
            render={(id) => (
              <>
                <TypeIcon type={id} className="size-3" />
                {TYPE_LABEL[id]}
              </>
            )}
          />
          <Facet
            title="Assignee"
            options={[{ id: "", label: "Unassigned" }, ...facets.assignees.map((a) => ({ id: a, label: a }))]}
            value={filters.assignees}
            onChange={(v) => set("assignees", v)}
            render={(id) => (
              <>
                <AssigneeAvatar name={id || null} size="xs" />
                {id || "Unassigned"}
              </>
            )}
          />
          <Facet
            title="Label"
            options={facets.labels.map((l) => ({ id: l, label: l }))}
            value={filters.labels}
            onChange={(v) => set("labels", v)}
            render={(id) => <LabelChip label={id} />}
          />
          <Facet
            title="Sprint"
            options={[{ id: "backlog", label: "Backlog" }, ...sprints.filter((s) => s.state !== "closed").map((s) => ({ id: s.id, label: s.name }))]}
            value={filters.sprintIds}
            onChange={(v) => set("sprintIds", v)}
          />
          <Facet
            title="Parent"
            options={[{ id: "none", label: "Top level only" }, ...epics.map((e) => ({ id: e.id, label: `${taskKey(e, boardKey)} ${e.title}` }))]}
            value={filters.parentIds}
            onChange={(v) => set("parentIds", v)}
          />
          <Facet
            title="Due"
            options={DUE_OPTIONS}
            value={filters.due === "any" ? [] : [filters.due]}
            onChange={(v) => set("due", (v.find((d) => d !== filters.due) ?? "any") as DueWindow)}
          />
          <Facet
            title="Archived"
            options={[
              { id: "all", label: "Include archived" },
              { id: "only", label: "Only archived" },
            ]}
            value={filters.archived === "hide" ? [] : [filters.archived]}
            onChange={(v) => set("archived", (v.find((d) => d !== filters.archived) ?? "hide") as TaskFilters["archived"])}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function Toolbar({
  mode,
  onMode,
  view,
  onChange,
  statuses,
  sprints,
  epics,
  facets,
  boardKey,
  savedViews,
  activeViewId,
  onPickView,
  onSaveView,
  onDeleteView,
  onNewTask,
  visible,
  total,
}: {
  mode: WorkspaceMode
  onMode: (m: WorkspaceMode) => void
  view: ViewState
  onChange: (patch: Partial<ViewState>) => void
  statuses: BoardStatus[]
  sprints: Sprint[]
  epics: Task[]
  facets: { assignees: string[]; labels: string[] }
  boardKey: string
  savedViews: BoardView[]
  activeViewId: string | null
  onPickView: (view: BoardView | null) => void
  onSaveView: () => void
  onDeleteView: (view: BoardView) => void
  onNewTask: () => void
  visible: number
  total: number
}) {
  const groupable = mode === "list"
  const sortable = mode !== "board" && mode !== "calendar" && mode !== "timeline"
  return (
    <div className="flex flex-col gap-2 border-b px-3 py-2 sm:px-4">
      {/* Row 1 on a phone: the mode switch and the primary action share the
          first line, the search takes its own full-width second line — a
          flex-wrap layout would squeeze the search to nothing instead. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="order-1">
          <ModeSwitch mode={mode} onChange={onMode} />
        </div>
        <button
          type="button"
          onClick={onNewTask}
          className="order-2 ml-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-4xl bg-primary px-3 text-xs font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:order-3"
        >
          <Plus className="size-4" />
          <span className="hidden min-[380px]:inline">New task</span>
        </button>
        <div className="relative order-3 w-full min-w-0 sm:order-2 sm:w-auto sm:max-w-xs sm:flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={view.filters.query}
            onChange={(e) => onChange({ filters: { ...view.filters, query: e.target.value } })}
            placeholder="Search key, title, labels…"
            aria-label="Search tasks"
            className="h-8 pl-8 text-xs"
          />
          {view.filters.query && (
            <button type="button" onClick={() => onChange({ filters: { ...view.filters, query: "" } })} aria-label="Clear search" className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      {/* Row 2 degrades to a scrollable strip on a phone rather than wrapping
          onto three lines; the pickers portal, so the scroll clips nothing. */}
      <div className="flex flex-wrap items-center gap-1.5 max-sm:flex-nowrap max-sm:overflow-x-auto">
        <FilterPopover filters={view.filters} onChange={(filters) => onChange({ filters })} statuses={statuses} sprints={sprints} epics={epics} facets={facets} boardKey={boardKey} />

        {groupable && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button type="button" className={cn(TOOL, view.groupBy !== "none" && "border-primary/40 text-primary")}>
                  <Group className="size-3.5" />
                  <span className="hidden @panel-sm:inline">{view.groupBy === "none" ? "Group" : GROUP_LABEL[view.groupBy]}</span>
                </button>
              }
            />
            <DropdownMenuContent align="start" className="w-44">
              {/* The label is Base UI's Menu.GroupLabel: it reads its group from
                  context and throws outside one, so it sits inside the radio
                  group it names rather than loose in the content. */}
              <DropdownMenuRadioGroup value={view.groupBy} onValueChange={(v) => onChange({ groupBy: v as GroupBy })}>
                <DropdownMenuLabel>Group by</DropdownMenuLabel>
                {GROUP_BYS.map((g) => (
                  <DropdownMenuRadioItem key={g} value={g}>
                    {g === "none" ? "Status (default)" : GROUP_LABEL[g]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {sortable && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button type="button" className={cn(TOOL, view.sortBy !== "manual" && "border-primary/40 text-primary")}>
                  <ArrowUpDown className="size-3.5" />
                  <span className="hidden @panel-sm:inline">
                    {SORT_LABEL[view.sortBy]}
                    {view.sortBy !== "manual" && (view.sortDir === "asc" ? " ↑" : " ↓")}
                  </span>
                </button>
              }
            />
            <DropdownMenuContent align="start" className="w-44">
              <DropdownMenuRadioGroup value={view.sortBy} onValueChange={(v) => onChange({ sortBy: v as SortBy })}>
                <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                {SORT_BYS.map((s) => (
                  <DropdownMenuRadioItem key={s} value={s}>
                    {SORT_LABEL[s]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup value={view.sortDir} onValueChange={(v) => onChange({ sortDir: v as "asc" | "desc" })}>
                <DropdownMenuRadioItem value="asc">Ascending</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="desc">Descending</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {mode === "table" && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button type="button" className={TOOL}>
                  <Columns3 className="size-3.5" />
                  <span className="hidden @panel-sm:inline">Columns</span>
                </button>
              }
            />
            <DropdownMenuContent align="start" className="w-44">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Columns</DropdownMenuLabel>
                {TABLE_COLUMNS.map((c) => (
                  <DropdownMenuCheckboxItem
                    key={c}
                    checked={view.columns.includes(c)}
                    onCheckedChange={(checked) =>
                      onChange({
                        columns: checked
                          ? TABLE_COLUMNS.filter((x) => x === c || view.columns.includes(x))
                          : view.columns.filter((x) => x !== c),
                      })
                    }
                  >
                    {COLUMN_LABEL[c as TableColumn]}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button type="button" className={cn(TOOL, activeViewId && "border-primary/40 text-primary")}>
                <Bookmark className="size-3.5" />
                <span className="hidden @panel-sm:inline">{savedViews.find((v) => v.id === activeViewId)?.name ?? "Views"}</span>
              </button>
            }
          />
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Saved views</DropdownMenuLabel>
              {savedViews.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">None yet — set up filters, then save.</p>}
              {savedViews.map((v) => (
                <DropdownMenuItem key={v.id} onClick={() => onPickView(v)}>
                  {v.id === activeViewId ? <Check className="size-4 text-primary" /> : <span className="size-4" />}
                  <span className="flex-1 truncate">{v.name}</span>
                  <span className="text-[10px] uppercase text-muted-foreground">{v.kind}</span>
                  <button
                    type="button"
                    aria-label={`Delete view ${v.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onDeleteView(v)
                    }}
                    className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onSaveView}>
              <Plus className="size-4" /> {activeViewId ? "Update / save as…" : "Save current view…"}
            </DropdownMenuItem>
            {activeViewId && (
              <DropdownMenuItem onClick={() => onPickView(null)}>
                <X className="size-4" /> Leave view
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
          {visible === total ? `${total} tasks` : `${visible} of ${total}`}
        </span>
      </div>
    </div>
  )
}
