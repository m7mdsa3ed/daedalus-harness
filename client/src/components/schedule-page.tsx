/* ── /schedules — the scheduled-messages surface ──
   One component, three faces: /schedules lists every schedule the server holds
   (pause/resume, delete, and the skip state the sweep stamps on an
   undeliverable row), /schedules/<id> is one schedule — what it says, where it
   lands, when it fires next, and the form that changes any of those — and
   /schedules/new is the creation form it always was. The rows are the server's
   own (`useScheduled`); every mutation invalidates the list, which is the
   refresh.

   A schedule keeps no history of its own: a delivered message is a turn in
   the thread it was sent to, and that transcript is the record. So the detail
   page has no runs list — it has the thread, one click away. */
import * as React from "react"
import {
  AlertTriangle,
  CalendarClock,
  ChevronRightIcon,
  ClockIcon,
  ExternalLinkIcon,
  MessageSquareTextIcon,
  MoreVerticalIcon,
  Pause,
  Pencil,
  Play,
  Plus,
  RepeatIcon,
  Trash2,
} from "lucide-react"
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router"
import { toast } from "@/lib/toast"

import { useConfirm } from "@/components/confirm-dialog"
import { AgentIcon, ProjectIcon } from "@/components/entity-icon"
import { MetaFact, StatGrid, StatTile, SurfaceCard, SurfaceHeader } from "@/components/page-primitives"
import { EmptyCard, Field, FormPageHeader, FormSection, PageForm } from "@/components/settings/primitives"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import type { Actions } from "@/lib/actions"
import { ErrorNote } from "@/components/error-note"
import { captureError, reportError, type InlineError } from "@/lib/errors"
import { scheduleDetailPath, schedulePath, schedulesPath, threadPath } from "@/lib/router"
import {
  DAY,
  HOUR,
  MAX_SCHEDULE_SKIPS,
  MINUTE,
  WEEK,
  everyLabel,
  scheduleParked,
  scheduleSkipped,
  scheduleWhen,
} from "@/lib/schedule"
import { isTopLevel, type ScheduledMessage, type SessionMeta } from "@/lib/settings"
import { useAgents, useProjects } from "@/lib/queries/catalog"
import { useCancelSchedule, useScheduled, useUpdateSchedule } from "@/lib/queries/routines"
import { untilLabel } from "@/components/routines/trigger-summary"
import { useStoreSelect } from "@/lib/store"
import { shortAge } from "@/lib/time"
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

/** Route element for /schedules, /schedules/new and /schedules/<id> — the
    path picks the face. */
export function SchedulePage({ actions }: { actions: Actions }) {
  const location = useLocation()
  const params = useParams()
  if (location.pathname.endsWith("/new")) return <NewSchedulePage actions={actions} />
  if (params.scheduleId) return <ScheduleDetailPage key={params.scheduleId} scheduleId={params.scheduleId} />
  return <SchedulesListPage />
}

/* ── Shared readings ── */

/** Pause, resume — and un-park, since any patch resets the skip state
    server-side, so "Resume" on a parked schedule is just `enabled: true`. */
function useSetEnabled() {
  const updateSchedule = useUpdateSchedule()
  return React.useCallback(
    (item: ScheduledMessage, enabled: boolean) =>
      updateSchedule.mutate(
        { id: item.id, patch: { enabled } },
        {
          onSuccess: () => toast.success(enabled ? "Schedule resumed" : "Schedule paused"),
          onError: (err) => reportError(err, "Couldn't update the schedule"),
        }
      ),
    [updateSchedule]
  )
}

function useRemoveSchedule() {
  const cancelSchedule = useCancelSchedule()
  const confirm = useConfirm()
  return React.useCallback(
    async (id: string): Promise<boolean> => {
      if (
        !(await confirm({
          title: "Cancel this scheduled message?",
          description:
            "It is removed from the schedule and never sent. The thread itself is untouched, and you can schedule the message again.",
          destructive: true,
          confirmLabel: "Cancel schedule",
        }))
      )
        return false
      try {
        await cancelSchedule.mutateAsync(id)
        toast.success("Schedule cancelled")
        return true
      } catch (err) {
        reportError(err, "Couldn't cancel the schedule")
        return false
      }
    },
    [cancelSchedule, confirm]
  )
}

/** The thread a schedule lands in — its meta from the store, or nothing when
    it has been purged (the sweep will have stamped the row as undeliverable). */
const useThreadOf = (sessionId: string): SessionMeta | undefined =>
  useStoreSelect((store) => store.sessions.find((s) => s.id === sessionId))

/** The skip banner under a row or at the top of the page. */
function SkipNote({ item, onResume }: { item: ScheduledMessage; onResume: () => void }) {
  const parked = scheduleParked(item)
  return (
    <div className="flex flex-wrap items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 sm:flex-nowrap dark:text-amber-400">
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
      <Button size="xs" variant="outline" className="shrink-0" onClick={onResume}>
        Resume
      </Button>
    </div>
  )
}

/* ── The list ── */

function SchedulesListPage() {
  const sessions = useStoreSelect((store) => store.sessions)
  const scheduledQuery = useScheduled()
  const scheduled = scheduledQuery.data ?? []
  const navigate = useNavigate()

  const paused = scheduled.filter((s) => s.enabled === 0).length
  const undeliverable = scheduled.filter(scheduleSkipped).length
  const recurring = scheduled.filter((s) => s.everyMs !== null).length
  const next = scheduled
    .filter((s) => s.enabled !== 0 && !scheduleParked(s))
    .reduce<ScheduledMessage | null>((best, s) => (!best || s.nextAt < best.nextAt ? s : best), null)

  /* Filed under the thread they will land in, soonest thread first: two
     schedules against one thread are one conversation's plans, and a reader
     asking "what is going to happen to this thread" wants them together. */
  const groups = React.useMemo(() => {
    const byThread = new Map<string, ScheduledMessage[]>()
    for (const s of [...scheduled].sort((a, b) => a.nextAt - b.nextAt))
      byThread.set(s.sessionId, [...(byThread.get(s.sessionId) ?? []), s])
    return [...byThread.entries()].map(([sessionId, items]) => ({
      sessionId,
      session: sessions.find((s) => s.id === sessionId),
      items,
    }))
  }, [scheduled, sessions])

  const newSchedule = () => void navigate(schedulePath(), { state: { returnTo: schedulesPath() } })

  return (
    <>
      <SurfaceHeader
        title="Scheduled messages"
        description="Prompts the server delivers to a thread's agent at a set time — with or without a browser open. Pause a schedule to keep it without it firing."
        onBack={() => void navigate("/")}
        actions={
          <Button onClick={newSchedule}>
            <Plus data-icon="inline-start" />
            New schedule
          </Button>
        }
      />
      {scheduledQuery.error && (
        <ErrorNote
          error={captureError(scheduledQuery.error, "Couldn't read the schedules")}
          onRetry={() => void scheduledQuery.refetch()}
        />
      )}
      {scheduled.length === 0 && !scheduledQuery.isPending ? (
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
          <StatGrid>
            <StatTile
              icon={CalendarClock}
              label="Scheduled"
              value={scheduled.length}
              loading={scheduledQuery.isPending}
              hint={
                paused > 0
                  ? `${paused} paused`
                  : recurring > 0
                    ? `${recurring} recurring`
                    : "all one-off"
              }
            />
            <StatTile
              icon={ClockIcon}
              label="Next delivery"
              value={next ? untilLabel(next.nextAt) : "—"}
              loading={scheduledQuery.isPending}
              hint={
                next
                  ? new Date(next.nextAt).toLocaleString()
                  : scheduled.length > 0
                    ? "everything is paused or parked"
                    : "nothing scheduled"
              }
            />
            <StatTile
              icon={RepeatIcon}
              label="Recurring"
              value={recurring}
              loading={scheduledQuery.isPending}
              hint={recurring === 1 ? "repeats until cancelled" : "repeat until cancelled"}
            />
            <StatTile
              icon={AlertTriangle}
              label="Undeliverable"
              value={undeliverable}
              loading={scheduledQuery.isPending}
              tone={undeliverable > 0 ? "text-amber-600 dark:text-amber-400" : undefined}
              hint={undeliverable > 0 ? "the sweep could not deliver" : "every thread reachable"}
            />
          </StatGrid>

          <div className="mt-4 space-y-4">
            {groups.map((group) => (
              <SurfaceCard
                key={group.sessionId}
                title={
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <MessageSquareTextIcon className="size-3.5 shrink-0" />
                    <span className="truncate normal-case tracking-normal">
                      {group.session?.title || (group.session ? "Untitled thread" : "Thread missing")}
                    </span>
                  </span>
                }
                action={
                  group.session ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => void navigate(threadPath(group.sessionId))}
                    >
                      Open thread
                      <ExternalLinkIcon data-icon="inline-end" />
                    </Button>
                  ) : undefined
                }
              >
                <div className="divide-y">
                  {group.items.map((item) => (
                    <ScheduleRow key={item.id} item={item} />
                  ))}
                </div>
              </SurfaceCard>
            ))}
          </div>
        </>
      )}
    </>
  )
}

function ScheduleRow({ item }: { item: ScheduledMessage }) {
  const navigate = useNavigate()
  const setEnabled = useSetEnabled()
  const remove = useRemoveSchedule()
  const paused = item.enabled === 0
  const skipped = scheduleSkipped(item)
  const open = () => void navigate(scheduleDetailPath(item.id))

  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:flex-nowrap">
        {paused ? (
          <Pause className="size-4 shrink-0 text-muted-foreground" aria-label="Paused" />
        ) : skipped ? (
          <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-label="Undeliverable" />
        ) : item.everyMs !== null ? (
          <RepeatIcon className="size-4 shrink-0 text-muted-foreground" aria-label="Recurring" />
        ) : (
          <CalendarClock className="size-4 shrink-0 text-muted-foreground" aria-label="Once" />
        )}
        <button type="button" onClick={open} className="min-w-0 flex-1 text-left">
          <div className={cn("truncate text-sm font-medium", paused && "text-muted-foreground")}>
            {item.text}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {scheduleWhen(item.nextAt, item.everyMs)}
            {paused ? " · paused" : ` · ${untilLabel(item.nextAt)}`}
          </div>
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Switch
            checked={!paused}
            onCheckedChange={(checked) => setEnabled(item, checked)}
            aria-label={paused ? "Resume schedule" : "Pause schedule"}
          />
          <Button variant="ghost" size="icon-sm" title="Open" onClick={open}>
            <ChevronRightIcon />
            <span className="sr-only">Open schedule</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-sm" title="More">
                  <MoreVerticalIcon />
                  <span className="sr-only">More actions</span>
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={open}>
                <Pencil />
                Edit…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void navigate(threadPath(item.sessionId))}>
                <ExternalLinkIcon />
                Open thread
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => void remove(item.id)}>
                <Trash2 />
                Cancel schedule
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {skipped && (
        <div className="mt-2">
          <SkipNote item={item} onResume={() => setEnabled(item, true)} />
        </div>
      )}
    </div>
  )
}

/* ── One schedule (/schedules/<id>) ── */

function ScheduleDetailPage({ scheduleId }: { scheduleId: string }) {
  const scheduledQuery = useScheduled()
  const item = scheduledQuery.data?.find((s) => s.id === scheduleId)
  const navigate = useNavigate()
  const back = () => void navigate(schedulesPath())

  if (!item) {
    if (scheduledQuery.isPending)
      return (
        <>
          <FormPageHeader title="Schedule" description="" onBack={back} />
          <Skeleton className="h-24 w-full rounded-xl" />
        </>
      )
    return (
      <>
        <FormPageHeader title="Schedule" description="" onBack={back} />
        <EmptyCard
          icon={CalendarClock}
          text="This schedule no longer exists — it was cancelled, or it fired once and was removed."
        />
      </>
    )
  }
  return <ScheduleDetail item={item} onBack={back} />
}

function ScheduleDetail({ item, onBack }: { item: ScheduledMessage; onBack: () => void }) {
  const thread = useThreadOf(item.sessionId)
  const projects = useProjects()
  const agents = useAgents()
  const navigate = useNavigate()
  const setEnabled = useSetEnabled()
  const remove = useRemoveSchedule()
  const [editing, setEditing] = React.useState(false)

  const paused = item.enabled === 0
  const skipped = scheduleSkipped(item)
  const parked = scheduleParked(item)
  const project = thread ? projects.find((p) => p.id === thread.projectId) : undefined
  const agent = thread ? agents.find((a) => a.id === thread.agentId) : undefined
  const threadGone = !thread || thread.deletedAt !== null

  return (
    <>
      <SurfaceHeader
        onBack={onBack}
        icon={
          <div className="flex size-11 items-center justify-center rounded-xl border bg-muted/40 text-muted-foreground">
            {paused ? <Pause className="size-5" /> : item.everyMs !== null ? <RepeatIcon className="size-5" /> : <CalendarClock className="size-5" />}
          </div>
        }
        title={
          <span className="inline-flex min-w-0 items-center gap-2">
            <span className="truncate">{item.everyMs === null ? "One-off message" : `Every ${everyLabel(item.everyMs)}`}</span>
            {paused && (
              <span className="rounded-pill bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase text-muted-foreground">
                Paused
              </span>
            )}
            {parked && (
              <span className="rounded-pill bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase text-amber-700 dark:text-amber-400">
                Parked
              </span>
            )}
          </span>
        }
        meta={
          <>
            <MetaFact icon={MessageSquareTextIcon} title="Thread">
              {thread ? thread.title || "Untitled thread" : "Thread missing"}
              {thread?.deletedAt ? " · in trash" : ""}
            </MetaFact>
            {project && (
              <MetaFact title="Project">
                <ProjectIcon project={project} className="size-3.5" />
                {project.name}
              </MetaFact>
            )}
            {thread && (
              <MetaFact title="Agent">
                <AgentIcon agentId={thread.agentId} className="size-3.5" />
                {agent?.name ?? thread.agentId}
                {thread.model && ` · ${thread.model}`}
              </MetaFact>
            )}
            <MetaFact icon={ClockIcon} title="Created">
              {new Date(item.createdAt).toLocaleString()}
            </MetaFact>
          </>
        }
        actions={
          <>
            <div className="mr-1 flex items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={!paused}
                onCheckedChange={(checked) => setEnabled(item, checked)}
                aria-label={paused ? "Resume schedule" : "Pause schedule"}
              />
              {paused ? "Paused" : "Active"}
            </div>
            {thread && !thread.deletedAt && (
              <Button variant="outline" onClick={() => void navigate(threadPath(item.sessionId))}>
                <ExternalLinkIcon data-icon="inline-start" />
                Open thread
              </Button>
            )}
            <Button variant={editing ? "secondary" : "default"} onClick={() => setEditing((v) => !v)} aria-pressed={editing}>
              <Pencil data-icon="inline-start" />
              {editing ? "Close editor" : "Edit"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="ghost" size="icon" title="More">
                    <MoreVerticalIcon />
                    <span className="sr-only">More actions</span>
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onClick={() => setEnabled(item, paused)}>
                  {paused ? <Play /> : <Pause />}
                  {paused ? "Resume" : "Pause"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => {
                    void remove(item.id).then((gone) => gone && onBack())
                  }}
                >
                  <Trash2 />
                  Cancel schedule
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      {skipped && (
        <div className="mb-4">
          <SkipNote item={item} onResume={() => setEnabled(item, true)} />
        </div>
      )}
      {!skipped && threadGone && (
        <p className="mb-4 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          <span className="text-pretty">
            {thread
              ? "The thread this lands in is in the trash. The next delivery will fail until it is restored."
              : "The thread this lands in is not in the list. The next delivery will fail; cancel this schedule and make a new one."}
          </span>
        </p>
      )}

      <StatGrid>
        <StatTile
          icon={ClockIcon}
          label="Next delivery"
          value={paused ? "—" : untilLabel(item.nextAt)}
          hint={paused ? "paused — nothing fires" : new Date(item.nextAt).toLocaleString()}
          tone={!paused && item.nextAt <= Date.now() ? "text-primary" : undefined}
        />
        <StatTile
          icon={RepeatIcon}
          label="Repeat"
          value={item.everyMs === null ? "Once" : everyLabel(item.everyMs)}
          hint={item.everyMs === null ? "then the schedule is removed" : "until cancelled"}
        />
        <StatTile
          icon={AlertTriangle}
          label="Failed deliveries"
          value={item.skipCount}
          tone={item.skipCount > 0 ? "text-amber-600 dark:text-amber-400" : undefined}
          hint={
            item.skipCount === 0
              ? "none"
              : parked
                ? "parked — resume to retry"
                : `parks at ${MAX_SCHEDULE_SKIPS}`
          }
        />
        <StatTile
          icon={CalendarClock}
          label="Created"
          value={shortAge(item.createdAt)}
          hint={new Date(item.createdAt).toLocaleString()}
        />
      </StatGrid>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <SurfaceCard title="Message">
          <p className="max-h-96 overflow-y-auto px-4 py-3 text-sm whitespace-pre-wrap text-pretty">{item.text}</p>
        </SurfaceCard>
        <SurfaceCard title="How it works">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 px-4 py-3 text-xs">
            <dt className="text-muted-foreground">Delivered by</dt>
            <dd>The server, browser or no browser</dd>
            <dt className="text-muted-foreground">Lands as</dt>
            <dd>A prompt in the thread — queued if a turn is running</dd>
            <dt className="text-muted-foreground">Record</dt>
            <dd>The thread's own transcript; a schedule keeps none</dd>
            <dt className="text-muted-foreground">Target</dt>
            <dd>Fixed — cancel and reschedule to move it</dd>
          </dl>
        </SurfaceCard>
      </div>

      {editing && (
        <div className="mt-4">
          <EditScheduleForm item={item} onDone={() => setEditing(false)} />
        </div>
      )}
    </>
  )
}

/** The editor: text, time, recurrence. The target thread is not editable (the
    server has no patch for it — cancel and reschedule instead). */
function EditScheduleForm({
  item,
  onDone,
}: {
  item: ScheduledMessage
  onDone: () => void
}) {
  const updateSchedule = useUpdateSchedule()
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
  const [error, setError] = React.useState<InlineError | null>(null)

  const nextAt = fromLocalInput(at)
  const valid = text.trim().length > 0 && nextAt > 0

  const recurrenceLabel = (value: EditRecurrence) =>
    value === "custom" ? `Every ${everyLabel(item.everyMs ?? 0)} (current)` : RECURRENCE_LABEL[value]

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    try {
      await updateSchedule.mutateAsync({
        id: item.id,
        patch: {
          text: text.trim(),
          nextAt,
          everyMs: recurrence === "custom" ? item.everyMs : (RECURRENCE_MS[recurrence] ?? null),
        },
      })
      toast.success("Schedule updated")
      onDone()
    } catch (error) {
      setError(captureError(error, "Couldn't update the schedule"))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border bg-card p-4">
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
      <ErrorNote error={error} />
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
  const allSessions = useStoreSelect((store) => store.sessions)
  const navigate = useNavigate()
  const location = useLocation()
  const [params] = useSearchParams()
  const routeState = (location.state ?? {}) as ScheduleLocationState
  const sessions = allSessions.filter((session) => isTopLevel(session) && !session.draft && !session.deletedAt)
  const requested = params.get("session")
  const initialTarget = sessions.some((session) => session.id === requested)
    ? (requested ?? "")
    : (sessions[0]?.id ?? "")

  const [text, setText] = React.useState(routeState.defaultText ?? "")
  const [at, setAt] = React.useState(() => toLocalInput(minNextAt()))
  const [recurrence, setRecurrence] = React.useState<Recurrence>("once")
  const [target, setTarget] = React.useState(initialTarget)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<InlineError | null>(null)

  const back = () => void navigate(routeState.returnTo ?? schedulesPath())
  const nextAt = fromLocalInput(at)
  const valid = target.length > 0 && text.trim().length > 0 && nextAt >= minNextAt()

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!valid) return
    setBusy(true)
    setError(null)
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
      setError(captureError(error, "Couldn't schedule the message"))
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
          <ErrorNote error={error} />
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
