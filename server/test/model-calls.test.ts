// Self-check for the model-call door (src/model-calls): the door picks the
// first attachable source and falls to `usage`; a `usage` thread rows on
// `usage_update` and an `acp` thread does not; `anchor` sums (normal,
// overshoot, parts missing → `unknown`); a filed record lands in `model_calls`
// with the snapshot columns and the bridge's step; the six dialect adapters
// each produce one `RequestShape` from a fixture, counted and anchored.
// Run: pnpm test:model-calls
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { db, modelCalls } from "../src/db/index.js";
import {
  chooseDoor,
  fileCall,
  listCalls,
  recordCall,
  sources,
  spendBy,
  usageFallback,
  type Attached,
  type CallThread,
  type ChosenDoor,
} from "../src/model-calls/index.js";
import {
  anchor,
  countShape,
  fromAnthropicMessages,
  fromClaudeSnapshot,
  fromCodexRollout,
  fromOpenAiChat,
  fromOpenAiResponses,
  fromOpencodeInstructions,
  partsOf,
  type RequestShape,
} from "../src/model-calls/prompt-parts.js";
import { calledOf } from "../src/model-calls/sources/proxy.js";
import type { ModelCall, ModelCallUpdate } from "../src/protocol.js";

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name}\n    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}

/* A thread whose `emit` files the record the way `SessionManager.emit` does,
   with a step counter standing in for the bridge's. */
function fakeThread(id: string, turnId: string | null = "turn-1"): CallThread & { emitted: ModelCall[] } {
  let steps = 0;
  const thread: CallThread & { emitted: ModelCall[] } = {
    emitted: [],
    id,
    agentId: "daedalus",
    profileId: "p1",
    projectId: "w1",
    cwd: "/tmp/model-calls",
    viaGateway: false,
    acpSessionId: () => null,
    turn: () => ({ turnId, nextStep: () => ++steps }),
    names: () => ({ threadTitle: "A thread", profileName: "Gateway", projectName: "Workspace" }),
    emit: (update: ModelCallUpdate) => {
      thread.emitted.push(update.call);
      void fileCall(thread, update.call);
    },
  };
  return thread;
}

const billed = (input: number, output = 10, read = 0) => ({
  totalTokens: input + output + read,
  inputTokens: input,
  outputTokens: output,
  cachedReadTokens: read || null,
  cachedWriteTokens: null,
  thoughtTokens: null,
});

/* ── the door ── */

await test("chooseDoor takes the first source that attaches, skips one that refuses or throws", async () => {
  const saved = { otlp: sources.otlp, proxy: sources.proxy };
  const tried: string[] = [];
  try {
    sources.otlp = { kind: "otlp", attach: async () => { tried.push("otlp"); throw new Error("no receiver"); } };
    sources.proxy = { kind: "proxy", attach: async () => { tried.push("proxy"); return { spawnEnv: { X: "1" }, stop() {} }; } };
    const door = await chooseDoor(fakeThread("t"), [
      { kind: "otlp", dialect: "claude-otlp", env: {} },
      { kind: "proxy", dialect: "anthropic-messages" },
      { kind: "files", format: "claude-jsonl" },
      { kind: "acp" },
    ]);
    assert.equal(door.kind, "proxy");
    assert.deepEqual(door.attached?.spawnEnv, { X: "1" });
    assert.deepEqual(tried, ["otlp", "proxy"]); // files and acp never tried
  } finally {
    Object.assign(sources, saved);
  }
});

await test("chooseDoor falls to usage when nothing attaches, and acp always attaches", async () => {
  /* The files door attaches wherever the runtime's store is on this machine. */
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = "/tmp/daedalus-test-model-calls/nowhere";
  try {
    const none = await chooseDoor(fakeThread("t"), [{ kind: "files", format: "codex-rollout" }]);
    assert.deepEqual(none, { kind: "usage", attached: null });
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
  }
  const acp = await chooseDoor(fakeThread("t"), [{ kind: "acp" }]);
  assert.equal(acp.kind, "acp");
  assert.ok(acp.attached);
});

await test("a usage thread rows on usage_update; an acp thread does not; a reading with no bill does not", () => {
  const usage: ChosenDoor = { kind: "usage", attached: null };
  const acp: ChosenDoor = { kind: "acp", attached: { stop() {} } as Attached };
  const step = billed(1000, 50, 200);
  const fromStep = usageFallback(usage, "m", { sessionUpdate: "usage_update", used: 1250, size: 200000, _meta: { daedalus: { step } } });
  assert.equal(fromStep?.source, "usage");
  assert.deepEqual(fromStep?.billed, step);
  const fromUsed = usageFallback(usage, "m", { sessionUpdate: "usage_update", used: 777, size: 200000 });
  assert.equal(fromUsed?.billed.inputTokens, 777);
  assert.equal(usageFallback(acp, "m", { sessionUpdate: "usage_update", used: 777, size: 200000 }), null);
  assert.equal(usageFallback(usage, "m", { sessionUpdate: "usage_update", used: 0, size: 200000 }), null);
  assert.equal(usageFallback(usage, "m", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } }), null);
});

/* ── anchor ── */

await test("anchor: every part seen → proportions that sum exactly to the total", () => {
  const out = anchor(100, { system: 30, tools: 60, user: 3 });
  assert.equal((out.system ?? 0) + (out.tools ?? 0) + (out.user ?? 0) + out.unknown, 100);
  assert.equal(out.unknown, 0);
  assert.equal(out.system, 32);
});

await test("anchor: a part unseen → seen parts stand, the rest is unknown; an overshoot scales by one factor", () => {
  const under = anchor(100, { system: 30, tools: 20, user: null });
  assert.deepEqual(under, { system: 30, tools: 20, user: null, unknown: 50 });
  const over = anchor(100, { system: 150, tools: 50, user: null });
  assert.equal(over.system, 75);
  assert.equal(over.tools, 25);
  assert.equal(over.unknown, 0);
  const nothing = anchor(100, { system: null, tools: null });
  assert.deepEqual(nothing, { system: null, tools: null, unknown: 100 });
});

/* ── filing ── */

await test("recordCall anchors to the bill, emits, and the filed row carries step, turn and the snapshot columns", async () => {
  await db.delete(modelCalls);
  const thread = fakeThread("sess-file");
  const shape: RequestShape = {
    system: [{ name: "System prompt › Rules", text: "You are a careful assistant. ".repeat(40) }],
    tools: [{ name: "read_file", text: JSON.stringify({ name: "read_file", parameters: { path: "string" } }) }],
    messages: [
      { role: "user", text: "hello there" },
      { role: "assistant", text: "read_file {}", tool: "read_file" },
      { role: "results", text: "file contents", tool: "read_file" },
    ],
  };
  await recordCall(thread, { callId: "c1", at: 1_700_000_000_000, who: "turn", model: "gpt-x", source: "proxy", billed: billed(600, 20, 100), shape, called: ["bash"] });
  await recordCall(thread, { callId: "c2", at: 1_700_000_001_000, who: "turn", model: "gpt-x", source: "proxy", billed: billed(50) });
  await new Promise((r) => setTimeout(r, 50)); // the fake emit's insert is not awaited, as the manager's is not
  const [first, second] = thread.emitted;
  assert.equal(first.step, 1);
  assert.equal(second.step, 2);
  const p = first.prompt!;
  assert.equal((p.system ?? 0) + (p.tools ?? 0) + (p.mcp ?? 0) + (p.user ?? 0) + (p.assistant ?? 0) + (p.results ?? 0) + p.unknown, 700);
  assert.equal(second.prompt, undefined);
  const rows = await listCalls("sess-file");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].callId, "c2"); // newest first
  assert.deepEqual(rows[1].called, ["bash"], "the reply's calls survive the ledger");
  assert.deepEqual(rows[1].toolUse?.map((t) => [t.name, t.calls]), [["read_file", 1]], "and so does the history's footprint");
  const paged = await listCalls("sess-file", { before: 1_700_000_001_000 });
  assert.deepEqual(paged.map((r) => r.callId), ["c1"]);
  const row = (await db.select().from(modelCalls))[0];
  assert.equal(row.threadTitle, "A thread");
  assert.equal(row.profileName, "Gateway");
  assert.equal(row.projectName, "Workspace");
  assert.equal(row.agentId, "daedalus");
  assert.equal(row.turnId, "turn-1");
  assert.equal(rows[0].billed.inputTokens, 50);
});

await test("a record that arrives with its own step keeps it (the acp door files, never renumbers)", async () => {
  const thread = fakeThread("sess-acp");
  await fileCall(thread, { callId: "a1", at: 1, who: "subagent", childId: "kid", step: 7, model: "m", source: "acp", billed: billed(5) });
  const [row] = await listCalls("sess-acp");
  assert.equal(row.step, 7);
  assert.equal(row.childId, "kid");
});

await test("spendBy groups the ledger by the five keys over a window", async () => {
  const byProfile = await spendBy("profile");
  const gw = byProfile.find((g) => g.key === "p1")!;
  assert.equal(gw.name, "Gateway");
  assert.equal(gw.calls, 3);
  assert.equal(gw.input, 655);
  assert.equal(gw.cacheRead, 100);
  const bySource = await spendBy("source", 0, 1_700_000_000_500);
  assert.deepEqual(bySource.map((g) => [g.key, g.calls]), [["proxy", 1], ["acp", 1]]); // biggest spend first
  for (const g of ["model", "project", "agent"] as const) assert.ok((await spendBy(g)).length > 0);
});

/* ── the six adapters ── */

const REMINDER = "<system-reminder>\nToday is Tuesday. Skills: none.\n</system-reminder>";
const TOOL = { name: "read_file", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } };
const MCP_TOOL = { name: "mcp__web-search__web_search", description: "Search", input_schema: { type: "object" } };

async function check(shape: RequestShape, expect: { system: boolean; tools: boolean; mcp?: boolean; convo: boolean; missing?: string[] }) {
  const counts = await countShape(shape);
  const { prompt, missing } = partsOf(1000, counts);
  const sum = (prompt.system ?? 0) + (prompt.tools ?? 0) + (prompt.mcp ?? 0) + (prompt.user ?? 0) + (prompt.assistant ?? 0) + (prompt.results ?? 0) + prompt.unknown;
  assert.equal(sum, 1000);
  assert.equal(prompt.system !== null && prompt.system > 0, expect.system, "system");
  assert.equal(prompt.tools !== null && prompt.tools > 0, expect.tools, "tools");
  if (expect.mcp !== undefined) assert.equal(prompt.mcp !== null && prompt.mcp > 0, expect.mcp, "mcp");
  assert.equal(prompt.user !== null && prompt.user > 0, expect.convo, "user");
  assert.deepEqual(missing ?? [], expect.missing ?? []);
  return prompt;
}

await test("anthropic-messages: system blocks, tools, a reminder counted as system, a tool_result as results", async () => {
  const shape = fromAnthropicMessages({
    system: [{ type: "text", text: "You are Claude Code." }],
    tools: [TOOL, MCP_TOOL],
    messages: [
      { role: "user", content: [{ type: "text", text: REMINDER }, { type: "text", text: "fix the bug" }] },
      { role: "assistant", content: [{ type: "tool_use", name: "read_file", input: { path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: [{ type: "text", text: "const a = 1" }] }] },
    ],
  });
  assert.equal(shape.system.length, 2);
  assert.ok(shape.system[1].name.startsWith("Injected context"));
  assert.deepEqual(shape.messages.map((m) => m.role), ["user", "assistant", "results"]);
  assert.equal(shape.tools.length, 2);
  const prompt = await check(shape, { system: true, tools: true, mcp: true, convo: true });
  assert.equal(prompt.unknown, 0);
});

await test("openai-chat: system row, tools[].function, tool_calls beside content, tool rows as results", async () => {
  const shape = fromOpenAiChat({
    messages: [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "run the tests" },
      { role: "assistant", content: null, tool_calls: [{ type: "function", function: { name: "bash", arguments: '{"cmd":"pnpm test"}' } }] },
      { role: "tool", tool_call_id: "1", content: "all passed" },
    ],
    tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }],
  });
  assert.equal(shape.system.length, 1);
  assert.deepEqual(shape.messages.map((m) => m.role), ["user", "assistant", "results"]);
  assert.equal(shape.tools[0].name, "bash");
  await check(shape, { system: true, tools: true, mcp: false, convo: true });
});

await test("openai-responses: instructions, input items (message / function_call / function_call_output), flat tools", async () => {
  const shape = fromOpenAiResponses({
    instructions: "Base instructions for codex.",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "Developer note." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "what is 2+2" }] },
      { type: "function_call", name: "shell", arguments: '{"command":["ls"]}' },
      { type: "function_call_output", call_id: "c", output: "a.ts\nb.ts" },
      "a bare string is a user message",
    ],
    tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
  });
  assert.equal(shape.system.length, 2);
  assert.deepEqual(shape.messages.map((m) => m.role), ["user", "assistant", "results", "user"]);
  assert.equal(shape.tools[0].name, "shell");
  await check(shape, { system: true, tools: true, convo: true });
});

await test("toolUse: each tool's calls and results, keyed across the three bodies, anchored inside its parts", async () => {
  const anthropic = fromAnthropicMessages({
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "const a = 1; ".repeat(40) }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "mcp__web-search__web_search", input: { q: "x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "result" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t3", name: "read_file", input: { path: "b.ts" } }] },
    ],
  });
  const counts = await countShape(anthropic);
  const { prompt, toolUse } = partsOf(5000, counts);
  assert.ok(toolUse);
  assert.deepEqual(toolUse.map((t) => [t.name, t.calls]), [["read_file", 2], ["mcp__web-search__web_search", 1]], "biggest first, calls counted");
  assert.ok(toolUse.reduce((n, t) => n + t.args, 0) <= prompt.assistant!, "args never exceed the assistant part");
  assert.ok(toolUse.reduce((n, t) => n + t.results, 0) <= prompt.results!, "results never exceed the results part");
  const chat = fromOpenAiChat({
    messages: [
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ],
  });
  assert.deepEqual(chat.messages.map((m) => m.tool), ["bash", "bash"]);
  const responses = fromOpenAiResponses({
    input: [
      { type: "function_call", call_id: "r1", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "r1", output: "ok" },
    ],
  });
  assert.deepEqual(responses.messages.map((m) => m.tool), ["shell", "shell"]);
  const codex = fromCodexRollout([
    { type: "response_item", payload: { type: "function_call", call_id: "x", name: "shell", arguments: "{}" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "x", output: "ok" } },
  ]);
  assert.deepEqual(codex.messages.map((m) => m.tool), ["shell", "shell"]);
});

await test("proxy calledOf: the tools a reply asked to run, whole or streamed, in each dialect", () => {
  assert.deepEqual(
    calledOf("anthropic-messages", [
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "a", name: "read_file", input: {} } },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "b", name: "bash", input: {} } },
    ]),
    ["read_file", "bash"],
  );
  assert.deepEqual(calledOf("anthropic-messages", [{ type: "message", content: [{ type: "tool_use", name: "grep" }] }]), ["grep"]);
  assert.deepEqual(
    calledOf("openai-chat", [
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "bash", arguments: "" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { name: "read", arguments: "" } }] } }] },
    ]),
    ["bash", "read"],
  );
  assert.deepEqual(
    calledOf("openai-responses", [
      { type: "response.output_item.added", item: { type: "function_call", call_id: "1", name: "shell" } },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "1", name: "shell" } },
      { type: "response.completed", response: { output: [{ type: "function_call", call_id: "1", name: "shell" }] } },
    ]),
    ["shell"],
  );
});

await test("claude prompt_snapshot: sections and tools seen, the conversation not; without tools, tool schemas missing too", async () => {
  const withTools = fromClaudeSnapshot({
    type: "prompt_snapshot",
    cliPrefix: "You are Claude Code, Anthropic's official CLI.",
    systemPrompt: ["# Rules\nBe careful.", "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__", "# Env\ncwd=/tmp"],
    tools: [TOOL, MCP_TOOL],
  });
  assert.equal(withTools.system.length, 3);
  const prompt = await check(withTools, { system: true, tools: true, mcp: true, convo: false, missing: ["the conversation"] });
  assert.equal(prompt.user, null);
  assert.ok(prompt.unknown > 0);
  const noTools = fromClaudeSnapshot({ type: "prompt_snapshot", systemPrompt: ["Rules."] });
  const p2 = await check(noTools, { system: true, tools: false, convo: false, missing: ["the conversation", "tool schemas"] });
  assert.equal(p2.tools, null);
  assert.equal(p2.mcp, null);
});

await test("codex rollout: base instructions, developer/context messages as system, the rest as the conversation, no tool schemas", async () => {
  const shape = fromCodexRollout([
    { type: "session_meta", payload: { id: "s", base_instructions: { text: "You are Codex." } } },
    { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "Developer instructions here." }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\ncwd=/x\n</environment_context>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "add a test" }] } },
    { type: "response_item", payload: { type: "function_call", name: "shell", arguments: '{"command":["ls"]}' } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "c", output: "a.ts" } },
    { type: "event_msg", payload: { type: "token_count", info: {} } },
  ]);
  assert.equal(shape.system.length, 3);
  assert.equal(shape.system[0].name, "System prompt › Base instructions");
  assert.deepEqual(shape.messages.map((m) => m.role), ["user", "assistant", "results"]);
  const prompt = await check(shape, { system: true, tools: false, convo: true, missing: ["tool schemas"] });
  assert.equal(prompt.tools, null);
  const noMeta = fromCodexRollout([]);
  assert.deepEqual(noMeta.missing, ["the system prompt", "tool schemas"]);
});

await test("opencode instruction_state: injected context as system, codemode as tools, MCP guidance per server; prompt and conversation missing", async () => {
  const blobs: Record<string, string> = {
    h1: JSON.stringify("Environment: linux, cwd=/x"),
    h2: JSON.stringify("Today is 2026-10-22"),
    h3: JSON.stringify([{ server: "web-search", instructions: "Use web_search for anything that changes." }]),
    h4: JSON.stringify("Tools: read, write, bash"),
    h5: "Skills available: none",
  };
  const shape = fromOpencodeInstructions(
    { "core/environment": "h1", "core/date": "h2", "core/mcp-guidance": "h3", "core/codemode": "h4", "core/skill-guidance": "h5", "core/missing": "nope" },
    (hash) => blobs[hash],
  );
  assert.deepEqual(shape.system.map((s) => s.name), ["Environment", "Date", "Skills › listing"]);
  assert.deepEqual(shape.tools.map((t) => t.name), ["mcp__web-search instructions", "Tool listing"]);
  const prompt = await check(shape, { system: true, tools: true, mcp: true, convo: false, missing: ["its own system prompt", "tool schemas", "the conversation"] });
  assert.equal(prompt.results, null);
});

await db.delete(modelCalls);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
