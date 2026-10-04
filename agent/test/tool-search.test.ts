// Run: pnpm test:tool-search
//
// Driven through a real `streamText`, because what matters is what the SDK
// actually sends on each step, not what our half believes it will.
import assert from "node:assert/strict";
import { dynamicTool, jsonSchema, streamText, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { deferMcpTools, searchDeferred, SEARCH_TOOL } from "../src/tools/tool-search.js";
import { textScript, toolCallScript } from "./helpers/scripted.js";

const stub = (description: string) =>
  dynamicTool({ description, inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => "x" });

const make = (): ToolSet => ({
  read_file: stub("Read a file."),
  mcp__gh__create_issue: stub("Create a GitHub issue."),
  mcp__gh__list_prs: stub("List pull requests."),
  mcp__web__fetch: stub("Fetch a URL."),
});

/** Runs one generation over `scripts`, returning the tool names each step sent. */
async function run(tools: ToolSet, messages: ModelMessage[], scripts: LanguageModelV4StreamPart[][]) {
  const sent: string[][] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      sent.push((options.tools ?? []).map((t) => t.name).sort());
      return { stream: convertArrayToReadableStream(scripts.shift()!) };
    },
  });
  const result = streamText({ model, messages, tools, stopWhen: stepCountIs(5) });
  await result.consumeStream();
  return { sent, response: await result.responseMessages };
}

// --- no MCP tool, nothing to defer and no search tool ---
{
  const tools: ToolSet = { read_file: stub("Read a file.") };
  assert.equal(deferMcpTools(tools, []), null);
  assert.ok(!(SEARCH_TOOL in tools));
}

// --- a single small server is deferred all the same; a search loads a match on the next step, and the next turn keeps it ---
{
  const tools = make();
  const deferral = deferMcpTools(tools, [])!;
  assert.ok(deferral);
  assert.match(String(tools[SEARCH_TOOL].description), /mcp__gh__list_prs/, "the search tool names what it can find");
  assert.match(String(tools[SEARCH_TOOL].description), /^mcp__gh__list_prs: List pull requests\.$/m, "each name carries its summary, so a model can select without searching");

  const history: ModelMessage[] = [{ role: "user", content: "file an issue" }];
  const { sent, response } = await run(tools, history, [
    toolCallScript(SEARCH_TOOL, { query: "github issue" }),
    textScript("done"),
  ]);
  assert.deepEqual(sent[0], ["read_file", SEARCH_TOOL]);
  assert.ok(sent[1].includes("mcp__gh__create_issue"), "the match is sent on the next step");
  assert.ok(!sent[1].includes("mcp__web__fetch"), "a tool nobody searched for stays out");
  assert.ok(deferral.activeFor([...history, ...response]).includes("mcp__gh__create_issue"), "the breakdown mirrors the SDK");

  // the next turn, rebuilt from the history: the loaded tool is sent from step one
  const next = make();
  deferMcpTools(next, [...history, ...response]);
  const again = await run(next, [...history, ...response, { role: "user", content: "another" }], [textScript("ok")]);
  assert.ok(again.sent[0].includes("mcp__gh__create_issue"));
  assert.ok(!again.sent[0].includes("mcp__web__fetch"));
}

// --- a deferred tool called directly counts as loaded ---
{
  const tools = make();
  const history: ModelMessage[] = [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "mcp__web__fetch", input: {} }] },
  ];
  const deferral = deferMcpTools(tools, history)!;
  assert.ok(!tools.mcp__web__fetch.deferLoading);
  assert.ok(tools.mcp__gh__list_prs.deferLoading);
  assert.ok(deferral.activeFor(history).includes("mcp__web__fetch"));
}

// --- select: loads exact names, Claude Code's way, beyond the keyword cap ---
{
  const tools = make();
  deferMcpTools(tools, []);
  const { sent } = await run(tools, [{ role: "user", content: "go" }], [
    toolCallScript(SEARCH_TOOL, { query: "select:mcp__gh__list_prs, mcp__web__fetch" }),
    textScript("done"),
  ]);
  assert.ok(sent[1].includes("mcp__gh__list_prs") && sent[1].includes("mcp__web__fetch"));
  assert.ok(!sent[1].includes("mcp__gh__create_issue"), "a select loads only what it names");

  const many = Array.from({ length: 8 }, (_, i) => ({ name: `mcp__s__t${i}` }));
  assert.equal(searchDeferred({ query: `select:${many.map((t) => t.name).join(",")}`, tools: many }).length, 8);
}

// --- keywords rank name over description; +server narrows to that server ---
{
  const catalog = [
    { name: "mcp__gh__create_issue", description: "Create a GitHub issue." },
    { name: "mcp__jira__create_issue", description: "Create a Jira issue." },
    { name: "mcp__gh__list_prs", description: "List pull requests, issue links included." },
  ];
  assert.deepEqual(searchDeferred({ query: "create issue", tools: catalog }).slice(0, 2).sort(), ["mcp__gh__create_issue", "mcp__jira__create_issue"]);
  assert.deepEqual(searchDeferred({ query: "+jira issue", tools: catalog }), ["mcp__jira__create_issue"]);
  assert.deepEqual(searchDeferred({ query: "+gh", tools: catalog }).sort(), ["mcp__gh__create_issue", "mcp__gh__list_prs"]);
  assert.deepEqual(searchDeferred({ query: "nothing here", tools: catalog }), []);
}

// --- the description lists every MCP tool, so a load does not change it ---
{
  const before = make();
  deferMcpTools(before, []);
  const after = make();
  deferMcpTools(after, [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "mcp__web__fetch", input: {} }] },
  ]);
  assert.equal(after[SEARCH_TOOL].description, before[SEARCH_TOOL].description);
  assert.match(String(before[SEARCH_TOOL].description), /select:name1,name2/);
}

// --- the names the system prompt lists do not move when a tool loads ---
{
  const loadedHistory: ModelMessage[] = [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "mcp__web__fetch", input: {} }] },
  ];
  const before = deferMcpTools(make(), [])!;
  const after = deferMcpTools(make(), loadedHistory)!;
  assert.deepEqual(after.base, before.base, "a load leaves the prompt's tool list alone, so the next turn stays cached");
  assert.deepEqual(before.base.sort(), ["read_file", SEARCH_TOOL].sort());
  assert.ok(after.activeFor(loadedHistory).includes("mcp__web__fetch"), "the request still sends what loaded");
}

console.log("tool-search.test.ts passed");
