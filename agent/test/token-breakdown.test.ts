// Run: pnpm test:token-breakdown
//
// The split is arithmetic over a counted prefix, so every case here is a
// property rather than a golden number: a tokenizer whose ranks move with a
// release must not make this test fail, and the invariants it asserts are the
// ones the drawn figures depend on.
import assert from "node:assert/strict";
import { tool, dynamicTool, jsonSchema, type ToolSet } from "ai";
import { z } from "zod";
import { prefixSystem, prefixTokens, prefixTools, promptBreakdown } from "../src/token-breakdown.js";

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
{
  const prefix = prefixTokens("You are a coding agent.", {} as ToolSet);
  const total = 5000;
  const split = promptBreakdown(total, prefix);

  assert.equal(split.total, total, "the total is the provider's, untouched");
  assert.equal(split.system, prefix.system);
  assert.equal(split.tools, prefix.tools);
  /* The headline number is the conversation plus the two counted parts — the
     reason the conversation is derived rather than counted a second way. */
  assert.equal(split.system + split.tools + split.conversation, total);

  /* A prompt the provider billed as *smaller* than our own count of its static
     half is a disagreement between an estimate and an invoice. The invoice
     wins: the two estimated parts shrink to fit it, together, and the three
     figures still sum to the headline number. */
  const tiny = promptBreakdown(1, prefix);
  assert.equal(tiny.conversation, 0, "nothing is left for the conversation");
  assert.equal(tiny.system + tiny.tools + tiny.conversation, 1, "and the parts still sum");

  /* Scaling both parts by one factor is what keeps their ratio — the thing the
     split is read for — rather than flattening one of them to zero. */
  const scaled = promptBreakdown(prefix.system + prefix.tools, prefix);
  assert.equal(scaled.system, prefix.system, "a prefix that exactly fits is untouched");
  assert.equal(scaled.tools, prefix.tools);

  /* No prompt at all: every part is zero, not a fraction of a division by it. */
  assert.deepEqual(promptBreakdown(0, prefix), { total: 0, system: 0, tools: 0, conversation: 0 });
  console.log("token-breakdown: division ok");
}

// --- a bigger prefix leaves less for the conversation, at a fixed total ---
{
  const lean = promptBreakdown(10_000, prefixTokens("short", {} as ToolSet));
  const fat = promptBreakdown(10_000, prefixTokens("short ".repeat(2_000), {} as ToolSet));
  assert.ok(fat.system > lean.system, "the longer prompt is the bigger share");
  assert.ok(fat.conversation < lean.conversation, "and leaves less of the same total");
  console.log("token-breakdown: share ok");
}
