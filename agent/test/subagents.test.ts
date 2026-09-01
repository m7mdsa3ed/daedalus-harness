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

const SCRIPTS = () => [
  toolCallScript("task", { description: "look things up", prompt: "find the thing" }),
  textScript("child report: found it "),
  textScript("Parent summary. "),
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

    const spawned = harness.updatesOf("subagent_spawned");
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0]?.sessionId, sessionId, "spawned announced on the parent");
    const childId = (spawned[0]?.update as { subagentSessionId?: string }).subagentSessionId;
    assert.ok(childId);

    const childChunks = harness
      .updatesOf("agent_message_chunk")
      .filter((u) => u.sessionId === childId);
    assert.ok(childChunks.length > 0, "child prose travels on the child session id");

    const state = harness.updatesOf("subagent_state_update");
    assert.equal((state.at(-1)?.update as { state?: string }).state, "completed");

    const taskDone = harness
      .updatesOf("tool_call_update")
      .find(
        (u) =>
          u.sessionId === sessionId &&
          (u.update as { status?: string }).status === "completed" &&
          JSON.stringify(u.update).includes("child report"),
      );
    assert.ok(taskDone, "the parent tool result carries the child's report");
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
