// Self-check for thread rewind: the conversation half forks the agent session
// at the turn before the one being discarded and respawns onto the fork (the
// journal refills from the load, so the discarded turns are gone), the files
// half restores the worktree to the turn's start tree without touching the
// conversation, and the refusals — no rewind door on the agent, unknown turn —
// read as what they are. Against the fake agent and a real repository under
// DATA_DIR.
// Run: pnpm test:rewind
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson } from "../src/config.js";
import { createProject, deleteProject } from "../src/projects.js";
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
]);

const { SessionManager } = await import("../src/sessions.js");

/* `rewindVia` is a claim about the runtime behind `command`, which only
   `seedAgents`' backfill is entitled to make for a shipped agent — and this
   one is the user's, so the test sets it the way a user would (Settings ›
   Agents), after first asserting the refusal without it. */
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
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(predicate(), `timed out waiting for ${what}`);
};

const manager = new SessionManager({}, 1);

// --- a git project for the files half, and a plain one for the conversation ---

const gitRoot = join(process.env.DAEDALUS_DATA_DIR!, "rewind-repo");
rmSync(gitRoot, { recursive: true, force: true });
mkdirSync(gitRoot, { recursive: true });
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@localhost", ...args], { cwd: gitRoot, stdio: "pipe" })
    .toString()
    .trim();
git("init", "-q");
writeFileSync(join(gitRoot, "a.txt"), "one\n");
git("add", "-A");
git("commit", "-q", "-m", "Scaffold");
/* Real rows: the git half resolves the repository through the project row
   (`projectRoot`), so an in-memory object like the bridge test's would read
   as "no such project" the moment a restore was asked for. */
const gitProject = createProject({ name: "rewind-git", cwd: gitRoot, description: null, logoUrl: "" });
const plainProject = createProject({ name: "test-ws", cwd: "/tmp/daedalus-test-data/ws", description: null, logoUrl: "" });

// --- two turns, then rewind the second ---

const session = manager.create(profile, "fake", plainProject);
await session.bridge!.ready;
const ws = new MockWs();
await manager.attach(session.id, ws as never);
/* A passive second peer, because `turn_started` goes to every peer EXCEPT the
   one whose words started it — the sender draws its bubble itself, so the
   turn boundaries this test needs are only visible from the side. */
const side = new MockWs();
await manager.attach(session.id, side as never);

send(ws, { id: 1, cmd: "prompt", text: "first turn" });
await waitFor(() => ws.of("turn_ended").length === 1, "first turn end");
send(ws, { id: 2, cmd: "prompt", text: "second turn" });
await waitFor(() => ws.of("turn_ended").length === 2, "second turn end");
assert.equal(session.acpSessionId, "acp-123", "both turns ran on the agent's session");
assert.equal(session.acpSessionProvisional, false, "…and the id is proven");

const turn1 = side.of("turn_started")[0]!;
const turn2 = side.of("turn_started")[1]!;
assert.ok(turn1 && turn2, "both turns were announced to the other peer");

// Without a rewind door on the agent, the conversation half is refused — and
// the refusal says files are still on the table.
await assert.rejects(
  manager.rewind(session.id, turn2.turnId, "conversation"),
  /cannot rewind its conversation/,
  "no rewindVia, no conversation rewind",
);
await setRewindVia("acp-fork-point");

await assert.rejects(
  manager.rewind(session.id, "no-such-turn", "conversation"),
  /unknown turn/,
  "an unknown turn is a 404-shaped refusal",
);

// The rewind lands on the fork: the fake agent names it after the fork point,
// which is turn 1's messageId (`msg-1` — one id per turn, shared by its
// chunks). The id is adopted as provisional — no turn has settled on it — and
// the respawn's load refills the journal with the forked stub, so the second
// turn is gone from the log the same way it is gone from the agent's context.
const result = await manager.rewind(session.id, turn2.turnId, "conversation");
assert.equal(result.ok, true);
assert.equal(session.acpSessionId, "acp-123-fork-msg-1", "the thread moved to the fork");
// The respawn's `session/load` answered, which is what proves an id — so the
// fork arrives already proven, which is also the proof it was loadable at all.
assert.equal(session.acpSessionProvisional, false, "the answering load proved the fork");

const after = new MockWs();
await manager.attach(session.id, after as never);
await waitFor(() => after.of("caught_up").length === 1, "the rewound replay");
assert.equal(after.of("turn_started").length, 0, "the discarded turns left no turn boundary behind");
assert.ok(
  after.of("update").some((e) => (e.update as { content?: { text?: string } }).content?.text === "(forked conversation)"),
  "the journal now holds the forked conversation",
);
assert.ok(
  !after.events.some((e) => e.ev === "update" && JSON.stringify(e.update).includes("Rail lines up")),
  "the original transcript is gone",
);

// --- files only: the worktree moves, the conversation does not ---

const gitSession = manager.create(profile, "fake", gitProject);
await gitSession.bridge!.ready;
const gws = new MockWs();
await manager.attach(gitSession.id, gws as never);
const gside = new MockWs();
await manager.attach(gitSession.id, gside as never);
send(gws, { id: 1, cmd: "prompt", text: "a turn in a repository" });
await waitFor(() => gws.of("turn_ended").length === 1, "the repo turn end");
const gitTurn = gside.of("turn_started")[0]!;
assert.ok(gitTurn, "the repo turn was announced to the other peer");

// The fake agent writes nothing, so the turn's start tree is HEAD's tree and
// the restore is honestly a no-op — the assertion is that the wiring runs,
// the tree is found, and the conversation is left exactly as it was.
const filesResult = await manager.rewind(gitSession.id, gitTurn.turnId, "files");
assert.equal(filesResult.ok, true);
assert.equal(filesResult.restored, false, "a no-op restore is answered as one");
assert.equal(gitSession.acpSessionId, "acp-123", "a files-only rewind keeps the conversation");
assert.equal(gitSession.acpSessionProvisional, false, "…and its proven id");

// A turn that was never measured has no files to give. The rewound thread's
// own turns are gone from the journal entirely (the fork's history has no
// turn boundaries), so drive a fresh one: it journals fine, but the project
// is not a repository, so its snapshot row holds no tree.
send(ws, { id: 3, cmd: "prompt", text: "a turn after the rewind" });
await waitFor(() => ws.of("turn_ended").length === 3, "the post-rewind turn end");
const turn3 = side.of("turn_started").at(-1)!;
await assert.rejects(
  manager.rewind(session.id, turn3.turnId, "files"),
  /no file snapshot/,
  "a turn with no tree is refused, not silently skipped",
);

console.log(`rewind: passed`);

deleteProject(gitProject.id);
deleteProject(plainProject.id);
rmSync(gitRoot, { recursive: true, force: true });
process.exit(0);
