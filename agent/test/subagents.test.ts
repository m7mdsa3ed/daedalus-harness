import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildAgentApp } from "../src/app.js";
import {
  FULL_CAPS,
  connectPair,
  initialize,
  makeClient,
  promptOf,
  scriptedModel,
  testEnv,
  textScript,
  toolCallScript,
} from "./helpers/scripted.js";

const cwd = mkdtempSync(join(tmpdir(), "daedalus-agent-cwd-"));

/* The RFD's one upsert, as the agent sends it on the parent's session. */
interface SubagentUpdate {
  sessionUpdate: "subagent_update";
  sessionId: string;
  title?: string | null;
  description?: string | null;
  capabilities?: { cancel?: unknown } | null;
  state?: { state: string; stopReason?: string; usage?: unknown } | null;
  cwd?: string | null;
  _meta?: Record<string, unknown> | null;
}

/* The child's step burns far more than the parent's final one on purpose: the
   numbers are what the usage assertions below read. Root call 28 + child 150 +
   root answer 15 = 193 total, and the parent's context gauge must read 15 —
   the child's 150 belong to the child's own window. */
const SCRIPTS = () => [
  toolCallScript("task", { description: "look things up", prompt: "find the thing" }, { input: 20, output: 8 }),
  textScript("child report: found it ", { input: 100, output: 50 }),
  textScript("Parent summary. ", { input: 10, output: 5 }),
];

// --- RFD negotiated: spawned → child-addressed updates → state update ---
{
  const agent = buildAgentApp({ env: testEnv(), makeModel: scriptedModel(SCRIPTS()) });
  const { app: client, harness } = makeClient();
  await connectPair(agent, client, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    const response = await ctx.request("session/prompt", { sessionId, prompt: promptOf("delegate") });
    assert.equal(response.stopReason, "end_turn");
    /* The turn's answer is the whole spend — the child's tokens included. */
    assert.equal(response.usage?.totalTokens, 193, `child usage joined the turn (got ${response.usage?.totalTokens})`);

    /* The lifecycle of a `task` child is the RFD's `subagent_update` on the
       parent, and nothing of the superseded draft pair: a spawn that names
       the child and says `running`, then an `idle` ending with its stop
       reason. The SDK's closed union carries this tag, so it travels on
       `session/update` itself. */
    const lifecycle = harness.updatesOf("subagent_update");
    assert.ok(lifecycle.every((u) => u.sessionId === sessionId), "every subagent_update is on the parent");
    assert.equal(harness.updatesOf("subagent_spawned").length, 0, "the draft spawn is gone");
    assert.equal(harness.updatesOf("subagent_state_update").length, 0, "the draft state update is gone");
    const frames = lifecycle.map((u) => u.update as SubagentUpdate);
    assert.equal(frames.length, 2, `spawn + ending (got ${JSON.stringify(frames.map((f) => f.state))})`);
    const spawn = frames[0]!;
    const childId = spawn.sessionId;
    assert.ok(childId);
    assert.equal(spawn.title, "look things up", "the spawn's title is the child's name");
    assert.equal(spawn.description, "find the thing", "the spawn's description is the brief");
    assert.deepEqual(spawn.state, { state: "running" });
    assert.equal(spawn.cwd, cwd, "the child reports where it works");
    assert.equal(
      (spawn._meta as { daedalus?: { model?: string } } | undefined)?.daedalus?.model,
      "test-model",
      "what the child runs on rides _meta",
    );
    const ending = frames[1]!;
    assert.equal(ending.sessionId, childId);
    assert.deepEqual(ending.state, { state: "idle", stopReason: "end_turn" });
    assert.equal(ending.title, undefined, "an ending restates nothing the spawn said");

    /* The parent's context gauge is the parent's own last step, never the
       child's: a child's 150-token step used to reset the parent's reading to
       itself mid-turn, which is what compaction thresholds against. */
    const rootUsage = harness
      .updatesOf("usage_update")
      .filter((u) => u.sessionId === sessionId)
      .map((u) => (u.update as { used?: number }).used);
    assert.equal(rootUsage.at(-1), 15, `parent gauge reads the parent's step (got ${rootUsage.at(-1)})`);
    const childUsage = harness
      .updatesOf("usage_update")
      .filter((u) => u.sessionId === childId)
      .map((u) => (u.update as { used?: number }).used);
    assert.deepEqual(childUsage, [150], "the child's step is reported on the child");

    const attributedUsage = harness
      .updatesOf("_daedalus/subagent_usage")
      .filter((u) => u.sessionId === sessionId)
      .map((u) => u.update as { subagentSessionId?: string; usage?: { totalTokens?: number } });
    assert.deepEqual(attributedUsage, [{
      sessionUpdate: "_daedalus/subagent_usage",
      subagentSessionId: childId,
      usage: {
        totalTokens: 150,
        inputTokens: 100,
        outputTokens: 50,
        thoughtTokens: null,
        cachedReadTokens: null,
        cachedWriteTokens: null,
      },
    }], "settled child usage is attributed to its parent card");

    const childChunks = harness
      .updatesOf("agent_message_chunk")
      .filter((u) => u.sessionId === childId);
    assert.ok(childChunks.length > 0, "child prose travels on the child session id");

    /* The card is the row. With the RFD negotiated the `task` call is not
       announced as a tool at all — the spawn carries the name and the brief,
       the child's own session carries the work and the report, and a tool row
       beside it was the same subagent drawn twice: the transcript showed a
       generic row holding the prompt and the whole report, and then the card
       holding both again. `announcesOwnSession` is what withholds it. */
    const taskRows = [...harness.updatesOf("tool_call"), ...harness.updatesOf("tool_call_update")].filter(
      (u) => u.sessionId === sessionId,
    );
    assert.equal(taskRows.length, 0, "the launch is the card, not a tool row beside it");
    // Chunk by chunk, so the phrase is only whole once they are joined.
    const childText = childChunks
      .map((u) => (u.update as { content?: { text?: string } }).content?.text ?? "")
      .join("");
    assert.ok(
      childText.includes("child report"),
      `the report is in the child's transcript, where the card draws it (got ${JSON.stringify(childText)})`,
    );
  });
  console.log("subagents: rfd ok");
}

// --- not negotiated: no RFD events leak, the report still arrives ---
{
  const agent = buildAgentApp({ env: testEnv(), makeModel: scriptedModel(SCRIPTS()) });
  const { app: client, harness } = makeClient();
  await connectPair(agent, client, async (ctx) => {
    const { subagents: _dropped, ...caps } = FULL_CAPS as Record<string, unknown>;
    await initialize(ctx, caps);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    const response = await ctx.request("session/prompt", { sessionId, prompt: promptOf("delegate") });
    assert.equal(response.stopReason, "end_turn");
    assert.equal(harness.updatesOf("subagent_update").length, 0);
    assert.equal(harness.updatesOf("subagent_spawned").length, 0);
    assert.equal(harness.updatesOf("subagent_state_update").length, 0);
    assert.ok(
      harness.updates.every((u) => u.sessionId === sessionId),
      "nothing is addressed to a session the client never learned about",
    );
    const taskDone = harness
      .updatesOf("tool_call_update")
      .find((u) => JSON.stringify(u.update).includes("child report"));
    assert.ok(taskDone);
  });
  console.log("subagents: fallback ok");
}

// --- send_message resumes the same saved child after a process restart ---
{
  const env = testEnv();
  const agent = buildAgentApp({
    env,
    makeModel: scriptedModel([
      toolCallScript("task", { description: "inspect source", prompt: "Inspect the source", model: "helper-model" }),
      textScript("Initial child notes. "),
      textScript("Initial parent summary. "),
    ]),
  });
  const { app: client, harness } = makeClient();
  let sessionId = "";
  let childId = "";
  await connectPair(agent, client, async (ctx) => {
    await initialize(ctx);
    ({ sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] }));
    await ctx.request("session/prompt", { sessionId, prompt: promptOf("delegate") });
    const spawned = harness.updatesOf("subagent_update")[0]?.update as SubagentUpdate | undefined;
    assert.ok(spawned?.sessionId);
    childId = spawned.sessionId;
  });

  const resumedAgent = buildAgentApp({
    env,
    makeModel: scriptedModel([
      toolCallScript("send_message", { agent: childId, message: "Continue and report the remaining findings." }),
      textScript("Follow-up child findings. "),
      textScript("Combined parent summary. "),
    ]),
  });
  const { app: resumedClient, harness: resumedHarness } = makeClient();
  await connectPair(resumedAgent, resumedClient, async (ctx) => {
    await initialize(ctx);
    await ctx.request("session/load", { sessionId, cwd, mcpServers: [] });
    const response = await ctx.request("session/prompt", {
      sessionId,
      prompt: promptOf("continue the child"),
    });
    assert.equal(response.stopReason, "end_turn");
    const resumedFrames = resumedHarness.updatesOf("subagent_update").map((u) => u.update as SubagentUpdate);
    const spawnedAgain = resumedFrames.find((f) => f.state?.state === "running");
    assert.equal(spawnedAgain?.sessionId, childId, "follow-up reuses the child identity");
    /* A follow-up restates the whole spawn: a server that has never seen the
       child (this one started after the first process) reads it as new. */
    assert.equal(spawnedAgain?.title, "inspect source");
    assert.equal(spawnedAgain?.description, "Inspect the source");
    /* send_message names no model: the child keeps the one it was spawned on,
       not the session's — a follow-up to the advisor is still the advisor's. */
    assert.equal(
      (spawnedAgain?._meta as { daedalus?: { model?: string } } | undefined)?.daedalus?.model,
      "helper-model",
      "follow-up runs on the child's model",
    );
    assert.deepEqual(resumedFrames.at(-1)?.state, { state: "idle", stopReason: "end_turn" });
    const continued = resumedHarness
      .updatesOf("agent_message_chunk")
      .filter((u) => u.sessionId === childId)
      .map((u) => (u.update as { content?: { text?: string } }).content?.text ?? "")
      .join("");
    assert.ok(continued.includes("Follow-up child findings."), `child continued: ${continued}`);
    const store = new (await import("../src/persistence.js")).SessionStore(env.home);
    const child = store.subagent(sessionId, childId);
    assert.equal(child?.status, "completed");
    assert.equal(child?.model, "helper-model", "the child's model is saved with it");
    assert.ok(child?.messages.some((message) => message.role === "user" && JSON.stringify(message).includes("Continue and report")));
    assert.ok(child?.messages.some((message) => message.role === "assistant" && JSON.stringify(message).includes("Initial child notes")));
    assert.ok(child?.messages.some((message) => message.role === "assistant" && JSON.stringify(message).includes("Follow-up child findings")));
  });
  console.log("subagents: send_message resume after restart ok");
}

// --- the server's translator passes the agent's frames through untouched ---
{
  /* The harness's canonical subagent shape is the RFD's `subagent_update`
     (`server/src/subagent-update.ts`): the agent's frames arrive on the SDK's
     typed path and are handed on as they are, while the superseded draft pair
     is what gets translated INTO them. The agent's frames are fed to that very
     module, so the two halves cannot drift apart without this failing: every
     frame must be recognised as the RFD shape, the translator must leave it
     byte-identical, and the stop reasons the agent spells must be the ones the
     server itself spells for a draft ending. Loaded by path and at runtime only
     — the server's sources are not this package's to typecheck, and a checkout
     without them skips the leg rather than failing it. */
  const here = dirname(fileURLToPath(import.meta.url));
  const translatorPath = resolve(here, "../../server/src/subagent-update.ts");
  if (!existsSync(translatorPath)) {
    console.log("subagents: translator round-trip skipped (server sources not beside the agent)");
  } else {
    /* Loaded by path, so nothing typechecks the cast below against the
       server's real exports: a file that is there but will not load, or that
       no longer exports these three names, FAILS the leg (never skips it),
       naming what moved. */
    type Translator = {
      translateDraftNotification: <T extends { update: { sessionUpdate: string } }>(n: T) => T;
      isRfdSubagentUpdate: (update: unknown) => boolean;
      endingSnapshot: (state: "completed" | "failed" | "cancelled" | "disconnected") => { state: string; stopReason?: string };
    };
    let translator: Partial<Record<keyof Translator, unknown>>;
    try {
      translator = (await import(pathToFileURL(translatorPath).href)) as Partial<Record<keyof Translator, unknown>>;
    } catch (error) {
      throw new Error(`subagents: ${translatorPath} exists but would not load — ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const name of ["translateDraftNotification", "isRfdSubagentUpdate", "endingSnapshot"] as const) {
      assert.equal(typeof translator[name], "function", `server/src/subagent-update.ts no longer exports ${name} — update this test`);
    }
    const { translateDraftNotification, isRfdSubagentUpdate, endingSnapshot } = translator as Translator;
    const agent = buildAgentApp({ env: testEnv(), makeModel: scriptedModel(SCRIPTS()) });
    const { app: client, harness } = makeClient();
    await connectPair(agent, client, async (ctx) => {
      await initialize(ctx);
      const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
      await ctx.request("session/prompt", { sessionId, prompt: promptOf("delegate") });
      const frames = harness.updatesOf("subagent_update");
      assert.ok(frames.length >= 2, "the task child announced itself and ended");
      for (const frame of frames) {
        assert.ok(isRfdSubagentUpdate(frame.update), "every frame is the RFD shape the server recognises");
        const out = translateDraftNotification(frame);
        assert.equal(out, frame, "the server's translator hands an RFD frame on as it is");
      }
      /* The endings the agent can send, each the exact snapshot the server
         itself spells for the matching draft ending — so a child of our
         runtime and a child of an older adapter read the same downstream. */
      const endings = frames
        .map((f) => f.update as SubagentUpdate)
        .filter((u) => u.state?.state === "idle");
      assert.deepEqual(endings.map((u) => u.state), [endingSnapshot("completed")], "end_turn is the server's completed");
      assert.deepEqual(endingSnapshot("failed"), { state: "idle", stopReason: "error" });
      assert.deepEqual(endingSnapshot("cancelled"), { state: "idle", stopReason: "cancelled" });
      /* The agent says usage on its own `_daedalus/subagent_usage`, never in
         `state.usage`, so nothing downstream reads it twice. */
      assert.ok(frames.every((f) => (f.update as SubagentUpdate).state?.usage === undefined));
    });
    console.log("subagents: translator round-trip ok");
  }
}

console.log("subagents.test.ts passed");
