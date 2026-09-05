// The draft's mode pick survives an idle-retire → revive: with no live
// process to copy from, the respawn restores the recorded mode instead of
// coming back on the agent's default.
// Run: DAEDALUS_DATA_DIR=/tmp/daedalus-test-mode-revive tsx test/mode-revive.test.ts
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson } from "../src/config.js";
import type { Profile } from "../src/profiles.js";
import type { ThreadCommand, ThreadEvent } from "../src/protocol.js";

rmSync(process.env.DAEDALUS_DATA_DIR!, { recursive: true, force: true });
mkdirSync("/tmp/daedalus-test-mode-revive/ws", { recursive: true });
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
  mcpServerIds: [],
  skillIds: [],
  commandIds: [],
};
const project = {
  id: "w1",
  name: "test-ws",
  cwd: "/tmp/daedalus-test-mode-revive/ws",
  description: null,
};

const send = (ws: MockWs, command: ThreadCommand) =>
  ws.emit("message", Buffer.from(JSON.stringify(command)));

const waitFor = async (predicate: () => boolean, what: string) => {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(predicate(), `timed out waiting for ${what}`);
};

const manager = new SessionManager({}, 1);

// A draft pick applies right after session/new and is recorded on the thread.
const session = manager.create(profile, "fake", project, undefined, undefined, undefined, undefined, undefined, {
  modeId: "acceptEdits",
});
await session.bridge!.ready;
assert.equal(session.bridge!.modes?.currentModeId, "acceptEdits", "the draft pick was applied");
assert.equal(session.modeId, "acceptEdits", "…and recorded on the thread");

// Idle-retire: the process goes, the thread stays.
manager.retire(manager.get(session.id)!);
assert.equal(session.bridge, null, "no live process left");

// Revive through the ordinary respawn path — no live bridge to copy from.
await manager.respawn(session.id, profile, "fake", project);
assert.equal(session.exited, false, "the thread is live again");
assert.equal(
  session.bridge!.modes?.currentModeId,
  "acceptEdits",
  "the revive restored the recorded mode, not the agent default",
);

// A live mode change is re-recorded, so the *next* bridgeless revive keeps it too.
const ws = new MockWs();
assert.equal(await manager.attach(session.id, ws as never, session.eventCount), null);
send(ws, { id: 1, cmd: "set_mode", modeId: "default" });
await waitFor(() => ws.of("reply").some((r) => r.id === 1), "mode change accepted");
assert.equal(session.modeId, "default", "the live change reached the spawn record");

manager.retire(manager.get(session.id)!);
await manager.respawn(session.id, profile, "fake", project);
assert.equal(session.bridge!.modes?.currentModeId, "default", "the updated mode survives a second revive");

console.log("mode-revive.test.ts passed");
