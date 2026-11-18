import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { buildAgentApp } from "../src/app.js";
import { replAvailable } from "../src/tools/repl.js";
import {
  connectPair,
  initialize,
  makeClient,
  promptOf,
  scriptedModel,
  testEnv,
  textScript,
  toolCallScript,
} from "./helpers/scripted.js";

if (!replAvailable()) {
  console.log("repl: skipped — this host cannot make an unprivileged network namespace (unshare -rn)");
  process.exit(0);
}

const freshCwd = () => mkdtempSync(join(tmpdir(), "daedalus-agent-repl-"));
const env = testEnv({ codeMode: true });
const repl = (code: string) => toolCallScript("repl", { code, description: "test script" });

/** The text the model was handed back for the repl call itself (`call-1`). */
function replResult(updates: { update: unknown }[]): string {
  const done = updates
    .map((u) => u.update as { sessionUpdate: string; toolCallId?: string; status?: string; content?: { content?: { text?: string } }[] })
    .find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "call-1" && (u.status === "completed" || u.status === "failed"));
  return done?.content?.[0]?.content?.text ?? "";
}

// --- a script calls tools, each call is its own row, only the return comes back ---
{
  const cwd = freshCwd();
  writeFileSync(join(cwd, "a.md"), "see docs/one.md and docs/two.md\n");
  writeFileSync(join(cwd, "one.md"), "x");
  const agent = buildAgentApp({
    env,
    makeModel: scriptedModel([
      repl(`
        const md = await read_file({ path: "a.md" });
        const refs = [...new Set(md.match(/docs\\/[\\w.-]+\\.md/g))].map(r => r.slice(5));
        const hits = await Promise.all(refs.map(p => glob({ pattern: p })));
        console.log("checked", refs.length);
        return { missing: refs.filter((p, i) => hits[i].startsWith("No files")) };
      `),
      textScript("done "),
    ]),
  });
  const { app: client, harness } = makeClient();
  await connectPair(agent, client, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    await ctx.request("session/prompt", { sessionId, prompt: promptOf("check links") });

    const result = replResult(harness.updates);
    assert.match(result, /"missing": \[\s*"two\.md"\s*\]/, result);
    assert.match(result, /console:\nchecked 2/);

    const inner = harness
      .updatesOf("tool_call")
      .map((u) => u.update as { toolCallId: string; name?: string; kind?: string })
      .filter((u) => u.toolCallId.startsWith("call-1:"));
    assert.deepEqual(inner.map((u) => u.name), ["read_file", "glob", "glob"]);
    assert.equal(inner[0]?.kind, "read");
    assert.equal(harness.permissionRequests.length, 0, "reads ask nobody, from a script as directly");

    /* The tally rides the repl row's own _meta, and the journaled one is
       final: it is what a reload draws the chips from. */
    const tallies = harness
      .updatesOf("tool_call_update")
      .map((u) => u.update as { toolCallId: string; _meta?: { daedalus?: { repl?: { calls?: Record<string, number> } } } })
      .filter((u) => u.toolCallId === "call-1" && u._meta?.daedalus?.repl?.calls);
    assert.deepEqual(tallies.at(-1)?._meta?.daedalus?.repl?.calls, { read_file: 1, glob: 2 });
  });
  console.log("repl: tool calls ok");
}

// --- the sandbox: escaping the vm reaches a realm with no fs, exec, network or env ---
{
  process.env.REPL_TEST_SECRET = "do-not-leak";
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.end("reached");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const agent = buildAgentApp({
    env,
    makeModel: scriptedModel([
      repl(`
        const out = { process: typeof process, require: typeof require, fetch: typeof fetch };
        try { await import("node:fs"); out.import = "allowed"; } catch (e) { out.import = "blocked"; }
        // a tool function was made in the child's own realm: its constructor is that realm's Function
        const P = read_file.constructor.constructor("return process")();
        const G = read_file.constructor.constructor("return globalThis")();
        try { P.getBuiltinModule("node:fs").readFileSync("/etc/hostname"); out.fs = "allowed"; } catch (e) { out.fs = e.code; }
        try { P.getBuiltinModule("node:child_process").execSync("true"); out.exec = "allowed"; } catch (e) { out.exec = e.code; }
        try { await G.fetch("http://127.0.0.1:${port}/"); out.net = "allowed"; } catch (e) { out.net = "blocked"; }
        out.secret = P.env.REPL_TEST_SECRET ?? null;
        return out;
      `),
      textScript("done "),
    ]),
  });
  const { app: client, harness } = makeClient();
  await connectPair(agent, client, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd: freshCwd(), mcpServers: [] });
    await ctx.request("session/prompt", { sessionId, prompt: promptOf("probe") });
    const out = JSON.parse(replResult(harness.updates)) as Record<string, unknown>;
    assert.deepEqual(out, {
      process: "undefined",
      require: "undefined",
      fetch: "undefined",
      import: "blocked",
      fs: "ERR_ACCESS_DENIED",
      exec: "ERR_ACCESS_DENIED",
      net: "blocked",
      secret: null,
    });
  });
  assert.equal(hits, 0, "the script reached the host's loopback");
  server.close();
  delete process.env.REPL_TEST_SECRET;
  console.log("repl: sandbox ok");
}

// --- a write from a script asks permission like a direct one, and a rejection throws in the script ---
{
  const cwd = freshCwd();
  const agent = buildAgentApp({
    env,
    makeModel: scriptedModel([
      repl(`await write_file({ path: "out.txt", content: "x" }); return "wrote";`),
      textScript("done "),
    ]),
  });
  const { app: client, harness } = makeClient();
  await connectPair(agent, client, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    harness.answerPermission("reject");
    await ctx.request("session/prompt", { sessionId, prompt: promptOf("write") });

    assert.equal(harness.permissionRequests.length, 1);
    assert.equal(harness.permissionRequests[0]?.toolCall.toolCallId, "call-1:1");
    assert.equal(harness.permissionRequests[0]?.toolCall.kind, "edit");
    assert.match(replResult(harness.updates), /The script threw:[\s\S]*rejected permission/);
    assert.equal(existsSync(join(cwd, "out.txt")), false);
  });
  console.log("repl: permission ok");
}

// --- bad input is refused by the tool's own schema, an unknown tool by name ---
{
  const agent = buildAgentApp({
    env,
    makeModel: scriptedModel([
      repl(`
        const out = {};
        try { await read_file({ nope: 1 }); } catch (e) { out.schema = e.message; }
        try { await tools.no_such_tool({}); } catch (e) { out.unknown = "threw"; }
        try { await no_such_tool({}); } catch (e) { out.bare = e.name; }
        return out;
      `),
      textScript("done "),
    ]),
  });
  const { app: client, harness } = makeClient();
  await connectPair(agent, client, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd: freshCwd(), mcpServers: [] });
    await ctx.request("session/prompt", { sessionId, prompt: promptOf("bad input") });
    const out = JSON.parse(replResult(harness.updates)) as Record<string, string>;
    assert.match(out.schema ?? "", /Invalid input for read_file/);
    assert.equal(out.unknown, "threw");
    assert.equal(out.bare, "ReferenceError");
  });
  console.log("repl: validation ok");
}

// --- cancel kills the script mid-call ---
{
  const agent = buildAgentApp({
    env,
    makeModel: scriptedModel([repl(`await bash({ command: "sleep 30" }); return "finished";`), textScript("never ")]),
  });
  const { app: client } = makeClient();
  await connectPair(agent, client, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd: freshCwd(), mcpServers: [] });
    await ctx.request("session/set_mode", { sessionId, modeId: "bypassPermissions" });
    const started = Date.now();
    const turn = ctx.request("session/prompt", { sessionId, prompt: promptOf("run it") });
    await new Promise((r) => setTimeout(r, 400));
    await ctx.notify("session/cancel", { sessionId });
    const response = await turn;
    assert.equal(response.stopReason, "cancelled");
    assert.ok(Date.now() - started < 10_000, "cancel did not stop the script");
  });
  console.log("repl: cancel ok");
}

// --- offered only with the switch on, and never in plan mode ---
{
  const offered = async (codeMode: boolean, mode?: string): Promise<boolean> => {
    let names: string[] = [];
    const script: LanguageModelV4StreamPart[] = textScript("ok ");
    const agent = buildAgentApp({
      env: testEnv({ codeMode }),
      makeModel: () =>
        new MockLanguageModelV4({
          doStream: async (options) => {
            names = (options.tools ?? []).map((t) => t.name);
            return { stream: convertArrayToReadableStream(script) };
          },
        }),
    });
    const { app: client } = makeClient();
    await connectPair(agent, client, async (ctx) => {
      await initialize(ctx);
      const { sessionId } = await ctx.request("session/new", { cwd: freshCwd(), mcpServers: [] });
      if (mode) await ctx.request("session/set_mode", { sessionId, modeId: mode });
      await ctx.request("session/prompt", { sessionId, prompt: promptOf("hi") });
    });
    return names.includes("repl");
  };
  assert.equal(await offered(true), true);
  assert.equal(await offered(false), false);
  assert.equal(await offered(true, "plan"), false);
  console.log("repl: offering ok");
}

// --- code mode is an agent option: the env is its default, the thread switches it live ---
{
  const toolsPerTurn: string[][] = [];
  const agent = buildAgentApp({
    env: testEnv({ codeMode: false }),
    makeModel: () =>
      new MockLanguageModelV4({
        doStream: async (options) => {
          toolsPerTurn.push((options.tools ?? []).map((t) => t.name));
          return { stream: convertArrayToReadableStream(textScript("ok ")) };
        },
      }),
  });
  const { app: client } = makeClient();
  await connectPair(agent, client, async (ctx) => {
    await initialize(ctx);
    const created = await ctx.request("session/new", { cwd: freshCwd(), mcpServers: [] });
    const option = created.configOptions?.find((o) => o.id === "codeMode");
    assert.equal(option?.type, "boolean");
    assert.equal(option?.currentValue, false, "the env switch is the default");

    await ctx.request("session/prompt", { sessionId: created.sessionId, prompt: promptOf("one") });
    const set = await ctx.request("session/set_config_option", { sessionId: created.sessionId, configId: "codeMode", type: "boolean", value: true });
    const after = set.configOptions;
    assert.equal(after.find((o) => o.id === "codeMode")?.currentValue, true);
    await ctx.request("session/prompt", { sessionId: created.sessionId, prompt: promptOf("two") });
  });
  assert.equal(toolsPerTurn[0]?.includes("repl"), false);
  assert.equal(toolsPerTurn[1]?.includes("repl"), true, "switched on, the next turn is offered repl without a respawn");
  console.log("repl: agent option ok");
}

console.log("repl.test.ts passed");
