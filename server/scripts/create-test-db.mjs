/*
 * Create the suite's scratch database, as a standalone process.
 *
 * `test/require-temp-data.ts` runs this with `execFileSync` rather than doing
 * the work itself, and the reason is ESM's evaluation order. A guard that
 * `await`s at the top level *suspends*, and a sibling import — `db/index.js`,
 * which opens the connection — is free to be evaluated while it is suspended.
 * The guard would then set DATABASE_URL after the database it names had already
 * been chosen, and the tests would run against whatever `config.ts` defaulted
 * to. Nothing about "imported first" prevents that; only being synchronous
 * does, and creating a database over a socket cannot be.
 *
 * Prints nothing on success. Exits non-zero with a readable line otherwise, so
 * the caller can pass the message straight through.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { testDatabaseUrl } from "./test-database-url.js";

/*
 * What the tables in a kept database were built from.
 *
 * `ensureSchema` pushes only into a database with no `sessions` table, which is
 * right for an install (a push is the operator's step, `pnpm db:push`) and
 * wrong for these: nobody runs `db:push` against a scratch database, and they
 * are kept between runs, so the day `schema.ts` gained a column every test file
 * started failing on the one it had never been told about — `column
 * "pinned_at" does not exist`, from a database created before the pin existed.
 *
 * So the fingerprint of `schema.ts` is stored on the database as its comment,
 * and a database whose comment does not match has its `public` schema dropped —
 * which is exactly the state `ensureSchema` pushes into. Cheap (one hash of one
 * file), and it costs a push only when the schema actually moved.
 */
const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "db", "schema.ts");
const fingerprint = `daedalus-test-schema:${createHash("sha256")
  .update(readFileSync(SCHEMA_PATH))
  .digest("hex")
  .slice(0, 32)}`;

const { scratch, name, isInstall } = testDatabaseUrl();
if (isInstall) {
  console.error(
    `the test database (${name}) is the configured one. These tests empty tables — ` +
      "set DAEDALUS_TEST_DATABASE_URL to a database you are willing to lose.",
  );
  process.exit(1);
}

/* `CREATE DATABASE` cannot run inside the database it creates, so the
   maintenance connection goes to `postgres` — the one database every server
   has. A role without CREATEDB gets that error here rather than a confusing
   failure inside `ensureSchema` later. */
const maintenance = new URL(scratch.toString());
maintenance.pathname = "/postgres";

const client = new pg.Client({ connectionString: maintenance.toString() });
try {
  await client.connect();
} catch (error) {
  console.error(
    `cannot reach Postgres at ${maintenance.host} to create the test database. ` +
      `Start it, or set DAEDALUS_TEST_DATABASE_URL. ${String(error)}`,
  );
  process.exit(1);
}
let fresh = false;
try {
  const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  // Quoted rather than parameterised: CREATE DATABASE takes no parameters, and
  // the name is derived from config, never from input.
  if (existing.rowCount === 0) {
    await client.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
    fresh = true;
  }
} catch (error) {
  console.error(`could not create the test database ${name}: ${String(error)}`);
  process.exit(1);
} finally {
  await client.end();
}

/*
 * Empty it, if it was already there.
 *
 * The SQLite file this replaced was deleted and re-made on every run, so each
 * test file started against nothing. A database kept between runs does not,
 * and several tests assert on "every session there is" — the first one to run
 * twice failed on rows its own previous run had left. Truncating gives the
 * same clean slate for a fraction of the cost of dropping and re-pushing.
 *
 * `session_events_fts` is included even though push does not manage it: it is
 * a table in this database like any other, and stale rows in it are stale
 * search results.
 */
const db = new pg.Client({ connectionString: scratch.toString() });
await db.connect();
try {
  const stored = await db.query(
    "SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = $1",
    [name],
  );
  const stale = !fresh && stored.rows[0]?.comment !== fingerprint;
  if (stale) {
    /* Everything, so `ensureSchema` sees a database it has never pushed to and
       pushes the whole current schema. Dropping the schema rather than the
       database keeps this on the one connection and needs no maintenance
       round trip. */
    await db.query("DROP SCHEMA public CASCADE");
    await db.query("CREATE SCHEMA public");
  } else if (!fresh) {
    /*
     * Empty it, if it was already there and still matches.
     *
     * The SQLite file this replaced was deleted and re-made on every run, so
     * each test file started against nothing. A database kept between runs does
     * not, and several tests assert on "every session there is" — the first one
     * to run twice failed on rows its own previous run had left. Truncating
     * gives the same clean slate for a fraction of the cost of dropping and
     * re-pushing.
     *
     * `session_events_fts` is included even though push does not manage it: it
     * is a table in this database like any other, and stale rows in it are
     * stale search results.
     */
    const tables = await db.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    if (tables.rowCount > 0) {
      const list = tables.rows
        .map((row) => `"${row.tablename.replaceAll('"', '""')}"`)
        .join(", ");
      // One statement, so the foreign keys between them are never half-cleared.
      await db.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
    }
  }
  /* Written whichever way it went: a fresh or just-dropped database is about to
     be pushed from this exact `schema.ts` by `ensureSchema`. Quoted, never
     parameterised — COMMENT takes no parameters, and both halves are derived
     from config and a file hash. */
  await db.query(
    `COMMENT ON DATABASE "${name.replaceAll('"', '""')}" IS '${fingerprint.replaceAll("'", "''")}'`,
  );
} catch (error) {
  console.error(`could not prepare the test database ${name}: ${String(error)}`);
  process.exit(1);
} finally {
  await db.end();
}
