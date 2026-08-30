// Self-check for backup.ts: export → import round-trips every table, `replace`
// empties what the bundle does not name, `merge` keeps it, and a redacted
// bundle merged over the install it came from keeps the install's secrets.
//
// Runs against a real (temp) database — importing db/index.js migrates
// whatever DAEDALUS_DATA_DIR points at. Run: pnpm test:backup
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  agents as agentsTable,
  commands as commandsTable,
  db,
  knowledge as knowledgeTable,
  mcpServers as mcpServersTable,
  profileMcpServers,
  profiles as profilesTable,
  projects as projectsTable,
  sessionEvents as eventsTable,
  sessionQueue as queueTable,
  sessions as sessionsTable,
  skills as skillsTable,
  tasks as tasksTable,
} from "../src/db/index.js";
import { BundleSchema, exportBundle, importBundle, type Bundle } from "../src/backup.js";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push(`${name}\n    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}

function wipe() {
  for (const table of [sessionsTable, profilesTable, projectsTable, mcpServersTable, skillsTable, commandsTable, agentsTable, tasksTable]) {
    db.delete(table).run();
  }
}

/** A small install: one of everything that links to something else. */
function seed() {
  wipe();
  const now = 1_700_000_000_000;
  db.insert(agentsTable).values({ id: "fake", name: "Fake", command: "node", args: ["a.mjs"], env: { K: "{apiKey}" }, seededVersion: 1 }).run();
  db.insert(mcpServersTable).values({ id: "m1", type: "http", name: "srv", url: "http://x", headers: [{ name: "Authorization", value: "Bearer s3cret" }] }).run();
  db.insert(skillsTable).values({ id: "s1", name: "skill", path: "/tmp/skill" }).run();
  db.insert(commandsTable).values({ id: "c1", name: "go", description: "d", content: "body" }).run();
  db.insert(profilesTable).values({ id: "p1", name: "gw", agents: { fake: {} }, baseUrl: "http://gw", apiKey: "sk-live", defaultModel: "m", smallModel: "", logoUrl: "", models: [{ id: "m", label: "M", reasoningEfforts: [] }] }).run();
  db.insert(profileMcpServers).values({ profileId: "p1", mcpServerId: "m1" }).run();
  db.insert(projectsTable).values({ id: "w1", name: "ws", cwd: "/tmp/ws", logoUrl: "" }).run();
  db.insert(knowledgeTable).values({ id: "k1", projectId: "w1", title: "t", content: "c", createdAt: now, updatedAt: now }).run();
  db.insert(sessionsTable).values({ id: "t1", profileId: "p1", projectId: "w1", agentId: "fake", model: "m", effort: "", title: "Thread", acpSessionId: "acp-1", createdAt: now }).run();
  db.insert(eventsTable).values([
    { sessionId: "t1", seq: 0, kind: "turn_started", payload: { ev: "turn_started", turnId: "x" }, at: now },
    { sessionId: "t1", seq: 1, kind: "turn_ended", payload: { ev: "turn_ended", turnId: "x" }, at: now },
  ]).run();
  db.insert(queueTable).values({ id: "q1", sessionId: "t1", position: 0, text: "later", createdAt: now }).run();
  db.insert(tasksTable).values({ id: "task1", title: "Do it", createdAt: now, updatedAt: now }).run();
}

const count = (table: SQLiteTable) => db.select().from(table).all().length;

test("a full export round-trips through the schema", () => {
  seed();
  const bundle = exportBundle({ includeSecrets: true, includeJournals: true });
  const parsed = BundleSchema.safeParse(JSON.parse(JSON.stringify(bundle)));
  assert.ok(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues));
  assert.equal(bundle.profiles[0]!.apiKey, "sk-live");
  assert.deepEqual(bundle.profiles[0]!.mcpServerIds, ["m1"]);
  assert.equal(bundle.events.length, 2);
  assert.equal(bundle.queue.length, 1);
});

test("a redacted export carries no secrets", () => {
  seed();
  const bundle = exportBundle({ includeSecrets: false, includeJournals: false });
  assert.equal("apiKey" in bundle.profiles[0]!, false);
  assert.deepEqual(bundle.mcpServers[0]!.headers, [{ name: "Authorization", value: "" }]);
  assert.equal(bundle.events.length, 0);
  assert.deepEqual(bundle.redacted, { secrets: true, journals: true });
});

test("replace restores an emptied install exactly", () => {
  seed();
  const bundle = exportBundle({ includeSecrets: true, includeJournals: true });
  wipe();
  assert.equal(count(sessionsTable), 0);
  const summary = importBundle(BundleSchema.parse(JSON.parse(JSON.stringify(bundle))), "replace");
  assert.equal(summary.sessions, 1);
  assert.equal(summary.events, 2);
  assert.equal(summary.orphaned, 0);
  assert.equal(summary.missingSecrets, false);
  const again = exportBundle({ includeSecrets: true, includeJournals: true });
  const strip = (b: Bundle) => ({ ...b, exportedAt: 0 });
  assert.deepEqual(strip(again), strip(bundle));
});

test("replace drops what the bundle does not name; merge keeps it", () => {
  seed();
  const bundle = exportBundle({ includeSecrets: true, includeJournals: true });
  db.insert(tasksTable).values({ id: "task2", title: "Extra", createdAt: 1, updatedAt: 1 }).run();
  importBundle(bundle, "merge");
  assert.equal(count(tasksTable), 2);
  importBundle(bundle, "replace");
  assert.equal(count(tasksTable), 1);
});

test("merge upserts by id without cascading the row's children", () => {
  seed();
  const bundle = exportBundle({ includeSecrets: true, includeJournals: true });
  bundle.profiles[0]!.name = "renamed";
  bundle.projects[0]!.name = "renamed-ws";
  importBundle(bundle, "merge");
  assert.equal(db.select().from(profilesTable).where(eq(profilesTable.id, "p1")).get()?.name, "renamed");
  // The profile's links and the project's knowledge survived the upsert.
  assert.equal(count(profileMcpServers), 1);
  assert.equal(count(knowledgeTable), 1);
});

test("a redacted bundle merged over its own install keeps the install's secrets", () => {
  seed();
  const bundle = exportBundle({ includeSecrets: false, includeJournals: true });
  const summary = importBundle(BundleSchema.parse(JSON.parse(JSON.stringify(bundle))), "merge");
  assert.equal(summary.missingSecrets, false);
  assert.equal(db.select().from(profilesTable).where(eq(profilesTable.id, "p1")).get()?.apiKey, "sk-live");
  assert.deepEqual(db.select().from(mcpServersTable).where(eq(mcpServersTable.id, "m1")).get()?.headers, [
    { name: "Authorization", value: "Bearer s3cret" },
  ]);
});

test("a redacted bundle on a fresh install says so", () => {
  seed();
  const bundle = exportBundle({ includeSecrets: false, includeJournals: true });
  wipe();
  const summary = importBundle(BundleSchema.parse(JSON.parse(JSON.stringify(bundle))), "replace");
  assert.equal(summary.missingSecrets, true);
  assert.equal(db.select().from(profilesTable).where(eq(profilesTable.id, "p1")).get()?.apiKey, "");
});

test("a bundle without journals leaves the install's logs alone", () => {
  seed();
  const bundle = exportBundle({ includeSecrets: true, includeJournals: false });
  importBundle(bundle, "merge");
  assert.equal(count(eventsTable), 2);
});

test("rows whose parent exists nowhere are dropped, not fatal", () => {
  seed();
  const bundle = exportBundle({ includeSecrets: true, includeJournals: true });
  bundle.knowledge.push({ id: "k-orphan", projectId: "nope", title: "t", content: "c", tags: null, createdAt: 1, updatedAt: 1 });
  bundle.queue.push({ id: "q-orphan", sessionId: "nope", position: 0, text: "x", createdAt: 1 });
  const summary = importBundle(bundle, "replace");
  assert.equal(summary.orphaned, 2);
  assert.equal(count(knowledgeTable), 1);
});

test("a bundle in the wrong format is refused", () => {
  assert.equal(BundleSchema.safeParse({ format: "something-else", version: 1 }).success, false);
  assert.equal(BundleSchema.safeParse({ format: "daedalus-backup", version: 99 }).success, false);
});

wipe();
console.log(`backup: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.error(`\nFAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
