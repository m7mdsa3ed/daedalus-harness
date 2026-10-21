/* ── OTLP intake: a runtime's own telemetry, filed as the thread's spans ──
 *
 * A runtime that exports OpenTelemetry (`AgentDef.telemetryVia`) is handed
 * `{otlpUrl}` — `/otlp/<key>/<threadId>` on this server — as its exporter
 * endpoint, and posts OTLP/JSON to `<url>/v1/traces` and `<url>/v1/logs`. What
 * arrives is the runtime's own account of itself: its interaction, every model
 * request with the provider's exact token counts, every tool. The bridge then
 * stops *deriving* those from ACP (`AcpBridge.selfTraced`) — never both, or each
 * call would be drawn and counted twice.
 *
 * The request body is the other half. A runtime that can write its raw API
 * request to a file (`OTEL_LOG_RAW_API_BODIES=file:<dir>`) names it on a
 * `api_request_body` log event; it is read **from that thread's own directory
 * and nowhere else**, divided into system / tools / MCP / the conversation
 * (`prompt-parts.ts`), written beside the model span as `daedalus.prompt_parts`, and
 * deleted. A body holds the whole conversation, so it lives on disk only as long
 * as it takes to be read.
 *
 * The key in the path is the credential, exactly as `/gw/<key>/`: derived from
 * data/loopback-secret, read only by children this server spawns, a 404 for
 * anything else. Identity attributes a runtime adds to every span (an email,
 * an account id) are dropped on the way in — they describe the person, not the
 * work, and nothing here reads them.
 *
 * Dialects: the wire is standard OTLP; the span and event *names* are the
 * runtime's. `claude-otlp` is the one written down so far.
 */
import { mkdirSync, rmSync } from "node:fs";
import { readFile, stat, unlink } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

import { DATA_DIR } from "./config.js";
import { safeKeyEqual } from "./gateway-shim.js";
import { derive } from "./loopback-secret.js";
import { PROMPT_PARTS_ATTR, countRequest, scaleParts, shapeFromBody, type RawCounts } from "./prompt-parts.js";
import type { TraceAttributeValue, TraceNotificationParams } from "./protocol.js";
import { annotateSpan, ingest, requestSpanAt } from "./tracing.js";

export type TelemetryDialect = "claude-otlp";

let receiver: { key: string; port: number } | null = null;
const BODIES = join(DATA_DIR, "otlp-bodies");

/** Called once at boot with the port this server listens on. Until then no
    endpoint is handed out and a runtime exports nowhere — which is also what a
    test that never boots a server gets. Any body a previous run left behind is
    removed: it holds a conversation and nothing will read it now. */
export function configureOtlp(opts: { port: number }): void {
  receiver = { key: derive("otlp"), port: opts.port };
  rmSync(BODIES, { recursive: true, force: true });
}

/** The exporter endpoint a thread's runtime posts to, or "" when there is none. */
export function otlpUrlFor(threadId: string): string {
  if (!receiver) return "";
  return `http://127.0.0.1:${receiver.port}/otlp/${receiver.key}/${encodeURIComponent(threadId)}`;
}

/** `file:<dir>` for a runtime's raw request bodies — a private directory of the
    thread's own, made now — or "" when there is no endpoint to tell about them. */
export function otlpBodiesFor(threadId: string): string {
  if (!receiver) return "";
  const dir = bodiesDirOf(threadId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return `file:${dir}`;
}

const bodiesDirOf = (threadId: string) => join(BODIES, threadId.replace(/[^\w-]/g, "_"));

type ThreadCheck = (threadId: string) => boolean;
let isThread: ThreadCheck = () => false;
/** The SessionManager hands over whether a thread exists; until it does, every
    path 404s, which is also what a test that boots the receiver alone gets. */
export function setOtlpThreadCheck(check: ThreadCheck): void {
  isThread = check;
}

/* ── OTLP/JSON → plain values ── */

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function anyValue(raw: unknown): TraceAttributeValue | undefined {
  const v = record(raw);
  if (!v) return undefined;
  if (typeof v.stringValue === "string") return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return Number(v.doubleValue);
  if (typeof v.boolValue === "boolean") return v.boolValue;
  const arr = record(v.arrayValue);
  if (arr) {
    const items = list(arr.values).map(anyValue);
    return items.every((i) => typeof i === "string") ? (items as string[]) : JSON.stringify(items);
  }
  const kv = record(v.kvlistValue);
  if (kv) return JSON.stringify(Object.fromEntries(list(kv.values).map((e) => [String(record(e)?.key), anyValue(record(e)?.value)])));
  return undefined;
}

function attributesOf(raw: unknown): Record<string, TraceAttributeValue> {
  const out: Record<string, TraceAttributeValue> = {};
  for (const entry of list(raw)) {
    const e = record(entry);
    const value = anyValue(e?.value);
    if (e && typeof e.key === "string" && value !== undefined) out[e.key] = value;
  }
  return out;
}

const nanosToMs = (value: unknown): number => Number(value) / 1e6;

/** What identifies the person rather than the work. */
const IDENTITY = new Set(["user.id", "user.email", "user.account_uuid", "user.account_id", "organization.id", "terminal.type"]);

/* ── the claude-otlp dialect ── */

const num = (v: TraceAttributeValue | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

interface Mapped {
  name: string;
  attributes: Record<string, TraceAttributeValue>;
}

/** Claude Code's span, said as the GenAI conventions the Trajectory already
    draws: a model call is `chat <model>` with the usage on it; a tool is
    `execute_tool <name>`; the interaction is the agent's run. */
function claudeSpan(name: string, raw: Record<string, TraceAttributeValue>): Mapped {
  const attributes: Record<string, TraceAttributeValue> = {};
  for (const [k, v] of Object.entries(raw)) if (!IDENTITY.has(k)) attributes[k] = v;
  if (name === "claude_code.llm_request") {
    const model = String(raw.model ?? raw["gen_ai.request.model"] ?? "model");
    const [input, read, write] = [num(raw.input_tokens), num(raw.cache_read_tokens), num(raw.cache_creation_tokens)];
    Object.assign(attributes, {
      "daedalus.kind": "model",
      "gen_ai.operation.name": "chat",
      /* The same convention the bridge writes: input counts what was cached. */
      "gen_ai.usage.input_tokens": input + read + write,
      "gen_ai.usage.output_tokens": num(raw.output_tokens),
      "gen_ai.usage.cache_read.input_tokens": read,
      "gen_ai.usage.cache_creation.input_tokens": write,
      "daedalus.usage.fresh_input_tokens": input,
      ...(raw.ttft_ms !== undefined ? { "daedalus.ttft_ms": num(raw.ttft_ms) } : {}),
    });
    return { name: `chat ${model}`, attributes };
  }
  if (name === "claude_code.tool") {
    attributes["daedalus.kind"] = "tool";
    attributes["gen_ai.operation.name"] = "execute_tool";
    return { name: `execute_tool ${String(raw.tool_name ?? raw["tool.name"] ?? "tool")}`, attributes };
  }
  if (name === "claude_code.interaction") {
    attributes["daedalus.kind"] = "agent";
    return { name: "invoke_agent", attributes };
  }
  attributes["daedalus.kind"] = "other";
  return { name: name.replace(/^claude_code\./, ""), attributes };
}

/* ── what a request held, once its pieces have all arrived ──
   The body, the provider's total and the span come on separate exports in no
   fixed order. Each is remembered by the request id they share until the three
   are in, then the parts are written beside the span. */

interface Pending {
  threadId: string;
  at: number;
  total?: number;
  spanId?: string;
}

const pending = new Map<string, Pending>();
/** Counted bodies by file name, until the request id that owns them is known. */
const bodies = new Map<string, { threadId: string; at: number; raw: RawCounts }>();
const PENDING_TTL_MS = 120_000;

function sweep(): void {
  const now = Date.now();
  for (const [id, p] of pending) if (now - p.at > PENDING_TTL_MS) pending.delete(id);
  for (const [file, b] of bodies) if (now - b.at > PENDING_TTL_MS) bodies.delete(file);
  if (pending.size > 128) pending.delete(pending.keys().next().value!);
  if (bodies.size > 64) bodies.delete(bodies.keys().next().value!);
}

function pendingFor(requestId: string, threadId: string): Pending {
  sweep();
  let p = pending.get(requestId);
  if (!p) pending.set(requestId, (p = { threadId, at: Date.now() }));
  return p;
}

/** Which body file a request id wrote: the runtime's own `index.jsonl`, one line
    a request, is the only place the two meet. */
async function fileFor(threadId: string, requestId: string): Promise<string | null> {
  try {
    const text = await readFile(join(bodiesDirOf(threadId), "index.jsonl"), "utf8");
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]!.includes(requestId)) continue;
      const row = record(JSON.parse(lines[i]!));
      if (row?.request_id === requestId && typeof row.request_file === "string") return row.request_file;
    }
  } catch {
    /* not written yet, or not JSON: a later event tries again */
  }
  return null;
}

/** Write the parts beside the span once the body, the provider's total and the
    span are all known — they come on separate exports in no fixed order. */
async function settle(requestId: string): Promise<void> {
  const p = pending.get(requestId);
  if (!p?.total || !p.spanId) return;
  const file = await fileFor(p.threadId, requestId);
  const counted = file ? bodies.get(file) : undefined;
  if (!counted) return;
  pending.delete(requestId);
  bodies.delete(file!);
  const parts = scaleParts(counted.raw, p.total, "otlp");
  if (parts) await annotateSpan(p.threadId, p.spanId, { [PROMPT_PARTS_ATTR]: JSON.stringify(parts) });
}

/** A path off the wire, if — and only if — it is inside the thread's own body
    directory. Read and delete both go through this: the path was named by
    whoever posted, so it is never touched until it has been shown to be ours. */
function ownPath(threadId: string, ref: string): string | null {
  const dir = resolve(bodiesDirOf(threadId));
  const path = resolve(ref);
  return path.startsWith(dir + sep) ? path : null;
}

async function readBody(path: string): Promise<unknown | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if ((await stat(path)).size > 64 * 1024 * 1024) break;
      return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return null;
}

async function claudeLog(threadId: string, event: string, a: Record<string, TraceAttributeValue>): Promise<void> {
  const requestId = typeof a.request_id === "string" ? a.request_id : "";
  if (event === "api_request" && requestId) {
    pendingFor(requestId, threadId).total = num(a.input_tokens) + num(a.cache_read_tokens) + num(a.cache_creation_tokens);
    await settle(requestId);
  } else if (event === "api_request_body") {
    // An inline body is cut at the content limit: not one we can read whole.
    const path = typeof a.body_ref === "string" ? ownPath(threadId, a.body_ref) : null;
    if (!path) return;
    const body = record(await readBody(path));
    /* Read, so it goes — it holds the whole conversation. */
    await unlink(path).catch(() => {});
    if (!body) return;
    sweep();
    bodies.set(basename(path), { threadId, at: Date.now(), raw: await countRequest(shapeFromBody(body)) });
    /* Its request id is not on this event; whichever request is waiting for a body
       takes it. */
    for (const [id, p] of pending) if (p.threadId === threadId) await settle(id);
  } else if (event === "api_response_body") {
    const path = typeof a.body_ref === "string" ? ownPath(threadId, a.body_ref) : null;
    if (path) await unlink(path).catch(() => {}); // nothing reads a response
    if (requestId) await settle(requestId);
  }
}

/* ── the two signals ── */

/** Open interactions' re-parenting, by the runtime's own trace id, so every span
    of one prompt lands in the same harness trace. */
const reparent = new Map<string, { traceId: string; parentSpanId: string | null }>();

async function traces(threadId: string, body: Json): Promise<void> {
  const spans: TraceNotificationParams["spans"] = [];
  const claimed = new Map<string, { requestId: string; total: number }>();
  const all = list(body.resourceSpans)
    .flatMap((r) => list(record(r)?.scopeSpans))
    .flatMap((s) => list(record(s)?.spans))
    .map(record)
    .filter((s): s is Json => !!s && typeof s.spanId === "string" && typeof s.traceId === "string");
  const ids = new Set(all.map((s) => String(s.spanId)));
  const isRoot = (s: Json) => !(typeof s.parentSpanId === "string" && s.parentSpanId !== "" && ids.has(s.parentSpanId));
  /* A prompt's interaction is the root of the runtime's own trace; hang it under
     the harness's `session/prompt` that was running, and its descendants follow.
     Settled first, because a child ends — and so is exported — before its parent. */
  for (const s of all) {
    if (s.name !== "claude_code.interaction" || !isRoot(s) || reparent.has(String(s.traceId))) continue;
    const at = await requestSpanAt(threadId, nanosToMs(s.startTimeUnixNano));
    if (at) {
      if (reparent.size > 256) reparent.delete(reparent.keys().next().value!);
      reparent.set(String(s.traceId), { traceId: at.traceId, parentSpanId: at.spanId });
    }
  }
  for (const s of all) {
    const rawAttributes = attributesOf(s.attributes);
    const mapped = claudeSpan(String(s.name ?? "span"), rawAttributes);
    const moved = reparent.get(String(s.traceId));
    const own = typeof s.parentSpanId === "string" && s.parentSpanId !== "" ? s.parentSpanId : null;
    const status = record(s.status);
    spans.push({
      traceId: moved?.traceId ?? String(s.traceId),
      spanId: String(s.spanId),
      parentSpanId: s.name === "claude_code.interaction" && isRoot(s) && moved ? moved.parentSpanId : own,
      name: mapped.name,
      start: nanosToMs(s.startTimeUnixNano),
      end: nanosToMs(s.endTimeUnixNano),
      status: status?.code === 2 ? "error" : status?.code === 1 ? "ok" : "unset",
      ...(typeof status?.message === "string" && status.message ? { statusMessage: status.message } : {}),
      attributes: mapped.attributes,
      events: list(s.events).map((e) => ({
        name: String(record(e)?.name ?? "event"),
        at: nanosToMs(record(e)?.timeUnixNano),
        attributes: attributesOf(record(e)?.attributes),
      })),
    });
    const requestId = rawAttributes.request_id;
    if (mapped.attributes["daedalus.kind"] === "model" && typeof requestId === "string")
      claimed.set(String(s.spanId), { requestId, total: num(mapped.attributes["gen_ai.usage.input_tokens"]) });
  }
  if (spans.length > 0) ingest(threadId, { sessionId: threadId, spans });
  for (const [spanId, { requestId, total }] of claimed) {
    const p = pendingFor(requestId, threadId);
    p.spanId = spanId;
    p.total ??= total;
    await settle(requestId);
  }
}

async function logs(threadId: string, body: Json): Promise<void> {
  const records = list(body.resourceLogs).flatMap((r) => list(record(r)?.scopeLogs)).flatMap((s) => list(record(s)?.logRecords));
  for (const raw of records) {
    const attributes = attributesOf(record(raw)?.attributes);
    const event = typeof attributes["event.name"] === "string" ? attributes["event.name"] : "";
    await claudeLog(threadId, event, attributes).catch((error) =>
      console.warn(`[otlp] ${event}: ${error instanceof Error ? error.message : error}`),
    );
  }
}

/* ── the route ── */

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** `POST /otlp/<key>/<threadId>/v1/<traces|logs|metrics>` */
export async function handleOtlp(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname.split("/");
  const [, , key, rawThread, version, signal] = path;
  if (!receiver || !key || !safeKeyEqual(key, receiver.key)) return json(404, { error: "unknown key" });
  const threadId = decodeURIComponent(rawThread ?? "");
  if (!threadId || !isThread(threadId)) return json(404, { error: "unknown thread" });
  if (req.method !== "POST" || version !== "v1") return json(404, { error: "not an OTLP path" });
  if (signal === "metrics") return json(200, {});
  if (signal !== "traces" && signal !== "logs") return json(404, { error: "not an OTLP signal" });
  if (!/application\/json/i.test(req.headers.get("content-type") ?? "")) return json(415, { error: "OTLP/JSON only" });
  let body: Json | null;
  try {
    let bytes: Buffer = Buffer.from(await req.arrayBuffer());
    if (/gzip/i.test(req.headers.get("content-encoding") ?? "")) bytes = gunzipSync(bytes);
    body = record(JSON.parse(bytes.toString("utf8")));
  } catch {
    return json(400, { error: "not JSON" });
  }
  if (!body) return json(400, { error: "not an OTLP body" });
  /* Answered first: the runtime waits on this, and the work is ours. */
  const work = signal === "traces" ? traces(threadId, body) : logs(threadId, body);
  work.catch((error) => console.warn(`[otlp] ${signal}: ${error instanceof Error ? error.message : error}`));
  return json(200, {});
}
