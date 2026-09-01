import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentApp } from "../src/app.js";
import {
  initialize,
  makeClient,
  promptOf,
  scriptedModel,
  testEnv,
  textScript,
} from "./helpers/scripted.js";

const cwd = mkdtempSync(join(tmpdir(), "daedalus-agent-cwd-"));
const env = testEnv();

// --- a turn is journaled; a second process loads and replays it ---
let sessionId = "";
{
  const agent = buildAgentApp({
    env,
    makeModel: scriptedModel([textScript("The answer is 42. ")]),
  });
  const { app: client } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const created = await ctx.request("session/new", { cwd, mcpServers: [] });
    sessionId = created.sessionId;
    await ctx.request("session/prompt", {
      sessionId,
      prompt: promptOf("what is the answer?"),
    });
  });
}

{
  // A fresh app over the same home is "the process restarted".
  const agent = buildAgentApp({ env, makeModel: scriptedModel([]) });
  const { app: client, harness } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const loaded = await ctx.request("session/load", { sessionId, cwd, mcpServers: [] });
    assert.ok(loaded.modes);

    // Replay carried the user's words and the coalesced answer, in order.
    const kinds = harness.updates.map((u) => (u.update as { sessionUpdate: string }).sessionUpdate);
    assert.ok(kinds.includes("user_message_chunk"), `got ${kinds}`);
    assert.ok(kinds.includes("agent_message_chunk"));
    const text = harness
      .updatesOf("agent_message_chunk")
      .map((u) => (u.update as { content?: { text?: string } }).content?.text ?? "")
      .join("");
    assert.equal(text, "The answer is 42. ");
    assert.ok(
      kinds.indexOf("user_message_chunk") < kinds.indexOf("agent_message_chunk"),
      "user before agent",
    );

    // The listing knows the session, its cwd and a title.
    const listed = await ctx.request("session/list", {});
    const entry = listed.sessions.find((s) => s.sessionId === sessionId);
    assert.ok(entry);
    assert.equal(entry.cwd, cwd);
    assert.equal(entry.title, "what is the answer?");

    // The cwd filter is real.
    const elsewhere = await ctx.request("session/list", { cwd: "/nonexistent" });
    assert.equal(elsewhere.sessions.length, 0);

    // An unknown id is a refusal, not a hang or an empty session.
    await assert.rejects(
      ctx.request("session/load", { sessionId: "no-such-session", cwd, mcpServers: [] }),
    );
  });
  console.log("persistence: load + list ok");
}

// --- a loaded session can keep talking: history reached the model ---
{
  let sawMessages = 0;
  const agent = buildAgentApp({
    env,
    makeModel: (agentEnv, modelId) => {
      const factory = scriptedModel([textScript("Continued. ")]);
      const model = factory(agentEnv, modelId);
      return new Proxy(model as object, {
        get(target, prop, receiver) {
          if (prop === "doStream") {
            return async (options: { prompt: unknown[] }) => {
              sawMessages = options.prompt.length;
              return (target as { doStream: (o: unknown) => unknown }).doStream(options);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as never;
    },
  });
  const { app: client } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    await ctx.request("session/load", { sessionId, cwd, mcpServers: [] });
    const response = await ctx.request("session/prompt", { sessionId, prompt: promptOf("go on") });
    assert.equal(response.stopReason, "end_turn");
    // system is separate; the prompt carries prior user+assistant plus the new ask
    assert.ok(sawMessages >= 3, `model saw ${sawMessages} messages`);
  });
  console.log("persistence: continue after load ok");
}

console.log("persistence.test.ts passed");
