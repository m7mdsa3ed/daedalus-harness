// A setting change that costs the process keeps the thread's journal: the
// `session/load` that hands the conversation back is dropped where it is
// produced (`Session.quietLoad`, read in `SessionManager.emit`) instead of
// being paid for by clearing the log every peer is attached to. The clear cost
// a rebuild on every device — and took the journaled `turn_started`/
// `turn_ended` rows with it, which `rewindPoint`, the turn rail and every
// window are read from and which the load never restates.
// Run: pnpm test:restart-journal (DAEDALUS_DATA_DIR is set by the npm script —
// static imports are hoisted, so setting it here would be too late).
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson } from "../src/config.js";
import type { Profile } from "../src/profiles.js";
import type { ThreadCommand, ThreadEvent } from "../src/protocol.js";

rmSync(process.env.DAEDALUS_DATA_DIR!, { recursive: true, force: true });
mkdirSync("/tmp/daedalus-test-restart-journal/ws", { recursive: true });
writeJson(join(process.env.DAEDALUS_DATA_DIR!, "agents.json"), [
  {
    id: "fake",
    name: "Fake",
    command: "node",
    args: [join(dirname(fileURLToPath(import.meta.url)), "fake-agent.mjs")],
    env: { FAKE_KEY: "{apiKey}" },
  },
]);

const { SessionManager } = await import("../src/sessions.js");

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
};
const project = {
  id: "w1",
  name: "test-ws",
  cwd: "/tmp/daedalus-test-restart-journal/ws",
  description: null,
};

const send = (ws: MockWs, command: ThreadCommand) =>
  ws.emit("message", Buffer.from(JSON.stringify(command)));

const waitFor = async (predicate: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 100 && !(await predicate()); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(await predicate(), `timed out waiting for ${what}`);
};

const manager = new SessionManager({}, 1);
const session = await manager.create(profile, "fake", project);
await session.bridge!.ready;

const peer = new MockWs();
assert.equal(await manager.attach(session.id, peer as never), null);

// One real turn, so the log holds a turn's brackets — the rows the clear used
// to take and the load never puts back.
send(peer, { id: 1, cmd: "prompt", text: "hello" });
await waitFor(() => peer.of("turn_ended").length === 1, "the first turn to end");

const before = {
  count: session.eventCount,
  events: (await manager.journal(session.id))!.events,
};
const turnsOf = (events: ThreadEvent[]) =>
  events.filter((e) => e.ev === "turn_started" || e.ev === "turn_ended").length;
assert.equal(turnsOf(before.events), 2, "the turn's brackets are journaled");
const sentBefore = peer.sent.length;

// A suggestions flip: no runtime takes one on a running process, so this is the
// respawn path — spawn, `session/load`, restore — with a live process and a log
// that is holding the conversation. The narration the fake agent replays on a
// load ("hello fake agent") is what must not arrive twice.
// `defer: false` is what asks for the restart itself: a process-costing change
// is otherwise staged and taken by the next spawn (see staged-config.test.ts).
// This test is about what that restart does to the journal.
const result = await manager.applyConfig(
  session.id,
  { profile, agentId: "fake", project, suggestKinds: session.suggestKinds.length ? [] : ["prompts"] },
  { defer: false },
);
assert.equal(result.live, false, "a suggestions flip cannot be applied live");

const restarts = peer.of("restart");
assert.deepEqual(
  restarts.map((e) => [e.state, e.kept]),
  [
    ["started", true],
    ["ready", true],
  ],
  "both ends of the restart say the journal was kept",
);

const after = (await manager.journal(session.id))!.events;
assert.ok(session.eventCount >= before.count, "the seq counter never went back to 0");
assert.equal(turnsOf(after), 2, "the turn's brackets survived the respawn");
assert.deepEqual(
  before.events.map((e) => e.ev),
  after.slice(0, before.events.length).map((e) => e.ev),
  "the journal was extended, never replaced",
);

// Nothing from the load reached the log or the socket — the guard in `emit` is
// the one chokepoint both pass through.
assert.equal(
  after.filter((e) => e.ev === "update" && e.historyReplay).length,
  0,
  "the load's narration was never journaled",
);
const since = peer.sent.slice(sentBefore).map((l) => JSON.parse(l) as ThreadEvent);
assert.equal(
  since.filter((e) => e.ev === "update" && e.historyReplay).length,
  0,
  "…and never fanned out to the socket that stayed attached",
);
assert.ok(
  since.some((e) => e.ev === "spawn_config"),
  "the new process's own state still reached that socket",
);

// The other half of the bargain: a thread with no log to keep still gets the
// clear, so `kept` is never a claim about a journal that is not there. The
// counter IS the log's head as far as every reader of it is concerned — see
// `Session.eventCount` — so zeroing it is the condition, not a stand-in for it.
const fresh = await manager.create(profile, "fake", project);
await fresh.bridge!.ready;
fresh.eventCount = 0;
const quiet = new MockWs();
assert.equal(await manager.attach(fresh.id, quiet as never), null);
await manager.applyConfig(
  fresh.id,
  { profile, agentId: "fake", project, suggestKinds: fresh.suggestKinds.length ? [] : ["prompts"] },
  { defer: false },
);
assert.deepEqual(
  quiet.of("restart").map((e) => [e.state, e.kept]),
  [
    ["started", false],
    ["ready", false],
  ],
  "an empty log is reloaded the old way",
);

peer.close();
quiet.close();
console.log("restart-journal: all assertions passed");
