# SQLite → Postgres, with multiple harness instances on one database

## Context

Storage today is `data/daedalus.db` opened with **better-sqlite3** (`server/src/db/index.ts`),
schema in `server/src/db/schema.ts`, pushed with drizzle-kit and never migrated. The driver was
chosen *because it is synchronous*: `getProfile`/`getAgent`/`getProject` are called from sync
paths (`resolveSpawn` builds a child's env, `proxyGatewayRequest` resolves a thread's profile per
proxied request), and the whole of `SessionManager` and `SessionJournal` is written sync around
that.

We want Postgres so the harness can point at a shared database, and — per the answers — so
**several harness instances can run against one database**. Two decisions taken up front:

- **Full replacement.** better-sqlite3 goes; there is one `schema.ts`, in `pg-core`. Drizzle
  cannot share a schema file across dialects, so keeping both would mean two schemas and two
  copies of every raw-SQL site (FTS5 vs tsvector) kept in sync by hand.
- **Fully async.** Every db read is awaited, including inside `resolveSpawn`, the gateway shim's
  per-request resolver, and `SessionJournal`'s flush-before-read. No sync cache layer.

### The honest constraint on "multiple instances"

An instance owns things a database cannot share: the **agent child processes**, the **WebSocket
peers**, the **node-pty terminals**, and the **project `cwd` on local disk**. `CLAUDE.md` already
records this ("One instance, fork mode: the agent child processes, the WebSocket peers and the
SQLite handle are owned by this process"). Postgres removes the *storage* reason for one instance;
it does not remove the process reason.

So the target is: **one owner per thread, every instance a reader.** Any instance can list, read
a transcript, search, edit the queue, manage the library and boards. A thread with a live process
is served by the instance that owns it; another instance serves it read-only (the `archived`
attach path that already exists) and takes ownership only when the previous owner is gone.
Instances must also share a filesystem for `project.cwd`, or projects must be disjoint per
instance — worth stating in the docs, because a `cwd` row that resolves on machine A and not on
machine B fails as an ENOENT inside a thread.

---

## Phase 1 — the port

### 1. Driver and config

- Deps: drop `better-sqlite3` + `@types/better-sqlite3`; add `pg` + `@types/pg`
  (`drizzle-orm/node-postgres`). `pg` over postgres.js because we need a `Pool` for queries **and**
  a separate long-lived `Client` for `LISTEN` in Phase 2, which is the shape `pg` is built for.
  Remove `better-sqlite3` from `pnpm.onlyBuiltDependencies`.
- `ServerConfig` (`server/src/config.ts`) gains `databaseUrl: string`. Follow the existing
  host/port precedent exactly: the env (`DAEDALUS_DATABASE_URL`) wins over the file, and the
  token-seeding write puts the file's own value back rather than persisting the override.
- `db/index.ts` becomes: build a `Pool` from the URL, `drizzle(pool, { schema })`. Delete the
  four `client.pragma(...)` lines (WAL/synchronous/foreign_keys/busy_timeout — pg has none of
  these problems). Keep the file as the single swap point.
- `drizzle.config.ts`: `dialect: "postgresql"`, `dbCredentials: { url }`, and
  `schemaFilter` for the per-instance/test schema (below). The `tablesFilter` hiding
  `session_events_fts*` **goes away** — the FTS table becomes an ordinary table drizzle models.
- `importLegacyJson` stays as-is (it reads local `data/*.json`, renames them `.imported`, and is
  a no-op on any install without them) but its `client.transaction(() => …)` becomes
  `await db.transaction(async (tx) => …)`, and the whole of `db/index.ts`'s boot work moves out
  of module top-level into an exported `await initDb()` called first in `index.ts` — a module
  side-effect cannot await.

### 2. Schema (`server/src/db/schema.ts`)

Mostly mechanical; the column names are already explicit snake_case, PKs are all `text`, and
there is no autoincrement.

| SQLite | Postgres |
|---|---|
| `sqliteTable` | `pgTable` |
| `text("x", { mode: "json" }).$type<T>()` | `jsonb("x").$type<T>()` |
| `integer("created_at")` (epoch ms) | `bigint("created_at", { mode: "number" })` |
| `integer("acp_session_provisional", { mode: "boolean" })` | `boolean(...)` |
| `integer("order")`, `integer("skip_count")`, `integer("seq")`, `integer("position")` | `integer(...)` |
| `integer("enabled").default(1)` | keep `integer` — `eq(scheduled.enabled, 1)` in scheduler.ts stays correct |
| `text("type", { enum: [...] })` | `text("type", { enum: [...] })` — same API in pg-core |

Three columns need thought, not translation:

- **`session_events.payload` must be `text`, not `jsonb`.** `replayFrames` reads the column *as
  stored text* and puts it straight on the socket — that is the whole point of the batched replay.
  `jsonb` would round-trip through pg's parser and reserializer once per read. Store `text`, drop
  the `cast(${payload} as text)` in `replayFrames`, and `JSON.parse` explicitly in `eventsFrom`.
- **`session_events_fts` becomes a real table** (below), with a real FK.
- Every `sql<number>\`count(*)\`` comes back from pg as a **string**. Audit and fix all of them:
  `session-journal.ts` (`turnCount`, `countTurnsBefore` — already wrapped in `Number()`),
  `project-stats.ts`, `tasks-board.ts`, `boards.ts`. Prefer `count(*)::int` in the SQL so the
  type annotation stops lying.

`session_events.at` is `bigint` and appears in `max(at)` / `having` in `nextSeqBySession`,
`lastActivityBySession`, `prune` — same string-coercion trap, cast in SQL.

### 3. Full-text search (`server/src/search.ts`)

FTS5 has no Postgres equivalent; the replacement is simpler than what it replaces.

```ts
export const sessionEventsFts = pgTable("session_events_fts", {
  sessionId: text("session_id").notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  at: bigint("at", { mode: "number" }).notNull(),
  text: text("text").notNull(),
  tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('simple', text)`).notNull(),
}, (t) => [
  primaryKey({ columns: [t.sessionId, t.seq] }),
  index("session_events_fts_tsv").using("gin", t.tsv),
]);
```

- `'simple'`, not `'english'`: FTS5 was `unicode61 remove_diacritics 2` — no stemming — and
  switching to a stemmer silently changes which threads match.
- `tsvector` is not a drizzle-native pg type; declare it once with `customType` in `schema.ts`.
  The GIN index and the generated column both push cleanly, so `ensureSchema`'s hand-written
  `CREATE VIRTUAL TABLE` block **is deleted**.
- **The FK deletes `deleteSearchIndex`'s reason to exist for purge.** `CLAUDE.md`'s note
  ("there is no foreign key to cascade for a virtual table") stops being true; keep the function
  for the two paths where the session row survives — `SessionJournal.clear` (revive) and `prune`
  (retention) — and drop the call in `SessionManager.purge`.
- `ftsQuery` → `tsQuery`: same defensive intent, different output. Build
  `to_tsquery('simple', …)` input by quoting each term and appending `:*` to the last, or use
  `websearch_to_tsquery` for all but the trailing prefix term. Keep the "cannot 500 on user
  input" contract and its test.
- `snippet(...)` → `ts_headline('simple', text, query, 'StartSel=…,StopSel=…,MaxWords=…,MinWords=…,MaxFragments=1')`.
  `SNIPPET_START`/`SNIPPET_END` stay exactly as they are and go in as `StartSel`/`StopSel`, so
  the client's split contract is untouched.
- The `materialized` CTE comment goes away — that was a SQLite restriction on `snippet()`.
  `ts_headline` composes with window functions, so the query flattens to hits → `row_number()`
  partitioned per session → cap → join sessions/projects → order by `at desc, seq desc`.
  Ranking is still recency, not `ts_rank`, exactly as today.
- `backfillSearchIndex`'s **`rowid` cursor has no pg equivalent.** Do not add a serial column;
  page on the existing unique index instead: `where (session_id, seq) > ($1, $2) order by
  session_id, seq limit 2000`, storing `"sid|seq"` in `search_meta`. Same resumability, same
  terminal `done` marker, no schema change. Guard the whole function with an advisory lock
  (Phase 2).

### 4. The async conversion

Mechanical rule, ~120 call sites across 22 files:

- `.all()` → drop it, `await` the builder.
- `.get()` → drop it, `await` and take `[0]` (add a `one()` helper in `db/index.ts` so the
  `?? undefined` dance is written once).
- `.run()` → drop it, `await`.
- `db.all<T>(sql)` / `db.get` / `db.run` → `(await db.execute(sql)).rows`.
- `db.transaction((tx) => …)` → `await db.transaction(async (tx) => …)`; every `tx.` call inside
  gains an `await`. Affects `search.ts`, `backup.ts`, `profiles.ts` ×2, `tasks-board.ts`,
  `boards.ts` ×7, `session-journal.ts`, `sessions.ts:514`.

Then the coloring, which is where the actual work is:

- **`SessionJournal`** — `append` stays synchronous (it stamps `seq` from the in-memory counter
  and buffers; that is what keeps `emit` cheap). Everything else becomes async: `flush`,
  `eventsFrom`, `replayFrames` (an `AsyncGenerator`), `turnStartsBefore`, `turnCount`,
  `countTurnsBefore`, `turnStartAt`, `earlierPage`, `clear`, `nextSeqBySession`,
  `lastActivityBySession`, `prune`. `flush` needs a **serialization guard** it did not need
  before — hold the in-flight promise on the instance and chain, or two overlapping flushes
  interleave their transactions. The row-by-row retry fallback keeps its `console.error`, and
  still must never throw (it runs on a `setImmediate`).
- **`SessionManager`** — `reload`, `retireAll`, `shutdown`, `journal`, `attach`, `persist`,
  `list`, `softDelete`, `restore`, `purge`, `create`, `importSession`, `queue*`, `effectiveLinks`
  / `materializeFor` become async. `shutdown()` currently relies on the sync final flush;
  make it `async` and **`await sessions.shutdown()`** in `index.ts`'s `shutdown(code)`, before
  the `SHUTDOWN_DRAIN_MS` sleep, rather than trusting the drain to cover it.
- **`registry.ts`** — `getAgent`, `listAgents`, `seedAgents`, `resolveSpawn`, `modelAllowlistFor`
  async. `resolveSpawn`'s callers (`spawnProc` in sessions.ts, `probe.ts`) are already inside
  async functions.
- **`profiles.ts` / `projects.ts` / `library.ts`** — all getters async. `defaultProfileFor` stays
  sync (it synthesizes, it does not read).
- **`gateway-shim.ts:472`** — `proxyGatewayRequest` is already async; the resolver
  `setGatewaySessionResolver((id) => this.gatewayStateOf(id))` returns from the in-memory
  `sessions` map, so it stays sync; only the `getProfile` beside it gains an `await`. Confirm no
  db read lands in the streaming body path.
- **`acp-bridge.ts:56`**, **`terminals.ts:130`**, **`workspace-fs.ts:126`**, **`knowledge.ts`**,
  **`previews.ts`**, **`scheduler.ts`'s `deliver`/`sweep`**, all of `routes/*` — add awaits.
- `session-socket.ts` — the attach/replay path becomes async; it already `await`s elsewhere.

### 5. Dialect-specific SQL to rewrite

- `project-stats.ts:229` — `date(at/1000,'unixepoch','localtime')` →
  `to_char(to_timestamp(at/1000.0) AT TIME ZONE current_setting('TimeZone'), 'YYYY-MM-DD')`.
  The comment about not bucketing in UTC stays true and stays.
- `groupBy(sql\`1\`)` / `orderBy(sql\`1\`)` work in pg as-is.
- `on conflict(key) do update set value = excluded.value` — identical syntax; unchanged.
- `backup.ts`'s non-cascading `ON CONFLICT DO UPDATE` (the deliberate non-`INSERT OR REPLACE`)
  is already the portable form; unchanged.

### 6. Tests

13 test files isolate by `DAEDALUS_DATA_DIR=/tmp/daedalus-test-x` — a fresh sqlite file per run.
Replace with a fresh **schema** per run:

- Add `DAEDALUS_DB_SCHEMA` (default `public`). `db/index.ts` sets it on the pool
  (`options: '-c search_path=<schema>'`), `drizzle.config.ts` sets `schemaFilter`.
- `test/pg-setup.ts`: `CREATE SCHEMA IF NOT EXISTS <s>` → `drizzle-kit push --force` → run →
  `DROP SCHEMA <s> CASCADE`. One helper the test scripts import.
- `docker-compose.yml` with a `postgres:17` for local dev and CI, and a `DAEDALUS_TEST_DATABASE_URL`.
- `package.json` test scripts swap `DAEDALUS_DATA_DIR=…` for `DAEDALUS_DB_SCHEMA=…` (keep the
  data dir too — `data/model-catalogs`, snapshots and `config.json` are still files).

### 7. Boot & ops

- `ensureSchema`'s "is this database fresh" probe changes from `sqlite_master` to
  `to_regclass('sessions')`. Keep the auto-push for a never-opened database (a first install and
  every test run depend on it) but wrap it in `pg_advisory_lock` so two instances booting
  together do not both run drizzle-kit.
- `pm2:start` still runs `pnpm db:push` before restart. Document that with several instances,
  push is an operator step taken once, and instances should not be at different code versions
  across a schema change.
- README/CLAUDE.md: `DAEDALUS_DATABASE_URL`, the docker-compose, and the `data/` directory's
  reduced role (config.json, model catalogs, snapshots — no longer the database).

---

## Phase 2 — several instances on one database

Do this **after** Phase 1 is green, as a separate change. Phase 1 alone is correct for one
instance on Postgres.

### Instance identity and thread ownership

New table:

```ts
export const instances = pgTable("instances", {
  id: text("id").primaryKey(),          // minted per boot, never stored in a file
  label: text("label").notNull(),       // host:port, for the operator
  startedAt: bigint(...).notNull(),
  heartbeatAt: bigint(...).notNull(),   // bumped every 15s
});
```

`sessions` gains `owner_instance_id text` (nullable, no FK — the same reasoning the row's own
comment gives for `parent_session_id`). An instance sets it when it **spawns a process** for the
thread and clears it on `retire`. A row whose owner's heartbeat is older than ~3 heartbeats is
treated as unowned — the owner died.

Every place that assumes "a row with no live process in my map is mine to act on" becomes
owner-scoped:

- **`SessionManager.reload()`** loads all rows so any instance can list and read, but must not
  build a `Session` it will later retire or revive if the row is owned by a *live* instance.
  Mark those `foreign: true` in the map: listable, archive-attachable, not spawnable.
- **The idle sweep** (`sessions.ts:361`) already iterates `this.sessions` — add a `foreign` skip.
- **`pruneJournals`** is the sharpest hazard: `prune(cutoff, liveIds)` skips only *this*
  instance's live ids, so instance B would delete instance A's live thread archive. `liveIds`
  must become "owned by any instance with a fresh heartbeat", read from the database.
- **`retireAll` / `shutdown`** — only this instance's own sessions (already true via the map,
  but the `foreign` flag makes it explicit).
- **`WorkflowRunner.recoverAtBoot`** marks every `status = "running"` row failed. It must only
  close runs whose parent session was owned by *this* instance id or by an instance whose
  heartbeat has expired — otherwise a booting instance fails another instance's live pipeline.
  Add `owner_instance_id` to `workflow_runs` and filter on it.
- **The scheduler sweep** (`scheduler.ts`) would fire every due prompt once per instance.
  Replace the plain `SELECT` with an atomic claim:
  `UPDATE session_scheduled SET claimed_by = $me, claimed_at = now() WHERE id IN (SELECT id FROM session_scheduled WHERE … FOR UPDATE SKIP LOCKED) RETURNING *`.
  `FOR UPDATE SKIP LOCKED` is the whole reason this is easy in pg and was impossible in SQLite.
- **`backfillSearchIndex`**, **`seedAgents`**'s backfill half, and **`ensureSchema`**'s push:
  each under a distinct `pg_advisory_lock` key. `seedAgents`'s inserts are already
  `onConflictDoNothing`; the lock is for the field backfills.
- **`SessionJournal.append`** stamps `seq` from an in-memory counter against a unique
  `(session_id, seq)` index. Safe *because* only the owner writes to a session's log — which is
  now a rule the ownership column enforces rather than an accident of there being one process.

### Cross-instance behaviour, stated plainly

- **Read is shared, free.** The journal, search, session list, boards, library, knowledge,
  queue edits and the backup route all work from any instance the moment Phase 1 lands — the
  three queue edits (`queue_update/remove/clear`) are already answered with no bridge.
- **Live is the owner's.** Attaching from a non-owner serves the archive and marks it
  `archived` — the path `attach` already takes for a retired thread. Sending from a non-owner
  goes through the existing revive, which now first checks ownership: unowned or expired-owner →
  claim and spawn; live owner → refuse with a clear error naming the owning instance's label.
  This is a small, honest scope, and it reuses machinery that exists.
- **Cache/list invalidation** uses `LISTEN`/`NOTIFY` on one channel from a dedicated `pg.Client`
  (not a pooled connection): a profile saved on instance A tells B to drop its probe cache and
  re-broadcast its session list. Payloads are small ids — NOTIFY caps at 8000 bytes, so nothing
  session-event-shaped travels this way.
- **Push notifications** gate on `peers.size === 0` (`sessions.ts:653`), which is per-process; an
  instance would push about a thread someone is watching elsewhere. Since only the owner runs
  turns and only the owner has peers for a live thread, this stays correct — worth a comment,
  not a change.
- **Not in scope**, and should be documented as such: live turn streaming to a peer on a
  non-owner instance, cross-instance terminals, and cross-instance `code-server`/IDE.

---

## Files

Core: `server/src/db/index.ts`, `server/src/db/schema.ts`, `server/src/db/links.ts`,
`server/drizzle.config.ts`, `server/src/config.ts`, `server/package.json`.

Rewritten SQL: `server/src/search.ts` (largest single change), `server/src/project-stats.ts`,
`server/src/session-journal.ts`.

Async conversion, same mechanical pattern throughout — representative paths:
`server/src/sessions.ts` (deepest), `server/src/registry.ts`, `server/src/profiles.ts`,
`server/src/projects.ts`, `server/src/library.ts`, `server/src/scheduler.ts`,
`server/src/workflows.ts`, `server/src/backup.ts`, `server/src/boards.ts`,
`server/src/tasks-board.ts`, `server/src/queue.ts`, `server/src/quota.ts`,
`server/src/knowledge.ts`, `server/src/previews.ts`, `server/src/push.ts`,
`server/src/websearch-usage.ts`, `server/src/session-list.ts`, `server/src/materialize.ts`,
`server/src/usage-api.ts`, `server/src/acp-bridge.ts`, `server/src/gateway-shim.ts`,
`server/src/index.ts`, and all of `server/src/routes/`.

Tests: new `server/test/pg-setup.ts`, new `docker-compose.yml`, all 13 `server/test/*.test.ts`
scripts in `package.json`.

**No client change.** The protocol in `server/src/protocol.ts` is untouched; the browser never
knew there was a database.

## Verification

1. `docker compose up -d postgres`, then `cd server && pnpm db:push` against an empty database —
   confirm the schema, the GIN index and the generated `tsv` column all land, and that a second
   `push` is a no-op (the FTS table no longer needs hiding).
2. `pnpm exec tsc --noEmit` — this is the real gate for the async conversion: a missing `await`
   on a drizzle builder is a type error at nearly every call site.
3. `pnpm test` — the full suite (`bridge`, `fs`, `websearch`, `models`, `ide`, `registry`,
   `gateway`, `backup`, `boards`, `search`, `workflow-schema`, `workflow`, `quota`), each in its
   own schema. `test:search` is the one to watch: it pins `ftsQuery`/`tsQuery` and the snippet
   markers, and should be extended with a prefix-match case and a multi-term case.
4. `pnpm test:backup` round-trips a bundle — the best single check that every table still reads
   and writes, since `backup.ts` touches all of them.
5. Manually, against a fresh database: `pnpm dev`, create a thread on `fake-echo`, run several
   turns, reload the browser (replay + `caught_up`), page back with "Show more" (turn-counted
   `earlier`), search for a word from the transcript, retire the thread and reopen it read-only,
   then send to revive it. Then restart the server and confirm the thread's `eventCount` picks up
   where it left off (`nextSeqBySession`).
6. `test:workflow` end to end — it is the only test that exercises mirrored child events, the
   `(session_id, seq)` uniqueness under concurrent writes, and `recoverAtBoot`.
7. Phase 2 only: boot two instances against one database on different ports. Confirm a thread
   started on A lists and reads on B; that B's boot does not fail A's running workflow; that a
   due schedule fires exactly once; that B's retention sweep leaves A's live thread's archive
   alone; and that sending from B to a thread A owns is refused by name rather than silently
   spawning a second process on the same `acp_session_id`.
