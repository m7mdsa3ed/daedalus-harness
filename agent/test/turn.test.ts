import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { buildAgentApp } from "../src/app.js";
import {
  initialize,
  makeClient,
  promptOf,
  scriptedModel,
  testEnv,
  textScript,
  toolCallScript,
  usage,
} from "./helpers/scripted.js";

const cwd = mkdtempSync(join(tmpdir(), "daedalus-agent-cwd-"));

// --- a plain text turn: streaming, usage, stop reason ---
{
  const agent = buildAgentApp({
    env: testEnv(),
    makeModel: scriptedModel([textScript("Hello there, world. ", { input: 10, output: 5 })]),
  });
  const { app: client, harness } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    const response = await ctx.request("session/prompt", {
      sessionId,
      prompt: promptOf("hi"),
    });
    assert.equal(response.stopReason, "end_turn");
    assert.equal(response.usage?.totalTokens, 15);

    const chunks = harness.updatesOf("agent_message_chunk");
    const text = chunks
      .map((u) => ((u.update as { content?: { text?: string } }).content?.text ?? ""))
      .join("");
    assert.equal(text, "Hello there, world. ");

    const usageUpdates = harness.updatesOf("usage_update");
    assert.equal((usageUpdates.at(-1)?.update as { used?: number }).used, 15);
  });
  console.log("turn: text ok");
}

// --- steering: a prompt mid-turn joins the running turn and shares its end ---
{
  const agent = buildAgentApp({
    env: testEnv(),
    makeModel: scriptedModel([
      toolCallScript("bash", { command: "sleep 0.4; echo done" }),
      textScript("All done. "),
    ]),
  });
  const { app: client } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    await ctx.request("session/set_mode", { sessionId, modeId: "bypassPermissions" });
    const first = ctx.request("session/prompt", { sessionId, prompt: promptOf("run it") });
    await new Promise((r) => setTimeout(r, 150));
    const second = ctx.request("session/prompt", { sessionId, prompt: promptOf("also note this") });
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.stopReason, "end_turn");
    assert.equal(b.stopReason, "end_turn");
  });
  console.log("turn: steering ok");
}

// --- cancel: session/cancel ends the turn with stopReason cancelled ---
{
  const agent = buildAgentApp({
    env: testEnv(),
    makeModel: scriptedModel([
      toolCallScript("bash", { command: "sleep 5" }),
      textScript("never reached "),
    ]),
  });
  const { app: client } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    await ctx.request("session/set_mode", { sessionId, modeId: "bypassPermissions" });
    const turn = ctx.request("session/prompt", { sessionId, prompt: promptOf("run it") });
    await new Promise((r) => setTimeout(r, 200));
    await ctx.notify("session/cancel", { sessionId });
    const response = await turn;
    assert.equal(response.stopReason, "cancelled");
  });
  console.log("turn: cancel ok");
}

// --- compaction: crossing the threshold summarizes before the next turn ---
{
  const agent = buildAgentApp({
    env: testEnv({ contextWindow: 100 }),
    makeModel: scriptedModel([
      // turn 1 reports 95/100 tokens used
      textScript("A long first answer. ", { input: 90, output: 5 }),
      // turn 2 first compacts (small model summary)...
      textScript("summary of the work so far ", { input: 5, output: 5 }),
      // ...then answers
      textScript("Fresh context answer. ", { input: 10, output: 5 }),
    ]),
  });
  const { app: client, harness } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    await ctx.request("session/prompt", { sessionId, prompt: promptOf("first") });
    const response = await ctx.request("session/prompt", { sessionId, prompt: promptOf("second") });
    assert.equal(response.stopReason, "end_turn");

    const compactions = harness.updatesOf("compaction_update");
    const statuses = compactions.map((u) => (u.update as { status?: string }).status);
    assert.ok(statuses.includes("in_progress") && statuses.includes("completed"), `got ${statuses}`);
    assert.ok(harness.updatesOf("compaction_summary_chunk").length > 0);
  });
  console.log("turn: compaction ok");
}

// --- provider error: the turn fails as a JSON-RPC error, not a hang ---
{
  const agent = buildAgentApp({
    env: testEnv(),
    makeModel: scriptedModel([
      [
        { type: "stream-start", warnings: [] },
        { type: "error", error: new Error("model exploded") },
        { type: "finish", finishReason: { unified: "error", raw: "error" }, usage: usage(1, 0) },
      ],
    ]),
  });
  const { app: client } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    await assert.rejects(
      ctx.request("session/prompt", { sessionId, prompt: promptOf("boom") }) as Promise<acp.PromptResponse>,
    );
  });
  console.log("turn: error ok");
}

console.log("turn.test.ts passed");
