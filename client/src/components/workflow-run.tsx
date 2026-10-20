import * as React from "react"
import { useRowState } from "@/lib/row-open"
import type * as acp from "@daedalus/acp"
import {
  BotIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  CircleSlashIcon,
  GanttChartIcon,
  KanbanIcon,
  ListIcon,
  ListTreeIcon,
  NetworkIcon,
  LoaderCircleIcon,
  PauseIcon,
  PlayIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react"
/* The workflow/subagent *run* surfaces — a run in the transcript, and the
   list of its steps underneath it.

   **A run is a card, and its steps are rows.** The card is the run's own
   object — name, state, readings, a segmented progress strip and, opened, a
   board of its phases — because a run is the one thing in a
   transcript with a *shape* (phases, parallel steps, how far along), and one
   quiet line could only state that as a fraction. Its steps are still the
   transcript's own subagent rows, injected as `stepRow`, so reading a step
   inside a run is reading the same row it would be on its own; and it still
   opens in place, never into a dialog that takes the transcript away.

   The import runs one way: thread-items renders `WorkflowRun` /
   `SubagentBatchRun` from here, so nothing in this file may import
   thread-items back (the same rule that keeps `tool-parts.tsx` under
   tool-views and thread-items rather than either importing the other). Hence
   `stepRow`: the step row is `SubagentStep`, which is in the mutually
   recursive cluster over there and reaches this file as a prop. The helpers
   both files read (`collectTools`, `useStepThread`, `subagentHasBody`,
   `stepUsage`, `stepNameOf`) are declared *here* and imported by thread-items,
   because the one-way edge already points this way. */
import { formatElapsed, StepMeta, useElapsed } from "@/components/step-row"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { TokenSummary } from "@/components/token-usage"
import { KIND_CHIPS, KIND_COLORS } from "@/components/tool-parts"
import { extractSubagent, toolHeading, toolOutputText } from "@/lib/tools"
import type { Row, SubagentBatch, SubagentGroup, WorkflowGroup } from "@/lib/transcript-rows"
import { formatTokens, sumUsage } from "@/lib/tokens"
import { cn } from "@/lib/utils"
import { useLayoutOptionsContext } from "@/lib/layout-options"
import { useStoreSelect, type ToolItem } from "@/lib/store"
import { reportError } from "@/lib/errors"
import { useServer } from "@/lib/server-context"
import { api } from "@/lib/settings"

const WorkflowGraph = React.lazy(() =>
  import("@/components/workflow-graph").then((module) => ({ default: module.WorkflowGraph }))
)

/** How a run draws one of its steps: `SubagentStep` from thread-items, which
    is the same row the step would draw as on its own. A component prop
    because it recurses into `RowView` and must stay over there (see the
    header comment). */
export type StepRowComponent = React.ComponentType<{
  group: SubagentGroup
  showTimestamps?: boolean
  /** `body`: the step's turn parts without its header row. */
  variant?: "row" | "body"
}>

/** Every tool step a subagent ran, out of its rows — for the count on the
    step's header line. Its own subagents' steps count too: they are its work. */
export function collectTools(rows: Row[]): ToolItem[] {
  const out: ToolItem[] = []
  for (const row of rows) {
    if (row.kind === "tool") out.push(row)
    /* A run can carry thoughts between its calls — they are the reasoning,
       not a step the count line means. */
    else if (row.kind === "run")
      out.push(...row.items.filter((item): item is ToolItem => item.kind === "tool"))
    else if (row.kind === "tool-group") out.push(...collectTools(row.children))
    else if (row.kind === "subagent-group") {
      if (row.head.kind === "tool") out.push(row.head)
      out.push(...collectTools(row.children))
    } else if (row.kind === "workflow-group" || row.kind === "subagent-batch")
      out.push(...collectTools(row.steps))
    else if (row.kind === "work-fold") out.push(...collectTools(row.rows))
  }
  return out
}

/* A harness workflow step is a real thread of ours: the RFD head's `sessionId`
   is then a session in the store, and the rail is a mirror of a transcript
   that can be opened whole. A Codex child's id never is. */
export function useStepThread(group: SubagentGroup): string | null {
  const head = group.head
  const candidate = head.kind === "subagent" ? head.sessionId : null
  /* A boolean, not the row and not the list: this is asked once per subagent
     group inside a live transcript, and `sessions` is replaced by every list
     refresh — the answer to "is this id ours" is not. */
  const known = useStoreSelect((state) =>
    candidate === null ? false : state.sessions.some((s) => s.id === candidate)
  )
  return known ? candidate : null
}

/** Whether the step's body (`SubagentBody` in thread-items) would draw
    anything — the caller has to know before it renders, because a row with no
    body must not offer a disclosure. */
export function subagentHasBody(group: SubagentGroup, stepThread: string | null): boolean {
  const previews =
    group.head.kind === "subagent" &&
    Boolean(sessionBriefOf(group) || group.head.report || group.head.activity || group.head.transcript)
  return (
    group.head.kind === "tool" ||
    group.children.length > 0 ||
    group.active ||
    stepThread !== null ||
    previews
  )
}

/** A session head's brief. A runtime that announces its child as an RFD
    session withholds the launch call (our `task`, Claude Code's and Codex's
    native children), so the spawn's `task` is the only record of what it was
    asked — unless a launch is here to say it, or `task` is just the name again
    (OpenCode titles both with the child's title). */
export function sessionBriefOf(group: SubagentGroup): string | undefined {
  const head = group.head
  if (head.kind !== "subagent") return undefined
  if (head.prompt) return head.prompt
  if (group.launch && extractSubagent(group.launch)?.prompt) return undefined
  const task = head.task?.trim()
  return task && task !== head.name.trim() ? task : undefined
}

/** What a step spent, when its runtime reported it. Task-child usage is
    attribution only: those tokens remain included in the parent's turn total. */
export function stepUsage(group: SubagentGroup): acp.Usage | undefined {
  return group.head.kind === "subagent" ? group.head.usage : undefined
}

/** A step's figure for a one-line label — `12.4k tokens`, or nothing when its
    runtime reported none or the reader hid tokens. */
function stepTokensLabel(group: SubagentGroup | null, showTokens: boolean): string | null {
  const total = showTokens && group ? stepUsage(group)?.totalTokens : undefined
  return total ? `${formatTokens(total)} tokens` : null
}

/** What a *running* step is doing right now: the newest call still open, else
    the newest call at all. A step's own summary counts are the right answer
    for one that has finished and the wrong one while it works — "reading 2
    files" is what it did a minute ago. */
function currentActivity(group: SubagentGroup): string | undefined {
  /* A step whose runtime previews its activity rather than streaming its calls
     (a native workflow's agent) has no rows to read — it says so directly. */
  if (group.head.kind === "subagent" && group.head.activity) return group.head.activity
  const tools = collectTools(group.children)
  if (!tools.length) return undefined
  const open = [...tools].reverse().find((t) => t.status !== "completed" && t.status !== "failed")
  return toolHeading(open ?? tools[tools.length - 1]).title
}

/** A running step's latest calls, oldest first — the flowchart's live lines. */
function recentActivity(group: SubagentGroup, limit = 3): string[] {
  if (group.head.kind === "subagent" && group.head.activity) return [group.head.activity]
  return collectTools(group.children)
    .slice(-limit)
    .map((tool) => toolHeading(tool).title)
}

/** What a settled step came back with: the runtime's report, else the
    launch call's result, else — an RFD child, whose prose IS its report — the
    last thing it said. A JSON report becomes a human summary for the compact
    board/flowchart preview; the opened step still shows the complete result. */
export function stepResultOf(group: SubagentGroup): string | undefined {
  const tool = group.head.kind === "tool" ? group.head : (group.launch ?? null)
  const report =
    (group.head.kind === "subagent" ? group.head.report : undefined) ||
    (tool ? (extractSubagent(tool)?.result ?? toolOutputText(tool, 2_000).text) : undefined) ||
    lastProse(group.children)
  if (!report?.trim()) return undefined
  return summarizeStepResult(report)
}

function summarizeStepResult(report: string): string {
  const trimmed = report.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1]
  const source = (fenced ?? trimmed).trim()
  if (!source.startsWith("{") && !source.startsWith("[")) return trimmed.replace(/\s+/g, " ")
  try {
    const value: unknown = JSON.parse(source)
    if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? "result" : "results"}`
    if (!value || typeof value !== "object") return trimmed.replace(/\s+/g, " ")
    const record = value as Record<string, unknown>
    if (Array.isArray(record.findings)) {
      const count = record.findings.length
      const status = [record.status, record.verdict].find((field) => typeof field === "string")
      return `${count} ${count === 1 ? "finding" : "findings"}${status ? ` · ${status}` : ""}`
    }
    const summary = [record.summary, record.overview, record.message].find(
      (field) => typeof field === "string" && field.trim()
    )
    if (typeof summary === "string") return summary.trim().replace(/\s+/g, " ")
    const count = Object.keys(record).length
    return `${count} ${count === 1 ? "result field" : "result fields"}`
  } catch {
    return trimmed.replace(/\s+/g, " ")
  }
}

function lastProse(rows: Row[]): string | undefined {
  for (const row of [...rows].reverse()) {
    if (row.kind === "agent") return row.text
    if (row.kind === "run" || row.kind === "tool-group") {
      const text = [...row.items].reverse().find((item) => item.kind === "agent")
      if (text && "text" in text) return text.text
    }
  }
  return undefined
}

/** A step's state as one word, from either kind of head. A step the runner has
    not spawned yet has no group at all — see `StepCard`. */
export function stepStateOf(
  group: SubagentGroup
): "running" | "completed" | "failed" | "cancelled" | "disconnected" {
  const head = group.head
  if (group.active) return "running"
  if (head.kind === "subagent") return head.state === "running" ? "running" : head.state
  return head.status === "failed" ? "failed" : head.status === "completed" ? "completed" : "running"
}

/** The name a step reads by: the definition's (`workflow.step`), not the
    agent's title for the thread — a table of steps should read as the workflow
    the user wrote. A launch call has no definition behind it, so it reads by
    the brief the agent gave that worker (`description`) and not by
    `toolHeading`'s title, which is the word "Task" for every one of them — a
    list of three identical rows names nothing. Exported because the step row
    itself (`SubagentStep`) reads by the same rule, in or out of a run. */
export function stepNameOf(group: SubagentGroup, fallback?: string): string {
  const head = group.head
  const info = head.kind === "subagent" ? head.workflow : undefined
  const own =
    head.kind === "subagent"
      ? head.name || head.task
      : (extractSubagent(head)?.description ?? toolHeading(head).title)
  return info?.step || own || (fallback ?? "")
}

/** The last moment anything happened under a run, for the duration of one that
    has finished: an item carries the time it arrived, and nothing records when
    a step *ended* — the store has no such field, and inventing one would mean
    the reducer marking steps done, which it never does. */
export function lastActivityAt(rows: Row[]): number {
  let last = 0
  for (const row of rows) {
    if (row.kind === "run") for (const item of row.items) last = Math.max(last, item.at ?? 0)
    else if (row.kind === "tool-group")
      for (const item of row.items) last = Math.max(last, item.at ?? 0)
    else if (row.kind === "subagent-group")
      last = Math.max(last, row.head.at ?? 0, lastActivityAt(row.children))
    else if (row.kind === "workflow-group" || row.kind === "subagent-batch")
      last = Math.max(last, lastActivityAt(row.steps))
    // Not every item kind is stamped (a plan has no arrival time of its own).
    else if ("at" in row) last = Math.max(last, row.at ?? 0)
  }
  return last
}

/** One phase's steps, in definition order: the group the runner spawned for
    each, or null while it is still ahead of the run. */
export interface PhaseView {
  /** Null for a definition written as a flat step list — one unnamed phase. */
  name: string | null
  steps: { name: string; group: SubagentGroup | null }[]
  /** A live harness workflow's pause/resume, on the first phase of its run —
      set by `agentOutline` only: a run card carries it in its own header. */
  hold?: RunHold
}

interface RunHold {
  sessionId: string
  runId: string
  paused: boolean
}

/** Whether a run can be held, and where its toggle posts. The hold is stamped
    on every step of the run (see the reducer), so any head says it; the thread
    the run belongs to rides the same stamp. Offered only while the run is live
    — a settled run has nothing to hold — and still while held, since a held
    run has no active step to read liveness from. */
function holdOf(group: WorkflowGroup): RunHold | undefined {
  const heads = group.steps.map((s) => (s.head.kind === "subagent" ? s.head : null))
  const info = heads.find((h) => h?.workflow)?.workflow
  const paused = heads.some((h) => h?.workflow?.paused)
  const live =
    paused ||
    group.steps.some((s) => stepStateOf(s) === "running") ||
    (info?.total !== undefined && group.steps.length < info.total)
  if (!live || !info?.sessionId) return undefined
  return { sessionId: info.sessionId, runId: group.id.slice("workflow:".length), paused }
}

const PhaseHold = ({ phase }: { phase: PhaseView }) => (phase.hold ? <WorkflowHold {...phase.hold} /> : null)

/**
 * The run as phases of steps: the definition's outline (`group.plan`, stamped
 * on every spawn) filled in with the steps that have started.
 *
 * Without a plan — an older server, or a journal written before phases existed
 * — the arrived steps are the outline, in definition order, as one unnamed
 * phase.
 */
function phasesOf(group: Pick<WorkflowGroup, "steps" | "plan">): PhaseView[] {
  const infoOf = (step: SubagentGroup) => (step.head.kind === "subagent" ? step.head.workflow : undefined)
  const byName = new Map<string, SubagentGroup>()
  for (const step of group.steps) {
    const name = infoOf(step)?.step
    if (name && !byName.has(name)) byName.set(name, step)
  }
  if (!group.plan) {
    /* Definition order when the server said it (`workflow.index`); the sort is
       stable, so steps without one keep arrival order — the runner's schedule. */
    const steps = [...group.steps].sort(
      (a, b) => (infoOf(a)?.index ?? Number.MAX_SAFE_INTEGER) - (infoOf(b)?.index ?? Number.MAX_SAFE_INTEGER)
    )
    return [{ name: null, steps: steps.map((s) => ({ name: infoOf(s)?.step ?? "", group: s })) }]
  }
  const named = new Set(group.plan.flatMap((phase) => phase.steps))
  const phases: PhaseView[] = group.plan.map((phase) => ({
    name: phase.name,
    steps: phase.steps.map((name) => ({ name, group: byName.get(name) ?? null })),
  }))
  // A step the outline does not name cannot be placed, and must not vanish.
  const strays = group.steps.filter((s) => !named.has(infoOf(s)?.step ?? ""))
  if (strays.length) {
    phases[phases.length - 1].steps.push(...strays.map((s) => ({ name: infoOf(s)?.step ?? "", group: s })))
  }
  return phases
}

const STATE_ICON = {
  completed: [CheckIcon, "text-success"],
  running: [LoaderCircleIcon, "text-primary motion-safe:animate-spin"],
  failed: [XIcon, "text-destructive"],
  cancelled: [CircleSlashIcon, "text-muted-foreground"],
  disconnected: [CircleSlashIcon, "text-muted-foreground"],
  pending: [CircleDashedIcon, "text-muted-foreground"],
} as const

/**
 * One step on the board: its state, its name, and one quiet line under it —
 * what it is on while it runs, how long it took once it has finished. A step
 * the runner has not spawned yet is drawn too (dashed, not clickable), so the
 * board shows the run's whole shape from the first step and does not *change*
 * shape as the run advances, which is what makes a reader lose their place.
 */
function StepCard({
  name,
  group,
  selected,
  onPick,
}: {
  name: string
  group: SubagentGroup | null
  selected: boolean
  onPick: (id: string) => void
}) {
  const state: StepState = group ? stepStateOf(group) : "pending"
  const startedAt = group?.head.startedAt ?? 0
  const live = useElapsed(startedAt, state === "running" && startedAt > 0)
  const end = group ? lastActivityAt(group.children) : 0
  const ms = state === "running" ? live : end > startedAt && startedAt > 0 ? end - startedAt : null
  const tokens = stepTokensLabel(group, useLayoutOptionsContext().showTokens)
  const meta = [tokens, ms !== null && ms >= 1000 ? formatElapsed(ms) : null].filter(Boolean).join(" · ")
  const detail = group
    ? state === "running"
      ? currentActivity(group)
      : state === "completed" || state === "failed"
        ? stepResultOf(group)
        : undefined
    : "waiting"
  const label = name || (group ? stepNameOf(group) : "")
  const [Icon, tone] = STATE_ICON[state]
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <Icon aria-hidden className={cn("size-3 shrink-0", tone)} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
        {meta && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{meta}</span>}
      </span>
      {detail && (
        <span
          className={cn(
            "block truncate ps-5 text-xs text-muted-foreground",
            state === "running" && "harness-shimmer"
          )}
        >
          {detail}
        </span>
      )}
    </>
  )
  if (!group)
    return (
      <div className="rounded-xl border border-dashed p-2 text-muted-foreground">
        <span className="sr-only">pending: </span>
        {body}
      </div>
    )
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onPick(group.id)}
      className={cn(
        "block w-full min-w-0 rounded-xl border bg-card p-2 text-start transition-colors outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50",
        selected ? "border-primary" : "",
        state === "failed" && !selected && "border-destructive/30 bg-destructive/10",
        state === "running" && !selected && "border-primary/30"
      )}
    >
      {body}
    </button>
  )
}

export type StepState = ReturnType<typeof stepStateOf> | "pending"

/* One colour per state, shared by the progress segments and the phase nodes so
   the strip and the board under it read as the same legend. */
export const SEGMENT: Record<StepState, string> = {
  completed: "bg-success",
  running: "bg-primary motion-safe:animate-pulse",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground/40",
  disconnected: "bg-muted-foreground/40",
  pending: "bg-muted-foreground/15",
}

/** A phase's own state, from its steps': any failure claims it, then any work
    in flight, and only a phase whose every step finished is done. */
function phaseState(states: StepState[]): StepState {
  if (states.some((s) => s === "failed")) return "failed"
  if (states.some((s) => s === "running")) return "running"
  if (states.length > 0 && states.every((s) => s === "completed")) return "completed"
  return states.some((s) => s !== "pending") ? "running" : "pending"
}

const BADGE = {
  running: ["Running", "bg-primary/10 text-primary"],
  paused: ["Paused", "bg-warning/10 text-warning"],
  failed: ["Failed", "bg-destructive/10 text-destructive"],
  completed: ["Done", "bg-success/10 text-success"],
} as const

/* ── The run's layouts ── one outline (`phasesOf`), drawn five ways. Each is
   a reading of the same facts the reader picks between: browse for
   drilling phase → step → its turn parts, the board for the run's shape, the list
   for reading every step inline, the timeline for when each step ran and for
   how long, and the flowchart for how phases join and what a running step is
   doing this second. */
export type RunView = "browse" | "board" | "list" | "timeline" | "flowchart"

export const RUN_VIEWS: { id: RunView; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "browse", label: "Browse", icon: ListTreeIcon },
  { id: "board", label: "Board", icon: KanbanIcon },
  { id: "list", label: "List", icon: ListIcon },
  { id: "timeline", label: "Timeline", icon: GanttChartIcon },
  { id: "flowchart", label: "Flowchart", icon: NetworkIcon },
]

interface ViewProps {
  phases: PhaseView[]
  /** More than one phase — the layouts draw phase headings only then. */
  staged: boolean
  picked: string | null
  /** Toggle: a second click on the picked step puts it away. */
  pick: (id: string) => void
  active: boolean
  stepRow: StepRowComponent
  showTimestamps?: boolean
}

const stateOfStep = (step: { group: SubagentGroup | null }): StepState =>
  step.group ? stepStateOf(step.group) : "pending"
const phaseLabel = (phase: PhaseView, p: number) => phase.name || `Phase ${p + 1}`

/** A step's span on the clock: its start, and its last activity (now, while it
    runs). Null for one that has not started. */
function spanOf(group: SubagentGroup | null, now: number | null): [number, number] | null {
  if (!group || !group.head.startedAt) return null
  const start = group.head.startedAt
  const end = stepStateOf(group) === "running" && now !== null ? now : lastActivityAt(group.children)
  return [start, Math.max(start, end)]
}

/** Board: a column per phase, steps as cards; one phase wraps as a grid. */
function BoardView({ phases, staged, picked, pick }: ViewProps) {
  const card = (step: PhaseView["steps"][number], key: React.Key) => (
    <StepCard
      key={key}
      name={step.name}
      group={step.group}
      selected={step.group !== null && step.group.id === picked}
      onPick={pick}
    />
  )
  if (!staged)
    return (
      <div className="grid grid-cols-1 gap-2 @panel-sm:grid-cols-2 @panel-md:grid-cols-3">
        {phases[0].steps.map((step, i) => card(step, step.group?.id ?? i))}
      </div>
    )
  /* A wide definition scrolls sideways rather than squeezing every column to a word. */
  return (
    <div className="-mx-2 flex snap-x gap-2 overflow-x-auto px-2 pb-1">
      {phases.map((phase, p) => {
        const own = phase.steps.map(stateOfStep)
        return (
          <section
            key={phase.name ?? p}
            aria-label={phaseLabel(phase, p)}
            className="flex w-44 min-w-44 flex-1 shrink-0 snap-start flex-col gap-1 rounded-2xl bg-muted p-1"
          >
            <header className="flex h-5 items-center gap-2 px-1">
              <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", SEGMENT[phaseState(own)])} />
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                {phaseLabel(phase, p)}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {own.filter((s) => s === "completed").length}/{own.length}
              </span>
              <PhaseHold phase={phase} />
            </header>
            {phase.steps.map((step, i) => card(step, step.group?.id ?? `${p}:${i}`))}
          </section>
        )
      })}
    </div>
  )
}

/** List: a numbered stepper down a connector, every step's own row inline. */
function ListView({ phases, staged, stepRow: StepView, showTimestamps }: ViewProps) {
  const rows = (phase: PhaseView, p: number) =>
    phase.steps.map((step, i) =>
      step.group ? (
        <StepView key={step.group.id} group={step.group} showTimestamps={showTimestamps} />
      ) : (
        <div key={`${p}:${i}`} className="flex h-6 items-center gap-2 text-sm text-muted-foreground">
          <span className="flex h-6 w-5 shrink-0 items-center justify-center">
            <CircleDashedIcon aria-hidden className="size-3" />
          </span>
          <span className="sr-only">pending: </span>
          <span className="min-w-0 flex-1 truncate">{step.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">waiting</span>
        </div>
      )
    )
  if (!staged) return <div className="min-w-0 space-y-0.5">{rows(phases[0], 0)}</div>
  return (
    <ol className="min-w-0">
      {phases.map((phase, p) => {
        const own = phase.steps.map(stateOfStep)
        const state = phaseState(own)
        const last = p === phases.length - 1
        return (
          <li key={phase.name ?? p} className="flex min-w-0 gap-2">
            <span aria-hidden className="flex w-5 shrink-0 flex-col items-center">
              <span
                className={cn(
                  "mt-0.5 flex size-5 items-center justify-center rounded-full text-xs font-medium tabular-nums",
                  state === "completed" && "bg-success/10 text-success",
                  state === "running" && "bg-primary/10 text-primary",
                  state === "failed" && "bg-destructive/10 text-destructive",
                  (state === "pending" || state === "cancelled" || state === "disconnected") &&
                    "bg-muted text-muted-foreground"
                )}
              >
                {state === "completed" ? <CheckIcon className="size-3" /> : p + 1}
              </span>
              {!last && (
                <span className={cn("mt-0.5 w-px flex-1", state === "completed" ? "bg-success/30" : "bg-border")} />
              )}
            </span>
            <div className={cn("min-w-0 flex-1", !last && "pb-3")}>
              <div className="flex h-6 items-center gap-2">
                <span className="truncate text-sm font-medium">{phaseLabel(phase, p)}</span>
                <span className="ms-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                  {own.filter((s) => s === "completed").length}/{own.length}
                </span>
                <PhaseHold phase={phase} />
              </div>
              <div className="min-w-0 space-y-0.5">{rows(phase, p)}</div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/** Timeline: a bar per step on the run's own clock, so what ran side by side
    and what took longest are read off the drawing. */
function TimelineView({ phases, staged, picked, pick, active }: ViewProps) {
  /* Elapsed since 0 is simply now — one clock for every running bar. */
  const now = useElapsed(0, active)
  const { showTokens } = useLayoutOptionsContext()
  const spans = phases.flatMap((phase) => phase.steps.map((step) => spanOf(step.group, now)))
  const known = spans.filter((span): span is [number, number] => span !== null)
  const t0 = known.length ? Math.min(...known.map((span) => span[0])) : 0
  const t1 = Math.max(t0 + 1000, ...known.map((span) => span[1]))
  const width = t1 - t0
  let k = 0
  return (
    <div className="min-w-0 space-y-0.5">
      {phases.map((phase, p) => (
        <React.Fragment key={phase.name ?? p}>
          {staged && (
            <div className="flex items-center gap-1 pt-2 pb-1 text-xs font-medium text-muted-foreground first:pt-0">
              <span className="min-w-0 flex-1 truncate">{phaseLabel(phase, p)}</span>
              <PhaseHold phase={phase} />
            </div>
          )}
          {phase.steps.map((step, i) => {
            const span = spans[k++]
            const state = stateOfStep(step)
            const label = step.name || (step.group ? stepNameOf(step.group) : "")
            const group = step.group
            return (
              <div key={group?.id ?? `${p}:${i}`} className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] items-center gap-2">
                <span className={cn("truncate text-sm", state === "pending" && "text-muted-foreground")}>{label}</span>
                <div className="relative h-5 rounded-md bg-muted">
                  {span && group ? (
                    <button
                      type="button"
                      aria-pressed={picked === group.id}
                      aria-label={[label, formatElapsed(span[1] - span[0]), stepTokensLabel(group, showTokens)].filter(Boolean).join(", ")}
                      title={[label, formatElapsed(span[1] - span[0]), stepTokensLabel(group, showTokens)].filter(Boolean).join(" · ")}
                      onClick={() => pick(group.id)}
                      style={{
                        insetInlineStart: `${((span[0] - t0) / width) * 100}%`,
                        width: `max(6px, ${((span[1] - span[0]) / width) * 100}%)`,
                      }}
                      className={cn(
                        "absolute inset-y-1 rounded-md transition-[width]",
                        SEGMENT[state],
                        picked === group.id && "ring-[3px] ring-ring/50"
                      )}
                    />
                  ) : (
                    <span className="absolute inset-y-0 start-2 flex items-center text-xs text-muted-foreground">
                      waiting
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </React.Fragment>
      ))}
      {known.length > 0 && (
        <div className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-2 pt-1 text-xs tabular-nums text-muted-foreground">
          <span />
          <span className="flex justify-between">
            <span>0s</span>
            <span>{formatElapsed(width)}</span>
          </span>
        </div>
      )}
    </div>
  )
}

/** Browse: the run as three levels you drill through, each taking the full
    width — the phases, then the picked phase's steps, then the picked step's
    own turn parts (its brief, rail and report, without a header row: the
    breadcrumb already says whose they are). A one-phase run starts at its
    steps. Back is the breadcrumb, or the arrow beside it. */
function BrowseView({ phases, staged, stepRow: StepView, showTimestamps }: ViewProps) {
  const [phaseAt, setPhaseAt] = React.useState<number | null>(staged ? null : 0)
  const [stepId, setStepId] = React.useState<string | null>(null)
  const phase = phaseAt === null ? null : (phases[phaseAt] ?? null)
  const step = phase?.steps.find((s) => s.group?.id === stepId)?.group ?? null
  const level = step ? 2 : phase ? 1 : 0
  const back = () => (step ? setStepId(null) : staged ? setPhaseAt(null) : undefined)

  const crumb = (label: string, onClick: (() => void) | null) =>
    onClick ? (
      <button type="button" onClick={onClick} className="min-w-0 truncate text-muted-foreground hover:text-foreground">
        {label}
      </button>
    ) : (
      <span aria-current="page" className="min-w-0 truncate font-medium text-foreground">
        {label}
      </span>
    )
  const crumbs = [
    staged ? crumb("Phases", level > 0 ? () => (setStepId(null), setPhaseAt(null)) : null) : null,
    phase ? crumb(staged ? phaseLabel(phase, phaseAt!) : "Steps", level > 1 ? () => setStepId(null) : null) : null,
    step ? crumb(stepNameOf(step), null) : null,
  ].filter(Boolean)

  return (
    <div className="min-w-0">
      <nav aria-label="Run" className="mb-2 flex h-6 min-w-0 items-center gap-1 text-sm">
        {(level === 2 || (level === 1 && staged)) && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={back}
            title="Back"
            className="-ms-1 text-muted-foreground"
          >
            <ChevronLeftIcon className="size-3.5" />
          </Button>
        )}
        {crumbs.map((node, i) => (
          <React.Fragment key={i}>
            {i > 0 && <ChevronRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />}
            {node}
          </React.Fragment>
        ))}
      </nav>

      {level === 0 && (
        <ol className="min-w-0 space-y-1">
          {phases.map((ph, i) => {
            const own = ph.steps.map(stateOfStep)
            const state = phaseState(own)
            const running = ph.steps.find((s) => s.group?.active)?.group
            return (
              <li key={ph.name ?? i} className="flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPhaseAt(i)}
                  className={cn(
                    "group/phase flex w-full min-w-0 flex-1 items-center gap-2 rounded-2xl border bg-card p-2 text-start transition-colors outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    state === "running" ? "border-primary/30" : state === "failed" ? "border-destructive/30" : ""
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums",
                      state === "completed" && "bg-success/10 text-success",
                      state === "running" && "bg-primary/15 text-primary",
                      state === "failed" && "bg-destructive/10 text-destructive",
                      (state === "pending" || state === "cancelled" || state === "disconnected") &&
                        "bg-muted text-muted-foreground"
                    )}
                  >
                    {state === "completed" ? <CheckIcon className="size-3" /> : i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{phaseLabel(ph, i)}</span>
                    <span
                      className={cn(
                        "block truncate text-xs text-muted-foreground",
                        running && "harness-shimmer"
                      )}
                    >
                      {running
                        ? [stepNameOf(running), currentActivity(running)].filter(Boolean).join(" — ")
                        : `${own.length} ${own.length === 1 ? "step" : "steps"}${own.length > 1 ? " in parallel" : ""}`}
                    </span>
                  </span>
                  {/* The phase's own strip — a segment per step. */}
                  <span aria-hidden className="hidden w-20 shrink-0 gap-0.5 @panel-sm:flex">
                    {own.map((st, k) => (
                      <span key={k} className={cn("h-1 flex-1 rounded-full", SEGMENT[st])} />
                    ))}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {own.filter((s) => s === "completed").length}/{own.length}
                  </span>
                  <ChevronRightIcon
                    aria-hidden
                    className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover/phase:translate-x-0.5"
                  />
                </button>
                <PhaseHold phase={ph} />
              </li>
            )
          })}
        </ol>
      )}

      {level === 1 && phase && (
        <div className="grid min-w-0 grid-cols-1 gap-2 @panel-sm:grid-cols-2">
          {phase.steps.map((st, i) => (
            <StepCard
              key={st.group?.id ?? i}
              name={st.name}
              group={st.group}
              selected={false}
              onPick={setStepId}
            />
          ))}
        </div>
      )}

      {level === 2 && step && (
        <div className="min-w-0">
          <StepView key={step.id} group={step} showTimestamps={showTimestamps} variant="body" />
        </div>
      )}
    </div>
  )
}

/** The run's head: its mark, name, state badge and the line under it. */
function RunHead({
  open,
  onToggle,
  icon: Icon,
  name,
  badge,
  caption,
  active,
  paused,
}: {
  open: boolean
  onToggle: () => void
  icon: React.ComponentType<{ className?: string }>
  name: string
  badge: readonly [string, string]
  caption?: string
  active: boolean
  paused: boolean
}) {
  const inner = (
    <>
      <span
        aria-hidden
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-lg",
          KIND_CHIPS.other,
          KIND_COLORS.other
        )}
      >
        <Icon className="size-3.5 group-hover/run:hidden" />
        <ChevronRightIcon
          className={cn("hidden size-3.5 transition-transform group-hover/run:block", open && "rotate-90")}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium leading-7">{name}</span>
          <Badge variant="secondary" className={badge[1]}>
            {badge[0]}
          </Badge>
        </span>
        {caption && (
          <span
            className={cn(
              "-mt-1 block truncate text-sm leading-5 text-muted-foreground",
              active && !paused && "harness-shimmer"
            )}
          >
            {caption}
          </span>
        )}
      </span>
    </>
  )
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="group/run flex min-w-0 flex-1 items-start gap-2 text-start"
    >
      {inner}
    </button>
  )
}

/** The layout picker: the run's own, and the Agents panel's with one more. */
export function RunViewTabs<V extends string>({
  views,
  value,
  onChange,
  label,
  className,
}: {
  views: { id: V; label: string; icon: React.ComponentType<{ className?: string }> }[]
  value: V
  onChange: (view: V) => void
  label: string
  className?: string
}) {
  return (
    <div className={cn("flex flex-wrap gap-0.5", className)} role="group" aria-label={label}>
      {views.map((mode) => (
        <Button
          key={mode.id}
          type="button"
          variant="ghost"
          size="xs"
          aria-pressed={value === mode.id}
          onClick={() => onChange(mode.id)}
          className={value === mode.id ? "bg-muted text-foreground" : "text-muted-foreground"}
        >
          <mode.icon aria-hidden />
          {mode.label}
        </Button>
      ))}
    </div>
  )
}

/** One outline in the picked layout, with the picked step opened under it.
    Owns the pick, so a run card and the Agents panel each keep their own. */
export function RunLayout({
  phases,
  view,
  active,
  stepRow: StepView,
  showTimestamps,
  fill = false,
}: {
  phases: PhaseView[]
  view: RunView
  active: boolean
  stepRow: StepRowComponent
  showTimestamps?: boolean
  /** The flowchart takes the whole of a flex column, and a picked step
      scrolls in a strip under it — the Agents panel, where the drawing is
      the panel. Without it (a card in the scrolling transcript, which has no
      height to fill) the chart bleeds to the card's edges at a height of its
      own. Only the flowchart reads it; the other layouts scroll. */
  fill?: boolean
}) {
  const [picked, setPicked] = React.useState<string | null>(null)
  const { showTokens } = useLayoutOptionsContext()
  /* A second click on the picked card puts it away again. */
  const pick = (id: string) => setPicked((current) => (current === id ? null : id))
  const pickedStep = picked
    ? (phases.flatMap((phase) => phase.steps).find((step) => step.group?.id === picked)?.group ?? null)
    : null
  /* A run with a hold is always drawn with its headings, so the toggle has
     somewhere to sit even when it is the only phase there is. */
  const staged = phases.length > 1 || phases.some((phase) => phase.hold)
  const viewProps: ViewProps = { phases, staged, picked, pick, active, stepRow: StepView, showTimestamps }
  const holds = phases.filter((phase) => phase.hold)
  return (
    <>
      {/* The flowchart has no headings, so its runs' toggles stand above it. */}
      {view === "flowchart" && holds.length > 0 && (
        <div className={cn("flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground", fill ? "px-3 py-1" : "pb-2")}>
          {holds.map((phase, i) => (
            <span key={i} className="inline-flex min-w-0 items-center gap-0.5">
              <span className="truncate">{phase.name}</span>
              <PhaseHold phase={phase} />
            </span>
          ))}
        </div>
      )}
      {view === "flowchart" && (
        <div
          className={cn(
            "flex flex-col",
            fill ? "min-h-0 flex-1" : "-mx-2 h-[min(70vh,600px)] min-h-64 border-y"
          )}
        >
          <React.Suspense fallback={<div className="flex-1" />}>
            <WorkflowGraph
              phases={phases.map((phase) => ({
                name: phase.name,
                steps: phase.steps.map((step) => ({
                  id: step.group?.id ?? null,
                  name: step.name || (step.group ? stepNameOf(step.group) : ""),
                  state: stateOfStep(step),
                  startedAt: step.group?.head.startedAt,
                  updates: step.group?.active ? recentActivity(step.group) : undefined,
                  result: step.group && !step.group.active ? stepResultOf(step.group) : undefined,
                  tokens: stepTokensLabel(step.group, showTokens) ?? undefined,
                })),
              }))}
              selectedId={pickedStep ? picked : null}
              onSelect={pick}
            />
          </React.Suspense>
        </div>
      )}
      {view === "board" && <BoardView {...viewProps} />}
      {view === "list" && <ListView {...viewProps} />}
      {view === "timeline" && <TimelineView {...viewProps} />}
      {view === "browse" && <BrowseView {...viewProps} />}
      {/* The picked step opens as the same row it would be on its own, under
          the drawing — the transcript stays in place. List and browse already
          draw their steps' rows. */}
      {pickedStep && view !== "list" && view !== "browse" && (
        <div
          className={cn(
            "mt-2 min-w-0 border-t pt-2",
            fill && view === "flowchart" && "mt-0 max-h-[45%] shrink-0 overflow-y-auto px-3 pb-3"
          )}
        >
          <StepView group={pickedStep} showTimestamps={showTimestamps} />
        </div>
      )}
    </>
  )
}

/** The shape strip: one segment per step in outline order, phases separated
    by a wider gap, so a run's shape and how far along it is read at a glance. */
export function RunStrip({ phases, className }: { phases: PhaseView[]; className?: string }) {
  if (!phases.some((phase) => phase.steps.length > 0)) return null
  return (
    <div className={cn("flex gap-1", className)} aria-hidden>
      {phases.map((phase, p) => (
        <div key={phase.name ?? p} className="flex flex-1 gap-0.5" style={{ flexGrow: phase.steps.length }}>
          {phase.steps.map((step, i) => (
            <span
              key={step.group?.id ?? i}
              title={step.name || (step.group ? stepNameOf(step.group) : "")}
              className={cn("h-1 flex-1 rounded-full transition-colors", SEGMENT[stateOfStep(step)])}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * Every agent a thread launched as one outline, in transcript order — so the
 * run layouts read the whole thread the way they read one run: a workflow
 * keeps its own phases (named after the run), a batch is a phase, and each
 * stretch of lone subagents between them is one.
 */
export function agentOutline(rows: Row[]): PhaseView[] {
  const phases: PhaseView[] = []
  let loose: PhaseView | null = null
  for (const row of rows) {
    if (row.kind === "subagent-group") {
      if (!loose) phases.push((loose = { name: "Subagents", steps: [] }))
      loose.steps.push({ name: "", group: row })
      continue
    }
    if (row.kind === "workflow-group") {
      const hold = holdOf(row)
      phasesOf(row).forEach((phase, i) =>
        phases.push({ ...phase, name: phase.name ? `${row.name} · ${phase.name}` : row.name, hold: i === 0 ? hold : undefined })
      )
    } else if (row.kind === "subagent-batch") {
      phases.push({ name: batchNameOf(row), steps: row.steps.map((group) => ({ name: "", group })) })
    } else continue
    loose = null
  }
  return phases
}

/**
 * A set of subagents in the transcript — a harness workflow run, or the N
 * workers an agent fired side by side — as **an expandable run card**.
 *
 * Folded, the card is a header (name, state, readings, the hold toggle), the
 * line about what is being written right now, and a segmented progress strip:
 * one segment per step in definition order, phases separated by a wider gap,
 * so the run's whole shape and how far along it is read at a glance. Opened,
 * it is a board: a column per phase, in the order they run, each headed by its
 * name and `done/total`, its steps compact cards (state, name, elapsed, and
 * what a running one is on). Clicking a card opens that step under the board
 * as the same subagent row it would be on its own. A flat definition and every
 * batch are one unnamed phase, so their cards wrap as a grid instead.
 *
 * A workflow knows its shape up front and a batch does not — the plan rides
 * every workflow spawn's `_meta`, so the strip and the board are whole from
 * the first spawn, the steps ahead of the run drawn as pending.
 */
function RunRow({
  name,
  steps: runSteps,
  plan,
  icon: Icon,
  countNoun,
  showTimestamps,
  stepRow: StepView,
  paused = false,
  control,
}: {
  name: string
  steps: SubagentGroup[]
  plan?: WorkflowGroup["plan"]
  /** The run is held (a harness workflow's `_daedalus/workflow_state`). */
  paused?: boolean
  /** A control in the header — the hold toggle. Outside the disclosure button,
      because a button may not hold a button. */
  control?: React.ReactNode
  icon: React.ComponentType<{ className?: string }>
  /** What the `2/9` counts — "steps" of a definition, "done" of a batch, which
      has no shape beyond the workers in it. */
  countNoun: string
  showTimestamps?: boolean
  stepRow: StepRowComponent
}) {
  const view = useLayoutOptionsContext()
  const phases = phasesOf({ steps: runSteps, plan })
  const staged = phases.length > 1
  const all = phases.flatMap((p) => p.steps)
  const stateOf = (step: { group: SubagentGroup | null }): StepState =>
    step.group ? stepStateOf(step.group) : "pending"
  const [runView, setRunView] = React.useState<RunView>("browse")
  const active = runSteps.some((step) => step.active)
  const states = all.map(stateOf)
  const done = states.filter((s) => s === "completed").length
  const failedCount = states.filter((s) => s === "failed").length
  /* The outline's count, so "1/9 steps" is honest while the later steps have
     not been spawned yet; a run with no outline falls back to what arrived. */
  const total = Math.max(
    all.length,
    ...runSteps.map((s) => (s.head.kind === "subagent" ? (s.head.workflow?.total ?? 0) : 0))
  )
  const started = runSteps.map((step) => step.head.startedAt)
  const startedAt = started.length ? Math.min(...started) : 0
  /* Live while it runs; once settled, start-to-last-activity — an
     approximation, and the honest one available (see `lastActivityAt`). */
  const liveMs = useElapsed(startedAt, active && startedAt > 0)
  const settledEnd = Math.max(0, ...runSteps.map((s) => lastActivityAt(s.children)))
  const ms = active ? liveMs : settledEnd > startedAt ? settledEnd - startedAt : null
  /* The run's cost is its steps' — a workflow spends nothing of its own. */
  const tokens = view.showTokens ? sumUsage(runSteps.map(stepUsage)) : null
  const runningStep = all.find((step) => step.group?.active)?.group ?? null
  const runningPhase = runningStep
    ? (phases.find((phase) => phase.steps.some((s) => s.group === runningStep))?.name ?? null)
    : null
  const where = runningStep ? [runningPhase, stepNameOf(runningStep)].filter(Boolean).join(" · ") : ""
  /* Which step is being written and what it is on this second; settled, the
     line admits to a failure instead, so a folded run never hides one. */
  const caption = paused
    ? where
    : runningStep
      ? [where, currentActivity(runningStep)].filter(Boolean).join(" — ")
      : failedCount > 1
        ? `${failedCount} steps failed`
        : failedCount === 1
          ? `${stepNameOf(all.find((s) => stateOf(s) === "failed")!.group!)} failed`
          : undefined
  const badge = BADGE[paused ? "paused" : active ? "running" : failedCount > 0 ? "failed" : "completed"]

  /* A run that is running when it mounts opens itself, and then stays where
     the reader leaves it; the view option re-applies the default. */
  /* Remembered across the row going dormant (`lib/row-open`), keyed by the
     run's first step: a revived card that opened itself while it ran must not
     come back closed because it is no longer running. */
  const [open, setOpen] = useRowState(
    runSteps[0] && `wf:${runSteps[0].id}`,
    active || view.showToolDetails,
    view.showToolDetails
  )
  const firstSetting = React.useRef(view.showToolDetails)
  React.useEffect(() => {
    if (firstSetting.current === view.showToolDetails) return
    firstSetting.current = view.showToolDetails
    setOpen(view.showToolDetails)
  }, [view.showToolDetails])

  /* The head's readings and the shape strip are declared once for the card. */
  const meta = (
    <StepMeta
      parts={[
        total > 0 ? `${done}/${total} ${countNoun}` : null,
        ms !== null && ms >= 2000 ? formatElapsed(ms) : null,
        tokens ? <TokenSummary usage={tokens} label="This run" /> : null,
      ]}
    />
  )
  const body = (
    <>
      <RunViewTabs
        views={RUN_VIEWS}
        value={runView}
        onChange={setRunView}
        label="Run view"
        className="pb-2"
      />
      <RunLayout phases={phases} view={runView} active={active} stepRow={StepView} showTimestamps={showTimestamps} />
    </>
  )

  const steps =
    all.length === 0 ? (
      <div className={cn("text-sm text-muted-foreground", active && "harness-shimmer")}>
        {active ? "Starting…" : "No steps ran"}
      </div>
    ) : (
      body
    )

  return (
    <Card size="sm" className="my-2 gap-0 py-0">
      <div className="flex min-w-0 items-start gap-2 p-2 pb-0">
        <RunHead
          open={open}
          onToggle={() => setOpen((v) => !v)}
          icon={Icon}
          name={name}
          badge={badge}
          caption={caption}
          active={active}
          paused={paused}
        />
        <span className="flex h-7 shrink-0 items-center gap-2">
          {meta}
          {control}
        </span>
      </div>

      <RunStrip phases={phases} className="px-2 pt-2 pb-2" />

      {open && <div className="min-w-0 border-t p-2">{steps}</div>}
    </Card>
  )
}

/** A harness workflow run (`WorkflowGroup`) as the row above. */
export const WorkflowRun = React.memo(function WorkflowRun({
  group,
  showTimestamps,
  stepRow,
}: {
  group: WorkflowGroup
  showTimestamps?: boolean
  stepRow: StepRowComponent
}) {
  const hold = holdOf(group)
  /* Paused is read off the steps even once the toggle is gone, for the badge. */
  const paused = group.steps.some((s) => s.head.kind === "subagent" && s.head.workflow?.paused)
  return (
    <RunRow
      name={group.name}
      steps={group.steps}
      plan={group.plan}
      icon={WorkflowIcon}
      countNoun="steps"
      showTimestamps={showTimestamps}
      stepRow={stepRow}
      paused={paused}
      control={hold ? <WorkflowHold {...hold} /> : undefined}
    />
  )
})
WorkflowRun.displayName = "WorkflowRun"

/** The hold toggle on a run's row. Posts straight to the run's route: the
    answer comes back as the journaled `_daedalus/workflow_state`, which is
    what redraws the card — so nothing is set here. */
function WorkflowHold({ sessionId, runId, paused }: { sessionId: string; runId: string; paused: boolean }) {
  const settings = useServer()
  const [busy, setBusy] = React.useState(false)
  const toggle = async () => {
    setBusy(true)
    try {
      await api(settings, `/api/sessions/${sessionId}/workflows/${runId}/${paused ? "resume" : "pause"}`, {
        method: "POST",
        body: "{}",
      })
    } catch (err) {
      reportError(err, paused ? "Couldn't resume the workflow" : "Couldn't pause the workflow")
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      disabled={busy}
      onClick={() => void toggle()}
      title={paused ? "Resume the workflow" : "Pause the workflow after the steps in flight"}
      // No margin of its own: it is the row's own trailing slot now, so the
      // row's gap is the gap (see StepRow's `control`).
      className={paused ? "text-primary hover:text-primary" : "text-muted-foreground"}
    >
      {paused ? <PlayIcon /> : <PauseIcon />}
      <span className="sr-only">{paused ? "Resume" : "Pause"}</span>
    </Button>
  )
}

function batchNameOf(group: SubagentBatch): string {
  const kinds = new Set(
    group.steps
      .map((step) => (step.head.kind === "tool" ? extractSubagent(step.head)?.agentType : step.head.name))
      .filter((kind): kind is string => Boolean(kind))
  )
  const count = group.steps.length
  return kinds.size === 1 ? `${count} × ${[...kinds][0]}` : `${count} subagents`
}

/**
 * The subagents an agent fired side by side (`SubagentBatch`) as the same row.
 * No definition wrote this one, so its name has to be read off the workers
 * themselves: the kind of agent when they all agree — which is the common
 * case, since a batch is usually one job split N ways — and a plain count when
 * they do not. Never a step's own description: three of them would have to fit
 * on one line, and the list says all three in full.
 */
export const SubagentBatchRun = React.memo(function SubagentBatchRun({
  group,
  showTimestamps,
  stepRow,
}: {
  group: SubagentBatch
  showTimestamps?: boolean
  stepRow: StepRowComponent
}) {
  return (
    <RunRow
      name={batchNameOf(group)}
      steps={group.steps}
      icon={BotIcon}
      countNoun="done"
      showTimestamps={showTimestamps}
      stepRow={stepRow}
    />
  )
})
SubagentBatchRun.displayName = "SubagentBatchRun"
