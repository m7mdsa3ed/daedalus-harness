// Self-check for the OTLP intake (`otlp.ts`): a runtime's own telemetry filed as
// the thread's spans — standard OTLP/JSON in, `claude-otlp` dialect read, the
// identity attributes dropped, the interaction hung under the harness's own
// prompt span — and the half that matters for tokens: the request body a runtime
// names on an event is read from the thread's own directory only, divided into
// parts, written beside the model span and deleted.
// Run: pnpm test:otlp
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { agents as agentsTable, db, profiles as profilesTable, projects as projectsTable, sessions as sessionsTable } from "../src/db/index.js";
import { configureOtlp, handleOtlp, otlpBodiesFor, otlpUrlFor, setOtlpThreadCheck } from "../src/otlp.js";
import { endSpan, getSpan, ingest, listSpans, startSpan } from "../src/tracing.js";

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

await db.insert(agentsTable).values({ id: "claude-code", name: "Claude", command: "x", args: [], env: {}, seededVersion: 1 });
await db.insert(profilesTable).values({ id: "p1", name: "p", agents: {}, baseUrl: "", apiKey: "", defaultModel: "m", smallModel: "", logoUrl: "", models: [] });
await db.insert(projectsTable).values({
  id: "w1", name: "ws", cwd: "/tmp/ws", logoUrl: "", defaultProfileId: "p1", defaultAgentId: "claude-code", defaultModel: "m", defaultEffort: "",
  defaultModeId: "", defaultConfigChoices: {}, defaultMcpServerIds: [], defaultSkillIds: [], defaultCommandIds: [], defaultSuggestKinds: [],
  defaultUiBlocks: false, defaultUiGroups: [], defaultAskProfiles: {},
});
await db.insert(sessionsTable).values({ id: "t1", profileId: "p1", projectId: "w1", agentId: "claude-code", model: "m", effort: "", title: "T", acpSessionId: "acp-1", createdAt: Date.now() });

const app = new Hono();
app.all("/otlp/*", (c) => handleOtlp(c.req.raw));
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise((resolve) => server.once("listening", resolve));
const port = (server.address() as { port: number }).port;
configureOtlp({ port });
setOtlpThreadCheck((id) => id === "t1");
const base = otlpUrlFor("t1");

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" || Buffer.isBuffer(body) ? (body as BodyInit) : JSON.stringify(body),
  });
const kv = (key: string, value: string | number | boolean) => ({
  key,
  value: typeof value === "string" ? { stringValue: value } : typeof value === "number" ? { intValue: String(value) } : { boolValue: value },
});
const nanos = (ms: number) => String(BigInt(Math.round(ms)) * 1_000_000n);
const settled = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 40; i++) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

/* ── the path is the credential ── */

await test("a wrong key, an unknown thread and a non-JSON body are refused", async () => {
  const wrongKey = await fetch(`${base.replace(/\/otlp\/[^/]+\//, "/otlp/nope/")}/v1/traces`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(wrongKey.status, 404);
  const unknown = await fetch(base.replace("/t1", "/other") + "/v1/traces", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(unknown.status, 404);
  assert.equal((await post("/v1/traces", "{}", { "content-type": "application/x-protobuf" })).status, 415);
  assert.equal((await post("/v1/traces", "not json")).status, 400);
  assert.equal((await post("/v1/metrics", {})).status, 200, "metrics are accepted and ignored");
});

/* ── a request, as Claude Code reports it ── */

const dir = otlpBodiesFor("t1").replace(/^file:/, "");
const requestFile = `${dir}/b1.request.json`;
const requestBody = {
  model: "claude-opus-5-5",
  system: [{ type: "text", text: `You are an agent. ${"alpha ".repeat(300)}` }],
  tools: [
    { name: "Bash", description: "run a shell command ".repeat(20), input_schema: { type: "object" } },
    { name: "mcp__docs__search", description: "search the docs ".repeat(10), input_schema: { type: "object" } },
  ],
  messages: [
    { role: "user", content: [{ type: "text", text: `<system-reminder>\nCLAUDE.md says ${"be careful ".repeat(80)}\n</system-reminder>` }, { type: "text", text: "fix the bug please" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "x", name: "Bash", input: { command: "ls" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "file-a\nfile-b" }] },
  ],
};
const T0 = Date.now();

await test("an interaction hangs under the harness's prompt span, its model span carries exact usage, and identity is dropped", async () => {
  const prompt = startSpan("t1", "session/prompt", "request");
  mkdirSync(dir, { recursive: true });
  writeFileSync(requestFile, JSON.stringify(requestBody));
  writeFileSync(`${dir}/index.jsonl`, JSON.stringify({ request_id: "req_1", request_file: "b1.request.json", response_file: "req_1.response.json" }) + "\n");

  const identity = [kv("user.email", "me@example.com"), kv("user.id", "u"), kv("organization.id", "o"), kv("session.id", "claude-session")];
  const traces = {
    resourceSpans: [{
      resource: { attributes: [kv("service.name", "claude-code"), kv("user.email", "me@example.com")] },
      scopeSpans: [{
        scope: { name: "com.anthropic.claude_code", version: "9.9.9" },
        spans: [
          { traceId: "a".repeat(32), spanId: "1".repeat(16), parentSpanId: "2".repeat(16), kind: 3, traceState: "vendor=1",
            links: [{ traceId: "c".repeat(32), spanId: "3".repeat(16), attributes: [kv("why", "retry")] }], name: "claude_code.llm_request", startTimeUnixNano: nanos(T0 + 10), endTimeUnixNano: nanos(T0 + 900),
            attributes: [...identity, kv("model", "claude-opus-5-5"), kv("input_tokens", 2), kv("output_tokens", 40), kv("cache_read_tokens", 1000), kv("cache_creation_tokens", 500), kv("request_id", "req_1"), kv("ttft_ms", 300)], status: { code: 0 } },
          { traceId: "a".repeat(32), spanId: "2".repeat(16), name: "claude_code.interaction", startTimeUnixNano: nanos(T0), endTimeUnixNano: nanos(T0 + 1000),
            attributes: [...identity, kv("interaction.sequence", 1)], status: { code: 1 } },
        ],
      }],
    }],
  };
  assert.equal((await post("/v1/traces", gzipSync(JSON.stringify(traces)), { "content-encoding": "gzip" })).status, 200, "gzip is accepted");
  const logs = {
    resourceLogs: [{ scopeLogs: [{ logRecords: [
      { attributes: [kv("event.name", "api_request_body"), kv("body_ref", requestFile), kv("body_length", 100)] },
      { attributes: [kv("event.name", "api_request"), kv("request_id", "req_1"), kv("input_tokens", 2), kv("output_tokens", 40), kv("cache_read_tokens", 1000), kv("cache_creation_tokens", 500)] },
    ] }] }],
  };
  assert.equal((await post("/v1/logs", logs)).status, 200);
  endSpan(prompt);

  const model = async () => (await listSpans("t1")).find((s) => s.name === "chat claude-opus-5-5");
  assert.ok(await settled(async () => Boolean((await model())?.attributes["daedalus.prompt_parts"])), "the parts were written beside the model span");
  const spans = await listSpans("t1");
  const interaction = spans.find((s) => s.name === "invoke_agent")!;
  const request = spans.find((s) => s.kind === "request")!;
  assert.equal(interaction.parentSpanId, request.spanId, "the interaction hangs under the harness's prompt");
  assert.equal(interaction.traceId, request.traceId, "…in the same trace");
  const chat = (await model())!;
  assert.equal(chat.parentSpanId, interaction.spanId);
  assert.equal(chat.traceId, request.traceId, "its child follows");
  assert.equal(chat.kind, "model");
  assert.equal(chat.attributes["gen_ai.usage.input_tokens"], 1502, "input counts what was cached, as the bridge writes it");
  assert.equal(chat.attributes["gen_ai.usage.cache_read.input_tokens"], 1000);
  assert.equal(chat.attributes["daedalus.ttft_ms"], 300);
  for (const key of ["user.email", "user.id", "organization.id"]) assert.equal(chat.attributes[key], undefined, `${key} is dropped`);
  assert.equal(chat.attributes["session.id"], "claude-session", "what is not identity stays");
  /* The OTel span model is kept whole, not flattened to the attributes. */
  assert.equal(chat.spanKind, "client");
  assert.deepEqual(chat.scope, { name: "com.anthropic.claude_code", version: "9.9.9" });
  assert.deepEqual(chat.resource, { "service.name": "claude-code" }, "the resource keeps its attributes, minus identity");
  assert.equal(chat.traceState, "vendor=1");
  assert.deepEqual(chat.links, [{ traceId: "c".repeat(32), spanId: "3".repeat(16), attributes: { why: "retry" } }]);
  assert.equal(request.spanKind, "client", "the harness's own prompt request is a client span");
  assert.equal(request.scope?.name, "daedalus-harness");
  assert.equal(request.resource?.["service.name"], "daedalus-harness");
});

await test("the parts add up to the provider's total, split system / tools / MCP / conversation, and the body is gone", async () => {
  const chat = (await listSpans("t1")).find((s) => s.name === "chat claude-opus-5-5")!;
  const whole = (await getSpan("t1", chat.spanId))!;
  const parts = JSON.parse(String(whole.attributes["daedalus.prompt_parts"]));
  assert.equal(parts.source, "otlp");
  assert.equal(parts.total, 1502);
  assert.equal(parts.system + parts.tools + parts.mcp + parts.conversation + parts.overhead, 1502);
  assert.ok(parts.system > 0 && parts.tools > 0 && parts.mcp > 0, "each static part is counted");
  assert.equal(parts.user + parts.assistant + parts.results, parts.conversation);
  assert.ok(parts.user > 0 && parts.assistant > 0 && parts.results > 0);
  const names = parts.items.system.map((i: { name: string }) => i.name);
  assert.ok(names.some((n: string) => n.startsWith("Injected context › ")), "a <system-reminder> is the runtime's context, not the person's words");
  assert.ok(parts.items.mcp.some((i: { name: string }) => i.name === "mcp__docs__search"));
  assert.equal(existsSync(requestFile), false, "a body holds the conversation: it is deleted once read");
});

await test("a body outside the thread's own directory is never read", async () => {
  const outside = `${dir}/../elsewhere.json`;
  writeFileSync(outside, JSON.stringify(requestBody));
  await post("/v1/logs", { resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: [kv("event.name", "api_request_body"), kv("body_ref", outside)] }] }] }] });
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(existsSync(outside), true, "it was not even deleted: the path was refused before it was touched");
});

await test("our own agent's chat span gets its parts from the AI SDK's GenAI attributes", async () => {
  const text = (content: string) => ({ type: "text", content });
  ingest("t1", {
    sessionId: "acp-1",
    spans: [{
      traceId: "c".repeat(32), spanId: "d".repeat(16), parentSpanId: null, name: "chat some-model", start: T0, end: T0 + 500, status: "ok", events: [],
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.usage.input_tokens": 2000,
        "gen_ai.system_instructions": JSON.stringify([text(`You are Daedalus. ${"rule ".repeat(200)}`)]),
        "gen_ai.tool.definitions": JSON.stringify([
          { type: "function", name: "read_file", description: "read a file ".repeat(20), inputSchema: { type: "object" } },
          { type: "function", name: "mcp__gh__issue", description: "an issue ".repeat(20), inputSchema: { type: "object" } },
        ]),
        "gen_ai.input.messages": JSON.stringify([
          { role: "user", parts: [text("please fix the build")] },
          { role: "assistant", parts: [{ type: "tool_call", id: "1", name: "read_file", arguments: { path: "a.ts" } }] },
          { role: "tool", parts: [{ type: "tool_call_response", id: "1", response: "export const a = 1" }] },
        ]),
      },
    }],
  });
  const span = async () => (await listSpans("t1")).find((x) => x.spanId === "d".repeat(16));
  assert.ok(await settled(async () => Boolean((await span())?.attributes["daedalus.prompt_parts"])), "parts were written");
  const parts = JSON.parse(String((await getSpan("t1", "d".repeat(16)))!.attributes["daedalus.prompt_parts"]));
  assert.equal(parts.source, "agent");
  assert.equal(parts.system + parts.tools + parts.mcp + parts.conversation + parts.overhead, 2000);
  assert.ok(parts.system > 0 && parts.tools > 0 && parts.mcp > 0 && parts.user > 0 && parts.assistant > 0 && parts.results > 0);
  assert.equal((await span())!.kind, "model");
});

server.close();
console.log(`otlp: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
