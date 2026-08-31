import * as React from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { reportError } from "@/lib/errors"
import {
  BOARD_COLORS,
  COLOR_DOT,
  COLOR_LABEL,
  type BoardColor,
  type BoardStatus,
} from "@/lib/boards"

/* The three edits a board or a column needs, each as its own dialog rather
   than one polymorphic form: naming a thing and deciding where a column's
   tasks go are different questions, and the second one has to be asked (a
   column delete moves work; it must not look like a task delete). */

/** A swatch row — the whole palette, since there are six of them. */
function ColorPicker({
  value,
  onChange,
}: {
  value: BoardColor | null
  onChange: (color: BoardColor | null) => void
}) {
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

/**
 * Name-and-colour, for creating or renaming a board or a column.
 *
 * `onSubmit` owns the request; this only keeps the dialog open and busy while
 * it runs, so a failure leaves the typed name on screen to retry rather than
 * closing over it.
 */
export function NameDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  initialName = "",
  initialColor = null,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  submitLabel: string
  initialName?: string
  initialColor?: BoardColor | null
  onSubmit: (value: { name: string; color: BoardColor | null }) => Promise<void>
}) {
  const [name, setName] = React.useState(initialName)
  const [color, setColor] = React.useState<BoardColor | null>(initialColor)
  const [busy, setBusy] = React.useState(false)

  // Re-seed each time it opens: the same dialog instance serves "rename this
  // column" for every column on the board.
  React.useEffect(() => {
    if (!open) return
    setName(initialName)
    setColor(initialColor)
  }, [open, initialName, initialColor])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      await onSubmit({ name: name.trim(), color })
      onOpenChange(false)
    } catch (err) {
      reportError(err, title)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-5 py-5">
            <div className="grid gap-2">
              <Label htmlFor="board-name">Name</Label>
              <Input
                id="board-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. In review"
                maxLength={120}
              />
            </div>
            <div className="grid gap-2">
              <Label>Colour</Label>
              <ColorPicker value={color} onChange={setColor} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? "Saving…" : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Delete a column, having said where its tasks go.
 *
 * The destination is a choice and not a default, because the alternative — a
 * cascade — would delete work silently. A column with nothing in it skips the
 * question, since there is nothing to decide.
 */
export function DeleteStatusDialog({
  open,
  onOpenChange,
  status,
  siblings,
  taskCount,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: BoardStatus | null
  /** The board's other columns — where the tasks may go. */
  siblings: BoardStatus[]
  taskCount: number
  onConfirm: (moveTo: string | undefined) => Promise<void>
}) {
  const [moveTo, setMoveTo] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (open) setMoveTo(siblings[0]?.id ?? "")
  }, [open, siblings])

  const confirm = async () => {
    if (busy) return
    setBusy(true)
    try {
      await onConfirm(moveTo || undefined)
      onOpenChange(false)
    } catch (err) {
      reportError(err, "Couldn't delete the column")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete “{status?.name}”?</DialogTitle>
          <DialogDescription>
            {taskCount === 0
              ? "The column is empty, so nothing moves."
              : `${taskCount} ${taskCount === 1 ? "task" : "tasks"} will move to another column — nothing is deleted.`}
          </DialogDescription>
        </DialogHeader>
        {taskCount > 0 && siblings.length > 0 && (
          <div className="grid gap-2 py-2">
            <Label>Move its tasks to</Label>
            <Select value={moveTo} onValueChange={(v) => setMoveTo(v ?? "")}>
              <SelectTrigger className="w-full">
                <SelectValue>
                  {siblings.find((s) => s.id === moveTo)?.name ?? "Choose a column"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {siblings.map((sibling) => (
                  <SelectItem key={sibling.id} value={sibling.id}>
                    {sibling.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={confirm}
            disabled={busy}
            className="bg-destructive text-white hover:bg-destructive/90"
          >
            {busy ? "Deleting…" : "Delete column"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Delete a board — which does take its tasks with it, so the count is said
    out loud rather than implied. */
export function DeleteBoardDialog({
  open,
  onOpenChange,
  name,
  taskCount,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  name: string
  taskCount: number
  onConfirm: () => Promise<void>
}) {
  const [busy, setBusy] = React.useState(false)

  const confirm = async () => {
    if (busy) return
    setBusy(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch (err) {
      reportError(err, "Couldn't delete the board")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete “{name}”?</DialogTitle>
          <DialogDescription>
            {taskCount === 0
              ? "The board is empty. Its columns are deleted with it."
              : `Its columns and all ${taskCount} ${taskCount === 1 ? "task" : "tasks"} on it are deleted. This cannot be undone.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={confirm}
            disabled={busy}
            className="bg-destructive text-white hover:bg-destructive/90"
          >
            {busy ? "Deleting…" : "Delete board"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
