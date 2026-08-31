/* ── Gateway shim ──
 *
 * `/gw/<key>/<profileId>/<agentId>/…` → the profile's own base URL, with one
 * repair on the way back.
 *
 * Claude Code makes two kinds of request to its endpoint, and a gateway that
 * gets one of them right can still get the other wrong. Every turn of the main
 * loop **streams**, and that is the path a Claude-Code-on-a-gateway router is
 * built and tested against. Its side jobs — the auto-mode permission
 * classifier above all, but also session titling, memory selection and the
 * rest of `sideQuery` — call `messages.create` **without** `stream`, and read
 * `response.content` straight off the JSON. 9router (the gateway this was
 * found on) forces streaming towards providers that need it and re-assembles
 * the SSE into JSON for the client — as an OpenAI `chat.completion`, for every
 * client format except Responses. A Claude-format client gets `choices[]`
 * where it expects `content[]`; the CLI's text extractor throws
 * `undefined is not an object (evaluating 'e.filter')`; the classifier reports
 * that as "<model> is temporarily unavailable" and **fails closed**, so an
 * ordinary web search or shell command is refused in auto mode while the main
 * model on the very same endpoint is healthy. Nothing in the harness's model
 * override can reach that — the classifier *is* on the profile's model, which
 * is what the error message names — because the shape of a response is the
 * gateway's to get right, and this one gets it right only when streaming.
 *
 * So the harness puts itself in front of the gateway for Claude Code and fixes
 * the one thing it can see: a non-streaming `/messages` reply that came back
 * OpenAI-shaped is rewritten into an Anthropic `message` before the CLI reads
 * it. Everything else is a byte-for-byte pass-through — streaming replies are
 * piped, not buffered; request bodies are never read (the decision is made on
 * the *response* content type, so a multi-megabyte main-loop prompt costs
 * nothing here); errors travel as they are. A gateway that answers correctly
 * pays one loopback hop and sees no difference.
 *
 * Codex gets the mirror-image repair on `/responses`, and this one touches
 * the request. Codex ≥ 0.148 sends every MCP server to the Responses API as a
 * `type: "namespace"` tool — `{name: "mcp__web_search", tools: [web_search,
 * web_fetch]}` — and expects the model's call back as `{type: "function_call",
 * name: "web_search", namespace: "mcp__web_search"}`; a flat
 * `mcp__web_search__web_search` is answered `unsupported call`. That is a
 * contract with OpenAI's own backend, and no gateway that translates
 * Responses to Chat Completions keeps it: 9router collapses the namespace
 * into one bare function with no schema, llama.cpp/LM Studio/Ollama drop or
 * reject it (openai/codex#23186, #26977 — open, no config switch). So the
 * shim flattens on the way out — every namespace becomes its member functions
 * named `<namespace>__<tool>`, and a `function_call` input item that carries
 * a namespace is flattened the same way so the conversation stays consistent
 * for the model — and on the way back re-namespaces any `function_call` whose
 * name starts with a namespace it flattened, in the SSE events and in a
 * buffered JSON reply alike. Verified against codex-acp 1.7 / codex 0.148:
 * the namespaced shape runs the MCP tool, the flat one does not. Reading a
 * `/responses` body is the cost, and only that path pays it — a request with
 * no namespace tool is forwarded exactly as it arrived.
 *
 * The key in the path is the credential, exactly as `/ide/<key>/` is: the
 * route is unauthenticated because the CLI sends its own `x-api-key` for the
 * gateway, and a bare `/gw/<profileId>/` would be an open relay to whatever
 * `baseUrl` a profile names. The key is minted per boot and never stored —
 * the only readers are child processes this server spawns, and a restart
 * kills those anyway. `{gatewayUrl}` in an agent's env template
 * (`registry.ts`) is where it is handed out.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

import { getProfile, profileBaseUrl } from "./profiles.js";

/** Constant-time string comparison for path-carried credentials — an equality
    that short-circuits on the first differing byte leaks how much of a guessed
    key matched. */
export function safeKeyEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Headers that describe a single connection and must not be forwarded. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

let shim: { key: string; port: number } | null = null;

/**
 * What the thread behind a `/gw/<key>/s/…` URL is configured with *right now*.
 *
 * The whole reason the path names a session rather than a profile: a thread's
 * profile, model and effort are the harness's to change while the agent runs,
 * and a URL that named the profile baked the answer in at spawn. Resolved per
 * request instead, from the SessionManager's own live state — so moving a
 * thread to another provider retargets the very next call the child makes,
 * with no restart and nothing for the child to notice.
 */
export interface GatewaySession {
  profileId: string;
  /** The thread's runtime. The row's, not the path's: only a respawn can
      change it, and it decides which per-agent base URL applies. */
  agentId: string;
  /** The model to put on the wire, or "" to forward whatever the child asked
      for. Set only when `rewriteModel` is true. */
  model: string;
  /** Reasoning effort to put on the wire, "" for whatever the child asked. */
  effort: string;
  /**
   * Whether the model the child names is stale and must be replaced.
   *
   * True for an agent whose model is only ever ours to change on the wire
   * (`liveConfig: "gateway"`), and true for *any* live-configured agent whose
   * profile has changed since it spawned — its env still spells the old
   * provider's ids, and Claude Code's side-job and alias vars are exactly that.
   * False otherwise, which is the common case and the one that costs nothing:
   * a request body is only ever read when this says the answer would differ.
   */
  rewriteModel: boolean;
}

type SessionResolver = (sessionId: string) => GatewaySession | undefined;

let resolveSession: SessionResolver = () => undefined;

/** The SessionManager hands its live state over at construction; until it does,
    a session-scoped URL resolves to nothing and 404s — which is what a test
    that boots the shim alone gets. */
export function setGatewaySessionResolver(resolver: SessionResolver): void {
  resolveSession = resolver;
}

/** Called once at boot with the port this server listens on. Until then
    `gatewayUrlFor` hands out nothing and a spawn goes straight to the gateway
    — which is also what a test that never boots a server gets. */
export function configureGatewayShim(opts: { port: number }): void {
  shim = { key: randomBytes(24).toString("hex"), port: opts.port };
}

/**
 * The URL a spawned agent should use instead of `baseUrl`, or `""` when there
 * is no gateway to front (the virtual Default profile) or no shim yet.
 *
 * `sessionId` is what makes the routing live, so a spawn on behalf of a thread
 * always passes it; the probe (`probe.ts`) has no thread and gets the
 * profile-scoped form, which resolves exactly as it always did.
 */
export function gatewayUrlFor(
  profileId: string,
  agentId: string,
  baseUrl: string,
  sessionId?: string,
): string {
  if (!shim || !baseUrl.trim()) return "";
  const [kind, id] = sessionId ? (["s", sessionId] as const) : (["p", profileId] as const);
  return `http://127.0.0.1:${shim.port}/gw/${shim.key}/${kind}/${encodeURIComponent(id)}/${encodeURIComponent(agentId)}`;
}

/** `/gw/<key>/<kind>/<id>/<agentId>/rest…` → its parts, or null when the shape
    is not ours. `kind` is `s` for a thread and `p` for a bare profile. */
export function parseGatewayPath(
  pathname: string,
): { key: string; kind: "s" | "p"; id: string; agentId: string; rest: string } | null {
  if (!pathname.startsWith("/gw/")) return null;
  const parts = pathname.slice("/gw/".length).split("/");
  const [key, kind, id, agentId, ...rest] = parts;
  if (!key || !id || !agentId) return null;
  if (kind !== "s" && kind !== "p") return null;
  /* Dot segments in the forwarded remainder would be rejoined verbatim and
     could walk the upstream URL out of the profile's configured base. Reject
     them (raw or percent-encoded) rather than normalising — nothing legitimate
     the CLI sends contains one. */
  for (const part of rest) {
    let decoded = part;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      /* malformed escapes stay raw — compared as-is below */
    }
    if (part === "." || part === ".." || decoded === "." || decoded === "..") return null;
  }
  return {
    key,
    kind,
    id: decodeURIComponent(id),
    agentId: decodeURIComponent(agentId),
    rest: rest.length ? `/${rest.join("/")}` : "",
  };
}

/* ── Response normalisation ── */

type Json = Record<string, unknown>;

interface ChatChoice {
  message?: {
    content?: unknown;
    reasoning_content?: unknown;
    tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[];
  };
  finish_reason?: string;
}

/** Is this body an OpenAI chat completion rather than an Anthropic message? */
export function isChatCompletion(body: unknown): body is Json & { choices: ChatChoice[] } {
  if (!body || typeof body !== "object") return false;
  const b = body as Json;
  if (b.type === "message" || Array.isArray(b.content)) return false;
  return Array.isArray(b.choices) && (b.object === "chat.completion" || b.object === undefined);
}

const STOP_REASONS: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "refusal",
};

/** The text of an OpenAI `message.content`, which is a string or an array of parts. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && typeof (part as Json).text === "string" ? (part as Json).text : ""))
    .join("");
}

/**
 * An OpenAI `chat.completion` as the Anthropic `message` the caller asked for.
 *
 * Only what a Claude-format client reads is produced: content blocks (thinking,
 * text, tool_use), `stop_reason`, and usage with the cache counters folded out
 * of `prompt_tokens_details`. A reasoning-only reply keeps its reasoning as a
 * `thinking` block so the caller can see *why* the text is empty — with
 * `max_tokens` as the stop reason, which is what actually happened.
 */
export function chatCompletionToMessage(body: Json & { choices: ChatChoice[] }): Json {
  const choice = body.choices[0] ?? {};
  const message = choice.message ?? {};
  const content: Json[] = [];
  const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
  if (reasoning) content.push({ type: "thinking", thinking: reasoning, signature: "" });
  const text = textOf(message.content);
  if (text) content.push({ type: "text", text });
  for (const [i, call] of (message.tool_calls ?? []).entries()) {
    const args = call.function?.arguments;
    let input: unknown = {};
    if (typeof args === "string") {
      try {
        input = args.trim() ? JSON.parse(args) : {};
      } catch {
        input = {};
      }
    } else if (args && typeof args === "object") input = args;
    content.push({
      type: "tool_use",
      id: call.id || `toolu_${i}`,
      name: call.function?.name ?? "",
      input,
    });
  }
  const usage = (body.usage ?? {}) as Json;
  const details = (usage.prompt_tokens_details ?? {}) as Json;
  const cacheRead = Number(details.cached_tokens ?? 0) || 0;
  const cacheCreate = Number(details.cache_creation_tokens ?? 0) || 0;
  const prompt = Number(usage.prompt_tokens ?? 0) || 0;
  return {
    id: typeof body.id === "string" && body.id ? body.id : `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: typeof body.model === "string" ? body.model : "",
    content,
    stop_reason: STOP_REASONS[choice.finish_reason ?? ""] ?? (content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"),
    stop_sequence: null,
    usage: {
      // Anthropic counts cache reads apart from input; OpenAI counts them inside prompt_tokens.
      input_tokens: Math.max(0, prompt - cacheRead - cacheCreate),
      output_tokens: Number(usage.completion_tokens ?? 0) || 0,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreate,
    },
  };
}

/** The body a Claude-format caller should see: rewritten when it was the
    wrong shape, untouched (and unparsed, if it isn't JSON) otherwise. */
export function normalizeMessagesResponse(text: string): { body: string; rewritten: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { body: text, rewritten: false };
  }
  if (!isChatCompletion(parsed)) return { body: text, rewritten: false };
  return { body: JSON.stringify(chatCompletionToMessage(parsed)), rewritten: true };
}

/* ── Codex: tool namespaces ── */

/** What Codex puts between a namespace and a member name in the flat form
    (`mcp__web_search__web_search`) — the same separator it uses inside the
    namespace name itself. */
const NS_SEP = "__";

const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A Responses request with its `namespace` tools flattened into their member
 * functions (`<namespace>__<name>`), and any namespaced `function_call` input
 * item flattened to match. Null when there is nothing to flatten — the
 * common case for everything but Codex, and the signal to forward the
 * original bytes untouched. `namespaces` is what the reply must be checked
 * against.
 */
export function flattenNamespaces(body: unknown): { body: Json; namespaces: string[] } | null {
  if (!isObject(body)) return null;
  const namespaces = new Set<string>();
  let changed = false;
  const out: Json = { ...body };
  if (Array.isArray(body.tools)) {
    const flat: unknown[] = [];
    for (const tool of body.tools) {
      if (isObject(tool) && tool.type === "namespace" && typeof tool.name === "string" && Array.isArray(tool.tools)) {
        namespaces.add(tool.name);
        changed = true;
        for (const member of tool.tools) {
          if (isObject(member) && typeof member.name === "string") flat.push({ ...member, name: `${tool.name}${NS_SEP}${member.name}` });
        }
      } else flat.push(tool);
    }
    out.tools = flat;
  }
  if (Array.isArray(body.input)) {
    out.input = body.input.map((item) => {
      if (isObject(item) && item.type === "function_call" && typeof item.namespace === "string" && typeof item.name === "string") {
        namespaces.add(item.namespace);
        changed = true;
        const { namespace, ...rest } = item;
        return { ...rest, name: `${namespace}${NS_SEP}${item.name}` };
      }
      return item;
    });
  }
  return changed ? { body: out, namespaces: [...namespaces] } : null;
}

/**
 * The reply with every flat `function_call` put back under its namespace:
 * `{name: "mcp__web_search__web_search"}` → `{name: "web_search", namespace:
 * "mcp__web_search"}`. Walks the whole value, so one function serves an
 * `output_item.added`, an `output_item.done`, the `output[]` inside
 * `response.completed` and a buffered non-streaming reply. Longest namespace
 * wins, since one may be a prefix of another. A call that already names its
 * namespace is left alone.
 */
export function renamespaceCalls(value: unknown, namespaces: string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => renamespaceCalls(v, namespaces));
  if (!isObject(value)) return value;
  const out: Json = {};
  for (const [k, v] of Object.entries(value)) out[k] = renamespaceCalls(v, namespaces);
  if (out.type === "function_call" && typeof out.name === "string" && out.namespace == null) {
    const name = out.name;
    const ns = namespaces.filter((n) => name.startsWith(n + NS_SEP)).sort((a, b) => b.length - a.length)[0];
    if (ns) {
      out.name = name.slice(ns.length + NS_SEP.length);
      out.namespace = ns;
    }
  }
  return out;
}

/** One SSE event block with its `data:` payload re-namespaced; a block whose
    data is not JSON (a comment, a `[DONE]`) is returned as it was. */
function renamespaceSseBlock(block: string, namespaces: string[]): string {
  const lines = block.split(/\r?\n/);
  const dataAt = lines.flatMap((line, i) => (line.startsWith("data:") ? [i] : []));
  if (!dataAt.length) return block;
  const data = dataAt.map((i) => lines[i]!.slice("data:".length).replace(/^ /, "")).join("\n");
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return block;
  }
  const head = lines.filter((_, i) => !dataAt.includes(i));
  return [...head, `data: ${JSON.stringify(renamespaceCalls(parsed, namespaces))}`].join("\n");
}

/**
 * A byte transform over a streaming Responses reply that re-namespaces each
 * event as it passes. Events are split on the blank line (`\n\n`, or CRLF), so
 * a chunk boundary inside an event is buffered, never mis-parsed; whatever is
 * left at the end is flushed as-is.
 */
export function renamespaceSse(namespaces: string[]): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buffer);
        if (!m) break;
        const block = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        controller.enqueue(encoder.encode(renamespaceSseBlock(block, namespaces) + m[0]));
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(renamespaceSseBlock(buffer, namespaces)));
    },
  });
}

/** Logged once per namespace set, not once per request — a turn is many. */
const loggedNamespaces = new Set<string>();

/* ── The model the child asked for, replaced by the one the thread is on ──
 *
 * The narrowest possible edit, and it is the whole of "changing the model
 * without restarting" for an agent that will not take one over ACP: the
 * request already names a model, so the shim names a different one. Both
 * dialects put it in the same place — Anthropic Messages and OpenAI Responses
 * alike carry a top-level `model` — and Responses carries the effort under
 * `reasoning.effort`, which is the other half of the same choice.
 *
 * Nothing else in the body is touched, and a request that names no model is
 * left alone rather than given one: a call with no model is not a completion,
 * and inventing a field is how a proxy breaks an endpoint it does not know.
 */
function applySessionModel(body: Json, model: string, effort: string): boolean {
  let changed = false;
  if (model && typeof body.model === "string" && body.model !== model) {
    body.model = model;
    changed = true;
  }
  if (effort) {
    const reasoning = body.reasoning;
    if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)) {
      const current = reasoning as Json;
      if (current.effort !== effort) {
        body.reasoning = { ...current, effort };
        changed = true;
      }
    }
  }
  return changed;
}

/* ── The proxy ── */

const notFound = (error: string) =>
  new Response(JSON.stringify({ error }), { status: 404, headers: { "content-type": "application/json" } });

/** Forward one request to the profile's gateway. */
export async function proxyGatewayRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const parsed = parseGatewayPath(url.pathname);
  if (!parsed) return notFound("not a gateway path");
  if (!shim || !safeKeyEqual(parsed.key, shim.key)) return notFound("unknown gateway key");
  /* A session-scoped URL is resolved through the manager on every request, so
     the thread's *current* provider answers — that is what makes moving a
     thread between profiles instant. A profile-scoped one (the probe) is the
     older, static case and stays exactly as it was. */
  const thread = parsed.kind === "s" ? resolveSession(parsed.id) : undefined;
  if (parsed.kind === "s" && !thread) return notFound("unknown thread");
  const agentId = thread?.agentId ?? parsed.agentId;
  const profile = getProfile(thread?.profileId ?? parsed.id);
  const baseUrl = profile ? profileBaseUrl(profile, agentId) : "";
  if (!baseUrl) return notFound("that profile has no base URL");

  const headers = new Headers();
  req.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name.toLowerCase())) headers.set(name, value);
  });
  /* The child carries the credential it was spawned with, which is the wrong
     one the moment the thread moves to another profile. Replace it in whatever
     shape it arrived in — `x-api-key` for Anthropic, `Authorization: Bearer`
     for OpenAI — rather than adding a header the upstream was not expecting.
     A profile with no key of its own says nothing here: the child is on its
     own auth (a ChatGPT login, a key already in the shell) and that is what
     should travel. */
  if (profile?.apiKey) {
    if (headers.has("x-api-key")) headers.set("x-api-key", profile.apiKey);
    if (headers.has("authorization")) headers.set("authorization", `Bearer ${profile.apiKey}`);
  }

  /* Two reasons to read a request body, and both are narrow. The Codex repair
     flattens namespace tools on `/responses` (see the header). The model
     rewrite replaces an id the child was spawned with by the one the thread is
     on now, and only for a thread whose `rewriteModel` says the two differ —
     so an ordinary turn, on an ordinary thread, still streams straight through
     and a multi-megabyte prompt still costs the shim nothing. */
  const isResponses = /\/responses\/?$/.test(parsed.rest);
  const rewriting = thread?.rewriteModel === true && (isResponses || /\/messages\/?$/.test(parsed.rest));
  let body: BodyInit | null = req.body;
  let namespaces: string[] = [];
  if (
    req.method === "POST" &&
    (isResponses || rewriting) &&
    /application\/json/i.test(req.headers.get("content-type") ?? "")
  ) {
    const text = await req.text();
    body = text;
    try {
      const parsedBody = JSON.parse(text) as Json;
      let edited = rewriting ? applySessionModel(parsedBody, thread.model, thread.effort) : false;
      const flat = isResponses ? flattenNamespaces(parsedBody) : null;
      if (flat) {
        namespaces = flat.namespaces;
        edited = true;
        const tag = `${parsed.id}/${agentId}:${namespaces.join(",")}`;
        if (!loggedNamespaces.has(tag)) {
          loggedNamespaces.add(tag);
          console.log(`[gateway-shim] flattening tool namespace(s) ${namespaces.join(", ")} for ${agentId} towards ${baseUrl}`);
        }
      }
      if (edited) body = JSON.stringify(flat ? flat.body : parsedBody);
    } catch {
      /* not JSON after all — forwarded as read */
    }
    headers.delete("content-length");
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl.replace(/\/+$/, "")}${parsed.rest}${url.search}`, {
      method: req.method,
      headers,
      body,
      // Node's fetch refuses a ReadableStream body without this.
      ...(body && typeof body !== "string" ? { duplex: "half" } : {}),
      redirect: "manual",
    } as RequestInit);
  } catch (error) {
    return new Response(
      JSON.stringify({ type: "error", error: { type: "api_error", message: error instanceof Error ? error.message : String(error) } }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }

  const out = new Headers();
  upstream.headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key)) return;
    // fetch already decoded the body; the old encoding and length would lie.
    if (key === "content-encoding" || key === "content-length") return;
    out.append(name, value);
  });

  /* The one repair. A non-streaming Messages reply is small (a verdict, a
     title) and JSON, so buffering it costs nothing; a streaming one is
     `text/event-stream` and is piped as it arrives. Errors keep their status
     and their body — the SDK reads `error.message` from either shape. */
  const contentType = upstream.headers.get("content-type") ?? "";
  if (upstream.ok && /\/messages\/?$/.test(parsed.rest) && /application\/json/i.test(contentType)) {
    const text = await upstream.text();
    const { body, rewritten } = normalizeMessagesResponse(text);
    if (rewritten) console.log(`[gateway-shim] rewrote an OpenAI-shaped reply from ${baseUrl} into an Anthropic message`);
    return new Response(body, { status: upstream.status, headers: out });
  }
  if (namespaces.length && upstream.ok && upstream.body) {
    if (/text\/event-stream/i.test(contentType)) {
      return new Response(upstream.body.pipeThrough(renamespaceSse(namespaces)), { status: upstream.status, headers: out });
    }
    if (/application\/json/i.test(contentType)) {
      const text = await upstream.text();
      try {
        return new Response(JSON.stringify(renamespaceCalls(JSON.parse(text), namespaces)), { status: upstream.status, headers: out });
      } catch {
        return new Response(text, { status: upstream.status, headers: out });
      }
    }
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
