/* ── The transcript's leaf layouts ── the per-kind cards and steps that do not
   recurse back into the row tree: agent prose with its demarcated blocks, a
   background task reporting back, an error, a compaction, a plan, the sources
   strip. The mutually recursive cluster (RowView / ThreadItemView / ToolRun /
   SubagentStep) stays in thread-items, which imports from here — never the
   reverse, so the two files cannot cycle. */
import * as React from "react"
import type * as acp from "@agentclientprotocol/sdk"
import {
  ChevronRightIcon,
  CopyIcon,
  FoldVerticalIcon,
  ListTodoIcon,
  PaperclipIcon,
  RotateCwIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
  UserRoundXIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ItemContextMenu, type MenuItemSpec } from "@/components/item-context-menu"
import { ContentBlockView, Prose, SmartBlock, SourceChip, Timestamp } from "@/components/tool-parts"
import { TodoList } from "@/components/tool-views"
import { copyText, formatElapsed, StepRow, yieldToTextSelection } from "@/components/step-row"
import { useStreamedText } from "@/hooks/use-streamed-text"
import type { StreamEffect } from "@/lib/stream-words"
import { resolveStreamEffect, useViewOptionsContext } from "@/lib/view-options"
import { shortPath, type TaskNotification, type TodoEntry } from "@/lib/tools"
import type { TurnSources } from "@/lib/sources"
import { cn } from "@/lib/utils"
import { autonomyLine } from "@/lib/autonomy-text"
import type { AutonomyItem, CompactionItem, PlanItem, ThreadItem } from "@/lib/store"

/* Explanatory agents emit their insight box as two backticked rule lines around
   the body — as markdown that's a pair of code chips with a wall of dashes.
   The rules are the frame, so drop them and render the body as a callout.
   Unterminated matches (still streaming) run to the end of the text. */
const INSIGHT_RE = /`?★[^\n]*?Insight[^\n]*\n([\s\S]*?)(?:\n?`?[─—–-]{5,}`?|$)/g

/* Codex's Plan mode wraps its proposal in a `<proposed_plan>` tag inside an
   ordinary assistant message. It is NOT an ACP plan: codex-acp sends no `plan`
   or `plan_update` frame for it, just the text with the tag in it — so without
   this the single most important thing in the turn arrives as undifferentiated
   prose wrapped in visible markup.

   Anchored to its own line at both ends, because agents talk ABOUT the tag as
   well as with it — this very thread contains "Wrap in <proposed_plan> so it
   renders…" in a question, and a loose pattern runs from that sentence to the
   real closing tag and swallows the conversation in between.

   Unterminated matches run to the end of the text, so a plan renders while it
   is still streaming instead of appearing only once it closes. That end-of-text
   test is `(?![\s\S])` and not `$` on purpose: `$` would need the `m` flag to
   pair with the line anchor, and under `m` it means end-of-LINE, which cuts
   every plan off after its first line. */
const PROPOSED_PLAN_RE =
  /(?:^|\n)<proposed_plan>[ \t]*\n([\s\S]*?)(?:\n[ \t]*<\/proposed_plan>|(?![\s\S]))/g

/* Structured output that agents demarcate inside plain text, because the
   protocol has no channel carrying it. Kept as a table rather than a chain of
   per-agent branches: a convention that earns a panel gets a row here, and the
   renderer never learns which agent it came from. */
const AGENT_BLOCKS = [
  { re: INSIGHT_RE, label: "Insight", mark: "★", accent: false },
  { re: PROPOSED_PLAN_RE, label: "Proposed plan", mark: "◆", accent: true },
] as const

function AgentBlock({
  label,
  mark,
  body,
  accent,
}: {
  label: string
  mark: string
  body: string
  accent: boolean
}) {
  return (
    <aside
      className={cn(
        "rounded-lg border px-4 py-3",
        // A proposal is waiting on a decision, so it reads a shade louder than
        // an aside that is only explaining something.
        accent ? "border-primary/30 border-l-2 border-l-primary/60 bg-primary/[0.03]" : "border-border/60 bg-muted/30"
      )}
    >
      <p
        className={cn(
          "mb-1.5 text-[11px] font-medium tracking-wider uppercase",
          accent ? "text-primary/80" : "text-muted-foreground"
        )}
      >
        <span aria-hidden>{mark}</span> {label}
      </p>
      <Prose text={body} />
    </aside>
  )
}

/**
 * Agent prose on the row that is currently being written.
 *
 * A component rather than a hook call at the `case "agent"` site: the kind
 * switch in `RowView` is a chain of returns, so a hook there would be a
 * conditional one. Everything else about the row is unchanged — `item.text` is
 * still the whole message everywhere it is read (copy, sources, search); only
 * the painted slice is paced.
 */
export function StreamedAgentText({ text, streaming }: { text: string; streaming: boolean }) {
  /* Read here rather than in `Prose`: the reveal is chosen once per row being
     written, and `Prose` is drawn a thousand times in a long transcript —
     subscribing every one of them to the option store would be a thousand
     subscriptions for a value only the tail can use. */
  const effect = useStreamEffect(streaming)
  return <AgentText text={useStreamedText(text, streaming)} stream={effect} />
}

/** The effect this row should draw with, or nothing when it is not the row
 *  being written. Calm motion has already been folded in. */
function useStreamEffect(streaming: boolean): StreamEffect | undefined {
  const options = useViewOptionsContext()
  return streaming ? resolveStreamEffect(options) : undefined
}

/**
 * Any other prose being written live — today, an open thought's detail.
 *
 * The same two halves `StreamedAgentText` puts together, without the block
 * conventions: the pacer decides when each word lands, the per-word reveal
 * decides what landing looks like. A component for the same reason that one is
 * — `RowView`'s kind switch is a chain of returns, so a hook at the call site
 * would be a conditional one.
 *
 * Reasoning arrives in the burstiest shape the wire has (a model goes quiet and
 * then emits a paragraph at once), which is exactly what the pacer is for; and
 * `StepRow` mounts the detail only while it is open, so a thought expanded
 * halfway through starts from what is already there rather than replaying it.
 */
export function StreamedProse({
  text,
  streaming,
  className,
}: {
  text: string
  streaming: boolean
  className?: string
}) {
  const effect = useStreamEffect(streaming)
  return <Prose text={useStreamedText(text, streaming)} stream={effect} className={className} />
}

export function AgentText({ text, stream }: { text: string; stream?: StreamEffect }) {
  const blocks = AGENT_BLOCKS.flatMap(({ re, label, mark, accent }) =>
    [...text.matchAll(re)].map((m) => ({
      start: m.index,
      end: m.index + m[0].length,
      body: m[1],
      label,
      mark,
      accent,
    }))
  ).sort((a, b) => a.start - b.start)
  if (blocks.length === 0) return <Prose text={text} stream={stream} />

  const parts: React.ReactNode[] = []
  let cut = 0
  for (const block of blocks) {
    // Two conventions claiming the same span: the earlier one already took it.
    if (block.start < cut) continue
    if (block.start > cut) parts.push(<Prose key={cut} text={text.slice(cut, block.start)} />)
    parts.push(<AgentBlock key={block.start} {...block} />)
    cut = block.end
  }
  /* The tail is the *message's* tail, so only the last run of prose asks for a
     reveal — handing it to every part would give each one a ramp of its own and
     soften text that was settled paragraphs ago. */
  if (cut < text.length) parts.push(<Prose key={cut} text={text.slice(cut)} stream={stream} />)

  return <div className="space-y-3">{parts}</div>
}

const compactTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1000)}k` : String(n)

/**
 * A background task reporting back.
 *
 * The runtime announces the end of the task as a synthetic user turn holding a
 * `<task-notification>` block (parsed in lib/tools). It is the other half of
 * the launch — the Workflow row started it, this says how it went — so it gets
 * a card of its own rather than a rule, and the failures are the point of it:
 * an audit where every stage died on a rate limit produced nothing, and the
 * only honest way to show that is to say so.
 */
export const TaskNotificationCard = React.memo(function TaskNotificationCard({
  task,
  at,
  showTimestamp,
}: {
  task: TaskNotification
  at?: number
  showTimestamp?: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const failed = task.failures.length > 0
  /* Every stage of a fan-out usually fails for ONE reason (a rate limit, a
     dead endpoint). Listing it five times buries the sentence; the stages that
     share a message are named together in front of it. */
  const grouped = React.useMemo(() => {
    const byMessage = new Map<string, string[]>()
    for (const failure of task.failures) {
      byMessage.set(failure.message, [...(byMessage.get(failure.message) ?? []), failure.label])
    }
    return [...byMessage.entries()].map(([message, labels]) => ({ message, labels }))
  }, [task.failures])

  const stats = [
    task.agentCount !== undefined && `${task.agentCount} agents`,
    task.agentsDone ? `${task.agentsDone} finished` : null,
    task.agentsError ? `${task.agentsError} failed` : null,
    task.durationMs !== undefined && formatElapsed(task.durationMs),
    task.subagentTokens !== undefined && `${compactTokens(task.subagentTokens)} tokens`,
  ].filter((entry): entry is string => typeof entry === "string")

  return (
    <div
      className={cn(
        "my-2 rounded-xl border px-3 py-2.5 text-xs",
        failed ? "border-destructive/30 bg-destructive/5" : "border-border/60 bg-muted/30"
      )}
    >
      <div className="flex items-start gap-2">
        {failed ? (
          <TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-destructive" />
        ) : (
          <ListTodoIcon className="mt-px size-3.5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className={cn("font-medium", failed ? "text-destructive" : "text-foreground")}>
            {task.summary ?? "Background task finished"}
          </p>
          {stats.length > 0 && (
            <p className="text-[11px] tabular-nums text-muted-foreground">{stats.join(" · ")}</p>
          )}
          {grouped.map(({ message, labels }, index) => (
            <div key={index} className="space-y-0.5">
              <p className="flex flex-wrap gap-1">
                {labels.map((label) => (
                  <span
                    key={label}
                    className="rounded bg-destructive/10 px-1.5 py-px font-mono text-[10px] text-destructive"
                  >
                    {label}
                  </span>
                ))}
              </p>
              <p className="text-[11px] text-muted-foreground">{message}</p>
            </div>
          ))}
          {task.result && (
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground/80 hover:text-foreground"
            >
              <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
              {open ? "Hide result" : "Show result"}
            </button>
          )}
          {open && task.result && <SmartBlock text={task.result} />}
          {/* The per-agent journal is still on disk, and the panel on the
              launch row above is already tailing it — so this says where the
              detail lives rather than repeating it here. */}
          {task.transcriptDir && (
            <p className="truncate font-mono text-[10px] text-muted-foreground/50" title={task.transcriptDir}>
              {shortPath(task.transcriptDir, 60)}
            </p>
          )}
          {showTimestamp && <Timestamp at={at} />}
        </div>
      </div>
    </div>
  )
})
TaskNotificationCard.displayName = "TaskNotificationCard"

/**
 * A failure, in the flow of the conversation. Loud enough not to be missed and
 * quiet enough not to be a modal: the headline says what the app was trying to
 * do, the line under it says why it failed, and the agent's own account of it
 * (a stack, a JSON-RPC `data` blob) stays folded until asked for — that text is
 * for debugging, and putting it on screen unbidden buries the sentence that
 * actually helps. Retry re-sends the exact prompt that died.
 */
export const ErrorRow = React.memo(function ErrorRow({
  item,
  onRetry,
  onRetryAsPaths,
  onDismiss,
  showTimestamp = false,
}: {
  item: Extract<ThreadItem, { kind: "error" }>
  onRetry?: () => void
  /** Offered only for the failure the capability story exists around: a turn
      that died carrying attachments that were delivered *inline*. It re-sends
      the same bytes pinned to the materialise-and-link branch. */
  onRetryAsPaths?: () => void
  onDismiss?: () => void
  showTimestamp?: boolean
}) {
  const [open, setOpen] = React.useState(false)
  /* Retry is a text path by construction — `turn_ended` carries the prompt,
     never the bytes — so a turn that had an image says so rather than quietly
     producing prose about a picture that is no longer there. */
  const carried = (item.retryAttachments?.length ?? 0) > 0
  const retryLabel = carried ? "Retry (text only)" : "Retry"
  // The pill buttons stay — they are the discoverable path. The menu repeats them.
  const menuItems: MenuItemSpec[] = [
    ...(onRetry ? [{ label: retryLabel, icon: <RotateCwIcon />, onClick: onRetry }] : []),
    ...(onRetryAsPaths
      ? [{ label: "Retry as file paths", icon: <PaperclipIcon />, onClick: onRetryAsPaths }]
      : []),
    ...(item.detail
      ? [
          {
            label: "Copy",
            icon: <CopyIcon />,
            onClick: () =>
              copyText([item.title, item.reason, item.detail].filter(Boolean).join("\n")),
          },
        ]
      : []),
    ...(onDismiss ? [{ label: "Dismiss", onClick: onDismiss }] : []),
  ]
  return (
    <ItemContextMenu
      items={menuItems}
      className="select-text"
      onContextMenu={yieldToTextSelection}
    >
      <div className="my-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs">
        <div className="flex items-start gap-2">
          <TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-medium text-destructive">{item.title}</p>
            {item.reason && <p className="text-muted-foreground">{item.reason}</p>}
            {item.detail && (
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="flex items-center gap-1 text-[11px] text-muted-foreground/80 hover:text-foreground"
              >
                <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
                {open ? "Hide details" : "Show details"}
              </button>
            )}
            {open && item.detail && (
              <pre className="max-h-56 overflow-auto rounded-md border border-destructive/20 bg-background/60 p-2 font-mono text-[11px] whitespace-pre-wrap">
                {item.detail}
              </pre>
            )}
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              {onRetry && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 gap-1 rounded-pill px-2 text-[11px]"
                  onClick={onRetry}
                  title={
                    carried
                      ? "Send that message again — the attachments do not travel with it"
                      : "Send that message again"
                  }
                >
                  <RotateCwIcon className="size-3" />
                  {retryLabel}
                </Button>
              )}
              {onRetryAsPaths && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 gap-1 rounded-pill px-2 text-[11px]"
                  onClick={onRetryAsPaths}
                  title="Send it again with the files written into the workspace and named by path, rather than inlined"
                >
                  <PaperclipIcon className="size-3" />
                  Retry as file paths
                </Button>
              )}
              {item.detail && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 rounded-pill px-2 text-[11px]"
                  onClick={() =>
                    void navigator.clipboard
                      ?.writeText([item.title, item.reason, item.detail].filter(Boolean).join("\n"))
                      .catch(() => {})
                  }
                >
                  <CopyIcon className="size-3" />
                  Copy
                </Button>
              )}
              {onDismiss && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 rounded-pill px-2 text-[11px] text-muted-foreground"
                  onClick={onDismiss}
                >
                  Dismiss
                </Button>
              )}
              {showTimestamp && <Timestamp at={item.at} />}
            </div>
          </div>
        </div>
      </div>
    </ItemContextMenu>
  )
})
ErrorRow.displayName = "ErrorRow"

/** A context compaction, in the place in the transcript where it happened —
    the marker saying the history above it is no longer what the agent can see.
    A step row like any other, with the retained summary folded behind it: the
    summary is the only part anyone reads twice, and it can be long. */
export const CompactionStep = React.memo(function CompactionStep({
  item,
  showTimestamp,
}: {
  item: CompactionItem
  showTimestamp?: boolean
}) {
  const running = item.status === "in_progress"
  const failed = item.status === "failed"
  const cancelled = item.status === "cancelled"
  const label = running
    ? "Compacting context…"
    : failed
      ? "Compaction failed"
      : cancelled
        ? "Compaction cancelled"
        : "Context compacted"
  // A failure explains itself even with no summary; a summary is worth opening
  // on any status. Nothing to show means a plain rule with no affordance.
  const detail =
    item.summary.length > 0 || item.error ? (
      <div className="min-w-0 space-y-2">
        {item.error && <p className="text-xs text-destructive">{item.error}</p>}
        {item.summary.map((block, i) => (
          <ContentBlockView key={i} block={block} />
        ))}
      </div>
    ) : undefined

  return (
    <StepRow
      icon={FoldVerticalIcon}
      status={running ? "in_progress" : failed ? "failed" : null}
      mono={false}
      target={label}
      metric={showTimestamp && item.at !== undefined ? <Timestamp at={item.at} /> : undefined}
      detail={detail}
    />
  )
})
CompactionStep.displayName = "CompactionStep"

/**
 * A question the harness answered for the user, in the transcript where it
 * happened.
 *
 * This row is the audit trail. The live permission card appears and resolves
 * itself under a watching reader, but neither event is journaled — so for a run
 * that fired on a schedule with nobody attached, and for every reload
 * afterwards, this is the only thing in the thread that says the agent asked at
 * all. It is drawn as a real row and not a muted aside for that reason: what it
 * records is the moment a routine did something no one was consulted about.
 *
 * `attention` is the ask-timeout, which is a different fact from any stance —
 * nobody came — and is the state a person can act on, so it takes the failed
 * tint the rest do not.
 */
export const AutonomyStep = React.memo(function AutonomyStep({
  item,
  showTimestamp,
}: {
  item: AutonomyItem
  showTimestamp?: boolean
}) {
  const line = autonomyLine(item)
  return (
    <StepRow
      icon={line.attention ? UserRoundXIcon : ShieldCheckIcon}
      status={line.attention ? "failed" : null}
      mono={false}
      target={line.title}
      metric={showTimestamp && item.at !== undefined ? <Timestamp at={item.at} /> : undefined}
      detail={<p className="text-xs leading-relaxed text-muted-foreground">{line.detail}</p>}
    />
  )
})
AutonomyStep.displayName = "AutonomyStep"

/**
 * The pages a turn's answer rests on, under the answer: what the agent read
 * and what it cited, as chips (see lib/sources for what counts). A search row
 * above lists everything the agent *saw*; this is the short list of what it
 * used, which is the one a reader wants to follow. Drawn only once the turn
 * has ended — mid-turn the list would grow under the reader's cursor.
 */
export const SourcesStrip = React.memo(function SourcesStrip({ turn }: { turn: TurnSources }) {
  if (turn.sources.length === 0) return null
  const consulted = [
    turn.searches > 0 && `${turn.searches} ${turn.searches === 1 ? "search" : "searches"}`,
    turn.fetches > 0 && `${turn.fetches} ${turn.fetches === 1 ? "page read" : "pages read"}`,
  ].filter(Boolean)
  return (
    <div className="mt-1 mb-2 flex min-w-0 flex-wrap items-center gap-1.5 pl-1">
      <span className="mr-0.5 text-[10px] font-semibold tracking-[0.08em] uppercase text-muted-foreground/50">
        Sources
      </span>
      {turn.sources.map((source) => (
        <SourceChip key={source.url} url={source.url} title={source.title} />
      ))}
      {consulted.length > 0 && (
        <span className="ml-auto text-[10px] text-muted-foreground/50">{consulted.join(" · ")}</span>
      )}
    </div>
  )
})
SourcesStrip.displayName = "SourcesStrip"

/** ACP's own plan entries, in the shape `TodoList` draws. The two vocabularies
    already agree on `content` and on all three statuses; this is the cast that
    says so. */
const toTodo = (entry: acp.PlanEntry): TodoEntry => ({
  content: entry.content,
  status: entry.status,
  priority: entry.priority,
})

export const PlanStep = React.memo(function PlanStep({ item }: { item: PlanItem }) {
  /* A plan the agent wrote as prose, or parked in a file. Neither has entries,
     so there is no progress to count and nothing to tick off — the content IS
     the plan. Rendering it as an empty checklist (which is what happened before
     these two variants were handled) said the agent had planned nothing. */
  if (item.markdown !== undefined || item.uri !== undefined) {
    return (
      <StepRow
        icon={ListTodoIcon}
        status={null}
        mono={false}
        target={item.uri ? shortPath(item.uri) : "plan"}
        detail={
          item.markdown !== undefined ? (
            <Prose text={item.markdown} />
          ) : (
            <span className="font-mono text-xs text-muted-foreground">{item.uri}</span>
          )
        }
      />
    )
  }

  const done = item.entries.filter((e) => e.status === "completed").length
  const current = item.entries.find((e) => e.status === "in_progress")
  // Agents often leave a plan with nothing in_progress (turn ended mid-list).
  // Headline the step that's up next, and only spin while one is actually running.
  const next = current ?? item.entries.find((e) => e.status !== "completed")
  return (
    <StepRow
      icon={ListTodoIcon}
      status={current ? "in_progress" : next ? null : "completed"}
      mono={false}
      target={next?.content ?? "all steps complete"}
      metric={`${done}/${item.entries.length}`}
      /* The same drawing a `TodoWrite` gets. Codex sends its checklist down
         ACP's plan channel and Claude Code and OpenCode send theirs as tool
         input, and a reader should not be able to tell which — where the list
         was read from is `lib/tools`' problem, not a difference in how a
         checklist looks. */
      detail={<TodoList todos={item.entries.map(toTodo)} />}
    />
  )
})
PlanStep.displayName = "PlanStep"
