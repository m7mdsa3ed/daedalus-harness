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
import "./require-temp-data.js";
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
type JournaledEvent = import("../src/protocol.js").JournaledEvent;

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
}

const journal = new SessionJournal();

/** `replayFrames` is an async generator now, so a spread cannot drain it. */
async function collect(frames: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const frame of frames) out.push(frame);
  return out;
}

let sessions = 0;
/** A fresh session row (the events table cascades off it) plus its owner. */
async function owner(): Promise<JournalOwner> {
  const id = `sj-${++sessions}`;
  await db.insert(schema.sessions)
    .values({ id, profileId: "p", projectId: "w", agentId: "a", model: "", effort: "", title: id, createdAt: 1 })
    ;
  return { id, eventCount: 0 };
}

const update = (text: string): ThreadEvent =>
  ({ ev: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } }) as ThreadEvent;

/** An update no run can swallow: the frame budgets are measured in events, and
    a chunk is no longer one of those on the wire — consecutive chunks are the
    one item they draw (`coalescedPage`). A tool call is what a frame full of
    events actually looks like now. */
const solid = (text: string, id = "c"): ThreadEvent =>
  ({
    ev: "update",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: id,
      content: [{ type: "content", content: { type: "text", text } }],
    },
  }) as ThreadEvent;

/** A chunk that cannot be merged with the plain `update` ones: same shape, one
    field different. Every field but the text and the seq is part of the run's
    identity. */
const tagged = (text: string, messageId: string): ThreadEvent =>
  ({
    ev: "update",
    update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } },
  }) as ThreadEvent;

/** The events a replay of `[from, to)` puts on the wire, unbatched. */
async function replayed(sessionId: string, from = 0, to?: number): Promise<JournaledEvent[]> {
  const out: JournaledEvent[] = [];
  for await (const line of journal.replayFrames(sessionId, from, false, to)) {
    out.push(JSON.parse(line) as JournaledEvent);
  }
  return out;
}

/** The text of a chunk event, however many chunks it was journaled as. */
const chunkText = (event: JournaledEvent): string =>
  ((event as { update?: { content?: { text?: string } } }).update?.content?.text ?? "");

/** One whole turn: turn_started, `chunks` updates of `size` chars, turn_ended. */
function turn(session: JournalOwner, n: number, chunks = 1, size = 10): void {
  journal.append(session, { ev: "turn_started", turnId: `t${n}` } as unknown as ThreadEvent);
  for (let i = 0; i < chunks; i += 1) journal.append(session, update("x".repeat(size)));
  journal.append(session, { ev: "turn_ended", turnId: `t${n}`, stopReason: "end_turn" } as unknown as ThreadEvent);
}

/** The stored byte size of everything from `from` on — `length(payload)` over
    the same rows the window function reads, computed independently. */
async function tailBytes(sessionId: string, from: number): Promise<number> {
  return (await journal.eventsFrom(sessionId, from)).reduce(
    (sum, event) => sum + JSON.stringify(event).length,
    0,
  );
}

console.log("session-journal");

await test("append stamps a monotonic seq and reads flush the buffer first", async () => {
  const s = await owner();
  const first = journal.append(s, update("a"));
  const second = journal.append(s, update("b"));
  assert.equal((first as { seq?: number }).seq, 0);
  assert.equal((second as { seq?: number }).seq, 1);
  // No tick has passed — the rows are still buffered, and the read must not
  // be able to observe a log missing its newest events.
  const events = await journal.eventsFrom(s.id, 0);
  assert.equal(events.length, 2);
  assert.deepEqual((await events).map((e) => e.seq), [0, 1]);
});

await test("turn arithmetic: turnCount / turnStartAt / countTurnsBefore agree", async () => {
  const s = await owner();
  for (let n = 0; n < 4; n += 1) turn(s, n, 2);
  assert.equal(await journal.turnCount(s.id), 4);
  // Each turn is 4 events (started, 2 chunks, ended).
  assert.equal(await journal.turnStartAt(s.id, 0), 0);
  assert.equal(await journal.turnStartAt(s.id, 2), 8);
  assert.equal(await journal.turnStartAt(s.id, 4), null, "past the end is null, not a guess");
  assert.equal(await journal.countTurnsBefore(s.id, 0), 0);
  assert.equal(await journal.countTurnsBefore(s.id, 8), 2);
  assert.equal(await journal.countTurnsBefore(s.id), 4, "omitted is every turn, not a sentinel");
});

await test("the step budget cuts at a turn_started, and only when a turn is withheld", async () => {
  const s = await owner();
  for (let n = 0; n < 10; n += 1) turn(s, n);
  const cut = await journal.windowStart(s.id, 3, Number.MAX_SAFE_INTEGER);
  assert.equal(cut, await journal.turnStartAt(s.id, 7), "the newest 3 turns, from a turn boundary");
  assert.equal(await journal.countTurnsBefore(s.id, cut), 7, "what `earlier` will report");
  // A window at least as wide as the log withholds nothing and says 0.
  assert.equal(await journal.windowStart(s.id, 10, Number.MAX_SAFE_INTEGER), 0);
  assert.equal(await journal.windowStart(s.id, 60, Number.MAX_SAFE_INTEGER), 0);
});

await test("the byte budget binds when the steps do not", async () => {
  const s = await owner();
  turn(s, 0, 1, 60_000); // one fat turn — a build log
  for (let n = 1; n < 5; n += 1) turn(s, n, 1, 10); // four ordinary ones
  const cut = await journal.windowStart(s.id, 60, 30_000);
  assert.equal(cut, await journal.turnStartAt(s.id, 1), "the fat turn is what gets withheld");
  assert.ok((await tailBytes(s.id, cut)) <= 30_000, "what is sent fits the budget");
  assert.ok((await tailBytes(s.id, 0)) > 30_000, "what was cut did not");
  assert.equal(await journal.countTurnsBefore(s.id, cut), 1);
});

await test("steps are applied first, so the byte pass never widens past the step floor", async () => {
  const s = await owner();
  turn(s, 0, 1, 60_000);
  for (let n = 1; n < 5; n += 1) turn(s, n, 1, 10);
  // Steps allow only the newest 2; bytes would have allowed turns 1-4. The
  // narrower answer wins — whichever budget binds first.
  const cut = await journal.windowStart(s.id, 2, 30_000);
  assert.equal(cut, await journal.turnStartAt(s.id, 3));
});

await test("one enormous turn is sent whole rather than the cut breaking the turn rule", async () => {
  const s = await owner();
  for (let n = 0; n < 3; n += 1) turn(s, n, 1, 10);
  turn(s, 3, 4, 50_000); // the newest turn alone busts the budget
  const cut = await journal.windowStart(s.id, 60, 20_000);
  // Not a blank transcript, and not a cut inside the turn: the newest
  // turn_started, budget missed rather than rule broken.
  assert.equal(cut, await journal.turnStartAt(s.id, 3));
  assert.ok((await tailBytes(s.id, cut)) > 20_000);
});

await test("revive: a log that is all head (no turn_started) replays whole from 0", async () => {
  // What `session/load` refills the journal with: the prior conversation as
  // updates, with no turn boundaries in it at all.
  const s = await owner();
  for (let i = 0; i < 20; i += 1) journal.append(s, update(`loaded ${i}`));
  assert.equal(await journal.windowStart(s.id, 5, Number.MAX_SAFE_INTEGER), 0);
  assert.equal(await journal.countTurnsBefore(s.id), 0, "`earlier` says 0 too");
});

await test("revive: a head plus one turn inside the window replays whole — the regression", async () => {
  // The exact bug the comment in windowStart names: jumping unconditionally to
  // "the first turn of the window" replayed from the turn's seq and dropped
  // everything the load had put back, while `earlier` said 0 so nothing
  // offered it back either.
  const s = await owner();
  for (let i = 0; i < 20; i += 1) journal.append(s, update(`loaded ${i}`));
  turn(s, 0);
  assert.equal(await journal.turnStartAt(s.id, 0), 20, "the one turn starts past the head");
  assert.equal(await journal.windowStart(s.id, 60, Number.MAX_SAFE_INTEGER), 0, "nothing is withheld, so no cut");
});

await test("revive: when the window does cut, the head belongs to the oldest page", async () => {
  const s = await owner();
  for (let i = 0; i < 20; i += 1) journal.append(s, update(`loaded ${i}`));
  for (let n = 0; n < 6; n += 1) turn(s, n);
  const cut = await journal.windowStart(s.id, 2, Number.MAX_SAFE_INTEGER);
  assert.equal(cut, await journal.turnStartAt(s.id, 4), "a real cut: two turns shown, four withheld");
  assert.equal(await journal.countTurnsBefore(s.id, cut), 4);
  // Paging back from the cut reaches the oldest turn, and that page extends to
  // seq 0: the head is not a turn, so it can never be a page of its own.
  const page = await journal.earlierPage(s.id, cut);
  assert.equal(page.earlier, 0, "no whole turns behind this page");
  assert.equal(page.from, 0, "the head came along");
  const stored = (await journal.eventsFrom(s.id, 0, cut)).map(chunkText).join("");
  assert.equal(
    page.events.map(chunkText).join(""),
    stored,
    "every character below the cut, exactly once — merged, not dropped",
  );
  assert.equal(page.events.at(-1)!.seq, cut - 1, "and it runs right up to the cut");
});

await test("earlierPage pages whole turns and counts what is still behind", async () => {
  const s = await owner();
  const total = EARLIER_PAGE_STEPS + 5;
  for (let n = 0; n < total; n += 1) turn(s, n);
  const before = (await journal.turnStartAt(s.id, total - 1))!;
  const page = await journal.earlierPage(s.id, before);
  // A full page of whole turns, newest-first capped then re-ordered.
  assert.equal(page.earlier, total - 1 - EARLIER_PAGE_STEPS);
  assert.equal(page.from, await journal.turnStartAt(s.id, total - 1 - EARLIER_PAGE_STEPS));
  assert.equal(page.events[0].seq, page.from, "a turn_started is never merged, so it keeps its seq");
  assert.equal(page.events[0].ev, "turn_started", "a page begins at a turn's opening event");
  assert.equal((await page).events.at(-1)!.seq, before - 1, "and runs right up to `before`");
  // The next page back is the last one and takes the head (seq 0) along.
  const last = await journal.earlierPage(s.id, page.from);
  assert.equal(last.earlier, 0);
  assert.equal(last.from, 0);
});

await test("earlierPage at the head of the log is empty, not an error", async () => {
  const s = await owner();
  turn(s, 0);
  assert.deepEqual(await journal.earlierPage(s.id, 0), { events: [], from: 0, earlier: 0 });
  assert.deepEqual(await journal.earlierPage(s.id, -1), { events: [], from: 0, earlier: 0 });
});

await test("trace pages newest-first with the journaled clock on each row", async () => {
  const s = await owner();
  for (let n = 0; n < 3; n += 1) turn(s, n, 2);
  const head = s.eventCount;
  const page = await journal.trace(s.id, head, 4);
  // Four events, oldest first within the page, right up to the head.
  assert.equal(page.length, 4);
  assert.equal(page[0].seq, head - 4);
  assert.equal((await page).at(-1)!.seq, head - 1);
  for (const row of page) {
    assert.equal(typeof row.at, "number");
    assert.equal(row.ev, row.payload.ev, "the kind column duplicates the payload discriminant");
  }
  // A window of zero is empty rather than the head of the log.
  assert.deepEqual(await journal.trace(s.id, 0, 4), []);
});

await test("replayFrames respects the `to` bound the attached event names", async () => {
  const s = await owner();
  for (let n = 0; n < 3; n += 1) turn(s, n);
  const to = (await journal.turnStartAt(s.id, 2))!;
  const frames = await collect(journal.replayFrames(s.id, 0, true, to));
  const events = frames.flatMap((f) => (JSON.parse(f) as { events: { seq: number }[] }).events);
  assert.equal(events.length, to, "everything before the bound");
  assert.ok(events.every((e) => e.seq < to), "and nothing past it — that is the live stream's");
  // The frame is the wire shape the client's `handle` switch unrolls.
  assert.match(frames[0], /^\{"ev":"replay","events":\[/);
});

await test("replayFrames cuts a frame on the byte budget", async () => {
  const s = await owner();
  for (let i = 0; i < 3; i += 1) journal.append(s, solid("y".repeat(Math.ceil(REPLAY_CHUNK_BYTES * 0.6)), `c${i}`));
  const frames = await collect(journal.replayFrames(s.id, 0, true));
  assert.equal(frames.length, 3, "no two of these fit one frame");
  for (const frame of frames) {
    assert.equal((JSON.parse(frame) as { events: unknown[] }).events.length, 1);
  }
});

await test("replayFrames cuts a frame on the count budget", async () => {
  const s = await owner();
  const total = REPLAY_CHUNK_SIZE + 10;
  for (let i = 0; i < total; i += 1) journal.append(s, solid("z", `c${i}`));
  const frames = (await collect(journal.replayFrames(s.id, 0, true))).map(
    (f) => (JSON.parse(f) as { events: unknown[] }).events.length,
  );
  assert.deepEqual(frames, [REPLAY_CHUNK_SIZE, 10]);
});

await test("a client that did not opt into bulk gets bare events, not a replay frame", async () => {
  const s = await owner();
  turn(s, 0);
  const rows = await collect(journal.replayFrames(s.id, 0, false));
  assert.equal(rows.length, 3);
  for (const row of rows) {
    const parsed = JSON.parse(row) as { ev: string };
    assert.notEqual(parsed.ev, "replay", "it would drop a frame it does not know");
  }
  assert.equal((JSON.parse(rows[0]) as { ev: string }).ev, "turn_started");
});

await test("turnTicks returns one entry per turn, oldest first, with excerpts", async () => {
  const s = await owner();
  for (let n = 0; n < 3; n += 1) turn(s, n, 2, 10);
  const ticks = await journal.turnTicks(s.id);
  assert.equal(ticks.length, 3);
  assert.deepEqual((await ticks).map((t) => t.turnId), ["t0", "t1", "t2"]);
  // Each turn is 4 events (started, 2 chunks, ended), so the seqs are the
  // turn_started rows — what a client paging backwards walks towards.
  assert.deepEqual((await ticks).map((t) => t.seq), [0, 4, 8]);
  assert.equal(ticks[0].reply, `${"x".repeat(10)}\n${"x".repeat(10)}`);
});

await test("turnTicks skips a subagent's chunks and caps a build-log turn", async () => {
  const s = await owner();
  journal.append(s, { ev: "turn_started", turnId: "t0" } as unknown as ThreadEvent);
  journal.append(s, update("plain"));
  journal.append(
    s,
    { ev: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "child" } }, sessionId: "sub-1" } as unknown as ThreadEvent,
  );
  journal.append(s, update("y".repeat(REPLAY_CHUNK_BYTES)));
  const ticks = await journal.turnTicks(s.id);
  assert.equal(ticks.length, 1);
  assert.ok(!ticks[0].reply.includes("child"), "the child's prose is its report, not the answer");
  assert.ok(ticks[0].reply.length <= 240, "a build-log turn costs its prefix, not its megabytes");
});

/* ---- coalescing: a run of streamed chunks is the one event it draws ---- */

await test("a run of chunks replays as one event, standing at the run's last seq", async () => {
  const s = await owner();
  journal.append(s, { ev: "turn_started", turnId: "t0" } as unknown as ThreadEvent);
  for (const piece of ["Let", " me", " think", " about", " this"]) journal.append(s, update(piece));
  journal.append(s, { ev: "turn_ended", turnId: "t0", stopReason: "end_turn" } as unknown as ThreadEvent);
  const events = await replayed(s.id);
  assert.deepEqual(events.map((e) => e.ev), ["turn_started", "update", "turn_ended"]);
  assert.equal(chunkText(events[1]), "Let me think about this", "the text is whole, in order");
  /* The cursor rule: a client folds this event and moves to `seq + 1`, so the
     seq has to be the last chunk's — the first would make a reconnect ask for
     chunks it already holds. */
  assert.equal(events[1].seq, 5, "the run's last chunk, not its first");
  assert.equal(events[2].seq, 6, "and the log's own numbering is untouched");
});

await test("a resume inside a run gets the tail of it, exactly once", async () => {
  // The reason this is a read and not a write: the journal still holds one row
  // per chunk, so a cursor landing mid-run cuts the run where the cursor is.
  const s = await owner();
  for (const piece of ["aa", "bb", "cc", "dd"]) journal.append(s, update(piece));
  assert.equal(chunkText((await replayed(s.id, 2))[0]), "ccdd", "from seq 2 on, and nothing before it");
  assert.equal(chunkText((await replayed(s.id, 0, 2))[0]), "aabb", "and the bound holds on the other side");
  const whole = (await replayed(s.id)).map(chunkText).join("");
  const split = [...(await replayed(s.id, 0, 2)), ...(await replayed(s.id, 2))].map(chunkText).join("");
  assert.equal(split, whole, "a resume rebuilds exactly what one read would have");
});

await test("a run is only what is identical apart from its text", async () => {
  const s = await owner();
  journal.append(s, update("one"));
  journal.append(s, tagged("two", "m1")); // a messageId the first chunk did not carry
  journal.append(s, tagged("three", "m1"));
  journal.append(s, tagged("four", "m2")); // a different message
  journal.append(s, solid("a tool"));
  journal.append(s, update("five"));
  const events = await replayed(s.id);
  assert.deepEqual(events.map(chunkText), ["one", "twothree", "four", "", "five"]);
  assert.equal(events.length, 5, "a field that differs breaks the run, and a tool call ends it");
});

await test("a run never crosses a turn boundary", async () => {
  const s = await owner();
  turn(s, 0, 3);
  turn(s, 1, 3);
  const events = await replayed(s.id);
  assert.deepEqual(
    events.map((e) => e.ev),
    ["turn_started", "update", "turn_ended", "turn_started", "update", "turn_ended"],
  );
});

await test("the byte budget measures what the wire carries, not the envelope", async () => {
  /* The regression this is pinned against: 81,686 thought chunks holding
     0.33MB of text inside 15.1MB of envelope. Counted as stored, a turn like
     this busts every budget and is withheld; counted as sent, it is a page of
     prose. */
  const s = await owner();
  turn(s, 0, 1, 10);
  journal.append(s, { ev: "turn_started", turnId: "t1" } as unknown as ThreadEvent);
  for (let i = 0; i < 2_000; i += 1) journal.append(s, update("wor")); // 6KB of text, ~200KB of rows
  journal.append(s, { ev: "turn_ended", turnId: "t1", stopReason: "end_turn" } as unknown as ThreadEvent);
  assert.ok((await tailBytes(s.id, 0)) > 100_000, "as stored, far past the budget");
  assert.equal(
    await journal.windowStart(s.id, 60, 100_000),
    0,
    "as sent it is 6KB, so nothing is withheld",
  );
});

console.log(`\n${passed} passed${failures.length ? `, ${failures.length} failed: ${failures.join(", ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
