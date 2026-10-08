import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { buildAgentApp } from "../src/app.js";
import { initialize, makeClient, promptOf, testEnv, textScript } from "./helpers/scripted.js";

const cwd = mkdtempSync(join(tmpdir(), "daedalus-agent-cwd-"));
const env = testEnv({ autoTitle: true });

/* test-small names the thread; test-model answers the turn. */
const makeModel = (_env: unknown, id: string) =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: '"Fix the login redirect."\nextra' }],
      finishReason: { unified: "stop", raw: "stop" } as never,
      usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } as never,
      warnings: [],
    }),
    doStream: async () => {
      assert.equal(id, "test-model");
      return { stream: convertArrayToReadableStream(textScript("done")) };
    },
  });

const agent = buildAgentApp({ env, makeModel });
const { app: client, harness } = makeClient();
await client.connectWith(agent, async (ctx) => {
  await initialize(ctx);
  const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
  await ctx.request("session/prompt", { sessionId, prompt: promptOf("the login page redirects wrong, please fix") });
  for (let i = 0; i < 50 && harness.updatesOf("session_info_update").length === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const titles = harness.updatesOf("session_info_update").map((u) => (u.update as { title?: string }).title);
  // One update, the generated one: the first-line fallback is not sent ahead of it.
  assert.deepEqual(titles, ["Fix the login redirect"]);
});
const shortTitleEnv = testEnv({ autoTitle: true });
const shortTitleAgent = buildAgentApp({
  env: shortTitleEnv,
  makeModel: () => new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: "Redirect" }],
      finishReason: { unified: "stop", raw: "stop" } as never,
      usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } as never,
      warnings: [],
    }),
    doStream: async () => ({ stream: convertArrayToReadableStream(textScript("done")) }),
  }),
});
const { app: shortClient, harness: shortHarness } = makeClient();
await shortClient.connectWith(shortTitleAgent, async (ctx) => {
  await initialize(ctx);
  const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
  await ctx.request("session/prompt", { sessionId, prompt: promptOf("the login page redirects wrong, please fix") });
  for (let i = 0; i < 50 && shortHarness.updatesOf("session_info_update").length === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const titles = shortHarness.updatesOf("session_info_update").map((u) => (u.update as { title?: string }).title);
  assert.deepEqual(titles, ["the login page redirects wrong, please fix"]);
});

console.log("title ok");
