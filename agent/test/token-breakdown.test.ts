// Run: pnpm test:token-breakdown
//
// The split is arithmetic over a counted prefix, so every case here is a
// property rather than a golden number: a tokenizer whose ranks move with a
// release must not make this test fail, and the invariants it asserts are the
// ones the drawn figures depend on.
import assert from "node:assert/strict";
import { tool, dynamicTool, jsonSchema, type ToolSet } from "ai";
import { z } from "zod";
import { historyTokens, prefixSystem, prefixTokens, prefixTools, promptBreakdown } from "../src/token-breakdown.js";

const notEmpty = (n: number) => assert.ok(n > 0, `expected a positive count, got ${n}`);

// --- the system prompt's own share ---
{
  assert.equal(prefixSystem(""), 0, "no system prompt counts nothing");
  const small = prefixSystem("You are a coding agent.");
  const large = prefixSystem("You are a coding agent. ".repeat(400));
  notEmpty(small);
  assert.ok(large > small * 100, "a longer prompt must count more");
  console.log("token-breakdown: system ok");
}

// --- the tool block, over both schema shapes that reach the tool set ---
{
  const inline = tool({
    description: "Read a file from the filesystem.",
    inputSchema: z.object({ path: z.string().describe("File path") }),
    execute: async () => "x",
  });
  const mcp = dynamicTool({
    description: "Search the web.",
    inputSchema: jsonSchema({
      type: "object",
      properties: { q: { type: "string", description: "query" } },
      required: ["q"],
    }),
    execute: async () => "x",
  });

  assert.equal(prefixTools({} as ToolSet), 0, "no tools counts nothing");

  /* Both shapes must be seen: the MCP tool's schema is already JSON and is
     read straight off, an inline one goes through `z.toJSONSchema`. A count of
     zero for either means a whole family of tools went uncounted. */
  notEmpty(prefixTools({ read_file: inline } as unknown as ToolSet));
  notEmpty(prefixTools({ "mcp__web__search": mcp } as unknown as ToolSet));

  /* Descriptions and schemas are what a provider tokenizes on every step, so
     two tools cost more than one — the property that makes this figure worth
     drawing at all. */
  const one = prefixTools({ read_file: inline } as unknown as ToolSet);
  const two = prefixTools({ read_file: inline, "mcp__web__search": mcp } as unknown as ToolSet);
  assert.ok(two > one, "a second tool must add tokens");
  console.log("token-breakdown: tools ok");
}

// --- the division, and the invariant the drawn figures rest on ---
const sum = (b: ReturnType<typeof promptBreakdown>) => b.system + b.tools + b.mcp + b.user + b.assistant + b.results;
{
  const prefix = prefixTokens("You are a coding agent.", {} as ToolSet);
  const total = 5000;
  const history = { user: 100, assistant: 300, results: 600 };
  const split = promptBreakdown(total, prefix, history);

  assert.equal(split.total, total, "the total is the provider's, untouched");
  assert.equal(split.system, prefix.system);
  assert.equal(split.tools, prefix.tools);
  assert.equal(split.conversation, total - prefix.system - prefix.tools - prefix.mcp, "the remainder is the provider's");
  assert.equal(sum(split), total, "every part adds up to the headline number");
  /* Shares follow the local counts: 1:3:6 of the remainder, whatever its size. */
  assert.ok(split.results > split.assistant && split.assistant > split.user, "shares keep their proportions");

  /* No messages to count: the remainder is not invented into shares. */
  const blind = promptBreakdown(total, prefix);
  assert.equal(blind.conversation, split.conversation);
  assert.equal(blind.user + blind.assistant + blind.results, 0, "an uncounted history is one remainder");

  /* A prompt the provider billed as *smaller* than our own count of its static
     half is a disagreement between an estimate and an invoice. The invoice
     wins: the estimated parts shrink to fit it, together, and the figures still
     sum to the headline number. */
  const tiny = promptBreakdown(1, prefix, history);
  assert.equal(tiny.conversation, 0, "nothing is left for the conversation");
  assert.equal(sum(tiny), 1, "and the parts still sum");

  /* Scaling the parts by one factor is what keeps their ratio — the thing the
     split is read for — rather than flattening one of them to zero. */
  const exact = promptBreakdown(prefix.system + prefix.tools + prefix.mcp, prefix, history);
  assert.equal(exact.system, prefix.system, "a prefix that exactly fits is untouched");
  assert.equal(exact.tools, prefix.tools);

  /* No prompt at all: every part is zero, not a fraction of a division by it. */
  assert.deepEqual(promptBreakdown(0, prefix, history), { total: 0, system: 0, tools: 0, mcp: 0, conversation: 0, user: 0, assistant: 0, results: 0 });
  console.log("token-breakdown: division ok");
}

// --- MCP tools are their own share, and the two shares are the whole block ---
{
  const inline = tool({
    description: "Read a file from the filesystem.",
    inputSchema: z.object({ path: z.string().describe("File path") }),
    execute: async () => "x",
  });
  const mcp = dynamicTool({
    description: "Search the web.",
    inputSchema: jsonSchema({ type: "object", properties: { q: { type: "string" } } }),
    execute: async () => "x",
  });
  const set = { read_file: inline, "mcp__web__search": mcp } as unknown as ToolSet;
  const prefix = prefixTokens("", set);
  notEmpty(prefix.tools);
  notEmpty(prefix.mcp);
  assert.equal(prefix.tools + prefix.mcp, prefixTools(set), "built-ins and MCP sum to the block");
  assert.equal(prefixTokens("", { read_file: inline } as unknown as ToolSet).mcp, 0, "no MCP tools, no MCP share");
  /* Overshoot scales all three parts and they still sum to the invoice. */
  const tiny = promptBreakdown(3, prefix, { user: 5, assistant: 5, results: 5 });
  assert.equal(sum(tiny), 3);
  console.log("token-breakdown: mcp ok");
}

// --- the history is counted by who wrote it ---
{
  const user = { role: "user", content: "Please inspect this code." } as const;
  const reply = {
    role: "assistant",
    content: [
      { type: "text", text: "I will read it." },
      { type: "tool-call", toolCallId: "1", toolName: "read_file", input: { path: "a.ts" } },
    ],
  } as const;
  const result = {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "1", toolName: "read_file", output: { type: "text", value: "export const a = 1;" } }],
  } as const;
  const h = historyTokens([user, reply, result] as never);
  notEmpty(h.user);
  notEmpty(h.assistant);
  notEmpty(h.results);
  assert.deepEqual(historyTokens([user] as never), { user: h.user, assistant: 0, results: 0 }, "other roles are not the user's");
  assert.deepEqual(historyTokens([user, reply, result] as never), h, "a repeat walk gives the same count");
  console.log("token-breakdown: history ok");
}

// --- a bigger prefix leaves less for the conversation, at a fixed total ---
{
  const lean = promptBreakdown(10_000, prefixTokens("short", {} as ToolSet), { user: 1, assistant: 1, results: 1 });
  const fat = promptBreakdown(10_000, prefixTokens("short ".repeat(2_000), {} as ToolSet), { user: 1, assistant: 1, results: 1 });
  assert.ok(fat.system > lean.system, "the longer prompt is the bigger share");
  assert.ok(fat.conversation < lean.conversation, "and leaves less of the same total");
  console.log("token-breakdown: share ok");
}

// --- what the prefix is made of, item by item ---
{
  const inline = tool({
    description: "Read a file from the filesystem.",
    inputSchema: z.object({ path: z.string() }),
    execute: async () => "x",
  });
  const mcp = dynamicTool({
    description: "Search the web.",
    inputSchema: jsonSchema({ type: "object", properties: { q: { type: "string" } } }),
    execute: async () => "x",
  });
  const sections = [
    { name: "Core instructions", text: "You are an agent.\n\n## General\n\nBe brief.\n\n## Planning\n\n" + "Plan well. ".repeat(50) },
    { name: "Persona", text: "Speak like a pirate." },
  ];
  const prefix = prefixTokens(sections, { read_file: inline, "mcp__web__search": mcp } as unknown as ToolSet);
  const names = prefix.items.system.map((item) => item.name);
  assert.deepEqual(names, ["Core instructions", "Core instructions › General", "Core instructions › Planning", "Persona"], "a section's headings are its rows");
  assert.equal(prefix.system, prefixTokens(sections.map((s) => s.text).join("\n\n"), {} as ToolSet).system, "sections count as the joined prompt");
  assert.deepEqual(prefix.items.tools.map((i) => i.name), ["read_file"], "built-ins listed apart");
  assert.deepEqual(prefix.items.mcp.map((i) => i.name), ["mcp__web__search"], "MCP tools listed apart");
  assert.ok(prefix.items.tools.every((i) => i.tokens > 0) && prefix.items.mcp.every((i) => i.tokens > 0));
  assert.equal("items" in promptBreakdown(10_000, prefix), false, "the per-step split does not carry the item list");
  console.log("token-breakdown: items ok");
}
