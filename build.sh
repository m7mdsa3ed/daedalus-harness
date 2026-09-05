#!/usr/bin/env bash
# Build one, some or all of the harness's three buildable parts.
#
#   ./build.sh              ask which parts to build
#   ./build.sh all          agent, server and client
#   ./build.sh agent client just those, in the order given
#   ./build.sh --install all   run `pnpm install` in each part first
#
# There is no root package.json: each part is its own pnpm project, so every
# build runs with --dir from here and the repo root is never the cwd of a build.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARTS=(agent server client)
INSTALL=0
SELECTED=()

# What each part's `build` actually is, printed before it runs so a failure is
# read against the command that caused it.
describe() {
  case "$1" in
    agent)  echo "tsc -p tsconfig.build.json → agent/dist" ;;
    server) echo "tsc -p tsconfig.build.json → server/dist" ;;
    client) echo "tsc -b && vite build → client/dist (+ service worker)" ;;
  esac
}

usage() {
  cat <<USAGE
usage: ./build.sh [--install] [all | agent | server | client ...]

  --install   pnpm install in each selected part before building
  no argument prompts for the selection
USAGE
}

for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    -i|--install) INSTALL=1 ;;
    all) SELECTED=("${PARTS[@]}") ;;
    agent|server|client) SELECTED+=("$arg") ;;
    *) echo "unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

# Nothing named on the command line: ask. A non-interactive shell has no one to
# ask, so it gets the usage and a failure rather than a silent default.
if [ ${#SELECTED[@]} -eq 0 ]; then
  if [ ! -t 0 ]; then
    echo "no parts named and stdin is not a terminal" >&2
    usage >&2
    exit 2
  fi
  echo "What should be built?"
  for i in "${!PARTS[@]}"; do
    printf "  %d) %-7s %s\n" "$((i + 1))" "${PARTS[$i]}" "$(describe "${PARTS[$i]}")"
  done
  echo "  a) all three"
  read -r -p "> select (numbers, names, or 'a') [a]: " reply
  reply="${reply:-a}"
  for token in $reply; do
    case "$token" in
      1|agent)  SELECTED+=(agent) ;;
      2|server) SELECTED+=(server) ;;
      3|client) SELECTED+=(client) ;;
      a|all|A)  SELECTED=("${PARTS[@]}"); break ;;
      *) echo "not a part: $token" >&2; exit 2 ;;
    esac
  done
fi

# The same part named twice is built once.
UNIQUE=()
for part in "${SELECTED[@]}"; do
  case " ${UNIQUE[*]-} " in *" $part "*) continue ;; esac
  UNIQUE+=("$part")
done

echo
echo "building: ${UNIQUE[*]}"
FAILED=()
for part in "${UNIQUE[@]}"; do
  echo
  echo "── $part ── $(describe "$part")"
  if [ "$INSTALL" -eq 1 ]; then
    pnpm --dir "$ROOT/$part" install || { FAILED+=("$part (install)"); continue; }
  fi
  if pnpm --dir "$ROOT/$part" build; then
    echo "✓ $part"
  else
    # Every part is built even when an earlier one failed: one run reports every
    # break, rather than one per run.
    echo "✗ $part" >&2
    FAILED+=("$part")
  fi
done

echo
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "✓ built: ${UNIQUE[*]}"
else
  echo "✗ failed: ${FAILED[*]}" >&2
  exit 1
fi
