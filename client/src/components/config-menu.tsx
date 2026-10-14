/* ── One row shape for every setting ──
   Model, effort, permission mode and whatever else an agent invents all render
   through here, in the session menu and in the draft menu alike. The point is
   that a picker driven by ACP and a picker driven by the profile catalog are
   the same control to look at — the difference between them is what happens on
   select, and that is the caller's business, not the row's. */
import type * as acp from "@daedalus/acp"
import * as React from "react"
import { CheckIcon, PlusIcon, SearchIcon, SlidersHorizontalIcon, Trash2Icon } from "lucide-react"
import {
  DropdownMenuCheckboxItem,
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
import type { ModelRole } from "@/lib/settings"
import { cn } from "@/lib/utils"
import { EffortMeter, ModeIcon } from "@/components/composer/option-icons"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

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

interface ChoiceSection {
  group?: string
  choices: Choice[]
}

/** Collect matching groups together, ordered by their first choice. */
function groupChoices(choices: Choice[]): ChoiceSection[] {
  const sections = new Map<string | undefined, ChoiceSection>()
  for (const choice of choices) {
    let section = sections.get(choice.group)
    if (!section) {
      section = { group: choice.group, choices: [] }
      sections.set(choice.group, section)
    }
    section.choices.push(choice)
  }
  return [...sections.values()]
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

/** What a row picks from — shared by the submenu (`MenuRow`) and the drawer
    (`ChoiceList`, a page of the mobile `ConfigDrawer`), so a picker keeps its
    props. */
export interface ChoicePick {
  label: string
  value: string
  choices: Choice[]
  onSelect: (value: string) => void
  /** When the catalog this row draws can be added to from here. */
  add?: MenuAdd
}

/**
 * A picker's choices as a plain list: a search box that is always there, the
 * groups with their headings, the current pick ticked, and the "Add…" row at
 * the foot. It is a page of the mobile settings drawer (`ConfigDrawer`), where a
 * nested flyout is the one thing a thumb cannot hit reliably.
 */
export function ChoiceList({
  value,
  choices,
  onSelect,
  add,
  label,
}: ChoicePick) {
  const [query, setQuery] = React.useState("")
  const shown = menuFilter(choices, query)
  const sections = groupChoices(shown)
  return (
    <div className="flex flex-col">
      <div className="relative pb-2">
        <SearchIcon className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search ${label.toLowerCase()}…`}
          aria-label={`Search ${label.toLowerCase()}`}
          className="w-full rounded-lg bg-muted/50 py-2 pr-3 pl-9 text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className="pb-2">
        {sections.map((section, index) => (
          <React.Fragment key={`section-${index}`}>
            {section.group && (
              <div className="px-2 pt-3 pb-1 text-[11px] tracking-wide text-muted-foreground uppercase">
                {section.group}
              </div>
            )}
            {section.choices.map((choice) => (
              <button
                key={choice.value}
                type="button"
                onClick={() => choice.value !== value && onSelect(choice.value)}
                className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
              >
                {choice.icon}
                <span className="min-w-0 flex-1 truncate">{choice.name}</span>
                {(choice.note || choice.recommended) && (
                  <span
                    className={cn(
                      "shrink-0 text-[11px]",
                      choice.note ? "text-destructive" : "text-muted-foreground"
                    )}
                  >
                    {choice.note ?? "Recommended"}
                  </span>
                )}
                <CheckIcon
                  className={cn("size-4 shrink-0", choice.value === value ? "opacity-100" : "opacity-0")}
                />
              </button>
            ))}
          </React.Fragment>
        ))}
        {shown.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">No match</p>}
      </div>
      {add && (
        <div className="border-t pt-2">
          <button
            type="button"
            onClick={add.onSelect}
            className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-muted"
          >
            <PlusIcon className="size-4 text-muted-foreground" />
            {add.label}
          </button>
        </div>
      )}
    </div>
  )
}

export function MenuRow({
  label,
  value,
  choices,
  onSelect,
  add,
}: ChoicePick) {
  const current = choices.find((choice) => choice.value === value)
  const [submenuOpen, setSubmenuOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  // The box is about *this* opening of the submenu, never the last one.
  React.useEffect(() => {
    if (!submenuOpen) setQuery("")
  }, [submenuOpen])
  const searchable = choices.length > SEARCH_THRESHOLD
  const shown = searchable ? menuFilter(choices, query) : choices

  const sections = groupChoices(shown)

  const renderChoice = (choice: Choice) => (
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
    </DropdownMenuRadioItem>
  )

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
            {sections.flatMap((section, index) => [
              ...(index > 0 ? [<DropdownMenuSeparator key={`sep-${section.group ?? "ungrouped"}`} />] : []),
              ...(section.group
                ? [
                    <DropdownMenuLabel
                      key={`lbl-${section.group}`}
                      className="pt-1 pb-0.5 text-[11px] tracking-wide uppercase"
                    >
                      {section.group}
                    </DropdownMenuLabel>,
                  ]
                : []),
              ...section.choices.map(renderChoice),
            ])}
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
 * The session's on/off settings as one submenu — the same shape as every other
 * row, with how many are on beside the label. They were a labelled group of
 * checkboxes, which made a menu of selectors end in a block of a different
 * kind. Toggling keeps the submenu open: these are flags, often flipped
 * together.
 */
export function SessionSettingsSub({
  items,
}: {
  items: { label: string; checked: boolean; onChange: (checked: boolean) => void }[]
}) {
  const on = items.filter((i) => i.checked).length
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <SlidersHorizontalIcon className="size-4 text-muted-foreground" />
        <span className="flex-1">Session settings</span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {on} of {items.length}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="max-w-80">
          {items.map((item) => (
            <DropdownMenuCheckboxItem
              key={item.label}
              checked={item.checked}
              closeOnClick={false}
              onCheckedChange={(checked) => item.onChange(checked === true)}
            >
              {item.label}
            </DropdownMenuCheckboxItem>
          ))}
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

/** One role→model entry of the thread's helper map (docs/model-roles.md). */
export interface HelperModelRow {
  role: string
  model: string
}

const SESSION_MODEL_CHOICE = "__session_model__"

/**
 * The thread's helper models, as a submenu: a row per role, each picking the
 * model a subagent spawned on that role runs on (docs/model-roles.md). Chosen
 * on the draft menu and edited on a started thread — a spawn input, so a change
 * costs a respawn and the caller routes it accordingly.
 *
 * Each assigned role gets one model picker (`""` = the session model), plus a
 * Remove action. The models are the Model row's own choices — the profile's
 * catalog where it has one, the agent's own list where it defers (the virtual
 * Default), which the server then passes through as written. Drawn only when
 * both lists have something in them. One entry per role, so Add appears only
 * while some role is still unassigned.
 */
export function HelperModelsSub({
  rows,
  roles,
  models,
  onChange,
  drawer = false,
}: {
  rows: HelperModelRow[]
  /** The whole `model_roles` vocabulary, in its own order. */
  roles: ModelRole[]
  /** The Model row's choices, minus its own "default" row. */
  models: Choice[]
  onChange: (next: HelperModelRow[]) => void
  /** Draw a full-width editor page inside the mobile config drawer. */
  drawer?: boolean
}) {
  if (roles.length === 0 || models.length === 0) return null
  const modelChoices: Choice[] = [{ value: SESSION_MODEL_CHOICE, name: "Session model" }, ...models]
  const used = new Set(rows.map((row) => row.role))
  const addRole = roles.find((role) => !used.has(role.id))
  const replace = (index: number, patch: Partial<HelperModelRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  const remove = (index: number) => onChange(rows.filter((_, i) => i !== index))

  if (drawer) {
    return (
      <div className="flex flex-col gap-3">
        <p className="px-1 text-xs leading-relaxed text-muted-foreground">
          Choose the model each helper role uses. Session model follows the main model above.
        </p>
        {rows.length === 0 && (
          <div className="rounded-xl bg-muted/50 px-3 py-4 text-sm text-muted-foreground">
            No helper roles assigned yet. Add one to choose a model for that kind of task.
          </div>
        )}
        {rows.map((row, index) => {
          const role = roles.find((candidate) => candidate.id === row.role)
          const model = models.find((candidate) => candidate.value === row.model)
          return (
            <section key={`${row.role}-${index}`} className="rounded-xl border bg-card p-3">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-medium">{role?.label ?? row.role}</h3>
                  {role?.description && (
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{role.description}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => remove(index)}
                  aria-label={`Remove ${role?.label ?? row.role} helper model`}
                  className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Trash2Icon className="size-4" />
                </button>
              </div>
              <Select
                value={row.model || SESSION_MODEL_CHOICE}
                onValueChange={(model) =>
                  model !== null && replace(index, { model: model === SESSION_MODEL_CHOICE ? "" : model })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue>{model?.name ?? (row.model || "Session model")}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SESSION_MODEL_CHOICE}>Session model</SelectItem>
                  {models.map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      <span className="flex items-center gap-2">
                        {choice.icon}
                        {choice.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-2 text-[11px] text-muted-foreground">
                {row.model ? "Fixed to this model for helper tasks." : "Uses the thread's selected model."}
              </p>
            </section>
          )
        })}
        {addRole ? (
          <button
            type="button"
            onClick={() => onChange([...rows, { role: addRole.id, model: "" }])}
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-dashed px-3 text-sm font-medium text-muted-foreground hover:border-foreground/30 hover:bg-muted/40 hover:text-foreground"
          >
            <PlusIcon className="size-4" />
            Add {addRole.label}
          </button>
        ) : (
          <p className="px-1 text-xs text-muted-foreground">Every helper role has a model assignment.</p>
        )}
      </div>
    )
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex-1">Helper models</span>
        {rows.length > 0 && (
          <span className="text-xs tabular-nums text-muted-foreground">{rows.length}</span>
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="w-72 no-scrollbar">
          {rows.map((row, index) => {
            const role = roles.find((r) => r.id === row.role)
            const model = models.find((m) => m.value === row.model)
            return (
              <DropdownMenuSub key={`${row.role}-${index}`}>
                <DropdownMenuSubTrigger>
                  <span className="min-w-0 flex-1 truncate">{role?.label ?? row.role}</span>
                  <span className="max-w-24 truncate text-xs text-muted-foreground">
                    {model?.name ?? (row.model || "Session model")}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent className="max-w-80 no-scrollbar">
                    <MenuRow
                      label="Model"
                      value={row.model}
                      choices={modelChoices}
                      onSelect={(model) => replace(index, { model })}
                    />
                    <DropdownMenuSeparator />
                    <DropdownMenuItem closeOnClick={false} onClick={() => remove(index)}>
                      <Trash2Icon className="size-4 text-muted-foreground" />
                      Remove
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
            )
          })}
          {/* Not `MenuAddItem`: that one closes because its callers open a
              dialog, and here the new row has to stay in view to be filled. */}
          {addRole ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                closeOnClick={false}
                onClick={() => onChange([...rows, { role: addRole.id, model: "" }])}
              >
                <PlusIcon className="size-4 text-muted-foreground" />
                Add helper model
              </DropdownMenuItem>
            </>
          ) : (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled className="text-xs">
                Every role is assigned
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
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
 * thread's so the two cannot drift. One line: the model (the only piece that
 * ellipsizes), then effort as a compact meter and the permission mode as an
 * icon.
 *
 * `effortLevel` is the pick's position in the agent's own ordered list, so the
 * meter needs no vocabulary; its word waits for `@panel-sm` (the panel's width,
 * never the device's). The mode is an icon alone — its name rides the title and
 * the accessible name, and the keyword icon falls back to a neutral shield, so a
 * miss is never a wrong claim.
 */
export function PillLabel({
  model,
  effort,
  effortLevel,
  mode,
  modeId,
}: {
  model: string
  effort?: string | null
  effortLevel?: { index: number; count: number } | null
  mode?: string
  modeId?: string
}) {
  return (
    <span className="flex min-w-0 max-w-52 items-center gap-1.5 @panel-sm:max-w-80">
      <span className="flex min-w-0 items-baseline gap-1">
        <span className="min-w-0 truncate font-medium text-foreground/90">{model}</span>
      </span>
      {effort && (
        <span className="flex shrink-0 items-center gap-1 capitalize" title={`Effort: ${effort}`}>
          {effortLevel ? (
            <EffortMeter index={effortLevel.index} count={effortLevel.count} />
          ) : null}
          <span className={cn(effortLevel && "hidden @panel-sm:inline")}>{effort}</span>
        </span>
      )}
      {mode && (
        <span className="flex shrink-0" title={`Mode: ${mode}`} aria-label={`Mode: ${mode}`}>
          <ModeIcon id={modeId} name={mode} />
        </span>
      )}
    </span>
  )
}
