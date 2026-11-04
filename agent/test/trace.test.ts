// One record per model call (src/trace.ts, the `traced` helper in turn.ts):
//   - the parts of a prompt are anchored to the provider's bill, so they sum
//     to it; a part a door cannot see is null and lands in `unknown`
//   - the static prefix is counted on the prepared tool JSON, MCP tools as
//     their own share; the conversation by who wrote it
//   - a Tracer joins the SDK's start and end events by callId into a ModelCall
//   - every call a turn makes — the loop's steps and a subagent's — travels as
//     `_daedalus/model_call` on the session it belongs to
// The counts are a tokenizer's, so every case is a property, never a golden
// number: a release that moves the ranks must not fail this.
// Run: pnpm test:trace
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelCallEndEvent, LanguageModelCallStartEvent } from "ai";
import { buildAgentApp } from "../src/app.js";
import { Tracer, anchor, anchorToolUse, countMessages, countPrefix, countToolUse, splitOutput, type ModelCall } from "../src/trace.js";
import { connectPair, initialize, makeClient, promptOf, scriptedModel, testEnv, textScript, toolCallScript } from "./helpers/scripted.js";

const cwd = mkdtempSync(join(tmpdir(), "daedalus-agent-trace-"));
const positive = (n: number | null | undefined, what: string) => assert.ok(typeof n === "number" && n > 0, `${what}: expected > 0, got ${n}`);
const promptSum = (p: NonNullable<ModelCall["prompt"]>) =>
  (p.system ?? 0) + (p.tools ?? 0) + (p.mcp ?? 0) + (p.user ?? 0) + (p.assistant ?? 0) + (p.results ?? 0) + p.unknown;

// --- anchor: the bill is the truth, the counts are its proportions ---
{
  const all = anchor(1000, { a: 100, b: 300, c: 600 });
  assert.deepEqual(all, { a: 100, b: 300, c: 600, unknown: 0 }, "every part seen: shared out exactly");
  const up = anchor(2000, { a: 100, b: 300, c: 600 });
  assert.deepEqual(up, { a: 200, b: 600, c: 1200, unknown: 0 }, "scaled up to the bill when the counts run short");
  const down = anchor(10, { a: 100, b: 300, c: 600 });
  assert.equal(down.a! + down.b! + down.c!, 10, "an overshoot is scaled by one factor and still sums");
  assert.ok(down.c! > down.b! && down.b! >= down.a!, "and keeps the parts' order");
  const blind = anchor(1000, { a: 100, b: null, c: 600 });
  assert.deepEqual(blind, { a: 100, b: null, c: 600, unknown: 300 }, "a part unseen: the seen ones stand, the rest is unknown");
  const blindOver = anchor(70, { a: 100, b: null, c: 600 });
  assert.equal(blindOver.a! + blindOver.c! + blindOver.unknown, 70, "a blind overshoot still sums to the bill");
  assert.deepEqual(anchor(500, { a: 0, b: 0 }), { a: 0, b: 0, unknown: 500 }, "nothing counted is all unknown, not one part's windfall");
  assert.deepEqual(anchor(0, { a: 5, b: null }), { a: 0, b: null, unknown: 0 }, "no prompt: nothing to divide");
  console.log("trace: anchor ok");
}

// --- the static prefix, over the prepared tool JSON ---
const readTool = {
  type: "function",
  name: "read_file",
  description: "Read a file from the filesystem.",
  inputSchema: { type: "object", properties: { path: { type: "string", description: "File path" } }, required: ["path"] },
};
const mcpTool = {
  type: "function",
  name: "mcp__web__search",
  description: "Search the web.",
  inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
};
{
  const none = countPrefix(undefined, undefined);
  assert.deepEqual([none.system, none.tools, none.mcp], [0, 0, 0], "no prompt, no tools: nothing");
  assert.deepEqual(none.items, { system: [], tools: [], mcp: [] });

  const one = countPrefix("You are a coding agent.", [readTool]);
  positive(one.system, "system");
  positive(one.tools, "tools");
  assert.equal(one.mcp, 0, "no MCP tool, no MCP share");
  assert.deepEqual(one.items.tools.map((i) => i.name), ["read_file"]);
  assert.deepEqual(one.items.system.map((i) => i.name), ["System prompt"], "a plain string is one item");

  const two = countPrefix("You are a coding agent.", [readTool, mcpTool]);
  positive(two.mcp, "mcp");
  assert.ok(two.tools + two.mcp > one.tools, "a second tool adds tokens");
  assert.deepEqual(two.items.mcp.map((i) => i.name), ["mcp__web__search"], "MCP tools are their own list");

  /* Sections name the items — and a section's `##` headings are rows of their own. */
  const sections = [
    { name: "Core", text: "Intro.\n\n## General\n\nBe brief.\n\n## Personality\n\nBe kind." },
    { name: "Persona", text: "You are terse." },
  ];
  const named = countPrefix(sections.map((s) => s.text).join("\n\n"), [], sections);
  assert.deepEqual(named.items.system.map((i) => i.name), ["Core", "Core › General", "Core › Personality", "Persona"]);

  /* The array form of instructions counts too. */
  positive(countPrefix([{ role: "system", content: "a" }, { role: "system", content: "b" }], []).system, "system messages");

  /* A schema the library cannot walk is counted as JSON, never thrown on. */
  const odd = countPrefix("", [{ type: "function", name: "weird", inputSchema: { anyOf: [{ $ref: "#/x" }] } }]);
  positive(odd.tools, "an unwalkable schema");
  console.log("trace: prefix ok");
}

// --- the conversation, by who wrote it ---
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
  const h = countMessages([user, reply, result] as never);
  positive(h.user, "user");
  positive(h.assistant, "assistant");
  positive(h.results, "results");
  assert.deepEqual(countMessages([user] as never), { user: h.user, assistant: 0, results: 0 });
  /* The cache is keyed on content, so fresh objects with the same words hit it and agree. */
  assert.deepEqual(countMessages([structuredClone(user), structuredClone(reply), structuredClone(result)] as never), h);
  console.log("trace: messages ok");

  /* Per tool: calls and results by the name the part carries, and anchored
     inside the parts they came from. */
  const raw = countToolUse([user, reply, result] as never);
  assert.equal(raw.length, 1);
  assert.equal(raw[0].name, "read_file");
  assert.equal(raw[0].calls, 1);
  positive(raw[0].args, "args");
  positive(raw[0].results, "results");
  const anchored = anchorToolUse(raw, { assistant: h.assistant * 2, results: h.results * 2 }, h);
  assert.ok(anchored[0].args >= raw[0].args && anchored[0].args <= h.assistant * 2, "scaled with its part");
  assert.deepEqual(anchorToolUse(raw, { assistant: null, results: null }, h)[0], { name: "read_file", calls: 1, args: 0, results: 0 });
  console.log("trace: tool use ok");
}

// --- the output: reasoning exact when reported, the rest anchored ---
{
  const content = [
    { type: "text", text: "Hello there, world." },
    { type: "tool-call", toolCallId: "1", toolName: "bash", input: { command: "ls" } },
  ] as never;
  const reported = splitOutput({ content, usage: { outputTokens: 100, outputTokenDetails: { reasoningTokens: 40 } } as never })!;
  assert.equal(reported.reasoning, 40, "the provider's reasoning figure is taken as is");
  assert.equal(reported.text + reported.toolCalls, 60, "text and calls share what is left");
  positive(reported.text, "text");
  positive(reported.toolCalls, "toolCalls");
  const counted = splitOutput({ content: [{ type: "reasoning", text: "thinking hard" }] as never, usage: { outputTokens: 7 } as never })!;
  positive(counted.reasoning, "unreported reasoning is counted");
  console.log("trace: output ok");
}

// --- the Tracer joins start and end by callId ---
const startEvent = (callId: string, tools: Record<string, unknown>[], messages: unknown[]): LanguageModelCallStartEvent =>
  ({ callId, provider: "test", modelId: "m", instructions: "You are a coding agent.", messages, tools }) as never;
const endEvent = (callId: string, input: number, output: number, ttft?: number): LanguageModelCallEndEvent =>
  ({
    callId,
    provider: "test",
    modelId: "m",
    finishReason: "stop",
    usage: { inputTokens: input, outputTokens: output, totalTokens: input + output, inputTokenDetails: { cacheReadTokens: 0 } },
    content: [{ type: "text", text: "ok" }],
    responseId: "r",
    performance: { responseTimeMs: 1200, timeToFirstOutputMs: ttft, timeBetweenOutputChunksMs: ttft === undefined ? undefined : {}, effectiveOutputTokensPerSecond: 0, effectiveTotalTokensPerSecond: 0 },
  }) as never;
{
  const tracer = new Tracer();
  const messages = [{ role: "user", content: "hi" }];
  tracer.start(startEvent("c1", [readTool, mcpTool], messages));
  const first = tracer.end(endEvent("c1", 5000, 20, 300), "turn", { sections: [{ name: "Core", text: "You are a coding agent." }] });
  assert.equal(first.source, "acp");
  assert.equal(first.step, 1);
  assert.equal(first.who, "turn");
  assert.equal(first.model, "m");
  assert.equal(first.ms, 1200);
  assert.deepEqual(first.timing, { ttftMs: 300, decodeMs: 900 });
  assert.equal(first.billed.inputTokens, 5000);
  assert.ok(first.prompt, "the request was seen, so the prompt is divided");
  assert.equal(promptSum(first.prompt!), 5000, "the parts sum to the billed prompt");
  assert.equal(first.prompt!.unknown, 0, "every part was seen");
  positive(first.prompt!.mcp, "mcp share");
  assert.ok(first.items, "the prefix is said on the first call");
  assert.deepEqual(first.items!.system.map((i) => i.name), ["Core"]);
  assert.equal(first.missing, undefined);
  assert.equal(first.called, undefined, "a text-only reply called nothing");
  assert.equal(first.toolUse, undefined, "a history with no tool parts has no footprint");

  tracer.start(startEvent("c2", [readTool, mcpTool], [...messages, { role: "assistant", content: "ok" }]));
  const second = tracer.end(endEvent("c2", 5100, 10), "turn");
  assert.equal(second.step, 2, "steps count within the turn");
  assert.equal(second.items, undefined, "the same prefix is not said twice");
  assert.equal(second.timing, undefined, "no first-output time, no timing");

  /* The SDK repeats one callId on every step of a streamText — the record's
     id must still be one per request, or the client keeps only the first. */
  tracer.start(startEvent("same", [readTool, mcpTool], messages));
  const a = tracer.end(endEvent("same", 100, 1), "turn");
  tracer.start(startEvent("same", [readTool, mcpTool], messages));
  const b = tracer.end(endEvent("same", 110, 1), "turn");
  assert.notEqual(a.callId, b.callId, "two steps of one streamText are two records");

  tracer.start(startEvent("c3", [readTool], messages));
  const third = tracer.end(endEvent("c3", 4000, 10), "turn");
  assert.ok(third.items, "a changed tool set says the prefix again");
  assert.equal(third.prompt!.mcp, 0);

  const history = [
    ...messages,
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "mcp__web__search", input: { q: "x" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "mcp__web__search", output: { type: "text", value: "found it" } }] },
  ];
  tracer.start(startEvent("c5", [readTool, mcpTool], history));
  const withTools = tracer.end(
    { ...(endEvent("c5", 3000, 10) as object), content: [{ type: "tool-call", toolCallId: "2", toolName: "read_file", input: { path: "a" } }] } as never,
    "turn",
  );
  assert.deepEqual(withTools.called, ["read_file"], "the reply's own calls, by name");
  assert.deepEqual(withTools.toolUse?.map((t) => [t.name, t.calls]), [["mcp__web__search", 1]], "the history's calls, per tool");

  const child = tracer.end(endEvent("c4", 100, 10), "subagent", { childId: "kid" });
  assert.equal(child.step, 1, "a child's steps are its own");
  assert.equal(child.childId, "kid");
  assert.equal(child.prompt, undefined, "an end with no start has nothing to divide");
  assert.deepEqual(child.missing, ["the request as sent"]);
  assert.equal(child.billed.totalTokens, 110, "but the bill is still the bill");
  console.log("trace: tracer ok");
}

// --- end to end: every call of a turn is a record on the session it belongs to ---
{
  const agent = buildAgentApp({
    env: testEnv(),
    makeModel: scriptedModel([
      toolCallScript("task", { description: "look things up", prompt: "find the thing" }, { input: 20, output: 8 }),
      textScript("child report: found it ", { input: 100, output: 50 }),
      textScript("Parent summary. ", { input: 10, output: 5 }),
    ]),
  });
  const { app: client, harness } = makeClient();
  await connectPair(agent, client, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    const response = await ctx.request("session/prompt", { sessionId, prompt: promptOf("delegate") });
    assert.equal(response.stopReason, "end_turn");
    const childId = (harness.updatesOf("subagent_update")[0]?.update as { sessionId?: string }).sessionId;
    assert.ok(childId);

    const calls = harness.updatesOf("_daedalus/model_call");
    const of = (id: string) => calls.filter((u) => u.sessionId === id).map((u) => (u.update as { call: ModelCall }).call);
    const root = of(sessionId);
    const child = of(childId!);
    assert.equal(root.length, 2, `the loop's two steps are two records (got ${root.length})`);
    assert.equal(child.length, 1, "the child's one step is one record, on the child's session");
    assert.deepEqual(root.map((c) => [c.who, c.step]), [["turn", 1], ["turn", 2]]);
    assert.deepEqual(child.map((c) => [c.who, c.step, c.childId]), [["subagent", 1, childId]]);
    assert.deepEqual(root.map((c) => c.billed.inputTokens), [20, 10], "billed is the provider's own figure");
    assert.equal(child[0]!.billed.inputTokens, 100);
    for (const call of [...root, ...child]) {
      assert.equal(call.source, "acp");
      assert.ok(call.prompt, "the request was seen");
      assert.equal(promptSum(call.prompt!), call.billed.inputTokens, "parts sum to the bill");
      assert.ok(call.output, "the output is divided too");
      assert.ok(call.at > 0 && call.ms! >= 0);
    }
    assert.ok(root[0]!.items && root[0]!.items.tools.length > 0, "the first call says what the prefix is made of");
    assert.equal(root[1]!.items, undefined, "the second, same prefix, does not");
    assert.ok(root[0]!.items!.system.some((i) => i.name.startsWith("Core instructions")), "system items are the named sections");
    /* The record is journaled before the step's tools run, so it precedes the step's usage_update. */
    const order = harness.updates
      .filter((u) => u.sessionId === sessionId)
      .map((u) => (u.update as { sessionUpdate: string }).sessionUpdate)
      .filter((k) => k === "_daedalus/model_call" || k === "usage_update");
    assert.deepEqual(order, ["_daedalus/model_call", "usage_update", "_daedalus/model_call", "usage_update"]);
  });
  console.log("trace: end to end ok");
}

console.log("trace: all ok");
