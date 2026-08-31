import * as React from "react"
import { useEffect, useMemo, useState } from "react"
import {
  BotIcon,
  CheckCircle2Icon,
  CheckIcon,
  ChevronDownIcon,
  CircleDashedIcon,
  ListChecksIcon,
  LoaderCircleIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Logo } from "@/components/ui/logo"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useStripSummary } from "@/components/composer-strip"
import { formatReset, peakWindow, profileHasUsage, quotaStatusText, quotaTone } from "@/lib/quota"
import type { Actions } from "@/lib/actions"
import type { SessionMeta } from "@/lib/settings"
import { extractSubagent, extractTodos, toolHeading, toolViewOf } from "@/lib/tools"
import { activeSubagents, buildRows } from "@/lib/transcript-rows"
import { useStore, type ThreadState, type ToolItem } from "@/lib/store"
import { formatTokens } from "@/lib/tokens"
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
 * it. Settings › Usage is the full view; this is the glance. It is drawn only
 * for a profile that names a plan of its own — a thread on one without it is
 * billed to an API key and has nothing a glance could say.
 *
 * Fetched when the popover first opens rather than with the thread: it costs a
 * process on the server, and a thread nobody expands should not pay for one.
 * After that the socket keeps it current on its own — the server re-reads on
 * every settled turn — so this asks once and then only listens.
 */
function PlanUsage({ thread, meta, actions }: { thread: ThreadState; meta?: SessionMeta; actions: Actions }) {
  const { state } = useStore()
  const profile = meta ? state.profiles.find((p) => p.id === meta.profileId) : null
  const { quota } = thread
  const asked = React.useRef(false)
  React.useEffect(() => {
    if (asked.current || quota || !meta || !profileHasUsage(profile)) return
    asked.current = true
    void actions.loadQuota(meta)
  }, [quota, meta, actions, profile])

  /* A thread on a profile with no plan of its own draws nothing here: the
     reading an agent probe would give back belongs to the machine's login, not
     to the profile, and Settings › Usage is where that answer lives. */
  if (!profileHasUsage(profile) || !quota || quota.status === "unsupported") return null
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
}: {
  thread: ThreadState
  /** The thread's row, for the (profile, agent) pair the quota is read under.
      Absent for a draft, which has no server-side thread to ask about yet. */
  meta?: SessionMeta
  actions: Actions
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
  const tone = context ? contextTone(percent) : null

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(
              "relative shrink-0 rounded-lg hover:text-foreground",
              tone ? tone.text : "text-muted-foreground",
            )}
            title={context ? `Context window — ${percent}% used` : "Turn stats"}
          >
            <Ring percent={percent} />
            <span className="absolute inset-0 grid place-items-center text-[7px] font-semibold tabular-nums">
              {context ? percent : "—"}
            </span>
          </Button>
        }
      />
      <PopoverContent align="end" side="top" className="w-60 gap-2">
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
 * One expanding row of a checklist, on the strip. Both the plan above the
 * composer and a `TodoWrite` checklist are the same object to a reader — "here
 * is the work the agent has ahead of it, and how far it is" — so this owns the
 * whole collapsible that either surface would otherwise have each written a
 * copy of: a ring of progress and a truncated current step when closed, the
 * full list when open.
 *
 * The list owns no inner scroll. It is read in one piece — which step follows
 * which is most of the information in it — and a list that scrolls inside a
 * shelf that is itself inside a scrolling page gives you two wheels doing
 * different things over one line of text. The transcript above is the flexible
 * track (`minmax(0,1fr)`), so an open list takes its room from the conversation
 * and gives it straight back on collapse; the composer never moves. It is
 * opened by hand and closes the same way, so a long one is on screen because it
 * was asked for.
 */
function ChecklistCollapsible({
  summaryId,
  summaryLabel,
  percent,
  completed,
  total,
  current,
  running,
  rows,
}: {
  summaryId: string
  summaryLabel: string
  percent: number
  completed: number
  total: number
  current?: string
  running: boolean
  rows: ChecklistRowData[]
}) {
  const [open, setOpen] = useState(false)
  const done = completed === total
  /* On the strip's collapsed line this is a count, not a step: "Plan 2/5" is
     what a glance wants, and the step it is on is one click away. */
  useStripSummary({
    id: summaryId,
    icon: ListChecksIcon,
    label: `${summaryLabel} ${completed}/${total}`,
  })
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full">
      <CollapsibleTrigger
        render={
          <button
            type="button"
            /* px-2: the strip's own gutter, the one DraftScopeRow sits in — a
               row on the shelf should start where the other row starts. */
            className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-accent/40"
          />
        }
      >
        {/* The ring carries the progress — same dial the context indicator uses,
            so "how far through" reads the same way everywhere in the composer. */}
        <span className="relative grid size-6 shrink-0 place-items-center text-primary">
          <Ring percent={percent} />
          <span className="absolute grid place-items-center text-[8px] font-semibold tabular-nums">
            {done ? <CheckIcon className="size-2.5" /> : completed}
          </span>
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs",
            // The live step shimmers like the transcript's working line, so
            // "which step" and "still going" are the same signal.
            running ? "harness-shimmer text-primary" : "text-muted-foreground"
          )}
        >
          {current ?? "All steps complete"}
        </span>
        {/* The count and the chevron are one cluster, not two things that
            happened to end up next to each other: they share a tighter gap than
            the row's, and the chevron sits in a fixed square so it is on the
            same right edge whether the count is 1/9 or 12/40. */}
        <span className="flex shrink-0 items-center gap-1.5">
          {/* Plain caption text, not a filled badge: the strip has no chips on
              it anywhere else, and the ring to the left is already the loud way
              of saying how far along this is. */}
          <span className="text-[11px] tabular-nums text-muted-foreground/70">
            {completed}/{total}
          </span>
          <span className="grid size-4 place-items-center">
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3.5 text-muted-foreground transition-transform duration-200",
                open && "rotate-180"
              )}
            />
          </span>
        </span>
        <span className="sr-only">{open ? "Hide steps" : "Show all steps"}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="harness-collapse">
        {/* A checklist step IS a transcript step, so it is built like one: a
            `size-3.5` status icon on the first line, `text-xs leading-6` beside
            it, nothing boxed. The Item kit gave every row its own padded,
            rounded, sometimes-filled surface — a list of little cards stacked
            inside a shelf that is itself inside the composer, three frames deep
            for one line of text each. */}
        <ul className="space-y-0.5 border-t border-border/40 px-2 py-1.5">
          {rows.map((row, index) => (
            <li key={`${row.content}-${index}`} className="flex items-start gap-2 text-xs">
              {/* `size-6`, the ring's width, so a step's icon sits under the
                  ring's centre and its text starts on the same column as the
                  current-step line above it. Without the box the list was
                  indented ten pixels left of the row it expands from. */}
              <span className="grid size-6 shrink-0 place-items-center">
                {row.status === "completed" ? (
                  <CheckCircle2Icon aria-hidden className="size-3.5 text-primary" />
                ) : row.status === "in_progress" ? (
                  <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin text-primary" />
                ) : (
                  <CircleDashedIcon aria-hidden className="size-3.5 text-muted-foreground/60" />
                )}
              </span>
              <span
                className={cn(
                  // break-words, not truncate: an expanded checklist is opened
                  // to be read in full, and a step is often a path or a
                  // command whose one long token would otherwise be clipped by
                  // the strip's own `overflow-hidden` and read as missing.
                  "min-w-0 flex-1 leading-6 break-words",
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
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * The agent's checklist, when it arrives through a tool call instead of ACP's
 * `plan` channel. Claude Code's `TodoWrite` and OpenCode's `todowrite` both
 * send the list as tool *input* and return nothing worth reading, and neither
 * maps to ACP's `plan` channel — so without this the shelf has no surface for
 * the most-repeated call in a long thread. A real ACP plan is NOT drawn here:
 * it arrives as its own session update, at its own point in the conversation,
 * so the transcript draws it in place (`PlanStep`). This one has no such point
 * — it is the input of a call the agent makes over and over, and stacking a row
 * per revision is what the shelf exists to avoid.
 *
 * `toolViewOf` is the single place that says "this call IS a todo list"; the
 * newest such call wins, so an agent revising its list mid-turn replaces the
 * shelf in place rather than stacking a row for every revision.
 */
export function ComposerTodo({ thread }: { thread: ThreadState }) {
  const todoItem = [...thread.items]
    .reverse()
    // Not a subagent's: a child's checklist is its own, drawn in its rail,
    // and letting it win here handed the composer shelf to whichever worker
    // wrote last.
    .find((item): item is ToolItem => item.kind === "tool" && !item.parentId && toolViewOf(item) === "todos")
  const todos = todoItem ? extractTodos(todoItem) : null
  if (!todos || todos.length === 0) return null

  const total = todos.length
  const completed = todos.filter((todo) => todo.status === "completed").length
  const current = todos.find((todo) => todo.status === "in_progress")
    ?? todos.find((todo) => todo.status !== "completed")
  const percent = Math.round((completed / total) * 100)

  return (
    <ChecklistCollapsible
      summaryId="todos"
      summaryLabel="Todos"
      percent={percent}
      completed={completed}
      total={total}
      current={current?.content}
      running={current?.status === "in_progress"}
      rows={todos.map((todo) => ({ content: todo.content, status: todo.status }))}
    />
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
 * How many subagents are running, above the composer. A subagent's rail is
 * somewhere up in the transcript — often scrolled past, sometimes folded — so
 * while workers are out the shelf says how many, and opens to who they are
 * and how long each has been at it. Gone the moment none are running: it is
 * a live count, not a history.
 */
export function ComposerAgents({ thread }: { thread: ThreadState }) {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the two fields it reads
  const agents = useMemo(() => runningAgents(thread), [thread.items, thread.turnActive])
  const [open, setOpen] = useState(false)
  const now = useNow(agents.length > 0)
  const count = agents.length
  const label = `${count} ${count === 1 ? "agent" : "agents"} running`
  useStripSummary(count > 0 ? { id: "agents", icon: BotIcon, label } : null)
  if (count === 0) return null

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full">
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-accent/40"
          />
        }
      >
        <span className="relative grid size-6 shrink-0 place-items-center text-primary">
          <BotIcon aria-hidden className="size-3.5" />
        </span>
        <span className="harness-shimmer min-w-0 flex-1 truncate text-xs text-primary">
          {label}
          <span className="text-muted-foreground">
            {" · "}
            {agents.map((agent) => agent.name ?? agent.task).join(", ")}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="grid size-4 place-items-center">
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3.5 text-muted-foreground transition-transform duration-200",
                open && "rotate-180"
              )}
            />
          </span>
        </span>
        <span className="sr-only">{open ? "Hide agents" : "Show running agents"}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="harness-collapse">
        <ul className="space-y-0.5 border-t border-border/40 px-2 py-1.5">
          {agents.map((agent) => (
            <li key={agent.id} className="flex items-start gap-2 text-xs">
              <span className="grid size-6 shrink-0 place-items-center">
                <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin text-primary" />
              </span>
              <span className="min-w-0 flex-1 leading-6 break-words text-foreground">
                {agent.name && <span className="font-mono text-muted-foreground">{agent.name} </span>}
                {agent.task}
              </span>
              <span className="shrink-0 text-[11px] leading-6 tabular-nums text-muted-foreground/60">
                {formatElapsed(now - agent.startedAt)}
              </span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
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
  if (thread.permission) return "Waiting for your approval"
  if (thread.elicitation) return "Waiting for your answer"
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

export function ActivityIndicator({ thread }: { thread: ThreadState }) {
  const message = workingMessage(thread)

  return (
    <div
      aria-label="Agent working"
      // flex, not inline-flex: an inline-flex box is sized by its content, so
      // the `truncate` below had nothing to truncate against and a long tool
      // heading (a whole bash command, a long path) ran off the transcript.
      className="flex min-w-0 max-w-full items-center gap-2 text-primary"
      role="status"
    >
      {/* The mark glints for as long as the turn runs — the same sweep the
          sidebar's mark makes every few seconds, run continuously here — so
          starting a turn rhymes with the mark that is always on screen.
          size-4 sits on the step row's 1.5rem line box. */}
      <Logo working className="size-4 shrink-0" />
      {/* ponytail: one flat text node — the shimmer paints a background clipped to
          text, and background-image doesn't inherit, so a nested span goes blank. */}
      {/* leading-6 matches a step row's line box, so the working line keeps the
          transcript's vertical rhythm. */}
      <span aria-hidden className="harness-shimmer min-w-0 truncate text-xs leading-6">
        {message}…
      </span>
    </div>
  )
}
