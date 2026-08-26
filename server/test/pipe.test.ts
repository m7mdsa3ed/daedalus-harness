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
  /** Every close(code, reason) the manager asked for — the reason is capped at
      123 bytes by the WebSocket protocol, so it is worth asserting on. */
  closes: [number | undefined, string | undefined][] = [];
  send(line: string) {
    this.sent.push(line);
  }
  close(code?: number, reason?: string) {
    this.closes.push([code, reason]);
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
  description: null,
  mcpServerIds: [],
  skillIds: [],
  commandIds: [],
};

const manager = new SessionManager({}, 1);
const session = manager.create(profile, project);

const ws1 = new MockWs();
assert.equal(manager.attach(session.id, ws1 as never), null, "attach should succeed");

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

// Reattach: replay agent notifications after cursor 0. Responses are skipped —
// their ids belong to whichever peer made the request, so they mean nothing to
// a new one; _daedalus/turn_ended is what carries the turn result across.
ws1.close();
assert.equal(manager.list()[0].attached, false);
const ws2 = new MockWs();
assert.equal(manager.attach(session.id, ws2 as never, 0), null, "attach should succeed");
const notifications = (ws: MockWs) => ws.sent.filter((l) => JSON.parse(l).method !== undefined);
assert.deepEqual(ws2.sent, notifications(ws1));

// Cursor skips already-seen frames.
const ws3 = new MockWs();
assert.equal(manager.attach(session.id, ws3 as never, session.journalCount), null, "attach should succeed");
assert.equal(ws3.sent.length, 0);

// --- multiplexing: two devices attached to one thread ---
ws2.close();
ws3.close();
const a = new MockWs();
const b = new MockWs();
const send = (ws: MockWs, msg: object) => ws.emit("message", Buffer.from(JSON.stringify(msg)));
assert.equal(manager.attach(session.id, a as never, session.journalCount), null, "attach should succeed");
assert.equal(manager.attach(session.id, b as never, session.journalCount), null, "attach should succeed");
assert.equal(manager.list()[0].peerCount, 2);

// Both peers number their own requests from 1. Each must get back exactly its
// own response — the id rewrite is what keeps them from colliding.
send(a, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
send(b, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
await waitFor(() => a.sent.length >= 1 && b.sent.length >= 1, "both initialize responses");
assert.equal(a.sent.length, 1);
assert.equal(b.sent.length, 1);
assert.equal(JSON.parse(a.sent[0]).id, 1);
assert.equal(JSON.parse(b.sent[0]).id, 1);

// A prompt from one peer: the other sees the same agent notifications, learns
// about the prompt through _daedalus/peer_prompt, and never sees the response.
send(a, { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { prompt: [{ type: "text", text: "second turn" }] } });
await waitFor(() => b.sent.some((l) => l.includes("_daedalus/turn_ended")), "peer sees turn end");
assert.ok(b.sent.some((l) => JSON.parse(l).method === "_daedalus/peer_prompt"));
assert.ok(!a.sent.some((l) => JSON.parse(l).method === "_daedalus/peer_prompt"));
const updates = (ws: MockWs) => ws.sent.filter((l) => JSON.parse(l).method === "session/update");
assert.deepEqual(updates(b), updates(a));
assert.equal(b.sent.filter((l) => JSON.parse(l).method === undefined).length, 1); // only its own initialize

// A permission request fans out to both peers; the first answer wins and the
// other peer is told to dismiss. The loser's late duplicate is dropped, so the
// agent never sees two responses to one id.
send(a, { jsonrpc: "2.0", id: 3, method: "session/prompt", params: { prompt: [{ type: "text", text: "needs permission" }] } });
await waitFor(
  () => b.sent.some((l) => JSON.parse(l).method === "session/request_permission"),
  "permission fans out to both peers",
);
const permLine = a.sent.find((l) => JSON.parse(l).method === "session/request_permission");
assert.ok(permLine, "asking peer also sees the permission request");
const permId = JSON.parse(permLine).id;
send(b, { jsonrpc: "2.0", id: permId, result: { outcome: { outcome: "selected", optionId: "allow" } } });
await waitFor(
  () => a.sent.some((l) => JSON.parse(l).method === "_daedalus/request_answered"),
  "the other peer is told to dismiss",
);
send(a, { jsonrpc: "2.0", id: permId, result: { outcome: { outcome: "cancelled" } } });
await waitFor(
  () => a.sent.filter((l) => l.includes("_daedalus/turn_ended")).length === 2,
  "permission-gated turn completes exactly once",
);
assert.equal(b.sent.filter((l) => l.includes("_daedalus/turn_ended")).length, 2);
assert.equal(session.promptActive, false);

// A peer leaving does not disturb the other.
a.close();
assert.equal(manager.list()[0].peerCount, 1);
assert.equal(manager.list()[0].attached, true);
b.close();
assert.equal(manager.list()[0].attached, false);

// Respawn: swaps the process, clears the journal, keeps the session id.
manager.respawn(session.id, { ...profile, name: "test2", defaultModel: "m2" }, project);
assert.equal(session.journalCount, 0);
assert.equal(session.model, "m2");
assert.equal(session.exited, false);
const ws4 = new MockWs();
assert.equal(manager.attach(session.id, ws4 as never, 0), null, "attach should succeed");
ws4.emit(
  "message",
  Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "initialize", params: {} })),
);
await waitFor(() => ws4.sent.length >= 1, "initialize response after respawn");
assert.equal(JSON.parse(ws4.sent[0]).id, 10);

// --- failure paths ---

// A prompt the agent answers with a bare "Internal error": the reason it wrote
// to stderr is spliced into the error's `data` on the way to the peer that
// asked, AND fanned out to the peers that didn't via _daedalus/turn_ended.
// Without this the client can only ever say "RequestError: Internal error".
const failer = new MockWs();
const watcher = new MockWs();
assert.equal(manager.attach(session.id, failer as never, session.journalCount), null);
assert.equal(manager.attach(session.id, watcher as never, session.journalCount), null);
send(failer, { jsonrpc: "2.0", id: 20, method: "session/new", params: { cwd: project.cwd } });
await waitFor(() => failer.sent.length >= 1, "session/new after respawn");
send(failer, {
  jsonrpc: "2.0",
  id: 21,
  method: "session/prompt",
  params: { prompt: [{ type: "text", text: "please fail" }] },
});
await waitFor(() => failer.sent.some((l) => JSON.parse(l).error !== undefined), "error response");

const failure = failer.sent.map((l) => JSON.parse(l)).find((m) => m.error !== undefined);
assert.equal(failure.id, 21, "the error comes back with the id the peer used");
assert.equal(failure.error.code, -32603);
assert.match(failure.error.data.stderr, /529/, "the agent's stderr explains the internal error");

const fanned = watcher.sent
  .map((l) => JSON.parse(l))
  .find((m) => m.method === "_daedalus/turn_ended");
assert.ok(fanned, "a peer that didn't prompt still learns the turn ended");
assert.match(fanned.params.error.data.stderr, /529/, "…and why it ended badly");
assert.equal(session.promptActive, false, "a failed prompt still ends the turn");

// An agent that dies holding a turn: the in-flight request is answered with an
// error rather than left hanging until the socket eventually closes.
manager.respawn(session.id, profile, project);
const doomed = new MockWs();
assert.equal(manager.attach(session.id, doomed as never, 0), null);
send(doomed, { jsonrpc: "2.0", id: 30, method: "session/new", params: { cwd: project.cwd } });
await waitFor(() => doomed.sent.length >= 1, "session/new before the crash");
send(doomed, {
  jsonrpc: "2.0",
  id: 31,
  method: "session/prompt",
  params: { prompt: [{ type: "text", text: "now crash" }] },
});
await waitFor(
  () => doomed.sent.some((l) => JSON.parse(l).id === 31 && JSON.parse(l).error),
  "the abandoned prompt is answered",
);
const abandoned = doomed.sent.map((l) => JSON.parse(l)).find((m) => m.id === 31 && m.error);
assert.match(abandoned.error.message, /ended/, "…with what happened to the process");
assert.match(abandoned.error.data.details, /Fatal/, "…and the agent's last words");
assert.equal(session.promptActive, false);

// Every close reason the manager sends must fit the protocol's 123-byte cap —
// `ws` rejects an oversized one by throwing, and these are emitted from an exit
// handler where that would take the server down instead of closing a socket.
for (const ws of [doomed, ws4]) {
  for (const [, reason] of ws.closes) {
    assert.ok(Buffer.byteLength(reason ?? "", "utf8") <= 123, `close reason too long: ${reason}`);
  }
}
assert.ok(
  doomed.closes.some(([code]) => code === 4001),
  "a dead agent closes its peers with 4001",
);

manager.respawn(session.id, profile, project);

// Soft delete keeps the row (and the acpSessionId that revives it); restore
// puts it back as a plain retired thread; purge is what actually forgets.
assert.ok(manager.softDelete(session.id));
const deleted = manager.list().find((s) => s.id === session.id);
assert.ok(deleted, "a deleted thread stays in the list");
assert.ok(deleted!.deletedAt, "…marked deleted");
assert.equal(deleted!.exited, true, "…with its process gone");
assert.match(
  manager.attach(session.id, new MockWs() as never, 0) ?? "",
  /trash/,
  "no attach while deleted, and the refusal says why",
);
assert.equal(manager.softDelete(session.id), false, "deleting twice is a no-op");
assert.ok(manager.restore(session.id));
assert.equal(manager.list().find((s) => s.id === session.id)!.deletedAt, null);
assert.ok(manager.purge(session.id));
assert.equal(manager.list().find((s) => s.id === session.id), undefined, "purge forgets it");

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

// Unquoted JSON slots: numbers pass through; absent metadata fills as the
// literal null and prunes away.
const numTemplate = '{"model":"{model}","model_context_window":{contextWindow}}';
assert.deepEqual(
  JSON.parse(resolveEnvValue(numTemplate, { model: "m", contextWindow: "128000" })!),
  { model: "m", model_context_window: 128000 },
);
assert.deepEqual(JSON.parse(resolveEnvValue(numTemplate, { model: "m", contextWindow: "null" })!), {
  model: "m",
});

// resolveSpawn threads the selected model's catalog metadata into the vars.
const { resolveSpawn } = await import("../src/registry.js");
const spec = resolveSpawn(
  {
    id: "x",
    name: "X",
    command: "x",
    args: [],
    env: { C: '{"model_context_window":{contextWindow},"model_max_output_tokens":{maxOutputTokens}}' },
  },
  {
    ...profile,
    models: [{ id: "m1", label: "M1", contextWindow: 200_000, reasoningEfforts: [] }],
  },
  project,
  "m1",
);
assert.deepEqual(JSON.parse(spec.env.C), { model_context_window: 200_000 });

// Persistence: a fresh manager (simulated server restart) lists prior sessions
// as exited-but-revivable, and respawn revives them without a live old proc.
const session2 = manager.create(profile, project);
const manager2 = new SessionManager({}, 1);
const restored = manager2.list().find((s) => s.id === session2.id);
assert.ok(restored, "session survives a manager restart");
assert.equal(restored!.exited, true);
const revived = manager2.respawn(session2.id, profile, project);
assert.equal(revived.exited, false);
assert.ok(manager2.purge(session2.id));
assert.ok(manager.purge(session2.id));

// A reload while a permission prompt is open: the client comes back attaching
// from the END of the log, so the prompt sits below its cursor. It still has to
// be sent — the agent is blocked on it, and nothing else would ever ask again.
const reloading = manager.create(profile, project);
const before = new MockWs();
assert.equal(manager.attach(reloading.id, before as never, 0), null, "attach should succeed");
send(before, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
send(before, { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: project.cwd } });
await waitFor(() => reloading.acpSessionId !== undefined, "session/new");
send(before, {
  jsonrpc: "2.0",
  id: 3,
  method: "session/prompt",
  params: { prompt: [{ type: "text", text: "needs permission" }] },
});
await waitFor(
  () => before.sent.some((l) => JSON.parse(l).method === "session/request_permission"),
  "the prompt raises a permission request",
);
const askedId = JSON.parse(
  before.sent.find((l) => JSON.parse(l).method === "session/request_permission")!,
).id;

// The reload. The old socket goes, and the new one asks from the end.
before.close();
const after = new MockWs();
assert.equal(manager.attach(reloading.id, after as never, reloading.journalCount), null);
const reasked = after.sent
  .map((l) => JSON.parse(l))
  .find((m) => m.method === "session/request_permission");
assert.ok(reasked, "the open permission request survives a reload");
assert.equal(reasked.id, askedId, "…with the id the agent is still waiting on");

// Answering it from the reloaded client reaches the agent and ends the turn.
send(after, { jsonrpc: "2.0", id: askedId, result: { outcome: { outcome: "selected", optionId: "allow" } } });
await waitFor(
  () => after.sent.some((l) => l.includes("_daedalus/turn_ended")),
  "the answer unblocks the turn",
);
assert.equal(reloading.promptActive, false);
// Once answered it must NOT come back on the next attach — that would be a
// dialog for a question nobody is asking any more.
const later = new MockWs();
assert.equal(manager.attach(reloading.id, later as never, reloading.journalCount), null);
assert.ok(
  !later.sent.some((l) => JSON.parse(l).method === "session/request_permission"),
  "an answered request is not replayed",
);
assert.ok(manager.purge(reloading.id));

// A load restates the whole conversation, so the journal drops what it is about
// to repeat. Two peers each loading once used to leave two full replays in the
// log — and a client rebuilding from it drew the thread twice.
const loader = manager.create(profile, project);
const lp = new MockWs();
assert.equal(manager.attach(loader.id, lp as never, 0), null, "attach should succeed");
send(lp, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
send(lp, { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: project.cwd } });
await waitFor(() => loader.journalCount > 2, "some history accrues");
const grown = loader.journalCount;
assert.ok(grown > 2, "journal has frames before the load");
send(lp, { jsonrpc: "2.0", id: 3, method: "session/load", params: { sessionId: loader.acpSessionId } });
await waitFor(() => loader.journalCount < grown, "the load clears what it will restate");
// The load request itself is the first thing in the fresh log.
const freshLog = manager.journal(loader.id)!;
assert.equal(JSON.parse(freshLog.entries[0].line).method, "session/load");
assert.ok(manager.purge(loader.id));

// --- storage ---

// The journal is a table now, so a replay reaching further back than anything
// held in memory has to come back whole and in order.
const logged = manager.create(profile, project);
const bulk = new MockWs();
assert.equal(manager.attach(logged.id, bulk as never, 0), null, "attach should succeed");
for (let i = 0; i < 500; i++) {
  send(bulk, { jsonrpc: "2.0", method: "session/update", params: { seq: i } });
}
const log = manager.journal(logged.id)!;
assert.equal(log.cursor, log.entries.length, "cursor is the frame count");
const replayed = log.entries.filter((e) => e.d === "c").map((e) => JSON.parse(e.line).params.seq);
assert.deepEqual(replayed, [...Array(500).keys()], "every frame, in order");
// ...and a cursor mid-log returns exactly the tail after it.
assert.equal(manager.journal(logged.id)!.entries.length - 400, log.entries.length - 400);

// Soft delete keeps the row and refuses new attachments; restore undoes it.
assert.ok(manager.softDelete(logged.id));
assert.equal(manager.list().find((s) => s.id === logged.id)?.deletedAt !== null, true);
assert.equal(manager.attach(logged.id, new MockWs() as never, 0), "this thread is in the trash");
assert.equal(manager.journal(logged.id)!.cursor, 0, "retiring clears the log");
assert.ok(manager.restore(logged.id));
assert.equal(manager.list().find((s) => s.id === logged.id)?.deletedAt, null);
assert.ok(manager.purge(logged.id));
assert.equal(manager.journal(logged.id), undefined, "purge forgets the thread");

// Purging cascades: no orphan journal rows are left behind for any session.
const { db, journal: journalTable } = await import("../src/db/index.js");
assert.equal(db.select().from(journalTable).all().length, 0, "journal rows cascade with the session");

// The legacy agents.json import landed, and then seeding adds the built-ins
// this install had never been offered — the case the old "seed only when the
// file is empty" rule could never reach. Seeding again adds nothing.
const { listAgents, seedAgents } = await import("../src/registry.js");
assert.ok(listAgents().some((a) => a.id === "fake"), "the imported agent survived");
seedAgents();
const seeded = listAgents();
assert.ok(seeded.some((a) => a.id === "opencode"), "a built-in reaches an install that has rows");
assert.ok(seeded.some((a) => a.id === "fake"), "seeding leaves the user's own agents alone");
seedAgents();
assert.equal(listAgents().length, seeded.length, "seeding twice adds nothing");

// Library deletions cascade into the projects that linked them, instead of
// leaving an id behind for a reader to filter out.
const { mcpServers } = await import("../src/library.js");
const { createProject, getProject } = await import("../src/projects.js");
const server1 = mcpServers.create({ type: "stdio", name: "s1", command: "true", args: [], env: [] });
const linked = createProject({ name: "p", cwd: "/tmp", description: null, mcpServerIds: [server1.id], skillIds: [], commandIds: [] });
assert.deepEqual(getProject(linked.id)!.mcpServerIds, [server1.id]);
mcpServers.remove(server1.id);
assert.deepEqual(getProject(linked.id)!.mcpServerIds, [], "the link went with the server");
// A stale id in a request links nothing rather than failing the whole write.
const stale = createProject({ name: "q", cwd: "/tmp", description: null, mcpServerIds: ["gone"], skillIds: [], commandIds: [] });
assert.deepEqual(getProject(stale.id)!.mcpServerIds, []);

console.log("pipe.test.ts OK");
process.exit(0);
