import * as React from "react"
import { Check, ChevronDown, Search, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SavedViewsMenu } from "@/components/pm/saved-views"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { Actions } from "@/lib/actions"
import { isFilterActive } from "@/lib/pm/filtering"
import type { Board, FilterSpec, ViewName } from "@/lib/pm/types"
import { cn } from "@/lib/utils"

/* ── The filter bar ──
   One FilterSpec, one owner: pm-page holds the spec and hands every view the
   already-narrowed list (lib/pm/filtering). This component only edits the spec
   — it never touches tasks, never fetches, and never decides what a view does
   with the result.

   The controls are chips rather than a form because a filter is read far more
   often than it is set: a glance has to answer "what am I not seeing?", so an
   active facet says so on its own trigger and every chosen value is a removable
   badge next to it.

   Free-form assignees (single bearer token, no accounts) mean the assignee
   picker cannot offer a closed list: it takes whatever names the board's tasks
   already carry, and its search box doubles as "add a name I typed". */

const PRIORITY_NAMES = ["None", "Low", "Medium", "High", "Urgent"]

const DUE_NAMES: Record<NonNullable<FilterSpec["due"]>, string> = {
  overdue: "Overdue",
  today: "Due today",
  week: "Due this week",
}

const ANY = "__any__"

/** Toggle one id in a filter's array, collapsing an emptied list back to
    "no filter" — an empty array must not read as "match nothing". */
function toggle(list: string[] | undefined, value: string): string[] | undefined {
  const next = list?.includes(value) ? list.filter((v) => v !== value) : [...(list ?? []), value]
  return next.length > 0 ? next : undefined
}

export interface FilterBarProps {
  board: Board
  value: FilterSpec
  /** Applying a saved view can also carry the tab it was saved from — a caller
      with nowhere to switch to may ignore the second argument. */
  onChange: (spec: FilterSpec, view?: ViewName) => void
  /** Threaded through to the saved-views menu, which writes the board's
      `savedViews` column. Without it the menu is not offered. */
  actions?: Actions
  /** Assignee names seen on the loaded board — pm-page derives them from the
      tasks it already has. The picker still accepts a name typed by hand. */
  assigneeOptions?: string[]
  /** The `/` shortcut lives in pm-page; this is the handle it focuses. */
  inputRef?: React.Ref<HTMLInputElement>
  autoFocus?: boolean
  className?: string
}

export function FilterBar({
  board,
  value,
  onChange,
  actions,
  assigneeOptions = [],
  inputRef,
  autoFocus,
  className,
}: FilterBarProps) {
  const patch = (next: Partial<FilterSpec>) => onChange({ ...value, ...next })
  const active = isFilterActive(value)

  const columnName = (id: string) => board.columns.find((c) => c.id === id)?.name ?? id
  const typeName = (id: string) => board.issueTypes.find((t) => t.id === id)?.name ?? id
  const label = (id: string) => board.labels.find((l) => l.id === id)

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <div className="relative min-w-40 flex-1 sm:max-w-72">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          autoFocus={autoFocus}
          value={value.q ?? ""}
          onChange={(e) => patch({ q: e.target.value || undefined })}
          placeholder="Search tasks"
          aria-label="Search tasks"
          className="h-8 pl-8 text-sm"
        />
        {value.q && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Clear search"
            onClick={() => patch({ q: undefined })}
            className="absolute top-1/2 right-1.5 -translate-y-1/2"
          >
            <X />
          </Button>
        )}
      </div>

      <MultiPicker
        title="Status"
        count={value.columnIds?.length ?? 0}
        options={board.columns.map((c) => ({ value: c.id, name: c.name, color: c.color }))}
        selected={value.columnIds ?? []}
        onToggle={(id) => patch({ columnIds: toggle(value.columnIds, id) })}
        onClear={() => patch({ columnIds: undefined })}
      />
      {board.issueTypes.length > 0 && (
        <MultiPicker
          title="Type"
          count={value.typeIds?.length ?? 0}
          options={board.issueTypes.map((t) => ({ value: t.id, name: t.name }))}
          selected={value.typeIds ?? []}
          onToggle={(id) => patch({ typeIds: toggle(value.typeIds, id) })}
          onClear={() => patch({ typeIds: undefined })}
        />
      )}
      <ChoiceChip
        title="Priority"
        label={
          value.priorityGte === undefined
            ? "Priority"
            : `${PRIORITY_NAMES[value.priorityGte] ?? value.priorityGte}+`
        }
        activeChip={value.priorityGte !== undefined}
        value={value.priorityGte === undefined ? ANY : String(value.priorityGte)}
        choices={[
          { value: ANY, name: "Any priority" },
          ...[1, 2, 3, 4].map((p) => ({ value: String(p), name: `${PRIORITY_NAMES[p]} or higher` })),
        ]}
        onSelect={(next) => patch({ priorityGte: next === ANY ? undefined : Number(next) })}
      />
      {board.labels.length > 0 && (
        <MultiPicker
          title="Labels"
          count={value.labelIds?.length ?? 0}
          options={board.labels.map((l) => ({ value: l.id, name: l.name, color: l.color }))}
          selected={value.labelIds ?? []}
          onToggle={(id) => patch({ labelIds: toggle(value.labelIds, id) })}
          onClear={() => patch({ labelIds: undefined })}
        />
      )}
      <MultiPicker
        title="Assignees"
        count={value.assignees?.length ?? 0}
        /* Whoever is already filtered stays listed even if no loaded task
           carries the name — otherwise removing the last such task would make
           the active filter unremovable from its own picker. */
        options={Array.from(new Set([...assigneeOptions, ...(value.assignees ?? [])]))
          .sort((a, b) => a.localeCompare(b))
          .map((name) => ({ value: name, name }))}
        selected={value.assignees ?? []}
        onToggle={(name) => patch({ assignees: toggle(value.assignees, name) })}
        onClear={() => patch({ assignees: undefined })}
        addLabel="Filter by this name"
      />
      <ChoiceChip
        title="Due"
        label={value.due ? DUE_NAMES[value.due] : "Due"}
        activeChip={!!value.due}
        value={value.due ?? ANY}
        choices={[
          { value: ANY, name: "Any date" },
          ...(Object.keys(DUE_NAMES) as Array<NonNullable<FilterSpec["due"]>>).map((key) => ({
            value: key,
            name: DUE_NAMES[key],
          })),
        ]}
        onSelect={(next) =>
          patch({ due: next === ANY ? undefined : (next as NonNullable<FilterSpec["due"]>) })
        }
      />

      {/* A saved view is this same FilterSpec under a name (plus, optionally,
          the tab it was saved from) — so it applies through `onChange`, exactly
          like ticking a facet does. */}
      {actions && (
        <SavedViewsMenu board={board} value={value} onChange={onChange} actions={actions} />
      )}

      {active && (
        <>
          <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />
          <div className="flex flex-wrap items-center gap-1">
            {(value.columnIds ?? []).map((id) => (
              <ActiveChip
                key={`col-${id}`}
                text={columnName(id)}
                onRemove={() => patch({ columnIds: toggle(value.columnIds, id) })}
              />
            ))}
            {(value.typeIds ?? []).map((id) => (
              <ActiveChip
                key={`type-${id}`}
                text={typeName(id)}
                onRemove={() => patch({ typeIds: toggle(value.typeIds, id) })}
              />
            ))}
            {(value.labelIds ?? []).map((id) => (
              <ActiveChip
                key={`label-${id}`}
                text={label(id)?.name ?? id}
                color={label(id)?.color ?? null}
                onRemove={() => patch({ labelIds: toggle(value.labelIds, id) })}
              />
            ))}
            {(value.assignees ?? []).map((name) => (
              <ActiveChip
                key={`who-${name}`}
                text={name}
                onRemove={() => patch({ assignees: toggle(value.assignees, name) })}
              />
            ))}
            {value.priorityGte !== undefined && (
              <ActiveChip
                text={`${PRIORITY_NAMES[value.priorityGte] ?? value.priorityGte}+`}
                onRemove={() => patch({ priorityGte: undefined })}
              />
            )}
            {value.due && (
              <ActiveChip text={DUE_NAMES[value.due]} onRemove={() => patch({ due: undefined })} />
            )}
          </div>
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            onClick={() =>
              /* Shelf switches are not filters: clearing must not drop the user
                 out of the archive or the trash they are looking at. */
              onChange({ archived: value.archived, trashed: value.trashed })
            }
          >
            Clear
          </Button>
        </>
      )}
    </div>
  )
}

/** One chosen value, with the X that removes it. */
function ActiveChip({
  text,
  color,
  onRemove,
}: {
  text: string
  color?: string | null
  onRemove: () => void
}) {
  return (
    <Badge variant="outline" className="gap-1 pr-1 font-normal">
      {color && <Dot color={color} />}
      <span className="max-w-32 truncate">{text}</span>
      <button
        type="button"
        aria-label={`Remove ${text}`}
        onClick={onRemove}
        className="grid size-3.5 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="size-2.5" />
      </button>
    </Badge>
  )
}

/** A board colour is data, not a theme token — the dot is the one place it is
    allowed to be an inline style. */
function Dot({ color }: { color: string | null }) {
  return (
    <span
      aria-hidden
      className="size-2 shrink-0 rounded-full bg-muted-foreground/40"
      style={color ? { backgroundColor: color } : undefined}
    />
  )
}

function ChipTrigger({
  title,
  label,
  active,
}: {
  title: string
  label: string
  active: boolean
}) {
  return (
    <Button
      variant="outline"
      size="xs"
      title={title}
      className={cn(
        "font-normal text-muted-foreground",
        active && "border-primary/40 bg-primary/10 text-foreground"
      )}
    >
      <span className="max-w-32 truncate">{label}</span>
      <ChevronDown className="opacity-60" />
    </Button>
  )
}

/** Single-choice facet (priority, due) — a menu, because there is nothing to
    search and picking one closes it. */
function ChoiceChip({
  title,
  label,
  activeChip,
  value,
  choices,
  onSelect,
}: {
  title: string
  label: string
  activeChip: boolean
  value: string
  choices: { value: string; name: string }[]
  onSelect: (value: string) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<ChipTrigger title={title} label={label} active={activeChip} />}
      />
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{title}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(next) => next && onSelect(String(next))}
          >
            {choices.map((choice) => (
              <DropdownMenuRadioItem key={choice.value} value={choice.value}>
                {choice.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Multi-choice facet.
 *
 * A popover, not a menu: a menu owns typeahead and closes on click, and this
 * one holds a text field and stays open across several picks. `addLabel` turns
 * the search box into an entry field too — the assignee list has no closed set
 * to search.
 */
function MultiPicker({
  title,
  count,
  options,
  selected,
  onToggle,
  onClear,
  addLabel,
}: {
  title: string
  count: number
  options: { value: string; name: string; color?: string | null }[]
  selected: string[]
  onToggle: (value: string) => void
  onClear: () => void
  addLabel?: string
}) {
  const [query, setQuery] = React.useState("")
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? options.filter((option) => option.name.toLowerCase().includes(needle))
    : options
  const searchable = options.length > 7 || !!addLabel
  const canAdd =
    !!addLabel &&
    query.trim().length > 0 &&
    !options.some((option) => option.value === query.trim())

  const add = () => {
    onToggle(query.trim())
    setQuery("")
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <ChipTrigger
            title={title}
            label={count > 0 ? `${title} · ${count}` : title}
            active={count > 0}
          />
        }
      />
      <PopoverContent align="start" className="w-60 gap-2 p-2">
        {searchable && (
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canAdd) {
                e.preventDefault()
                add()
              }
            }}
            placeholder={addLabel ? "Search or type a name" : `Filter ${title.toLowerCase()}`}
            aria-label={`Filter ${title.toLowerCase()}`}
            className="h-8 text-sm"
          />
        )}
        <div className="flex max-h-64 flex-col overflow-y-auto">
          {canAdd && (
            <button
              type="button"
              onClick={add}
              className="flex items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm hover:bg-muted"
            >
              <span className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">
                {addLabel}: <span className="font-medium">{query.trim()}</span>
              </span>
            </button>
          )}
          {shown.map((option) => {
            const on = selected.includes(option.value)
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={on}
                onClick={() => onToggle(option.value)}
                className="flex items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm hover:bg-muted"
              >
                <Check className={cn("size-3.5 shrink-0", on ? "opacity-100" : "opacity-0")} />
                {option.color !== undefined && <Dot color={option.color ?? null} />}
                <span className="min-w-0 flex-1 truncate">{option.name}</span>
              </button>
            )
          })}
          {shown.length === 0 && !canAdd && (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">Nothing to pick</p>
          )}
        </div>
        {count > 0 && (
          <Button variant="ghost" size="xs" className="justify-start" onClick={onClear}>
            Clear {title.toLowerCase()}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}
