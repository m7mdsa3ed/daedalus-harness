import * as React from "react"
import { Repeat, Sprout } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { usePmActions } from "@/components/pm/pm-sidebar-panels"
import type { Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import type { Recurrence, Task } from "@/lib/pm/types"
import { cn } from "@/lib/utils"

/* ── Recurrence ──
   The server's recurrence is exactly two fields — `{ freq, interval }` (see
   RecurrenceSchema in server/src/pm/schema.ts) — and exactly one behaviour:
   completing a recurring task clones it, with every date advanced by
   `interval × freq`, checklist ticks reset and comments/activity left behind
   (`spawnRecurrence` in server/src/pm/tasks.ts). Nothing schedules anything.

   So this control offers those two fields and nothing more. No weekday picks,
   no "ends after N", no cron: the schema has no room for them and a UI that
   promised them would be lying about what the board does. The one thing worth
   spelling out instead is the trigger, which is not the calendar — hence the
   summary line and the note under it.

   `describeRecurrence` is the pure half, for cards and rows that want the
   label without the popover. */

const FREQ_LABELS: Record<Recurrence["freq"], [one: string, many: string]> = {
  daily: ["day", "days"],
  weekly: ["week", "weeks"],
  monthly: ["month", "months"],
  yearly: ["year", "years"],
}

const FREQS = Object.keys(FREQ_LABELS) as Recurrence["freq"][]

/** Select's "no recurrence" option — a sentinel, because `null` is not a value
    a Select item can carry. */
const OFF = "__off__"

/** "week" / "weeks", agreeing with the interval beside it. */
const unitLabel = (freq: Recurrence["freq"], interval: number): string =>
  FREQ_LABELS[freq][interval === 1 ? 0 : 1]

/** Clamp what the server would reject: `interval` is an int ≥ 1. The upper
    bound is ours — 999 of anything is a typo, not a schedule. */
const clampInterval = (value: number): number =>
  Number.isFinite(value) ? Math.min(999, Math.max(1, Math.trunc(value))) : 1

/** "Every 2 weeks" / "Every day" — the chip label. `null` reads as "" so a
    card can render `{describeRecurrence(task.recurrence)}` unguarded. */
export function describeRecurrence(recurrence: Recurrence | null | undefined): string {
  if (!recurrence) return ""
  const interval = clampInterval(recurrence.interval)
  const [one, many] = FREQ_LABELS[recurrence.freq] ?? FREQ_LABELS.daily
  return interval === 1 ? `Every ${one}` : `Every ${interval} ${many}`
}

/** The full sentence the editor shows: what repeats, and — the part that is
    not obvious — that the repeat is triggered by completing this task. */
export function recurrenceSummary(recurrence: Recurrence | null | undefined): string {
  if (!recurrence) return "This task does not repeat."
  const interval = clampInterval(recurrence.interval)
  const [one, many] = FREQ_LABELS[recurrence.freq] ?? FREQ_LABELS.daily
  const every = interval === 1 ? one : `${interval} ${many}`
  return `Repeats every ${every}; a new task is created when this one is completed, with its dates moved on by ${every}.`
}

// ---------------------------------------------------------------------------
// Presentation

export interface RecurrenceBadgeProps {
  recurrence: Recurrence | null | undefined
  className?: string
}

/** The pill a card or table row shows for a recurring task. Pure and memo'd —
    a 500-row list renders one per row and pays nothing for it. */
export const RecurrenceBadge = React.memo(function RecurrenceBadge({
  recurrence,
  className,
}: RecurrenceBadgeProps) {
  if (!recurrence) return null
  return (
    <Badge
      variant="outline"
      className={cn("border-border bg-muted text-muted-foreground", className)}
      title={recurrenceSummary(recurrence)}
    >
      <Repeat aria-hidden />
      {describeRecurrence(recurrence)}
    </Badge>
  )
})

export interface RecurrenceOriginNoteProps {
  task: Pick<Task, "recurrenceParentId">
  /** Open the task this one was spawned from, when the caller can. */
  onOpenParent?: (taskId: string) => void
  className?: string
}

/** The provenance line: a task carrying `recurrenceParentId` was not typed by
    anyone, it was spawned when its predecessor was completed. Renders nothing
    for an ordinary task. */
export function RecurrenceOriginNote({
  task,
  onOpenParent,
  className,
}: RecurrenceOriginNoteProps) {
  const parentId = task.recurrenceParentId
  if (!parentId) return null
  return (
    <p className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", className)}>
      <Sprout aria-hidden className="size-3.5 shrink-0" />
      <span>Created by a repeating task</span>
      {onOpenParent && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          onClick={() => onOpenParent(parentId)}
        >
          Open the original
        </Button>
      )}
    </p>
  )
}

// ---------------------------------------------------------------------------
// Editor

export interface RecurrenceEditorProps {
  task: Task
  /** A caller that already holds Actions passes them; otherwise the control
      builds its own the way every router-rendered PM component does. */
  actions?: Actions
  /** The saved task, so a parent can reconcile without a refetch. */
  onSaved?: (task: Task) => void
  onOpenParent?: (taskId: string) => void
  disabled?: boolean
  className?: string
}

/**
 * The task editor's Repeat row: a trigger showing the current setting, and a
 * popover holding the whole of what the server implements — off, or every N
 * days/weeks/months/years — with the summary line and the spawn-on-completion
 * note. Saves through `patchTask({ recurrence })`, one PATCH per Save rather
 * than one per keystroke in the interval box.
 */
export function RecurrenceEditor({
  task,
  actions: passed,
  onSaved,
  onOpenParent,
  disabled = false,
  className,
}: RecurrenceEditorProps) {
  const own = usePmActions()
  const actions = passed ?? own
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  /* `null` in the draft is the "off" option, so the popover can hold a
     freq/interval the task does not have yet without saving it. */
  const [draft, setDraft] = React.useState<Recurrence | null>(task.recurrence)

  /* Every open starts from the task as it is now — an abandoned edit must not
     survive to the next open, and another client's change wins. */
  React.useEffect(() => {
    if (!open) return
    setDraft(task.recurrence)
    setBusy(false)
  }, [open, task.recurrence])

  const save = async (next: Recurrence | null) => {
    if (busy) return
    setBusy(true)
    try {
      const saved = await actions.patchTask(task.boardId, task.id, { recurrence: next })
      toast.success(next ? `${task.key} repeats ${describeRecurrence(next).toLowerCase()}` : `${task.key} no longer repeats`)
      setOpen(false)
      setBusy(false)
      onSaved?.(saved)
    } catch (err) {
      reportError(err, "Couldn't save the repeat")
      setBusy(false)
    }
  }

  const current = task.recurrence

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              className={cn(
                "w-full justify-start font-normal",
                current === null && "text-muted-foreground"
              )}
            >
              <Repeat />
              <span className="truncate">
                {current === null ? "Does not repeat" : describeRecurrence(current)}
              </span>
            </Button>
          }
        />
        <PopoverContent align="start" className="w-80 p-3">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              {draft !== null && (
                <>
                  <span className="text-sm text-muted-foreground">Every</span>
                  <Input
                    type="number"
                    min={1}
                    max={999}
                    step={1}
                    aria-label="Repeat interval"
                    className="w-16"
                    value={draft.interval}
                    onChange={(event) =>
                      setDraft((d) =>
                        d === null
                          ? d
                          : { ...d, interval: clampInterval(event.target.valueAsNumber) }
                      )
                    }
                  />
                </>
              )}
              <Select
                value={draft === null ? OFF : draft.freq}
                onValueChange={(value) =>
                  setDraft(
                    value === OFF
                      ? null
                      : { freq: value as Recurrence["freq"], interval: draft?.interval ?? 1 }
                  )
                }
              >
                <SelectTrigger className="flex-1" aria-label="Repeat frequency">
                  <SelectValue>
                    {draft === null ? "Does not repeat" : unitLabel(draft.freq, draft.interval)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={OFF}>Does not repeat</SelectItem>
                  {FREQS.map((freq) => (
                    <SelectItem key={freq} value={freq}>
                      {unitLabel(freq, draft?.interval ?? 1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <p className="text-xs text-muted-foreground">{recurrenceSummary(draft)}</p>
            {draft !== null && (
              <p className="rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
                Nothing is scheduled: the next task appears only when this one is moved into a
                done column. Its checklists start unticked; comments and history stay here.
              </p>
            )}

            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => void save(draft === null ? null : { ...draft, interval: clampInterval(draft.interval) })}
              >
                Save
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <RecurrenceOriginNote task={task} onOpenParent={onOpenParent} />
    </div>
  )
}
