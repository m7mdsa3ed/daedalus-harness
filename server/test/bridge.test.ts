// Self-check for the server-side ACP client: spawn the fake agent through
// SessionManager, assert the handshake, the event log, replay on reattach, the
// multi-peer arbitration and the failure paths.
// Run: pnpm test (DAEDALUS_DATA_DIR is set by the npm script — static
// imports are hoisted, so setting it here would be too late).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson } from "../src/config.js";
import type { Profile } from "../src/profiles.js";
import type { ThreadCommand, ThreadEvent } from "../src/protocol.js";

rmSync(process.env.DAEDALUS_DATA_DIR!, { recursive: true, force: true });
writeJson(join(process.env.DAEDALUS_DATA_DIR!, "agents.json"), [
  {
    id: "fake",
    name: "Fake",
    command: "node",
    args: [join(dirname(fileURLToPath(import.meta.url)), "fake-agent.mjs")],
    env: { FAKE_KEY: "{apiKey}", FAKE_EMPTY: "{baseUrl}" },
  },
  {
    id: "fake-no-fork",
    name: "Fake without history",
    command: "node",
    args: [join(dirname(fileURLToPath(import.meta.url)), "fake-agent.mjs")],
    env: { FAKE_NO_FORK: "1" },
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
  /** Everything this peer has been sent, parsed. */
  get events(): ThreadEvent[] {
    return this.sent.map((l) => JSON.parse(l) as ThreadEvent);
  }
  of<K extends ThreadEvent["ev"]>(ev: K): Extract<ThreadEvent, { ev: K }>[] {
    return this.events.filter((e) => e.ev === ev) as Extract<ThreadEvent, { ev: K }>[];
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
  smallModel: "",
  webSearch: { enabled: false },
  knowledge: { enabled: false },
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

const send = (ws: MockWs, command: ThreadCommand) =>
  ws.emit("message", Buffer.from(JSON.stringify(command)));

const waitFor = async (predicate: () => boolean, what: string) => {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(predicate(), `timed out waiting for ${what}`);
};

const manager = new SessionManager({}, 1);

// --- the handshake happens server-side, before anyone attaches ---

const session = manager.create(profile, project);
await session.bridge!.ready;
assert.equal(session.liveAcpSessionId, "acp-123", "the server ran session/new itself");
// It is recorded straight away — a thread that keeps no id at all is a thread
// whose rollout, if the agent did flush one, nothing can ever find again — but
// it is recorded as *provisional*: no turn has committed to it, so it is the
// one id a later session/new is allowed to take the slot from.
assert.equal(session.acpSessionId, "acp-123", "a fresh session id is written down");
assert.equal(session.acpSessionProvisional, true, "…but not yet as a proven one");

const ws1 = new MockWs();
assert.equal(manager.attach(session.id, ws1 as never), null, "attach should succeed");
// The replay is bracketed, and the session's settings are already in the log —
// so a client that attaches after the handshake still learns them.
assert.equal(ws1.events[0].ev, "attached");
assert.equal(ws1.of("session_config").length, 1, "session/new's answer was journaled");
assert.ok(ws1.of("caught_up")[0], "the replay is closed off");

// --- a turn ---

send(ws1, { id: 1, cmd: "prompt", text: "hello fake agent" });
await waitFor(() => ws1.of("turn_ended").length === 1, "turn end");
assert.equal(session.title, "hello fake agent", "the title is sniffed from the first prompt");
// The turn is what makes the session findable again, so now it is proven.
// The *first* turn runs unforked: a session the agent has only minted cannot be
// resumed, and a fork is a resume — asking for one used to fail the prompt with
// ResourceNotFound naming the child it had just created. There is also nothing
// to revert to before the first turn.
assert.equal(session.acpSessionId, "acp-123", "the first turn runs on the session itself");
assert.equal(session.acpSessionProvisional, false, "a turn promotes the id to a proven one");
assert.equal(session.bridge!.promptActive, false);
assert.ok(ws1.of("update").length > 0, "the transcript streamed");
assert.deepEqual(
  ws1.of("reply").map((r) => r.id),
  [1],
  "the command that can fail got exactly one reply",
);
// The sender showed its own message, so it is not told about its own prompt.
assert.equal(ws1.of("turn_started").length, 0);
assert.ok(ws1.of("ttft")[0], "time to first update is measured server-side");
assert.ok(ws1.of("turn_ended")[0].usage, "usage rides the turn end");

// --- and the second turn, which is the first one there is a checkpoint for ---

send(ws1, { id: 2, cmd: "prompt", text: "and again" });
await waitFor(() => ws1.of("turn_ended").length === 2, "the second turn");
assert.equal(session.acpSessionId, "acp-fork-1", "now the fork carries the conversation");
assert.equal(session.acpSessionProvisional, false);

// --- reattach: the journaled events come back, in order ---

ws1.close();
assert.equal(manager.list()[0].attached, false);
const ws2 = new MockWs();
assert.equal(manager.attach(session.id, ws2 as never, 0), null, "attach should succeed");
const journaled = (ws: MockWs) =>
  ws.events.filter((e) => e.ev === "update" || e.ev === "session_config" || e.ev === "turn_started" || e.ev === "turn_ended");
assert.deepEqual(journaled(ws2), manager.journal(session.id)!.events, "a replay is the log");
assert.deepEqual(
  journaled(ws2).filter((e) => e.ev !== "turn_started"),
  journaled(ws1),
  "…and the log is what the live socket said, bar the peer's own prompt",
);
assert.equal(ws2.of("caught_up")[0].cursor, session.eventCount);

// --- the same replay, batched into one frame ---
// `?batch=1` changes the number of frames and nothing else: the bracket still
// brackets, and what is inside is the log in order.
const ws2b = new MockWs();
assert.equal(manager.attach(session.id, ws2b as never, 0, true), null, "attach should succeed");
assert.equal(ws2b.events[0].ev, "attached");
assert.equal(ws2b.events[ws2b.events.length - 1].ev, "caught_up");
assert.equal(journaled(ws2b).length, 0, "no journaled event rode on its own frame");
const batched = ws2b.of("replay");
assert.equal(batched.length, 1, "one chunk holds a log this short");
assert.deepEqual(
  batched.flatMap((r) => r.events),
  manager.journal(session.id)!.events,
  "the batched replay is the same log the one-at-a-time replay sent",
);
assert.equal(ws2b.of("caught_up")[0].cursor, session.eventCount);
ws2b.close();

// Cursor skips already-seen events; only the bracket is left.
const ws3 = new MockWs();
assert.equal(manager.attach(session.id, ws3 as never, session.eventCount), null, "attach should succeed");
assert.equal(journaled(ws3).length, 0);
assert.equal(ws3.sent.length, 2, "attached + caught_up and nothing else");

// --- two devices attached to one thread ---

ws2.close();
ws3.close();
const a = new MockWs();
const b = new MockWs();
assert.equal(manager.attach(session.id, a as never, session.eventCount), null, "attach should succeed");
assert.equal(manager.attach(session.id, b as never, session.eventCount), null, "attach should succeed");
assert.equal(manager.list()[0].peerCount, 2);

// A prompt from one peer: the other sees the same updates and learns about the
// prompt through turn_started, and never sees the reply.
send(a, { id: 2, cmd: "prompt", text: "second turn" });
await waitFor(() => b.of("turn_ended").length === 1, "peer sees turn end");
assert.equal(b.of("turn_started").length, 1, "the other peer learns whose words started it");
assert.equal(b.of("turn_started")[0].text, "second turn");
assert.equal(a.of("turn_started").length, 0);
assert.deepEqual(b.of("update"), a.of("update"));
assert.equal(b.of("reply").length, 0, "a reply belongs to the peer that asked");
assert.equal(a.of("reply").length, 1);

// A permission request fans out to both peers; the first answer wins and the
// other peer is told to dismiss. The loser's late duplicate is answered
// directly, so its card still clears and the agent never sees two responses.
send(a, { id: 3, cmd: "prompt", text: "needs permission" });
await waitFor(() => b.of("permission").length === 1, "permission fans out to both peers");
assert.equal(a.of("permission").length, 1, "the asking peer sees it too");
const requestId = a.of("permission")[0].requestId;
send(b, {
  cmd: "answer_permission",
  requestId,
  response: { outcome: { outcome: "selected", optionId: "allow" } },
});
await waitFor(() => a.of("request_answered").length === 1, "the other peer is told to dismiss");
assert.equal(b.of("request_answered").length, 0, "…but the answerer is not told about itself");
send(a, { cmd: "answer_permission", requestId, response: { outcome: { outcome: "cancelled" } } });
await waitFor(() => a.of("request_answered").length === 2, "a late duplicate clears its own card");
await waitFor(() => a.of("turn_ended").length === 2, "the permission-gated turn completes once");
assert.equal(b.of("turn_ended").length, 2);
assert.equal(session.bridge!.promptActive, false);

// Steering: a second prompt sent mid-turn must not end the turn early — the
// indicator belongs to the whole turn, not to the first prompt in it.
const before2 = a.of("turn_ended").length;
send(a, { id: 4, cmd: "prompt", text: "one" });
send(a, { id: 5, cmd: "prompt", text: "two" });
await waitFor(() => a.of("turn_ended").length >= before2 + 1, "the steered turn ends");
await new Promise((r) => setTimeout(r, 200));
assert.equal(a.of("turn_ended").length, before2 + 1, "two prompts, exactly one turn end");

// Compaction. The fake agent stays silent about it unless the client claimed
// `session.compaction` at initialize, so seeing the updates at all is the
// assertion that we advertise it — and they are ordinary `update` events, which
// is what puts them in the journal and back on screen after a reload.
const beforeCompact = b.of("update").length;
send(a, { id: 6, cmd: "prompt", text: "please compact" });
await waitFor(() => a.of("turn_ended").length >= 4, "the compaction turn ends");
const compactionUpdates = b
  .of("update")
  .slice(beforeCompact)
  .map((e) => e.update)
  .filter((u: { sessionUpdate: string }) => u.sessionUpdate.startsWith("compaction"));
assert.deepEqual(
  compactionUpdates.map((u: { sessionUpdate: string }) => u.sessionUpdate),
  [
    "compaction_update",
    "compaction_summary_chunk",
    "compaction_summary_chunk",
    "compaction_update",
  ],
  "the agent compacts only because the handshake said we can render it",
);
assert.ok(
  manager
    .journal(session.id)!
    .events.some(
      (e) => e.ev === "update" && e.update.sessionUpdate === "compaction_update",
    ),
  "a compaction survives a reload like any other update",
);

// A peer leaving does not disturb the other.
a.close();
assert.equal(manager.list()[0].peerCount, 1);
assert.equal(manager.list()[0].attached, true);
b.close();
assert.equal(manager.list()[0].attached, false);

// --- respawn is atomic ---

// Set an option that is neither model nor effort: a respawn is a new process on
// a new profile, and the way the user had the agent configured has to survive
// it. The client used to drive this in three round trips; the server does it
// inside respawn now, so nothing can navigate away halfway through.
const tuner = new MockWs();
assert.equal(manager.attach(session.id, tuner as never, session.eventCount), null);
send(tuner, { id: 6, cmd: "set_config_option", configId: "verbose", value: true });
await waitFor(() => tuner.of("reply").some((r) => r.id === 6), "the option is accepted");
assert.equal(
  session.bridge!.configOptions.find((o) => o.id === "verbose")?.currentValue,
  true,
);
// A model change is also recorded on the session, or reviving a retired thread
// would put it back on the model the user switched away from.
send(tuner, { id: 7, cmd: "set_config_option", configId: "model", value: "smart" });
await waitFor(() => session.model === "smart", "a model change reaches the spawn record");
tuner.close();

await manager.respawn(session.id, { ...profile, name: "test2", defaultModel: "m2" }, project);
assert.equal(session.model, "m2");
assert.equal(session.exited, false);
assert.ok(session.eventCount > 0, "the load replay refilled the log it cleared");
const reloaded = manager.journal(session.id)!;
assert.ok(
  reloaded.events.some((e) => e.ev === "update" && e.historyReplay),
  "the conversation came back as history, not as news",
);
assert.equal(
  session.bridge!.configOptions.find((o) => o.id === "verbose")?.currentValue,
  true,
  "the restart put the agent's settings back",
);

// Two overlapping respawns — a double-click, two tabs, model then effort
// changed in quick succession. The second used to close the first call's
// not-yet-ready bridge, and `close(reason)` rejects exactly the promise the
// first call is awaiting (`bridge.ready`), so the first route answered 500
// "respawning" while the second one's thread came up fine. They queue now.
{
  const first = manager.respawn(session.id, profile, project);
  await new Promise((r) => setTimeout(r, 30)); // first spawn is up, handshake in flight
  const second = manager.respawn(session.id, { ...profile, name: "test3" }, project);
  const settled = await Promise.allSettled([first, second]);
  assert.deepEqual(
    settled.map((r) => r.status),
    ["fulfilled", "fulfilled"],
    "an overlapping respawn queues behind the first instead of killing it",
  );
  assert.equal(session.profileId, profile.id, "the last request's profile is the one that stuck");
}

// --- failure paths ---

// A prompt the agent answers with a bare "Internal error": the reason it wrote
// to stderr is spliced into the error on the way out, and it reaches BOTH the
// peer that prompted (as a reply is not used for turn outcomes, that means
// turn_ended) and the peers that didn't. Without this the client can only ever
// say "Internal error".
const failer = new MockWs();
const watcher = new MockWs();
assert.equal(manager.attach(session.id, failer as never, session.eventCount), null);
assert.equal(manager.attach(session.id, watcher as never, session.eventCount), null);
send(failer, { id: 8, cmd: "prompt", text: "please fail" });
await waitFor(() => failer.of("turn_ended").length === 1, "the failed turn ends");
const failure = failer.of("turn_ended")[0];
assert.ok(failure.error, "a failed prompt still ends the turn, and says so");
assert.equal(failure.error!.code, -32603);
assert.match(
  (failure.error!.data as { stderr: string }).stderr,
  /529/,
  "the agent's stderr explains the internal error",
);
assert.equal(failure.promptText, "please fail", "…and a replay can still offer Retry");
const fanned = watcher.of("turn_ended")[0];
assert.ok(fanned, "a peer that didn't prompt still learns the turn ended");
assert.match((fanned.error!.data as { stderr: string }).stderr, /529/, "…and why it ended badly");
assert.equal(session.bridge!.promptActive, false);
failer.close();
watcher.close();

// An agent that dies holding a turn: the in-flight prompt is answered rather
// than left hanging until the socket eventually closes.
await manager.respawn(session.id, profile, project);
const doomed = new MockWs();
assert.equal(manager.attach(session.id, doomed as never, 0), null);
send(doomed, { id: 9, cmd: "prompt", text: "now crash" });
await waitFor(() => doomed.of("turn_ended").some((t) => t.error), "the abandoned prompt is answered");
const abandoned = doomed.of("turn_ended").find((t) => t.error)!;
assert.match(abandoned.error!.message, /ended/, "…with what happened to the process");
assert.match(
  (abandoned.error!.data as { stderr: string }).stderr,
  /Fatal/,
  "…and the agent's last words",
);
await waitFor(() => doomed.closes.length > 0, "the peers are closed after being told");
assert.ok(doomed.closes.some(([code]) => code === 4001), "a dead agent closes its peers with 4001");
// Every close reason must fit the protocol's 123-byte cap — `ws` rejects an
// oversized one by throwing, and these are emitted from an exit handler where
// that would take the server down instead of closing a socket.
for (const [, reason] of doomed.closes) {
  assert.ok(Buffer.byteLength(reason ?? "", "utf8") <= 123, `close reason too long: ${reason}`);
}

await manager.respawn(session.id, profile, project);

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

// --- a reload while a question is open ---

// The client comes back attaching from the END of the log, so a permission
// request made earlier sits below its cursor. It still has to be sent — the
// agent is blocked on it, and nothing else would ever ask again. It is not in
// the log at all: it lives in the bridge's pending map, for exactly as long as
// the agent is waiting.
const reloading = manager.create(profile, project);
await reloading.bridge!.ready;
const before = new MockWs();
assert.equal(manager.attach(reloading.id, before as never, 0), null, "attach should succeed");
send(before, { id: 1, cmd: "prompt", text: "needs permission" });
await waitFor(() => before.of("permission").length === 1, "the prompt raises a permission request");
const askedId = before.of("permission")[0].requestId;

before.close();
const after = new MockWs();
assert.equal(manager.attach(reloading.id, after as never, reloading.eventCount), null);
const reasked = after.of("permission")[0];
assert.ok(reasked, "the open permission request survives a reload");
assert.equal(reasked.requestId, askedId, "…and it is the one the agent is still waiting on");
assert.ok(
  after.events.findIndex((e) => e.ev === "permission") >
    after.events.findIndex((e) => e.ev === "caught_up"),
  "…sent after the replay, so it reads as live",
);

send(after, {
  cmd: "answer_permission",
  requestId: askedId,
  response: { outcome: { outcome: "selected", optionId: "allow" } },
});
await waitFor(() => after.of("turn_ended").length === 1, "the answer unblocks the turn");
assert.equal(reloading.bridge!.promptActive, false);
// Once answered it must NOT come back on the next attach — that would be a
// dialog for a question nobody is asking any more.
const later = new MockWs();
assert.equal(manager.attach(reloading.id, later as never, reloading.eventCount), null);
assert.equal(later.of("permission").length, 0, "an answered request is not replayed");

// A dying process must not take an open question with it: the agent's promise
// is held here now, so nothing else would ever settle it.
send(later, { id: 2, cmd: "prompt", text: "needs permission again" });
await waitFor(() => later.of("permission").length === 1, "a second question");
assert.equal(reloading.bridge!.pending.size, 1);
manager.purge(reloading.id);
assert.equal(reloading.bridge, null, "purge retires the bridge with the process");

// --- storage ---

// The log is a table, so a replay reaching further back than anything held in
// memory has to come back whole and in order.
const logged = manager.create(profile, project);
await logged.bridge!.ready;
const bulk = new MockWs();
assert.equal(manager.attach(logged.id, bulk as never, 0), null, "attach should succeed");
for (let i = 0; i < 25; i++) {
  send(bulk, { id: 100 + i, cmd: "prompt", text: `turn ${i}` });
  await waitFor(() => bulk.of("turn_ended").length === i + 1, `turn ${i}`);
}
const log = manager.journal(logged.id)!;
assert.equal(log.cursor, log.events.length, "cursor is the event count");
assert.deepEqual(
  log.events.map((e) => (e as { seq: number }).seq),
  [...Array(log.events.length).keys()],
  "every event, in order",
);
assert.deepEqual(
  log.events.filter((e) => e.ev === "turn_started").map((e) => e.text),
  [...Array(25).keys()].map((i) => `turn ${i}`),
  "…including a user message per turn",
);

// Soft delete keeps the row and refuses new attachments; restore undoes it.
assert.ok(manager.softDelete(logged.id));
assert.equal(manager.list().find((s) => s.id === logged.id)?.deletedAt !== null, true);
assert.equal(manager.attach(logged.id, new MockWs() as never, 0), "this thread is in the trash");
assert.equal(manager.journal(logged.id)!.cursor, 0, "retiring clears the log");
assert.ok(manager.restore(logged.id));
assert.equal(manager.list().find((s) => s.id === logged.id)?.deletedAt, null);
assert.ok(manager.purge(logged.id));
assert.equal(manager.journal(logged.id), undefined, "purge forgets the thread");

// --- a refused session/load must not cost the thread its history ---

// The thread has a conversation the agent knows about...
const orphan = manager.create(profile, project);
await orphan.bridge!.ready;
const orphanWs = new MockWs();
manager.attach(orphan.id, orphanWs as never);
send(orphanWs, { id: 1, cmd: "prompt", text: "remember this" });
await waitFor(() => orphanWs.of("turn_ended").length === 1, "the turn that records the session");
assert.equal(orphan.acpSessionId, "acp-123");

// ...and then a revive asks for one the agent cannot find. It comes back on a
// fresh session — the thread stays usable — but the id it failed on is still
// the thread's, because that id is the only pointer to a transcript which is
// very often still in the agent's store. Replacing it is what turned one
// refusal into a thread that could never find its history again.
orphan.acpSessionId = "acp-gone";
await manager.respawn(orphan.id, profile, project);
assert.equal(orphan.acpSessionId, "acp-gone", "the failed id is kept, not overwritten");
assert.equal(orphan.liveAcpSessionId, "acp-123", "the process runs on the fallback session");
assert.ok(orphan.historyLost, "the refusal is recorded rather than swallowed");
assert.equal(orphan.historyLost!.acpSessionId, "acp-gone");
assert.match(String((orphan.historyLost!.error.data as { details?: string }).details), /no rollout/);

// And the peer is told, so an empty transcript cannot pass for a quiet one.
const orphanWs2 = new MockWs();
manager.attach(orphan.id, orphanWs2 as never);
assert.ok(
  (orphanWs2.events[0] as { historyLost?: unknown }).historyLost,
  "attach carries the lost history",
);

// A turn on the fallback session is what finally moves the record: there is
// something to load now, and the old id has proven it leads nowhere.
send(orphanWs2, { id: 1, cmd: "prompt", text: "start over" });
await waitFor(() => orphanWs2.of("turn_ended").length === 1, "the turn on the new session");
assert.equal(orphan.acpSessionId, "acp-123", "a session with a turn in it takes over the record");
assert.equal(orphan.historyLost, null, "and the warning goes with it");
assert.ok(manager.purge(orphan.id));

// --- the same refusal, on an id no turn ever committed to ---

// The mirror image: a provisional id has no transcript behind it by
// definition, so a refusal to load it strands nothing. It is replaced without
// argument, and it is NOT reported as lost history — otherwise every thread
// killed before its first turn finished would come back wearing an error.
const unproven = manager.create(profile, project);
await unproven.bridge!.ready;
assert.equal(unproven.acpSessionProvisional, true);
unproven.acpSessionId = "acp-gone";
await manager.respawn(unproven.id, profile, project);
assert.equal(unproven.acpSessionId, "acp-123", "an unproven id yields to the fallback");
assert.equal(unproven.acpSessionProvisional, true, "which is itself still unproven");
assert.equal(unproven.historyLost, null, "and nothing was lost to report");
assert.ok(manager.purge(unproven.id));

// --- persistence across a restart ---

const session2 = manager.create(profile, project);
await session2.bridge!.ready;
const manager2 = new SessionManager({}, 1);
const restored = manager2.list().find((s) => s.id === session2.id);
assert.ok(restored, "session survives a manager restart");
assert.equal(restored!.exited, true);
// The restart killed it before any turn settled — the window that used to
// throw the id away. The agent may well have flushed the session anyway (they
// do it lazily, not never), so the provisional id survives the restart and the
// revive tries to load it rather than starting a stranger.
assert.equal(restored!.acpSessionId, "acp-123", "an unproven id still survives a restart");
const revived = await manager2.respawn(session2.id, profile, project);
assert.equal(revived.exited, false);
assert.equal(revived.acpSessionId, "acp-123", "and the revive loaded it");
assert.equal(revived.acpSessionProvisional, false, "a load that answered proves the id");
assert.equal(revived.historyLost, null);
assert.ok(manager2.purge(session2.id));
assert.ok(manager.purge(session2.id));

// Purging cascades: no orphan event rows are left behind for any session.
const { db, sessionEvents } = await import("../src/db/index.js");
assert.equal(
  db.select().from(sessionEvents).all().length,
  0,
  "event rows cascade with the session",
);

// --- registry: env templates ---

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

const unsupportedSession = manager.create({ ...profile, id: "p-no-fork", agentId: "fake-no-fork" }, project);
await unsupportedSession.bridge!.ready;
const unsupportedWs = new MockWs();
manager.attach(unsupportedSession.id, unsupportedWs as never);
assert.equal(unsupportedWs.of("attached")[0]!.history.available, false);
assert.equal(unsupportedWs.of("attached")[0]!.history.strategy, "unsupported");
send(unsupportedWs, { id: 99, cmd: "prompt", text: "still works" });
await waitFor(() => unsupportedWs.of("turn_ended").length === 1, "unsupported agent turn");
assert.equal(unsupportedWs.of("history_state").length, 0, "no restore points are invented");
assert.ok(manager.purge(unsupportedSession.id));

// --- generic history checkpoints restore ACP and workspace state together ---

writeFileSync(join(project.cwd, "history-original.txt"), "original\n");
writeFileSync(join(project.cwd, "history-delete.txt"), "keep me\n");
const historySession = manager.create(profile, project);
await historySession.bridge!.ready;
const historyWs = new MockWs();
manager.attach(historySession.id, historyWs as never);
// One turn to make the session forkable — the agent has to have written it
// down before it can branch from it — and to prove the unforkable first turn
// costs nothing but its checkpoint: the prompt still runs.
send(historyWs, { id: 98, cmd: "prompt", text: "warm up" });
await waitFor(() => historyWs.of("turn_ended").length === 1, "the unforkable first turn");
assert.equal(historyWs.of("reply").find((event) => event.id === 98)!.error, undefined);
assert.equal(
  historyWs.of("history_state").at(-1)!.history.checkpoints.length,
  0,
  "nothing to revert to before the first turn",
);
send(historyWs, { id: 100, cmd: "prompt", text: "edit workspace" });
await waitFor(() => historyWs.of("turn_ended").length === 2, "history turn end");
await waitFor(
  () => historyWs.of("history_state").some((event) => event.history.checkpoints.length === 1),
  "completed history checkpoint",
);
const checkpoint = historyWs.of("history_state").at(-1)!.history.checkpoints[0]!;
assert.equal(readFileSync(join(project.cwd, "history-original.txt"), "utf8"), "changed by agent\n");
assert.equal(existsSync(join(project.cwd, ".history-created")), true);
assert.equal(existsSync(join(project.cwd, "history-delete.txt")), false);

send(historyWs, { id: 101, cmd: "revert", checkpointId: checkpoint.id });
await waitFor(() => historyWs.of("reply").some((event) => event.id === 101), "revert reply");
assert.equal(historyWs.of("reply").find((event) => event.id === 101)!.error, undefined);
assert.equal(readFileSync(join(project.cwd, "history-original.txt"), "utf8"), "original\n");
assert.equal(readFileSync(join(project.cwd, "history-delete.txt"), "utf8"), "keep me\n");
assert.equal(existsSync(join(project.cwd, ".history-created")), false);
assert.equal(existsSync(join(project.cwd, "history-binary.bin")), false);
assert.ok(historyWs.of("history_reset")[0], "all peers reset before ACP history is replayed");
assert.equal(historyWs.of("history_state").at(-1)!.history.branches.length, 1, "discarded child branch is retained");

const discardedBranch = historyWs.of("history_state").at(-1)!.history.branches[0]!;
send(historyWs, { id: 105, cmd: "recover_branch", branchId: discardedBranch.id });
await waitFor(() => historyWs.of("reply").some((event) => event.id === 105), "branch recovery reply");
assert.equal(historyWs.of("reply").find((event) => event.id === 105)!.error, undefined);
assert.equal(readFileSync(join(project.cwd, "history-original.txt"), "utf8"), "changed by agent\n");
const revertedBranch = historyWs.of("history_state").at(-1)!.history.branches.find(
  (branch) => branch.label === "Branch before recovery",
)!;
send(historyWs, { id: 106, cmd: "recover_branch", branchId: revertedBranch.id });
await waitFor(() => historyWs.of("reply").some((event) => event.id === 106), "reverted branch recovery reply");
assert.equal(historyWs.of("reply").find((event) => event.id === 106)!.error, undefined);
assert.equal(readFileSync(join(project.cwd, "history-original.txt"), "utf8"), "original\n");

// Steering shares the restore point created for the logical turn.
send(historyWs, { id: 102, cmd: "prompt", text: "one" });
send(historyWs, { id: 103, cmd: "prompt", text: "two" });
await waitFor(() => historyWs.of("turn_ended").length === 3, "steered history turn end");
await waitFor(
  () => historyWs.of("history_state").at(-1)?.history.checkpoints.length === 1,
  "one checkpoint for steering",
);
const steeredCheckpoint = historyWs.of("history_state").at(-1)!.history.checkpoints[0]!;

// An edit outside the known branch head is never overwritten.
writeFileSync(join(project.cwd, "intervening.txt"), "mine\n");
send(historyWs, { id: 104, cmd: "revert", checkpointId: steeredCheckpoint.id });
await waitFor(() => historyWs.of("reply").some((event) => event.id === 104), "conflict reply");
assert.ok(historyWs.of("reply").find((event) => event.id === 104)!.error, "the conflict rejects the command");
assert.equal(readFileSync(join(project.cwd, "intervening.txt"), "utf8"), "mine\n");
assert.match(historyWs.of("history_state").at(-1)!.history.conflict!, /changed after the last agent turn/);
assert.ok(manager.purge(historySession.id));

// --- a checkpoint that cannot be taken costs its checkpoint, not the turn ---

// Forcing the durability flag makes the bridge ask for a fork the agent will
// refuse — the exact failure that used to reach the user as "the agent couldn't
// find that resource", naming a session id it had minted a moment earlier, with
// their message never sent at all.
const refusedSession = manager.create(profile, project);
await refusedSession.bridge!.ready;
refusedSession.bridge!.sessionDurable = true;
const refusedWs = new MockWs();
manager.attach(refusedSession.id, refusedWs as never);
send(refusedWs, { id: 200, cmd: "prompt", text: "go on anyway" });
await waitFor(() => refusedWs.of("turn_ended").length === 1, "the uncheckpointed turn still runs");
assert.equal(refusedWs.of("reply").find((event) => event.id === 200)!.error, undefined);
assert.match(
  refusedWs.of("history_state").at(-1)!.history.conflict!,
  /not checkpointed/,
  "and the thread is told why it has no restore point",
);
assert.ok(manager.purge(refusedSession.id));

console.log("bridge.test.ts OK");
process.exit(0);
