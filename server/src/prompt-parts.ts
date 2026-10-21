/* ── What a request's prompt held, from the request itself ──
 *
 * A provider reports `prompt_tokens` as one number. When a runtime hands us the
 * request it sent — Claude Code's raw API body (OTLP, `otlp.ts`) or the AI SDK's
 * GenAI span attributes (our own agent, `tracing.ts` `ingest`) — the parts are
 * counted here and scaled to the real total, so they always add up to what the
 * provider billed. Proportions are the claim: the counts are gpt-tokenizer's, a
 * different family tokenizes the same bytes differently, and images, thinking
 * blocks and framing are spread over every part rather than parked in one bucket.
 *
 * **Never on the event loop for long.** The shim used to do this on every request
 * and froze every thread's socket for 43–156 ms a time. Each piece is counted
 * separately and the loop is given back every few milliseconds (`tick`), and a
 * text seen before — the system prompt, the tool list, every earlier message —
 * is remembered by its hash, so a step pays for what is new.
 *
 * The result has the shape `lib/token-breakdown.ts` already reads
 * (`_meta.daedalus.breakdown`), so one reader draws it wherever it is found.
 */
import { createHash } from "node:crypto";
import { countTokens } from "gpt-tokenizer";

/** The span attribute a request's parts are written to, as JSON. Not
    `daedalus.prompt`, which is the person's own words on a turn's span. */
export const PROMPT_PARTS_ATTR = "daedalus.prompt_parts";

export interface PromptItem {
  name: string;
  tokens: number;
}

export interface PromptPartsBreakdown {
  source: "otlp" | "agent";
  total: number;
  system: number;
  tools: number;
  mcp: number;
  conversation: number;
  user: number;
  assistant: number;
  results: number;
  /** Only rounding: the request itself is the whole prompt. */
  overhead: number;
  items: { system: PromptItem[]; tools: PromptItem[]; mcp: PromptItem[] };
}

/** A request, reduced to what is counted. `system` and `tools` are named. */
export interface RequestShape {
  system: { name: string; text: string }[];
  tools: { name: string; text: string }[];
  messages: { role: "user" | "assistant" | "results"; text: string }[];
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/* ── counting without holding the loop ── */

let sliceStart = 0;
async function tick(): Promise<void> {
  if (performance.now() - sliceStart > 4) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    sliceStart = performance.now();
  }
}

const known = new Map<string, number>();
const hashOf = (text: string) => createHash("sha1").update(text).digest("base64");

async function count(text: string): Promise<number> {
  if (!text) return 0;
  const small = text.length < 256;
  const key = small ? "" : hashOf(text);
  if (!small) {
    const hit = known.get(key);
    if (hit !== undefined) return hit;
  }
  await tick();
  const n = countTokens(text);
  if (!small) {
    if (known.size > 4_000) known.clear();
    known.set(key, n);
  }
  return n;
}

/* ── naming ── */

/** The first line that says something, as a short name. */
function label(text: string, fallback: string): string {
  const line = text
    .replace(/<\/?[a-z-]+>/gi, "")
    .split("\n")
    .map((l) => l.replace(/^[#>\-*\s]+/, "").trim())
    .find(Boolean);
  if (!line) return fallback;
  return line.length > 48 ? `${line.slice(0, 48)}…` : line;
}

const isMcp = (name: string) => /(^|[._])mcp__|^mcp__/.test(name.toLowerCase());

/* ── a Messages / Chat / Responses request body ── */

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const item = record(part);
      if (!item) return "";
      if (typeof item.text === "string") return item.text;
      if (item.type === "tool_use") return `${str(item.name)} ${JSON.stringify(item.input ?? {})}`;
      if (item.type === "function_call") return `${str(item.name)} ${JSON.stringify(item.arguments ?? {})}`;
      if (item.type === "function_call_output") return textOf(item.output);
      if (item.type === "tool_result") return textOf(item.content ?? item.output);
      if (item.type === "thinking") return str(item.thinking);
      return "";
    })
    .join(" ");
}

const REMINDER = /^\s*<system-reminder>/;

/**
 * An Anthropic Messages body (also OpenAI chat and Responses, enough of them to
 * be read): system, tools and messages by who wrote them. **A user message's
 * `<system-reminder>` blocks are the runtime's context, not the person's words**
 * — instructions, skills, MCP guidance and the date ride in them — so they are
 * counted as system, under "Injected context", and only the rest is "user".
 */
export function shapeFromBody(body: Json): RequestShape {
  const shape: RequestShape = { system: [], tools: [], messages: [] };
  const addSystem = (text: string, group: string) => {
    if (text) shape.system.push({ name: `${group} › ${label(text, "Section")}`, text });
  };
  if (typeof body.system === "string") addSystem(body.system, "System prompt");
  else for (const block of list(body.system)) addSystem(textOf([block]), "System prompt");
  if (typeof body.instructions === "string") addSystem(body.instructions, "System prompt");

  const addMessage = (role: string, content: unknown) => {
    if (role === "system" || role === "developer") return addSystem(textOf(content), "System prompt");
    const as = role === "user" ? "user" : role === "tool" || role === "function" ? "results" : "assistant";
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : list(content);
    for (const block of blocks) {
      const item = record(block);
      const text = textOf([block]);
      if (!text) continue;
      /* A tool's result rides a `user` message in the Anthropic shape. */
      const blockRole = item?.type === "tool_result" || item?.type === "function_call_output" ? "results" : as;
      if (blockRole === "user" && REMINDER.test(text)) addSystem(text, "Injected context");
      else shape.messages.push({ role: blockRole, text });
    }
  };
  for (const raw of list(body.messages)) {
    const message = record(raw);
    if (message) addMessage(str(message.role) || "assistant", message.content ?? message);
  }
  for (const raw of list(body.input)) {
    if (typeof raw === "string") {
      addMessage("user", raw);
      continue;
    }
    const item = record(raw);
    if (!item) continue;
    if (item.type === "message") addMessage(str(item.role) || "user", item.content);
    else if (item.type === "function_call") addMessage("assistant", [item]);
    else if (item.type === "function_call_output") addMessage("tool", [item]);
  }
  for (const raw of list(body.tools)) {
    const tool = record(raw);
    if (!tool) continue;
    const fn = tool.type === "function" ? record(tool.function) : null;
    const name = str(fn?.name ?? tool.name ?? tool.type) || "Tool";
    shape.tools.push({ name, text: JSON.stringify(fn ?? tool) });
  }
  return shape;
}

/* ── the AI SDK's GenAI span attributes ── */

const parsed = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

/**
 * `gen_ai.system_instructions`, `gen_ai.tool.definitions` and
 * `gen_ai.input.messages`, which `@ai-sdk/otel` puts on every `chat` span as JSON
 * strings. Null when none of them is there (a harness-derived span).
 */
export function shapeFromGenAi(attributes: Record<string, unknown>): RequestShape | null {
  const system = parsed(attributes["gen_ai.system_instructions"]);
  const tools = parsed(attributes["gen_ai.tool.definitions"]);
  const messages = parsed(attributes["gen_ai.input.messages"]);
  if (system === undefined && tools === undefined && messages === undefined) return null;
  const shape: RequestShape = { system: [], tools: [], messages: [] };
  for (const part of list(system)) {
    const text = str(record(part)?.content ?? record(part)?.text);
    if (text) shape.system.push({ name: `System prompt › ${label(text, "Section")}`, text });
  }
  for (const raw of list(tools)) {
    const tool = record(raw);
    if (tool) shape.tools.push({ name: str(tool.name) || "Tool", text: JSON.stringify(tool) });
  }
  for (const raw of list(messages)) {
    const message = record(raw);
    if (!message) continue;
    const role = str(message.role);
    for (const p of list(message.parts)) {
      const part = record(p);
      if (!part) continue;
      const type = str(part.type);
      const text =
        type === "tool_call"
          ? `${str(part.name)} ${typeof part.arguments === "string" ? part.arguments : JSON.stringify(part.arguments ?? {})}`
          : type === "tool_call_response"
            ? typeof part.response === "string" ? part.response : JSON.stringify(part.response ?? "")
            : str(part.content);
      if (!text) continue;
      if (role === "system" || role === "developer") {
        shape.system.push({ name: `System prompt › ${label(text, "Section")}`, text });
        continue;
      }
      shape.messages.push({
        role: type === "tool_call_response" || role === "tool" ? "results" : role === "user" ? "user" : "assistant",
        text,
      });
    }
  }
  return shape;
}

/* ── dividing ── */

/** A request's pieces, counted but not yet scaled — small enough to keep until
    the provider's total arrives (it comes on another export). */
export interface RawCounts {
  systemItems: PromptItem[];
  toolItems: PromptItem[];
  history: { user: number; assistant: number; results: number };
}

export async function countRequest(shape: RequestShape): Promise<RawCounts> {
  const systemItems: PromptItem[] = [];
  for (const s of shape.system) systemItems.push({ name: s.name, tokens: await count(s.text) });
  const toolItems: PromptItem[] = [];
  for (const t of shape.tools) toolItems.push({ name: t.name, tokens: await count(t.text) });
  const history = { user: 0, assistant: 0, results: 0 };
  for (const m of shape.messages) history[m.role] += await count(m.text);
  return { systemItems, toolItems, history };
}

/** Scale counted pieces to `total`, the prompt the provider billed; `source`
    says who handed us the request. Null when there is nothing to divide. */
export function scaleParts(raw: RawCounts, total: number, source: PromptPartsBreakdown["source"]): PromptPartsBreakdown | null {
  if (!(total > 0)) return null;
  const mcpItems = raw.toolItems.filter((t) => isMcp(t.name));
  const builtins = raw.toolItems.filter((t) => !isMcp(t.name));
  const sum = (items: PromptItem[]) => items.reduce((n, i) => n + i.tokens, 0);
  const rawSystem = sum(raw.systemItems);
  const rawTools = sum(builtins);
  const rawMcp = sum(mcpItems);
  const rawHistory = raw.history.user + raw.history.assistant + raw.history.results;
  const estimated = rawSystem + rawTools + rawMcp + rawHistory;
  if (estimated === 0) return null;
  const scale = total / estimated;
  const system = Math.round(rawSystem * scale);
  const mcp = Math.min(total - system, Math.round(rawMcp * scale));
  const tools = Math.min(total - system - mcp, Math.round(rawTools * scale));
  const conversation = Math.min(Math.max(0, total - system - tools - mcp), Math.round(rawHistory * scale));
  const user = rawHistory ? Math.round((conversation * raw.history.user) / rawHistory) : 0;
  const assistant = rawHistory ? Math.min(conversation - user, Math.round((conversation * raw.history.assistant) / rawHistory)) : 0;
  const results = conversation - user - assistant;
  const scaled = (items: PromptItem[]) => items.map((i) => ({ ...i, tokens: Math.round(i.tokens * scale) }));
  return {
    source,
    total,
    system,
    tools,
    mcp,
    conversation,
    user,
    assistant,
    results,
    overhead: Math.max(0, total - system - tools - mcp - conversation),
    items: { system: scaled(raw.systemItems), tools: scaled(builtins), mcp: scaled(mcpItems) },
  };
}

/** Both halves, for a caller that already has the total. */
export async function partsOf(shape: RequestShape, total: number, source: PromptPartsBreakdown["source"]): Promise<PromptPartsBreakdown | null> {
  if (!(total > 0)) return null;
  return scaleParts(await countRequest(shape), total, source);
}
