import * as React from "react"
import {
  ArrowUpRightIcon,
  BotIcon,
  LoaderCircleIcon,
  PlayIcon,
  WrenchIcon,
} from "lucide-react"
import { ChevronRightIcon, CopyIcon } from "lucide-react"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import { ItemContextMenu } from "@/components/item-context-menu"
import { Message, MessageContent } from "@/components/ui/message"
/* The tool-call layouts and the boxes they are built from live in their own
   files — see the header comment on each. This one keeps the transcript's own
   rows: a message, a step, a plan, a compaction. The shared step chrome is
   `step-row.tsx`, the non-recursive leaf layouts are `thread-cards.tsx`, and
   the workflow/subagent *run* card and its dialog are `workflow-run.tsx`;
   what stays here is the mutually recursive cluster (RowView / ThreadItemView
   / ToolRun / SubagentStep / SubagentBody), which cannot move apart without a
   module cycle — which is also why `SubagentBody` reaches the run's step rows
   as workflow-run's `stepBody` prop rather than as an import. */
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
import { copyText, StepRow, yieldToTextSelection } from "@/components/step-row"
import {
  collectTools,
  stepUsage,
  SubagentBatchRun,
  subagentHasBody,
  useStepThread,
  WorkflowRun,
} from "@/components/workflow-run"
import {
  AutonomyStep,
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
import { StepTokens, TokenFigure, useStepTokens } from "@/components/token-usage"
import { cn } from "@/lib/utils"
import { useViewOptionsContext } from "@/lib/view-options"
import type { ThreadItem, ToolItem } from "@/lib/store"
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
  if (row.kind === "workflow-group")
    return <WorkflowRun group={row} showTimestamps={showTimestamps} stepBody={SubagentBody} />
  if (row.kind === "subagent-batch")
    return <SubagentBatchRun group={row} showTimestamps={showTimestamps} stepBody={SubagentBody} />
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
    case "autonomy":
      return <AutonomyStep item={item} showTimestamp={showTimestamps} />
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
