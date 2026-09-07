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
import pg from "pg";
import { testDatabaseUrl } from "./test-database-url.js";

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
if (!fresh) {
  const db = new pg.Client({ connectionString: scratch.toString() });
  await db.connect();
  try {
    const tables = await db.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    if (tables.rowCount > 0) {
      const list = tables.rows
        .map((row) => `"${row.tablename.replaceAll('"', '""')}"`)
        .join(", ");
      // One statement, so the foreign keys between them are never half-cleared.
      await db.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
    }
  } catch (error) {
    console.error(`could not empty the test database ${name}: ${String(error)}`);
    process.exit(1);
  } finally {
    await db.end();
  }
}
