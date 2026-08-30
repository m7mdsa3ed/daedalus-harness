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
  gatewayUrlFor,
  isChatCompletion,
  normalizeMessagesResponse,
  parseGatewayPath,
  proxyGatewayRequest,
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

await test("the path grammar", () => {
  assert.deepEqual(parseGatewayPath("/gw/k/p1/claude-code/v1/messages"), {
    key: "k",
    profileId: "p1",
    agentId: "claude-code",
    rest: "/v1/messages",
  });
  assert.deepEqual(parseGatewayPath("/gw/k/p%201/a"), { key: "k", profileId: "p 1", agentId: "a", rest: "" });
  assert.equal(parseGatewayPath("/gw/k/p1"), null);
  assert.equal(parseGatewayPath("/api/sessions"), null);
});

await test("no shim, or no gateway, hands out nothing", () => {
  assert.equal(gatewayUrlFor("p1", "claude-code", "https://gw.example/v1"), "");
  configureGatewayShim({ port: 4321 });
  assert.equal(gatewayUrlFor("p1", "claude-code", ""), "");
  const url = gatewayUrlFor("p 1", "claude-code", "https://gw.example/v1");
  assert.match(url, /^http:\/\/127\.0\.0\.1:4321\/gw\/[0-9a-f]{48}\/p%201\/claude-code$/);
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
    agents: { "claude-code": {} },
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

await test("an error keeps its status and body; other paths pass through", async () => {
  const bad = await fetch(`${base}/v1/broken`, { method: "POST" });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: { message: "insufficient credits" } });
  const models = await fetch(`${base}/v1/models?limit=1`);
  assert.deepEqual(await models.json(), { data: [] });
  assert.equal(seen.at(-1)!.path, "/v1/v1/models?limit=1");
});

await test("a wrong key or an unknown profile is a 404, never a relay", async () => {
  const wrongKey = await fetch(`http://127.0.0.1:${shimPort}/gw/nope/gw-test/claude-code/v1/models`);
  assert.equal(wrongKey.status, 404);
  const key = base.split("/gw/")[1]!.split("/")[0];
  const noProfile = await fetch(`http://127.0.0.1:${shimPort}/gw/${key}/missing/claude-code/v1/models`);
  assert.equal(noProfile.status, 404);
});

server.close();
fake.close();

console.log(`gateway-shim: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
