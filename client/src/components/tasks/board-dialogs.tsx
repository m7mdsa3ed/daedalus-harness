import * as React from "react"
import { uuid } from "@/lib/uuid"
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/busy-button"
import { Input } from "@/components/ui/input"
import { ChoiceTiles, FIELD_GRID, Field, Section, Segmented } from "@/components/settings/primitives"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ErrorNote } from "@/components/error-note"
import { captureError, reportError, type InlineError } from "@/lib/errors"
import { toast } from "@/lib/toast"
import type { Project } from "@/lib/settings"
import {
  BOARD_COLORS,
  CATEGORY_LABEL,
  COLOR_DOT,
  COLOR_LABEL,
  FIELD_TYPES,
  STATUS_CATEGORIES,
  type Board,
  type BoardColor,
  type BoardStatus,
  type BoardView,
  type CustomFieldDef,
  type Sprint,
  type StatusCategory,
  type ViewKind,
} from "@/lib/boards"
import { viewConfigOf, type ViewState } from "@/lib/tasks-view"
import {
  useCompleteSprint,
  useCreateBoard,
  useCreateSprint,
  useCreateStatus,
  useCreateView,
  useDeleteBoard,
  useDeleteStatus,
  useReorderStatuses,
  useUpdateBoard,
  useUpdateSprint,
  useUpdateStatus,
  useUpdateView,
} from "@/lib/queries/boards"
import { ICON_BTN, fromDateInput, toDateInput } from "./fields"
import { MODES } from "./modes"

/* The edits a board needs, each as its own dialog rather than one polymorphic
   form: naming a thing and deciding where a column's tasks go are different
   questions, and the second one has to be asked (a column delete moves work;
   it must not look like a task delete). */

/** A swatch row — the whole palette. */
export function ColorPicker({ value, onChange }: { value: BoardColor | null; onChange: (color: BoardColor | null) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <button
        type="button"
        onClick={() => onChange(null)}
        aria-label="No colour"
        aria-pressed={value === null}
        className={cn(
          "grid size-8 place-items-center rounded-full border text-xs pointer-coarse:size-11 text-muted-foreground outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
          value === null ? "border-primary bg-muted" : "border-transparent bg-muted",
        )}
      >
        —
      </button>
      {BOARD_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          onClick={() => onChange(color)}
          aria-label={COLOR_LABEL[color]}
          title={COLOR_LABEL[color]}
          aria-pressed={value === color}
          className={cn(
            "grid size-8 place-items-center rounded-full border outline-none pointer-coarse:size-11 transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
            value === color ? "border-primary" : "border-transparent",
          )}
        >
          <span className={cn("size-3.5 rounded-full", COLOR_DOT[color])} />
        </button>
      ))}
    </div>
  )
}

const FIELD_TYPE_LABEL: Record<CustomFieldDef["type"], string> = {
  text: "Text",
  number: "Number",
  select: "Select",
  date: "Date",
  checkbox: "Checkbox",
  url: "URL",
}

/** A column's colour as one swatch that opens the palette. */
function ColumnSwatch({ value, onChange }: { value: BoardColor | null; onChange: (color: BoardColor | null) => void }) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Colour: ${value ? COLOR_LABEL[value] : "none"}`} title="Colour" className={ICON_BTN}>
            <span className={cn("size-3.5 rounded-full", value ? COLOR_DOT[value] : "border border-dashed border-muted-foreground/60")} />
          </Button>
        }
      />
      <PopoverContent align="end" className="w-auto max-w-72 p-2">
        <ColorPicker
          value={value}
          onChange={(color) => {
            onChange(color)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/** Wraps a form's submit so a failure keeps the dialog open with the values
    on screen, and success closes it. */
function useSubmit(onOpenChange: (open: boolean) => void, title: string) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<InlineError | null>(null)
  const run = async (fn: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await fn()
      onOpenChange(false)
    } catch (err) {
      setError(captureError(err, title))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run, setError }
}

// ---- board ----

/**
 * Create or edit a board: name, key, colour, description, project — and, when
 * editing, its columns and custom fields, since those are the board's shape
 * and belong beside its name.
 */
export function BoardDialog({
  open,
  onOpenChange,
  board,
  statuses,
  projects,
  onCreated,
  onDeleteStatus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Null = a new board. */
  board: Board | null
  statuses: BoardStatus[]
  projects: Project[]
  onCreated?: (board: Board) => void
  onDeleteStatus: (status: BoardStatus) => void
}) {
  const createBoard = useCreateBoard()
  const updateBoard = useUpdateBoard()
  const createStatus = useCreateStatus()
  const updateStatus = useUpdateStatus()
  const reorder = useReorderStatuses()
  const { busy, error, run } = useSubmit(onOpenChange, board ? "Couldn't save the board" : "Couldn't create the board")

  const [name, setName] = React.useState("")
  const [key, setKey] = React.useState("")
  const [keyTouched, setKeyTouched] = React.useState(false)
  const [color, setColor] = React.useState<BoardColor | null>(null)
  const [description, setDescription] = React.useState("")
  const [projectId, setProjectId] = React.useState<string>("")
  const [fields, setFields] = React.useState<CustomFieldDef[]>([])
  const [newColumn, setNewColumn] = React.useState("")

  React.useEffect(() => {
    if (!open) return
    setName(board?.name ?? "")
    setKey(board?.key ?? "")
    setKeyTouched(!!board)
    setColor(board?.color ?? null)
    setDescription(board?.description ?? "")
    setProjectId(board?.projectId ?? "")
    setFields(board?.customFields ?? [])
    setNewColumn("")
  }, [open, board])

  // A key suggested from the name until the user types one themselves.
  React.useEffect(() => {
    if (keyTouched) return
    const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean)
    const guess = words.length >= 2 ? words.map((w) => w[0]).join("").slice(0, 4) : (words[0] ?? "").slice(0, 4)
    setKey(guess)
  }, [name, keyTouched])

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    void run(async () => {
      const input = {
        name: name.trim(),
        key: key.trim().toUpperCase() || undefined,
        color,
        description: description.trim() || null,
        projectId: projectId || null,
      }
      if (board) {
        await updateBoard.mutateAsync({ id: board.id, input: { ...input, customFields: fields } })
      } else {
        const created = await createBoard.mutateAsync(input)
        onCreated?.(created)
      }
    })
  }

  const moveColumn = (status: BoardStatus, delta: -1 | 1) => {
    if (!board) return
    const ids = statuses.map((s) => s.id)
    const from = ids.indexOf(status.id)
    const to = from + delta
    if (from === -1 || to < 0 || to >= ids.length) return
    ids.splice(to, 0, ...ids.splice(from, 1))
    reorder.mutateAsync({ boardId: board.id, ids }).catch((err) => reportError(err, "Couldn't move the column"))
  }

  const addColumn = () => {
    if (!board || !newColumn.trim()) return
    createStatus
      .mutateAsync({ boardId: board.id, input: { name: newColumn.trim(), category: "in_progress" } })
      .then(() => setNewColumn(""))
      .catch((err) => reportError(err, "Couldn't add the column"))
  }

  const patchStatus = (status: BoardStatus, input: Parameters<typeof updateStatus.mutateAsync>[0]["input"]) =>
    updateStatus.mutateAsync({ id: status.id, input }).catch((err) => reportError(err, "Couldn't update the column"))

  const setField = (id: string, patch: Partial<CustomFieldDef>) => setFields((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)))

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-2xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{board ? "Board settings" : "New board"}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>{board ? "Name, key, columns and custom fields." : "A board is its own workspace, with its own key, columns, sprints and views."}</ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        {/* The footer is partitioned out of the children, so the buttons hang
            off the form by id rather than by nesting. */}
        <form id="board-dialog-form" onSubmit={submit} className="flex flex-col">
          <Section label={board ? "Details" : undefined}>
            <div className="grid gap-4">
              <div className={FIELD_GRID}>
                <Field htmlFor="board-name" label="Name">
                  <Input id="board-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Web platform" maxLength={120} />
                </Field>
                <Field
                  htmlFor="board-key"
                  label="Key"
                  hint={
                    <>
                      Tasks are <span className="font-mono">{key || "KEY"}-1</span>, <span className="font-mono">{key || "KEY"}-2</span>… Changing the key renames them all.
                    </>
                  }
                >
                  <Input
                    id="board-key"
                    value={key}
                    onChange={(e) => {
                      setKeyTouched(true)
                      setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))
                    }}
                    placeholder="WEB"
                    className="font-mono"
                  />
                </Field>
              </div>
              <Field label="Colour">
                <ColorPicker value={color} onChange={setColor} />
              </Field>
              <Field htmlFor="board-desc" label="Description">
                <Textarea id="board-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this board is for" className="min-h-16" />
              </Field>
              <Field label="Project">
                <Select value={projectId} onValueChange={(v) => setProjectId(v ?? "")}>
                  <SelectTrigger className="w-full">
                    <SelectValue>{projects.find((p) => p.id === projectId)?.name ?? "No project"}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">No project</SelectItem>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          </Section>

          {board && (
            <Section
              label="Columns"
              count={statuses.length}
              hint="Column changes save as you make them. A task entering a Done column is completed; a WIP limit is shown, never enforced."
            >
              <ul className="grid gap-1 rounded-2xl p-2 ring-1 ring-foreground/10">
                {statuses.map((s, i) => (
                  <li
                    key={s.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg p-1 hover:bg-muted/50 @panel-md:grid-cols-[minmax(0,1fr)_auto_5rem_auto_auto]"
                  >
                    <Input
                      defaultValue={s.name}
                      onBlur={(e) => {
                        const v = e.target.value.trim()
                        if (v && v !== s.name) void patchStatus(s, { name: v })
                      }}
                      className="h-8 pointer-coarse:h-11"
                      aria-label="Column name"
                    />
                    {/* Narrow: name | moves on the first line, category | WIP + colour on
                        the second. From @panel-md every control is a column of one row. */}
                    <Segmented
                      label={`${s.name} category`}
                      value={s.category}
                      onChange={(category: StatusCategory) => void patchStatus(s, { category })}
                      options={STATUS_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))}
                      className="order-2 @panel-md:order-none"
                    />
                    <div className="order-2 flex items-center gap-2 @panel-md:contents">
                      <Input
                        type="number"
                        min={1}
                        defaultValue={s.wipLimit ?? ""}
                        onBlur={(e) => {
                          const v = e.target.value === "" ? null : Number(e.target.value)
                          if (v !== s.wipLimit) void patchStatus(s, { wipLimit: v })
                        }}
                        placeholder="WIP"
                        className="h-8 w-20 pointer-coarse:h-11 @panel-md:w-full"
                        aria-label="WIP limit"
                      />
                      <ColumnSwatch value={s.color} onChange={(color) => void patchStatus(s, { color })} />
                    </div>
                    <span className="order-1 inline-flex @panel-md:order-none">
                      <Button type="button" variant="ghost" size="icon-sm" disabled={i === 0} onClick={() => moveColumn(s, -1)} aria-label="Move up" className={cn(ICON_BTN, "text-muted-foreground")}>
                        <ChevronUp />
                      </Button>
                      <Button type="button" variant="ghost" size="icon-sm" disabled={i === statuses.length - 1} onClick={() => moveColumn(s, 1)} aria-label="Move down" className={cn(ICON_BTN, "text-muted-foreground")}>
                        <ChevronDown />
                      </Button>
                      <Button type="button" variant="ghost" size="icon-sm" disabled={statuses.length <= 1} onClick={() => onDeleteStatus(s)} aria-label="Delete column" className={cn(ICON_BTN, "text-muted-foreground hover:bg-destructive/10 hover:text-destructive")}>
                        <Trash2 />
                      </Button>
                    </span>
                  </li>
                ))}
                <li className="flex items-center gap-2 p-1">
                  <Input
                    value={newColumn}
                    onChange={(e) => setNewColumn(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        addColumn()
                      }
                    }}
                    placeholder="New column name…"
                    aria-label="New column name"
                    className="h-8 pointer-coarse:h-11"
                  />
                  <Button type="button" size="sm" variant="outline" onClick={addColumn} disabled={!newColumn.trim()} className="pointer-coarse:h-11">
                    <Plus data-icon="inline-start" /> Add
                  </Button>
                </li>
              </ul>
            </Section>
          )}

          {board && (
            <Section label="Fields" count={fields.length} hint="Extra properties every task on this board can carry. Saved with the board.">
              <ul className="grid gap-1 rounded-2xl p-2 ring-1 ring-foreground/10">
                {fields.map((f) => (
                  <li key={f.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg p-1 @panel-md:grid-cols-[minmax(0,1fr)_8rem_minmax(0,1fr)_auto]">
                    <Input value={f.name} onChange={(e) => setField(f.id, { name: e.target.value })} placeholder="Field name" className="h-8 pointer-coarse:h-11" aria-label="Field name" />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setFields((fs) => fs.filter((x) => x.id !== f.id))}
                      aria-label="Remove field"
                      className={cn(ICON_BTN, "text-muted-foreground hover:bg-destructive/10 hover:text-destructive @panel-md:order-last")}
                    >
                      <Trash2 />
                    </Button>
                    {/* Type and options take the second line on a narrow panel and rejoin the row from @panel-md. */}
                    <div className="col-span-full grid grid-cols-[8rem_minmax(0,1fr)] gap-2 @panel-md:contents">
                      <Select value={f.type} onValueChange={(v) => v && setField(f.id, { type: v as CustomFieldDef["type"] })}>
                        <SelectTrigger size="sm" className="w-full pointer-coarse:h-11" aria-label="Field type">
                          <SelectValue>{FIELD_TYPE_LABEL[f.type]}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {FIELD_TYPES.map((t) => (
                            <SelectItem key={t} value={t}>
                              {FIELD_TYPE_LABEL[t]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {f.type === "select" ? (
                        <Input
                          value={(f.options ?? []).join(", ")}
                          onChange={(e) =>
                            setField(f.id, {
                              options: e.target.value
                                .split(",")
                                .map((o) => o.trim())
                                .filter(Boolean),
                            })
                          }
                          placeholder="Options, comma-separated"
                          className="h-8 pointer-coarse:h-11"
                          aria-label="Options"
                        />
                      ) : (
                        <span />
                      )}
                    </div>
                  </li>
                ))}
                <li className="p-1">
                  <Button type="button" size="sm" variant="outline" onClick={() => setFields((fs) => [...fs, { id: uuid(), name: "", type: "text" }])} className="pointer-coarse:h-11">
                    <Plus data-icon="inline-start" /> Add field
                  </Button>
                </li>
              </ul>
            </Section>
          )}
          <ErrorNote error={error} className="mt-4" />
        </form>
        <ResponsiveDialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="board-dialog-form" loading={busy} disabled={!name.trim() || fields.some((f) => !f.name.trim())}>
            {board ? "Save" : "Create board"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

/** Delete a board — which does take its tasks with it, so the count is said
    out loud rather than implied. */
export function DeleteBoardDialog({ open, onOpenChange, board, taskCount, onDeleted }: { open: boolean; onOpenChange: (open: boolean) => void; board: Board | null; taskCount: number; onDeleted: () => void }) {
  const del = useDeleteBoard()
  const { busy, error, run } = useSubmit(onOpenChange, "Couldn't delete the board")
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Delete “{board?.name}”?</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <ResponsiveDialogDescription>
          {taskCount === 0
            ? "The board is empty. Its columns, sprints and views are deleted with it."
            : `Its columns, sprints, views and all ${taskCount} ${taskCount === 1 ? "task" : "tasks"} on it are deleted. This cannot be undone.`}
        </ResponsiveDialogDescription>
        <ErrorNote error={error} />
        <ResponsiveDialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            loading={busy}
            disabled={!board}
            onClick={() =>
              void run(async () => {
                await del.mutateAsync(board!.id)
                onDeleted()
              })
            }
          >
            Delete board
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

// ---- columns ----

/** Add a column with everything a column has, or edit one (`status` set): the
    kanban's "+ Add column" and a column's "Edit column…". */
export function ColumnDialog({
  open,
  onOpenChange,
  boardId,
  status,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  boardId: string
  status?: BoardStatus | null
}) {
  const create = useCreateStatus()
  const update = useUpdateStatus()
  const { busy, error, run } = useSubmit(onOpenChange, status ? "Couldn't save the column" : "Couldn't add the column")
  const [name, setName] = React.useState("")
  const [color, setColor] = React.useState<BoardColor | null>(null)
  const [category, setCategory] = React.useState<StatusCategory>("in_progress")
  const [wip, setWip] = React.useState("")
  React.useEffect(() => {
    if (!open) return
    setName(status?.name ?? "")
    setColor(status?.color ?? null)
    setCategory(status?.category ?? "in_progress")
    setWip(status?.wipLimit != null ? String(status.wipLimit) : "")
    // By id: a refetch hands over a new object for the same column, and must not wipe the edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, status?.id])
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{status ? "Edit column" : "New column"}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {status ? "A Done column completes the tasks that enter it." : "A column is a status a task can be in. It is added at the end."}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form
          id="column-dialog-form"
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim()) return
            const input = { name: name.trim(), color, category, wipLimit: wip ? Number(wip) : null }
            void run(async () => {
              if (status) await update.mutateAsync({ id: status.id, input })
              else await create.mutateAsync({ boardId, input })
            })
          }}
        >
          <Field htmlFor="col-name" label="Name">
            <Input id="col-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. In review" maxLength={60} />
          </Field>
          <Field label="Category">
            <Segmented
              label="Category"
              value={category}
              onChange={setCategory}
              options={STATUS_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))}
            />
          </Field>
          <Field htmlFor="col-wip" label="WIP limit" hint="Shown on the column, never enforced.">
            <Input id="col-wip" type="number" min={1} value={wip} onChange={(e) => setWip(e.target.value)} placeholder="Optional" className="w-28" />
          </Field>
          <Field label="Colour">
            <ColorPicker value={color} onChange={setColor} />
          </Field>
          <ErrorNote error={error} />
        </form>
        <ResponsiveDialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="column-dialog-form" loading={busy} disabled={!name.trim()}>
            {status ? "Save" : "Add column"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

/**
 * Delete a column, having said where its tasks go.
 *
 * The destination is a choice and not a default, because the alternative — a
 * cascade — would delete work silently. A column with nothing in it skips the
 * question, since there is nothing to decide.
 */
export function DeleteStatusDialog({ open, onOpenChange, status, siblings, taskCount }: { open: boolean; onOpenChange: (open: boolean) => void; status: BoardStatus | null; siblings: BoardStatus[]; taskCount: number }) {
  const del = useDeleteStatus()
  const [moveTo, setMoveTo] = React.useState("")
  const { busy, error, run } = useSubmit(onOpenChange, "Couldn't delete the column")
  React.useEffect(() => {
    if (open) setMoveTo(siblings[0]?.id ?? "")
  }, [open, siblings])
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Delete “{status?.name}”?</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <ResponsiveDialogDescription>
          {taskCount === 0 ? "The column is empty, so nothing moves." : `${taskCount} ${taskCount === 1 ? "task" : "tasks"} will move to another column — nothing is deleted.`}
        </ResponsiveDialogDescription>
        {taskCount > 0 && siblings.length > 0 && (
          <Field label="Move its tasks to">
            <Select value={moveTo} onValueChange={(v) => setMoveTo(v ?? "")}>
              <SelectTrigger className="w-full">
                <SelectValue>{siblings.find((s) => s.id === moveTo)?.name ?? "Choose a column"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {siblings.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
        <ErrorNote error={error} />
        <ResponsiveDialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" loading={busy} disabled={!status} onClick={() => void run(() => del.mutateAsync({ id: status!.id, moveTo: moveTo || undefined }).then(() => undefined))}>
            Delete column
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

// ---- sprints ----

export function SprintDialog({ open, onOpenChange, boardId, sprint }: { open: boolean; onOpenChange: (open: boolean) => void; boardId: string; sprint: Sprint | null }) {
  const create = useCreateSprint()
  const update = useUpdateSprint()
  const { busy, error, run } = useSubmit(onOpenChange, sprint ? "Couldn't save the sprint" : "Couldn't create the sprint")
  const [name, setName] = React.useState("")
  const [goal, setGoal] = React.useState("")
  const [start, setStart] = React.useState("")
  const [end, setEnd] = React.useState("")
  React.useEffect(() => {
    if (!open) return
    setName(sprint?.name ?? "")
    setGoal(sprint?.goal ?? "")
    setStart(toDateInput(sprint?.startAt))
    setEnd(toDateInput(sprint?.endAt))
  }, [open, sprint])
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{sprint ? "Edit sprint" : "New sprint"}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>A dated window of work. Start it when the team commits; complete it to roll open work forward.</ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form
          id="sprint-dialog-form"
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim()) return
            const input = { name: name.trim(), goal: goal.trim() || null, startAt: fromDateInput(start), endAt: fromDateInput(end) }
            void run(async () => {
              if (sprint) await update.mutateAsync({ id: sprint.id, input })
              else await create.mutateAsync({ boardId, input })
            })
          }}
        >
            <Field htmlFor="sprint-name" label="Name">
              <Input id="sprint-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Sprint 1" maxLength={120} />
            </Field>
            <Field htmlFor="sprint-goal" label="Goal">
              <Textarea id="sprint-goal" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What done looks like" className="min-h-14" />
            </Field>
            <div className={FIELD_GRID}>
              <Field htmlFor="sprint-start" label="Start">
                <Input id="sprint-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
              </Field>
              <Field htmlFor="sprint-end" label="End">
                <Input id="sprint-end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
              </Field>
            </div>
          <ErrorNote error={error} />
        </form>
        <ResponsiveDialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="sprint-dialog-form" loading={busy} disabled={!name.trim()}>
            {sprint ? "Save" : "Create sprint"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

/** Close a sprint, having said where its open tasks go. */
export function CompleteSprintDialog({ open, onOpenChange, sprint, openCount, doneCount }: { open: boolean; onOpenChange: (open: boolean) => void; sprint: Sprint | null; openCount: number; doneCount: number }) {
  const complete = useCompleteSprint()
  const [moveTo, setMoveTo] = React.useState<"backlog" | "next">("next")
  const { busy, error, run } = useSubmit(onOpenChange, "Couldn't complete the sprint")
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Complete “{sprint?.name}”?</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <ResponsiveDialogDescription>
          {doneCount} {doneCount === 1 ? "task is" : "tasks are"} done and stay on the record.{" "}
          {openCount > 0 ? `${openCount} ${openCount === 1 ? "task is" : "tasks are"} still open — choose where they go.` : "Nothing is left open."}
        </ResponsiveDialogDescription>
        {openCount > 0 && (
          <RadioGroup value={moveTo} onValueChange={(v) => setMoveTo(v as typeof moveTo)} className="gap-3">
            {(["next", "backlog"] as const).map((opt) => (
              <label key={opt} className="flex cursor-pointer items-start gap-3 text-sm">
                <RadioGroupItem value={opt} className="mt-0.5" />
                {opt === "next" ? "Move to the next sprint (created if there is none)" : "Return to the backlog"}
              </label>
            ))}
          </RadioGroup>
        )}
        <ErrorNote error={error} />
        <ResponsiveDialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            loading={busy}
            disabled={!sprint}
            onClick={() =>
              void run(async () => {
                const result = await complete.mutateAsync({ id: sprint!.id, moveTo })
                toast.success(result.moved > 0 ? `Sprint completed · ${result.moved} moved to ${result.next?.name ?? "the backlog"}` : "Sprint completed")
              })
            }
          >
            Complete sprint
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

// ---- saved views ----

export function SaveViewDialog({ open, onOpenChange, boardId, state, existing, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; boardId: string; state: ViewState; existing: BoardView | null; onSaved: (view: BoardView) => void }) {
  const create = useCreateView()
  const update = useUpdateView()
  const { busy, error, run } = useSubmit(onOpenChange, "Couldn't save the view")
  const [name, setName] = React.useState("")
  const [kind, setKind] = React.useState<ViewKind>(state.kind)
  const [asNew, setAsNew] = React.useState(false)
  React.useEffect(() => {
    if (!open) return
    setName(existing?.name ?? "")
    setKind(state.kind)
    setAsNew(!existing)
  }, [open, existing, state.kind])
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{existing && !asNew ? "Update view" : "Save view"}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>The current layout, filters, grouping and sort, under a name in the Views menu.</ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form
          id="save-view-dialog-form"
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim()) return
            void run(async () => {
              const input = { name: name.trim(), kind, config: viewConfigOf({ ...state, kind }) }
              const saved = existing && !asNew ? await update.mutateAsync({ id: existing.id, input }) : await create.mutateAsync({ boardId, input })
              onSaved(saved)
            })
          }}
        >
            <Field htmlFor="view-name" label="Name">
              <Input id="view-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My open bugs" maxLength={80} />
            </Field>
            <Field label="Layout">
              {/* Sprints is the workspace's planning mode, not a saved layout. */}
              <ChoiceTiles
                label="Layout"
                value={kind}
                onChange={setKind}
                choices={MODES.filter((m): m is (typeof MODES)[number] & { id: ViewKind } => m.id !== "sprints").map((m) => ({ value: m.id, label: m.label, icon: m.icon }))}
              />
            </Field>
            {existing && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={asNew} onCheckedChange={(checked) => setAsNew(checked)} />
                Save as a new view instead of updating “{existing.name}”
              </label>
            )}
          <ErrorNote error={error} />
        </form>
        <ResponsiveDialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="save-view-dialog-form" loading={busy} disabled={!name.trim()}>
            Save
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
