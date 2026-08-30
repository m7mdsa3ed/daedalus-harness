/* ── /schedules — the scheduled-messages surface ──
   One component, two faces: /schedules lists every schedule the server holds
   (pause/resume, inline edit, delete, and the skip state the sweep stamps on
   an undeliverable row), /schedules/new is the creation form it always was.
   The rows are raw server rows out of the store (`state.scheduled`); every
   mutation goes through actions, which re-fetch the list after. */
import * as React from "react"
import {
  AlertTriangle,
  CalendarClock,
  ClockIcon,
  Pause,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react"
import { useLocation, useNavigate, useSearchParams } from "react-router"
import { toast } from "sonner"

import { useConfirm } from "@/components/confirm-dialog"
import { EmptyCard, Field, FormPageHeader, FormSection, Group, PageForm } from "@/components/settings/primitives"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import type { Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import { schedulePath, schedulesPath } from "@/lib/router"
import {
  DAY,
  HOUR,
  MINUTE,
  WEEK,
  everyLabel,
  scheduleParked,
  scheduleSkipped,
  scheduleWhen,
} from "@/lib/schedule"
import type { ScheduledMessage } from "@/lib/settings"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

function minNextAt(): number {
  return Date.now() + MINUTE
}

function toLocalInput(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

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
  week: WEEK,
}

interface ScheduleLocationState {
  defaultText?: string
  returnTo?: string
}

/** Route element for /schedules and /schedules/new — the path picks the face. */
export function SchedulePage({ actions }: { actions: Actions }) {
  const location = useLocation()
  return location.pathname.endsWith("/new") ? (
    <NewSchedulePage actions={actions} />
  ) : (
    <SchedulesListPage actions={actions} />
  )
}

/* ── The list ── */

function SchedulesListPage({ actions }: { actions: Actions }) {
  const { state } = useStore()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const [editingId, setEditingId] = React.useState<string | null>(null)

  const titleOf = (sessionId: string) =>
    state.sessions.find((s) => s.id === sessionId)?.title || "Unknown thread"

  const remove = async (id: string) => {
    if (
      !(await confirm({
        title: "Cancel this scheduled message?",
        destructive: true,
        confirmLabel: "Cancel schedule",
      }))
    )
      return
    actions.cancelSchedule(id).catch((err) => reportError(err, "Couldn't cancel the schedule"))
  }

  const newSchedule = () => void navigate(schedulePath(), { state: { returnTo: schedulesPath() } })

  return (
    <>
      <FormPageHeader
        title="Scheduled messages"
        description="Prompts the server delivers to a thread's agent at a set time — with or without a browser open. Pause a schedule to keep it without it firing."
        onBack={() => void navigate("/")}
      />
      {state.scheduled.length === 0 ? (
        <EmptyCard
          icon={CalendarClock}
          text="Nothing scheduled yet."
          action={
            <Button size="sm" onClick={newSchedule}>
              <Plus data-icon="inline-start" />
              New schedule
            </Button>
          }
        />
      ) : (
        <>
          <div className="mb-4 flex justify-end">
            <Button size="sm" variant="outline" onClick={newSchedule}>
              <Plus data-icon="inline-start" />
              New schedule
            </Button>
          </div>
          <Group>
            {state.scheduled.map((item) => (
              <ScheduleRow
                key={item.id}
                item={item}
                threadTitle={titleOf(item.sessionId)}
                actions={actions}
                editing={editingId === item.id}
                onEdit={() => setEditingId(editingId === item.id ? null : item.id)}
                onDelete={() => void remove(item.id)}
              />
            ))}
          </Group>
        </>
      )}
    </>
  )
}

function ScheduleRow({
  item,
  threadTitle,
  actions,
  editing,
  onEdit,
  onDelete,
}: {
  item: ScheduledMessage
  threadTitle: string
  actions: Actions
  editing: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const paused = item.enabled === 0
  const skipped = scheduleSkipped(item)
  const parked = scheduleParked(item)

  const setEnabled = (enabled: boolean) => {
    actions
      .updateSchedule(item.id, { enabled })
      .then(() => toast.success(enabled ? "Schedule resumed" : "Schedule paused"))
      .catch((err) => reportError(err, "Couldn't update the schedule"))
  }

  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:flex-nowrap">
        {paused ? (
          <Pause className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <CalendarClock className="size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className={cn("truncate text-sm font-medium", paused && "text-muted-foreground")}>
            {item.text}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {threadTitle} · {scheduleWhen(item.nextAt, item.everyMs)}
            {paused && " · paused"}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Switch
            checked={!paused}
            onCheckedChange={(checked) => setEnabled(checked)}
            aria-label={paused ? "Resume schedule" : "Pause schedule"}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-pressed={editing}
            title="Edit schedule"
            onClick={onEdit}
          >
            <Pencil />
            <span className="sr-only">Edit schedule</span>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive"
            title="Cancel schedule"
            onClick={onDelete}
          >
            <Trash2 />
            <span className="sr-only">Cancel schedule</span>
          </Button>
        </div>
      </div>
      {skipped && (
        <div className="mt-2 flex flex-wrap items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 sm:flex-nowrap dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p>
              {parked
                ? `Parked after ${item.skipCount} failed deliveries — the server has stopped retrying.`
                : `Couldn't deliver${item.skipCount > 1 ? ` (${item.skipCount} attempts)` : ""}.`}
              {item.lastError && ` Last error: ${item.lastError}.`}
            </p>
            {item.skippedAt !== null && (
              <p className="mt-0.5 opacity-80">
                Last attempt{" "}
                {new Date(item.skippedAt).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
            )}
          </div>
          {/* Any patch resets the skip state server-side, so "Resume" is one
              enabled:true — it also un-parks a row past the skip cap. */}
          <Button size="xs" variant="outline" className="shrink-0" onClick={() => setEnabled(true)}>
            Resume
          </Button>
        </div>
      )}
      {editing && <EditScheduleForm item={item} actions={actions} onDone={onEdit} />}
    </div>
  )
}

/** Inline editor under a row: text, time, recurrence. The target thread is not
    editable (the server has no patch for it — cancel and reschedule instead). */
function EditScheduleForm({
  item,
  actions,
  onDone,
}: {
  item: ScheduledMessage
  actions: Actions
  onDone: () => void
}) {
  type EditRecurrence = Recurrence | "custom"
  const initialRecurrence: EditRecurrence =
    item.everyMs === null
      ? "once"
      : item.everyMs === HOUR
        ? "hour"
        : item.everyMs === DAY
          ? "day"
          : item.everyMs === WEEK
            ? "week"
            : "custom"

  const [text, setText] = React.useState(item.text)
  const [at, setAt] = React.useState(() => toLocalInput(item.nextAt))
  const [recurrence, setRecurrence] = React.useState<EditRecurrence>(initialRecurrence)
  const [busy, setBusy] = React.useState(false)

  const nextAt = fromLocalInput(at)
  const valid = text.trim().length > 0 && nextAt > 0

  const recurrenceLabel = (value: EditRecurrence) =>
    value === "custom" ? `Every ${everyLabel(item.everyMs ?? 0)} (current)` : RECURRENCE_LABEL[value]

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    try {
      await actions.updateSchedule(item.id, {
        text: text.trim(),
        nextAt,
        everyMs: recurrence === "custom" ? item.everyMs : (RECURRENCE_MS[recurrence] ?? null),
      })
      toast.success("Schedule updated")
      onDone()
    } catch (error) {
      reportError(error, "Couldn't update the schedule")
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-3 rounded-lg border bg-muted/30 p-3">
      <Field label="Message to send">
        <Textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Next run">
          <Input type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} />
        </Field>
        <Field label="Repeat">
          <Select
            value={recurrence}
            onValueChange={(value) => setRecurrence(value as EditRecurrence)}
          >
            <SelectTrigger className="w-full">
              <SelectValue>{recurrenceLabel(recurrence)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(RECURRENCE_LABEL) as Recurrence[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {RECURRENCE_LABEL[key]}
                </SelectItem>
              ))}
              {initialRecurrence === "custom" && (
                <SelectItem value="custom">{recurrenceLabel("custom")}</SelectItem>
              )}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy || !valid}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  )
}

/* ── Creation (/schedules/new) — unchanged flow ── */

function NewSchedulePage({ actions }: { actions: Actions }) {
  const { state } = useStore()
  const navigate = useNavigate()
  const location = useLocation()
  const [params] = useSearchParams()
  const routeState = (location.state ?? {}) as ScheduleLocationState
  const sessions = state.sessions.filter((session) => !session.draft && !session.deletedAt)
  const requested = params.get("session")
  const initialTarget = sessions.some((session) => session.id === requested)
    ? (requested ?? "")
    : (sessions[0]?.id ?? "")

  const [text, setText] = React.useState(routeState.defaultText ?? "")
  const [at, setAt] = React.useState(() => toLocalInput(minNextAt()))
  const [recurrence, setRecurrence] = React.useState<Recurrence>("once")
  const [target, setTarget] = React.useState(initialTarget)
  const [busy, setBusy] = React.useState(false)

  const back = () => void navigate(routeState.returnTo ?? schedulesPath())
  const nextAt = fromLocalInput(at)
  const valid = target.length > 0 && text.trim().length > 0 && nextAt >= minNextAt()

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
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
      back()
    } catch (error) {
      reportError(error, "Couldn't schedule the message")
      setBusy(false)
    }
  }

  return (
    <>
      <FormPageHeader
        title="Schedule a message"
        description="The server sends this to the selected thread even when no browser tab is open. Recurring messages continue until cancelled."
        onBack={back}
      />
      {sessions.length === 0 ? (
        <EmptyCard icon={CalendarClock} text="Open and send a thread before scheduling a message." />
      ) : (
        <PageForm onSubmit={submit}>
          <FormSection label="Thread">
            <Field label="Send to">
              <Select value={target} onValueChange={(value) => setTarget(value ?? target)}>
                <SelectTrigger className="w-full">
                  <SelectValue>{sessions.find((session) => session.id === target)?.title ?? "Select a thread"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {sessions.map((session) => (
                    <SelectItem key={session.id} value={session.id}>
                      {session.title || "Untitled thread"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </FormSection>
          <FormSection label="Message">
            <Field label="Message to send">
              <Textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows={5}
                placeholder="What should the agent do?"
              />
            </Field>
          </FormSection>
          <FormSection label="When">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Start at">
                <Input
                  type="datetime-local"
                  value={at}
                  min={toLocalInput(minNextAt())}
                  onChange={(event) => setAt(event.target.value)}
                />
              </Field>
              <Field label="Repeat">
                <Select value={recurrence} onValueChange={(value) => setRecurrence(value as Recurrence)}>
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
            </div>
          </FormSection>
          <p className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
            <ClockIcon className="size-3" />
            {recurrence === "once"
              ? "This fires once, then the schedule is removed."
              : `Repeats ${RECURRENCE_LABEL[recurrence].toLowerCase()} until you cancel it.`}
          </p>
          <footer className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={back}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !valid}>
              {busy ? "Scheduling…" : "Schedule"}
            </Button>
          </footer>
        </PageForm>
      )}
    </>
  )
}
