/* The tool-call layouts and the boxes they are built from live in their own
   files — see the header comment on each. This one keeps the transcript's own
   rows: a message, a step, a plan, a compaction. The shared step chrome is
   `step-row.tsx`, the non-recursive leaf layouts are `thread-cards.tsx`, and
   a run of them (a workflow, a batch of subagents) is `workflow-run.tsx`;
   what stays here is the mutually recursive cluster (RowView / ThreadItemView
   / ToolRun / SubagentStep / SubagentBody), which cannot move apart without a
   module cycle — which is also why `SubagentStep` reaches a run's list as
   workflow-run's `stepRow` prop rather than as an import. */
/* The three siblings under `thread-items/` are the parts of this file that are
   NOT in that cluster and so could leave it: `summaries.tsx` (what a folded
   run and a folded thought say about themselves), `rail.tsx` (the run rail's
   geometry and its "N earlier steps" head) and `user-message.tsx` (a user
   bubble's prose and its pasted-text toggles). Each is imported one way, from
   here. There is no barrel above this directory: callers import the file
   that owns what they use (the row views here, `tool-parts.tsx` for the
   kind chips and `Prose`, `thread-cards.tsx` for `SourcesStrip`). */
import * as React from "react"
import {
  ArrowUpRightIcon,
  BotIcon,
  EyeIcon,
  ListTodoIcon,
  PlayIcon,
  WrenchIcon,
} from "lucide-react"
import { ChevronRightIcon, CopyIcon, GitBranch as GitBranchIcon, History as HistoryIcon } from "lucide-react"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import { ItemContextMenu } from "@/components/item-context-menu"
import { Message, MessageContent } from "@/components/ui/message"
import { SkeletonText } from "@/components/ui/skeletons"
import { MessageAttachments } from "@/components/message-attachments"
import { loadAgentTranscript, useAgentTranscript } from "@/lib/agent-transcripts"
import { loadSettings } from "@/lib/settings"
import {
  DetailSection,
  KIND_CHIPS,
  KIND_COLORS,
  KIND_ICONS,
  SmartBlock,
  Timestamp,
} from "@/components/tool-parts"
import {
  BriefSection,
  SubagentBrief,
  SubagentReport,
  ToolDetail,
  ToolSources,
  toolHasDetail,
  toolOpensByDefault,
} from "@/components/tool-views"
import { copyText, RAIL_CLASS, StepMeta, StepRow, yieldToTextSelection } from "@/components/step-row"
import {
  collectTools,
  stepNameOf,
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
  ShellRun,
  ShellStep,
  StreamedAgentText,
  StreamedProse,
  TaskNotificationCard,
} from "@/components/thread-cards"
import {
  pluralNoun,
  RunAvatarStack,
  RunSummary,
  summarise,
  thoughtPreview,
} from "@/components/thread-items/summaries"
import {
  EarlierSteps,
  PEEK,
  RAIL_ELBOW,
  RAIL_TAIL,
  RAIL_THROUGH,
  RUN_RAIL_CLASS,
} from "@/components/thread-items/rail"
import { UserMessageText } from "@/components/thread-items/user-message"
import {
  childToolTitle,
  extractSubagent,
  fileRangeOf,
  parseTaskNotification,
  toolHeading,
  toolKindOf,
  toolViewOf,
  workflowAgentItems,
} from "@/lib/tools"
import { buildRows } from "@/lib/transcript-rows"
import type { Row, SubagentGroup, ToolGroup, ToolRunGroup } from "@/lib/transcript-rows"
import { StepTokens, TokenSummary, useStepTokens } from "@/components/token-usage"
import { Logo } from "@/components/ui/logo"
import { cn, stagger } from "@/lib/utils"
import { useViewOptionsContext } from "@/lib/view-options"
import type { TextItem, ThreadItem, ToolItem } from "@/lib/store"
import { threadPath } from "@/lib/router"
import { FilePreviewContext, projectPath } from "@/lib/file-preview"
import { Link } from "react-router"

export const ToolRun = React.memo(function ToolRun({
  items,
  nestedRows,
  showTimestamps,
  tail,
}: {
  items: Array<ToolItem | TextItem>
  nestedRows?: ToolGroup["children"]
  showTimestamps?: boolean
  /** This group is the transcript's last row and the turn is still open — the
      agent has said nothing since, so the run is not finished being written
      even in the gaps between its calls. */
  tail?: boolean
}) {
  /* Thoughts travel inside the group with the calls they explain, but only
     tool calls contribute to its summary and status. */
  const tools = items.filter((item): item is ToolItem => item.kind === "tool")
  const failed = tools.filter((item) => item.status === "failed").length
  const active = tools.some((item) => item.status === "in_progress" || item.status === "pending")
  const summary = summarise(tools)
  const displayItems: Array<ToolItem | TextItem | ToolRunGroup> = nestedRows ?? items
  const displayLength = displayItems.length
  const view = useViewOptionsContext()
  /* Open while it runs, folded once it has. A group is a sequence of tool calls
     with their interleaved thoughts — `groupToolRuns` breaks on other content —
     so the summary line heads the steps that belong together; while they are happening that
     heading is a number that ticks,
     and the work belongs on screen. Finished, the counting line IS the
     reading ("read 12 files"), and a scrolled-back transcript should be the
     prose with its work folded beside it rather than every step the agent
     ever took.

     `active` alone is the wrong test for "still going", and that is what `tail`
     is for. A step settles the instant its call returns, so between two calls
     of one run there is a moment with nothing pending — on `active` alone the
     group folded and re-opened around every gap, which is the transcript
     rewriting itself while it is being read. The group at the *end* of an open
     turn is still being written whatever its steps are doing at this instant,
     and it stops being that the moment a different row lands after it: the
     agent has moved on, so the run becomes the history the counting line
     describes.

     Derived rather than seeded, and this is the `useState` trap the view
     options warn about: an initialiser reading these is read once, so a run
     that mounted live would stay open forever and one replayed from the
     journal would stay shut. `open` is the reader's answer when they have
     given one and the run's own state otherwise, so a hand-opened group stays
     open through the turn that follows it and a hand-closed one stays closed. */
  const [choice, setChoice] = React.useState<boolean | null>(null)
  /* A step the transcript would have opened on its own keeps that answer inside
     the run: a single edit shows its diff without being asked, and a batch of
     edits grouped into one run may not fold away the thing each step exists to
     show. The run's own fold is about counting finished work; the steps inside
     a run opened this way keep their own defaultOpen (reads and searches stay
     one-line rows), and the reader's hand still wins over all of it. */
  const live = active || tail === true
  const open = choice ?? ((view.openRunningGroup && live) || tools.some(toolOpensByDefault))
  const setOpen = (value: boolean | ((previous: boolean) => boolean)) =>
    setChoice(typeof value === "function" ? value(open) : value)

  /* A run the reader has closed by hand while it is *still running* keeps its
     tail visible rather than going fully dark: the group the agent is inside
     is the one thing on screen that is actually happening, and a live process
     reduced to a number that ticks is not a reading of it. Three: enough to
     see what it just did and what it is doing, few enough that the transcript
     is not re-expanding itself behind your back. A finished run shows nothing,
     which is what the counting line is for — so the peek closes on its own
     when the run ends. */
  /* `live`, not `active`: folded by the option, a peek keyed on `active` would
     blink out in every gap between two calls — the flicker `tail` exists for. */
  const showing = open ? displayItems : live ? displayItems.slice(-PEEK) : []
  const hidden = live && !open ? displayLength - showing.length : 0

  /* How many of `showing` were already on screen at the last commit, which is
     what the entrance staggers off (`--item-i`, index.css). The steps' place
     in the *list* is the wrong number: a run that streams one step at a time
     mounts one row, and that row is its batch's first, so it waits for
     nothing. Only a burst spreads — a replay, or this run being opened onto
     the steps the peek had folded. Read in render and written in an effect,
     never assigned during the render itself: under StrictMode's double pass
     the second render would read what the first had just written and stagger
     nothing, in dev only, which is the half of the feature you look at. */
  const shown = React.useRef(0)
  const already = shown.current
  React.useEffect(() => {
    shown.current = showing.length
  })

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
        <RunAvatarStack items={items} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs leading-6 text-muted-foreground",
            active && "harness-shimmer"
          )}
        >
          <RunSummary summary={summary} />
        </span>
        {/* The run's own trailing column, on the same group its steps use — a
            count that sits a pixel off the rows it heads reads as a different
            kind of thing than it is. */}
        <StepMeta parts={[failed > 0 ? <span className="text-destructive">{failed} failed</span> : null]} />
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
              style={stagger(index - already)}
              className={cn(
                "harness-item-in",
                RAIL_ELBOW,
                index < showing.length - 1 && RAIL_TAIL
              )}
            >
              {/* Nested rows retain their own same-view fold; direct items use
                  the ordinary step renderer and preserve a live thought tail. */}
              {item.kind === "run" ? (
                <RowView row={item} showTimestamps={showTimestamps} streaming={tail && index === showing.length - 1} />
              ) : item.kind === "tool" ? (
                <ToolStep item={item} showTimestamp={showTimestamps} />
              ) : (
                <ThreadItemView
                  item={item}
                  showTimestamps={showTimestamps}
                  streaming={tail && index === showing.length - 1}
                />
              )}
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
  onRetryAsPaths,
  onDismiss,
  onRewind,
  onFork,
  showTimestamps,
  streaming,
}: {
  row: Row
  onContinue?: () => void
  onRetry?: () => void
  onRetryAsPaths?: () => void
  onDismiss?: () => void
  /** Present on a finished user turn that can be rewound — see ThreadItemView. */
  onRewind?: () => void
  /** Present where the agent's runtime can branch: a new thread carrying the
      conversation through this turn. Same surface as rewind, minus the scope —
      a fork never touches the parent, so there is nothing to choose. */
  onFork?: () => void
  showTimestamps?: boolean
  /** This row is the transcript's tail and the turn is still open — it is the
      one thing still being written. Only a thought draws differently for it
      (see ThreadItemView); prose streams visibly on its own. */
  streaming?: boolean
}) {
  if (row.kind === "run")
    return <ToolRun items={row.items} showTimestamps={showTimestamps} tail={streaming} />
  if (row.kind === "tool-group")
    return <ToolRun items={row.items} nestedRows={row.children} showTimestamps={showTimestamps} tail={streaming} />
  if (row.kind === "shell-run")
    return <ShellRun items={row.items} showTimestamps={showTimestamps} />
  if (row.kind === "subagent-group") return <SubagentStep group={row} showTimestamps={showTimestamps} />
  if (row.kind === "workflow-group")
    return <WorkflowRun group={row} showTimestamps={showTimestamps} stepRow={SubagentStep} />
  if (row.kind === "subagent-batch")
    return <SubagentBatchRun group={row} showTimestamps={showTimestamps} stepRow={SubagentStep} />
  return (
    <ThreadItemView
      item={row}
      onContinue={onContinue}
      onRetry={onRetry}
      onRetryAsPaths={onRetryAsPaths}
      onDismiss={onDismiss}
      onRewind={onRewind}
      onFork={onFork}
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

  /* One naming rule for a subagent, in a run or on its own: the workflow
     definition's name for the step when there is one, else what the worker was
     asked to do. Shared with the run's list (`stepNameOf`) so a step does not
     change its name depending on where it is read. */
  const target = stepNameOf(group)
  const captionOf = tool
    ? [call?.agentType, call?.model].filter(Boolean).join(" · ") || undefined
    : session!.name
  /* Who the worker is and what it has done so far share the second line, not
     the trailing column: that column is `shrink-0` (it holds figures that must
     not wrap), and a sentence parked in it took a narrow panel's whole width
     and left the name nothing. The caption truncates; the figures stay. */
  const who = captionOf === target ? undefined : captionOf
  const steps = collectTools(children)
  const prose = summarise(steps)
    .map(({ verb, noun, count }) => `${verb} ${count} ${pluralNoun(noun, count)}`)
    .join(", ")
  const caption = [who, prose].filter(Boolean).join(" · ") || undefined
  const stepThread = useStepThread(group)
  const hasBody = subagentHasBody(group, stepThread)
  const tokens = view.showTokens ? stepUsage(group) : undefined
  const peek = view.subagentPeek === "always" || (view.subagentPeek === "live" && active)

  return (
    <StepRow
      icon={BotIcon}
      iconAccent={KIND_COLORS.other}
      iconChip={KIND_CHIPS.other}
      status={status}
      label={label}
      target={target}
      caption={caption}
      mono={false}
      startedAt={head.startedAt}
      metric={[
        tokens ? <TokenSummary usage={tokens} label="This step" /> : null,
        showTimestamps ? <Timestamp at={head.at} /> : null,
      ]}
      detail={
        hasBody ? (
          <SubagentBody
            group={group}
            stepThread={stepThread}
            showTimestamps={showTimestamps}
          />
        ) : undefined
      }
      /* The latest few steps of a folded worker, on the same rail and with the
         same "N earlier steps" head a peeking tool run has — which opens the
         row, as it opens a run. Open, the body carries the whole rail, so the
         peek steps aside rather than drawing its tail twice. Flush, because the
         rail brings its own indent and hangs off the mark, not the title. */
      belowFlush
      below={(open, setOpen) => {
        if (open || !peek) return undefined
        if (session?.transcript)
          return (
            <NativeStepTranscript
              transcript={session.transcript}
              active={active}
              showTimestamps={showTimestamps}
              limit={PEEK}
              onEarlier={() => setOpen(true)}
            />
          )
        if (children.length === 0 && !active) return undefined
        return (
          <SubagentTranscript
            rows={children}
            active={active}
            showTimestamps={showTimestamps}
            limit={PEEK}
            onEarlier={() => setOpen(true)}
          />
        )
      }}
      /* Opening is the reader's and "Expand tool output"'s; the peek above is
         its own option and never a reason to open the row. */
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
  const session = group.head.kind === "subagent" ? group.head : null
  const active = group.active
  return (
    <div className="space-y-2">
      {tool && <SubagentBrief item={tool} />}
      {/* A step the runtime previews rather than streams (a native workflow's
          agent — see `nativeWorkflowRun`). The same two sections a tool-headed
          step gets, from the only source there is for one of these. */}
      {session?.activity && active && (
        <p className="text-[11px] text-muted-foreground/70 harness-shimmer">{session.activity}</p>
      )}
      {session?.prompt && <BriefSection text={session.prompt} />}
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
      {(group.children.length > 0 || (active && !session?.transcript)) && (
        <SubagentTranscript rows={group.children} active={active} showTimestamps={showTimestamps} />
      )}
      {session?.transcript && (
        <NativeStepTranscript
          transcript={session.transcript}
          active={active}
          showTimestamps={showTimestamps}
        />
      )}
      {tool && <SubagentReport item={tool} active={active} />}
      {session?.report && (
        <DetailSection label={session.state === "failed" ? "Error" : active ? "Report so far" : "Report"}>
          <SmartBlock text={session.report} tone={session.state === "failed" ? "error" : undefined} />
        </DetailSection>
      )}
    </div>
  )
}

/** How often an open, still-working step re-reads its file. The agent is
    writing to it from another process, so there is nothing to push us. */
const NATIVE_STEP_REFRESH_MS = 6_000

/**
 * The rail of a native workflow step, read off the server's disk.
 *
 * Its agent runs inside the CLI and produces no ACP frames, so unlike every
 * other subagent this one has no children in the store — what it did is a file
 * (`agent-<agentId>.jsonl` beside the run's journal) that only the server can
 * read. Fetched only while its preview or details are visible: a run of thirty
 * agents is thirty files, and we never fetch the whole batch up front.
 *
 * The records become ordinary `ThreadItem`s (`workflowAgentItems`) and then
 * ordinary rows, so the rail, the tool views and the nesting are the same ones
 * the rest of the transcript uses — the file is where this history came from,
 * and the only place that fact is known.
 */
function NativeStepTranscript({
  transcript,
  active,
  showTimestamps,
  limit,
  onEarlier,
}: {
  transcript: { dir: string; agentId: string }
  active: boolean
  showTimestamps?: boolean
  limit?: number
  onEarlier?: () => void
}) {
  const events = useAgentTranscript(transcript.dir, transcript.agentId)
  const [failed, setFailed] = React.useState(false)
  const { dir, agentId } = transcript

  React.useEffect(() => {
    const settings = loadSettings()
    if (!settings) return
    let cancelled = false
    const read = (force: boolean) =>
      loadAgentTranscript(settings, dir, agentId, force).then(
        () => !cancelled && setFailed(false),
        () => !cancelled && setFailed(true)
      )
    void read(false)
    // A settled agent's file does not change, so only a live one is re-read.
    if (!active) return () => {
      cancelled = true
    }
    const timer = setInterval(() => void read(true), NATIVE_STEP_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [dir, agentId, active])

  const rows = React.useMemo(() => buildRows(workflowAgentItems(events), false, active), [events, active])

  if (rows.length === 0) {
    /* Still being read: lines where the transcript will be, not a sentence
       saying so — the tool-call views already stand in this way. */
    if (active && !failed) return <SkeletonText lines={3} className="py-0.5" />
    return (
      <p className="text-[11px] text-muted-foreground/70">
        {failed ? "Couldn't read this agent's transcript on the server." : "This agent left no transcript."}
      </p>
    )
  }
  return (
    <SubagentTranscript
      rows={rows}
      active={active}
      showTimestamps={showTimestamps}
      limit={limit}
      onEarlier={onEarlier}
    />
  )
}

/** A subagent's rows, on a rail: all of them, or — given a `limit` — the
    newest few under an "N earlier steps" head that `onEarlier` answers. */
function SubagentTranscript({
  rows: all,
  active,
  showTimestamps,
  limit,
  onEarlier,
}: {
  rows: Row[]
  active: boolean
  showTimestamps?: boolean
  limit?: number
  onEarlier?: () => void
}) {
  const rows = limit ? all.slice(-limit) : all
  const hidden = all.length - rows.length
  return (
    <div className={RAIL_CLASS}>
      {hidden > 0 && onEarlier && <EarlierSteps count={hidden} onClick={onEarlier} />}
      {rows.map((row, i) => (
        <div key={row.id} className="harness-item-in">
          <RowView
            row={row}
            showTimestamps={showTimestamps}
            streaming={active && i === rows.length - 1}
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
          <Logo working className="size-3.5 shrink-0" />
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
export const ThreadItemView = React.memo(function ThreadItemView({
  item,
  onContinue,
  onRetry,
  onRetryAsPaths,
  onDismiss,
  onRewind,
  onFork,
  showTimestamps = false,
  streaming = false,
}: {
  item: ThreadItem
  /** Present only on the transcript's last interrupt notice — see ThreadView. */
  onContinue?: () => void
  /** Present on an error row that knows the prompt it killed. */
  onRetry?: () => void
  /** Present when that prompt's attachments were delivered inline — see ErrorRow. */
  onRetryAsPaths?: () => void
  onDismiss?: () => void
  /** Present on a finished user turn: rewind the thread to before it. Absent
      while the turn runs, on untagged bubbles, and off the transcript's own
      turns (a subagent's prose is its report, not a turn to cut at). */
  onRewind?: () => void
  /** Present on a finished user turn whose agent can branch: fork the
      conversation through this turn into a new thread. Absent wherever rewind
      is, and on agents with no fork-point door (`rewindVia`). */
  onFork?: () => void
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
          onRetryAsPaths={onRetryAsPaths}
          onDismiss={onDismiss}
          showTimestamp={showTimestamps}
        />
      )
    case "user":
      return (
        <ItemContextMenu
          items={[
            { label: "Copy text", icon: <CopyIcon />, onClick: () => copyText(item.text) },
            ...(onRewind
              ? [
                  {
                    label: "Rewind to here",
                    icon: <HistoryIcon />,
                    onClick: onRewind,
                  } as const,
                ]
              : []),
            ...(onFork
              ? [
                  {
                    label: "Fork from here",
                    icon: <GitBranchIcon />,
                    onClick: onFork,
                  } as const,
                ]
              : []),
          ]}
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
                  {/* Above the prose, inside the same tinted bubble: what was
                      attached is part of the message, not a note beside it. */}
                  {item.attachments && item.attachments.length > 0 && (
                    <MessageAttachments attachments={item.attachments} />
                  )}
                  {item.text && <UserMessageText text={item.text} />}
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
          iconAccent={KIND_COLORS.think}
          iconChip={KIND_CHIPS.think}
          status={streaming ? "in_progress" : null}
          label={streaming ? "thinking" : undefined}
          startedAt={streaming ? item.at : undefined}
          metric={[tokens ? <StepTokens usage={tokens} itemId={item.id} /> : null]}
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
            <StreamedProse
              text={reasoning}
              streaming={streaming}
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
    case "shell":
      return <ShellStep item={item} showTimestamp={showTimestamps} />
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
  const toolView = toolViewOf(item)
  const webSearch = toolView === "websearch"
  const isTodoTool = toolView === "todos"
  const KindIcon = isTodoTool ? ListTodoIcon : KIND_ICONS[kind] ?? WrenchIcon
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
      iconAccent={isTodoTool ? "text-primary" : KIND_COLORS[webSearch ? "search" : kind] ?? KIND_COLORS.other}
      iconChip={isTodoTool ? "bg-primary/12" : KIND_CHIPS[webSearch ? "search" : kind] ?? KIND_CHIPS.other}
      toolLayout={view.toolLayout}
      target={heading.title}
      /* "Show the command" off leaves the sentence alone on the row. What was
         typed is still in the body, which is where it is read once the line
         above it says what the call was for. */
      caption={view.showToolCommand ? heading.detail : undefined}
      file={heading.file}
      filePath={heading.filePath}
      fileRange={fileRangeOf(item) ?? undefined}
      control={
        (kind === "read" || kind === "edit") && heading.filePath ? (
          <PreviewFileButton path={heading.filePath} />
        ) : undefined
      }
      mono={!heading.prose}
      /* No outcome here. The header line is the title and the command that
         produced it; churn counts and echoed output lines competed with both
         for the same strip of row, and a long one pushed the command it
         belonged to out of view. What happened is in the body — the diff, the
         output, the matches — where it is the thing being read rather than a
         teaser for it. `failed` still reaches the row, as the label. */
      metric={[
        tokens ? <StepTokens usage={tokens} itemId={item.id} /> : null,
        showTimestamp ? <Timestamp at={item.at} /> : null,
      ]}
      startedAt={item.startedAt}
      detail={hasBody || active ? <ToolDetail item={item} active={active} /> : undefined}
      firstRow={view.showToolSourcesOnFirstRow ? <ToolSources item={item} /> : undefined}
      below={!view.showToolSourcesOnFirstRow ? <ToolSources item={item} /> : undefined}
      defaultOpen={view.showToolDetails || toolOpensByDefault(item)}
      openSetting={view.showToolDetails}
    />
  )
})
ToolStep.displayName = "ToolStep"

/* A read's or a write's file, opened in the Preview panel through the same
   door a mention takes (`FilePreviewContext`). Beside the row, not on its
   badge: the badge sits inside the disclosure button, and a button may not
   hold a button. Nothing is drawn for a path outside the project or where no
   dock is in reach (a popout). */
function PreviewFileButton({ path }: { path: string }) {
  const ctx = React.useContext(FilePreviewContext)
  const target = ctx ? projectPath(path, ctx.scope) : null
  if (!ctx || !target) return null
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={`Preview ${target}`}
      title={`Preview ${target}`}
      onClick={() => ctx.open(target)}
      className="size-6 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/step:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
    >
      <EyeIcon className="size-3.5" />
    </Button>
  )
}
