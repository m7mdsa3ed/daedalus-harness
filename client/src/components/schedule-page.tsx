import * as React from "react"
import { CalendarClock, ClockIcon } from "lucide-react"
import { useLocation, useNavigate, useSearchParams } from "react-router"
import { toast } from "sonner"

import { EmptyCard, Field, FormPageHeader, FormSection, PageForm } from "@/components/settings/primitives"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
import { threadPath } from "@/lib/router"
import { useStore } from "@/lib/store"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

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
  week: 7 * DAY,
}

interface ScheduleLocationState {
  defaultText?: string
  returnTo?: string
}

export function SchedulePage({ actions }: { actions: Actions }) {
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

  const back = () => void navigate(routeState.returnTo ?? (target ? threadPath(target) : "/"))
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
