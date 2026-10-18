// Deleting a profile resets its threads to their agent's Default instead of
// refusing: the plain DELETE names the threads (409 + threads[]), the user
// confirms, and DELETE ?force=1 moves every one of them — profile, model,
// effort and helper models — keeping transcripts, retiring live processes and
// dropping staged picks. One thread mid-turn refuses the whole reset.
//
// Run: pnpm test:profile-delete (DAEDALUS_DATA_DIR is set by the npm script —
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { writeJson } from "../src/config.js";
import type { Profile } from "../src/profiles.js";
import type { ThreadCommand, ThreadEvent } from "../src/protocol.js";

rmSync(process.env.DAEDALUS_DATA_DIR!, { recursive: true, force: true });
mkdirSync("/tmp/daedalus-test-profile-delete/ws", { recursive: true });
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
const { profileRoutes } = await import("../src/routes/profiles.js");
const {
  db,
  sessions: sessionsTable,
  profiles: profilesTable,
  projects: projectsTable,
} = await import("../src/db/index.js");
const { getProfile } = await import("../src/profiles.js");

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

const send = (ws: MockWs, command: ThreadCommand) =>
  ws.emit("message", Buffer.from(JSON.stringify(command)));

const waitFor = async (predicate: () => boolean, what: string) => {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(predicate(), `timed out waiting for ${what}`);
};

const profile: Profile = {
  id: "p1",
  name: "doomed",
  agents: { fake: {} },
  baseUrl: "",
  apiKey: "sk-test",
  models: [
    { id: "m1", label: "Model One", reasoningEfforts: [] },
    { id: "m2", label: "Model Two", reasoningEfforts: [] },
  ],
  defaultModel: "m1",
  smallModel: "",
  logoUrl: "",
};
const project = {
  id: "w1",
  name: "test-ws",
  cwd: "/tmp/daedalus-test-profile-delete/ws",
  description: null,
};

await db.insert(profilesTable).values({
  id: profile.id,
  name: profile.name,
  agents: profile.agents,
  baseUrl: profile.baseUrl,
  apiKey: profile.apiKey,
  models: profile.models,
  defaultModel: profile.defaultModel,
  smallModel: profile.smallModel,
  logoUrl: profile.logoUrl,
});
await db.insert(projectsTable).values({ id: project.id, name: project.name, cwd: project.cwd });

const manager = new SessionManager({}, 1);
const app = new Hono();
profileRoutes(app, { sessions: manager });
const del = (id: string, force: boolean) =>
  app.request(`/api/profiles/${id}${force ? "?force=1" : ""}`, { method: "DELETE" });

// ---- the plain delete names the threads instead of just counting them ----

const a = await manager.create(profile, "fake", project, "m1", "high", undefined, undefined, undefined, {
  helperModels: [{ role: "r1", model: "m1" }],
});
await a.bridge!.ready;
const b = await manager.create(profile, "fake", project, "m2");
await b.bridge!.ready;
const c = await manager.create(profile, "fake", project, "m1");
await c.bridge!.ready;
manager.softDelete(c.id);

const peer = new MockWs();
assert.equal(await manager.attach(a.id, peer as never), null);
const spawnBefore = peer.of("spawn_config").length;

/* A pick waiting for the next spawn names the profile being left — it has to
   die with it rather than land on Default. */
const staged = await manager.applyConfig(a.id, { profile, agentId: "fake", project, model: "m2" });
assert.equal(staged.staged?.model, "m2", "the model pick is staged, waiting for a spawn");

const eventsBefore = a.eventCount;

const refused = await del("p1", false);
assert.equal(refused.status, 409, "threads on the profile still block the plain delete");
const refusedBody = (await refused.json()) as { threads?: { id: string; title: string }[] };
assert.deepEqual(
  (refusedBody.threads ?? []).map((t) => t.id).sort(),
  [a.id, b.id].sort(),
  "the 409 names the live threads — trashed ones are already on their way out",
);

// ---- confirmed, every thread moves to its agent's Default ----

const forced = await del("p1", true);
assert.equal(forced.status, 200, "the confirmed delete goes through");
const forcedBody = (await forced.json()) as { moved?: string[] };
assert.deepEqual((forcedBody.moved ?? []).sort(), [a.id, b.id].sort(), "both live threads moved");

for (const s of [a, b]) {
  assert.equal(s.profileId, "default:fake", "the thread is on its agent's Default profile");
  assert.equal(s.profile?.id, "default:fake", "…in memory as well as on the row");
  assert.equal(s.model, "", "the old profile's model is cleared, not carried across");
  assert.equal(s.effort, "", "…and so is the effort");
  assert.deepEqual(s.helperModels, [], "…and the helper models that named its catalog");
  assert.equal(manager.stagedRequest(s.id), null, "a staged pick for the deleted profile is dropped");
  assert.equal(s.bridge, null, "a live process was retired, not left running the old credentials");
  assert.equal(s.exited, true, "…so the next send revives it like any retired thread");
}
assert.equal(a.eventCount, eventsBefore, "the transcript is untouched — the journal was never cleared");

const notices = peer.of("spawn_config");
assert.equal(notices.length, spawnBefore + 1, "the watching peer is told exactly once");
assert.deepEqual(
  { profileId: notices.at(-1)!.profileId, model: notices.at(-1)!.model, effort: notices.at(-1)!.effort },
  { profileId: "default:fake", model: "", effort: "" },
  "absolute, so a menu holding the deleted profile redraws",
);

const rowA = (await db.select().from(sessionsTable).where(eq(sessionsTable.id, a.id)))[0];
assert.equal(rowA.profileId, "default:fake", "the row moved too, so a restart revives on Default");
assert.equal(rowA.model, "", "…with no model to 404 on");
assert.equal((await getProfile("p1")), undefined, "the profile itself is gone");

assert.equal(c.profileId, "p1", "a trashed thread is left alone");
assert.deepEqual(
  (await manager.resetThreadsFromProfile("p1")).moved,
  [],
  "a second reset finds nothing — the move is idempotent",
);

// ---- one thread mid-turn refuses the whole reset ----

await db.insert(profilesTable).values({
  id: "p2",
  name: "busy",
  agents: { fake: {} },
  baseUrl: "",
  apiKey: "sk-test",
  models: [],
  defaultModel: "",
  smallModel: "",
  logoUrl: "",
});
const p2 = (await getProfile("p2"))!;
const d = await manager.create(p2, "fake", project);
await d.bridge!.ready;
const peer2 = new MockWs();
assert.equal(await manager.attach(d.id, peer2 as never), null);
send(peer2, { id: 1, cmd: "prompt", text: "needs permission" });
await waitFor(() => peer2.of("permission").length === 1, "the turn parks on a permission");
assert.equal(d.bridge!.promptActive, true, "the turn is still running");

const held = await manager.resetThreadsFromProfile("p2");
assert.deepEqual(held.moved, [], "a busy thread moves nothing — not even the idle ones");
assert.equal(held.busy.length, 1, "…and names who is busy");
assert.equal(d.profileId, "p2", "the busy thread keeps its profile");

const busyRes = await del("p2", true);
assert.equal(busyRes.status, 409, "the confirmed delete refuses while a turn runs");
assert.match(
  ((await busyRes.json()) as { error: string }).error,
  /mid-turn/,
  "and says why, rather than killing the turn under it",
);

await d.bridge!.cancel();
await waitFor(() => d.bridge!.promptActive === false, "the cancelled turn settles");
const freed = await del("p2", true);
assert.equal(freed.status, 200, "with the turn settled the reset goes through");
assert.deepEqual(
  ((await freed.json()) as { moved?: string[] }).moved,
  [d.id],
  "the parked thread moved to Default",
);
assert.equal(d.profileId, "default:fake", "…and reads Default");

manager.shutdown();
console.log("profile-delete: all assertions passed");
process.exit(0);
