// Self-check for `@thread:<id>` (src/mentions/thread-recap.ts, resolvers/thread.ts):
// the recap is built from the journal and the thread's row, never a live
// bridge — whole-thread and `#turn-N` shapes, the appended `<context>` /
// `<tasks>` blocks stripped from user messages, a subagent's chunks ignored,
// the cap and its hint (only when cut), files from turn attribution, an unknown
// or deleted id answering nothing, and a short id resolving by unique prefix.
// Run: pnpm test:mention-threads
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

rmSync(process.env.DAEDALUS_DATA_DIR!, { recursive: true, force: true });

const { db, schema } = await import("../src/db/index.js");
const { SessionJournal } = await import("../src/session-journal.js");
const { buildRecap, findThreadId, loadThread, parseThreadRef, stripAppended, RECAP_CAP, TRUNCATED_HINT } = await import(
  "../src/mentions/thread-recap.js"
);
const { threadResolver } = await import("../src/mentions/resolvers/thread.js");
const { expandMentions } = await import("../src/mentions/index.js");
type ThreadEvent = import("../src/protocol.js").ThreadEvent;

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
await db.insert(schema.projects).values({ id: "proj-1", name: "Harness", cwd: "/tmp" });

const chunk = (kind: "agent" | "user", text: string, extra: object = {}): ThreadEvent =>
  ({ ev: "update", update: { sessionUpdate: `${kind}_message_chunk`, content: { type: "text", text } }, ...extra }) as unknown as ThreadEvent;
const started = (n: number, text: string): ThreadEvent => ({ ev: "turn_started", turnId: `t${n}`, text }) as unknown as ThreadEvent;
const ended = (n: number): ThreadEvent => ({ ev: "turn_ended", turnId: `t${n}`, usage: null }) as unknown as ThreadEvent;

/** A thread row plus its journal: `turns` is [user, answer chunks[]]. */
async function seed(id: string, title: string, turns: [string, string[]][], opts: { deleted?: boolean } = {}) {
  await db.insert(schema.sessions).values({
    id,
    profileId: "p",
    projectId: "proj-1",
    agentId: "claude-code",
    model: "sonnet",
    effort: "",
    title,
    createdAt: 1_700_000_000_000,
    lastActivityAt: 1_700_000_900_000,
    deletedAt: opts.deleted ? 1 : null,
  });
  const owner = { id, eventCount: 0 };
  turns.forEach(([user, answer], i) => {
    journal.append(owner, started(i + 1, user));
    // Tool traffic in between is not part of a recap.
    journal.append(owner, { ev: "update", update: { sessionUpdate: "tool_call", toolCallId: "c", title: "Read" } } as unknown as ThreadEvent);
    for (const piece of answer) journal.append(owner, chunk("agent", piece));
    journal.append(owner, ended(i + 1));
  });
  await journal.flush();
  return owner;
}

console.log("mention-threads");

await test("parseThreadRef: bare, #turn-N, and a malformed suffix", () => {
  assert.deepEqual(parseThreadRef("abc"), { id: "abc" });
  assert.deepEqual(parseThreadRef("abc#turn-3"), { id: "abc", turn: 3 });
  assert.ok(Number.isNaN(parseThreadRef("abc#nope").turn));
});

await test("stripAppended drops the trailing context and tasks blocks only", () => {
  const sent = "fix it @thread:x\n\n<tasks>\nA\n</tasks>\n\n<context>\nB\n</context>";
  assert.equal(stripAppended(sent), "fix it @thread:x");
  assert.equal(stripAppended("explain the <context> tag"), "explain the <context> tag");
});

await seed("th-recap-0001", "Fix the login bug", [
  ["Why does login fail?\n\n<context>\nold\n</context>", ["It fails ", "because of a stale token."]],
  ["Please patch it", ["Done, ", "patched ", "auth.ts."]],
  ["Add a test too", ["Added ", "login.test.ts."]],
]);
await db.insert(schema.sessionTurnChanges).values([
  { sessionId: "th-recap-0001", turnId: "t2", files: [{ path: "src/auth.ts", status: "modified", additions: 4, deletions: 1, binary: false }], startedAt: 1, endedAt: 2 },
  { sessionId: "th-recap-0001", turnId: "t3", files: [{ path: "test/login.test.ts", status: "added", additions: 20, deletions: 0, binary: false }], startedAt: 3, endedAt: 4 },
]);

await test("loadThread folds the journal into turns, skipping tool traffic and appended blocks", async () => {
  const thread = await loadThread("th-recap-0001");
  assert.ok(thread);
  assert.equal(thread.title, "Fix the login bug");
  assert.equal(thread.projectName, "Harness");
  assert.deepEqual(
    thread.turns.map((t) => [t.user, t.answer]),
    [
      ["Why does login fail?", "It fails because of a stale token."],
      ["Please patch it", "Done, patched auth.ts."],
      ["Add a test too", "Added login.test.ts."],
    ],
  );
});

await test("the whole-thread recap names title, project, agent, times, first/last message, answer and files", async () => {
  const recap = buildRecap((await loadThread("th-recap-0001"))!)!;
  assert.match(recap, /^Thread: Fix the login bug\nProject: Harness\nAgent: claude-code · sonnet/);
  assert.match(recap, /Created: 2023-11-14T22:13Z/);
  assert.match(recap, /Turns: 3/);
  assert.match(recap, /Files changed: src\/auth\.ts \(\+4 -1\), test\/login\.test\.ts \(\+20 -0\)/);
  assert.match(recap, /First user message:\nWhy does login fail\?/);
  assert.match(recap, /Last user message:\nAdd a test too/);
  assert.match(recap, /Last assistant answer:\nAdded login\.test\.ts\.$/);
  assert.ok(!recap.includes(TRUNCATED_HINT), "an uncut recap carries no hint");
});

await test("#turn-N returns that turn's message, answer and files; a missing turn is nothing", async () => {
  const thread = (await loadThread("th-recap-0001"))!;
  const recap = buildRecap(thread, 2)!;
  assert.match(recap, /Turn: 2 of 3/);
  assert.match(recap, /User message:\nPlease patch it/);
  assert.match(recap, /Assistant answer:\nDone, patched auth\.ts\./);
  assert.match(recap, /Files changed: src\/auth\.ts/);
  assert.ok(!recap.includes("login.test.ts"));
  assert.equal(buildRecap(thread, 4), null);
  assert.equal(buildRecap(thread, 0), null);
  assert.equal(buildRecap(thread, Number.NaN), null);
});

await test("a one-turn thread says 'User message' once; an empty one says so", async () => {
  await seed("th-single-0001", "Single", [["only question", ["only answer"]]]);
  const single = buildRecap((await loadThread("th-single-0001"))!)!;
  assert.match(single, /User message:\nonly question/);
  assert.ok(!single.includes("First user message"));
  await seed("th-empty-00001", "Empty", []);
  assert.match(buildRecap((await loadThread("th-empty-00001"))!)!, /\(no messages yet\)/);
});

await test("a subagent's chunks are not the thread's answer", async () => {
  const owner = await seed("th-sub-000001", "Sub", [["go", ["real answer"]]]);
  journal.append(owner, chunk("agent", " + child noise", { sessionId: "child-1" }));
  await journal.flush();
  const thread = (await loadThread("th-sub-000001"))!;
  assert.equal(thread.turns[0]!.answer, "real answer");
});

await test("a load-refilled head (replayed user chunks, no turn_started) still reads", async () => {
  const id = "th-replay-0001";
  await db.insert(schema.sessions).values({ id, profileId: "p", projectId: "proj-1", agentId: "a", model: "", effort: "", title: "Replayed", createdAt: 1 });
  const owner = { id, eventCount: 0 };
  journal.append(owner, chunk("user", "hello ", { historyReplay: true }));
  journal.append(owner, chunk("user", "there", { historyReplay: true }));
  journal.append(owner, chunk("agent", "hi", { historyReplay: true }));
  await journal.flush();
  const thread = (await loadThread(id))!;
  assert.deepEqual(thread.turns.map((t) => [t.user, t.answer]), [["hello there", "hi"]]);
});

await test("the cap holds, and only a cut recap says so", async () => {
  await seed("th-big-0000001", "Big", [["q", ["a".repeat(20_000)]]]);
  const big = buildRecap((await loadThread("th-big-0000001"))!)!;
  assert.ok(big.length <= RECAP_CAP, `recap is ${big.length}`);
  assert.ok(big.endsWith(TRUNCATED_HINT));
  const turn = buildRecap((await loadThread("th-big-0000001"))!, 1, 1_000)!;
  assert.ok(turn.length <= 1_000);
  assert.ok(turn.endsWith(TRUNCATED_HINT));
});

await test("unknown, deleted and ambiguous ids resolve to nothing; a unique prefix resolves", async () => {
  await seed("th-gone-000001", "Gone", [["x", ["y"]]], { deleted: true });
  assert.equal(await findThreadId("nope"), null);
  assert.equal(await findThreadId("th-gone-000001"), null, "deleted");
  assert.equal(await findThreadId("th-recap-0001"), "th-recap-0001");
  assert.equal(await findThreadId("th-recap"), "th-recap-0001", "unique prefix");
  assert.equal(await findThreadId("th-"), null, "ambiguous prefix, and too short");
  assert.equal(await findThreadId("th-%"), null, "no wildcards");
});

await test("the resolver claims every ref but only answers for threads it can read", async () => {
  const out = await threadResolver.resolve(["th-recap-0001", "th-recap-0001#turn-3", "missing", "th-recap-0001#turn-9"], {
    projectId: "proj-1",
    cwd: "/tmp",
    budget: 30_000,
  });
  assert.deepEqual(out.claimed, ["th-recap-0001", "th-recap-0001#turn-3", "missing", "th-recap-0001#turn-9"]);
  assert.deepEqual(out.blocks.map((b) => b.ref), ["th-recap-0001", "th-recap-0001#turn-3"]);
});

await test("expandMentions appends a <context> block for a thread and nothing for a missing one", async () => {
  const scope = { projectId: "proj-1", cwd: "/tmp" };
  const out = await expandMentions("see @thread:th-recap-0001#turn-1 and @thread:missing", scope);
  assert.match(out.text, /<mention kind="thread" ref="th-recap-0001#turn-1">\nThread: Fix the login bug/);
  assert.ok(!out.text.includes('ref="missing"'));
  assert.deepEqual([...out.claimed].sort(), ["thread:missing", "thread:th-recap-0001#turn-1"]);
  assert.equal((await expandMentions("@thread:missing", scope)).text, "");
});

if (failures.length > 0) {
  console.log(`\n${failures.length} failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`mention-threads: ${passed} ok`);
process.exit(0);
