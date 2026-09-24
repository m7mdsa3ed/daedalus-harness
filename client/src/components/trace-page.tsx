/* ── The trace view ── /t/<sessionId>/trace
 *
 * A thread's journal as a raw timeline: every journaled event in the order the
 * server wrote it, with the wall-clock stamp the transcript never carries.
 * The transcript answers "what was said"; this answers "what happened, when,
 * and at what cost" — the step payloads, the model request behind each step,
 * the token figures and the window occupancy alongside them.
 *
 * The data is paged newest-first (see lib/queries/trace) and flattened here
 * into one chronological list: the thread reads oldest at the top, like the
 * transcript does, and older history is offered above it. Turn boundaries cut
 * it into sections; subagent work (an event carrying `sessionId`) is flagged
 * rather than nested — nesting is the transcript's job. */
import * as React from "react"
import {
  ActivityIcon,
  AlertTriangleIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  CoinsIcon,
  CopyIcon,
  DatabaseIcon,
  RefreshCwIcon,
  WrenchIcon,
} from "lucide-react"
import { useNavigate, useParams } from "react-router"
import type * as acp from "@daedalus/acp"
import type { JournaledEvent, SessionUpdate, TraceEvent } from "@daedalus/protocol"

import { PageFrame } from "@/components/page-primitives"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { AgentIcon } from "@/components/entity-icon"
import { Notice } from "@/components/notice"
import { errorText } from "@/lib/errors"
import { writeClipboard } from "@/lib/clipboard"
import { threadPath } from "@/lib/router"
import { useSessionMeta } from "@/lib/store"
import { formatDuration, formatTokens, promptTokens, sumUsage } from "@/lib/tokens"
import { cn } from "@/lib/utils"
import { useThreadTrace } from "@/lib/queries/trace"

export function TracePage() {
  const { sessionId = "" } = useParams()
  const navigate = useNavigate()
  const meta = useSessionMeta(sessionId)
  const trace = useThreadTrace(sessionId)

  /* Pages arrive newest-first; the view reads oldest-first, like the thread. */
  const events = React.useMemo(() => {
    const out: TraceEvent[] = []
    for (let i = trace.pages.length - 1; i >= 0; i--) out.push(...trace.pages[i].events)
    return out
  }, [trace.pages])

  const totals = React.useMemo(() => {
    const usages: (acp.Usage | null)[] = []
    for (const e of events) {
      const p = e.payload
      if (p.ev === "turn_ended" && p.usage) usages.push(p.usage)
    }
    return sumUsage(usages)
  }, [events])

  return (
    <PageFrame width="wide">
        <TraceHeader
          sessionId={sessionId}
          onBack={() => void navigate(threadPath(sessionId))}
          onRefresh={trace.refresh}
          refreshing={trace.refreshing}
        />

        {trace.error && (
          <Notice tone="neutral" icon={<AlertTriangleIcon />} className="mt-4">
            {errorText(trace.error)}{" "}
            <button type="button" className="underline" onClick={trace.refresh}>
              Try again
            </button>
          </Notice>
        )}

        <div className="mt-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <Tile
            icon={CoinsIcon}
            label="Total tokens"
            value={totals ? formatTokens(totals.totalTokens) : "—"}
            loading={trace.loading}
            hint="Summed over every settled turn"
          />
          <Tile
            icon={ArrowUpIcon}
            label="Prompt"
            value={totals ? formatTokens(promptTokens(totals)) : "—"}
            loading={trace.loading}
            hint="Everything sent up, cache hits included"
          />
          <Tile
            icon={ActivityIcon}
            label="Output"
            value={totals ? formatTokens(totals.outputTokens) : "—"}
            loading={trace.loading}
            hint="What the model wrote back"
          />
          <Tile
            icon={DatabaseIcon}
            label="Cache hits"
            value={totals?.cachedReadTokens ? formatTokens(totals.cachedReadTokens) : "—"}
            loading={trace.loading}
            hint="Prompt tokens served from cache"
          />
        </div>

        <CardShell
          title="Events"
          count={trace.loading ? undefined : events.length}
          action={
            trace.hasOlder ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={trace.loadingOlder}
                onClick={trace.loadOlder}
              >
                {trace.loadingOlder ? "Loading…" : "Load older"}
              </Button>
            ) : undefined
          }
        >
          {trace.loading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : events.length === 0 && !trace.error ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              This thread has no journaled events — send a first message and they appear here.
            </p>
          ) : (
            <ol className="space-y-1 p-2">
              {events.map((event, i) => (
                <TraceRow
                  key={event.seq}
                  event={event}
                  deltaMs={i > 0 && event.at > 0 && events[i - 1].at > 0 ? event.at - events[i - 1].at : null}
                />
              ))}
            </ol>
          )}
        </CardShell>
    </PageFrame>
  )
}

/* ── Header, tiles, card and banner — the project page's vocabulary ──
   The overview, the routines and the schedules are the same kind of screen:
   an identity block (avatar, title, meta chips), a Refresh ghost icon, a row
   of tiles, and the list in a bordered card. The trace is that kind of
   screen, so it reads its header, tiles and card from the same shapes. */

function TraceHeader({
  sessionId,
  onBack,
  onRefresh,
  refreshing,
}: {
  sessionId: string;
  onBack: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const meta = useSessionMeta(sessionId)
  const [copied, setCopied] = React.useState(false)
  const copy = async () => {
    try {
      await writeClipboard(sessionId)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // A clipboard the browser refused is not worth an error card; the id is
      // on screen and selectable either way.
    }
  }

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex items-start gap-3.5 min-w-0 flex-1">
        <div className="rounded-xl border bg-muted/30 p-1.5 shrink-0 shadow-xs">
          <AgentIcon agentId={meta?.agentId} className="size-10" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl sm:text-2xl font-bold tracking-tight text-foreground">
              {meta?.title ?? "Thread trace"}
            </h1>
          </div>

          <button
            type="button"
            onClick={() => void copy()}
            title="Copy thread ID"
            className="mt-1.5 inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/70 bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="truncate font-mono text-[11px]">{sessionId}</span>
            {copied ? (
              <CheckIcon className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <CopyIcon className="size-3 shrink-0 opacity-60" />
            )}
          </button>

          <p className="mt-2 max-w-2xl text-xs sm:text-sm text-pretty text-muted-foreground leading-relaxed">
            The journal as a timeline — every event the server kept, with its time, its payload
            and its token cost.{" "}
            <button type="button" className="underline" onClick={onBack}>
              Back to the thread
            </button>
          </p>
        </div>
      </div>

      <div className="hidden sm:flex shrink-0 items-center gap-2">
        <Button variant="ghost" size="icon" title="Refresh" onClick={onRefresh} disabled={refreshing}>
          <RefreshCwIcon className={cn("size-4", refreshing && "animate-spin")} />
          <span className="sr-only">Refresh</span>
        </Button>
      </div>
    </div>
  )
}

function Tile({
  icon: Icon,
  label,
  value,
  hint,
  loading,
}: {
  icon: typeof ActivityIcon;
  label: string;
  value: React.ReactNode;
  hint: string;
  loading?: boolean;
}) {
  return (
    <div className="group relative rounded-xl border bg-card p-3.5 sm:p-4 transition-all hover:border-border/90 hover:shadow-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          {label}
        </span>
        <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground group-hover:text-foreground transition-colors">
          <Icon className="size-3.5" />
        </div>
      </div>
      <div className="mt-2 text-2xl sm:text-3xl font-bold tracking-tight tabular-nums text-foreground">
        {loading ? <Skeleton className="h-8 w-20" /> : value}
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground truncate" title={hint}>
        <span className="truncate">{hint}</span>
      </div>
    </div>
  )
}

function CardShell({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6 rounded-xl border bg-card">
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        <h2 className="text-sm font-medium">{title}</h2>
        {count != null && (
          <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
        )}
        {action && <div className="ml-auto">{action}</div>}
      </header>
      {children}
    </section>
  )
}

/* ── One row ──
   A lane per kind: turns open and close sections, tool calls carry their
   payload, usage updates carry their figures, and the message chunks the
   journal is mostly made of collapse to one line each. Anything carrying a
   child `sessionId` is a subagent's — flagged on the row. */
function TraceRow({ event, deltaMs }: { event: TraceEvent; deltaMs: number | null }) {
  const { payload } = event
  if (payload.ev === "turn_started")
    return <TurnBoundary event={event} variant="start" deltaMs={deltaMs} />
  if (payload.ev === "turn_ended")
    return <TurnBoundary event={event} variant="end" deltaMs={deltaMs} />
  if (payload.ev === "update") return <UpdateRow event={event} deltaMs={deltaMs} />
  /* session_config / config_notice: rare and small — drawn whole, no lane. */
  return <ConfigRow event={event} deltaMs={deltaMs} />
}

function TurnBoundary({
  event,
  variant,
  deltaMs,
}: {
  event: TraceEvent;
  variant: "start" | "end";
  deltaMs: number | null;
}) {
  const p = event.payload
  const isStart = variant === "start" && p.ev === "turn_started"
  const ended = !isStart && p.ev === "turn_ended"
  return (
    <li className="flex items-baseline gap-3 rounded-md bg-muted/50 px-3 py-2">
      <span
        className={cn(
          "shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] font-medium",
          variant === "start" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
        )}
      >
        {variant === "start" ? "turn" : "end"}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm">
        {isStart ? p.text || "(empty prompt)" : ended ? turnEndText(p) : ""}
      </span>
      {ended && p.usage ? (
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums">
          <CoinsIcon className="size-3" />
          {formatTokens(p.usage.totalTokens)}
        </span>
      ) : null}
      <Time at={event.at} deltaMs={deltaMs} seq={event.seq} />
    </li>
  )
}

function turnEndText(p: Extract<JournaledEvent, { ev: "turn_ended" }>): string {
  if (p.error) return `failed: ${p.error.message}`
  const bits = [`${formatTokens(p.usage?.totalTokens ?? 0)} tokens`]
  if (p.durationMs !== undefined) bits.push(formatDuration(p.durationMs))
  if (p.continued) bits.push("continued")
  return bits.join(" · ")
}

function UpdateRow({ event, deltaMs }: { event: TraceEvent; deltaMs: number | null }) {
  const p = event.payload
  if (p.ev !== "update") return null
  const child = p.sessionId ? true : false
  switch (p.update.sessionUpdate) {
    case "tool_call":
    case "tool_call_update":
      return <ToolRow event={event} update={p.update} deltaMs={deltaMs} child={child} />
    case "usage_update":
      return <UsageRow event={event} update={p.update} deltaMs={deltaMs} child={child} />
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "user_message_chunk": {
      const text = chunkText(p.update)
      if (!text) return null
      return <ChunkRow event={event} label={chunkLabel(p.update)} text={text} deltaMs={deltaMs} child={child} />
    }
    default:
      return <GenericUpdateRow event={event} update={p.update} deltaMs={deltaMs} child={child} />
  }
}

function chunkLabel(update: SessionUpdate): string {
  if (update.sessionUpdate === "agent_thought_chunk") return "thought"
  if (update.sessionUpdate === "user_message_chunk") return "user"
  return "reply"
}

function chunkText(update: SessionUpdate): string | null {
  if (
    update.sessionUpdate !== "agent_message_chunk" &&
    update.sessionUpdate !== "agent_thought_chunk" &&
    update.sessionUpdate !== "user_message_chunk"
  )
    return null
  const content = update.content
  if (typeof content === "object" && content !== null && "text" in content) {
    const text = (content as { text?: unknown }).text
    return typeof text === "string" ? text : null
  }
  return null
}

function ChunkRow({
  event,
  label,
  text,
  deltaMs,
  child,
}: {
  event: TraceEvent;
  label: string;
  text: string;
  deltaMs: number | null;
  child: boolean;
}) {
  const preview = text.length > 220 ? `${text.slice(0, 220)}…` : text
  return (
    <li className="group flex items-baseline gap-3 rounded-md px-3 py-1 text-sm hover:bg-muted/50">
      <LaneDot kind="chunk" />
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{label}</span>
      {child && <ChildFlag />}
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{preview}</span>
      <CopyButtont text={text} label={`${label} text`} />
      <Time at={event.at} deltaMs={deltaMs} seq={event.seq} />
    </li>
  )
}

function UsageRow({
  event,
  update,
  deltaMs,
  child,
}: {
  event: TraceEvent;
  update: Extract<SessionUpdate, { sessionUpdate: "usage_update" }>;
  deltaMs: number | null;
  child: boolean;
}) {
  const share = update.size > 0 ? Math.round((update.used / update.size) * 100) : null
  return (
    <li className="flex items-baseline gap-3 rounded-md px-3 py-1 text-sm hover:bg-muted/50">
      <LaneDot kind="usage" />
      <span className="flex shrink-0 items-center gap-1 tabular-nums">
        <CoinsIcon className="size-3 text-muted-foreground" />
        {formatTokens(update.used)}
      </span>
      {child && <ChildFlag />}
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {`of ${formatTokens(update.size)}${share !== null ? ` · ${share}% of window` : ""}`}
        {update.cost ? ` · ${update.cost.amount.toFixed(4)} ${update.cost.currency}` : ""}
      </span>
      <Time at={event.at} deltaMs={deltaMs} seq={event.seq} />
    </li>
  )
}

function ToolRow({
  event,
  update,
  deltaMs,
  child,
}: {
  event: TraceEvent;
  update:
    | Extract<SessionUpdate, { sessionUpdate: "tool_call" }>
    | Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>;
  deltaMs: number | null;
  child: boolean;
}) {
  const [open, setOpen] = React.useState(false)
  const title = "title" in update && update.title ? update.title : update.toolCallId
  const status = "status" in update && update.status ? String(update.status) : null
  const rawInput = "rawInput" in update ? update.rawInput : undefined
  const rawOutput = "rawOutput" in update ? update.rawOutput : undefined
  const contents = "content" in update && Array.isArray(update.content) ? update.content : []
  const textParts = contents
    .map((c) => {
      if (typeof c !== "object" || c === null) return null
      const block = c as { type?: string; content?: unknown }
      if (block.type === "content" && typeof block.content === "object" && block.content !== null) {
        const inner = block.content as { type?: string; text?: unknown }
        if (inner.type === "text" && typeof inner.text === "string") return inner.text
      }
      if (block.type === "terminal" && typeof (block as { output?: unknown }).output === "string")
        return (block as { output: string }).output
      return null
    })
    .filter((t): t is string => t !== null)
  const output = rawOutput !== undefined ? stringify(rawOutput) : textParts.join("\n") || null
  const input = rawInput !== undefined ? stringify(rawInput) : null
  return (
    <li className="rounded-md px-3 py-1 hover:bg-muted/50">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-baseline gap-3 text-sm">
          <LaneDot kind="tool" />
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-baseline gap-2 text-left">
            <ChevronDownIcon className={cn("size-3 shrink-0 self-center text-muted-foreground transition-transform", !open && "-rotate-90")} />
            <WrenchIcon className="size-3 shrink-0 self-center text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
          </CollapsibleTrigger>
          {child && <ChildFlag />}
          {status && (
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{status}</span>
          )}
          <Time at={event.at} deltaMs={deltaMs} seq={event.seq} />
        </div>
        <CollapsibleContent className="mt-1 space-y-1 pl-6">
          {input && <PayloadBlock label="Input" text={input} />}
          {output && <PayloadBlock label="Output" text={output} />}
          {!input && !output && (
            <p className="text-xs text-muted-foreground">No payload recorded on this update.</p>
          )}
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

function GenericUpdateRow({
  event,
  update,
  deltaMs,
  child,
}: {
  event: TraceEvent;
  update: SessionUpdate;
  deltaMs: number | null;
  child: boolean;
}) {
  const text = stringify(update)
  return (
    <li className="rounded-md px-3 py-1 hover:bg-muted/50">
      <Collapsible>
        <div className="flex items-baseline gap-3 text-sm">
          <LaneDot kind="other" />
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-baseline gap-2 text-left">
            <ChevronDownIcon className="size-3 shrink-0 self-center text-muted-foreground transition-transform [[data-state=open]_&]:rotate-0 -rotate-90" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{update.sessionUpdate}</span>
          </CollapsibleTrigger>
          {child && <ChildFlag />}
          <CopyButtont text={text} label={`${update.sessionUpdate} payload`} />
          <Time at={event.at} deltaMs={deltaMs} seq={event.seq} />
        </div>
        <CollapsibleContent className="mt-1 pl-6">
          <PayloadBlock label="Payload" text={text} />
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

function ConfigRow({ event, deltaMs }: { event: TraceEvent; deltaMs: number | null }) {
  const text = stringify(event.payload)
  return (
    <li className="rounded-md px-3 py-1 hover:bg-muted/50">
      <Collapsible>
        <div className="flex items-baseline gap-3 text-sm">
          <LaneDot kind="other" />
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-baseline gap-2 text-left">
            <ChevronDownIcon className="size-3 shrink-0 self-center text-muted-foreground transition-transform [[data-state=open]_&]:rotate-0 -rotate-90" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{event.ev}</span>
          </CollapsibleTrigger>
          <CopyButtont text={text} label={`${event.ev} payload`} />
          <Time at={event.at} deltaMs={deltaMs} seq={event.seq} />
        </div>
        <CollapsibleContent className="mt-1 pl-6">
          <PayloadBlock label="Payload" text={text} />
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

/* ── Row atoms ── */

function LaneDot({ kind }: { kind: "chunk" | "usage" | "tool" | "other" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 self-center rounded-full",
        kind === "chunk" && "bg-muted-foreground/40",
        kind === "usage" && "bg-amber-500/70",
        kind === "tool" && "bg-sky-500/70",
        kind === "other" && "bg-muted-foreground/25"
      )}
    />
  )
}

function ChildFlag() {
  return (
    <span
      title="A subagent's event"
      className="shrink-0 rounded bg-violet-500/10 px-1 py-0.5 font-mono text-[10px] text-violet-600 dark:text-violet-400"
    >
      sub
    </span>
  )
}

/** The journal's own clock, plus the gap since the previous event — the two
    halves of "how long did this take". Pre-`at` rows show their seq only. */
function Time({ at, deltaMs, seq }: { at: number; deltaMs: number | null; seq: number }) {
  const label =
    at > 0
      ? new Date(at).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
        })
      : `seq ${seq}`
  return (
    <span className="flex shrink-0 items-baseline gap-1.5" title={at > 0 ? `seq ${seq}` : undefined}>
      {deltaMs !== null && deltaMs >= 0 && (
        <span className="font-mono text-[10px] text-muted-foreground/70 tabular-nums">
          +{formatDuration(deltaMs)}
        </span>
      )}
      <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{label}</span>
    </span>
  )
}

function PayloadBlock({ label, text }: { label: string; text: string }) {
  const shown = text.length > 8000 ? `${text.slice(0, 8000)}\n… (truncated)` : text
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
        <CopyButtont text={text} label={`${label} payload`} />
      </div>
      <pre className="max-h-96 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] break-words whitespace-pre-wrap">
        {shown}
      </pre>
    </div>
  )
}

function CopyButtont({ text, label }: { text: string; label: string }) {
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      className="shrink-0 rounded p-1 text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
      onClick={(e) => {
        e.stopPropagation()
        void writeClipboard(text).catch(() => {})
      }}
    >
      <CopyIcon className="size-3" />
    </button>
  )
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}
