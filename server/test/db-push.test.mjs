import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const serverRoot = fileURLToPath(new URL("..", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "daedalus-db-push-"));
const dataDir = join(temp, "data");
const binDir = join(temp, "bin");
mkdirSync(dataDir);
mkdirSync(binDir);
writeFileSync(join(dataDir, "config.json"), JSON.stringify({ databaseUrl: "postgres://test:secret@localhost:5432/daedalus_test" }));
const pgDump = join(binDir, "pg_dump");
writeFileSync(pgDump, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--file" ]; then
    shift
    printf 'partial dump' > "$1"
    break
  fi
  shift
done
exit 1
`);
chmodSync(pgDump, 0o755);

try {
  const result = spawnSync(join(serverRoot, "node_modules/.bin/tsx"), [join(serverRoot, "scripts/db-push.mjs")], {
    cwd: serverRoot,
    env: {
      ...process.env,
      DAEDALUS_DATA_DIR: dataDir,
      DATABASE_URL: "postgres://test:secret@localhost:5432/daedalus_test",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0, "a failed backup must fail the push");
  assert.match(result.stderr, /schema push stopped/);
  assert.deepEqual(readdirSync(join(dataDir, "backups")), [], "partial backup is removed");
  assert.doesNotMatch(result.stdout + result.stderr, /drizzle-kit/i, "Drizzle must not run after backup failure");
  console.log("db push backup failure guard passed");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
