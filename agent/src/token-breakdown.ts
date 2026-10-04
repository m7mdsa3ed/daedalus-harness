/* ── Where a request's prompt went ──
   A provider reports `prompt_tokens` as one number: the system prompt, the tool
   schemas, the conversation and the tool results arrive folded into it and
   nothing in the response says how the total divides. It is not recoverable
   from the payload — Anthropic's own `count_tokens` accepts the three parts
   structured and still answers one figure — so the split is measured here,
   locally, from the same parts that were sent.

   The method is **anchored, not simulated**. `prompt_tokens` is the truth the
   provider actually billed, so the conversation's share is what is *left* of it
   once the two static parts are subtracted. Only the static prefix is counted
   with a tokenizer, and that is the half worth estimating: it is built here,
   it is byte-identical between the steps of a turn, and the question a reader
   asks of it ("is my persona or my tool list eating the window?") is answered
   to the token by an approximation. Reconstructing the conversation the same
   way would compound two errors to answer a question the provider already
   answered exactly.

   The conversation's own division (what the user said, what the model wrote,
   what the tools answered) is the same bargain one level down: each is counted
   locally and the *provider's remainder* is shared out in their proportion, so
   the three always sum to what the provider left once the static parts were
   taken, and a tokenizer that runs a little long shrinks all three alike
   instead of landing its error on one.

   **This is an estimate and says so everywhere it is drawn.** We speak
   OpenAI-compatible to whatever gateway is configured, so the ranks are only
   exactly right when the serving model is OpenAI's; a different family tokenizes
   the same bytes into a different count. The `o200k_base` ranks are used
   regardless (see `gpt-tokenizer`), minus the provider's own framing — which is
   the same bargain `ContextWindow.known` makes for an unmeasured window. */
import { countTokens } from "gpt-tokenizer";
import {
  countMessageTokens,
  estimateTokensInFunctions,
  type ChatCompletionFunctionDefinition,
} from "gpt-tokenizer/functionCalling";
import type { ModelMessage, ToolSet } from "ai";
import { z } from "zod";

/** The two static parts of a request's prompt, counted once per turn. */
export interface PrefixTokens {
  /** The `system` string as the runtime built it, framing included. */
  system: number;
  /** The built-in tools' names, descriptions and parameter schemas, framing
      included. */
  tools: number;
  /** The same for the MCP servers' tools (`mcp__<server>__<tool>`), which a
      reader adds and removes — the part of the tool block that is theirs. */
  mcp: number;
  /** What each of the three is made of — raw local counts, so only their
      proportions mean anything; the client scales them to the part's figure. */
  items: PrefixItems;
}

/** One named piece of the static prefix: a system prompt section (or one of
    its `##` headings), or one tool's definition. */
export interface PrefixItem {
  name: string;
  tokens: number;
}

export interface PrefixItems {
  system: PrefixItem[];
  tools: PrefixItem[];
  mcp: PrefixItem[];
}

/** A request's prompt, divided. `total` and `conversation` are exact (they come
    from the provider); `system` and `tools` are the local estimate. */
export interface PromptBreakdown extends Omit<PrefixTokens, "items"> {
  /** The whole prompt, as the provider billed it. */
  total: number;
  /** Everything that is not the static prefix: `total` less the system prompt
      and the tool blocks, and always `user + assistant + results` unless the
      messages could not be counted at all (then it is the lone remainder). */
  conversation: number;
  /** The user's messages' share of `conversation`. */
  user: number;
  /** The model's own earlier replies and tool calls' share of it. */
  assistant: number;
  /** The tools' results' share of it. */
  results: number;
}

/** Locally counted tokens of the history, by who wrote it — proportions only,
    never a figure that is drawn. */
export interface HistoryTokens {
  user: number;
  assistant: number;
  results: number;
}

/* The JSON Schema behind a tool, whatever shape the tool was built in.
   Two shapes reach the tool set and they are not the same zod: a built-in is
   `tool({ inputSchema: z.object(…) })`, whose schema is a Zod object, while an
   MCP tool is `dynamicTool({ inputSchema: jsonSchema(…) })`, whose schema is
   already JSON. (`repair.ts` tells the two apart for the same reason — an
   inline zod is re-parsed, an MCP one is validated as-is.) */
function schemaOf(tool: ToolSet[string]): unknown | null {
  const schema = tool.inputSchema as unknown as { jsonSchema?: unknown };
  if (schema?.jsonSchema !== undefined) return schema.jsonSchema;
  try {
    return z.toJSONSchema(schema as never);
  } catch {
    /* A schema this zod cannot render is one tool's description lost, never
       the turn's — the count simply comes out a little low. */
    return null;
  }
}

/* A tool as the provider is sent it. A description the SDK computes per call is
   one whose text only exists at the call, which is not this walk — so the tool
   is counted without it and the figure comes out slightly low rather than
   invented. Every tool this runtime builds carries a static description; only a
   third-party one could differ. */
function functionOf(name: string, tool: ToolSet[string]): ChatCompletionFunctionDefinition | null {
  const parameters = schemaOf(tool);
  if (parameters === null) return null;
  const description = typeof tool.description === "string" ? tool.description : undefined;
  return {
    name,
    ...(description ? { description } : {}),
    parameters: parameters as ChatCompletionFunctionDefinition["parameters"],
  };
}

/** The tool block's own tokens: what a provider has to tokenize on *every*
    step of every turn, whether or not a call is made. */
export function prefixTools(tools: ToolSet): number {
  const functions = Object.entries(tools).flatMap(([name, tool]) => functionOf(name, tool) ?? []);
  return functions.length ? estimateTokensInFunctions(functions, countTokens) : 0;
}

/** Each tool's own definition, counted alone, biggest first. */
function toolItems(tools: [string, ToolSet[string]][]): PrefixItem[] {
  return tools
    .flatMap(([name, tool]) => {
      const fn = functionOf(name, tool);
      return fn ? [{ name, tokens: estimateTokensInFunctions([fn], countTokens) }] : [];
    })
    .sort((x, y) => y.tokens - x.tokens);
}

/* A section's `##` headings are its own rows: the core instructions are one
   block of a dozen topics, and "which topic is the long one" is the question. */
function systemItems(sections: { name: string; text: string }[]): PrefixItem[] {
  const items: PrefixItem[] = [];
  for (const { name, text } of sections) {
    for (const chunk of text.split(/\n(?=## )/)) {
      const heading = chunk.startsWith("## ") ? chunk.split("\n", 1)[0].slice(3).trim() : "";
      const tokens = countTokens(chunk);
      if (tokens > 0) items.push({ name: heading ? `${name} › ${heading}` : name, tokens });
    }
  }
  return items;
}

/** The system prompt's own tokens, on the same footing the library counts a
    chat message on (role and per-message framing included). */
export function prefixSystem(system: string): number {
  return system ? countMessageTokens({ role: "system", content: system }, countTokens) : 0;
}

/* The text of a tool call or result as a provider is sent it. Media is not
   counted: its cost is the provider's own formula, and an estimate of it would
   be a guess dressed as a count. */
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
      if (part.type === "text") return String(part.text ?? "");
      if (part.type === "tool-call") return `${String(part.toolName)}${JSON.stringify(part.input ?? {})}`;
      if (part.type === "tool-result") return resultText(part.output);
      return "";
    })
    .join("");
}

/* A message's tokens never change, and the same objects come back on every
   step of a turn, so each is counted once: the walk is then the new messages
   and not the whole history again per request. */
const counted = new WeakMap<object, number>();

/** The history of one request, counted by role. A `tool` message is the tools'
    answers; an `assistant` one is the model's own text and calls. */
export function historyTokens(messages: ModelMessage[]): HistoryTokens {
  const total: HistoryTokens = { user: 0, assistant: 0, results: 0 };
  for (const message of messages) {
    let tokens = counted.get(message);
    if (tokens === undefined) {
      tokens = countMessageTokens({ role: message.role, content: messageText(message) } as never, countTokens);
      counted.set(message, tokens);
    }
    if (message.role === "user") total.user += tokens;
    else if (message.role === "assistant") total.assistant += tokens;
    else if (message.role === "tool") total.results += tokens;
  }
  return total;
}

/** Both static parts of the prompt, in one walk — the shape `turn.ts` caches
    per turn, since neither the system prompt nor the tool set changes between
    the steps of one. The MCP share is counted on its own and the built-ins take
    the rest of the whole block, so the block's framing is counted once and the
    two still sum to it. `system` is the prompt's named sections where the
    caller has them (`systemSections`), joined exactly as the prompt joins them. */
export function prefixTokens(system: string | { name: string; text: string }[], tools: ToolSet): PrefixTokens {
  const sections = typeof system === "string" ? [{ name: "System prompt", text: system }] : system;
  const text = sections.map((part) => part.text).join("\n\n");
  const all = prefixTools(tools);
  const entries = Object.entries(tools);
  const mcpEntries = entries.filter(([name]) => name.startsWith("mcp__"));
  const mcp = Math.min(all, prefixTools(Object.fromEntries(mcpEntries) as ToolSet));
  return {
    system: prefixSystem(text),
    tools: all - mcp,
    mcp,
    items: {
      system: systemItems(sections),
      tools: toolItems(entries.filter(([name]) => !name.startsWith("mcp__"))),
      mcp: toolItems(mcpEntries),
    },
  };
}

/**
 * Divide a request's prompt, given the provider's own total for it.
 *
 * `total` is `prompt_tokens` — it includes cache hits and cache writes, which is
 * the whole prompt and what a reader means by "the prompt" (`lib/tokens.ts`
 * says the same thing on the client).
 *
 * **The parts always sum to the total**, which the drawing depends on: a row of
 * figures under a headline that does not add up to it is worse than no row. So a
 * counted prefix that comes out *larger* than the whole prompt — a real case,
 * since we tokenize with OpenAI's ranks whatever model is serving — is scaled
 * down to fit rather than left to overflow it. Scaling the static parts by the
 * same factor keeps the one thing the split is for ("the tools cost three times
 * what the system prompt did"), and the alternative — flooring the conversation
 * and leaving the prefix long — draws a system prompt bigger than the request
 * that carried it.
 */
export function promptBreakdown(total: number, prefix: PrefixTokens, history?: HistoryTokens): PromptBreakdown {
  const empty = { user: 0, assistant: 0, results: 0 };
  /* Nothing to divide: no prompt, or a provider that reported nothing. */
  if (total <= 0) return { total, system: 0, tools: 0, mcp: 0, conversation: 0, ...empty };
  const staticTokens = prefix.system + prefix.tools + prefix.mcp;
  if (staticTokens > total) {
    /* The estimate overshoots the invoice, so the invoice wins — the parts are
       the same estimates, so they shrink by one common factor and keep their
       ratio. `tools` takes the remainder rather than its own rounding, so a
       fraction of a token can never make the figures miss the total. */
    const system = Math.round(prefix.system * (total / staticTokens));
    const mcp = Math.min(total - system, Math.round(prefix.mcp * (total / staticTokens)));
    return { total, system, tools: total - system - mcp, mcp, conversation: 0, ...empty };
  }
  const conversation = total - staticTokens;
  const counted = history ? history.user + history.assistant + history.results : 0;
  const fixed = { system: prefix.system, tools: prefix.tools, mcp: prefix.mcp };
  if (!history || counted === 0) return { total, ...fixed, conversation, ...empty };
  /* The remainder is the provider's; the three shares are only its proportions.
     The last takes what rounding left, so they add to it exactly. */
  const user = Math.round((conversation * history.user) / counted);
  const assistant = Math.min(conversation - user, Math.round((conversation * history.assistant) / counted));
  return { total, ...fixed, conversation, user, assistant, results: conversation - user - assistant };
}
