import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentApp } from "../src/app.js";
import { SessionStore } from "../src/persistence.js";
import type { UpdateParams } from "../src/types.js";
import {
  connectPair,
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
  await connectPair(agent, client, async (ctx) => {
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
  await connectPair(agent, client, async (ctx) => {
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

// --- resume restores the same session without narrating it ---
{
  const agent = buildAgentApp({ env, makeModel: scriptedModel([]) });
  const { app: client, harness } = makeClient();
  await connectPair(agent, client, async (ctx) => {
    const init = await initialize(ctx);
    assert.ok(init.agentCapabilities?.sessionCapabilities?.resume, "resume advertised");
    const resumed = await ctx.request("session/resume", { sessionId, cwd, mcpServers: [] });
    assert.ok(resumed.modes);
    const narrated = harness.updates.filter((u) =>
      ["user_message_chunk", "agent_message_chunk"].includes((u.update as { sessionUpdate: string }).sessionUpdate),
    );
    assert.equal(narrated.length, 0, "resume replays nothing");
    await assert.rejects(ctx.request("session/resume", { sessionId: "no-such-session", cwd, mcpServers: [] }));
  });
  console.log("persistence: resume ok");
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
  await connectPair(agent, client, async (ctx) => {
    await initialize(ctx);
    await ctx.request("session/load", { sessionId, cwd, mcpServers: [] });
    const response = await ctx.request("session/prompt", { sessionId, prompt: promptOf("go on") });
    assert.equal(response.stopReason, "end_turn");
    // system is separate; the prompt carries prior user+assistant plus the new ask
    assert.ok(sawMessages >= 3, `model saw ${sawMessages} messages`);
  });
  console.log("persistence: continue after load ok");
}

// --- session/fork: the log cut at a message id, loadable by a fresh process ---
{
  const agent = buildAgentApp({
    env,
    makeModel: scriptedModel([textScript("First. "), textScript("Second. ")]),
  });
  const { app: client, harness } = makeClient();
  let forkedAt = "";
  let forkedTip = "";
  await connectPair(agent, client, async (ctx) => {
    await initialize(ctx);
    const created = await ctx.request("session/new", { cwd, mcpServers: [] });
    const sid = created.sessionId as string;
    await ctx.request("session/prompt", { sessionId: sid, prompt: promptOf("turn one") });
    /* The fork point the harness would cut at is the last messageId the turn
       produced — the live chunks carry it, one id per message block. */
    const turnOne = harness
      .updatesOf("agent_message_chunk")
      .map((u) => (u.update as { messageId?: string }).messageId);
    const point = turnOne.at(-1);
    assert.ok(point, "turn one produced a message id");
    await ctx.request("session/prompt", { sessionId: sid, prompt: promptOf("turn two") });

    const forkParams = (messageId?: string) => ({
      sessionId: sid,
      cwd,
      mcpServers: [],
      ...(messageId === undefined ? {} : { _meta: { jetbrains: { air: { fork: { version: 1, messageId } } } } }),
    });
    const at = (await ctx.request("session/fork", forkParams(point))) as { sessionId: string };
    assert.ok(typeof at.sessionId === "string" && at.sessionId !== sid);
    forkedAt = at.sessionId;
    // No point = the spec's fork-at-tip: everything, no cut.
    const tip = (await ctx.request("session/fork", forkParams())) as { sessionId: string };
    assert.ok(typeof tip.sessionId === "string" && tip.sessionId !== sid);
    forkedTip = tip.sessionId;
    // A point nothing carries is a refusal, not a fork at nothing.
    await assert.rejects(ctx.request("session/fork", forkParams("no-such-message")));
  });

  // A fresh process over the same home loads the fork and sees the cut.
  const seen: string[] = [];
  const reader = buildAgentApp({
    env,
    makeModel: (agentEnv, modelId) => {
      const model = scriptedModel([textScript("Third. ")])(agentEnv, modelId);
      return new Proxy(model as object, {
        get(target, prop, receiver) {
          if (prop === "doStream") {
            return async (options: { prompt: { content?: unknown }[] }) => {
              for (const m of options.prompt) seen.push(JSON.stringify(m.content));
              return (target as { doStream: (o: unknown) => unknown }).doStream(options);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as never;
    },
  });
  const { app: readerClient, harness: readerHarness } = makeClient();
  await connectPair(reader, readerClient, async (ctx) => {
    await initialize(ctx);
    await ctx.request("session/load", { sessionId: forkedAt, cwd, mcpServers: [] });
    const replay = readerHarness
      .updatesOf("agent_message_chunk")
      .map((u) => (u.update as { content?: { text?: string } }).content?.text ?? "")
      .join("");
    assert.equal(replay, "First. ", `the fork carries turn one only, got ${JSON.stringify(replay)}`);

    // The fork keeps talking: the model sees the cut history, not the whole.
    await ctx.request("session/prompt", { sessionId: forkedAt, prompt: promptOf("go on") });
    const flat = seen.join("\n");
    assert.ok(flat.includes("First."), "the model saw the kept half");
    assert.ok(!flat.includes("Second."), "the model did not see past the cut");

    // The tip fork carries everything, and the listing knows both forks.
    await ctx.request("session/load", { sessionId: forkedTip, cwd, mcpServers: [] });
    const tipReplay = readerHarness
      .updatesOf("agent_message_chunk")
      .map((u) => (u.update as { content?: { text?: string } }).content?.text ?? "")
      .join("");
    assert.ok(tipReplay.includes("Second."), `the tip fork carries the whole log, got ${JSON.stringify(tipReplay)}`);
    const listed = await ctx.request("session/list", {});
    assert.ok(listed.sessions.some((s: { sessionId: string }) => s.sessionId === forkedAt));
    assert.ok(listed.sessions.some((s: { sessionId: string }) => s.sessionId === forkedTip));
  });
  console.log("persistence: session/fork ok");
}

// --- read() reports the last journaled root usage, and delete() removes a session ---
{
  const home = mkdtempSync(join(tmpdir(), "daedalus-agent-home-"));
  const store = new SessionStore(home);
  const id = "11111111-1111-4111-8111-111111111111";
  const child = "22222222-2222-4222-8222-222222222222";
  store.create(id, cwd);
  const usageUpdate = (sessionId: string, used: number): UpdateParams => ({
    sessionId,
    update: { sessionUpdate: "usage_update", used, size: 200_000 },
  });
  store.appendUpdate(id, usageUpdate(id, 90_000));
  /* A subagent's step is journaled into the same file, addressed to the child
     id — its context is a fraction of the parent's and must not be read back
     as the parent's. */
  store.appendUpdate(id, usageUpdate(child, 4_000));
  store.appendUpdate(id, usageUpdate(id, 150_000));
  store.createSubagent(id, {
    id: child,
    name: "reviewer",
    task: "Inspect the API",
    status: "running",
  });
  store.appendSubagentMessages(id, child, [{ role: "user", content: "Inspect the API" }]);
  store.setSubagentStatus(id, child, "stopped");

  const read = store.read(id);
  assert.equal(read?.lastTokens, 150_000, "the last root usage_update is the reading");
  assert.deepEqual(store.subagent(id, "reviewer"), {
    id: child,
    name: "reviewer",
    task: "Inspect the API",
    status: "stopped",
    messages: [{ role: "user", content: "Inspect the API" }],
  });

  assert.ok(store.delete(id), "delete reports a session it removed");
  assert.equal(store.read(id), null, "the log is gone");
  assert.equal(store.list(cwd, null).sessions.length, 0, "the listing no longer shows it");
  // A fresh store over the same home is the next process: still gone.
  assert.equal(new SessionStore(home).has(id), false, "the index flush landed");
  assert.equal(store.delete(id), false, "deleting nothing again is reported");
  console.log("persistence: lastTokens on read + delete ok");
}

console.log("persistence.test.ts passed");
