import * as React from "react"
import type * as acp from "@agentclientprotocol/sdk"
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
import { ChevronLeftIcon, ChevronRightIcon, CopyIcon, Maximize2Icon } from "lucide-react"
import { Tabs } from "@base-ui/react/tabs"
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useIsMobile } from "@/hooks/use-mobile"
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
  CompactionStep,
  ErrorRow,
  PlanStep,
  SourcesStrip,
  StreamedAgentText,
  TaskNotificationCard,
} from "@/components/thread-cards"
import {
  childToolTitle,
  extractSubagent,
  fileRangeOf,
  parseTaskNotification,
  toolKindOf,
  toolHeading,
  webInput,
} from "@/lib/tools"
import type { Row, SubagentBatch, SubagentGroup, ToolRunGroup, WorkflowGroup } from "@/lib/transcript-rows"
import { formatTokens, sumUsage } from "@/lib/tokens"
import { StepTokens, TokenFigure, TokenSummary, useStepTokens } from "@/components/token-usage"
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
export type { Row, SubagentBatch, SubagentGroup, ToolRunGroup, WorkflowGroup }

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

/* ── A run's rail ──
   Drawn per step rather than as one border down the box around them: the line
   has to *stop* at the last step's elbow (a tail running on under the last row
   is a branch that goes nowhere), and a border on the container cannot know
   which child is last. So `RUN_RAIL_CLASS` is the same geometry as `RAIL_CLASS`
   with the border taken off, and each step carries its own piece of it.

   Each piece is an elbow: the rail down the step's left, turning into its icon
   column on a curve. `before:h-4` ends the turn at 14px — the middle of the
   row's first line box (`py-0.5` + `leading-6`) — so it meets the leading mark
   however many lines the row grows to, and the `-top-0.5` closes the 2px
   `space-y` gap over it so consecutive elbows read as one line. The left edge
   is `-left-[11px]`, which is where the container's border used to sit, so
   nothing else moved. Tool steps only: every row in a run is a StepRow with
   that geometry, where a subagent's rail also carries prose, which has no mark
   to meet.

   The width is 13px and not 11px — two more than the distance to the row's
   content edge — because the mark it turns into is a 14px *box* with the glyph
   inset inside it. Ending the curve at x=0 landed it on the box's edge and left
   a hairline of daylight before the icon actually starts, so the rail read as
   pointing at the step rather than joining it; the extra 2px tuck under the
   glyph's leading edge, where the line is hidden by the mark itself. */
const RUN_RAIL_CLASS = "mt-0.5 ml-[calc(0.75rem-1px)] space-y-0.5 pl-2.5"

const RAIL_ELBOW =
  "relative before:absolute before:-top-0.5 before:-left-[11px] before:h-4 before:w-[13px] before:rounded-bl-[6px] before:border-b before:border-l before:border-border/60"

/** The rail continuing past a step to the one under it — every step but the
    last, which is what makes the run's line end on its own last elbow. */
const RAIL_TAIL =
  "after:absolute after:top-[0.875rem] after:-bottom-0.5 after:-left-[11px] after:w-px after:bg-border/60"

/** A straight length of the same rail, for a row in it that is not a step (the
    "N earlier steps" line) — it passes the line on without claiming an elbow. */
const RAIL_THROUGH =
  "relative before:absolute before:-top-0.5 before:-bottom-0.5 before:-left-[11px] before:w-px before:bg-border/60"

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
        <div className={RUN_RAIL_CLASS}>
          {hidden > 0 && (
            <div className={RAIL_THROUGH}>
              <EarlierSteps count={hidden} onClick={() => setOpen(true)} />
            </div>
          )}
          {/* Not `[data-message-id]` rows, so the transcript's entrance does
              not reach them on its own — the class is the same animation. */}
          {showing.map((item, index) => (
            <div
              key={item.id}
              className={cn(
                "harness-item-in",
                RAIL_ELBOW,
                index < showing.length - 1 && RAIL_TAIL
              )}
            >
              <ToolStep item={item} showTimestamp={showTimestamps} />
            </div>
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
  if (row.kind === "subagent-batch") return <SubagentBatchRun group={row} showTimestamps={showTimestamps} />
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
    } else if (row.kind === "workflow-group" || row.kind === "subagent-batch") out.push(...collectTools(row.steps))
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
  const tokens = view.showTokens ? stepUsage(group) : undefined

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
        prose || showTimestamps || tokens ? (
          <>
            {prose}
            {prose && tokens && " · "}
            {/* Bare text, not the popover form: this sits inside StepRow's own
                disclosure button, and a button may not hold a button. */}
            {tokens && <TokenFigure usage={tokens} />}
            {(prose || tokens) && showTimestamps && " · "}
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

/** What a *running* step is doing right now: the newest call still open, else
    the newest call at all. `summarise`'s counts are the right answer for a
    step that has finished and the wrong one while it works — "reading 2
    files" is what it did a minute ago. Read by the preview card's live line
    and by the dialog sidebar's running row alike. */
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
function stepUsage(group: SubagentGroup): acp.Usage | undefined {
  return group.head.kind === "subagent" ? group.head.usage : undefined
}

const WF_STATE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  running: LoaderCircleIcon,
  completed: CheckIcon,
  failed: XIcon,
  cancelled: MinusIcon,
  disconnected: MinusIcon,
}

/* ── One colour vocabulary for the whole card ──
   A run says the same five things in four places — the meter's segments, a
   step's mark, a phase's band, the header — and they were each choosing their
   own tints, so a failed step could read destructive in the table and merely
   muted in the strip above it. `WF_TONE` is the tint per state and `wfTone` is
   how every one of them asks for it. */
type WfState = "pending" | "running" | "completed" | "failed" | "cancelled" | "disconnected"

const WF_TONE: Record<WfState, { text: string; fill: string; chip: string }> = {
  pending: {
    text: "text-muted-foreground/40",
    fill: "bg-muted-foreground/15",
    chip: "bg-muted text-muted-foreground/60",
  },
  running: {
    text: "text-primary",
    fill: "bg-primary animate-pulse",
    chip: "bg-primary/10 text-primary",
  },
  completed: {
    text: "text-muted-foreground/60",
    fill: "bg-muted-foreground/50",
    chip: "bg-muted text-muted-foreground",
  },
  failed: {
    text: "text-destructive",
    fill: "bg-destructive",
    chip: "bg-destructive/10 text-destructive",
  },
  cancelled: {
    text: "text-muted-foreground/50",
    fill: "bg-muted-foreground/25",
    chip: "bg-muted text-muted-foreground/70",
  },
  disconnected: {
    text: "text-muted-foreground/50",
    fill: "bg-muted-foreground/25",
    chip: "bg-muted text-muted-foreground/70",
  },
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
    sidebar of three identical rows names nothing. */
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
 * One step of the run, as a row of the dialog's sidebar *and* as a tab: its
 * mark, its name, its duration — and while it runs, what it is on right now,
 * as a second line, because the sidebar is the only part of the dialog that
 * says anything about a step you have not selected.
 *
 * A tab so the run is walkable — ↑/↓ move between steps, Enter picks one,
 * `Home`/`End` reach the ends; Base UI's tabs give the roving focus and the
 * ARIA wiring (see the Tabs.Root in `WorkflowPreviewDialog`).
 */
function WorkflowStepTab({ group }: { group: SubagentGroup }) {
  const active = group.active
  const state = stepStateOf(group)
  const failed = state === "failed"
  const stepThread = useStepThread(group)
  const selectable = subagentHasBody(group, stepThread)
  const ms = useStepElapsed(group)
  const Mark = WF_STATE_ICONS[state] ?? LoaderCircleIcon
  const view = useViewOptionsContext()
  const tokens = view.showTokens ? stepUsage(group) : undefined
  /* Live, the second line says what the step is on right now. */
  const activity = active ? currentActivity(group.children) : undefined
  /* Only a step that did not simply succeed spends the trailing text on a
     word — the mark says the rest. */
  const trailing = state === "completed" || state === "running" ? null : state

  return (
    <Tabs.Tab
      value={group.id}
      disabled={!selectable}
      className={cn(
        /* A step mounts when the runner reaches it, replacing its pending row
           — the space is already held, so it fades alive rather than sliding. */
        "group/wfs harness-fade-in flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-start transition-colors duration-150",
        "focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-ring",
        /* The row the eye should land on is the one being written. A failure
           keeps its own tint after the fact, since that is the row you came
           back for. Selection outranks both — it is the answer to "which of
           these am I reading", and it has to win over a state colour. */
        active && "bg-primary/5",
        failed && "bg-destructive/5",
        selectable ? "cursor-pointer hover:bg-muted/60" : "cursor-default",
        "data-active:bg-accent data-active:shadow-xs"
      )}
    >
      {/* The mark sits in a disc of its own state's tint: a column of bare
          glyphs reads as punctuation, and the mark column is what the eye
          runs down looking for the step that failed. */}
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full",
          failed
            ? "bg-destructive/10 text-destructive"
            : active
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground/60"
        )}
      >
        <Mark className={cn("size-3", active && "animate-spin")} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            "min-w-0 truncate text-xs leading-5",
            failed ? "text-destructive" : active ? "text-foreground/90" : "text-muted-foreground",
            "group-data-active/wfs:font-medium group-data-active/wfs:text-foreground",
            active && "harness-shimmer"
          )}
        >
          {/* The mark is the only thing that states the state, and it is an
              icon — so say it once for a reader who cannot see one. */}
          <span className="sr-only">{state}: </span>
          {stepNameOf(group)}
        </span>
        {activity && (
          <span className="harness-shimmer min-w-0 truncate text-[11px] leading-4 text-muted-foreground/80">
            {activity}
          </span>
        )}
      </span>
      <span
        className={cn(
          "shrink-0 text-end text-[11px] leading-5 tabular-nums",
          failed ? "text-destructive" : "text-muted-foreground/50"
        )}
      >
        {trailing}
        {trailing && ms !== null && " · "}
        {ms !== null && formatElapsed(ms)}
        {/* Under the duration rather than beside it: the trailing column is
            already two facts wide on a failed step, and a third would push the
            step's own name out of a sidebar that is deliberately narrow. */}
        {tokens && (
          <span className="block text-muted-foreground/40">
            <TokenFigure usage={tokens} />
          </span>
        )}
      </span>
    </Tabs.Tab>
  )
}

/**
 * The selected step's events, as the dialog's main pane: a header naming the
 * step, then the very same body the step draws on its own — brief, thread
 * link, rail, report.
 *
 * On a phone the sidebar and this pane are one column and the list yields to
 * the panel, so the header grows a back button; on a desktop the list stays
 * beside it and closing is deselecting, which the back button also does. It
 * is a button and not a second click on the row: a tab list that deselects on
 * re-click loses your place by accident.
 */
function WorkflowStepPanel({
  group,
  onBack,
  showTimestamps,
}: {
  group: SubagentGroup
  onBack: () => void
  showTimestamps?: boolean
}) {
  const stepThread = useStepThread(group)
  const state = stepStateOf(group)
  const Mark = WF_STATE_ICONS[state] ?? LoaderCircleIcon
  const failed = state === "failed"
  const active = group.active
  const ms = useStepElapsed(group)
  const view = useViewOptionsContext()
  const panelTokens = view.showTokens ? stepUsage(group) : undefined
  return (
    <Tabs.Panel value={group.id} className="flex min-h-0 min-w-0 flex-1 flex-col outline-none">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/40 px-3 py-2 sm:px-4">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back to steps"
          onClick={onBack}
          className="-ml-1 size-7 shrink-0 text-muted-foreground sm:hidden"
        >
          <ChevronLeftIcon className="size-4" />
        </Button>
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
        {ms !== null && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/50">{formatElapsed(ms)}</span>
        )}
        {/* The pane is ordinary flow content — no enclosing button — so this is
            the one place a step can offer the whole breakdown. */}
        {panelTokens && (
          <TokenSummary
            usage={panelTokens}
            context={group.head.kind === "subagent" ? group.head.context : undefined}
            label="This step"
            className="shrink-0"
          />
        )}
        <WorkflowPill state={state as WfState} />
      </div>
      {/* The pane owns the scroll, so a long rail never grows the dialog. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5 sm:px-4">
        <SubagentBody group={group} stepThread={stepThread} showTimestamps={showTimestamps} />
      </div>
    </Tabs.Panel>
  )
}

/** A step of the definition that has not spawned yet: the outline says it
    exists, and nothing else about it is known. Drawn so the sidebar shows the
    run's whole shape from the first step rather than growing a row at a time. */
function WorkflowPendingItem({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 opacity-60">
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/40">
        <CircleDashedIcon className="size-3" />
      </span>
      <span className="min-w-0 flex-1 truncate text-xs leading-5 text-muted-foreground/50">
        <span className="sr-only">pending: </span>
        {name}
      </span>
      {/* A trailing word rather than a blank: a column of blanks reads as
          missing data rather than as work not yet done. */}
      <span className="shrink-0 text-[11px] leading-5 text-muted-foreground/40">waiting</span>
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
 * The meter under the card's header: **one segment per step**, grouped by
 * phase, each segment tinted with its own step's state.
 *
 * It replaces two things that used to sit apart — a pip per phase in the header
 * and a `done/total` progress bar drawn into the header's hairline. Neither was
 * enough on its own: the bar said how far through the run was and nothing about
 * where it went wrong, the pips said which stage it was in and nothing about
 * how big a stage was. One segment per step says all of it at a glance — how
 * long the run is, how much of it is behind you, which step is being written
 * and which one failed — and it still *is* the rule under the header, so the
 * card gains a reading rather than a band.
 *
 * Segments share the width in proportion to the steps in a phase, so a phase of
 * six does not read the same length as a phase of one. Aria-hidden: the counter
 * beside it and the table below say every bit of this in words.
 */
function WorkflowMeter({ phases, className }: { phases: PhaseView[]; className?: string }) {
  return (
    <div className={cn("flex w-full items-stretch gap-1", className)} aria-hidden>
      {phases.map((phase, p) => (
        <div
          key={phase.name ?? p}
          className="flex min-w-0 items-center gap-px"
          style={{ flex: `${Math.max(1, phase.steps.length)} 1 0%` }}
          /* The bands below say this in words; a pointer still gets the phase
             it is pointing at. */
          title={phase.name ? `${phase.name} — ${phaseStateOf(phase)}` : phaseStateOf(phase)}
        >
          {(phase.steps.length ? phase.steps : [null]).map((step, i) => (
            <span
              key={i}
              className={cn(
                "h-1 min-w-1 flex-1 rounded-pill transition-colors duration-300",
                /* Not `harness-shimmer`: it paints through
                   `background-clip: text`, and a segment has no text. */
                wfTone(step ? stateOfStep(step) : "pending").fill
              )}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * A phase's heading in the dialog's sidebar: its name, how long it took and
 * how far through it is. Sticky, so a long phase scrolling by still says
 * which stage its steps belong to. Not a disclosure any more: the dialog has
 * the room the card never did, so a phase no longer folds.
 *
 * Its own component because each phase times itself, and `useElapsed` is a
 * hook: a run's phases cannot be timed from a loop in the dialog.
 */
function WorkflowPhaseHeader({ phase }: { phase: PhaseView }) {
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
    <div className="sticky top-0 z-10 flex items-center gap-2 bg-popover px-2 pt-2.5 pb-1">
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[10px] font-semibold uppercase leading-5 tracking-[0.08em]",
          failed ? "text-destructive" : active ? "text-foreground/75" : "text-muted-foreground/60",
          active && "harness-shimmer"
        )}
      >
        {phase.name}
      </span>
      {ms !== null && ms >= 2000 && (
        <span className="shrink-0 text-[11px] leading-5 tabular-nums text-muted-foreground/50">{formatElapsed(ms)}</span>
      )}
      {/* The count is a pill so the heading carries a piece of its state's
          colour beside the step marks below it. */}
      <span className={cn("shrink-0 rounded-pill px-1.5 text-[10px] leading-5 tabular-nums", wfTone(state).chip)}>
        {done}/{phase.steps.length}
      </span>
    </div>
  )
}

/**
 * A set of subagents in the transcript — a harness workflow run, or the N
 * workers an agent fired side by side — as a compact preview card: the run's
 * name, its state, its meter and, while it runs, the step being written. It
 * opens the whole thing in a dialog on click.
 *
 * A dialog rather than the phase-banded table this card used to hold, because
 * a run is N whole threads and a transcript column is the wrong room to read
 * one in: the table fought the panel for width, and a step's events ended up
 * in a pane inside a card inside a transcript. The card now answers only the
 * passing reader's questions — is it moving, how far along, did anything fail
 * — and the dialog answers the rest: a sidebar of the run's phases with their
 * steps under them, and the selected step's events beside it, the very same
 * `SubagentBody` a step draws anywhere.
 *
 * One component for both because they are one question asked twice: a
 * workflow knows its shape up front and an ad-hoc batch does not, which is
 * the whole of the difference — the plan rides every workflow spawn's
 * `_meta`, so the meter and the sidebar show every phase and every step from
 * the first spawn on, the ones ahead of the run dimmed, while a batch has
 * exactly the steps that were launched. A definition with no phases, and
 * every batch, is one unnamed phase whose header is left out — a flat step
 * list.
 */
function RunCard({
  name,
  steps: runSteps,
  plan,
  icon: RunIcon,
  countNoun,
  ariaLabel,
  showTimestamps,
}: {
  name: string
  steps: SubagentGroup[]
  plan?: WorkflowGroup["plan"]
  icon: React.ComponentType<{ className?: string }>
  /** What the `2/9` in the subtitle counts — "steps" of a definition, "done"
      of a batch, which has no shape beyond the workers in it. */
  countNoun: string
  ariaLabel: string
  showTimestamps?: boolean
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
  /* Counts belong under the name, not beside the pill: the second line is the
     run's shape (how many steps, which stage), and the pill is its state. A
     run whose outline has not arrived has neither yet. */
  const runningPhase = phases.find((phase) => phaseStateOf(phase) === "running")
  /* The run's cost is its steps' — a workflow spends nothing of its own. Summed
     at view time rather than accumulated anywhere, so a step arriving late (or
     a replay rebuilding the lot) simply adds to it. */
  const view = useViewOptionsContext()
  const runTokens = view.showTokens ? sumUsage(runSteps.map(stepUsage)) : null
  const subtitle = [
    total > 0 ? `${done}/${total} ${countNoun}` : null,
    banded && runningPhase?.name ? runningPhase.name : null,
    elapsedMs !== null && elapsedMs >= 2000 ? formatElapsed(elapsedMs) : null,
    runTokens ? `${formatTokens(runTokens.totalTokens)} tokens` : null,
  ]
    .filter(Boolean)
    .join(" · ")

  const runningStep = all.find((step) => step.group?.active)?.group ?? null
  const failedStep = all.find((step) => step.group && stepStateOf(step.group) === "failed")?.group ?? null
  /* The card's foot line: what is being written right now, else the step that
     failed — the two things a reader would open the dialog to find. */
  const activity = runningStep ? currentActivity(runningStep.children) : undefined
  const liveLine = runningStep ? [stepNameOf(runningStep), activity].filter(Boolean).join(" — ") : null

  const [open, setOpen] = React.useState(false)
  const [selected, setSelected] = React.useState<string | null>(null)
  const isMobile = useIsMobile()
  const openPreview = (next: boolean) => {
    /* Opening lands on the step being written, else the one that failed —
       the rows the reader came for — and keeps a pick made last time. On a
       phone it opens on the list instead: there the panel *replaces* the
       list, and auto-selecting would skip the run's shape, which is the
       screen the tap asked for. */
    if (next && !isMobile) {
      setSelected((cur) => cur ?? runningStep?.id ?? failedStep?.id ?? runSteps[0]?.id ?? null)
    }
    setOpen(next)
  }

  return (
    <Dialog open={open} onOpenChange={openPreview}>
      {/* The whole card is the trigger — one target, no interactive rows left
          inside it — so its children are spans: a button holds phrasing
          content. */}
      <DialogTrigger
        render={
          <button
            type="button"
            aria-label={ariaLabel}
            className={cn(
              "group/wfc my-1 block w-full overflow-hidden rounded-lg border border-border/60 text-start",
              "transition-colors duration-150 hover:border-border hover:bg-muted/30",
              "focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-ring"
            )}
          />
        }
      >
        <span className="flex items-center gap-2 bg-muted/25 px-2.5 py-1.5 transition-colors duration-150 group-hover/wfc:bg-muted/40">
          <span
            aria-hidden
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-md",
              failed
                ? "bg-destructive/10 text-destructive"
                : active
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-muted-foreground/70"
            )}
          >
            <RunIcon className="size-3.5" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span
              className={cn(
                "truncate text-xs font-medium leading-4",
                failed ? "text-destructive" : active ? "text-foreground" : "text-foreground/80",
                active && "harness-shimmer"
              )}
            >
              {name}
            </span>
            {subtitle && (
              <span className="truncate text-[11px] leading-4 tabular-nums text-muted-foreground/60">
                {subtitle}
              </span>
            )}
          </span>
          <WorkflowPill state={runState} />
          {/* The one standing hint that the card opens: visible always, louder
              under the pointer — hover is not the only way in, just the first
              one discovered. */}
          <Maximize2Icon
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground/40 transition-colors duration-150 group-hover/wfc:text-muted-foreground"
          />
        </span>
        {/* The run's whole shape as a strip of steps — see `WorkflowMeter`.
            Drawn even before a step has spawned, because the outline is known
            from the first `_meta` the runner stamps. */}
        {all.length > 0 && <WorkflowMeter phases={phases} className="px-2.5 pt-2 pb-1.5" />}
        {(liveLine || failedStep) && (
          <span className="flex items-center gap-1.5 border-t border-border/40 px-2.5 py-1">
            {liveLine ? (
              <>
                <LoaderCircleIcon aria-hidden className="size-3 shrink-0 animate-spin text-primary" />
                <span className="harness-shimmer min-w-0 truncate text-[11px] leading-4 text-muted-foreground/80">
                  {liveLine}
                </span>
              </>
            ) : (
              <>
                <XIcon aria-hidden className="size-3 shrink-0 text-destructive" />
                <span className="min-w-0 truncate text-[11px] leading-4 text-destructive">
                  {stepNameOf(failedStep!)} failed
                </span>
              </>
            )}
          </span>
        )}
      </DialogTrigger>
      <DialogContent
        className={cn(
          "flex h-[min(44rem,calc(100svh-2rem))] w-[min(60rem,calc(100vw-1rem))] flex-col gap-0 overflow-hidden p-0",
          "sm:max-w-[calc(100vw-3rem)]"
        )}
      >
        {/* The card's header, restated where the card can no longer be seen:
            the dialog covers the transcript, so it has to say which run it is
            showing. `pr-12` clears the dialog's own close button. */}
        <div className="shrink-0 border-b border-border/40">
          <div className="flex items-center gap-2.5 py-3 pr-12 pl-4">
            <span
              aria-hidden
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-md",
                failed
                  ? "bg-destructive/10 text-destructive"
                  : active
                    ? "bg-primary/10 text-primary"
                    : "bg-muted text-muted-foreground/70"
              )}
            >
              <RunIcon className="size-4" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <DialogTitle
                className={cn(
                  "truncate text-sm leading-4 font-medium",
                  failed ? "text-destructive" : "text-foreground",
                  active && "harness-shimmer"
                )}
              >
                {name}
              </DialogTitle>
              {subtitle && (
                <span className="truncate text-[11px] leading-4 tabular-nums text-muted-foreground/60">
                  {subtitle}
                </span>
              )}
            </span>
            <WorkflowPill state={runState} />
          </div>
          {all.length > 0 && <WorkflowMeter phases={phases} className="px-4 pb-2.5" />}
        </div>
        {/* Sidebar and pane. On a desktop they sit side by side; on a phone
            they are one column and selecting swaps the list for the panel,
            whose header grows the way back (see `WorkflowStepPanel`).

            The sidebar is a Tabs.List: phase headers and pending rows ride
            inside it in document order — they are not tabs and never take the
            roving focus, so ↑/↓ walk the steps. Selection is manual
            (`activateOnFocus` left off): a panel is a whole transcript, and
            activating on focus would open one on the way past. Arrows move,
            Enter/Space picks. */}
        <Tabs.Root
          orientation="vertical"
          value={selected}
          onValueChange={(value) => setSelected(value as string | null)}
          className="flex min-h-0 flex-1"
        >
          <Tabs.List
            className={cn(
              "flex w-full flex-col overflow-y-auto p-1.5 pb-2 outline-none sm:w-64 sm:shrink-0 sm:border-r sm:border-border/40",
              selected !== null && "max-sm:hidden"
            )}
          >
            {/* A run whose first spawn has arrived but whose outline has not
                (an older server) draws no rows at all, and an empty sidebar
                reads as a broken dialog rather than as a pipeline about to
                start. */}
            {all.length === 0 && (
              <div className={cn("px-2 py-1.5 text-xs leading-6 text-muted-foreground/60", active && "harness-shimmer")}>
                {active ? "Starting…" : "No steps ran"}
              </div>
            )}
            {phases.map((phase, p) => (
              <div key={phase.name ?? p}>
                {banded && phase.name !== null && <WorkflowPhaseHeader phase={phase} />}
                {phase.steps.map((step) =>
                  step.group ? (
                    <WorkflowStepTab key={step.group.id} group={step.group} />
                  ) : (
                    <WorkflowPendingItem key={`${phase.name ?? p}:${step.name}`} name={step.name} />
                  )
                )}
              </div>
            ))}
          </Tabs.List>
          {/* One panel per step; Base UI mounts only the selected one, so a
              run of nine steps costs one transcript and not nine. */}
          <div className={cn("min-h-0 min-w-0 flex-1 flex-col", selected === null ? "hidden sm:flex" : "flex")}>
            {runSteps.map((step) => (
              <WorkflowStepPanel
                key={step.id}
                group={step}
                onBack={() => setSelected(null)}
                showTimestamps={showTimestamps}
              />
            ))}
            {/* Nothing picked: the pane beside the list would otherwise be a
                hole the width of the dialog. Desktop-only by construction —
                on a phone no selection means the list has the column. */}
            {selected === null && (
              <div className="flex flex-1 items-center justify-center p-6 text-xs text-muted-foreground/60">
                Select a step to see its events
              </div>
            )}
          </div>
        </Tabs.Root>
      </DialogContent>
    </Dialog>
  )
}

/** A harness workflow run (`WorkflowGroup`) as the card above. */
export const WorkflowRun = React.memo(function WorkflowRun({
  group,
  showTimestamps,
}: {
  group: WorkflowGroup
  showTimestamps?: boolean
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
 * have to fit on one line, and the sidebar says all three in full.
 */
export const SubagentBatchRun = React.memo(function SubagentBatchRun({
  group,
  showTimestamps,
}: {
  group: SubagentBatch
  showTimestamps?: boolean
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
    />
  )
})
SubagentBatchRun.displayName = "SubagentBatchRun"

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
        <div key={row.id} className="harness-item-in">
          <RowView
            row={row}
            showTimestamps={showTimestamps}
            streaming={active && i === showing.length - 1}
          />
        </div>
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
  /* Read here rather than in the one case that prints it: a switch is not a
     place a hook can live. Only a thought uses it — a tool row draws its own
     inside ToolStep, and the other kinds are not steps. */
  const stepTokens = useStepTokens(item.id)
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
                <BubbleContent dir="auto" className="rounded-2xl rounded-br-sm px-4 py-2.5 text-sm">
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
                <BubbleContent dir="auto" className="text-sm leading-relaxed">
                  <StreamedAgentText text={item.text} streaming={streaming} />
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
              className="h-6 shrink-0 gap-1 rounded-pill px-2 text-[11px]"
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
      /* A request that ended on its thinking — no tool call after it — files
         its cost here, and this is the row that has to print it or the reading
         is simply lost. Never while it streams: the figure lands with the
         request that is still being written. */
      const tokens = view.showTokens && !streaming ? stepTokens : undefined

      return (
        <StepRow
          icon={KIND_ICONS.think}
          status={streaming ? "in_progress" : null}
          label={streaming ? "thinking" : undefined}
          startedAt={streaming ? item.at : undefined}
          metric={tokens ? <StepTokens usage={tokens} itemId={item.id} /> : undefined}
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
  /* What the request that ended on this call cost. Only the step it ended on
     carries one, so most rows in a run have none — that is the reading being
     honest about which step it can be pinned to, not a gap. */
  const stepTokens = useStepTokens(item.id)
  const tokens = view.showTokens ? stepTokens : undefined
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
      fileRange={fileRangeOf(item) ?? undefined}
      mono={!heading.prose}
      /* No outcome here. The header line is the title and the command that
         produced it; churn counts and echoed output lines competed with both
         for the same strip of row, and a long one pushed the command it
         belonged to out of view. What happened is in the body — the diff, the
         output, the matches — where it is the thing being read rather than a
         teaser for it. `failed` still reaches the row, as the label. */
      metric={
        tokens || showTimestamp ? (
          <>
            {tokens ? <StepTokens usage={tokens} itemId={item.id} /> : null}
            {tokens && showTimestamp ? " · " : null}
            {showTimestamp ? <Timestamp at={item.at} /> : null}
          </>
        ) : undefined
      }
      startedAt={item.startedAt}
      detail={hasBody || active ? <ToolDetail item={item} active={active} /> : undefined}
      below={<ToolSources item={item} />}
      defaultOpen={view.showToolDetails || toolOpensByDefault(item)}
      openSetting={view.showToolDetails}
    />
  )
})
ToolStep.displayName = "ToolStep"
