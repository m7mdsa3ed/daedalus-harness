// Self-check for the replay windowing in src/session-journal.ts — the math
// index.ts warns is version-sensitive, pinned as behavior:
//   - the window and every page are counted in steps (turns), and a cut is only
//     ever made at a journaled `turn_started` seq — never mid-turn
//   - `windowStart` applies two budgets, steps first then bytes, whichever
//     binds first; one enormous turn is sent whole rather than the cut breaking
//     the turn-boundary rule
//   - the revive case: a log refilled by `session/load` does NOT begin with a
//     `turn_started`, and the window is applied only when a turn is genuinely
//     withheld — otherwise the whole log (that head included) replays from 0
//   - `earlierPage` pages whole turns backwards, and the page that reaches the
//     oldest turn extends to seq 0 so the revive head is never stranded
//   - `replayFrames` cuts frames on count or bytes, respects the `to` bound the
//     `attached` event names, and degrades to one event per message for a
//     client that did not opt into bulk
// Run: pnpm test:session-journal
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

rmSync(process.env.DAEDALUS_DATA_DIR!, { recursive: true, force: true });

const { db, schema } = await import("../src/db/index.js");
const { SessionJournal } = await import("../src/session-journal.js");
type JournalOwner = import("../src/session-journal.js").JournalOwner;
const { EARLIER_PAGE_STEPS, REPLAY_CHUNK_BYTES, REPLAY_CHUNK_SIZE } = await import(
  "../src/protocol.js"
);
type ThreadEvent = import("../src/protocol.js").ThreadEvent;

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
}

const journal = new SessionJournal();

let sessions = 0;
/** A fresh session row (the events table cascades off it) plus its owner. */
function owner(): JournalOwner {
  const id = `sj-${++sessions}`;
  db.insert(schema.sessions)
    .values({ id, profileId: "p", projectId: "w", agentId: "a", model: "", effort: "", title: id, createdAt: 1 })
    .run();
  return { id, eventCount: 0 };
}

const update = (text: string): ThreadEvent =>
  ({ ev: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } }) as ThreadEvent;

/** One whole turn: turn_started, `chunks` updates of `size` chars, turn_ended. */
function turn(session: JournalOwner, n: number, chunks = 1, size = 10): void {
  journal.append(session, { ev: "turn_started", turnId: `t${n}` } as unknown as ThreadEvent);
  for (let i = 0; i < chunks; i += 1) journal.append(session, update("x".repeat(size)));
  journal.append(session, { ev: "turn_ended", turnId: `t${n}`, stopReason: "end_turn" } as unknown as ThreadEvent);
}

/** The stored byte size of everything from `from` on — `length(payload)` over
    the same rows the window function reads, computed independently. */
function tailBytes(sessionId: string, from: number): number {
  return journal
    .eventsFrom(sessionId, from)
    .reduce((sum, event) => sum + JSON.stringify(event).length, 0);
}

console.log("session-journal");

test("append stamps a monotonic seq and reads flush the buffer first", () => {
  const s = owner();
  const first = journal.append(s, update("a"));
  const second = journal.append(s, update("b"));
  assert.equal((first as { seq?: number }).seq, 0);
  assert.equal((second as { seq?: number }).seq, 1);
  // No tick has passed — the rows are still buffered, and the read must not
  // be able to observe a log missing its newest events.
  const events = journal.eventsFrom(s.id, 0);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.seq), [0, 1]);
});

test("turn arithmetic: turnCount / turnStartAt / countTurnsBefore agree", () => {
  const s = owner();
  for (let n = 0; n < 4; n += 1) turn(s, n, 2);
  assert.equal(journal.turnCount(s.id), 4);
  // Each turn is 4 events (started, 2 chunks, ended).
  assert.equal(journal.turnStartAt(s.id, 0), 0);
  assert.equal(journal.turnStartAt(s.id, 2), 8);
  assert.equal(journal.turnStartAt(s.id, 4), null, "past the end is null, not a guess");
  assert.equal(journal.countTurnsBefore(s.id, 0), 0);
  assert.equal(journal.countTurnsBefore(s.id, 8), 2);
  assert.equal(journal.countTurnsBefore(s.id, Number.MAX_SAFE_INTEGER), 4);
});

test("the step budget cuts at a turn_started, and only when a turn is withheld", () => {
  const s = owner();
  for (let n = 0; n < 10; n += 1) turn(s, n);
  const cut = journal.windowStart(s.id, 3, Number.MAX_SAFE_INTEGER);
  assert.equal(cut, journal.turnStartAt(s.id, 7), "the newest 3 turns, from a turn boundary");
  assert.equal(journal.countTurnsBefore(s.id, cut), 7, "what `earlier` will report");
  // A window at least as wide as the log withholds nothing and says 0.
  assert.equal(journal.windowStart(s.id, 10, Number.MAX_SAFE_INTEGER), 0);
  assert.equal(journal.windowStart(s.id, 60, Number.MAX_SAFE_INTEGER), 0);
});

test("the byte budget binds when the steps do not", () => {
  const s = owner();
  turn(s, 0, 1, 60_000); // one fat turn — a build log
  for (let n = 1; n < 5; n += 1) turn(s, n, 1, 10); // four ordinary ones
  const cut = journal.windowStart(s.id, 60, 30_000);
  assert.equal(cut, journal.turnStartAt(s.id, 1), "the fat turn is what gets withheld");
  assert.ok(tailBytes(s.id, cut) <= 30_000, "what is sent fits the budget");
  assert.ok(tailBytes(s.id, 0) > 30_000, "what was cut did not");
  assert.equal(journal.countTurnsBefore(s.id, cut), 1);
});

test("steps are applied first, so the byte pass never widens past the step floor", () => {
  const s = owner();
  turn(s, 0, 1, 60_000);
  for (let n = 1; n < 5; n += 1) turn(s, n, 1, 10);
  // Steps allow only the newest 2; bytes would have allowed turns 1-4. The
  // narrower answer wins — whichever budget binds first.
  const cut = journal.windowStart(s.id, 2, 30_000);
  assert.equal(cut, journal.turnStartAt(s.id, 3));
});

test("one enormous turn is sent whole rather than the cut breaking the turn rule", () => {
  const s = owner();
  for (let n = 0; n < 3; n += 1) turn(s, n, 1, 10);
  turn(s, 3, 4, 50_000); // the newest turn alone busts the budget
  const cut = journal.windowStart(s.id, 60, 20_000);
  // Not a blank transcript, and not a cut inside the turn: the newest
  // turn_started, budget missed rather than rule broken.
  assert.equal(cut, journal.turnStartAt(s.id, 3));
  assert.ok(tailBytes(s.id, cut) > 20_000);
});

test("revive: a log that is all head (no turn_started) replays whole from 0", () => {
  // What `session/load` refills the journal with: the prior conversation as
  // updates, with no turn boundaries in it at all.
  const s = owner();
  for (let i = 0; i < 20; i += 1) journal.append(s, update(`loaded ${i}`));
  assert.equal(journal.windowStart(s.id, 5, Number.MAX_SAFE_INTEGER), 0);
  assert.equal(journal.countTurnsBefore(s.id, Number.MAX_SAFE_INTEGER), 0, "`earlier` says 0 too");
});

test("revive: a head plus one turn inside the window replays whole — the regression", () => {
  // The exact bug the comment in windowStart names: jumping unconditionally to
  // "the first turn of the window" replayed from the turn's seq and dropped
  // everything the load had put back, while `earlier` said 0 so nothing
  // offered it back either.
  const s = owner();
  for (let i = 0; i < 20; i += 1) journal.append(s, update(`loaded ${i}`));
  turn(s, 0);
  assert.equal(journal.turnStartAt(s.id, 0), 20, "the one turn starts past the head");
  assert.equal(journal.windowStart(s.id, 60, Number.MAX_SAFE_INTEGER), 0, "nothing is withheld, so no cut");
});

test("revive: when the window does cut, the head belongs to the oldest page", () => {
  const s = owner();
  for (let i = 0; i < 20; i += 1) journal.append(s, update(`loaded ${i}`));
  for (let n = 0; n < 6; n += 1) turn(s, n);
  const cut = journal.windowStart(s.id, 2, Number.MAX_SAFE_INTEGER);
  assert.equal(cut, journal.turnStartAt(s.id, 4), "a real cut: two turns shown, four withheld");
  assert.equal(journal.countTurnsBefore(s.id, cut), 4);
  // Paging back from the cut reaches the oldest turn, and that page extends to
  // seq 0: the head is not a turn, so it can never be a page of its own.
  const page = journal.earlierPage(s.id, cut);
  assert.equal(page.earlier, 0, "no whole turns behind this page");
  assert.equal(page.events[0].seq, 0, "the head came along");
  assert.equal(page.events.length, cut, "every event below the cut, exactly once");
});

test("earlierPage pages whole turns and counts what is still behind", () => {
  const s = owner();
  const total = EARLIER_PAGE_STEPS + 5;
  for (let n = 0; n < total; n += 1) turn(s, n);
  const before = journal.turnStartAt(s.id, total - 1)!;
  const page = journal.earlierPage(s.id, before);
  // A full page of whole turns, newest-first capped then re-ordered.
  assert.equal(page.earlier, total - 1 - EARLIER_PAGE_STEPS);
  assert.equal(page.events[0].seq, journal.turnStartAt(s.id, total - 1 - EARLIER_PAGE_STEPS));
  assert.equal(page.events[0].ev, "turn_started", "a page begins at a turn's opening event");
  assert.equal(page.events.at(-1)!.seq, before - 1, "and runs right up to `before`");
  // The next page back is the last one and takes the head (seq 0) along.
  const last = journal.earlierPage(s.id, page.events[0].seq as number);
  assert.equal(last.earlier, 0);
  assert.equal(last.events[0].seq, 0);
});

test("earlierPage at the head of the log is empty, not an error", () => {
  const s = owner();
  turn(s, 0);
  assert.deepEqual(journal.earlierPage(s.id, 0), { events: [], earlier: 0 });
  assert.deepEqual(journal.earlierPage(s.id, -1), { events: [], earlier: 0 });
});

test("replayFrames respects the `to` bound the attached event names", () => {
  const s = owner();
  for (let n = 0; n < 3; n += 1) turn(s, n);
  const to = journal.turnStartAt(s.id, 2)!;
  const frames = [...journal.replayFrames(s.id, 0, true, to)];
  const events = frames.flatMap((f) => (JSON.parse(f) as { events: { seq: number }[] }).events);
  assert.equal(events.length, to, "everything before the bound");
  assert.ok(events.every((e) => e.seq < to), "and nothing past it — that is the live stream's");
  // The frame is the wire shape the client's `handle` switch unrolls.
  assert.match(frames[0], /^\{"ev":"replay","events":\[/);
});

test("replayFrames cuts a frame on the byte budget", () => {
  const s = owner();
  for (let i = 0; i < 3; i += 1) journal.append(s, update("y".repeat(Math.ceil(REPLAY_CHUNK_BYTES * 0.6))));
  const frames = [...journal.replayFrames(s.id, 0, true)];
  assert.equal(frames.length, 3, "no two of these fit one frame");
  for (const frame of frames) {
    assert.equal((JSON.parse(frame) as { events: unknown[] }).events.length, 1);
  }
});

test("replayFrames cuts a frame on the count budget", () => {
  const s = owner();
  const total = REPLAY_CHUNK_SIZE + 10;
  for (let i = 0; i < total; i += 1) journal.append(s, update("z"));
  const frames = [...journal.replayFrames(s.id, 0, true)].map(
    (f) => (JSON.parse(f) as { events: unknown[] }).events.length,
  );
  assert.deepEqual(frames, [REPLAY_CHUNK_SIZE, 10]);
});

test("a client that did not opt into bulk gets bare events, not a replay frame", () => {
  const s = owner();
  turn(s, 0);
  const rows = [...journal.replayFrames(s.id, 0, false)];
  assert.equal(rows.length, 3);
  for (const row of rows) {
    const parsed = JSON.parse(row) as { ev: string };
    assert.notEqual(parsed.ev, "replay", "it would drop a frame it does not know");
  }
  assert.equal((JSON.parse(rows[0]) as { ev: string }).ev, "turn_started");
});

console.log(`\n${passed} passed${failures.length ? `, ${failures.length} failed: ${failures.join(", ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
