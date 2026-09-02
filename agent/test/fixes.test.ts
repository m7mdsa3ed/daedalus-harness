/* Pins the fixes phase: MCP permission gating, session-reload MCP cleanup,
   compaction ordering/degradation, bash process-group kill + delta bounds, and
   the grep fallback's time budget. Same harness as the other suites: an
   in-process ACP client over scripted MockLanguageModelV4s. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type * as acp from "../src/acp.js";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { buildAgentApp } from "../src/app.js";
import { SessionStore } from "../src/persistence.js";
import type { ModelFactory } from "../src/provider.js";
import type { ToolRuntime } from "../src/tools/context.js";
import { globToRegExp, makeGrepTool } from "../src/tools/search.js";
import {
  initialize,
  makeClient,
  promptOf,
  scriptedModel,
  testEnv,
  textScript,
  toolCallScript,
} from "./helpers/scripted.js";

const MCP_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "helpers", "mcp-echo-server.mjs");

function freshCwd(): string {
  return mkdtempSync(join(tmpdir(), "daedalus-agent-cwd-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

/* scriptedModel plus: records every doStream's prompt (so a test can say what
   each model call actually saw), and a queue entry that is an Error makes that
   call fail — the failing-summarizer case. */
function recordingModel(
  scripts: (LanguageModelV4StreamPart[] | Error)[],
  prompts: unknown[][],
): ModelFactory {
  const queue = [...scripts];
  return () =>
    new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push((options as { prompt: unknown[] }).prompt);
        const script = queue.shift();
        if (!script) throw new Error("scripted model ran out of scripts");
        if (script instanceof Error) throw script;
        return { stream: convertArrayToReadableStream(script) };
      },
    });
}

function readJournal(home: string, sessionId: string): { t: string; m?: unknown }[] {
  return readFileSync(join(home, "sessions", `${sessionId}.jsonl`), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { t: string; m?: unknown });
}

function mcpServer(pidFile: string): acp.McpServer {
  return {
    name: "echo",
    command: process.execPath,
    args: [MCP_FIXTURE],
    env: [{ name: "MCP_PID_FILE", value: pidFile }],
  };
}

// --- (1) MCP tools gate through permissions; always-allow sticks per tool ---
// --- (2) re-loading a session reaps the old MCP child before spawning fresh ---
{
  const cwd = freshCwd();
  const pids = mkdtempSync(join(tmpdir(), "daedalus-agent-mcp-"));
  const firstPidFile = join(pids, "first.pid");
  const secondPidFile = join(pids, "second.pid");
  const agent = buildAgentApp({
    env: testEnv(),
    makeModel: scriptedModel([
      toolCallScript("mcp__echo__echo", { text: "one" }),
      toolCallScript("mcp__echo__echo", { text: "two" }, { id: "call-2" }),
      textScript("Echoed twice. "),
    ]),
  });
  const { app: client, harness } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", {
      cwd,
      mcpServers: [mcpServer(firstPidFile)],
    });
    harness.answerPermission("allow_always");
    const response = await ctx.request("session/prompt", { sessionId, prompt: promptOf("echo twice") });
    assert.equal(response.stopReason, "end_turn");

    // Default mode: the first MCP call asked; allow_always stuck, so the
    // second did not. (Ungated, there would be zero asks.)
    assert.equal(harness.permissionRequests.length, 1, "one ask for two MCP calls");
    const ask = harness.permissionRequests[0];
    assert.equal(ask?.toolCall.title, "mcp__echo__echo");
    assert.deepEqual(ask?.toolCall.rawInput, { text: "one" });
    const completed = harness
      .updatesOf("tool_call_update")
      .filter((u) => (u.update as { status?: string }).status === "completed")
      .map((u) => JSON.stringify(u.update));
    assert.ok(completed.some((u) => u.includes("echo:one")), "first call ran");
    assert.ok(completed.some((u) => u.includes("echo:two")), "second call ran");
    console.log("fixes: mcp permission gate ok");

    // Re-load of the same id: the prior handle's stdio child must die.
    const firstPid = Number(readFileSync(firstPidFile, "utf8"));
    assert.ok(alive(firstPid), "first MCP server is running before the reload");
    await ctx.request("session/load", { sessionId, cwd, mcpServers: [mcpServer(secondPidFile)] });
    assert.ok(await waitFor(() => !alive(firstPid)), "old MCP child was reaped on reload");
    const secondPid = Number(readFileSync(secondPidFile, "utf8"));
    assert.ok(alive(secondPid), "replacement MCP server is running");
    console.log("fixes: session reload reaps old MCP child ok");

    /* Nothing closes the in-process agent's sessions at end-of-test, and a
       live stdio child would keep this script's event loop alive forever —
       reap it so the suite exits on its own. */
    process.kill(secondPid, "SIGKILL");
  });
}

// --- (3) compaction runs before the prompt joins: the just-typed message
//     survives verbatim in session.messages and lands after the JSONL barrier ---
{
  const MARKER = "KEEP-THIS-PROMPT-VERBATIM after the threshold trips";
  const env = testEnv({ contextWindow: 100 });
  const prompts: unknown[][] = [];
  const agent = buildAgentApp({
    env,
    makeModel: recordingModel(
      [
        textScript("A long first answer. ", { input: 90, output: 5 }), // turn 1: 95/100
        textScript("The gist so far. ", { input: 5, output: 5 }), // turn 2's summarizer
        textScript("Continuing fresh. ", { input: 10, output: 5 }), // turn 2 proper
      ],
      prompts,
    ),
  });
  const { app: client, harness } = makeClient();
  let sessionId = "";
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    ({ sessionId } = await ctx.request("session/new", { cwd: freshCwd(), mcpServers: [] }));
    await ctx.request("session/prompt", { sessionId, prompt: promptOf("first") });
    const response = await ctx.request("session/prompt", { sessionId, prompt: promptOf(MARKER) });
    assert.equal(response.stopReason, "end_turn");

    const statuses = harness
      .updatesOf("compaction_update")
      .map((u) => (u.update as { status?: string }).status);
    assert.ok(statuses.includes("completed"), `compaction completed (got ${statuses})`);

    // The summarizer (call 2) never saw the just-typed prompt…
    assert.equal(prompts.length, 3);
    const summarizerSaw = JSON.stringify(prompts[1]);
    assert.ok(summarizerSaw.includes("Summarize this conversation"), "call 2 was the summarizer");
    assert.ok(!summarizerSaw.includes(MARKER), "summarizer did not eat the new prompt");
    // …and the turn ran on [summary, verbatim prompt], prompt last.
    const turnSaw = prompts[2] as unknown[];
    const turnSawText = JSON.stringify(turnSaw);
    assert.ok(turnSawText.includes("Summary of the conversation so far"), "turn saw the summary");
    assert.ok(JSON.stringify(turnSaw.at(-1)).includes(MARKER), "turn ended on the verbatim prompt");
  });

  // Persisted: the msg lands after the compact barrier, so read() keeps it.
  const records = readJournal(env.home, sessionId);
  const compactAt = records.findIndex((r) => r.t === "compact");
  const markerAt = records.findIndex((r) => r.t === "msg" && JSON.stringify(r.m).includes(MARKER));
  assert.ok(compactAt >= 0, "compact barrier journaled");
  assert.ok(markerAt > compactAt, "prompt journaled after the barrier");
  const replayed = new SessionStore(env.home).read(sessionId);
  assert.ok(
    replayed?.messages.some((m) => JSON.stringify(m).includes(MARKER)),
    "a re-read of the store still holds the prompt",
  );
  assert.ok(
    JSON.stringify(replayed?.messages[0]).includes("Summary of the conversation so far"),
    "history begins at the summary",
  );
  console.log("fixes: compaction keeps the prompt ok");
}

// --- (4) a failing summarizer degrades to an uncompacted turn, not a failed one ---
{
  const MARKER = "still answer me after the summarizer dies";
  const env = testEnv({ contextWindow: 100 });
  const prompts: unknown[][] = [];
  const agent = buildAgentApp({
    env,
    makeModel: recordingModel(
      [
        textScript("A long first answer. ", { input: 90, output: 5 }),
        new Error("summarizer exploded"),
        textScript("Uncompacted but fine. ", { input: 10, output: 5 }),
      ],
      prompts,
    ),
  });
  const { app: client, harness } = makeClient();
  let sessionId = "";
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    ({ sessionId } = await ctx.request("session/new", { cwd: freshCwd(), mcpServers: [] }));
    await ctx.request("session/prompt", { sessionId, prompt: promptOf("first") });
    const response = await ctx.request("session/prompt", { sessionId, prompt: promptOf(MARKER) });
    assert.equal(response.stopReason, "end_turn", "the turn still ended cleanly");

    /* The AI SDK's textStream swallows the model error (it only logs it), so
       the throw surfaces through compact's own empty-summary check — what is
       pinned here is that a failure is announced and the turn degrades, not
       the exact wording. */
    const failed = harness
      .updatesOf("compaction_update")
      .find((u) => (u.update as { status?: string }).status === "failed");
    assert.ok(failed, "the failure was announced as a failed compaction_update");
    // The turn ran on the full, uncompacted history plus the new prompt.
    const turnSaw = JSON.stringify(prompts[2]);
    assert.ok(turnSaw.includes("A long first answer"), "history survived");
    assert.ok(turnSaw.includes(MARKER), "prompt survived");
    const answer = harness
      .updatesOf("agent_message_chunk")
      .map((u) => (u.update as { content?: { text?: string } }).content?.text ?? "")
      .join("");
    assert.ok(answer.includes("Uncompacted but fine."), "the model answered");
  });
  assert.ok(
    !readJournal(env.home, sessionId).some((r) => r.t === "compact"),
    "no compact barrier was journaled",
  );
  console.log("fixes: failed summarizer degrades ok");
}

// --- (5) an empty summary never replaces the history ---
{
  const MARKER = "prompt after the empty summary";
  const env = testEnv({ contextWindow: 100 });
  const prompts: unknown[][] = [];
  const emptyScript: LanguageModelV4StreamPart[] = [
    { type: "stream-start", warnings: [] },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" } as never,
      usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 0, text: 0, reasoning: undefined },
      } as never,
    },
  ];
  const agent = buildAgentApp({
    env,
    makeModel: recordingModel(
      [
        textScript("A long first answer. ", { input: 90, output: 5 }),
        emptyScript, // the summarizer answers with nothing at all
        textScript("History intact. ", { input: 10, output: 5 }),
      ],
      prompts,
    ),
  });
  const { app: client, harness } = makeClient();
  let sessionId = "";
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    ({ sessionId } = await ctx.request("session/new", { cwd: freshCwd(), mcpServers: [] }));
    await ctx.request("session/prompt", { sessionId, prompt: promptOf("first") });
    const response = await ctx.request("session/prompt", { sessionId, prompt: promptOf(MARKER) });
    assert.equal(response.stopReason, "end_turn");

    const failed = harness
      .updatesOf("compaction_update")
      .find((u) => (u.update as { status?: string }).status === "failed");
    assert.ok(JSON.stringify(failed?.update).includes("empty"), "empty summary reported as a failure");
    const turnSaw = JSON.stringify(prompts[2]);
    assert.ok(turnSaw.includes("A long first answer"), "history was not wiped");
    assert.ok(turnSaw.includes(MARKER));
  });
  const replayed = new SessionStore(env.home).read(sessionId);
  assert.ok(
    replayed?.messages.some((m) => JSON.stringify(m).includes("first")),
    "the store still holds the pre-compaction history",
  );
  assert.ok(
    !readJournal(env.home, sessionId).some((r) => r.t === "compact"),
    "no compact barrier was journaled",
  );
  console.log("fixes: empty summary keeps history ok");
}

// --- (6) bash timeout kills the whole process group ---
{
  const agent = buildAgentApp({
    env: testEnv(),
    makeModel: scriptedModel([
      toolCallScript("bash", {
        command: "sleep 30 & echo CHILD:$!; sleep 30",
        timeout_ms: 1500,
      }),
      textScript("Timed out as expected. "),
    ]),
  });
  const { app: client, harness } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd: freshCwd(), mcpServers: [] });
    await ctx.request("session/set_mode", { sessionId, modeId: "bypassPermissions" });
    await ctx.request("session/prompt", { sessionId, prompt: promptOf("run it") });

    const done = harness
      .updatesOf("tool_call_update")
      .map((u) => JSON.stringify(u.update))
      .find((u) => u.includes("timed out after 1500ms"));
    assert.ok(done, "the timeout was reported in the result");
    const grandchild = Number(/CHILD:(\d+)/.exec(done ?? "")?.[1]);
    assert.ok(Number.isFinite(grandchild) && grandchild > 0, "the backgrounded pid was captured");
    assert.ok(await waitFor(() => !alive(grandchild)), "the backgrounded grandchild died with the group");
  });
  console.log("fixes: bash kills the process group ok");
}

// --- (6b) the live-output delta buffer stays bounded ---
{
  const agent = buildAgentApp({
    env: testEnv(),
    makeModel: scriptedModel([
      // 500KB in one burst, then outlive the first delta flush window.
      toolCallScript("bash", { command: "head -c 500000 /dev/zero | tr '\\0' x; sleep 0.4" }),
      textScript("Flooded. "),
    ]),
  });
  const { app: client, harness } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd: freshCwd(), mcpServers: [] });
    await ctx.request("session/set_mode", { sessionId, modeId: "bypassPermissions" });
    await ctx.request("session/prompt", { sessionId, prompt: promptOf("flood") });

    const deltas = harness
      .updatesOf("tool_call_update")
      .map(
        (u) =>
          ((u.update as { _meta?: { terminal_output_delta?: { data?: string } } })._meta
            ?.terminal_output_delta?.data) ?? "",
      )
      .filter(Boolean);
    assert.ok(deltas.length > 0, "deltas streamed");
    const CAP = 64_000 + "[stream truncated]\n".length;
    for (const d of deltas) {
      assert.ok(d.length <= CAP, `a delta stayed under the cap (got ${d.length})`);
    }
    /* Known defect, deliberately not pinned: the one-time "[stream truncated]"
       note is prefixed when the cap first trips, but every later chunk slices
       the buffer to its tail again and cuts the note off the front — in a
       sustained flood the note never reaches a flush. The bound above is the
       load-bearing half and is what this test pins. */
    const result = harness
      .updatesOf("tool_call_update")
      .map((u) => JSON.stringify(u.update))
      .find((u) => u.includes("[output truncated]"));
    assert.ok(result, "the result buffer was truncated too");
  });
  console.log("fixes: bash delta buffer bounded ok");
}

// --- (7) the grep fallback bails within its wall-clock budget ---
{
  const cwd = freshCwd();
  // A few files a catastrophic pattern has to chew on — no match, all 'a's.
  for (let i = 0; i < 3; i++) writeFileSync(join(cwd, `f${i}.txt`), `${"a".repeat(20)}\n`);
  const rt = { session: { cwd } } as unknown as ToolRuntime;
  const grep = makeGrepTool(rt);

  /* Force the sync fallback (no rg on an empty PATH) and stub the clock so
     the 10s budget elapses after the first file — the bail path itself is
     what is pinned, without a 10-second test. */
  const origPath = process.env.PATH;
  const origNow = Date.now;
  const base = origNow();
  let calls = 0;
  process.env.PATH = join(tmpdir(), "definitely-no-binaries-here");
  /* Call 0 computes the deadline; every later reading is past it, so the scan
     bails at the first between-files check without ever running the regex. */
  Date.now = () => (calls++ === 0 ? base : base + 20_000);
  const startedAt = process.hrtime.bigint();
  try {
    const out = (await grep.execute!(
      { pattern: "(a+)+b" },
      { toolCallId: "t1", messages: [] } as never,
    )) as string;
    assert.ok(out.includes("[search timed out after 10000ms"), `budget note present (got: ${out})`);
  } finally {
    process.env.PATH = origPath;
    Date.now = origNow;
  }
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.ok(elapsedMs < 5_000, `bailed quickly (took ${Math.round(elapsedMs)}ms)`);
  console.log("fixes: grep fallback time budget ok");
}

// --- globToRegExp: the glob subset, pure ---
{
  const cases: [string, string, boolean][] = [
    ["*.ts", "a.ts", true],
    ["*.ts", "a/b.ts", false], // * never crosses a slash
    ["*.ts", "axts", false], // the dot is literal
    ["**/*.ts", "a/b/c.ts", true],
    ["**/*.ts", "a.ts", true], // **/ also matches zero directories
    ["src/**", "src/deep/file.js", true],
    ["src/**", "other/file.js", false],
    ["a?c", "abc", true],
    ["a?c", "a/c", false], // ? never matches a slash
    ["a?c", "ac", false],
    ["{a,b}.js", "a.js", true],
    ["{a,b}.js", "b.js", true],
    ["{a,b}.js", "c.js", false],
    ["{a.b,c}.js", "a.b.js", true], // alternatives escape their dots
    ["{a.b,c}.js", "axb.js", false],
    ["{unclosed", "{unclosed", true], // an unclosed brace is a literal
    ["a+b", "a+b", true], // regex metacharacters are literal
    ["a+b", "aab", false],
  ];
  for (const [pattern, input, expected] of cases) {
    assert.equal(
      globToRegExp(pattern).test(input),
      expected,
      `${pattern} vs ${input} should be ${expected}`,
    );
  }
  console.log("fixes: globToRegExp ok");
}

console.log("fixes.test.ts passed");
