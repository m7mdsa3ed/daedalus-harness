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
    /* The same script, but configured to open every turn with Codex's
       fallback-metadata notice — what the normal fake cannot emit, because
       the env template is the agent's and every profile shares it. */
    id: "fake-warn",
    name: "Fake (fallback warning)",
    command: "node",
    args: [join(dirname(fileURLToPath(import.meta.url)), "fake-agent.mjs")],
    env: {
      FAKE_KEY: "{apiKey}",
      FAKE_FALLBACK_WARNING:
        "Warning: Model metadata for `cmc/deepseek/deepseek-v4-flash-fast` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.",
    },
  },
]);

const { SessionManager } = await import("../src/sessions.js");

/* Which door a persona reaches this agent through — set on the row rather than
   in agents.json above, because the legacy importer deliberately does not carry
   it (nor `liveConfig`, nor `quotaProbe`): those are claims about a runtime that
   only `seedAgents`' backfill is entitled to make, and it never touches an agent
   the user wrote themselves. Without it the bridge correctly sends no persona at
   all, which would make the assertions at the end of this file vacuous. */
{
  const { eq } = await import("drizzle-orm");
  const { db, agents: agentsTable } = await import("../src/db/index.js");
  db.update(agentsTable).set({ personaVia: "acp-meta" }).where(eq(agentsTable.id, "fake")).run();
}

class MockWs extends EventEmitter {
  sent: string[] = [];
  /** Every close(code, reason) the manager asked for — the reason is capped at
      123 bytes by the WebSocket protocol, so it is worth asserting on. */
  closes: [number | undefined, string | undefined][] = [];
  /** Open, as far as the socket router is concerned: it skips a replay whose
      peer has gone away, so a mock that never says it is open replays nothing. */
  readyState = 1;
  /** The callback is how the replay paces itself against a real socket (it is
      what `SessionSocket.sendFrame` awaits), so a mock that ignores it hangs
      the attach rather than failing it. */
  send(line: string, cb?: (error?: Error) => void) {
    this.sent.push(line);
    cb?.();
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
  agents: { fake: {} },
  baseUrl: "",
  apiKey: "sk-test",
  models: [],
  defaultModel: "",
  smallModel: "",
  logoUrl: "",
  mcpServerIds: [],
  skillIds: [],
  commandIds: [],
};
const project = {
  id: "w1",
  name: "test-ws",
  cwd: "/tmp/daedalus-test-data/ws",
  description: null,
};

const send = (ws: MockWs, command: ThreadCommand) =>
  ws.emit("message", Buffer.from(JSON.stringify(command)));

const waitFor = async (predicate: () => boolean, what: string) => {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(predicate(), `timed out waiting for ${what}`);
};

const manager = new SessionManager({}, 1);

// --- the handshake happens server-side, before anyone attaches ---

const session = manager.create(profile, "fake", project);
await session.bridge!.ready;
assert.equal(session.liveAcpSessionId, "acp-123", "the server ran session/new itself");
// It is recorded straight away — a thread that keeps no id at all is a thread
// whose rollout, if the agent did flush one, nothing can ever find again — but
// it is recorded as *provisional*: no turn has committed to it, so it is the
// one id a later session/new is allowed to take the slot from.
assert.equal(session.acpSessionId, "acp-123", "a fresh session id is written down");
assert.equal(session.acpSessionProvisional, true, "…but not yet as a proven one");

const ws1 = new MockWs();
assert.equal(await manager.attach(session.id, ws1 as never), null, "attach should succeed");
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
// --- subagents, both mechanisms ---
// claude-agent-acp's: the child's prose is sent only to a client that claimed
// `_meta["subagent-transcript"]` at initialize, so seeing it at all is the
// assertion that the handshake did — and that `_meta` reaches the host whole.
const meta = (e: { update: { _meta?: unknown } }) =>
  (e.update._meta as { claudeCode?: { parentToolUseId?: string } } | undefined)?.claudeCode;
assert.ok(
  ws1.of("update").some((e) => e.update.sessionUpdate === "agent_message_chunk" && meta(e)?.parentToolUseId === "t7"),
  "a subagent's prose arrives, attributed to its Task",
);
assert.ok(
  ws1.of("update").some(
    (e) => e.update.sessionUpdate === "tool_call_update" && e.update.toolCallId === "t7a" && meta(e)?.parentToolUseId === "t7",
  ),
  "a late attribution rides the update, verbatim",
);
// The RFD's: the agent sends these only to a client that claimed `subagents`;
// the SDK's parser would have dropped `subagent_spawned` as an unknown variant;
// and the child's own updates are told apart by the session id they came on.
assert.ok(
  ws1.of("update").some((e) => e.update.sessionUpdate === "subagent_spawned"),
  "the RFD's spawn update survives the SDK's closed union",
);
/* Which children spoke, not how many times: the fake agent's subagent scene is
   the transcript's sample set and grows a worker whenever a row needs one. What
   must not change is that an update of a child's carries that child's id and an
   update of the thread's own carries none. */
assert.deepEqual(
  [...new Set(ws1.of("update").filter((e) => e.sessionId !== undefined).map((e) => e.sessionId))],
  ["sub-1", "sub-2", "sub-3"],
  "the child's updates carry its session id, the thread's own carry none",
);
assert.ok(
  ws1.of("update").some((e) => e.update.sessionUpdate === "subagent_state_update"),
  "…and the child's terminal state arrives on the parent",
);
assert.deepEqual(
  ws1.of("reply").map((r) => r.id),
  [1],
  "the command that can fail got exactly one reply",
);
// The sender showed its own message, so it is not told about its own prompt.
assert.equal(ws1.of("turn_started").length, 0);
assert.ok(ws1.of("ttft")[0], "time to first update is measured server-side");
assert.ok(ws1.of("turn_ended")[0].usage, "usage rides the turn end");

// --- and a second turn on the same session ---

send(ws1, { id: 2, cmd: "prompt", text: "and again" });
await waitFor(() => ws1.of("turn_ended").length === 2, "the second turn");
assert.equal(session.acpSessionId, "acp-123", "the session id is unchanged");
assert.equal(session.acpSessionProvisional, false);

// --- reattach: the journaled events come back, in order ---

ws1.close();
assert.equal(manager.list()[0].attached, false);
const ws2 = new MockWs();
assert.equal(await manager.attach(session.id, ws2 as never, 0), null, "attach should succeed");
const journaled = (ws: MockWs) =>
  ws.events.filter((e) => e.ev === "update" || e.ev === "session_config" || e.ev === "turn_started" || e.ev === "turn_ended");
assert.deepEqual(journaled(ws2), manager.journal(session.id)!.events, "a replay is the log");
assert.ok(
  ws2.of("update").some((e) => e.sessionId === "sub-1"),
  "a child's session id is journaled with its update, so a replay nests it again",
);
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
assert.equal(await manager.attach(session.id, ws2b as never, 0, true), null, "attach should succeed");
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
assert.equal(await manager.attach(session.id, ws3 as never, session.eventCount), null, "attach should succeed");
assert.equal(journaled(ws3).length, 0);
assert.equal(ws3.sent.length, 2, "attached + caught_up and nothing else");

// --- two devices attached to one thread ---

ws2.close();
ws3.close();
const a = new MockWs();
const b = new MockWs();
assert.equal(await manager.attach(session.id, a as never, session.eventCount), null, "attach should succeed");
assert.equal(await manager.attach(session.id, b as never, session.eventCount), null, "attach should succeed");
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
// indicator belongs to the whole turn, not to the first prompt in it. It has
// to say `steer` now: a bare prompt sent mid-turn is queued instead.
const before2 = a.of("turn_ended").length;
send(a, { id: 4, cmd: "prompt", text: "one" });
send(a, { id: 5, cmd: "prompt", text: "two", steer: true });
await waitFor(() => a.of("turn_ended").length >= before2 + 1, "the steered turn ends");
await new Promise((r) => setTimeout(r, 200));
assert.equal(a.of("turn_ended").length, before2 + 1, "two prompts, exactly one turn end");

// --- the queue ---

const allow = { outcome: { outcome: "selected", optionId: "allow" } } as const;
const lastQueue = (ws: MockWs) => ws.of("queue").at(-1)?.items ?? [];
const park = async (n: number) => {
  send(a, { id: 1000 + n, cmd: "prompt", text: "needs permission" });
  await waitFor(() => b.of("permission").length === n, `turn ${n} parks on a permission`);
  return b.of("permission").at(-1)!.requestId;
};

// A prompt sent while a turn is running is queued, not steered. The reply says
// so, and the queue reaches every peer — the one that asked included — as the
// whole list, because the ids are the server's.
const qEnded = a.of("turn_ended").length;
const qStarted = a.of("turn_started").length;
let permission = await park(2);
send(b, { id: 21, cmd: "prompt", text: "queued one" });
await waitFor(() => b.of("reply").some((r) => r.id === 21), "the busy prompt is answered");
const queuedReply = b.of("reply").find((r) => r.id === 21)!.result as { queued?: boolean; itemId?: string };
assert.equal(queuedReply.queued, true, "a mid-turn prompt is queued");
assert.equal(lastQueue(a).length, 1, "the other peer sees the queue");
assert.equal(lastQueue(b).length, 1, "…and so does the one that asked");
assert.equal(a.of("turn_started").length, qStarted, "nothing was sent to the agent");
send(a, { id: 22, cmd: "queue_add", text: "queued two" });
await waitFor(() => lastQueue(a).length === 2, "queue_add appends");
send(b, { id: 23, cmd: "queue_update", itemId: lastQueue(a)[0].id, text: "queued one!" });
await waitFor(() => lastQueue(a)[0]?.text === "queued one!", "an edit reaches every peer");
assert.deepEqual(lastQueue(a).map((i) => i.text), ["queued one!", "queued two"], "in order");
// The turn ends cleanly: everything queued goes out as ONE prompt, with no
// origin peer — so both peers draw the bubble from turn_started.
send(b, { cmd: "answer_permission", requestId: permission, response: allow });
await waitFor(() => a.of("turn_ended").length >= qEnded + 2, "the parked turn and the drained turn end");
const ended = a.of("turn_ended").slice(qEnded);
assert.equal(ended[0].continued, true, "the turn before a drain says the queue follows it");
assert.equal(ended[1].continued, undefined, "the drained turn is followed by nothing");
assert.equal(a.of("turn_started").at(-1)!.text, "queued one!\n\nqueued two", "combined, blank-line separated");
assert.equal(b.of("turn_started").at(-1)!.text, "queued one!\n\nqueued two", "…on every peer");
assert.deepEqual(lastQueue(a), [], "the queue is empty after the drain");
const journalAfterDrain = manager.journal(session.id)!.events;
const continuedAt = journalAfterDrain.findIndex((e) => e.ev === "turn_ended" && e.continued);
assert.equal(journalAfterDrain[continuedAt + 1].ev, "turn_started", "the drain is journaled right after the turn it follows");

// "Send now" on one item: the running turn is cancelled, that item goes out in
// its place, the rest stays queued — and drains when the new turn ends.
permission = await park(3);
send(a, { id: 31, cmd: "queue_add", text: "a1" });
send(a, { id: 32, cmd: "queue_add", text: "b1" });
await waitFor(() => lastQueue(a).length === 2, "two queued");
const sEnded = b.of("turn_ended").length;
const sStarted = b.of("turn_started").length;
send(a, { id: 33, cmd: "queue_send_now", itemId: lastQueue(a)[1].id });
await waitFor(() => a.of("reply").some((r) => r.id === 33), "send now answers once the new turn is dispatched");
assert.ok("turnId" in (a.of("reply").find((r) => r.id === 33)!.result as object), "…with the new turn's id");
const cancelled = b.of("turn_ended")[sEnded];
assert.equal(cancelled.error, undefined, "a cancelled turn is not a failure");
assert.equal(cancelled.continued, undefined, "…and does not drain the queue on its own");
assert.equal(b.of("turn_started")[sStarted].text, "b1", "only the chosen item was sent");
// The fake answers b1 in the same tick, so a1 may already have drained by
// now: what is asserted is the sequence the queue went through, not a snapshot.
await waitFor(() => b.of("turn_ended").length >= sEnded + 3, "b1 ends cleanly and a1 follows");
const queueHistory = a.of("queue").map((q) => q.items.map((i) => i.text).join(","));
const afterSendNow = queueHistory.lastIndexOf("a1,b1");
assert.deepEqual(queueHistory.slice(afterSendNow + 1), ["a1", ""], "the rest stayed queued until b1's turn ended");
assert.equal(b.of("turn_ended")[sEnded + 1].continued, true);
assert.equal(b.of("turn_started")[sStarted + 1].text, "a1", "the remainder drained after the sent-now turn");
assert.deepEqual(lastQueue(a), []);

// Steer: inject one queued item into the running turn without stopping it.
permission = await park(4);
send(a, { id: 41, cmd: "queue_add", text: "s1" });
await waitFor(() => lastQueue(a).length === 1, "one queued");
const stEnded = a.of("turn_ended").length;
send(b, { id: 42, cmd: "queue_steer", itemId: lastQueue(a)[0].id });
await waitFor(() => b.of("reply").some((r) => r.id === 42), "steer is answered");
assert.equal(a.of("turn_started").at(-1)!.text, "s1", "the steered item reached every peer");
assert.deepEqual(lastQueue(b), [], "…and left the queue");
assert.equal(session.bridge!.promptActive, true, "steering keeps the turn open");
send(a, { cmd: "answer_permission", requestId: permission, response: allow });
await waitFor(() => a.of("turn_ended").length === stEnded + 1, "the turn ends");
await new Promise((r) => setTimeout(r, 200));
assert.equal(a.of("turn_ended").length, stEnded + 1, "a steer plus its turn is one turn end");

// Stop parks the queue: nothing auto-follows a cancelled turn.
await park(5);
send(a, { id: 51, cmd: "queue_add", text: "parked" });
await waitFor(() => lastQueue(a).length === 1, "one queued");
const pEnded = a.of("turn_ended").length;
const pStarted = a.of("turn_started").length;
send(a, { id: 52, cmd: "cancel" });
await waitFor(() => a.of("turn_ended").length === pEnded + 1, "stop ends the turn");
await new Promise((r) => setTimeout(r, 200));
assert.equal(a.of("turn_ended").at(-1)!.continued, undefined, "a stop is not a continuation");
assert.equal(a.of("turn_started").length, pStarted, "nothing was sent after the stop");
assert.deepEqual(lastQueue(a).map((i) => i.text), ["parked"], "the queue is still there");
send(a, { id: 53, cmd: "queue_clear" });
await waitFor(() => lastQueue(a).length === 0, "clear empties it");
assert.equal(session.bridge!.promptActive, false);

// Compaction. The fake agent stays silent about it unless the client claimed
// `session.compaction` at initialize, so seeing the updates at all is the
// assertion that we advertise it — and they are ordinary `update` events, which
// is what puts them in the journal and back on screen after a reload.
const beforeCompact = b.of("update").length;
const beforeCompactEnded = a.of("turn_ended").length;
send(a, { id: 6, cmd: "prompt", text: "please compact" });
await waitFor(() => a.of("turn_ended").length > beforeCompactEnded, "the compaction turn ends");
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
assert.equal(await manager.attach(session.id, tuner as never, session.eventCount), null);
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

await manager.respawn(session.id, { ...profile, name: "test2", defaultModel: "m2" }, "fake", project);
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
  const first = manager.respawn(session.id, profile, "fake", project);
  await new Promise((r) => setTimeout(r, 30)); // first spawn is up, handshake in flight
  const second = manager.respawn(session.id, { ...profile, name: "test3" }, "fake", project);
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
assert.equal(await manager.attach(session.id, failer as never, session.eventCount), null);
assert.equal(await manager.attach(session.id, watcher as never, session.eventCount), null);
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
await manager.respawn(session.id, profile, "fake", project);
const doomed = new MockWs();
assert.equal(await manager.attach(session.id, doomed as never, 0), null);
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

await manager.respawn(session.id, profile, "fake", project);

// Soft delete keeps the row (and the acpSessionId that revives it); restore
// puts it back as a plain retired thread; purge is what actually forgets.
assert.ok(manager.softDelete(session.id));
const deleted = manager.list().find((s) => s.id === session.id);
assert.ok(deleted, "a deleted thread stays in the list");
assert.ok(deleted!.deletedAt, "…marked deleted");
assert.equal(deleted!.exited, true, "…with its process gone");
assert.match(
  await manager.attach(session.id, new MockWs() as never, 0) ?? "",
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
const reloading = manager.create(profile, "fake", project);
await reloading.bridge!.ready;
const before = new MockWs();
assert.equal(await manager.attach(reloading.id, before as never, 0), null, "attach should succeed");
send(before, { id: 1, cmd: "prompt", text: "needs permission" });
await waitFor(() => before.of("permission").length === 1, "the prompt raises a permission request");
const askedId = before.of("permission")[0].requestId;

before.close();
const after = new MockWs();
assert.equal(await manager.attach(reloading.id, after as never, reloading.eventCount), null);
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
assert.equal(await manager.attach(reloading.id, later as never, reloading.eventCount), null);
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
const logged = manager.create(profile, "fake", project);
await logged.bridge!.ready;
const bulk = new MockWs();
assert.equal(await manager.attach(logged.id, bulk as never, 0), null, "attach should succeed");
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

// --- a turn that lands while the replay is still going out ---

/* The replay is paced against the socket now (it awaits each frame's write, so
   a long archive does not stall every other thread's turn and a slow peer is
   not handed the whole window at once), which means it yields — and a turn can
   be journaled between two frames. That is what `Peer.pending` and the `to`
   bound on `replayFrames` are for, and this is the case that proves them: the
   events of that turn must reach the peer exactly once, after the bracket, as
   the live events they are — not twice (once from the replay's trailing page
   and once from the fan-out) and not before the history they follow.

   `SlowWs` holds every frame callback until it is released, which parks the
   attach mid-replay for as long as the test needs. */
class SlowWs extends MockWs {
  private held: (() => void)[] = [];
  private open = false;
  override send(line: string, cb?: (error?: Error) => void) {
    this.sent.push(line);
    if (!cb) return;
    if (this.open) cb();
    else this.held.push(() => cb());
  }
  /** Let the replay run to the end, and every frame after it. */
  release() {
    this.open = true;
    const held = this.held;
    this.held = [];
    for (const resume of held) resume();
  }
}

const interleaved = manager.create(profile, "fake", project);
await interleaved.bridge!.ready;
await manager.prompt(interleaved.id, "before the replay");
const beforeCount = interleaved.eventCount;
const slow = new SlowWs();
const attaching = manager.attach(interleaved.id, slow as never, 0, true);
// The attach is parked on its first frame. A whole turn happens under it.
await manager.prompt(interleaved.id, "during the replay");
await waitFor(() => interleaved.eventCount > beforeCount, "the turn was journaled");
slow.release();
assert.equal(await attaching, null, "the attach finishes once the socket drains");

const attachedMid = slow.of("attached")[0];
assert.equal(attachedMid.to, beforeCount, "the replay is bounded at the log it announced");
assert.equal(
  slow.of("caught_up")[0].cursor,
  beforeCount,
  "…and `caught_up` names that same end, not the log as it now stands",
);
const seen = [
  ...slow.of("replay").flatMap((r) => r.events),
  ...journaled(slow),
].map((e) => (e as { seq: number }).seq);
assert.deepEqual(
  seen,
  [...Array(interleaved.eventCount).keys()],
  "every event once, in order: the replay's, then the turn that overtook it",
);
const bracket = slow.events.findIndex((e) => e.ev === "caught_up");
assert.ok(
  slow.events.slice(0, bracket).every((e) => e.ev === "attached" || e.ev === "replay"),
  "nothing live jumped the bracket",
);
assert.ok(
  journaled(slow).some((e) => e.ev === "turn_started" && e.text === "during the replay"),
  "…and the turn arrived after it, as live",
);
slow.close();
assert.ok(manager.purge(interleaved.id));

// --- a retired thread keeps its log, and can be read from it ---

// Retiring stops the process; it does not throw the transcript away. That is
// what lets an idle-retired thread be opened and read without spawning an agent
// to re-narrate it — the log is a cache for reading, and only a revive (which
// is about to re-narrate the conversation for real) clears it.
const archivedCursor = manager.journal(logged.id)!.cursor;
assert.ok(archivedCursor > 0, "the thread has a log to keep");
manager.retire(manager.get(logged.id)!);
assert.equal(manager.journal(logged.id)!.cursor, archivedCursor, "retiring keeps the log");
const reader = new MockWs();
assert.equal(await manager.attach(logged.id, reader as never, 0), null, "an archive can be attached to");
const attached = reader.of("attached")[0];
assert.equal(attached.archived, true, "…and says it has no agent behind it");
assert.equal(attached.resumed, false);
assert.equal(
  journaled(reader).length,
  archivedCursor,
  "the whole archive replays with no process running",
);
// Commands still need an agent — reading is the only thing the journal serves.
send(reader, { id: 900, cmd: "prompt", text: "nope" });
await waitFor(() => reader.of("reply").length === 1, "a prompt to an archive is refused");
assert.match(String(reader.of("reply")[0].error?.message), /no running agent/);
// …except paging back through it, which is a read. Pages are cut in **steps**
// (turns): `before` and `from` are always the seq of a `turn_started`, and a
// page is whole turns however many events each one journaled.
const turnStarts = manager
  .journal(logged.id)!
  .events.filter((e) => e.ev === "turn_started")
  .map((e) => (e as { seq: number }).seq);
assert.equal(turnStarts.length, 25);
send(reader, { id: 901, cmd: "load_earlier", before: turnStarts[3] });
await waitFor(() => reader.of("reply").length === 2, "load_earlier is answered from the journal");
const page = reader.of("reply")[1].result as { events: { seq: number }[]; earlier: number };
// The page that reaches the oldest turn takes the head of the log with it —
// whatever precedes the first `turn_started` is not a turn and so can never be
// a page of its own. On a revived thread that head is the entire `session/load`
// replay, i.e. the whole conversation before the revive.
assert.equal(page.events[0].seq, 0, "the oldest page begins at the head of the log");
assert.equal(page.events.length, turnStarts[3], "…and ends where the window began");
assert.equal(page.earlier, 0, "…and nothing is left above it");
send(reader, { id: 902, cmd: "load_earlier", before: 0 });
await waitFor(() => reader.of("reply").length === 3, "the head of the log");
assert.deepEqual(reader.of("reply")[2].result, { events: [], earlier: 0 }, "nothing before the head");

// A ping is about the socket, not the agent, so it is answered where a prompt
// is refused: an archived thread has no process and must still say it is there.
// Silence is what the client's watchdog reads as a dead path, and reconnecting
// an archive means spawning an agent to prove a WebSocket is open.
send(reader, { id: 904, cmd: "ping" });
await waitFor(() => reader.of("reply").length === 4, "a ping is answered with no agent running");
assert.deepEqual(reader.of("reply")[3].result, {}, "…with a bare result and no error");
assert.equal(reader.of("reply")[3].error, undefined);

// --- windowed attach: only the tail, in whole steps, with the rest fetchable ---
const windowed = new MockWs();
assert.equal(await manager.attach(logged.id, windowed as never, 0, true, { window: 5 }), null);
const windowAttach = windowed.of("attached")[0];
assert.equal(windowAttach.from, turnStarts[20], "the replay starts at the 5th-last turn");
assert.equal(windowAttach.earlier, 20, "…and says how many steps it withheld");
assert.equal(windowAttach.resumed, false, "a window is not a resume — the client must reset");
assert.equal(
  windowed.of("replay").flatMap((r) => r.events).length,
  archivedCursor - turnStarts[20],
  "only the tail was sent",
);
// Paging back from the window's edge hands over the 20 steps before it — one
// page's worth — so the head is reached in one ask.
send(windowed, { id: 903, cmd: "load_earlier", before: windowAttach.from });
await waitFor(() => windowed.of("reply").length === 1, "a page before the window");
const tailPage = windowed.of("reply")[0].result as { events: { seq: number }[]; earlier: number };
assert.equal(tailPage.events[0].seq, 0);
assert.equal(tailPage.events.length, turnStarts[20]);
assert.equal(tailPage.earlier, 0);

// --- the same bracket over HTTP ---

/* A thread is opened by reading it (`GET /api/sessions/:id/replay`) and only
   then connecting a socket, so the document that read serves has to be the
   socket's own attach, word for word: same window, same frames, same
   `caught_up`. If the two ever drift the client folds one of them through a
   dispatch written for the other. */
const snapshot = (id: string, cursor = 0, opts: { window?: number } = {}) => {
  const result = manager.snapshot(id, cursor, opts);
  if ("refused" in result) return result;
  return JSON.parse([...result.body].join("")) as {
    attached: Extract<ThreadEvent, { ev: "attached" }>;
    frames: Extract<ThreadEvent, { ev: "replay" }>[];
    caughtUp: Extract<ThreadEvent, { ev: "caught_up" }>;
  };
};
const doc = snapshot(logged.id, 0, { window: 5 });
assert.ok(!("refused" in doc));
assert.deepEqual(doc.attached, windowAttach, "the HTTP bracket is the socket's attach");
assert.deepEqual(
  doc.frames.flatMap((f) => f.events),
  windowed.of("replay").flatMap((r) => r.events),
  "…carrying the same events, in the same order",
);
assert.equal(doc.caughtUp.cursor, doc.attached.to, "…and ending where it said it would");
assert.equal(
  doc.caughtUp.cursor,
  windowed.of("caught_up")[0].cursor,
  "…which is where the socket ended too",
);

// A resume asks for the delta and gets no window — same rule as the socket's,
// which is why the client keeps the window it already folded.
const delta = snapshot(logged.id, doc.attached.to);
assert.ok(!("refused" in delta));
assert.equal(delta.attached.resumed, true, "a cursor is a resume");
assert.equal(delta.attached.from, doc.attached.to);
assert.equal(delta.frames.flatMap((f) => f.events).length, 0, "…of nothing, here");

// Paging back needs no socket either: the archive is where it mostly happens.
assert.deepEqual(
  manager.earlierPage(logged.id, windowAttach.from),
  tailPage,
  "the HTTP page is the socket's page",
);

// The three refusals are the socket's, so the client reads them the same way.
assert.deepEqual(snapshot("no-such-thread"), { refused: "no such thread on this server" });

// --- a log that does not begin with a turn is not windowed away ---

// A revive clears the journal and refills it from the `session/load` replay:
// the prior conversation, with no `turn_started` in it, followed by whatever
// turns are taken after. Cutting at "the first turn of the window" would then
// start the replay *after* everything the load put back — and report
// `earlier: 0`, since there are no whole turns behind it, so nothing would
// offer it back either. A crash and revive lost the conversation on screen
// while every event of it sat in the table. Only cut when a turn is actually
// being withheld.
  // The 25-turn log above is now heavier than the byte budget, so this shape
  // needs a thread of its own: the point is the *shape* (a head followed by
  // turns), not the size. Its first `turn_started` is at seq 1, so it stands in
  // for that: a few turns against a window of 60 withholds nothing, and the
  // replay has to be the whole log — head included — rather than starting at
  // that first turn.
  const small = manager.create(profile, "fake", project);
  await small.bridge!.ready;
  const smallBulk = new MockWs();
  assert.equal(await manager.attach(small.id, smallBulk as never, 0), null, "attach should succeed");
  for (let i = 0; i < 3; i += 1) {
    send(smallBulk, { id: 500 + i, cmd: "prompt", text: `turn ${i}` });
    await waitFor(() => smallBulk.of("turn_ended").length === i + 1, `small turn ${i}`);
  }
  const smallStarts = manager
    .journal(small.id)!
    .events.filter((e) => e.ev === "turn_started")
    .map((e) => (e as { seq: number }).seq);
  assert.ok(smallStarts.length >= 2, "the small log has turns");
  assert.ok(smallStarts[0] > 0, "this log has events before its first turn");
  const whole = new MockWs();
  assert.equal(await manager.attach(small.id, whole as never, 0, true, { window: 60 }), null);
  assert.equal(whole.of("attached")[0].from, 0, "a log inside the window replays from its head");
  assert.equal(whole.of("attached")[0].earlier, 0, "…and withholds nothing");
  assert.equal(
    whole.of("replay").flatMap((r) => r.events).length,
    manager.journal(small.id)!.cursor,
    "…which is every event, including the ones before the first turn",
  );
  // The small thread's rows would trip the cascade assertion at the end of the
  // file, so it is purged here — its only job was the shape check above.
  assert.ok(manager.purge(small.id));

  // --- the window is capped in bytes too, because a step is not a size ---

  // Steps bound the replay in turns, which is the unit the transcript is cut in
  // and not the unit the wait is paid in: a turn is anything from one sentence to
  // a build log streamed through `_meta.terminal_output_delta`, so a handful of
  // them is a screenful on one thread and megabytes on the next. The bytes are
  // what someone actually waits for, and `REPLAY_WINDOW_BYTES` is the second
  // budget — whichever binds first. Six fat turns are appended to a log of 25
  // thin ones so the step budget below (60) cannot be what cuts it; each fat
  // turn is a fifth of the byte budget, so four fit the window and five do not.
  const { SessionJournal } = await import("../src/session-journal.js");
  const { REPLAY_WINDOW_BYTES } = await import("../src/protocol.js");
  const { db: fatDb } = await import("../src/db/index.js");
  const fat = new SessionJournal(fatDb);
  const fatSession = manager.get(logged.id)!;
  const FAT = "x".repeat(REPLAY_WINDOW_BYTES / 5);
for (let i = 0; i < 6; i += 1) {
  fat.append(fatSession, { ev: "turn_started", text: `fat ${i}`, turnId: `fat-${i}` } as never);
  fat.append(fatSession, {
    ev: "update",
    update: { sessionUpdate: "tool_call", toolCallId: `fat-${i}`, title: "big", rawInput: { FAT } },
  } as never);
}
fat.flush();
const fatStarts = manager
  .journal(logged.id)!
  .events.filter((e) => e.ev === "turn_started")
  .map((e) => (e as { seq: number }).seq);
const capped = new MockWs();
assert.equal(await manager.attach(logged.id, capped as never, 0, true, { window: 60 }), null);
const cappedAttach = capped.of("attached")[0];
assert.ok(fatStarts.includes(cappedAttach.from), "the cut is still a turn boundary");
assert.ok(cappedAttach.earlier > 0, "…and says how many turns it withheld");
// The budget is honoured, and honoured *maximally* — one more turn would bust
// it. A cut that merely fits is also what "send nothing" would be.
const sizeFrom = (seq: number) =>
  manager
    .journal(logged.id)!
    .events.filter((e) => (e as { seq: number }).seq >= seq)
    .reduce((n, e) => n + JSON.stringify(e).length, 0);
assert.ok(sizeFrom(cappedAttach.from) <= REPLAY_WINDOW_BYTES, "the replay fits the byte budget");
const oneMore = fatStarts[fatStarts.indexOf(cappedAttach.from) - 1];
assert.ok(oneMore !== undefined && sizeFrom(oneMore) > REPLAY_WINDOW_BYTES, "…and only just");

// `attached` states where the replay ends as well as where it starts: the
// client counts what it unrolls against it, which is the difference between a
// progress bar and an apology. Same number `caught_up` carries, read in the
// same tick so the two cannot disagree.
assert.equal(cappedAttach.to, manager.journal(logged.id)!.cursor, "attached says how far it runs");
assert.equal(capped.of("caught_up")[0].cursor, cappedAttach.to);

// --- the queue outlives the process ---

// A parked queue is a row, not process state: a fresh manager reads it back,
// hands it over on attach, and lets it be edited with no agent to spawn.
const { enqueue, listQueue } = await import("../src/queue.js");
const parked = enqueue(logged.id, "after restart");
const restarted = new SessionManager({}, 1);
const survivor = new MockWs();
assert.equal(await restarted.attach(logged.id, survivor as never, 0), null, "an archive can be attached to");
assert.deepEqual(
  survivor.of("caught_up")[0].queue?.map((i) => i.text),
  ["after restart"],
  "the queue survives a restart and rides on caught_up",
);
send(survivor, { id: 70, cmd: "queue_update", itemId: parked.id, text: "after restart!" });
await waitFor(() => survivor.of("reply").some((r) => r.id === 70), "a parked queue is editable with no process");
assert.equal(listQueue(logged.id)[0].text, "after restart!");
send(survivor, { id: 71, cmd: "queue_remove", itemId: parked.id });
await waitFor(() => survivor.of("queue").at(-1)?.items.length === 0, "…and emptied");
assert.deepEqual(listQueue(logged.id), []);

// Soft delete keeps the row and refuses new attachments; restore undoes it.
assert.ok(manager.softDelete(logged.id));
assert.equal(manager.list().find((s) => s.id === logged.id)?.deletedAt !== null, true);
assert.equal(await manager.attach(logged.id, new MockWs() as never, 0), "this thread is in the trash");
assert.ok(manager.restore(logged.id));
assert.equal(manager.list().find((s) => s.id === logged.id)?.deletedAt, null);
assert.ok(manager.purge(logged.id));
assert.equal(manager.journal(logged.id), undefined, "purge forgets the thread");

// --- a refused session/load must not cost the thread its history ---

// The thread has a conversation the agent knows about...
const orphan = manager.create(profile, "fake", project);
await orphan.bridge!.ready;
const orphanWs = new MockWs();
await manager.attach(orphan.id, orphanWs as never);
send(orphanWs, { id: 1, cmd: "prompt", text: "remember this" });
await waitFor(() => orphanWs.of("turn_ended").length === 1, "the turn that records the session");
assert.equal(orphan.acpSessionId, "acp-123");

// ...and then a revive asks for one the agent cannot find. It comes back on a
// fresh session — the thread stays usable — but the id it failed on is still
// the thread's, because that id is the only pointer to a transcript which is
// very often still in the agent's store. Replacing it is what turned one
// refusal into a thread that could never find its history again.
orphan.acpSessionId = "acp-gone";
await manager.respawn(orphan.id, profile, "fake", project);
assert.equal(orphan.acpSessionId, "acp-gone", "the failed id is kept, not overwritten");
assert.equal(orphan.liveAcpSessionId, "acp-123", "the process runs on the fallback session");
assert.ok(orphan.historyLost, "the refusal is recorded rather than swallowed");
assert.equal(orphan.historyLost!.acpSessionId, "acp-gone");
assert.match(String((orphan.historyLost!.error.data as { details?: string }).details), /no rollout/);

// And the peer is told, so an empty transcript cannot pass for a quiet one.
const orphanWs2 = new MockWs();
await manager.attach(orphan.id, orphanWs2 as never);
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
const unproven = manager.create(profile, "fake", project);
await unproven.bridge!.ready;
assert.equal(unproven.acpSessionProvisional, true);
unproven.acpSessionId = "acp-gone";
await manager.respawn(unproven.id, profile, "fake", project);
assert.equal(unproven.acpSessionId, "acp-123", "an unproven id yields to the fallback");
assert.equal(unproven.acpSessionProvisional, true, "which is itself still unproven");
assert.equal(unproven.historyLost, null, "and nothing was lost to report");
assert.ok(manager.purge(unproven.id));

// --- persistence across a restart ---

const session2 = manager.create(profile, "fake", project);
await session2.bridge!.ready;
/* Stop the first manager's process for this thread before standing the second
   one up. A restart is one manager replacing another, not two of them sharing a
   database — and now that the event log survives a boot, two live managers mean
   two writers appending to one thread's log at seqs neither can see the other
   assigning. The unique index catches it, which is the index doing its job on a
   situation that only this test could create (the real server is one process
   owning the database — see CLAUDE.md). */
manager.retire(manager.get(session2.id)!);
const manager2 = new SessionManager({}, 1);
const restored = manager2.list().find((s) => s.id === session2.id);
assert.ok(restored, "session survives a manager restart");
assert.equal(restored!.exited, true);
// The restart killed it before any turn settled — the window that used to
// throw the id away. The agent may well have flushed the session anyway (they
// do it lazily, not never), so the provisional id survives the restart and the
// revive tries to load it rather than starting a stranger.
assert.equal(restored!.acpSessionId, "acp-123", "an unproven id still survives a restart");
const revived = await manager2.respawn(session2.id, profile, "fake", project);
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

// Library deletions cascade into the profiles that linked them, instead of
// leaving an id behind for a reader to filter out.
const { mcpServers } = await import("../src/library.js");
const { createProfile, getProfile } = await import("../src/profiles.js");
const server1 = mcpServers.create({ type: "stdio", name: "s1", command: "true", args: [], env: [] });
const profileInput = {
  name: "linked",
  agents: { fake: {} },
  baseUrl: "",
  apiKey: "sk-test",
  models: [],
  defaultModel: "",
  smallModel: "",
  logoUrl: "",
  suppressModelMetadataWarning: false,
  mcpServerIds: [server1.id],
  skillIds: [],
  commandIds: [],
};
const linkedProfile = createProfile(profileInput);
assert.deepEqual(getProfile(linkedProfile.id)!.mcpServerIds, [server1.id]);
mcpServers.remove(server1.id);
assert.deepEqual(getProfile(linkedProfile.id)!.mcpServerIds, [], "the link went with the server");
// A stale id in a request links nothing rather than failing the whole write.
const staleProfile = createProfile({ ...profileInput, name: "stale", mcpServerIds: ["gone"] });
assert.deepEqual(getProfile(staleProfile.id)!.mcpServerIds, []);

// The Codex fallback-metadata opt-out is one of the stored columns: a profile
// created with it reads it back, an update can turn it off, and a profile that
// predates it (or omits it) reads as off.
const quietProfile = createProfile({ ...profileInput, name: "quiet", suppressModelMetadataWarning: true });
assert.equal(getProfile(quietProfile.id)!.suppressModelMetadataWarning, true);
const { updateProfile } = await import("../src/profiles.js");
updateProfile(quietProfile.id, { ...profileInput, name: "quiet" });
assert.equal(getProfile(quietProfile.id)!.suppressModelMetadataWarning, false, "absent means off");

// A profile that opted out of Codex's fallback-metadata notice never sees it,
// and one that did not still does: the bridge drops the update before it is
// forwarded or journaled, so the quiet thread's transcript is clean.
const fakeWarnAgent = "fake-warn";
const quietwarn = manager.create(
  { ...profile, id: "p-quietwarn", name: "quiet-warn", agents: { fake: {}, "fake-warn": {} }, suppressModelMetadataWarning: true },
  fakeWarnAgent,
  project,
);
const loudwarn = manager.create(
  { ...profile, id: "p-loudwarn", name: "loud-warn", agents: { fake: {}, "fake-warn": {} }, suppressModelMetadataWarning: false },
  fakeWarnAgent,
  project,
);
const quietWarnWs = new MockWs();
const loudWarnWs = new MockWs();
await manager.attach(quietwarn.id, quietWarnWs as never);
await manager.attach(loudwarn.id, loudWarnWs as never);
send(quietWarnWs, { id: 91, cmd: "prompt", text: "quiet warning turn" });
send(loudWarnWs, { id: 92, cmd: "prompt", text: "loud warning turn" });
await waitFor(() => quietWarnWs.of("turn_ended").length === 1, "the quiet warning turn ends");
await waitFor(() => loudWarnWs.of("turn_ended").length === 1, "the loud warning turn ends");
const mentionsFallback = (ws: MockWs) =>
  ws.of("update").some((e) => JSON.stringify(e.update).includes("Defaulting to fallback metadata"));
assert.equal(mentionsFallback(quietWarnWs), false, "the quiet profile dropped the notice");
assert.equal(mentionsFallback(loudWarnWs), true, "a profile that did not opt out still shows it");

// --- a persona reaches the agent through session/new AND session/load ---
// The two together are the whole reason a persona change is affordable: `_meta`
// is only read when a session is created or loaded, so switching costs a
// respawn — and a respawn ends in `session/load`, which is what carries the new
// instructions onto the *existing* conversation instead of an empty one.
const { personas } = await import("../src/personas.js");
const persona = personas.create({
  name: "Terse",
  description: "",
  prompt: "Answer in one line.",
  thinking: 0,
  effort: null,
  sortOrder: 0,
});

const metaLog = (): { method: string; meta: Record<string, any> | null }[] =>
  existsSync(join(process.env.DAEDALUS_DATA_DIR!, "fake-session-meta.jsonl"))
    ? readFileSync(join(process.env.DAEDALUS_DATA_DIR!, "fake-session-meta.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

// A thread with no persona says nothing about one: `_meta` carries no
// systemPrompt at all, rather than an empty append the agent would still apply.
const beforePlain = metaLog().length;
const plain = manager.create(profile, "fake", project);
await plain.bridge!.ready;
const plainMeta = metaLog().slice(beforePlain).find((e) => e.method === "session/new");
assert.ok(plainMeta, "session/new was recorded");
assert.equal(plainMeta!.meta?.systemPrompt, undefined, "no persona means no systemPrompt");
assert.equal(plainMeta!.meta?.claudeCode?.options?.thinking, undefined, "…and no thinking budget");

// Picked at create time, before any process exists.
const mark = metaLog().length;
const styled = manager.create(
  profile,
  "fake",
  project,
  undefined,
  undefined,
  undefined,
  undefined,
  { mcpServerIds: [], skillIds: [], commandIds: [] },
  { personaId: persona.id },
);
await styled.bridge!.ready;
const newMeta = metaLog().slice(mark).find((e) => e.method === "session/new");
assert.deepEqual(
  newMeta!.meta?.systemPrompt,
  { append: "Answer in one line." },
  "the persona is appended to the agent's own prompt, never a replacement",
);
assert.deepEqual(
  newMeta!.meta?.claudeCode?.options?.thinking,
  { type: "disabled" },
  "a 0 budget is thinking off, not an absent budget",
);

// And again on the respawn that a persona change (or any other) costs: the
// conversation is restored by session/load, and the instructions ride with it.
/* A turn first: `session/load` is only attempted for an id a turn has proven,
   so without one the respawn would fall back to `session/new` and prove
   nothing about the load path. */
const styledWs = new MockWs();
assert.equal(await manager.attach(styled.id, styledWs as never), null);
send(styledWs, { id: 1, cmd: "prompt", text: "hi" });
await waitFor(() => styledWs.of("turn_ended").length === 1, "the styled thread's first turn");
assert.equal(styled.acpSessionProvisional, false, "the turn proved the id");
const beforeLoad = metaLog().length;
await manager.respawn(styled.id, profile, "fake", project);
const loadMeta = metaLog().slice(beforeLoad).find((e) => e.method === "session/load");
assert.ok(loadMeta, "the respawn loaded the conversation rather than starting a new one");
assert.deepEqual(
  loadMeta!.meta?.systemPrompt,
  { append: "Answer in one line." },
  "session/load carries the persona too — this is what makes a switch keep the thread",
);

// Dropping it is a real value, not an omission: the next spawn says nothing
// about a system prompt again.
const dropped = metaLog().length;
await manager.applyConfig(styled.id, { profile, agentId: "fake", project, personaId: "" });
assert.equal(styled.personaId, "", "the row records that the thread has no persona now");
const droppedMeta = metaLog().slice(dropped).find((e) => e.meta);
assert.equal(droppedMeta?.meta?.systemPrompt, undefined, "and the agent is told nothing about one");

/* --- a frozen peer is not a watching peer ---
   The server pushes a "Turn finished" notification only for a thread nobody is
   watching, and an attached socket used to be the whole of that test. It is
   not: a backgrounded PWA holds its socket open with its page frozen, and the
   browser answers the server's WebSocket pings from its network stack, so the
   thread looks watched while nothing on it can draw anything. The `background`
   command is how the page says so on the way into the freeze. */
const pushed: string[] = [];
const notifying = new SessionManager(
  { onTurnEnd: (s) => pushed.push(s.id) },
  1,
);
const frozen = notifying.create(profile, "fake", project);
await frozen.bridge!.ready;
const phone = new MockWs();
assert.equal(await notifying.attach(frozen.id, phone as never), null);

send(phone, { id: 1, cmd: "prompt", text: "watched" });
await waitFor(() => phone.of("turn_ended").length === 1, "the watched turn ends");
assert.deepEqual(pushed, [], "a turn ending in front of someone raises no push");

send(phone, { cmd: "background", background: true });
send(phone, { id: 2, cmd: "prompt", text: "backgrounded" });
await waitFor(() => phone.of("turn_ended").length === 2, "the backgrounded turn ends");
await waitFor(() => pushed.length === 1, "a frozen peer is pushed to");
/* The socket is still a peer in every other sense — the events go out to it as
   they always did (the browser hands them over when the page thaws), which is
   why nothing about the fan-out, the idle sweep or the journal reads this flag.
   `turn_ended` is the one the origin peer gets: `turn_started` fans out to
   everyone *except* whoever asked for it. */
assert.ok(phone.of("update").length > 0, "…and still receives the events");

send(phone, { cmd: "background", background: false });
send(phone, { id: 3, cmd: "prompt", text: "back again" });
await waitFor(() => phone.of("turn_ended").length === 3, "the resumed turn ends");
await new Promise((r) => setTimeout(r, 200));
assert.equal(pushed.length, 1, "resuming stops the push again");
notifying.retire(notifying.get(frozen.id)!);
assert.ok(notifying.purge(frozen.id));

console.log("bridge.test.ts OK");
process.exit(0);
