/* ── One counting path for every server-built record ──
 *
 * A provider bills a prompt as one number. A door that saw the request — the
 * gateway shim, Claude Code's OTLP body, a runtime's own session file — reduces
 * it to a `RequestShape` here (system sections and tools *named*, messages by
 * who wrote them), the shape is counted, and the counts are **anchored** to
 * the billed total (`anchor`, the formula the agent's `trace.ts` repeats). The
 * counts are gpt-tokenizer's: proportions, not a second invoice.
 *
 * Never on a request's path. The shim used to count inside the forward and
 * froze every socket 43–156 ms a request; counting here yields the loop every
 * few milliseconds (`tick`) and remembers every text it has seen by hash, so a
 * step pays for what is new. A part a door cannot see is `unseen` — it lands as
 * null in the record and its share in `unknown` — and `missing` says why in the
 * door's own words. Six adapters, one shape, one counter.
 */
import { createHash } from "node:crypto";
import { countTokens } from "gpt-tokenizer";
import type { PrefixItem, PrefixItems, PromptParts, ToolUse } from "../protocol.js";

export type PromptPart = keyof Omit<PromptParts, "unknown">;

/** A request, reduced to what is counted. */
export interface RequestShape {
  system: { name: string; text: string }[];
  tools: { name: string; text: string }[];
  /** `tool` names the tool an assistant's call went to, or whose answer a
      result is — what `toolUse` is summed by. */
  messages: { role: "user" | "assistant" | "results"; text: string; tool?: string }[];
  /** Parts this door could not see — null in the record, never zero. */
  unseen?: PromptPart[];
  /** The same, in words: "the system prompt", "tool schemas". */
  missing?: string[];
}

/** A shape counted, before the anchor: items named, the history by role. */
export interface ShapeCounts {
  items: PrefixItems;
  user: number;
  assistant: number;
  results: number;
  /** Raw counts per tool, before the anchor. */
  toolUse: ToolUse[];
  unseen: PromptPart[];
  missing: string[];
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
  const key = text.length < 256 ? "" : hashOf(text);
  if (key) {
    const hit = known.get(key);
    if (hit !== undefined) return hit;
  }
  await tick();
  const n = countTokens(text);
  if (key) {
    if (known.size > 4_000) known.clear();
    known.set(key, n);
  }
  return n;
}

const isMcp = (name: string) => /(^|[._])mcp__/.test(name.toLowerCase());

/** Count a shape. MCP tools (`mcp__` prefix) are their own share of the tool block. */
export async function countShape(shape: RequestShape): Promise<ShapeCounts> {
  const items: PrefixItems = { system: [], tools: [], mcp: [] };
  for (const s of shape.system) items.system.push({ name: s.name, tokens: await count(s.text) });
  for (const t of shape.tools) (isMcp(t.name) ? items.mcp : items.tools).push({ name: t.name, tokens: await count(t.text) });
  const history = { user: 0, assistant: 0, results: 0 };
  const byTool = new Map<string, ToolUse>();
  for (const m of shape.messages) {
    const n = await count(m.text);
    history[m.role] += n;
    if (!m.tool || m.role === "user") continue;
    const use = byTool.get(m.tool) ?? { name: m.tool, calls: 0, args: 0, results: 0 };
    if (m.role === "assistant") {
      use.calls += 1;
      use.args += n;
    } else use.results += n;
    byTool.set(m.tool, use);
  }
  return { items, ...history, toolUse: [...byTool.values()], unseen: shape.unseen ?? [], missing: shape.missing ?? [] };
}

/**
 * Share `total` out over `counts`. Every part seen: each is its proportion of
 * the total, up or down, and they sum to it exactly. A part unseen (`null`):
 * the seen ones stand as counted — scaled down by one factor only if together
 * they overshoot the invoice — and what is left is `unknown`. Nothing counted
 * is all `unknown`, never one part's windfall. Verbatim from `agent/src/trace.ts`.
 */
export function anchor<K extends string>(
  total: number,
  counts: Record<K, number | null>,
): Record<K, number | null> & { unknown: number } {
  const keys = Object.keys(counts) as K[];
  const seen = keys.filter((k) => counts[k] !== null);
  const counted = seen.reduce((n, k) => n + (counts[k] as number), 0);
  const blind = seen.length < keys.length;
  let left = Math.max(0, Math.round(total));
  const factor = counted === 0 ? 0 : !blind || counted > left ? left / counted : 1;
  const out = { ...counts, unknown: 0 } as Record<K, number | null> & { unknown: number };
  seen.forEach((k, i) => {
    const last = i === seen.length - 1 && !blind && counted > 0;
    const share = last ? left : Math.min(left, Math.round((counts[k] as number) * factor));
    (out as Record<K, number | null>)[k] = share;
    left -= share;
  });
  out.unknown = left;
  return out;
}

const sum = (items: PrefixItem[]) => items.reduce((n, i) => n + i.tokens, 0);

/** The counts anchored to the billed prompt: the record's `prompt`, `missing`
    and `items`. An unseen part is null before the anchor, so its share is `unknown`. */
export function partsOf(
  total: number,
  counts: ShapeCounts,
): { prompt: PromptParts; missing?: string[]; items: PrefixItems; toolUse?: ToolUse[] } {
  const unseen = new Set(counts.unseen);
  const seen = (part: PromptPart, n: number) => (unseen.has(part) ? null : n);
  const prompt = anchor(total, {
    system: seen("system", sum(counts.items.system)),
    tools: seen("tools", sum(counts.items.tools)),
    mcp: seen("mcp", sum(counts.items.mcp)),
    user: seen("user", counts.user),
    assistant: seen("assistant", counts.assistant),
    results: seen("results", counts.results),
  });
  const toolUse = anchorToolUse(counts.toolUse, prompt, counts);
  return {
    prompt,
    ...(counts.missing.length ? { missing: counts.missing } : {}),
    items: counts.items,
    ...(toolUse.length ? { toolUse } : {}),
  };
}

/** Each tool's raw counts scaled by the factor its part was anchored with, so
    a tool's figures are a share of the billed `assistant`/`results`, never more
    than the part, and biggest first. Verbatim from `agent/src/trace.ts`. */
export function anchorToolUse(
  raw: readonly ToolUse[],
  prompt: Pick<PromptParts, "assistant" | "results">,
  counted: { assistant: number; results: number },
): ToolUse[] {
  const scale = (part: number | null, n: number) => (part === null || n <= 0 ? 0 : part / n);
  const a = scale(prompt.assistant, counted.assistant);
  const r = scale(prompt.results, counted.results);
  return raw
    .map((t) => ({ name: t.name, calls: t.calls, args: Math.round(t.args * a), results: Math.round(t.results * r) }))
    .sort((x, y) => y.args + y.results - (x.args + x.results));
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

const empty = (): RequestShape => ({ system: [], tools: [], messages: [] });

/* ── the three request bodies ── */

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const item = record(part);
      if (!item) return "";
      if (typeof item.text === "string") return item.text;
      if (item.type === "tool_use") return `${str(item.name)} ${JSON.stringify(item.input ?? {})}`;
      if (item.type === "function_call") return `${str(item.name)} ${str(item.arguments) || JSON.stringify(item.arguments ?? {})}`;
      if (item.type === "function_call_output") return textOf(item.output) || str(item.output);
      if (item.type === "tool_result") return textOf(item.content ?? item.output) || str(item.content);
      if (item.type === "thinking") return str(item.thinking);
      return "";
    })
    .join(" ");
}

const REMINDER = /^\s*<system-reminder>/;

/* Shared by the three bodies: they differ only in where the system prompt and
   the conversation sit. **A user message's `<system-reminder>` blocks are the
   runtime's context, not the person's words** — instructions, skills, MCP
   guidance and the date ride in them — so they count as system, under
   "Injected context". A tool's result rides a `user` message in the Anthropic
   shape and a `tool` message in OpenAI's; both are `results`. */
function fromBody(body: Json): RequestShape {
  const shape = empty();
  /* A result names its call by id, never the tool: the call before it is where
     the name is. */
  const called = new Map<string, string>();
  const callOf = (id: unknown, name: string) => {
    if (typeof id === "string" && id && name) called.set(id, name);
    return name || undefined;
  };
  const addSystem = (text: string, group: string) => {
    if (text) shape.system.push({ name: `${group} › ${label(text, "Section")}`, text });
  };
  /* An OpenAI chat `tool` message names its call beside the content. */
  let toolOfResult: string | undefined;
  const addMessage = (role: string, content: unknown) => {
    if (role === "system" || role === "developer") return addSystem(textOf(content), "System prompt");
    const as = role === "user" ? "user" : role === "tool" || role === "function" ? "results" : "assistant";
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : list(content);
    for (const block of blocks) {
      const item = record(block);
      const text = textOf([block]);
      if (!text) continue;
      const blockRole = item?.type === "tool_result" || item?.type === "function_call_output" ? "results" : as;
      const tool =
        item?.type === "tool_use" || item?.type === "function_call"
          ? callOf(item.call_id ?? item.id, str(item.name))
          : item?.type === "tool_result"
            ? called.get(str(item.tool_use_id))
            : item?.type === "function_call_output"
              ? called.get(str(item.call_id))
              : as === "results"
                ? toolOfResult
                : undefined;
      if (blockRole === "user" && REMINDER.test(text)) addSystem(text, "Injected context");
      else shape.messages.push({ role: blockRole, text, ...(tool ? { tool } : {}) });
    }
  };
  if (typeof body.system === "string") addSystem(body.system, "System prompt");
  else for (const block of list(body.system)) addSystem(textOf([block]), "System prompt");
  if (typeof body.instructions === "string") addSystem(body.instructions, "System prompt");
  for (const raw of list(body.messages)) {
    const message = record(raw);
    if (!message) continue;
    const role = str(message.role) || "assistant";
    toolOfResult = role === "tool" || role === "function" ? called.get(str(message.tool_call_id)) || str(message.name) || undefined : undefined;
    addMessage(role, message.content);
    /* OpenAI chat: an assistant's calls are beside `content`, not in it. */
    for (const raw of list(message.tool_calls)) {
      const call = record(raw);
      const fn = record(call?.function);
      if (!fn) continue;
      const tool = callOf(call?.id, str(fn.name));
      shape.messages.push({ role: "assistant", text: `${str(fn.name)} ${str(fn.arguments)}`, ...(tool ? { tool } : {}) });
    }
  }
  toolOfResult = undefined;
  for (const raw of list(body.input)) {
    if (typeof raw === "string") {
      addMessage("user", raw);
      continue;
    }
    const item = record(raw);
    if (!item) continue;
    if (item.type === "message" || (!item.type && item.role)) addMessage(str(item.role) || "user", item.content);
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

/** An Anthropic Messages request: `system` (string or blocks), `messages`, `tools`. */
export const fromAnthropicMessages = (body: Json): RequestShape => fromBody(body);

/** An OpenAI chat-completions request: `messages` (system/developer rows inside),
    `tools[].function`, `tool_calls` beside an assistant's content. */
export const fromOpenAiChat = (body: Json): RequestShape => fromBody(body);

/** An OpenAI Responses request: `instructions`, `input` items, flat `tools`. */
export const fromOpenAiResponses = (body: Json): RequestShape => fromBody(body);

/* ── the three session stores ── */

/**
 * Claude Code's `prompt_snapshot` attachment (its session JSONL): the system
 * prompt by section, the CLI's identity prefix and — on a version that writes
 * them — the tool schemas. The conversation is not in it; a reader has the
 * per-message `usage` beside it, never the messages as sent.
 */
export function fromClaudeSnapshot(snapshot: Json): RequestShape {
  const shape = empty();
  const identity = str(snapshot.cliPrefix);
  if (identity) shape.system.push({ name: "System prompt › Identity", text: identity });
  list(snapshot.systemPrompt)
    .map(str)
    .filter((s) => s && s !== "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__")
    .forEach((s, i) => shape.system.push({ name: `System prompt › ${label(s, `Section ${i + 1}`)}`, text: s }));
  const tools = Array.isArray(snapshot.tools) ? list(snapshot.tools).map(record).filter((t): t is Json => !!t) : null;
  for (const tool of tools ?? []) shape.tools.push({ name: str(tool.name) || "Tool", text: JSON.stringify(tool) });
  shape.unseen = ["user", "assistant", "results", ...(tools ? [] : (["tools", "mcp"] as PromptPart[]))];
  shape.missing = ["the conversation", ...(tools ? [] : ["tool schemas"])];
  return shape;
}

/** A `user` message Codex writes that is context, not something a person said. */
const CODEX_CONTEXT = ["<environment_context>", "<user_instructions>", "# AGENTS.md", "<INSTRUCTIONS>"];

/**
 * A Codex rollout's lines, parsed: `session_meta` carries the base
 * instructions; `response_item`s carry the developer messages, the
 * environment/AGENTS.md context and the conversation. No tool schemas anywhere.
 */
export function fromCodexRollout(lines: Json[]): RequestShape {
  const shape = empty();
  let base = "";
  let n = 0;
  const called = new Map<string, string>();
  for (const line of lines) {
    const p = record(line.payload);
    if (!p) continue;
    if (line.type === "session_meta") {
      base = str(p.base_instructions) || str(record(p.base_instructions)?.text);
      continue;
    }
    if (line.type !== "response_item") continue;
    if (p.type === "function_call" || p.type === "custom_tool_call") {
      const name = str(p.name);
      if (name && str(p.call_id)) called.set(str(p.call_id), name);
      shape.messages.push({ role: "assistant", text: `${name} ${str(p.arguments) || str(p.input)}`, ...(name ? { tool: name } : {}) });
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const tool = called.get(str(p.call_id));
      shape.messages.push({ role: "results", text: textOf(p.output) || str(p.output), ...(tool ? { tool } : {}) });
    }
    else if (p.type === "message") {
      const text = list(p.content).map((c) => str(record(c)?.text)).join("");
      if (!text) continue;
      const role = str(p.role);
      if (role === "developer") shape.system.push({ name: `Developer instructions › ${label(text, `Message ${++n}`)}`, text });
      else if (role === "user" && CODEX_CONTEXT.some((m) => text.trimStart().startsWith(m)))
        shape.system.push({ name: `Context › ${label(text, `Message ${++n}`)}`, text });
      else shape.messages.push({ role: role === "assistant" ? "assistant" : "user", text });
    }
  }
  if (base) shape.system.unshift({ name: "System prompt › Base instructions", text: base });
  shape.unseen = ["tools", "mcp", ...(base ? [] : (["system"] as PromptPart[]))];
  shape.missing = [...(base ? [] : ["the system prompt"]), "tool schemas"];
  return shape;
}

/**
 * OpenCode's `instruction_state.current_values` row — `{key: blobHash}` — with
 * its blobs resolved by the caller: the context it injects (environment, date,
 * MCP guidance, skill guidance, the tool listing). Neither its own system
 * prompt nor tool schemas nor the conversation are there.
 */
export function fromOpencodeInstructions(current: Record<string, string>, blob: (hash: string) => string | undefined): RequestShape {
  const shape = empty();
  const blobText = (hash: string): string => {
    const raw = blob(hash) ?? "";
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "string" ? parsed : raw;
    } catch {
      return raw;
    }
  };
  for (const [key, hash] of Object.entries(current)) {
    const text = blobText(hash);
    if (!text) continue;
    if (key === "core/mcp-guidance") {
      try {
        const servers = list(JSON.parse(text)).map(record).filter((s): s is Json => !!s);
        for (const s of servers) shape.tools.push({ name: `mcp__${str(s.server) || "server"} instructions`, text: str(s.instructions) });
        if (servers.length) continue;
      } catch {
        /* not the shape we know: counted whole below */
      }
      shape.tools.push({ name: "mcp__guidance", text });
    } else if (key === "core/codemode") shape.tools.push({ name: "Tool listing", text });
    else if (key === "core/skill-guidance") shape.system.push({ name: "Skills › listing", text });
    else if (key === "core/environment") shape.system.push({ name: "Environment", text });
    else if (key === "core/date") shape.system.push({ name: "Date", text });
    else shape.system.push({ name: `Instructions › ${key.replace(/^core\//, "")}`, text });
  }
  shape.unseen = ["user", "assistant", "results"];
  shape.missing = ["its own system prompt", "tool schemas", "the conversation"];
  return shape;
}
