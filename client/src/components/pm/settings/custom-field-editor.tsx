import * as React from "react"
import { ArrowDown, ArrowUp, Pencil, Plus, X } from "lucide-react"
import { toast } from "sonner"

import { useConfirm } from "@/components/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { formatCustomFieldValue } from "@/components/pm/task/custom-field-renderer"
import type { Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import type { Board, CustomFieldDef, CustomFieldInput, CustomFieldType, Task } from "@/lib/pm/types"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

/* ── Custom field editor ──
   One dialog for the whole of a board's custom fields, built the way
   sprint-editor and milestone-editor are: the list, an inline create/edit form
   under it, and a destructive confirm that says what a delete costs.

   The type is a real decision — it decides the shape of every value already
   stored — so editing one warns, and deleting one says out loud that the
   values go with it (the column is dropped, and nothing keeps a copy).

   Field order is the server's (gap-1000, assigned on create); this only ever
   reads it. The options list, on the other hand, is a plain array on the
   definition, so its order is ours to edit. */

// ---------------------------------------------------------------------------
// Actions contract
//
// The three mutators live in lib/actions.ts alongside the rest of PM.
// `CustomFieldActions` names the slice this file needs, so a rename there
// fails here at compile time rather than at the first click.

export interface CustomFieldActions {
  /** POST /api/boards/:id/custom-fields */
  createCustomField(boardId: string, input: CustomFieldInput): Promise<CustomFieldDef>
  /** PATCH /api/boards/:id/custom-fields/:fieldId — the server parses a FULL
      CustomFieldInput (its options refine needs `type`), so a partial patch
      would 400. Every call here sends the whole definition. */
  patchCustomField(
    boardId: string,
    fieldId: string,
    patch: Partial<CustomFieldInput>
  ): Promise<CustomFieldDef>
  /** DELETE — the values stored under this id go with it. */
  deleteCustomField(boardId: string, fieldId: string): Promise<void>
}

export function customFieldApi(actions: Actions): CustomFieldActions {
  return actions
}

/** The type list, in the order the dialog offers it, with the one-liner that
    tells the two choice types apart. */
export const CUSTOM_FIELD_TYPES: { type: CustomFieldType; label: string; hint: string }[] = [
  { type: "text", label: "Text", hint: "A single line of free text." },
  { type: "number", label: "Number", hint: "Any number — cost, count, score." },
  { type: "select", label: "Select", hint: "One of a fixed list of options." },
  { type: "multiselect", label: "Multi-select", hint: "Any number of the options." },
  { type: "date", label: "Date", hint: "A single date." },
  { type: "checkbox", label: "Checkbox", hint: "Yes or no." },
  { type: "url", label: "URL", hint: "A link, opened in a new tab." },
]

const TYPE_LABELS = new Map(CUSTOM_FIELD_TYPES.map((entry) => [entry.type, entry.label]))

/** "Select · 4 options" — the sub-line every row in the list shows. */
export function customFieldSummary(field: CustomFieldDef): string {
  const label = TYPE_LABELS.get(field.type) ?? field.type
  if (field.type !== "select" && field.type !== "multiselect") return label
  const count = field.options?.length ?? 0
  return `${label} · ${count} ${count === 1 ? "option" : "options"}`
}

/** Board order (gap-1000 `order`, ties by name) — the same order the server
    lists them in, restated so a locally-sorted list agrees. */
export function sortCustomFields(fields: CustomFieldDef[]): CustomFieldDef[] {
  return [...fields].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
}

/** How many of `tasks` have a value for each field id. One pass, not one per
    row — the delete confirm needs the number before it can be honest. */
export function customFieldValueCounts(fields: CustomFieldDef[], tasks: Task[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const task of tasks) {
    const values = task.customFieldValues ?? {}
    for (const field of fields) {
      const value = values[field.id]
      if (value == null || formatCustomFieldValue(field, value) === "") continue
      counts.set(field.id, (counts.get(field.id) ?? 0) + 1)
    }
  }
  return counts
}

const EMPTY_TASKS: Task[] = []

const needsOptions = (type: CustomFieldType) => type === "select" || type === "multiselect"

// ---------------------------------------------------------------------------
// Dialog

export interface CustomFieldDialogProps {
  board: Board
  open: boolean
  onOpenChange(open: boolean): void
  actions: Actions
  /** Open straight into editing this field (null/absent = the list). */
  field?: CustomFieldDef | null
  /** Tasks to count values against; defaults to the board's cached tasks. */
  tasks?: Task[]
  onSaved?(field: CustomFieldDef): void
  onDeleted?(fieldId: string): void
}

interface Draft {
  name: string
  type: CustomFieldType
  options: string[]
}

/** `null` = the list; an object = the form, editing `id` (null = create). */
type Editing = { id: string | null; draft: Draft } | null

const draftOf = (field?: CustomFieldDef | null): Draft => ({
  name: field?.name ?? "",
  type: field?.type ?? "text",
  options: field?.options ?? [],
})

/** The wire shape both mutators take: PATCH is a full input, not a partial. */
function inputOf(draft: Draft): CustomFieldInput {
  const options = draft.options.map((entry) => entry.trim()).filter(Boolean)
  return {
    name: draft.name.trim(),
    type: draft.type,
    options: needsOptions(draft.type) ? options : null,
  }
}

function draftIsValid(draft: Draft): boolean {
  const input = inputOf(draft)
  if (input.name === "") return false
  return !needsOptions(draft.type) || (input.options?.length ?? 0) > 0
}

export function CustomFieldDialog({
  board,
  open,
  onOpenChange,
  actions,
  field,
  tasks,
  onSaved,
  onDeleted,
}: CustomFieldDialogProps) {
  const confirm = useConfirm()
  const { state } = useStore()
  const api = customFieldApi(actions)
  const [editing, setEditing] = React.useState<Editing>(null)
  const [busy, setBusy] = React.useState(false)

  /* Every open starts from the field it was opened on — reopening on another
     one must not carry the last one's name. */
  React.useEffect(() => {
    if (!open) return
    setEditing(field ? { id: field.id, draft: draftOf(field) } : null)
    setBusy(false)
  }, [open, field])

  const boardTasks = tasks ?? state.pmTasks[board.id] ?? EMPTY_TASKS
  const fields = React.useMemo(() => sortCustomFields(board.customFields), [board.customFields])
  const counts = React.useMemo(
    () => customFieldValueCounts(fields, boardTasks),
    [fields, boardTasks]
  )

  const setDraft = (patch: Partial<Draft>) =>
    setEditing((current) =>
      current === null ? current : { ...current, draft: { ...current.draft, ...patch } }
    )

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (editing === null || busy || !draftIsValid(editing.draft)) return
    const input = inputOf(editing.draft)

    /* Changing the type reinterprets every value already stored under this id,
       and the server validates on the next write — so say so before it is a
       surprise on someone else's task. */
    const before = editing.id ? board.customFields.find((entry) => entry.id === editing.id) : null
    if (before && before.type !== input.type) {
      const affected = counts.get(before.id) ?? 0
      const ok = await confirm({
        title: `Change ${before.name} to ${TYPE_LABELS.get(input.type) ?? input.type}?`,
        description:
          affected === 0
            ? "No task has a value for this field yet."
            : `${affected} ${affected === 1 ? "task has" : "tasks have"} a value of the old type; those values stop showing and are replaced the next time the field is edited.`,
        confirmLabel: "Change type",
        destructive: true,
      })
      if (!ok) return
    }

    setBusy(true)
    try {
      const saved = editing.id
        ? await api.patchCustomField(board.id, editing.id, input)
        : await api.createCustomField(board.id, input)
      toast.success(editing.id ? `${saved.name} updated` : `${saved.name} created`)
      setEditing(null)
      setBusy(false)
      onSaved?.(saved)
    } catch (err) {
      reportError(err, editing.id ? "Couldn't save the field" : "Couldn't create the field")
      setBusy(false)
    }
  }

  const remove = React.useCallback(
    async (target: CustomFieldDef) => {
      const affected = counts.get(target.id) ?? 0
      const ok = await confirm({
        title: `Delete ${target.name}?`,
        description:
          affected === 0
            ? "The field is removed from every view on this board. No task has a value for it."
            : `${affected} ${affected === 1 ? "task's value is" : "tasks' values are"} dropped with it. Nothing keeps a copy.`,
        confirmLabel: "Delete field",
        destructive: true,
      })
      if (!ok) return
      setBusy(true)
      try {
        await api.deleteCustomField(board.id, target.id)
        toast.success(`${target.name} deleted`)
        setEditing((current) => (current?.id === target.id ? null : current))
        setBusy(false)
        onDeleted?.(target.id)
      } catch (err) {
        reportError(err, "Couldn't delete the field")
        setBusy(false)
      }
    },
    [api, board.id, confirm, counts, onDeleted]
  )

  const edit = React.useCallback((target: CustomFieldDef) => {
    setEditing({ id: target.id, draft: draftOf(target) })
  }, [])

  const typeHint = editing
    ? CUSTOM_FIELD_TYPES.find((entry) => entry.type === editing.draft.type)?.hint
    : undefined

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Custom fields</DialogTitle>
          <DialogDescription>
            Extra fields every task on {board.name} carries. They render from their type — no
            board knows how to draw its own.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
          {fields.length === 0 && editing === null && (
            <p className="py-6 text-center text-sm text-muted-foreground">No custom fields yet.</p>
          )}
          {fields.map((row) => (
            <CustomFieldRow
              key={row.id}
              field={row}
              valueCount={counts.get(row.id) ?? 0}
              busy={busy}
              editing={editing?.id === row.id}
              onEdit={edit}
              onDelete={remove}
            />
          ))}
        </div>

        {editing === null ? (
          <DialogFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditing({ id: null, draft: draftOf(null) })}
            >
              <Plus />
              New field
            </Button>
            <Button type="button" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </DialogFooter>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4 border-t border-border pt-4">
            <CustomField label="Name">
              <Input
                autoFocus
                required
                aria-label="Field name"
                value={editing.draft.name}
                onChange={(e) => setDraft({ name: e.target.value })}
                placeholder={`Field ${board.customFields.length + 1}`}
              />
            </CustomField>

            <CustomField label="Type" hint={typeHint}>
              <Select
                value={editing.draft.type}
                onValueChange={(value) =>
                  setDraft({ type: String(value ?? "text") as CustomFieldType })
                }
              >
                <SelectTrigger className="w-full" aria-label="Field type">
                  {/* Base UI: SelectValue needs explicit children for the label. */}
                  <SelectValue>
                    {TYPE_LABELS.get(editing.draft.type) ?? editing.draft.type}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {CUSTOM_FIELD_TYPES.map((entry) => (
                    <SelectItem key={entry.type} value={entry.type}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CustomField>

            {needsOptions(editing.draft.type) && (
              <CustomField
                label="Options"
                hint="At least one. Their order here is the order the picker shows."
              >
                <OptionsEditor
                  options={editing.draft.options}
                  disabled={busy}
                  onChange={(options) => setDraft({ options })}
                />
              </CustomField>
            )}

            <DialogFooter className="sm:justify-between">
              {editing.id ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    const target = board.customFields.find((entry) => entry.id === editing.id)
                    if (target) void remove(target)
                  }}
                >
                  Delete
                </Button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy || !draftIsValid(editing.draft)}>
                  {editing.id ? "Save field" : "Create field"}
                </Button>
              </div>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Rows

interface CustomFieldRowProps {
  field: CustomFieldDef
  valueCount: number
  busy: boolean
  editing: boolean
  onEdit(field: CustomFieldDef): void
  onDelete(field: CustomFieldDef): void
}

/** Memo'd on stable callbacks — a board with many fields re-renders one row per
    keystroke in the form otherwise. */
const CustomFieldRow = React.memo(function CustomFieldRow({
  field,
  valueCount,
  busy,
  editing,
  onEdit,
  onDelete,
}: CustomFieldRowProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border border-transparent px-2 py-1.5",
        editing ? "border-border bg-muted" : "hover:bg-muted/60"
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{field.name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {customFieldSummary(field)}
          {" · "}
          {valueCount} {valueCount === 1 ? "task" : "tasks"}
        </span>
      </div>
      <Badge variant="outline" className="font-normal text-muted-foreground">
        {TYPE_LABELS.get(field.type) ?? field.type}
      </Badge>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={busy}
        title="Edit"
        aria-label={`Edit ${field.name}`}
        onClick={() => onEdit(field)}
      >
        <Pencil />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={busy}
        title="Delete"
        aria-label={`Delete ${field.name}`}
        onClick={() => onDelete(field)}
      >
        <X />
      </Button>
    </div>
  )
})

// ---------------------------------------------------------------------------
// Bits

/** The options list for select/multiselect: edit in place, add, remove, and
    move up/down (buttons, not drag — this list is short, and a dialog inside a
    dialog is not the place for a drag context). */
function OptionsEditor({
  options,
  disabled,
  onChange,
}: {
  options: string[]
  disabled?: boolean
  onChange(options: string[]): void
}) {
  const move = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= options.length) return
    const next = [...options]
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-1.5">
      {options.length === 0 && (
        <p className="text-xs text-muted-foreground">No options yet.</p>
      )}
      {options.map((option, index) => (
        <div key={index} className="flex items-center gap-1">
          <Input
            aria-label={`Option ${index + 1}`}
            value={option}
            disabled={disabled}
            placeholder={`Option ${index + 1}`}
            className="h-8 min-w-0 flex-1 text-[13px]"
            onChange={(event) => {
              const next = [...options]
              next[index] = event.target.value
              onChange(next)
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled || index === 0}
            title="Move up"
            aria-label={`Move option ${index + 1} up`}
            onClick={() => move(index, -1)}
          >
            <ArrowUp />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled || index === options.length - 1}
            title="Move down"
            aria-label={`Move option ${index + 1} down`}
            onClick={() => move(index, 1)}
          >
            <ArrowDown />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            title="Remove"
            aria-label={`Remove option ${index + 1}`}
            onClick={() => onChange(options.filter((_, i) => i !== index))}
          >
            <X />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        className="self-start"
        onClick={() => onChange([...options, ""])}
      >
        <Plus />
        Add option
      </Button>
    </div>
  )
}

/** The PM dialogs' plain label/hint row — a <div>, not a <label>, because these
    wrap popover and select buttons that own their own clicks. */
function CustomField({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}
