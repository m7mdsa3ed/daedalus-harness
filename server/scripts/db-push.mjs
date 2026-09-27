/*
 * Safe schema push: capture a restorable dump of the configured PostgreSQL
 * database before Drizzle is allowed to change it. The database URL and
 * password handling match db-dump.mjs, so the safety copy cannot silently
 * target a different database or leak its credential in argv.
 */
import { spawn } from "node:child_process";
import { mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR, databaseUrl } from "../src/config.js";

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function connection() {
  const url = new URL(databaseUrl());
  const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres";
  return {
    url,
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

function redact(url) {
  const copy = new URL(url);
  if (copy.password) copy.password = "***";
  return copy.toString();
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit", cwd: SERVER_ROOT });
    child.on("error", (error) =>
      reject(error.code === "ENOENT" ? new Error(`${command} is not installed — install the postgresql-client package`) : error),
    );
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)),
    );
  });
}

function defaultPath() {
  const stamp = new Date().toISOString().replace(/:/g, "-");
  return join(DATA_DIR, "backups", `pre-push-${stamp}-${process.pid}.sql`);
}

async function main() {
  const { url, flags, env } = connection();
  const dumpPath = defaultPath();
  mkdirSync(dirname(dumpPath), { recursive: true });
  console.log(`[db] backing up ${redact(url)} before schema push → ${dumpPath}`);

  try {
    await run("pg_dump", [
      ...flags,
      "--clean",
      "--if-exists",
      "--format=plain",
      "--no-owner",
      "--no-privileges",
      "--file", dumpPath,
    ], env);
    const dump = statSync(dumpPath);
    if (!dump.isFile() || dump.size === 0) throw new Error("pg_dump produced an empty backup");
  } catch (error) {
    try { unlinkSync(dumpPath); } catch {}
    throw error;
  }

  console.log(`[db] backup ready: ${dumpPath}`);
  await run(join(SERVER_ROOT, "node_modules", ".bin", "drizzle-kit"), ["push"], {
    ...env,
    DATABASE_URL: url.toString(),
  });
}

main().catch((error) => {
  console.error(`[db] schema push stopped: ${error.message}`);
  process.exit(1);
});
