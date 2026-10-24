// Self-check for the otlp door (src/model-calls/sources/otlp.ts): the key in
// the path is the credential, a thread not attached is a 404, a body is read
// from the thread's own directory only and deleted once counted, an
// `api_request` and its `api_request_body` become one record whose parts sum
// to the billed prompt, each half alone is still a record after the wait,
// identity attributes land nowhere, and traces/metrics record nothing.
// Run: pnpm test:otlp
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { CallThread } from "../src/model-calls/index.js";
import { configureOtlp, handleOtlp, otlpSource } from "../src/model-calls/sources/otlp.js";
import type { CallDoor, ModelCall, ModelCallUpdate } from "../src/protocol.js";

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

/* A thread that keeps what the door emits; filing is the SessionManager's and
   is tested with the ledger (test:model-calls). */
function fakeThread(id: string): CallThread & { emitted: ModelCall[] } {
  let steps = 0;
  const thread: CallThread & { emitted: ModelCall[] } = {
    emitted: [],
    id,
    agentId: "claude-code",
    profileId: "p1",
    projectId: "w1",
    cwd: "/tmp/otlp-test",
    viaGateway: true,
    acpSessionId: () => "acp-1",
    turn: () => ({ turnId: "turn-1", nextStep: () => ++steps }),
    names: () => ({ threadTitle: "T", profileName: "P", projectName: "W" }),
    emit: (update: ModelCallUpdate) => {
      thread.emitted.push(update.call);
    },
  };
  return thread;
}

const door: CallDoor = {
  kind: "otlp",
  dialect: "claude-otlp",
  env: {
    CLAUDE_CODE_ENABLE_TELEMETRY: "{otlpUrl?1}",
    OTEL_EXPORTER_OTLP_ENDPOINT: "{otlpUrl}",
    OTEL_LOG_RAW_API_BODIES: "{otlpBodies}",
    OTEL_METRICS_EXPORTER: "{otlpUrl?none}",
  },
};

await test("with no receiver booted the door does not attach", async () => {
  assert.equal(await otlpSource.attach(fakeThread("t0"), door), null);
});

const app = new Hono();
app.all("/otlp/*", (c) => handleOtlp(c.req.raw));
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise((resolve) => server.once("listening", resolve));
const port = (server.address() as { port: number }).port;
configureOtlp({ port });

const t1 = fakeThread("t1");
const attached = (await otlpSource.attach(t1, door))!;
const env = attached.spawnEnv!;
const base = env.OTEL_EXPORTER_OTLP_ENDPOINT!;
const dir = env.OTEL_LOG_RAW_API_BODIES!.replace(/^file:/, "");

const post = (path: string, body: unknown, headers: Record<string, string> = {}, url = base) =>
  fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" || Buffer.isBuffer(body) ? (body as BodyInit) : JSON.stringify(body),
  });
const kv = (key: string, value: string | number) => ({ key, value: typeof value === "string" ? { stringValue: value } : { intValue: String(value) } });
const nanos = (ms: number) => String(BigInt(Math.round(ms)) * 1_000_000n);
const logs = (...records: { attributes: unknown[]; timeUnixNano?: string }[]) => ({ resourceLogs: [{ scopeLogs: [{ logRecords: records }] }] });
const settled = async (check: () => boolean, ms = 5000) => {
  for (let waited = 0; waited < ms; waited += 50) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
};

const identity = [kv("user.email", "me@example.com"), kv("user.id", "u"), kv("organization.id", "o"), kv("session.id", "claude-session")];
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

await test("the door resolves its env from the receiver: switches on, endpoint and bodies named", () => {
  assert.equal(env.CLAUDE_CODE_ENABLE_TELEMETRY, "1");
  assert.equal(env.OTEL_METRICS_EXPORTER, "none");
  assert.match(base, new RegExp(`^http://127\\.0\\.0\\.1:${port}/otlp/[0-9a-f]{48}/t1$`));
  assert.ok(existsSync(dir), "the thread's body directory is made on attach");
});

await test("a wrong key, an unattached thread, a non-JSON body and protobuf are refused; traces and metrics are accepted and dropped", async () => {
  assert.equal((await post("/v1/logs", "{}", {}, base.replace(/\/otlp\/[^/]+\//, "/otlp/nope/"))).status, 404);
  assert.equal((await post("/v1/logs", "{}", {}, base.replace(/\/t1$/, "/t9"))).status, 404);
  assert.equal((await post("/v1/logs", "{}", { "content-type": "application/x-protobuf" })).status, 415);
  assert.equal((await post("/v1/logs", "not json")).status, 400);
  assert.equal((await post("/v1/wat", {})).status, 404);
  const traces = { resourceSpans: [{ scopeSpans: [{ spans: [{ name: "claude_code.llm_request", attributes: [kv("input_tokens", 5), kv("request_id", "req_t")] }] }] }] };
  assert.equal((await post("/v1/traces", traces)).status, 200);
  assert.equal((await post("/v1/metrics", {})).status, 200);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(t1.emitted.length, 0, "nothing was recorded from traces or metrics");
});

await test("api_request and api_request_body become one record whose parts sum to the billed prompt; the body is gone; identity lands nowhere", async () => {
  const file = `${dir}/b1.request.json`;
  writeFileSync(file, JSON.stringify(requestBody));
  writeFileSync(`${dir}/index.jsonl`, JSON.stringify({ request_id: "req_1", request_file: "b1.request.json", response_file: "req_1.response.json" }) + "\n");
  const res = await post(
    "/v1/logs",
    gzipSync(
      JSON.stringify(
        logs(
          { attributes: [...identity, kv("event.name", "api_request_body"), kv("body_ref", file), kv("body_length", 100)] },
          {
            timeUnixNano: nanos(T0),
            attributes: [
              ...identity,
              kv("event.name", "api_request"),
              kv("request_id", "req_1"),
              kv("model", "claude-opus-5-5"),
              kv("input_tokens", 2),
              kv("output_tokens", 40),
              kv("cache_read_tokens", 1000),
              kv("cache_creation_tokens", 500),
              { key: "cost_usd", value: { doubleValue: 0.0123 } },
              kv("duration_ms", 900),
            ],
          },
        ),
      ),
    ),
    { "content-encoding": "gzip" },
  );
  assert.equal(res.status, 200, "gzip is accepted");
  assert.ok(await settled(() => t1.emitted.length === 1), "one record came out");
  const call = t1.emitted[0]!;
  assert.equal(call.source, "otlp");
  assert.equal(call.callId, "req_1");
  assert.equal(call.at, T0);
  assert.equal(call.ms, 900);
  assert.equal(call.model, "claude-opus-5-5");
  assert.equal(call.costUsd, 0.0123);
  assert.deepEqual(call.billed, { totalTokens: 1542, inputTokens: 2, outputTokens: 40, cachedReadTokens: 1000, cachedWriteTokens: 500 });
  const p = call.prompt!;
  assert.equal(p.system! + p.tools! + p.mcp! + p.user! + p.assistant! + p.results! + p.unknown, 1502, "the parts sum to fresh + cache read + cache write");
  assert.ok(p.system! > 0 && p.tools! > 0 && p.mcp! > 0 && p.user! > 0 && p.assistant! > 0 && p.results! > 0, "every part was seen");
  assert.equal(call.missing, undefined);
  assert.ok(call.items?.mcp.some((i) => i.name === "mcp__docs__search"), "items ride the first record");
  assert.ok(call.items?.system.some((i) => i.name.startsWith("Injected context › ")), "a <system-reminder> is the runtime's context");
  assert.equal(existsSync(file), false, "a body holds the conversation: it is deleted once read");
  assert.doesNotMatch(JSON.stringify(call), /me@example\.com|claude-session|organization/, "identity attributes are dropped");
  assert.equal(t1.emitted.length, 1, "the pair is one record, not two");
});

await test("a body outside the thread's own directory is neither read nor deleted", async () => {
  const outside = `${dir}/../elsewhere.json`;
  mkdirSync(`${dir}/..`, { recursive: true });
  writeFileSync(outside, JSON.stringify(requestBody));
  const before = t1.emitted.length;
  await post("/v1/logs", logs({ attributes: [kv("event.name", "api_request_body"), kv("body_ref", outside)] }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(existsSync(outside), true, "the path was refused before it was touched");
  assert.equal(t1.emitted.length, before);
});

await test("a request with no body is a record without prompt; a body with no request has nothing to anchor to and files nothing; neither waits on the other", async () => {
  const before = t1.emitted.length;
  const file = `${dir}/b2.request.json`;
  writeFileSync(file, JSON.stringify({ ...requestBody, tools: [] }));
  await post(
    "/v1/logs",
    logs(
      { timeUnixNano: nanos(T0 + 1000), attributes: [kv("event.name", "api_request"), kv("request_id", "req_lonely"), kv("model", "m"), kv("input_tokens", 10), kv("output_tokens", 1)] },
      { attributes: [kv("event.name", "api_request_body"), kv("request_id", "req_bodyonly"), kv("body_ref", file)] },
    ),
  );
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(t1.emitted.length, before, "each half waits for the other first");
  assert.ok(await settled(() => t1.emitted.length === before + 1), "the request came out after the wait");
  assert.ok(await settled(() => !existsSync(file)), "the body was still read and deleted");
  const lonely = t1.emitted.find((c) => c.callId === "req_lonely")!;
  assert.equal(lonely.prompt, undefined);
  assert.equal(lonely.billed.inputTokens, 10);
  assert.equal(t1.emitted.length, before + 1, "no zero-billed record for the body");
});

await test("after stop the thread is unattached and its posts are refused", async () => {
  attached.stop();
  assert.equal((await post("/v1/logs", logs())).status, 404);
});

server.close();
console.log(`otlp: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
