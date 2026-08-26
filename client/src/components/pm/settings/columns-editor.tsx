/* ── Columns ──
   The board's statuses, in the order the kanban paints them. A column is more
   than a lane: its `category` is what stamps `completedAt` (moving into a
   `done` column completes the task, moving out clears it), which is what the
   burndown, the dashboard and the `task_completed` automation trigger all read.
   So the category selector says so, rather than pretending to be decoration.

   Reordering is dnd-kit vertical sortable, and it writes through
   `actions.reorder({ scope: { kind: "columns" } })` — the same gap-1000 rank
   endpoint the backlog uses, not a per-column PATCH.

   Deleting is the one operation the server refuses to guess at: `columnId` is
   a RESTRICT foreign key and the endpoint requires `?moveTasksTo=`, so the
   delete flow asks which column the tasks land in before it asks whether to
   go ahead. A board's last column cannot be deleted at all — there would be
   nowhere for its tasks to go. */
import * as React from "react"
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

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
import { ColorSwatches, EditorHeader, NameInput } from "@/components/pm/settings/editor-bits"
import type { Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import type { Board, Column, ColumnCategory, ColumnInput, Task } from "@/lib/pm/types"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

const CATEGORIES: Array<{ value: ColumnCategory; label: string; hint: string }> = [
  { value: "open", label: "Open", hint: "Not started." },
  { value: "active", label: "Active", hint: "In flight." },
  { value: "done", label: "Done", hint: "Completes the task." },
]

const categoryLabel = (category: ColumnCategory) =>
  CATEGORIES.find((entry) => entry.value === category)?.label ?? category

const EMPTY_TASKS: Task[] = []

/** How many live tasks sit in each column — one pass, not one per row. */
export function columnTaskCounts(tasks: Task[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const task of tasks) {
    if (task.deletedAt !== null || task.archivedAt !== null) continue
    counts.set(task.columnId, (counts.get(task.columnId) ?? 0) + 1)
  }
  return counts
}

export const sortColumns = (columns: Column[]): Column[] =>
  [...columns].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))

export interface ColumnsEditorProps {
  board: Board
  actions: Actions
  /** Defaults to the board's cached tasks — only used for the counts. */
  tasks?: Task[]
  className?: string
}

export function ColumnsEditor({ board, actions, tasks, className }: ColumnsEditorProps) {
  const { state } = useStore()
  const [busy, setBusy] = React.useState(false)
  const [deleting, setDeleting] = React.useState<Column | null>(null)
  const [creating, setCreating] = React.useState(false)
  const [newName, setNewName] = React.useState("")

  const boardTasks = tasks ?? state.pmTasks[board.id] ?? EMPTY_TASKS
  const counts = React.useMemo(() => columnTaskCounts(boardTasks), [boardTasks])
  const columns = React.useMemo(() => sortColumns(board.columns), [board.columns])

  const sensors = useSensors(
    // Distance 6, like the kanban: below that a press is a click on a control.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const patch = React.useCallback(
    (column: Column, next: Partial<ColumnInput>) => {
      setBusy(true)
      actions
        .patchColumn(board.id, column.id, next)
        .catch((err) => reportError(err, `Couldn't save ${column.name}`))
        .finally(() => setBusy(false))
    },
    [actions, board.id]
  )

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    const name = newName.trim()
    if (!name || busy) return
    setBusy(true)
    try {
      await actions.createColumn(board.id, {
        name,
        color: null,
        category: "open",
        wipLimit: null,
      })
      toast.success(`${name} added`)
      setNewName("")
      setCreating(false)
    } catch (err) {
      reportError(err, "Couldn't add the column")
    } finally {
      setBusy(false)
    }
  }

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const ids = columns.map((column) => column.id)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from === -1 || to === -1) return
    ids.splice(to, 0, ...ids.splice(from, 1))
    // `reorder` paints the new ranks optimistically and reloads the board — a
    // failure rolls the whole list back and reports itself.
    void actions
      .reorder(board.id, { scope: { kind: "columns" }, orderedIds: ids })
      .catch(() => {})
  }

  return (
    <div className={cn("space-y-3", className)}>
      <EditorHeader
        title="Columns"
        hint="The board's statuses. A column's category decides whether landing in it completes the task."
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => setCreating(true)}>
            <Plus />
            New column
          </Button>
        }
      />

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext
          items={columns.map((column) => column.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-1.5">
            {columns.map((column) => (
              <SortableColumnRow
                key={column.id}
                column={column}
                taskCount={counts.get(column.id) ?? 0}
                busy={busy}
                canDelete={columns.length > 1}
                onPatch={patch}
                onDelete={setDeleting}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {creating && (
        <form onSubmit={create} className="flex items-center gap-2 border-t border-border pt-3">
          <Input
            autoFocus
            value={newName}
            aria-label="New column name"
            placeholder="In review"
            onChange={(event) => setNewName(event.target.value)}
            className="h-8 text-[13px]"
          />
          <Button type="submit" size="sm" disabled={busy || newName.trim().length === 0}>
            Add
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setCreating(false)
              setNewName("")
            }}
          >
            Cancel
          </Button>
        </form>
      )}

      <DeleteColumnDialog
        board={board}
        column={deleting}
        taskCount={deleting ? (counts.get(deleting.id) ?? 0) : 0}
        actions={actions}
        onClose={() => setDeleting(null)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Rows

interface ColumnRowProps {
  column: Column
  taskCount: number
  busy: boolean
  canDelete: boolean
  onPatch(column: Column, patch: Partial<ColumnInput>): void
  onDelete(column: Column): void
}

/** Memo'd on stable callbacks: a board with a dozen columns should not
    re-render every row while one WIP limit is being typed into. */
const ColumnRow = React.memo(function ColumnRow({
  column,
  taskCount,
  busy,
  canDelete,
  onPatch,
  onDelete,
  dragging,
  handleProps,
  ref,
  style,
}: ColumnRowProps & {
  dragging?: boolean
  handleProps?: React.HTMLAttributes<HTMLButtonElement>
  ref?: React.Ref<HTMLDivElement>
  style?: React.CSSProperties
}) {
  const [wip, setWip] = React.useState(column.wipLimit === null ? "" : String(column.wipLimit))
  React.useEffect(() => {
    setWip(column.wipLimit === null ? "" : String(column.wipLimit))
  }, [column.wipLimit])

  const commitWip = () => {
    const raw = wip.trim()
    if (raw === "") {
      if (column.wipLimit !== null) onPatch(column, { wipLimit: null })
      return
    }
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 1) {
      setWip(column.wipLimit === null ? "" : String(column.wipLimit))
      return
    }
    if (value !== column.wipLimit) onPatch(column, { wipLimit: value })
  }

  return (
    <div
      ref={ref}
      style={style}
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-md border bg-card/40 px-2 py-1.5",
        dragging && "opacity-60"
      )}
    >
      <button
        type="button"
        aria-label={`Reorder ${column.name}`}
        {...handleProps}
        className="grid size-6 shrink-0 cursor-grab touch-none place-items-center rounded text-muted-foreground hover:bg-muted"
      >
        <GripVertical className="size-4" />
      </button>

      <NameInput
        value={column.name}
        ariaLabel={`${column.name} name`}
        disabled={busy}
        onCommit={(name) => onPatch(column, { name })}
        className="min-w-32 flex-1"
      />

      <Select
        value={column.category}
        onValueChange={(value) =>
          onPatch(column, { category: String(value) as ColumnCategory })
        }
      >
        <SelectTrigger size="sm" className="w-28" aria-label={`${column.name} category`}>
          <SelectValue>{categoryLabel(column.category)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {CATEGORIES.map((entry) => (
            <SelectItem key={entry.value} value={entry.value}>
              {entry.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Input
        value={wip}
        inputMode="numeric"
        aria-label={`${column.name} WIP limit`}
        title="WIP limit — blank for none"
        placeholder="WIP"
        disabled={busy}
        onChange={(event) => setWip(event.target.value)}
        onBlur={commitWip}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur()
        }}
        className="h-8 w-16 text-[13px]"
      />

      <ColorSwatches
        label={column.name}
        value={column.color}
        disabled={busy}
        onChange={(color) => onPatch(column, { color })}
      />

      <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
        {taskCount} {taskCount === 1 ? "task" : "tasks"}
      </span>

      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={busy || !canDelete}
        title={canDelete ? "Delete column" : "A board keeps at least one column"}
        aria-label={`Delete ${column.name}`}
        onClick={() => onDelete(column)}
      >
        <Trash2 />
      </Button>
    </div>
  )
})

/** The draggable wrapper — no `transition-transform` class near it: dnd-kit
    sets transform imperatively and a CSS transition fights it. */
function SortableColumnRow(props: ColumnRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.column.id,
  })
  return (
    <ColumnRow
      {...props}
      ref={setNodeRef}
      dragging={isDragging}
      handleProps={{ ...attributes, ...listeners } as React.HTMLAttributes<HTMLButtonElement>}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    />
  )
}

// ---------------------------------------------------------------------------
// Delete

/** `?moveTasksTo=` is required by the server — a column delete must never eat
    tasks — so the target is picked here, before the confirm, not guessed. */
function DeleteColumnDialog({
  board,
  column,
  taskCount,
  actions,
  onClose,
}: {
  board: Board
  column: Column | null
  taskCount: number
  actions: Actions
  onClose(): void
}) {
  const others = React.useMemo(
    () => sortColumns(board.columns).filter((entry) => entry.id !== column?.id),
    [board.columns, column?.id]
  )
  const [target, setTarget] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (!column) return
    setTarget(others[0]?.id ?? "")
    setBusy(false)
  }, [column, others])

  const submit = async () => {
    if (!column || !target || busy) return
    setBusy(true)
    try {
      await actions.deleteColumn(board.id, column.id, target)
      toast.success(`${column.name} deleted`)
      onClose()
    } catch (err) {
      reportError(err, "Couldn't delete the column")
      setBusy(false)
    }
  }

  const targetName = others.find((entry) => entry.id === target)?.name ?? "—"

  return (
    <Dialog open={column !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {column?.name}?</DialogTitle>
          <DialogDescription>
            {taskCount === 0
              ? "The column is empty — nothing moves."
              : `${taskCount} ${taskCount === 1 ? "task moves" : "tasks move"} to another column first. Nothing is deleted with it.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Move tasks to</span>
          <Select value={target} onValueChange={(value) => setTarget(String(value))}>
            <SelectTrigger className="w-full" aria-label="Move tasks to">
              <SelectValue>{targetName}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {others.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy || !target}
            onClick={() => void submit()}
          >
            Delete column
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ColumnsEditor
