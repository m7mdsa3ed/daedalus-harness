// Escape stops the running turn AND takes back the message the user has not
// seen land, so a send made a second ago costs one key to undo.
//
// Two kinds of un-landed message, two bargains. A QUEUED row never left this
// server and never joined a turn, so taking it back into the composer is
// total. A STEER joined a running turn on purpose — its promise was "these
// words run" — so a stop keeps the promise instead of revoking it: the words
// are re-queued as ordinary rows and, once the cancelled turn has settled,
// run as the next turn. From the queue they are editable, removable and
// drainable, which is the way back a take-back used to be.
//
// The ordering below is the mechanism, not a detail: a cancel settles the
// turn, and a settle is a step boundary — `flushSteers` emits every held steer
// as the real bubble it was waiting to become. So the take-back and the steer
// conversion happen first, server-side, in one command.
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

// ---- a held steer: the stop re-queues it, and the words run as the next turn ----

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
const permsAtStop = b.of("permission").length;

const heldStarts = b.of("turn_started").length;
const heldEnds = b.of("turn_ended").length;
send(a, { id: 6, cmd: "cancel", reclaim: true });
await waitFor(() => a.of("reply").some((r) => r.id === 6), "the reclaiming stop answers");
assert.deepEqual(
  replyTo(6),
  {},
  "a steer is not handed back — it re-queues and runs as the next turn",
);
/* The row itself is transient — the follow-up turn claims it within the same
   breath — so what is observable is the queue draining and the words running
   as their own turn, not a listing of the row. */
await waitFor(
  () => b.of("turn_ended").length === heldEnds + 1,
  "the stop still ends the turn it was aimed at",
);
await waitFor(
  () =>
    b.of("turn_started").length === heldStarts + 1 &&
    b.of("turn_started").at(-1)!.text === "steered by mistake, needs permission",
  "the steered words run as the next turn, not as a bubble in the dead one",
);
await waitFor(() => queue().length === 0, "the row is claimed by the turn it started");
await waitFor(
  () => b.of("permission").length === permsAtStop + 1,
  "the steered turn parks in its turn — it parked the step, like the one it replaced",
);
send(a, { id: 7, cmd: "cancel" });
await waitFor(() => a.of("reply").some((r) => r.id === 7), "the parked steered turn is stopped");
await idle();
assert.equal(
  (await manager.journal(session.id))!.events.filter(
    (e) => e.ev === "turn_started" && e.text === "steered by mistake, needs permission",
  ).length,
  1,
  "the steered words are in the journal as the turn they became",
);

// ---- a plain stop re-queues a held steer all the same ----

// The conversion is the stop's, not the take-back's: a caller with nowhere to
// put the words (Retry, the palette, a workflow) strands nothing either.
await park(8);
send(a, { id: 9, cmd: "prompt", text: "steered at a plain stop, needs permission", steer: true });
await waitFor(() => queue().some((i) => i.steer), "the steer is held");
const permsAtStop2 = b.of("permission").length;
const plainStarts = b.of("turn_started").length;
send(a, { id: 10, cmd: "cancel" });
await waitFor(() => a.of("reply").some((r) => r.id === 10), "the plain stop answers");
assert.deepEqual(replyTo(10), {}, "a plain stop takes no row");
await waitFor(
  () => b.of("turn_started").length === plainStarts + 1,
  "the steered words still run as the next turn",
);
await waitFor(
  () => b.of("permission").length === permsAtStop2 + 1,
  "and parks on its own permission in its turn",
);
send(a, { id: 11, cmd: "cancel" });
await waitFor(() => a.of("reply").some((r) => r.id === 11), "the parked steered turn is stopped");
await idle();

// ---- order: the re-queued steer runs alone; the parked rows stay parked ----

// A steer typed at t1, rows queued at t2 and t3: the stop re-queues the steer
// ahead of them and runs THE STEERED WORDS as the next turn — the parked rows
// are not carried along, because a stop parks the queue. They follow only
// when the steered turn ends and the settle-drain finds them.
await park(12);
/* The steer has to still be HELD at the stop, so its text parks the step the
   same way — a steer the running turn has already read is a landed bubble,
   not this section's subject. */
send(a, { id: 13, cmd: "prompt", text: "steered first, needs permission", steer: true });
await waitFor(() => queue().some((i) => i.steer), "the steer is held");
const permsAtStop6 = b.of("permission").length;
send(a, { id: 14, cmd: "queue_add", text: "queued second" });
await waitFor(() => queue().some((i) => i.text === "queued second"), "the row parked behind the held steer");
send(a, { id: 15, cmd: "queue_add", text: "queued third" });
await waitFor(() => queue().some((i) => i.text === "queued third"), "a second row parked behind that");
send(a, { id: 16, cmd: "cancel", reclaim: true });
await waitFor(() => a.of("reply").some((r) => r.id === 16), "the stop answers");
assert.equal(replyTo(16).reclaimed?.text, "queued third", "the newest ROW is what comes back");
await waitFor(
  () => b.of("turn_started").at(-1)?.text === "steered first, needs permission",
  "the next turn runs the steered words alone",
);
await waitFor(
  () => b.of("permission").length === permsAtStop6 + 1,
  "the steered turn parks in its turn",
);
send(a, { id: 17, cmd: "cancel" });
await waitFor(() => a.of("reply").some((r) => r.id === 17), "the parked steered turn is stopped");
await idle();
await new Promise((r) => setTimeout(r, 200));
assert.deepEqual(
  queue().map((i) => i.text),
  ["queued second"],
  "the parked row was not carried along — a stop parks the queue",
);

// ---- nothing un-landed: a reclaiming stop is an ordinary stop ----

// Answering with nothing is what keeps the composer from filling itself with
// words that are already in the transcript — the landed case arrives here,
// because by then the steer is gone from `pendingSteers`.
send(a, { id: 18, cmd: "queue_clear" });
await waitFor(() => a.of("reply").some((r) => r.id === 18), "the parked row is cleared away");
await waitFor(() => queue().length === 0, "the queue is empty again");
await park(19);
send(a, { id: 20, cmd: "cancel", reclaim: true });
await waitFor(() => a.of("reply").some((r) => r.id === 20), "a stop with nothing to take answers");
assert.deepEqual(replyTo(20), {}, "…and hands back nothing");
await idle();

// ---- a plain stop is unchanged: the queue is parked, not raided ----

// `reclaim` is opt-in because the message leaves the queue when it is taken: a
// caller with nowhere to put the words (Retry, the palette, a workflow) must
// not be handed them.
await park(21);
send(a, { id: 22, cmd: "queue_add", text: "still mine" });
await waitFor(() => queue().length === 1, "one queued");
send(a, { id: 23, cmd: "cancel" });
await waitFor(() => a.of("reply").some((r) => r.id === 23), "the plain stop answers");
assert.deepEqual(replyTo(23), {}, "a plain stop takes nothing");
await idle();
await new Promise((r) => setTimeout(r, 200));
assert.deepEqual(queue().map((i) => i.text), ["still mine"], "the queue is still there");

a.close();
b.close();
console.log("reclaim: all assertions passed");
