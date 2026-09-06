/* The OpenCode subagent sidecar (src/opencode-subagents.ts): the pure
   translator against scripted bus events, the SSE framing, the merge into
   the bridge's inbound stream, and the fetch/retry/abort path against a tiny
   HTTP server that speaks `text/event-stream`. No database, no agent. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  OpencodeSubagentFeed,
  OpencodeTranslatorState,
  sseBlocks,
  translateOpencodeEvent,
  type Notification,
} from "../src/opencode-subagents.js";
import { mergeReadables } from "../src/acp-bridge.js";

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    failures.push(`${name}\n    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}

const ROOT = "ses_root";
const CHILD = "ses_child";

/* A child's whole life on the bus: created under the root, a message with a
   text part streamed by deltas, a reasoning part that finished without one,
   a tool run to completion, a step-finish, idle. */
const script = [
  { type: "session.created", properties: { info: { id: CHILD, parentID: ROOT, title: "Explore the repo" } } },
  { type: "message.updated", properties: { info: { id: "msg1", sessionID: CHILD, role: "assistant" } } },
  { type: "message.part.updated", properties: { part: { id: "p1", sessionID: CHILD, messageID: "msg1", type: "text", text: "" } } },
  { type: "message.part.delta", properties: { sessionID: CHILD, messageID: "msg1", partID: "p1", field: "text", delta: "Hello " } },
  { type: "message.part.delta", properties: { sessionID: CHILD, messageID: "msg1", partID: "p1", field: "text", delta: "world" } },
  { type: "message.part.updated", properties: { part: { id: "p1", sessionID: CHILD, messageID: "msg1", type: "text", text: "Hello world", time: { start: 1, end: 2 } } } },
  { type: "message.part.updated", properties: { part: { id: "p2", sessionID: CHILD, messageID: "msg1", type: "reasoning", text: "thinking…", time: { start: 1, end: 2 } } } },
  { type: "message.part.updated", properties: { part: { id: "p3", sessionID: CHILD, messageID: "msg1", type: "tool", callID: "call1", tool: "bash", state: { status: "running", input: { command: "ls" }, title: "ls" } } } },
  { type: "message.part.updated", properties: { part: { id: "p3", sessionID: CHILD, messageID: "msg1", type: "tool", callID: "call1", tool: "bash", state: { status: "completed", input: { command: "ls" }, title: "ls", output: "a\nb\n", metadata: {} } } } },
  { type: "message.part.updated", properties: { part: { id: "p4", sessionID: CHILD, messageID: "msg1", type: "step-finish", tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 0 } }, cost: 0.01 } } },
  { type: "session.status", properties: { sessionID: CHILD, status: { type: "idle" } } },
];

const runScript = (state: OpencodeTranslatorState, events: unknown[]): Notification[] =>
  events.flatMap((event) => translateOpencodeEvent(state, event as never));

await test("a child's life becomes the RFD sequence, addressed to the right sessions", () => {
  const state = new OpencodeTranslatorState(() => ROOT);
  const out = runScript(state, script);
  const shape = out.map((n) => `${n.params.sessionId}:${n.params.update.sessionUpdate}`);
  assert.deepEqual(shape, [
    `${ROOT}:subagent_spawned`,
    `${CHILD}:agent_message_chunk`,
    `${CHILD}:agent_message_chunk`,
    `${CHILD}:agent_thought_chunk`,
    `${CHILD}:tool_call`,
    `${CHILD}:tool_call_update`,
    `${ROOT}:_daedalus/subagent_usage`,
    `${ROOT}:subagent_state_update`,
  ]);
  const spawned = out[0].params.update as { name: string; subagentSessionId: string };
  assert.equal(spawned.name, "Explore the repo");
  assert.equal(spawned.subagentSessionId, CHILD);
  const call = out[4].params.update as { toolCallId: string; kind: string; status: string };
  assert.equal(call.toolCallId, "call1");
  assert.equal(call.kind, "execute");
  assert.equal(call.status, "in_progress");
  const done = out[5].params.update as { status: string; content: { content: { text: string } }[] };
  assert.equal(done.status, "completed");
  assert.equal(done.content[0].content.text, "a\nb\n");
  const usage = out[6].params.update as { usage: { totalTokens: number; cachedReadTokens: number } };
  assert.equal(usage.usage.totalTokens, 17);
  assert.equal(usage.usage.cachedReadTokens, 3);
  const state1 = out[7].params.update as { state: string };
  assert.equal(state1.state, "completed");
});

await test("the finished text part is not emitted twice when deltas carried it", () => {
  const state = new OpencodeTranslatorState(() => ROOT);
  const out = runScript(state, script);
  const prose = out
    .filter((n) => n.params.update.sessionUpdate === "agent_message_chunk")
    .map((n) => (n.params.update as { content: { text: string } }).content.text)
    .join("");
  assert.equal(prose, "Hello world");
});

await test("a child seen before the root id is known is held, then adopted", () => {
  let root: string | null = null;
  const state = new OpencodeTranslatorState(() => root);
  const early = runScript(state, script.slice(0, 3));
  assert.deepEqual(early, []);
  root = ROOT;
  const late = runScript(state, script.slice(3));
  assert.equal(late[0].params.update.sessionUpdate, "subagent_spawned");
  assert.equal(late[0].params.sessionId, ROOT);
  /* The first delta was seen before the root was known and was dropped with
     its part — the second and everything after arrive. */
  assert.ok(late.some((n) => n.params.update.sessionUpdate === "tool_call"));
});

await test("an unrelated session produces nothing", () => {
  const state = new OpencodeTranslatorState(() => ROOT);
  const foreign = script.map((event) => JSON.parse(JSON.stringify(event).replaceAll(ROOT, "ses_other")));
  assert.deepEqual(runScript(state, foreign), []);
});

await test("the task tool's metadata adopts a child whose session.created was missed", () => {
  const state = new OpencodeTranslatorState(() => ROOT);
  const out = runScript(state, [
    {
      type: "message.part.updated",
      properties: {
        part: {
          id: "pt", sessionID: ROOT, messageID: "m0", type: "tool", callID: "task1", tool: "task",
          state: { status: "completed", title: "Find tests", metadata: { sessionId: CHILD, parentSessionId: ROOT } },
        },
      },
    },
    ...script.slice(1),
  ]);
  assert.equal(out[0].params.update.sessionUpdate, "subagent_spawned");
  assert.equal((out[0].params.update as { name: string }).name, "Find tests");
  /* The root's own tool part is not re-emitted: ACP already carried it. */
  assert.ok(!out.some((n) => n.params.sessionId === ROOT && n.params.update.sessionUpdate === "tool_call"));
});

await test("a user-role part in the child is dropped, a tool error marks the child failed", () => {
  const state = new OpencodeTranslatorState(() => ROOT);
  const out = runScript(state, [
    script[0],
    { type: "message.updated", properties: { info: { id: "u1", sessionID: CHILD, role: "user" } } },
    { type: "message.part.updated", properties: { part: { id: "up", sessionID: CHILD, messageID: "u1", type: "text", text: "the brief", time: { end: 1 } } } },
    { type: "message.updated", properties: { info: { id: "a1", sessionID: CHILD, role: "assistant" } } },
    { type: "message.part.updated", properties: { part: { id: "t", sessionID: CHILD, messageID: "a1", type: "tool", callID: "c", tool: "read", state: { status: "error", error: "boom" } } } },
    { type: "session.status", properties: { sessionID: CHILD, status: { type: "idle" } } },
  ]);
  const kinds = out.map((n) => n.params.update.sessionUpdate);
  assert.deepEqual(kinds, ["subagent_spawned", "tool_call", "tool_call_update", "subagent_state_update"]);
  assert.equal((out[3].params.update as { state: string }).state, "failed");
});

await test("SSE framing splits on blank lines across chunk boundaries", async () => {
  const text = "data: {\"a\":1}\n\ndata: {\"b\":\ndata: 2}\n\n: comment\n\ndata: {\"c\":3}\n\n";
  const cut = 9;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(text.slice(0, cut)));
      c.enqueue(enc.encode(text.slice(cut)));
      c.close();
    },
  }).pipeThrough(sseBlocks());
  const blocks: string[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    blocks.push(value);
  }
  assert.deepEqual(blocks, ['{"a":1}', '{"b":\n2}', '{"c":3}']);
});

await test("mergeReadables interleaves and closes with the primary", async () => {
  let extraController!: ReadableStreamDefaultController<string>;
  const extra = new ReadableStream<string>({ start: (c) => (extraController = c) });
  let primaryController!: ReadableStreamDefaultController<string>;
  const primary = new ReadableStream<string>({ start: (c) => (primaryController = c) });
  const merged = mergeReadables(primary, extra);
  const reader = merged.getReader();
  primaryController.enqueue("p1");
  extraController.enqueue("e1");
  const a = await reader.read();
  const b = await reader.read();
  assert.deepEqual([a.value, b.value].sort(), ["e1", "p1"]);
  primaryController.close();
  const end = await reader.read();
  assert.equal(end.done, true);
});

await test("the feed connects, retries while the bus is not up, and stops on close", async () => {
  const events = script.map((event) => `data: ${JSON.stringify(event)}\n\n`);
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    assert.equal(req.headers.authorization, `Basic ${Buffer.from("opencode:secret").toString("base64")}`);
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const line of events) res.write(line);
    /* Left open, the way the bus is: the feed must not need EOF to deliver. */
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  /* The first attempt is refused (the port is not the server's yet) — the
     feed must retry rather than give up. */
  let attempt = 0;
  const fetchImpl: typeof fetch = (input, init) => {
    attempt += 1;
    if (attempt === 1) return Promise.reject(new Error("ECONNREFUSED"));
    return fetch(input, init);
  };
  const feed = new OpencodeSubagentFeed({ port, password: "secret", rootSessionId: () => ROOT, fetch: fetchImpl, log: () => {} });
  const reader = feed.stream.getReader();
  const got: string[] = [];
  while (got.length < 8) {
    const { done, value } = await reader.read();
    if (done) break;
    const message = value as unknown as Notification;
    got.push(`${message.params.sessionId}:${message.params.update.sessionUpdate}`);
  }
  assert.equal(got[0], `${ROOT}:subagent_spawned`);
  assert.equal(got[7], `${ROOT}:subagent_state_update`);
  assert.equal(requests, 1);
  assert.equal(attempt, 2);
  feed.close();
  const end = await reader.read();
  assert.equal(end.done, true);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
});

console.log(`opencode-subagents: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.error(`✗ ${failure}`);
process.exit(failures.length ? 1 : 0);
