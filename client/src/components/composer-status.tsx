import * as React from "react"
import { useEffect, useMemo, useState } from "react"
import {
  BotIcon,
  CheckCircle2Icon,
  CheckIcon,
  CircleDashedIcon,
  LoaderCircleIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Logo } from "@/components/ui/logo"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { formatReset, peakWindow, planReadable, quotaStatusText, quotaTone } from "@/lib/quota"
import type { Actions } from "@/lib/actions"
import type { SessionMeta } from "@/lib/settings"
import { extractSubagent, extractTodos, toolHeading, toolViewOf } from "@/lib/tools"
import { activeSubagents, buildRows } from "@/lib/transcript-rows"
import { useAgents, useProfiles } from "@/lib/queries/catalog"
import { useStoreSelect, type PlanItem, type ThreadState, type ToolItem } from "@/lib/store"
import { describeError } from "@/lib/errors"
import { holdOf } from "@/lib/thread/hold"
import { formatRate, formatTokens } from "@/lib/tokens"
import { cn } from "@/lib/utils"

/** Above this the agent is about to compact, so the popover says so. */
const COMPACTION_WARN = 85

/** Urgency colour for the ring and bar: calm while there is room, amber as it
 *  fills, red at the brink. Returns both the text and fill classes so the same
 *  tone paints the dial and the bar without a second threshold check. */
function contextTone(percent: number): { text: string; bar: string } {
  if (percent >= 90) return { text: "text-destructive", bar: "bg-destructive" }
  if (percent >= COMPACTION_WARN) return { text: "text-amber-600 dark:text-amber-400", bar: "bg-amber-500" }
  return { text: "text-emerald-600 dark:text-emerald-400", bar: "bg-emerald-500" }
}

function Ring({ percent }: { percent: number }) {
  const radius = 8.5
  const circumference = 2 * Math.PI * radius

  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-6 -rotate-90">
      <circle cx="12" cy="12" r={radius} fill="none" strokeWidth="2" stroke="currentColor" className="opacity-15" />
      <circle
        cx="12"
        cy="12"
        r={radius}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        stroke="currentColor"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - percent / 100)}
      />
    </svg>
  )
}

function Stat({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("font-medium tabular-nums", valueClass)}>{value}</dd>
    </div>
  )
}

/**
 * The plan behind the turn, under the turn's own numbers.
 *
 * Two different questions share this popover on purpose. The stats above it are
 * about *this thread* — how full its context is, what the last turn cost. This
 * is about the account the thread spends, which is the thing that decides
 * whether there is a next turn at all, and there was nowhere in the app to see
 * it. Settings › Usage is the full view; this is the glance. It is drawn for a
 * pair with a plan to read (`planReadable`): a profile that names one of its
 * own, or a thread on the agent's Default profile, which spends the machine's
 * own `claude`/`codex login` and is read by the agent's own probe. A thread on
 * a stored profile with neither is billed to an API key and has nothing a
 * glance could say.
 *
 * Fetched when the popover first opens rather than with the thread: it costs a
 * process on the server, and a thread nobody expands should not pay for one.
 * After that the socket keeps it current on its own — the server re-reads on
 * every settled turn — so this asks once and then only listens.
 */
function PlanUsage({ thread, meta, actions }: { thread: ThreadState; meta?: SessionMeta; actions: Actions }) {
  const profileId = meta?.profileId
  const agentId = meta?.agentId
  const profile = useProfiles().find((p) => p.id === profileId) ?? null
  const agent = useAgents().find((a) => a.id === agentId) ?? null
  const readable = planReadable(profile, agent)
  const { quota } = thread
  const asked = React.useRef(false)
  /* True from the ask until the answer: the probe spawns a CLI on the server,
     which can take seconds, and the section should say so rather than appear
     from nowhere once it lands. Cleared on failure too — a swallowed error
     leaves `quota` null, and a spinner that never stops is worse than no row. */
  const [pending, setPending] = useState(false)
  React.useEffect(() => {
    if (asked.current || quota || !meta || !readable) return
    asked.current = true
    setPending(true)
    void actions.loadQuota(meta).finally(() => setPending(false))
  }, [quota, meta, actions, readable])

  /* A thread on a stored profile with no plan of its own draws nothing here:
     the reading an agent probe would give back belongs to the machine's login,
     which that thread never spent, and Settings › Usage is where that answer
     lives. */
  if (!readable) return null
  if (!quota) {
    if (!pending) return null
    return (
      <div className="border-t pt-2">
        <p className="font-medium">Plan usage</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
          <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
          Reading plan usage…
        </p>
      </div>
    )
  }
  if (quota.status === "unsupported") return null
  const peak = peakWindow(quota)

  return (
    <div className="border-t pt-2">
      <p className="font-medium">Plan usage</p>
      {quota.windows.length === 0 ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{quotaStatusText(quota)}</p>
      ) : (
        <div className="mt-1.5 space-y-2">
          {quota.windows.map((window) => {
            const percent = Math.min(100, Math.max(0, Math.round(window.usedPercent)))
            const tone = quotaTone(percent)
            const reset = formatReset(window)
            return (
              <div key={window.id}>
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate text-muted-foreground">{window.label}</span>
                  <span className={cn("font-medium tabular-nums", tone.text)}>{percent}%</span>
                </div>
                <div
                  className="mt-1 h-1 w-full overflow-hidden rounded-pill bg-muted"
                  role="progressbar"
                  aria-label={window.label}
                  aria-valuenow={percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div className={cn("h-full rounded-pill transition-all", tone.bar)} style={{ width: `${percent}%` }} />
                </div>
                {reset && <p className="mt-0.5 text-[10px] text-muted-foreground">Resets {reset}</p>}
              </div>
            )
          })}
          {peak && peak.usedPercent >= 90 && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
              Nearly out of plan — {peak.label.toLowerCase()} is {Math.round(peak.usedPercent)}% used.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The single home for per-turn telemetry: context occupancy on the ring, and
 * tokens / cache rate / TTFT inside its popover. The header carries none of it.
 */
export function ContextIndicator({
  thread,
  meta,
  actions,
  side = "top",
  size = "icon-xs",
  triggerClassName,
}: {
  thread: ThreadState
  /** The thread's row, for the (profile, agent) pair the quota is read under.
      Absent for a draft, which has no server-side thread to ask about yet. */
  meta?: SessionMeta
  actions: Actions
  /** Where the popover opens. The composer's ring opens upward; the header's
      rides at the top of the screen, so it opens downward. */
  side?: "top" | "bottom"
  /** The trigger's scale: 24px on the composer's toolbar, 32px in the header
      beside the bell, which is the header's other silent-size control. */
  size?: "icon-xs" | "icon-sm"
  /** Extra trigger classes. The header rounds its controls like the bell's
      pill rather than the composer's `rounded-lg`. */
  triggerClassName?: string
}) {
  const { context, usage, ttftMs } = thread
  if (!context && !usage && ttftMs === null) return null

  const percent = context
    ? Math.min(100, Math.max(0, Math.round((context.used / context.size) * 100)))
    : 0
  // thread.usage is the store's running total over the session's turns (agents
  // report Usage per turn), so the rate below is a genuine average.
  // `inputTokens` counts only tokens NOT served from cache — the rest of the
  // prompt arrives as cachedRead (hit) or cachedWrite (miss, being cached now).
  // Dividing by inputTokens alone pins the rate at ~100%: the whole prompt is
  // the denominator.
  // One user message === one session/prompt (actions.send is the only caller),
  // and items are rebuilt from the journal on reconnect — so no counter to keep.
  const requests = thread.items.filter((item) => item.kind === "user").length
  const cached = usage?.cachedReadTokens ?? 0
  const prompt = usage ? usage.inputTokens + cached + (usage.cachedWriteTokens ?? 0) : 0
  const cacheRate = prompt > 0 ? Math.round((cached / prompt) * 100) : null
  /* Session-average output speed: summed only over turns the server timed, so
     turns that ended before durations existed dilute neither side. */
  const measured = Object.entries(thread.turnUsage).filter(([id]) => thread.turnDuration[id] !== undefined)
  const measuredOutput = measured.reduce((n, [, u]) => n + u.outputTokens, 0)
  const measuredMs = measured.reduce((n, [id]) => n + (thread.turnDuration[id] ?? 0), 0)
  const avgRate = formatRate(measuredOutput, measuredMs)
  const tone = context ? contextTone(percent) : null

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size={size}
            className={cn(
              "relative shrink-0 rounded-lg hover:text-foreground",
              tone ? tone.text : "text-muted-foreground",
              triggerClassName,
            )}
            title={context ? `Context window — ${percent}% used` : "Turn stats"}
          >
            <Ring percent={percent} />
            <span className="absolute inset-0 grid place-items-center text-[8px] font-semibold tabular-nums">
              {context ? percent : "—"}
            </span>
          </Button>
        }
      />
      <PopoverContent align="end" side={side} className="w-60 gap-2">
        <div>
          <p className="font-medium">Context window</p>
          <p className="text-xs text-muted-foreground">
            {context
              ? `${formatTokens(context.used)} of ${formatTokens(context.size)} tokens`
              : "Not reported by this agent"}
          </p>
        </div>
        {context && (
          <div
            className="h-1.5 w-full overflow-hidden rounded-pill bg-muted"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className={cn("h-full rounded-pill transition-all", tone?.bar)} style={{ width: `${percent}%` }} />
          </div>
        )}
        {context && percent >= COMPACTION_WARN && (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
            Context is nearly full — the agent compacts the history soon to keep the turn going.
          </p>
        )}
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          <Stat label="Requests" value={String(requests)} />
          {context && (
            <>
              <Stat label="Used" value={`${percent}%`} valueClass={tone?.text} />
              <Stat label="Remaining" value={formatTokens(Math.max(0, context.size - context.used))} />
            </>
          )}
          {usage && (
            <>
              <Stat label="Prompt" value={formatTokens(prompt)} />
              <Stat label="Output" value={formatTokens(usage.outputTokens)} />
              <Stat label="New in" value={formatTokens(usage.inputTokens)} />
            </>
          )}
          {usage?.thoughtTokens ? <Stat label="Thinking" value={formatTokens(usage.thoughtTokens)} /> : null}
          {usage?.cachedReadTokens ? <Stat label="Cached" value={formatTokens(usage.cachedReadTokens)} /> : null}
          {usage?.cachedWriteTokens ? <Stat label="Cache write" value={formatTokens(usage.cachedWriteTokens)} /> : null}
          {cacheRate !== null && (
            <Stat
              label="Cache avg"
              value={`${cacheRate}%`}
              valueClass={
                cacheRate >= 50
                  ? "text-emerald-600 dark:text-emerald-400"
                  : cacheRate >= 20
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-destructive"
              }
            />
          )}
          {usage && <Stat label="Total" value={formatTokens(usage.totalTokens)} />}
          {avgRate && <Stat label="Output avg" value={avgRate} />}
          {ttftMs !== null && <Stat label="TTFT" value={`${ttftMs}ms`} />}
          {/* Cost is cumulative for the session; agents that don't price turns omit it. */}
          {context?.cost && (
            <Stat label="Cost" value={`${context.cost.amount.toFixed(2)} ${context.cost.currency}`} />
          )}
        </dl>
        {usage && (
          <p className="text-[11px] text-muted-foreground">
            Billed across every model request this session, so totals run far above the
            context size — a turn re-sends the context once per tool call. Revive resets them.
          </p>
        )}
        <PlanUsage thread={thread} meta={meta} actions={actions} />
      </PopoverContent>
    </Popover>
  )
}

/** One checklist row, in the shape both a plan entry and a todo entry reduce
    to. The two surfaces read from different channels but draw the same row. */
interface ChecklistRowData {
  content: string
  status: "completed" | "in_progress" | "pending"
}

/**
 * The agent's checklist, when it arrives through a tool call instead of ACP's
 * `plan` channel. Claude Code's `TodoWrite` and OpenCode's `todowrite` both
 * send the list as tool *input* and return nothing worth reading, and neither
 * maps to ACP's `plan` channel — so without this the most-repeated call in a
 * long thread has no surface at all. A real ACP plan is NOT read here: it
 * arrives as its own session update, at its own point in the conversation, so
 * the transcript draws it in place (`PlanStep`). This one has no such point —
 * it is the input of a call the agent makes over and over, and a row per
 * revision is what one collapsed reading exists to avoid.
 *
 * `toolViewOf` is the single place that says "this call IS a todo list"; the
 * newest such call wins, so an agent revising its list mid-turn replaces the
 * reading rather than stacking one per revision.
 */
function threadTodos(thread: ThreadState): ChecklistRowData[] | null {
  const todoItem = [...thread.items]
    .reverse()
    // Not a subagent's: a child's checklist is its own, drawn in its rail, and
    // letting it win here handed the reading to whichever worker wrote last.
    .find((item): item is ToolItem => item.kind === "tool" && !item.parentId && toolViewOf(item) === "todos")
  /* Claude Code's ACP adapter now sends TodoWrite as an ACP `plan` update
     rather than a tool call with input, so with no such call the thread's own
     plan (never a subagent's) is the checklist. */
  const planItem = todoItem
    ? null
    : [...thread.items]
        .reverse()
        .find((item): item is PlanItem => item.kind === "plan" && !item.parentId && item.entries.length > 0)
  const todos = todoItem ? extractTodos(todoItem) : planItem ? planItem.entries : null
  return todos && todos.length > 0 ? todos : null
}

/**
 * How far the agent's checklist has got, beside the context ring.
 *
 * A trigger and a popover, not a row: the checklist is the same *kind* of
 * answer as the context reading — one number that is true of the thread right
 * now, wanted at a glance and read in full only when something looks wrong —
 * so it is drawn the same way and stands in the same cluster. It has been a
 * card on the composer's shelf (folded behind a 14px sliver) and a card at the
 * foot of the transcript (a screenful of scrolling from view); both were the
 * whole list, permanently, for a question that is usually "how far along".
 *
 * The ring is the progress and the popover is the steps. The list inside it
 * scrolls — a popover is a fixed surface with a viewport of its own, which is
 * the thing the shelf could not offer without taking the room from the
 * transcript.
 */
export function TodoIndicator({ thread }: { thread: ThreadState }) {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the one field it reads
  const todos = useMemo(() => threadTodos(thread), [thread.items])
  if (!todos) return null

  const total = todos.length
  const completed = todos.filter((todo) => todo.status === "completed").length
  const current =
    todos.find((todo) => todo.status === "in_progress") ??
    todos.find((todo) => todo.status !== "completed")
  const percent = Math.round((completed / total) * 100)
  const done = completed === total

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="relative shrink-0 rounded-lg text-primary hover:text-primary"
            title={`Checklist — ${completed} of ${total} done${current ? ` · ${current.content}` : ""}`}
            aria-label="Checklist"
          >
            <Ring percent={percent} />
            {/* The count inside the dial, exactly as the context ring prints
                its percentage — one shape, two readings, so a glance at the
                cluster is one habit and not two. */}
            <span className="absolute inset-0 grid place-items-center text-[8px] font-semibold tabular-nums">
              {done ? <CheckIcon className="size-2.5" /> : completed}
            </span>
          </Button>
        }
      />
      <PopoverContent align="end" side="top" className="w-72 gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <p className="font-medium">Checklist</p>
          <span className="text-xs tabular-nums text-muted-foreground">
            {completed}/{total}
          </span>
        </div>
        {/* Its own scroll, capped against the panel: a forty-step list is
            longer than a phone. The popover is a fixed surface, so this costs
            the transcript nothing — which is the whole reason the list moved
            here. */}
        <ul className="-mx-1 max-h-[min(50svh,20rem)] space-y-0.5 overflow-y-auto overscroll-contain px-1">
          {todos.map((row, index) => (
            <li key={`${row.content}-${index}`} className="flex items-start gap-2 text-xs">
              <span className="grid size-5 shrink-0 place-items-center">
                {row.status === "completed" ? (
                  <CheckCircle2Icon aria-hidden className="size-3.5 text-primary" />
                ) : row.status === "in_progress" ? (
                  <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin text-primary" />
                ) : (
                  <CircleDashedIcon aria-hidden className="size-3.5 text-muted-foreground/60" />
                )}
              </span>
              {/* break-words, not truncate: the popover is opened to read the
                  list in full, and a step is often a path or a command whose
                  one long token would otherwise read as missing. */}
              <span
                className={cn(
                  "min-w-0 flex-1 leading-5 break-words",
                  row.status === "completed"
                    ? "text-muted-foreground line-through opacity-70"
                    : row.status === "in_progress"
                      ? "text-foreground"
                      : "text-muted-foreground"
                )}
              >
                {row.content}
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

/** One subagent still at work, whichever way its runtime announced it. */
interface RunningAgent {
  id: string
  /** What it was asked — the Task's description, or the RFD's `task`. */
  task: string
  /** Who it is — `code-reviewer`, the RFD's `name`. */
  name?: string
  startedAt: number
}

/**
 * The subagents at work right now. One reading, shared with the transcript:
 * `buildRows` decides which subagent group is `active` (see `subagentActive`
 * in lib/transcript-rows — the turn, the head, its children, and for a
 * background launch whether its owner has spoken since), and this is that
 * list flattened, nested workers included, with each head read for a name
 * and a brief.
 */
export function runningAgents(thread: Pick<ThreadState, "items" | "turnActive">): RunningAgent[] {
  return activeSubagents(buildRows(thread.items, false, thread.turnActive)).map(({ head }) => {
    if (head.kind === "subagent") {
      return { id: head.id, task: head.task || head.name, name: head.name, startedAt: head.startedAt }
    }
    const call = extractSubagent(head)
    return {
      id: head.id,
      task: call?.description ?? call?.prompt?.split("\n")[0] ?? head.title,
      name: call?.agentType,
      startedAt: head.startedAt,
    }
  })
}

/** Ticks once a second while `active`, so an elapsed time can be drawn live. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

const formatElapsed = (ms: number): string =>
  ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`

/**
 * How many subagents are out working, beside the checklist and the context
 * ring — a count, and their names and elapsed times in a popover.
 *
 * A subagent's rail is somewhere up in the transcript, often scrolled past and
 * sometimes folded, so while workers are out the cluster says how many. Gone
 * the moment none are running: it is a live count, not a history, and the rail
 * is where the record lives.
 */
export function AgentsIndicator({ thread }: { thread: ThreadState }) {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the two fields it reads
  const agents = useMemo(() => runningAgents(thread), [thread.items, thread.turnActive])
  const count = agents.length
  /* The clock ticks only while the popover is open AND workers are out: an
     elapsed time nobody is looking at is a re-render a second for nothing. */
  const [open, setOpen] = useState(false)
  const now = useNow(open && count > 0)
  if (count === 0) return null
  const label = `${count} ${count === 1 ? "agent" : "agents"} running`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="relative shrink-0 rounded-lg text-primary hover:text-primary"
            title={`${label} — ${agents.map((agent) => agent.name ?? agent.task).join(", ")}`}
            aria-label={label}
          >
            <BotIcon className="size-3.5" />
            {/* The count rides the mark rather than sitting beside it: the
                cluster is a row of 24px squares and a number outside one would
                make this the only control that is wider than it is tall. */}
            <span className="absolute -end-0.5 -top-0.5 grid size-3 place-items-center rounded-full bg-primary text-[8px] font-semibold tabular-nums text-primary-foreground">
              {count > 9 ? "9+" : count}
            </span>
          </Button>
        }
      />
      <PopoverContent align="end" side="top" className="w-72 gap-2">
        <p className="harness-shimmer font-medium text-primary">{label}</p>
        <ul className="-mx-1 max-h-[min(50svh,20rem)] space-y-0.5 overflow-y-auto overscroll-contain px-1">
          {agents.map((agent) => (
            <li key={agent.id} className="flex items-start gap-2 text-xs">
              <span className="grid size-5 shrink-0 place-items-center">
                <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin text-primary" />
              </span>
              <span className="min-w-0 flex-1 leading-5 break-words text-foreground">
                {agent.name && <span className="font-mono text-muted-foreground">{agent.name} </span>}
                {agent.task}
              </span>
              <span className="shrink-0 text-[11px] leading-5 tabular-nums text-muted-foreground/60">
                {formatElapsed(now - agent.startedAt)}
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

/**
 * What the working line says, read off the thread: the one thing the turn is
 * doing right now, so the line is a status and not a mood. In order of what
 * the reader most needs to know — a question waiting on them, workers out,
 * then whatever the *newest* thing in the transcript is.
 *
 * That last part is a single walk backwards, and it has to be: an in-flight
 * step used to be searched for across the whole transcript before prose and
 * thinking were even looked at, so a step a runtime never settles — a tool
 * call left `in_progress` forever, which is ordinary — pinned the line to its
 * heading for the rest of the turn while the agent wrote a page underneath it.
 * The line said "Read store.tsx" for two minutes. So the first item from the
 * end that means anything wins, and a *settled* step is the one thing that
 * means nothing (it is over) and is stepped past to whatever ran before it —
 * which is what keeps a parallel batch of calls reading as the call still out.
 */
export function workingMessage(thread: ThreadState): string {
  /* Before everything else: a held turn is not doing any of it. Read off the
     hold rather than the transcript, whose newest item is whatever the turn
     managed before it stopped. What it says is the hold's own (`holdOf`): a
     turn held on a failure is named as a state — the provider's sentence,
     which is what tells the reader which model to reach for — never as the
     failure an `ErrorRow` would draw. */
  if (thread.paused) return holdOf(thread).message
  /* Above everything but the hold, and for the same reason: a turn waiting out
     a backoff is not doing whatever the transcript's newest item says it is.
     This is the silence that used to read as work — seconds of shimmer under
     the name of a tool call that had already failed — and it is worth naming
     while there is still a chance it fixes itself. Named with the failure, not
     just the count: "Retrying (1 of 2)" alone leaves the reader waiting to find
     out what for. */
  if (thread.retry) {
    const of = thread.retry.of ? ` of ${thread.retry.of}` : ""
    const why = thread.retry.error ? describeError(thread.retry.error).title : ""
    return `Retrying (${thread.retry.attempt}${of})${why ? ` — ${why}` : ""}`
  }
  if (thread.permissions.length > 0) return "Waiting for your approval"
  if (thread.elicitations.length > 0) return "Waiting for your answer"
  const agents = runningAgents(thread)
  if (agents.length > 0) return `${agents.length} ${agents.length === 1 ? "agent" : "agents"} running`
  const items = thread.items
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    /* A subagent's own work is announced by the line above, not by this one. */
    if (item.parentId) continue
    switch (item.kind) {
      case "tool": {
        if (item.status !== "in_progress" && item.status !== "pending") continue
        // The step's own heading, so "Read store.tsx" here matches the row above.
        const heading = toolHeading(item)
        if (heading.file) return `${heading.title} ${heading.file}`
        if (heading.detail && !heading.prose) return `${heading.title} ${heading.detail}`
        return heading.title
      }
      case "compaction":
        if (item.status !== "in_progress") continue
        return "Compacting the context"
      case "plan":
        return "Working through the plan"
      case "thought":
        return "Thinking"
      case "agent":
        return "Writing"
      case "user":
        /* The turn is open and the agent has not said a word yet — which is a
           real stage of a turn (the model is reading the prompt), and naming it
           is what stops the line reading as "Working" from send to finish. */
        return "Starting the turn"
      default:
        // A notice or an error is not what the turn is doing; keep walking.
        continue
    }
  }
  return "Working"
}

/**
 * The one line a thread says about itself while something is happening.
 *
 * Seven sentences reach it and they used to reach it through two components
 * with the same body: six from `startingLine` — spawning, restarting, reading,
 * loading, connecting, reconnecting — and one from `workingMessage`, the turn
 * itself. Duplicated, the two drifted (only one carried `max-w-full`, only one
 * had a `title`), and worse, every step of one uninterrupted wait was a cut,
 * because the only thing the reader has to follow from stage to stage is a
 * sentence being *replaced* in a line that never moves.
 *
 * The mark is deliberately outside the swap. It glints for as long as the
 * thread is busy — the same sweep the sidebar's makes every few seconds, run
 * continuously — and re-keying it on each sentence would restart that glint
 * four times on the way from "Spawning the agent…" to "Working…".
 */
export function PhaseLine({
  text,
  still = false,
  label,
}: {
  text: string
  /** Nothing is moving — a held turn. Motion here would say the agent is
      working when it is in fact waiting for the reader. */
  still?: boolean
  label: string
}) {
  return (
    <div
      aria-label={label}
      // flex, not inline-flex: an inline-flex box is sized by its content, so
      // the `truncate` below had nothing to truncate against and a long tool
      // heading (a whole bash command, a long path) ran off the transcript.
      className={cn(
        "flex min-w-0 max-w-full items-center gap-2",
        still ? "text-muted-foreground" : "text-primary",
      )}
      role="status"
    >
      {/* size-4 sits on the step row's 1.5rem line box. */}
      <Logo working={!still} className="size-4 shrink-0" />
      {/* ponytail: one flat text node — the shimmer paints a background clipped to
          text, and background-image doesn't inherit, so a nested span goes blank.
          That constraint is also why the swap below is a transition and not an
          animation: `animation` is one shorthand per element and the shimmer
          already owns it here, and the fix cannot be to nest a span. See
          `harness-phase-swap` in index.css.
          leading-6 matches a step row's line box, so the line keeps the
          transcript's vertical rhythm. */}
      <span
        key={text}
        aria-hidden
        className={cn(
          "harness-phase-swap min-w-0 truncate text-xs leading-6",
          !still && "harness-shimmer",
        )}
        title={still ? text : undefined}
      >
        {text}
      </span>
    </div>
  )
}

export function ActivityIndicator({ thread }: { thread: ThreadState }) {
  const message = workingMessage(thread)
  /* A held turn is stopped. The line stays in the same slot, which is the
     point — the turn is still open and the composer still belongs to it. */
  const held = thread.paused
  return (
    <PhaseLine
      text={held ? message : `${message}…`}
      still={held}
      label={held ? "Turn held" : "Agent working"}
    />
  )
}
