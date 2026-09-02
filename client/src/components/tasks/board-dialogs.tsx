import * as React from "react"
import { ChevronDown, ChevronUp, GripVertical, Plus, Trash2 } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
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
  VIEW_KINDS,
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
import { fromDateInput, toDateInput } from "./fields"

/* The edits a board needs, each as its own dialog rather than one polymorphic
   form: naming a thing and deciding where a column's tasks go are different
   questions, and the second one has to be asked (a column delete moves work;
   it must not look like a task delete). */

/** A swatch row — the whole palette. */
export function ColorPicker({ value, onChange }: { value: BoardColor | null; onChange: (color: BoardColor | null) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={() => onChange(null)}
        aria-label="No colour"
        aria-pressed={value === null}
        className={cn(
          "grid size-7 place-items-center rounded-full border text-[10px] text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          value === null ? "border-primary/50 bg-primary/10" : "border-transparent bg-muted/50",
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
            "grid size-7 place-items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === color ? "border-primary/50 bg-primary/10" : "border-transparent",
          )}
        >
          <span className={cn("size-3.5 rounded-full", COLOR_DOT[color])} />
        </button>
      ))}
    </div>
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
        <form id="board-dialog-form" onSubmit={submit} className="grid content-start gap-6">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_7rem]">
              <div className="grid gap-2">
                <Label htmlFor="board-name">Name</Label>
                <Input id="board-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Web platform" maxLength={120} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="board-key">Key</Label>
                <Input
                  id="board-key"
                  value={key}
                  onChange={(e) => {
                    setKeyTouched(true)
                    setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))
                  }}
                  placeholder="WEB"
                  className="font-mono uppercase"
                />
              </div>
            </div>
            <p className="-mt-3 text-xs text-muted-foreground">
              Every task on the board is <span className="font-mono">{key || "KEY"}-1</span>, <span className="font-mono">{key || "KEY"}-2</span>… Changing the key renames them all.
            </p>
            <div className="grid gap-2">
              <Label>Colour</Label>
              <ColorPicker value={color} onChange={setColor} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="board-desc">Description</Label>
              <Textarea id="board-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this board is for" className="min-h-16" />
            </div>
            <div className="grid gap-2">
              <Label>Project</Label>
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
            </div>

            {board && (
              <div className="grid gap-2">
                <Label>Columns</Label>
                <p className="text-xs text-muted-foreground">A task entering a <em>Done</em> column is completed. A WIP limit is shown, never enforced. Column edits save immediately.</p>
                <ul className="grid gap-1 rounded-xl border p-1">
                  {statuses.map((s, i) => (
                    <li key={s.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5 rounded-lg px-1 py-1 hover:bg-accent/40 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto_auto_auto]">
                      <GripVertical className="size-3.5 text-muted-foreground/50" />
                      <Input
                        defaultValue={s.name}
                        onBlur={(e) => {
                          const v = e.target.value.trim()
                          if (v && v !== s.name) void patchStatus(s, { name: v })
                        }}
                        className="h-7 text-xs"
                        aria-label="Column name"
                      />
                      <span className="inline-flex">
                        <button type="button" disabled={i === 0} onClick={() => moveColumn(s, -1)} aria-label="Move up" className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-accent disabled:opacity-30">
                          <ChevronUp className="size-3.5" />
                        </button>
                        <button type="button" disabled={i === statuses.length - 1} onClick={() => moveColumn(s, 1)} aria-label="Move down" className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-accent disabled:opacity-30">
                          <ChevronDown className="size-3.5" />
                        </button>
                        <button type="button" disabled={statuses.length <= 1} onClick={() => onDeleteStatus(s)} aria-label="Delete column" className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-30">
                          <Trash2 className="size-3.5" />
                        </button>
                      </span>
                      {/* The three controls rejoin the flat grid on desktop. */}
                      <div className="col-span-full grid grid-cols-[minmax(0,1fr)_4.5rem_minmax(0,1fr)] gap-1.5 sm:contents">
                        <select value={s.category} onChange={(e) => void patchStatus(s, { category: e.target.value as StatusCategory })} className="h-7 rounded-md border bg-background px-1 text-xs" aria-label="Category">
                          {STATUS_CATEGORIES.map((c) => (
                            <option key={c} value={c}>
                              {CATEGORY_LABEL[c]}
                            </option>
                          ))}
                        </select>
                        <Input
                          type="number"
                          min={1}
                          defaultValue={s.wipLimit ?? ""}
                          onBlur={(e) => {
                            const v = e.target.value === "" ? null : Number(e.target.value)
                            if (v !== s.wipLimit) void patchStatus(s, { wipLimit: v })
                          }}
                          placeholder="WIP"
                          className="h-7 text-xs"
                          aria-label="WIP limit"
                        />
                        <select value={s.color ?? ""} onChange={(e) => void patchStatus(s, { color: (e.target.value || null) as BoardColor | null })} className="h-7 rounded-md border bg-background px-1 text-xs" aria-label="Colour">
                          <option value="">No colour</option>
                          {BOARD_COLORS.map((c) => (
                            <option key={c} value={c}>
                              {COLOR_LABEL[c]}
                            </option>
                          ))}
                        </select>
                      </div>
                    </li>
                  ))}
                  <li className="flex items-center gap-1.5 px-1 py-1">
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
                      className="h-7 text-xs"
                    />
                    <Button type="button" size="xs" variant="outline" onClick={addColumn} disabled={!newColumn.trim()}>
                      <Plus className="size-3" /> Add
                    </Button>
                  </li>
                </ul>
              </div>
            )}

            {board && (
              <div className="grid gap-2">
                <Label>Custom fields</Label>
                <p className="text-xs text-muted-foreground">Extra properties every task on this board can carry. Saved with the board.</p>
                <ul className="grid gap-1 rounded-xl border p-1">
                  {fields.map((f) => (
                    <li key={f.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5 rounded-lg px-1 py-1 sm:grid-cols-[minmax(0,1fr)_7rem_minmax(0,1fr)_auto]">
                      <Input value={f.name} onChange={(e) => setField(f.id, { name: e.target.value })} placeholder="Field name" className="h-7 text-xs" aria-label="Field name" />
                      <button type="button" onClick={() => setFields((fs) => fs.filter((x) => x.id !== f.id))} aria-label="Remove field" className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                        <Trash2 className="size-3.5" />
                      </button>
                      {/* Type and options rejoin the flat grid on desktop. */}
                      <div className="col-span-full grid grid-cols-[7rem_minmax(0,1fr)] gap-1.5 sm:contents">
                        <select value={f.type} onChange={(e) => setField(f.id, { type: e.target.value as CustomFieldDef["type"] })} className="h-7 rounded-md border bg-background px-1 text-xs" aria-label="Field type">
                          {FIELD_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
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
                            className="h-7 text-xs"
                            aria-label="Options"
                          />
                        ) : (
                          <span />
                        )}
                      </div>
                    </li>
                  ))}
                  <li className="px-1 py-1">
                    <Button type="button" size="xs" variant="outline" onClick={() => setFields((fs) => [...fs, { id: crypto.randomUUID(), name: "", type: "text" }])}>
                      <Plus className="size-3" /> Add field
                    </Button>
                  </li>
                </ul>
              </div>
            )}
          <ErrorNote error={error} />
          <ResponsiveDialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" form="board-dialog-form" disabled={busy || !name.trim() || fields.some((f) => !f.name.trim())}>
              {busy ? "Saving…" : board ? "Save" : "Create board"}
            </Button>
          </ResponsiveDialogFooter>
        </form>
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
            disabled={busy || !board}
            onClick={() =>
              void run(async () => {
                await del.mutateAsync(board!.id)
                onDeleted()
              })
            }
          >
            {busy ? "Deleting…" : "Delete board"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

// ---- columns ----

/** Add a column with everything a column has, from the kanban's "+ Add column". */
export function ColumnDialog({ open, onOpenChange, boardId }: { open: boolean; onOpenChange: (open: boolean) => void; boardId: string }) {
  const create = useCreateStatus()
  const { busy, error, run } = useSubmit(onOpenChange, "Couldn't add the column")
  const [name, setName] = React.useState("")
  const [color, setColor] = React.useState<BoardColor | null>(null)
  const [category, setCategory] = React.useState<StatusCategory>("in_progress")
  const [wip, setWip] = React.useState("")
  React.useEffect(() => {
    if (open) {
      setName("")
      setColor(null)
      setCategory("in_progress")
      setWip("")
    }
  }, [open])
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <form
          id="column-dialog-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim()) return
            void run(async () => {
              await create.mutateAsync({ boardId, input: { name: name.trim(), color, category, wipLimit: wip ? Number(wip) : null } })
            })
          }}
        >
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>New column</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>A column is a status a task can be in. It is added at the end.</ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="col-name">Name</Label>
              <Input id="col-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. In review" maxLength={60} />
            </div>
            <div className="grid gap-2">
              <Label>Category</Label>
              <div className="flex gap-1">
                {STATUS_CATEGORIES.map((c) => (
                  <button key={c} type="button" onClick={() => setCategory(c)} aria-pressed={category === c} className={cn("rounded-pill border px-2.5 py-1 text-xs", category === c ? "border-primary/40 bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent")}>
                    {CATEGORY_LABEL[c]}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="col-wip">WIP limit</Label>
              <Input id="col-wip" type="number" min={1} value={wip} onChange={(e) => setWip(e.target.value)} placeholder="Optional" className="w-28" />
            </div>
            <div className="grid gap-2">
              <Label>Colour</Label>
              <ColorPicker value={color} onChange={setColor} />
            </div>
          </div>
          <ErrorNote error={error} />
          <ResponsiveDialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" form="column-dialog-form" disabled={busy || !name.trim()}>
              {busy ? "Adding…" : "Add column"}
            </Button>
          </ResponsiveDialogFooter>
        </form>
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
          <div className="grid gap-2 py-2">
            <Label>Move its tasks to</Label>
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
          </div>
        )}
        <ErrorNote error={error} />
        <ResponsiveDialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={busy || !status} onClick={() => void run(() => del.mutateAsync({ id: status!.id, moveTo: moveTo || undefined }).then(() => undefined))}>
            {busy ? "Deleting…" : "Delete column"}
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
        <form
          id="sprint-dialog-form"
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
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>{sprint ? "Edit sprint" : "New sprint"}</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>A dated window of work. Start it when the team commits; complete it to roll open work forward.</ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="sprint-name">Name</Label>
              <Input id="sprint-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Sprint 1" maxLength={120} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sprint-goal">Goal</Label>
              <Textarea id="sprint-goal" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What done looks like" className="min-h-14" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="sprint-start">Start</Label>
                <Input id="sprint-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="sprint-end">End</Label>
                <Input id="sprint-end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
              </div>
            </div>
          </div>
          <ErrorNote error={error} />
          <ResponsiveDialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" form="sprint-dialog-form" disabled={busy || !name.trim()}>
              {busy ? "Saving…" : sprint ? "Save" : "Create sprint"}
            </Button>
          </ResponsiveDialogFooter>
        </form>
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
          <div className="grid gap-1 py-2">
            {(["next", "backlog"] as const).map((opt) => (
              <label key={opt} className={cn("flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm", moveTo === opt && "border-primary/40 bg-primary/5")}>
                <input type="radio" name="moveTo" checked={moveTo === opt} onChange={() => setMoveTo(opt)} className="accent-primary" />
                {opt === "next" ? "Move to the next sprint (created if there is none)" : "Return to the backlog"}
              </label>
            ))}
          </div>
        )}
        <ErrorNote error={error} />
        <ResponsiveDialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || !sprint}
            onClick={() =>
              void run(async () => {
                const result = await complete.mutateAsync({ id: sprint!.id, moveTo })
                toast.success(result.moved > 0 ? `Sprint completed · ${result.moved} moved to ${result.next?.name ?? "the backlog"}` : "Sprint completed")
              })
            }
          >
            {busy ? "Completing…" : "Complete sprint"}
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
        <form
          id="save-view-dialog-form"
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
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>{existing && !asNew ? "Update view" : "Save view"}</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>The current layout, filters, grouping and sort, under a name in the Views menu.</ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="view-name">Name</Label>
              <Input id="view-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My open bugs" maxLength={80} />
            </div>
            <div className="grid gap-2">
              <Label>Layout</Label>
              <div className="flex flex-wrap gap-1">
                {VIEW_KINDS.map((k) => (
                  <button key={k} type="button" onClick={() => setKind(k)} aria-pressed={kind === k} className={cn("rounded-pill border px-2.5 py-1 text-xs capitalize", kind === k ? "border-primary/40 bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent")}>
                    {k}
                  </button>
                ))}
              </div>
            </div>
            {existing && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={asNew} onChange={(e) => setAsNew(e.target.checked)} className="accent-primary" />
                Save as a new view instead of updating “{existing.name}”
              </label>
            )}
          </div>
          <ErrorNote error={error} />
          <ResponsiveDialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" form="save-view-dialog-form" disabled={busy || !name.trim()}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
