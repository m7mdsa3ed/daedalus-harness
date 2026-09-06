import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  toolCallScript,
} from "./helpers/scripted.js";

function freshCwd(): string {
  return mkdtempSync(join(tmpdir(), "daedalus-agent-cwd-"));
}

// --- read: no permission needed, kind read, contents in the update ---
{
  const cwd = freshCwd();
  writeFileSync(join(cwd, "hello.txt"), "hello from disk\n");
  const agent = buildAgentApp({
    env: testEnv(),
    makeModel: scriptedModel([toolCallScript("read_file", { path: "hello.txt" }), textScript("Read it. ")]),
  });
  const { app: client, harness } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    await ctx.request("session/prompt", { sessionId, prompt: promptOf("read hello.txt") });
    assert.equal(harness.permissionRequests.length, 0, "read asks nobody");

    const calls = harness.updatesOf("tool_call");
    assert.equal((calls[0]?.update as { kind?: string }).kind, "read");
    const done = harness
      .updatesOf("tool_call_update")
      .find((u) => (u.update as { status?: string }).status === "completed");
    assert.ok(JSON.stringify(done?.update).includes("hello from disk"));
  });
  console.log("tools: read ok");
}

// --- write: asks permission (kind edit), emits a diff, writes the file ---
{
  const cwd = freshCwd();
  const agent = buildAgentApp({
    env: testEnv(),
    makeModel: scriptedModel([
      toolCallScript("write_file", { path: "out.txt", content: "written by agent" }),
      textScript("Wrote it. "),
    ]),
  });
  const { app: client, harness } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    harness.answerPermission("allow");
    await ctx.request("session/prompt", { sessionId, prompt: promptOf("write out.txt") });

    assert.equal(harness.permissionRequests.length, 1);
    assert.equal(harness.permissionRequests[0]?.toolCall.kind, "edit");
    const kinds = harness.permissionRequests[0]?.options.map((o) => o.kind);
    assert.deepEqual(kinds, ["allow_once", "allow_always", "reject_once", "reject_always"]);

    assert.equal(readFileSync(join(cwd, "out.txt"), "utf8"), "written by agent");
    const withDiff = harness
      .updatesOf("tool_call_update")
      .find((u) => JSON.stringify(u.update).includes('"diff"'));
    assert.ok(withDiff, "a diff content update was emitted");
  });
  console.log("tools: write ok");
}

// --- reject: the tool fails, the file stays, the turn still ends cleanly ---
{
  const cwd = freshCwd();
  const agent = buildAgentApp({
    env: testEnv(),
    makeModel: scriptedModel([
      toolCallScript("write_file", { path: "never.txt", content: "nope" }),
      textScript("Understood, not writing. "),
    ]),
  });
  const { app: client, harness } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    harness.answerPermission("reject");
    const response = await ctx.request("session/prompt", { sessionId, prompt: promptOf("try") });
    assert.equal(response.stopReason, "end_turn");
    assert.ok(!existsSync(join(cwd, "never.txt")));
    const failed = harness
      .updatesOf("tool_call_update")
      .find((u) => (u.update as { status?: string }).status === "failed");
    assert.ok(JSON.stringify(failed?.update).includes("rejected"));
  });
  console.log("tools: reject ok");
}

// --- acceptEdits: edits run without asking; sticky always-allow works for bash ---
{
  const cwd = freshCwd();
  writeFileSync(join(cwd, "twice.txt"), "one");
  const agent = buildAgentApp({
    env: testEnv(),
    makeModel: scriptedModel([
      toolCallScript("edit_file", { path: "twice.txt", old_string: "one", new_string: "two" }),
      toolCallScript("bash", { command: "echo first" }, { id: "call-2" }),
      toolCallScript("bash", { command: "echo second" }, { id: "call-3" }),
      textScript("Done. "),
    ]),
  });
  const { app: client, harness } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    await ctx.request("session/set_mode", { sessionId, modeId: "acceptEdits" });
    harness.answerPermission("allow_always");
    await ctx.request("session/prompt", { sessionId, prompt: promptOf("edit then run") });
    // The edit asked nothing; bash asked once and the always answer stuck.
    assert.equal(harness.permissionRequests.length, 1);
    assert.equal(harness.permissionRequests[0]?.toolCall.kind, "execute");
    assert.equal(readFileSync(join(cwd, "twice.txt"), "utf8"), "two");
  });
  console.log("tools: acceptEdits + always ok");
}

// --- bash streams terminal deltas through _meta ---
{
  const cwd = freshCwd();
  const agent = buildAgentApp({
    env: testEnv(),
    makeModel: scriptedModel([
      toolCallScript("bash", { command: "echo streamed-output-marker" }),
      textScript("Ran. "),
    ]),
  });
  const { app: client, harness } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    await ctx.request("session/set_mode", { sessionId, modeId: "bypassPermissions" });
    await ctx.request("session/prompt", { sessionId, prompt: promptOf("run") });
    assert.equal(harness.permissionRequests.length, 0, "bypass asks nobody");
    const delta = harness
      .updatesOf("tool_call_update")
      .find((u) =>
        String(
          ((u.update as { _meta?: { terminal_output_delta?: { data?: string } } })._meta
            ?.terminal_output_delta?.data) ?? "",
        ).includes("streamed-output-marker"),
      );
    assert.ok(delta, "terminal delta carried the output");
  });
  console.log("tools: bash terminal ok");
}

// --- write_todos becomes a plan update; ask_user becomes an elicitation ---
{
  const cwd = freshCwd();
  const agent = buildAgentApp({
    env: testEnv(),
    makeModel: scriptedModel([
      toolCallScript("write_todos", {
        todos: [
          { content: "explore", status: "completed" },
          { content: "implement", status: "in_progress" },
        ],
      }),
      toolCallScript(
        "ask_user",
        {
          questions: [
            { question: "Which approach?", options: [{ label: "A" }, { label: "B" }] },
          ],
        },
        { id: "call-2" },
      ),
      textScript("Going with A. "),
    ]),
  });
  const { app: client, harness } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    harness.answerElicitation({ action: "accept", content: { q1: "A" } });
    await ctx.request("session/prompt", { sessionId, prompt: promptOf("plan then ask") });

    const plans = harness.updatesOf("plan");
    assert.equal(
      (plans[0]?.update as { entries?: { content: string }[] }).entries?.length,
      2,
    );
    assert.equal(harness.elicitations.length, 1);
    const schema = JSON.stringify(harness.elicitations[0]);
    assert.ok(schema.includes("Which approach?") && schema.includes('"const":"A"'));
  });
  console.log("tools: plan + ask_user ok");
}

// --- plan mode: nothing that writes is even offered ---
{
  const cwd = freshCwd();
  writeFileSync(join(cwd, "peek.txt"), "readable in plan mode");
  const agent = buildAgentApp({
    env: testEnv(),
    makeModel: scriptedModel([toolCallScript("read_file", { path: "peek.txt" }), textScript("Plan: … ")]),
  });
  const { app: client, harness } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    await ctx.request("session/set_mode", { sessionId, modeId: "plan" });
    const response = await ctx.request("session/prompt", { sessionId, prompt: promptOf("look around") });
    assert.equal(response.stopReason, "end_turn");
    assert.equal(harness.permissionRequests.length, 0);
  });
  console.log("tools: plan mode ok");
}

console.log("tools.test.ts passed");
