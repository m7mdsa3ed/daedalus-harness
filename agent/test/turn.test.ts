import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "../src/acp.js";
import { APICallError } from "@ai-sdk/provider";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
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

    /* The prompt split rides the same event. `used` is the provider's own
       prompt total, so the conversation is what is left of it once the two
       counted static parts come out — the parts must sum back to the headline
       figure rather than to a second, independently guessed one. */
    const meta = (usageUpdates.at(-1)?.update as { _meta?: Record<string, unknown> })._meta;
    const split = (meta?.breakdown ?? null) as null | Record<string, number>;
    assert.ok(split, "a measured prompt carries its breakdown");
    assert.equal(split.total, 15, "the total is the provider's prompt figure");
    assert.ok(split.system > 0, "the system prompt is counted");
    assert.ok(split.tools > 0, "the tool block is counted");
    assert.equal(
      split.system + split.tools + split.mcp + split.user + split.assistant + split.results,
      split.total,
      "the split sums back to the total",
    );
    /* The first step of an attempt names what the prefix is made of. */
    const items = (split as unknown as { items?: { system: { name: string }[]; tools: unknown[] } }).items;
    assert.ok(items?.system.some((item) => item.name.startsWith("Core instructions")), "system sections ride the first step");
    assert.ok((items?.tools.length ?? 0) > 0, "and each tool's definition");
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

// --- a steer that lands after the last step still gets read, not stranded ---
{
  /* The bug this covers: a steer arriving after the final `prepareStep` — the
     model had already streamed its answer, so no boundary is left to read it —
     used to be pushed into the history for the *next* turn while the running
     one ended. The harness draws a held steer's bubble at turn end, so the
     user saw their words land as part of a turn that never acted on them, and
     no new turn followed. The turn must read one more step instead. */
  let calls = 0;
  const promptsSeen: string[] = [];
  const agent = buildAgentApp({
    env: testEnv(),
    makeModel: () =>
      new MockLanguageModelV4({
        doStream: async (params) => {
          calls += 1;
          promptsSeen.push(JSON.stringify(params.prompt));
          /* The first step stalls before streaming — the window a late steer
             arrives in: `turnActive` is true and no `prepareStep` runs again. */
          if (calls === 1) await new Promise((r) => setTimeout(r, 300));
          return {
            stream: convertArrayToReadableStream(
              calls === 1 ? textScript("first answer ") : textScript("second answer "),
            ),
          };
        },
      }),
  });
  const { app: client, harness } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    const first = ctx.request("session/prompt", { sessionId, prompt: promptOf("start") });
    await new Promise((r) => setTimeout(r, 100));
    const steer = ctx.request("session/prompt", { sessionId, prompt: promptOf("late thought") });
    const [a, b] = await Promise.all([first, steer]);
    assert.equal(a.stopReason, "end_turn");
    assert.equal(b.stopReason, "end_turn");
    assert.equal(calls, 2, "the late steer should drive a second model step");
    assert.ok(promptsSeen[1]?.includes("late thought"), "the second step must carry the steer");
    const text = harness
      .updatesOf("agent_message_chunk")
      .map((u) => ((u.update as { content?: { text?: string } }).content?.text ?? ""))
      .join("");
    assert.ok(text.includes("second answer"), "the model must answer after the steer");
  });
  console.log("turn: a late steer is read, not stranded ok");
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

// --- a 429 is retried by the harness, announced, and never held ---
{
  const rateLimited = new APICallError({
    message: "rate limit exceeded, retry after a brief wait",
    url: "http://provider/chat/completions",
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: { "retry-after": "0" },
  });
  const agent = buildAgentApp({
    env: testEnv({ holdOnError: true }),
    makeModel: scriptedModel([
      [
        { type: "stream-start", warnings: [] },
        { type: "error", error: rateLimited },
        { type: "finish", finishReason: { unified: "error", raw: "error" } as never, usage: usage(1, 0) },
      ],
      textScript("after the retry "),
    ]),
  });
  const { app: client, harness } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    const response = await ctx.request("session/prompt", { sessionId, prompt: promptOf("go") });
    assert.equal(response.stopReason, "end_turn");
    assert.equal(harness.holds.length, 0, "a retriable provider error is retried, not held");
    assert.equal(harness.retries[0]?.attempt, 1, "the retry was announced before its backoff");
    assert.match(harness.retries[0]?.message ?? "", /rate limit/);
    assert.equal(harness.retries.at(-1)?.attempt, null, "and taken back once the attempt worked");
  });
  console.log("turn: a 429 is retried, not held ok");
}

// --- a wall that will not move is held at once, not retried into ---
{
  const capped = new APICallError({
    message: "Usage limit reached for 5 hour. Your limit will reset at 18:30",
    url: "http://provider/chat/completions",
    requestBodyValues: {},
    statusCode: 429,
  });
  const agent = buildAgentApp({
    env: testEnv({ holdOnError: true }),
    makeModel: scriptedModel([
      [
        { type: "stream-start", warnings: [] },
        { type: "error", error: capped },
        { type: "finish", finishReason: { unified: "error", raw: "error" } as never, usage: usage(1, 0) },
      ],
      textScript("after the resume "),
    ]),
  });
  const { app: client, harness } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    const turn = ctx.request("session/prompt", { sessionId, prompt: promptOf("go") }) as Promise<acp.PromptResponse>;
    await waitFor(() => harness.holds.some((h) => h.paused), "the usage cap to hold", 1_000);
    assert.equal(harness.retries.length, 0, "a usage cap is not worth a retry");
    await ctx.request("_daedalus/session/resume", { sessionId });
    assert.equal((await turn).stopReason, "end_turn");
  });
  console.log("turn: a usage cap holds at once ok");
}

// --- a 400 is the request, not the moment: held at once, and said in full ---
{
  /* The real one, from a gateway whose ceiling is below what the profile's
     catalog claimed the model's output limit was. One line, ~230 characters,
     and the part that says *which* parameter is at the end of it — which is
     what a 200-character headline with nothing behind it threw away. */
  const tooBig = new APICallError({
    message:
      '[commandcode/deepseek/deepseek-v4.1-flash] [400]: Invalid request error. Often missing required parameters or typo. ' +
      'HINT: Validation error: Too big: expected number to be <=200000 at "params.max_tokens"',
    url: "http://provider/chat/completions",
    requestBodyValues: {},
    statusCode: 400,
  });
  const agent = buildAgentApp({
    env: testEnv({ holdOnError: true }),
    makeModel: scriptedModel([
      [
        { type: "stream-start", warnings: [] },
        { type: "error", error: tooBig },
        { type: "finish", finishReason: { unified: "error", raw: "error" } as never, usage: usage(1, 0) },
      ],
      textScript("after the fix "),
    ]),
  });
  const { app: client, harness } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    const turn = ctx.request("session/prompt", { sessionId, prompt: promptOf("go") }) as Promise<acp.PromptResponse>;
    await waitFor(() => harness.holds.some((h) => h.paused), "the 400 to hold", 1_000);
    // Four backoffs re-sending bytes the provider already rejected as invalid
    // is a minute of silence in front of the same hold.
    assert.equal(harness.retries.length, 0, "an invalid request is not retried");
    const hold = harness.holds.find((h) => h.paused)!;
    assert.ok((hold.message ?? "").endsWith("…"), "the headline is cut to a headline's length");
    assert.match(hold.detail ?? "", /params\.max_tokens/, "…and the cut text is kept whole underneath");
    await ctx.request("_daedalus/session/resume", { sessionId });
    assert.equal((await turn).stopReason, "end_turn");
  });
  console.log("turn: a 400 holds at once and keeps its whole message ok");
}

// --- a 400 relayed under a 503 is still the request, not the moment ---
{
  /* The same wall as above, as the local combo gateway actually sends it: the
     upstream 400 smuggled into the message body, the relay's own 503 on the
     status line and a `retry-after: 30` that would book four 30s backoffs of
     re-sending bytes the provider had already rejected as invalid. */
  const relayed = new APICallError({
    message:
      '[commandcode/deepseek/deepseek-v4.1-flash] [400]: Invalid request error. Often missing required parameters or typo. ' +
      'HINT: Validation error: Too big: expected number to be <=200000 at "params.max_tokens" (reset after 30s)',
    url: "http://provider/chat/completions",
    requestBodyValues: {},
    statusCode: 503,
    responseHeaders: { "retry-after": "30" },
  });
  const agent = buildAgentApp({
    env: testEnv({ holdOnError: true }),
    makeModel: scriptedModel([
      [
        { type: "stream-start", warnings: [] },
        { type: "error", error: relayed },
        { type: "finish", finishReason: { unified: "error", raw: "error" } as never, usage: usage(1, 0) },
      ],
      textScript("after the fix "),
    ]),
  });
  const { app: client, harness } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    const turn = ctx.request("session/prompt", { sessionId, prompt: promptOf("go") }) as Promise<acp.PromptResponse>;
    await waitFor(() => harness.holds.some((h) => h.paused), "the relayed 400 to hold", 1_000);
    assert.equal(harness.retries.length, 0, "a relayed invalid request is not retried despite the 503");
    await ctx.request("_daedalus/session/resume", { sessionId });
    assert.equal((await turn).stopReason, "end_turn");
  });
  console.log("turn: a 400 relayed as a 503 holds at once ok");
}

// --- an image attachment reaches the provider as a content part ---
{
  /* The bridge sends an image as an ACP `image` block only because this
     runtime advertises `promptCapabilities.image` (app.ts); a `false` there
     degrades every image to a file path before `modalities` is consulted, and
     the model sees prose about a screenshot instead of the screenshot. Even
     with the flag on, a block the loop cannot convert is dropped — so both
     halves are asserted here: the capability the harness reads, and the part
     the provider receives. */
  const model = new MockLanguageModelV4({
    doStream: async () => ({ stream: convertArrayToReadableStream(textScript("I see it. ")) }),
  });
  const agent = buildAgentApp({ env: testEnv(), makeModel: () => model });
  const { app: client } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    const init = await initialize(ctx);
    assert.equal(
      init.agentCapabilities?.promptCapabilities?.image,
      true,
      "the runtime claims it can carry an image",
    );
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    await ctx.request("session/prompt", {
      sessionId,
      prompt: [
        { type: "text", text: "what is this?" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
    });
    const prompt = model.doStreamCalls.at(-1)?.prompt ?? [];
    const user = prompt.find((m) => m.role === "user") as { content: unknown[] } | undefined;
    const parts = Array.isArray(user?.content) ? user.content : [];
    const image = parts.find((p) => (p as { type?: string }).type === "file") as
      | { mediaType?: string; data?: { data?: unknown } }
      | undefined;
    assert.equal(image?.mediaType, "image/png", "the image rides as a file part");
    /* The SDK tags raw bytes `{ type: "data", data }` on the way to the
       provider (the file part's data is a union of data/url/text). */
    assert.equal(image?.data?.data, "aGVsbG8=", "with its base64 payload intact");
    assert.ok(
      parts.some((p) => (p as { type?: string }).type === "text"),
      "and the prose is still there beside it",
    );
  });
  console.log("turn: an image attachment reaches the provider ok");
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

// --- a steer carries its image blocks, not just its prose ---
{
  /* The bug this covers: a prompt landing mid-turn was flattened to its text,
     so an attached screenshot reached the model as the `[attached: …]` line and
     nothing else — the harness had already decided to inline the bytes, and the
     model was told a screenshot was there and never given it.

     The first step is a tool call, which is what guarantees a second step (and
     so a `prepareStep` for the steer to be drained at) without racing a timer. */
  let calls = 0;
  const promptsSeen: string[] = [];
  const agent = buildAgentApp({
    env: testEnv(),
    makeModel: () =>
      new MockLanguageModelV4({
        doStream: async (params) => {
          calls += 1;
          promptsSeen.push(JSON.stringify(params.prompt));
          return {
            stream: convertArrayToReadableStream(
              calls === 1
                ? toolCallScript("bash", { command: "sleep 0.4; echo done" })
                : textScript("answer "),
            ),
          };
        },
      }),
  });
  const { app: client } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    await ctx.request("session/set_mode", { sessionId, modeId: "bypassPermissions" });
    const first = ctx.request("session/prompt", { sessionId, prompt: promptOf("start") });
    await new Promise((r) => setTimeout(r, 150));
    const steer = ctx.request("session/prompt", {
      sessionId,
      prompt: [
        ...promptOf("look at this"),
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      ],
    });
    await Promise.all([first, steer]);
    assert.ok(
      promptsSeen.slice(1).some((p) => p.includes("iVBORw0KGgo=")),
      "the steer must carry its image bytes to the model",
    );
  });
  console.log("turn: steered image ok");
}

// --- step ids: calls from one model request share an id, a later request has its own ---
{
  const twoCalls: ReturnType<typeof toolCallScript> = [
    { type: "stream-start", warnings: [] },
    ...["a", "b"].flatMap((id) => [
      { type: "tool-input-start" as const, id, toolName: "bash" },
      { type: "tool-input-end" as const, id },
      { type: "tool-call" as const, toolCallId: id, toolName: "bash", input: JSON.stringify({ command: "true" }) },
    ]),
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_calls" } as never,
      usage: usage(20, 8),
    },
  ];
  const agent = buildAgentApp({
    env: testEnv(),
    makeModel: scriptedModel([twoCalls, toolCallScript("bash", { command: "true" }, { id: "c" }), textScript("done ")]),
  });
  const { app: client, harness } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    await ctx.request("session/set_mode", { sessionId, modeId: "bypassPermissions" });
    await ctx.request("session/prompt", { sessionId, prompt: promptOf("run them") });
    const stepOf = (id: string): string | undefined => {
      for (const u of harness.updatesOf("tool_call")) {
        const call = u.update as { toolCallId?: string; _meta?: { daedalus?: { stepId?: string } } };
        if (call.toolCallId === id) return call._meta?.daedalus?.stepId;
      }
      return undefined;
    };
    assert.ok(stepOf("a"), "a call carries its request's step id");
    assert.equal(stepOf("a"), stepOf("b"), "parallel calls from one request share it");
    assert.notEqual(stepOf("a"), stepOf("c"), "the next request has its own");
    // The id rides the update that carries the arguments too, so a client that
    // only sees `tool_call_update` for a call still learns it.
    const updated = harness
      .updatesOf("tool_call_update")
      .some((u) => (u.update as { toolCallId?: string; _meta?: { daedalus?: { stepId?: string } } }).toolCallId === "b" &&
        (u.update as { _meta?: { daedalus?: { stepId?: string } } })._meta?.daedalus?.stepId === stepOf("b"));
    assert.ok(updated, "the in-progress update repeats the step id");
  });
  console.log("turn: step ids ok");
}
