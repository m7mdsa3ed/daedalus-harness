import * as React from "react"
import { format } from "date-fns"
import { CalendarIcon, Check, Flag, Pencil, Plus, RotateCcw, X } from "lucide-react"
import { toast } from "sonner"

import { useConfirm } from "@/components/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import type { Board, Milestone, MilestoneInput, Task } from "@/lib/pm/types"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

/* ── Milestone editor ──
   One dialog for the whole of a board's milestones: the list (name, date,
   reached state, how many tasks point at it), an inline create/edit form, the
   delete confirm, and the reach/un-reach switch. A milestone is a date with a
   name — there is not enough of one to earn a page, and seeing the others is
   the only way to tell whether a new date is sane.

   Dates use the idiom new-task-dialog established and sprint-editor reuses: a
   Popover over the shared Calendar, cleared by a small ✕, epoch-ms on the wire.

   `MilestoneMarker` is the presentational half — the pill a calendar or
   timeline cell drops on a day. Pure and memo'd, no fetching, so a view can
   render one per date without paying for it. */

/** A milestone change moves the board's `milestones` array, and a delete moves
    the tasks that pointed at it (SET NULL), so both caches are refetched — the
    same fire-and-forget shape `refreshAfterSprintChange` uses. */
export function refreshAfterMilestoneChange(actions: Actions, boardId: string): void {
  void actions.loadBoard(boardId).catch(() => {})
  void actions.loadBoardTasks(boardId, { force: true }).catch(() => {})
}

// ---------------------------------------------------------------------------
// Presentation helpers (shared with the calendar/timeline markers)

/** "17 Mar 2026", or null when the milestone is undated. */
export function milestoneDateLabel(milestone: Milestone): string | null {
  return milestone.date === null ? null : format(milestone.date, "d MMM yyyy")
}

/** Whole days until the milestone; negative once it is past, null if undated. */
export function milestoneDaysLeft(milestone: Milestone, now = Date.now()): number | null {
  if (milestone.date === null) return null
  return Math.ceil((milestone.date - now) / 86_400_000)
}

/** Board order: dated first, ascending, then undated by name — the same order
    the server lists them in, restated so a locally-sorted list agrees. */
export function sortMilestones(milestones: Milestone[]): Milestone[] {
  return [...milestones].sort((a, b) => {
    if (a.date === null && b.date === null) return a.name.localeCompare(b.name)
    if (a.date === null) return 1
    if (b.date === null) return -1
    return a.date - b.date || a.name.localeCompare(b.name)
  })
}

/** How many of `tasks` point at each milestone id. One pass, not one per row. */
export function milestoneTaskCounts(tasks: Task[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const task of tasks) {
    if (!task.milestoneId) continue
    counts.set(task.milestoneId, (counts.get(task.milestoneId) ?? 0) + 1)
  }
  return counts
}

const EMPTY_TASKS: Task[] = []

// ---------------------------------------------------------------------------
// Marker

export interface MilestoneMarkerProps {
  milestone: Milestone
  /** Hide the date half — a calendar cell already IS the date. */
  showDate?: boolean
  /** Optional click-through (open the editor, filter the board). Presentational
      either way: the pill never fetches. */
  onClick?: (milestone: Milestone) => void
  title?: string
  className?: string
}

/** The pill a calendar/timeline cell drops on a milestone's date: flag, name,
    date, and a reached tone. Pure — memo'd on its props, no store, no fetch. */
export const MilestoneMarker = React.memo(function MilestoneMarker({
  milestone,
  showDate = true,
  onClick,
  title,
  className,
}: MilestoneMarkerProps) {
  const reached = milestone.reachedAt !== null
  const date = showDate ? milestoneDateLabel(milestone) : null
  const label = title ?? `${milestone.name}${date ? ` · ${date}` : ""}`
  const handleClick = React.useCallback(() => onClick?.(milestone), [onClick, milestone])

  const content = (
    <>
      <Flag aria-hidden />
      <span className="truncate">{milestone.name}</span>
      {date && <span className="tabular-nums opacity-70">{date}</span>}
    </>
  )
  const classes = cn(
    "max-w-full",
    reached
      ? "border-transparent bg-primary/15 text-foreground"
      : "border-border bg-muted text-muted-foreground",
    onClick && "cursor-pointer hover:bg-muted/80",
    className
  )

  if (onClick) {
    return (
      <Badge
        variant="outline"
        className={classes}
        title={label}
        render={<button type="button" onClick={handleClick} />}
      >
        {content}
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className={classes} title={label}>
      {content}
    </Badge>
  )
})

// ---------------------------------------------------------------------------
// Dialog

export interface MilestoneDialogProps {
  board: Board
  open: boolean
  onOpenChange(open: boolean): void
  actions: Actions
  /** Open straight into editing this milestone (null/absent = the list). */
  milestone?: Milestone | null
  /** Tasks to count against; defaults to the board's cached tasks in the store. */
  tasks?: Task[]
  onSaved?(milestone: Milestone): void
  onDeleted?(milestoneId: string): void
}

interface Draft {
  name: string
  date: number | null
}

/** `null` = the list; an object = the form, editing `id` (null = create). */
type Editing = { id: string | null; draft: Draft } | null

const draftOf = (milestone?: Milestone | null): Draft => ({
  name: milestone?.name ?? "",
  date: milestone?.date ?? null,
})

export function MilestoneDialog({
  board,
  open,
  onOpenChange,
  actions,
  milestone,
  tasks,
  onSaved,
  onDeleted,
}: MilestoneDialogProps) {
  const confirm = useConfirm()
  const { state } = useStore()
  const [editing, setEditing] = React.useState<Editing>(null)
  const [busy, setBusy] = React.useState(false)

  /* Every open starts from the milestone it was opened on — reopening on
     another one must not carry the last one's name. */
  React.useEffect(() => {
    if (!open) return
    setEditing(milestone ? { id: milestone.id, draft: draftOf(milestone) } : null)
    setBusy(false)
  }, [open, milestone])

  const boardTasks = tasks ?? state.pmTasks[board.id] ?? EMPTY_TASKS
  const counts = React.useMemo(() => milestoneTaskCounts(boardTasks), [boardTasks])
  const milestones = React.useMemo(() => sortMilestones(board.milestones), [board.milestones])

  const setDraft = (patch: Partial<Draft>) =>
    setEditing((current) =>
      current === null ? current : { ...current, draft: { ...current.draft, ...patch } }
    )

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (editing === null || busy) return
    const name = editing.draft.name.trim()
    if (!name) return
    setBusy(true)
    const input: MilestoneInput = { name, date: editing.draft.date }
    try {
      const saved = editing.id
        ? await actions.patchMilestone(board.id, editing.id, input)
        : await actions.createMilestone(board.id, input)
      refreshAfterMilestoneChange(actions, board.id)
      toast.success(editing.id ? `${saved.name} updated` : `${saved.name} created`)
      setEditing(null)
      setBusy(false)
      onSaved?.(saved)
    } catch (err) {
      reportError(
        err,
        editing.id ? "Couldn't save the milestone" : "Couldn't create the milestone"
      )
      setBusy(false)
    }
  }

  const remove = React.useCallback(
    async (target: Milestone) => {
      const assigned = counts.get(target.id) ?? 0
      const ok = await confirm({
        title: `Delete ${target.name}?`,
        description:
          assigned === 0
            ? "The milestone is removed from the board."
            : `${assigned} ${assigned === 1 ? "task keeps" : "tasks keep"} their place on the board and lose this milestone.`,
        confirmLabel: "Delete milestone",
        destructive: true,
      })
      if (!ok) return
      setBusy(true)
      try {
        await actions.deleteMilestone(board.id, target.id)
        refreshAfterMilestoneChange(actions, board.id)
        toast.success(`${target.name} deleted`)
        setEditing((current) => (current?.id === target.id ? null : current))
        setBusy(false)
        onDeleted?.(target.id)
      } catch (err) {
        reportError(err, "Couldn't delete the milestone")
        setBusy(false)
      }
    },
    [actions, board.id, confirm, counts, onDeleted]
  )

  const toggleReached = React.useCallback(
    async (target: Milestone) => {
      const reached = target.reachedAt === null
      setBusy(true)
      try {
        const saved = await actions.reachMilestone(board.id, target.id, reached)
        refreshAfterMilestoneChange(actions, board.id)
        toast.success(reached ? `${saved.name} reached` : `${saved.name} reopened`)
        setBusy(false)
        onSaved?.(saved)
      } catch (err) {
        reportError(err, reached ? "Couldn't mark it reached" : "Couldn't reopen the milestone")
        setBusy(false)
      }
    },
    [actions, board.id, onSaved]
  )

  const edit = React.useCallback((target: Milestone) => {
    setEditing({ id: target.id, draft: draftOf(target) })
  }, [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Milestones</DialogTitle>
          <DialogDescription>
            Dates {board.name} is measured against. A task carries at most one.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
          {milestones.length === 0 && editing === null && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No milestones yet.
            </p>
          )}
          {milestones.map((row) => (
            <MilestoneRow
              key={row.id}
              milestone={row}
              taskCount={counts.get(row.id) ?? 0}
              busy={busy}
              editing={editing?.id === row.id}
              onEdit={edit}
              onToggleReached={toggleReached}
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
              New milestone
            </Button>
            <Button type="button" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </DialogFooter>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4 border-t border-border pt-4">
            <MilestoneField label="Name">
              <Input
                autoFocus
                required
                aria-label="Milestone name"
                value={editing.draft.name}
                onChange={(e) => setDraft({ name: e.target.value })}
                placeholder={`Milestone ${board.milestones.length + 1}`}
              />
            </MilestoneField>

            <MilestoneField label="Date" hint="Undated milestones sort last and show no marker.">
              <DateField
                label="date"
                value={editing.draft.date}
                onChange={(date) => setDraft({ date })}
              />
            </MilestoneField>

            <DialogFooter className="sm:justify-between">
              {editing.id ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    const target = board.milestones.find((m) => m.id === editing.id)
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
                <Button type="submit" disabled={busy || editing.draft.name.trim().length === 0}>
                  {editing.id ? "Save milestone" : "Create milestone"}
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

interface MilestoneRowProps {
  milestone: Milestone
  taskCount: number
  busy: boolean
  editing: boolean
  onEdit(milestone: Milestone): void
  onToggleReached(milestone: Milestone): void
  onDelete(milestone: Milestone): void
}

/** Memo'd on stable callbacks — a board with many milestones re-renders one row
    per keystroke in the form otherwise. */
const MilestoneRow = React.memo(function MilestoneRow({
  milestone,
  taskCount,
  busy,
  editing,
  onEdit,
  onToggleReached,
  onDelete,
}: MilestoneRowProps) {
  const reached = milestone.reachedAt !== null
  const date = milestoneDateLabel(milestone)
  const days = milestoneDaysLeft(milestone)

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border border-transparent px-2 py-1.5",
        editing ? "border-border bg-muted" : "hover:bg-muted/60"
      )}
    >
      <Flag
        aria-hidden
        className={cn("size-4 shrink-0", reached ? "text-primary" : "text-muted-foreground")}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{milestone.name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {date ?? "No date"}
          {date && !reached && days !== null && (
            <> · {days >= 0 ? `in ${days}d` : `${Math.abs(days)}d ago`}</>
          )}
          {" · "}
          {taskCount} {taskCount === 1 ? "task" : "tasks"}
        </span>
      </div>
      {reached && (
        <Badge variant="outline" className="border-transparent bg-primary/15 text-foreground">
          Reached
        </Badge>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={busy}
        title={reached ? "Reopen" : "Mark reached"}
        aria-label={reached ? `Reopen ${milestone.name}` : `Mark ${milestone.name} reached`}
        onClick={() => onToggleReached(milestone)}
      >
        {reached ? <RotateCcw /> : <Check />}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={busy}
        title="Edit"
        aria-label={`Edit ${milestone.name}`}
        onClick={() => onEdit(milestone)}
      >
        <Pencil />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={busy}
        title="Delete"
        aria-label={`Delete ${milestone.name}`}
        onClick={() => onDelete(milestone)}
      >
        <X />
      </Button>
    </div>
  )
})

// ---------------------------------------------------------------------------
// Bits

/** The date-picker idiom new-task-dialog established: a Popover over the shared
    Calendar with a ✕ that clears it back to null. */
function DateField({
  label,
  value,
  onChange,
}: {
  label: string
  value: number | null
  onChange(value: number | null): void
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Popover>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              className={cn(
                "min-w-0 flex-1 justify-start font-normal",
                value === null && "text-muted-foreground"
              )}
            >
              <CalendarIcon />
              <span className="truncate">
                {value === null ? `No ${label}` : format(new Date(value), "EEE d MMM yyyy")}
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
          aria-label={`Clear ${label}`}
          onClick={() => onChange(null)}
        >
          <X />
        </Button>
      )}
    </div>
  )
}

/** The PM dialogs' plain label/hint row — a <div>, not a <label>, because these
    wrap popover buttons that own their own clicks. */
function MilestoneField({
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
