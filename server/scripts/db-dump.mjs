/*
 * `pnpm db:export` and `pnpm db:import` — the whole database, as one .sql file.
 *
 * Both halves are here rather than in two package.json one-liners for one
 * reason: **which database** is `config.ts`'s answer, not a second one spelled
 * in a script. `databaseUrl()` reads DATABASE_URL, then `data/config.json`,
 * then the default — the same order the server and `drizzle.config.ts` use, so
 * a dump can never quietly come from a database the server is not running on.
 *
 *   pnpm db:export [path]   → writes data/backups/daedalus-<stamp>.sql by default
 *   pnpm db:import <path>   → restores that file into the configured database
 *
 * This is **not** `src/backup.ts`. That is the harness's own portable document
 * (one JSON, one transaction, deliberately excluding the server token, the
 * probe cache and `history_*`) and it is what moves an install between
 * machines. This is the dialect's own dump: everything, including the rows
 * backup refuses to carry, restorable only into Postgres. Use it before a
 * schema push you are unsure of, not as the thing you hand another user.
 *
 * Credentials never reach the argv a `ps` can read: the connection is passed
 * to both tools through PGPASSWORD and discrete flags, and every log line goes
 * through `redact`.
 *
 * The dump is `--clean --if-exists`, so an import is a *replacement* and not a
 * merge — restoring into a database with threads in it drops them first. That
 * is the only behaviour that makes a restore mean what it says, and it is why
 * `db:import` refuses to run without the path spelled out.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR, databaseUrl } from "../src/config.js";

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The connection, split into the flags `pg_dump`/`psql` take. Parsing the URL
    rather than passing it whole is what keeps the password out of argv. */
function connection() {
  const url = new URL(databaseUrl());
  const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres";
  return {
    url,
    database,
    flags: [
      "--host", url.hostname || "localhost",
      "--port", url.port || "5432",
      "--username", decodeURIComponent(url.username) || "postgres",
      "--dbname", database,
    ],
    env: {
      ...process.env,
      ...(url.password ? { PGPASSWORD: decodeURIComponent(url.password) } : {}),
    },
  };
}

/** A connection string with its password removed, for a log line. */
function redact(url) {
  const copy = new URL(url);
  if (copy.password) copy.password = "***";
  return copy.toString();
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit", cwd: SERVER_ROOT });
    child.on("error", (error) =>
      reject(
        error.code === "ENOENT"
          ? new Error(`${command} is not installed — install the postgresql-client package`)
          : error,
      ),
    );
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)),
    );
  });
}

/** `daedalus-2026-09-07T06-31-02.sql` — sortable, and legal on every filesystem. */
function defaultPath() {
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "-");
  return join(DATA_DIR, "backups", `daedalus-${stamp}.sql`);
}

async function main() {
  const [mode, target] = [process.argv[2], process.argv[3]];
  const { url, database, flags, env } = connection();

  if (mode === "export") {
    const out = target ? target : defaultPath();
    mkdirSync(dirname(out), { recursive: true });
    console.log(`[db] dumping ${redact(url)} → ${out}`);
    await run(
      "pg_dump",
      [
        ...flags,
        // A restore has to be able to replace what is there; without these the
        // second import of the same file fails on every existing object.
        "--clean",
        "--if-exists",
        // Plain SQL, no owner or grant statements: the role that restores is
        // whatever the target database uses, which is rarely the one that
        // dumped.
        "--format=plain",
        "--no-owner",
        "--no-privileges",
        "--file",
        out,
      ],
      env,
    );
    console.log(`[db] wrote ${out}`);
    return;
  }

  if (mode === "import") {
    if (!target) {
      throw new Error("usage: pnpm db:import <path/to/dump.sql>");
    }
    console.log(`[db] restoring ${target} → ${redact(url)} (this replaces ${database})`);
    await run(
      "psql",
      [
        ...flags,
        // Stop at the first real error rather than restoring half a database
        // and reporting success. The dump's own DROPs are `IF EXISTS`, so a
        // fresh target does not trip this.
        "--set", "ON_ERROR_STOP=1",
        "--single-transaction",
        "--quiet",
        "--file", target,
      ],
      env,
    );
    console.log(`[db] restored ${target}`);
    return;
  }

  throw new Error("usage: pnpm db:export [path] | pnpm db:import <path>");
}

main().catch((error) => {
  console.error(`[db] ${error.message}`);
  process.exit(1);
});
