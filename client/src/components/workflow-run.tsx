import * as React from "react"
import type * as acp from "@daedalus/acp"
import { BotIcon, CircleDashedIcon, PauseIcon, PlayIcon, WorkflowIcon } from "lucide-react"
/* The workflow/subagent *run* surfaces — a run in the transcript, and the
   list of its steps underneath it.

   **A run is a step.** It draws through the same `StepRow` every tool,
   thought and subagent draws through: one quiet line that opens in place. Its
   steps are the transcript's own subagent rows, injected as `stepRow` — so
   there is exactly one row vocabulary in a transcript, and reading a workflow
   is reading the same rows one level in.

   This replaces a preview card and a modal dialog: a bordered card with an
   icon tile, a state pill, a progress bar, a fact line and a live foot, over
   a dialog that restated all five and drew its own step rows, phase rules and
   colour table. Nine hundred lines of a second design language, to say what a
   row already says — and a modal to read it in, which takes the transcript off
   the screen to show a part of it. Opening in place keeps the run where it
   happened.

   The import runs one way: thread-items renders `WorkflowRun` /
   `SubagentBatchRun` from here, so nothing in this file may import
   thread-items back (the same rule that keeps `tool-parts.tsx` under
   tool-views and thread-items rather than either importing the other). Hence
   `stepRow`: the step row is `SubagentStep`, which is in the mutually
   recursive cluster over there and reaches this file as a prop. The helpers
   both files read (`collectTools`, `useStepThread`, `subagentHasBody`,
   `stepUsage`, `stepNameOf`) are declared *here* and imported by thread-items,
   because the one-way edge already points this way. */
import { formatElapsed, RAIL_CLASS, StepRow, useElapsed } from "@/components/step-row"
import { TokenFigure } from "@/components/token-usage"
import { KIND_CHIPS, KIND_COLORS } from "@/components/tool-parts"
import { extractSubagent, toolHeading } from "@/lib/tools"
import type { Row, SubagentBatch, SubagentGroup, WorkflowGroup } from "@/lib/transcript-rows"
import { sumUsage } from "@/lib/tokens"
import { cn } from "@/lib/utils"
import { useViewOptionsContext } from "@/lib/view-options"
import { useStoreSelect, type ToolItem } from "@/lib/store"
import { reportError } from "@/lib/errors"
import { useServer } from "@/lib/server-context"
import { api } from "@/lib/settings"

/** How a run draws one of its steps: `SubagentStep` from thread-items, which
    is the same row the step would draw as on its own. A component prop
    because it recurses into `RowView` and must stay over there (see the
    header comment). */
export type StepRowComponent = React.ComponentType<{
  group: SubagentGroup
  showTimestamps?: boolean
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
    else if (row.kind === "subagent-group") {
      if (row.head.kind === "tool") out.push(row.head)
      out.push(...collectTools(row.children))
    } else if (row.kind === "workflow-group" || row.kind === "subagent-batch")
      out.push(...collectTools(row.steps))
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
    Boolean(group.head.prompt || group.head.report || group.head.activity || group.head.transcript)
  return (
    group.head.kind === "tool" ||
    group.children.length > 0 ||
    group.active ||
    stepThread !== null ||
    previews
  )
}

/** What a step spent, when its runtime reported it. Only the RFD/workflow head
    has one: a Task-tool head is a call on the *parent's* session, so its tokens
    are already inside the parent turn's own reading and counting them here
    would say the same tokens twice. */
export function stepUsage(group: SubagentGroup): acp.Usage | undefined {
  return group.head.kind === "subagent" ? group.head.usage : undefined
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

/** A step's state as one word, from either kind of head. A step the runner has
    not spawned yet has no group at all — see `PendingStepRow`. */
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
function lastActivityAt(rows: Row[]): number {
  let last = 0
  for (const row of rows) {
    if (row.kind === "run") for (const item of row.items) last = Math.max(last, item.at ?? 0)
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
interface PhaseView {
  /** Null for a definition written as a flat step list — one unnamed phase. */
  name: string | null
  steps: { name: string; group: SubagentGroup | null }[]
}

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

/**
 * A step of the definition that has not spawned yet: the outline says it
 * exists, and nothing else about it is known. `StepRow`'s geometry with
 * nothing to open, so the list shows the run's whole shape from the first step
 * rather than growing a row at a time — and so the shape does not *change* as
 * the run advances, which is what makes a reader lose their place.
 */
function PendingStepRow({ name }: { name: string }) {
  return (
    <div className="flex min-w-0 items-start gap-2 py-0.5">
      <span aria-hidden className="flex h-6 w-3.5 shrink-0 items-center justify-center text-muted-foreground/30">
        <CircleDashedIcon className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate text-xs leading-6 text-muted-foreground/45">
        <span className="sr-only">pending: </span>
        {name}
      </span>
      {/* A trailing word rather than a blank: a column of blanks reads as
          missing data rather than as work not yet done. */}
      <span className="shrink-0 text-[11px] leading-6 text-muted-foreground/40">waiting</span>
    </div>
  )
}

/**
 * A set of subagents in the transcript — a harness workflow run, or the N
 * workers an agent fired side by side — as **one step row that opens into its
 * steps**.
 *
 * The line says what a passing reader needs: the run's name, how far along,
 * how long, what it cost, and — while it runs — the step being written and
 * what that step is on. Opening it lists the steps in the order they run,
 * each one the same subagent row it would be on its own, each opening its own
 * transcript in place. That is the whole design. There is no card, no dialog,
 * no second surface to navigate to and back from, and no geometry drawing a
 * sequence that a list states for free.
 *
 * One component for both kinds because they are one question asked twice: a
 * workflow knows its shape up front and an ad-hoc batch does not, which is the
 * whole of the difference — the plan rides every workflow spawn's `_meta`, so
 * the list shows every phase and every step from the first spawn on, the ones
 * ahead of the run drawn as pending rows, while a batch has exactly the steps
 * that were launched. A definition with no phases, and every batch, is one
 * unnamed phase and so gets no headings at all — a heading over the whole list
 * is a level with one child, which is a level to collapse.
 */
function RunRow({
  name,
  steps: runSteps,
  plan,
  icon,
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
  /** A control beside the metric — the hold toggle. Outside the row's own
      button, which is why it is a slot here and not part of `target`. */
  control?: React.ReactNode
  icon: React.ComponentType<{ className?: string }>
  /** What the `2/9` counts — "steps" of a definition, "done" of a batch, which
      has no shape beyond the workers in it. */
  countNoun: string
  showTimestamps?: boolean
  stepRow: StepRowComponent
}) {
  const view = useViewOptionsContext()
  const phases = phasesOf({ steps: runSteps, plan })
  const banded = phases.some((phase) => phase.name !== null)
  const all = phases.flatMap((p) => p.steps)
  const active = runSteps.some((step) => step.active)
  const states = all.map((step) => (step.group ? stepStateOf(step.group) : "pending"))
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
  /* The run's cost is its steps' — a workflow spends nothing of its own.
     Summed at view time rather than accumulated anywhere, so a step arriving
     late (or a replay rebuilding the lot) simply adds to it. */
  const tokens = view.showTokens ? sumUsage(runSteps.map(stepUsage)) : null
  const runningStep = all.find((step) => step.group?.active)?.group ?? null
  /* Which phase and which step are being written, and what that step is on —
     the one thing about a folded run worth a second line. Settled, the line is
     the run's shape instead, so a folded run still admits to a failure. */
  const runningPhase = runningStep
    ? (phases.find((phase) => phase.steps.some((s) => s.group === runningStep))?.name ?? null)
    : null
  const caption = paused
    ? [
        "paused",
        runningStep ? [runningPhase, stepNameOf(runningStep)].filter(Boolean).join(" · ") : "",
      ]
        .filter(Boolean)
        .join(" — ")
    : runningStep
    ? [
        [runningPhase, stepNameOf(runningStep)].filter(Boolean).join(" · "),
        currentActivity(runningStep),
      ]
        .filter(Boolean)
        .join(" — ")
    : failedCount > 0
      ? failedCount > 1
        ? `${failedCount} steps failed`
        : `${stepNameOf(all.find((s) => s.group && stepStateOf(s.group) === "failed")!.group!)} failed`
      : undefined

  return (
    <StepRow
      icon={icon}
      iconAccent={KIND_COLORS.other}
      iconChip={KIND_CHIPS.other}
      status={active ? "in_progress" : failedCount > 0 ? "failed" : "completed"}
      target={name}
      caption={caption}
      mono={false}
      metric={
        <>
          {total > 0 && `${done}/${total} ${countNoun}`}
          {ms !== null && ms >= 2000 && ` · ${formatElapsed(ms)}`}
          {tokens && " · "}
          {tokens && <TokenFigure usage={tokens} />}
          {control}
        </>
      }
      /* A run that is running when it mounts opens itself — it is the liveliest
         thing on the screen and a folded line is not what a reader wants of it
         — and then stays wherever the reader leaves it (StepRow reads its
         default once, so a list you were watching does not snap shut under
         you). A settled run, and every replayed one, is folded like every
         other step. */
      defaultOpen={active || view.showToolDetails}
      openSetting={view.showToolDetails}
      detail={
        /* The steps hang off the same rail a subagent's own rows do, so one
           level in reads as one level in wherever you are. */
        <div className={cn(RAIL_CLASS, "min-w-0")}>
          {all.length === 0 && (
            <div className={active ? "harness-shimmer text-xs text-muted-foreground/60" : "text-xs text-muted-foreground/60"}>
              {active ? "Starting…" : "No steps ran"}
            </div>
          )}
          {phases.map((phase, p) => (
            <React.Fragment key={phase.name ?? p}>
              {/* A heading over the whole list is a level with one child. So a
                  flat definition and every ad-hoc batch get none, and neither
                  does a definition that turned out to have exactly one phase:
                  the run's own name is already above it. */}
              {banded && phases.length > 1 && (
                <div className="pt-2 pb-0.5 text-[11px] leading-5 font-medium tracking-[0.08em] text-muted-foreground/50 uppercase first:pt-0">
                  {phase.name}
                </div>
              )}
              {phase.steps.map((step, i) =>
                step.group ? (
                  <StepView key={step.group.id} group={step.group} showTimestamps={showTimestamps} />
                ) : (
                  <PendingStepRow key={`${phase.name ?? ""}:${step.name}:${i}`} name={step.name} />
                )
              )}
            </React.Fragment>
          ))}
        </div>
      }
    />
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
  /* The hold is stamped on every step of the run (see the reducer), so any
     head says it; the thread the run belongs to rides the same stamp. The
     toggle is only offered while the run is live — a settled run has nothing
     to hold — and stays offered while held, since a held run has no active
     step to read liveness from. */
  const heads = group.steps.map((s) => (s.head.kind === "subagent" ? s.head : null))
  const info = heads.find((h) => h?.workflow)?.workflow
  const paused = heads.some((h) => h?.workflow?.paused)
  const live =
    paused ||
    group.steps.some((s) => stepStateOf(s) === "running") ||
    (info?.total !== undefined && group.steps.length < info.total)
  const runId = group.id.slice("workflow:".length)
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
      control={
        live && info?.sessionId ? (
          <WorkflowHold sessionId={info.sessionId} runId={runId} paused={paused} />
        ) : undefined
      }
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
    <button
      type="button"
      disabled={busy}
      onClick={() => void toggle()}
      title={paused ? "Resume the workflow" : "Pause the workflow after the steps in flight"}
      className={cn(
        "ml-1.5 inline-flex h-6 w-5 items-center justify-center rounded align-middle transition-colors",
        paused ? "text-primary hover:text-primary" : "text-muted-foreground/60 hover:text-foreground",
        busy && "opacity-50"
      )}
    >
      {paused ? <PlayIcon className="size-3" /> : <PauseIcon className="size-3" />}
      <span className="sr-only">{paused ? "Resume" : "Pause"}</span>
    </button>
  )
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
  const kinds = new Set(
    group.steps
      .map((step) => (step.head.kind === "tool" ? extractSubagent(step.head)?.agentType : step.head.name))
      .filter((kind): kind is string => Boolean(kind))
  )
  const count = group.steps.length
  const name = kinds.size === 1 ? `${count} × ${[...kinds][0]}` : `${count} subagents`
  return (
    <RunRow
      name={name}
      steps={group.steps}
      icon={BotIcon}
      countNoun="done"
      showTimestamps={showTimestamps}
      stepRow={stepRow}
    />
  )
})
SubagentBatchRun.displayName = "SubagentBatchRun"
