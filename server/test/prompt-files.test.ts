// Self-check for the files door (src/model-calls/sources/files.ts): each of
// the three readers turns its fixture into drafts whose bills are the store's
// and whose shapes count and anchor through prompt-parts with the reader's own
// `missing`; a reader tails from where it stopped and starts over on a rewrite;
// a missing, locked or unknown store yields nothing; the door attaches only
// where the store is, waits for the earned session id, skips bills from a
// previous life, files what the watch sees and stops when told.
// Run: pnpm test:prompt-files
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { billedPrompt, type CallThread } from "../src/model-calls/index.js";
import { countShape, partsOf } from "../src/model-calls/prompt-parts.js";
import { filesSource, filesTiming, openReader } from "../src/model-calls/sources/files.js";
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

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* The three stores, laid out as the runtimes lay them out, under one temp root. */
const root = mkdtempSync(join(tmpdir(), "prompt-files-"));
const CLAUDE_ID = "11111111-1111-4111-8111-111111111111";
const CODEX_ID = "019cdeff-b232-7a12-a6df-873aea3823cb";
const OPENCODE_ID = "ses_fixture0001";
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
process.env.CODEX_HOME = join(root, "codex");
process.env.XDG_DATA_HOME = join(root, "share");
const claudeFile = join(root, "claude", "projects", "-tmp-proj", `${CLAUDE_ID}.jsonl`);
const codexFile = join(root, "codex", "sessions", "2026", "03", "12", `rollout-2026-03-12T00-23-45-${CODEX_ID}.jsonl`);
const opencodeFile = join(root, "share", "opencode", "opencode.db");
for (const [from, to] of [
  ["claude-session.jsonl", claudeFile],
  ["codex-rollout.jsonl", codexFile],
]) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(FIXTURES, from), to);
}
mkdirSync(dirname(opencodeFile), { recursive: true });
{
  const db = new DatabaseSync(opencodeFile);
  db.exec(readFileSync(join(FIXTURES, "opencode.sql"), "utf8"));
  db.close();
}

/** The sum the anchor promises: every seen part plus `unknown` is the bill. */
function sumOf(prompt: NonNullable<ModelCall["prompt"]>): number {
  return (prompt.system ?? 0) + (prompt.tools ?? 0) + (prompt.mcp ?? 0) + (prompt.user ?? 0) + (prompt.assistant ?? 0) + (prompt.results ?? 0) + prompt.unknown;
}

/** A Claude assistant line for request `req`, stamped `at`. */
function claudeLine(req: string, at: string, usage = { input_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, output_tokens: 7 }) {
  return `${JSON.stringify({
    type: "assistant",
    uuid: `u-${req}`,
    timestamp: at,
    requestId: req,
    isSidechain: false,
    message: { model: "claude-opus-5-5", id: `msg_${req}`, role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage },
  })}\n`;
}

/* ── claude-jsonl ── */

await test("claude-jsonl: one draft per request (not per line), the bill and the snapshot's shape, items on the first", async () => {
  const reader = openReader("claude-jsonl", CLAUDE_ID);
  assert.equal(reader.path(), claudeFile);
  const drafts = reader.read();
  assert.equal(drafts.length, 2);
  const [a, b] = drafts;
  assert.equal(a.callId, "req_A");
  assert.equal(a.who, "turn");
  assert.equal(a.model, "claude-opus-5-5");
  assert.equal(a.finishReason, "tool_use");
  assert.equal(a.source, "files");
  assert.equal(a.at, Date.parse("2026-10-20T11:42:26.900Z"));
  assert.deepEqual(a.billed, { totalTokens: 2 + 948 + 57107 + 1103, inputTokens: 2, outputTokens: 1103, cachedReadTokens: 57107, cachedWriteTokens: 948, thoughtTokens: 333 });
  assert.equal(b.callId, "req_B");
  assert.equal(b.finishReason, "end_turn");
  assert.equal(a.items, true);
  assert.equal(b.items, false);
  const parts = partsOf(billedPrompt(a.billed), await countShape(a.shape!));
  assert.ok((parts.prompt.system ?? 0) > 0, "system sections counted");
  assert.equal(parts.prompt.tools, null, "no tools in this snapshot");
  assert.equal(parts.prompt.mcp, null);
  assert.equal(parts.prompt.user, null);
  assert.equal(parts.prompt.results, null);
  assert.equal(sumOf(parts.prompt), billedPrompt(a.billed));
  assert.deepEqual(parts.missing, ["the conversation", "tool schemas"]);
  const names = parts.items.system.map((i) => i.name);
  assert.ok(names.includes("System prompt › Identity"));
  assert.ok(names.some((n) => n.startsWith("Project rules › ")), "the instructions attachment rides as system");
  assert.ok(parts.items.mcp.some((i) => i.name === "mcp__agents instructions"), "MCP instructions ride under mcp");
  assert.ok(!names.some((n) => n.includes("DYNAMIC_BOUNDARY")));
});

await test("claude-jsonl: tails from where it stopped; a repeated request is not a second bill; a rewrite starts over", () => {
  const reader = openReader("claude-jsonl", CLAUDE_ID);
  assert.equal(reader.read().length, 2);
  assert.deepEqual(reader.read(), []);
  appendFileSync(claudeFile, claudeLine("req_B", "2026-10-20T11:42:31.000Z"));
  assert.deepEqual(reader.read(), [], "req_B was filed already");
  appendFileSync(claudeFile, claudeLine("req_C", "2026-10-20T11:42:40.000Z"));
  const [c] = reader.read();
  assert.equal(c?.callId, "req_C");
  assert.equal(c?.billed.cachedReadTokens, 100);
  /* Rewritten shorter, with no snapshot: every part is unseen and said so. */
  truncateSync(claudeFile, 0);
  writeFileSync(claudeFile, claudeLine("req_A", "2026-10-20T11:50:00.000Z"));
  const [again] = reader.read();
  assert.equal(again?.callId, "req_A", "the rewrite forgot what was seen");
  assert.deepEqual(again?.shape?.unseen, ["system", "tools", "mcp", "user", "assistant", "results"]);
  assert.deepEqual(again?.shape?.missing, ["the system prompt", "tool schemas", "the conversation"]);
  copyFileSync(join(FIXTURES, "claude-session.jsonl"), claudeFile);
});

await test("claude-jsonl: a session the store does not hold yields nothing", () => {
  const reader = openReader("claude-jsonl", "nope");
  assert.equal(reader.path(), null);
  assert.deepEqual(reader.read(), []);
});

/* ── codex-rollout ── */

await test("codex-rollout: a draft per token_count with a bill; cached inside input; no tool schemas", async () => {
  const reader = openReader("codex-rollout", CODEX_ID);
  assert.equal(reader.path(), codexFile);
  const drafts = reader.read();
  assert.equal(drafts.length, 1, "info:null and the all-zero event yield nothing");
  const [d] = drafts;
  assert.equal(d.model, "gpt-5.4");
  assert.equal(d.at, Date.parse("2026-03-11T22:24:03.100Z"));
  assert.deepEqual(d.billed, { totalTokens: 1280, inputTokens: 200, outputTokens: 80, cachedReadTokens: 1000, cachedWriteTokens: null, thoughtTokens: 30 });
  assert.equal(d.items, true);
  const parts = partsOf(billedPrompt(d.billed), await countShape(d.shape!));
  assert.ok((parts.prompt.system ?? 0) > 0);
  assert.ok((parts.prompt.user ?? 0) > 0, "the person's message is the conversation");
  assert.ok((parts.prompt.assistant ?? 0) > 0);
  assert.equal(parts.prompt.tools, null);
  assert.equal(parts.prompt.mcp, null);
  assert.equal(sumOf(parts.prompt), 1200);
  assert.deepEqual(parts.missing, ["tool schemas"]);
  const names = parts.items.system.map((i) => i.name);
  assert.equal(names[0], "System prompt › Base instructions");
  assert.ok(names.some((n) => n.startsWith("Developer instructions › ")));
  assert.ok(names.some((n) => n.startsWith("Context › ")));
  assert.deepEqual(reader.read(), []);
});

await test("codex-rollout: a rollout the store does not hold yields nothing", () => {
  assert.equal(openReader("codex-rollout", "nope").path(), null);
  assert.deepEqual(openReader("codex-rollout", "nope").read(), []);
});

/* ── opencode-sqlite ── */

await test("opencode-sqlite: a draft per completed assistant row with tokens; context only, said so", async () => {
  const reader = openReader("opencode-sqlite", OPENCODE_ID);
  assert.equal(reader.path(), opencodeFile);
  const drafts = reader.read();
  assert.equal(drafts.length, 1, "the user row and the failed zero-token row yield nothing");
  const [d] = drafts;
  assert.equal(d.callId, "msg_a1");
  assert.equal(d.model, "gpt-5.4");
  assert.equal(d.finishReason, "stop");
  assert.equal(d.at, 1792003842295);
  assert.equal(d.ms, 2705);
  assert.equal(d.costUsd, 0.0123);
  assert.deepEqual(d.billed, { totalTokens: 900 + 60 + 4000 + 100, inputTokens: 900, outputTokens: 60, cachedReadTokens: 4000, cachedWriteTokens: 100, thoughtTokens: 20 });
  const parts = partsOf(billedPrompt(d.billed), await countShape(d.shape!));
  assert.ok((parts.prompt.system ?? 0) > 0, "environment and date");
  assert.ok((parts.prompt.tools ?? 0) > 0, "the tool listing");
  assert.ok((parts.prompt.mcp ?? 0) > 0, "MCP guidance per server");
  assert.equal(parts.prompt.user, null);
  assert.equal(sumOf(parts.prompt), 5000);
  assert.deepEqual(parts.missing, ["its own system prompt", "tool schemas", "the conversation"]);
  assert.ok(parts.items.mcp.some((i) => i.name === "mcp__agents instructions"));
  assert.deepEqual(reader.read(), [], "nothing updated since");
});

await test("opencode-sqlite: a missing store yields nothing; an unknown schema throws (the door reads it as nothing)", () => {
  const saved = process.env.XDG_DATA_HOME;
  try {
    process.env.XDG_DATA_HOME = join(root, "nowhere");
    assert.equal(openReader("opencode-sqlite", OPENCODE_ID).path(), null);
    assert.deepEqual(openReader("opencode-sqlite", OPENCODE_ID).read(), []);
    process.env.XDG_DATA_HOME = join(root, "foreign");
    mkdirSync(join(root, "foreign", "opencode"), { recursive: true });
    const db = new DatabaseSync(join(root, "foreign", "opencode", "opencode.db"));
    db.exec("create table something_else (id text)");
    db.close();
    assert.throws(() => openReader("opencode-sqlite", OPENCODE_ID).read(), /no such table/);
  } finally {
    process.env.XDG_DATA_HOME = saved;
  }
});

/* ── the door ── */

/** A thread whose `emit` only collects, and whose session id is earned when the test says. */
function fakeThread(): CallThread & { emitted: ModelCall[]; earn(id: string): void } {
  let acp: string | null = null;
  let steps = 0;
  const thread: CallThread & { emitted: ModelCall[]; earn(id: string): void } = {
    emitted: [],
    earn: (id) => (acp = id),
    id: "thread-1",
    agentId: "claude-code",
    profileId: "p1",
    projectId: "w1",
    cwd: "/tmp/proj",
    viaGateway: false,
    acpSessionId: () => acp,
    turn: () => ({ turnId: "turn-1", nextStep: () => ++steps }),
    names: () => ({ threadTitle: "A thread", profileName: "Default", projectName: "Workspace" }),
    emit: (update: ModelCallUpdate) => {
      thread.emitted.push(update.call);
    },
  };
  return thread;
}

await test("door: does not attach where the store is not on this machine", async () => {
  const saved = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = join(root, "nowhere");
    assert.equal(await filesSource.attach(fakeThread(), { kind: "files", format: "codex-rollout" }), null);
  } finally {
    process.env.CODEX_HOME = saved;
  }
  assert.equal(await filesSource.attach(fakeThread(), { kind: "acp" }), null);
});

await test("door: waits for the earned id, skips a previous life's bills, files what the watch sees, stops", async () => {
  Object.assign(filesTiming, { pollMs: 40, debounceMs: 40 });
  const thread = fakeThread();
  const attached = await filesSource.attach(thread, { kind: "files", format: "claude-jsonl" });
  assert.ok(attached, "the store is here");
  await sleep(150);
  assert.equal(thread.emitted.length, 0, "no session id yet");
  thread.earn(CLAUDE_ID);
  await sleep(200);
  assert.equal(thread.emitted.length, 0, "the fixture's bills predate this life");
  appendFileSync(claudeFile, claudeLine("req_live", new Date().toISOString()));
  await sleep(400);
  assert.equal(thread.emitted.length, 1);
  const call = thread.emitted[0]!;
  assert.equal(call.callId, "req_live");
  assert.equal(call.source, "files");
  assert.equal(call.billed.cachedReadTokens, 100);
  assert.ok(call.prompt, "counted and anchored on the way through recordCall");
  assert.equal(sumOf(call.prompt!), 103);
  assert.deepEqual(call.missing, ["the conversation", "tool schemas"]);
  assert.ok(call.items, "first record carries the prefix items");
  attached!.stop();
  appendFileSync(claudeFile, claudeLine("req_after", new Date().toISOString()));
  await sleep(300);
  assert.equal(thread.emitted.length, 1, "stopped");
});

rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error(failures.join("\n\n"));
  process.exit(1);
}
process.exit(0);
