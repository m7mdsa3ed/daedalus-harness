import * as React from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type * as acp from "@agentclientprotocol/sdk"
import {
  ArrowLeftRightIcon,
  BrainIcon,
  FileTextIcon,
  GlobeIcon,
  PencilLineIcon,
  SearchIcon,
  SquareTerminalIcon,
  Trash2Icon,
  ToggleLeftIcon,
  WrenchIcon,
} from "lucide-react"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Message, MessageContent } from "@/components/ui/message"
import { ToolCallSkeleton } from "@/components/ui/skeletons"
import { cn } from "@/lib/utils"
import type { PlanItem, ThreadItem, ToolItem } from "@/lib/store"

/* Steps read as one timeline: a hairline rail down the gutter with a node per
   step (rail geometry in index.css). The thing acted on is the headline — the
   kind is demoted to a right-hand label so those form their own scan column.
   Everything a step produced is collapsed behind the row until clicked. */

export const KIND_LABELS: Record<string, string> = {
  read: "read",
  edit: "edit",
  delete: "delete",
  move: "move",
  search: "search",
  execute: "run",
  think: "think",
  fetch: "fetch",
  switch_mode: "mode",
  other: "tool",
}

export const KIND_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  read: FileTextIcon,
  edit: PencilLineIcon,
  delete: Trash2Icon,
  move: ArrowLeftRightIcon,
  search: SearchIcon,
  execute: SquareTerminalIcon,
  think: BrainIcon,
  fetch: GlobeIcon,
  switch_mode: ToggleLeftIcon,
}

function lineCount(text: string): number {
  return text ? text.split("\n").length : 0
}

/** Right-hand size hint, derived generically from whatever the tool returned. */
function metricFor(item: ToolItem): string | null {
  // ponytail: old/new line counts, not a real diff — swap in a line-diff lib
  // here and in ToolContentView together if reviews need exact +/-.
  const diff = item.content.find((c) => c.type === "diff")
  if (diff && diff.type === "diff") {
    const added = lineCount(diff.newText)
    const removed = lineCount(diff.oldText ?? "")
    return removed ? `+${added} −${removed}` : `+${added}`
  }
  const text = item.content
    .filter((c) => c.type === "content" && c.content.type === "text")
    .map((c) => (c.type === "content" && c.content.type === "text" ? c.content.text : ""))
    .join("\n")
  if (text.trim()) return `${lineCount(text.trimEnd())}L`
  if (item.locations.length > 1) return `${item.locations.length} files`
  return null
}

function useElapsed(startedAt: number, active: boolean): number | null {
  const [ms, setMs] = React.useState<number | null>(null)
  React.useEffect(() => {
    if (!active) {
      setMs(null)
      return
    }
    const tick = () => setMs(Date.now() - startedAt)
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [startedAt, active])
  return ms
}

function formatElapsed(ms: number): string {
  return ms < 60_000
    ? `${Math.round(ms / 1000)}s`
    : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

function StepRow({
  target,
  label,
  status,
  metric,
  detail,
  startedAt,
  mono = true,
}: {
  target: React.ReactNode
  label: string
  status: string | null
  metric?: React.ReactNode
  detail?: React.ReactNode
  startedAt?: number
  mono?: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const expandable = detail !== undefined && detail !== null && detail !== false
  const active = status === "in_progress" || status === "pending"
  const failed = status === "failed"
  const elapsedMs = useElapsed(startedAt ?? 0, active && startedAt !== undefined)

  return (
    <div>
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          // items-center, not items-baseline: the target span is `truncate`
          // (overflow: hidden), so its baseline is its bottom edge — baseline
          // alignment lifted the title ~5px above the "edit"/"run" label. Every
          // child is leading-6, so centring lines them up exactly.
          // The width is calc(100% + 12px) so the -mx-1.5/px-1.5 hover bleed
          // cancels on BOTH sides: a `w-full` box only shifts left under a
          // negative start margin, which left the row's content edge 12px shy
          // of the right edge that messages run to.
          "-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 py-0.5 text-start transition-colors duration-150",
          expandable && "hover:bg-muted/40"
        )}
      >
        {/* Steps are what the agent did, not what it said: the whole row sits at
            caption weight so prose stays the thing you read. */}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs leading-6",
            mono && "font-mono",
            failed ? "text-destructive" : "text-muted-foreground",
            active && "harness-shimmer"
          )}
        >
          {target}
        </span>

        {elapsedMs !== null && elapsedMs >= 2000 && (
          <span className="shrink-0 text-[11px] leading-6 tabular-nums text-muted-foreground/60">
            {formatElapsed(elapsedMs)}
          </span>
        )}
        {metric && (
          <span className="shrink-0 text-[11px] leading-6 tabular-nums text-muted-foreground/60">
            {metric}
          </span>
        )}
        <span
          className={cn(
            "shrink-0 text-[11px] leading-6",
            failed ? "text-destructive" : "text-muted-foreground/50"
          )}
        >
          {failed ? "failed" : label}
        </span>
      </button>

      {expandable && open && <div className="mt-1 mb-2.5 min-w-0 space-y-2">{detail}</div>}
    </div>
  )
}

/* Prose palette + code/table styling live in index.css, so both themes come
   from the app tokens — no prose-invert needed. */
function Prose({ text }: { text: string }) {
  return (
    <div className="prose prose-sm max-w-none">
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  )
}

/* Explanatory agents emit their insight box as two backticked rule lines around
   the body — as markdown that's a pair of code chips with a wall of dashes.
   The rules are the frame, so drop them and render the body as a callout.
   Unterminated matches (still streaming) run to the end of the text. */
const INSIGHT_RE = /`?★[^\n]*?Insight[^\n]*\n([\s\S]*?)(?:\n?`?[─—–-]{5,}`?|$)/g

function AgentText({ text }: { text: string }) {
  const parts: React.ReactNode[] = []
  let cut = 0
  for (const match of text.matchAll(INSIGHT_RE)) {
    if (match.index > cut) parts.push(<Prose key={cut} text={text.slice(cut, match.index)} />)
    parts.push(
      <aside key={match.index} className="rounded-lg border border-border/60 bg-muted/30 px-4 py-3">
        <p className="mb-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
          <span aria-hidden>★</span> Insight
        </p>
        <Prose text={match[1]} />
      </aside>
    )
    cut = match.index + match[0].length
  }
  if (parts.length === 0) return <Prose text={text} />
  if (cut < text.length) parts.push(<Prose key={cut} text={text.slice(cut)} />)
  return <div className="space-y-3">{parts}</div>
}

export function ThreadItemView({ item }: { item: ThreadItem }) {
  switch (item.kind) {
    case "user":
      return (
        <Message align="end" className="py-2">
          <MessageContent>
            <Bubble align="end">
              <BubbleContent className="rounded-2xl rounded-br-sm px-4 py-2.5 text-xs whitespace-pre-wrap">
                {item.text}
              </BubbleContent>
            </Bubble>
          </MessageContent>
        </Message>
      )
    case "agent":
      return (
        // The transcript is ONE column: prose, steps and notices all start on
        // the same left edge, with nothing inset for a gutter.
        <Message className="py-2">
          <MessageContent>
            <Bubble variant="ghost">
              <BubbleContent className="text-xs leading-relaxed">
                <AgentText text={item.text} />
              </BubbleContent>
            </Bubble>
          </MessageContent>
        </Message>
      )
    case "notice":
      // A break in the conversation, so it reads as one: hairline across the
      // column with the reason inline.
      return (
        <div className="flex items-center gap-2.5 py-2 text-[11px] text-muted-foreground/70">
          <span aria-hidden className="h-px flex-1 bg-border" />
          <span className="shrink-0">{item.text}</span>
          <span aria-hidden className="h-px flex-1 bg-border" />
        </div>
      )
    case "thought": {
      const reasoning = item.text.trim()

      return (
        <StepRow
          label="think"
          status={null}
          mono={false}
          target={reasoning.split("\n").find((line) => line.trim()) ?? "…"}
          detail={
            <p className="text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {reasoning}
            </p>
          }
        />
      )
    }
    case "tool":
      return <ToolStep item={item} />
    case "plan":
      return <PlanStep item={item} />
  }
}

/* Agents stream output as many small text blocks (one per result, per line).
   Rendering a bordered box per block turns six one-liners into six panels —
   consecutive text is one stream, so it gets one block. */
function mergeText(content: acp.ToolCallContent[]): acp.ToolCallContent[] {
  const merged: acp.ToolCallContent[] = []
  for (const part of content) {
    const prev = merged[merged.length - 1]
    if (
      part.type === "content" &&
      part.content.type === "text" &&
      prev?.type === "content" &&
      prev.content.type === "text"
    ) {
      merged[merged.length - 1] = {
        ...prev,
        content: { ...prev.content, text: `${prev.content.text}\n${part.content.text}` },
      }
    } else {
      merged.push(part)
    }
  }
  return merged
}

function ToolStep({ item }: { item: ToolItem }) {
  const active = item.status === "in_progress" || item.status === "pending"
  const KindIcon = KIND_ICONS[item.toolKind ?? "other"] ?? WrenchIcon
  const json = JSON.stringify(item.rawInput ?? null)
  const args = json === "null" || json === "{}" ? null : json
  const hasBody = item.content.length > 0 || item.locations.length > 0 || args !== null
  const detail = hasBody ? (
    <>
      {/* The title often names only the tool ("ToolSearch") — the input is what
          says which call this was. */}
      {args && (
        <p className="truncate font-mono text-[11px] text-muted-foreground/70">
          {args}
        </p>
      )}
      {item.locations.length > 0 && (
        <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground/80">
          {item.locations.map((l, i) => (
            <li key={i} className="truncate">
              {l.path}
              {l.line != null && `:${l.line}`}
            </li>
          ))}
        </ul>
      )}
      <ToolCallContent content={item.content} />
    </>
  ) : active ? (
    <ToolCallSkeleton className="py-1" />
  ) : undefined

  return (
    <StepRow
      label={KIND_LABELS[item.toolKind ?? "other"] ?? KIND_LABELS.other}
      status={item.status}
      target={
        <span className="flex min-w-0 items-center gap-1.5">
          {/* Needs its own colour: the shimmer paints text via background-clip,
              which would leave a currentColor icon invisible while active. */}
          <KindIcon
            className={cn("size-3.5 shrink-0", active ? "text-primary" : "text-muted-foreground/60")}
          />
          <span className="truncate">{item.title}</span>
        </span>
      }
      metric={metricFor(item)}
      startedAt={item.startedAt}
      detail={detail}
    />
  )
}

/** Everything a tool call produced, rendered the way the transcript renders it.
    Shared with the approval card so a diff looks the same before and after. */
export function ToolCallContent({ content }: { content: acp.ToolCallContent[] }) {
  return mergeText(content).map((part, i) => <ToolContentView key={i} content={part} />)
}

function ToolContentView({ content }: { content: acp.ToolCallContent }) {
  if (content.type === "content" && content.content.type === "text") {
    return (
      <pre className="max-h-64 w-fit max-w-full overflow-auto rounded-md border border-border/50 bg-muted/40 px-2.5 py-2 font-mono text-[11px] whitespace-pre-wrap">
        {content.content.text}
      </pre>
    )
  }
  if (content.type === "diff") {
    // ponytail: whole-block old/new render; swap in a line-diff lib if reviews need it.
    return (
      <div className="overflow-hidden rounded-md border border-border/50 font-mono text-[11px]">
        <div className="truncate border-b border-border/50 bg-muted/40 px-2 py-1 text-muted-foreground">
          {content.path}
        </div>
        {content.oldText != null && content.oldText !== "" && (
          <pre className="max-h-48 overflow-auto bg-red-500/10 p-2 whitespace-pre-wrap text-red-700 dark:text-red-300">
            {content.oldText}
          </pre>
        )}
        <pre className="max-h-48 overflow-auto bg-green-500/10 p-2 whitespace-pre-wrap text-green-700 dark:text-green-300">
          {content.newText}
        </pre>
      </div>
    )
  }
  return <div className="text-[11px] text-muted-foreground">[{content.type}]</div>
}

function PlanStep({ item }: { item: PlanItem }) {
  const done = item.entries.filter((e) => e.status === "completed").length
  const current = item.entries.find((e) => e.status === "in_progress")
  // Agents often leave a plan with nothing in_progress (turn ended mid-list).
  // Headline the step that's up next, and only spin while one is actually running.
  const next = current ?? item.entries.find((e) => e.status !== "completed")
  return (
    <StepRow
      label="plan"
      status={current ? "in_progress" : next ? null : "completed"}
      mono={false}
      target={next?.content ?? "all steps complete"}
      metric={`${done}/${item.entries.length}`}
      detail={
        <ul className="space-y-1">
          {item.entries.map((entry, i) => (
            <li key={i} className="flex items-start gap-2 text-xs">
              <span
                className={cn(
                  "mt-1.5 size-1.5 shrink-0 rounded-full",
                  entry.status === "completed"
                    ? "bg-primary"
                    : entry.status === "in_progress"
                      ? "harness-node-active bg-primary"
                      : "bg-muted-foreground/40"
                )}
              />
              <span
                className={cn(
                  "min-w-0",
                  entry.status === "completed"
                    ? "text-muted-foreground line-through"
                    : entry.status === "in_progress"
                      ? "text-foreground"
                      : "text-muted-foreground"
                )}
              >
                {entry.content}
              </span>
            </li>
          ))}
        </ul>
      }
    />
  )
}
