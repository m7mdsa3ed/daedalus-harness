/* ── Labels ──
   Free-floating tags: no order, no category, no behaviour — a name and a
   colour. The one thing worth saying out loud is what a delete does:
   `pm_task_labels` cascades from both sides, so deleting a label silently
   removes it from every task that wore it and nothing keeps a copy. The
   confirm says how many tasks that is. */
import * as React from "react"
import { Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { useConfirm } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ColorSwatches, EditorHeader, NameInput } from "@/components/pm/settings/editor-bits"
import type { Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import type { Board, Label as PmLabel, LabelInput, Task } from "@/lib/pm/types"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

const EMPTY_TASKS: Task[] = []

/** How many live tasks wear each label — one pass over the board. */
export function labelTaskCounts(tasks: Task[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const task of tasks) {
    if (task.deletedAt !== null) continue
    for (const id of task.labelIds) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}

export const sortLabels = (labels: PmLabel[]): PmLabel[] =>
  [...labels].sort((a, b) => a.name.localeCompare(b.name))

export interface LabelsEditorProps {
  board: Board
  actions: Actions
  tasks?: Task[]
  className?: string
}

export function LabelsEditor({ board, actions, tasks, className }: LabelsEditorProps) {
  const confirm = useConfirm()
  const { state } = useStore()
  const [busy, setBusy] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [newName, setNewName] = React.useState("")

  const boardTasks = tasks ?? state.pmTasks[board.id] ?? EMPTY_TASKS
  const counts = React.useMemo(() => labelTaskCounts(boardTasks), [boardTasks])
  const labels = React.useMemo(() => sortLabels(board.labels), [board.labels])

  const patch = React.useCallback(
    (label: PmLabel, next: Partial<LabelInput>) => {
      setBusy(true)
      actions
        .patchLabel(board.id, label.id, next)
        .catch((err) => reportError(err, `Couldn't save ${label.name}`))
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
      await actions.createLabel(board.id, { name, color: null })
      toast.success(`${name} added`)
      setNewName("")
      setCreating(false)
    } catch (err) {
      reportError(err, "Couldn't add the label")
    } finally {
      setBusy(false)
    }
  }

  const remove = React.useCallback(
    async (label: PmLabel) => {
      const worn = counts.get(label.id) ?? 0
      const ok = await confirm({
        title: `Delete ${label.name}?`,
        description:
          worn === 0
            ? "No task wears it."
            : `It comes off ${worn} ${worn === 1 ? "task" : "tasks"}. Nothing keeps a copy.`,
        confirmLabel: "Delete label",
        destructive: true,
      })
      if (!ok) return
      setBusy(true)
      try {
        await actions.deleteLabel(board.id, label.id)
        toast.success(`${label.name} deleted`)
      } catch (err) {
        reportError(err, "Couldn't delete the label")
      } finally {
        setBusy(false)
      }
    },
    [actions, board.id, confirm, counts]
  )

  return (
    <div className={cn("space-y-3", className)}>
      <EditorHeader
        title="Labels"
        hint="Tags a task can wear any number of. Deleting one takes it off every task."
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => setCreating(true)}>
            <Plus />
            New label
          </Button>
        }
      />

      {labels.length === 0 && !creating && (
        <p className="py-6 text-center text-sm text-muted-foreground">No labels yet.</p>
      )}

      <div className="space-y-1.5">
        {labels.map((label) => (
          <LabelRow
            key={label.id}
            label={label}
            taskCount={counts.get(label.id) ?? 0}
            busy={busy}
            onPatch={patch}
            onDelete={remove}
          />
        ))}
      </div>

      {creating && (
        <form onSubmit={create} className="flex items-center gap-2 border-t border-border pt-3">
          <Input
            autoFocus
            value={newName}
            aria-label="New label name"
            placeholder="regression"
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
    </div>
  )
}

interface LabelRowProps {
  label: PmLabel
  taskCount: number
  busy: boolean
  onPatch(label: PmLabel, patch: Partial<LabelInput>): void
  onDelete(label: PmLabel): void
}

const LabelRow = React.memo(function LabelRow({
  label,
  taskCount,
  busy,
  onPatch,
  onDelete,
}: LabelRowProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-card/40 px-2 py-1.5">
      <span
        aria-hidden
        className="size-2.5 shrink-0 rounded-full bg-muted-foreground/40"
        style={label.color ? { backgroundColor: label.color } : undefined}
      />
      <NameInput
        value={label.name}
        ariaLabel={`${label.name} name`}
        disabled={busy}
        onCommit={(name) => onPatch(label, { name })}
        className="min-w-32 flex-1"
      />
      <ColorSwatches
        label={label.name}
        value={label.color}
        disabled={busy}
        onChange={(color) => onPatch(label, { color })}
      />
      <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
        {taskCount} {taskCount === 1 ? "task" : "tasks"}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={busy}
        title="Delete label"
        aria-label={`Delete ${label.name}`}
        onClick={() => onDelete(label)}
      >
        <Trash2 />
      </Button>
    </div>
  )
})

export default LabelsEditor
