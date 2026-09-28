/* ── One row shape for every setting ──
   Model, effort, permission mode and whatever else an agent invents all render
   through here, in the session menu and in the draft menu alike. The point is
   that a picker driven by ACP and a picker driven by the profile catalog are
   the same control to look at — the difference between them is what happens on
   select, and that is the caller's business, not the row's. */
import type * as acp from "@daedalus/acp"
import * as React from "react"
import { PlusIcon } from "lucide-react"
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import { flattenSelectOptions } from "@/lib/session-options"

export interface Choice {
  value: string
  name: string
  /** A mark drawn before the name — a profile's logo, an agent's brand. */
  icon?: React.ReactNode
  /** Optional group label — choices with the same group are rendered under a
      shared heading in the submenu. */
  group?: string
}

/** The row that makes the list longer, at the foot of a submenu: "Add model…",
    "New profile…", "New project…". A catalog you can pick from and a catalog
    you can only add to from settings are the same menu to look at, and the
    second one sends you three clicks away to name one model. */
export interface MenuAdd {
  label: string
  /** Runs on select; the menu closes first, because every one of these opens
      something (a prompt, a page) that owns the focus next. */
  onSelect: () => void
}

/** Past this many choices the submenu grows a filter box. Under it the list is
    shorter than the box would make it, and a search field over six rows is a
    control asking to be used for nothing. */
const SEARCH_THRESHOLD = 8

/** Case-insensitive substring, over what the reader can see plus the id they
    may have pasted. Deliberately not fuzzy: these are model ids and project
    paths, where a subsequence match is mostly noise. Exported because the
    strip's own picker (`PickerMenu`) filters the same way over a different
    row shape — one rule for what "search" means in a menu. */
export function menuFilter<T extends { value: string; name: string; group?: string; hint?: string }>(
  items: T[],
  query: string
): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter((item) =>
    [item.name, item.value, item.group ?? "", item.hint ?? ""].some((field) =>
      field.toLowerCase().includes(q)
    )
  )
}

/**
 * The filter box at the head of a menu popup.
 *
 * A plain input, not the Combobox: the list below is already rendered and a
 * filter over it is a substring test, not a second popup with its own anchor
 * inside one that has one.
 *
 * `stopPropagation` on the printable keys is what makes it work at all — Base
 * UI runs the menu's typeahead off keydown on the popup, so every character
 * typed here would otherwise jump the highlight to an item and the box would
 * take none of them. The navigation keys are deliberately let through: arrows,
 * Enter and Escape belong to the menu, so query → ↓ → Enter is one gesture.
 */
export function MenuSearchInput({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <input
      autoFocus
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (!MENU_KEYS.includes(event.key)) event.stopPropagation()
      }}
      placeholder={`Search ${label.toLowerCase()}…`}
      aria-label={`Search ${label.toLowerCase()}`}
      className="mb-1 w-full rounded-lg bg-muted/50 px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
    />
  )
}

const MENU_KEYS = ["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab", "Home", "End"]

/** The add row at the foot of a menu, for the pickers that can grow their own
    catalog. Same shape in a submenu and in the strip's picker.

    ponytail: the caller closes the menu and opens its dialog in the same tick,
    and the menu's own focus-restore fires as it unmounts. The dialog is modal
    and re-traps, so it wins; if a browser is ever seen yanking the caret back
    to the trigger, defer the `onSelect` past the close animation. */
export function MenuAddItem({ add }: { add: MenuAdd }) {
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={add.onSelect}>
        <PlusIcon className="size-4 text-muted-foreground" />
        {add.label}
      </DropdownMenuItem>
    </>
  )
}

export function MenuRow({
  label,
  value,
  choices,
  onSelect,
  add,
}: {
  label: string
  value: string
  choices: Choice[]
  onSelect: (value: string) => void
  /** When the catalog this row draws can be added to from here. */
  add?: MenuAdd
}) {
  const current = choices.find((choice) => choice.value === value)
  const [submenuOpen, setSubmenuOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  // The box is about *this* opening of the submenu, never the last one.
  React.useEffect(() => {
    if (!submenuOpen) setQuery("")
  }, [submenuOpen])
  const searchable = choices.length > SEARCH_THRESHOLD
  const shown = searchable ? menuFilter(choices, query) : choices

  /* When any choice carries a group, the submenu is partitioned into labelled
     sections.  The array order is the display order; a group label is drawn the
     first time its value appears, and a separator is drawn between adjacent
     groups.  Choices without a group go under no heading. */
  const hasGroups = shown.some((c) => c.group)

  /** Render one choice item, optionally preceded by a group header. */
  const renderChoice = (choice: Choice, prevGroup: string | undefined) => {
    const parts: React.ReactNode[] = []
    if (hasGroups && choice.group !== prevGroup) {
      if (prevGroup !== undefined) {
        parts.push(<DropdownMenuSeparator key={`sep-${choice.group ?? "none"}`} />)
      }
      if (choice.group) {
        parts.push(
          <DropdownMenuLabel key={`lbl-${choice.group}`} className="text-[11px] tracking-wide uppercase pt-1 pb-0.5">
            {choice.group}
          </DropdownMenuLabel>,
        )
      }
    }
    parts.push(
      <DropdownMenuRadioItem key={choice.value} value={choice.value}>
        {choice.icon}
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{choice.name}</span>
        </span>
      </DropdownMenuRadioItem>,
    )
    return parts
  }

  return (
    <DropdownMenuSub open={submenuOpen} onOpenChange={setSubmenuOpen}>
      <DropdownMenuSubTrigger>
        <span className="flex-1">{label}</span>
        {current?.icon}
        <span className="max-w-24 truncate text-xs text-muted-foreground">
          {current?.name ?? value}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="max-w-80 no-scrollbar">
          {searchable && <MenuSearchInput label={label} value={query} onChange={setQuery} />}
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(next) => {
              setSubmenuOpen(false)
              next && next !== value && onSelect(next)
            }}
          >
            {(() => {
              let prevGroup: string | undefined
              return shown.flatMap((choice) => {
                const parts = renderChoice(choice, prevGroup)
                prevGroup = choice.group
                return parts
              })
            })()}
          </DropdownMenuRadioGroup>
          {/* Absence is said, because a filter that matches nothing and a
              catalog that is empty look identical as a blank popup. */}
          {shown.length === 0 && (
            <DropdownMenuItem disabled className="text-xs">
              No match
            </DropdownMenuItem>
          )}
          {add && (
            <MenuAddItem
              add={{
                label: add.label,
                onSelect: () => {
                  setSubmenuOpen(false)
                  add.onSelect()
                },
              }}
            />
          )}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  )
}

/**
 * The same row, for a setting whose choices have not been learned yet.
 *
 * A menu that simply leaves the row out until the probe answers is a menu that
 * changes height and order under the pointer, and — worse — one that says this
 * agent has no model to pick for as long as the spawn takes. Drawn disabled and
 * with the value skeletoned, which is the same bargain the project page's tiles
 * make: a shape that is waiting, never a zero.
 */
export function MenuRowSkeleton({ label }: { label: string }) {
  return (
    <DropdownMenuItem disabled>
      <span className="flex-1">{label}</span>
      <span className="h-3 w-14 animate-pulse rounded bg-muted" />
    </DropdownMenuItem>
  )
}

/** A select option's choices, flattened out of any groups the agent used. */
export const selectChoices = (option: acp.SessionConfigOption): Choice[] =>
  option.type === "select"
    ? flattenSelectOptions(option.options).map((choice) => ({
        value: choice.value,
        name: choice.name,
      }))
    : []
