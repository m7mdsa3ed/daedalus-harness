/* The selected span, whole: timing, usage, the model's conversation or the
   tool's call, every other attribute, its events and its status — each payload
   with a Copy. A span whose list copy elided a value is read again whole
   (`useSpanDetail`); until it lands, the elided payloads skeleton. */
import * as React from "react"
import { ArrowLeftIcon, XIcon } from "lucide-react"
import type { TraceAttributeValue, TraceSpan } from "@daedalus/protocol"

import { ErrorNote } from "@/components/error-note"
import { Notice } from "@/components/notice"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { Skeleton } from "@/components/ui/skeleton"
import { inlineFromQuery } from "@/lib/errors"
import { useSpanDetail } from "@/lib/queries/trace"
import { formatTokens, formatTps } from "@/lib/tokens"
import {
  PROMPT_KEYS,
  diffLines,
  diffMessages,
  hasPrompt,
  parseJsonAttr,
  previousModelCall,
  spanTiming,
  spanUsage,
  type LineOp,
} from "@/lib/trajectory"
import { cn } from "@/lib/utils"
import { KIND, fmtClock, fmtMs, spanText } from "./kinds"

/** Payload attributes drawn as their own blocks, in this order. */
const PAYLOADS: [key: string, label: string][] = [
  ["daedalus.prompt", "Prompt"],
  ["gen_ai.system_instructions", "System instructions"],
  ["gen_ai.input.messages", "Input messages"],
  ["gen_ai.output.messages", "Output messages"],
  ["gen_ai.tool.definitions", "Tool definitions"],
  ["gen_ai.tool.call.arguments", "Arguments"],
  ["gen_ai.tool.call.result", "Result"],
]
/** Read into the timing and usage grids, so not listed again below. */
const SHOWN = new Set([
  ...PAYLOADS.map(([key]) => key),
  "daedalus.ttft_ms",
  "gen_ai.client.operation.time_to_first_chunk",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "gen_ai.usage.cache_read.input_tokens",
  "gen_ai.usage.cache_creation.input_tokens",
])

export function SpanDetail({
  sessionId,
  spans,
  span: listed,
  live,
  onClose,
}: {
  sessionId: string
  /** The whole thread's spans — what a model call's prompt is compared against. */
  spans: TraceSpan[]
  span: TraceSpan
  live: boolean
  onClose: () => void
}) {
  const detail = useSpanDetail(sessionId, listed, live)
  const span = detail.data ?? listed
  const pending = new Set(detail.data ? [] : (listed.elided ?? []))
  const timing = spanTiming(span)
  const usage = spanUsage(span)
  const Icon = KIND[span.kind].icon
  const rest = Object.entries(span.attributes).filter(([key]) => !SHOWN.has(key))

  return (
    <div className="flex flex-col gap-4 p-3 text-sm">
      <header className="flex items-start gap-2">
        <Button
          variant="ghost"
          size="icon-xs"
          className="@panel-md:hidden"
          aria-label="Back to the spans"
          onClick={onClose}
        >
          <ArrowLeftIcon />
        </Button>
        <span className="flex h-5 shrink-0 items-center">
          <Icon className={cn("size-4", spanText(span))} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium [overflow-wrap:anywhere]">{span.name}</h3>
          <p className="text-muted-foreground">
            {KIND[span.kind].label} · {span.source === "agent" ? "agent" : "harness"}
            {span.end === null && " · running"}
          </p>
        </div>
        <CopyButton size="icon-xs" text={JSON.stringify(span, null, 2)} title="Copy the span as JSON" />
        <Button
          variant="ghost"
          size="icon-xs"
          className="hidden @panel-md:inline-flex"
          aria-label="Close the span"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </header>

      {span.status === "error" && (
        <Notice
          tone="error"
          title="The span failed"
          action={<CopyButton size="icon-xs" text={span.statusMessage ?? span.name} />}
        >
          {span.statusMessage && <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{span.statusMessage}</p>}
        </Notice>
      )}

      <ErrorNote
        error={inlineFromQuery(detail.error, "Couldn't read the whole span")}
        onRetry={() => void detail.refetch()}
      />

      <Facts
        rows={[
          ["Start", fmtClock(span.start)],
          ["End", span.end === null ? "running" : fmtClock(span.end)],
          ["Duration", fmtMs(timing.duration)],
          ...(timing.ttft !== null
            ? ([
                ["Time to first token", fmtMs(timing.ttft)],
                ["Decode", fmtMs(timing.decode)],
              ] as [string, string][])
            : []),
          ...(timing.tps !== null ? ([["Output speed", formatTps(timing.tps) ?? "—"]] as [string, string][]) : []),
        ]}
      />

      {(usage.input ?? usage.output ?? usage.cacheRead ?? usage.cacheWrite) !== null && (
        <Facts
          title="Tokens"
          rows={(
            [
              ["Input", usage.input],
              ["Output", usage.output],
              ["Cache read", usage.cacheRead],
              ["Cache write", usage.cacheWrite],
            ] as [string, number | null][]
          )
            .filter(([, v]) => v !== null)
            .map(([k, v]) => [k, formatTokens(v!)])}
        />
      )}

      {span.kind === "model" && hasPrompt(listed) && (
        <PromptChange sessionId={sessionId} spans={spans} span={span} ready={pending.size === 0} live={live} />
      )}

      {PAYLOADS.map(([key, label]) =>
        pending.has(key) ? (
          <Section key={key} title={label}>
            <Skeleton className="h-24 w-full" />
          </Section>
        ) : key in span.attributes ? (
          <Payload key={key} label={label} value={span.attributes[key]} />
        ) : null
      )}

      {rest.length > 0 && (
        <Section
          title="Attributes"
          copy={JSON.stringify(Object.fromEntries(rest), null, 2)}
        >
          <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1">
            {rest.map(([key, value]) => (
              <React.Fragment key={key}>
                <dt className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{key}</dt>
                <dd className="font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {pending.has(key) ? <Skeleton className="h-4 w-24" /> : text(value)}
                </dd>
              </React.Fragment>
            ))}
          </dl>
        </Section>
      )}

      {span.events.length > 0 && (
        <Section title="Events" copy={JSON.stringify(span.events, null, 2)}>
          <ol className="space-y-1">
            {span.events.map((event, i) => (
              <li key={i} className="rounded-lg bg-muted px-3 py-2">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium">{event.name}</span>
                  <span className="text-muted-foreground tabular-nums">+{fmtMs(event.at - span.start)}</span>
                </div>
                {event.attributes && Object.keys(event.attributes).length > 0 && (
                  <p className="mt-1 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {Object.entries(event.attributes)
                      .map(([k, v]) => `${k}=${text(v)}`)
                      .join("  ")}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </Section>
      )}
    </div>
  )
}

const text = (value: TraceAttributeValue) => (Array.isArray(value) ? value.join(", ") : String(value))

function Section({ title, copy, children }: { title: string; copy?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1">
      <div className="flex items-center gap-1">
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        {copy !== undefined && <CopyButton size="icon-xs" className="ml-auto" text={copy} />}
      </div>
      {children}
    </section>
  )
}

function Facts({ title, rows }: { title?: string; rows: [string, string][] }) {
  const body = (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border @panel-sm:grid-cols-3">
      {rows.map(([k, v]) => (
        <div key={k} className="bg-card px-3 py-2">
          <dt className="text-xs text-muted-foreground">{k}</dt>
          <dd className="font-medium tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  )
  return title ? <Section title={title}>{body}</Section> : body
}

/** A payload attribute: messages drawn as messages, anything else as its
    pretty-printed JSON or its text. Copy is the raw value. */
function Payload({ label, value }: { label: string; value: TraceAttributeValue }) {
  const raw = text(value)
  const parsed = parseJsonAttr(value)
  const messages = Array.isArray(parsed) && parsed.every((m) => m && typeof m === "object" && "role" in m)
  return (
    <Section title={label} copy={raw}>
      {messages ? (
        <ol className="space-y-1">
          {(parsed as Message[]).map((message, i) => (
            <li key={i} className="rounded-lg bg-muted px-3 py-2">
              <div className="mb-1 text-xs font-medium text-muted-foreground">{message.role}</div>
              <MessageBody message={message} />
            </li>
          ))}
        </ol>
      ) : (
        <Pre>{typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2)}</Pre>
      )}
    </Section>
  )
}

/* GenAI message shape: `{ role, parts: [{ type: "text", content }, …] }`;
   older/other shapes carry `content` directly. Anything not text is JSON. */
interface Message {
  role: string
  parts?: { type?: string; content?: unknown }[]
  content?: unknown
}

function MessageBody({ message }: { message: Message }) {
  const parts = message.parts ?? (message.content === undefined ? [] : [{ type: "text", content: message.content }])
  return (
    <div className="space-y-1">
      {parts.map((part, i) =>
        part.type === "text" && typeof part.content === "string" ? (
          <p key={i} className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            {part.content}
          </p>
        ) : (
          <Pre key={i}>{JSON.stringify(part, null, 2)}</Pre>
        )
      )}
    </div>
  )
}

function Pre({ children }: { children: string }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
      {children}
    </pre>
  )
}

/* ── What changed in the prompt ──
   The selected call's prompt against an earlier one's: the last call of the
   turn before (the default — what a new message and everything since did to
   the prompt), or the call just before (what one step added). System
   instructions and tool definitions as a line diff, the conversation as
   messages kept, removed and added. Both spans are read whole first: the list
   elides exactly these attributes. */
function PromptChange({
  sessionId,
  spans,
  span,
  ready,
  live,
}: {
  sessionId: string
  spans: TraceSpan[]
  span: TraceSpan
  /** The selected span is whole — its elided values have landed. */
  ready: boolean
  live: boolean
}) {
  const [scope, setScope] = React.useState<"turn" | "call">("turn")
  const listedPrev = React.useMemo(() => previousModelCall(spans, span, scope), [spans, span, scope])
  const detail = useSpanDetail(sessionId, listedPrev, live)
  const prev = detail.data ?? listedPrev
  const prevReady = !listedPrev?.elided?.length || detail.data !== undefined

  const picker = (
    <div className="ml-auto flex rounded-lg bg-muted p-0.5">
      {(["turn", "call"] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={scope === value}
          onClick={() => setScope(value)}
          className={cn(
            "rounded-md px-2 py-0.5 text-xs",
            scope === value ? "bg-card text-foreground" : "text-muted-foreground hover:text-foreground"
          )}
        >
          {value === "turn" ? "vs last turn" : "vs last call"}
        </button>
      ))}
    </div>
  )

  let body: React.ReactNode
  if (!prev) {
    body = (
      <p className="text-muted-foreground">
        {scope === "turn" ? "No earlier turn made a model call to compare with." : "This is the first model call."}
      </p>
    )
  } else if (!ready || !prevReady) {
    body = detail.error ? (
      <ErrorNote
        error={inlineFromQuery(detail.error, "Couldn't read the earlier call")}
        onRetry={() => void detail.refetch()}
      />
    ) : (
      <Skeleton className="h-24 w-full" />
    )
  } else {
    const parts = PROMPT_KEYS.map((key) => <PromptPart key={key} name={key} before={prev.attributes[key]} after={span.attributes[key]} />)
    body = (
      <div className="space-y-3">
        <p className="text-muted-foreground">
          Against <span className="font-medium text-foreground">{prev.name}</span> at {fmtClock(prev.start)}
          {prev.traceId === span.traceId ? ", earlier in this turn" : ""}.
        </p>
        {parts}
      </div>
    )
  }

  return (
    <section className="space-y-1">
      <div className="flex items-center gap-1">
        <h3 className="text-xs font-medium text-muted-foreground">Prompt change</h3>
        {picker}
      </div>
      {body}
    </section>
  )
}

const PART_LABEL: Record<(typeof PROMPT_KEYS)[number], string> = {
  "gen_ai.system_instructions": "System instructions",
  "gen_ai.tool.definitions": "Tool definitions",
  "gen_ai.input.messages": "Messages",
}

/** One attribute of the prompt, compared. */
function PromptPart({
  name,
  before,
  after,
}: {
  name: (typeof PROMPT_KEYS)[number]
  before: TraceAttributeValue | undefined
  after: TraceAttributeValue | undefined
}) {
  const label = PART_LABEL[name]
  if (before === undefined && after === undefined) return null
  const a = parseJsonAttr(before)
  const b = parseJsonAttr(after)

  if (name === "gen_ai.input.messages" && Array.isArray(a) && Array.isArray(b)) {
    const diff = diffMessages(a as Message[], b as Message[])
    return (
      <div className="space-y-2">
        <PartHeading label={label}>
          {diff.kept} kept · <span className="text-success">+{diff.added.length}</span>
          {diff.removed.length > 0 && <span className="text-destructive"> −{diff.removed.length}</span>}
        </PartHeading>
        {diff.removed.length > 0 && (
          <Notice tone="warn">
            The history was rewritten between the two calls — {diff.removed.length} earlier{" "}
            {diff.removed.length === 1 ? "message is" : "messages are"} no longer sent (a compaction or a rewind).
          </Notice>
        )}
        <ol className="space-y-1">
          {diff.removed.map((message, i) => (
            <MessageChange key={`d${i}`} message={message} op="del" />
          ))}
          {diff.added.map((message, i) => (
            <MessageChange key={`a${i}`} message={message} op="add" />
          ))}
        </ol>
      </div>
    )
  }

  const pretty = (v: unknown) => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v, null, 2))
  const lines = diffLines(pretty(a), pretty(b))
  const changed = lines === null || lines.some((line) => line.op !== "same")
  return (
    <div className="space-y-2">
      <PartHeading label={label}>
        {!changed ? (
          "unchanged"
        ) : lines === null ? (
          "changed (too long to compare line by line)"
        ) : (
          <>
            <span className="text-success">+{lines.filter((l) => l.op === "add").length}</span>{" "}
            <span className="text-destructive">−{lines.filter((l) => l.op === "del").length}</span> lines
          </>
        )}
      </PartHeading>
      {changed && lines !== null && <LineDiff lines={lines} />}
    </div>
  )
}

function PartHeading({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground tabular-nums">{children}</span>
    </div>
  )
}

function MessageChange({ message, op }: { message: Message; op: "add" | "del" }) {
  return (
    <li
      className={cn(
        "rounded-lg border-l-2 px-3 py-2",
        op === "add" ? "border-success bg-success/10" : "border-destructive bg-destructive/10 opacity-80"
      )}
    >
      <div className="mb-1 text-xs font-medium text-muted-foreground">
        {op === "add" ? "+ " : "− "}
        {message.role}
      </div>
      <MessageBody message={message} />
    </li>
  )
}

/** Unchanged runs past this many lines fold to a count, keeping context. */
const CONTEXT = 2

function LineDiff({ lines }: { lines: LineOp[] }) {
  const rows: React.ReactNode[] = []
  for (let i = 0; i < lines.length; ) {
    if (lines[i].op === "same") {
      let end = i
      while (end < lines.length && lines[end].op === "same") end++
      const run = end - i
      const lead = i === 0 ? 0 : CONTEXT
      const trail = end === lines.length ? 0 : CONTEXT
      if (run > lead + trail + 1) {
        for (let k = i; k < i + lead; k++) rows.push(<DiffRow key={k} line={lines[k]} />)
        rows.push(
          <div key={`fold${i}`} className="px-3 text-muted-foreground italic">
            … {run - lead - trail} unchanged lines
          </div>
        )
        for (let k = end - trail; k < end; k++) rows.push(<DiffRow key={k} line={lines[k]} />)
      } else for (let k = i; k < end; k++) rows.push(<DiffRow key={k} line={lines[k]} />)
      i = end
    } else {
      rows.push(<DiffRow key={i} line={lines[i]} />)
      i++
    }
  }
  return (
    <div className="max-h-80 overflow-auto rounded-lg bg-muted py-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
      {rows}
    </div>
  )
}

function DiffRow({ line }: { line: LineOp }) {
  return (
    <div
      className={cn(
        "px-3",
        line.op === "add" && "bg-success/10 text-success",
        line.op === "del" && "bg-destructive/10 text-destructive"
      )}
    >
      {line.op === "add" ? "+ " : line.op === "del" ? "− " : "  "}
      {line.text || " "}
    </div>
  )
}
