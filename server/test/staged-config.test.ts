// A change that costs the process is STAGED when it is picked, and the next
// spawn is what takes it. Two mechanisms and no third: `respawnNow` folds the
// patch into any spawn that happens (a revive, a rewind, the restart route),
// and `prompt` makes a spawn happen when a turn finds a patch outstanding.
// There is no `turn_ended` flush any more — a turn ending is not a reason to
// restart an agent for a user who is still reading the answer.
// Run: pnpm test:staged-config (DAEDALUS_DATA_DIR is set by the npm script —
// static imports are hoisted, so setting it here would be too late).
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson } from "../src/config.js";
import type { Profile } from "../src/profiles.js";
import type { ThreadCommand, ThreadEvent } from "../src/protocol.js";

rmSync(process.env.DAEDALUS_DATA_DIR!, { recursive: true, force: true });
mkdirSync("/tmp/daedalus-test-staged-config/ws", { recursive: true });
const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fake-agent.mjs");
// Two agents on the same binary: the second exists only so an *agent* change is
// a thing this profile can express. It is the one change that is never staged.
writeJson(join(process.env.DAEDALUS_DATA_DIR!, "agents.json"), [
  { id: "fake", name: "Fake", command: "node", args: [FAKE], env: { FAKE_KEY: "{apiKey}" } },
  { id: "fake2", name: "Fake Two", command: "node", args: [FAKE], env: { FAKE_KEY: "{apiKey}" } },
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
  agents: { fake: {}, fake2: {} },
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
  cwd: "/tmp/daedalus-test-staged-config/ws",
  description: null,
};

/* Written to the store as well as held here. A staged patch carries *ids*, so
   the flush and the fold resolve both the profile and the project through
   `getProfile`/`getProject` — objects the test alone knows about are ones they
   read as deleted, drop the patch for, and let the send proceed on. Which is
   the right behaviour, and the reason these rows have to exist. */
{
  const {
    db,
    mcpServers: mcpServersTable,
    profiles: profilesTable,
    projects: projectsTable,
    skills: skillsTable,
  } = await import("../src/db/index.js");
  await db.insert(mcpServersTable).values({
    id: "builtin:workflow",
    type: "builtin",
    name: "Workflow",
    builtin: "workflow",
  });
  await db.insert(skillsTable).values({ id: "skill-one", name: "Skill One", path: "/tmp/skill-one" });
  await db.insert(projectsTable).values({
    id: project.id,
    name: project.name,
    cwd: project.cwd,
  });
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
}

const send = (ws: MockWs, command: ThreadCommand) =>
  ws.emit("message", Buffer.from(JSON.stringify(command)));

const waitFor = async (predicate: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 200 && !(await predicate()); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(await predicate(), `timed out waiting for ${what}`);
};

/* Every `session/new` and `session/load` the fake agent has answered, one line
   each — which makes it the spawn counter this whole file is written around.
   "One spawn, not two" is the claim staging exists to make. */
const metaLogPath = join(process.env.DAEDALUS_DATA_DIR!, "fake-session-meta.jsonl");
const spawns = (): number =>
  existsSync(metaLogPath)
    ? readFileSync(metaLogPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { method: string })
        .filter((e) => e.method === "session/new" || e.method === "session/load" || e.method === "session/resume").length
    : 0;

const manager = new SessionManager({}, 1);

// ---- an idle pick stages, and costs nothing ----

const session = await manager.create(profile, "fake", project, "m1");
await session.bridge!.ready;
const peer = new MockWs();
assert.equal(await manager.attach(session.id, peer as never), null);
send(peer, { id: 1, cmd: "prompt", text: "hello" });
await waitFor(() => peer.of("turn_ended").length === 1, "the first turn to end");

/* The fake agent declares no `liveConfig`, so every setting here costs the
   process — which is exactly the class of change this file is about. */
const idle = spawns();
const staged = await manager.applyConfig(session.id, {
  profile,
  agentId: "fake",
  project,
  model: "m2",
});
assert.equal(staged.live, false, "a model change on this agent cannot be applied live");
assert.deepEqual(staged.staged?.model, "m2", "…so it was staged rather than taken");
assert.equal(staged.restarting, undefined, "and nothing was restarted");
assert.equal(spawns(), idle, "an idle pick spawns nothing — this is the whole point");
assert.equal(session.model, "m1", "the row still says what the process is actually on");
assert.deepEqual(
  peer.of("staged_config").at(-1)?.config?.model,
  "m2",
  "every peer was told what is waiting",
);
manager.stageLinks(session.id, "mcpServerIds", ["builtin:workflow"]);
manager.stageLinks(session.id, "skillIds", ["skill-one"]);

// ---- the next turn takes it, in one spawn, and says so first ----

const journalBefore = (await manager.journal(session.id))!.events.length;
await manager.prompt(session.id, "second");
await waitFor(() => peer.of("turn_ended").length === 2, "the second turn to end");

assert.equal(spawns(), idle + 1, "the send spent exactly one spawn");
assert.equal(session.model, "m2", "…and the process came up on the staged model");
assert.equal(manager.stagedRequest(session.id), null, "the patch was consumed, not left behind");
assert.deepEqual(session.links.mcpServerIds, ["builtin:workflow"], "the selected MCP was stored on the thread");
assert.deepEqual(session.links.skillIds, ["skill-one"], "the selected skill was stored on the thread");
assert.equal(spawns(), idle + 1, "model and link changes share exactly one spawn");

const since = (await manager.journal(session.id))!.events.slice(journalBefore);
const noticeAt = since.findIndex((e) => e.ev === "config_notice" && e.text.startsWith("Model:"));
const turnAt = since.findIndex((e) => e.ev === "turn_started");
assert.ok(noticeAt >= 0, "the change is said in the transcript, not just applied");
assert.ok(
  noticeAt < turnAt,
  "…and said BEFORE the turn, or the transcript reads as though the setting followed the message",
);
/* A tool link is a setting like the ones beside it, so it draws the same row —
   named, out of the library, never a uuid. Both were empty and both were picked. */
assert.ok(
  since.some((e) => e.ev === "config_notice" && e.text === "MCP: none → Workflow"),
  "the MCP link change is said too, by the server's own name for it",
);
assert.ok(
  since.some((e) => e.ev === "config_notice" && e.text === "Skills: none → Skill One"),
  "…and so is the skill, on the same one spawn",
);

// ---- a queue drain is not a boundary, and neither is a steer ----

// Parked on a permission request, so the turn stays open while the pick lands.
const endedBefore = peer.of("turn_ended").length;
send(peer, { id: 2, cmd: "prompt", text: "needs permission" });
await waitFor(() => peer.of("permission").length === 1, "a turn parked on a permission");
assert.equal(session.bridge!.promptActive, true, "the turn is running");

const mid = await manager.applyConfig(session.id, { profile, agentId: "fake", project, model: "m1" });
assert.deepEqual(mid.staged?.model, "m1", "a mid-turn pick stages, as it always did");
const busy = spawns();

/* Queued behind the running turn. The drain calls `startTurn` directly and
   never reaches `prompt`, which is what preserves the old `continued` rule: no
   restart between two messages the user sent together. */
await manager.queueAdd(session.id, "queued");
/* And a steer joins the running turn rather than starting one, so it is not a
   boundary either — `prompt` reads `promptActive` to tell the two apart. */
await manager.prompt(session.id, "steered", undefined, { steer: true });
assert.deepEqual(manager.stagedRequest(session.id)?.model, "m1", "a steer does not consume the patch");

send(peer, {
  cmd: "answer_permission",
  requestId: peer.of("permission")[0].requestId,
  response: { outcome: { outcome: "selected", optionId: "allow" } },
});
await waitFor(
  () => peer.of("turn_ended").length >= endedBefore + 2,
  "the running turn to settle and the queued one after it",
);
await waitFor(() => session.bridge?.promptActive !== true, "the queue to finish draining");
assert.deepEqual(
  manager.stagedRequest(session.id)?.model,
  "m1",
  "the drained message did not consume it either — and no turn boundary flushed it",
);
assert.equal(spawns(), busy, "nothing respawned while the queue drained");

// The next user-initiated turn is what takes it.
await manager.prompt(session.id, "after the queue");
assert.equal(session.model, "m1", "the turn after the drain came up on the staged model");
assert.equal(manager.stagedRequest(session.id), null, "and consumed the patch");

// ---- a spawn that happens for some other reason folds it too ----

/* Retiring is what an idle thread does on its own, and it is the case staging
   was worth the most for: the pick used to respawn a process nobody was talking
   to, and the next message then revived it a second time. */
manager.retireAll([session.id]);
assert.equal(session.exited, true, "the thread is retired");
const revive = await manager.applyConfig(session.id, {
  profile,
  agentId: "fake",
  project,
  model: "m2",
});
assert.deepEqual(revive.staged?.model, "m2", "a retired thread stages rather than waking up");
assert.equal(spawns(), busy + 1, "…and nothing spawned to hear about it");

const beforeRevive = spawns();
// The revive the `/respawn` route drives, passing the row's own values.
await manager.respawn(session.id, profile, "fake", project, session.model || undefined);
assert.equal(spawns(), beforeRevive + 1, "the revive is ONE spawn, not a revive plus a restart");
assert.equal(session.model, "m2", "…and it came up on the staged model, not the row's");
assert.equal(manager.stagedRequest(session.id), null, "the patch was consumed by the fold");

// ---- Apply now respawns a live idle thread to apply staged links ----

const applyNow = await manager.create(profile, "fake", project, "m1");
await applyNow.bridge!.ready;
manager.stageLinks(applyNow.id, "mcpServerIds", ["builtin:workflow"]);
manager.stageLinks(applyNow.id, "skillIds", ["skill-one"]);
const beforeLiveApplyNow = spawns();
assert.equal(await manager.approveStaged(applyNow.id), null, "Apply now consumes the link patch");
assert.equal(spawns(), beforeLiveApplyNow + 1, "Apply now respawns a live idle thread for new links");
assert.deepEqual(applyNow.links.mcpServerIds, ["builtin:workflow"], "Apply now stores the MCP selection");
assert.deepEqual(applyNow.links.skillIds, ["skill-one"], "Apply now stores the skill selection");

// ---- Apply now revives a retired thread instead of requiring a live bridge ----

await manager.applyConfig(applyNow.id, {
  profile,
  agentId: "fake",
  project,
  model: "m2",
});
manager.retireAll([applyNow.id]);
assert.equal(applyNow.exited, true, "the staged thread has no running agent");
const beforeApplyNow = spawns();
assert.equal(await manager.approveStaged(applyNow.id), null, "Apply now consumes the patch");
assert.equal(spawns(), beforeApplyNow + 1, "Apply now revives with one spawn");
assert.equal(applyNow.model, "m2", "the revived agent starts on the staged model");
assert.ok(applyNow.bridge && !applyNow.exited, "the revived thread has a running agent");

// ---- a held turn takes it, on Continue and on a send into the hold ----

/* The hold is the harness's promise that a failed turn waits for a model change
   and a resume, so Continue is a door a patch may leave by. And a pick made
   while the turn was still *retrying* lands before the hold exists — the guard
   in `applyConfig` reads the hold at pick time — which would otherwise strand it
   behind a steer, and a steer never flushes. */
const parked = await manager.create(profile, "fake", project, "m1");
await parked.bridge!.ready;
const heldPeer = new MockWs();
assert.equal(await manager.attach(parked.id, heldPeer as never), null);
send(heldPeer, { id: 3, cmd: "prompt", text: "needs permission" });
await waitFor(() => heldPeer.of("permission").length === 1, "a turn parked on a permission");

const midHeld = await manager.applyConfig(parked.id, {
  profile,
  agentId: "fake",
  project,
  model: "m2",
});
assert.deepEqual(midHeld.staged?.model, "m2", "the pick staged while the turn was running");
await parked.bridge!.pause();
assert.equal(parked.bridge!.paused, true, "the hold arrived after the pick");

const heldSpawns = spawns();
await manager.prompt(parked.id, "into the hold", undefined, { steer: true });
assert.equal(parked.model, "m2", "a send into a held turn takes the patch");
assert.equal(manager.stagedRequest(parked.id), null, "…and consumes it");
assert.equal(spawns(), heldSpawns + 1, "…in one spawn");

const resumed = await manager.applyConfig(parked.id, {
  profile,
  agentId: "fake",
  project,
  model: "m1",
});
assert.deepEqual(resumed.staged?.model, "m1", "staged again, on the new process");
await parked.bridge!.pause();
const beforeResume = spawns();
assert.equal(
  (await manager.resumeTurn(parked.id)).paused,
  false,
  "the flush replaced the process, so there is nothing left to resume",
);
assert.equal(parked.model, "m1", "Continue takes the patch");
assert.equal(manager.stagedRequest(parked.id), null, "…and consumes it");
assert.equal(spawns(), beforeResume + 1, "…in one spawn");
heldPeer.close();

// ---- an agent change is never staged ----

const swapped = await manager.applyConfig(session.id, {
  profile,
  agentId: "fake2",
  project,
  model: "m2",
});
assert.equal(swapped.staged, undefined, "an agent change is applied, never staged");
assert.equal(session.agentId, "fake2", "…and the row moved with the process");
assert.equal(
  manager.stagedRequest(session.id),
  null,
  "StagedConfig cannot carry an agent, so staging one would silently drop it",
);

// ---- the agent's own selectors are staged too; approving takes them without a restart ----

const picker = await manager.create(profile, "fake", project, "m1");
await picker.bridge!.ready;
const modeOf = () => picker.bridge!.modes?.currentModeId;
const first = modeOf();
const stagedMode = manager.stagePick(picker.id, { modeId: "acceptEdits" });
assert.equal(stagedMode.modeId, "acceptEdits", "a mode pick is staged");
assert.equal(modeOf(), first, "…and the agent is still on the mode it was on");
const beforePick = spawns();
assert.equal((await manager.approveStaged(picker.id)), null, "approving takes it, and nothing is left");
assert.equal(modeOf(), "acceptEdits", "the agent took the mode");
assert.equal(spawns(), beforePick, "a mode costs no spawn, even when approved on a runtime with no live path");

manager.stagePick(picker.id, { modeId: "bypassPermissions" });
await manager.prompt(picker.id, "next turn takes it");
assert.equal(modeOf(), "bypassPermissions", "a starting turn takes a staged mode");
assert.equal(manager.stagedRequest(picker.id), null, "…and consumes it");

// ---- a flush that fails keeps the patch and sends nothing ----

const doomed = await manager.create(profile, "fake", project, "m1");
await doomed.bridge!.ready;
const held = await manager.applyConfig(doomed.id, {
  profile,
  agentId: "fake",
  project,
  model: "m2",
});
assert.deepEqual(held.staged?.model, "m2", "staged, ready to be flushed by the next send");
manager.stageLinks(doomed.id, "skillIds", ["skill-one"]);

{
  /* Break the spawn under it: the respawn the flush asks for cannot come up.
     A missing *script* rather than a missing binary, because the two fail by
     different routes — node exits immediately, which `proc.on("exit")` turns
     into a collapse and a rejected `bridge.ready`, and that is the failure the
     flush has to survive. */
  const { eq } = await import("drizzle-orm");
  const { db, agents: agentsTable } = await import("../src/db/index.js");
  await db
    .update(agentsTable)
    .set({ args: [`${FAKE}.does-not-exist`] })
    .where(eq(agentsTable.id, "fake"));
}

await assert.rejects(
  () => manager.prompt(doomed.id, "never sent"),
  "the send fails rather than running on settings the user has moved off",
);
assert.deepEqual(
  manager.stagedRequest(doomed.id)?.model,
  "m2",
  "the patch went back — `applyConfig` drops it before it restarts, so the flush must restore it",
);
assert.deepEqual(manager.stagedRequest(doomed.id)?.skillIds, ["skill-one"], "the failed flush retains the link patch");
assert.deepEqual(doomed.links.skillIds, [], "the failed flush restores the previously active links");

peer.close();
console.log("staged-config: all assertions passed");
