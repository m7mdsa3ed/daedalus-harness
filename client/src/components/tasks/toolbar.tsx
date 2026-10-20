import * as React from "react"
import { Bookmark, Check, LogOut, Plus, Save, SlidersHorizontal, Trash2, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { FiltersBar, type FilterFieldDef, type FilterSchemaValue } from "@/components/ui/filters-bar"
import { Segmented } from "@/components/settings/primitives"
import { useConfirm } from "@/components/confirm-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { COLOR_DOT, type BoardStatus, type BoardView, type Sprint } from "@/lib/boards"
import { PRIORITY_LABEL, TASK_PRIORITIES, TASK_TYPES, TYPE_LABEL, taskKey, type Task, type TaskPriority, type TaskType } from "@/lib/tasks-board"
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
  type TaskFilters,
  type ViewState,
} from "@/lib/tasks-view"
import { AssigneeAvatar, PriorityIcon, TypeIcon } from "./fields"
import { INSET_X, MODES, type WorkspaceMode } from "./modes"

export type { WorkspaceMode } from "./modes"

const DUE_OPTIONS: { value: DueWindow; label: string }[] = [
  { value: "any", label: "Any time" },
  { value: "overdue", label: "Overdue" },
  { value: "today", label: "Today" },
  { value: "week", label: "Next 7 days" },
  { value: "none", label: "No date" },
]

const ARCHIVED_OPTIONS: { value: TaskFilters["archived"]; label: string }[] = [
  { value: "hide", label: "Hide" },
  { value: "all", label: "Include" },
  { value: "only", label: "Only" },
]

/* The filter "Unassigned" is the empty string in `TaskFilters`; a command list
   cannot hold an empty value, so it travels under a name of its own here. */
const UNASSIGNED = "__unassigned"
const toAssigneeOption = (a: string) => (a === "" ? UNASSIGNED : a)
const fromAssigneeOption = (a: string) => (a === UNASSIGNED ? "" : a)

const MULTI_KEYS = ["statusIds", "priorities", "types", "assignees", "labels", "sprintIds", "parentIds"] as const

/** The search and every facet, as `FiltersBar` fields over one `TaskFilters`.
    The bar draws a popover on a wide panel and a sheet on a narrow one. */
function TaskFiltersBar({
  filters,
  onChange,
  statuses,
  sprints,
  epics,
  facets,
  boardKey,
  narrow,
}: {
  filters: TaskFilters
  onChange: (next: TaskFilters) => void
  statuses: BoardStatus[]
  sprints: Sprint[]
  epics: Task[]
  facets: { assignees: string[]; labels: string[] }
  boardKey: string
  narrow: boolean
}) {
  const fields: FilterFieldDef[] = [
    { id: "statusIds", label: "Status", type: "multi-select", placeholder: "Any status", options: statuses.map((s) => ({ value: s.id, label: s.name })) },
    {
      id: "priorities",
      label: "Priority",
      type: "multi-select",
      placeholder: "Any priority",
      options: [...TASK_PRIORITIES].reverse().map((p) => ({ value: p, label: PRIORITY_LABEL[p] })),
    },
    { id: "types", label: "Type", type: "multi-select", placeholder: "Any type", options: TASK_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] })) },
    {
      id: "assignees",
      label: "Assignee",
      type: "multi-select",
      placeholder: "Anyone",
      options: [{ value: UNASSIGNED, label: "Unassigned" }, ...facets.assignees.map((a) => ({ value: a, label: a }))],
    },
    { id: "labels", label: "Label", type: "multi-select", placeholder: "Any label", options: facets.labels.map((l) => ({ value: l, label: l })) },
    {
      id: "sprintIds",
      label: "Sprint",
      type: "multi-select",
      placeholder: "Any sprint",
      options: [{ value: "backlog", label: "Backlog" }, ...sprints.filter((s) => s.state !== "closed").map((s) => ({ value: s.id, label: s.name }))],
    },
    {
      id: "parentIds",
      label: "Parent",
      type: "multi-select",
      placeholder: "Any parent",
      searchPlaceholder: "Search epics…",
      options: [{ value: "none", label: "Top level only" }, ...epics.map((e) => ({ value: e.id, label: `${taskKey(e, boardKey)} ${e.title}` }))],
    },
    { id: "due", label: "Due", type: "select", options: DUE_OPTIONS },
    { id: "archived", label: "Archived", type: "segmented", options: ARCHIVED_OPTIONS },
  ]
  const values: FilterSchemaValue = {
    statusIds: filters.statusIds,
    priorities: filters.priorities,
    types: filters.types,
    assignees: filters.assignees.map(toAssigneeOption),
    labels: filters.labels,
    sprintIds: filters.sprintIds,
    parentIds: filters.parentIds,
    due: filters.due,
    archived: filters.archived,
  }
  const change = (id: string, value: string[] | string | boolean) => {
    if ((MULTI_KEYS as readonly string[]).includes(id)) {
      const list = Array.isArray(value) ? value : []
      onChange({ ...filters, [id]: id === "assignees" ? list.map(fromAssigneeOption) : list })
    } else if (id === "due") {
      onChange({ ...filters, due: (value || "any") as DueWindow })
    } else if (id === "archived") {
      onChange({ ...filters, archived: (value || "hide") as TaskFilters["archived"] })
    }
  }
  return (
    <FiltersBar
      // `contents`: the search, the filter button and the toolbar's own
      // controls wrap as one row rather than as a bar inside a bar.
      className="contents"
      narrow={narrow}
      search={{ value: filters.query, onChange: (query) => onChange({ ...filters, query }), placeholder: "Search tasks…" }}
      fields={fields}
      values={values}
      onFilterChange={change}
      filterCount={activeFilterCount(filters)}
      onClearFilters={() => onChange({ ...EMPTY_FILTERS, query: filters.query })}
    />
  )
}

/** Group, sort and table columns: how the visible list is laid out. */
function DisplayPopover({ mode, view, onChange, narrow }: { mode: WorkspaceMode; view: ViewState; onChange: (patch: Partial<ViewState>) => void; narrow: boolean }) {
  const groupLabel = (g: GroupBy) => (g === "none" ? "Status (default)" : GROUP_LABEL[g])
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button type="button" variant="outline" size="sm" title="Display" className="pointer-coarse:h-11">
            <SlidersHorizontal data-icon="inline-start" />
            <span className="hidden @panel-sm:inline">Display</span>
          </Button>
        }
      />
      <PopoverContent align="end" className="grid w-72 gap-4 p-4">
        {mode === "list" && (
          <div className="grid gap-2">
            <Label>Group</Label>
            <Select value={view.groupBy} onValueChange={(v) => v && onChange({ groupBy: v as GroupBy })}>
              <SelectTrigger className="w-full">
                <SelectValue>{groupLabel(view.groupBy)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {GROUP_BYS.map((g) => (
                  <SelectItem key={g} value={g}>
                    {groupLabel(g)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="grid gap-2">
          <Label>Sort</Label>
          <Select value={view.sortBy} onValueChange={(v) => v && onChange({ sortBy: v as SortBy })}>
            <SelectTrigger className="w-full">
              <SelectValue>{SORT_LABEL[view.sortBy]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {SORT_BYS.map((s) => (
                <SelectItem key={s} value={s}>
                  {SORT_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Segmented
            label="Sort direction"
            value={view.sortDir}
            onChange={(sortDir) => onChange({ sortDir })}
            options={[
              { value: "asc", label: "Asc" },
              { value: "desc", label: "Desc" },
            ]}
          />
        </div>
        {mode === "table" && (
          <div className="grid gap-2">
            <Label>Columns</Label>
            <div className="grid grid-cols-2 gap-2">
              {TABLE_COLUMNS.map((c) => (
                <Label key={c} className="font-normal">
                  <Checkbox
                    checked={view.columns.includes(c)}
                    onCheckedChange={(checked) =>
                      onChange({
                        columns: checked ? TABLE_COLUMNS.filter((x) => x === c || view.columns.includes(x)) : view.columns.filter((x) => x !== c),
                      })
                    }
                  />
                  {COLUMN_LABEL[c]}
                </Label>
              ))}
            </div>
            {narrow && <p className="text-xs text-muted-foreground">Listed under each row at this width.</p>}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** Saved views: pick, save, update, leave, delete. */
function ViewsMenu({
  savedViews,
  activeViewId,
  onPickView,
  onSaveView,
  onDeleteView,
}: {
  savedViews: BoardView[]
  activeViewId: string | null
  onPickView: (view: BoardView | null) => void
  onSaveView: (update: boolean) => void
  onDeleteView: (view: BoardView) => void
}) {
  const confirm = useConfirm()
  const active = savedViews.find((v) => v.id === activeViewId) ?? null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button type="button" variant="outline" size="sm" className="max-w-48 pointer-coarse:h-11">
            <Bookmark data-icon="inline-start" />
            <span className="truncate">{active?.name ?? "Views"}</span>
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Saved views</DropdownMenuLabel>
          {savedViews.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">None yet. Set up filters, then save.</p>}
          {savedViews.map((v) => {
            const Icon = MODES.find((m) => m.id === v.kind)?.icon ?? Bookmark
            return (
              <DropdownMenuItem key={v.id} onClick={() => onPickView(v)}>
                <Icon />
                <span className="flex-1 truncate">{v.name}</span>
                {v.id === activeViewId && <Check className="text-primary" />}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onSaveView(false)}>
          <Plus /> Save view…
        </DropdownMenuItem>
        {active && (
          <>
            <DropdownMenuItem onClick={() => onSaveView(true)}>
              <Save /> Update “{active.name}”…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onPickView(null)}>
              <LogOut /> Leave view
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={async () => {
                if (await confirm({ title: `Delete “${active.name}”?`, description: "The saved view goes for everyone. Tasks are not touched.", confirmLabel: "Delete", destructive: true }))
                  onDeleteView(active)
              }}
            >
              <Trash2 /> Delete “{active.name}”…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function FilterPill({ label, onRemove, children }: { label: string; onRemove: () => void; children?: React.ReactNode }) {
  return (
    <Badge variant="outline" className="h-7 gap-1.5 pe-0.5 pointer-coarse:h-9">
      {children}
      <span className="max-w-40 truncate">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter ${label}`}
        className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground pointer-coarse:size-8"
      >
        <X className="size-3.5" />
      </button>
    </Badge>
  )
}

/** Every active facet as a removable pill, then "Clear all". Wraps, never scrolls. */
function ActiveFilterPills({
  filters,
  onChange,
  statuses,
  sprints,
  epics,
  boardKey,
}: {
  filters: TaskFilters
  onChange: (next: TaskFilters) => void
  statuses: BoardStatus[]
  sprints: Sprint[]
  epics: Task[]
  boardKey: string
}) {
  if (activeFilterCount(filters) === 0) return null
  const without = <K extends (typeof MULTI_KEYS)[number]>(key: K, value: string) =>
    onChange({ ...filters, [key]: (filters[key] as string[]).filter((v) => v !== value) })
  const pills: React.ReactNode[] = []
  for (const id of filters.statusIds) {
    const s = statuses.find((x) => x.id === id)
    if (s)
      pills.push(
        <FilterPill key={`s-${id}`} label={s.name} onRemove={() => without("statusIds", id)}>
          <span className={cn("size-2 rounded-full", s.color ? COLOR_DOT[s.color] : "bg-muted-foreground/40")} />
        </FilterPill>,
      )
  }
  for (const p of filters.priorities as TaskPriority[])
    pills.push(
      <FilterPill key={`p-${p}`} label={PRIORITY_LABEL[p]} onRemove={() => without("priorities", p)}>
        <PriorityIcon priority={p} />
      </FilterPill>,
    )
  for (const t of filters.types as TaskType[])
    pills.push(
      <FilterPill key={`t-${t}`} label={TYPE_LABEL[t]} onRemove={() => without("types", t)}>
        <TypeIcon type={t} />
      </FilterPill>,
    )
  for (const a of filters.assignees)
    pills.push(
      <FilterPill key={`a-${a}`} label={a || "Unassigned"} onRemove={() => without("assignees", a)}>
        <AssigneeAvatar name={a || null} size="xs" />
      </FilterPill>,
    )
  for (const l of filters.labels) pills.push(<FilterPill key={`l-${l}`} label={l} onRemove={() => without("labels", l)} />)
  for (const id of filters.sprintIds) {
    const name = id === "backlog" ? "Backlog" : sprints.find((s) => s.id === id)?.name
    if (name) pills.push(<FilterPill key={`sp-${id}`} label={`Sprint: ${name}`} onRemove={() => without("sprintIds", id)} />)
  }
  for (const id of filters.parentIds) {
    const epic = epics.find((e) => e.id === id)
    const name = id === "none" ? "Top level only" : epic ? `${taskKey(epic, boardKey)} ${epic.title}` : null
    if (name) pills.push(<FilterPill key={`pa-${id}`} label={id === "none" ? name : `Parent: ${name}`} onRemove={() => without("parentIds", id)} />)
  }
  if (filters.due !== "any")
    pills.push(<FilterPill key="due" label={`Due: ${DUE_OPTIONS.find((d) => d.value === filters.due)?.label ?? filters.due}`} onRemove={() => onChange({ ...filters, due: "any" })} />)
  if (filters.archived !== "hide")
    pills.push(<FilterPill key="archived" label={filters.archived === "only" ? "Archived only" : "Including archived"} onRemove={() => onChange({ ...filters, archived: "hide" })} />)
  return (
    <div className={cn("flex flex-wrap items-center gap-2 pb-3", INSET_X)}>
      {pills}
      <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ ...EMPTY_FILTERS, query: filters.query })} className="text-muted-foreground pointer-coarse:h-11">
        Clear all
      </Button>
    </div>
  )
}

/** The toolbar under the view switch: search and filters, display, saved
    views and the count on one wrapping row, then the active filters as pills. */
export function Toolbar({
  mode,
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
  visible,
  total,
  narrow,
}: {
  mode: WorkspaceMode
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
  /** `true` asks to update the active view; `false` to save a new one. */
  onSaveView: (update: boolean) => void
  onDeleteView: (view: BoardView) => void
  visible: number
  total: number
  /** The workspace is narrower than `@panel-sm` (measured by the shell). */
  narrow: boolean
}) {
  const setFilters = (filters: TaskFilters) => onChange({ filters })
  return (
    <>
      <div className={cn("flex flex-wrap items-center gap-2 py-3", INSET_X)}>
        <TaskFiltersBar filters={view.filters} onChange={setFilters} statuses={statuses} sprints={sprints} epics={epics} facets={facets} boardKey={boardKey} narrow={narrow} />
        {(mode === "list" || mode === "table" || mode === "sprints") && <DisplayPopover mode={mode} view={view} onChange={onChange} narrow={narrow} />}
        <ViewsMenu savedViews={savedViews} activeViewId={activeViewId} onPickView={onPickView} onSaveView={onSaveView} onDeleteView={onDeleteView} />
        <span className="ms-auto hidden text-sm tabular-nums text-muted-foreground @panel-sm:inline">
          {visible === total ? `${total} ${total === 1 ? "task" : "tasks"}` : `${visible} of ${total}`}
        </span>
      </div>
      <ActiveFilterPills filters={view.filters} onChange={setFilters} statuses={statuses} sprints={sprints} epics={epics} boardKey={boardKey} />
    </>
  )
}
