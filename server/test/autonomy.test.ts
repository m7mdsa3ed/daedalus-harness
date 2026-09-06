// Self-check for autonomy at the bridge's one choke point (src/autonomy.ts +
// AcpBridge.park) against the fake agent:
//   - `allow` selects the agent's own allow_once option, never allow_always
//   - `deny` selects its reject option
//   - the per-kind map splits read from execute; an absent kind falls to default
//   - a stance the agent offered no option for falls through to a REAL park
//   - an auto-answer is still emitted: the `permission` event and its
//     `request_answered` both go out, the latter marked `auto`
//   - an unanswered `ask` falls through to askFallback and marks the session
//     blocked; a human who gets there first still wins
//   - an elicitation is declined, and the turn carries on
//   - `maxRunSeconds` cancels through the ordinary cancel path and records why
//   - a session with no policy behaves exactly as it did before
// Run: pnpm test:autonomy
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson } from "../src/config.js";
import type { Profile } from "../src/profiles.js";
import type { ThreadEvent } from "../src/protocol.js";
import type { AutonomyPolicy } from "../src/autonomy.js";

rmSync(process.env.DAEDALUS_DATA_DIR!, { recursive: true, force: true });
writeJson(join(process.env.DAEDALUS_DATA_DIR!, "agents.json"), [
  {
    id: "fake",
    name: "Fake",
    command: "node",
    args: [join(dirname(fileURLToPath(import.meta.url)), "fake-agent.mjs")],
    env: {},
  },
]);

const { SessionManager } = await import("../src/sessions.js");
const { ASK_EVERYTHING, optionFor, stanceFor } = await import("../src/autonomy.js");
const { db, schema } = await import("../src/db/index.js");

class MockWs extends EventEmitter {
  sent: string[] = [];
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
  close() {
    this.emit("close");
  }
  get events(): ThreadEvent[] {
    return this.sent.flatMap((l) => {
      const e = JSON.parse(l) as ThreadEvent;
      return e.ev === "replay" ? e.events : [e];
    });
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
  apiKey: "",
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
  cwd: "/tmp/daedalus-test-autonomy/ws",
  description: null,
};
db.insert(schema.profiles)
  .values({ id: "p1", name: "test", agents: { fake: {} }, baseUrl: "", apiKey: "", models: [], defaultModel: "", smallModel: "", logoUrl: "" } as never)
  .onConflictDoNothing()
  .run();
db.insert(schema.projects)
  .values({ id: "w1", name: "test-ws", cwd: project.cwd, description: null, logoUrl: "" } as never)
  .onConflictDoNothing()
  .run();

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? error.stack : String(error)}`);
  }
}
const waitFor = async (predicate: () => boolean, what: string, ms = 10_000) => {
  for (let i = 0; i < ms / 50 && !predicate(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(predicate(), `timed out waiting for ${what}`);
};
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

const manager = new SessionManager({}, 60);
const opened: string[] = [];

/** A fresh thread on `policy`, with a peer watching it. One per case: the
    assertions are about counters and pending questions, and sharing a thread
    would make every one of them depend on the case before it. */
async function thread(autonomy?: AutonomyPolicy) {
  const session = manager.create(profile, "fake", project, undefined, undefined, undefined, undefined, undefined, autonomy ? { autonomy } : {});
  await session.bridge!.ready;
  const ws = new MockWs();
  assert.equal(await manager.attach(session.id, ws as never), null);
  opened.push(session.id);
  return { session, ws };
}
/** What the agent said it was answered with — the only place the *selected
    option* is visible from the agent's side, which is the half a client-side
    assertion cannot see. */
const answerOf = (ws: MockWs) =>
  ws
    .of("update")
    .map((e) => e.update as { sessionUpdate: string; content?: { text?: string } })
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => u.content?.text ?? "")
    .find((t) => t.startsWith("answered: ")) ?? "";

/** Everything but the stance, so a case says only what it is about. */
const policy = (over: Partial<AutonomyPolicy>): AutonomyPolicy => ({
  ...ASK_EVERYTHING,
  askTimeoutSeconds: 0, // no timer unless a case asks for one
  maxRunSeconds: 0,
  ...over,
});

console.log("autonomy");

await test("the pure selectors read ACP's own fields and nothing else", () => {
  const p = policy({ permissions: { default: "ask", read: "allow", execute: "deny" } });
  assert.equal(stanceFor(p, "read"), "allow");
  assert.equal(stanceFor(p, "execute"), "deny");
  // An absent or unnamed kind is the protocol saying nothing: fall to default.
  assert.equal(stanceFor(p, null), "ask");
  assert.equal(stanceFor(p, undefined), "ask");
  assert.equal(stanceFor(p, "edit"), "ask");
  const options = [
    { optionId: "a2", name: "Always", kind: "allow_always" as const },
    { optionId: "a1", name: "Once", kind: "allow_once" as const },
    { optionId: "r1", name: "No", kind: "reject_once" as const },
  ];
  // allow_once wins: an automated grant must not write a standing rule into
  // the agent's own config, where it would outlive the run that made it.
  assert.equal(optionFor(options, "allow")?.optionId, "a1");
  assert.equal(optionFor(options, "deny")?.optionId, "r1");
  assert.equal(optionFor([{ optionId: "r1", name: "No", kind: "reject_once" }], "allow"), null);
  assert.equal(optionFor(undefined, "allow"), null);
});

await test("`allow` answers with the agent's own allow_once option, visibly", async () => {
  const { session, ws } = await thread(policy({ permissions: { default: "allow" } }));
  await manager.prompt(session.id, "perm:execute");
  await waitFor(() => ws.of("turn_ended").length === 1, "the turn finishes unattended");
  // Nothing is silent: the question was announced, then answered.
  assert.equal(ws.of("permission").length, 1, "the peer saw the question");
  const answered = ws.of("request_answered");
  assert.equal(answered.length, 1);
  assert.deepEqual(answered[0].auto, { answer: "allow", timedOut: false });
  assert.equal(answered[0].toolCallId, ws.of("permission")[0].request.toolCall.toolCallId);
  assert.ok(
    ws.events.findIndex((e) => e.ev === "permission") <
      ws.events.findIndex((e) => e.ev === "request_answered"),
    "the card appears before it resolves itself",
  );
  assert.match(answerOf(ws), /"optionId":"allow"/, "allow_once, not allow_always");
  assert.equal(session.bridge!.pending.size, 0);
  assert.equal(session.autonomyBlocked, 0, "an answered stance is not a blocked run");
});

await test("`deny` answers with the agent's own reject option", async () => {
  const { session, ws } = await thread(policy({ permissions: { default: "deny" } }));
  await manager.prompt(session.id, "perm:execute");
  await waitFor(() => ws.of("turn_ended").length === 1, "the turn finishes");
  assert.deepEqual(ws.of("request_answered")[0].auto, { answer: "deny", timedOut: false });
  assert.match(answerOf(ws), /"optionId":"reject"/);
});

await test("the per-kind map splits read from execute", async () => {
  const { session, ws } = await thread(
    policy({ permissions: { default: "ask", read: "allow" } }),
  );
  await manager.prompt(session.id, "perm:read");
  await waitFor(() => ws.of("turn_ended").length === 1, "the read is granted");
  assert.deepEqual(ws.of("request_answered")[0].auto, { answer: "allow", timedOut: false });

  await manager.prompt(session.id, "perm:execute");
  await waitFor(() => ws.of("permission").length === 2, "the execute is asked");
  await settle(200);
  assert.equal(session.bridge!.pending.size, 1, "the execute really parked");
  assert.equal(ws.of("request_answered").length, 1, "and nothing answered it");
  // A human still wins through the ordinary path, and the turn then finishes.
  const requestId = ws.of("permission")[1].requestId;
  assert.ok(session.bridge!.answer(requestId, { outcome: { outcome: "cancelled" } }));
  await waitFor(() => ws.of("turn_ended").length === 2, "the human's answer ends the turn");
  assert.equal(ws.of("request_answered")[1].auto, undefined, "a human answer is not marked auto");
});

await test("a tool call with no kind falls to `default`", async () => {
  const { session, ws } = await thread(
    policy({ permissions: { default: "deny", execute: "allow" } }),
  );
  await manager.prompt(session.id, "perm:none");
  await waitFor(() => ws.of("turn_ended").length === 1, "the turn finishes");
  assert.deepEqual(ws.of("request_answered")[0].auto, { answer: "deny", timedOut: false });
});

await test("a stance the agent offered no option for falls through to a real park", async () => {
  const { session, ws } = await thread(policy({ permissions: { default: "allow" } }));
  await manager.prompt(session.id, "perm-noallow");
  await waitFor(() => ws.of("permission").length === 1, "the question");
  await settle(250);
  // Nothing was invented: the agent advertised only a reject, so `allow` had
  // no optionId it could honestly send.
  assert.equal(session.bridge!.pending.size, 1, "still parked");
  assert.equal(ws.of("request_answered").length, 0);
  assert.equal(ws.of("turn_ended").length, 0);
});

await test("an unanswered `ask` falls through to askFallback and marks the run blocked", async () => {
  const { session, ws } = await thread(
    policy({ permissions: { default: "ask" }, askTimeoutSeconds: 0.3, askFallback: "deny" }),
  );
  await manager.prompt(session.id, "perm:execute");
  await waitFor(() => ws.of("turn_ended").length === 1, "the fallback answers it");
  assert.deepEqual(ws.of("request_answered")[0].auto, { answer: "deny", timedOut: true });
  assert.match(answerOf(ws), /"optionId":"reject"/, "deny still speaks the agent's vocabulary");
  // `blocked`, not `failed`: the run is the state a person can act on.
  assert.equal(session.autonomyBlocked, 1);
});

await test("a human who beats the ask timeout wins, and the timer is dropped", async () => {
  const { session, ws } = await thread(
    policy({ permissions: { default: "ask" }, askTimeoutSeconds: 0.4, askFallback: "deny" }),
  );
  await manager.prompt(session.id, "perm:execute");
  await waitFor(() => ws.of("permission").length === 1, "the question");
  const allow = { outcome: { outcome: "selected", optionId: "allow-all" } };
  assert.ok(session.bridge!.answer(ws.of("permission")[0].requestId, allow));
  await waitFor(() => ws.of("turn_ended").length === 1, "the human's answer ends the turn");
  await settle(400); // past when the fallback would have fired
  assert.equal(ws.of("request_answered").length, 1, "the timer answered nothing after it");
  assert.equal(session.autonomyBlocked, 0);
  assert.match(answerOf(ws), /"optionId":"allow-all"/, "the human's choice, not the policy's");
});

await test("an elicitation is declined, and the turn carries on", async () => {
  const { session, ws } = await thread(policy({ elicitations: "decline" }));
  await manager.prompt(session.id, "elicit:which way?");
  await waitFor(() => ws.of("turn_ended").length === 1, "the turn finishes");
  assert.equal(ws.of("elicitation").length, 1, "the peer saw the question");
  assert.deepEqual(ws.of("request_answered")[0].auto, { answer: "decline", timedOut: false });
  // `decline`, not `cancel`: the bridges read it as "the user skipped" and the
  // tool call survives, which is the whole difference for an unattended run.
  assert.match(answerOf(ws), /"action":"decline"/);
});

await test("an elicitation under `ask` parks, then takes the cancel fallback", async () => {
  const { session, ws } = await thread(
    policy({ elicitations: "ask", askTimeoutSeconds: 0.3, askFallback: "cancel" }),
  );
  await manager.prompt(session.id, "elicit:which way?");
  await waitFor(() => ws.of("turn_ended").length === 1, "the fallback answers it");
  assert.deepEqual(ws.of("request_answered")[0].auto, { answer: "cancel", timedOut: true });
  assert.match(answerOf(ws), /"action":"cancel"/);
  assert.equal(session.autonomyBlocked, 1);
});

await test("`maxRunSeconds` cancels the run and says it was the deadline", async () => {
  const { session, ws } = await thread(
    policy({ permissions: { default: "ask" }, maxRunSeconds: 0.4 }),
  );
  await manager.prompt(session.id, "perm:execute");
  await waitFor(() => ws.of("permission").length === 1, "the question parks");
  assert.equal(session.cancelReason, null, "not yet");
  await waitFor(() => ws.of("turn_ended").length === 1, "the deadline ends the turn");
  // A Stop and a deadline are the same `stopReason: "cancelled"` on the wire;
  // this is the only thing that tells a caller which it was.
  assert.equal(session.cancelReason, "deadline");
  assert.equal(session.bridge!.pending.size, 0, "cancel() settled the open question");
  assert.equal(session.bridge!.promptActive, false);
  assert.equal(session.deadline, null, "the timer does not survive its own firing");
});

await test("a policy can be lowered under a running process", async () => {
  const { session, ws } = await thread(policy({ permissions: { default: "allow" } }));
  await manager.prompt(session.id, "perm:execute");
  await waitFor(() => ws.of("turn_ended").length === 1, "granted while the policy said allow");
  // The bridge reads the policy through its host on every request, which is
  // what makes this take effect on the very next question rather than at the
  // next respawn — for a run in flight, never.
  manager.setAutonomy(session.id, policy({ permissions: { default: "ask" } }));
  await manager.prompt(session.id, "perm:execute");
  await waitFor(() => ws.of("permission").length === 2, "the second question");
  await settle(200);
  assert.equal(session.bridge!.pending.size, 1, "now it parks");
  assert.equal(ws.of("request_answered").length, 1);
  manager.setAutonomy(session.id, null);
  await session.bridge!.cancel();
});

await test("a thread with no policy is unchanged: it parks and waits", async () => {
  const { session, ws } = await thread();
  assert.equal(session.autonomy, null);
  assert.equal(session.deadline, null, "no policy, no deadline");
  await manager.prompt(session.id, "perm:execute");
  await waitFor(() => ws.of("permission").length === 1, "the question");
  await settle(300);
  assert.equal(session.bridge!.pending.size, 1, "nobody answered it for the user");
  assert.equal(ws.of("request_answered").length, 0);
  assert.equal(session.autonomyBlocked, 0);
});

await test("autonomy never revives with a thread", async () => {
  const { session } = await thread(policy({ permissions: { default: "allow" }, maxRunSeconds: 600 }));
  manager.retire(session);
  assert.equal(session.deadline, null, "retire disarms the deadline");
  manager.reload();
  // A run a person opens by hand tomorrow is a thread with a human in front of
  // it, and must not come back holding last night's standing grant.
  assert.equal(manager.get(session.id)?.autonomy, null);
});

for (const id of opened) manager.get(id) && manager.retire(manager.get(id)!);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
