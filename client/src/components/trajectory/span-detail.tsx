/* The selected span, as OpenTelemetry says it. Every field the span model has
   is here under its own name — identity (trace, span, parent, tracestate),
   `SpanKind`, status, timing and self time, instrumentation scope, resource,
   all attributes unfiltered, events on the span's own timeline, links — and
   the GenAI conventions are a lens beside them, shown only for a span that
   carries `gen_ai.*`. Raw is the span as OTLP/JSON, the same shape a collector
   takes. A span whose list copy elided a value is read whole (`useSpanDetail`);
   until it lands, the elided payloads skeleton. */
import * as React from "react"
import { ArrowLeftIcon, ArrowUpRightIcon, SearchIcon, XIcon } from "lucide-react"
import type { TraceAttributeValue, TraceSpan } from "@daedalus/protocol"

import { ErrorNote } from "@/components/error-note"
import { Notice } from "@/components/notice"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { inlineFromQuery } from "@/lib/errors"
import { useSpanDetail } from "@/lib/queries/trace"
import { PROMPT_PARTS_ATTR, spanPromptParts } from "@/lib/token-breakdown"
import { formatTokens, formatTps } from "@/lib/tokens"
import { hasPrompt, otelKindOf, selfTime, spanTiming, spanUsage, toOtlp, type SpanNode } from "@/lib/trajectory"
import { cn } from "@/lib/utils"
import { Facts, PAYLOADS, Payload, Pre, PromptChange, Section, text } from "./genai"
import { KIND, OTEL_KIND_LABEL, fmtClock, fmtMs, spanText } from "./kinds"
import { PromptParts } from "./prompt-parts"

type Tab = "overview" | "attributes" | "events" | "links" | "genai" | "raw"

/** Whether the span says anything the GenAI lens draws. */
const isGenAi = (span: TraceSpan) =>
  Object.keys(span.attributes).some((key) => key.startsWith("gen_ai.")) || PAYLOADS.some(([key]) => key in span.attributes)

export function SpanDetail({
  sessionId,
  spans,
  node,
  now,
  live,
  onClose,
  onSelect,
}: {
  sessionId: string
  /** The whole thread's spans — what a prompt is compared against, and where links resolve. */
  spans: TraceSpan[]
  node: SpanNode
  now: number
  live: boolean
  onClose: () => void
  /** Jump to another span (the parent, a child, a link's target). */
  onSelect: (spanId: string) => void
}) {
  const listed = node.span
  const detail = useSpanDetail(sessionId, listed, live)
  const span = detail.data ?? listed
  const pending = new Set(detail.data ? [] : (listed.elided ?? []))
  const Icon = KIND[span.kind].icon
  const byId = React.useMemo(() => new Map(spans.map((s) => [s.spanId, s])), [spans])
  const [tab, setTab] = React.useState<Tab>("overview")
  const genai = isGenAi(span)
  const links = span.links ?? []

  return (
    <div className="flex min-h-0 flex-col text-sm">
      <header className="flex items-start gap-2 p-3 pb-2">
        <Button variant="ghost" size="icon-xs" className="@panel-md:hidden" aria-label="Back to the spans" onClick={onClose}>
          <ArrowLeftIcon />
        </Button>
        <span className="flex h-5 shrink-0 items-center">
          <Icon className={cn("size-4", spanText(span))} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium [overflow-wrap:anywhere]">{span.name}</h3>
          <p className="text-muted-foreground">
            {OTEL_KIND_LABEL[otelKindOf(span)]} · {KIND[span.kind].label} · {span.source}
            {span.end === null && " · running"}
          </p>
        </div>
        <CopyButton size="icon-xs" text={JSON.stringify(toOtlp(span), null, 2)} title="Copy the span as OTLP/JSON" />
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
        <div className="px-3 pb-2">
          <Notice tone="error" title="Status: error" action={<CopyButton size="icon-xs" text={span.statusMessage ?? span.name} />}>
            {span.statusMessage && <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{span.statusMessage}</p>}
          </Notice>
        </div>
      )}

      <ErrorNote error={inlineFromQuery(detail.error, "Couldn't read the whole span")} onRetry={() => void detail.refetch()} />

      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="min-h-0 flex-1 gap-0">
        <div className="overflow-x-auto px-3 pb-2">
          <TabsList variant="line">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="attributes">Attributes · {Object.keys(span.attributes).length}</TabsTrigger>
            <TabsTrigger value="events">Events · {span.events.length}</TabsTrigger>
            <TabsTrigger value="links">Links · {links.length}</TabsTrigger>
            {genai && <TabsTrigger value="genai">GenAI</TabsTrigger>}
            <TabsTrigger value="raw">OTLP</TabsTrigger>
          </TabsList>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          <TabsContent value="overview">
            <Overview span={span} node={node} byId={byId} now={now} onSelect={onSelect} />
          </TabsContent>
          <TabsContent value="attributes">
            <Attributes span={span} pending={pending} />
          </TabsContent>
          <TabsContent value="events">
            <Events span={span} />
          </TabsContent>
          <TabsContent value="links">
            <Links span={span} byId={byId} onSelect={onSelect} />
          </TabsContent>
          {genai && (
            <TabsContent value="genai">
              <GenAiLens sessionId={sessionId} spans={spans} span={span} listed={listed} pending={pending} live={live} />
            </TabsContent>
          )}
          <TabsContent value="raw">
            <Pre>{JSON.stringify(toOtlp(span), null, 2)}</Pre>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  )
}

/* ── Overview: the span's own structure ── */

function Overview({
  span,
  node,
  byId,
  now,
  onSelect,
}: {
  span: TraceSpan
  node: SpanNode
  byId: Map<string, TraceSpan>
  now: number
  onSelect: (spanId: string) => void
}) {
  const duration = span.end === null ? null : span.end - span.start
  const self = selfTime(node, now)
  const parent = span.parentSpanId ? byId.get(span.parentSpanId) : undefined
  return (
    <div className="space-y-4">
      <Facts
        rows={[
          ["Start", fmtClock(span.start)],
          ["End", span.end === null ? "running" : fmtClock(span.end)],
          ["Duration", fmtMs(duration)],
          ["Self time", node.children.length ? fmtMs(self) : "—"],
          ["Children", String(node.children.length)],
          ["Status", span.status],
        ]}
      />

      <Section title="Identity">
        <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1">
          <Field name="trace_id" value={span.traceId} copy />
          <Field name="span_id" value={span.spanId} copy />
          <dt className="font-mono text-xs text-muted-foreground">parent_span_id</dt>
          <dd className="font-mono text-xs [overflow-wrap:anywhere]">
            {span.parentSpanId ? (
              parent ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-left underline-offset-2 hover:underline"
                  onClick={() => onSelect(parent.spanId)}
                >
                  {span.parentSpanId}
                  <ArrowUpRightIcon className="size-3" />
                  <span className="font-sans text-muted-foreground">{parent.name}</span>
                </button>
              ) : (
                <>
                  {span.parentSpanId} <span className="font-sans text-muted-foreground">(not recorded)</span>
                </>
              )
            ) : (
              <span className="font-sans text-muted-foreground">none — a root</span>
            )}
          </dd>
          <Field name="kind" value={OTEL_KIND_LABEL[otelKindOf(span)].toUpperCase()} />
          {span.traceState && <Field name="trace_state" value={span.traceState} />}
        </dl>
      </Section>

      {span.scope && (
        <Section title="Instrumentation scope">
          <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1">
            <Field name="name" value={span.scope.name} />
            {span.scope.version && <Field name="version" value={span.scope.version} />}
          </dl>
        </Section>
      )}

      {span.resource && Object.keys(span.resource).length > 0 && (
        <Section title="Resource" copy={JSON.stringify(span.resource, null, 2)}>
          <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1">
            {Object.entries(span.resource).map(([key, value]) => (
              <Field key={key} name={key} value={text(value)} />
            ))}
          </dl>
        </Section>
      )}
    </div>
  )
}

function Field({ name, value, copy }: { name: string; value: string; copy?: boolean }) {
  return (
    <>
      <dt className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{name}</dt>
      <dd className="flex items-baseline gap-1 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
        {value}
        {copy && <CopyButton size="icon-xs" className="size-5" text={value} />}
      </dd>
    </>
  )
}

/* ── Attributes: every one, the span's own order, none held back ── */

function Attributes({ span, pending }: { span: TraceSpan; pending: ReadonlySet<string> }) {
  const [filter, setFilter] = React.useState("")
  const q = filter.trim().toLowerCase()
  const entries = Object.entries(span.attributes)
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([key, value]) => !q || key.toLowerCase().includes(q) || text(value).toLowerCase().includes(q))
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <InputGroup className="h-8 flex-1">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter attributes" aria-label="Filter attributes" />
        </InputGroup>
        <CopyButton size="icon-xs" text={JSON.stringify(span.attributes, null, 2)} title="Copy the attributes as JSON" />
      </div>
      {entries.length === 0 ? (
        <p className="text-muted-foreground">{q ? "No attribute matches." : "This span has no attributes."}</p>
      ) : (
        <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1">
          {entries.map(([key, value]) => (
            <React.Fragment key={key}>
              <dt className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{key}</dt>
              <dd className="font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
                {pending.has(key) ? <Skeleton className="h-4 w-24" /> : clip(text(value))}
              </dd>
            </React.Fragment>
          ))}
        </dl>
      )}
    </div>
  )
}

/** A long value is cut for the grid; Copy and the OTLP tab hold it whole. */
const VALUE_LINES = 12
function clip(value: string): string {
  const lines = value.split("\n")
  return lines.length > VALUE_LINES ? `${lines.slice(0, VALUE_LINES).join("\n")}\n… ${lines.length - VALUE_LINES} more lines` : value
}

/* ── Events: on the span's own timeline ── */

function Events({ span }: { span: TraceSpan }) {
  if (span.events.length === 0) return <p className="text-muted-foreground">No events were recorded on this span.</p>
  const duration = Math.max(1, (span.end ?? Math.max(...span.events.map((e) => e.at), span.start)) - span.start)
  return (
    <div className="space-y-3">
      <div className="relative h-2 rounded-full bg-muted" aria-hidden>
        {span.events.map((event, i) => (
          <span
            key={i}
            title={event.name}
            className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-chart-3 ring-2 ring-background"
            style={{ left: `${Math.min(100, Math.max(0, ((event.at - span.start) / duration) * 100))}%` }}
          />
        ))}
      </div>
      <ol className="space-y-1">
        {span.events.map((event, i) => (
          <li key={i} className="rounded-lg bg-muted px-3 py-2">
            <div className="flex items-baseline gap-2">
              <span className="font-medium">{event.name}</span>
              <span className="text-muted-foreground tabular-nums">+{fmtMs(event.at - span.start)}</span>
              <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">{fmtClock(event.at)}</span>
            </div>
            {event.attributes && Object.keys(event.attributes).length > 0 && (
              <dl className="mt-1 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-0.5">
                {Object.entries(event.attributes).map(([k, v]) => (
                  <React.Fragment key={k}>
                    <dt className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{k}</dt>
                    <dd className="font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{clip(text(v))}</dd>
                  </React.Fragment>
                ))}
              </dl>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}

/* ── Links: causal references that are not the parent ── */

function Links({
  span,
  byId,
  onSelect,
}: {
  span: TraceSpan
  byId: Map<string, TraceSpan>
  onSelect: (spanId: string) => void
}) {
  const links = span.links ?? []
  if (links.length === 0) return <p className="text-muted-foreground">This span links to no other span.</p>
  return (
    <ol className="space-y-1">
      {links.map((link, i) => {
        const target = byId.get(link.spanId)
        return (
          <li key={i} className="rounded-lg bg-muted px-3 py-2">
            {target ? (
              <button type="button" className="flex items-center gap-1 text-left font-medium hover:underline" onClick={() => onSelect(target.spanId)}>
                {target.name}
                <ArrowUpRightIcon className="size-3" />
              </button>
            ) : (
              <span className="text-muted-foreground">Not in this thread's record</span>
            )}
            <dl className="mt-1 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-0.5">
              <Field name="trace_id" value={link.traceId} />
              <Field name="span_id" value={link.spanId} />
              {Object.entries(link.attributes ?? {}).map(([k, v]) => (
                <Field key={k} name={k} value={text(v)} />
              ))}
            </dl>
          </li>
        )
      })}
    </ol>
  )
}

/* ── GenAI: the conventions' layer ── */

function GenAiLens({
  sessionId,
  spans,
  span,
  listed,
  pending,
  live,
}: {
  sessionId: string
  spans: TraceSpan[]
  span: TraceSpan
  listed: TraceSpan
  pending: ReadonlySet<string>
  live: boolean
}) {
  const timing = spanTiming(span)
  const usage = spanUsage(span)
  const a = span.attributes
  const said = (key: string) => (a[key] === undefined ? null : text(a[key]))
  const identity: [string, string][] = (
    [
      ["Operation", said("gen_ai.operation.name")],
      ["Provider", said("gen_ai.provider.name") ?? said("gen_ai.system")],
      ["Request model", said("gen_ai.request.model")],
      ["Response model", said("gen_ai.response.model")],
      ["Agent", said("gen_ai.agent.name")],
      ["Tool", said("gen_ai.tool.name")],
      ["Finish", said("gen_ai.response.finish_reasons")],
    ] as [string, string | null][]
  ).filter((row): row is [string, string] => row[1] !== null)
  const tokens = (
    [
      ["Input", usage.input],
      ["Output", usage.output],
      ["Cache read", usage.cacheRead],
      ["Cache write", usage.cacheWrite],
    ] as [string, number | null][]
  )
    .filter(([, v]) => v !== null)
    .map(([k, v]): [string, string] => [k, formatTokens(v!)])
  return (
    <div className="space-y-4">
      {identity.length > 0 && <Facts rows={identity} />}
      {(timing.ttft !== null || timing.tps !== null) && (
        <Facts
          title="Timing"
          rows={[
            ...(timing.ttft !== null ? ([["Time to first token", fmtMs(timing.ttft)], ["Decode", fmtMs(timing.decode)]] as [string, string][]) : []),
            ...(timing.tps !== null ? ([["Output speed", formatTps(timing.tps) ?? "—"]] as [string, string][]) : []),
          ]}
        />
      )}
      {tokens.length > 0 && <Facts title="Tokens" rows={tokens} />}

      {span.kind === "model" && spanPromptParts(span.attributes) && (
        <Section title="Prompt by part">
          <PromptParts span={span} />
        </Section>
      )}

      {span.kind === "model" && hasPrompt(listed) && (
        <PromptChange sessionId={sessionId} spans={spans} span={span} ready={pending.size === 0} live={live} />
      )}

      {PAYLOADS.map(([key, label]) =>
        pending.has(key) ? (
          <Section key={key} title={label}>
            <Skeleton className="h-24 w-full" />
          </Section>
        ) : key in a ? (
          <Payload key={key} label={label} value={a[key] as TraceAttributeValue} />
        ) : null
      )}
    </div>
  )
}
