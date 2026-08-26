/* ── Custom fields, rendered generically ──
   A board's custom fields are data, not code: the only thing that decides how
   one looks is `field.type`, so everything here switches on that and nothing
   here knows which board it is on. Adding a field to a board must never mean
   adding a branch to the client.

   Values live in one json map on the task (`customFieldValues`, keyed by field
   id) and are validated server-side, so a write is a merge of that map — never
   a replacement — and a value whose field has since been deleted is dropped on
   the way out rather than sent back to a server that would 400 on it.

   Dates use the idiom new-task-dialog established: a Popover over the shared
   Calendar, cleared by a small ✕, epoch-ms on the wire. */
import * as React from "react"
import { format } from "date-fns"
import { CalendarIcon, ExternalLink, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import type {
  Board,
  CustomFieldDef,
  CustomFieldValues as CustomFieldValueMap,
  Task,
} from "@/lib/pm/types"
import { cn } from "@/lib/utils"

/** Select has no empty value, so "not set" needs a token of its own. */
const NONE = "__none__"

// ---------------------------------------------------------------------------
// Value reading (the wire shapes the server validates against)

/** `null` for every "not set" spelling — absent, null, or the empty string. */
function textOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function boolOf(value: unknown): boolean {
  return value === true
}

function listOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

/** A select value only counts if it is still one of the field's options — an
    option removed from the definition leaves stale values behind. */
function choiceOf(field: CustomFieldDef, value: unknown): string | null {
  const text = textOf(value)
  return text !== null && (field.options ?? []).includes(text) ? text : null
}

function choicesOf(field: CustomFieldDef, value: unknown): string[] {
  const options = field.options ?? []
  return listOf(value).filter((entry) => options.includes(entry))
}

/** Loose on purpose: the server stores whatever string the user typed, so this
    only decides whether we offer the "open it" affordance and whether a commit
    is allowed through. */
export function isCustomFieldUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

/** One line of text for a table cell, a list row, or a card badge — never JSX,
    so a column can sort and filter on the same string it shows. Empty string
    when the field has no value. */
export function formatCustomFieldValue(field: CustomFieldDef, value: unknown): string {
  switch (field.type) {
    case "text":
    case "url":
      return textOf(value) ?? ""
    case "number": {
      const n = numberOf(value)
      return n === null ? "" : String(n)
    }
    case "date": {
      const n = numberOf(value)
      return n === null ? "" : format(new Date(n), "d MMM yyyy")
    }
    case "checkbox":
      return boolOf(value) ? "Yes" : "No"
    case "select":
      return choiceOf(field, value) ?? ""
    case "multiselect":
      return choicesOf(field, value).join(", ")
  }
}

/** The map a task should send back: its current values minus anything whose
    field the board no longer has (the server 400s on an unknown id), plus the
    one field being written. `null` clears. */
export function mergeCustomFieldValues(
  board: Board,
  current: CustomFieldValueMap,
  fieldId: string,
  value: unknown
): CustomFieldValueMap {
  const known = new Set(board.customFields.map((entry) => entry.id))
  const next: CustomFieldValueMap = {}
  for (const [id, existing] of Object.entries(current)) {
    if (known.has(id) && existing != null) next[id] = existing
  }
  if (value == null) delete next[fieldId]
  else next[fieldId] = value
  return next
}

// ---------------------------------------------------------------------------
// One control

export interface CustomFieldControlProps {
  field: CustomFieldDef
  value: unknown
  /** Called with the committed wire value, or `null` to clear it. Text-like
      types commit on blur/Enter; the rest commit as they change. */
  onChange(value: unknown): void
  disabled?: boolean
  className?: string
}

/** The whole of the per-type rendering. No board is named here, and no branch
    is per-field: a field is its `type` plus, for the two choice types, its
    `options`. */
export function CustomFieldControl({
  field,
  value,
  onChange,
  disabled,
  className,
}: CustomFieldControlProps) {
  switch (field.type) {
    case "text":
      return (
        <TextControl
          field={field}
          value={textOf(value) ?? ""}
          onChange={onChange}
          disabled={disabled}
          className={className}
        />
      )
    case "url":
      return (
        <UrlControl
          field={field}
          value={textOf(value) ?? ""}
          onChange={onChange}
          disabled={disabled}
          className={className}
        />
      )
    case "number":
      return (
        <NumberControl
          field={field}
          value={numberOf(value)}
          onChange={onChange}
          disabled={disabled}
          className={className}
        />
      )
    case "checkbox":
      return (
        <span className={cn("flex items-center", className)}>
          <Checkbox
            aria-label={field.name}
            disabled={disabled}
            checked={boolOf(value)}
            onCheckedChange={(checked) => onChange(checked === true)}
          />
        </span>
      )
    case "date":
      return (
        <DateControl
          field={field}
          value={numberOf(value)}
          onChange={onChange}
          disabled={disabled}
          className={className}
        />
      )
    case "select":
      return (
        <SelectControl
          field={field}
          value={choiceOf(field, value)}
          onChange={onChange}
          disabled={disabled}
          className={className}
        />
      )
    case "multiselect":
      return (
        <MultiSelectControl
          field={field}
          value={choicesOf(field, value)}
          onChange={onChange}
          disabled={disabled}
          className={className}
        />
      )
  }
}

/** Text and number hold a local buffer so a half-typed value is not a patch;
    the buffer follows the prop whenever the stored value changes underneath. */
function useBuffer(external: string): [string, (next: string) => void, () => void] {
  const [draft, setDraft] = React.useState(external)
  const [dirty, setDirty] = React.useState(false)
  React.useEffect(() => {
    setDraft(external)
    setDirty(false)
  }, [external])
  const set = React.useCallback((next: string) => {
    setDraft(next)
    setDirty(true)
  }, [])
  const reset = React.useCallback(() => {
    setDraft(external)
    setDirty(false)
  }, [external])
  return [dirty ? draft : external, set, reset]
}

function TextControl({
  field,
  value,
  onChange,
  disabled,
  className,
}: {
  field: CustomFieldDef
  value: string
  onChange(value: unknown): void
  disabled?: boolean
  className?: string
}) {
  const [draft, set] = useBuffer(value)
  const commit = () => {
    const next = draft.trim()
    if (next === value) return
    onChange(next === "" ? null : next)
  }
  return (
    <Input
      aria-label={field.name}
      disabled={disabled}
      value={draft}
      placeholder="—"
      className={cn("h-8 text-[13px]", className)}
      onChange={(event) => set(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault()
          commit()
        }
      }}
    />
  )
}

function NumberControl({
  field,
  value,
  onChange,
  disabled,
  className,
}: {
  field: CustomFieldDef
  value: number | null
  onChange(value: unknown): void
  disabled?: boolean
  className?: string
}) {
  const [draft, set] = useBuffer(value === null ? "" : String(value))
  const trimmed = draft.trim()
  const parsed = trimmed === "" ? null : Number(trimmed)
  const invalid = parsed !== null && !Number.isFinite(parsed)
  const commit = () => {
    if (invalid || parsed === value) return
    onChange(parsed)
  }
  return (
    <div className={cn("min-w-0", className)}>
      <Input
        aria-label={field.name}
        inputMode="decimal"
        disabled={disabled}
        value={draft}
        placeholder="—"
        aria-invalid={invalid || undefined}
        className="h-8 w-32 text-[13px]"
        onChange={(event) => set(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            commit()
          }
        }}
      />
      {invalid && <p className="mt-1 text-[11px] text-destructive">Numbers only</p>}
    </div>
  )
}

function UrlControl({
  field,
  value,
  onChange,
  disabled,
  className,
}: {
  field: CustomFieldDef
  value: string
  onChange(value: unknown): void
  disabled?: boolean
  className?: string
}) {
  const [draft, set] = useBuffer(value)
  const trimmed = draft.trim()
  const invalid = trimmed !== "" && !isCustomFieldUrl(trimmed)
  const commit = () => {
    if (invalid || trimmed === value) return
    onChange(trimmed === "" ? null : trimmed)
  }
  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex items-center gap-1.5">
        <Input
          aria-label={field.name}
          type="url"
          disabled={disabled}
          value={draft}
          placeholder="https://…"
          aria-invalid={invalid || undefined}
          className="h-8 min-w-0 flex-1 text-[13px]"
          onChange={(event) => set(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              commit()
            }
          }}
        />
        {value !== "" && isCustomFieldUrl(value) && (
          <Button
            variant="ghost"
            size="icon-sm"
            title={value}
            aria-label={`Open ${field.name}`}
            render={
              <a href={value} target="_blank" rel="noreferrer noopener">
                <ExternalLink />
              </a>
            }
          />
        )}
      </div>
      {invalid && (
        <p className="mt-1 text-[11px] text-destructive">Enter a full URL (https://…)</p>
      )}
    </div>
  )
}

function DateControl({
  field,
  value,
  onChange,
  disabled,
  className,
}: {
  field: CustomFieldDef
  value: number | null
  onChange(value: unknown): void
  disabled?: boolean
  className?: string
}) {
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <Popover>
        <PopoverTrigger
          disabled={disabled}
          render={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn(
                "min-w-0 flex-1 justify-start font-normal",
                value === null && "text-muted-foreground"
              )}
            >
              <CalendarIcon />
              <span className="truncate">
                {value === null ? `No ${field.name.toLowerCase()}` : format(new Date(value), "EEE d MMM yyyy")}
              </span>
            </Button>
          }
        />
        <PopoverContent align="start" className="w-auto p-0">
          <Calendar
            mode="single"
            autoFocus
            selected={value === null ? undefined : new Date(value)}
            onSelect={(date) => onChange(date ? date.getTime() : null)}
          />
        </PopoverContent>
      </Popover>
      {value !== null && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          aria-label={`Clear ${field.name}`}
          onClick={() => onChange(null)}
        >
          <X />
        </Button>
      )}
    </div>
  )
}

function SelectControl({
  field,
  value,
  onChange,
  disabled,
  className,
}: {
  field: CustomFieldDef
  value: string | null
  onChange(value: unknown): void
  disabled?: boolean
  className?: string
}) {
  const options = field.options ?? []
  return (
    <Select
      value={value ?? NONE}
      disabled={disabled}
      onValueChange={(next) => {
        const chosen = String(next ?? NONE)
        onChange(chosen === NONE ? null : chosen)
      }}
    >
      <SelectTrigger className={cn("w-full", className)} aria-label={field.name}>
        {/* Base UI: SelectValue needs explicit children for the label. */}
        <SelectValue>
          {value ?? <span className="text-muted-foreground">Not set</span>}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>Not set</SelectItem>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function MultiSelectControl({
  field,
  value,
  onChange,
  disabled,
  className,
}: {
  field: CustomFieldDef
  value: string[]
  onChange(value: unknown): void
  disabled?: boolean
  className?: string
}) {
  const options = field.options ?? []
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <Button
            variant="outline"
            size="sm"
            className={cn("w-full justify-start font-normal", className)}
          />
        }
      >
        {value.length === 0 ? (
          <span className="text-muted-foreground">Not set</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {value.map((entry) => (
              <Badge key={entry} variant="secondary" className="text-[10px]">
                {entry}
              </Badge>
            ))}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {options.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            This field has no options yet.
          </div>
        )}
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option}
            checked={value.includes(option)}
            onCheckedChange={(checked) => {
              const next = checked
                ? [...value, option]
                : value.filter((entry) => entry !== option)
              onChange(next.length === 0 ? null : next)
            }}
          >
            {option}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ---------------------------------------------------------------------------
// The block the task editor drops in

export interface CustomFieldValuesProps {
  board: Board
  task: Task
  actions: Actions
  /** Read-only rendering (an archived or trashed task). */
  disabled?: boolean
  className?: string
}

/** Every one of the board's custom fields, for this task, each writing through
    `patchTask({ customFieldValues })` with the map MERGED — a patch that
    replaced it would silently drop every other field's value.

    Writes are optimistic and reverted on the server's 400: a value the server
    refuses (a select option deleted between render and click) must not be left
    on screen looking saved. */
export function CustomFieldValues({
  board,
  task,
  actions,
  disabled,
  className,
}: CustomFieldValuesProps) {
  /* Pending writes, by field id. Cleared per field as the task comes back with
     the new value (or when the write fails), so the row shows what was clicked
     rather than flicking back to the old value for one round trip. */
  const [pending, setPending] = React.useState<CustomFieldValueMap>({})
  const stored = task.customFieldValues ?? {}

  const fields = React.useMemo(
    () => [...board.customFields].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
    [board.customFields]
  )

  const write = async (field: CustomFieldDef, value: unknown) => {
    const next = mergeCustomFieldValues(board, stored, field.id, value)
    setPending((current) => ({ ...current, [field.id]: value ?? null }))
    try {
      await actions.patchTask(board.id, task.id, { customFieldValues: next })
    } catch (error) {
      reportError(error, `Couldn't save ${field.name}`)
    } finally {
      setPending((current) => {
        if (!(field.id in current)) return current
        const rest = { ...current }
        delete rest[field.id]
        return rest
      })
    }
  }

  if (fields.length === 0) return null

  return (
    <div className={cn("space-y-3", className)}>
      {fields.map((field) => (
        <div
          key={field.id}
          className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3"
        >
          <Label className="truncate text-xs font-medium text-muted-foreground" title={field.name}>
            {field.name}
          </Label>
          <div className="min-w-0">
            <CustomFieldControl
              field={field}
              value={field.id in pending ? pending[field.id] : stored[field.id]}
              disabled={disabled}
              onChange={(value) => void write(field, value)}
            />
          </div>
        </div>
      ))}
    </div>
  )
}
