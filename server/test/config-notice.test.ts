// A mode/model/effort change that lands mid-turn draws a journaled
// `config_notice` row in the thread — held for the step boundary like a
// steer (visible meanwhile as a held `steer` queue row), flushed at the
// latest when the turn settles, so it is logged after the turn as well as
// drawn during it. An idle change stays a silent `session_config`.
// Run: pnpm test:config-notice (DAEDALUS_DATA_DIR is set by the npm script —
// static imports are hoisted, so setting it here would be too late).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson } from "../src/config.js";
import type { Profile } from "../src/profiles.js";
import type { ThreadCommand, ThreadEvent } from "../src/protocol.js";

rmSync(process.env.DAEDALUS_DATA_DIR!, { recursive: true, force: true });
mkdirSync("/tmp/daedalus-test-config-notice/ws", { recursive: true });
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

{
  const { eq } = await import("drizzle-orm");
  const { db, agents: agentsTable } = await import("../src/db/index.js");
  db.update(agentsTable).set({ personaVia: "acp-meta" }).where(eq(agentsTable.id, "fake")).run();
}

class MockWs extends EventEmitter {
  sent: string[] = [];
  closes: [number | undefined, string | undefined][] = [];
  readyState = 1;
  send(line: string, cb?: (error?: Error) => void) {
    this.sent.push(line);
    cb?.();
  }
  close(code?: number, reason?: string) {
    this.closes.push([code, reason]);
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
  mcpServerIds: [],
  skillIds: [],
  commandIds: [],
};
const project = {
  id: "w1",
  name: "test-ws",
  cwd: "/tmp/daedalus-test-config-notice/ws",
  description: null,
};

const send = (ws: MockWs, command: ThreadCommand) =>
  ws.emit("message", Buffer.from(JSON.stringify(command)));

const waitFor = async (predicate: () => boolean, what: string) => {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(predicate(), `timed out waiting for ${what}`);
};

const manager = new SessionManager({}, 1);
const session = manager.create(profile, "fake", project);
await session.bridge!.ready;

const a = new MockWs();
const b = new MockWs();
assert.equal(await manager.attach(session.id, a as never), null);
assert.equal(await manager.attach(session.id, b as never), null);
assert.equal(a.of("config_notice").length, 0, "handshake journals no notice");

// Park a turn on a permission request so the changes below land mid-turn.
send(a, { id: 1, cmd: "prompt", text: "needs permission" });
await waitFor(() => b.of("permission").length === 1, "permission fans out");
assert.equal(session.bridge!.promptActive, true, "the turn is still running");

// One held row per accepted change, in arrival order, visible to every peer
// including the one that asked — like a steer's bubble waiting on its step.
send(b, { id: 10, cmd: "set_mode", modeId: "acceptEdits" });
send(b, { id: 11, cmd: "set_config_option", configId: "model", value: "smart" });
send(b, { id: 12, cmd: "set_config_option", configId: "effort", value: "high" });
await waitFor(() => b.of("reply").filter((r) => r.id >= 10).length === 3, "all three changes accepted");

const expected = [
  "Mode: Always ask → Accept edits",
  "Model: Fast → Smart",
  "Effort: Medium effort → High effort",
];
for (const peer of [a, b]) {
  const held = peer.of("queue").at(-1)!.items.filter((i) => i.steer);
  assert.deepEqual(
    held.map((i) => i.text),
    expected,
    "both peers see one held row per mid-turn change",
  );
  assert.equal(peer.of("config_notice").length, 0, "nothing lands before the step lets go");
}
assert.ok(b.of("session_config").length >= 2, "the absolute state still rides alongside");

// Repeating the same value is not a change: no second row.
send(b, { id: 13, cmd: "set_config_option", configId: "model", value: "smart" });
await waitFor(() => b.of("reply").some((r) => r.id === 13), "repeat accepted");
assert.equal(
  b.of("queue").at(-1)!.items.filter((i) => i.steer).length,
  3,
  "an unchanged value holds nothing",
);

// Settling the turn flushes the held rows into the journal, ahead of the
// turn's own end — logged after the turn as well as drawn during it.
const requestId = b.of("permission")[0].requestId;
send(a, {
  cmd: "answer_permission",
  requestId,
  response: { outcome: { outcome: "selected", optionId: "allow" } },
});
await waitFor(() => b.of("turn_ended").length === 1, "turn end");
for (const peer of [a, b]) {
  assert.deepEqual(
    peer.of("config_notice").map((e) => e.text),
    expected,
    "both peers get one ordered line per mid-turn change",
  );
}
{
  const order = b.events.map((e) => e.ev);
  const turnStart = order.indexOf("turn_started");
  const turnEnd = order.indexOf("turn_ended");
  const notices = order
    .map((ev, i) => ({ ev, i }))
    .filter(({ ev }) => ev === "config_notice")
    .map(({ i }) => i);
  assert.equal(notices.length, 3);
  assert.ok(
    notices.every((i) => i > turnStart && i < turnEnd),
    "the flushed lines sit inside the turn they landed in",
  );
}

// The same settings changed while idle: silent.
send(b, { id: 14, cmd: "set_config_option", configId: "model", value: "fast" });
send(b, { id: 15, cmd: "set_config_option", configId: "verbose", value: true });
await waitFor(() => b.of("reply").filter((r) => r.id >= 14).length === 2, "idle changes accepted");
assert.equal(b.of("config_notice").length, 3, "idle changes draw no line");

// A late joiner replays the three lines inline, between the turn's brackets.
const c = new MockWs();
assert.equal(await manager.attach(session.id, c as never, 0), null);
const order = c.events.map((e) => e.ev);
const turnStart = order.indexOf("turn_started");
const turnEnd = order.indexOf("turn_ended");
const notices = order
  .map((ev, i) => ({ ev, i }))
  .filter(({ ev }) => ev === "config_notice")
  .map(({ i }) => i);
assert.equal(notices.length, 3, "the journal kept all three mid-turn lines");
assert.ok(
  notices.every((i) => i > turnStart && i < turnEnd),
  "the lines replay inside the turn they landed in",
);
assert.deepEqual(
  c.of("config_notice").map((e) => e.text),
  expected,
);
assert.deepEqual(
  manager.journal(session.id)!.events.filter((e) => e.ev === "config_notice"),
  c.of("config_notice"),
  "the replay is the log",
);

a.close();
b.close();
c.close();
console.log("config-notice: all assertions passed");
