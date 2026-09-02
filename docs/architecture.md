# Architecture & storage

_Extracted from CLAUDE.md; the rationale behind the rules summarised there._

## The server

- `server/` — Node 22 + Hono + ws. **The ACP client lives here.** It spawns an agent
  process per thread (agent registry, `{apiKey}`/`{baseUrl}`/`{model}`/`{cwd}` placeholders
  filled from profile + project) and drives the protocol over its stdio with
  `@agentclientprotocol/sdk` — one `AcpBridge` (`src/acp-bridge.ts`) per process, owning the
  handshake, `session/new`-vs-`session/load`, prompts, config, and the permission and
  elicitation requests the agent blocks on. What reaches the browser is *derived state*: the
  small command/event protocol in `src/protocol.ts`, over the same WebSocket. Also owns
  **profiles** (provider config: credentials/models, keys redacted from the API, plus the
  MCP/skill/command links every thread on it gets), **projects** (workspace: a cwd and a
  name — nothing linked), the **library** of reusable MCP servers/skills/commands
  and of **personas** (how a thread is worked on — one is *named* by a thread, not
  linked like the rest),
  bearer-token auth, the event log (reconnect/replay), and FCM push.
  `data/` holds secrets — gitignored, never commit.

## Storage: SQLite via Drizzle

- **Storage is SQLite via Drizzle** (`server/src/db/`), not JSON files.
  `data/daedalus.db`, opened with better-sqlite3 — chosen over `node:sqlite`/libsql because
  it is what Drizzle's Node driver binds to *and* it is synchronous, and `getProfile`/
  `getAgent`/`listProjects` are called from sync paths (`spawnAgent` builds a child's env from
  all three). Every query goes through the `db` exported by `db/index.ts`, so the driver is
  swappable in one file. **The schema is `db/schema.ts`, pushed — there are no migration
  files.** `pnpm db:push` after a schema change; a database that has never been opened gets
  the whole schema at boot (`ensureSchema` in `db/index.ts` runs `drizzle-kit push` once), so
  a first install and every test run need nothing by hand. A pre-SQLite install is imported once on first boot
  and its files kept as `*.json.imported` (`importLegacyJson`). Two things the JSON could not
  express: a profile's and a session's MCP/skill/command links are **join tables with
  `ON DELETE CASCADE`** (`profile_*`, `session_*`), so a dangling id cannot exist and nothing
  filters for one any more; and the **event log is a
  table** (`session_events`) keyed `(session_id, seq)` rather than an unbounded in-memory
  array, so `cursor` is a monotonic seq, a replay is a paged range scan, and a long thread
  costs no RAM — outliving its process, which is what makes a retired thread readable
  without one. Writes are buffered and flushed on the next tick in one transaction (a
  streaming turn is thousands of events, and the serialization belongs off the emit path);
  every read and every delete flushes first, so nothing can observe a log missing its
  newest events. `data/config.json`
  is the deliberate holdout — bootstrap (host/port/token/FCM path), hand-editable, and needed
  before any database exists.

## The agent runtime (`agent/`)

- `agent/` — **the harness's own ACP agent runtime** ("Daedalus Agent", registry id
  `daedalus`, seed 14), an independent package like the other two: an agent loop on the
  Vercel AI SDK (`streamText` + tools), OpenAI-compatible chat completions only, spawned
  as `node agent/dist/index.js` (`{daedalusAgentEntry}` in `registry.ts`;
  `DAEDALUS_AGENT_ENTRY` overrides, and the server's `pm2:start` runs `build:agent`).
  Configured entirely through `DAEDALUS_AGENT_*` env filled from the profile — the
  literal string `"null"` means unset, matching the unquoted-JSON placeholders. It
  implements the full surface the bridge negotiates: session/load replay and
  session/list from its own store (`~/.daedalus-agent/`, JSONL per session + index —
  which is what makes it importable), steering, four permission modes incl. `plan`,
  request_permission with sticky always-answers, form elicitation (`ask_user`, offered
  only when the client claims it), ACP plans (`write_todos`), model/effort/boolean
  config options (`liveConfig: "acp"` — the model select is read back from the
  allowlist the server materializes into `<cwd>/.claude/settings.local.json`), codex-
  style `_meta.terminal_output_delta` streaming from `bash`, MCP servers via
  `@modelcontextprotocol/sdk` wrapped in `dynamicTool` (`mcp__<server>__<tool>`),
  materialized commands/skills, persona via `{personaFile}`, compaction past ~80% of
  the window, and the subagent RFD (`task` tool) with a journal-only fallback.
  It also reads the instruction files a repo already has — `AGENTS.md`,
  `CLAUDE.md`, `CLAUDE.local.md` from the cwd up to the **git root** (above a
  checkout is somebody's home directory) plus `~/.claude/CLAUDE.md` first and
  weakest — deduped by real path *and* by content, since `AGENTS.md ->
  CLAUDE.md` is a symlink half the repos in the wild ship; each block is
  labelled with its path so a rule can be traced to the file that set it. **The
  whole walk runs every turn, not once at `session/new`** — it is ~70
  `statSync` calls against a turn about to spend seconds in a model, and
  resolving it once meant a `CLAUDE.md` that did not exist when the thread
  opened stayed invisible until a respawn, which is exactly the file an agent
  asked to write down how the repo works has just created. They sit *before*
  the persona, which is the choice made for this thread on top of them. `agent/docs/` is the standalone,
  prompting and management guide.
  **The agent row is editable now** (`PUT /api/agents/:id`, `POST
  /api/agents/:id/reset`, Settings › Agents): exactly the four fields the seed
  rules already promise never to overwrite — name, command, args, env — so an
  edit survives every release, while `spawnCategories`/`liveConfig`/
  `personaVia`/`quotaProbe` stay the seed's because they are statements about
  what the other end can do rather than preferences. A write evicts the
  `agent_options` probe cache for that agent on both sides (server `like
  '%:<id>:%'`, device-local `dropAgentOptionsFor`) — the probe's answer is a
  function of the env — and touches no running thread: the edit reaches one at
  its next spawn. The listing reports a computed `builtIn`, which is only ever
  "is there something to reset to". Two SDK
  sharp edges are load-bearing: **inbound zod strips capability keys it does not
  know**, so `initialize` is registered with an identity parser or the harness's
  `subagents` claim silently vanishes; and outbound `notify()` is unvalidated, which
  is what lets the RFD updates travel (`Emitter` in `src/updates.ts` — the tests'
  `connectPair` re-addresses them exactly as the server's `agentStream` does).
  Tests are in-process ACP clients over scripted `MockLanguageModelV4`s
  (`test/helpers/scripted.ts`); `cd agent && pnpm test`.

## Agent registry & seeding

- Agents are spawned by their **globally installed binary**, not through `npx`:
  `npm install -g @agentclientprotocol/claude-agent-acp @agentclientprotocol/codex-acp`
  (codex-acp **1.7.0 or later** — that is the release that speaks subagent sessions, see
  the subagents note under Conventions).
  npx re-resolves the package on every spawn, and a thread spawns on create, on revive and
  on every profile/model change — measured here at ~3.2s per spawn versus ~0.4s for the
  binary. A missing binary fails with ENOENT, which surfaces in the thread; the
  self-installing form is `command: "npx"`, `args: ["-y", "<package>"]`. Defaults live in
  `DEFAULT_AGENTS` (`server/src/registry.ts`); each carries **two** seed versions —
  `introduced`, the release that first shipped the agent, fixed forever, and `since`, the
  release whose work the row still needs, bumped by every backfill — and `seedAgents()`
  inserts only the ones this install has never been offered, so **an agent
  added in a later release reaches installs that already have rows** (the old seed-if-empty
  rule could not). It backfills fields a release *adds* (e.g. `spawnCategories`) onto older
  built-in rows but never replaces name/command/args/env — those are the user's. A release
  that adds a single key *inside* one of them (the codex catalog key in `CODEX_CONFIG`) says
  so with a `backfill` on the seed entry, which merges that one key and leaves the rest; it
  also drops that agent's cached probe answers, since what the key adds is what the probe
  reports. The two versions have to be separate because a backfill bumps `since` past every
  row present, and "is this install past the release that introduced this agent" is the only
  way to read a *missing* row as **deleted on purpose** rather than as a fresh install owed
  the agent — with one version, backfilling a built-in resurrects it for everyone who
  removed it.
- **Whether a row's binary is actually there is a reading, not a row** (`server/src/agent-status.ts`,
  `GET /api/agents/status`, drawn on Settings › Agents). `checkInstalled` resolves the command
  the way `spawn` will (`locateCommand`: PATH lookup for a bare name, cwd-relative for a
  path) and requires every *absolute path among the args* to exist — which is how the
  harness's own `node <repo>/agent/dist/index.js` reads as "not installed" when `dist` was
  never built, since `node` always is. A missing one carries its install line
  (`INSTALL_COMMANDS`, keyed by agent id — the package behind the *default* command, which is
  why it is not on the editable row). Versions are read the way everything about a runtime
  is read here: one ACP `initialize` per agent (`withAgentConnection`, on the virtual Default
  profile, in the server's cwd), whose answer carries the negotiated `protocolVersion` and
  `agentInfo {name, version}` — every runtime we ship fills it, so no `--version` output is
  parsed per CLI. The harness's own half (SDK pin, `acp.PROTOCOL_VERSION`) rides beside them.
  Cached in memory for five minutes, never in the database (the next boot may be on a host
  where the binary moved); an edit or reset of the row evicts, and `?refresh=1` re-measures
  for the case the cache cannot see — an `npm install -g` that just ran.
- Seed 16 adds `subagentFeed` to the `opencode` row (`"opencode-http"`): a declarative field
  like `liveConfig`, so it is set by the backfill beside the user's env rather than inside
  it, and it does **not** evict the probe cache — nothing the agent advertises changed. At
  spawn (`SessionManager.start`) an agent that declares it is handed a loopback port from a
  pre-bound `PortPool` (`server/src/net.ts`, which is also where `freePort` now lives for
  code-server and the dev server) and a fresh 24-byte password; `spawnAgent` appends
  `--port`/`--hostname` to the resolved args and `OPENCODE_SERVER_PASSWORD` to the env, so
  the registry row's own `args` are never edited and the probe, which passes no sidecar,
  spawns the plain process. The feed is closed on the process's `close`.

## Deployment (built, not tsx)

- **The server is deployed built, not with tsx.** `pnpm build` emits to `server/dist/` via
  `tsconfig.build.json` — the only place the server is emitted; `tsconfig.json` stays
  `noEmit` because it is what the editor and `tsc --noEmit` typecheck (tests included).
  `dist/` sits one level under `server/` exactly like `src/`, so every
  `join(dirname(fileURLToPath(import.meta.url)), "..")` — `data/`, `drizzle.config.ts` —
  resolves to the same directory built as it does under tsx. `pnpm serve` runs it; `pnpm
  pm2:start` builds, pushes the schema and (re)starts `ecosystem.config.cjs` on **port
  4001**, `pm2:stop` / `pm2:logs` for
  the rest. The port there is `DAEDALUS_PORT` in the env, not `data/config.json`: `pnpm dev`
  reads that same file, so a port written into it would move dev too. `loadConfig` therefore
  lets the env win for `host`/`port` and *only* those — token, FCM and idle timeout stay the
  file's, and the token-seeding write puts the file's own port back rather than persisting
  the override. One instance, fork mode: the agent child processes, the WebSocket peers and
  the SQLite handle are owned by this process, and a cluster fork could not see another
  fork's bridges.

## Schema changes

- **Schema change: edit `server/src/db/schema.ts`, run `pnpm db:push`.** That is the whole
  path — no migration files are generated or committed, and nothing applies SQL at boot to a
  database that already has a schema (`ensureSchema` pushes only into a database that has
  none). Push diffs `schema.ts` against the live database and asks before anything
  destructive, which is why a booting server does not run it on its own. Two objects sit
  outside it: the FTS5 search index is a virtual table drizzle-kit can neither model nor
  survive meeting (it read the shadow tables as unknown, dropped the index with them and then
  crashed on a shadow it had already taken), so `drizzle.config.ts` hides
  `session_events_fts*` from push (`tablesFilter`) and `db/index.ts` creates it on every boot
  with `IF NOT EXISTS`; and a table push does not know about is a table push **drops**
  (`search_meta` was lost that way before it moved into `schema.ts`), so anything the server
  reads must be declared there. Custom migration files are for the day a change cannot be
  expressed as a schema diff — a data rewrite, a rename push would see as drop-and-add — and
  none exists today. `pnpm db:studio` browses the database.

## The PWA dev tunnel

- **The PWA needs https, so dev has `pnpm dev:tunnel`.** No secure context means no
  service worker and no install prompt, and `localhost` is one where a LAN IP is not —
  which is why plain `pnpm dev` gets you a browser shortcut on a phone, not an app.
  `client/scripts/dev-tunnel.mjs` puts Cloudflare quick tunnels in front instead of
  issuing a certificate every device would have to be taught to trust. It tunnels
  **both** halves, because an https page may not open `ws://` to the server — the
  browser blocks that as mixed content — and prints the pair plus the token. It does
  not start the server; that stays `cd server && pnpm dev`. `DAEDALUS_TUNNEL=1` is what
  the tunnel tells `vite.config.ts`, whose only effect is HMR: the client derives its
  socket from the dev server's port, so behind a tunnel it needs `wss` on 443 told to
  it. `allowedHosts: true` already covers the random hostname. That hostname changes
  every run, so the URL saved on a device goes stale — `DAEDALUS_CLIENT_URL` /
  `DAEDALUS_SERVER_URL` skip the quick tunnel for a named one that doesn't. While it
  runs both ports are on the public internet with only the bearer token in front.
