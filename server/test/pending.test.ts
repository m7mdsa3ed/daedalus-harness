// The cross-thread inbox: `GET /api/pending` lists what live agents are
// blocked on, straight off `bridge.pending`, and the answer route is the same
// first-answer-wins door a socket's `answer_permission` takes — so a peer
// watching the thread is told `request_answered`, and a second answer loses.
//
// Run: pnpm test:pending (DAEDALUS_DATA_DIR is set by the npm script).
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { writeJson } from "../src/config.js";
import type { Profile } from "../src/profiles.js";
import type { PendingItem, ThreadEvent } from "../src/protocol.js";

rmSync(process.env.DAEDALUS_DATA_DIR!, { recursive: true, force: true });
mkdirSync("/tmp/daedalus-test-pending/ws", { recursive: true });
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
const { sessionRoutes } = await import("../src/routes/sessions.js");

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
const project = { id: "w1", name: "test-ws", cwd: "/tmp/daedalus-test-pending/ws", description: null };

const manager = new SessionManager({}, 1);
const app = new Hono();
sessionRoutes(app, { sessions: manager });
const list = async () => (await (await app.request("/api/pending")).json()) as PendingItem[];
const answer = (sessionId: string, requestId: string, optionId: string) =>
  app.request(`/api/sessions/${sessionId}/pending/${requestId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ optionId }),
  });

const session = await manager.create(profile, "fake", project);
await session.bridge!.ready;
const peer = new MockWs();
assert.equal(await manager.attach(session.id, peer as never), null);

assert.deepEqual(await list(), [], "nothing pending on an idle thread");

peer.emit("message", Buffer.from(JSON.stringify({ id: 1, cmd: "prompt", text: "needs permission" })));
await waitFor(() => peer.of("permission").length === 1, "the turn parks on a permission");

const [item] = await list();
assert.equal(item.sessionId, session.id);
assert.equal(item.kind, "permission");
assert.equal(item.requestId, peer.of("permission")[0].requestId);
assert.ok(item.kind === "permission" && item.request.options.some((o) => o.kind === "allow_once"));

assert.equal((await answer(session.id, item.requestId, "nope")).status, 400, "an option not offered is refused");
assert.equal((await list()).length, 1, "and the question is still open");

assert.equal((await answer(session.id, item.requestId, "allow")).status, 200);
assert.equal(peer.of("request_answered").length, 1, "the watching peer is told, as for a socket answer");
assert.equal((await answer(session.id, item.requestId, "reject")).status, 409, "a second answer loses");
assert.deepEqual(await list(), [], "answered means gone");
await waitFor(() => session.bridge!.promptActive === false, "the allowed turn finishes");

manager.shutdown();
console.log("pending: ok");
process.exit(0);
