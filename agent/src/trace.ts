/* ── One record per model call ──
 *
 * The provider bills a prompt as one number and never says how it divides:
 * the system prompt, the tool schemas, the conversation and the tool results
 * arrive folded into `prompt_tokens`. The split is measured here, locally, from
 * the request exactly as the SDK sent it — `onLanguageModelCallStart` carries
 * the instructions, the messages and the *prepared* tool JSON under a `callId`
 * the end event repeats — and **anchored** to the provider's figure: the total
 * is the truth, the local counts are its proportions (`anchor`).
 *
 * This is an estimate and is drawn as one. The runtime speaks OpenAI-compatible
 * to whatever gateway is configured, so the `o200k_base` ranks are only exactly
 * right when OpenAI's model is serving; another family tokenizes the same bytes
 * into another count, and the anchor is what keeps the parts summing to the
 * bill regardless. The record (`ModelCall`) is the harness's contract: the
 * same shape whichever door built it, this one being `source: "acp"`.
 */
import { createHash } from "node:crypto";
import { countTokens } from "gpt-tokenizer";
import {
  countMessageTokens,
  estimateTokensInFunctions,
  type ChatCompletionFunctionDefinition,
} from "gpt-tokenizer/functionCalling";
import type { LanguageModelCallEndEvent, LanguageModelCallStartEvent, ModelMessage, streamText } from "ai";
import type * as acp from "./acp.js";
import { generationOf, normalizeUsage, toAcpUsage } from "./metering.js";

/** One named piece of the static prefix: a system prompt section (or one of
    its `##` headings), or one tool's definition. Raw local counts — only their
    proportions mean anything. */
export interface PrefixItem {
  name: string;
  tokens: number;
}

/** One provider request, whoever observed it. Mirrors `ModelCall` in the
    server's `protocol.ts`; travels as `_daedalus/model_call`. */
export interface ModelCall {
  callId: string;
  /** Epoch ms sent. */
  at: number;
  /** Wall time to the parsed response, when the door saw both ends. */
  ms?: number;
  who: "turn" | "subagent" | "compaction" | "title";
  childId?: string;
  /** 1-based within the turn, per `who` (and per child). */
  step: number;
  model: string;
  finishReason?: string;
  /** Which door built it. */
  source: "acp" | "otlp" | "proxy" | "files" | "usage";
  /** Exact — the provider's counters, `acp.Usage` shaped (fresh input, cache read/write beside it). */
  billed: acp.Usage;
  /** Only when the runtime says it. */
  costUsd?: number;
  timing?: { ttftMs?: number; decodeMs?: number; decodeTokens?: number };
  /** ~ Where the prompt went. Present parts sum, with `unknown`, to fresh + cacheRead + cacheWrite.
      A part the door could not see is null and named in `missing`. */
  prompt?: PromptParts;
  /** "the system prompt", "tool schemas" — the door's own words. */
  missing?: string[];
  /** ~ What the output was; `reasoning` exact when reported. */
  output?: { text: number; reasoning: number; toolCalls: number };
  /** Which section / which tool definition is the big one. Sent when the prefix
      changes, never every step. */
  items?: PrefixItems;
  /** ~ Which tools' calls and results the conversation carried, biggest first. */
  toolUse?: ToolUse[];
  /** The tools this response asked to run, in order — one entry per call. */
  called?: string[];
}

/** ~ One tool's footprint in a request's conversation, anchored to the
    `assistant` (args) and `results` parts. Mirrors the server's `ToolUse`. */
export interface ToolUse {
  name: string;
  calls: number;
  args: number;
  results: number;
}

export interface PromptParts {
  system: number | null;
  tools: number | null;
  mcp: number | null;
  user: number | null;
  assistant: number | null;
  results: number | null;
  unknown: number;
}

export interface PrefixItems {
  system: PrefixItem[];
  tools: PrefixItem[];
  mcp: PrefixItem[];
}

/** The two callbacks every `streamText`/`generateText` site passes, composed
    by `turn.ts` out of the meter's record and a `Tracer`. */
export type CallHooks = Pick<Parameters<typeof streamText>[0], "onLanguageModelCallStart" | "onLanguageModelCallEnd">;

/**
 * Share `total` out over `counts`. Every part seen: each is its proportion of
 * the total, up or down, and they sum to it exactly. A part unseen (`null`):
 * the seen ones stand as counted — scaled down by one factor only if together
 * they overshoot the invoice — and what is left is `unknown`. Nothing counted
 * is all `unknown`, never one part's windfall. The one formula the server's
 * `prompt-parts.ts` repeats, because the agent cannot import it.
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
  const out: Record<string, number | null> = { ...counts };
  seen.forEach((k, i) => {
    const last = i === seen.length - 1 && !blind && counted > 0;
    const share = last ? left : Math.min(left, Math.round((counts[k] as number) * factor));
    out[k] = share;
    left -= share;
  });
  return { ...out, unknown: left } as Record<K, number | null> & { unknown: number };
}

/* A tool as the provider is sent it (`prepareTools`: `{type:"function", name,
   description?, inputSchema}`), on the library's function-calling footing. */
function functionOf(tool: Record<string, unknown>): ChatCompletionFunctionDefinition | null {
  if (tool.type !== "function") return null;
  return {
    name: String(tool.name),
    ...(typeof tool.description === "string" ? { description: tool.description } : {}),
    parameters: tool.inputSchema as ChatCompletionFunctionDefinition["parameters"],
  };
}

/* The tokens of a tool block as the provider has to read it on every step. A
   schema the library cannot walk (a third-party MCP one) is counted as its
   JSON rather than lost. */
function blockTokens(tools: readonly Record<string, unknown>[]): number {
  if (tools.length === 0) return 0;
  const fns = tools.map(functionOf);
  try {
    if (fns.every((fn) => fn !== null)) return estimateTokensInFunctions(fns, countTokens);
  } catch {
    /* a schema the library cannot walk: counted as JSON below */
  }
  return tools.reduce((n, tool) => n + countTokens(JSON.stringify(tool)), 0);
}

const isMcp = (tool: Record<string, unknown>) => String(tool.name).startsWith("mcp__");

export function instructionsText(instructions: LanguageModelCallStartEvent["instructions"]): string {
  if (!instructions) return "";
  if (typeof instructions === "string") return instructions;
  return (Array.isArray(instructions) ? instructions : [instructions]).map((m) => m.content).join("\n\n");
}

/* A section's `##` headings are its own rows: the core instructions are one
   block of a dozen topics, and "which topic is the long one" is the question. */
function systemItems(sections: { name: string; text: string }[]): PrefixItem[] {
  const items: PrefixItem[] = [];
  for (const { name, text } of sections) {
    for (const chunk of text.split(/\n(?=## )/)) {
      const heading = chunk.startsWith("## ") ? chunk.split("\n", 1)[0]!.slice(3).trim() : "";
      const tokens = countTokens(chunk);
      if (tokens > 0) items.push({ name: heading ? `${name} › ${heading}` : name, tokens });
    }
  }
  return items;
}

/** The static prefix of one request: the system prompt and the tool block,
    MCP tools (`mcp__` prefix) counted as their own share of the block so the
    block's framing is counted once and the two still sum to it. `sections`
    only names the system items; the text counted is the event's. */
export function countPrefix(
  instructions: LanguageModelCallStartEvent["instructions"],
  tools: readonly Record<string, unknown>[] | undefined,
  sections?: { name: string; text: string }[],
): { system: number; tools: number; mcp: number; items: PrefixItems } {
  const text = instructionsText(instructions);
  const all = tools ?? [];
  const mcpTools = all.filter(isMcp);
  const whole = blockTokens(all);
  const mcp = Math.min(whole, blockTokens(mcpTools));
  /* Each tool's own definition, counted alone, biggest first. */
  const items = (list: Record<string, unknown>[]) =>
    list.map((tool) => ({ name: String(tool.name), tokens: blockTokens([tool]) })).sort((x, y) => y.tokens - x.tokens);
  return {
    system: text ? countMessageTokens({ role: "system", content: text }, countTokens) : 0,
    tools: whole - mcp,
    mcp,
    items: {
      system: systemItems(sections ?? (text ? [{ name: "System prompt", text }] : [])),
      tools: items(all.filter((tool) => !isMcp(tool))),
      mcp: items(mcpTools),
    },
  };
}

/* The text of a message as a provider is sent it. Media is not counted: its
   cost is the provider's own formula, and an estimate of it would be a guess
   dressed as a count — it lands in the anchor's remainder instead. */
function resultText(output: unknown): string {
  const o = output as { type?: string; value?: unknown } | undefined;
  if (!o || typeof o !== "object") return String(output ?? "");
  if (o.type === "content" && Array.isArray(o.value))
    return o.value.map((part) => (part?.type === "text" ? part.text : "")).join("");
  return typeof o.value === "string" ? o.value : JSON.stringify(o.value ?? "");
}

function messageText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return (message.content as { type: string; [k: string]: unknown }[])
    .map((part) => {
      if (part.type === "text" || part.type === "reasoning") return String(part.text ?? "");
      if (part.type === "tool-call") return `${String(part.toolName)}${JSON.stringify(part.input ?? {})}`;
      if (part.type === "tool-result") return resultText(part.output);
      return "";
    })
    .join("");
}

/* A message's count never changes and the history is re-sent on every step,
   but the SDK rebuilds the message objects per call, so a `WeakMap` on them
   never hits: the cache is keyed on the content's hash and bounded, oldest
   out. ponytail: counting runs on the call's end, before the step's tools —
   one-off for a big loaded history (tens of ms per 100k); a worker if it shows. */
const CACHE_LIMIT = 4096;
const counted = new Map<string, number>();

function messageTokens(message: ModelMessage): number {
  const text = messageText(message);
  const key = createHash("sha1").update(message.role).update("\0").update(text).digest("base64");
  let tokens = counted.get(key);
  if (tokens === undefined) {
    tokens = countMessageTokens({ role: message.role, content: text }, countTokens);
    if (counted.size >= CACHE_LIMIT) counted.delete(counted.keys().next().value!);
    counted.set(key, tokens);
  }
  return tokens;
}

/** The conversation of one request, counted by who wrote it. A `tool` message
    is the tools' answers; an `assistant` one is the model's own text and calls. */
export function countMessages(messages: readonly ModelMessage[]): { user: number; assistant: number; results: number } {
  const total = { user: 0, assistant: 0, results: 0 };
  for (const message of messages) {
    const tokens = messageTokens(message);
    if (message.role === "user") total.user += tokens;
    else if (message.role === "assistant") total.assistant += tokens;
    else if (message.role === "tool") total.results += tokens;
  }
  return total;
}

const partTokens = (text: string): number => {
  const key = createHash("sha1").update("part\0").update(text).digest("base64");
  let tokens = counted.get(key);
  if (tokens === undefined) {
    tokens = countTokens(text);
    if (counted.size >= CACHE_LIMIT) counted.delete(counted.keys().next().value!);
    counted.set(key, tokens);
  }
  return tokens;
};

/** Raw counts per tool over a request's conversation: each call's name and
    input, each result's text, keyed on the tool the part names. */
export function countToolUse(messages: readonly ModelMessage[]): ToolUse[] {
  const byTool = new Map<string, ToolUse>();
  const use = (name: string) => {
    let entry = byTool.get(name);
    if (!entry) byTool.set(name, (entry = { name, calls: 0, args: 0, results: 0 }));
    return entry;
  };
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content as { type: string; toolName?: string; input?: unknown; output?: unknown }[]) {
      if (!part.toolName) continue;
      if (part.type === "tool-call") {
        const entry = use(part.toolName);
        entry.calls += 1;
        entry.args += partTokens(`${part.toolName}${JSON.stringify(part.input ?? {})}`);
      } else if (part.type === "tool-result") use(part.toolName).results += partTokens(resultText(part.output));
    }
  }
  return [...byTool.values()];
}

/** Each tool's raw counts scaled by the factor its part was anchored with, so a
    tool's figures are a share of the billed `assistant`/`results`, biggest
    first. The formula the server's `prompt-parts.ts` repeats. */
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

/** What the output was made of. Reasoning is the provider's own figure when it
    reports one (a model that thinks unstreamed still bills it); text and tool
    calls are counted locally and anchored to what is left of the output. */
export function splitOutput(call: Pick<LanguageModelCallEndEvent, "content" | "usage">): ModelCall["output"] {
  let text = 0;
  let toolCalls = 0;
  let reasoningText = 0;
  for (const part of call.content) {
    if (part.type === "text") text += countTokens(part.text);
    else if (part.type === "reasoning") reasoningText += countTokens(part.text);
    else if (part.type === "tool-call") toolCalls += countTokens(`${part.toolName}${JSON.stringify(part.input ?? {})}`);
  }
  const reasoning = call.usage.outputTokenDetails?.reasoningTokens ?? reasoningText;
  const output = call.usage.outputTokens;
  if (output === undefined) return { text, reasoning, toolCalls };
  const rest = anchor(output - reasoning, { text, toolCalls });
  return { text: rest.text ?? 0, reasoning, toolCalls: rest.toolCalls ?? 0 };
}

/** One per turn. `start` parks the request by `callId`; `end` joins it to the
    response, counts, anchors and hands back the record — step numbers and the
    "prefix already said" memory are kept per `who` (and child), so a retried
    attempt keeps counting and a second compaction is step 2. */
export class Tracer {
  private pending = new Map<string, { at: number; event: LanguageModelCallStartEvent }>();
  private steps = new Map<string, number>();
  private said = new Map<string, string>();

  start = (event: LanguageModelCallStartEvent): void => {
    this.pending.set(event.callId, { at: Date.now(), event });
  };

  end(
    event: LanguageModelCallEndEvent,
    who: ModelCall["who"],
    opts: { childId?: string; sections?: { name: string; text: string }[] } = {},
  ): ModelCall {
    const started = this.pending.get(event.callId);
    this.pending.delete(event.callId);
    const key = `${who}:${opts.childId ?? ""}`;
    const step = (this.steps.get(key) ?? 0) + 1;
    this.steps.set(key, step);
    const billed = toAcpUsage(normalizeUsage(event.usage))!;
    const perf = event.performance;
    const generation = generationOf(event);
    const decodeMs = generation?.decodeMs;
    const call: ModelCall = {
      /* The SDK mints one `callId` per `streamText` and repeats it on every
         step's start and end, so it names an attempt, not a request; the
         step makes it one per request (steps of one attempt are sequential,
         so the parked start above is still this step's). */
      callId: `${event.callId}:${step}`,
      at: started?.at ?? Date.now() - Math.round(perf.responseTimeMs),
      ms: Math.round(perf.responseTimeMs),
      who,
      ...(opts.childId ? { childId: opts.childId } : {}),
      step,
      model: event.modelId,
      finishReason: event.finishReason,
      source: "acp",
      billed,
      ...(perf.timeToFirstOutputMs !== undefined || decodeMs !== undefined
        ? {
            timing: {
              ...(perf.timeToFirstOutputMs !== undefined ? { ttftMs: Math.round(perf.timeToFirstOutputMs) } : {}),
              ...(decodeMs !== undefined ? { decodeMs } : {}),
              ...(generation && generation.outputTokens !== billed.outputTokens ? { decodeTokens: generation.outputTokens } : {}),
            },
          }
        : {}),
      output: splitOutput(event),
    };
    const called = event.content.flatMap((part) => (part.type === "tool-call" ? [part.toolName] : []));
    if (called.length) call.called = called;
    /* An end with no start seen is a bill with no request to divide — the
       SDK pairs them, so this is a guard, not a path. */
    if (!started) return { ...call, missing: ["the request as sent"] };
    const { instructions, tools, messages } = started.event;
    const prefix = countPrefix(instructions, tools, opts.sections);
    const total = billed.inputTokens + (billed.cachedReadTokens ?? 0) + (billed.cachedWriteTokens ?? 0);
    const history = countMessages(messages);
    call.prompt = anchor(total, { system: prefix.system, tools: prefix.tools, mcp: prefix.mcp, ...history });
    const toolUse = anchorToolUse(countToolUse(messages), call.prompt, history);
    if (toolUse.length) call.toolUse = toolUse;
    /* What the prefix is made of rides the first call and any call after it
       changed (a search loaded tools, a steer rewrote nothing — the text is the
       key): byte-identical between steps, and a turn is the smallest window a
       reader ever loads, so every loaded turn holds one. */
    const shape = createHash("sha1")
      .update(instructionsText(instructions))
      .update("\0")
      .update((tools ?? []).map((tool) => String(tool.name)).join(","))
      .digest("base64");
    if (this.said.get(key) !== shape) {
      this.said.set(key, shape);
      call.items = prefix.items;
    }
    return call;
  }
}
