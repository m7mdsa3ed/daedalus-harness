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

await test("ftsQuery neutralizes FTS5 syntax", () => {
  assert.equal(ftsQuery("hello world"), '"hello" "world"*');
  assert.equal(ftsQuery('  spaced   out '), '"spaced" "out"*');
  assert.equal(ftsQuery('"foo AND'), '"""foo" "AND"*');
  assert.equal(ftsQuery('""'), null);
  assert.equal(ftsQuery("   "), null);
});

// An empty database: the backfill marks itself done, so the rows the tests
// index by hand below are never double-indexed by a second walk.
await test("backfill on an empty journal is a no-op that marks done", () => {
  backfillSearchIndex();
  backfillSearchIndex(); // idempotent
});

const now = Date.now();
const session = (id: string, title: string, projectId: string, deletedAt: number | null = null) =>
  db.insert(schema.sessions).values({
    id, profileId: "prof", projectId, agentId: "fake-echo", model: "", effort: "",
    title, createdAt: now, deletedAt,
  }).run();

db.insert(schema.projects).values({ id: "proj-1", name: "Harness", cwd: "/tmp" }).run();
session("s-alpha", "Login fixes", "proj-1");
session("s-beta", "Deploy notes", "proj-none");
session("s-gone", "Trashed", "proj-1", now);

const journal = (sessionId: string, seq: number, payload: object, at: number) => {
  const kind = (payload as { ev: string }).ev;
  db.insert(schema.sessionEvents).values({ sessionId, seq, kind, payload, at }).run();
  indexEventRow(db, { sessionId, seq, kind, payload, at });
};

journal("s-alpha", 0, { ev: "turn_started", seq: 0, turnId: "t1", text: "investigate the flaky login redirect" }, now - 3000);
journal("s-alpha", 1, chunk("agent_message_chunk", "the login redirect loops because the cookie is stale"), now - 2500);
journal("s-beta", 0, chunk("agent_message_chunk", "deploy went fine, no login issues at all"), now - 1000);
journal("s-gone", 0, chunk("agent_message_chunk", "login secrets of a trashed thread"), now - 500);

await test("searchEvents: shape, markers, resolution, order, trash filter", () => {
  const results = searchEvents("login");
  assert.ok(results.length >= 3, `expected hits, got ${results.length}`);
  // Newest first: s-beta's event is the most recent live one.
  assert.equal(results[0].sessionId, "s-beta");
  assert.equal(results[0].projectName, "", "unknown project resolves to empty, not a throw");
  const alpha = results.find((r) => r.sessionId === "s-alpha" && r.seq === 1);
  assert.ok(alpha, "agent prose is searchable");
  assert.equal(alpha!.title, "Login fixes");
  assert.equal(alpha!.projectId, "proj-1");
  assert.equal(alpha!.projectName, "Harness");
  assert.ok(alpha!.snippet.includes(`${SNIPPET_START}login${SNIPPET_END}`), `marked snippet, got: ${alpha!.snippet}`);
  assert.ok(!results.some((r) => r.sessionId === "s-gone"), "trashed threads are not searched");
});

await test("prefix search and operator input", () => {
  assert.ok(searchEvents("redir").some((r) => r.sessionId === "s-alpha"), "last term matches as a prefix");
  // Raw operators must not throw — merely match or not.
  assert.doesNotThrow(() => searchEvents('"login AND (NEAR'));
  assert.deepEqual(searchEvents('""'), []);
});

await test("one thread cannot fill the page", () => {
  for (let seq = 2; seq < 12; seq++) {
    journal("s-alpha", seq, chunk("agent_message_chunk", `still poking at login attempt ${seq}`), now - 100 + seq);
  }
  const hits = searchEvents("login").filter((r) => r.sessionId === "s-alpha");
  assert.equal(hits.length, 3);
});

await test("deleteSearchIndex drops a session's rows", () => {
  deleteSearchIndex(["s-alpha"]);
  assert.ok(!searchEvents("login").some((r) => r.sessionId === "s-alpha"));
  assert.ok(searchEvents("deploy").some((r) => r.sessionId === "s-beta"), "other sessions untouched");
});

await test("backfill indexes journal rows the index has never seen, once", async () => {
  const { sql } = await import("drizzle-orm");
  session("s-old", "Archived wisdom", "proj-1");
  db.insert(schema.sessionEvents).values({
    sessionId: "s-old", seq: 0, kind: "update",
    payload: chunk("agent_message_chunk", "an ancient zanzibar reference"), at: now,
  }).run();
  // Reset the marker the way an upgraded install arrives: rows exist, no index.
  db.run(sql`delete from search_meta where key = 'fts_backfill'`);
  db.run(sql`delete from session_events_fts`);
  backfillSearchIndex();
  assert.equal(searchEvents("zanzibar").length, 1);
  backfillSearchIndex(); // marked done — must not double-index
  assert.equal(searchEvents("zanzibar").length, 1);
});

if (failures.length) {
  console.error("search.test.ts FAILED\n" + failures.join("\n\n"));
  process.exit(1);
}
console.log(`search: ${passed} passed`);
