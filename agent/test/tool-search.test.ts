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
  mcp__github__create_issue: stub("Create a GitHub issue."),
  mcp__github__list_issues: stub("List issues in a repository, newest first."),
  mcp__github__list_prs: stub("List pull requests."),
  mcp__web__fetch: stub("Fetch a URL."),
});

const catalog = (tools: ToolSet) =>
  Object.entries(tools).map(([name, tool]) => ({ name, description: typeof tool.description === "string" ? tool.description : undefined }));

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

// --- the catalogue groups every tool under its server, and a summary can be read without searching ---
{
  const tools = make();
  const deferral = deferMcpTools(tools, [])!;
  const description = String(tools[SEARCH_TOOL].description);
  assert.match(description, /^github \(3 tools\)$/m, "a server's tools are one group, with the count");
  assert.match(description, /^ {2}create_issue: Create a GitHub issue\.$/m, "a name carries its summary, so a model can select without searching");
  assert.match(description, /^web \(1 tool\)$/m, "one tool is not 'tools'");
  assert.match(description, /up to 25/, "the whole-server cap is stated, not silent");
  assert.match(description, /select:<name>/, "the query forms are listed");

  const history: ModelMessage[] = [{ role: "user", content: "file an issue" }];
  const { sent, response } = await run(tools, history, [toolCallScript(SEARCH_TOOL, { query: "github issue" }), textScript("done")]);
  assert.deepEqual(sent[0], ["read_file", SEARCH_TOOL]);
  assert.ok(sent[1].includes("mcp__github__create_issue"), "the match is sent on the next step");
  assert.ok(!sent[1].includes("mcp__web__fetch"), "a tool nobody searched for stays out");
  assert.ok(deferral.activeFor([...history, ...response]).includes("mcp__github__create_issue"), "the breakdown mirrors the SDK");

  // the next turn, rebuilt from the history: the loaded tool is sent from step one
  const next = make();
  deferMcpTools(next, [...history, ...response]);
  const again = await run(next, [...history, ...response, { role: "user", content: "another" }], [textScript("ok")]);
  assert.ok(again.sent[0].includes("mcp__github__create_issue"));
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
  assert.ok(tools.mcp__github__list_prs.deferLoading);
  assert.ok(deferral.activeFor(history).includes("mcp__web__fetch"));
}

// --- select: resolves the forms the description promises, not just the whole name ---
{
  const tools = catalog(make());
  assert.deepEqual(searchDeferred({ query: "select:mcp__github__list_prs", tools }), ["mcp__github__list_prs"]);
  assert.deepEqual(searchDeferred({ query: "select:MCP__GITHUB__LIST_PRS", tools }), ["mcp__github__list_prs"], "punctuation and case are forgiven");
  assert.deepEqual(searchDeferred({ query: "select:list_prs", tools }), ["mcp__github__list_prs"], "a bare tool name is enough when it is unambiguous");
  assert.deepEqual(searchDeferred({ query: "select:github/list_prs", tools }), ["mcp__github__list_prs"], "server/tool path");
  assert.deepEqual(searchDeferred({ query: "select:github/*", tools }).sort(), ["mcp__github__create_issue", "mcp__github__list_issues", "mcp__github__list_prs"]);
  assert.deepEqual(searchDeferred({ query: "select:create_issue, list_prs", tools }).sort(), ["mcp__github__create_issue", "mcp__github__list_prs"], "a list of names");
  assert.deepEqual(searchDeferred({ query: "select:github/nope", tools }), [], "a miss stays a miss, so the empty answer teaches");
  assert.deepEqual(searchDeferred({ query: "select:nope", tools }), []);

  // a leaf two servers both ship cannot be resolved by the leaf alone
  const shared = [{ name: "mcp__a__search" }, { name: "mcp__b__search" }];
  assert.deepEqual(searchDeferred({ query: "select:search", tools: shared }), []);
  assert.deepEqual(searchDeferred({ query: "select:b/*", tools: shared }), ["mcp__b__search"], "the server path disambiguates");
}

// --- a selection of named tools is never cut short ---
{
  const tools: ToolSet = { read_file: stub("Read a file.") };
  const names = Array.from({ length: 30 }, (_, i) => `mcp__bulk__t${i}`);
  for (const name of names) tools[name] = stub(`Bulk tool ${name}.`);
  deferMcpTools(tools, []);
  const { sent } = await run(tools, [{ role: "user", content: "go" }], [
    toolCallScript(SEARCH_TOOL, { query: `select:${names.join(",")}` }),
    textScript("done"),
  ]);
  assert.equal(sent[1].filter((name) => name.startsWith("mcp__")).length, 30, "all thirty are sent, not the SDK's default cap");
}

// --- keywords rank name over description and find a plural ---
{
  const tools = catalog(make());
  assert.deepEqual(searchDeferred({ query: "issue", tools }).sort(), ["mcp__github__create_issue", "mcp__github__list_issues"], "'issue' finds 'list_issues'");
  assert.deepEqual(searchDeferred({ query: "pull request", tools }), ["mcp__github__list_prs"], "a two-word name is two name hits");
  assert.deepEqual(searchDeferred({ query: "nothing here", tools }), []);
}

// --- +server resolves by prefix and alone loads the whole cluster ---
{
  const tools = catalog(make());
  assert.deepEqual(searchDeferred({ query: "+gh", tools }).sort(), ["mcp__github__create_issue", "mcp__github__list_issues", "mcp__github__list_prs"], "'+gh' is the 'github' server");
  assert.deepEqual(searchDeferred({ query: "+git", tools }).sort(), ["mcp__github__create_issue", "mcp__github__list_issues", "mcp__github__list_prs"], "a prefix of the server's name is enough");
  assert.deepEqual(searchDeferred({ query: "+gh issue", tools }).sort(), ["mcp__github__create_issue", "mcp__github__list_issues"], "keywords rank inside the server");
  assert.deepEqual(searchDeferred({ query: "+web", tools }), ["mcp__web__fetch"], "a one-tool server is not a keyword search");
  assert.deepEqual(searchDeferred({ query: "+issue", tools }).sort(), ["mcp__github__create_issue", "mcp__github__list_issues"], "a + term naming no server still has to appear in the name");

  // the whole-server cap is real, stated, and reachable again by keywords
  const bulk = Array.from({ length: 30 }, (_, i) => ({ name: `mcp__bulk__t${i}`, description: `Bulk tool ${i}.` }));
  assert.equal(searchDeferred({ query: "+bulk", tools: bulk }).length, 25);
}

// --- a near miss on the name loads rather than costing the step ---
{
  const tools = catalog(make());
  assert.deepEqual(searchDeferred({ query: "creat", tools }), ["mcp__github__create_issue"], "a prefix of the name is a hit");
  assert.deepEqual(searchDeferred({ query: "repositor", tools }), [], "a description-only word is not a hit — that is how a search loads strangers");
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
  assert.match(String(before[SEARCH_TOOL].description), /select:<name>/);
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
