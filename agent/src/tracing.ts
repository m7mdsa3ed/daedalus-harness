/**
 * OpenTelemetry for this runtime: every span it makes is sent up to the harness
 * over ACP (`_daedalus/trace`), parented under the harness's own prompt span by
 * the W3C `traceparent` the prompt carries in `_meta`. The bulk of the spans are
 * the AI SDK's GenAI ones (`@ai-sdk/otel` — invoke_agent, step, chat,
 * execute_tool); the few it cannot see (compaction, MCP connects, the turn that
 * retries and holds) are made here.
 *
 * A span belongs to the ACP session whose context it was started in: the turn
 * runs inside `sessionContext`, a processor copies the id onto every span as it
 * starts, and the exporter groups on it — one notification per session. A span
 * started with no session in its context has nowhere to go and is dropped.
 */
import { registerTelemetry } from "ai";
import { OpenTelemetry } from "@ai-sdk/otel";
import {
  context,
  createContextKey,
  defaultTextMapGetter,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span as ApiSpan,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { ExportResultCode, hrTimeToMilliseconds, W3CTraceContextPropagator, type ExportResult } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type ReadableSpan,
  type Span,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type * as acp from "./acp.js";

/** Advertised in `initialize` so the harness knows spans will come up. */
export const TRACE_CAPABILITY = "daedalus/trace";
/** Agent → client, spelled the same in `server/src/protocol.ts`. */
export const TRACE_NOTIFICATION = "_daedalus/trace";
export const SESSION_ATTRIBUTE = "daedalus.acp_session_id";

type AttrValue = string | number | boolean | string[] | number[] | boolean[];
export interface WireSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  start: number;
  end: number | null;
  status: "unset" | "ok" | "error";
  statusMessage?: string;
  attributes: Record<string, AttrValue>;
  events: { name: string; at: number; attributes?: Record<string, AttrValue> }[];
}
export interface TraceNotification {
  sessionId: string;
  spans: WireSpan[];
}

const SESSION_KEY = createContextKey("daedalus.acp_session_id");
const MAX_STRING = 256 * 1024;

/* Where each session's spans go. Rebound on every request that names the
   session, so a thread loaded into a new connection follows it.
   ponytail: never pruned — one entry per session this process ever served. */
const sinks = new Map<string, acp.AgentContext>();

const tagger: SpanProcessor = {
  onStart(span: Span, parent: Context) {
    const id = parent.getValue(SESSION_KEY);
    if (typeof id === "string") span.setAttribute(SESSION_ATTRIBUTE, id);
  },
  onEnd() {},
  forceFlush: async () => {},
  shutdown: async () => {},
};

const cap = (s: string) => (s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…` : s);

function flatten(attrs: Attributes | undefined): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string") out[k] = cap(v);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[k] = (v as string[]).map(cap);
    else if (Array.isArray(v) && (v.every((x) => typeof x === "number") || v.every((x) => typeof x === "boolean")))
      out[k] = v as number[] | boolean[];
    else out[k] = cap(JSON.stringify(v));
  }
  return out;
}

export function toWire(span: ReadableSpan): WireSpan {
  const sc = span.spanContext();
  const code = span.status.code;
  return {
    traceId: sc.traceId,
    spanId: sc.spanId,
    parentSpanId: span.parentSpanContext?.spanId ?? null,
    name: span.name,
    start: hrTimeToMilliseconds(span.startTime),
    end: span.ended ? hrTimeToMilliseconds(span.endTime) : null,
    status: code === SpanStatusCode.ERROR ? "error" : code === SpanStatusCode.OK ? "ok" : "unset",
    ...(span.status.message ? { statusMessage: span.status.message } : {}),
    attributes: flatten(span.attributes),
    events: span.events.map((e) => ({
      name: e.name,
      at: hrTimeToMilliseconds(e.time),
      ...(e.attributes ? { attributes: flatten(e.attributes) } : {}),
    })),
  };
}

/** One notification per session; spans with no session are dropped. */
export function groupBySession(spans: ReadableSpan[]): TraceNotification[] {
  const by = new Map<string, WireSpan[]>();
  for (const s of spans) {
    const id = s.attributes[SESSION_ATTRIBUTE];
    if (typeof id !== "string") continue;
    const list = by.get(id) ?? [];
    list.push(toWire(s));
    by.set(id, list);
  }
  return [...by].map(([sessionId, list]) => ({ sessionId, spans: list }));
}

const acpExporter: SpanExporter = {
  export(spans, done: (r: ExportResult) => void) {
    const sends = groupBySession(spans).map((n) =>
      /* Best-effort, like the retry and hold notices: a trace nobody could be
         told about must never fail the turn it describes. */
      sinks.get(n.sessionId)?.notify(TRACE_NOTIFICATION, n as unknown as never).catch(() => {}),
    );
    void Promise.all(sends).then(() => done({ code: ExportResultCode.SUCCESS }));
  },
  shutdown: async () => {},
};

const acpProcessor = new BatchSpanProcessor(acpExporter, {
  scheduledDelayMillis: 500,
  /* A chat span carries the whole prompt; a smaller batch keeps one
     notification from being tens of megabytes. */
  maxExportBatchSize: 64,
});

const processors: SpanProcessor[] = [tagger, acpProcessor];
/* The standard env, read by the exporter itself (endpoint, headers). */
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) {
  processors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
}

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
const provider = new BasicTracerProvider({ spanProcessors: processors });
export const tracer = provider.getTracer("daedalus-agent");
registerTelemetry(new OpenTelemetry({ tracer }));

const propagator = new W3CTraceContextPropagator();

/**
 * The context a session's work runs in: the harness's span (from `_meta`'s
 * `traceparent`/`tracestate`) as the parent when one was sent, the ambient
 * context otherwise, and the session id every span started under it is tagged
 * with. Also (re)binds where that session's spans are sent.
 */
export function sessionContext(sessionId: string, client: acp.AgentContext, meta?: unknown): Context {
  sinks.set(sessionId, client);
  let ctx = context.active();
  const carrier = meta as { traceparent?: unknown } | null | undefined;
  if (carrier && typeof carrier.traceparent === "string") {
    ctx = propagator.extract(ctx, carrier, defaultTextMapGetter);
  }
  return ctx.setValue(SESSION_KEY, sessionId);
}

/** Send whatever has ended so far — awaited before a prompt answers, so the
    harness holds the turn's spans before it hears the turn end. Only the ACP
    exporter: an OTLP collector's latency is no reason to hold a turn. */
export function flushTraces(): Promise<void> {
  return acpProcessor.forceFlush();
}

/** Run `fn` as the active span `name`, ending it however `fn` ends. */
export function inSpan<T>(
  name: string,
  kind: "turn" | "step" | "process",
  attributes: Attributes,
  fn: (span: ApiSpan) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes: { "daedalus.kind": kind, ...attributes } }, async (span) => {
    try {
      const out = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return out;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message ?? String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** A point in time on whatever span is running — a retry, a hold. */
export function spanEvent(name: string, attributes?: Attributes): void {
  trace.getActiveSpan()?.addEvent(name, attributes);
}
