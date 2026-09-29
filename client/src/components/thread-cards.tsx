/* ── The transcript's leaf layouts ── the per-kind cards and steps that do not
   recurse back into the row tree: agent prose with its demarcated blocks, a
   background task reporting back, an error, a compaction, a plan, the sources
   strip. The mutually recursive cluster (RowView / ThreadItemView / ToolRun /
   SubagentStep) stays in thread-items, which imports from here — never the
   reverse, so the two files cannot cycle. */
import * as React from "react"
import type * as acp from "@daedalus/acp"
import {
  ChevronRightIcon,
  CopyIcon,
  FoldVerticalIcon,
  ListTodoIcon,
  PaperclipIcon,
  RotateCwIcon,
  ShieldCheckIcon,
  SquareTerminalIcon,
  TriangleAlertIcon,
  UserRoundXIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { ItemContextMenu, type MenuItemSpec } from "@/components/item-context-menu"
import {
  CARD,
  ContentBlockView,
  Disclosure,
  KIND_CHIPS,
  KIND_COLORS,
  KIND_ICONS,
  LABEL,
  Prose,
  ProseWithOpenui,
  ShellPane,
  SmartBlock,
  SourceChip,
  Timestamp,
} from "@/components/tool-parts"
import { TodoList } from "@/components/tool-views"
import { copyText, formatElapsed, StepMeta, StepRow, yieldToTextSelection } from "@/components/step-row"
import { useStreamedText } from "@/hooks/use-streamed-text"
import type { StreamEffect } from "@/lib/stream-words"
import { resolveStreamEffect, useViewOptionsContext } from "@/lib/view-options"
import { shortPath, toolHeading, type TaskNotification, type TodoEntry } from "@/lib/tools"
import type { TurnSources } from "@/lib/sources"
import { stripPromptSuggestions } from "@/lib/suggestions"
import { cn } from "@/lib/utils"
import { autonomyLine } from "@/lib/autonomy-text"
import type { AutonomyItem, CompactionItem, PlanItem, ShellItem, ThreadItem } from "@/lib/store"

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
  stream,
  streaming,
}: {
  label: string
  mark: string
  body: string
  accent: boolean
  stream?: StreamEffect
  streaming: boolean
}) {
  return (
    <aside
      className={cn(
        // The card geometry every notice in the flow shares, minus the `my-2`:
        // this one sits inside prose that already spaces its blocks.
        CARD,
        "my-0",
        // A proposal is waiting on a decision, so it reads a shade louder than
        // an aside that is only explaining something.
        accent ? "border-primary/30 border-l-2 border-l-primary/60 bg-primary/[0.03]" : "border-border/60 bg-muted/40"
      )}
    >
      <p className={cn(LABEL, "mb-1.5", accent && "text-primary/80")}>
        <span aria-hidden>{mark}</span> {label}
      </p>
      <ProseWithOpenui text={body} stream={stream} streaming={streaming} />
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
  const painted = useStreamedText(text, streaming)
  return (
    <div className="contents" data-stream-idle={useStreamIdle(painted, streaming) || undefined}>
      <AgentText text={painted} stream={effect} streaming={streaming} />
    </div>
  )
}

/** How long the painted text must hold still before the sweep's edge settles:
 *  past any gap between two words of one answer, well short of the wait for a
 *  tool call the model has moved on to. */
const STREAM_IDLE_MS = 600

/** True once a live row has painted nothing new for `STREAM_IDLE_MS`. Being the
 *  tail of a running turn is not the same as being written: after its last
 *  word the model may spend minutes on a tool call (a subagent), and the ramp
 *  would hold the last words faded for all of it. The next word resets it. */
function useStreamIdle(painted: string, streaming: boolean): boolean {
  const [idle, setIdle] = React.useState(false)
  React.useEffect(() => {
    setIdle(false)
    if (!streaming) return
    const timer = window.setTimeout(() => setIdle(true), STREAM_IDLE_MS)
    return () => window.clearTimeout(timer)
  }, [painted, streaming])
  return idle
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
  const painted = useStreamedText(text, streaming)
  return (
    <div className="contents" data-stream-idle={useStreamIdle(painted, streaming) || undefined}>
      <ProseWithOpenui text={painted} stream={effect} className={className} streaming={streaming} />
    </div>
  )
}

export function AgentText({
  text,
  stream,
  streaming = false,
}: {
  text: string
  stream?: StreamEffect
  /** The row is still being written — threaded to the openui view so a fence
      that has not closed yet draws as the program it currently is. */
  streaming?: boolean
}) {
  /* The suggestions fence never paints: its prompts live on the suggestion
     card under the answer (`prompt-suggestions.tsx`), and a raw fence in the
     painted answer is the machinery showing. Stripped for paint only —
     `item.text` is still whole everywhere it is read (copy, search, the
     journal). */
  const painted = stripPromptSuggestions(text)
  const blocks = AGENT_BLOCKS.flatMap(({ re, label, mark, accent }) =>
    [...painted.matchAll(re)].map((m) => ({
      start: m.index,
      end: m.index + m[0].length,
      body: m[1],
      label,
      mark,
      accent,
    }))
  ).sort((a, b) => a.start - b.start)
  /* Every run of prose goes through `ProseWithOpenui`, which is what turns a
     fenced `openui-lang` program into the view it describes — and it has to be
     every run, including this fast path.

     It was only the tail of a message that *also* carried a marked block, so a
     fence in an ordinary answer never reached the renderer at all: the message
     that reported this was drawn as its own source. The fences and the marks are
     independent conventions that happen to share a paragraph, and neither may
     gate the other. */
  if (blocks.length === 0)
    return <ProseWithOpenui text={painted} stream={stream} streaming={streaming} />

  const parts: React.ReactNode[] = []
  let cut = 0
  for (const block of blocks) {
    // Two conventions claiming the same span: the earlier one already took it.
    if (block.start < cut) continue
    if (block.start > cut)
      parts.push(
        <ProseWithOpenui
          key={cut}
          text={painted.slice(cut, block.start)}
          stream={stream}
          streaming={streaming}
        />
      )
    parts.push(
      <AgentBlock key={block.start} {...block} stream={stream} streaming={streaming} />
    )
    cut = block.end
  }
  /* The tail is the *message's* tail, so only the last run of prose asks for a
     reveal — handing it to every part would give each one a ramp of its own and
     soften text that was settled paragraphs ago. */
  if (cut < painted.length)
    parts.push(
      <ProseWithOpenui key={cut} text={painted.slice(cut)} stream={stream} streaming={streaming} />
    )

  return <div className="flex min-w-0 flex-col gap-3">{parts}</div>
}

const compactTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1000)}k` : String(n)

/* ── The transcript's alert vocabulary ──
   Four shapes say "something happened" in the flow, and they are deliberately
   four rather than one — the difference is what the reader has to do about it:

   — `AlertCard` (here): something the app reports, read and moved past. An
     error, or a task reporting back. The transcript's `CARD` geometry, a tone,
     a leading glyph and a stack of lines; `ErrorRow` and `TaskNotificationCard`
     are the two members, and the shell is what stops them drifting apart.
   — `AgentRequestCard` (`agent-request.tsx`): something *waiting on the
     reader* — an approval, a question, a held turn. A roomy, borderless tinted
     stack, because it is the one place the app asks rather than tells.
   — the interrupt rule (`thread-items/rows.tsx`): a break in the conversation
     with one line of what happened, no body to read.
   — `Notice` (`components/notice.tsx`): NOT a transcript shape — it belongs to
     the app's surfaces (a page, a dialog, the composer's strip). A transcript
     alert is a card in a column of conversation; a notice is a box on a page.

   The first two carry a payload with a tone and a glyph, which is the part that
   really was three copies of the same markup; the last two are single-purpose
   and share nothing worth extracting. */
const AlertCard = React.memo(function AlertCard({
  tone,
  icon,
  children,
}: {
  tone: "error" | "neutral"
  /** The leading glyph, tone-coloured by the caller. */
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        CARD,
        "text-xs",
        tone === "error"
          ? "border-destructive/30 bg-destructive/5"
          : "border-border/60 bg-muted/40"
      )}
    >
      <div className="flex items-start gap-2">
        <span className="mt-px shrink-0 [&>svg]:size-3.5">{icon}</span>
        <div className="min-w-0 flex-1 space-y-1.5">{children}</div>
      </div>
    </div>
  )
})
AlertCard.displayName = "AlertCard"

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
    <AlertCard
      tone={failed ? "error" : "neutral"}
      icon={
        failed ? (
          <TriangleAlertIcon className="text-destructive" />
        ) : (
          <ListTodoIcon className="text-muted-foreground" />
        )
      }
    >
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
                className="rounded-sm bg-destructive/10 px-1.5 py-px font-mono text-[10px] text-destructive"
              >
                {label}
              </span>
            ))}
          </p>
          <p className="text-[11px] text-muted-foreground">{message}</p>
        </div>
      ))}
      {task.result && (
        <Disclosure open={open} onToggle={() => setOpen((value) => !value)}>
          {open ? "Hide result" : "Show result"}
        </Disclosure>
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
    </AlertCard>
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
  /* Never gated on `detail`. A failure with only a headline and a reason is
     still a failure someone has to paste into an issue — and it is the case
     with the *least* to select by hand, since there is no expandable well
     under it holding the text. */
  const full = [item.title, item.reason, item.detail].filter(Boolean).join("\n")
  // The pill buttons stay — they are the discoverable path. The menu repeats them.
  const menuItems: MenuItemSpec[] = [
    ...(onRetry ? [{ label: retryLabel, icon: <RotateCwIcon />, onClick: onRetry }] : []),
    ...(onRetryAsPaths
      ? [{ label: "Retry as file paths", icon: <PaperclipIcon />, onClick: onRetryAsPaths }]
      : []),
    { label: "Copy", icon: <CopyIcon />, onClick: () => copyText(full) },
    ...(onDismiss ? [{ label: "Dismiss", onClick: onDismiss }] : []),
  ]
  return (
    <ItemContextMenu
      items={menuItems}
      className="select-text"
      onContextMenu={yieldToTextSelection}
    >
      <AlertCard tone="error" icon={<TriangleAlertIcon className="text-destructive" />}>
        <p className="font-medium text-destructive">{item.title}</p>
        {item.reason && <p className="text-muted-foreground">{item.reason}</p>}
        {item.detail && (
          <Disclosure open={open} onToggle={() => setOpen((v) => !v)}>
            {open ? "Hide details" : "Show details"}
          </Disclosure>
        )}
        {open && item.detail && (
          <pre className="max-h-56 overflow-auto rounded-sm border border-destructive/20 bg-background/50 p-2 font-mono text-[11px] whitespace-pre-wrap">
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
          <CopyButton
            text={full}
            label="Copy"
            className="h-6 gap-1 rounded-pill px-2 text-[11px] [&_svg]:size-3"
          />
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
      </AlertCard>
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
        {item.error && (
          <div className="flex items-start gap-1">
            <p className="min-w-0 flex-1 text-xs text-destructive">{item.error}</p>
            <CopyButton text={item.error} size="icon-xs" className="shrink-0 text-destructive" />
          </div>
        )}
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
      metric={[showTimestamp && item.at !== undefined ? <Timestamp at={item.at} /> : null]}
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
      metric={[showTimestamp && item.at !== undefined ? <Timestamp at={item.at} /> : null]}
      detail={<p className="text-xs leading-relaxed text-muted-foreground">{line.detail}</p>}
    />
  )
})
AutonomyStep.displayName = "AutonomyStep"

/**
 * A `!` command the reader ran against the thread's project, in the transcript
 * where it ran.
 *
 * **Drawn as a Bash step, because that is what it is.** The agent did not make
 * this call and was not told about it, but the thing itself — a shell line and
 * its stream — is exactly an `execute` tool call, so it is drawn the way the app
 * draws one: the same kind icon, the same heading rule (`toolHeading`, which
 * turns a recognisable command into a sentence and leaves the rest as written),
 * and the same `ShellPane` body. Two vocabularies for one act is the thing that
 * reads as a bug.
 *
 * The one thing it does differently is open: a Bash step folds itself away, and
 * nothing else in the thread says what a `!` command printed, so a folded one
 * would be a row with no reading in it. It is also drawn from the moment the
 * line starts — a command that showed nothing until it finished would read as
 * one that was ignored.
 */
export const ShellStep = React.memo(function ShellStep({
  item,
  showTimestamp,
}: {
  item: ShellItem
  showTimestamp?: boolean
}) {
  const view = useViewOptionsContext()
  const running = item.status === "running"
  const failed = !running && item.exitCode !== null && item.exitCode !== 0
  /* The heading an *agent's* Bash call for this same line would get, from the
     one rule that decides these (`lib/tools/heading.ts`). */
  const heading = toolHeading({ title: "", rawInput: { command: item.command }, toolKind: "execute" })
  return (
    <StepRow
      icon={KIND_ICONS.execute}
      iconAccent={KIND_COLORS.execute}
      iconChip={KIND_CHIPS.execute}
      status={running ? "in_progress" : failed ? "failed" : null}
      target={heading.title}
      /* The command under the sentence, the way a Bash step carries it. The pane
         below says it again in full — which is also what a Bash step does. */
      caption={view.showToolCommand ? heading.detail : undefined}
      mono={!heading.prose}
      metric={[
        failed ? <span className="font-mono text-destructive">exit {item.exitCode}</span> : null,
        showTimestamp && item.at !== undefined ? <Timestamp at={item.at} /> : null,
      ]}
      detail={
        <>
          <ShellPane
            command={item.command}
            output={item.output}
            failed={failed}
            running={running}
            /* A settled run that printed nothing says so; a Bash step leaves the
               command line standing alone, and a `!` row has no agent prose
               around it to carry that meaning. */
            emptyNote={running ? undefined : "No output."}
          />
          {item.timedOut && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Stopped at the timeout — this is what it printed first.
            </p>
          )}
        </>
      }
      defaultOpen
    />
  )
})
ShellStep.displayName = "ShellStep"

/**
 * A run of `!` commands the reader ran back to back, folded into one row — the
 * same shape as a folded tool run, and for the same reason: the counting line
 * answers "what did I just do" and the blocks under it answer "do I need to read
 * it". Opens on its own while a command is still running, because that is the
 * one thing on the row worth watching.
 */
export const ShellRun = React.memo(function ShellRun({
  items,
  showTimestamps,
}: {
  items: ShellItem[]
  showTimestamps?: boolean
}) {
  const running = items.some((item) => item.status === "running")
  const failed = items.filter(
    (item) => item.status === "done" && item.exitCode !== null && item.exitCode !== 0
  ).length
  /* Derived, never seeded — the `useState` trap the view options document: a run
     that mounted live would stay open for ever, one rebuilt from the journal
     would stay shut. The reader's choice, once made, outranks both. */
  const [choice, setChoice] = React.useState<boolean | null>(null)
  const open = choice ?? running
  return (
    <div>
      <button
        type="button"
        onClick={() => setChoice(!open)}
        className="-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 py-0.5 text-start transition-colors duration-150 hover:bg-muted/40"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground/60 transition-transform duration-200",
            open && "rotate-90"
          )}
        />
        <SquareTerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs leading-6 text-muted-foreground",
            running && "harness-shimmer"
          )}
        >
          {items.length} commands
        </span>
        <StepMeta
          parts={[failed > 0 ? <span className="text-destructive">{failed} failed</span> : null]}
        />
      </button>
      {open && (
        /* One rail for the blocks, the way a folded tool run draws one: the
           commands are a group, and the line down their left says so. */
        <div className="ms-1.5 border-s border-border/50 ps-1">
          {items.map((item) => (
            <ShellStep key={item.id} item={item} showTimestamp={showTimestamps} />
          ))}
        </div>
      )}
    </div>
  )
})
ShellRun.displayName = "ShellRun"

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
      <span className={cn(LABEL, "mr-0.5")}>Sources</span>
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
      metric={[`${done}/${item.entries.length}`]}
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
