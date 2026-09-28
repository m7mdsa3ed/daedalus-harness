/* ── The parts a config menu is assembled from, swappable ──
   The session and draft menus are one body each — who answers, how, and the
   agent's own options — and that body is drawn in two places: behind a
   dropdown (the held-turn card, the routine form) and flat in the composer,
   where nothing may open a popup. Rather than a second copy of each body that
   would drift from the first, the body asks this context for its parts. The
   dropdown kit is the menu components as they were; the inline kit draws the
   same rows in flow — a row that picks a value expands its list underneath
   itself, never over the page. */
import * as React from "react"
import { CheckIcon, ChevronRightIcon, PlusIcon } from "lucide-react"
import {
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import {
  MenuAddItem,
  MenuRow,
  MenuRowSkeleton,
  MenuSearchInput,
  SEARCH_THRESHOLD,
  menuFilter,
  type MenuAdd,
  type MenuRowProps,
} from "@/components/config-menu"
import { cn } from "@/lib/utils"

export interface MenuItemProps {
  onClick?: () => void
  disabled?: boolean
  className?: string
  children: React.ReactNode
  variant?: "default" | "destructive"
  /** False for a row that acts without being the last thing picked (a retry,
      a refresh): the dropdown stays open to show the result. Inline there is
      nothing to close, so the inline kit ignores it. */
  closeOnClick?: boolean
}

export interface MenuCheckboxItemProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  children: React.ReactNode
}

export interface MenuKit {
  Group: React.ComponentType<{ children: React.ReactNode }>
  Label: React.ComponentType<{ className?: string; children: React.ReactNode }>
  Separator: React.ComponentType
  Item: React.ComponentType<MenuItemProps>
  CheckboxItem: React.ComponentType<MenuCheckboxItemProps>
  Row: React.ComponentType<MenuRowProps>
  RowSkeleton: React.ComponentType<{ label: string }>
  AddItem: React.ComponentType<{ add: MenuAdd }>
}

export const DROPDOWN_KIT: MenuKit = {
  Group: DropdownMenuGroup,
  Label: DropdownMenuLabel,
  Separator: () => <DropdownMenuSeparator />,
  Item: DropdownMenuItem,
  CheckboxItem: ({ checked, onCheckedChange, children }) => (
    <DropdownMenuCheckboxItem checked={checked} onCheckedChange={(next) => onCheckedChange(next === true)}>
      {children}
    </DropdownMenuCheckboxItem>
  ),
  Row: MenuRow,
  RowSkeleton: MenuRowSkeleton,
  AddItem: MenuAddItem,
}

/** The one row shape every inline part shares, so a button, a switch row and a
    picker read as one list. */
const ROW =
  "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs outline-none hover:bg-muted focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

function InlineLabel({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase", className)}>
      {children}
    </div>
  )
}

function InlineSeparator() {
  return <div role="separator" className="my-1 h-px bg-foreground/10" />
}

function InlineItem({ onClick, disabled, className, children, variant }: MenuItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(ROW, variant === "destructive" && "text-destructive", className)}
    >
      {children}
    </button>
  )
}

function InlineCheckboxItem({ checked, onCheckedChange, children }: MenuCheckboxItemProps) {
  /* A label, so the whole row toggles — the switch is the reading, the row is
     the target. */
  return (
    <label className={cn(ROW, "cursor-pointer")}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <Switch size="sm" checked={checked} onCheckedChange={(next) => onCheckedChange(next)} />
    </label>
  )
}

function InlineRowSkeleton({ label }: { label: string }) {
  return (
    <div className={cn(ROW, "hover:bg-transparent")} aria-busy>
      <span className="flex-1">{label}</span>
      <span className="h-3 w-14 animate-pulse rounded bg-muted" />
    </div>
  )
}

function InlineAddItem({ add }: { add: MenuAdd }) {
  return (
    <button type="button" onClick={add.onSelect} className={ROW}>
      <PlusIcon className="size-4 text-muted-foreground" />
      {add.label}
    </button>
  )
}

/**
 * `MenuRow`, in flow: the label and the current value, and a click that opens
 * the choices directly underneath rather than beside it in a submenu. Same
 * list otherwise — group headings, a filter past the same count, "No match",
 * the add row at its foot — and a pick collapses it, as choosing from a
 * submenu closes one.
 */
function InlineRow({ label, value, choices, onSelect, add }: MenuRowProps) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const listId = React.useId()
  const current = choices.find((choice) => choice.value === value)
  const searchable = choices.length > SEARCH_THRESHOLD
  const shown = searchable ? menuFilter(choices, query) : choices
  const hasGroups = shown.some((choice) => choice.group)
  const toggle = (next: boolean) => {
    setOpen(next)
    // The box is about this opening of the list, never the last one.
    setQuery("")
  }

  let prevGroup: string | undefined
  const rows = shown.flatMap((choice) => {
    const parts: React.ReactNode[] = []
    // MenuRow's rule: a heading where a group starts, a line after a named one.
    if (hasGroups && choice.group !== prevGroup) {
      if (prevGroup !== undefined) parts.push(<InlineSeparator key={`sep-${choice.group ?? "none"}`} />)
      if (choice.group) {
        parts.push(
          <InlineLabel key={`lbl-${choice.group}`} className="pt-1 pb-0.5">
            {choice.group}
          </InlineLabel>
        )
      }
    }
    prevGroup = choice.group
    const selected = choice.value === value
    parts.push(
      <button
        key={choice.value}
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={() => {
          toggle(false)
          if (!selected) onSelect(choice.value)
        }}
        className={ROW}
      >
        {choice.icon}
        <span className="min-w-0 flex-1 truncate">{choice.name}</span>
        {selected && <CheckIcon className="size-4" />}
      </button>
    )
    return parts
  })

  return (
    <div
      onKeyDown={(event) => {
        // Escape folds the list first; only a closed row lets it through.
        if (event.key === "Escape" && open) {
          event.stopPropagation()
          toggle(false)
        }
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => toggle(!open)}
        className={ROW}
      >
        <span className="flex-1">{label}</span>
        {current?.icon}
        <span className="max-w-32 truncate text-muted-foreground">{current?.name ?? value}</span>
        <ChevronRightIcon
          className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <div id={listId} className="mb-1 ml-3 border-l border-foreground/10 pl-1">
          {searchable && <MenuSearchInput label={label} value={query} onChange={setQuery} />}
          <div role="radiogroup" aria-label={label} className="max-h-56 overflow-y-auto">
            {rows}
          </div>
          {/* Said, because a filter that matches nothing and an empty catalog
              are otherwise the same blank. */}
          {shown.length === 0 && <div className={cn(ROW, "text-muted-foreground hover:bg-transparent")}>No match</div>}
          {add && (
            <>
              <InlineSeparator />
              <InlineAddItem
                add={{
                  label: add.label,
                  onSelect: () => {
                    toggle(false)
                    add.onSelect()
                  },
                }}
              />
            </>
          )}
        </div>
      )}
    </div>
  )
}

export const INLINE_KIT: MenuKit = {
  Group: ({ children }) => <div role="group">{children}</div>,
  Label: InlineLabel,
  Separator: InlineSeparator,
  Item: InlineItem,
  CheckboxItem: InlineCheckboxItem,
  Row: InlineRow,
  RowSkeleton: InlineRowSkeleton,
  AddItem: InlineAddItem,
}

export const MenuKitContext = React.createContext<MenuKit>(DROPDOWN_KIT)

export const useMenuKit = () => React.useContext(MenuKitContext)
