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

await test("upstream path is chat completions (the dialect daedalus speaks)", () => {
  assert.equal(opencodeFree.upstreamPath("mimo-v2.6-flash-free", "/chat/completions"), "/chat/completions");
  assert.equal(opencodeFree.upstreamPath("muse-spark-1.3-contributor-free", "/chat/completions"), "/chat/completions");
});

if (failures.length) {
  console.error(`\n${failures.length} FAILURES:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`providers-opencode-free: ${passed} passed`);
