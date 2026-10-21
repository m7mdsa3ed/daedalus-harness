/* ── Tracing: a thread's trajectory as OpenTelemetry spans ──
 *
 * One tracer for the harness. Every span it starts names the thread it belongs
 * to (`daedalus.session_id`) and what it is (`daedalus.kind`), and every span
 * that finishes lands twice: in `trace_spans`, which is what the Trajectory
 * panel reads, and — when an OTLP endpoint is configured through the standard
 * `OTEL_EXPORTER_OTLP_(TRACES_)ENDPOINT` env — in whatever backend that is.
 *
 * Two sources share the table. The harness's own spans are read off ACP by the
 * bridge and so exist for every runtime: a turn, its `session/prompt`, a
 * permission wait, a spawn or load, and — for a runtime that does not trace
 * itself — the model generations and tool calls its updates imply. A runtime
 * that does trace itself (`daedalus/trace` in its `initialize` `_meta`) sends
 * its finished spans over `_daedalus/trace`, parented under our prompt span by
 * the `traceparent` that prompt carried; those are written by `ingest` with
 * `source: "agent"` and never pass through the tracer, because they are
 * already spans — re-starting them would mint new ids and break the tree.
 *
 * A span still open is kept in memory (`open`) and served from there with
 * `end: null`, so a running turn draws as it happens. Nothing about a span is
 * journaled: the journal is the transcript's, and this is a record of what
 * happened around it.
 */
import { SpanStatusCode, trace, ROOT_CONTEXT, SpanKind, type Attributes, type Span } from "@opentelemetry/api";
import { hrTimeToMilliseconds } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";

import { db, traceSpans } from "./db/index.js";
import { PROMPT_PARTS_ATTR, partsOf, shapeFromGenAi } from "./prompt-parts.js";
import {
  TRACE_LIST_VALUE_LIMIT,
  type TraceAttributeValue,
  type TraceNotificationParams,
  type TraceSpan,
  type TraceSpanEvent,
  type TraceSpanKind,
} from "./protocol.js";

const SESSION_ATTR = "daedalus.session_id";
const KIND_ATTR = "daedalus.kind";
/** One attribute's ceiling in storage. A model span's input messages are the
    whole prompt, every step; past this the tail is the part nobody reads. */
const STORED_VALUE_LIMIT = 256 * 1024;

/* ── The store ── */

type Row = typeof traceSpans.$inferInsert;

/** Spans started and not yet ended, by span id. */
const open = new Map<string, ReadableSpan>();
/** Rows waiting for the next write — one insert per tick, not per span. */
let queue: Row[] = [];
let flushing: Promise<void> | null = null;
let timer: NodeJS.Timeout | null = null;

function schedule(): void {
  timer ??= setTimeout(() => {
    timer = null;
    void flush();
  }, 250);
}

/** Write what is queued. Awaited by every read, so a span that ended a moment
    ago is in the list that asks for it. */
export async function flush(): Promise<void> {
  if (flushing) await flushing;
  if (queue.length === 0) return;
  const rows = queue;
  queue = [];
  flushing = db
    .insert(traceSpans)
    .values(rows)
    .onConflictDoNothing()
    .then(() => undefined)
    .catch(async () => {
      /* A thread purged between a span ending and the write is a foreign-key
         refusal — and one refused row fails the whole insert. Row by row, so
         only the spans with nowhere to belong are the ones lost. */
      for (const row of rows) {
        await db.insert(traceSpans).values(row).onConflictDoNothing().catch(() => {});
      }
    })
    .finally(() => {
      flushing = null;
    });
  await flushing;
}

const toMs = (time: ReadableSpan["startTime"]): number => hrTimeToMilliseconds(time);

function capValue(value: unknown): TraceAttributeValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.length > STORED_VALUE_LIMIT ? `${value.slice(0, STORED_VALUE_LIMIT)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value as TraceAttributeValue;
  return capValue(JSON.stringify(value));
}

function capAttributes(attributes: Record<string, unknown> | Attributes | undefined): Record<string, TraceAttributeValue> {
  const out: Record<string, TraceAttributeValue> = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    const capped = capValue(value);
    if (capped !== undefined) out[key] = capped;
  }
  return out;
}

/**
 * What a span is, for drawing. The harness says so itself; an agent's span is
 * read off the GenAI conventions `@ai-sdk/otel` follows — `chat <model>`,
 * `execute_tool <name>`, `step <n>`, and the operation's root.
 */
export function kindOf(name: string, attributes: Record<string, unknown>): TraceSpanKind {
  const said = attributes[KIND_ATTR];
  if (typeof said === "string") return said as TraceSpanKind;
  const op = attributes["gen_ai.operation.name"];
  if (op === "execute_tool" || name.startsWith("execute_tool")) return "tool";
  if (/^step \d+$/.test(name)) return "step";
  if (op === "chat" || op === "text_completion" || op === "generate_content" || name.startsWith("chat ")) {
    /* The operation's root carries the operation name too; only the inference
       span is a model *call*. The root is the agent's run. */
    return attributes["ai.operationId"] !== undefined && !name.startsWith("chat ") ? "agent" : "model";
  }
  if (op === "invoke_agent" || attributes["ai.operationId"] !== undefined) return "agent";
  return "other";
}

function statusOf(code: SpanStatusCode): TraceSpan["status"] {
  return code === SpanStatusCode.ERROR ? "error" : code === SpanStatusCode.OK ? "ok" : "unset";
}

function eventsOf(span: ReadableSpan): TraceSpanEvent[] {
  return span.events.map((event) => ({
    name: event.name,
    at: toMs(event.time),
    ...(event.attributes ? { attributes: capAttributes(event.attributes) } : {}),
  }));
}

function wireOf(span: ReadableSpan, ended: boolean): TraceSpan {
  const attributes = capAttributes(span.attributes);
  return {
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    parentSpanId: span.parentSpanContext?.spanId ?? null,
    sessionId: String(span.attributes[SESSION_ATTR] ?? ""),
    name: span.name,
    kind: kindOf(span.name, attributes),
    source: "harness",
    start: toMs(span.startTime),
    end: ended ? toMs(span.endTime) : null,
    status: statusOf(span.status.code),
    ...(span.status.message ? { statusMessage: span.status.message } : {}),
    attributes,
    events: eventsOf(span),
  };
}

function rowOf(span: TraceSpan & { end: number }): Row {
  return {
    spanId: span.spanId,
    traceId: span.traceId,
    parentSpanId: span.parentSpanId,
    sessionId: span.sessionId,
    name: span.name,
    kind: span.kind,
    source: span.source,
    start: span.start,
    end: span.end,
    status: span.status,
    statusMessage: span.statusMessage ?? null,
    attributes: span.attributes,
    events: span.events,
  };
}

/** The table's half of the tracer: open spans in memory, finished ones queued. */
const store: SpanProcessor = {
  onStart(span) {
    if (span.attributes[SESSION_ATTR]) open.set(span.spanContext().spanId, span as unknown as ReadableSpan);
  },
  onEnd(span) {
    open.delete(span.spanContext().spanId);
    if (!span.attributes[SESSION_ATTR]) return;
    const wire = wireOf(span, true);
    queue.push(rowOf({ ...wire, end: wire.end ?? wire.start }));
    schedule();
  },
  forceFlush: () => flush(),
  shutdown: () => flush(),
};

function otlpEndpoint(): string | undefined {
  return process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined;
}

/* The harness's spans only: a runtime's arrive already finished and are
   exported by the runtime itself, which reads the same env. */
const otlp = otlpEndpoint() ? new OTLPTraceExporter() : null;

const provider = new BasicTracerProvider({
  resource: resourceFromAttributes({ "service.name": "daedalus-harness" }),
  spanProcessors: [store, ...(otlp ? [new BatchSpanProcessor(otlp)] : [])],
});

export const tracer = provider.getTracer("daedalus-harness");

/** Flush both halves on the way down, so the last turn is not lost. */
export async function shutdownTracing(): Promise<void> {
  await provider.shutdown().catch(() => {});
}

/* ── Starting spans ── */

export interface SpanOptions {
  /** The span this one sits under. Null/absent starts a new trace — a turn,
      or a spawn that belongs to no turn. */
  parent?: Span | null;
  attributes?: Attributes;
  /** Epoch ms, for a span whose start was measured before it was opened. */
  startTime?: number;
  spanKind?: SpanKind;
}

/** A span of a thread's trajectory. The caller ends it (`end` below). */
export function startSpan(sessionId: string, name: string, kind: TraceSpanKind, options: SpanOptions = {}): Span {
  const parent = options.parent ? trace.setSpan(ROOT_CONTEXT, options.parent) : ROOT_CONTEXT;
  return tracer.startSpan(
    name,
    {
      kind: options.spanKind ?? SpanKind.INTERNAL,
      startTime: options.startTime,
      attributes: { ...options.attributes, [SESSION_ATTR]: sessionId, [KIND_ATTR]: kind },
    },
    parent,
  );
}

/** End a span, as an error when there was one. Safe on an already-ended span
    (the SDK ignores the second end), which is what makes a bridge closing
    mid-turn able to end everything it holds without asking what is open. */
export function endSpan(span: Span | null | undefined, error?: unknown, attributes?: Attributes): void {
  if (!span) return;
  if (attributes) span.setAttributes(attributes);
  if (error !== undefined && error !== null) {
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message });
  }
  span.end();
}

/** The W3C `traceparent` for a span — how a runtime that traces itself is
    told where its spans go. */
export function traceparent(span: Span): string {
  const ctx = span.spanContext();
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.traceFlags.toString(16).padStart(2, "0")}`;
}

/* ── A runtime's own spans ── */

/**
 * Write the spans a runtime sent up over `_daedalus/trace`, filed under the
 * thread the bridge that received them belongs to — never under an id the
 * agent names, which is its ACP session and not ours.
 */
export function ingest(sessionId: string, params: TraceNotificationParams): void {
  if (!Array.isArray(params.spans)) return;
  for (const span of params.spans) {
    if (!span || typeof span.spanId !== "string" || typeof span.traceId !== "string") continue;
    const attributes = capAttributes(span.attributes);
    /* The request itself is on a `chat` span — system instructions, tool
       definitions, input messages — as the AI SDK wrote it, and storage caps one
       value at 256KB, so it is divided here, from the whole value, and the
       result written beside it once counted (`daedalus.prompt_parts`). */
    void annotateRequestParts(sessionId, span.spanId, span.attributes as Record<string, unknown>);
    const start = Number(span.start);
    const end = span.end === null || span.end === undefined ? start : Number(span.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    queue.push(
      rowOf({
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: typeof span.parentSpanId === "string" ? span.parentSpanId : null,
        sessionId,
        name: String(span.name ?? "span"),
        /* A runtime's own "turn" is the run inside ours — the turn is the
           harness's span, the one root a trace has. */
        kind: ((k) => (k === "turn" ? "agent" : k))(kindOf(String(span.name ?? ""), attributes)),
        source: "agent",
        start,
        end,
        status: span.status === "error" || span.status === "ok" ? span.status : "unset",
        ...(typeof span.statusMessage === "string" ? { statusMessage: span.statusMessage } : {}),
        attributes,
        events: Array.isArray(span.events) ? span.events.map((e) => ({ ...e, attributes: capAttributes(e.attributes) })) : [],
      }),
    );
  }
  schedule();
}

/* ── What a request held, written beside the span that made it ── */

/** Merge attributes into a stored span. Waits for the queue first, so a span
    ingested a moment ago is there to update; false if there is still no such
    span (a thread purged, or a span that never arrived). */
export async function annotateSpan(
  sessionId: string,
  spanId: string,
  patch: Record<string, TraceAttributeValue>,
): Promise<boolean> {
  const value = JSON.stringify(capAttributes(patch));
  for (let attempt = 0; attempt < 2; attempt++) {
    await flush();
    const rows = await db
      .update(traceSpans)
      .set({ attributes: sql`${traceSpans.attributes} || ${value}::jsonb` })
      .where(and(eq(traceSpans.sessionId, sessionId), eq(traceSpans.spanId, spanId)))
      .returning({ spanId: traceSpans.spanId });
    if (rows.length > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function annotateRequestParts(sessionId: string, spanId: string, attributes: Record<string, unknown>): Promise<void> {
  try {
    const shape = shapeFromGenAi(attributes);
    if (!shape) return;
    /* OpenAI-compatible: `input_tokens` already includes what was cached. */
    const total = Number(attributes["gen_ai.usage.input_tokens"]);
    const parts = await partsOf(shape, total, "agent");
    if (parts) await annotateSpan(sessionId, spanId, { [PROMPT_PARTS_ATTR]: JSON.stringify(parts) });
  } catch (error) {
    console.warn(`[tracing] could not divide a request's prompt: ${error instanceof Error ? error.message : error}`);
  }
}

/** The harness's own `session/prompt` span that was running at `ms` — what a
    runtime's interaction hangs under when it reports itself over OTLP. */
export async function requestSpanAt(sessionId: string, ms: number): Promise<{ traceId: string; spanId: string } | null> {
  for (const span of open.values()) {
    if (span.attributes[SESSION_ATTR] !== sessionId || span.attributes[KIND_ATTR] !== "request") continue;
    if (toMs(span.startTime) <= ms + 1000) return { traceId: span.spanContext().traceId, spanId: span.spanContext().spanId };
  }
  await flush();
  const [row] = await db
    .select({ traceId: traceSpans.traceId, spanId: traceSpans.spanId, end: traceSpans.end })
    .from(traceSpans)
    .where(and(eq(traceSpans.sessionId, sessionId), eq(traceSpans.kind, "request"), lte(traceSpans.start, ms + 1000)))
    .orderBy(desc(traceSpans.start))
    .limit(1);
  return row && row.end >= ms - 1000 ? { traceId: row.traceId, spanId: row.spanId } : null;
}

/* ── Reading ── */

function elide(span: TraceSpan): TraceSpan {
  const elided: string[] = [];
  const attributes: Record<string, TraceAttributeValue> = {};
  for (const [key, value] of Object.entries(span.attributes)) {
    if (typeof value === "string" && value.length > TRACE_LIST_VALUE_LIMIT) {
      elided.push(key);
      attributes[key] = `${value.slice(0, TRACE_LIST_VALUE_LIMIT)}…`;
    } else attributes[key] = value;
  }
  return elided.length ? { ...span, attributes, elided } : span;
}

function fromRow(row: typeof traceSpans.$inferSelect): TraceSpan {
  return {
    traceId: row.traceId,
    spanId: row.spanId,
    parentSpanId: row.parentSpanId,
    sessionId: row.sessionId,
    name: row.name,
    kind: row.kind as TraceSpanKind,
    source: row.source as TraceSpan["source"],
    start: row.start,
    end: row.end,
    status: row.status as TraceSpan["status"],
    ...(row.statusMessage ? { statusMessage: row.statusMessage } : {}),
    attributes: row.attributes as Record<string, TraceAttributeValue>,
    events: row.events as TraceSpanEvent[],
  };
}

function openFor(sessionId: string): TraceSpan[] {
  const out: TraceSpan[] = [];
  for (const span of open.values()) {
    if (span.attributes[SESSION_ATTR] === sessionId) out.push(wireOf(span, false));
  }
  return out;
}

/** Every span of the thread, finished and open, oldest start first, with long
    values elided (`TRACE_LIST_VALUE_LIMIT`). */
export async function listSpans(sessionId: string): Promise<TraceSpan[]> {
  await flush();
  const rows = await db.select().from(traceSpans).where(eq(traceSpans.sessionId, sessionId)).orderBy(asc(traceSpans.start));
  const spans = [...rows.map(fromRow), ...openFor(sessionId)].map(elide);
  return spans.sort((a, b) => a.start - b.start);
}

/** One span whole — what the list elided. */
export async function getSpan(sessionId: string, spanId: string): Promise<TraceSpan | undefined> {
  const live = open.get(spanId);
  if (live && live.attributes[SESSION_ATTR] === sessionId) return wireOf(live, false);
  await flush();
  const [row] = await db
    .select()
    .from(traceSpans)
    .where(and(eq(traceSpans.sessionId, sessionId), eq(traceSpans.spanId, spanId)))
    .limit(1);
  return row ? fromRow(row) : undefined;
}
