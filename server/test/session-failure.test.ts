// The AIR capability handshake and the prompt answer's failure record: what
// the harness claims at `initialize` (`CLIENT_CAPABILITIES`), that a
// `sessionFailure` on a `session/prompt` answer lands on `turn_ended.failure`,
// is journaled with it and comes back on a replay — and that a malformed
// record is dropped rather than drawn.
//
// Run: pnpm test:session-failure (DAEDALUS_DATA_DIR is set by the npm script).
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson } from "../src/config.js";
import type { Profile } from "../src/profiles.js";
import type { ThreadEvent } from "../src/protocol.js";

rmSync(process.env.DAEDALUS_DATA_DIR!, { recursive: true, force: true });
mkdirSync("/tmp/daedalus-test-session-failure/ws", { recursive: true });
writeJson(join(process.env.DAEDALUS_DATA_DIR!, "agents.json"), [
  {
    id: "fake",
    name: "Fake",
    command: "node",
    args: [join(dirname(fileURLToPath(import.meta.url)), "fake-agent.mjs")],
    env: { FAKE_KEY: "{apiKey}" },
  },
]);

const { CLIENT_CAPABILITIES, parseSessionFailure } = await import("../src/acp-bridge.js");
const { SessionManager } = await import("../src/sessions.js");

// --- the handshake: the contract both adapters read ---

const caps = CLIENT_CAPABILITIES as unknown as {
  session: Record<string, unknown>;
  subagents?: unknown;
  _meta: Record<string, unknown>;
};
assert.deepEqual(caps.session.notices, {}, "session.notices is claimed");
assert.deepEqual(caps.subagents, {}, "the RFD's subagents field is still sent beside the AIR spelling");
assert.deepEqual(caps._meta, {
  "subagent-transcript": true,
  "opencode/child-session-updates": true,
  terminal_output_delta: true,
  jetbrains: {
    air: {
      version: 1,
      capabilities: ["asyncTasks", "nativeSubagentSessions", "sessionFailure", "recommendedValue", "planContentDelta"],
    },
  },
});

// --- the record's shape check ---

const good = { id: "t:error", revision: 2, category: "limit", severity: "error", title: "Out", actions: ["retry"] };
const wrap = (r: unknown) => ({ jetbrains: { air: { version: 1, sessionFailure: r } } });
assert.deepEqual(parseSessionFailure(wrap(good)), good);
assert.deepEqual(parseSessionFailure(wrap({ ...good, details: "more" })), { ...good, details: "more" });
assert.equal(parseSessionFailure(undefined), undefined);
assert.equal(parseSessionFailure({ quota: {} }), undefined, "no record, no failure");
for (const bad of [
  { ...good, id: "" },
  { ...good, revision: 0 },
  { ...good, revision: 1.5 },
  { ...good, severity: "fatal" },
  { ...good, title: 3 },
  { ...good, actions: "retry" },
  { ...good, actions: [1] },
]) {
  assert.equal(parseSessionFailure(wrap(bad)), undefined, `dropped: ${JSON.stringify(bad)}`);
}

// --- end to end: the prompt's answer → turn_ended.failure → the journal ---

class MockWs extends EventEmitter {
  sent: string[] = [];
  readyState = 1;
  send(line: string, cb?: (error?: Error) => void) {
    this.sent.push(line);
    cb?.();
  }
  close() {
    this.emit("close");
  }
  of<K extends ThreadEvent["ev"]>(ev: K): Extract<ThreadEvent, { ev: K }>[] {
    return this.sent.map((l) => JSON.parse(l) as ThreadEvent).filter((e) => e.ev === ev) as Extract<ThreadEvent, { ev: K }>[];
  }
}

const waitFor = async (predicate: () => boolean, what: string) => {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(predicate(), `timed out waiting for ${what}`);
};

const profile: Profile = {
  id: "p1", name: "test", agents: { fake: {} }, baseUrl: "", apiKey: "sk-test",
  models: [], defaultModel: "", smallModel: "", logoUrl: "",
};
const project = { id: "w1", name: "test-ws", cwd: "/tmp/daedalus-test-session-failure/ws", description: null };

const manager = new SessionManager({}, 1);
const session = await manager.create(profile, "fake", project);
await session.bridge!.ready;
const peer = new MockWs();
assert.equal(await manager.attach(session.id, peer as never), null);

peer.emit("message", Buffer.from(JSON.stringify({ id: 1, cmd: "prompt", text: "air-incident" })));
await waitFor(() => peer.of("turn_ended").length === 1, "the failed turn ends");
const expected = {
  id: "turn-1:error", revision: 1, category: "limit", severity: "error",
  title: "You've hit your usage limit.", actions: ["retry"],
};
const [ended] = peer.of("turn_ended");
assert.deepEqual(ended.failure, expected, "the record rides turn_ended");
assert.equal(ended.error, undefined, "an end_turn failure is not a JSON-RPC error");

peer.emit("message", Buffer.from(JSON.stringify({ id: 2, cmd: "prompt", text: "echo:fine" })));
await waitFor(() => peer.of("turn_ended").length === 2, "the next turn ends");
assert.equal(peer.of("turn_ended")[1].failure, undefined, "a failure does not leak into the next turn");

peer.close();
const replay = new MockWs();
assert.equal(await manager.attach(session.id, replay as never, 0), null);
await waitFor(() => replay.of("turn_ended").length === 2, "the replay");
assert.deepEqual(replay.of("turn_ended")[0].failure, expected, "journaled, so the replay has it");

// --- a failed create leaves nothing behind: the same id can be retried ---
const retryId = "11111111-1111-4111-8111-111111111111";
await assert.rejects(
  manager.create(profile, "fake", { ...project, cwd: "/tmp/daedalus-test-session-failure/gone" }, undefined, undefined, retryId),
  /no longer exists/,
);
const retried = await manager.create(profile, "fake", project, undefined, undefined, retryId);
assert.equal(retried.id, retryId, "a retry after a failed create is not a 409");
await retried.bridge!.ready;

// --- a revive of a live thread is the live thread (coalesced, idempotent) ---
const liveBridge = retried.bridge;
await manager.respawn(retried.id, profile, "fake", project, undefined, undefined, { revive: true });
assert.equal(retried.bridge, liveBridge, "a revive of a live thread does not respawn it");
manager.retire(retried);
const [r1, r2] = [
  manager.respawn(retried.id, profile, "fake", project, undefined, undefined, { revive: true }),
  manager.respawn(retried.id, profile, "fake", project, undefined, undefined, { revive: true }),
];
await r1;
const firstUp = retried.bridge;
await r2;
assert.ok(firstUp && retried.bridge === firstUp, "two devices reviving at once share one process");

// --- a spawn refused up front tears nothing down ---
await assert.rejects(
  manager.respawn(retried.id, { ...profile, agents: {} }, "fake", project),
  /not configured/,
);
assert.equal(retried.bridge, firstUp, "a refused spawn leaves the running process alone");
assert.equal(retried.exited, false);

// --- a spawn that fails after the teardown leaves a thread that says so ---
const cursorBefore = (await manager.journal(session.id))!.cursor;
assert.ok(cursorBefore > 0);
await assert.rejects(
  manager.respawn(session.id, profile, "fake", { ...project, cwd: "/tmp/daedalus-test-session-failure/gone" }),
);
assert.equal(session.bridge, null);
assert.equal(session.exited, true, "a failed respawn is an exited thread, not a live one with no bridge");
assert.equal((await manager.journal(session.id))!.cursor, cursorBefore, "the journal is not cleared before the spawn is proven");
assert.equal(manager.list().find((s) => s.id === session.id)?.exited, true);

// --- a collapsed process reads as archived, though its bridge object stays ---
retried.proc!.kill("SIGKILL");
await waitFor(() => retried.exited && manager.list().find((s) => s.id === retried.id)?.exited === true, "the collapse");
const late = new MockWs();
assert.equal(await manager.attach(retried.id, late as never, 0), null);
assert.equal(late.of("attached")[0]?.archived, true, "a dead process is archived even with a bridge object");

manager.shutdown();
console.log("session-failure: ok");
process.exit(0);
