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
import { flattenSelectOptions, recommendedValue } from "@/lib/session-options"
import { reportError } from "@/lib/errors"
import { cn } from "@/lib/utils"
import { useSetProfileFlags } from "@/lib/queries/catalog"
import type { Profile } from "@/lib/settings"

export interface Choice {
  value: string
  name: string
  /** A mark drawn before the name — a profile's logo, an agent's brand. */
  icon?: React.ReactNode
  /** Optional group label — choices with the same group are rendered under a
      shared heading in the submenu. */
  group?: string
  /** The agent marks this one as its recommendation (ACP `_meta`, read in
      `selectChoices`) — drawn as a muted suffix, never selected for you. */
  recommended?: boolean
  /** A muted word on the row's end that is a *fact about the choice*, not a
      recommendation — "Not installed". The row stays pickable. */
  note?: string
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
        {(choice.note || choice.recommended) && (
          <span
            className={cn(
              "ml-auto shrink-0 pl-2 text-[11px]",
              choice.note ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {choice.note ?? "Recommended"}
          </span>
        )}
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
export const selectChoices = (option: acp.SessionConfigOption): Choice[] => {
  if (option.type !== "select") return []
  const recommended = recommendedValue(option)
  return flattenSelectOptions(option.options).map((choice) => ({
    value: choice.value,
    name: choice.name,
    recommended: choice.value === recommended,
  }))
}

/** The composer's thread-settings chip. */
export const PILL =
  "h-5 gap-1 rounded-pill border-0 bg-transparent px-1.5 text-[11px] shadow-none text-muted-foreground hover:bg-muted/60 hover:text-foreground aria-expanded:bg-muted/60 data-popup-open:bg-muted/60 pointer-coarse:h-7 pointer-coarse:px-2 [&_[data-slot=avatar]]:size-3.5"

/**
 * The words on the settings chip, shared by the draft's trigger and the started
 * thread's so the two cannot drift.
 *
 * The model is the part the reader is looking for, so it is the only piece
 * that gives way: effort and mode are `shrink-0` and the model ellipsizes
 * first, instead of one string being cut wherever the cap lands. The persona
 * is a prefix that pushes the model out of a narrow chip, so it waits for
 * `@panel-sm` (the panel's width, never the device's) — the title and the menu
 * still carry it. The mode stays at every width: a silently-active "accept
 * edits" is the one setting you must see.
 */
export function PillLabel({
  persona,
  model,
  effort,
  mode,
}: {
  persona?: string
  model: string
  effort?: string | null
  mode?: string
}) {
  return (
    <span className="flex min-w-0 max-w-52 items-baseline gap-1 @panel-sm:max-w-64">
      {persona && <span className="hidden shrink-0 @panel-sm:inline">{persona} ·</span>}
      <span className="min-w-0 truncate font-medium text-foreground/90">{model}</span>
      {effort && <span className="shrink-0 capitalize">· {effort}</span>}
      {mode && <span className="shrink-0">· {mode}</span>}
    </span>
  )
}

/**
 * The profile's helper model — what the agent's side-jobs run on — as one more
 * row of the settings menu. It edits the *profile* (`smallModel`), never the
 * thread: the helper goes to the same endpoint with the same key, so it is one
 * of this provider's models, and every thread on the profile takes it from its
 * next start. Drawn only where the profile owns a catalog to pick from.
 */
export function HelperModelRow({ profile }: { profile: Profile }) {
  const setFlags = useSetProfileFlags()
  if (profile.virtual || profile.models.length === 0) return null
  return (
    <MenuRow
      label="Helper model"
      value={profile.smallModel || SAME_AS_THREAD}
      choices={[
        { value: SAME_AS_THREAD, name: "Same as thread" },
        ...profile.models.map((m) => ({ value: m.id, name: m.label, group: m.group || undefined })),
      ]}
      onSelect={(value) =>
        void setFlags
          .mutateAsync({ id: profile.id, smallModel: value === SAME_AS_THREAD ? "" : value })
          .catch((err) => reportError(err, "Couldn't change the helper model"))
      }
    />
  )
}

/** Sentinel for "the session model", which is not itself a model id. */
const SAME_AS_THREAD = "__same__"
