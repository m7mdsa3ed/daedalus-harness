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
 * The key in the path is the credential, exactly as `/ide/<key>/` is: the
 * route is unauthenticated because the CLI sends its own `x-api-key` for the
 * gateway, and a bare `/gw/<profileId>/` would be an open relay to whatever
 * `baseUrl` a profile names. The key is minted per boot and never stored —
 * the only readers are child processes this server spawns, and a restart
 * kills those anyway. `{gatewayUrl}` in an agent's env template
 * (`registry.ts`) is where it is handed out.
 */
import { randomBytes } from "node:crypto";

import { getProfile, profileBaseUrl } from "./profiles.js";

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

/** Called once at boot with the port this server listens on. Until then
    `gatewayUrlFor` hands out nothing and a spawn goes straight to the gateway
    — which is also what a test that never boots a server gets. */
export function configureGatewayShim(opts: { port: number }): void {
  shim = { key: randomBytes(24).toString("hex"), port: opts.port };
}

/** The URL a spawned agent should use instead of `baseUrl`, or `""` when there
    is no gateway to front (the virtual Default profile) or no shim yet. */
export function gatewayUrlFor(profileId: string, agentId: string, baseUrl: string): string {
  if (!shim || !baseUrl.trim()) return "";
  return `http://127.0.0.1:${shim.port}/gw/${shim.key}/${encodeURIComponent(profileId)}/${encodeURIComponent(agentId)}`;
}

/** `/gw/<key>/<profileId>/<agentId>/rest…` → its parts, or null when the shape is not ours. */
export function parseGatewayPath(
  pathname: string,
): { key: string; profileId: string; agentId: string; rest: string } | null {
  if (!pathname.startsWith("/gw/")) return null;
  const parts = pathname.slice("/gw/".length).split("/");
  const [key, profileId, agentId, ...rest] = parts;
  if (!key || !profileId || !agentId) return null;
  return {
    key,
    profileId: decodeURIComponent(profileId),
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

/* ── The proxy ── */

const notFound = (error: string) =>
  new Response(JSON.stringify({ error }), { status: 404, headers: { "content-type": "application/json" } });

/** Forward one request to the profile's gateway. */
export async function proxyGatewayRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const parsed = parseGatewayPath(url.pathname);
  if (!parsed) return notFound("not a gateway path");
  if (!shim || parsed.key !== shim.key) return notFound("unknown gateway key");
  const profile = getProfile(parsed.profileId);
  const baseUrl = profile ? profileBaseUrl(profile, parsed.agentId) : "";
  if (!baseUrl) return notFound("that profile has no base URL");

  const headers = new Headers();
  req.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name.toLowerCase())) headers.set(name, value);
  });

  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl.replace(/\/+$/, "")}${parsed.rest}${url.search}`, {
      method: req.method,
      headers,
      body: req.body,
      // Node's fetch refuses a ReadableStream body without this.
      ...(req.body ? { duplex: "half" } : {}),
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
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
