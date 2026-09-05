import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "../src/acp.js";
import { buildAgentApp } from "../src/app.js";
import { SessionStore } from "../src/persistence.js";
import {
  initialize,
  makeClient,
  promptOf,
  scriptedModel,
  scriptedModelsById,
  testEnv,
  textScript,
  toolCallScript,
  usage,
} from "./helpers/scripted.js";

const cwd = mkdtempSync(join(tmpdir(), "daedalus-agent-cwd-"));

/* A workspace whose model allowlist offers a second id — what the harness
   materializes before every spawn (`server/src/materialize.ts`) and what
   `readModelAllowlist` reads back as the model selector's options. Without it
   a session offers only the model it was spawned with, and there is nothing to
   switch a held turn to. */
const twoModelCwd = mkdtempSync(join(tmpdir(), "daedalus-agent-models-"));
mkdirSync(join(twoModelCwd, ".claude"), { recursive: true });
writeFileSync(
  join(twoModelCwd, ".claude", "settings.local.json"),
  JSON.stringify({ availableModels: ["test-model", "test-model-2"] }),
);

/** Polls until `ready`, so a test never races a hold that is announced a tick
    after the step that failed. Fails loudly rather than hanging. */
async function waitFor(ready: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

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

// --- pause: the turn holds at the next step boundary, and resume carries on ---
{
  const agent = buildAgentApp({
    env: testEnv(),
    makeModel: scriptedModel([
      toolCallScript("bash", { command: "sleep 0.2; echo one" }),
      textScript("after the pause "),
    ]),
  });
  const { app: client, harness } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    await ctx.request("session/set_mode", { sessionId, modeId: "bypassPermissions" });
    const turn = ctx.request("session/prompt", { sessionId, prompt: promptOf("run it") });
    await new Promise((r) => setTimeout(r, 100));
    const paused = await ctx.request<{ paused: boolean; turnActive: boolean }>("_daedalus/session/pause", { sessionId });
    assert.deepEqual(paused, { paused: true, turnActive: true });
    // The bash step finishes whole; the model step after it does not begin.
    await new Promise((r) => setTimeout(r, 600));
    const toolDone = harness.updatesOf("tool_call_update").some((u) => (u.update as { status?: string }).status === "completed");
    assert.ok(toolDone, "the step in flight ran to its end");
    assert.equal(harness.updatesOf("agent_message_chunk").length, 0, "nothing streamed while paused");
    const resumed = await ctx.request<{ paused: boolean }>("_daedalus/session/resume", { sessionId });
    assert.equal(resumed.paused, false);
    const response = await turn;
    assert.equal(response.stopReason, "end_turn");
    const text = harness
      .updatesOf("agent_message_chunk")
      .map((u) => ((u.update as { content?: { text?: string } }).content?.text ?? ""))
      .join("");
    assert.equal(text, "after the pause ");
  });
  console.log("turn: pause/resume ok");
}

// --- pause then cancel: the held turn ends as cancelled, and the pause goes with it ---
{
  const agent = buildAgentApp({
    env: testEnv(),
    makeModel: scriptedModel([
      toolCallScript("bash", { command: "echo one" }),
      textScript("never reached "),
      textScript("second turn "),
    ]),
  });
  const { app: client, harness } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    await ctx.request("session/set_mode", { sessionId, modeId: "bypassPermissions" });
    await ctx.request("_daedalus/session/pause", { sessionId });
    // A paused session's next prompt waits at its first step.
    const turn = ctx.request("session/prompt", { sessionId, prompt: promptOf("run it") });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(harness.updatesOf("tool_call").length, 0, "the first step did not start");
    await ctx.notify("session/cancel", { sessionId });
    const response = await turn;
    assert.equal(response.stopReason, "cancelled");
    // The cancel cleared the pause: the next turn runs at once.
    const next = await ctx.request("session/prompt", { sessionId, prompt: promptOf("again") });
    assert.equal(next.stopReason, "end_turn");
  });
  console.log("turn: pause then cancel ok");
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

// --- a failed turn holds, a model change releases it, and no work is repeated ---
{
  const heldEnv = testEnv({ holdOnError: true });
  const agent = buildAgentApp({
    env: heldEnv,
    makeModel: scriptedModelsById({
      // The first model runs a tool, then dies on the next step.
      "test-model": [
        toolCallScript("bash", { command: "echo one" }),
        [
          { type: "stream-start", warnings: [] },
          { type: "error", error: new Error("429 rate limit exceeded") },
          { type: "finish", finishReason: { unified: "error", raw: "error" } as never, usage: usage(1, 0) },
        ],
      ],
      // The one the user switches to answers.
      "test-model-2": [textScript("done on the second model ")],
    }),
  });
  const { app: client, harness } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd: twoModelCwd, mcpServers: [] });
    await ctx.request("session/set_mode", { sessionId, modeId: "bypassPermissions" });
    const turn = ctx.request("session/prompt", { sessionId, prompt: promptOf("run it") }) as Promise<acp.PromptResponse>;

    // It holds rather than rejecting, and says why.
    await waitFor(() => harness.holds.some((h) => h.paused), "the turn to hold");
    const hold = harness.holds.find((h) => h.paused)!;
    assert.equal(hold.reason, "error");
    assert.match(hold.message ?? "", /429/);

    // The tool the first model ran is still there, completed — the whole point.
    const completed = harness
      .updatesOf("tool_call_update")
      .filter((u) => (u.update as { status?: string }).status === "completed");
    assert.equal(completed.length, 1, "the finished tool call survived the hold");

    // The user changes the model on the running process, then continues.
    await ctx.request("session/set_config_option", { sessionId, configId: "model", value: "test-model-2" });
    await ctx.request("_daedalus/session/resume", { sessionId });

    const response = await turn;
    assert.equal(response.stopReason, "end_turn");
    const text = harness
      .updatesOf("agent_message_chunk")
      .map((u) => ((u.update as { content?: { text?: string } }).content?.text ?? ""))
      .join("");
    assert.equal(text, "done on the second model ", "the answer came from the model that was switched to");
    // The bash tool ran once: a hold continues a turn, it does not restart one.
    assert.equal(harness.updatesOf("tool_call").length, 1, "the tool was not run again");
    assert.ok(harness.holds.some((h) => !h.paused), "the release was announced too");

    /* What a `session/load` would hand back. The failed attempt must have left
       nothing: the user's words once, and no assistant message carrying a tool
       call whose result never arrived — the shape most providers reject, and
       what the JSONL used to keep for good because it is append-only. */
    const history = new SessionStore(heldEnv.home).read(sessionId)!;
    const userMessages = history.messages.filter((m) => m.role === "user");
    assert.equal(userMessages.length, 1, "the user's words are stored exactly once");
    assert.equal(
      history.updates.filter((u) => (u.update as { sessionUpdate?: string }).sessionUpdate === "user_message_chunk").length,
      1,
      "…and journaled exactly once",
    );
    const calls = new Set<string>();
    const results = new Set<string>();
    for (const m of history.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const part of m.content as { type?: string; toolCallId?: string }[]) {
        if (part.type === "tool-call" && part.toolCallId) calls.add(part.toolCallId);
        if (part.type === "tool-result" && part.toolCallId) results.add(part.toolCallId);
      }
    }
    assert.equal(calls.size, 1, "the one tool call that ran is kept");
    for (const id of calls) assert.ok(results.has(id), `tool call ${id} has no result in the stored history`);
  });
  console.log("turn: hold and continue on a new model ok");
}

// --- a step that failed with no error part still holds ---
{
  const agent = buildAgentApp({
    env: testEnv({ holdOnError: true }),
    makeModel: scriptedModel([
      // `finishReason: error` and nothing else: this used to end as `end_turn`.
      [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "half an ans" },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: { unified: "error", raw: "error" } as never, usage: usage(5, 2) },
      ],
      textScript("a whole answer "),
    ]),
  });
  const { app: client, harness } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    const turn = ctx.request("session/prompt", { sessionId, prompt: promptOf("go") }) as Promise<acp.PromptResponse>;
    await waitFor(() => harness.holds.some((h) => h.paused), "the failed finish to hold");
    await ctx.request("_daedalus/session/resume", { sessionId });
    const response = await turn;
    assert.equal(response.stopReason, "end_turn");
  });
  console.log("turn: a failed finish reason holds ok");
}

// --- a tool that fails is the model's problem, not the reader's ---
{
  const agent = buildAgentApp({
    env: testEnv({ holdOnError: true }),
    makeModel: scriptedModel([
      // `read_file` on a path that is not there — the tool throws.
      toolCallScript("read_file", { path: "definitely-not-here.txt" }),
      textScript("carried on alone "),
    ]),
  });
  const { app: client, harness } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    await ctx.request("session/set_mode", { sessionId, modeId: "bypassPermissions" });
    const response = await ctx.request("session/prompt", { sessionId, prompt: promptOf("read it") });
    /* The failure is drawn, handed back to the model, and worked around. A tool
       error is information the model is meant to see — holding on one would
       stop the turn on the thing the runtime already recovers from. */
    assert.equal(response.stopReason, "end_turn");
    assert.ok(
      harness.updatesOf("tool_call_update").some((u) => (u.update as { status?: string }).status === "failed"),
      "the failed tool call was recorded",
    );
    assert.equal(harness.holds.length, 0, "a tool failure does not hold the turn");
  });
  console.log("turn: a failed tool call does not hold ok");
}

// --- a held turn that is cancelled ends as cancelled, never as a failure ---
{
  const agent = buildAgentApp({
    env: testEnv({ holdOnError: true }),
    makeModel: scriptedModel([
      [
        { type: "stream-start", warnings: [] },
        { type: "error", error: new Error("model exploded") },
        { type: "finish", finishReason: { unified: "error", raw: "error" } as never, usage: usage(1, 0) },
      ],
      textScript("the next turn runs "),
    ]),
  });
  const { app: client, harness } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    const turn = ctx.request("session/prompt", { sessionId, prompt: promptOf("boom") }) as Promise<acp.PromptResponse>;
    await waitFor(() => harness.holds.some((h) => h.paused), "the turn to hold");
    await ctx.notify("session/cancel", { sessionId });
    const response = await turn;
    assert.equal(response.stopReason, "cancelled", "a Stop on a held turn is a cancel, not a failure");
    // The cancel let the hold go with the turn: the next prompt runs at once.
    const next = await ctx.request("session/prompt", { sessionId, prompt: promptOf("again") });
    assert.equal(next.stopReason, "end_turn");
  });
  console.log("turn: held then cancelled ok");
}

// --- provider error with holds off: the turn fails as a JSON-RPC error, not a hang ---
{
  const agent = buildAgentApp({
    /* `testEnv` leaves holds off, which is this case: a runtime nobody can
       release — an unattended thread, or a client that cannot resume — has to
       fail fast rather than wait forever. */
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
