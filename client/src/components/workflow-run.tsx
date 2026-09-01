import * as React from "react"
import type * as acp from "@agentclientprotocol/sdk"
import {
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  MinusIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
/* The workflow/subagent *run* surfaces — the preview card in the transcript,
   the run dialog behind it, and the rows and headings inside that dialog —
   split out of `thread-items.tsx`, which keeps the transcript's own rows.

   The import runs one way: thread-items renders `WorkflowRun` /
   `SubagentBatchRun` from here, so nothing in this file may import
   thread-items back (the same rule that keeps `tool-parts.tsx` under
   tool-views and thread-items rather than either importing the other). Two
   consequences. The one piece of a step that is genuinely recursive —
   `SubagentBody`, whose rail draws `RowView` and so cannot leave the mutually
   recursive cluster in thread-items — is injected as the `stepBody` prop
   rather than imported. And the helpers both files read (`collectTools`,
   `useStepThread`, `subagentHasBody`, `stepUsage`) are declared *here* and
   imported by thread-items, because the one-way edge already points this
   way. */
import { formatElapsed, useElapsed } from "@/components/step-row"
import { TokenFigure, TokenSummary } from "@/components/token-usage"
import { extractSubagent, toolHeading } from "@/lib/tools"
import type { Row, SubagentBatch, SubagentGroup, WorkflowGroup } from "@/lib/transcript-rows"
import { formatTokens, sumUsage } from "@/lib/tokens"
import { cn } from "@/lib/utils"
import { useViewOptionsContext } from "@/lib/view-options"
import { useStoreSelect, type ToolItem } from "@/lib/store"

/** What thread-items' `SubagentBody` receives — the whole of what a step did,
    drawn under its row when it is opened. A component prop because the body
    recurses into `RowView` and must stay in thread-items (see the header
    comment). */
export interface StepBodyProps {
  group: SubagentGroup
  stepThread: string | null
  showTimestamps?: boolean
}

export type StepBodyComponent = React.ComponentType<StepBodyProps>

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
    } else if (row.kind === "workflow-group" || row.kind === "subagent-batch") out.push(...collectTools(row.steps))
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
  return group.head.kind === "tool" || group.children.length > 0 || group.active || stepThread !== null
}

/** What a *running* step is doing right now: the newest call still open, else
    the newest call at all. `summarise`'s counts are the right answer for a
    step that has finished and the wrong one while it works — "reading 2
    files" is what it did a minute ago. Read by the preview card's live line
    and by the run card's live line alike. */
function currentActivity(rows: Row[]): string | undefined {
  const tools = collectTools(rows)
  if (!tools.length) return undefined
  const open = [...tools].reverse().find((t) => t.status !== "completed" && t.status !== "failed")
  return toolHeading(open ?? tools[tools.length - 1]).title
}

/** A step's state as one word, from either kind of head. A step the runner has
    not spawned yet has no group at all — see `WorkflowPendingRow`. */
function stepStateOf(group: SubagentGroup): "running" | "completed" | "failed" | "cancelled" | "disconnected" {
  const head = group.head
  if (group.active) return "running"
  if (head.kind === "subagent") return head.state === "running" ? "running" : head.state
  return head.status === "failed" ? "failed" : head.status === "completed" ? "completed" : "running"
}

/** What a step spent, when its runtime reported it. Only the RFD/workflow head
    has one: a Task-tool head is a call on the *parent's* session, so its tokens
    are already inside the parent turn's own reading and counting them here
    would say the same tokens twice. */
export function stepUsage(group: SubagentGroup): acp.Usage | undefined {
  return group.head.kind === "subagent" ? group.head.usage : undefined
}

const WF_STATE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  running: LoaderCircleIcon,
  completed: CheckIcon,
  failed: XIcon,
  cancelled: MinusIcon,
  disconnected: MinusIcon,
}

/* ── One colour vocabulary for the whole run ──
   A run says the same six things in three places — the bar on the card, a
   step's mark, the state pill — and they were each choosing their own tints,
   so a failed step could read destructive in one and merely muted in the next.
   `WF_TONE` is the tint per state and `wfTone` is how every one of them asks
   for it. Two entries, not five: what was a `text`/`fill`/`border` per state
   went unread once the run stopped being drawn as bands and boards, and a
   colour nothing paints is a colour that drifts. */
type WfState = "pending" | "running" | "completed" | "failed" | "cancelled" | "disconnected"

const WF_TONE: Record<WfState, { chip: string; bar: string }> = {
  pending: { chip: "bg-muted text-muted-foreground/60", bar: "bg-muted-foreground/25" },
  running: { chip: "bg-primary/10 text-primary", bar: "bg-primary" },
  completed: { chip: "bg-muted text-muted-foreground", bar: "bg-primary/50" },
  failed: { chip: "bg-destructive/10 text-destructive", bar: "bg-destructive" },
  cancelled: { chip: "bg-muted text-muted-foreground/70", bar: "bg-muted-foreground/40" },
  disconnected: { chip: "bg-muted text-muted-foreground/70", bar: "bg-muted-foreground/40" },
}

const wfTone = (state: string) => WF_TONE[(state as WfState) in WF_TONE ? (state as WfState) : "completed"]

/** The run's state as one word, in the header. A word rather than another
    colour: the meter under it is already the colour, and "failed" is the thing
    a reader scrolling past a long transcript is looking for. */
function WorkflowPill({ state }: { state: WfState }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-pill px-1.5 py-0.5 text-[10px] font-medium leading-4 tracking-wide uppercase",
        wfTone(state).chip
      )}
    >
      {state === "completed" ? "done" : state}
    </span>
  )
}

/** The last moment anything happened under a step, for the duration of one
    that has finished: an item carries the time it arrived, and nothing
    records when a step *ended* — the store has no such field, and inventing
    one would mean the reducer marking steps done, which it never does. */
function lastActivityAt(rows: Row[]): number {
  let last = 0
  for (const row of rows) {
    if (row.kind === "run") for (const item of row.items) last = Math.max(last, item.at ?? 0)
    else if (row.kind === "subagent-group") last = Math.max(last, row.head.at ?? 0, lastActivityAt(row.children))
    else if (row.kind === "workflow-group" || row.kind === "subagent-batch")
      last = Math.max(last, lastActivityAt(row.steps))
    // Not every item kind is stamped (a plan has no arrival time of its own).
    else if ("at" in row) last = Math.max(last, row.at ?? 0)
  }
  return last
}

/** The name a step reads by: the definition's (`workflow.step`), not the
    agent's title for the thread — a table of steps should read as the workflow
    the user wrote. A launch call has no definition behind it, so it reads by
    the brief the agent gave that worker (`description`) and not by
    `toolHeading`'s title, which is the word "Task" for every one of them — a
    list of three identical rows names nothing. */
function stepNameOf(group: SubagentGroup, fallback?: string): string {
  const head = group.head
  const info = head.kind === "subagent" ? head.workflow : undefined
  const own =
    head.kind === "subagent"
      ? head.name || head.task
      : (extractSubagent(head)?.description ?? toolHeading(head).title)
  return info?.step || own || (fallback ?? "")
}

/** A step's one duration: live while it runs; once settled,
    start-to-last-activity — an approximation, and the honest one available
    (see `lastActivityAt`). A hook because the live half ticks. */
function useStepElapsed(group: SubagentGroup): number | null {
  const liveMs = useElapsed(group.head.startedAt, group.active)
  const settledEnd = lastActivityAt(group.children)
  const settledMs = settledEnd > group.head.startedAt ? settledEnd - group.head.startedAt : null
  return group.active ? liveMs : settledMs
}

/**
 * One step of the run, as **a row you can open in place**: a state mark, the
 * step's name, what it is on right now, its duration and cost — and, under it
 * when opened, the whole of what that step did.
 *
 * A row and not a card, and a disclosure and not an overlay, because both of
 * the shapes this replaced were the same mistake twice. A grid of cards spends
 * a dialog's width on chrome — a border, a lid, a tinted square and three lines
 * of foot per step — to say what one line says, and it reorders itself as the
 * dialog is resized, so the order the steps *run* in stopped being the order
 * they are read in. The overlay pane then took the run off the screen to show
 * one step of it, which is a navigation, with a Back button to undo. Opening in
 * place keeps the list under your eye, keeps the reading order fixed at one
 * column whatever the width, and makes the whole dialog one scroll rather than
 * three (list, pane, and the pane's own rail).
 *
 * One step is open at a time — an accordion, not a set of checkboxes. Partly
 * because a step is a whole transcript and mounting nine costs nine, and partly
 * because a list with several open is a list you have to scroll to re-find your
 * place in.
 *
 * A plain `<button aria-expanded>` and not a Base UI `Tabs.Tab`, which is what
 * the cards were. Tabs bought a roving focus (one tab stop, ↑/↓ between steps)
 * and charged for it: manual activation, a `Tabs.Panel` per step, a `value`
 * threaded through the dialog, and the rule that a panel may not sit inside the
 * list — which is the rule that forced the transcript out into an overlay in
 * the first place. A disclosure list is Tab to each row and Enter or Space to
 * open it, which is what a list of expandable rows is expected to do anywhere
 * else in the app, and it lets the body live where it belongs: under its row.
 */
function WorkflowStepRow({
  group,
  open,
  onToggle,
  showTimestamps,
  stepBody: StepBody,
}: {
  group: SubagentGroup
  open: boolean
  onToggle: () => void
  showTimestamps?: boolean
  stepBody: StepBodyComponent
}) {
  const active = group.active
  const state = stepStateOf(group)
  const failed = state === "failed"
  const stepThread = useStepThread(group)
  const expandable = subagentHasBody(group, stepThread)
  const ms = useStepElapsed(group)
  const Mark = WF_STATE_ICONS[state] ?? LoaderCircleIcon
  const view = useViewOptionsContext()
  const tokens = view.showTokens ? stepUsage(group) : undefined
  /* Live, the row says what the step is on right now — the one thing about a
     step you have not opened that is worth the room. */
  const activity = active ? currentActivity(group.children) : undefined
  /* Only a step that did not simply succeed spends a word on its state; the
     mark says the rest. */
  const word = state === "completed" || state === "running" ? null : state

  return (
    <div
      className={cn(
        "harness-fade-in overflow-hidden rounded-lg border transition-colors duration-150",
        open ? "border-border/70 bg-muted/20" : "border-transparent"
      )}
    >
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={onToggle}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-start",
          "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
          expandable ? "cursor-pointer hover:bg-muted/40" : "cursor-default"
        )}
      >
        <span
          aria-hidden
          className={cn("flex size-5 shrink-0 items-center justify-center rounded-md", wfTone(state).chip)}
        >
          <Mark className={cn("size-3", active && "animate-spin")} />
        </span>
        <span
          className={cn(
            "min-w-0 shrink-0 truncate text-sm leading-5",
            /* The name keeps its own width up to half the row; the activity
               beside it takes what is left. Both truncate, so neither can push
               the figures at the end off the row. */
            "max-w-[55%]",
            failed ? "text-destructive" : active ? "font-medium text-foreground" : "text-foreground/85"
          )}
        >
          {/* The mark is the only thing that states the state, and it is an
              icon — so say it once for a reader who cannot see one. */}
          <span className="sr-only">{state}: </span>
          <span className={active ? "harness-shimmer" : undefined}>{stepNameOf(group)}</span>
        </span>
        {activity && (
          <span className="harness-shimmer hidden min-w-0 flex-1 truncate text-xs leading-4 text-muted-foreground sm:block">
            {activity}
          </span>
        )}
        <span className="flex flex-1 items-center justify-end gap-1.5 text-xs leading-4 tabular-nums text-muted-foreground/70">
          {word && <span className={cn("shrink-0", failed && "text-destructive")}>{word}</span>}
          {ms !== null && <span className="shrink-0">{formatElapsed(ms)}</span>}
          {tokens && !open && (
            <span className="shrink-0">
              <TokenFigure usage={tokens} />
            </span>
          )}
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 transition-transform duration-150",
              open ? "rotate-90 text-muted-foreground" : "text-muted-foreground/40",
              !expandable && "invisible"
            )}
          />
        </span>
      </button>
      {open && expandable && (
        <div className="harness-fade-in border-t border-border/50 px-3 py-2.5">
          {/* The row itself is a button, so this is the one place a step can
              offer the whole breakdown rather than a bare figure. */}
          {tokens && (
            <div className="mb-2 flex justify-end">
              <TokenSummary
                usage={tokens}
                context={group.head.kind === "subagent" ? group.head.context : undefined}
                label="This step"
              />
            </div>
          )}
          <StepBody group={group} stepThread={stepThread} showTimestamps={showTimestamps} />
        </div>
      )}
    </div>
  )
}

/** A step of the definition that has not spawned yet: the outline says it
    exists, and nothing else about it is known. The same row, greyed and with
    nothing to open, so the list shows the run's whole shape from the first
    step rather than growing a row at a time — and so the shape does not
    *change* as the run advances, which is what makes a reader lose their
    place. A trailing word rather than a blank: a column of blanks reads as
    missing data rather than as work not yet done. */
function WorkflowPendingRow({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-transparent px-2 py-1.5">
      <span
        aria-hidden
        className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/30"
      >
        <CircleDashedIcon className="size-3" />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm leading-5 text-muted-foreground/50">
        <span className="sr-only">pending: </span>
        {name}
      </span>
      <span className="shrink-0 text-xs leading-4 text-muted-foreground/40">waiting</span>
      {/* Holds the column the open rows' chevrons sit in, so the names line up. */}
      <span aria-hidden className="size-3.5 shrink-0" />
    </div>
  )
}

/** One phase's steps, in definition order: the group the runner spawned for
    each, or null while it is still ahead of the run. */
interface PhaseView {
  /** Null for a definition written as a flat step list — one unnamed phase. */
  name: string | null
  steps: { name: string; group: SubagentGroup | null }[]
}

type PhaseState = "pending" | "running" | "completed" | "failed" | "cancelled"

/**
 * The run as phases of steps: the definition's outline (`group.plan`, stamped
 * on every spawn) filled in with the steps that have started.
 *
 * Without a plan — an older server, or a journal written before phases existed
 * — the arrived steps are the outline, in definition order, as one unnamed
 * phase; that is exactly the flat table the card drew before.
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

const stateOfStep = (step: PhaseView["steps"][number]): PhaseState | "disconnected" =>
  step.group ? stepStateOf(step.group) : "pending"

/** A phase reads as the worst thing that happened in it, then the liveliest. */
function phaseStateOf(phase: PhaseView): PhaseState {
  const states = phase.steps.map(stateOfStep)
  if (states.some((s) => s === "failed")) return "failed"
  if (states.some((s) => s === "running")) return "running"
  if (states.every((s) => s === "pending")) return "pending"
  if (states.some((s) => s === "pending")) return "running"
  if (states.some((s) => s === "cancelled" || s === "disconnected")) return "cancelled"
  return "completed"
}

/**
 * The run's progress on the **card**: one bar.
 *
 * It replaces a segmented track with a slot per stage, a weighted-flex row to
 * size those slots, and a "frontier pill" floating over the live one to name
 * the stage — three mechanisms and about sixty lines to say *2 of 9 done, one
 * of them is failing*, which is what the fact line beside it already says in
 * words. The card is a preview: it is read in passing, at the width of a
 * transcript column, and the only questions it has to answer are is it moving,
 * how far along, and did anything break. A bar answers all three, and the
 * stage the run is on is said in words on the foot line, where there is room
 * for it and where it is not competing with a shape.
 *
 * Spans throughout: the card's whole surface is a button, and a button holds
 * phrasing content.
 */
function RunProgress({ done, total, state }: { done: number; total: number; state: WfState }) {
  const pct = total ? (done / total) * 100 : 0
  /* A run that has started but finished nothing would draw an empty trough,
     which reads as "not started". A sliver says it is under way. */
  const shown = state === "running" ? Math.max(pct, 3) : pct
  /* No `role="progressbar"`: the bar lives inside the card's button, whose
     children are presentational, and whose own label states the same count in
     words. A role there would be an announcement nothing can reach. */
  return (
    <span aria-hidden className="block h-1.5 w-full overflow-hidden rounded-pill bg-border/50">
      <span
        aria-hidden
        className={cn(
          "block h-full rounded-pill transition-[width] duration-500",
          wfTone(state).bar,
          state === "running" && "animate-pulse"
        )}
        style={{ width: `${shown}%` }}
      />
    </span>
  )
}

/**
 * One stage of the run, as **a heading over its steps**: the stage's name, a
 * rule, its elapsed time and its `done/total`.
 *
 * A heading, because that is all a stage is here. It was a timeline node on a
 * rail before that, and a bordered column on a board before that, and both
 * spent a great deal of geometry — a disc masking a line, a ring, a ping halo,
 * a connector drawn inside each stage so it would run through the gap to the
 * next — to say one thing: *these run together, and only then does that lot
 * start*. A list already says it. The steps under a heading are the ones that
 * run together; the next heading is what follows. Stages are ordered top to
 * bottom, which is the order they run in, at every width — where the board's
 * columns reordered themselves at phone width and the timeline's rail had to
 * be redrawn to survive it.
 *
 * Its own component because each stage times itself and `useElapsed` is a
 * hook: a run's stages cannot be timed from a loop in the dialog.
 */
function WorkflowPhaseHeading({ phase }: { phase: PhaseView }) {
  const state = phaseStateOf(phase)
  const groups = phase.steps.map((s) => s.group).filter((g): g is SubagentGroup => g !== null)
  const startedAt = groups.length ? Math.min(...groups.map((g) => g.head.startedAt)) : 0
  const active = state === "running"
  const liveMs = useElapsed(startedAt, active && startedAt > 0)
  const settledEnd = Math.max(0, ...groups.map((g) => lastActivityAt(g.children)))
  const settledMs = startedAt > 0 && settledEnd > startedAt ? settledEnd - startedAt : null
  const ms = active ? liveMs : settledMs
  const done = phase.steps.filter((s) => stateOfStep(s) === "completed").length
  const failed = state === "failed"

  return (
    <div className="flex items-center gap-2 px-2 pt-4 pb-1.5 first:pt-1">
      <span
        className={cn(
          "min-w-0 shrink truncate text-[11px] leading-4 font-semibold tracking-[0.08em] uppercase",
          failed ? "text-destructive" : active ? "text-foreground/80" : "text-muted-foreground/60",
          active && "harness-shimmer"
        )}
      >
        {phase.name}
      </span>
      {/* The rule is what makes a run of headings read as sections rather than
          as more rows: it fills whatever the name does not use. */}
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border/50" />
      {ms !== null && ms >= 2000 && (
        <span className="shrink-0 text-[11px] leading-4 tabular-nums text-muted-foreground/50">
          {formatElapsed(ms)}
        </span>
      )}
      <span className="shrink-0 text-[11px] leading-4 tabular-nums text-muted-foreground/60">
        {done}/{phase.steps.length}
      </span>
    </div>
  )
}

/* ── The run's numbers ──
   How many steps, how long, what it cost, what broke. One derivation and two
   renderings, because the card and the dialog are the same facts under
   different pressure: on the card they are a line inside a button (spans, one
   row, truncating), in the dialog they are the header's own content, with room
   to label each figure rather than lean on word order. Both put the *figure*
   in the foreground and the noun behind it — a run's second line used to be
   four dot-joined phrases of equal weight, which is a sentence to read rather
   than a reading to take. */
interface RunFact {
  label: string
  value: string
  tone?: "bad"
}

function RunFactsInline({ facts }: { facts: RunFact[] }) {
  return (
    <span className="flex min-w-0 items-center gap-2 truncate text-xs leading-4">
      {facts.map((fact, i) => (
        <React.Fragment key={fact.label}>
          {i > 0 && (
            <span aria-hidden className="shrink-0 text-muted-foreground/25">
              ·
            </span>
          )}
          <span className="shrink-0 tabular-nums">
            <span className={cn("font-semibold", fact.tone === "bad" ? "text-destructive" : "text-foreground/80")}>
              {fact.value}
            </span>{" "}
            <span className="text-muted-foreground/60">{fact.label}</span>
          </span>
        </React.Fragment>
      ))}
    </span>
  )
}

function RunFactsBlock({ facts }: { facts: RunFact[] }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1.5">
      {facts.map((fact) => (
        <div key={fact.label} className="flex items-baseline gap-1.5">
          <span
            className={cn(
              "text-base leading-5 font-semibold tabular-nums",
              fact.tone === "bad" ? "text-destructive" : "text-foreground"
            )}
          >
            {fact.value}
          </span>
          <span className="text-[11px] leading-5 tracking-[0.08em] text-muted-foreground/60 uppercase">
            {fact.label}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * A set of subagents in the transcript — a harness workflow run, or the N
 * workers an agent fired side by side — as a preview card: the run's name, its
 * numbers, one progress bar and, while it runs, the stage and step being
 * written. It opens the whole run as **one list** on click.
 *
 * A dialog rather than a table inside the transcript, because a run is N whole
 * threads and a transcript column is the wrong room to read one in. The card
 * answers only the passing reader's questions — is it moving, how far along,
 * did anything fail — and the dialog answers the rest.
 *
 * **The dialog is one scrolling list, top to bottom, and nothing else.** A
 * stage is a heading (`WorkflowPhaseHeading`), a step is a row
 * (`WorkflowStepRow`), and opening a step expands its transcript underneath it
 * in place. That is the whole design, and it is the third: a board of columns
 * with an overlay pane came first, then a timeline of nodes on a rail with a
 * grid of cards, and both were the same error — spending the dialog's geometry
 * on *drawing* a sequence that a list states for free, and then needing a
 * second surface (a pane, an overlay, a Back button) to show a step, because
 * the first surface had been spent on shape. The list has one scroll, one
 * column at every width, one reading order — the order the steps run in — and
 * one way in and out of a step. The things a CI run view is judged on
 * (progressive disclosure in place rather than navigating away; no layout that
 * reflows under the cursor; a shape that can grow as steps arrive) come out of
 * that shape rather than being fought for on top of it.
 *
 * One component for both because they are one question asked twice: a
 * workflow knows its shape up front and an ad-hoc batch does not, which is the
 * whole of the difference — the plan rides every workflow spawn's `_meta`, so
 * the list shows every stage and every step from the first spawn on, the ones
 * ahead of the run drawn as greyed rows, while a batch has exactly the steps
 * that were launched. A definition with no phases, and every batch, is one
 * unnamed phase and so gets no headings at all — a heading over the whole list
 * is a level with one child, which is a level to collapse.
 */
function RunCard({
  name,
  steps: runSteps,
  plan,
  icon: RunIcon,
  countNoun,
  ariaLabel,
  showTimestamps,
  stepBody,
}: {
  name: string
  steps: SubagentGroup[]
  plan?: WorkflowGroup["plan"]
  icon: React.ComponentType<{ className?: string }>
  /** What the `2/9` in the fact line counts — "steps" of a definition, "done"
      of a batch, which has no shape beyond the workers in it. */
  countNoun: string
  ariaLabel: string
  showTimestamps?: boolean
  stepBody: StepBodyComponent
}) {
  const phases = phasesOf({ steps: runSteps, plan })
  const banded = phases.some((phase) => phase.name !== null)
  const all = phases.flatMap((p) => p.steps)
  const active = runSteps.some((step) => step.active)
  const failed = phases.some((phase) => phaseStateOf(phase) === "failed")
  const done = all.filter((step) => stateOfStep(step) === "completed").length
  /* The outline's count, so "1/9 steps" is honest while the later steps have
     not been spawned yet; a run with no outline falls back to what arrived. */
  const total = Math.max(all.length, ...runSteps.map((s) => (s.head.kind === "subagent" ? (s.head.workflow?.total ?? 0) : 0)))
  const started = runSteps.map((step) => step.head.startedAt)
  const startedAt = started.length ? Math.min(...started) : 0
  const elapsedMs = useElapsed(startedAt, active && startedAt > 0)
  /* The run's own state, said once and read by the pill, the icon chip and the
     meter's tint. "Cancelled" is what is left when nothing failed and nothing
     ran to completion — a step the process died under. */
  const runState: WfState = failed
    ? "failed"
    : active
      ? "running"
      : all.length === 0
        ? "pending"
        : done === all.length
          ? "completed"
          : "cancelled"
  const runningPhase = phases.find((phase) => phaseStateOf(phase) === "running") ?? null
  const runningStep = all.find((step) => step.group?.active)?.group ?? null
  const failedSteps = all.filter((step) => step.group && stepStateOf(step.group) === "failed")
  const failedStep = failedSteps[0]?.group ?? null
  /* The run's cost is its steps' — a workflow spends nothing of its own. Summed
     at view time rather than accumulated anywhere, so a step arriving late (or
     a replay rebuilding the lot) simply adds to it. */
  const view = useViewOptionsContext()
  const runTokens = view.showTokens ? sumUsage(runSteps.map(stepUsage)) : null
  /* Counts belong under the name, not beside the pill: the pill is the run's
     state, this is its shape. Which *stage* is being written is no longer one
     of them — the meter names it now, under the segments that say how far into
     it the run is, so saying it here as well was the same fact twice. A count
     of failures is here rather than only in the foot line, because a run that
     has moved on from a failure still has to admit to it. */
  const facts: RunFact[] = [
    total > 0 ? { label: countNoun, value: `${done}/${total}` } : null,
    failedSteps.length > 0 ? { label: "failed", value: String(failedSteps.length), tone: "bad" as const } : null,
    elapsedMs !== null && elapsedMs >= 2000 ? { label: "elapsed", value: formatElapsed(elapsedMs) } : null,
    runTokens ? { label: "tokens", value: formatTokens(runTokens.totalTokens) } : null,
  ].filter((fact): fact is RunFact => fact !== null)
  /* The card's foot line: what is being written right now, else the step that
     failed — the two things a reader would open the dialog to find. The stage
     leads it, which is where "which stage is the run on" is now said: in words,
     on the one line that already exists for the live reading, rather than as a
     pill floating over a segmented bar. */
  const activity = runningStep ? currentActivity(runningStep.children) : undefined
  const liveLine = runningStep
    ? [
        [runningPhase?.name, stepNameOf(runningStep)].filter(Boolean).join(" · "),
        activity,
      ]
        .filter(Boolean)
        .join(" — ")
    : null

  const [open, setOpen] = React.useState(false)
  /* Which step is expanded, or none. Opening the dialog lands on the **list**,
     never on a step: auto-expanding would answer a question the reader has not
     asked yet and push the rest of the run off the screen at the moment they
     asked to see it. A step opened last time stays open, though — reopening a
     run you were reading is the one case where the step is what was asked
     for. */
  const [opened, setOpened] = React.useState<string | null>(null)
  const openPreview = (next: boolean) => setOpen(next)

  return (
    <ResponsiveDialog open={open} onOpenChange={openPreview}>
      {/* The whole card is the trigger — one target, no interactive rows left
          inside it — so its children are spans: a button holds phrasing
          content. A plain button rather than a `DialogTrigger`, because the
          modal here is the responsive one and on a phone its root is a Drawer:
          one trigger cannot render into both, and `openPreview` is what has to
          run either way (it is where the landing step is chosen). */}
      <button
        type="button"
        /* The card's whole state in its name: the bar is presentational inside
            a button and the fact line is spans, so without this a screen reader
            gets the run's title and nothing about how it is going. */
        aria-label={total > 0 ? `${ariaLabel} — ${runState}, ${done} of ${total} complete` : `${ariaLabel} — ${runState}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => openPreview(true)}
        className={cn(
          "group/wfc my-1.5 block w-full overflow-hidden rounded-xl border text-start",
          "transition-[border-color,box-shadow,background-color] duration-150 hover:shadow-sm",
          failed ? "border-destructive/25" : active ? "border-primary/25" : "border-border/60",
          "bg-card hover:border-border",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        )}
      >
        <span className="flex items-center gap-3 px-3 py-2.5">
          <span
            aria-hidden
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-xl",
              failed
                ? "bg-destructive/10 text-destructive"
                : active
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-muted-foreground/70"
            )}
          >
            <RunIcon className="size-4.5" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span
              className={cn(
                "truncate text-sm leading-5 font-semibold",
                failed ? "text-destructive" : "text-foreground",
                active && "harness-shimmer"
              )}
            >
              {name}
            </span>
            {facts.length > 0 && <RunFactsInline facts={facts} />}
          </span>
          <WorkflowPill state={runState} />
          {/* The one standing hint that the card opens: visible always, louder
              under the pointer — hover is not the only way in, just the first
              one discovered. */}
          <Maximize2Icon
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground/40 transition-colors duration-150 group-hover/wfc:text-muted-foreground"
          />
        </span>
        {/* One bar — see `RunProgress`. Drawn even before a step has spawned,
            because the outline is known from the first `_meta` the runner
            stamps, so the denominator is honest from the start. */}
        {total > 0 && (
          <span className="block px-3 pb-3">
            <RunProgress done={done} total={total} state={runState} />
          </span>
        )}
        {(liveLine || failedStep) && (
          <span className="flex items-center gap-2 border-t border-border/40 bg-muted/20 px-3 py-2">
            {liveLine ? (
              <>
                <LoaderCircleIcon aria-hidden className="size-3.5 shrink-0 animate-spin text-primary" />
                <span className="harness-shimmer min-w-0 truncate text-xs leading-4 text-muted-foreground">
                  {liveLine}
                </span>
              </>
            ) : (
              <>
                <XIcon aria-hidden className="size-3.5 shrink-0 text-destructive" />
                <span className="min-w-0 truncate text-xs leading-4 text-destructive">
                  {/* One failure reads by name — that is what the reader came
                      back for. Several would have to be a list the card has no
                      room for, so it says how many and the list names them. */}
                  {failedSteps.length > 1
                    ? `${failedSteps.length} steps failed`
                    : `${stepNameOf(failedStep!)} failed`}
                </span>
              </>
            )}
          </span>
        )}
      </button>
      {/* A centred dialog on a desktop, a bottom sheet on a phone — the run is
          N whole transcripts, which is exactly the content a phone wants as a
          sheet it can swipe away rather than a box inset from every edge.
          `bodyClassName` turns the shared scroll region off: the run's list
          owns the only scroll in here. */}
      {/* The dialog is sized to the run now, not to the screen. A board had to
          fill a fixed box or its columns had nothing to stand in; a list has a
          length, and a run of four steps in a box built for twenty reads as a
          dialog that failed to load. So on a desktop it grows with its content
          between a floor (a short run should still look like a dialog, and the
          box must not resize under the pointer as one step opens) and the
          screen. On a phone it stays a full-height sheet, which is what a
          bottom sheet is. It is also narrower than it was: one column of rows
          has no use for 72rem, and a line of text that long is hard to read. */}
      <ResponsiveDialogContent
        bodyClassName="overflow-hidden p-0"
        className={cn(
          "flex flex-col gap-0 overflow-hidden p-0",
          "h-[calc(100dvh-6rem)]",
          "md:h-auto md:min-h-[22rem] md:max-h-[min(46rem,calc(100svh-2rem))]",
          "md:w-[min(52rem,calc(100vw-3rem))] md:max-w-[calc(100vw-3rem)]"
        )}
      >
        {/* The card's header, restated where the card can no longer be seen:
            the dialog covers the transcript, so it has to say which run it is
            showing. `pr-12` clears the modal's own close button. */}
        <ResponsiveDialogHeader className="gap-3 px-4 py-3.5 pr-12">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className={cn(
                "flex size-10 shrink-0 items-center justify-center rounded-xl",
                failed
                  ? "bg-destructive/10 text-destructive"
                  : active
                    ? "bg-primary/10 text-primary"
                    : "bg-muted text-muted-foreground/70"
              )}
            >
              <RunIcon className="size-5" />
            </span>
            {/* The run's name gets the whole line here. The figures under it
                are the dialog's own reading — labelled, because a header with
                room for them should not make word order carry the meaning. */}
            <ResponsiveDialogTitle
              className={cn(
                "min-w-0 flex-1 truncate text-base leading-6 font-semibold",
                failed ? "text-destructive" : "text-foreground",
                active && "harness-shimmer"
              )}
            >
              {name}
            </ResponsiveDialogTitle>
            <WorkflowPill state={runState} />
          </div>
          {facts.length > 0 && <RunFactsBlock facts={facts} />}
        </ResponsiveDialogHeader>
        {/* The run: one list, one scroll, one column. A stage is a heading, a
            step is a row, and an open step's transcript is drawn under its own
            row — so there is no second surface to navigate to and back from,
            and no geometry drawing a sequence the list already states. */}
        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-2",
            "pb-[max(0.75rem,env(safe-area-inset-bottom))]"
          )}
        >
          {/* A run whose first spawn has arrived but whose outline has not (an
              older server) has nothing to list, and an empty dialog reads as
              broken rather than as a pipeline about to start. */}
          {all.length === 0 && (
            <div className={cn("p-3 text-sm text-muted-foreground/60", active && "harness-shimmer")}>
              {active ? "Starting…" : "No steps ran"}
            </div>
          )}
          {phases.map((phase, p) => (
            <React.Fragment key={phase.name ?? p}>
              {/* A heading over the whole list is a level with one child. So a
                  flat definition and every ad-hoc batch get none, and neither
                  does a definition that turned out to have exactly one stage:
                  the run's own name is already above it. */}
              {banded && phases.length > 1 && <WorkflowPhaseHeading phase={phase} />}
              {phase.steps.map((step, i) => {
                const group = step.group
                if (!group) return <WorkflowPendingRow key={`${phase.name ?? ""}:${step.name}:${i}`} name={step.name} />
                return (
                  <WorkflowStepRow
                    key={group.id}
                    group={group}
                    open={opened === group.id}
                    /* One at a time: a step is a whole transcript, so opening
                       the next closes the last and the list stays a list. */
                    onToggle={() => setOpened((current) => (current === group.id ? null : group.id))}
                    showTimestamps={showTimestamps}
                    stepBody={stepBody}
                  />
                )
              })}
            </React.Fragment>
          ))}
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

/** A harness workflow run (`WorkflowGroup`) as the card above. */
export const WorkflowRun = React.memo(function WorkflowRun({
  group,
  showTimestamps,
  stepBody,
}: {
  group: WorkflowGroup
  showTimestamps?: boolean
  stepBody: StepBodyComponent
}) {
  return (
    <RunCard
      name={group.name}
      steps={group.steps}
      plan={group.plan}
      icon={WorkflowIcon}
      countNoun="steps"
      ariaLabel={`Preview workflow ${group.name}`}
      showTimestamps={showTimestamps}
      stepBody={stepBody}
    />
  )
})
WorkflowRun.displayName = "WorkflowRun"

/**
 * The subagents an agent fired side by side (`SubagentBatch`) as the same
 * card. No definition wrote this one, so its name has to be read off the
 * workers themselves: the kind of agent when they all agree — which is the
 * common case, since a batch is usually one job split N ways — and a plain
 * count when they do not. Never a step's own description: three of them would
 * have to fit on one line, and the list says all three in full.
 */
export const SubagentBatchRun = React.memo(function SubagentBatchRun({
  group,
  showTimestamps,
  stepBody,
}: {
  group: SubagentBatch
  showTimestamps?: boolean
  stepBody: StepBodyComponent
}) {
  const kinds = new Set(
    group.steps
      .map((step) => (step.head.kind === "tool" ? extractSubagent(step.head)?.agentType : step.head.name))
      .filter((kind): kind is string => Boolean(kind))
  )
  const count = group.steps.length
  const name = kinds.size === 1 ? `${count} × ${[...kinds][0]}` : `${count} subagents`
  return (
    <RunCard
      name={name}
      steps={group.steps}
      icon={BotIcon}
      countNoun="done"
      ariaLabel={`Preview ${name}`}
      showTimestamps={showTimestamps}
      stepBody={stepBody}
    />
  )
})
SubagentBatchRun.displayName = "SubagentBatchRun"
