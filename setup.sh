#!/usr/bin/env bash
# First run, from a fresh clone to a running server — everything that has to
# happen before a browser can. Everything after it (agents, logins, profiles,
# projects) is the app's own first-run wizard.
#
#   ./setup.sh                 check, install, build, start, print the link
#   ./setup.sh --local         bind the server to 127.0.0.1 only (SSH is then
#                              its only door — the desktop app's SSH connect)
#   ./setup.sh --port 4001     the port to bind
#   ./setup.sh --no-start      stop after building; print how to start
#
# Idempotent: a second run changes nothing that is already true. It never
# installs system software (Node, pnpm, PostgreSQL): a missing one stops the
# run with the line that installs it. It never asks anything, so the desktop
# app can run it over SSH.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER="$ROOT/server"
LOCAL=0
PORT=""
START=1

while [ $# -gt 0 ]; do
  case "$1" in
    --local) LOCAL=1 ;;
    --port) PORT="${2:-}"; shift ;;
    --no-start) START=0 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
if [ -n "$PORT" ] && ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  echo "--port needs a number" >&2
  exit 2
fi

step() { printf '\n── %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

# ── 1. What has to be on the machine already ─────────────────────────────────
step "Checking prerequisites"
command -v git >/dev/null || fail "git is missing — install it with your package manager (apt install git, brew install git)."
command -v node >/dev/null || fail "Node.js is missing — install Node 22 or newer: https://nodejs.org (or: nvm install 22)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node $(node -v) is too old — install Node 22 or newer (nvm install 22)."
command -v pnpm >/dev/null || fail "pnpm is missing — install it with: corepack enable pnpm  (or: npm install -g pnpm)."
echo "✓ git, node $(node -v), pnpm $(pnpm -v)"

# ── 2. Dependencies and builds ───────────────────────────────────────────────
step "Installing and building"
"$ROOT/build.sh" --install all

# ── 3. Bootstrap config: the token, and where to bind ────────────────────────
# data/config.json is the server's bootstrap file (token, host, port, database
# URL). Written here rather than left to the first boot so the link below can
# carry the token before the server has ever run; the server keeps whatever it
# finds. pm2 reads server/.env over its own defaults, so a chosen host/port is
# written there too — otherwise pm2's DAEDALUS_PORT=4001 would win.
step "Writing the bootstrap config"
set_env() {
  local file="$SERVER/.env" key="$1" value="$2"
  touch "$file"
  if grep -q "^$key=" "$file"; then
    sed -i.bak "s|^$key=.*|$key=$value|" "$file" && rm -f "$file.bak"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}
[ "$LOCAL" -eq 1 ] && set_env DAEDALUS_HOST 127.0.0.1
[ -n "$PORT" ] && set_env DAEDALUS_PORT "$PORT"

LOCAL="$LOCAL" PORT="$PORT" node --input-type=module - "$SERVER/data/config.json" <<'NODE'
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const path = process.argv[2];
const config = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
config.token ??= randomBytes(24).toString("hex");
if (process.env.LOCAL === "1") config.host = "127.0.0.1";
if (process.env.PORT) config.port = Number(process.env.PORT);
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
NODE
echo "✓ server/data/config.json"

# ── 4. PostgreSQL ────────────────────────────────────────────────────────────
# Reached with the server's own driver, so no psql is needed. A database that
# does not exist yet is created; the server pushes the schema into an empty
# one on its first boot (db/index.ts ensureSchema). A server that cannot be
# reached at all is not installed from here.
step "Checking PostgreSQL"
(cd "$SERVER" && node --input-type=module -) <<'NODE'
import { readFileSync, existsSync } from "node:fs";
import pg from "pg";
const file = "data/config.json";
const fromFile = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).databaseUrl : undefined;
const url = process.env.DATABASE_URL ?? fromFile ?? "postgres://postgres@localhost:5432/daedalus";
const shown = url.replace(/\/\/([^:@/]+):[^@/]*@/, "//$1:***@");
const tryConnect = async (u) => {
  const client = new pg.Client({ connectionString: u, connectionTimeoutMillis: 5000 });
  await client.connect();
  return client;
};
try {
  (await tryConnect(url)).end();
  console.log(`✓ ${shown}`);
} catch (err) {
  if (err.code === "3D000") {
    const target = new URL(url);
    const name = decodeURIComponent(target.pathname.slice(1));
    target.pathname = "/postgres";
    const admin = await tryConnect(target.toString()).catch((e) => {
      console.error(`✗ The database "${name}" does not exist, and the server would not let this create it: ${e.message}`);
      console.error(`  Create it yourself: createdb ${name}`);
      process.exit(1);
    });
    await admin.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    await admin.end();
    console.log(`✓ created ${shown}`);
  } else {
    console.error(`✗ Cannot reach PostgreSQL at ${shown}: ${err.message}`);
    console.error("  Start one, then run this again. For example:");
    console.error("    Debian/Ubuntu:  sudo apt install postgresql && sudo -u postgres createuser -s \"$USER\"");
    console.error("    macOS:          brew install postgresql@16 && brew services start postgresql@16");
    console.error("    Docker:         docker run -d --name daedalus-pg -p 5432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16");
    console.error("  Or point DATABASE_URL (or databaseUrl in server/data/config.json) at one you have.");
    process.exit(1);
  }
}
NODE

# ── 5. Start ─────────────────────────────────────────────────────────────────
if [ "$START" -eq 1 ] && command -v pm2 >/dev/null; then
  step "Starting the server under pm2"
  pnpm --dir "$SERVER" pm2:start
  STARTED=pm2
else
  STARTED=""
fi

# ── 6. How to connect ────────────────────────────────────────────────────────
# The port the server binds: the env pm2 is given (server/.env over its own
# 4001), else the config file — the same order config.ts reads them in.
CONFIG_PORT="$(node -p "require('$SERVER/data/config.json').port ?? 8791")"
ENV_PORT="$(grep -s '^DAEDALUS_PORT=' "$SERVER/.env" | cut -d= -f2 || true)"
if [ "$STARTED" = pm2 ]; then BIND_PORT="${ENV_PORT:-4001}"; else BIND_PORT="${ENV_PORT:-$CONFIG_PORT}"; fi
TOKEN="$(node -p "require('$SERVER/data/config.json').token")"
if [ "$LOCAL" -eq 1 ]; then
  HOST=127.0.0.1
else
  HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
  HOST="${HOST:-localhost}"
fi
SERVER_URL="http://$HOST:$BIND_PORT"
ENC_URL="$(node -p "encodeURIComponent('$SERVER_URL')")"

step "Done"
if [ -z "$STARTED" ]; then
  echo "Start the server:   pnpm --dir server serve      (or install pm2 and run this again)"
fi
echo "Server:             $SERVER_URL"
echo "Serve the client:   pnpm --dir client preview --host"
echo "Then open:          http://$HOST:4173/?server=$ENC_URL&token=$TOKEN"
echo
echo "The link carries the access token: open it yourself, don't share it."
echo "The app takes it from there — agents, logins, profiles and your first project."
