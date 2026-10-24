import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { buildAgentApp } from "../src/app.js";
import type { AgentEnv } from "../src/env.js";
import { connectMcpServers, type McpHooks } from "../src/mcp.js";
import { connectPair, initialize, makeClient, promptOf, testEnv, textScript, toolCallScript } from "./helpers/scripted.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "helpers", "mcp-full-server.mjs");

let promptsChanged = 0;
const hooks: McpHooks = {
  elicit: async (server, params) => {
    assert.equal(server, "full");
    assert.equal(params.message, "name?");
    return { action: "accept", content: { name: "ada" } };
  },
  sample: async () => ({ role: "assistant", model: "m", content: { type: "text", text: "pong" } }),
  roots: () => [{ uri: "file:///work" }],
  onPromptsChanged: () => promptsChanged++,
};

const mcp = await connectMcpServers(
  [{ name: "full", command: process.execPath, args: [FIXTURE], env: [] }],
  hooks,
);
try {
  assert.deepEqual(mcp.failures, []);
  const call = async (tool: string, input: unknown = {}, extras: object = {}) =>
    (mcp.tools[`mcp__full__${tool}`]!.execute as (i: unknown, o: object) => Promise<unknown>)(input, {
      toolCallId: "t",
      messages: [],
      ...extras,
    });

  /* Instructions reach the handle; the model reads them in its system prompt. */
  assert.deepEqual(mcp.instructions, [{ server: "full", text: "Call pic before describing anything." }]);

  /* An image is named in the text and queued for the next step, never base64'd into it. */
  const pic = String(await call("pic"));
  assert.match(pic, /a dot\n\[image\/png, 0 KB — attached/);
  assert.equal(mcp.media.length, 1);
  assert.equal(mcp.media[0]!.tool, "mcp__full__pic");
  mcp.media.length = 0;

  assert.equal(await call("struct"), '{"answer":42}');
  assert.equal(await call("link"), "[resource: mem://a (A)]");

  /* Resources: the fixed list, the templates, a filled template, a binary one. */
  assert.match(String(await call("list_resources")), /mem:\/\/a — A/);
  assert.match(String(await call("list_resource_templates")), /mem:\/\/\{key\} — any key/);
  assert.equal(await call("read_resource", { uri: "mem://zz" }), "contents of mem://zz");
  assert.match(String(await call("read_resource", { uri: "mem://img" })), /image\/png/);
  assert.equal(mcp.media.length, 1);
  mcp.media.length = 0;

  /* The three requests a server makes of us. */
  assert.equal(await call("ask"), "accept:ada");
  assert.equal(await call("sample"), "sampled:pong");
  assert.equal(await call("roots"), "file:///work");

  /* Progress lands on the sink the gate passes in. */
  const progress: string[] = [];
  assert.equal(await call("slow", {}, { onProgress: (t: string) => progress.push(t) }), "done");
  assert.deepEqual(progress, ["halfway (1/2)"]);

  /* A changed tool list replaces this server's tools in place. */
  assert.equal(mcp.tools.mcp__full__grown, undefined);
  await call("grow");
  for (let i = 0; i < 50 && !mcp.tools.mcp__full__grown; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(await call("grown"), "i am new");
  assert.ok(mcp.tools.mcp__full__read_resource, "resource tools survive a relist");

  /* Prompts are slash commands. */
  assert.equal(await mcp.prompts[0]!.fetch!("ada"), "hello ada");
  assert.equal(promptsChanged, 0);
} finally {
  await mcp.close();
}

console.log("mcp-features: handle ok");

/* End to end: the image a tool returned is in the *next* step's prompt as a
   file part — unless the catalog says the model takes no images. */
async function nextStepParts(env: Partial<AgentEnv>): Promise<string[]> {
  const scripts: LanguageModelV4StreamPart[][] = [
    /* Every MCP tool is deferred: found by a search, then called. */
    toolCallScript("search_tools", { query: "select:mcp__full__pic" }, { id: "search-1" }),
    toolCallScript("mcp__full__pic", {}),
    textScript("A dot. "),
  ];
  const model = new MockLanguageModelV4({
    doStream: async () => ({ stream: convertArrayToReadableStream(scripts.shift()!) }),
  });
  const agent = buildAgentApp({ env: testEnv(env), makeModel: () => model });
  const { app: client } = makeClient();
  let parts: string[] = [];
  await connectPair(agent, client, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", {
      cwd: process.cwd(),
      mcpServers: [{ name: "full", command: process.execPath, args: [FIXTURE], env: [] }],
    });
    await ctx.request("session/set_mode", { sessionId, modeId: "bypassPermissions" });
    await ctx.request("session/prompt", { sessionId, prompt: promptOf("look") });
    const prompt = model.doStreamCalls.at(-1)?.prompt ?? [];
    parts = prompt.flatMap((m) =>
      m.role === "user" && Array.isArray(m.content) ? m.content.map((p) => (p as { type: string }).type) : [],
    );
    const system = prompt.find((m) => m.role === "system") as { content: string } | undefined;
    assert.match(system?.content ?? "", /Instructions from the full MCP server:\nCall pic/);
    await ctx.request("session/close", { sessionId });
  });
  return parts;
}
assert.ok((await nextStepParts({})).includes("file"), "the image reaches the next step");
assert.ok(
  !(await nextStepParts({ modelModalities: { "test-model": ["text"] } })).includes("file"),
  "a text-only model is not sent it",
);
console.log("mcp-features: media reaches the next step ok");
