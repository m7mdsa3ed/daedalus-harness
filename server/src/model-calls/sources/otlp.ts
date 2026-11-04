/* ── The otlp door: Claude Code's own telemetry, filed as model calls ──
 *
 * A runtime with an `otlp` door (`dialect: "claude-otlp"`) is handed
 * `/otlp/<key>/<threadId>` as its OTLP exporter endpoint and a private
 * directory for its raw request bodies, both through the door's templated
 * `env` (`{otlpUrl}`, `{otlpBodies}`). It posts OTLP/JSON logs; two events
 * matter and are paired by request id: `api_request` (the provider's exact
 * counters, `cost_usd`, `duration_ms`, `model`) and `api_request_body` (the
 * file it wrote the request to — read from the thread's own directory and
 * nowhere else, shaped by the Anthropic adapter, deleted). The pair is one
 * draft to `recordCall`. A request whose body never comes is a record with no
 * `prompt`; a body whose request never comes is counted billed-less.
 *
 * Trust: the key in the path is the credential (`derive("otlp")`, as `/gw/`);
 * a thread not attached here is a 404; a body path is resolved against the
 * thread's directory before it is read or unlinked; the directory is wiped at
 * boot. Nothing but the fields named above is read off an event, so identity
 * attributes (`user.email`, `organization.id`, `session.id`) land nowhere.
 * `/v1/traces` and `/v1/metrics` are answered 200 and dropped.
 */
import { mkdirSync, rmSync } from "node:fs";
import { readFile, stat, unlink } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { DATA_DIR } from "../../config.js";
import { safeKeyEqual } from "../../gateway-shim.js";
import { derive } from "../../loopback-secret.js";
import { resolveEnvValue } from "../../registry.js";
import type { CallSource, CallThread, ModelCallDraft } from "../index.js";
import { fromAnthropicMessages, type RequestShape } from "../prompt-parts.js";

let receiver: { key: string; port: number } | null = null;
const BODIES = join(DATA_DIR, "otlp-bodies");
const bodiesDirOf = (threadId: string) => join(BODIES, threadId.replace(/[^\w-]/g, "_"));

/** Called once at boot with the port this server listens on. Until then the
    door does not attach — which is also what a test that never boots gets. Any
    body a previous run left behind holds a conversation nothing will read now. */
export function configureOtlp(opts: { port: number }): void {
  receiver = { key: derive("otlp"), port: opts.port };
  rmSync(BODIES, { recursive: true, force: true });
}

/* ── attached threads and what each is waiting on ── */

/** One request's two halves, until both are in or the wait runs out. */
interface Waiting {
  draft?: ModelCallDraft;
  shape?: RequestShape;
  timer: NodeJS.Timeout;
}

interface Attachment {
  thread: CallThread;
  waiting: Map<string, Waiting>;
  /** The prefix names last sent as `items`; `items` goes again when they change. */
  prefix: string;
}

const attached = new Map<string, Attachment>();
const PAIR_WAIT_MS = 3_000;

export const otlpSource: CallSource = {
  kind: "otlp",
  async attach(thread, door) {
    if (!receiver || door.kind !== "otlp") return null;
    const dir = bodiesDirOf(thread.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const vars = {
      otlpUrl: `http://127.0.0.1:${receiver.port}/otlp/${receiver.key}/${encodeURIComponent(thread.id)}`,
      otlpBodies: `file:${dir}`,
    };
    const spawnEnv: Record<string, string> = {};
    for (const [key, template] of Object.entries(door.env)) {
      const value = resolveEnvValue(template, vars);
      if (value !== undefined) spawnEnv[key] = value;
    }
    const me: Attachment = { thread, waiting: new Map(), prefix: "" };
    attached.set(thread.id, me);
    return {
      spawnEnv,
      stop() {
        if (attached.get(thread.id) !== me) return;
        for (const w of me.waiting.values()) clearTimeout(w.timer);
        attached.delete(thread.id);
      },
    };
  },
};

/* ── OTLP/JSON → plain values ── */

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function anyValue(raw: unknown): string | number | undefined {
  const v = record(raw);
  if (!v) return undefined;
  if (typeof v.stringValue === "string") return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return Number(v.doubleValue);
  return undefined;
}

function attributesOf(raw: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const entry of list(raw)) {
    const e = record(entry);
    const value = anyValue(e?.value);
    if (e && typeof e.key === "string" && value !== undefined) out[e.key] = value;
  }
  return out;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/* ── pairing ── */

/** The record goes out once both halves are in, or when the wait runs out
    with whichever half came. */
function settle(me: Attachment, requestId: string, half: Partial<Pick<Waiting, "draft" | "shape">>): void {
  const found = me.waiting.get(requestId);
  if (found) {
    clearTimeout(found.timer);
    me.waiting.delete(requestId);
    void file(me, { ...found, ...half });
    return;
  }
  const w: Waiting = { ...half, timer: setTimeout(() => { me.waiting.delete(requestId); void file(me, w); }, PAIR_WAIT_MS) };
  me.waiting.set(requestId, w);
}

function file(me: Attachment, w: Pick<Waiting, "draft" | "shape">): Promise<void> {
  const draft: ModelCallDraft = w.draft ?? {
    callId: `otlp-${Date.now()}`,
    at: Date.now(),
    who: "turn",
    model: "",
    source: "otlp",
    billed: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
  };
  if (w.shape) {
    draft.shape = w.shape;
    const prefix = [...w.shape.system, ...w.shape.tools].map((p) => p.name).join("\n");
    if (prefix !== me.prefix) {
      me.prefix = prefix;
      draft.items = true;
    }
  }
  /* ponytail: imported at call time — index.ts holds `sources` and imports this
     file, so a static import here is a load cycle whenever a route or test
     enters through this file first. A recordCall module of its own retires it. */
  return import("../index.js")
    .then(({ recordCall }) => recordCall(me.thread, draft))
    .catch((error: unknown) => console.warn(`[otlp] record: ${error instanceof Error ? error.message : String(error)}`));
}

/** A path off the wire, if — and only if — it is inside the thread's own body
    directory. Read and delete both go through this. */
function ownPath(threadId: string, ref: string): string | null {
  const dir = resolve(bodiesDirOf(threadId));
  const path = resolve(ref);
  return path.startsWith(dir + sep) ? path : null;
}

async function readBody(path: string): Promise<Json | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if ((await stat(path)).size > 64 * 1024 * 1024) break;
      return record(JSON.parse(await readFile(path, "utf8")));
    } catch {
      await new Promise((r) => setTimeout(r, 200)); // still being written
    }
  }
  return null;
}

/** Which request a body file belongs to: `request_id` on the event when the
    runtime puts it there, else the runtime's own `index.jsonl` beside the
    bodies (one line a request, naming the file). */
async function requestIdOf(threadId: string, a: Record<string, string | number>, path: string): Promise<string> {
  if (str(a.request_id)) return str(a.request_id);
  const name = basename(path);
  try {
    const lines = (await readFile(join(bodiesDirOf(threadId), "index.jsonl"), "utf8")).split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]!.includes(name)) continue;
      const row = record(JSON.parse(lines[i]!));
      if (row?.request_file === name && typeof row.request_id === "string") return row.request_id;
    }
  } catch {
    /* not written yet, or not JSON */
  }
  return `body:${name}`; // ponytail: an unindexed body pairs with nothing and is filed billed-less
}

async function claudeLog(me: Attachment, raw: Json): Promise<void> {
  const a = attributesOf(raw.attributes);
  const event = str(a["event.name"]);
  const at = raw.timeUnixNano !== undefined ? Number(raw.timeUnixNano) / 1e6 : Date.now();
  if (event === "api_request") {
    const requestId = str(a.request_id) || `at:${at}`;
    const [input, output, read, write] = [num(a.input_tokens), num(a.output_tokens), num(a.cache_read_tokens), num(a.cache_creation_tokens)];
    settle(me, requestId, {
      draft: {
        callId: requestId,
        at: Math.round(at),
        ...(a.duration_ms !== undefined ? { ms: num(a.duration_ms) } : {}),
        who: "turn", // ponytail: the log does not say which calls were a subagent's
        model: str(a.model) || "model",
        source: "otlp",
        billed: { totalTokens: input + output + read + write, inputTokens: input, outputTokens: output, cachedReadTokens: read, cachedWriteTokens: write },
        ...(a.cost_usd !== undefined ? { costUsd: num(a.cost_usd) } : {}),
        /* `duration_ms` runs to the response's end, so what follows the first
           token is the decode — the proxy door's split. */
        ...(a.ttft_ms !== undefined
          ? { timing: { ttftMs: num(a.ttft_ms), ...(a.duration_ms !== undefined ? { decodeMs: num(a.duration_ms) - num(a.ttft_ms) } : {}) } }
          : {}),
      },
    });
  } else if (event === "api_request_body") {
    // An inline body is cut at the content limit: only a file is read whole.
    const path = str(a.body_ref) ? ownPath(me.thread.id, str(a.body_ref)) : null;
    if (!path) return;
    const body = await readBody(path);
    /* Read, so it goes — it holds the whole conversation. */
    await unlink(path).catch(() => {});
    if (!body) return;
    settle(me, await requestIdOf(me.thread.id, a, path), { shape: fromAnthropicMessages(body) });
  } else if (event === "api_response_body") {
    const path = str(a.body_ref) ? ownPath(me.thread.id, str(a.body_ref)) : null;
    if (path) await unlink(path).catch(() => {}); // nothing reads a response
  }
}

/* ── the route ── */

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** `POST /otlp/<key>/<threadId>/v1/<logs|traces|metrics>` */
export async function handleOtlp(req: Request): Promise<Response> {
  const [, , key, rawThread, version, signal] = new URL(req.url).pathname.split("/");
  if (!receiver || !key || !safeKeyEqual(key, receiver.key)) return json(404, { error: "unknown key" });
  const me = attached.get(decodeURIComponent(rawThread ?? ""));
  if (!me) return json(404, { error: "unknown thread" });
  if (req.method !== "POST" || version !== "v1") return json(404, { error: "not an OTLP path" });
  if (signal === "traces" || signal === "metrics") return json(200, {});
  if (signal !== "logs") return json(404, { error: "not an OTLP signal" });
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
  const records = list(body.resourceLogs).flatMap((r) => list(record(r)?.scopeLogs)).flatMap((s) => list(record(s)?.logRecords));
  void (async () => {
    for (const raw of records) {
      const rec = record(raw);
      if (rec) await claudeLog(me, rec).catch((error: unknown) => console.warn(`[otlp] log: ${error instanceof Error ? error.message : String(error)}`));
    }
  })();
  return json(200, {});
}
