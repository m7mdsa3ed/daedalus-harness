/*
 * Which database the test suite is allowed to write to.
 *
 * Shared by `test/require-temp-data.ts` (which creates it) and
 * `scripts/test-db.mjs` (which drops it) so the two can never disagree about
 * the name and leave a scratch database nobody can reach.
 *
 * It deliberately does NOT go through `config.ts`. The tests run with
 * `DAEDALUS_DATA_DIR` pointed at a temp directory, so `config.ts` would read a
 * `config.json` that is not there and answer with the *default* connection
 * string — a different server, or a different database, than the install the
 * scratch name has to be derived from and compared against. This reads the
 * install's own `server/data/config.json` directly, by path, for the same
 * reason `config.ts` reads it: it is bootstrap, and it is needed before
 * anything else is ready.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DATABASE_URL = "postgres://postgres@localhost:5432/daedalus";

/** The install's database: DATABASE_URL, then `data/config.json`, then the
    default — the same order `config.ts` uses, against the real data dir. */
export function installDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const candidate of ["config.json", "config.json.bak"]) {
    const path = join(SERVER_ROOT, "data", candidate);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { databaseUrl?: string };
      if (parsed.databaseUrl) return parsed.databaseUrl;
    } catch {
      // A torn write; try the backup, then the default.
    }
  }
  return DEFAULT_DATABASE_URL;
}

/**
 * `{ install, scratch, name }` — the install's URL, the suite's, and the
 * scratch database's bare name.
 *
 * The scratch database is the install's with `_test_<file>` appended, so one
 * Postgres serves both and nothing has to be configured for a checkout to run
 * the tests. **One per test file**, keyed off `DAEDALUS_DATA_DIR` the way the
 * SQLite file it replaced was: the files share a process manager, not a
 * fixture, and several of them assert on "every session there is". A single
 * shared database hands the next file the rows the last one left — which is
 * not a hypothetical, it is what made `manager.list()[0]` a thread from
 * another test.
 *
 * They are kept between runs rather than dropped, so only the first run of
 * each pays for `drizzle-kit push`; every test already empties what it uses.
 * `DAEDALUS_TEST_DATABASE_URL` overrides the whole scheme for a CI server that
 * hands out its own.
 */
export function testDatabaseUrl() {
  const install = new URL(installDatabaseUrl());
  const scratch = new URL(process.env.DAEDALUS_TEST_DATABASE_URL ?? install.toString());
  if (!process.env.DAEDALUS_TEST_DATABASE_URL) {
    /* `/tmp/daedalus-test-boards` → `boards`. Non-word characters become `_`
       so the result is a legal identifier, and the whole thing is capped well
       under Postgres's 63-byte limit. */
    const suffix = (process.env.DAEDALUS_DATA_DIR ?? "")
      .split(/[\\/]/)
      .filter(Boolean)
      .pop()
      ?.replace(/^daedalus[-_]?test[-_]?/, "")
      .replace(/\W+/g, "_")
      .slice(0, 24);
    scratch.pathname = `${install.pathname}_test${suffix ? `_${suffix}` : ""}`;
  }
  return {
    install,
    scratch,
    name: decodeURIComponent(scratch.pathname.replace(/^\//, "")),
    /** True when the two are the same database — always a refusal. */
    isInstall: scratch.host === install.host && scratch.pathname === install.pathname,
  };
}
