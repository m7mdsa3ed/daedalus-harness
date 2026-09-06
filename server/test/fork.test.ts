// Self-check for thread fork: the branch is a NEW thread on the runtime's own
// fork of the conversation (cut at the target turn's own last message — turns
// 1..N inclusive, the mirror of rewind's cut), spawned straight onto a
// `session/load` of the fork id, while the parent keeps its process, its
// journal and its proven session id untouched. The refusals — no fork-point
// door on the agent, unknown turn — read as what they are, and a retired
// parent is revived rather than refused. Against the fake agent under
// DATA_DIR.
// Run: pnpm test:fork
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Profile } from "../src/profiles.js";
import type { ThreadCommand, ThreadEvent } from "../src/protocol.js";

rmSync(process.env.DAEDALUS_DATA_DIR!, { recursive: true, force: true });
const { writeJson } = await import("../src/config.js");
writeJson(join(process.env.DAEDALUS_DATA_DIR!, "agents.json"), [
  {
    id: "fake",
    name: "Fake",
    command: process.execPath,
    args: [join(import.meta.dirname, "fake-agent.mjs")],
    env: { FAKE_KEY: "{apiKey}", FAKE_EMPTY: "{baseUrl}" },
  },
]);

const { SessionManager } = await import("../src/sessions.js");
const { createProject, deleteProject } = await import("../src/projects.js");

/* The door is the user's to claim, exactly as `rewind.test.ts` sets it: first
   assert the refusal without it, then set it the way Settings › Agents would. */
const setRewindVia = async (value: "acp-fork-point" | null) => {
  const { eq } = await import("drizzle-orm");
  const { db, agents: agentsTable } = await import("../src/db/index.js");
  db.update(agentsTable).set({ rewindVia: value }).where(eq(agentsTable.id, "fake")).run();
};

class MockWs extends EventEmitter {
  sent: string[] = [];
  readyState = 1;
  send(line: string, cb?: (error?: Error) => void) {
    this.sent.push(line);
    cb?.();
  }
  close() {}
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

const send = (ws: MockWs, command: ThreadCommand) =>
  ws.emit("message", Buffer.from(JSON.stringify(command)));

const waitFor = async (predicate: () => boolean, what: string) => {
  for (let i = 0; i < 100 && !predicate(); i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.ok(predicate(), `timed out waiting for ${what}`);
};

const manager = new SessionManager({}, 1);
const project = createProject({ name: "test-fork", cwd: "/tmp/daedalus-test-fork/ws", description: null, logoUrl: "" });

// --- a parent with two settled turns ---

const parent = manager.create(profile, "fake", project);
await parent.bridge!.ready;
const ws = new MockWs();
await manager.attach(parent.id, ws as never);
/* The passive second peer, because `turn_started` is not echoed to the peer
   whose words started the turn — the boundaries this test forks at are only
   visible from the side. */
const side = new MockWs();
await manager.attach(parent.id, side as never);

send(ws, { id: 1, cmd: "prompt", text: "first turn" });
await waitFor(() => ws.of("turn_ended").length === 1, "first turn end");
send(ws, { id: 2, cmd: "prompt", text: "second turn" });
await waitFor(() => ws.of("turn_ended").length === 2, "second turn end");
assert.equal(parent.acpSessionId, "acp-123", "both turns ran on the agent's session");

const turn1 = side.of("turn_started")[0]!;
const turn2 = side.of("turn_started")[1]!;
assert.ok(turn1 && turn2, "both turns were announced to the other peer");

// --- refusals, before anything is spawned ---

await assert.rejects(
  manager.fork(parent.id, turn2.turnId),
  /cannot fork its conversation/,
  "no rewindVia, no fork",
);
await setRewindVia("acp-fork-point");
await assert.rejects(
  manager.fork(parent.id, "no-such-turn"),
  /unknown turn/,
  "an unknown turn is a 404-shaped refusal",
);

// --- the fork: a new thread on the runtime's own cut ---

const parentBridge = parent.bridge;
const parentCursor = parent.eventCount;
const child = await manager.fork(parent.id, turn2.turnId);
assert.notEqual(child.id, parent.id, "the branch is its own thread");
/* Turn 2's own last message (`msg-2`) is the cut — turns 1..2 inclusive, where
   a rewind OF turn 2 would have cut at `msg-1`. The fake agent names the fork
   after the point it was given. */
assert.equal(child.acpSessionId, "acp-123-fork-msg-2", "the branch runs on the fork");
assert.equal(child.acpSessionProvisional, false, "the load that filled it proved the id");
assert.equal(child.historyLost, null, "…and the fork was loadable");
assert.equal(child.forkedFromSessionId, parent.id, "provenance: the parent");
assert.equal(child.forkedFromTurnId, turn2.turnId, "provenance: the turn carried through");
assert.equal(child.profileId, parent.profileId, "inherits the profile");
assert.equal(child.agentId, parent.agentId, "…the agent");
assert.equal(child.projectId, parent.projectId, "…the project");
assert.equal(child.model, parent.model, "…the model");
assert.equal(child.personaId, parent.personaId, "…the persona");
assert.equal(child.suggestFollowups, parent.suggestFollowups, "…the suggestions toggle");
assert.equal(child.parentSessionId, null, "a branch is not a workflow step");
assert.ok(child.title.endsWith("(branch)"), "a name the title sniff will leave alone");

// The parent was never the thing being changed.
assert.equal(parent.acpSessionId, "acp-123", "the parent keeps its conversation");
assert.equal(parent.acpSessionProvisional, false, "…still proven");
assert.equal(parent.bridge, parentBridge, "…and its process — no respawn");
assert.equal(parent.eventCount, parentCursor, "…and its journal — nothing was cleared");
const reader = new MockWs();
await manager.attach(parent.id, reader as never);
await waitFor(() => reader.of("caught_up").length === 1, "the parent's replay");
assert.equal(reader.of("turn_started").length, 2, "both turns are still where they were");

// The branch's own transcript: the loaded fork, plus the one notice that says
// where it came from.
const cws = new MockWs();
await manager.attach(child.id, cws as never);
await waitFor(() => cws.of("caught_up").length === 1, "the branch's replay");
assert.ok(
  cws.of("update").some((e) => (e.update as { content?: { text?: string } }).content?.text === "(forked conversation)"),
  "the journal holds the forked conversation",
);
assert.ok(
  cws.of("config_notice").some((e) => e.text.includes("Forked from")),
  "the branch says where it came from",
);

// The branch takes a turn of its own without borrowing the parent's identity.
send(cws, { id: 1, cmd: "prompt", text: "a turn on the branch" });
await waitFor(() => cws.of("turn_ended").length === 1, "the branch's turn end");
assert.equal(child.acpSessionId, "acp-123-fork-msg-2", "the turn settled on the fork, not a new session");

// --- a client-minted id and a typed name both survive ---

const minted = randomUUID();
const named = await manager.fork(parent.id, turn1.turnId, { id: minted, title: "My branch" });
assert.equal(named.id, minted, "the client's id is the thread's id");
assert.equal(named.title, "My branch", "a typed name is not suffixed");
assert.equal(named.acpSessionId, "acp-123-fork-msg-1", "an earlier turn is an earlier cut");

// --- a retired parent is revived, not refused ---

manager.retireAll([parent.id]);
assert.equal(parent.bridge, null, "the parent's process is gone");
const fromRetired = await manager.fork(parent.id, turn1.turnId);
assert.equal(fromRetired.acpSessionId, "acp-123-fork-msg-1", "the fork point was read before the revive cleared the journal");
assert.equal(parent.acpSessionId, "acp-123", "the revived parent came back on its own conversation");

console.log("fork: passed");

deleteProject(project.id);
process.exit(0);
