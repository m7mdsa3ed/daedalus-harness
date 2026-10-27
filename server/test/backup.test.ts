// Self-check for backup.ts: export → import round-trips every table, `replace`
// empties what the bundle does not name, `merge` keeps it, and a redacted
// bundle merged over the install it came from keeps the install's secrets.
//
// Runs against a real (temp) database — importing db/index.js migrates
// whatever DAEDALUS_DATA_DIR points at. Run: pnpm test:backup
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  agents as agentsTable,
  commands as commandsTable,
  db,
  knowledge as knowledgeTable,
  mcpServers as mcpServersTable,
  personas as personasTable,
  
  profiles as profilesTable,
  projectSpaces as projectSpacesTable,
  projects as projectsTable,
  spaces as spacesTable,
  routineMcpServers,
  routineRuns as routineRunsTable,
  routineTriggers as routineTriggersTable,
  routines as routinesTable,
  sessionEvents as eventsTable,
  sessionQueue as queueTable,
  sessions as sessionsTable,
  skills as skillsTable,
  boards as boardsTable,
  boardStatuses as boardStatusesTable,
  tasks as tasksTable,
} from "../src/db/index.js";
import { BundleSchema, exportBundle, importBundle, type Bundle } from "../src/backup.js";
import { ensureDefaultBoard } from "../src/boards.js";

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

async function wipe() {
  for (const table of [sessionsTable, profilesTable, projectsTable, spacesTable, mcpServersTable, skillsTable, commandsTable, personasTable, routinesTable, agentsTable, tasksTable, boardStatusesTable, boardsTable]) {
    await db.delete(table);
  }
}

/** A small install: one of everything that links to something else. */
async function seed() {
  await wipe();
  // Every real install has a board — index.ts seeds one at boot, and a task
  // with no column to point at is not a state the app can produce.
  (await ensureDefaultBoard());
  const now = 1_700_000_000_000;
  await db.insert(agentsTable).values({ id: "fake", name: "Fake", command: "node", args: ["a.mjs"], env: { K: "{apiKey}" }, seededVersion: 1 });
  await db.insert(mcpServersTable).values({ id: "m1", type: "http", name: "srv", url: "http://x", headers: [{ name: "Authorization", value: "Bearer s3cret" }] });
  await db.insert(skillsTable).values({ id: "s1", name: "skill", path: "/tmp/skill" });
  await db.insert(commandsTable).values({ id: "c1", name: "go", description: "d", content: "body" });
  await db.insert(profilesTable).values({ id: "p1", name: "gw", agents: { fake: {} }, baseUrl: "http://gw", apiKey: "sk-live", defaultModel: "m", smallModel: "", logoUrl: "", models: [{ id: "m", label: "M", reasoningEfforts: [], group: "Speed", iconUrl: "https://models.dev/logos/gw.svg" }] });
  
  /* A project with start defaults picked, so the round trip below is a real
     one: an empty defaults object would pass whether or not the columns are
     carried at all. */
  await db.insert(projectsTable).values({
    id: "w1",
    name: "ws",
    cwd: "/tmp/ws",
    logoUrl: "",
    defaultProfileId: "p1",
    defaultAgentId: "fake",
    defaultModel: "m",
    defaultEffort: "high",
    defaultModeId: "plan",
    defaultConfigChoices: { sandbox: "workspace-write" },
    defaultMcpServerIds: ["m1"],
    defaultSkillIds: ["s1"],
    defaultCommandIds: ["c1"],
    defaultSuggestKinds: [],
    defaultUiBlocks: false,
    defaultUiGroups: ["layout", "numbers"],
    defaultPersonaId: "persona1",
    defaultAskProfiles: { fake: { profileId: "p1", model: "m1" } },
  });
  /* One project in two spaces: the join table is what the bundle has to carry. */
  await db.insert(spacesTable).values([
    { id: "sp1", name: "Personal", sortOrder: 0, createdAt: now },
    { id: "sp2", name: "Work", sortOrder: 1, createdAt: now },
  ]);
  await db.insert(projectSpacesTable).values([
    { projectId: "w1", spaceId: "sp1" },
    { projectId: "w1", spaceId: "sp2" },
  ]);
  await db.insert(knowledgeTable).values({ id: "k1", projectId: "w1", title: "t", content: "c", createdAt: now, updatedAt: now });
  await db.insert(sessionsTable).values({ id: "t1", profileId: "p1", projectId: "w1", agentId: "fake", model: "m", effort: "", title: "Thread", acpSessionId: "acp-1", createdAt: now });
  await db.insert(eventsTable).values([
    { sessionId: "t1", seq: 0, kind: "turn_started", payload: { ev: "turn_started", turnId: "x" }, at: now },
    { sessionId: "t1", seq: 1, kind: "turn_ended", payload: { ev: "turn_ended", turnId: "x" }, at: now },
  ]);
  await db.insert(queueTable).values({ id: "q1", sessionId: "t1", position: 0, text: "later", createdAt: now });
  /* A number, because every task the app creates has one (`tasks-board.ts`
     takes it from the board's counter) — and the import backfills any task
     that lacks one, so a fixture without it is numbered on the way back in and
     the export is no longer the thing that returns. */
  await db.insert(tasksTable).values({ id: "task1", number: 1, title: "Do it", createdAt: now, updatedAt: now });
  /* A routine with all three of its tables populated, and a token on the
     trigger — the credential the `secrets=0` rule has to reach. */
  await db.insert(routinesTable).values({
    id: "r1",
    name: "Nightly review",
    projectId: "w1",
    profileId: "p1",
    agentId: "fake",
    model: "m",
    effort: "",
    body: { kind: "prompt", text: "Review yesterday." },
    autonomy: { permissions: { default: "ask" }, elicitations: "ask", askTimeoutSeconds: 300, askFallback: "deny", maxRunSeconds: 1800 },
    dryRunCompleted: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(routineMcpServers).values({ routineId: "r1", mcpServerId: "m1" });
  await db.insert(routineTriggersTable).values({
    id: "trg1",
    routineId: "r1",
    kind: "schedule",
    cron: "30 2 * * *",
    tz: "America/New_York",
    nextFireAt: now + 3600_000,
    secretHash: "deadbeef",
    secretCreatedAt: now,
    createdAt: now,
  });
  await db.insert(routineRunsTable).values({
    id: "run1",
    routineId: "r1",
    fireId: "f1",
    sessionId: "t1",
    source: "schedule",
    status: "completed",
    output: "nothing changed",
    startedAt: now,
    endedAt: now + 1000,
  });
}

const count = async (table: SQLiteTable) => (await db.select().from(table)).length;

await test("a full export round-trips through the schema", async () => {
  await seed();
  const bundle = await exportBundle({ includeSecrets: true, includeJournals: true });
  const parsed = BundleSchema.safeParse(JSON.parse(JSON.stringify(bundle)));
  assert.ok(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues));
  assert.equal(bundle.profiles[0]!.apiKey, "sk-live");
  assert.ok(!("mcpServerIds" in (bundle.profiles[0] as object)));
  assert.equal(bundle.events.length, 2);
  assert.equal(bundle.queue.length, 1);
  assert.ok(!("prompts" in bundle), "the legacy key is never exported");
  /* A model's `group` and `iconUrl` are the user's own writing, like the price
     beside them — a bundle that did not carry them would hand back a restored
     profile whose picker headings were silently gone. */
  assert.equal(bundle.profiles[0]!.models[0]!.group, "Speed");
  assert.equal(bundle.profiles[0]!.models[0]!.iconUrl, "https://models.dev/logos/gw.svg");
});

await test("a legacy bundle's prompts import as slash commands with slugged names; personas stay personas", async () => {
  await seed();
  const bundle = JSON.parse(JSON.stringify(await exportBundle({ includeSecrets: true, includeJournals: true })));
  bundle.commands = [{ id: "cx", name: "think-more", description: "d", content: "X" }];
  bundle.prompts = [
    { id: "pc", name: "terse", description: "", prompt: "C" },
    { id: "pd", name: "Think more!", description: "", prompt: "D" },
  ];
  bundle.personas = [{ id: "pa", name: "Think more", prompt: "A", thinking: 0, effort: "low" }];
  await wipe();
  const summary = await importBundle(BundleSchema.parse(bundle), "replace");
  const rows = await db.select().from(commandsTable);
  assert.deepEqual(rows.map((r) => [r.id, r.name]).sort(), [["cx", "think-more"], ["pc", "terse"], ["pd", "think-more-2"]]);
  assert.equal(rows.find((r) => r.id === "pc")!.content, "C");
  assert.equal(summary.personas, 1);
  const personaRows = await db.select().from(personasTable);
  assert.deepEqual(personaRows.map((r) => [r.id, r.name, r.prompt]), [["pa", "Think more", "A"]]);
});

await test("a routine round-trips with its triggers, runs and links", async () => {
  await seed();
  const bundle = await exportBundle({ includeSecrets: true, includeJournals: true });
  assert.equal(bundle.routines[0]!.dryRunCompleted, true, "the grant the user already made informedly");
  assert.equal(bundle.routineTriggers[0]!.secretHash, "deadbeef");
  await wipe();
  const summary = await importBundle(BundleSchema.parse(JSON.parse(JSON.stringify(bundle))), "replace");
  assert.equal(summary.routines, 1);
  assert.equal(summary.routineTriggers, 1);
  assert.equal(summary.routineRuns, 1);
  assert.equal(await count(routineMcpServers), 1);
  const routine = (await db.select().from(routinesTable).where(eq(routinesTable.id, "r1")))[0]!;
  assert.deepEqual(routine.body, { kind: "prompt", text: "Review yesterday." });
  assert.equal(routine.autonomy.permissions.default, "ask");
  assert.equal(routine.dryRunCompleted, true);
  assert.equal((await db.select().from(routineTriggersTable))[0]!.tz, "America/New_York");
  assert.equal((await db.select().from(routineRunsTable))[0]!.output, "nothing changed");
});

await test("a trigger deleted after the export does not come back on a merge", async () => {
  // Both children are replaced per routine, not upserted by id: a merge that
  // only added rows would resurrect a trigger the user deliberately removed,
  // and leave a run history whose NEWEST row came from another install — which
  // is the row `lastRunHeadOid` reads to decide whether anything has changed.
  await seed();
  const bundle = await exportBundle({ includeSecrets: true, includeJournals: true });
  await db.insert(routineTriggersTable).values({ id: "trg2", routineId: "r1", kind: "api", createdAt: 1 });
  await importBundle(BundleSchema.parse(JSON.parse(JSON.stringify(bundle))), "merge");
  assert.equal(await count(routineTriggersTable), 1);
  assert.equal((await db.select().from(routineTriggersTable))[0]!.id, "trg1");
});

await test("a redacted export carries no secrets", async () => {
  await seed();
  const bundle = await exportBundle({ includeSecrets: false, includeJournals: false });
  assert.equal("apiKey" in bundle.profiles[0]!, false);
  assert.deepEqual(bundle.mcpServers[0]!.headers, [{ name: "Authorization", value: "" }]);
  // Absent, not blanked — absent is what the import reads as "keep what this
  // install already holds". The stored value is only a hash, but it is the one
  // credential that starts a process on this machine.
  assert.equal("secretHash" in bundle.routineTriggers[0]!, false);
  assert.equal(bundle.events.length, 0);
  assert.deepEqual(bundle.redacted, { secrets: true, journals: true });
});

await test("replace restores an emptied install exactly", async () => {
  await seed();
  const bundle = await exportBundle({ includeSecrets: true, includeJournals: true });
  await wipe();
  assert.equal(await count(sessionsTable), 0);
  const summary = await importBundle(BundleSchema.parse(JSON.parse(JSON.stringify(bundle))), "replace");
  assert.equal(summary.sessions, 1);
  assert.equal(summary.events, 2);
  assert.equal(summary.orphaned, 0);
  assert.equal(summary.missingSecrets, false);
  const again = await exportBundle({ includeSecrets: true, includeJournals: true });
  const strip = (b: Bundle) => ({ ...b, exportedAt: 0 });
  assert.deepEqual(strip(again), strip(bundle));
});

await test("a project's spaces round-trip, and an old bundle's single space still lands", async () => {
  await seed();
  const bundle = await exportBundle({ includeSecrets: true, includeJournals: true });
  assert.deepEqual(bundle.projects.find((p) => p.id === "w1")!.spaceIds, ["sp1", "sp2"]);
  await wipe();
  // A bundle from before spaces were many-to-many names one `spaceId`.
  const old = BundleSchema.parse(JSON.parse(JSON.stringify(bundle)));
  for (const p of old.projects) {
    delete p.spaceIds;
    p.spaceId = "sp2";
  }
  await importBundle(old, "replace");
  const rows = await db.select().from(projectSpacesTable);
  assert.deepEqual(rows, [{ projectId: "w1", spaceId: "sp2" }]);
});

await test("boards and their columns round-trip", async () => {
  await seed();
  const bundle = await exportBundle({ includeSecrets: true, includeJournals: true });
  assert.equal(bundle.boards.length, 1);
  assert.equal(bundle.boardStatuses.length, 4);
  assert.equal(bundle.tasks[0]!.boardId, "default");
  assert.equal(bundle.tasks[0]!.statusId, "todo");
});

/* The pre-boards shape: a task row with `board`/`status` instead of ids. Those
   values ARE the seeded ids, so an old bundle has to import unchanged. */
await test("a pre-boards bundle imports into the default board", async () => {
  await seed();
  const bundle = await exportBundle({ includeSecrets: true, includeJournals: true });
  const legacy = JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>;
  delete legacy.boards;
  delete legacy.boardStatuses;
  legacy.tasks = [
    { id: "old1", board: "default", status: "in_progress", title: "Legacy", priority: "high", labels: [], order: 0, createdAt: 1, updatedAt: 1 },
  ];
  const parsed = BundleSchema.safeParse(legacy);
  assert.ok(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues));
  const summary = await importBundle(parsed.data, "replace");
  assert.equal(summary.tasks, 1);
  // Re-seeded by the import, since the bundle carried no boards.
  assert.equal(await count(boardsTable), 1);
  assert.equal(await count(boardStatusesTable), 4);
  const task = (await db.select().from(tasksTable).where(eq(tasksTable.id, "old1")))[0]!;
  assert.equal(task.boardId, "default");
  assert.equal(task.statusId, "in_progress");
  assert.equal(summary.orphaned, 0);
});

/* A bundle whose tasks name a column it did not bring: repaired to the board's
   first column rather than left invisible. */
await test("a task pointing at a missing column is rehomed, not lost", async () => {
  await seed();
  const bundle = await exportBundle({ includeSecrets: true, includeJournals: true });
  const broken = BundleSchema.parse(JSON.parse(JSON.stringify(bundle)));
  broken.boardStatuses = broken.boardStatuses.filter((s) => s.id !== "todo");
  const summary = await importBundle(broken, "replace");
  assert.equal(summary.orphaned, 1);
  const task = (await db.select().from(tasksTable).where(eq(tasksTable.id, "task1")))[0]!;
  assert.equal(task.statusId, "in_progress");
});

await test("replace drops what the bundle does not name; merge keeps it", async () => {
  await seed();
  const bundle = await exportBundle({ includeSecrets: true, includeJournals: true });
  await db.insert(tasksTable).values({ id: "task2", title: "Extra", createdAt: 1, updatedAt: 1 });
  await importBundle(bundle, "merge");
  assert.equal(await count(tasksTable), 2);
  await importBundle(bundle, "replace");
  assert.equal(await count(tasksTable), 1);
});

await test("a project's start defaults survive export and import", async () => {
  await seed();
  const bundle = await exportBundle({ includeSecrets: true, includeJournals: true });
  // The export answers the reader's shape, one field per column, never the
  // raw `default_*` names.
  const exported = bundle.projects.find((p) => p.id === "w1")!;
  assert.equal("defaultModel" in exported, false, "the columns travel folded, not raw");
  assert.deepEqual(exported.defaults, {
    profileId: "p1",
    agentId: "fake",
    model: "m",
    effort: "high",
    modeId: "plan",
    configChoices: { sandbox: "workspace-write" },
    mcpServerIds: ["m1"],
    skillIds: ["s1"],
    commandIds: ["c1"],
    suggestKinds: [],
    uiGroups: ["layout", "numbers"],
    personaId: "persona1",
    voiceProvider: "",
    askProfiles: { fake: { profileId: "p1", model: "m1" } },
  });
  /* A bundle from before the columns: the key is absent and every field of
     the defaults is missing too, which is the shape `prefault` exists for. */
  const legacy = JSON.parse(JSON.stringify(bundle)) as { projects: Record<string, unknown>[] };
  delete legacy.projects[0]!.defaults;
  await importBundle(BundleSchema.parse(legacy), "replace");
  const restored = (await db.select().from(projectsTable).where(eq(projectsTable.id, "w1")))[0]!;
  assert.equal(restored.defaultModel, null, "a bundle from before the columns clears them");
  assert.equal(restored.defaultUiGroups, null, "and the group set reads as every group");
  assert.deepEqual(restored.defaultSuggestKinds, ["prompts", "commands"], "and the suggestion set lands on its default");
  // And the modern bundle puts them back.
  await importBundle(bundle, "replace");
  const round = (await db.select().from(projectsTable).where(eq(projectsTable.id, "w1")))[0]!;
  assert.equal(round.defaultModel, "m");
  assert.deepEqual(round.defaultConfigChoices, { sandbox: "workspace-write" });
  assert.deepEqual(round.defaultMcpServerIds, ["m1"]);
  assert.deepEqual(round.defaultSuggestKinds, []);
  assert.deepEqual(round.defaultUiGroups, ["layout", "numbers"]);
  assert.equal(round.defaultPersonaId, "persona1");
  assert.deepEqual(round.defaultAskProfiles, { fake: { profileId: "p1", model: "m1" } });

  // A bundle from before the set carried only the legacy switch: off is the empty set.
  const old = JSON.parse(JSON.stringify(bundle)) as { projects: { defaults: Record<string, unknown> }[] };
  delete old.projects[0]!.defaults.uiGroups;
  old.projects[0]!.defaults.uiBlocks = false;
  await importBundle(BundleSchema.parse(old), "replace");
  const off = (await db.select().from(projectsTable).where(eq(projectsTable.id, "w1")))[0]!;
  assert.deepEqual(off.defaultUiGroups, [], "legacy uiBlocks:false imports as an empty group set");

  // The same for a thread: a row carrying only `uiBlocks:false` lands as [].
  const oldSession = JSON.parse(JSON.stringify(bundle)) as { sessions: Record<string, unknown>[] };
  delete oldSession.sessions[0]!.uiGroups;
  oldSession.sessions[0]!.uiBlocks = false;
  await importBundle(BundleSchema.parse(oldSession), "replace");
  const thread = (await db.select().from(sessionsTable).where(eq(sessionsTable.id, "t1")))[0]!;
  assert.deepEqual(thread.uiGroups, [], "legacy session uiBlocks:false imports as uiGroups []");
});

await test("merge upserts by id without cascading the row's children", async () => {
  await seed();
  const bundle = await exportBundle({ includeSecrets: true, includeJournals: true });
  bundle.profiles[0]!.name = "renamed";
  bundle.projects[0]!.name = "renamed-ws";
  await importBundle(bundle, "merge");
  assert.equal((await db.select().from(profilesTable).where(eq(profilesTable.id, "p1")))[0]?.name, "renamed");
  // The profile's links and the project's knowledge survived the upsert.
  assert.equal(await count(knowledgeTable), 1);
});

await test("a redacted bundle merged over its own install keeps the install's secrets", async () => {
  await seed();
  const bundle = await exportBundle({ includeSecrets: false, includeJournals: true });
  const summary = await importBundle(BundleSchema.parse(JSON.parse(JSON.stringify(bundle))), "merge");
  assert.equal(summary.missingSecrets, false);
  assert.equal((await db.select().from(profilesTable).where(eq(profilesTable.id, "p1")))[0]?.apiKey, "sk-live");
  assert.deepEqual((await db.select().from(mcpServersTable).where(eq(mcpServersTable.id, "m1")))[0]?.headers, [
    { name: "Authorization", value: "Bearer s3cret" },
  ]);
  assert.equal(
    (await db.select().from(routineTriggersTable).where(eq(routineTriggersTable.id, "trg1")))[0]?.secretHash,
    "deadbeef",
    "a redacted trigger token keeps working after a merge over its own install",
  );
});

await test("a redacted bundle on a fresh install says so", async () => {
  await seed();
  const bundle = await exportBundle({ includeSecrets: false, includeJournals: true });
  await wipe();
  const summary = await importBundle(BundleSchema.parse(JSON.parse(JSON.stringify(bundle))), "replace");
  assert.equal(summary.missingSecrets, true);
  assert.equal((await db.select().from(profilesTable).where(eq(profilesTable.id, "p1")))[0]?.apiKey, "");
});

await test("a bundle without journals leaves the install's logs alone", async () => {
  await seed();
  const bundle = await exportBundle({ includeSecrets: true, includeJournals: false });
  await importBundle(bundle, "merge");
  assert.equal(await count(eventsTable), 2);
});

await test("rows whose parent exists nowhere are dropped, not fatal", async () => {
  await seed();
  const bundle = await exportBundle({ includeSecrets: true, includeJournals: true });
  (await bundle).knowledge.push({ id: "k-orphan", projectId: "nope", title: "t", content: "c", tags: null, createdAt: 1, updatedAt: 1 });
  (await bundle).queue.push({ id: "q-orphan", sessionId: "nope", position: 0, text: "x", createdAt: 1 });
  bundle.routineRuns.push({
    id: "run-orphan", routineId: "nope", fireId: "f", sessionId: null, source: "manual",
    payload: null, dryRun: false, status: "completed", error: null, output: null, verdict: null,
    actions: [], headOid: null, tokens: null, triggerId: null, startedAt: 1, endedAt: null,
  });
  const summary = await importBundle(bundle, "replace");
  assert.equal(summary.orphaned, 3);
  assert.equal(await count(knowledgeTable), 1);
});

await test("an old bundle's scheduled rows are restored as session-mode routines", async () => {
  await seed();
  const bundle = await exportBundle({ includeSecrets: true, includeJournals: true });
  assert.equal(bundle.scheduled.length, 0, "new bundles carry scheduled messages as routines");
  bundle.scheduled.push(
    { id: "old-sched", sessionId: "t1", text: "remind me", nextAt: 5_000, everyMs: 600_000, createdAt: 1 },
    { id: "old-orphan", sessionId: "nope", text: "x", nextAt: 5_000, createdAt: 1 },
  );
  const summary = await importBundle(BundleSchema.parse(JSON.parse(JSON.stringify(bundle))), "replace");
  assert.equal(summary.scheduled, 1);
  assert.equal(summary.orphaned, 1);
  const restored = (await db.select().from(routinesTable).where(eq(routinesTable.id, "old-sched")))[0]!;
  assert.equal(restored.runsIn, "session");
  assert.equal(restored.sessionId, "t1");
  assert.equal(restored.projectId, "w1");
  const trigger = (await db.select().from(routineTriggersTable).where(eq(routineTriggersTable.routineId, "old-sched")))[0]!;
  assert.equal(trigger.intervalMs, 600_000);
  assert.equal(trigger.nextFireAt, 5_000);
});

await test("a bundle in the wrong format is refused", () => {
  assert.equal(BundleSchema.safeParse({ format: "something-else", version: 1 }).success, false);
  assert.equal(BundleSchema.safeParse({ format: "daedalus-backup", version: 99 }).success, false);
});

/* ---- the route's own auth rule (routes/misc.ts) ----
   GET /api/backup accepts the bearer token ONLY in the Authorization header.
   The general middleware also takes `?token=`, but a full-secret export URL is
   exactly the thing that ends up in browser history and proxy logs — so the
   route re-checks, and a query token is refused even when its value is right.
   Pinned here because no diff shows it: the route looks like a duplicate of
   the middleware and "simplifying" it to `bearerToken(header, query)` would
   pass every other test. */
async function routeTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    failures.push(`${name}\n    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}

{
  const { Hono } = await import("hono");
  const { miscRoutes } = await import("../src/routes/misc.js");
  type MiscDeps = Parameters<typeof miscRoutes>[1];
  const app = new Hono();
  // Only `config.token` is read on this route; the rest of the deps are for
  // handlers these requests never reach.
  miscRoutes(app, { config: { token: "s3cret-tok" }, sessions: {}, push: {} } as MiscDeps);
  await seed();

  await routeTest("a correct token in the query string is refused", async () => {
    const res = await app.request("/api/backup?token=s3cret-tok&secrets=1");
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /Authorization header/, "the refusal says how to ask properly");
  });

  await routeTest("a query token does not rescue a missing header", async () => {
    const res = await app.request("/api/backup?token=s3cret-tok", {
      headers: { authorization: "Bearer wrong" },
    });
    assert.equal(res.status, 401);
  });

  await routeTest("a non-Bearer authorization scheme is refused", async () => {
    const res = await app.request("/api/backup", { headers: { authorization: "Basic s3cret-tok" } });
    assert.equal(res.status, 401);
  });

  await routeTest("the header token is accepted and answers the bundle as an attachment", async () => {
    const res = await app.request("/api/backup", { headers: { authorization: "Bearer s3cret-tok" } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="daedalus-backup-/);
    const parsed = BundleSchema.safeParse(await res.json());
    assert.ok(parsed.success, "what it serves is a real bundle");
    // And without `secrets=1` the download is the redacted one.
    assert.equal("apiKey" in parsed.data.profiles[0]!, false, "secrets stay opt-in");
  });

  // Riding along on the mounted routes: the wire contract the client's gate reads (`compat.ts`).
  await routeTest("health says the contract numbers without a token", async () => {
    const body = (await (await app.request("/api/health")).json()) as { api?: unknown; minClientApi?: unknown };
    assert.equal(typeof body.api, "number");
    assert.equal(typeof body.minClientApi, "number");
  });
}

await wipe();
console.log(`backup: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.error(`\nFAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
