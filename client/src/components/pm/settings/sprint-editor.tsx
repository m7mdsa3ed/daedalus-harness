import * as React from "react"
import { format } from "date-fns"
import { CalendarIcon, X } from "lucide-react"
import { toast } from "sonner"

import { useConfirm } from "@/components/confirm-dialog"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import type { Board, Sprint, SprintInput } from "@/lib/pm/types"
import { cn } from "@/lib/utils"

/* ── Sprint editor ──
   Create / edit / delete a sprint, plus the dialog the backlog's "Complete
   sprint" opens — the one place that asks the question the endpoint needs an
   answer to (`moveIncompleteTo`): whatever did not finish has to land
   somewhere, and silently dropping it back to the backlog is a decision, not a
   default.

   Dates use the same idiom as new-task-dialog: a Popover over the shared
   Calendar, cleared by a small ✕, epoch-ms on the wire. */

// ---------------------------------------------------------------------------
// Actions contract
//
// The five sprint mutators live in lib/actions.ts alongside the rest of PM.
// `SprintActions` names the slice of `Actions` this file and the backlog view
// need, and `sprintApi` is the (structural) narrowing to it — so a rename in
// actions.ts fails here at compile time rather than at the first click.

export interface SprintActions {
  /** POST /api/boards/:id/sprints */
  createSprint(boardId: string, input: SprintInput): Promise<Sprint>
  /** PATCH /api/boards/:id/sprints/:sprintId */
  patchSprint(boardId: string, sprintId: string, patch: Partial<SprintInput>): Promise<Sprint>
  /** DELETE /api/boards/:id/sprints/:sprintId */
  deleteSprint(boardId: string, sprintId: string): Promise<void>
  /** POST .../start — the server enforces one active sprint per board. */
  startSprint(boardId: string, sprintId: string): Promise<Sprint>
  /** POST .../complete — `moveIncompleteTo` is a sprint id, or null/undefined
      for the backlog. */
  completeSprint(
    boardId: string,
    sprintId: string,
    moveIncompleteTo?: string | null
  ): Promise<Sprint>
}

export function sprintApi(actions: Actions): SprintActions {
  return actions
}

/** Board + task cache both change when a sprint does (complete moves tasks), so
    every flow here ends the same way. Fire-and-forget: a refresh that fails is
    the next focus refetch's problem, not an error the user must dismiss. */
export function refreshAfterSprintChange(actions: Actions, boardId: string): void {
  void actions.loadBoard(boardId).catch(() => {})
  void actions.loadBoardTasks(boardId, { force: true }).catch(() => {})
}

// ---------------------------------------------------------------------------
// Presentation helpers (shared with the backlog lanes)

/** "3 Mar – 17 Mar", one date, or null when the sprint has no dates at all. */
export function sprintDateRange(sprint: Sprint): string | null {
  const start = sprint.startDate === null ? null : format(sprint.startDate, "d MMM")
  const end = sprint.endDate === null ? null : format(sprint.endDate, "d MMM")
  if (start && end) return `${start} – ${end}`
  return start ?? end ?? null
}

/** Whole days left before `endDate`; negative once it is past. */
export function sprintDaysLeft(sprint: Sprint, now = Date.now()): number | null {
  if (sprint.endDate === null) return null
  return Math.ceil((sprint.endDate - now) / 86_400_000)
}

const BACKLOG_TARGET = "__backlog__"

// ---------------------------------------------------------------------------
// Create / edit

export interface SprintDialogProps {
  board: Board
  open: boolean
  onOpenChange(open: boolean): void
  /** Absent = create. Present = edit that sprint (and offer Delete). */
  sprint?: Sprint | null
  actions: Actions
  onSaved?(sprint: Sprint): void
  /** Called after a delete goes through — the caller drops its selection. */
  onDeleted?(sprintId: string): void
}

interface Draft {
  name: string
  goal: string
  startDate: number | null
  endDate: number | null
}

function draftOf(sprint?: Sprint | null): Draft {
  return {
    name: sprint?.name ?? "",
    goal: sprint?.goal ?? "",
    startDate: sprint?.startDate ?? null,
    endDate: sprint?.endDate ?? null,
  }
}

export function SprintDialog({
  board,
  open,
  onOpenChange,
  sprint,
  actions,
  onSaved,
  onDeleted,
}: SprintDialogProps) {
  const confirm = useConfirm()
  const [draft, setDraft] = React.useState<Draft>(() => draftOf(sprint))
  const [busy, setBusy] = React.useState(false)
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))

  /* Every open starts from the sprint being edited — reopening on a different
     sprint must not carry the last one's goal. */
  React.useEffect(() => {
    if (!open) return
    setDraft(draftOf(sprint))
    setBusy(false)
  }, [open, sprint])

  const editing = !!sprint
  const invalid =
    draft.startDate !== null && draft.endDate !== null && draft.endDate < draft.startDate

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const name = draft.name.trim()
    if (!name || busy || invalid) return
    setBusy(true)
    const input: SprintInput = {
      name,
      goal: draft.goal.trim() || null,
      startDate: draft.startDate,
      endDate: draft.endDate,
    }
    const api = sprintApi(actions)
    try {
      const saved = editing
        ? await api.patchSprint(board.id, sprint!.id, input)
        : await api.createSprint(board.id, input)
      refreshAfterSprintChange(actions, board.id)
      toast.success(editing ? `${saved.name} updated` : `${saved.name} created`)
      onOpenChange(false)
      onSaved?.(saved)
    } catch (err) {
      reportError(err, editing ? "Couldn't save the sprint" : "Couldn't create the sprint")
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!sprint || busy) return
    const ok = await confirm({
      title: `Delete ${sprint.name}?`,
      description:
        "The sprint is removed; its tasks stay on the board and fall back to the backlog.",
      confirmLabel: "Delete sprint",
      destructive: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      await sprintApi(actions).deleteSprint(board.id, sprint.id)
      refreshAfterSprintChange(actions, board.id)
      toast.success(`${sprint.name} deleted`)
      onOpenChange(false)
      onDeleted?.(sprint.id)
    } catch (err) {
      reportError(err, "Couldn't delete the sprint")
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit sprint" : "New sprint"}</DialogTitle>
            <DialogDescription>
              {editing ? `${sprint!.name} · ${board.name}` : `In ${board.name}`}
            </DialogDescription>
          </DialogHeader>

          <SprintField label="Name">
            <Input
              autoFocus
              required
              aria-label="Sprint name"
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder={`Sprint ${board.sprints.length + 1}`}
            />
          </SprintField>

          <SprintField label="Goal" hint="One sentence the team can hold the sprint against.">
            <Textarea
              aria-label="Sprint goal"
              rows={2}
              value={draft.goal}
              onChange={(e) => set({ goal: e.target.value })}
              placeholder="What this sprint is for"
            />
          </SprintField>

          <div className="grid gap-4 sm:grid-cols-2">
            <SprintField label="Start">
              <DateField
                label="start date"
                value={draft.startDate}
                onChange={(startDate) => set({ startDate })}
              />
            </SprintField>
            <SprintField label="End">
              <DateField
                label="end date"
                value={draft.endDate}
                onChange={(endDate) => set({ endDate })}
              />
            </SprintField>
          </div>
          {invalid && (
            <p className="text-xs text-destructive">The end date is before the start date.</p>
          )}

          <DialogFooter className="sm:justify-between">
            {editing ? (
              <Button type="button" variant="ghost" disabled={busy} onClick={remove}>
                Delete
              </Button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || invalid || draft.name.trim().length === 0}>
                {editing ? "Save sprint" : "Create sprint"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Complete

export interface CompleteSprintDialogProps {
  board: Board
  open: boolean
  onOpenChange(open: boolean): void
  sprint: Sprint
  /** Tasks of the sprint that are not done — what the target selector moves. */
  incomplete: number
  /** Points still open, for the sentence above the selector. */
  incompletePoints?: number
  actions: Actions
  onCompleted?(sprint: Sprint): void
}

export function CompleteSprintDialog({
  board,
  open,
  onOpenChange,
  sprint,
  incomplete,
  incompletePoints,
  actions,
  onCompleted,
}: CompleteSprintDialogProps) {
  /* Only a planned sprint can take the leftovers: an active one is the sprint
     being closed and a completed one is history. */
  const targets = React.useMemo(
    () =>
      board.sprints.filter((other) => other.id !== sprint.id && other.state === "planned"),
    [board.sprints, sprint.id]
  )
  const [target, setTarget] = React.useState<string>(BACKLOG_TARGET)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setTarget(BACKLOG_TARGET)
    setBusy(false)
  }, [open, sprint.id])

  const complete = async () => {
    if (busy) return
    setBusy(true)
    try {
      const done = await sprintApi(actions).completeSprint(
        board.id,
        sprint.id,
        target === BACKLOG_TARGET ? null : target
      )
      refreshAfterSprintChange(actions, board.id)
      toast.success(`${sprint.name} completed`)
      onOpenChange(false)
      onCompleted?.(done)
    } catch (err) {
      reportError(err, "Couldn't complete the sprint")
      setBusy(false)
    }
  }

  const targetName =
    target === BACKLOG_TARGET
      ? "Backlog"
      : targets.find((other) => other.id === target)?.name ?? "Backlog"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Complete {sprint.name}</DialogTitle>
          <DialogDescription>
            The sprint's committed and completed totals are frozen for velocity, and it stops
            being the active sprint.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            {incomplete === 0 ? (
              "Everything in this sprint is done."
            ) : (
              <>
                {incomplete} unfinished {incomplete === 1 ? "task" : "tasks"}
                {incompletePoints ? ` (${incompletePoints} pts)` : ""} move to:
              </>
            )}
          </p>

          {incomplete > 0 && (
            <Select value={target} onValueChange={(value) => setTarget(String(value ?? BACKLOG_TARGET))}>
              <SelectTrigger className="w-full">
                <SelectValue>{targetName}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={BACKLOG_TARGET}>Backlog</SelectItem>
                {targets.map((other) => (
                  <SelectItem key={other.id} value={other.id}>
                    {other.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={complete} disabled={busy}>
            Complete sprint
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

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
    wrap popover buttons and selects that own their own clicks. */
function SprintField({
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
