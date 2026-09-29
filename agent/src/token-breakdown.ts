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
}

/** A request's prompt, divided. `total` and `conversation` are exact (they come
    from the provider); `system` and `tools` are the local estimate. */
export interface PromptBreakdown extends PrefixTokens {
  /** The whole prompt, as the provider billed it. */
  total: number;
  /** User-role message text counted locally from the exact messages sent. */
  user: number;
  /** The remaining history and tool results, derived from the provider total. */
  conversation: number;
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

/** The tool block's own tokens: what a provider has to tokenize on *every*
    step of every turn, whether or not a call is made. */
export function prefixTools(tools: ToolSet): number {
  const functions: ChatCompletionFunctionDefinition[] = [];
  for (const [name, tool] of Object.entries(tools)) {
    const parameters = schemaOf(tool);
    if (parameters === null) continue;
    /* A description the SDK computes per call is one whose text only exists at
       the call, which is not this walk — so the tool is counted without it and
       the figure comes out slightly low rather than invented. Every tool this
       runtime builds carries a static description; only a third-party one
       could differ. */
    const description = typeof tool.description === "string" ? tool.description : undefined;
    functions.push({
      name,
      ...(description ? { description } : {}),
      parameters: parameters as ChatCompletionFunctionDefinition["parameters"],
    });
  }
  return functions.length ? estimateTokensInFunctions(functions, countTokens) : 0;
}

/** The system prompt's own tokens, on the same footing the library counts a
    chat message on (role and per-message framing included). */
export function prefixSystem(system: string): number {
  return system ? countMessageTokens({ role: "system", content: system }, countTokens) : 0;
}

/** Text in user-role messages is separate from assistant history and tool
    results. Non-text media is excluded; text uses the same tokenizer and
    framing as the system message. */
export function userMessageTokens(messages: ModelMessage[]): number {
  return messages.reduce((total, message) => {
    if (message.role !== "user") return total;
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("");
    return total + countMessageTokens({ role: "user", content }, countTokens);
  }, 0);
}

/** Both static parts of the prompt, in one walk — the shape `turn.ts` caches
    per turn, since neither the system prompt nor the tool set changes between
    the steps of one. The MCP share is counted on its own and the built-ins take
    the rest of the whole block, so the block's framing is counted once and the
    two still sum to it. */
export function prefixTokens(system: string, tools: ToolSet): PrefixTokens {
  const all = prefixTools(tools);
  const mcp = Math.min(
    all,
    prefixTools(Object.fromEntries(Object.entries(tools).filter(([name]) => name.startsWith("mcp__"))) as ToolSet),
  );
  return { system: prefixSystem(system), tools: all - mcp, mcp };
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
 * down to fit rather than left to overflow it. Scaling both static parts by the
 * same factor keeps the one thing the split is for ("the tools cost three times
 * what the system prompt did"), and the alternative — flooring the conversation
 * and leaving the prefix long — draws a system prompt bigger than the request
 * that carried it.
 */
export function promptBreakdown(
  total: number,
  prefix: PrefixTokens,
  user = 0,
): PromptBreakdown {
  const staticTokens = prefix.system + prefix.tools + prefix.mcp;
  if (staticTokens <= total) {
    const userTokens = Math.min(user, total - staticTokens);
    return {
      total,
      system: prefix.system,
      tools: prefix.tools,
      mcp: prefix.mcp,
      user: userTokens,
      conversation: total - staticTokens - userTokens,
    };
  }
  /* Nothing to divide: no prompt, or a provider that reported nothing. */
  if (total <= 0) return { total, system: 0, tools: 0, mcp: 0, user: 0, conversation: 0 };
  /* The estimate overshoots the invoice, so the invoice wins — the parts are
     the same estimates, so they shrink by one common factor and keep their
     ratio. `tools` takes the remainder rather than its own rounding, so a
     fraction of a token can never make the figures miss the total. */
  const system = Math.round(prefix.system * (total / staticTokens));
  const mcp = Math.min(total - system, Math.round(prefix.mcp * (total / staticTokens)));
  const tools = total - system - mcp;
  const userTokens = Math.min(user, Math.max(0, total - system - tools - mcp));
  return { total, system, tools, mcp, user: userTokens, conversation: total - system - tools - mcp - userTokens };
}
