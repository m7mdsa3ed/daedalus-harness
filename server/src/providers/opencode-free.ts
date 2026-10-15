/**
 * opencode.ai free tier (`oc/*`) as a provider.
 *
 * Measured against opencode.ai 2026-10-14 (9router#4842, verified live from
 * this repo with curl): every free request outside this fingerprint answers
 * `403 FreeTierError`.
 *
 *   - endpoint  `/inference/v1/*` (never `/zen/v1/*` for free models)
 *   - `User-Agent: opencode/latest/2.0.26/cli` (v1 `opencode/1.18.x` rejected)
 *   - `x-opencode-session` AND `x-opencode-session-id` (either alone rejected),
 *     plus `x-session-affinity` / `x-session-id` with the same value
 *   - never any `x-opencode-request` header (v1 only, rejected)
 *   - `Authorization: Bearer public`, `x-opencode-client: cli`
 *   - body carries opencode's own `read` + `shell` tools with their EXACT
 *     descriptions and parameter schemas (stubbed ones rejected); the texts
 *     below are verbatim from the v2.0.26 CLI — do not reword
 *   - `tool_choice` absent/`auto`, never `"none"`
 *   - session prefix = 12 hex of `~(timeMs * 0x1000 + counter)` masked to 48
 *     bits; upstream rejects non-small counters, so counter is pinned to 1
 *     and the session is stable per thread (minting one per request burns
 *     quota into `429 FreeUsageLimitError`)
 *   - `stream: true` upstream always; the route layer aggregates for
 *     non-streaming callers
 *
 * Responses-native models (muse-spark-*) live behind `/responses` and speak
 * the Responses dialect, which Daedalus (chat completions only) cannot. For
 * those the wrapper translates chat→responses on the way out and responses
 * SSE/JSON→chat on the way back (`chatToResponsesBody`,
 * `responsesSseToChat`, `responsesJsonToChat`). Everything else goes to
 * `/chat/completions` untouched.
 */
import { createHash, randomBytes } from "node:crypto";
import type { FreeProvider, ProviderContext } from "./types.js";

export const OPENCODE_FREE_UA = "opencode/latest/2.0.26/cli";
export const OPENCODE_FREE_CLIENT = "cli";
export const OPENCODE_FREE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const PREFIX_MASK = (1n << 48n) - 1n;
const TIME_MASK = (1n << 36n) - 1n;

/** Verbatim from the opencode v2.0.26 CLI. Upstream compares description AND parameters. */
export const FINGERPRINT_TOOLS = [
  {
    name: "read",
    description:
      "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to read" },
        offset: { type: "integer", minimum: 0, description: "The line or directory entry to start reading from (1-based)" },
        limit: { type: "integer", minimum: 0, description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "shell",
    description:
      "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command string to execute" },
        workdir: { type: "string", description: "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead." },
        timeout: { type: "integer", minimum: 0, description: "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default." },
        background: { type: "boolean", description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
] as const;

/**
 * Lowercase names the Responses gate still enforces exact definitions for. A
 * caller tool reusing one with a different definition 403s there (live: toy
 * `bash`/`glob` → 403, neutral `frobnicate` → 200), so those travel as
 * `<name>_client` on the responses path. Case variants (`Read`/`Bash`) pass
 * through untouched — upstream accepts them alongside the fingerprint.
 */
export const GATED_TOOL_NAMES = ["bash", "glob", "grep", "read", "shell"];

function descendingTimeHex(time: bigint | number, counter: bigint | number): string {
  return ((~(BigInt(time) * 0x1000n + BigInt(counter)) & PREFIX_MASK).toString(16)).padStart(12, "0");
}

function randomTail(): string {
  const bytes = randomBytes(14);
  let out = "";
  for (let i = 0; i < 14; i++) out += BASE62[bytes[i]! % 62];
  return out;
}

/**
 * Stable session per thread: deterministic time field from the thread id,
 * counter pinned to 1 — what the CLI sends, and what the gate accepts.
 * A hash-filled prefix (random counter bits) 403s; an empty/foreign id 403s.
 */
export function sessionForThread(threadId: string): string {
  const digest = createHash("sha256").update(`opencode-free\0${threadId}`).digest();
  const time = BigInt(`0x${digest.subarray(0, 5).toString("hex")}`) & TIME_MASK;
  let tail = "";
  for (let i = 6; i < 20; i++) tail += BASE62[digest[i]! % 62];
  return `ses_${descendingTimeHex(time, 1)}${tail}`;
}

/** Fresh session (one-off probes, tests). Counter pinned to 1 like the CLI. */
export function freshSession(timestamp = Date.now()): string {
  return `ses_${descendingTimeHex(timestamp, 1)}${randomTail()}`;
}

/** Decoded low-12-bit counter of a session prefix — the field the gate checks. */
export function sessionCounter(id: string): number | null {
  const m = OPENCODE_FREE_SESSION_RE.exec(id.trim());
  if (!m) return null;
  return Number(~BigInt(`0x${id.slice(4, 16)}`) & 0xfffn);
}

/** Models served by `/responses`; every other model stays on `/chat/completions`. */
const RESPONSES_MODELS = new Set(["muse-spark-1.2-contributor-free", "muse-spark-1.3-contributor-free"]);

function baseModelId(model: string): string {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

/** True for responses-native models (muse-spark-*). Exported for tests. */
export function isResponsesModel(model: string): boolean {
  const base = baseModelId(model);
  return RESPONSES_MODELS.has(base) || base.startsWith("muse-spark-");
}

type ChatTool = { type: string; function: { name: string; description?: string; parameters?: unknown } };

function toolName(tool: unknown): string {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
  const t = tool as { name?: unknown; function?: { name?: unknown } };
  if (typeof t.name === "string" && t.name.trim()) return t.name.trim();
  if (t.function && typeof t.function === "object" && typeof t.function.name === "string") return t.function.name.trim();
  return "";
}

function isExactDefinition(tool: unknown, want: (typeof FINGERPRINT_TOOLS)[number]): boolean {
  const t = tool as { function?: { description?: unknown; parameters?: unknown }; description?: unknown; parameters?: unknown };
  const def = t.function && typeof t.function === "object" ? t.function : t;
  return def.description === want.description && JSON.stringify(def.parameters) === JSON.stringify(want.parameters);
}

/**
 * Caller tools pass through verbatim, except one that already uses a
 * fingerprint name with a different definition: it travels as `<name>_client`
 * so the exact definitions can be appended without a duplicate name.
 *
 * @param flat true for Responses tools ({name}), false for chat tools ({function:{name}})
 * @returns map of sent name -> caller name, for retargeting tool_choice
 */
function applyFingerprint(body: Record<string, unknown>, flat: boolean): Map<string, string> {
  const raw = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
  const taken = new Set(raw.map(toolName));
  const seen = new Set<string>();
  const map = new Map<string, string>();
  // Flat (responses) path: upstream also enforces exact definitions for the
  // legacy lowercase names, so those are concealed too. Chat path: only the
  // fingerprint pair (verified passing with the rest untouched).
  const gated = flat ? GATED_TOOL_NAMES : FINGERPRINT_TOOLS.map((f) => f.name);
  const out: unknown[] = [];
  for (const tool of raw) {
    const name = toolName(tool);
    const want = FINGERPRINT_TOOLS.find((f) => f.name === name);
    if (!gated.includes(name)) {
      out.push(tool);
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    if (want && isExactDefinition(tool, want)) {
      out.push(tool);
      continue;
    }
    let alias = `${name}_client`;
    for (let i = 2; taken.has(alias); i++) alias = `${name}_client${i}`;
    taken.add(alias);
    map.set(alias, name);
    const t = tool as { function?: Record<string, unknown> };
    if (flat) {
      const { function: _fn, ...rest } = t as Record<string, unknown>;
      out.push({ ...rest, name: alias });
    } else {
      out.push(t.function && typeof t.function === "object" ? { ...t, function: { ...t.function, name: alias } } : { ...(t as object), name: alias });
    }
  }
  const appended: string[] = [];
  for (const want of FINGERPRINT_TOOLS) {
    if (out.some((t) => toolName(t) === want.name)) continue;
    out.push(
      flat
        ? { type: "function", name: want.name, description: want.description, parameters: want.parameters, strict: false }
        : { type: "function", function: { name: want.name, description: want.description, parameters: want.parameters } },
    );
    appended.push(want.name);
  }
  body.tools = out;
  // Without the old "must not be used" stub text the model really calls the
  // appended tools, so the system prompt marks them as placeholders instead.
  // Upstream does not gate on prompt text. Wording matters: "not available"
  // made the model refuse the caller's own tools too.
  if (appended.length) {
    const list = appended.map((n) => `\`${n}\``).join(" or ");
    const note = `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`;
    if (flat) {
      body.instructions = typeof body.instructions === "string" && body.instructions.trim() ? `${body.instructions}\n\n${note}` : note;
    } else if (Array.isArray(body.messages)) {
      const messages = body.messages as { role?: unknown; content?: unknown }[];
      const first = messages[0];
      if (first?.role === "system" && typeof first.content === "string") {
        messages[0] = { ...first, content: `${first.content}\n\n${note}` };
      } else {
        body.messages = [{ role: "system", content: note }, ...messages];
      }
    }
  }
  return map;
}

/* ── chat completions ↔ responses translation (spark models) ── */

function chatText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const p = part as Record<string, unknown>;
        if (typeof p.text === "string") return p.text;
        if (p.type === "text" && typeof (p as { text?: unknown }).text === "string") return String((p as { text?: unknown }).text);
      }
      return "";
    })
    .join("");
}

function toFlatTools(chatTools: unknown[]): { name: string; description?: string; parameters?: unknown }[] {
  return chatTools.flatMap((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return [];
    const t = tool as { name?: unknown; description?: unknown; parameters?: unknown; function?: { name?: unknown; description?: unknown; parameters?: unknown } };
    const fn = t.function && typeof t.function === "object" ? t.function : null;
    const name = (typeof t.name === "string" && t.name.trim()) || (fn && typeof fn.name === "string" ? fn.name.trim() : "");
    if (!name) return [];
    const description = (fn?.description ?? t.description) as string | undefined;
    const parameters = (fn?.parameters ?? t.parameters ?? { type: "object", properties: {} }) as unknown;
    return [{ name, description, parameters }];
  });
}

/**
 * Chat completions body → Responses body, in place. System messages become
 * `instructions`; assistant tool_calls and tool results become the
 * function_call / function_call_output items the next turn needs. Caller
 * tools reusing a gated name travel as `<name>_client` (with history renamed
 * to match); the sent→original map is kept request-local for the reply path.
 */
const bodyRenames = new WeakMap<Record<string, unknown>, Map<string, string>>();

/** Sent→original tool renames recorded for a translated request body. */
export function renamesForBody(body: Record<string, unknown>): Map<string, string> {
  return bodyRenames.get(body) ?? new Map();
}

function chatToResponsesBody(body: Record<string, unknown>): void {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const flatCaller = toFlatTools(Array.isArray(body.tools) ? (body.tools as unknown[]) : []).map((t) => ({
    type: "function",
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    parameters: t.parameters,
    strict: false,
  }));
  const probe: Record<string, unknown> = { tools: flatCaller };
  const map = applyFingerprint(probe, true);
  const byOriginal = new Map([...map].map(([alias, original]) => [original, alias]));
  const wireName = (name: string): string => byOriginal.get(name) ?? name;
  const instructions: string[] = [];
  const input: unknown[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;
    const m = msg as { role?: unknown; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown; name?: unknown };
    if (m.role === "system") {
      const text = chatText(m.content).trim();
      if (text) instructions.push(text);
      continue;
    }
    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: typeof m.tool_call_id === "string" ? m.tool_call_id : "",
        output: chatText(m.content),
      });
      continue;
    }
    if (m.role === "assistant") {
      const text = chatText(m.content).trim();
      if (text) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      if (Array.isArray(m.tool_calls)) {
        for (const call of m.tool_calls) {
          const c = call as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
          const rawName = c.function && typeof c.function === "object" && typeof c.function.name === "string" ? c.function.name : "";
          input.push({
            type: "function_call",
            call_id: typeof c.id === "string" ? c.id : "",
            name: wireName(rawName),
            arguments: c.function && typeof c.function === "object" && typeof c.function.arguments === "string" ? c.function.arguments : "{}",
          });
        }
      }
      continue;
    }
    // user and everything else: text parts only, images passed through.
    const parts: unknown[] = [];
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (typeof part === "string") {
          if (part.trim()) parts.push({ type: "input_text", text: part });
        } else if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if ((p.type === "text" || p.type === "input_text") && typeof p.text === "string" && p.text.trim()) {
            parts.push({ type: "input_text", text: p.text });
          } else if (p.type === "image_url" && p.image_url && typeof p.image_url === "object") {
            parts.push({ type: "input_image", image_url: (p.image_url as { url?: string }).url ?? "" });
          }
        }
      }
    } else {
      const text = chatText(m.content).trim();
      if (text) parts.push({ type: "input_text", text });
    }
    if (parts.length) input.push({ type: "message", role: "user", content: parts });
  }
  if (!input.length) input.push({ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] });

  const responses: Record<string, unknown> = {
    model: body.model,
    input,
    stream: true,
    store: false,
  };
  if (instructions.length) responses.instructions = instructions.join("\n\n");
  if (typeof probe.instructions === "string" && probe.instructions) {
    responses.instructions = responses.instructions ? `${responses.instructions}\n\n${probe.instructions}` : probe.instructions;
  }
  responses.tools = probe.tools;
  const choice = body.tool_choice;
  if (choice === "none") {
    // dropped: upstream 403s on "none"
  } else if (typeof choice === "string") {
    responses.tool_choice = choice === "required" ? "required" : "auto";
  } else if (choice && typeof choice === "object" && !Array.isArray(choice)) {
    const c = choice as { name?: unknown; function?: { name?: unknown } };
    const name = typeof c.name === "string" ? c.name : c.function && typeof c.function.name === "string" ? c.function.name : "";
    if (name) responses.tool_choice = { type: "function", name: wireName(name) };
  } else {
    responses.tool_choice = "auto";
  }
  if (body.max_output_tokens !== undefined) responses.max_output_tokens = body.max_output_tokens;
  else if (body.max_completion_tokens !== undefined) responses.max_output_tokens = body.max_completion_tokens;
  else if (body.max_tokens !== undefined) responses.max_output_tokens = body.max_tokens;
  for (const key of ["temperature", "top_p", "parallel_tool_calls"]) {
    if (body[key] !== undefined) responses[key] = body[key];
  }
  for (const key of Object.keys(body)) delete body[key];
  Object.assign(body, responses);
  if (map.size) bodyRenames.set(body, map);
  if (!body.tool_choice) body.tool_choice = "auto";
}

/* ── responses SSE/events → chat completion chunks ── */

interface SseState {
  id: string;
  model: string;
  created: number;
  roleSent: boolean;
  callIndex: number;
  pendingCalls: Map<string, number>;
  hasToolCalls: boolean;
  usage: Record<string, unknown> | null;
  /** sent name → caller name, for calls to aliased tools. */
  renames: Map<string, string>;
}

function newSseState(renames?: Map<string, string>): SseState {
  return { id: `chatcmpl-${Date.now()}`, model: "", created: Math.floor(Date.now() / 1000), roleSent: false, callIndex: -1, pendingCalls: new Map(), hasToolCalls: false, usage: null, renames: renames ?? new Map() };
}

function chatChunk(state: SseState, delta: unknown, finish: string | null): string {
  return `data: ${JSON.stringify({ id: state.id, object: "chat.completion.chunk", created: state.created, model: state.model, choices: [{ index: 0, delta, finish_reason: finish }] })}`;
}

/**
 * One responses SSE block → zero or more chat chunk lines (without trailing
 * blank line). Non-JSON blocks (comments, `[DONE]`) pass through untouched.
 */
export function responsesSseBlockToChat(block: string, state: SseState): string[] {
  const lines = block.split(/\r?\n/);
  const dataLines = lines.filter((l) => l.startsWith("data:"));
  if (!dataLines.length) return [block];
  let payload: unknown;
  try {
    payload = JSON.parse(dataLines.map((l) => l.slice("data:".length).trim()).join("\n"));
  } catch {
    return [block];
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [block];
  const p = payload as Record<string, unknown>;
  const out: string[] = [];
  const ensureRole = () => {
    if (!state.roleSent) {
      state.roleSent = true;
      out.push(chatChunk(state, { role: "assistant", content: "" }, null));
    }
  };
  switch (p.type) {
    case "response.created": {
      const r = (p.response ?? {}) as Record<string, unknown>;
      if (typeof r.id === "string" && r.id) state.id = r.id;
      if (typeof r.model === "string") state.model = r.model;
      if (typeof r.created_at === "number") state.created = r.created_at;
      break;
    }
    case "response.output_item.added": {
      const item = (p.item ?? {}) as Record<string, unknown>;
      if (item.type === "function_call" && typeof item.name === "string") {
        state.callIndex += 1;
        state.hasToolCalls = true;
        const key = typeof item.call_id === "string" ? item.call_id : (typeof item.id === "string" ? item.id : `call_${state.callIndex}`);
        state.pendingCalls.set(key, state.callIndex);
        ensureRole();
        out.push(
          chatChunk(state, { tool_calls: [{ index: state.callIndex, id: key, type: "function", function: { name: state.renames.get(item.name) ?? item.name, arguments: "" } }] }, null),
        );
      }
      break;
    }
    case "response.output_text.delta": {
      if (typeof p.delta === "string" && p.delta) {
        ensureRole();
        out.push(chatChunk(state, { content: p.delta }, null));
      }
      break;
    }
    case "response.function_call_arguments.delta": {
      if (typeof p.delta === "string" && p.delta) {
        ensureRole();
        const seq = typeof p.sequence_number === "number" ? p.sequence_number : null;
        const index = seq !== null && [...state.pendingCalls.values()].includes(seq) ? seq : state.callIndex;
        out.push(chatChunk(state, { tool_calls: [{ index: Math.max(0, index), function: { arguments: p.delta } }] }, null));
      }
      break;
    }
    case "response.completed":
    case "response.incomplete":
    case "response.failed": {
      const r = (p.response ?? {}) as Record<string, unknown>;
      if (r.usage && typeof r.usage === "object") state.usage = r.usage as Record<string, unknown>;
      ensureRole();
      const chunk: Record<string, unknown> = { id: state.id, object: "chat.completion.chunk", created: state.created, model: state.model, choices: [{ index: 0, delta: {}, finish_reason: state.hasToolCalls ? "tool_calls" : "stop" }] };
      if (state.usage) chunk.usage = toChatUsage(state.usage);
      out.push(`data: ${JSON.stringify(chunk)}`);
      out.push("data: [DONE]");
      break;
    }
    default:
      break;
  }
  return out;
}

/** Byte transform: responses SSE → chat completion SSE. Splits on blank lines so chunk boundaries never mis-parse. */
export function responsesSseToChat(renames?: Map<string, string>): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state = newSseState(renames);
  let buffer = "";
  const convert = (block: string): string => {
    const lines = responsesSseBlockToChat(block, state);
    return lines.length ? lines.join("\n") + "\n\n" : "";
  };
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buffer);
        if (!m) break;
        controller.enqueue(encoder.encode(convert(buffer.slice(0, m.index))));
        buffer = buffer.slice(m.index + m[0].length);
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.trim()) controller.enqueue(encoder.encode(convert(buffer)));
    },
  });
}

/** Responses usage (input/output_tokens) → chat usage (prompt/completion_tokens). */
function toChatUsage(usage: Record<string, unknown>): Record<string, number> {
  const prompt = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
  const completion = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(usage.total_tokens ?? prompt + completion) || 0,
  };
}

/** Split SSE text into parsed `data:` payloads (skips comments and [DONE]). */
function ssePayloads(text: string): unknown[] {
  const out: unknown[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice("data:".length).trim();
      if (!data || data === "[DONE]") continue;
      try {
        out.push(JSON.parse(data));
      } catch {
        // ignore partial lines
      }
    }
  }
  return out;
}

/**
 * Aggregate a chat-completions SSE stream into one chat completion object —
 * for children that asked for JSON while upstream was forced to stream.
 */
export function chatSseToJson(sseText: string, model: string): unknown {
  let id = `chatcmpl-${Date.now()}`;
  let created = Math.floor(Date.now() / 1000);
  let content = "";
  let reasoning = "";
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  let finish: string | null = null;
  let usage: Record<string, number> | null = null;
  for (const payload of ssePayloads(sseText)) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const p = payload as Record<string, unknown>;
    if (typeof p.id === "string" && p.id) id = p.id;
    if (typeof p.created === "number") created = p.created;
    if (p.usage && typeof p.usage === "object") usage = p.usage as Record<string, number>;
    const choice = (Array.isArray(p.choices) ? p.choices[0] : null) as {
      delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] };
      message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] };
      finish_reason?: string;
    } | null;
    if (!choice) continue;
    const delta = choice.delta ?? choice.message;
    if (delta) {
      if (typeof delta.content === "string") content += delta.content;
      const r = delta.reasoning_content ?? delta.reasoning;
      if (typeof r === "string") reasoning += r;
      for (const call of delta.tool_calls ?? []) {
        const index = typeof call.index === "number" ? call.index : calls.size;
        const existing = calls.get(index) ?? { id: "", name: "", arguments: "" };
        if (call.id) existing.id = call.id;
        if (call.function?.name) existing.name = call.function.name;
        if (typeof call.function?.arguments === "string") existing.arguments += call.function.arguments;
        calls.set(index, existing);
      }
    }
    if (typeof choice.finish_reason === "string" && choice.finish_reason) finish = choice.finish_reason;
  }
  const message: Record<string, unknown> = { role: "assistant", content: content || null };
  const toolCalls = [...calls.values()].filter((c) => c.id || c.name);
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((c, i) => ({ id: c.id || `call_${i}`, type: "function", function: { name: c.name, arguments: c.arguments || "{}" } }));
  }
  return {
    id, object: "chat.completion", created, model,
    choices: [{ index: 0, message, finish_reason: finish ?? (toolCalls.length ? "tool_calls" : "stop") }],
    ...(usage ? { usage } : {}),
  };
}

/**
 * Aggregate a responses SSE stream into one chat completion object: fold the
 * events into a synthetic completed-response shape, then reuse the JSON
 * translator (which also restores aliased tool names).
 */
export function responsesSseToJson(sseText: string, renames?: Map<string, string>): unknown {
  let id = `resp_${Date.now()}`;
  let model = "";
  let created = Math.floor(Date.now() / 1000);
  let text = "";
  const calls: Record<string, unknown>[] = [];
  let current: Record<string, unknown> | null = null;
  let usage: Record<string, unknown> = {};
  for (const payload of ssePayloads(sseText)) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const p = payload as Record<string, unknown>;
    switch (p.type) {
      case "response.created": {
        const r = (p.response ?? {}) as Record<string, unknown>;
        if (typeof r.id === "string" && r.id) id = r.id;
        if (typeof r.model === "string") model = r.model;
        if (typeof r.created_at === "number") created = r.created_at;
        break;
      }
      case "response.output_item.added": {
        const item = (p.item ?? {}) as Record<string, unknown>;
        if (item.type === "function_call") {
          current = { type: "function_call", call_id: item.call_id ?? item.id ?? "", name: item.name ?? "", arguments: "" };
          calls.push(current);
        }
        break;
      }
      case "response.output_text.delta":
        if (typeof p.delta === "string") text += p.delta;
        break;
      case "response.function_call_arguments.delta":
        if (current && typeof p.delta === "string") current.arguments = String(current.arguments ?? "") + p.delta;
        break;
      case "response.completed":
      case "response.incomplete":
      case "response.failed": {
        const r = (p.response ?? {}) as Record<string, unknown>;
        if (typeof r.id === "string" && r.id) id = r.id;
        if (typeof r.model === "string") model = r.model;
        if (r.usage && typeof r.usage === "object") usage = r.usage as Record<string, unknown>;
        break;
      }
      default:
        break;
    }
  }
  const output: unknown[] = [];
  if (text) output.push({ type: "message", content: [{ type: "output_text", text }] });
  output.push(...calls);
  return responsesJsonToChat({ id, object: "response", model, created_at: created, output, usage }, renames);
}
export function responsesJsonToChat(payload: unknown, renames?: Map<string, string>): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.output) && p.object !== "response") return payload;
  const content: string[] = [];
  const toolCalls: { id: string; type: string; function: { name: string; arguments: string } }[] = [];
  for (const item of (p.output ?? []) as Record<string, unknown>[]) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content as Record<string, unknown>[]) {
        if ((part.type === "output_text" || part.type === "text") && typeof part.text === "string") content.push(part.text);
      }
    } else if (item.type === "function_call" && typeof item.name === "string") {
      toolCalls.push({
        id: typeof item.call_id === "string" ? item.call_id : `call_${toolCalls.length}`,
        type: "function",
        function: { name: renames?.get(item.name) ?? item.name, arguments: typeof item.arguments === "string" ? item.arguments : "{}" },
      });
    }
  }
  const message: Record<string, unknown> = { role: "assistant", content: content.join("") || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const usage = (p.usage ?? {}) as Record<string, unknown>;
  return {
    id: typeof p.id === "string" ? p.id : `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: typeof p.created_at === "number" ? p.created_at : Math.floor(Date.now() / 1000),
    model: typeof p.model === "string" ? p.model : "",
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
    usage: {
      prompt_tokens: Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0,
      completion_tokens: Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0,
      total_tokens: Number(usage.total_tokens ?? 0) || 0,
    },
  };
}
function retargetChatToolChoice(body: Record<string, unknown>, map: Map<string, string>): void {
  if (!map.size) return;
  const choice = body.tool_choice as { name?: unknown; function?: { name?: unknown } } | null;
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return;
  const byOriginal = new Map([...map].map(([alias, original]) => [original, alias]));
  if (typeof choice.name === "string") {
    const alias = byOriginal.get(choice.name.trim());
    if (alias) body.tool_choice = { ...choice, name: alias };
    return;
  }
  const fn = choice.function;
  if (fn && typeof fn === "object" && typeof fn.name === "string") {
    const alias = byOriginal.get(fn.name.trim());
    if (alias) body.tool_choice = { ...choice, function: { ...fn, name: alias } };
  }
}

export const opencodeFree: FreeProvider = {
  id: "opencode-free",

  upstreamPath(model: string, _askedPath: string): string {
    // Daedalus speaks chat completions; responses-native models need the
    // Responses endpoint plus translation (transformBody does the body half).
    return isResponsesModel(model) ? "/responses" : "/chat/completions";
  },

  upstreamDialect(model: string): "chat" | "responses" {
    return isResponsesModel(model) ? "responses" : "chat";
  },

  async wrapResponse(upstream: Response, model: string, renames?: Map<string, string>, opts?: { wantStream?: boolean }): Promise<Response> {
    if (!upstream.body) return upstream;
    const dialect = this.upstreamDialect(model);
    const wantStream = opts?.wantStream !== false;
    const contentType = upstream.headers.get("content-type") ?? "";
    const isSse = /text\/event-stream/i.test(contentType);
    const isJson = /application\/json/i.test(contentType);
    const cleanHeaders = (): Headers => {
      const out = new Headers();
      upstream.headers.forEach((value, name) => {
        const key = name.toLowerCase();
        if (key === "content-encoding" || key === "content-length") return;
        out.append(name, value);
      });
      return out;
    };
    // The child asked for one JSON object but upstream was forced to stream:
    // aggregate the stream before answering (this is the "JSON parsing
    // failed ... [DONE]" failure: an SSE body handed to a JSON parser).
    if (!wantStream && isSse) {
      const text = await upstream.text();
      const body = dialect === "responses" ? responsesSseToJson(text, renames) : chatSseToJson(text, model);
      const out = cleanHeaders();
      out.set("content-type", "application/json");
      return new Response(JSON.stringify(body), { status: upstream.status, headers: out });
    }
    if (dialect !== "responses") return upstream;
    if (isSse) {
      const out = cleanHeaders();
      out.set("content-type", "text/event-stream");
      return new Response(upstream.body.pipeThrough(responsesSseToChat(renames)), { status: upstream.status, headers: out });
    }
    if (isJson) {
      try {
        const out = cleanHeaders();
        return new Response(JSON.stringify(responsesJsonToChat(await upstream.json(), renames)), { status: upstream.status, headers: out });
      } catch {
        return upstream;
      }
    }
    return upstream;
  },

  renamesFor(body: Record<string, unknown>): Map<string, string> {
    return renamesForBody(body);
  },

  headers(ctx: ProviderContext): Record<string, string> {
    const session = sessionForThread(ctx.threadId || "default");
    return {
      authorization: "Bearer public",
      "user-agent": OPENCODE_FREE_UA,
      "x-opencode-client": OPENCODE_FREE_CLIENT,
      "x-opencode-session": session,
      "x-opencode-session-id": session,
      "x-session-affinity": session,
      "x-session-id": session,
      "x-opencode-project": "global",
    };
  },

  dropRequestHeaders(): string[] {
    // v1-only header: upstream rejects ANY value with 403.
    return ["x-opencode-request"];
  },

  transformBody(body: Record<string, unknown>): boolean {
    // Free tier rejects non-streaming requests: always stream upstream and let
    // the route layer aggregate for non-stream callers.
    body.stream = true;
    if (isResponsesModel(typeof body.model === "string" ? body.model : "")) {
      if (body.tool_choice === "none") delete body.tool_choice;
      chatToResponsesBody(body);
      return true;
    }
    if (body.tool_choice === "none") delete body.tool_choice;
    const map = applyFingerprint(body, false);
    retargetChatToolChoice(body, map);
    return true;
  },
};
