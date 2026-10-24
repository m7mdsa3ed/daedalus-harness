# Phase 6: completeness

## Context

- **There is no operator guide.** `README.md` describes an older app: SQLite and JSON data
  files, port 8791, the browser as the ACP client, `npx` agents, a `/journal` route that does
  not exist, steering as a concurrent prompt. Nothing covers Postgres, the agent binaries,
  `patch:acp`, TLS, backups or upgrades.
- **`AGENT.md` is a stale copy, not a symlink.** CLAUDE.md says one links to the other; they are
  separate files (87 KB vs 95 KB). `agent/src/instructions.ts:26` reads `AGENT.md` first, so
  every Daedalus turn gets the SQLite-era rules before the current ones, both truncated.
- **The client has gaps a user hits.** Most dock panels have no error boundary
  (`dock-surface.tsx:358`), so a throw in a page, terminal or the sidebar replaces the whole app.
  A server outage or a bad token on a cold load shows "Finish the setup" (`catalog.ts:59`). The
  compat screen's upgrade command fails from the repo root (`lib/compat.ts:22`).
- **Electron cannot be released.** No signing or notarization, mac target `dmg` only (the
  updater needs `zip`), no `NSMicrophoneUsageDescription`, and every runtime dependency packed
  into the asar.
- **No LICENSE**, and dead files are tracked.

## Steps

1. **Docs**:
   - Rewrite `README.md`: Postgres, port 4001 under pm2, the server as ACP client, the seeded
     agents, global binaries never npx, the test commands in all three packages.
   - Add `docs/deploy.md`: Postgres 18 and its client, agent binaries and minimum versions
     (claude-agent-acp 0.89.0, codex-acp 2.0.1), `patch:acp` per upgrade, the tunnel and TLS,
     the token, backups and restore (link phase 2's runbook), upgrades, `pm2:kill-agents` under
     the hosted sandbox.
   - Add `server/.env.example` listing every env var the server reads.
   - Fix stale comments: `ecosystem.config.cjs:10`, `config.ts:10`, `build.sh:9`,
     `db/index.ts:293`.
2. **Rules file**: `git rm AGENT.md && ln -s CLAUDE.md AGENT.md` (optionally `AGENTS.md` for
   codex), and cut the file down: 95 KB is about 24k tokens on every turn of every runtime.
3. **Client**:
   - An `ErrorBoundary` around each dock panel (`resetKeys` on its params), the sidebar and the
     header.
   - A "can't reach server / token rejected" state with Retry and Edit connection, and a 401
     after connect that leads back to it.
   - The upgrade command in `lib/compat.ts:22`:
     `git pull && pnpm --dir client build && pnpm --dir server pm2:start`.
   - A mixed-content hint on the connect screen for an https PWA pointed at an http server;
     drop the always-checked profile step in `landing-setup.tsx`.
   - `aria-label`s on the combobox clear and trigger buttons.
   - Client crash reports go to the server's event log (or Bugsnag).
4. **Electron release**: a mac `["dmg","zip"]` target, signing and notarization from env,
   `mac.extendInfo.NSMicrophoneUsageDescription`, `node_modules` kept out of the asar except
   `electron-updater`, and a default update feed.
5. **LICENSE** at the root and a `license` field in each manifest.
6. **Delete dead files**: `client/describe-airlock.mjs`, `describe-run.mjs`,
   `describe-ts-entry.ts`/`.mjs`, `run-describe.mjs`, `d-client-dev`, `public/prototypes/`,
   `public/vite.svg`, the `ws` dependency; `agent/src/daedalus.db`; `server/asyncify.mjs`;
   `.commandcode/taste/taste.md`. Replace `client/README.md` (Vite boilerplate).
7. **`.gitignore`**: `git rm -r --cached .opencode/skills` and ignore `.opencode/skills/`,
   `.claude/skills/`, `.claude/worktrees/`, `server/dist-demo/`.
8. **Precache**: add `typescript-*`, `pptx-preview`, `exceljs` to `globIgnores`; lower
   `chunkSizeWarningLimit` so the 1.94 MB entry chunk stays visible.

## Done when

- A new operator can deploy from `docs/deploy.md` alone, on a fresh machine.
- `readlink AGENT.md` prints `CLAUDE.md`.
- Killing a page panel's render shows that panel's error, not a blank app; stopping the server
  shows "can't reach".
- A signed Electron build installs on Windows and macOS and finds an update.
