import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    const spawned = harness.updatesOf("subagent_spawned");
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0]?.sessionId, sessionId, "spawned announced on the parent");
    const childId = (spawned[0]?.update as { subagentSessionId?: string }).subagentSessionId;
    assert.ok(childId);

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

    const childChunks = harness
      .updatesOf("agent_message_chunk")
      .filter((u) => u.sessionId === childId);
    assert.ok(childChunks.length > 0, "child prose travels on the child session id");

    const state = harness.updatesOf("subagent_state_update");
    assert.equal((state.at(-1)?.update as { state?: string }).state, "completed");

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

console.log("subagents.test.ts passed");
