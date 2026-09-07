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

/* ── ClickUp-style view tabs ──
   Prominent pill buttons with icons, the active one highlighted. */
function ViewTabs({ mode, onChange }: { mode: WorkspaceMode; onChange: (m: WorkspaceMode) => void }) {
  return (
    <div className="inline-flex shrink-0 items-center gap-0.5 rounded-xl border bg-muted/40 p-0.5" aria-label="View">
      {MODES.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          aria-pressed={mode === id}
          title={label}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            mode === id
              ? "bg-background text-foreground shadow-sm ring-1 ring-border"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <Icon className="size-3.5 shrink-0" />
          <span className="hidden @panel-sm:inline">{label}</span>
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

/** The filter popover — same shape as before but with a cleaner header. */
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
          <button type="button" className={cn("inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-dashed px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:border-solid hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", count > 0 && "border-solid border-primary/40 bg-primary/5 text-primary")}>
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

/** ClickUp-style filter pill: shows the active filter with a remove button. */
function FilterPill({
  label,
  onRemove,
  children,
}: {
  label: string
  onRemove: () => void
  children?: React.ReactNode
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-pill border border-primary/30 bg-primary/5 px-2 py-0.5 text-xs font-medium text-primary">
      {children}
      <span className="max-w-[8rem] truncate">{label}</span>
      <button type="button" onClick={onRemove} aria-label={`Remove ${label}`} className="-mr-0.5 ml-0.5 rounded-full hover:bg-primary/15">
        <X className="size-3" />
      </button>
    </span>
  )
}

/** Extract the active filter pills from the filter state. */
function ActiveFilterPills({
  filters,
  onChange,
  statuses,
}: {
  filters: TaskFilters
  onChange: (next: TaskFilters) => void
  statuses: BoardStatus[]
}) {
  const pills: React.ReactNode[] = []
  const removeStr = (key: "assignees" | "labels", value: string) => {
    onChange({ ...filters, [key]: (filters[key] as string[]).filter((v) => v !== value) })
  }
  const removeArr = (key: "statusIds", value: string) => {
    onChange({ ...filters, [key]: filters[key].filter((v) => v !== value) })
  }
  const removePrio = (value: TaskPriority) => {
    onChange({ ...filters, priorities: filters.priorities.filter((v) => v !== value) })
  }
  const removeType = (value: TaskType) => {
    onChange({ ...filters, types: filters.types.filter((v) => v !== value) })
  }

  for (const sid of filters.statusIds) {
    const s = statuses.find((x) => x.id === sid)
    if (s) pills.push(<FilterPill key={`status-${sid}`} label={s.name} onRemove={() => removeArr("statusIds", sid)}><span className={cn("size-1.5 rounded-full", s.color ? COLOR_DOT[s.color] : "bg-muted-foreground/40")} /></FilterPill>)
  }
  for (const p of filters.priorities) {
    pills.push(<FilterPill key={`p-${p}`} label={PRIORITY_LABEL[p]} onRemove={() => removePrio(p)}><PriorityIcon priority={p} className="size-3" /></FilterPill>)
  }
  for (const t of filters.types) {
    pills.push(<FilterPill key={`t-${t}`} label={TYPE_LABEL[t]} onRemove={() => removeType(t)}><TypeIcon type={t} className="size-3" /></FilterPill>)
  }
  for (const a of filters.assignees) {
    pills.push(<FilterPill key={`a-${a}`} label={a || "Unassigned"} onRemove={() => removeStr("assignees", a)}><AssigneeAvatar name={a || null} size="xs" /></FilterPill>)
  }
  for (const l of filters.labels) {
    pills.push(<FilterPill key={`l-${l}`} label={l} onRemove={() => removeStr("labels", l)}><LabelChip label={l} /></FilterPill>)
  }
  if (filters.due !== "any") {
    const dueLabel = DUE_OPTIONS.find((d) => d.id === filters.due)?.label ?? filters.due
    pills.push(<FilterPill key="due" label={dueLabel} onRemove={() => onChange({ ...filters, due: "any" })} />)
  }
  if (filters.archived !== "hide") {
    pills.push(<FilterPill key="archived" label={filters.archived === "only" ? "Archived only" : "Include archived"} onRemove={() => onChange({ ...filters, archived: "hide" })} />)
  }

  if (pills.length === 0) return null
  return <div className="flex flex-wrap items-center gap-1">{pills}</div>
}

/** ClickUp-style sort button: icon + label + direction indicator. */
function SortButton({
  view,
  onChange,
  sortable,
}: {
  view: ViewState
  onChange: (patch: Partial<ViewState>) => void
  sortable: boolean
}) {
  if (!sortable) return null
  const active = view.sortBy !== "manual"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button type="button" className={cn("inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active && "border-primary/30 bg-primary/5 text-primary")}>
            <ArrowUpDown className="size-3.5" />
            <span className="hidden @panel-sm:inline">
              {SORT_LABEL[view.sortBy]}
              {active && (view.sortDir === "asc" ? " ↑" : " ↓")}
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
  )
}

/** ClickUp-style group button. */
function GroupButton({
  view,
  onChange,
  groupable,
}: {
  view: ViewState
  onChange: (patch: Partial<ViewState>) => void
  groupable: boolean
}) {
  if (!groupable) return null
  const active = view.groupBy !== "none"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button type="button" className={cn("inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active && "border-primary/30 bg-primary/5 text-primary")}>
            <Group className="size-3.5" />
            <span className="hidden @panel-sm:inline">{GROUP_LABEL[view.groupBy]}</span>
          </button>
        }
      />
      <DropdownMenuContent align="start" className="w-44">
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
  )
}

/** ClickUp-style columns button (table view only). */
function ColumnsButton({
  view,
  onChange,
}: {
  view: ViewState
  onChange: (patch: Partial<ViewState>) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button type="button" className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
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
  )
}

/** Saved views dropdown — ClickUp-style bookmark button. */
function SavedViewsButton({
  savedViews,
  activeViewId,
  onPickView,
  onSaveView,
  onDeleteView,
}: {
  savedViews: BoardView[]
  activeViewId: string | null
  onPickView: (view: BoardView | null) => void
  onSaveView: () => void
  onDeleteView: (view: BoardView) => void
}) {
  const active = !!activeViewId
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button type="button" className={cn("inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active && "border-primary/30 bg-primary/5 text-primary")}>
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
  )
}

/** The full ClickUp-style toolbar: view tabs + filter/search + controls. */
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
      {/* Row 1: View tabs + search + new task */}
      <div className="flex flex-wrap items-center gap-2">
        <ViewTabs mode={mode} onChange={onMode} />
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={view.filters.query}
            onChange={(e) => onChange({ filters: { ...view.filters, query: e.target.value } })}
            placeholder="Search tasks…"
            aria-label="Search tasks"
            className="h-8 pl-8 text-xs"
          />
          {view.filters.query && (
            <button type="button" onClick={() => onChange({ filters: { ...view.filters, query: "" } })} aria-label="Clear search" className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
          {visible === total ? `${total} tasks` : `${visible} of ${total}`}
        </span>
        <button
          type="button"
          onClick={onNewTask}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="size-4" />
          <span className="hidden min-[380px]:inline">New task</span>
        </button>
      </div>

      {/* Row 2: Filter pill bar + group/sort/columns + saved views */}
      <div className="flex flex-wrap items-center gap-1.5 max-sm:flex-nowrap max-sm:overflow-x-auto">
        <FilterPopover filters={view.filters} onChange={(filters) => onChange({ filters })} statuses={statuses} sprints={sprints} epics={epics} facets={facets} boardKey={boardKey} />
        <ActiveFilterPills filters={view.filters} onChange={(filters) => onChange({ filters })} statuses={statuses} />
        <span className="h-4 w-px bg-border shrink-0" />
        <GroupButton view={view} onChange={onChange} groupable={groupable} />
        <SortButton view={view} onChange={onChange} sortable={sortable} />
        {mode === "table" && <ColumnsButton view={view} onChange={onChange} />}
        <SavedViewsButton savedViews={savedViews} activeViewId={activeViewId} onPickView={onPickView} onSaveView={onSaveView} onDeleteView={onDeleteView} />
      </div>
    </div>
  )
}
