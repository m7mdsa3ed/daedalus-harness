/*
 * `pnpm test:db:drop` — throw away the suite's scratch databases.
 *
 * There is one per test file (`<configured>_test_<file>`, created on demand by
 * test/require-temp-data.ts), left in place between runs so a re-run does not
 * pay for `drizzle-kit push` again. This is how to get rid of them — after a
 * schema change the push cannot make, or just to reclaim the disk. With no
 * `DAEDALUS_DATA_DIR` it drops every `<configured>_test*` there is; with one,
 * only that file's.
 *
 * Which database that is comes from `test-database-url.js`, the same module
 * the tests derive it from, so the two can never disagree about the name. It
 * refuses anyway if the answer comes out equal to the install's.
 */
import pg from "pg";
import { testDatabaseUrl } from "./test-database-url.js";

const { install, scratch, name, isInstall } = testDatabaseUrl();
if (isInstall) {
  console.error(`refusing: ${name} is the configured database, not a scratch one`);
  process.exit(1);
}
const installName = decodeURIComponent(install.pathname.replace(/^\//, ""));

if (process.argv[2] !== "drop") {
  console.error("usage: pnpm test:db:drop");
  process.exit(1);
}

const maintenance = new URL(scratch.toString());
maintenance.pathname = "/postgres";
const client = new pg.Client({ connectionString: maintenance.toString() });
await client.connect();
try {
  /* With no data dir named, every one of them: the per-file names all start
     `<install>_test`, and the install itself can never match that prefix
     because it is the prefix's own stem. */
  const targets = process.env.DAEDALUS_DATA_DIR
    ? [name]
    : (
        await client.query("SELECT datname FROM pg_database WHERE datname LIKE $1", [
          `${installName}\\_test%`,
        ])
      ).rows.map((row) => row.datname);
  for (const target of targets) {
    if (target === installName) continue;
    // WITH (FORCE): a test run that died leaves a connection behind, and a drop
    // that fails on it would need a manual `pg_terminate_backend` to clear.
    await client.query(`DROP DATABASE IF EXISTS "${target.replaceAll('"', '""')}" WITH (FORCE)`);
    console.log(`[db] dropped ${target}`);
  }
  if (targets.length === 0) console.log("[db] no test databases to drop");
} finally {
  await client.end();
}
