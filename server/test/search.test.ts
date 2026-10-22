// Self-check for full-text thread search (src/search.ts):
//   - the extractor pulls prose (message/thought chunks, turn_started prompts,
//     tool titles) and nothing else out of journaled payloads.
//   - ftsQuery cannot produce a MATCH expression that throws — raw FTS5
//     operators and unbalanced quotes are neutralized.
//   - searchEvents returns the route's shape: snippet with the private-use
//     markers, title/project resolved, newest first, trashed threads excluded,
//     one thread capped so it cannot fill the page.
//   - deleteSearchIndex drops a session's rows (revive/purge path).
//   - backfillSearchIndex indexes pre-existing journal rows exactly once.
// Run: pnpm test:search
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DATA = process.env.DAEDALUS_DATA_DIR!;
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
writeFileSync(
  join(DATA, "config.json"),
  JSON.stringify({ token: "x", host: "127.0.0.1", port: 8798, sessionIdleMinutes: 30 }),
);

const {
  SNIPPET_END,
  SNIPPET_START,
  backfillSearchIndex,
  deleteSearchIndex,
  extractSearchText,
  ftsQuery,
  indexEventRow,
  searchEvents,
} = await import("../src/search.js");
const { db, schema } = await import("../src/db/index.js");

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    failures.push(`${name}\n    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}

const chunk = (kind: string, text: string) => ({
  ev: "update",
  seq: 0,
  update: { sessionUpdate: kind, content: { type: "text", text } },
  historyReplay: false,
});

await test("extractor: prose in, noise out", () => {
  assert.equal(extractSearchText("turn_started", { ev: "turn_started", seq: 0, turnId: "t", text: "fix the login bug" }), "fix the login bug");
  assert.equal(extractSearchText("update", chunk("agent_message_chunk", "I fixed it")), "I fixed it");
  assert.equal(extractSearchText("update", chunk("user_message_chunk", "please")), "please");
  assert.equal(extractSearchText("update", chunk("agent_thought_chunk", "hmm")), "hmm");
  // A tool call contributes its title only — never rawInput/rawOutput.
  assert.equal(
    extractSearchText("update", {
      ev: "update",
      update: { sessionUpdate: "tool_call", title: "Read config.ts", rawInput: { secret: "nope" } },
    }),
    "Read config.ts",
  );
  assert.equal(extractSearchText("update", { ev: "update", update: { sessionUpdate: "tool_call_update", rawOutput: { text: "noise" } } }), null);
  assert.equal(extractSearchText("update", { ev: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "x" } } }), null);
  assert.equal(extractSearchText("turn_ended", { ev: "turn_ended" }), null);
  assert.equal(extractSearchText("update", chunk("agent_message_chunk", "   ")), null);
  assert.equal(extractSearchText("update", "not an object"), null);
});

await test("ftsQuery neutralizes tsquery syntax", () => {
  // Postgres `to_tsquery`, not FTS5: every term is quoted so a raw operator or
  // an unbalanced quote is a term rather than syntax, and only the last one
  // gets the `:*` prefix so the query narrows rather than expanding every word.
  assert.equal(ftsQuery("hello world"), "'hello' & 'world':*");
  assert.equal(ftsQuery('  spaced   out '), "'spaced' & 'out':*");
  assert.equal(ftsQuery('"foo AND'), "'\"foo' & 'AND':*");
  assert.equal(ftsQuery('""'), null);
  assert.equal(ftsQuery("   "), null);
});

// An empty database: the backfill marks itself done, so the rows the tests
// index by hand below are never double-indexed by a second walk.
await test("backfill on an empty journal is a no-op that marks done", async () => {
  (await backfillSearchIndex());
  (await backfillSearchIndex()); // idempotent
});

const now = Date.now();
const session = async (id: string, title: string, projectId: string, deletedAt: number | null = null) =>
  await db.insert(schema.sessions).values({
    id, profileId: "prof", projectId, agentId: "test-agent", model: "", effort: "",
    title, createdAt: now, deletedAt,
  });

await db.insert(schema.projects).values({ id: "proj-1", name: "Harness", cwd: "/tmp" });
await session("s-alpha", "Login fixes", "proj-1");
await session("s-beta", "Deploy notes", "proj-none");
await session("s-gone", "Trashed", "proj-1", now);

const journal = async (sessionId: string, seq: number, payload: object, at: number) => {
  const kind = (payload as { ev: string }).ev;
  await db.insert(schema.sessionEvents).values({ sessionId, seq, kind, payload, at });
  await indexEventRow(db, { sessionId, seq, kind, payload, at });
};

await journal("s-alpha", 0, { ev: "turn_started", seq: 0, turnId: "t1", text: "investigate the flaky login redirect" }, now - 3000);
await journal("s-alpha", 1, chunk("agent_message_chunk", "the login redirect loops because the cookie is stale"), now - 2500);
await journal("s-beta", 0, { ev: "turn_started", seq: 0, turnId: "t2", text: "deploy notes" }, now - 1500);
await journal("s-beta", 1, chunk("agent_message_chunk", "deploy went fine, no login issues at all"), now - 1000);
await journal("s-gone", 0, { ev: "turn_started", seq: 0, turnId: "t3", text: "trashed prompt" }, now - 600);
await journal("s-gone", 1, chunk("agent_message_chunk", "login secrets of a trashed thread"), now - 500);

await test("searchEvents: shape, markers, resolution, order, trash filter", async () => {
  const results = await searchEvents("login");
  assert.ok(results.length >= 3, `expected hits, got ${results.length}`);
  // Newest first: s-beta's event is the most recent live one.
  assert.equal(results[0].sessionId, "s-beta");
  assert.equal(results[0].projectName, "", "unknown project resolves to empty, not a throw");
  const alpha = (await results).find((r) => r.sessionId === "s-alpha" && r.seq === 1);
  assert.ok(alpha, "agent prose is searchable");
  assert.equal(alpha!.title, "Login fixes");
  assert.equal(alpha!.projectId, "proj-1");
  assert.equal(alpha!.projectName, "Harness");
  assert.equal(alpha!.turnId, "t1");
  assert.equal(alpha!.turnSeq, 0);
  assert.ok(alpha!.snippet.includes(`${SNIPPET_START}login${SNIPPET_END}`), `marked snippet, got: ${alpha!.snippet}`);
  assert.ok(!(await results).some((r) => r.sessionId === "s-gone"), "trashed threads are not searched");
});

await test("session-scoped search only returns that thread and its turn", async () => {
  const results = await searchEvents("login", 30, "s-alpha");
  assert.ok(results.length > 0);
  assert.ok(results.every((result) => result.sessionId === "s-alpha"));
  assert.ok(results.every((result) => result.turnId === "t1" && result.turnSeq === 0));
  assert.deepEqual(await searchEvents("login", 30, "missing-session"), []);
});

await test("prefix search and operator input", async () => {
  assert.ok((await searchEvents("redir")).some((r) => r.sessionId === "s-alpha"), "last term matches as a prefix");
  // Raw operators must not throw — merely match or not.
  assert.doesNotThrow(async () => (await searchEvents('"login AND (NEAR')));
  assert.deepEqual((await searchEvents('""')), []);
});

await test("one thread cannot fill the page", async () => {
  for (let seq = 2; seq < 12; seq++) {
    await journal("s-alpha", seq, chunk("agent_message_chunk", `still poking at login attempt ${seq}`), now - 100 + seq);
  }
  const hits = (await searchEvents("login")).filter((r) => r.sessionId === "s-alpha");
  assert.equal(hits.length, 3);
});

await test("deleteSearchIndex drops a session's rows", async () => {
  await deleteSearchIndex(["s-alpha"]);
  assert.ok(!(await searchEvents("login")).some((r) => r.sessionId === "s-alpha"));
  assert.ok((await searchEvents("deploy")).some((r) => r.sessionId === "s-beta"), "other sessions untouched");
});

await test("backfill indexes journal rows the index has never seen, once", async () => {
  const { sql } = await import("drizzle-orm");
  await session("s-old", "Archived wisdom", "proj-1");
  await db.insert(schema.sessionEvents).values({
    sessionId: "s-old", seq: 0, kind: "update",
    payload: chunk("agent_message_chunk", "an ancient zanzibar reference"), at: now,
  });
  // Reset the marker the way an upgraded install arrives: rows exist, no index.
  await db.execute(sql`delete from search_meta where key = 'fts_backfill'`);
  await db.execute(sql`delete from session_events_fts`);
  await backfillSearchIndex();
  assert.equal((await searchEvents("zanzibar")).length, 1);
  await backfillSearchIndex(); // marked done — must not double-index
  assert.equal((await searchEvents("zanzibar")).length, 1);
});

if (failures.length) {
  console.error("search.test.ts FAILED\n" + failures.join("\n\n"));
  process.exit(1);
}
console.log(`search: ${passed} passed`);
