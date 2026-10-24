/* ── The proxy door: any runtime behind the gateway shim ──
 *
 * The shim (`gateway-shim.ts`) forwards a thread's provider requests byte for
 * byte and, for a thread attached here, hands each one over once its reply has
 * ended (`GatewayTap`): the request body as sent, the reply as text, the
 * timing. Everything the shim does not know is decided here by the door's
 * dialect — which prompt-parts adapter shapes the request, and where the bill
 * sits in the reply (`message_start`/`message_delta` for Messages SSE, the
 * final chunk's `usage` for chat/responses SSE, or the JSON body). Counting
 * runs in `recordCall`, after the tap, never inside the forward.
 */
import { randomUUID } from "node:crypto";
import type * as acp from "../../acp.js";
import { setGatewayTap, type GatewayTap } from "../../gateway-shim.js";
import type { CallDoor } from "../../protocol.js";
import { recordCall, type CallSource, type CallThread } from "../index.js";
import { fromAnthropicMessages, fromOpenAiChat, fromOpenAiResponses, type RequestShape } from "../prompt-parts.js";

type Dialect = Extract<CallDoor, { kind: "proxy" }>["dialect"];
type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/* ── reading the bill ── */

interface Bill {
  billed: acp.Usage;
  model?: string;
  finishReason?: string;
}

function usage(input: number, output: number, read?: number, write?: number, thought?: number): acp.Usage {
  return {
    totalTokens: input + output + (read ?? 0) + (write ?? 0),
    inputTokens: input,
    outputTokens: output,
    cachedReadTokens: read ?? null,
    cachedWriteTokens: write ?? null,
    thoughtTokens: thought ?? null,
  };
}

/** Numbers from `src` over `into`; a null (`message_delta` repeats the cache
    fields as null on some gateways) never erases what `message_start` said. */
function mergeNumbers(into: Json, src: Json): Json {
  for (const [k, v] of Object.entries(src)) if (typeof v === "number") into[k] = v;
  return into;
}

/** Anthropic Messages: the JSON body is the message; streamed, `message_start`
    carries the message (model, input and cache counts) and `message_delta` the
    output count and the stop reason. */
function anthropicBill(events: Json[]): Bill | null {
  let u: Json | null = null;
  let model: string | undefined;
  let finish: string | undefined;
  for (const ev of events) {
    const message = isObject(ev.message) ? ev.message : ev.type === "message" ? ev : null;
    if (message) {
      if (isObject(message.usage)) u = mergeNumbers(u ?? {}, message.usage);
      model = str(message.model) ?? model;
      finish = str(message.stop_reason) ?? finish;
    }
    if (ev.type === "message_delta") {
      if (isObject(ev.usage)) u = mergeNumbers(u ?? {}, ev.usage);
      finish = str(isObject(ev.delta) ? ev.delta.stop_reason : undefined) ?? finish;
    }
  }
  if (!u) return null;
  return {
    billed: usage(num(u.input_tokens) ?? 0, num(u.output_tokens) ?? 0, num(u.cache_read_input_tokens), num(u.cache_creation_input_tokens)),
    model,
    finishReason: finish,
  };
}

/** OpenAI chat completions: `usage` on the body, or on the last chunk
    (`stream_options.include_usage`). Cache reads are *inside* `prompt_tokens`
    — the same fold `chatCompletionToMessage` makes. */
function openAiChatBill(events: Json[]): Bill | null {
  let u: Json | null = null;
  let model: string | undefined;
  let finish: string | undefined;
  for (const ev of events) {
    if (isObject(ev.usage)) u = ev.usage;
    model = str(ev.model) ?? model;
    const choice = Array.isArray(ev.choices) ? ev.choices[0] : null;
    finish = str(isObject(choice) ? choice.finish_reason : undefined) ?? finish;
  }
  if (!u) return null;
  const prompt = isObject(u.prompt_tokens_details) ? u.prompt_tokens_details : {};
  const completion = isObject(u.completion_tokens_details) ? u.completion_tokens_details : {};
  const read = num(prompt.cached_tokens) ?? 0;
  const write = num(prompt.cache_creation_tokens) ?? 0;
  return {
    billed: usage(Math.max(0, (num(u.prompt_tokens) ?? 0) - read - write), num(u.completion_tokens) ?? 0, read, write, num(completion.reasoning_tokens)),
    model,
    finishReason: finish,
  };
}

/** OpenAI Responses: the JSON body is the response; streamed, every event
    carries `response` and the completed one carries its `usage`. Cache reads
    are inside `input_tokens` here too. */
function openAiResponsesBill(events: Json[]): Bill | null {
  let u: Json | null = null;
  let model: string | undefined;
  let finish: string | undefined;
  for (const ev of events) {
    const response = isObject(ev.response) ? ev.response : ev.object === "response" ? ev : null;
    if (!response) continue;
    if (isObject(response.usage)) u = response.usage;
    model = str(response.model) ?? model;
    const incomplete = isObject(response.incomplete_details) ? str(response.incomplete_details.reason) : undefined;
    finish = incomplete ?? str(response.status) ?? finish;
  }
  if (!u) return null;
  const input = isObject(u.input_tokens_details) ? u.input_tokens_details : {};
  const output = isObject(u.output_tokens_details) ? u.output_tokens_details : {};
  const read = num(input.cached_tokens) ?? 0;
  return {
    billed: usage(Math.max(0, (num(u.input_tokens) ?? 0) - read), num(u.output_tokens) ?? 0, read, undefined, num(output.reasoning_tokens)),
    model,
    finishReason: finish,
  };
}

const DIALECTS: Record<Dialect, { shape: (body: Json) => RequestShape; bill: (events: Json[]) => Bill | null }> = {
  "anthropic-messages": { shape: fromAnthropicMessages, bill: anthropicBill },
  "openai-chat": { shape: fromOpenAiChat, bill: openAiChatBill },
  "openai-responses": { shape: fromOpenAiResponses, bill: openAiResponsesBill },
};

const parse = (text: string): Json | null => {
  try {
    const v: unknown = JSON.parse(text);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
};

/** The JSON objects a reply carries: the body itself, or — streamed — every
    SSE `data:` block that mentions a bill. Content deltas are the bulk of a
    stream and never carry one; in all three dialects the events that do
    (and the stop reason beside it) spell `usage`. */
function eventsOf(response: { contentType: string; body: string }): Json[] {
  if (!/text\/event-stream/i.test(response.contentType)) {
    const body = parse(response.body);
    return body ? [body] : [];
  }
  return response.body.split(/\r?\n\r?\n/).flatMap((block) => {
    if (!block.includes("usage")) return [];
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /, ""))
      .join("\n");
    const ev = parse(data);
    return ev ? [ev] : [];
  });
}

/* ── reading what the reply asked to run ── */

/** Every JSON object a reply carries, unfiltered — the tool calls ride the
    content events `eventsOf` skips. Only read for the names, once per reply. */
function allEventsOf(response: { contentType: string; body: string }): Json[] {
  if (!/text\/event-stream/i.test(response.contentType)) {
    const body = parse(response.body);
    return body ? [body] : [];
  }
  return response.body.split(/\r?\n\r?\n/).flatMap((block) => {
    if (!/tool_use|tool_calls|function_call/.test(block)) return [];
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /, ""))
      .join("\n");
    const ev = parse(data);
    return ev ? [ev] : [];
  });
}

/** The tools a reply asked to run, in order, one entry per call — the
    tool-use blocks (Messages), the indexed `tool_calls` deltas (chat), or the
    `function_call` output items (Responses), whole body or streamed. */
export function calledOf(dialect: Dialect, events: Json[]): string[] {
  const out: string[] = [];
  if (dialect === "anthropic-messages") {
    for (const ev of events) {
      const block = isObject(ev.content_block) ? ev.content_block : null;
      if (block?.type === "tool_use" && str(block.name)) out.push(str(block.name)!);
      if (ev.type === "message" && Array.isArray(ev.content))
        for (const b of ev.content) if (isObject(b) && b.type === "tool_use" && str(b.name)) out.push(str(b.name)!);
    }
  } else if (dialect === "openai-chat") {
    /* Streamed, a call's name comes once on the delta that opens its index. */
    const byIndex = new Map<number, string>();
    for (const ev of events) {
      for (const choice of Array.isArray(ev.choices) ? ev.choices : []) {
        if (!isObject(choice)) continue;
        const holder = isObject(choice.message) ? choice.message : isObject(choice.delta) ? choice.delta : null;
        for (const [i, call] of (Array.isArray(holder?.tool_calls) ? holder!.tool_calls : []).entries()) {
          if (!isObject(call)) continue;
          const name = str(isObject(call.function) ? call.function.name : undefined);
          const index = num(call.index) ?? (isObject(choice.message) ? i : byIndex.size);
          if (name && !byIndex.has(index)) byIndex.set(index, name);
        }
      }
    }
    out.push(...[...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, name]) => name));
  } else {
    const seen = new Set<string>();
    const add = (item: unknown) => {
      if (!isObject(item) || (item.type !== "function_call" && item.type !== "custom_tool_call")) return;
      const id = str(item.call_id) ?? str(item.id) ?? String(seen.size);
      if (seen.has(id) || !str(item.name)) return;
      seen.add(id);
      out.push(str(item.name)!);
    };
    for (const ev of events) {
      if (ev.type === "response.output_item.done" || ev.type === "response.output_item.added") add(ev.item);
      const response = isObject(ev.response) ? ev.response : ev.object === "response" ? ev : null;
      for (const item of Array.isArray(response?.output) ? response!.output : []) add(item);
    }
  }
  return out;
}

/* ── the door ── */

const threads = new Map<string, { thread: CallThread; dialect: Dialect }>();

const tap: GatewayTap = {
  wants: (sessionId) => threads.has(sessionId),
  ended(sessionId, requestBody, response, timing) {
    const entry = threads.get(sessionId);
    if (!entry) return;
    const { shape, bill } = DIALECTS[entry.dialect];
    /* A reply with no bill is not a model call — a model listing, a token
       count, an error body. */
    const found = bill(eventsOf(response));
    if (!found) return;
    const request = parse(requestBody);
    const called = calledOf(entry.dialect, allEventsOf(response));
    /* ponytail: `who` is always "turn" — a Claude Code side job (the title, the
       permission classifier) is on the same URL and indistinguishable here;
       `output` is left to the billed counters — of the reply's content only
       the names of the tools it called are read. */
    void recordCall(entry.thread, {
      callId: randomUUID(),
      at: timing.at,
      ms: timing.ms,
      who: "turn",
      model: found.model ?? (request ? str(request.model) : undefined) ?? "",
      ...(found.finishReason ? { finishReason: found.finishReason } : {}),
      source: "proxy",
      billed: found.billed,
      timing: { ttftMs: timing.ttftMs, decodeMs: timing.ttftMs !== undefined ? timing.ms - timing.ttftMs : undefined },
      ...(called.length ? { called } : {}),
      ...(request ? { shape: shape(request) } : {}),
    }).catch((error: unknown) => {
      console.warn(`[model-calls] proxy record for ${sessionId.slice(0, 8)} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  },
};
setGatewayTap(tap);

/** Attaches only to a thread that is actually behind the shim (`viaGateway`):
    a Default or subscription profile has no gateway to tap. */
export const proxySource: CallSource = {
  kind: "proxy",
  async attach(thread, door) {
    if (door.kind !== "proxy" || !thread.viaGateway) return null;
    const entry = { thread, dialect: door.dialect };
    threads.set(thread.id, entry);
    return {
      stop() {
        if (threads.get(thread.id) === entry) threads.delete(thread.id);
      },
    };
  },
};
