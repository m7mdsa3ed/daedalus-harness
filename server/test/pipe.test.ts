// Self-check for the WS<->stdio pipe: spawn the fake agent through
// SessionManager, assert round-trip, sniffing, journal replay on reattach.
// Run: pnpm test (DAEDALUS_DATA_DIR is set by the npm script — static
// imports are hoisted, so setting it here would be too late).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson } from "../src/config.js";
import type { Profile } from "../src/profiles.js";

rmSync(process.env.DAEDALUS_DATA_DIR!, { recursive: true, force: true });
writeJson(join(process.env.DAEDALUS_DATA_DIR!, "agents.json"), [
  {
    id: "fake",
    name: "Fake",
    command: "node",
    args: [join(dirname(fileURLToPath(import.meta.url)), "fake-agent.mjs")],
    env: { FAKE_KEY: "{apiKey}", FAKE_EMPTY: "{baseUrl}" },
  },
]);

const { SessionManager } = await import("../src/sessions.js");

class MockWs extends EventEmitter {
  sent: string[] = [];
  send(line: string) {
    this.sent.push(line);
  }
  close() {
    this.emit("close");
  }
}

const profile: Profile = {
  id: "p1",
  name: "test",
  agentId: "fake",
  baseUrl: "",
  apiKey: "sk-test",
  models: [],
  defaultModel: "",
};
const project = {
  id: "w1",
  name: "test-ws",
  cwd: "/tmp/daedalus-test-data/ws",
  extraInstructions: "be terse",
  mcpServers: [],
  skills: [],
};

const manager = new SessionManager({}, 1);
const session = manager.create(profile, project);

const ws1 = new MockWs();
assert.ok(manager.attach(session.id, ws1 as never));

const request = (id: number, method: string, params: object = {}) =>
  ws1.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params })));

const waitFor = async (predicate: () => boolean, what: string) => {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(predicate(), `timed out waiting for ${what}`);
};

request(1, "initialize", { protocolVersion: 1 });
await waitFor(() => ws1.sent.length >= 1, "initialize response");
assert.equal(JSON.parse(ws1.sent[0]).id, 1);

request(2, "session/new", { cwd: project.cwd });
await waitFor(() => session.acpSessionId === "acp-123", "acpSessionId sniff");

// The turn is complete once the server-synthesized turn_ended frame arrives
// (it follows the prompt response).
request(3, "session/prompt", { prompt: [{ type: "text", text: "hello fake agent" }] });
await waitFor(() => ws1.sent.some((l) => l.includes("_daedalus/turn_ended")), "turn end");
assert.equal(session.title, "hello fake agent");
assert.equal(session.promptActive, false);
assert.equal(JSON.parse(ws1.sent[2]).method, "session/update");
assert.equal(JSON.parse(ws1.sent[ws1.sent.length - 1]).method, "_daedalus/turn_ended");

// Reattach: replay only agent frames after cursor 0 -> the same 4 frames.
ws1.close();
assert.equal(manager.list()[0].attached, false);
const ws2 = new MockWs();
assert.ok(manager.attach(session.id, ws2 as never, 0));
assert.deepEqual(ws2.sent, ws1.sent);

// Cursor skips already-seen frames.
const ws3 = new MockWs();
assert.ok(manager.attach(session.id, ws3 as never, session.journal.length));
assert.equal(ws3.sent.length, 0);

// Respawn: swaps the process, clears the journal, keeps the session id.
manager.respawn(session.id, { ...profile, name: "test2", defaultModel: "m2" }, project);
assert.equal(session.journal.length, 0);
assert.equal(session.model, "m2");
assert.equal(session.exited, false);
const ws4 = new MockWs();
assert.ok(manager.attach(session.id, ws4 as never, 0));
ws4.emit(
  "message",
  Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "initialize", params: {} })),
);
await waitFor(() => ws4.sent.length >= 1, "initialize response after respawn");
assert.equal(JSON.parse(ws4.sent[0]).id, 10);

assert.ok(manager.kill(session.id));

// JSON env templates (Codex's CODEX_CONFIG): empty placeholders are pruned,
// a hollow object omits the var, plain templates behave as before.
const { resolveEnvValue } = await import("../src/registry.js");
const template = '{"model":"{model}","model_reasoning_effort":"{effort}"}';
assert.equal(
  resolveEnvValue(template, { model: "gpt-5-codex", effort: "" }),
  '{"model":"gpt-5-codex"}',
);
assert.equal(
  resolveEnvValue(template, { model: "m", effort: "high" }),
  '{"model":"m","model_reasoning_effort":"high"}',
);
assert.equal(resolveEnvValue(template, { model: "", effort: "" }), undefined);
assert.equal(resolveEnvValue("{apiKey}", { apiKey: "sk-1" }), "sk-1");
assert.equal(resolveEnvValue("{apiKey}", { apiKey: "" }), undefined);

// Conditional literals: a base URL emits the whole provider block; without one
// the block prunes away as a unit.
const codexTemplate =
  '{"model":"{model}","model_provider":"{baseUrl?daedalus}","model_providers":{"daedalus":{"name":"{baseUrl?Gateway}","base_url":"{baseUrl}","env_key":"{baseUrl?CODEX_API_KEY}","wire_api":"{baseUrl?responses}"}}}';
assert.deepEqual(
  JSON.parse(resolveEnvValue(codexTemplate, { model: "m", baseUrl: "http://gw:9000/v1" })!),
  {
    model: "m",
    model_provider: "daedalus",
    model_providers: {
      daedalus: { name: "Gateway", base_url: "http://gw:9000/v1", env_key: "CODEX_API_KEY", wire_api: "responses" },
    },
  },
);
assert.deepEqual(JSON.parse(resolveEnvValue(codexTemplate, { model: "m", baseUrl: "" })!), {
  model: "m",
});

// Persistence: a fresh manager (simulated server restart) lists prior sessions
// as exited-but-revivable, and respawn revives them without a live old proc.
const session2 = manager.create(profile, project);
const manager2 = new SessionManager({}, 1);
const restored = manager2.list().find((s) => s.id === session2.id);
assert.ok(restored, "session survives a manager restart");
assert.equal(restored!.exited, true);
const revived = manager2.respawn(session2.id, profile, project);
assert.equal(revived.exited, false);
assert.ok(manager2.kill(session2.id));
assert.ok(manager.kill(session2.id));

console.log("pipe.test.ts OK");
process.exit(0);
