import * as React from "react"
import {
  ArrowUpRightIcon,
  BotIcon,
  CheckIcon,
  CircleDashedIcon,
  LoaderCircleIcon,
  MinusIcon,
  PlayIcon,
  WorkflowIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react"
import { ChevronRightIcon, CopyIcon } from "lucide-react"
import { Tabs } from "@base-ui/react/tabs"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import { ItemContextMenu } from "@/components/item-context-menu"
import { Message, MessageContent } from "@/components/ui/message"
/* The tool-call layouts and the boxes they are built from live in their own
   files — see the header comment on each. This one keeps the transcript's own
   rows: a message, a step, a plan, a compaction. The shared step chrome is
   `step-row.tsx` and the non-recursive leaf layouts are `thread-cards.tsx`;
   what stays here is the mutually recursive cluster (RowView / ThreadItemView
   / ToolRun / SubagentStep), which cannot move apart without a module cycle. */
import {
  FileBadge,
  KIND_ICONS,
  KIND_LABELS,
  Prose,
  Timestamp,
  ToolCallContent,
} from "@/components/tool-parts"
import {
  SubagentBrief,
  SubagentReport,
  ToolDetail,
  ToolSources,
  toolHasDetail,
  toolOpensByDefault,
} from "@/components/tool-views"
import { copyText, formatElapsed, StepRow, useElapsed, yieldToTextSelection } from "@/components/step-row"
import {
  AgentText,
  CompactionStep,
  ErrorRow,
  PlanStep,
  SourcesStrip,
  TaskNotificationCard,
} from "@/components/thread-cards"
import {
  childToolTitle,
  extractSubagent,
  parseTaskNotification,
  toolKindOf,
  toolHeading,
  webInput,
} from "@/lib/tools"
import type { Row, SubagentGroup, ToolRunGroup, WorkflowGroup } from "@/lib/transcript-rows"
import { cn } from "@/lib/utils"
import { useViewOptionsContext } from "@/lib/view-options"
import { useStore, type ThreadItem, type ToolItem } from "@/lib/store"
import { threadPath } from "@/lib/router"
import { Link } from "react-router"

/* Re-exported so the approval card and the editor panel keep importing the
   transcript's vocabulary from the transcript, not from its internals. */
export { FileBadge, KIND_ICONS, KIND_LABELS, Prose, Timestamp, ToolCallContent }
export { SourcesStrip }

/* The row shapes are `lib/transcript-rows`' — the transform that builds them
   is shared with the nested transcript a subagent step draws, and both this
   file and thread-view read them. Re-exported so callers keep importing the
   transcript's vocabulary from the transcript. */
export type { Row, SubagentGroup, ToolRunGroup, WorkflowGroup }

/** Natural-language summary: "reading 10 files, running 28 shell commands". */
const KIND_VERBS: Record<string, string> = {
  read: "reading",
  edit: "editing",
  delete: "deleting",
  move: "moving",
  search: "searching",
  execute: "running",
  think: "thinking",
  fetch: "fetching",
  switch_mode: "switching mode",
  other: "running",
  websearch: "searching the web",
  webfetch: "reading",
}

const KIND_NOUNS: Record<string, string> = {
  read: "file",
  edit: "file",
  delete: "file",
  move: "file",
  search: "search",
  execute: "shell command",
  think: "thought",
  fetch: "fetch",
  switch_mode: "mode change",
  other: "tool",
  websearch: "time",
  webfetch: "page",
}

const KIND_NOUNS_PLURAL: Record<string, string> = {
  search: "searches",
  fetch: "fetches",
  time: "times",
}

const pluralNoun = (noun: string, count: number) =>
  count === 1 ? noun : (KIND_NOUNS_PLURAL[noun] ?? `${noun}s`)

/** What the run actually did: "reading 10 files, running 28 shell commands", in the
    order the kinds first appeared. */
function summarise(items: ToolItem[]): { verb: string; noun: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const item of items) {
    // toolKindOf, not the raw field: a run of Bash calls from an agent that
    // omits `kind` should still summarise as "running 3 shell commands", not "3 tools".
    // The web's two acts are named apart from the `fetch` kind they share:
    // "searching the web 3 times, reading 2 pages" says what a run of
    // globe-icon rows did; "fetching 5 fetches" did not.
    const web = webInput(item)
    const kind = web?.query ? "websearch" : web?.url ? "webfetch" : toolKindOf(item)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return [...counts.entries()].map(([kind, count]) => ({
    verb: KIND_VERBS[kind] ?? KIND_VERBS.other,
    noun: KIND_NOUNS[kind] ?? KIND_NOUNS.other,
    count,
  }))
}

/** How much of a running group stays on screen without being expanded. */
const PEEK = 3

/** The rail nested steps hang off: one for a run and for a subagent's
    transcript alike, so a subagent's steps read as steps and not as a second
    kind of list. `ml-[calc(0.75rem-1px)]` puts the line under the parent
    row's icon column, and a rail inside a rail indents once more. */
const RAIL_CLASS = "mt-0.5 ml-[calc(0.75rem-1px)] space-y-0.5 border-l border-border/60 pl-2.5"

/** "N earlier steps" — the top of a peeking rail. */
function EarlierSteps({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-mx-1 block rounded px-1 text-[11px] leading-5 text-muted-foreground/70 transition-colors hover:text-foreground"
    >
      {count} earlier {count === 1 ? "step" : "steps"}
    </button>
  )
}

export const ToolRun = React.memo(function ToolRun({
  items,
  showTimestamps,
}: {
  items: ToolItem[]
  showTimestamps?: boolean
}) {
  /* Open by default. A group is only ever a run of tool calls with NOTHING
     between them — `groupToolRuns` breaks the run on the first non-tool item —
     so the summary line is a heading for steps that belong together, not a
     drawer to hide them in. Collapsing by default made the transcript go quiet
     exactly where the agent was busiest; text between tool calls is what
     separates one run from the next, and that already happens by splitting
     them into two groups. The disclosure stays: a 40-step run is still worth
     folding away by hand. */
  const [open, setOpen] = React.useState(true)
  const failed = items.filter((item) => item.status === "failed").length
  const active = items.some((item) => item.status === "in_progress" || item.status === "pending")
  const summary = summarise(items)

  const prose = summary
    .map(({ verb, noun, count }) => `${verb} ${count} ${pluralNoun(noun, count)}`)
    .join(", ")

  /* While the run is still going, the tail of it stays visible without being
     asked for. Collapsed-by-default is right for a finished run — it is
     history, and "read 12 files" is the whole of what you need from it — but
     the group the agent is working in right now is the one thing on screen
     that is actually happening, and folding it into a single counting line
     turns a live process into a number that ticks. Three: enough to see what
     it just did and what it is doing, few enough that the transcript is not
     re-expanding itself behind your back.

     `active` is the whole test — only the run the agent is inside has a
     pending or in_progress step — so this needs no notion of "the last
     group". The peek closes on its own when the run finishes. */
  const showing = open ? items : active ? items.slice(-PEEK) : []
  const hidden = active && !open ? items.length - showing.length : 0

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 py-0.5 text-start transition-colors duration-150 hover:bg-muted/40"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground/60 transition-transform duration-200",
            open && "rotate-90"
          )}
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs leading-6 text-muted-foreground",
            active && "harness-shimmer"
          )}
        >
          {prose}
        </span>
        {failed > 0 && (
          <span className="shrink-0 text-[11px] leading-6 text-destructive">{failed} failed</span>
        )}
      </button>
      {showing.length > 0 && (
        /* One rail for both states, so expanding a peeking run grows the list
           in place instead of swapping one layout for another. */
        <div className={RAIL_CLASS}>
          {hidden > 0 && <EarlierSteps count={hidden} onClick={() => setOpen(true)} />}
          {showing.map((item) => (
            <ToolStep key={item.id} item={item} showTimestamp={showTimestamps} />
          ))}
        </div>
      )}
    </div>
  )
})
ToolRun.displayName = "ToolRun"

/**
 * One row of the transcript, whichever shape `buildRows` gave it. The top
 * level and every subagent's rail draw through this, which is what makes a
 * nested transcript the same transcript — same step rows, same prose, same
 * grouping — and not a summary of one.
 */
export const RowView = React.memo(function RowView({
  row,
  onContinue,
  onRetry,
  onDismiss,
  showTimestamps,
  streaming,
}: {
  row: Row
  onContinue?: () => void
  onRetry?: () => void
  onDismiss?: () => void
  showTimestamps?: boolean
  /** This row is the transcript's tail and the turn is still open — it is the
      one thing still being written. Only a thought draws differently for it
      (see ThreadItemView); prose streams visibly on its own. */
  streaming?: boolean
}) {
  if (row.kind === "run") return <ToolRun items={row.items} showTimestamps={showTimestamps} />
  if (row.kind === "subagent-group") return <SubagentStep group={row} showTimestamps={showTimestamps} />
  if (row.kind === "workflow-group") return <WorkflowRun group={row} showTimestamps={showTimestamps} />
  return (
    <ThreadItemView
      item={row}
      onContinue={onContinue}
      onRetry={onRetry}
      onDismiss={onDismiss}
      showTimestamps={showTimestamps}
      streaming={streaming}
    />
  )
})
RowView.displayName = "RowView"

/** Every tool step a subagent ran, out of its rows — for the count on the
    step's header line. Its own subagents' steps count too: they are its work. */
function collectTools(rows: Row[]): ToolItem[] {
  const out: ToolItem[] = []
  for (const row of rows) {
    if (row.kind === "tool") out.push(row)
    else if (row.kind === "run") out.push(...row.items)
    else if (row.kind === "subagent-group") {
      if (row.head.kind === "tool") out.push(row.head)
      out.push(...collectTools(row.children))
    } else if (row.kind === "workflow-group") out.push(...collectTools(row.steps))
  }
  return out
}

/**
 * A subagent: the step that launched it, with everything it did underneath.
 *
 * Brief, then the rail of steps and prose, then the report — the order the
 * work happened in. Open while it runs (a worker's rail is the one live thing
 * on screen; folded, the transcript would go quiet exactly where the agent
 * is busiest) and left as it is when it finishes: StepRow reads its default
 * once, so a rail you were watching does not snap shut under you. The rail
 * peeks its last few steps while live, like a run does.
 *
 * `head` is a Task tool call (Claude Code, OpenCode, Codex's legacy rows) or
 * the session the agent announced (the ACP subagent RFD). The RFD's has no
 * brief or report of its own — the child's prose IS the report, and it is in
 * the rail — so those two halves are drawn only for a tool head.
 */
export const SubagentStep = React.memo(function SubagentStep({
  group,
  showTimestamps,
}: {
  group: SubagentGroup
  showTimestamps?: boolean
}) {
  const { head, children } = group
  const view = useViewOptionsContext()
  const tool = head.kind === "tool" ? head : null
  const session = head.kind === "subagent" ? head : null
  const call = tool ? extractSubagent(tool) : null
  /* The RFD's states onto the step vocabulary: `failed` is a failure,
     `cancelled`/`disconnected` are endings that are not — they get the word
     in the label column, in the quiet colour, rather than "failed". */
  const headStatus = tool
    ? tool.status
    : session!.state === "running"
      ? "in_progress"
      : session!.state === "failed"
        ? "failed"
        : "completed"
  const label =
    session && (session.state === "cancelled" || session.state === "disconnected") ? session.state : undefined
  /* Whether it is at work is the row builder's call (`subagentActive` in
     lib/transcript-rows), the same answer the count above the composer
     reads — a launch call can settle before its child does, and the head's
     own status alone would say "done" of a worker mid-rail. */
  const active = group.active
  const status = active ? "in_progress" : headStatus

  const target = tool ? (call?.description ?? toolHeading(tool).title) : session!.task || session!.name
  const caption = tool
    ? [call?.agentType, call?.model].filter(Boolean).join(" · ") || undefined
    : session!.name
  const steps = collectTools(children)
  const prose = summarise(steps)
    .map(({ verb, noun, count }) => `${verb} ${count} ${pluralNoun(noun, count)}`)
    .join(", ")
  const stepThread = useStepThread(group)
  const hasBody = subagentHasBody(group, stepThread)

  return (
    <StepRow
      icon={BotIcon}
      status={status}
      label={label}
      target={target}
      caption={caption}
      mono={false}
      startedAt={head.startedAt}
      metric={
        prose || showTimestamps ? (
          <>
            {prose}
            {prose && showTimestamps && " · "}
            {showTimestamps && <Timestamp at={head.at} />}
          </>
        ) : undefined
      }
      detail={hasBody ? <SubagentBody group={group} stepThread={stepThread} showTimestamps={showTimestamps} /> : undefined}
      /* Folded by default, live or not: the shimmering title and the step
         count say enough at a glance, and the rail is one click away. Only
         the "show tool details" option opens it unasked, as it does every
         other tool row. */
      defaultOpen={view.showToolDetails}
      openSetting={view.showToolDetails}
    />
  )
})
SubagentStep.displayName = "SubagentStep"

/* A harness workflow step is a real thread of ours: the RFD head's `sessionId`
   is then a session in the store, and the rail is a mirror of a transcript
   that can be opened whole. A Codex child's id never is. */
function useStepThread(group: SubagentGroup): string | null {
  const { state } = useStore()
  const head = group.head
  if (head.kind !== "subagent") return null
  return state.sessions.some((s) => s.id === head.sessionId) ? head.sessionId : null
}

/** Whether `SubagentBody` would draw anything — the caller has to know before
    it renders, because a row with no body must not offer a disclosure. */
function subagentHasBody(group: SubagentGroup, stepThread: string | null): boolean {
  return group.head.kind === "tool" || group.children.length > 0 || group.active || stepThread !== null
}

/**
 * Everything a subagent produced: brief, its own thread, its rail, its report.
 *
 * Split out of `SubagentStep` because a workflow step is drawn twice — as an
 * ordinary step row on its own, and as a row of the run's table — and the two
 * differ only in the header above this. The brief and report exist for a tool
 * head alone: the RFD's child has no brief of its own, its prose IS the report
 * and it is already in the rail.
 */
function SubagentBody({
  group,
  stepThread,
  showTimestamps,
}: {
  group: SubagentGroup
  stepThread: string | null
  showTimestamps?: boolean
}) {
  const tool = group.head.kind === "tool" ? group.head : null
  const active = group.active
  return (
    <div className="space-y-2">
      {tool && <SubagentBrief item={tool} />}
      {stepThread && (
        <Link
          to={threadPath(stepThread)}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          Open thread <ArrowUpRightIcon className="size-3" />
        </Link>
      )}
      {/* The rail is drawn while the subagent is live even with nothing on it
          yet, so the working line at its foot has somewhere to sit and the
          first step lands in place rather than opening a rail. */}
      {(group.children.length > 0 || active) && (
        <SubagentTranscript rows={group.children} active={active} showTimestamps={showTimestamps} />
      )}
      {tool && <SubagentReport item={tool} active={active} />}
    </div>
  )
}

/* The run table's columns: mark, ordinal, step, what it did, how long.
   The activity column is the one that can be spared, and it is spared at both
   ends: below `@panel-sm` there is no room for it, and at `@panel-md` the
   selected step's panel has moved alongside the list, so the work is on screen
   in full and the list needs its width for the step's name instead. Dropped
   from the template AND hidden at both, or the cell would keep a column of its
   own with nothing in it. */
const WF_GRID =
  "grid items-center gap-2 grid-cols-[1rem_1.25rem_minmax(0,1fr)_auto] @panel-sm:grid-cols-[1rem_1.25rem_minmax(0,1fr)_minmax(0,11rem)_auto] @panel-md:grid-cols-[1rem_1.25rem_minmax(0,1fr)_auto]"

/** The activity cell's own visibility, which has to match the template above. */
const WF_ACTIVITY_CELL = "hidden min-w-0 truncate @panel-sm:block @panel-md:hidden"

/* A row is a touch target on a phone. The table is dense by design — that is
   what makes a nine-step run readable at a glance — so the height comes back
   only where the pointer is a finger, which is the device's question and not
   the panel's (see the "Mobile is two questions" note in CLAUDE.md). */
const WF_ROW_PAD = "px-1 py-0.5 max-md:py-1.5"

/** What a *running* step is doing right now, for the activity column: the
    newest call still open, else the newest call at all. `summarise`'s counts
    are the right answer for a step that has finished and the wrong one while
    it works — "reading 2 files" is what it did a minute ago, and the column is
    the only place the table says anything about a live step at all. */
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

const WF_STATE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  running: LoaderCircleIcon,
  completed: CheckIcon,
  failed: XIcon,
  cancelled: MinusIcon,
  disconnected: MinusIcon,
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
    else if (row.kind === "workflow-group") last = Math.max(last, lastActivityAt(row.steps))
    // Not every item kind is stamped (a plan has no arrival time of its own).
    else if ("at" in row) last = Math.max(last, row.at ?? 0)
  }
  return last
}

/** The name a step reads by: the definition's (`workflow.step`), not the
    agent's title for the thread — a table of steps should read as the workflow
    the user wrote. */
function stepNameOf(group: SubagentGroup, fallback?: string): string {
  const head = group.head
  const info = head.kind === "subagent" ? head.workflow : undefined
  return info?.step || (head.kind === "subagent" ? head.name || head.task : toolHeading(head).title) || (fallback ?? "")
}

/**
 * One step of a run, as a row of the table *and* as a tab: its mark, its place
 * in the definition, its name, what it did and how long it took — selecting
 * the panel that holds the same body the step draws on its own.
 *
 * A tab rather than the accordion this was, because a run is a set of steps you
 * move *between*: opening two of them pushed the rest off screen and left the
 * table — the thing the card is for — unreadable. As a tab list it keeps its
 * shape whatever you are looking at, and the run becomes walkable — ↑/↓ move
 * between steps, Enter picks one, `Home`/`End` reach the ends. Base UI's tabs
 * give the roving focus and the ARIA wiring; see `WorkflowRun`.
 */
function WorkflowStepRow({
  group,
  position,
}: {
  group: SubagentGroup
  /** 1-based fallback for a step the server did not number. */
  position: number
}) {
  const head = group.head
  const session = head.kind === "subagent" ? head : null
  const info = session?.workflow
  const active = group.active
  const state = stepStateOf(group)
  const failed = state === "failed"
  const stepThread = useStepThread(group)
  const selectable = subagentHasBody(group, stepThread)

  const name = stepNameOf(group)
  const done = summarise(collectTools(group.children))
    .map(({ verb, noun, count }) => `${verb} ${count} ${pluralNoun(noun, count)}`)
    .join(", ")
  /* Live, the column says what the step is on; settled, what it did. */
  const work = (active ? currentActivity(group.children) : undefined) ?? done
  /* Live while it runs; once settled, start-to-last-activity — an
     approximation, and the honest one available (see lastActivityAt). */
  const liveMs = useElapsed(head.startedAt, active)
  const settledEnd = lastActivityAt(group.children)
  const settledMs = settledEnd > head.startedAt ? settledEnd - head.startedAt : null
  const ms = active ? liveMs : settledMs
  const Mark = WF_STATE_ICONS[state] ?? LoaderCircleIcon
  /* Only a step that did not simply succeed spends the trailing column on a
     word — the mark says the rest, exactly as a step row's does. */
  const trailing = state === "completed" || state === "running" ? null : state

  return (
    <Tabs.Tab
      value={group.id}
      disabled={!selectable}
      className={cn(
        WF_GRID,
        WF_ROW_PAD,
        "group/wf relative -mx-1 w-[calc(100%+0.5rem)] rounded-md text-start transition-colors duration-150",
        "focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-ring",
        /* The row the eye should land on is the one being written. A failure
           keeps its own tint after the fact, since that is the row you came
           back for. Selection outranks both — it is the answer to "which of
           these am I reading", and it has to win over a state colour. */
        active && "bg-primary/5",
        failed && "bg-destructive/5",
        selectable && "hover:bg-muted/40",
        "data-active:bg-muted/70",
        /* Where the panel sits beside the list, the selected row grows an edge
           towards it; stacked, the tint is the whole signal and an accent
           pointing at nothing would be a lie. */
        "after:absolute after:inset-y-0.5 after:-right-1 after:hidden after:w-0.5 after:rounded-full after:bg-primary @panel-md:data-active:after:block"
      )}
    >
      <span
        className={cn(
          "relative flex h-6 w-4 shrink-0 items-center justify-center",
          failed ? "text-destructive" : active ? "text-primary" : "text-muted-foreground/60"
        )}
      >
        <Mark className={cn("size-3.5", active && "animate-spin")} />
      </span>
      <span className="text-[11px] leading-6 tabular-nums text-muted-foreground/50">
        {(info?.index ?? position - 1) + 1}
      </span>
      <span
        className={cn(
          "min-w-0 truncate text-xs leading-6",
          failed ? "text-destructive" : active ? "text-foreground/90" : "text-muted-foreground",
          "group-data-active/wf:text-foreground",
          active && "harness-shimmer"
        )}
      >
        {/* The mark is the only thing that states the state, and it is an
            icon — so say it once for a reader who cannot see one. */}
        <span className="sr-only">{state}: </span>
        {name}
      </span>
      <span
        className={cn(
          WF_ACTIVITY_CELL,
          "text-[11px] leading-6",
          active ? "text-muted-foreground/80 harness-shimmer" : "text-muted-foreground/60"
        )}
      >
        {work}
      </span>
      <span
        className={cn(
          "shrink-0 text-end text-[11px] leading-6 tabular-nums",
          failed ? "text-destructive" : "text-muted-foreground/60"
        )}
      >
        {trailing}
        {trailing && ms !== null && " · "}
        {ms !== null && formatElapsed(ms)}
      </span>
    </Tabs.Tab>
  )
}

/**
 * The selected step's work, as the run's one detail panel.
 *
 * It names the step it belongs to, because in the stacked layout it sits under
 * the whole list rather than beside the row that opened it — and a pane of
 * someone else's transcript with no heading is unreadable on a phone. Closing
 * is a button and not a second click on the row: a tab list that deselects on
 * re-click is a tab list that loses your place by accident.
 */
function WorkflowStepPanel({
  group,
  onClose,
  showTimestamps,
}: {
  group: SubagentGroup
  onClose: () => void
  showTimestamps?: boolean
}) {
  const stepThread = useStepThread(group)
  const state = stepStateOf(group)
  const Mark = WF_STATE_ICONS[state] ?? LoaderCircleIcon
  const failed = state === "failed"
  const active = group.active
  return (
    <Tabs.Panel
      value={group.id}
      /* Stacked, the panel is separated from the list it sits under by a rule
         across the card; beside it, by the rule down its left edge. */
      className="min-w-0 flex-1 border-t border-border/40 pt-2 outline-none @panel-md:border-t-0 @panel-md:border-l @panel-md:pt-0 @panel-md:pl-3"
    >
      <div className="mb-1 flex items-center gap-1.5">
        <Mark
          aria-hidden
          className={cn(
            "size-3.5 shrink-0",
            failed ? "text-destructive" : active ? "text-primary animate-spin" : "text-muted-foreground/60"
          )}
        />
        <span className={cn("min-w-0 flex-1 truncate text-xs font-medium", failed ? "text-destructive" : "text-foreground/80")}>
          {stepNameOf(group)}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close step"
          onClick={onClose}
          className="size-6 shrink-0 text-muted-foreground max-md:size-8"
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
      <SubagentBody group={group} stepThread={stepThread} showTimestamps={showTimestamps} />
    </Tabs.Panel>
  )
}

/** A step of the definition that has not spawned yet: the outline says it
    exists, and nothing else about it is known. Drawn so a run shows its whole
    shape from the first step rather than growing a row at a time. */
function WorkflowPendingRow({ name, position }: { name: string; position: number }) {
  return (
    <div className={cn(WF_GRID, WF_ROW_PAD, "-mx-1 opacity-60")}>
      <span className="flex h-6 w-4 shrink-0 items-center justify-center text-muted-foreground/40">
        <CircleDashedIcon className="size-3.5" />
      </span>
      <span className="text-[11px] leading-6 tabular-nums text-muted-foreground/40">{position}</span>
      <span className="min-w-0 truncate text-xs leading-6 text-muted-foreground/50">
        <span className="sr-only">pending: </span>
        {name}
      </span>
      {/* The column is empty for every pending row, and a column of blanks
          reads as missing data rather than as work not yet done. */}
      <span className={cn(WF_ACTIVITY_CELL, "text-[11px] leading-6 text-muted-foreground/40")}>waiting</span>
      <span />
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
function phasesOf(group: WorkflowGroup): PhaseView[] {
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

const PHASE_ICONS: Record<PhaseState, React.ComponentType<{ className?: string }>> = {
  pending: CircleDashedIcon,
  running: LoaderCircleIcon,
  completed: CheckIcon,
  failed: XIcon,
  cancelled: MinusIcon,
}

/** The phase strip in the card's header: one segment per phase, so the stage a
    long run is in is legible without reading the table. */
function PhasePips({ phases }: { phases: PhaseView[] }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5" aria-hidden>
      {phases.map((phase, i) => {
        const state = phaseStateOf(phase)
        return (
          <span
            key={phase.name ?? i}
            /* Hidden from the reader — the bands below say all of this in
               words — but a pointer still gets the phase it is pointing at. */
            title={phase.name ? `${phase.name} — ${state}` : state}
            className={cn(
              "h-1 w-3 rounded-full transition-colors duration-300",
              state === "failed"
                ? "bg-destructive"
                : /* Not `harness-shimmer`: it paints through
                     `background-clip: text`, and a pip has no text. */
                  state === "running"
                  ? "bg-primary animate-pulse"
                  : state === "completed"
                    ? "bg-muted-foreground/50"
                    : "bg-muted-foreground/15"
            )}
          />
        )
      })}
    </span>
  )
}

/**
 * A phase's band: its mark, its name, how far through it is and how long it
 * took — and the disclosure for its steps.
 *
 * Its own component because each band times itself, and `useElapsed` is a hook:
 * a run's phases cannot be timed from a loop in the card.
 */
function WorkflowPhaseBand({
  phase,
  open,
  onToggle,
}: {
  phase: PhaseView
  open: boolean
  onToggle: () => void
}) {
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
  const Mark = PHASE_ICONS[state]

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn(
        "group/ph -mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-md text-start transition-colors duration-150 hover:bg-muted/40",
        "focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-ring",
        WF_ROW_PAD
      )}
    >
      <span
        className={cn(
          "relative flex h-6 w-4 shrink-0 items-center justify-center",
          failed ? "text-destructive" : active ? "text-primary" : "text-muted-foreground/50"
        )}
      >
        <Mark className={cn("size-3.5 transition-opacity duration-100", active && "animate-spin", open ? "opacity-0" : "group-hover/ph:opacity-0")} />
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "absolute size-3.5 text-muted-foreground transition-[opacity,transform] duration-100",
            open ? "rotate-90 opacity-100" : "opacity-0 group-hover/ph:opacity-100"
          )}
        />
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[11px] font-medium uppercase leading-6 tracking-wide",
          failed ? "text-destructive" : active ? "text-foreground/80" : "text-muted-foreground/70",
          active && "harness-shimmer"
        )}
      >
        {phase.name}
      </span>
      {ms !== null && ms >= 2000 && (
        <span className="shrink-0 text-[11px] leading-6 tabular-nums text-muted-foreground/50">{formatElapsed(ms)}</span>
      )}
      <span className={cn("shrink-0 text-[11px] leading-6 tabular-nums", failed ? "text-destructive" : "text-muted-foreground/50")}>
        {done}/{phase.steps.length}
      </span>
    </button>
  )
}

/**
 * A workflow run: the harness's own pipeline, folded into one card — a header
 * naming the run, then its **phases**, each a band over a **table** of its
 * steps, one row each.
 *
 * A table rather than the rail of `SubagentStep`s it used to be because a run
 * is not a sequence of one agent's steps: it is N threads with a shape the
 * user wrote down, and what you want off it is the shape — which step is
 * which, which is running, which failed, how long each took — read down a
 * column rather than reconstructed from N header lines of different lengths.
 * Each row still expands into the very same body (`SubagentBody`) a step
 * draws on its own, so nothing about a step is lost by tabulating it.
 *
 * And the shape is drawn *before* it happens: the whole definition rides every
 * spawn's `_meta` as `plan`, so the card opens with every phase and every step
 * in it, the ones ahead of the run dimmed. A run that grew a row per spawn
 * could only ever say what had already happened. A definition with no phases
 * has one unnamed phase, whose band is left out — that is the flat table this
 * card has always drawn.
 */
export const WorkflowRun = React.memo(function WorkflowRun({
  group,
  showTimestamps,
}: {
  group: WorkflowGroup
  showTimestamps?: boolean
}) {
  const phases = phasesOf(group)
  const banded = phases.some((phase) => phase.name !== null)
  const all = phases.flatMap((p) => p.steps)
  const active = group.steps.some((step) => step.active)
  const failed = phases.some((phase) => phaseStateOf(phase) === "failed")
  const done = all.filter((step) => stateOfStep(step) === "completed").length
  /* The outline's count, so "1/9 steps" is honest while the later steps have
     not been spawned yet; a run with no outline falls back to what arrived. */
  const total = Math.max(all.length, ...group.steps.map((s) => (s.head.kind === "subagent" ? (s.head.workflow?.total ?? 0) : 0)))
  const started = group.steps.map((step) => step.head.startedAt)
  const startedAt = started.length ? Math.min(...started) : 0
  const elapsedMs = useElapsed(startedAt, active && startedAt > 0)
  const summary = total > 0 ? (failed ? `${done}/${total} · failed` : `${done}/${total} steps`) : failed ? "failed" : null

  /* A finished phase folds away while the run is still going, so what is on
     screen is the stage it is in; when the run settles they all open, because
     then the question is what happened rather than what is happening. Either
     is one click away, and a click is remembered for the rest of the render. */
  const [overrides, setOverrides] = React.useState<Record<string, boolean>>({})
  /* Nothing is selected until asked for. Following the running step on its own
     would make every live run open a panel in the middle of the transcript and
     swap it out from under the reader each time a step finished — the table is
     what the card is for, and the panel is what you ask it for. */
  const [selected, setSelected] = React.useState<string | null>(null)
  const isOpen = (phase: PhaseView, i: number) => {
    const key = phase.name ?? String(i)
    if (key in overrides) return overrides[key]
    return !(active && phaseStateOf(phase) === "completed")
  }

  return (
    <div
      role="group"
      aria-label={`Workflow ${group.name}`}
      className="my-1 overflow-hidden rounded-lg border border-border/60"
    >
      <div className="flex items-center gap-2 bg-muted/30 px-2.5 py-1">
        <WorkflowIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0",
            failed ? "text-destructive" : active ? "text-primary" : "text-muted-foreground/60"
          )}
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs font-medium leading-6",
            failed ? "text-destructive" : active ? "text-foreground/90" : "text-foreground/70",
            active && "harness-shimmer"
          )}
        >
          {group.name}
        </span>
        {banded && <PhasePips phases={phases} />}
        {elapsedMs !== null && elapsedMs >= 2000 && (
          <span className="shrink-0 text-[11px] leading-6 tabular-nums text-muted-foreground/60">
            {formatElapsed(elapsedMs)}
          </span>
        )}
        {summary && (
          <span
            className={cn(
              "shrink-0 text-[11px] leading-6 tabular-nums",
              failed ? "text-destructive" : "text-muted-foreground/60"
            )}
          >
            {summary}
          </span>
        )}
      </div>
      {/* How far through, as a length rather than a fraction — a run's shape is
          a distance, and a bar is read without being parsed. It is also the
          header's rule: the track is exactly the hairline that was there, so
          the card gains a reading and not a band. Aria-hidden because the
          count beside it already says this in words. */}
      <div className="h-px w-full bg-border/50" aria-hidden>
        <div
          className={cn(
            "h-full transition-[width] duration-500 ease-out",
            failed ? "bg-destructive" : active ? "bg-primary" : "bg-muted-foreground/50"
          )}
          style={{ width: total > 0 ? `${Math.round((done / total) * 100)}%` : "0%" }}
        />
      </div>
      {/* List and panel. Side by side once there is room for both (`@panel-md`),
          stacked below that — which is the phone, where a 20rem column beside a
          transcript is neither. Stacked, the panel is under the whole list
          rather than under its row, so it names its step; see
          `WorkflowStepPanel`. `items-start` keeps the list from stretching to
          the height of a long panel and leaving its rows floating. */}
      <Tabs.Root
        orientation="vertical"
        value={selected}
        onValueChange={(value) => setSelected(value as string | null)}
        className="flex flex-col gap-2 px-2.5 py-1.5 @panel-md:flex-row @panel-md:items-start"
      >
        {/* The tab list is the table. Bands and pending rows ride inside it in
            document order — they are not tabs and never take the roving focus,
            so ↑/↓ walk the steps and Tab reaches a band to fold it. Base UI
            registers its tabs by ref and orders them by document position, so
            nesting them under a phase's rail costs nothing.

            Selection is manual (`activateOnFocus` left off): a panel is a whole
            transcript, and activating on focus would mean tabbing *past* a run
            on the way somewhere else opened one. Arrows move, Enter/Space
            picks. */}
        <Tabs.List className="min-w-0 shrink-0 @panel-md:w-[19rem] @panel-md:max-w-[45%]">
          {/* The column heads are drawn only once there is a row under them — a
              lone header over an empty pipeline reads as a broken table rather
              than as a run that has not started. */}
          {all.length > 0 && (
            /* Indented with the rows when there are bands, or the columns would
               head nothing — the rows sit inside the phase's rail. */
            <div className={cn(banded && "ml-3 pl-2")}>
              <div
                className={cn(
                  WF_GRID,
                  "px-1 pb-0.5 text-[10px] uppercase leading-5 tracking-wide text-muted-foreground/40"
                )}
              >
                <span aria-hidden />
                <span>#</span>
                <span>Step</span>
                <span className={WF_ACTIVITY_CELL}>Activity</span>
                <span className="text-end">Time</span>
              </div>
            </div>
          )}
          {/* A run whose first spawn has arrived but whose outline has not (an
              older server) draws no rows at all, and an empty bordered box reads
              as a broken card rather than as a pipeline about to start. */}
          {all.length === 0 && (
            <div className={cn("px-1 text-xs leading-6 text-muted-foreground/60", active && "harness-shimmer")}>
              {active ? "Starting…" : "No steps ran"}
            </div>
          )}
          {phases.map((phase, p) => {
            const open = isOpen(phase, p)
            /* The ordinal is the step's place in the *run*, not in its phase:
               the numbers read down the card as one sequence, which is what the
               `#` column is for. */
            const before = phases.slice(0, p).reduce((n, ph) => n + ph.steps.length, 0)
            return (
              <div key={phase.name ?? p} className={cn(banded && p > 0 && "mt-1")}>
                {banded && phase.name !== null && (
                  <WorkflowPhaseBand
                    phase={phase}
                    open={open}
                    onToggle={() => {
                      setOverrides((o) => ({ ...o, [phase.name ?? String(p)]: !open }))
                      /* Folding a phase takes its rows away, and a panel whose
                         tab is no longer on screen is a pane with nothing
                         pointing at it. */
                      if (open && phase.steps.some((s) => s.group?.id === selected)) setSelected(null)
                    }}
                  />
                )}
                {open && (
                  <div className={cn(banded && "ml-3 border-l border-border/40 pl-2")}>
                    {phase.steps.map((step, i) =>
                      step.group ? (
                        <WorkflowStepRow key={step.group.id} group={step.group} position={before + i + 1} />
                      ) : (
                        <WorkflowPendingRow key={`${phase.name ?? p}:${step.name}`} name={step.name} position={before + i + 1} />
                      )
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </Tabs.List>
        {/* One panel per step; Base UI mounts only the selected one, so a run of
            nine steps costs one transcript and not nine. */}
        {group.steps.map((step) => (
          <WorkflowStepPanel
            key={step.id}
            group={step}
            onClose={() => setSelected(null)}
            showTimestamps={showTimestamps}
          />
        ))}
        {/* Nothing picked: the column beside the list would otherwise be a hole
            the width of the card. Only where the panel is beside the list —
            stacked, no selection simply means no panel, and a standing hint
            under every run would be noise. */}
        {selected === null && (
          <div className="hidden min-w-0 flex-1 items-center border-l border-border/40 pl-3 text-xs text-muted-foreground/50 @panel-md:flex">
            Select a step to see its work
          </div>
        )}
      </Tabs.Root>
    </div>
  )
})
WorkflowRun.displayName = "WorkflowRun"

/** A subagent's rows, on a rail. Peeks the tail while the subagent is live;
    the whole thing once it is done, or once asked. */
function SubagentTranscript({
  rows,
  active,
  showTimestamps,
}: {
  rows: Row[]
  active: boolean
  showTimestamps?: boolean
}) {
  const [expanded, setExpanded] = React.useState(false)
  const showing = expanded || !active ? rows : rows.slice(-PEEK)
  const hidden = rows.length - showing.length
  return (
    <div className={RAIL_CLASS}>
      {hidden > 0 && <EarlierSteps count={hidden} onClick={() => setExpanded(true)} />}
      {showing.map((row, i) => (
        <RowView
          key={row.id}
          row={row}
          showTimestamps={showTimestamps}
          streaming={active && i === showing.length - 1}
        />
      ))}
      {/* The subagent's own working line, at the foot of its rail: the thread's
          indicator under the composer says the *turn* is running, which is
          true whether or not this worker is — and between two of its steps,
          or before its first, its rail would otherwise just stop. */}
      {active && (
        <div
          aria-label="Subagent working"
          className="flex items-center gap-2 px-1.5 py-0.5 text-[11px] leading-6 text-primary"
        >
          <LoaderCircleIcon aria-hidden className="size-3.5 shrink-0 animate-spin" />
          <span className="harness-shimmer">{rows.length === 0 ? "Starting…" : "Working…"}</span>
        </div>
      )}
    </div>
  )
}

/* Memoized — the transcript's row discriminator, and the thing that makes
   memo work up the tree: `item` is referentially stable for everything the
   reducer did not touch, so a streaming chunk re-renders only the changed rows
   instead of all n. The `useViewOptionsContext` inside reads the same
   context value across a re-render storm, so it does not break memo. */
const THOUGHT_SNIPPET = 96

/** The line of a thought that stands for it in a folded row: the first while
    it is settled, the tail of the newest while it streams (see the `thought`
    case). Markdown marks are stripped — the row is one plain line. */
function thoughtPreview(reasoning: string, streaming: boolean): string {
  const lines = reasoning.split("\n").filter((line) => line.trim())
  if (lines.length === 0) return streaming ? "Thinking…" : "…"
  const line = (streaming ? lines[lines.length - 1] : lines[0]).replace(/[`*_~#>]/g, "").trim()
  if (!streaming || line.length <= THOUGHT_SNIPPET) return line
  return "…" + line.slice(-THOUGHT_SNIPPET).replace(/^\S*\s/, "")
}

export const ThreadItemView = React.memo(function ThreadItemView({
  item,
  onContinue,
  onRetry,
  onDismiss,
  showTimestamps = false,
  streaming = false,
}: {
  item: ThreadItem
  /** Present only on the transcript's last interrupt notice — see ThreadView. */
  onContinue?: () => void
  /** Present on an error row that knows the prompt it killed. */
  onRetry?: () => void
  onDismiss?: () => void
  showTimestamps?: boolean
  /** See RowView. */
  streaming?: boolean
}) {
  const view = useViewOptionsContext()
  switch (item.kind) {
    case "error":
      return (
        <ErrorRow
          item={item}
          onRetry={onRetry}
          onDismiss={onDismiss}
          showTimestamp={showTimestamps}
        />
      )
    case "user":
      return (
        <ItemContextMenu
          items={[{ label: "Copy text", icon: <CopyIcon />, onClick: () => copyText(item.text) }]}
          className="select-text"
          onContextMenu={yieldToTextSelection}
        >
          {/* Tinted, not filled: a soft wash of the accent with foreground text
              rather than the primary-on-primary-foreground pair, which is the
              loudest thing the theme has and made every prompt shout over the
              answer under it. Width, alignment and the corner tail are as they
              were — the bubble still hugs the right edge at 80%. */}
          <Message align="end" className="flex-col items-end gap-0.5 py-2">
            <MessageContent>
              <Bubble variant="tinted" align="end">
                <BubbleContent className="rounded-2xl rounded-br-sm px-4 py-2.5 text-sm">
                  <Prose text={item.text} />
                </BubbleContent>
              </Bubble>
            </MessageContent>
            {showTimestamps && <Timestamp at={item.at} className="pr-1" />}
          </Message>
        </ItemContextMenu>
      )
    case "agent":
      return (
        <ItemContextMenu
          items={[{ label: "Copy text", icon: <CopyIcon />, onClick: () => copyText(item.text) }]}
          className="select-text"
          onContextMenu={yieldToTextSelection}
        >
          {/* The transcript is ONE column: prose, steps and notices all start on
              the same left edge, with nothing inset for a gutter. */}
          <Message className="flex-col items-start gap-0.5 py-2">
            <MessageContent>
              <Bubble variant="ghost">
                <BubbleContent className="text-sm leading-relaxed">
                  <AgentText text={item.text} />
                </BubbleContent>
              </Bubble>
            </MessageContent>
            {showTimestamps && <Timestamp at={item.at} />}
          </Message>
        </ItemContextMenu>
      )
    case "notice": {
      // Two things arrive as agent-authored transcript events: an interrupt
      // (one line, a rule) and a background task reporting back (a card — see
      // TaskNotificationCard). The store keeps the raw block; this is where it
      // becomes one or the other.
      const task = parseTaskNotification(item.text)
      if (task) {
        return <TaskNotificationCard task={task} at={item.at} showTimestamp={showTimestamps} />
      }
      // A break in the conversation, so it reads as one: hairline across the
      // column with the reason inline. An interrupt you can still resume gets
      // the resume button right there in the rule — picking the turn back up
      // is the only thing anyone wants after stopping it.
      return (
        <div className="flex items-center gap-2.5 py-2 text-[11px] text-muted-foreground/70">
          <span aria-hidden className="h-px flex-1 bg-border" />
          <span className="shrink-0">{item.text}</span>
          {showTimestamps && <Timestamp at={item.at} />}
          {onContinue && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 shrink-0 gap-1 rounded-full px-2 text-[11px]"
              onClick={onContinue}
              title="Ask the agent to pick up where it stopped"
            >
              <PlayIcon className="size-3" />
              Continue
            </Button>
          )}
          <span aria-hidden className="h-px flex-1 bg-border" />
        </div>
      )
    }
    case "thought": {
      const reasoning = item.text.trim()
      /* The title is a snippet of the detail. Settled, it is the opening
         line — what the thought was about. Still streaming, it is the
         *newest* line's tail instead, so a folded row reads as a ticker of
         what the agent is thinking right now rather than freezing on the
         first words for a minute of silence; the whole item is rebuilt per
         chunk anyway (appendText replaces the tail item), so this costs no
         extra render. Clipped from the front because `truncate` cuts the
         end, and the end is the part that is new. */
      const preview = thoughtPreview(reasoning, streaming)

      return (
        <StepRow
          icon={KIND_ICONS.think}
          status={streaming ? "in_progress" : null}
          label={streaming ? "thinking" : undefined}
          startedAt={streaming ? item.at : undefined}
          mono={false}
          defaultOpen={view.showThinking}
          openSetting={view.showThinking}
          target={
            streaming ? (
              <span className="harness-shimmer text-primary">{preview}</span>
            ) : (
              preview
            )
          }
          detail={
            <Prose
              text={reasoning}
              className="text-xs leading-relaxed text-muted-foreground"
            />
          }
        />
      )
    }
    case "tool":
      return <ToolStep item={item} showTimestamp={showTimestamps} />
    case "plan":
      return <PlanStep item={item} />
    case "compaction":
      return <CompactionStep item={item} showTimestamp={showTimestamps} />
    case "subagent":
      // An announced session with nothing filed under it yet — `buildRows`
      // wraps every one it sees, so this is the bare item reaching a row view
      // directly (a rail's own list). Same step, empty rail.
      return (
        <SubagentStep
          group={{ kind: "subagent-group", id: item.id, head: item, active: item.state === "running", children: [] }}
          showTimestamps={showTimestamps}
        />
      )
  }
})
ThreadItemView.displayName = "ThreadItemView"

// ─── Per-kind layouts ────────────────────────────────────────────────────────

const ToolStep = React.memo(function ToolStep({
  item,
  showTimestamp,
}: {
  item: ToolItem;
  showTimestamp?: boolean;
}) {
  const active = item.status === "in_progress" || item.status === "pending"
  const kind = toolKindOf(item)
  const KindIcon = KIND_ICONS[kind] ?? WrenchIcon
  const view = useViewOptionsContext()
  /* Both of these are `tool-views`' to answer, not this row's: whether an
     expansion would hold anything, and whether it should start open, both
     depend on which layout the call resolved to — and a chevron that opens an
     empty box is worse than no chevron. "Expand tool output" overrides the
     second, so the body is there to read without a click. */
  const hasBody = toolHasDetail(item)
  /* What the agent said it was doing beats what it typed: a Bash call carries
     both, and the command truncates to nothing useful in a row this wide.
     A subagent's step drops the child's name its runtime may have prefixed —
     the rail it sits in is already headed by that name. */
  const heading = toolHeading(item.parentId ? { ...item, title: childToolTitle(item) } : item)

  return (
    <StepRow
      status={item.status}
      icon={KindIcon}
      target={heading.title}
      caption={heading.detail}
      file={heading.file}
      filePath={heading.filePath}
      mono={!heading.prose}
      /* No outcome here. The header line is the title and the command that
         produced it; churn counts and echoed output lines competed with both
         for the same strip of row, and a long one pushed the command it
         belonged to out of view. What happened is in the body — the diff, the
         output, the matches — where it is the thing being read rather than a
         teaser for it. `failed` still reaches the row, as the label. */
      metric={showTimestamp ? <Timestamp at={item.at} /> : undefined}
      startedAt={item.startedAt}
      detail={hasBody || active ? <ToolDetail item={item} active={active} /> : undefined}
      below={<ToolSources item={item} />}
      defaultOpen={view.showToolDetails || toolOpensByDefault(item)}
      openSetting={view.showToolDetails}
    />
  )
})
ToolStep.displayName = "ToolStep"
