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
import { AnimatePresence, m, useReducedMotion } from "motion/react"
import {
  ArrowUpRightIcon,
  BotIcon,
  ListTodoIcon,
  PlayIcon,
  SparklesIcon,
  WrenchIcon,
} from "lucide-react"
import { ChevronRightIcon, CopyIcon, GitBranch as GitBranchIcon, History as HistoryIcon } from "lucide-react"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import { ItemContextMenu } from "@/components/item-context-menu"
import { Message, MessageContent } from "@/components/ui/message"
import { SkeletonText } from "@/components/ui/skeletons"
import { MessageAttachments } from "@/components/message-attachments"
import { splitOpenuiFences } from "@/lib/openui/fences"
import { loadAgentTranscript, useAgentTranscript } from "@/lib/agent-transcripts"
import { loadSettings } from "@/lib/settings"
import {
  DetailSection,
  KIND_CHIPS,
  KIND_COLORS,
  KIND_ICONS,
  SmartBlock,
  THOUGHT_MAX_H,
  Timestamp,
} from "@/components/tool-parts"
import { ReportBlock } from "@/components/tool-views/report"
import { HarnessPreview, harnessMark as harnessMarkOf } from "@/components/tool-views/harness"
import { useFollowStream } from "@/hooks/use-follow-stream"
import {
  AskAgentChip,
  BriefSection,
  SubagentBrief,
  SubagentReport,
  ToolDetail,
  ToolSources,
  toolHasDetail,
  toolOpensByDefault,
} from "@/components/tool-views"
import {
  copyText,
  DISCLOSE_EXIT,
  finishedOpening,
  formatElapsed,
  StepDirContext,
  StepMeta,
  StepRow,
  textDir,
  yieldToTextSelection,
} from "@/components/step-row"
import {
  collectTools,
  stepNameOf,
  stepUsage,
  SubagentBatchRun,
  sessionBriefOf,
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
  VoiceStep,
  StreamedAgentText,
  StreamedProse,
  TaskNotificationCard,
} from "@/components/thread-cards"
import {
  pluralNoun,
  RunAvatarStack,
  RunSummary,
  summarise,
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
  harnessSummary,
  parseTaskNotification,
  toolHeading,
  toolKindOf,
  toolViewOf,
  workflowAgentItems,
  workflowAgentResult,
} from "@/lib/tools"
import { buildRows } from "@/lib/transcript-rows"
import type { Row, SubagentGroup, ToolGroup, ToolRunGroup, WorkFold } from "@/lib/transcript-rows"
import { StepTokens, TokenSummary, useStepTokens } from "@/components/token-usage"
import { Logo } from "@/components/ui/logo"
import { cn, stagger } from "@/lib/utils"
import { toolVariantOf, useLayoutOptionsContext } from "@/lib/layout-options"
import type { SubagentItem, TextItem, ThreadItem, ToolItem } from "@/lib/store"
import type { SubagentCall } from "@/lib/tools"
import { threadPath } from "@/lib/router"
import { Link } from "react-router"
import { ShimmerWave } from "@/components/ui/shimmer-wave"
import { BranchGutter, gutterWidth } from "@/components/thread-items/branch-gutter"
import { layoutRun } from "@/lib/tool-graph"


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
  /* One direction for the whole run, from its first call: its steps share a
     rail, and a rail cannot sit on both sides. */
  const dir = textDir(tools[0]?.title)
  const displayItems: Array<ToolItem | TextItem | ToolRunGroup> = nestedRows ?? items
  const displayLength = displayItems.length
  const view = useLayoutOptionsContext()
  const systemReducedMotion = useReducedMotion()
  const reduceMotion = view.calmMotion || systemReducedMotion
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
  const railRef = React.useRef<HTMLDivElement>(null)
  const isRun = tools.length > 1 || nestedRows !== undefined
  const [showRunHeader] = React.useState(isRun)
  /* A step the transcript would have opened on its own keeps that answer inside
     the run: a single edit shows its diff without being asked, and a batch of
     edits grouped into one run may not fold away the thing each step exists to
     show. The run's own fold is about counting finished work; the steps inside
     a run opened this way keep their own defaultOpen (reads and searches stay
     one-line rows), and the reader's hand still wins over all of it. */
  const live = active || tail === true
  const open = choice ?? ((view.openRunningGroup && live) || tools.some((tool) => toolOpensByDefault(tool, view.expandEdits)))
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

  /* Keep the identities already on screen, not just their count: regrouping a
     live tail can change its wrapper without making old tools new. When a live
     singleton becomes a run, all but the newest child were already visible as
     standalone rows before this component mounted. */
  const shown = React.useRef(new Set(tail ? displayItems.slice(0, -1).map((item) => item.id) : []))
  const already = shown.current
  const entranceIndex = new Map<string, number>()
  let nextEntrance = 0
  for (const item of showing) {
    if (!already.has(item.id)) entranceIndex.set(item.id, nextEntrance++)
  }
  React.useEffect(() => {
    shown.current = new Set(showing.map((item) => item.id))
  })

  /* The Branch layout draws the run as a commit graph instead of the elbow
     rail: lanes from the steps' own timing (`lib/tool-graph.ts`). */
  const branch = view.toolLayout === "branch"
  const branchVariant = toolVariantOf("branch", view.toolVariant)
  const graph = React.useMemo(
    () =>
      branch
        ? layoutRun(
            showing.map((item) =>
              item.kind === "tool"
                ? {
                    start: item.startedAt,
                    end: item.endedAt ?? (item.status === "in_progress" || item.status === "pending" ? undefined : item.startedAt),
                  }
                : {}
            )
          )
        : null,
    [branch, showing]
  )
  const gutter = graph ? gutterWidth(Math.max(0, ...graph.map((row) => row.lane)), branchVariant) : 0

  return (
    <StepDirContext.Provider value={dir}>
    <div dir={dir}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 py-0.5 text-start transition-colors duration-150 hover:bg-muted/40"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground/60 transition-transform duration-200",
            dir === "rtl" && "-scale-x-100",
            open && (dir === "rtl" ? "-rotate-90" : "rotate-90")
          )}
        />
        <RunAvatarStack items={items} />
        {/* English UI words, isolated: in an RTL run "2 files" would otherwise
            reorder into "files 2". */}
        <span
          dir="auto"
          className={cn(
            "min-w-0 flex-1 truncate text-xs leading-6 text-muted-foreground",
            dir === "rtl" ? "text-right" : "text-left",
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
      <AnimatePresence initial={false}>
        {showing.length > 0 && (
          /* One rail for both states, so expanding a peeking run grows the list
             in place instead of swapping one layout for another. */
          <m.div
            key="run-rail-clip"
            ref={railRef}
            initial={reduceMotion ? false : { height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0, transition: reduceMotion ? { duration: 0 } : DISCLOSE_EXIT }}
            transition={{ duration: reduceMotion ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
            onAnimationStart={() => {
              if (railRef.current) railRef.current.style.overflow = "hidden"
            }}
            onAnimationComplete={(definition) => {
              if (finishedOpening(definition) && railRef.current) railRef.current.style.overflow = "visible"
            }}
            className="overflow-hidden"
          >
            {/* The rail's spacing lives inside the clip, so it collapses with it. */}
            <div className={branch ? "ms-[calc(0.75rem-1px)] space-y-0.5 pt-0.5" : RUN_RAIL_CLASS}>
            {hidden > 0 && (
              <div className={branch ? undefined : RAIL_THROUGH} style={branch ? { paddingInlineStart: gutter } : undefined}>
                <EarlierSteps count={hidden} onClick={() => setOpen(true)} />
              </div>
            )}
            {/* Not `[data-message-id]` rows, so the transcript's entrance does
                not reach them on its own — the class is the same animation. */}
            {showing.map((item, index) => (
              <div
                key={item.id}
                style={{ ...stagger(entranceIndex.get(item.id) ?? -1), ...(branch ? { paddingInlineStart: gutter } : null) }}
                className={cn(
                  !already.has(item.id) && "harness-item-in",
                  branch ? "relative flow-root" : RAIL_ELBOW,
                  !branch && index < showing.length - 1 && RAIL_TAIL
                )}
              >
                {graph && (
                  <BranchGutter
                    row={graph[index]}
                    width={gutter}
                    variant={branchVariant}
                    status={item.kind === "tool" ? item.status : "completed"}
                    last={index === showing.length - 1}
                  />
                )}
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
          </m.div>
        )}
      </AnimatePresence>
    </div>
    </StepDirContext.Provider>
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
  compactError,
}: {
  row: Row
  compactError?: boolean
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
  if (row.kind === "work-fold")
    return <WorkFoldRow row={row} showTimestamps={showTimestamps} streaming={streaming} />
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
      compactError={compactError}
    />
  )
})
RowView.displayName = "RowView"

/** The tools a fold's own level holds — inside its runs and tool groups, but
    never inside a subagent or a workflow, which say what they did themselves.
    What the fold's counting line is summed from. */
function surfaceTools(rows: Row[]): ToolItem[] {
  const out: ToolItem[] = []
  for (const row of rows) {
    if (row.kind === "tool") out.push(row)
    else if (row.kind === "run")
      out.push(...row.items.filter((item): item is ToolItem => item.kind === "tool"))
    else if (row.kind === "tool-group") out.push(...collectTools(row.children))
  }
  return out
}

/**
 * The work between two things said, folded into one line (`answersOnly`,
 * layout-options). Collapsed by default and only ever opened by hand — this is
 * the one fold whose entire job is to not be read.
 *
 * It draws its rows back through `RowView`, which is what makes opening it
 * give the transcript back: the same steps, rails, cards and prose, re-shaped
 * by nothing. That recursion is also why it lives here, in the cluster that
 * may not come apart.
 */
const WorkFoldRow = React.memo(function WorkFoldRow({
  row,
  showTimestamps,
  streaming,
}: {
  row: WorkFold
  showTimestamps?: boolean
  /** The fold holds the transcript's tail and the turn is still open — its
      counting line speaks while the work is being written. */
  streaming?: boolean
}) {
  const view = useLayoutOptionsContext()
  const systemReducedMotion = useReducedMotion()
  const reduceMotion = view.calmMotion || systemReducedMotion
  const [open, setOpen] = React.useState(false)
  const railRef = React.useRef<HTMLDivElement>(null)
  const rows = row.rows
  const tools = surfaceTools(rows)
  const failed = tools.filter((tool) => tool.status === "failed").length
  const summary = summarise(tools)

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
        <RunAvatarStack items={tools} />
        {/* English UI words, isolated: in an RTL fold "2 files" would otherwise
            reorder into "files 2". */}
        <span
          dir="auto"
          className={cn(
            "min-w-0 flex-1 truncate text-xs leading-6 text-left text-muted-foreground",
            streaming && "harness-shimmer"
          )}
        >
          {summary.length > 0 ? (
            <RunSummary summary={summary} />
          ) : (
            <>
              <span className="text-foreground/80">{rows.length}</span> {pluralNoun("step", rows.length)}
            </>
          )}
        </span>
        <StepMeta parts={[failed > 0 ? <span className="text-destructive">{failed} failed</span> : null]} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <m.div
            key="work-fold-clip"
            ref={railRef}
            initial={reduceMotion ? false : { height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0, transition: reduceMotion ? { duration: 0 } : DISCLOSE_EXIT }}
            transition={{ duration: reduceMotion ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
            onAnimationStart={() => {
              if (railRef.current) railRef.current.style.overflow = "hidden"
            }}
            onAnimationComplete={(definition) => {
              if (finishedOpening(definition) && railRef.current) railRef.current.style.overflow = "visible"
            }}
            className="overflow-hidden"
          >
            {/* The rail's spacing lives inside the clip, so it collapses with it. */}
            <div className={RUN_RAIL_CLASS}>
              {rows.map((inner, index) => (
                <div key={inner.id} className={cn(RAIL_ELBOW, index < rows.length - 1 && RAIL_TAIL)}>
                  <RowView
                    row={inner}
                    showTimestamps={showTimestamps}
                    streaming={streaming && index === rows.length - 1}
                  />
                </div>
              ))}
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  )
})
WorkFoldRow.displayName = "WorkFoldRow"

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
 * the session the agent announced (the ACP subagent RFD). The RFD's brief is
 * the spawn's `task` and it has no report of its own — the child's prose IS
 * the report, and it is in the rail.
 */
export const SubagentStep = React.memo(function SubagentStep({
  group,
  showTimestamps,
  variant = "row",
}: {
  group: SubagentGroup
  showTimestamps?: boolean
  /** `body`: only what the step produced, without its header row — a run's
      navigation has already said whose step it is, and gives it the width. */
  variant?: "row" | "body"
}) {
  const { head, children } = group
  const view = useLayoutOptionsContext()
  /* A session head may carry the call that launched it (`group.launch`): the
     call brings the brief, the report and the agent type, the session the
     state. One step either way, whichever runtime announced it. */
  const tool = head.kind === "tool" ? head : (group.launch ?? null)
  const session = head.kind === "subagent" ? head : null
  const call = tool ? extractSubagent(tool) : null
  /* The RFD's states onto the step vocabulary: `failed` is a failure,
     `cancelled`/`disconnected` are endings that are not — they get the word
     in the label column, in the quiet colour, rather than "failed". */
  const headStatus = !session
    ? tool!.status
    : session.state === "running"
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
  const runsOn = subagentModelOf(group, call)
  /* An ask of another pair: the only worker here that is not this thread's own
     agent, so its row says who answered (`AskAgentChip`) and wears the app's
     accent rather than a tool kind's. Everything else about it is the plain
     subagent it already is — it is a real child thread of the parent's, and a
     launch call names the pair before the spawn has landed. */
  const ask = session?.ask
  const asked = ask !== undefined || call?.ask === true
  /* The pair is the chip's to say for an ask, so the raw `agent` argument — an
     id half the time — does not also sit in the caption under the title. */
  const captionOf = asked ? session?.name : (call?.agentType ?? runsOn.role ?? session?.name)
  /* Who the worker is and what it has done so far share the second line, not
     the trailing column: that column is `shrink-0` (it holds figures that must
     not wrap), and a sentence parked in it took a narrow panel's whole width
     and left the name nothing. The caption truncates; the figures stay. */
  const who =
    [captionOf === target ? undefined : captionOf, runsOn.model].filter(Boolean).join(" · ") || undefined
  const steps = collectTools(children)
  const prose = summarise(steps)
    .map(({ verb, noun, count }) => `${verb} ${count} ${pluralNoun(noun, count)}`)
    .join(", ")
  const caption = [who, prose].filter(Boolean).join(" · ") || undefined
  const stepThread = useStepThread(group)
  const hasBody = subagentHasBody(group, stepThread)
  const tokens = view.showTokens ? stepUsage(group) : undefined
  const peek = view.subagentPeek === "always" || (view.subagentPeek === "live" && active)

  if (variant === "body")
    return hasBody ? (
      <SubagentBody group={group} stepThread={stepThread} showTimestamps={showTimestamps} />
    ) : (
      <p className="text-xs text-muted-foreground/60">This step left nothing to show.</p>
    )

  return (
    <StepRow
      icon={BotIcon}
      iconAccent={asked ? "text-primary" : KIND_COLORS.other}
      iconChip={asked ? "bg-primary/10" : KIND_CHIPS.other}
      status={status}
      label={label}
      target={target}
      caption={caption}
      firstRow={ask ? <AskAgentChip ask={ask} /> : undefined}
      mono={false}
      startedAt={head.startedAt}
      /* Only a tool head has an ending to hand: the call that launched the
         worker settles when the worker does. A session head's end is the state
         update that closed it, which is not stamped on the item. */
      endedAt={head.kind === "tool" ? head.endedAt : undefined}
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
 * Which helper role a subagent was spawned on and the model it runs on: our
 * runtime's spawn says both (`SubagentItem.model`/`role` — on the head, or
 * nested under the `task` call that launched it); else a call that named its
 * own model (an OpenCode or Codex call) says that (docs/model-roles.md).
 */
function subagentModelOf(group: SubagentGroup, call: SubagentCall | null): { role?: string; model?: string } {
  const spawn: SubagentItem | undefined =
    group.head.kind === "subagent"
      ? group.head
      : group.children.find(
          (row): row is SubagentGroup & { head: SubagentItem } =>
            row.kind === "subagent-group" && row.head.kind === "subagent"
        )?.head
  return { role: spawn?.role ?? call?.agentType, model: spawn?.model || call?.model || undefined }
}

/**
 * Everything a subagent produced: brief, its own thread, its rail, its report.
 *
 * Split out of `SubagentStep` because a workflow step is drawn twice — as an
 * ordinary step row on its own, and as a row of the run's table — and the two
 * differ only in the header above this. A tool head brings its brief and
 * report; an RFD child's brief is its spawn's `task` (`sessionBriefOf`), and
 * its prose IS the report, already in the rail.
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
  const tool = group.head.kind === "tool" ? group.head : (group.launch ?? null)
  const session = group.head.kind === "subagent" ? group.head : null
  const brief = sessionBriefOf(group)
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
      {brief && <BriefSection text={brief} />}
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
      {session?.report && <NativeStepReport session={session} active={active} />}
    </div>
  )
}

/* The runtime's report is a 400-character preview, which never holds a whole
   JSON report — so once the step's transcript is read (`NativeStepTranscript`,
   mounted beside this, does the reading) its final answer replaces it. A
   failure keeps the runtime's error, which is not in the transcript. */
function NativeStepReport({ session, active }: { session: SubagentItem; active: boolean }) {
  const failed = session.state === "failed"
  const events = useAgentTranscript(session.transcript?.dir ?? "", session.transcript?.agentId ?? "")
  const full = React.useMemo(
    () => (failed || !session.transcript ? undefined : workflowAgentResult(events)),
    [events, failed, session.transcript]
  )
  return (
    <DetailSection label={failed ? "Error" : active ? "Report so far" : "Report"}>
      <ReportBlock text={full ?? session.report!} tone={failed ? "error" : undefined} />
    </DetailSection>
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
    <div className={RUN_RAIL_CLASS}>
      {hidden > 0 && onEarlier && (
        <div className={RAIL_THROUGH}>
          <EarlierSteps count={hidden} onClick={onEarlier} />
        </div>
      )}
      {rows.map((row, i) => (
        <div
          key={row.id}
          className={cn(
            "harness-item-in",
            RAIL_ELBOW,
            (i < rows.length - 1 || active) && RAIL_TAIL
          )}
        >
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
          <ShimmerWave text={rows.length === 0 ? "Starting…" : "Working…"} />
        </div>
      )}
    </div>
  )
}

/* Memoized — the transcript's row discriminator, and the thing that makes
   memo work up the tree: `item` is referentially stable for everything the
   reducer did not touch, so a streaming chunk re-renders only the changed rows
   instead of all n. The `useLayoutOptionsContext` inside reads the same
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
  compactError = false,
}: {
  item: ThreadItem
  /** The foot's status line is standing in for this failure — see ErrorRow. */
  compactError?: boolean
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
  const view = useLayoutOptionsContext()
  /* Read here rather than in the one case that prints it: a switch is not a
     place a hook can live. Only a thought uses it — a tool row draws its own
     inside ToolStep, and the other kinds are not steps. */
  const stepTokens = useStepTokens(item.id)
  const thoughtElapsed = useThoughtElapsed(
    item.kind === "thought" ? item.at : undefined,
    item.kind === "thought" ? item.endedAt : undefined,
    item.kind === "thought" && streaming
  )
  switch (item.kind) {
    case "error":
      return (
        <ErrorRow
          item={item}
          onRetry={onRetry}
          onRetryAsPaths={onRetryAsPaths}
          onContinue={onContinue}
          onDismiss={onDismiss}
          showTimestamp={showTimestamps}
          compact={compactError}
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
              were — the bubble still hugs the right edge, and may now grow to the full width. */}
          <Message align="end" className="flex-col items-end gap-0.5 py-2 data-[align=end]:flex-col">
            <MessageContent>
              <Bubble variant="tinted" align="end" className="max-w-full">
                <BubbleContent
                  dir="auto"
                  className="rounded-2xl rounded-br-sm px-4 py-2.5 text-sm [&_.chip]:bg-background/70 [&_.chip]:ring-1 [&_.chip]:ring-foreground/10 [&_.chip:hover]:bg-background"
                >
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
    case "agent": {
      const hasOpenui = splitOpenuiFences(item.text, streaming).some((part) => typeof part !== "string")
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
              <Bubble variant="ghost" className={hasOpenui ? "w-full max-w-full" : undefined}>
                <BubbleContent
                  dir="auto"
                  className={hasOpenui ? "w-full max-w-full text-sm leading-relaxed" : "text-sm leading-relaxed"}
                >
                  <StreamedAgentText text={item.text} streaming={streaming} />
                </BubbleContent>
              </Bubble>
            </MessageContent>
            {showTimestamps && <Timestamp at={item.at} />}
          </Message>
        </ItemContextMenu>
      )
    }
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
      /* A request that ended on its thinking — no tool call after it — files
         its cost here, and this is the row that has to print it or the reading
         is simply lost. Never while it streams: the figure lands with the
         request that is still being written. */
      const tokens = view.showTokens && !streaming ? stepTokens : undefined
      /* The clock is the block's own title, not a trailing reading: the whole
         point of the thought is the duration, and a label parked at the row's
         end left the reasoning squeezed into the column beside it. */
      const durationLabel =
        thoughtElapsed !== null
          ? `${streaming ? "Thinking" : "Thought for"} ${formatElapsed(thoughtElapsed)}`
          : undefined

      return (
        <StepRow
          dir={textDir(reasoning)}
          plain
          status={streaming ? "in_progress" : null}
          metric={[tokens ? <StepTokens usage={tokens} itemId={item.id} /> : null]}
          mono={false}
          /* The row is open for exactly as long as the thought streams: a live
             view you watch, not a block left standing in the transcript. When
             folded, it shows three lines of muted reasoning like assistant
             prose; clicking opens the full text. "Show thinking" arms the live
             view: off, the excerpt stays folded while the thought streams. */
          autoOpen={view.showThinking && !view.thoughtOneLine && streaming}
          openSetting={view.showThinking}
          target=""
          foldedTarget={
            view.thoughtOneLine ? (
              <ThoughtLabel label={durationLabel} />
            ) : (
              <ThoughtPreview text={reasoning} label={durationLabel} />
            )
          }
          detail={<ThoughtDetail text={reasoning} streaming={streaming} label={durationLabel} />}
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
    case "voice":
      return <VoiceStep item={item} showTimestamp={showTimestamps} />
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

/* The clock for a thought. Unlike a tool step's `useElapsed`, this one outlives
   the stream — a settled thought keeps saying "Thought for 12s" — but it must
   be *measured*, never re-derived. `at` is when the thought started, so
   `Date.now() - at` on any later mount (a scroll, a reload, a journal replay)
   is the age of the row, not how long it thought: that is where "Thought for
   177m 45s" came from. So the figure ticks while it streams and the last
   reading is frozen when the stream ends.

   A thought read back out of the journal is the case the freeze cannot cover —
   it mounts settled, with nothing frozen — and it used to say nothing at all.
   It now arrives with both ends: `at` is the run's first chunk as the journal
   wrote it and `endedAt` the last, so the length is the gap between them,
   measured server-side at the only moment it could be (see `coalescedPage`,
   which is what merges the run and can therefore see its end). Live, `endedAt`
   is absent and the ticking `elapsed` above stands. */
function useThoughtElapsed(
  startedAt: number | undefined,
  endedAt: number | undefined,
  streaming: boolean
): number | null {
  const [elapsed, setElapsed] = React.useState<number | null>(null)
  const settled = React.useRef<number | null>(null)

  React.useEffect(() => {
    if (startedAt === undefined) {
      settled.current = null
      setElapsed(null)
      return
    }
    if (!streaming) {
      setElapsed(settled.current)
      return
    }
    settled.current = null
    const update = () => setElapsed(Date.now() - startedAt)
    update()
    const timer = setInterval(update, 1000)
    return () => {
      clearInterval(timer)
      settled.current = Date.now() - startedAt
    }
  }, [startedAt, streaming])

  /* After the hooks, never before: a return above them would change what the
     next render calls. The order matters, because an item can have both
     readings: a socket that reattached mid-run rebuilds the item from the
     journal (`at`/`endedAt`, the run so far) and then watches the rest of it
     stream. There the frozen figure covers the whole run and the journal's end
     is stale by however long it kept going, so the measurement this mount took
     is the one that stands. */
  if (!streaming && settled.current !== null) return settled.current
  if (!streaming && startedAt !== undefined && endedAt !== undefined) {
    return Math.max(0, endedAt - startedAt)
  }
  return elapsed
}

/* Folded and expanded thoughts share one muted prose renderer. In expanded
   streaming state, cap and follow it so new text stays in view; settled detail
   starts at its beginning. */
function ThoughtLabel({ label }: { label?: string }) {
  return (
    <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70">
      {label ?? "Thinking"}
    </div>
  )
}

function ThoughtPreview({ text, label }: { text: string; label?: string }) {
  return (
    <div className="thought-surface">
      <ThoughtLabel label={label} />
      <div className="thought-detail thought-preview">
        <StreamedProse text={text} streaming={false} />
      </div>
    </div>
  )
}

function ThoughtDetail({ text, streaming, label }: { text: string; streaming: boolean; label?: string }) {
  const follow = useFollowStream(streaming)
  return (
    <div className="thought-surface">
      <ThoughtLabel label={label} />
      <div ref={follow.viewportRef} className={cn(THOUGHT_MAX_H, "overflow-y-auto overscroll-contain pr-1")}>
        <div ref={follow.contentRef}>
          <StreamedProse text={text} streaming={streaming} className="thought-detail" />
        </div>
      </div>
    </div>
  )
}

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
  /* The harness server's own two tools get their own mark, like a checklist —
     and a skill load gets a sparkle, so it reads as handing the agent a
     capability rather than as another generic call. */
  const isHarnessTool = toolView === "harness"
  const isSkillTool = toolView === "skill"
  const harnessMark = isHarnessTool ? harnessMarkOf(item) : null
  const KindIcon = isTodoTool
    ? ListTodoIcon
    : harnessMark
      ? harnessMark.Icon
      : isSkillTool
        ? SparklesIcon
        : KIND_ICONS[kind] ?? WrenchIcon
  const view = useLayoutOptionsContext()
  /* Both of these are `tool-views`' to answer, not this row's: whether an
     expansion would hold anything, and whether it should start open, both
     depend on which layout the call resolved to — and a chevron that opens an
     empty box is worse than no chevron. "Expand tool output" overrides the
     second, so the body is there to read without a click. */
  /* Raw data on, every step has a body — the call itself is always something. */
  const hasBody = toolHasDetail(item) || view.showRawToolData
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
      iconAccent={
        harnessMark
          ? harnessMark.accent
          : isTodoTool
            ? "text-primary"
            : isSkillTool
              ? "text-purple-600 dark:text-purple-400"
              : KIND_COLORS[webSearch ? "search" : kind] ?? KIND_COLORS.other
      }
      iconChip={
        harnessMark
          ? harnessMark.chip
          : isTodoTool
            ? "bg-primary/12"
            : isSkillTool
              ? "bg-purple-500/12"
              : KIND_CHIPS[webSearch ? "search" : kind] ?? KIND_CHIPS.other
      }
      toolLayout={view.toolLayout}
      toolVariant={view.toolVariant}
      target={heading.title}
      /* "Show the command" off leaves the sentence alone on the row. What was
         typed is still in the body, which is where it is read once the line
         above it says what the call was for. */
      caption={view.showToolCommand ? heading.detail : undefined}
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
      metric={[
        isHarnessTool && item.status !== "failed" ? harnessSummary(item) : null,
        tokens ? <StepTokens usage={tokens} itemId={item.id} /> : null,
        showTimestamp ? <Timestamp at={item.at} /> : null,
      ]}
      startedAt={item.startedAt}
      endedAt={item.endedAt}
      detail={hasBody || active ? <ToolDetail item={item} active={active} /> : undefined}
      firstRow={view.showToolSourcesOnFirstRow ? <ToolSources item={item} /> : undefined}
      below={
        isHarnessTool
          ? <HarnessPreview item={item} />
          : !view.showToolSourcesOnFirstRow
            ? <ToolSources item={item} />
            : undefined
      }
      defaultOpen={view.showToolDetails || toolOpensByDefault(item, view.expandEdits)}
      openSetting={`${view.showToolDetails}:${view.expandEdits}`}
    />
  )
})
ToolStep.displayName = "ToolStep"
