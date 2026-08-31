// Self-check for the gateway shim: the reply repair (an OpenAI chat completion
// handed to a Claude-format caller becomes an Anthropic message; everything
// else is left byte-for-byte alone), the path grammar, and the URL an agent is
// handed. The proxy itself is exercised end to end against a local stand-in
// gateway that answers `/v1/messages` the way 9router does for a
// forced-streaming provider — with `choices[]` — and streams SSE untouched.
// Run: pnpm test:gateway
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { db, profiles as profilesTable } from "../src/db/index.js";
import {
  chatCompletionToMessage,
  configureGatewayShim,
  flattenNamespaces,
  renamespaceCalls,
  renamespaceSse,
  gatewayUrlFor,
  isChatCompletion,
  normalizeMessagesResponse,
  parseGatewayPath,
  proxyGatewayRequest,
  setGatewaySessionResolver,
  type GatewaySession,
} from "../src/gateway-shim.js";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
    })
    .catch((err) => {
      failures.push(`${name}\n    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    });
}

/* ── the pure half ── */

const completion = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "deepseek/deepseek-v4-flash-vision-exp",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "<reason>fine</reason><block>true</block>", reasoning_content: "We need to decide." },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240, prompt_tokens_details: { cached_tokens: 150 } },
};

await test("an OpenAI chat completion is recognised; an Anthropic message is not", () => {
  assert.equal(isChatCompletion(completion), true);
  assert.equal(isChatCompletion({ type: "message", content: [] }), false);
  assert.equal(isChatCompletion({ type: "error", error: { message: "x" } }), false);
  assert.equal(isChatCompletion("nope"), false);
});

await test("the conversion keeps the text, the reasoning and the counts", () => {
  const msg = chatCompletionToMessage(completion) as Record<string, any>;
  assert.equal(msg.type, "message");
  assert.equal(msg.role, "assistant");
  assert.equal(msg.id, "chatcmpl-1");
  assert.equal(msg.model, completion.model);
  assert.equal(msg.stop_reason, "end_turn");
  assert.deepEqual(msg.content, [
    { type: "thinking", thinking: "We need to decide.", signature: "" },
    { type: "text", text: "<reason>fine</reason><block>true</block>" },
  ]);
  // OpenAI counts cache reads inside prompt_tokens; Anthropic counts them apart.
  assert.deepEqual(msg.usage, {
    input_tokens: 50,
    output_tokens: 40,
    cache_read_input_tokens: 150,
    cache_creation_input_tokens: 0,
  });
});

await test("a reply truncated inside its reasoning says so honestly", () => {
  const msg = chatCompletionToMessage({
    ...completion,
    choices: [{ message: { content: "", reasoning_content: "still thinking" }, finish_reason: "length" }],
  }) as Record<string, any>;
  assert.equal(msg.stop_reason, "max_tokens");
  assert.deepEqual(msg.content, [{ type: "thinking", thinking: "still thinking", signature: "" }]);
});

await test("tool calls become tool_use blocks with parsed input", () => {
  const msg = chatCompletionToMessage({
    ...completion,
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id: "call_1", function: { name: "Read", arguments: '{"file_path":"/x"}' } },
            { id: "call_2", function: { name: "Bash", arguments: "not json" } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  }) as Record<string, any>;
  assert.equal(msg.stop_reason, "tool_use");
  assert.deepEqual(msg.content, [
    { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "/x" } },
    { type: "tool_use", id: "call_2", name: "Bash", input: {} },
  ]);
});

await test("normalize leaves a correct reply and a non-JSON body exactly as they were", () => {
  const anthropic = JSON.stringify({ type: "message", content: [{ type: "text", text: "hi" }] });
  assert.deepEqual(normalizeMessagesResponse(anthropic), { body: anthropic, rewritten: false });
  assert.deepEqual(normalizeMessagesResponse("event: ping\n\n"), { body: "event: ping\n\n", rewritten: false });
  const fixed = normalizeMessagesResponse(JSON.stringify(completion));
  assert.equal(fixed.rewritten, true);
  assert.equal((JSON.parse(fixed.body) as { type: string }).type, "message");
});

/* ── Codex's tool namespaces ── */

const namespaced = {
  model: "m",
  tools: [
    { type: "function", name: "exec_command", parameters: {} },
    {
      type: "namespace",
      name: "mcp__web_search",
      description: "web",
      tools: [
        { type: "function", name: "web_search", parameters: { type: "object" } },
        { type: "function", name: "web_fetch", parameters: { type: "object" } },
      ],
    },
    { type: "web_search" },
  ],
  input: [
    { type: "message", role: "user", content: "hi" },
    { type: "function_call", name: "web_search", namespace: "mcp__web_search", call_id: "c1", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "…" },
  ],
};

await test("namespace tools flatten to prefixed functions; a request without any is left alone", () => {
  const flat = flattenNamespaces(namespaced)!;
  assert.deepEqual(flat.namespaces, ["mcp__web_search"]);
  assert.deepEqual(
    (flat.body.tools as { type: string; name?: string }[]).map((t) => [t.type, t.name]),
    [
      ["function", "exec_command"],
      ["function", "mcp__web_search__web_search"],
      ["function", "mcp__web_search__web_fetch"],
      ["web_search", undefined],
    ],
  );
  // The member keeps its schema; the namespace's own description is not a tool.
  assert.deepEqual((flat.body.tools as Record<string, unknown>[])[1]!.parameters, { type: "object" });
  // The earlier call in the transcript is flattened the same way, namespace dropped.
  assert.deepEqual((flat.body.input as unknown[])[1], {
    type: "function_call",
    name: "mcp__web_search__web_search",
    call_id: "c1",
    arguments: "{}",
  });
  assert.equal(flattenNamespaces({ model: "m", tools: [{ type: "function", name: "x" }], input: [] }), null);
  assert.equal(flattenNamespaces("nope"), null);
});

await test("a flat call is put back under its namespace wherever it appears; longest prefix wins", () => {
  const ns = ["mcp__web_search", "mcp__web"];
  const fixed = renamespaceCalls(
    {
      type: "response.completed",
      response: {
        output: [
          { type: "function_call", name: "mcp__web_search__web_search", call_id: "c1", arguments: "{}" },
          { type: "function_call", name: "mcp__web__fetch", call_id: "c2", arguments: "{}" },
          { type: "function_call", name: "exec_command", call_id: "c3", arguments: "{}" },
          { type: "function_call", name: "other", namespace: "already", call_id: "c4" },
          { type: "message", content: [{ type: "output_text", text: "mcp__web_search__web_search" }] },
        ],
      },
    },
    ns,
  ) as Record<string, any>;
  assert.deepEqual(
    fixed.response.output.slice(0, 4).map((o: Record<string, unknown>) => [o.name, o.namespace]),
    [
      ["web_search", "mcp__web_search"],
      ["fetch", "mcp__web"],
      ["exec_command", undefined],
      ["other", "already"],
    ],
  );
  // Prose is not a call.
  assert.equal(fixed.response.output[4].content[0].text, "mcp__web_search__web_search");
});

await test("the SSE transform rewrites each event, survives a split inside one, and passes non-JSON through", async () => {
  const sse =
    'event: response.created\ndata: {"type":"response.created"}\n\n' +
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","name":"mcp__web_search__web_search","call_id":"c1","arguments":"{}"}}\n\n' +
    ": keep-alive\n\n" +
    "data: [DONE]\n\n";
  const cut = 70; // inside the second event
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      c.enqueue(enc.encode(sse.slice(0, cut)));
      c.enqueue(enc.encode(sse.slice(cut)));
      c.close();
    },
  }).pipeThrough(renamespaceSse(["mcp__web_search"]));
  const out = await new Response(stream).text();
  const blocks = out.split("\n\n");
  assert.equal(blocks[0], 'event: response.created\ndata: {"type":"response.created"}');
  const item = JSON.parse(blocks[1]!.split("\ndata: ")[1]!).item;
  assert.deepEqual(item, { type: "function_call", name: "web_search", call_id: "c1", arguments: "{}", namespace: "mcp__web_search" });
  assert.equal(blocks[2], ": keep-alive");
  assert.equal(blocks[3], "data: [DONE]");
});

await test("the path grammar", () => {
  assert.deepEqual(parseGatewayPath("/gw/k/p/p1/claude-code/v1/messages"), {
    key: "k",
    kind: "p",
    id: "p1",
    agentId: "claude-code",
    rest: "/v1/messages",
  });
  assert.deepEqual(parseGatewayPath("/gw/k/s/sess-1/codex"), {
    key: "k",
    kind: "s",
    id: "sess-1",
    agentId: "codex",
    rest: "",
  });
  assert.deepEqual(parseGatewayPath("/gw/k/p/p%201/a"), { key: "k", kind: "p", id: "p 1", agentId: "a", rest: "" });
  assert.equal(parseGatewayPath("/gw/k/p/p1"), null);
  // The old two-segment shape is not a kind, so it is not ours any more.
  assert.equal(parseGatewayPath("/gw/k/p1/claude-code"), null);
  assert.equal(parseGatewayPath("/api/sessions"), null);
});

await test("no shim, or no gateway, hands out nothing", () => {
  assert.equal(gatewayUrlFor("p1", "claude-code", "https://gw.example/v1"), "");
  configureGatewayShim({ port: 4321 });
  assert.equal(gatewayUrlFor("p1", "claude-code", ""), "");
  const url = gatewayUrlFor("p 1", "claude-code", "https://gw.example/v1");
  assert.match(url, /^http:\/\/127\.0\.0\.1:4321\/gw\/[0-9a-f]{48}\/p\/p%201\/claude-code$/);
  // A spawn on a thread's behalf names the thread, which is what lets the
  // profile behind it change while the child keeps the same URL.
  const scoped = gatewayUrlFor("p1", "codex", "https://gw.example/v1", "sess 1");
  assert.match(scoped, /^http:\/\/127\.0\.0\.1:4321\/gw\/[0-9a-f]{48}\/s\/sess%201\/codex$/);
});

/* ── the proxy, end to end ── */

/** A gateway that answers Messages calls the way 9router does for a
    forced-streaming provider: streaming as Anthropic SSE, non-streaming as an
    OpenAI chat completion. Records what it was sent. */
const seen: { path: string; headers: Record<string, string>; body: string }[] = [];
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    seen.push({ path: req.url ?? "", headers: req.headers as Record<string, string>, body });
    if (req.url?.includes("/messages")) {
      const wantsStream = /"stream"\s*:\s*true/.test(body);
      if (wantsStream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(completion));
      return;
    }
    if (req.url?.includes("/responses")) {
      // A gateway that speaks flat functions only: echoes back a call to the
      // first `mcp__…` function it was offered, by its flat name.
      const tools = (JSON.parse(body) as { tools?: { type: string; name?: string }[] }).tools ?? [];
      const mcp = tools.find((t) => t.type === "function" && t.name?.startsWith("mcp__"));
      const item = mcp
        ? { type: "function_call", name: mcp.name, call_id: "c1", arguments: "{}" }
        : { type: "message", role: "assistant", content: [{ type: "output_text", text: "no mcp tool offered" }] };
      const wantsStream = /"stream"\s*:\s*true/.test(body);
      if (wantsStream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`);
        res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { output: [item] } })}\n\n`);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "r1", object: "response", output: [item] }));
      return;
    }
    if (req.url?.includes("/broken")) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "insufficient credits" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
  });
});
await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
const fakePort = (fake.address() as { port: number }).port;

const app = new Hono();
app.all("/gw/*", (c) => proxyGatewayRequest(c.req.raw));
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>((r) => server.once("listening", r));
const shimPort = (server.address() as { port: number }).port;
configureGatewayShim({ port: shimPort });

db.delete(profilesTable).run();
db.insert(profilesTable)
  .values({
    id: "gw-test",
    name: "gw",
    agents: { "claude-code": {}, codex: {} },
    baseUrl: `http://127.0.0.1:${fakePort}/v1/`,
    apiKey: "sk",
    models: [],
    defaultModel: "",
  } as never)
  .run();

const base = gatewayUrlFor("gw-test", "claude-code", "x");

await test("a non-streaming Messages reply comes back as an Anthropic message", async () => {
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk", "anthropic-beta": "context-1m-2025-08-07" },
    body: JSON.stringify({ model: "m", max_tokens: 64, messages: [] }),
  });
  assert.equal(res.status, 200);
  const msg = (await res.json()) as Record<string, any>;
  assert.equal(msg.type, "message");
  assert.equal(msg.content[1].text, "<reason>fine</reason><block>true</block>");
  const last = seen.at(-1)!;
  // The SDK's path is appended to the base URL exactly as it would be without
  // the shim (a `/v1` base gets `/v1/v1/messages`, which is what the gateway
  // already answered), the trailing slash does not double up, and the CLI's
  // own credentials and betas travel as sent.
  assert.equal(last.path, "/v1/v1/messages");
  assert.equal(last.headers["x-api-key"], "sk");
  assert.equal(last.headers["anthropic-beta"], "context-1m-2025-08-07");
});

await test("a streaming reply is piped through untouched", async () => {
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", stream: true, messages: [] }),
  });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.match(await res.text(), /^event: message_start\n/);
});

const codexBase = gatewayUrlFor("gw-test", "codex", "x");

await test("Codex's namespace tools reach the gateway flat and its call comes back namespaced (SSE)", async () => {
  const res = await fetch(`${codexBase}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk" },
    body: JSON.stringify({ ...namespaced, stream: true }),
  });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const text = await res.text();
  const sent = JSON.parse(seen.at(-1)!.body) as typeof namespaced;
  // What the gateway saw: functions only, the transcript's call flattened to match.
  assert.ok(sent.tools.every((t) => t.type !== "namespace"));
  assert.ok(sent.tools.some((t) => t.name === "mcp__web_search__web_search"));
  assert.equal((sent.input[1] as { name: string }).name, "mcp__web_search__web_search");
  assert.equal(seen.at(-1)!.headers.authorization, "Bearer sk");
  // What Codex sees: the call under its namespace, in both events.
  const events = text.split("\n\n").filter(Boolean).map((b) => JSON.parse(b.split("\ndata: ")[1]!));
  assert.deepEqual(events[0].item, { type: "function_call", name: "web_search", call_id: "c1", arguments: "{}", namespace: "mcp__web_search" });
  assert.equal(events[1].response.output[0].namespace, "mcp__web_search");
});

await test("…and in a buffered JSON reply; a request with no namespace is forwarded untouched", async () => {
  const res = await fetch(`${codexBase}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(namespaced),
  });
  const reply = (await res.json()) as { output: { name: string; namespace?: string }[] };
  assert.deepEqual([reply.output[0]!.name, reply.output[0]!.namespace], ["web_search", "mcp__web_search"]);
  const plain = JSON.stringify({ model: "m", tools: [{ type: "function", name: "exec_command" }], input: [] });
  const res2 = await fetch(`${codexBase}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: plain });
  assert.equal(seen.at(-1)!.body, plain);
  assert.equal(((await res2.json()) as { output: { type: string }[] }).output[0]!.type, "message");
});

await test("an error keeps its status and body; other paths pass through", async () => {
  const bad = await fetch(`${base}/v1/broken`, { method: "POST" });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: { message: "insufficient credits" } });
  const models = await fetch(`${base}/v1/models?limit=1`);
  assert.deepEqual(await models.json(), { data: [] });
  assert.equal(seen.at(-1)!.path, "/v1/v1/models?limit=1");
});

await test("a wrong key, an unknown profile or an unknown thread is a 404, never a relay", async () => {
  const wrongKey = await fetch(`http://127.0.0.1:${shimPort}/gw/nope/p/gw-test/claude-code/v1/models`);
  assert.equal(wrongKey.status, 404);
  const key = base.split("/gw/")[1]!.split("/")[0];
  const noProfile = await fetch(`http://127.0.0.1:${shimPort}/gw/${key}/p/missing/claude-code/v1/models`);
  assert.equal(noProfile.status, 404);
  const noThread = await fetch(`http://127.0.0.1:${shimPort}/gw/${key}/s/missing/codex/v1/models`);
  assert.equal(noThread.status, 404);
});

/* ── the session-scoped route: the thread's provider and model, per request ── */

let thread: GatewaySession = {
  profileId: "gw-test",
  agentId: "codex",
  model: "",
  effort: "",
  rewriteModel: false,
};
setGatewaySessionResolver((id) => (id === "sess-1" ? thread : undefined));
const sessionBase = gatewayUrlFor("gw-test", "codex", "x", "sess-1");

await test("a thread forwards untouched until its model has actually moved", async () => {
  const body = JSON.stringify({ model: "spawned-model", input: [] });
  await fetch(`${sessionBase}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  // Nothing to repair, so the body is the one the child wrote, byte for byte.
  assert.equal(seen.at(-1)!.body, body);
});

await test("a moved thread's model and effort are replaced on the wire", async () => {
  thread = { ...thread, model: "gateway/model-b", effort: "high", rewriteModel: true };
  await fetch(`${sessionBase}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "spawned-model", reasoning: { effort: "low", summary: "auto" }, input: [] }),
  });
  const sent = JSON.parse(seen.at(-1)!.body) as { model: string; reasoning: Record<string, string> };
  assert.equal(sent.model, "gateway/model-b");
  // The effort moves; everything else the child put beside it stays.
  assert.deepEqual(sent.reasoning, { effort: "high", summary: "auto" });
});

await test("the credential travels as the thread's profile, not as the child's", async () => {
  // The child was spawned on another profile and still sends that key; what
  // reaches the gateway is the one the thread is on now.
  await fetch(`${sessionBase}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer stale-key" },
    body: JSON.stringify({ model: "spawned-model", input: [] }),
  });
  assert.equal(seen.at(-1)!.headers.authorization, "Bearer sk");
  await fetch(`${sessionBase}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "stale-key" },
    body: JSON.stringify({ model: "spawned-model", messages: [] }),
  });
  assert.equal(seen.at(-1)!.headers["x-api-key"], "sk");
  // A Messages body is read too once the thread has moved — that is where
  // Claude Code's side-job and alias models, pinned into its env at spawn,
  // would otherwise keep naming the previous provider's ids.
  assert.equal((JSON.parse(seen.at(-1)!.body) as { model: string }).model, "gateway/model-b");
});

server.close();
fake.close();

console.log(`gateway-shim: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
