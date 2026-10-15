// Self-check for the opencode-free provider: session shape (valid counter),
// stable-per-thread sessions, header contract, fingerprint tools, and the
// never-`none` / always-stream rules. Run: pnpm test:providers-opencode-free
import assert from "node:assert/strict";
import {
  FINGERPRINT_TOOLS,
  OPENCODE_FREE_SESSION_RE,
  OPENCODE_FREE_UA,
  freshSession,
  opencodeFree,
  sessionCounter,
  sessionForThread,
} from "../src/providers/opencode-free.js";
import { detectProvider } from "../src/providers/index.js";

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    failures.push(`${name}\n    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}

await test("sessions match the canonical format with counter pinned to 1", () => {
  for (let i = 0; i < 20; i++) {
    const id = freshSession();
    assert.match(id, OPENCODE_FREE_SESSION_RE);
    assert.equal(sessionCounter(id), 1);
  }
});

await test("sessions are stable per thread and differ per thread", () => {
  const a = sessionForThread("thread-a");
  assert.match(a, OPENCODE_FREE_SESSION_RE);
  assert.equal(sessionCounter(a), 1);
  assert.equal(sessionForThread("thread-a"), a);
  assert.notEqual(sessionForThread("thread-b"), a);
});

await test("foreign strings are not valid sessions", () => {
  assert.equal(sessionCounter("hello"), null);
  assert.equal(sessionCounter("ses_zzzzzzzzzzzzAAAAAAAAAAAAAA"), null);
  assert.equal(sessionCounter(""), null);
});

await test("headers carry the v2 fingerprint and never x-opencode-request", () => {
  const h = opencodeFree.headers({ threadId: "t1", agentId: "daedalus", profileId: "p1" });
  assert.equal(h["user-agent"], OPENCODE_FREE_UA);
  assert.equal(h["authorization"], "Bearer public");
  assert.equal(h["x-opencode-client"], "cli");
  assert.match(h["x-opencode-session"]!, OPENCODE_FREE_SESSION_RE);
  assert.equal(h["x-opencode-session-id"], h["x-opencode-session"]);
  assert.equal(h["x-session-affinity"], h["x-opencode-session"]);
  assert.equal(h["x-session-id"], h["x-opencode-session"]);
  assert.ok(!("x-opencode-request" in h));
  assert.ok(opencodeFree.dropRequestHeaders().includes("x-opencode-request"));
});

await test("transform forces stream and drops tool_choice none", () => {
  const body: Record<string, unknown> = {
    model: "mimo-v2.6-flash-free",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
    tool_choice: "none",
  };
  opencodeFree.transformBody(body, { threadId: "t1", agentId: "daedalus", profileId: "p1" });
  assert.equal(body.stream, true);
  assert.ok(!("tool_choice" in body));
});

await test("transform appends exact read/shell and a placeholder note", () => {
  const body: Record<string, unknown> = { model: "m", messages: [{ role: "user", content: "hi" }] };
  opencodeFree.transformBody(body, { threadId: "t1", agentId: "daedalus", profileId: "p1" });
  const tools = body.tools as { function: { name: string; description: string; parameters: unknown } }[];
  assert.deepEqual(
    tools.map((t) => t.function.name),
    ["read", "shell"],
  );
  for (const want of FINGERPRINT_TOOLS) {
    const got = tools.find((t) => t.function.name === want.name)!;
    assert.equal(got.function.description, want.description);
    assert.deepEqual(got.function.parameters, want.parameters);
  }
  const messages = body.messages as { role: string; content: string }[];
  assert.equal(messages[0]!.role, "system");
  assert.match(messages[0]!.content, /placeholders/);
});

await test("a caller tool named shell is aliased, not duplicated", () => {
  const mine = { type: "function", function: { name: "shell", description: "mine", parameters: { type: "object" } } };
  const body: Record<string, unknown> = { model: "m", messages: [], tools: [mine] };
  opencodeFree.transformBody(body, { threadId: "t1", agentId: "daedalus", profileId: "p1" });
  const names = (body.tools as { function: { name: string } }[]).map((t) => t.function.name);
  assert.deepEqual(names, ["shell_client", "read", "shell"]);
});

await test("detection keys off the opencode inference base URL", () => {
  assert.equal(detectProvider("https://opencode.ai/inference/v1")?.id, "opencode-free");
  assert.equal(detectProvider("https://opencode.ai/inference/v1/")?.id, "opencode-free");
  assert.equal(detectProvider("https://api.openai.com/v1"), undefined);
  assert.equal(detectProvider(""), undefined);
});

await test("upstream path routes spark to responses, rest to chat", () => {
  assert.equal(opencodeFree.upstreamPath("muse-spark-1.3-contributor-free", "/chat/completions"), "/responses");
  assert.equal(opencodeFree.upstreamPath("muse-spark-1.3-contributor-free(high)", "/chat/completions"), "/responses");
  assert.equal(opencodeFree.upstreamPath("mimo-v2.6-flash-free", "/chat/completions"), "/chat/completions");
  assert.equal(opencodeFree.upstreamDialect("muse-spark-1.3-contributor-free"), "responses");
  assert.equal(opencodeFree.upstreamDialect("mimo-v2.6-flash-free"), "chat");
});

await test("spark transform produces a responses body with flat tools", () => {
  const body: Record<string, unknown> = {
    model: "muse-spark-1.3-contributor-free",
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", function: { name: "bash", arguments: "{\"command\":\"ls\"}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "file.txt" },
      { role: "user", content: "thanks" },
    ],
    tools: [{ type: "function", function: { name: "shell", description: "mine", parameters: { type: "object" } } }],
    max_tokens: 512,
  };
  opencodeFree.transformBody(body, { threadId: "t1", agentId: "daedalus", profileId: "p1" });
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.max_output_tokens, 512);
  assert.match(String(body.instructions), /Be brief\./);
  assert.match(String(body.instructions), /placeholders/);
  const types = (body.input as { type: string }[]).map((i) => i.type);
  assert.deepEqual(types, ["message", "function_call", "function_call_output", "message"]);
  const names = (body.tools as { name: string }[]).map((t) => t.name);
  assert.deepEqual(names, ["shell_client", "read", "shell"]);
  assert.ok(!(body.messages || body.max_tokens));
});

await test("responses path aliases gated legacy names and renames history", async () => {
  const { renamesForBody } = await import("../src/providers/opencode-free.js");
  const body: Record<string, unknown> = {
    model: "muse-spark-1.3-contributor-free",
    messages: [
      { role: "user", content: "list files" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
    ],
    tools: [{ type: "function", function: { name: "bash", description: "mine", parameters: { type: "object" } } }],
  };
  opencodeFree.transformBody(body, { threadId: "t1", agentId: "daedalus", profileId: "p1" });
  const names = (body.tools as { name: string }[]).map((t) => t.name);
  assert.deepEqual(names, ["bash_client", "read", "shell"]);
  const calls = (body.input as { type: string; name?: string }[]).filter((i) => i.type === "function_call");
  assert.deepEqual(calls.map((c) => c.name), ["bash_client"]);
  const renames = renamesForBody(body);
  assert.equal(renames.get("bash_client"), "bash");
  const { responsesJsonToChat } = await import("../src/providers/opencode-free.js");
  const out = responsesJsonToChat({
    id: "resp_1", object: "response", model: "m", created_at: 1,
    output: [{ type: "function_call", call_id: "c2", name: "bash_client", arguments: "{}" }],
    usage: {},
  }, renames) as { choices: { message: { tool_calls: { function: { name: string } }[] } }[] };
  assert.equal(out.choices[0].message.tool_calls[0].function.name, "bash");
});

await test("non-stream child gets one chat JSON, not SSE", async () => {
  const { responsesSseToJson, chatSseToJson } = await import("../src/providers/opencode-free.js");
  const respSse = [
    'data: {"type":"response.created","response":{"id":"resp_9","model":"m","created_at":50}}',
    "",
    'data: {"type":"response.output_text.delta","delta":"Hi there"}',
    "",
    'data: {"type":"response.completed","response":{"id":"resp_9","usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const agg = responsesSseToJson(respSse) as {
    object: string; choices: { message: { role: string; content: string }; finish_reason: string }[]; usage: { prompt_tokens: number; completion_tokens: number };
  };
  assert.equal(agg.object, "chat.completion");
  assert.equal(agg.choices[0].message.content, "Hi there");
  assert.equal(agg.choices[0].finish_reason, "stop");
  assert.deepEqual([agg.usage.prompt_tokens, agg.usage.completion_tokens], [7, 3]);

  const chatSse = [
    'data: {"id":"c1","object":"chat.completion.chunk","created":50,"model":"m","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
    "",
    'data: {"id":"c1","object":"chat.completion.chunk","created":50,"model":"m","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}',
    "",
    'data: {"id":"c1","object":"chat.completion.chunk","created":50,"model":"m","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}',
    "",
    'data: {"id":"c1","object":"chat.completion.chunk","created":50,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const agg2 = chatSseToJson(chatSse, "m") as { object: string; choices: { message: { content: string }; finish_reason: string }[] };
  assert.equal(agg2.object, "chat.completion");
  assert.equal(agg2.choices[0].message.content, "Hello");
  assert.equal(agg2.choices[0].finish_reason, "stop");
});

await test("wrapResponse aggregates SSE to JSON when the child did not ask to stream", async () => {
  const sse = [
    'data: {"type":"response.created","response":{"id":"resp_9","model":"muse-spark-1.3-contributor-free","created_at":50}}',
    "",
    'data: {"type":"response.output_text.delta","delta":"Hi"}',
    "",
    'data: {"type":"response.completed","response":{"id":"resp_9","usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const upstream = new Response(sse, { headers: { "content-type": "text/event-stream" } });
  const out = await opencodeFree.wrapResponse(upstream, "muse-spark-1.3-contributor-free", new Map(), { wantStream: false });
  assert.equal(out.headers.get("content-type"), "application/json");
  const json = (await out.json()) as { object: string; choices: { message: { content: string } }[] };
  assert.equal(json.object, "chat.completion");
  assert.equal(json.choices[0].message.content, "Hi");

  const upstream2 = new Response(sse, { headers: { "content-type": "text/event-stream" } });
  const out2 = await opencodeFree.wrapResponse(upstream2, "muse-spark-1.3-contributor-free", new Map(), { wantStream: true });
  assert.match(out2.headers.get("content-type") ?? "", /text\/event-stream/);
});

await test("responses SSE blocks become chat chunks ending in DONE", async () => {
  const { responsesSseBlockToChat } = await import("../src/providers/opencode-free.js");
  const state = { id: "x", model: "", created: 0, roleSent: false, callIndex: -1, pendingCalls: new Map(), hasToolCalls: false, usage: null, renames: new Map() };
  const blocks = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"muse-spark-1.3-contributor-free","created_at":100}}',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}',
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_9","name":"bash"}}',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"{\\"command\\""}',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}',
  ];
  const lines = blocks.flatMap((b) => responsesSseBlockToChat(b, state as never));
  const chunks = lines.filter((l) => l.startsWith("data:") && !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(5).trim()));
  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  assert.equal(chunks[1].choices[0].delta.content, "Hi");
  assert.equal(chunks[2].choices[0].delta.tool_calls[0].function.name, "bash");
  assert.equal(chunks[3].choices[0].delta.tool_calls[0].function.arguments, '{"command"');
  const last = chunks[chunks.length - 1];
  assert.equal(last.choices[0].finish_reason, "tool_calls");
  assert.equal(lines[lines.length - 1], "data: [DONE]");
});

await test("responses JSON becomes a chat completion", async () => {
  const { responsesJsonToChat } = await import("../src/providers/opencode-free.js");
  const out = responsesJsonToChat({
    id: "resp_1",
    object: "response",
    model: "muse-spark-1.3-contributor-free",
    created_at: 100,
    output: [
      { type: "message", content: [{ type: "output_text", text: "Hi" }] },
      { type: "function_call", call_id: "call_9", name: "bash", arguments: "{}" },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  }) as { choices: { message: { content: string; tool_calls: { function: { name: string } }[] }; finish_reason: string }[] };
  assert.equal(out.choices[0].message.content, "Hi");
  assert.equal(out.choices[0].message.tool_calls[0].function.name, "bash");
  assert.equal(out.choices[0].finish_reason, "tool_calls");
});

if (failures.length) {
  console.error(`\n${failures.length} FAILURES:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`providers-opencode-free: ${passed} passed`);
