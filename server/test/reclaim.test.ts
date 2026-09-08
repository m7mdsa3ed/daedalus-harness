// Escape stops the running turn AND takes back the message the user has not
// seen land, so a send made a second ago costs one key to undo.
//
// Two halves, and only the first is total. A QUEUED row never left this
// server, so taking it back is complete. A STEER's words went out the moment
// they were sent — but no runtime reads a second prompt before its current
// step ends, and until then its `turn_started` is held in the bridge
// (`pendingSteers`), which is the only place it exists on this side. So while
// the steer is still held it can be unwound with no trace; once a step has
// read it, its bubble is in the transcript and there is nothing to take. That
// is the whole of "unless a new step already read it".
//
// The ordering below is the mechanism, not a detail: a cancel settles the
// turn, and a settle is a step boundary — `flushSteers` emits every held steer
// as the real bubble it was waiting to become. So the take-back happens first,
// server-side, in one command.
//
// Run: pnpm test:reclaim (DAEDALUS_DATA_DIR is set by the npm script — static
// imports are hoisted, so setting it here would be too late).
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
mkdirSync("/tmp/daedalus-test-reclaim/ws", { recursive: true });
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
  mcpServerIds: [],
  skillIds: [],
  commandIds: [],
};
const project = {
  id: "w1",
  name: "test-ws",
  cwd: "/tmp/daedalus-test-reclaim/ws",
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

const a = new MockWs();
const b = new MockWs();
assert.equal(await manager.attach(session.id, a as never), null);
assert.equal(await manager.attach(session.id, b as never), null);

const queue = () => a.of("queue").at(-1)?.items ?? [];
const replyTo = (id: number) =>
  a.of("reply").find((r) => r.id === id)!.result as { reclaimed?: { text: string } };

/** Start a turn and leave it parked on a permission — a turn held open with no
    tool call settling, which is exactly the state a steer must not land in. */
const park = async (id: number) => {
  const before = b.of("permission").length;
  send(a, { id, cmd: "prompt", text: "needs permission" });
  await waitFor(() => b.of("permission").length === before + 1, `turn ${id} parks on a permission`);
};

const idle = () =>
  waitFor(() => session.bridge!.promptActive === false, "the thread goes idle again");

// ---- a queued row: taking it back is total ----

// `b`, not `a`: the peer that sent a prompt is not told about its own —
// it drew the bubble itself — so only the other peer counts the bubbles.
const startsBefore = b.of("turn_started").length;
const endsBefore = b.of("turn_ended").length;
await park(1);
send(a, { id: 2, cmd: "queue_add", text: "typed by mistake" });
await waitFor(() => queue().length === 1, "one queued");

send(a, { id: 3, cmd: "cancel", reclaim: true });
await waitFor(() => a.of("reply").some((r) => r.id === 3), "the reclaiming stop answers");
assert.equal(replyTo(3).reclaimed?.text, "typed by mistake", "the words come back to the caller");
// Both halves, or the message is said twice: one in the composer and one still
// queued is the failure this ordering exists to prevent.
await waitFor(() => queue().length === 0, "…and leave the queue");
await waitFor(() => b.of("turn_ended").length === endsBefore + 1, "the turn is stopped all the same");
assert.equal(
  b.of("turn_started").length,
  startsBefore + 1,
  "only the parked turn was ever sent — the queued row reached no agent",
);
await idle();

// ---- a held steer: taken back before the settle can flush it ----

await park(4);
/* The steer must ITSELF hold the step open — the fake agent parks on a
   permission for this text — or it settles in the same tick and flushes its own
   bubble, which is the landed case and not what this half is about. */
send(a, { id: 5, cmd: "prompt", text: "steered by mistake, needs permission", steer: true });
await waitFor(() => a.of("reply").some((r) => r.id === 5), "the steer is answered");
assert.equal(
  (a.of("reply").find((r) => r.id === 5)!.result as { deferred?: boolean }).deferred,
  true,
  "the sender is told its bubble is being held",
);
await waitFor(() => queue().some((i) => i.steer), "…and it is listed as held, not landed");

const heldStarts = b.of("turn_started").length;
send(a, { id: 6, cmd: "cancel", reclaim: true });
await waitFor(() => a.of("reply").some((r) => r.id === 6), "the reclaiming stop answers");
assert.equal(
  replyTo(6).reclaimed?.text,
  "steered by mistake, needs permission",
  "a steer no step has read comes back too",
);
await idle();
// The settle behind the cancel IS a step boundary. Taken first, it has nothing
// left to flush — so the words leave no trace on this side at all.
await new Promise((r) => setTimeout(r, 200));
assert.equal(b.of("turn_started").length, heldStarts, "its bubble never lands");
assert.deepEqual(queue(), [], "and nothing is left holding it");
assert.deepEqual(
  (await manager.journal(session.id))!.events.filter(
    (e) => e.ev === "turn_started" && e.text === "steered by mistake, needs permission",
  ),
  [],
  "…including in the journal, so a reload agrees",
);

// ---- nothing un-landed: a reclaiming stop is an ordinary stop ----

// Answering with nothing is what keeps the composer from filling itself with
// words that are already in the transcript — the "unless a new step read it"
// case arrives here, because by then the steer is gone from `pendingSteers`.
await park(7);
send(a, { id: 8, cmd: "cancel", reclaim: true });
await waitFor(() => a.of("reply").some((r) => r.id === 8), "a stop with nothing to take answers");
assert.deepEqual(replyTo(8), {}, "…and hands back nothing");
await idle();

// ---- a plain stop is unchanged: the queue is parked, not raided ----

// `reclaim` is opt-in because the message leaves the queue when it is taken: a
// caller with nowhere to put the words (Retry, the palette, a workflow) must
// not be handed them.
await park(9);
send(a, { id: 10, cmd: "queue_add", text: "still mine" });
await waitFor(() => queue().length === 1, "one queued");
send(a, { id: 11, cmd: "cancel" });
await waitFor(() => a.of("reply").some((r) => r.id === 11), "the plain stop answers");
assert.deepEqual(replyTo(11), {}, "a plain stop takes nothing");
await idle();
await new Promise((r) => setTimeout(r, 200));
assert.deepEqual(queue().map((i) => i.text), ["still mine"], "the queue is still there");

a.close();
b.close();
console.log("reclaim: all assertions passed");
