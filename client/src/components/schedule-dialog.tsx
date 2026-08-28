import * as React from "react"
import { ClockIcon } from "lucide-react"
import { toast } from "sonner"
import { reportError } from "@/lib/errors"
import type { Actions } from "@/lib/actions"
import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
} from "@/components/ui/responsive-dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Field, FormSection } from "@/components/settings/primitives"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Epoch ms for "now". The relative offsets below are applied to this base, and
    a date chosen in the past is rejected server-side by no one — so clamping to
    the future is ours. */
function minNextAt(): number {
  return Date.now() + MINUTE
}

/** A `datetime-local` value ("YYYY-MM-DDTHH:mm"), or "" when unset. */
function toLocalInput(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Parse a `datetime-local` value to epoch ms; the browser sends it as *local*
    time, so Date is constructed as local, not UTC. */
function fromLocalInput(value: string): number {
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? 0 : d.getTime()
}

type Recurrence = "once" | "hour" | "day" | "week"

const RECURRENCE_LABEL: Record<Recurrence, string> = {
  once: "Once",
  hour: "Every hour",
  day: "Every day",
  week: "Every week",
}

const RECURRENCE_MS: Partial<Record<Recurrence, number>> = {
  hour: HOUR,
  day: DAY,
  week: 7 * DAY,
}

export function ScheduleDialog({
  open,
  onOpenChange,
  sessionId,
  actions,
  defaultText,
  sessions,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string
  actions: Actions
  /** Pre-fill the message (the composer's current draft). */
  defaultText?: string
  /** When set, offer a thread picker — the standalone (settings) use. Omit to
      schedule into the thread the dialog was opened from. */
  sessions?: { id: string; title: string }[]
  onDone?: () => void
}) {
  const [text, setText] = React.useState(defaultText ?? "")
  const [at, setAt] = React.useState(() => toLocalInput(minNextAt()))
  const [recurrence, setRecurrence] = React.useState<Recurrence>("once")
  const [target, setTarget] = React.useState(sessionId)
  const [busy, setBusy] = React.useState(false)

  // Re-seed when opened: the composer draft is the intended message, and the
  // fire time should default to a minute out rather than the last time the
  // dialog was used. The target thread resets to the one this dialog was
  // opened for (the "New schedule" button's first thread).
  React.useEffect(() => {
    if (open) {
      setText(defaultText ?? "")
      setAt(toLocalInput(minNextAt()))
      setRecurrence("once")
      setTarget(sessionId)
      setBusy(false)
    }
  }, [open, defaultText, sessionId])

  const nextAt = fromLocalInput(at)
  const valid = text.trim().length > 0 && nextAt > 0 && nextAt >= minNextAt()

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!valid) return
    setBusy(true)
    try {
      await actions.createSchedule({
        sessionId: target,
        text: text.trim(),
        nextAt,
        everyMs: RECURRENCE_MS[recurrence] ?? null,
      })
      toast.success(recurrence === "once" ? "Message scheduled" : "Recurring message scheduled")
      onOpenChange(false)
      onDone?.()
    } catch (error) {
      reportError(error, "Couldn't schedule the message")
      setBusy(false)
    }
  }

  /* The fire time is a datetime-local input, rounded to 15 minutes for the
     default so the picker is scrolled to a sensible spot. */
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-lg">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Schedule a message</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            The server sends this to the thread's agent at the time you pick — even if
            no browser tab is open. Recurring messages repeat until cancelled.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {sessions && sessions.length > 0 && (
            <FormSection label="Thread">
              <Field label="Send to">
                {/* Base UI hands back `string | null` — null is "cleared",
                    which this Select cannot be (there is always a thread to
                    send to). Coalescing keeps the state a plain string rather
                    than spreading the null through every reader of `target`. */}
                <Select value={target} onValueChange={(value) => setTarget(value ?? target)}>
                  <SelectTrigger className="w-full">
                    <SelectValue>{sessions.find((s) => s.id === target)?.title ?? "Select a thread"}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {sessions.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.title || "Untitled thread"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </FormSection>
          )}
          <FormSection label="Message">
            <Field label="Message to send">
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                placeholder="What should the agent do?"
              />
            </Field>
          </FormSection>
          <FormSection label="When">
            <Field label="Start at">
              <Input
                type="datetime-local"
                value={at}
                min={toLocalInput(minNextAt())}
                onChange={(e) => setAt(e.target.value)}
              />
            </Field>
            <Field label="Repeat">
              <Select
                value={recurrence}
                onValueChange={(value) => setRecurrence(value as Recurrence)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>{RECURRENCE_LABEL[recurrence]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(RECURRENCE_LABEL) as Recurrence[]).map((key) => (
                    <SelectItem key={key} value={key}>
                      {RECURRENCE_LABEL[key]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </FormSection>
          <p className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
            <ClockIcon className="size-3" />
            {recurrence === "once"
              ? "This fires once, then the schedule is removed."
              : `Repeats ${RECURRENCE_LABEL[recurrence].toLowerCase()} until you cancel it here.`}
          </p>
          <ResponsiveDialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !valid}>
              {busy ? "Scheduling…" : "Schedule"}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
