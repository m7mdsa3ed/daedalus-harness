import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import { DATA_DIR, databaseUrl, readJson } from "../config.js";
import * as schema from "./schema.js";

export * from "./schema.js";
export { schema };

const CONNECTION_STRING = databaseUrl();
/** Where a pre-Postgres install kept everything (`migrateSqlite`). */
const SQLITE_PATH = join(DATA_DIR, "daedalus.db");
/** `server/` — one level up from `src/db` and from `dist/db` alike, which is
    where drizzle.config.ts and node_modules are. */
const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/*
 * node-postgres, pooled.
 *
 * This used to be better-sqlite3, chosen because it was *synchronous*:
 * `getProfile`, `getAgent` and `listProjects` were called from synchronous
 * paths (spawnProc built a child process's env from all three). No Postgres
 * driver is synchronous and none can be, so those paths are `async` now and
 * `await` reaches spawnProc, sessions.ts and registry.ts. That is the price of
 * the dialect and it is paid once, here and at the call sites — everything
 * else about the storage rule is unchanged: every query in this codebase goes
 * through the `db` exported here, so swapping the driver is still a change to
 * this file and no other.
 *
 * The pool is small on purpose. The workload is one process talking to itself:
 * a replay is a single long read, and the writes are a streaming turn's
 * journal flush. Connections past a handful only add memory on the server side
 * and latency to the first query after a spike.
 */
const pool = new pg.Pool({
  connectionString: CONNECTION_STRING,
  max: 10,
  // A pooled connection that has been idle this long is closed rather than
  // held open across a night of nothing happening.
  idleTimeoutMillis: 30_000,
  // Fail the query rather than hang forever when the server is gone; every
  // caller already renders a thrown query as an error.
  connectionTimeoutMillis: 10_000,
});
/* An idle pooled connection that the server drops (a restart, a proxy timeout)
   surfaces as an 'error' on the pool with nobody awaiting it, which is an
   unhandled error event and therefore a dead process. The pool discards the
   connection itself; this only has to keep the event from being fatal. */
pool.on("error", (error) => console.error("[db] idle connection error", error));

/*
 * `bigint` (int8) comes back from pg as a *string*, because 2^63 does not fit
 * a JS number. Every int8 in this schema is an epoch-millisecond stamp or a
 * counter — decades short of 2^53 — and the raw-SQL readers (search.ts,
 * session-journal.ts, project-stats.ts) select them straight into numbers.
 * Parsing globally is what keeps `db.execute` and drizzle's own reads agreeing
 * on the type of `at`.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

export const db = drizzle(pool, { schema });

/*
 * Top-level await: the schema has to exist and the SQLite import has to have
 * run before any other module's first query, and there is no synchronous
 * constructor left to hang that on. Importing `db` is therefore importing a
 * database that is ready — which is the same guarantee the old file gave, by
 * different means.
 */
await ensureSchema();
await migrateSqlite();
await importLegacyJson();

/** The database handle inside a transaction: the same query surface, minus the
    driver escape hatch and minus `transaction` itself. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/*
 * Which connection a query belongs to.
 *
 * SQLite had one connection, so `db.transaction(() => { ... })` could call any
 * helper in the codebase and everything it did was inside the transaction,
 * whether it knew about it or not. A pool does not work that way: `db` inside
 * such a callback hands out a *different* connection, so the writes would land
 * outside the transaction that was opened for them — committed independently,
 * and unable to see the rows the transaction is holding locks on.
 *
 * Threading a `tx` argument through every helper of boards.ts and
 * tasks-board.ts would say the same thing at the cost of touching every
 * signature between the transaction and the query. This says it once instead:
 * `transaction()` puts the handle in async-local storage for the duration of
 * the callback, and `conn()` is what a query is built on — the transaction
 * when there is one, the pool when there is not. The rule the codebase already
 * had ("every query goes through the `db` exported here") is unchanged; this
 * is only the answer to *which connection that is right now*.
 */
const active = new AsyncLocalStorage<Tx>();

/** The connection the caller's queries belong to. */
export function conn(): Tx {
  return active.getStore() ?? (db as unknown as Tx);
}

/**
 * Run `fn` inside one transaction, with `conn()` resolving to it throughout.
 *
 * Already inside one: the callback simply runs, because a nested BEGIN is not
 * what any of these callers mean — they mean "all of this, or none of it", and
 * the outer transaction already promises that.
 */
export function transaction<T>(fn: () => Promise<T>): Promise<T> {
  if (active.getStore()) return fn();
  return db.transaction((tx) => active.run(tx, fn));
}

/** Close the pool — for tests and for a clean shutdown. */
export async function closeDb(): Promise<void> {
  await pool.end();
}

/**
 * The schema is `schema.ts`, pushed — there are no migration files.
 *
 * A database that has never been pushed to (a first install, every test run)
 * is given the whole schema here by running `drizzle-kit push` once. Existing
 * databases are left alone at boot. For a schema change, `pnpm db:push` first
 * captures a full `pg_dump` under `data/backups/`, then runs Drizzle's diff;
 * the server never pushes a new schema silently on boot.
 *
 * The full-text index over the journal is the one object push does not manage
 * (drizzle.config.ts hides it), so it is created here, idempotently, on every
 * boot.
 */
async function ensureSchema(): Promise<void> {
  const fresh = await isFresh();
  if (fresh) {
    console.log(`[db] empty database at ${redact(CONNECTION_STRING)}; pushing the schema`);
    execFileSync(join(SERVER_ROOT, "node_modules", ".bin", "drizzle-kit"), ["push", "--force"], {
      cwd: SERVER_ROOT,
      env: { ...process.env, DATABASE_URL: CONNECTION_STRING, DAEDALUS_DATA_DIR: DATA_DIR },
      stdio: ["ignore", "ignore", "inherit"],
    });
  }
  /* Additive columns and tables the operator has not pushed yet (`pnpm db:push`
     is the documented step, but a server booting under a process manager must
     not come up broken for missing it). Postgres spells the no-op itself with
     IF NOT EXISTS, so unlike the SQLite version this needs no try/catch around
     a duplicate-column error. */
  await db.execute(sql`
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS suggest_followups BOOLEAN NOT NULL DEFAULT TRUE
  `);
  await db.execute(sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS rules TEXT`);
  /* A thread's git worktree (worktree.ts). */
  await db.execute(sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS worktree TEXT`);
  /* The rules table (rules.ts). */
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS rules (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS rules_project ON rules(project_id)`);
  /* Migrate the old single-blob rules from app_settings into the rules table,
     once. The old row is removed so it does not accumulate on future boots.
     Idempotent: only runs if the rules table is empty and the old blob
     exists. */
  const existingRules = await db.execute<{ one: number }>(sql`SELECT 1 AS one FROM rules LIMIT 1`);
  const legacy = await db.execute<{ value: string }>(
    sql`SELECT value FROM app_settings WHERE key = 'rules'`,
  );
  const blob = legacy.rows[0]?.value?.trim();
  if (existingRules.rows.length === 0 && blob) {
    const t = Date.now();
    await db.execute(sql`
      INSERT INTO rules (id, project_id, title, content, sort_order, created_at, updated_at)
      VALUES (${randomUUID()}, NULL, 'Global rules', ${blob}, 0, ${t}, ${t})
    `);
    await db.execute(sql`DELETE FROM app_settings WHERE key = 'rules'`);
  }
  /* A thread's OpenTelemetry spans (tracing.ts). */
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS trace_spans (
      span_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      parent_span_id TEXT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      start DOUBLE PRECISION NOT NULL,
      "end" DOUBLE PRECISION NOT NULL,
      status TEXT NOT NULL,
      status_message TEXT,
      attributes JSONB NOT NULL,
      events JSONB NOT NULL
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS trace_spans_session ON trace_spans(session_id, start)`);
  await ensureSearchIndex();
}

/**
 * The full-text index over the journal.
 *
 * SQLite's half of this was an FTS5 virtual table, which Postgres has no
 * equivalent of: full text here is an ordinary table carrying a **generated**
 * `tsvector` beside the prose and a GIN index over it. Generated rather than
 * written by hand so `search.ts` inserts prose and nothing else — there is no
 * second value for a writer to forget, and no trigger to keep in step with the
 * configuration the queries use.
 *
 * `'simple'` and not `'english'`: transcripts are code, paths and identifiers
 * as much as prose, and a stemmer that turns `sessions` into `session` also
 * turns a filename into something the user cannot search for by typing it.
 * Diacritics are folded by `unaccent` where the extension is available — it is
 * in contrib rather than core, so a server without it (or a role without
 * CREATE) keeps the unfolded configuration rather than failing to boot.
 */
async function ensureSearchIndex(): Promise<void> {
  /* No surrogate key: nothing reads one (deletes are by session, reads are by
     `tsv`), and a `bigserial` here would own a sequence that `drizzle-kit
     push` sees, does not recognise and tries to DROP — which fails, because
     the column it is hidden behind still defaults from it, and takes every
     later push down with it. `tablesFilter` can hide the table; it cannot hide
     the sequence. */
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS session_events_fts (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      at BIGINT NOT NULL DEFAULT 0,
      text TEXT NOT NULL,
      tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED
    )
  `);
  /* An install created before the surrogate key was removed still has the
     column and its sequence; dropping it here is what makes the next push
     succeed. IF EXISTS, so this is a no-op everywhere else. */
  await db.execute(sql`ALTER TABLE session_events_fts DROP COLUMN IF EXISTS id`);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS session_events_fts_tsv ON session_events_fts USING GIN (tsv)
  `);
  /* Deletes are by session (`deleteSearchIndex`), and ordering is by (at, seq)
     within one — the same two shapes the SQLite index was read through. */
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS session_events_fts_session
      ON session_events_fts (session_id, at DESC, seq DESC)
  `);
}

/** True when this database has never been pushed to. `to_regclass` answers
    null for a table that is not there instead of throwing, which is what makes
    it askable of a database that holds nothing at all. */
async function isFresh(): Promise<boolean> {
  try {
    const result = await db.execute<{ table: string | null }>(
      sql`SELECT to_regclass('public.sessions') AS table`,
    );
    return !result.rows[0]?.table;
  } catch (error) {
    throw new Error(
      `[db] cannot reach Postgres at ${redact(CONNECTION_STRING)} — set DATABASE_URL, or start ` +
        `the server and create the database (createdb daedalus). ${String(error)}`,
    );
  }
}

/** A connection string with its password removed, for a log line. */
function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "the configured database";
  }
}

/**
 * Move a pre-Postgres install's `data/daedalus.db` into the database, once.
 *
 * Idempotent by rename: the file becomes `daedalus.db.migrated`, so a second
 * boot finds nothing to do and the original is still there to read if the copy
 * got something wrong. It is also refused outright unless the Postgres side is
 * empty, because the failure this has to be safe against is a server pointed
 * at a database that already has threads in it.
 *
 * SQLite is read through `node:sqlite` rather than better-sqlite3: this is the
 * only thing left in the codebase that reads that file, and a native
 * dependency carried for one boot's worth of work is a dependency the deploy
 * has to build. Read-only, so a copy that goes wrong cannot damage the source.
 *
 * The copy is generic — the two schemas have the same table and column names,
 * so what is left is coercing the values SQLite had no types for: `0`/`1` into
 * `boolean`, JSON *text* into `jsonb`. The order is the FK graph's, read from
 * Postgres itself, so a child never lands before its parent. One transaction:
 * a half-migrated install would be worse than either outcome.
 */
async function migrateSqlite(): Promise<void> {
  if (!existsSync(SQLITE_PATH)) return;
  const occupied = await db.execute<{ one: number }>(sql`SELECT 1 AS one FROM sessions LIMIT 1`);
  if (occupied.rows.length > 0) {
    console.warn(
      `[db] ${SQLITE_PATH} is still here but ${redact(CONNECTION_STRING)} already has threads in ` +
        `it; not migrating. Move the file aside once you are sure it is not needed.`,
    );
    return;
  }

  const { DatabaseSync } = await import("node:sqlite");
  const source = new DatabaseSync(SQLITE_PATH, { readOnly: true });
  try {
    const sqliteTables = new Set(
      source
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String((row as { name: unknown }).name)),
    );
    const targets = (await tableOrder()).filter((name) => sqliteTables.has(name));
    const types = await columnTypes();

    let copied = 0;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const table of targets) {
        const columns = types.get(table);
        if (!columns) continue;
        /* Read a page at a time, never the whole table.
           `SELECT * FROM session_events` is a million rows of JSON payload —
           over a gigabyte once it is JS objects — and `.all()` on it is how
           this ran the process out of heap before it wrote a single row. Every
           table SQLite made has a rowid, and paging by `rowid > last` is a
           seek per page rather than the row scan `OFFSET` would repeat.

           Batched on the write side for the same reason it is paged on the
           read side: a journal of a million events is the whole point of this
           being a migration and not a script someone runs overnight. */
        const PAGE = 1_000;
        const page = source.prepare(
          `SELECT rowid AS __rowid, * FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ${PAGE}`,
        );
        let cursor = 0;
        let names: string[] | null = null;
        let quoted = "";
        for (;;) {
          const rows = page.all(cursor) as Record<string, unknown>[];
          if (rows.length === 0) break;
          cursor = Number(rows[rows.length - 1].__rowid);
          if (!names) {
            // Only the columns both sides declare: a column SQLite has and the
            // current schema.ts dropped is not something to fail the migration
            // on, and `__rowid` is this loop's own, never the table's.
            names = Object.keys(rows[0]).filter((name) => name !== "__rowid" && columns.has(name));
            if (names.length === 0) break;
            quoted = names.map((name) => `"${name}"`).join(", ");
          }
          const values: unknown[] = [];
          const tuples = rows.map((row) => {
            const placeholders = names!.map((name) => {
              values.push(coerce(row[name], columns.get(name)!));
              return `$${values.length}`;
            });
            return `(${placeholders.join(", ")})`;
          });
          await client.query(
            `INSERT INTO "${table}" (${quoted}) VALUES ${tuples.join(", ")} ON CONFLICT DO NOTHING`,
            values,
          );
          copied += rows.length;
          if (rows.length < PAGE) break;
        }
      }
      /* Every `bigserial` this schema has was handed explicit ids by the copy,
         so its sequence still believes the table is empty and the next insert
         would collide. */
      await resetSequences(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    console.log(
      `[db] migrated ${copied} row(s) from ${SQLITE_PATH} into ${redact(CONNECTION_STRING)}; ` +
        `the original is kept as daedalus.db.migrated`,
    );
  } finally {
    source.close();
  }
  renameSync(SQLITE_PATH, `${SQLITE_PATH}.migrated`);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${SQLITE_PATH}${suffix}`)) {
      renameSync(`${SQLITE_PATH}${suffix}`, `${SQLITE_PATH}.migrated${suffix}`);
    }
  }
}

/**
 * Every table this schema declares, parents before children.
 *
 * The edges are read from Postgres rather than from `schema.ts` because that
 * is what the inserts actually have to satisfy — including the ones a hand
 * `CREATE TABLE` above added. A cycle (there are none today) would leave the
 * remaining tables in declaration order rather than looping.
 */
async function tableOrder(): Promise<string[]> {
  const declared = await db.execute<{ name: string }>(sql`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  const edges = await db.execute<{ child: string; parent: string }>(sql`
    SELECT child.relname AS child, parent.relname AS parent
    FROM pg_constraint c
    JOIN pg_class child ON child.oid = c.conrelid
    JOIN pg_class parent ON parent.oid = c.confrelid
    WHERE c.contype = 'f'
  `);
  const pending = new Set(declared.rows.map((row) => row.name));
  const parents = new Map<string, Set<string>>();
  for (const { child, parent } of edges.rows) {
    if (child === parent) continue; // a self-reference orders nothing
    if (!parents.has(child)) parents.set(child, new Set());
    parents.get(child)!.add(parent);
  }
  const ordered: string[] = [];
  while (pending.size > 0) {
    const ready = [...pending].filter((name) =>
      [...(parents.get(name) ?? [])].every((parent) => !pending.has(parent)),
    );
    // A cycle: nothing is ready and the rest goes in as it came.
    const next = ready.length > 0 ? ready : [...pending];
    for (const name of next) {
      ordered.push(name);
      pending.delete(name);
    }
  }
  return ordered;
}

/** `table -> column -> pg data type`, for the coercion below. */
async function columnTypes(): Promise<Map<string, Map<string, string>>> {
  const rows = await db.execute<{ table: string; column: string; type: string }>(sql`
    SELECT table_name AS table, column_name AS column, data_type AS type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND is_generated = 'NEVER'
  `);
  const out = new Map<string, Map<string, string>>();
  for (const row of rows.rows) {
    if (!out.has(row.table)) out.set(row.table, new Map());
    out.get(row.table)!.set(row.column, row.type);
  }
  return out;
}

/**
 * SQLite's value for a column into Postgres's.
 *
 * The three that need it: a boolean, which SQLite stored as `0`/`1`; a JSON
 * column, which it stored as text — a `jsonb` parameter given a string is
 * parsed, which is exactly the round trip wanted, so the only case left is a
 * value that somehow is not one; and the NUL character, which SQLite stores
 * happily and Postgres cannot represent at all (`22P05`) — not in `text`, and
 * not inside a `jsonb` string even as the ` ` escape.
 *
 * A journal is transcripts, and a transcript quotes code: this repo's own
 * `.join("\0")` is in one, so the escape reaches the copy as data. Dropping
 * the character is the only lossless-enough answer — the alternative is
 * failing a migration over one byte of a code sample nobody will read again.
 */
function coerce(value: unknown, type: string): unknown {
  if (value === null || value === undefined) return null;
  if (type === "boolean") return value !== 0 && value !== "0" && value !== false;
  if (type === "jsonb" || type === "json") {
    return scrubJson(typeof value === "string" ? value : JSON.stringify(value));
  }
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return value.includes("\0") ? value.replaceAll("\0", "") : value;
  return value;
}

/**
 * A JSON document with every NUL taken out of it, strings and keys alike.
 *
 * The test comes first because it is the only part that runs a million times:
 * a document with no NUL in it — which is very nearly all of them — is handed
 * back untouched, and only the rare one pays for a parse and a re-serialise.
 * Text that does not parse is scrubbed literally rather than dropped, because
 * a column that was never really JSON is still a column with a value in it.
 */
export function scrubJson(raw: string): string {
  if (!raw.includes("\0") && !/\\u0000/i.test(raw)) return raw;
  const strip = (value: unknown): unknown => {
    if (typeof value === "string") return value.replaceAll("\0", "");
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, inner]) => [key.replaceAll("\0", ""), strip(inner)]),
      );
    }
    return value;
  };
  try {
    return JSON.stringify(strip(JSON.parse(raw)));
  } catch {
    return raw.replaceAll("\0", "").replace(/\\u0000/gi, "");
  }
}

/** Put every `bigserial` back ahead of the ids the copy inserted by hand. */
async function resetSequences(client: pg.PoolClient): Promise<void> {
  const sequences = await client.query<{ table: string; column: string; sequence: string }>(`
    SELECT c.table_name AS table, c.column_name AS column,
           pg_get_serial_sequence(quote_ident(c.table_name), c.column_name) AS sequence
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND pg_get_serial_sequence(quote_ident(c.table_name), c.column_name) IS NOT NULL
  `);
  for (const row of sequences.rows) {
    await client.query(
      `SELECT setval($1, COALESCE((SELECT MAX("${row.column}") FROM "${row.table}"), 0) + 1, false)`,
      [row.sequence],
    );
  }
}

/**
 * Move a pre-SQLite install's `data/*.json` into the database, once.
 *
 * Idempotent by rename: an imported file becomes `<name>.json.imported`, so a
 * second boot finds nothing to do and the original is still there to read if
 * the import got something wrong. Runs in one transaction — a half-imported
 * install would be worse than either outcome.
 */
async function importLegacyJson(): Promise<void> {
  const legacy = (name: string) => join(DATA_DIR, name);
  const present = [
    "agents.json",
    "profiles.json",
    "projects.json",
    "mcp-servers.json",
    "skills.json",
    "sessions.json",
    "push-tokens.json",
  ].filter((name) => existsSync(legacy(name)));
  if (present.length === 0) return;

  interface LegacyProject {
    id: string;
    name?: string;
    cwd?: string;
  }
  interface LegacySession {
    id: string;
    profileId?: string;
    projectId?: string;
    agentId?: string;
    model?: string;
    effort?: string;
    title?: string;
    acpSessionId?: string;
    createdAt?: number;
    deletedAt?: number | null;
  }

  const agents = readJson<(typeof schema.agents.$inferSelect)[]>(legacy("agents.json"), []);
  // Pre-SQLite profiles bound to one agent (`agentId`); today's row names a
  // set. The import writes the old binding as a one-entry map.
  type LegacyProfile = Omit<typeof schema.profiles.$inferSelect, "agents"> & {
    agentId?: string;
    agents?: Record<string, schema.ProfileAgentLink>;
  };
  const profiles = readJson<LegacyProfile[]>(legacy("profiles.json"), []);
  const projects = readJson<LegacyProject[]>(legacy("projects.json"), []);
  const mcp = readJson<(typeof schema.mcpServers.$inferSelect)[]>(legacy("mcp-servers.json"), []);
  const skills = readJson<(typeof schema.skills.$inferSelect)[]>(legacy("skills.json"), []);
  const sessions = readJson<LegacySession[]>(legacy("sessions.json"), []);
  const tokens = readJson<string[]>(legacy("push-tokens.json"), []);

  const now = Date.now();
  await db.transaction(async (tx) => {
    for (const agent of agents) {
      await tx
        .insert(schema.agents)
        .values({
          id: agent.id,
          name: agent.name,
          command: agent.command,
          args: agent.args ?? [],
          env: agent.env ?? {},
          spawnCategories: agent.spawnCategories ?? null,
          // 0, so the DEFAULT_AGENTS merge in registry.ts still gets to add
          // whatever this install has never seen.
          seededVersion: 0,
        })
        .onConflictDoNothing();
    }
    for (const profile of profiles) {
      await tx
        .insert(schema.profiles)
        .values({
          id: profile.id,
          name: profile.name,
          agents: profile.agents ?? (profile.agentId ? { [profile.agentId]: {} } : {}),
          baseUrl: profile.baseUrl ?? "",
          apiKey: profile.apiKey ?? "",
          defaultModel: profile.defaultModel ?? "",
          smallModel: profile.smallModel ?? "",
          models: profile.models ?? [],
        })
        .onConflictDoNothing();
    }
    for (const server of mcp) {
      await tx.insert(schema.mcpServers).values({ ...server }).onConflictDoNothing();
    }
    for (const skill of skills) {
      await tx.insert(schema.skills).values({ ...skill }).onConflictDoNothing();
    }
    // A pre-SQLite project also carried MCP/skill id lists; those are not
    // imported — projects link nothing now (links belong to profiles and
    // threads), and a stale id in an old file is exactly what they held.
    for (const project of projects) {
      await tx
        .insert(schema.projects)
        .values({ id: project.id, name: project.name ?? "", cwd: project.cwd ?? "" })
        .onConflictDoNothing();
    }
    for (const session of sessions) {
      await tx
        .insert(schema.sessions)
        .values({
          id: session.id,
          profileId: session.profileId ?? "",
          projectId: session.projectId ?? "",
          agentId: session.agentId ?? "",
          model: session.model ?? "",
          effort: session.effort ?? "",
          title: session.title ?? "New thread",
          acpSessionId: session.acpSessionId ?? null,
          createdAt: session.createdAt ?? now,
          deletedAt: session.deletedAt ?? null,
        })
        .onConflictDoNothing();
    }
    for (const token of tokens) {
      await tx.insert(schema.pushTokens).values({ token, createdAt: now }).onConflictDoNothing();
    }
  });

  for (const name of present) renameSync(legacy(name), `${legacy(name)}.imported`);
  console.log(
    `[db] imported ${present.length} legacy JSON file(s) into ${redact(CONNECTION_STRING)}; ` +
      `originals kept as *.json.imported`,
  );
}
