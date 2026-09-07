/**
 * Point the tests at a scratch database, and refuse to run without one.
 *
 * The tests that import this one delete rows — `db.delete(sessionsTable)` and
 * friends — from whatever database `db/index.js` opens. Under SQLite that was
 * `server/data/daedalus.db` unless `DAEDALUS_DATA_DIR` moved it, so the guard
 * was a check on that variable: running a test file directly (`tsx
 * test/backup.test.ts`) is exactly how a real install once lost every project,
 * thread and journal row it had, leaving the fixtures behind in their place.
 *
 * Postgres moved the answer. `DAEDALUS_DATA_DIR` still decides where files go,
 * but the database is `config.ts`'s `databaseUrl()` — DATABASE_URL, then
 * `data/config.json`, then the default — and a temp data dir does nothing to
 * it. A guard on the old variable would now pass while pointing at the install.
 *
 * So this names the scratch database itself (`scripts/test-database-url.ts`:
 * the install's, with `_test` appended), creates it if it is not there, and
 * sets DATABASE_URL to it before `db/index.js` is ever imported — which is why
 * this file is imported FIRST, and why every line of it is **synchronous**.
 * Being first is not enough on its own: ESM evaluates a module that awaits at
 * the top level by *suspending* it, and a sibling import is free to be
 * evaluated meanwhile — so an `await` here would let `db/index.js` pick its
 * connection before DATABASE_URL was set, and the tests would quietly run
 * against the install. Creating a database over a socket cannot be
 * synchronous, so it happens in a child process (`scripts/create-test-db.mjs`)
 * that this one waits for.
 *
 * The suite shares one scratch database: it runs one file at a time, every test
 * already empties what it uses, and keeping it means only the first run pays
 * for `drizzle-kit push`. `pnpm test:db:drop` throws it away.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { testDatabaseUrl } from "../scripts/test-database-url.js";

if (!process.env.DAEDALUS_DATA_DIR) {
  console.error(
    "refusing to run: this test writes files under DAEDALUS_DATA_DIR, and with it unset that is server/data/.\n" +
      "Run it through its npm script (pnpm test:backup, pnpm test:boards, …), or set DAEDALUS_DATA_DIR to a temp directory.",
  );
  process.exit(1);
}

const { scratch, name, isInstall } = testDatabaseUrl();
if (isInstall) {
  console.error(
    `refusing to run: the test database (${name}) is the configured one.\n` +
      "These tests empty tables. Set DAEDALUS_TEST_DATABASE_URL to a database you are willing to lose.",
  );
  process.exit(1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
try {
  execFileSync(
    process.execPath,
    [
      // The creator is `.mjs` but imports a `.ts` helper, so it needs tsx's
      // loader exactly as the test itself does.
      fileURLToPath(import.meta.resolve("tsx/cli")),
      join(HERE, "..", "scripts", "create-test-db.mjs"),
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
} catch {
  console.error("refusing to run: the test database could not be created (see above).");
  process.exit(1);
}

/* Set for `db/index.js`, imported next and reading it through `databaseUrl()`.
   Everything downstream — `drizzle-kit push` on a fresh database included —
   inherits it from the environment. */
process.env.DATABASE_URL = scratch.toString();
