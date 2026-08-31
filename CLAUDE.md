# Daedalus Harness

Generic ACP (Agent Client Protocol) harness. Three parts, one repo:

- `server/` — Node 22 + Hono + ws. **The ACP client lives here.** It spawns an agent
  process per thread (agent registry, `{apiKey}`/`{baseUrl}`/`{model}`/`{cwd}` placeholders
  filled from profile + project) and drives the protocol over its stdio with
  `@agentclientprotocol/sdk` — one `AcpBridge` (`src/acp-bridge.ts`) per process, owning the
  handshake, `session/new`-vs-`session/load`, prompts, config, and the permission and
  elicitation requests the agent blocks on. What reaches the browser is *derived state*: the
  small command/event protocol in `src/protocol.ts`, over the same WebSocket. Also owns
  **profiles** (provider config: credentials/models, keys redacted from the API, plus the
  MCP/skill/command links every thread on it gets), **projects** (workspace: a cwd and a
  name — nothing linked), the **library** of reusable MCP servers/skills,
  bearer-token auth, the event log (reconnect/replay), and FCM push.
  `data/` holds secrets — gitignored, never commit.
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
- `client/` — Vite + React 19 + Tailwind v4 + shadcn (Base UI, NOT Radix: compose triggers
  with `render={...}`, not `asChild`; `SelectValue` needs explicit children for labels).
  The browser does **not** speak ACP — the server does. `src/lib/thread-socket.ts` is a plain
  WebSocket that sends the commands in `server/src/protocol.ts` and dispatches its events;
  `@agentclientprotocol/sdk` is a **devDependency**, imported type-only (the payloads are
  still ACP-shaped because the transcript renders them). State: one reducer in
  `src/lib/store.tsx`; side effects in `src/lib/actions.ts`. Color palettes live in
  `src/styles/themes.css` (one `[data-color-theme]` block per palette, light +
  dark), not in `index.css`; user-made palettes are that same token set written
  into a runtime `<style>` by `src/lib/custom-themes.ts` and edited in
  `components/theme-builder.tsx`. **The colour before the app exists is
  `src/lib/boot-colors.ts`** — the address-bar tint, the inlined splash and the
  manifest all need the background named before any stylesheet is parsed, so it
  is written once there in hex and pulled in three ways: `lib/theme.tsx` imports
  it as a fallback, `vite.config.ts` imports it for the manifest and substitutes
  `%BOOT_LIGHT%`/`%BOOT_DARK%` into the static `index.html`. It is the *Default
  palette's* `--background`, not `.dark`'s from `index.css` — ThemeProvider
  always sets `data-color-theme`, so `.dark` alone is a state nothing paints —
  and changing that palette in `themes.css` means changing it here. Only the
  floor lives there: every load after the first tints from the real palette,
  which `applyThemeColor` caches per `<palette>:<mode>` for the pre-paint script
  in `index.html` to read back. ⌘K opens `components/command-palette.tsx`.
  Reading a tool call — inferring its kind, target, language and diff out of
  ACP's opaque `rawInput`/`rawOutput` — is quarantined in `lib/tools.ts`, and
  **drawing** one is `components/tool-views.tsx` on top of the primitives in
  `components/tool-parts.tsx` (which exists so those two and `thread-items.tsx`
  can share a pane without importing each other). No component matches on a
  vendor tool name: `toolViewOf` picks the layout and the matching `extract*`
  supplies the fields, so a new runtime's tool is one file's edit. ACP `kind`
  still decides the layout *family* — it is the part that is protocol — but it
  is too coarse on its own, because the three runtimes describe the same act
  three ways: a checklist arrives as tool input under `think` from Claude Code,
  under `other` from OpenCode and as a real ACP plan from Codex; an MCP call
  arrives under `execute` from Codex (`mcp.<server>.<tool>`, `{server, tool,
  arguments}`) and as `mcp__server__tool` from the others; a web search arrives
  under `search`, which is also where ripgrep lives. Each of those rendered as
  a JSON dump or a wrong-shaped pane before it had a view — as did a
  `MultiEdit`, whose hunks are one level down in an array. The loudest of them
  is **the terminal**: Codex announces every shell command as `content:
  [{type:"terminal"}]` and streams the bytes through `_meta.terminal_output_delta`
  on later updates, *whether or not the client claimed the capability* — the
  content block is a handle, not a payload, and `_meta` is merged key-wise per
  update, so drawing it printed the literal `[terminal]` and kept only the last
  chunk. `applyTerminalMeta` accumulates the chunks onto `ToolItem.terminal` in
  the store reducer, which is also what makes replay work, since a replayed
  thread runs the same reducer over the same journaled updates.
  **The web has two views of its own, and they are matched on the tool's
  *leaf* name** (`toolLeafName`: `web_search` out of `mcp__web-search__web_search`
  or Codex's `mcp.web-search.web_search`), so Claude Code's built-in
  `WebSearch`/`WebFetch`, OpenCode's `websearch`/`webfetch`, Codex's browsing and
  any MCP search server — the harness's own included — land in the same layouts.
  `extractWebSearch` reads results out of whatever the tool answered: structured
  `results[]` on `rawOutput` or on `_meta.claudeCode.toolResponse` (flat, or Claude
  Code's nested `content[]` — whose array also carries the prose strings of the
  built-in search's own answer, kept as `summary` and drawn under the list),
  `N. title / url / snippet` blocks (what `websearch.ts` and the cc-cli proxy
  write), `Title (url)` lines, or markdown links; the web heading wins over the
  agent's own title (`"query"` from Claude Code, the raw MCP name from the server)
  so both read `Search the web for “…”`; `extractWebFetch` is any named fetcher or `kind:
  "fetch"` with an http URL. `WebSearchDetail` draws results as sources (favicon,
  host, title, a clamped snippet that opens on click); `WebFetchDetail` draws the
  page as markdown under its address. Two rules made this reachable at all: an
  MCP server name may carry a hyphen, so `NAME_RE` accepts `[\w.-]` (it read
  `mcp__web-search__web_search` as *prose* and made it the row title), and an
  agent's `kind: "other"` is the protocol saying nothing, so `toolKindOf` lets
  the name answer instead (Claude Code files every MCP tool under `other`). The
  **Sources** strip under a finished turn (`lib/sources.ts`, `SourcesStrip`,
  inserted by `withTurnSources` in `thread-view.tsx`) is derived from the
  transcript alone — pages the agent *fetched* plus search results whose URL it
  *cited* in its prose, never every hit it saw — so it survives replay with
  nothing journaled, and it waits for `turnActive` to drop so it does not grow
  under the reader. Sources exist at the **tool-call level** too: `ToolSources`
  (`tool-views.tsx`) is the `below` slot of every `StepRow` — a shadcn
  `AvatarGroup` stack of site favicons, one per host a search returned (result
  order, a `+N` count past six that opens the rest) or the page a fetch read —
  visible whether the step is open or not, so a collapsed run still says which
  sites answered. Each avatar is a link, rendered with Base UI's `render={<a/>}`
  so the anchor *is* the avatar root and the group's ring selector
  (`*:data-[slot=avatar]`) still finds it. The two strips answer different questions: the row's is
  "what did this call see", the turn's is "what did the answer use".
  **A thinking row streams as a ticker**: `RowView`'s `streaming` flag (set by
  `thread-view.tsx` on the transcript's tail row while `turnActive`, and by the subagent
  rail on its tail while the child is active) makes the `thought` case draw in-progress —
  primary icon, elapsed timer, a shimmering title that is the *newest* line's tail
  (`thoughtPreview`), clipped from the front because the end is the part that is new.
  Settled, the title is the opening line as before. Derived at view time from position,
  not from a flag in the store: the reducer never marks a thought done.
  `components/ui/diff-view.tsx` is a dependency-free line LCS.
  Device-local, per-session state lives in its own tiny stores — `lib/drafts.ts`
  (unsent prompts) and `lib/pins.ts` (pinned threads), both pruned from
  `refreshSessions`. `lib/view-options.ts` (timestamps/tool grouping/density) is
  device-local too but **global and persisted**: one set of reading settings for
  every thread, keyed by nothing, so `useViewOptions()`/`setViewOption(key, …)`
  take no session and there is nothing to prune. Per-session was the older rule
  and it meant finding and flipping the same switch again in every thread — how a
  transcript is drawn is a property of the reader, not of the conversation. The
  pre-global blob (`{ [sessionId]: Partial<ViewOptions> }` under the same
  `ui.viewOptions` key) is folded into the one set on first read, later threads
  winning, rather than dropped. **The sidebar
  is `components/thread-sidebar.tsx`**, laid out like the Codex and Claude desktop
  apps: fixed nav rows on top (`SidebarNav`: New thread, Search, Tasks — menu rows,
  so they survive the icon rail), then Pinned, a flat Recents, **one folder per
  project** with its threads under it and a hover `+` that starts a thread *in*
  that project, Scheduled, Trash. Pinned and Recents are **shortcuts, not
  places**: a folder holds every one of its project's threads, the recent and
  the pinned included, because a folder that dropped whatever was recent was an
  incomplete index of its own project — with the newest thread, the one most
  likely to be looked for, the one missing from where it lives. Inside a folder
  the rows are **grouped by period** (`periodLabel` in `lib/time.ts`, `grouped`
  on `ThreadList`): Today / Yesterday / Previous 7 days / Previous 30 days, then
  by month. Counted in calendar days, so 00:10 says "Yesterday" about 23:50, and
  the headings are inserted over the rows that are *visible*, so `limit` still
  counts threads and "Show more" can never reveal an empty heading.
  **Every one of those orders — and the period a row is filed under — is
  `activityAt` (`lib/settings.ts`), the last *turn*, never `createdAt`**: a
  thread is recent because something was said in it, so an old thread picked up
  this morning belongs at the top of Recents and under Today, and ordering by
  creation buried it under threads nothing had happened in for weeks. The clock
  is `sessions.last_activity_at`, bumped server-side in `SessionManager.emit` on
  the journaled `turn_started`/`turn_ended` — once per turn, not once per
  streamed token — and reported by `list()`. **Reading is not activity**:
  attaching journals nothing, so opening yesterday's thread does not promote it,
  which is also why the client's own optimistic stamp (the `turn-active` case in
  the store) fires on a turn *starting* only — `turn_ended` is replayed, and
  stamping on it would move a thread to the top of the list for having been
  scrolled. Rows written before the column existed read 0 and are backfilled
  from the journal's own `max(at)` in `reload`, once, rather than by a migration.
  Rows are one line and title-only: a running turn
  **shimmers the title** (`harness-shimmer`, the same band as the working line and a live
  thought), a thread waiting on you gets an amber dot at the trailing edge; agent,
  profile, model, project, start time and — when it says something the start
  time does not — last active live in `ThreadInfoCard` — one popover
  that opens on hover (Base UI `openOnHover`) and, on a phone, on long press,
  where it also carries the row's actions (it replaces the right-click menu there). Every row, label and group draws from
  one scale (`ROW`/`MENU`/`GROUP`/`TIER`, exported for the settings nav too). The
  main surface (`SidebarInset`) is `bg-card` over the sidebar's tinted ground, and
  the Threads label carries a sort/filter menu (recent first / by project;
  all / running / needs you) remembered per device as `ui.sidebarView`. Fold
  state is `ui.collapsedProjects`, keyed by project id. The shelf above
  the composer is `components/composer-strip.tsx`; app icons regenerate from
  `client/build/icon.svg` via `pnpm icons`.
  **Everything with a face is drawn by `components/entity-icon.tsx`**: `EntityIcon`
  is the one round, ringed mark (picture when the URL loads, fallback otherwise,
  a broken URL remembered per src), and `AgentIcon` / `ProfileIcon` /
  `ProjectIcon` wrap it with each entity's rule for where the picture comes from
  — built-in brand PNGs, the profile's `logoUrl` (else its agent's mark), the
  project's `logoUrl` (else its initial in a disc whose hue is hashed from the
  name). Projects carry `logo_url`; the API reports `""`
  for none, like profiles. No component draws a folder for a project any more.
  **Settings › Knowledge base** (`components/settings/knowledge.tsx`) is the cross-project
  view of what the built-in `knowledge` MCP server has written: one `GET /api/knowledge`
  (`listAllKnowledge` in `server/src/knowledge.ts`, every entry newest-updated first with its
  `projectName` resolved server-side), grouped by project on screen with a project filter,
  delete and a hand-written add — both through the existing per-project routes, which the
  project form's own knowledge section still uses.
  Theme/layout ported from
  `/var/www/mawared-off/social-live-agent/ai-agent-web` (glass surfaces, Inter, step-row
  transcript). Electron shell lives in `client/electron/` (frameless, vibrancy/acrylic).
- No build-time client config: server URL + token are entered at runtime (localStorage).

## Commands

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
- Server: `cd server && pnpm dev` (prints token), `pnpm test` (bridge self-check against the
  fake agent: handshake, event log, replay, multi-peer, failure paths).
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
- Client: `cd client && pnpm dev` / `pnpm build` / `pnpm electron:dev` / `pnpm electron:dist:win`.
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
- Typecheck: `pnpm exec tsc -b` (client), `pnpm exec tsc --noEmit` (server).
- `tsconfig` uses `erasableSyntaxOnly` — no TS constructor parameter properties.
- eslint currently crashes at startup (typescript-eslint vs typescript 7 — pre-existing).

## Conventions

- **The server is the ACP client; the browser is a subscriber.** One `AcpBridge` per agent
  process holds the SDK connection over the child's stdio (`ndJsonStream` on
  `Writable.toWeb(stdin)` / `Readable.toWeb(stdout)` — which takes exclusive ownership of
  stdout, so nothing else may attach a `data` listener). N browser sockets are peers of the
  SessionManager, not of the agent, which is why there is no id arbitration left: the server
  mints one ACP request and answers the one peer that asked. Commands carry a per-socket
  `id` and get exactly one `reply`; events fan out, minus the peer whose own action caused
  them. Four are journaled and replayed on attach — `update`, `session_config`,
  `turn_started`, `turn_ended` — and the rest are live-only. A permission or elicitation is
  **not** journaled: it lives in `bridge.pending` for exactly as long as the agent is blocked
  on it, so a peer attaching mid-question is handed what is still open and an answered
  request simply is not there. First answer wins; a loser is told directly so its card still
  clears. `settleAll` answers everything when the process dies, because the agent's promise
  is held here now and nothing else would ever settle it.
  The one thing the server still does not interpret is a `session/update` payload — it
  forwards them whole.
- **Live and replay are one code path.** `attached` and `caught_up` bracket the replay, and
  everything between them is the same event the live socket sends, so the client has no
  second parser. The bracket is
  load-bearing: without it a reload re-fires a desktop — and, with nobody watching, a push —
  notification for every turn in the thread. `session_config` carries **absolute** state,
  which is what makes it safe to journal and broadcast at once; never make it a delta.
  **Where the replay starts has three sources and only one meaning per attach**, which is
  why `attached` states it rather than leaving it to be inferred from `from > 0`: a fresh
  attach starts at 0; a *resume* starts at this device's own cursor (`journalCursors` /
  `resumeCursor` in `actions.ts`, so a dropped socket costs a delta and not the thread); and
  a *windowed* attach starts wherever the server chose, because the thread was longer than
  `REPLAY_WINDOW_STEPS`. **The window and every `load_earlier` page are counted in steps
  (turns), never events**: the server cuts only at journaled `turn_started` seqs
  (`SessionManager.turnStartAt`/`earlierPage`), so `attached.from` is always a turn's
  opening event and a page is whole turns — an event-counted cut landed mid-turn and the
  re-fold opened a half turn the reducer had never seen begin. `earlier` counts withheld
  turns; events before the first `turn_started` (a load replay's history) are behind the
  head and never paged. The first two replace the transcript, the third also replaces it — but
  `from` is large in the second and third alike, so `resumed` is a field and not a
  comparison. `earlier` says how much was withheld, and `load_earlier` fetches it a page at
  a time. Folding one of those pages is the awkward part: the reducer only appends, so an
  older event cannot be inserted into a built transcript — `ThreadSocket.loadEarlier`
  re-folds the whole widened window through the same callbacks inside the same buffer, which
  is why the socket keeps its raw journaled events, and why it only keeps them when
  `earlier > 0` (a thread that arrived whole can never page back and pays nothing).
  The replay travels in **bulk** — one `replay` frame per `REPLAY_CHUNK_SIZE` events *or*
  `REPLAY_CHUNK_BYTES`, whichever runs out first — because the browser woke, parsed and
  re-rendered once per frame, and that, not the range scan, was what made a long thread
  visibly rebuild itself. The byte budget is the half that matters for a thread full of
  terminal output or large diffs, where 500 events is a multi-megabyte frame held whole on
  both ends. The frames are built from the payload column **as text** and put straight on
  the socket: it is already the JSON the browser needs, so parsing it to re-serialize it
  once per peer is work with no reader — and the scan is paged, so a replay costs a page of
  memory rather than the whole transcript.
  It is a container, not a fifth journaled kind: `attached`/`caught_up` still bracket it and
  `thread-socket.ts` unrolls it back through the same switch, so there is still one parser.
  It is **opt-in** (`?batch=1`, which `wsUrl` sets): a client that predates the shape would
  drop the frame, and with it the `caught_up` inside, leaving a thread that never finishes
  connecting rather than one that merely renders slowly. The client folds it to match: the
  bracket also opens and closes a **buffer** in `makeCallbacks`, so the whole history is one
  `batch` action — one commit — rather than one render per event of a transcript nobody has
  looked at yet. Which is why everything thread-scoped in there goes through `send`, never
  `dispatch` (a direct dispatch jumps the queue and lands ahead of the `thread-reset` still
  sitting in the buffer — `recordError` takes the sink as an argument for exactly that
  reason), and why a socket that dies mid-replay flushes too: `caught_up` is the ordinary
  exit from the replay, not the only one. It also means a callback cannot read the state its
  own replay is building — `session_config` leaves `configOptions` out to mean *unchanged*
  and the **reducer** resolves it, because the value the callback would have read has not
  been committed yet.
- ACP schema is the source for modes/config options/usage — render generically, don't
  hardcode per-agent knowledge in the client.
- **The profile decides who owns the model.** A profile that lists `models[]` has
  *overridden* the agent: those ids reach it as `{model}`/`{effort}`/
  `{contextWindow}` in the env template (`server/src/registry.ts`) — at spawn, which is
  no longer the same as *only* at spawn (see the live-reconfiguration note below).
  A profile that lists none defers to the agent, whose
  `category: "model"` / `"thought_level"` selectors apply through
  `session/set_config_option` — one call, safe mid-turn, no restart. The override is scoped
  to exactly those two settings: **every other agent option passes through untouched and
  stays live** in either case. This exists because an agent pointed at a gateway advertises
  its own catalog, which the endpoint does not serve — codex derives its effort list from
  the *current model's* metadata, so an unknown gateway model id yields no effort selector
  at all. **The profile's catalog is therefore written out as the agent's catalog** where an
  agent will read one: codex looks a model up by *slug* in its built-in list and an id it has
  never heard of gets invented metadata (`Model metadata for … not found. Defaulting to
  fallback metadata`) — a made-up context window, so compaction fires at the wrong point.
  `model_context_window` does not silence it; only `model_catalog_json` does, and it takes a
  *path*. So `server/src/model-catalog.ts` writes `data/model-catalogs/<profileId>.json` on
  spawn and `{codexModelCatalog}` in the env template points at it. It buys the metadata and
  **not** the selectors, which is worth stating because it was once assumed to buy both:
  measured against codex-acp 1.7 / codex 0.150, `listModels` ignores the catalog file
  entirely — it answers with codex's own built-ins plus a synthetic entry for whatever
  `CODEX_CONFIG.model` names (a slug invented for the test comes back the same way), that
  entry carries no reasoning levels, and `set_config_option` answers `Invalid params` for
  every catalog model but the spawned one. Which is why codex's live model change is the
  shim's and not the agent's. **A model a profile does not
  name is a model the gateway picks**, and the quietest one is the *second* model Claude
  Code runs its cheap side-jobs on — the Bash permission classifier among them, which is
  what `auto` mode's verdict is. Unnamed, the endpoint maps the built-in Haiku id onto
  whatever it calls cheap; when that is an experimental preview it flaps and the classifier
  fails closed, so an ordinary build is refused while the main model on the same endpoint is
  healthy. `{smallModel}` fills `ANTHROPIC_DEFAULT_HAIKU_MODEL` *and*
  `ANTHROPIC_SMALL_FAST_MODEL` (the var was renamed across releases and the harness does not
  pin the binary), and resolves to the session model — always, with no per-profile cheap
  pick any more: a profile means "run everything on this model", and a second id is one more
  the gateway may not serve. The same rule, for the same reason, pins Claude Code's model
  *aliases* — `ANTHROPIC_DEFAULT_SONNET_MODEL`/`_OPUS_MODEL`/`_FABLE_MODEL` all carry
  `{model}`, because the CLI switches to them on its own (entering plan mode upgrades a
  haiku-alias session to `sonnet`; `opusplan` resolves opus/sonnet across the plan boundary)
  and each names a built-in Anthropic id a gateway does not serve, which killed turns with
  `model_not_found` the moment one fired. A profile with no models at all resolves all of
  these empty and the keys prune away, which hands the choice back to the agent exactly as
  it does for `ANTHROPIC_MODEL`. An entry carries far more than
  numbers (`base_instructions` is codex's whole system prompt), so none is invented: `codex
  debug models` prints the built-in catalog and each entry is its flagship model with the
  identity, context window and efforts swapped. No `codex` on PATH, or a profile with no
  `models[]`, means no file, an empty placeholder and the key pruned away — the agent keeps
  its own catalog. `lib/session-options.ts` does the sorting from the ACP `category` field; unknown
  and missing categories fall through to "Agent options" rather than being dropped, and an
  agent advertising no model selector gets no Model row — the client never invents one.
  **A profile changes the model and the effort, and nothing else.** It is credentials and a
  catalog, not a way of working, so a respawn must not reset how the agent was configured.
  `POST /api/sessions/:id/respawn` is therefore **atomic and server-side**: it captures the
  permission mode and every non-model/effort option from the live bridge, kills the process,
  spawns, `session/load`s, and puts the settings back before it answers, skipping whatever
  the new session already agrees with (`AcpBridge.captureRestoreState` / `applyRestore`).
  Driving that from the browser is what used to leave a half-restored thread when a tab
  closed halfway through. Both menus read Profile → Model → Effort, with mode and the rest
  under "Agent options", because the profile decides what the two lists below it can contain.
  Profile changes always confirm (new credentials, new endpoint, new catalog; the model does
  not carry over). After a live change the server records `session.model`/`effort` itself —
  it knows the option's `category` — so reviving a retired thread rebuilds the right env.
- **Being env at spawn does not mean being env forever: profile, model and effort all
  change on a running agent now, and `POST /api/sessions/:id/config` is the one door.**
  It answers `{live}`, and a falsy answer means it fell through to the same respawn as
  before — so the client sends every pick the same way and only reconnects when told to
  (`actions.changeThreadConfig`). The decision is `SessionManager.applyConfig`, server-side
  for the reason respawn already is. Two mechanisms underneath, and which one an agent gets
  is `AgentDef.liveConfig`, declared with the agent beside `spawnCategories` (which still
  only ever said which knobs are env):
  **the endpoint and the credential are the shim's, not the child's.** `{gatewayUrl}` now
  resolves to `/gw/<key>/s/<sessionId>/<agentId>` — the *thread*, not the profile — and
  `proxyGatewayRequest` resolves that thread's current profile per request through a
  resolver the SessionManager registers (`setGatewaySessionResolver`). Moving a thread to
  another provider retargets the very next call the child makes, `x-api-key` /
  `Authorization: Bearer` rewritten to the new profile's key in whatever shape they
  arrived. The probe has no thread and keeps the old `/gw/<key>/p/<profileId>/<agentId>`
  form, which is why the path carries a kind at all.
  **The model is the agent's own selector where it will take one (`"acp"`, claude-code) and
  the shim's rewrite where it will not (`"gateway"`, codex).** Claude Code's picker is built
  from `availableModels` in the settings the SDK resolves for the cwd and *only* from there
  — `CLAUDE_MODEL_CONFIG` reaches the SDK query but never the picker, and a value the picker
  does not offer is refused — so `materializeModelAllowlist` merges the ids into
  `<cwd>/.claude/settings.local.json` (the gitignored tier; the user's own keys and entries
  survive, and a `.daedalus-models.json` manifest beside it is what makes the sweep take
  back only what it wrote). Verified end to end against claude-agent-acp 0.70: with the ids
  allowlisted *and* a custom `ANTHROPIC_BASE_URL` set, `set_config_option` moves a live
  session onto a gateway id and `query.setModel` accepts it; without the base URL the SDK
  refuses the id as unrecognized, which is exactly the Default profile, which is exactly the
  case that still respawns. The allowlist is the **union across every profile that serves
  the agent**, not the thread's own: it is read once at `session/new` and a thread outlives
  its profile choice, so a narrower list would put the *next* profile's models out of reach
  and cost the restart this is here to avoid. **A profile with no catalog writes no
  allowlist at all**, which is the one thing the union cannot say: `availableModels` is a
  *replacement*, so a Default-profile thread spawned in a cwd some gateway thread had
  written opened a picker of that gateway's ids and none of the agent's own — a profile that
  overrides nothing must impose nothing, and an empty list drops the key back to whatever
  the user had. Nothing is lost by narrowing it, because a move on or off a catalog-less
  profile is exactly what `applyConfig` refuses to do live, so the respawn that carries the
  thread there writes the next list. The **probe writes it too** (`probe.ts`), for the same
  reason it materializes the profile's skills: its whole job is to answer what a thread on
  this pair would offer, and reading whatever the last spawn in that cwd left behind
  answered for a different profile. It is in the probe's **cache key**, hashed beside the
  cwd — the allowlist changes the answer exactly as the cwd does, and one profile gaining a
  catalog widens (and so invalidates) its siblings', which `updateProfile`'s own eviction
  does not reach. Codex gets none of that; the shim replaces
  `model` and `reasoning.effort` in the request body it is already reading for the namespace
  repair. `rewriteModel` is what says a body is worth reading at all — true for a
  `"gateway"` agent whose thread has a catalog, and true for **any** live-configured agent
  whose profile has changed since it spawned, because its env still spells the old
  provider's ids (for Claude Code that is the side-job and alias vars, which the main
  model's ACP switch does not touch). False otherwise, which is the ordinary turn, which
  still streams straight through. What `applyConfig` refuses to do live, and hands to
  `respawn` instead: a different agent (a different runtime), a thread that is not behind
  the shim or is moving to a profile that would not be, a move to a profile with no catalog
  (that hands model and effort back to the agent, which is a different session state and not
  a value to set), a model the running bridge will not confirm it offers (`offersModel` —
  the alternative to asking is being refused with the thread's record already changed), and
  a thread with no live process, which is a revive. A live change fans out as the
  **`spawn_config`** event: absolute like `session_config`, live-only and *not* journaled
  (it is the session row's state, and a peer attaching later reads the row), and sent to
  every peer *including* the one that asked, because the server is what resolves a cleared
  model into the profile's default. The one thing that does not survive the move: Claude
  Code rebuilds its option list around the new model, and for an id its SDK does not
  recognize that means the permission mode can clamp (`auto` → `default`) and the effort
  selector can disappear — both arrive as ordinary updates, so the menu stays truthful, and
  effort was never in claude-code's env anyway, so a restart would not have placed one
  either.
- **A message typed into a running turn is queued, not steered — and the queue is the
  server's.** `session_queue` (`server/src/queue.ts`, storage only) holds it per thread,
  ordered, cascaded with the row, so it survives a tab closing and a server restart and is
  drained with nobody attached. A `prompt` arriving while `bridge.promptActive` is enqueued and
  answered `{queued, itemId}` — only the server knows whether the turn is still open, the
  browser's `turnActive` is a hint (a `{queued}` reply to a prompt the client sent optimistically
  is what `drop-user-message` takes back). Steering is the explicit `prompt {steer:true}` /
  `queue_steer` (⌘⇧Enter), which joins the turn through the old `inflight++` path. The queue
  travels as the `queue` event — **absolute** like `session_config`, never a delta, fanned to
  every peer *including* the origin because the ids are minted here — and is not journaled: it
  is current state, handed over on `caught_up` the way a pending permission is handed over
  after the replay. A drain combines **everything** queued into one blank-line-separated
  prompt and starts one turn on it with no origin peer, so every device draws the user bubble
  from `turn_started`. It hooks `AcpBridge.settleTurn` → `host.onTurnSettled`, after
  `turn_ended` is journaled, and only after a turn that ended **cleanly**: a Stop or a failure
  parks the queue on the shelf (`stopReason: "cancelled"` is a *success* on the wire, which is
  why the bridge reads it now), and nothing drains on revive either — a profile-change respawn
  must not fire a parked queue. The `turn_ended` before a drain carries `continued: true`, so
  neither the toast nor the push says "Turn finished" about a turn that is about to continue.
  "Send now" (one item, or all) is atomic and server-side like respawn — `cancel()` (which now
  also `settleAll()`s the open questions, as ACP asks of a cancelling client), `whenIdle()`,
  prompt — serialised on `session.queueChain`, which also stands the auto-drain down so nothing
  goes twice; rows are deleted only after the prompt is dispatched, so a process dying mid-wait
  leaves the queue as it was. The three edits (`queue_update/remove/clear`) are answered with no
  bridge, like `load_earlier`: a parked queue on an archived thread is the user's words, and
  taking one back must not cost a spawn. The scheduler gets the rule for free: a scheduled
  prompt that lands mid-turn waits its turn. The row is `components/composer-queue.tsx` on the
  strip (summary id `queue`).
- **Claude Code reaches a profile's gateway through the harness's own shim, because a
  gateway that streams correctly can still answer a non-streaming call in the wrong
  shape.** Every main-loop turn streams, and that is the path a Claude-Code-on-a-gateway
  router is built against; the CLI's *side queries* — the auto-mode permission
  classifier above all, plus titling, memory selection and the rest of `sideQuery` — call
  `messages.create` without `stream` and read `response.content` off the JSON. 9router
  forces streaming towards providers that need it and re-assembles the SSE into JSON for
  the client as an OpenAI `chat.completion` for every client format but Responses, so a
  Claude-format caller gets `choices[]` where it expects `content[]`; the CLI's text
  extractor throws (`undefined is not an object (evaluating 'e.filter')`), the classifier
  reports "<model> is temporarily unavailable" and **fails closed** — a web search or a
  build refused in auto mode while the main model on the same endpoint is healthy. The
  model override cannot touch that (the classifier *is* on the profile's model; the error
  names it), so `server/src/gateway-shim.ts` sits in front: the claude-code seed's
  `ANTHROPIC_BASE_URL` is `{gatewayUrl}` (seed 8; the backfill moves only a key still
  holding the exact seeded `{baseUrl}`), which `resolveSpawn` fills with
  `http://127.0.0.1:<port>/gw/<key>/<profileId>/<agentId>` — or with the raw `{baseUrl}`
  when no shim is configured, and with nothing at all for the Default profile, so the key
  still prunes. `proxyGatewayRequest` resolves `profileBaseUrl(profile, agent)` per request
  and forwards everything byte for byte — request bodies are never read, streaming replies
  are piped — and makes exactly one repair: a `2xx` `application/json` reply to a path
  ending in `/messages` that parses as a chat completion is rewritten into an Anthropic
  `message` (`chatCompletionToMessage`: thinking/text/tool_use blocks, `stop_reason`, usage
  with the cache counters split back out). The decision is made on the *response* content
  type so a multi-megabyte prompt costs the shim nothing. The key in the path is the
  credential, exactly as `/ide/<key>/` — the route is unauthenticated because the CLI
  carries its own `x-api-key` for the gateway, and a bare `/gw/<profileId>/` would be an
  open relay to whatever URL a profile names; it is minted per boot and never stored, since
  its only readers are children this process spawns and a restart kills those anyway.
  `pnpm test:gateway` drives it against a stand-in gateway that answers like 9router.
- **A profile is a provider, not an agent, and a thread is a (profile, agent) pair.**
  `profiles.agents` is a JSON map keyed by agent id (`ProfileAgentLink`), not a single
  `agent_id`: the credentials, catalog and default model on a profile are gateway data,
  and binding them to one runtime meant entering the same key and model list once per
  agent. The key set is the contract — which agents the profile can spawn — and the value
  carries the one thing that genuinely differs per agent on a gateway, an optional
  `baseUrl` override (`profileBaseUrl` in `profiles.ts`: LiteLLM-style routers serve
  Claude Code at an Anthropic-messages path and Codex at an OpenAI-responses path). The
  agent is therefore chosen at draft time and lives on the **session** (`sessions.agent_id`,
  which already existed): `POST /api/sessions` takes `agentId` and `sessions.create`,
  `respawn`, `spawnAgent` and `probeAgentOptions` all take it explicitly; `resolveProfileAgent`
  lets it be omitted only when the profile names exactly one agent (the virtual Default, or an
  older client). A respawn keeps the session's agent unless told otherwise — a profile change
  is new credentials, never a new runtime — and refuses a profile not configured for it, which
  is also why both config menus list only profiles that serve the thread's agent. On the
  client, `Profile.agents` replaces `agentId`, `lib/agent-options.ts` is keyed
  `optionKey(profileId, agentId)` (what codex offers on a gateway is not what Claude Code
  offers on it), `thread-defaults` remembers the agent too and `resolveThreadStart` degrades
  the pair one half at a time (the agent is the stickier habit: a remembered profile that no
  longer serves it loses to the first profile that does). Migration `0019` filled every
  existing row with `{ [agent_id]: {} }`; it was written by hand under `generate --custom`
  because drizzle-kit's rename prompt needs a TTY and its table-rebuild for this diff
  selected a column the old table did not have.
- **The harness's own MCP servers are library rows, not profile toggles.** Web search and
  the knowledge base used to be `webSearch`/`knowledge` opt-ins on the profile (with per-profile
  search overrides); they are `mcp_servers.type = "builtin"` rows now — `BUILTIN_MCP` in
  `library.ts`, fixed ids `builtin:web-search` / `builtin:knowledge` — linked by a project, a
  profile or a thread exactly like any other server. The row is a *handle*: it stores no
  command, env or credentials, and `mcpServersFor` resolves it at spawn to `websearchServer(config)`
  (config.json's backend, live, so a token is never cached in a row) or `knowledgeServer(project)`
  (the thread's project id in env — which is why it could never be a stored command). A linked
  web-search row resolves to *nothing* while search is unconfigured: a tool that cannot answer is
  not advertised. `session.websearchViaMcp` — what makes the bridge disallow Claude Code's own
  WebSearch/WebFetch and what gates usage recording — is now "the resolved list contains it",
  for any agent. **The disallow travels with an allow rule for `mcp__web-search`**
  (`AcpBridge.claudeMeta`): a disallowed tool becomes one of the session's
  `alwaysDenyRules`, which the auto-mode classifier's prompt lists as "User Deny Rules" with
  a standing order to block the same effect reached through another tool — and a web search
  through our MCP server is exactly that, so it was denied as circumvention of a rule the
  harness wrote, and the model told the user to edit their settings. Allow rules resolve
  before the classifier is consulted; verified with the CLI on the same gateway (two denials
  → none). `POST /api/mcp-servers/builtin/:kind` (`mcpServers.ensureBuiltin`) is the
  "Add web search" / "Add knowledge base" button on the MCP page, idempotent by id, and a
  built-in row has no Edit (nothing to edit) but can be deleted. Migration `0021` linked every
  profile that had a toggle on to the injected row before dropping the columns.
- **Workflows are the harness's, not an agent's.** Claude Code has a `Workflow` tool;
  Codex and OpenCode have nothing like it, and the harness could only ever *watch* Claude
  Code's (`tasks.ts` tails its `journal.jsonl`). So `builtin:workflow` is a third library
  row beside web search and the knowledge base — any agent that links it gets the
  `workflow` MCP server, and on Claude Code the server disallows `Workflow` and allows
  `mcp__workflow` (`AcpBridge.claudeMeta`, `workflowViaMcp`), for exactly the classifier
  reason the web-search pair exists. A definition is **declarative JSON**
  (`server/src/workflow-schema.ts`: named steps, `dependsOn` edges, `{{inputs.x}}` /
  `{{steps.y.output…}}` templates, an optional JSON-schema `output` that buys the step one
  repair turn before it fails) and never a script: the server does not interpret an agent's
  payloads, and it must not start interpreting a *program* an agent wrote — steps, edges and
  templates are data it can validate up front (duplicate names, a cycle, a template that
  reads a step it did not *directly* wait for, a schema `z.fromJSONSchema` cannot compile),
  draw, and replay. **Phases are sugar over those edges, not a second scheduler.** A
  definition is written either as flat `steps` or as `phases: [{name, steps}]` — named stages
  that run one after another, the steps inside one side by side — and the phase form is
  *desugared at parse time*: every step of phase k gains a `dependsOn` on every step of phase
  k-1, so `readySteps`, `dependentsOf`, the cycle check and the skip cascade never learned
  what a phase is. `WorkflowDefinitionSchema` therefore ends in a `.transform`, and the
  engine only ever sees one shape: a flat `steps[]` (each carrying its `phase` tag) plus a
  `phases[]` outline. Two rules come with the barrier. A template may read any step in a
  **strictly earlier phase** without declaring an edge — the barrier is the guarantee a
  direct dependency otherwise provides, and it is the whole ergonomic point, since otherwise
  every stage would have to restate the one before it — while a step in the *same* phase
  still needs the edge, because siblings run together. And a `dependsOn` pointing at a later
  phase is refused by name rather than as a "cycle", which is what `findCycle` would have
  called it. **Every step is a real thread**: `sessions.parent_session_id` names its
  parent, it has its own transcript, is searchable, openable and revivable, and is created
  **on the parent's own profile, agent, model and effort** — a step is the same actor working
  in another thread, never a second identity — with the parent's links, the title
  `<wf> · <step>` and the parent's `captureRestoreState()`, so a step does not ask what the
  parent would not. The parent sees it through **the RFD's own events**: the runner (`workflows.ts`)
  emits `subagent_spawned` on the parent, every `update` the child journals re-addressed
  with the child's `sessionId`, and `subagent_state_update` when it closes — all as ordinary
  journaled `update`s through `SessionManager.emitOn`, so the client learned nothing new
  and replay is free. The spawn's `_meta.daedalus.workflow` names the run (`runId`, workflow
  name, step, index/total, this step's `phase`) — decoded only in `lib/tools/subagents.ts`
  (`workflowInfoOf`), stamped onto the `SubagentItem`, and folded at view time by
  `mergeWorkflowRuns` (`transcript-rows.ts`) into one `workflow-group` row per run, which
  `WorkflowRun` (`thread-items.tsx`) draws as a **compact preview card that opens the run
  in a dialog** — instead of N stray subagent rows, and instead of the phase-banded table
  the card itself used to hold: a run is N whole threads, and a transcript column is the
  wrong room to read one in (the table fought the panel for width, and a step's events
  ended up in a pane inside a card inside a transcript). The card answers the passing
  reader's questions and nothing else: a two-line header (an icon chip in the run's state
  tint, the run's name over `done/total · running phase · elapsed`, the state as a word in
  `WorkflowPill`), the meter, and a foot line that live says the step being written plus
  `currentActivity` (the newest call still open — `summarise`'s counts describe what a
  working step did a minute ago) and settled-failed names the step that failed. The whole
  card is one `DialogTrigger` button (children are spans — a button holds phrasing
  content), with a standing `Maximize2Icon` hint: hover is not the only way in, just the
  first one discovered. **The meter is one segment per step**, grouped by phase and tinted
  per step state (`WorkflowMeter`, `className` from the caller since card and dialog pad
  differently), replacing the pip-per-phase and done/total bar that used to sit apart:
  segments share width in proportion to a phase's step count, so a phase of six does not
  read the length of a phase of one. Every state colour anywhere — meter fills, mark
  discs, count pills, chips — comes from one table (`WF_TONE`/`wfTone`), because four
  surfaces each picking their own let a failed step read destructive in one and merely
  muted in another. **The dialog is the run**: it restates the card's header (it covers
  the transcript, so it must say which run it is showing) over a two-pane body — a
  sidebar of the run's phases with their steps under them, and the selected step's events
  beside it. The sidebar is a Base UI `Tabs.List`: each started step is a `Tabs.Tab`
  (`WorkflowStepTab`: state mark in its tinted disc, the definition's step name, a live
  second line of `currentActivity` while it runs, duration trailing) and the selected
  step's `SubagentBody` — the very same brief/thread-link/rail/report a step draws on its
  own, which is what `SubagentStep` was split around — is its `Tabs.Panel`
  (`WorkflowStepPanel`), scrolling in its own pane so a long rail never grows the dialog.
  Phase headers (`WorkflowPhaseHeader`: name, duration, done/total pill) are sticky and
  are not tabs — nor are pending rows — so they never take the roving focus and ↑/↓ walk
  the steps, Enter picks, Home/End reach the ends. Selection is **manual**
  (`activateOnFocus` off: a panel is a whole transcript) and only the selected panel
  mounts (`keepMounted` off, so nine steps cost one transcript). Phases no longer fold —
  the dialog has the room the card never did. Opening the dialog lands on the running
  step, else the failed one, else the first, and keeps a pick made last time; on a phone
  (`useIsMobile`) it opens on the list instead, because there the panel *replaces* the
  list (`max-sm:hidden` both ways) and the panel header grows a back button — the two
  panes are viewport-anchored now, so their breakpoints are `sm:`, not `@panel-*`. A
  running row is tinted `bg-primary/5` and a failed one `bg-destructive/5` (the two rows
  anyone is looking for), a pending row trails `waiting` rather than sitting blank, and
  every row carries its state as `sr-only` text, since the mark that states it is an
  icon. **The shape is drawn before it happens**: the same stamp carries `plan`, the
  whole outline (phases and the step names in them), repeated on *every* spawn — so the
  meter and the sidebar show every step of the definition from the first spawn, the ones
  the runner has not reached yet dimmed (`WorkflowPendingItem`), and `phasesOf` is what
  joins the outline to the steps that have started. Repeating it is what keeps it
  journaled and replayed for free: an outline sent once would have to be an event kind of
  its own, and a view built only from spawns can only ever say what has already happened.
  A flat definition's outline is one phase named `null`, whose header is left out — a
  plain step list, which is also what a journal written before phases existed replays as,
  since `phasesOf` falls back to the arrived steps when there is no plan.
  A settled step's duration is start-to-last-activity (`lastActivityAt`): nothing records
  when a step *ended*, and the reducer never marks one done. Only `update`s are mirrored: a child's
  `turn_started`/`turn_ended` on the parent's log would cut the parent's replay windows at
  turns it never had. The mirror is said twice, so it is counted once — `emitOn` raises
  `emit`'s `mirrored` flag and the web-search usage ledger skips it, and `indexEventRow`
  (`search.ts`) skips any `update` row carrying a `sessionId`, or every search hit inside a
  step came back twice. ACP's `PromptResponse` carries no text, so a step's answer is
  accumulated from its `agent_message_chunk`s in the same `subscribe` hook (capped at
  `LIMITS.outputBytes`); `whenTurnSettled(sessionId, turnId)` is how the runner waits,
  settled from `hostFor().onTurnSettled` (which gained `turnId` for it) and rejected by
  `processGone`, so a child that dies mid-step fails the step rather than hanging the run.
  `parent_session_id` is **not a foreign key**, and the `sessions` row's own comment says
  why: an SQL cascade would delete the children's rows underneath the manager's in-memory
  map — their journals, FTS rows and processes are the manager's to take down — and a backup
  merge inserts sessions in bundle order, where a child may precede its parent inside the one
  transaction; so `softDelete`/`restore`/`purge` cascade to `childrenOf` by hand, children
  first on purge. `workflow_runs` is the opposite: one row per run with a `steps` JSON
  column (the only queries are "runs of this thread" and "what was running when the server
  stopped"), and it *does* cascade off the parent, which only a purge deletes. A child is
  **retired the moment its turn settles** — it is a single-purpose process, and its id is
  proven by that turn (`onSessionDurable`), so the thread stays readable from its log and
  revivable through `session/load` like any retired thread. The trigger is the awkward
  half: the `workflow` MCP server (`workflow-mcp.ts`) is a process the *agent* spawns and
  cannot reach the SessionManager, so it drives the engine over HTTP at
  `/wf/<key>/<sessionId>/…` (`routes/workflows.ts`) — outside `/api`, the `/gw`/`/ide`
  key-in-path rule: the key is minted per boot and never stored, and the session id names
  the caller so a server can act for exactly the thread that asked and no other. **One level,
  never a tree**: `serversFor` hands no workflow server to a session with a
  `parentSessionId`, whatever its profile links, and `WorkflowRunner.start` refuses a caller
  that is a step — a step that could start a workflow makes the caps, cancel propagation and
  restart recovery a tree, and a definition that spawns itself the obvious failure. The
  tools answer within their wait budget (`run_workflow` ≤55s, then `wait_workflow`
  long-polls the same route) because an MCP tool timeout is the agent runtime's — codex 60s,
  Claude Code a hard wall clock — and every one of them is shorter than a pipeline. Children
  never push (`hostFor` gates `onTurnEnd`, permission and elicitation on `parentSessionId`:
  a phone told "turn finished" per step is told it five times for one workflow), and the
  idle sweep in the constructor now skips a session mid-turn (`bridge.promptActive`) and
  every child — a parent blocked inside a workflow call with no browser open was being
  retired under it. Nothing survives a restart (every step thread was this process's child):
  `recoverAtBoot` marks the running rows failed and journals `disconnected` on each parent,
  so a reopened thread shows the steps as disconnected rather than forever running.
  `pnpm test:workflow-schema` is the pure half; `pnpm test:workflow` drives the engine
  against the fake agent (`echo:` prompts).
- **MCP servers, skills and commands have two owners, and the agent gets the union.**
  A profile links them (the provider setup: a gateway's own servers, the skills that go with
  a house style), and a thread picks its own on the draft's composer strip
  (`ThreadToolsMenu` in `components/thread-tools.tsx`, where the profile's show checked and
  locked, so the thread's picks are exactly the additions). **That control outlives the
  draft**: the same component, `editable={false}`, sits in the composer's control row beside
  `SessionConfigPopover` for the whole of a started thread and reads the kit back — what the
  agent was spawned with, each entry saying whether it came from the profile or from the
  thread — because the picks were only ever visible while they were still hypothetical, and
  vanished at the moment they started mattering. It is a read-out and not a picker there:
  the links are written once at create and are what a revive spawns with, so there is
  nothing to toggle. A read-out lists only what is linked (a started thread has no use for
  the rest of the library) and draws nothing at all when a thread carries no tools. A
  project links nothing — it is the directory, not the toolset; the `project_*` link tables
  it once had are gone. Both
  owners are join tables with `ON DELETE CASCADE` — `profile_*`, `session_*` — read and
  written through one descriptor-driven helper, `server/src/db/links.ts`
  (`readLinks`/`writeLinks`/`unionLinks`), so a stale id links nothing and nothing filters.
  The thread's picks arrive in `POST /api/sessions` (`mcpServerIds`/`skillIds`/`commandIds`),
  are written once at create, reported back by `list()`, and are what a revive spawns with.
  `SessionManager.effectiveLinks` is the union; `serversFor` passes its MCP servers to
  `session/new`. Skills and commands are the awkward half: they are **materialised into the
  project's cwd**, which every thread of the project shares, and the materialiser sweeps
  whatever it did not write — so `materializeFor` hands `materializeWorkspace` the union
  across *every live thread in that cwd* plus the one spawning, never one thread's set alone
  (that pulled the symlinks out from under the thread next to it). It runs in
  `SessionManager.start`, not in `spawnAgent`, because only the manager knows the other
  threads; the probe materialises the profile's own set itself, which is additive and safe.
- **Every agent gets a virtual "Default" profile**, listed first. `defaultProfileFor`
  synthesizes `default:<agentId>` — no credentials and, deliberately, no `models`, which is
  what hands model and effort back to the agent per the rule above. It is offered for every
  agent, not just unconfigured ones: "run this agent as it ships" is a real choice next to
  "run it on my gateway", and without it the only way back would be deleting the profile.
  Never written to `data/`, cannot be edited or deleted. `profiles.ts` is the single source:
  the same function feeds `GET /api/profiles` and `getProfile` at spawn.
- **A draft cannot ask a process that does not exist**, so `lib/agent-options.ts` (a
  reactive device-local store, same shape as `pins.ts`) holds each profile's option set from
  two sources: whatever a live session last advertised, and — when nothing is known yet — a
  one-shot `POST /api/profiles/:id/options` (body carries `agentId`, since a profile may serve
  several). A pair that has no set of its own borrows the same agent's from a sibling
  profile (Default first) for display — the profile only
  overrides model/effort, everything else is the agent's — while its own probe still runs
  and replaces the borrowed set. The probe spawns the agent, runs the handshake as far as
  `session/new`, and kills it (`server/src/probe.ts`). The answer is cached **in the
  database**, keyed `profileId:agentId:cwd` (cwd is in the key because it changes the answer),
  with an in-flight map so two tabs asking at once spawn one agent, not two — so it is one
  spawn ever, not one per page-load, and `?refresh=1` is the escape hatch for an upgraded
  binary or a changed gateway catalog. Picks are held on the draft, sent as `configChoices`
  in `POST /api/sessions`, and applied by the bridge right after `session/new`.
  **Which options exist can depend on which model is selected** — opencode reveals `effort`
  only for its reasoning models, in the `set_config_option` *response*, with no
  `config_option_update` notification. So the probe does not just snapshot the current set:
  while it has the process up it walks the model list (capped at `MAX_MODEL_SWEEP`, and it
  logs when it truncates), recording what each model advertises, and the menu reads the
  entry for the model actually chosen. One spawn, the whole map. Still best-effort — a
  different cwd or an upgraded agent invalidates it — and the real set replaces it as soon
  as a session answers.
  **A thread that already exists asks the same question**, and that is not a special case
  of the draft's: `SessionConfigPopover` runs the same `learnAgentOptions` when the thread
  has advertised nothing *and* nothing is remembered — an archived thread with no process,
  a plain reattach (no call in it carries an option set), a device that has never drafted
  on this pair. The draft menu used to be the only writer, so the only way to make an old
  thread's Model/Effort rows appear was to open a new thread first and let it fill the
  store. It is gated on there being nothing to draw, because the answer costs a spawn: a
  live session is already the authority, and a pair borrowing a sibling's set already has
  something true to show. The store is device-local, so **saving a profile drops its
  entries** (`dropAgentOptions`, from the profile form) — the credentials, endpoint and
  catalog are what decide the answer, `learnAgentOptions` refuses to re-ask a pair it has
  a set for, and the server evicts its own probe cache on that same PUT.
  `refreshProfiles` re-reads the **agent registry along with the profiles**, since every
  agent's virtual Default is synthesized from it, and returning to a hidden tab re-reads
  both (throttled to a minute): the client is a PWA that stays open for days, and a
  profile added on another device — or an agent a server upgrade started offering — was
  otherwise invisible until a reload.
- **The client mints session ids and threads start as drafts.** "New thread" is a route
  change, not a round trip: `actions.newDraftThread` mints a UUID, puts a `draft: true`
  `SessionMeta` in the store and navigates. `POST /api/sessions` (which accepts that id,
  rejecting non-UUIDs and collisions) is not called — and no agent process is spawned —
  until the first message, in `actions.send` — and that POST does not answer until the
  handshake is done, so a 201 means the thread is genuinely ready. Everything that treats the server's list as
  the authority has to let drafts through: the `sessions` reducer **merges** instead of
  replacing, `refreshSessions` prunes against server ids **plus** draft ids, and
  `connectThread` returns early for a draft since there is nothing to connect to. A route
  for a thread the server has never heard of is adopted as a fresh draft rather than 404ing.
  An empty thread centres its composer over an animated wash (`styles/thread-hero.css`) and
  docks it on the first message — both driven by one `data-empty` flag on a grid whose
  spacer row animates `1fr` → `0fr`.
- **An agent's session id is earned, not announced — and a refused `session/load` never
  replaces one.** The conversation lives in the agent's store; `sessions.acp_session_id` is
  the only pointer to it, so what is written there is the one thing a thread cannot get
  wrong. What is written is therefore **ranked, not withheld** — `acp_session_id` plus
  `acp_session_provisional`, both in `AcpBridge` + `SessionManager.hostFor`. An id from
  `session/new` is written down immediately but flagged *provisional*: agents create the
  session in memory and flush their transcript lazily (codex's rollout file appears seconds
  later, and only once a turn records something), so nothing yet proves it loadable. A turn
  settling on it (`onSessionDurable` ← `settleTurn`) or a `session/load` that answers
  (`adoptSession(…, proven)`) clears the flag, and from then on **only another proven id may
  replace it** — a bare `session/new` never can. Withholding the unproven id entirely was
  the older rule and it was worse: a process killed before its first turn settled — a `tsx
  watch` restart, a crash — left the thread pointing at *nothing*, while the agent's rollout
  sat on disk with the whole conversation in it and no id anywhere to reach it by. A blank
  thread with no error, and the only repair a manual hunt through
  `~/.claude/projects/…/*.jsonl` for the orphan. A provisional id costs nothing to keep,
  because the failure it risks is already handled: when `session/load` is refused the bridge
  falls back to `session/new` (the thread has to be usable) and, if the refused id was
  **proven**, it stays on the record and the refusal is reported — `host.onHistoryLost` →
  `Session.historyLost` → the `attached` event → an error row in the transcript
  (`actions.makeCallbacks.onAttached`). That rule was not hypothetical either: the fallback
  used to persist its own fresh id, so one transient refusal overwrote the pointer to a
  transcript still sitting on disk — and because that replacement had no rollout either, the
  *next* revive failed and replaced it in turn. A chain of ghosts, each one the reason for
  the next, with the real conversation orphaned at the head of it. A load can fail for
  reasons that heal (the agent was mid-write, it was upgraded, the cwd moved); keeping the id
  means the next revive tries again instead of burning it. A refused **provisional** id is
  the mirror case — no turn ever committed to it, so there is no transcript to strand: it
  yields to the fallback silently, and `onHistoryLost` drops it rather than putting an error
  on every thread that was interrupted before its first turn.
  Note that the event log does **not** cover this gap, and the distinction is the whole
  reason it can be kept at all: **the journal is a cache for reading, never a source for
  resuming.** It survives a restart now, so a retired thread can be *opened and read* with no
  process at all — `attach` serves the archive and marks it `archived`, `openThread` takes
  that path when `meta.cursor > 0`, and `actions.send` is what revives, because sending is
  the moment a reader becomes a user. But nothing ever reconstructs a thread's state *for the
  agent* out of these rows: a revive is still `session/load`, and `respawnNow` clears the log
  before the load refills it so the two accounts can never be stitched together. That rule
  used to be enforced by deleting the table at boot, which also made reading yesterday's work
  cost a spawn. Reconnect paths always revive (`ConnectOpts.revive`) — a socket that dropped
  because the process died must not come back silently read-only. Retention is
  `sessionJournalRetentionDays` (default 30) and only ever drops **whole** logs of threads
  with **no live process**: trimming the head of a live one would hand the next full attach a
  transcript that silently begins in the middle, and dropping a whole archive is safe because
  the thread just falls back to reviving. `list()` and the respawn route report `liveAcpSessionId ??
  acpSessionId` — "what is this thread on right now" — which is also what `tasks.ts` matches
  transcript directories against.
- **A capability we don't advertise is a feature the agent turns off.** The `initialize`
  handshake in `server/src/acp-bridge.ts` is not a formality: claude-agent-acp puts `AskUserQuestion` on
  the session's `disallowedTools` unless the client claims `elicitation.form`, so without it
  the model cannot ask a question at all — not badly, at all. Same bargain buys codex's
  boolean config options (`session.configOptions.boolean`) and codex's plans (`plan`).
  **Context compaction is the same bargain and the quietest one**
  (`session.compaction`): an agent that runs out of window compacts either way, but without
  the claim it must keep `compaction_update`/`compaction_summary_chunk` to itself, so the
  history simply stops being what the agent can see and the transcript says nothing. The
  updates are ordinary `session/update`s — journaled, replayed, forwarded whole like the
  rest — so the whole client side is one thread item: `CompactionItem` in `lib/store.tsx`,
  an upsert keyed `compaction:<compactionId>` whose **first** update fixes its place in the
  transcript. `summary` and `error` have *patch* semantics (omitted = unchanged, `null` or
  `[]` = cleared, a value = replaced) and `compaction_summary_chunk` appends to the summary,
  which is why absent and empty must not be conflated: agents stream the summary in chunks
  and send the terminal `completed` with no `summary` at all. There is no compaction RPC —
  asking for one is the agent's own `/compact` slash command, which already rides the normal
  prompt path. Questions arrive as `elicitation/create`, NOT as a permission request: a form-mode request
  whose `requestedSchema` is a JSON Schema of primitive properties. Reading that schema —
  titled `oneOf` enums, `items.anyOf` multi-selects, and the two `_meta` conventions the
  AskUserQuestion bridges ride (`_askUserQuestionCustomAnswer`, which pairs a free-text
  "Other" field to a select field, and `_claude/askUserQuestionOption`, which carries an
  option's preview) — is quarantined in `lib/elicitation.ts`, the way `lib/tools.ts`
  quarantines tool-call shapes. `components/elicitation-form.tsx` renders it as a
  `ui/questionnaire` stepper, one field per step. Narrow the request with
  `isFormElicitation`/`isUrlElicitation`, never `mode === "form"`: the union's custom variant
  carries the same tag, so the guards check the payload instead. Answers are `accept` with
  content keyed by field; **`decline` is a real answer** (the bridges read it as "the user
  skipped" and the turn continues) where `cancel` aborts the tool call. The lifecycle mirrors
  `permission` exactly — one pending slot on `ThreadState` keyed by the server's `requestId`,
  cleared by `resolve`, dropped when `request_answered` says somebody else got there first,
  and pushed by the server (`onElicitationRequest`) when no peer is attached. A URL flow that
  completes is accepted **server-side** on `elicitation/complete`: the answer is already in,
  and waiting for a browser meant an agent with no peer attached blocked forever.
- **Subagents: the store is flat, the transcript is a tree, and there are three ways a
  runtime says whose work an update is.** ACP v1 has no subagent concept, so every
  runtime improvised and none agree. Claude Code (`claude-agent-acp`) sends the child's
  work on the *parent's* session, each update stamped `_meta.claudeCode.parentToolUseId`
  = the `toolCallId` of the `Task`/`Agent` call that launched it — but withholds the
  child's prose and thinking unless the client claims
  `clientCapabilities._meta["subagent-transcript"]`, and attributes best-effort: a child's
  `tool_call` can go out unowned and be told its parent on a later update. Codex
  (`codex-acp` ≥ 1.7) implements the draft **ACP Subagent Sessions RFD** (PR #1992):
  after both sides advertise `subagents`, the parent session gets `subagent_spawned
  {subagentSessionId, name, task, capabilities}`, the child's updates arrive as ordinary
  `session/update`s **whose `sessionId` is the child's**, and `subagent_state_update
  {state: completed|failed|cancelled|disconnected}` closes it on the parent; a
  `session/load` of the parent replays the children in place. Unnegotiated, the same
  runtime folds a child into lifecycle tool calls (`_meta.codex.subagent`,
  `_meta.codex.collaboration`) with no steps in them. OpenCode's shipped ACP bridge drops
  the child session entirely (only the `task` call and its `<task id state>…<task_result>`
  XML arrive — `parseTaskWrapper` unwraps it); its `acp-subagent-events` branch (PR #40654)
  projects the child onto the root with `_meta["opencode/child-session"] = {id, parentID,
  depth, title}` and tool ids namespaced `<childSid>:<callId>`, which is read as a third
  shape. Two things on the server make the RFD path possible. The SDK's `SessionUpdate`
  union is **closed** and `acp.client()` validates every `session/update` against it in a
  router that runs *before any handler* — so `agentStream` re-addresses the two RFD
  variants to `_daedalus/subagent_update` on the way in and the bridge listens on both
  names (`protocol.ts` declares `SubagentSpawned`/`SubagentStateUpdate` and the widened
  `SessionUpdate` both ends use). And the `update` event gains an optional `sessionId`,
  set **only** when the update is a child's, so every event journaled before subagents
  existed keeps its exact shape. On the client, ownership is resolved in one place —
  `applySessionUpdate`'s `owner`: `lib/tools.parentToolIdOf(_meta)` first (the two `_meta`
  shapes; the store still never reads `_meta` itself), else the child session id when the
  event carries one. The meta outranks the session on purpose: a workflow step's own Task
  tree arrives mirrored with the step's `sessionId` AND the Task attribution, and
  session-first filed every inner row under the step — the tree Claude Code's native
  transcript nests, flattened. The tool row the meta names travels on the same mirrored
  stream, so the head always exists. `owner` lands as `parentId` on every item; `subagent_spawned` becomes a
  `SubagentItem` (`subagent:<sessionId>`) for children no tool call launched. The store
  stays **flat** (arrival order, reducer/replay/`settleTools` untouched) and
  `lib/transcript-rows.ts` builds the tree at view time — `buildRows` = nest, then group —
  keyed on the *full* id set because a child can precede its parent; orphans stay flat;
  Codex's legacy lifecycle rows are grouped by thread id best-effort. `appendText`
  coalesces a text chunk only onto a run with the **same owner** (parent prose after a
  subagent is a new bubble, not the tail of the child's), a child's `user_message_chunk`s
  are dropped (tool-result echoes; the brief is on the parent), a child's plan/compaction
  ids carry `@<owner>` so they never replace the thread's, and a child's session-level
  updates (mode, options, usage) never reach `ThreadState`. `SubagentStep` (thread-items)
  draws it: bot icon, brief → rail of `RowView`s → report, open while live. Consumers that
  read `thread.items` must ignore `parentId` items where the thread's own is meant — the
  composer todo shelf, the rail's reply previews and the palette's transcript text do.
- **One service worker, and no Firebase inside it.** `client/src/sw.ts` is the whole
  PWA: Workbox precache, an SPA navigation route bound to the precached shell, and the
  `push`/`notificationclick` handlers. vite-plugin-pwa builds it (`strategies:
  "injectManifest"`) and `lib/pwa.ts` registers it through `virtual:pwa-register` —
  which is the only thing that knows the worker is `/dev-sw.js?dev-sw` as a module in
  dev and a classic `/sw.js` in a build. Updates are `registerType: "prompt"`, not
  auto: a new worker installs and waits, and `registerPwa` offers it as one pinned
  sonner toast (fixed id, so an hourly re-check replaces rather than stacks) whose
  Reload calls `updateSW(true)` — the worker only `skipWaiting()`s on that message.
  **That one toast has three faces**, because a build is a whole precache and the
  install is a download, not an instant: `watchInstalling` (off `updatefound`, and off
  the worker already in flight when `onRegisteredSW` lands) puts a *loading* toast up
  while the new worker installs, `onNeedRefresh` replaces it in place with the
  Reload/Later offer, and Reload replaces it again with a loading toast while the
  handover and reload happen. Only when something already controls the page — on a
  first install there is no old version, nothing will be offered at the end of it, and
  the announcement would be a lie. A failed install (`redundant`) dismisses the toast
  rather than leaving a spinner turning against nothing.
  Silently taking over would swap the precache under a page whose JS is already
  running, so a lazy chunk it asks for next is a hash that no longer exists, and it
  would reload the tab mid-turn. Reloading is cheap on purpose — drafts are in
  localStorage and the turn is the server's — but it is still the user's call. The reason FCM's SDK
  is *not* in the worker is the worker's lifecycle: the browser kills it when idle and
  restarts it per event, so only top-level code is guaranteed to have run when a push
  lands — and this client has no build-time config, so a config handed over at runtime
  (postMessage, IndexedDB) races that restart and loses. FCM on the web is Web Push
  underneath, so the worker reads the raw `push` event and needs no config at all.
  The page still uses the SDK, to mint a token — and `getToken` must be passed
  `serviceWorkerRegistration`, or it goes and registers a `firebase-messaging-sw.js`
  this app does not ship — and the app it *is* passed is a **named** app per Firebase
  project, never `getApp()`: several servers can be connected at once, each with its own
  FCM project, and the default app is whichever was reached first, so a token minted
  through it carries the wrong sender id and fails silently in both directions.
  `registerPwa` unregisters the retired `firebase-messaging-sw.js`, and does it
  **before** registering, not alongside: a registration is keyed `(origin, scope)` and
  the old worker held the same `/` that `/sw.js` claims, so they are one object — racing
  the two tears down the worker that just replaced it. **The payload is therefore a
  contract, not a convention**: `server/src/push.ts` sends **data-only** messages
  carrying `title`/`body`/`sessionId`, because a `notification` block is displayed by
  whatever FCM code is in a worker and a device with the retired one still installed
  would show two. It also sends them in batches of 500 (FCM rejects a larger multicast
  outright, so one extra device would cost *everyone* the notification) with a one-hour
  `TTL` and a `Topic` — the FNV hash of title+session, because the header caps at 32
  URL-safe characters and a truncated UUID would collide, which here means a dropped
  notification. Both exist for the phone that was off overnight: the push service keeps
  only the newest message per topic, so coming back means the state of each thread
  rather than a night of history, and nothing arrives about a turn already read.
- **Registering for push is reversible, and the reverse has to reach the server.**
  A token outlives the preference and the connection: turning off "System notifications"
  or forgetting a server leaves that server pushing to the device with nothing left in
  the UI to stop it. So `lib/push.ts` pairs `setupPush` with `teardownPush` — `DELETE
  /api/push/register` plus `deleteToken`, skipping the latter when another connected
  server shows the *same* cached token, since a token belongs to the Firebase project
  and revoking it would unsubscribe that server too. The client's "already registered"
  cache is `{token, at}` and re-POSTs weekly, because the server drops rows FCM reports
  dead while `getToken` keeps returning the same string — an unexpiring cache is a
  device that goes dark permanently and says nothing.
- **`new Notification()` is not available everywhere, and push does not cover the gap.**
  Chrome on Android forbids the constructor outright (worker-only), and the server pushes
  *only* while `peers.size === 0` — so the in-page path in `lib/notifications.ts`, which
  fires for a socket still attached from a window nobody is watching, is exactly the case
  push will never reach. It falls back to `registration.showNotification`, whose click the
  worker already routes on `data.sessionId`. Both paths pass `renotify` (declared in
  `vite-env.d.ts`; TS's DOM lib lacks it) — with a `tag` and without it, a replacement
  swaps the text in silence, which for a second permission ask is the same as no
  notification at all.
- **A slash command is either the agent's or the harness's, and the composer draws one
  list.** Agent commands come from `available_commands_update` and are ordinary prompts —
  `/name args` is sent, the agent resolves it, the send path is untouched. The harness's own
  (`HARNESS_COMMANDS` in `components/slash-commands.tsx`, declared in the same
  `acp.AvailableCommand` shape) are the exception the send path knows about:
  `harnessCommandFor` reads the composed text in `ThreadComposer.send` and, for
  `/schedule`, opens the schedule form with the rest of the line as its message instead of
  sending anything. That is how a message is scheduled now — the clock button beside the
  composer is gone: scheduling is *what to say and when*, which is typing, not a second
  control in a row of send/stop/voice. The composer's draft is deliberately **not** cleared
  on that path (nothing was sent, and the form can be backed out of), and a **draft thread
  is offered no harness commands at all** — `/schedule` needs a thread the server knows
  about, which a draft is not until its first message. The agent's catalog **shadows** the
  harness's: a runtime advertising its own `/schedule` keeps it, and `harnessCommandFor`
  then declines to intercept, because a name collision must cost the harness's command and
  never silently swallow the agent's. Harness rows draw with their own mark (`HARNESS_ICON`)
  rather than the generic slash, so a row that opens a harness surface does not read as one
  more thing the agent will answer.
- **An `@` mention is text in the prompt and a `resource_link` beside it.**
  `components/file-mentions.tsx` is the composer's file completer — the same strip row,
  the same key contract and the same mousedown rule as `slash-commands.tsx`, but the token
  is read **at the caret** (a file is named mid-sentence, a command never is), which is why
  the hook takes the textarea's ref and tracks the caret itself: a pick rewrites `text` and
  the caret it wants must be re-applied after that render, ahead of the sync from
  `selectionStart`, or the placement is undone by the effect meant to follow it. Picking a
  directory completes to `@path/` and leaves the token open so the next keystroke drills in;
  picking a file completes to `@path ` and is done. It reads one route,
  `GET /api/projects/:id/files/search?q=` (`searchEntries` in `workspace-fs.ts`): a
  breadth-first walk of the project — not `git ls-files` or `rg`, neither of which a project
  is guaranteed to have — skipping `DEFAULT_IGNORES`, never descending a symlink, budgeted at
  `SEARCH_VISIT_LIMIT` entries and ranked by a greedy fuzzy score that rewards adjacent runs,
  separator boundaries and basename hits. Breadth-first is what makes a *truncated* walk
  still useful: it returns the shallow paths, which are the ones a person meant. What the
  composer sends is unchanged — plain `@src/index.ts` in the text, so the draft, the queue,
  the journal, Retry and the prompt-history walk all stay strings and none of them learned a
  second shape. The protocol half is the server's: `AcpBridge.prompt` appends the
  `resource_link` blocks that `server/src/mentions.ts` derives from the text, and **only for
  a token that resolves to something existing inside the session's cwd** — prose is full of
  at-signs (an address, a handle, a decorator) and inventing a file reference for one sends
  the agent after a path nobody named. Containment is checked lexically and then against the
  real path, like every other path in `workspace-fs`, because `@../../.ssh/id_rsa` is user
  input naming a file *for an agent to open*. Both halves travel on purpose: the text is what
  every runtime already understands, the links are what a runtime that reads the protocol can
  resolve without guessing, and dropping the text would make the transcript stop saying what
  the user typed.
- **"Mobile" is two questions: width is the panel's, the pointer is the device's.**
  A dockview panel is a box inside the window, so a media query is the wrong instrument
  for anything a *panel* has to fit — a chat squeezed to 320px beside a terminal was
  drawing the desktop layout because the window was still 1600px wide.
  `components/workspace/panel-container.tsx` wraps every panel's content, in the one place
  the component map is built (`dock.tsx`), in an unnamed `@container`, and `index.css`
  declares `--container-panel-sm: 40rem` / `--container-panel-md: 48rem` — deliberately the
  pixel values of `sm:`/`md:`, since the variants they replace were written against those.
  So layout that needs *room* (the workflow table's activity column, the queue rows that
  wrap their actions, the strip's inset and its collapsed labels, the turn rail) is
  `@panel-sm:`/`@panel-md:` now. Touch targets, the terminal's soft key bar and
  Enter-inserts-a-newline stay on `useIsMobile` and plain media queries, because a narrow
  panel on a desktop is still driven by a mouse; and viewport-centred things (the dialog
  that becomes a drawer, the sidebar sheet) stay on the window because that is genuinely
  what they are measured against. The container is `inline-size`, not `size` — sizing both
  axes means size containment, and a panel whose height failed to resolve would collapse to
  nothing rather than merely lay out wrong. That leaves `cqh` unavailable, so the panel's
  **height** is measured by one ResizeObserver and published as `--panel-h`, written to the
  style attribute rather than held in state (it changes every frame of a sash drag and
  nothing renders differently for it). Every `svh`/`vh` cap inside a panel — the shelf, the
  approval's evidence band, `PANE_MAX_H`, the error fallback — reads
  `var(--panel-h, 100svh)`, and that fallback is what makes the same class correct outside
  the dock.
- **A key that is bound is a key that is listed.** `client/src/lib/shortcuts.ts` holds
  the chord vocabulary (`mod` = ⌘ or Ctrl), the matcher, and the `SHORTCUTS` table that
  `components/shortcuts-help.tsx` (`?` / `⌘/`, and a command-palette entry) prints — so a
  binding nobody can discover is a bug in one file, not two. **A chord is printed by
  `components/shortcut.tsx` and nowhere else**: `Shortcut` draws keycaps on shadcn's
  `Kbd`/`KbdGroup`, from a chord (`chord="mod+k"`, split by `chordKeys`) or from literal
  caps (`keys={["1…9"]}`) for a range or a glyph that is not a binding. Every surface reads
  it — the sheet, the palette, the `+` menu, a tooltip, the sidebar's hover hint, the
  permission card's digits — because they each used to draw their own: half printed
  `formatChord()` into bare text and half built keycaps by hand, so one chord read three
  ways depending on where you met it. `formatChord` survives for the places a chord has to
  be a *string* (a tooltip prop, an aria-label). `CommandShortcut`/`DropdownMenuShortcut`
  drop their letter-spacing when they hold a `kbd-group`, since tracking meant for bare
  glyphs pulls keycaps apart. `hooks/use-hotkey.ts` binds on
  `window` with the handler in a ref and skips an event another handler already claimed
  (`defaultPrevented`), which is how a local owner — the slash menu's arrows, a dialog's
  Escape — always beats a global. Scope is the real decision: global keys are unguarded,
  **thread keys are gated on `currentThreadId(location)`** because the dock keeps every
  opened transcript mounted and only the routed one is in front, and composer keys stay on
  the textarea where the caret is what they are about. `ThreadView.useThreadKeys` owns the
  whole Escape chain in one place — skip the elicitation, else reject the permission (only
  if the agent offered a reject), else stop the turn — rather than letting each card bind
  it and race. Digits/Enter answer a permission only when `isTypingTarget`/
  `isInteractiveTarget` say nothing else owns the key. Prompt history (↑/↓) reads the
  transcript's own user turns: no second store, nothing to persist, and nothing that can
  disagree with what is on screen.
- **Errors are never `String(err)`.** `client/src/lib/errors.ts` normalizes everything
  thrown (`AgentError` from `lib/thread-socket`, the plain `{code, message, data}` on a
  `turn_ended`, `ApiError` from `lib/settings`, network failures, aborts)
  into `{ title, detail }`: `describeError` for the values, `reportError(err, context)`
  for the toast, where `context` names the action ("Couldn't save the profile") and the
  normalized title/detail go underneath. Failures that belong to a thread go IN that
  thread instead — `actions.recordError` appends an `error` ThreadItem (title / reason /
  folded detail / `retryText` for a Retry button), which survives longer than a toast and
  comes back on reload from the journaled `turn_ended` (which carries the prompt text, so
  the rebuilt row still offers Retry). `installGlobalErrorReporting()` in `main.tsx` is
  the floor under both.
- The server splices the agent's stderr into errors on the way out
  (`SessionManager.enrichError`, `data.stderr`) — "Internal error" is a code, not an
  explanation, and the explanation was only ever on stderr. When the process dies mid-turn
  the SDK rejects instantly with "ACP connection closed", which explains nothing while the
  stderr that does has not finished arriving — so the bridge **holds** that turn until
  `close(reason)` (called after `EXIT_DRAIN_MS`) has both the reason and the output.
  `GET /api/sessions/:id/stderr` exposes the tail. `app.onError` turns every route throw
  into the `{ error }` shape the client already parses.
- **The dock holds four panel kinds: chat, editor, terminal and web (the *Browser*
  panel).** The framed `code-server` panel, the "Simple IDE" opening, the file
  explorer, the source-control panel, the Output & problems panel and the Subagents &
  workflows panel have all been removed
  from the client — with them went `ide-panel.tsx`, `simple-ide.ts`, `explorer-panel.tsx`,
  `source-control-panel.tsx`, `output-panel.tsx`, `agents-panel.tsx`, `lib/workspace/ide.ts`,
  `lib/workspace/ide-theme.ts`, `lib/workspace/output.ts` and the ⌘⇧E / ⌘⇧G / ⌘⇧U chords.
  The server's `src/ide.ts` + `src/ide-proxy.ts` (code-server spawn, `/ide/<key>/` proxy) and
  `src/git.ts` are still there and still routed; nothing in the UI reaches the IDE half any
  more, while git is still read by the editor panel's diff mode (`gitFileAt`). An editor
  panel is opened from the transcript's file links — there is no tree to pick a file from,
  so `openWorkspacePanel("editor")` is gone too. Output went the same way: it was a
  device-local buffer per project fed by two producers that already had a home on screen —
  `recordError`'s failures, which are a transcript row, and task journal events, which are
  a task card — so the pane was a second copy of both, and `parseLocation` was maintaining
  four compiler-diagnostic regexes to make a `file:line` clickable in the copy. A layout
  restored with an output panel in it drops that panel and keeps the rest, which is
  `parsePanel` returning null for a component it does not know. The agents panel went for
  the same reason and took `AgentsScope` with it: a thread's workers are already drawn
  where the work is — the transcript nests every subagent step under the call that
  launched it and folds a workflow run into its own card, and the composer's shelf says
  how many are running — so a panel beside it was a third view of one stream, and the only
  panel that was pruned by session rather than by project. **None of the subagent or
  workflow machinery is affected**: the RFD events, `mergeWorkflowRuns`, `WorkflowRun`,
  `SubagentStep`/`SubagentBody`, `ComposerAgents` and the whole server-side engine are
  untouched.
- **A project has a page of its own (`/projects/<id>`), and it is assembled from two
  halves on purpose.** Until it did, a project was a row in settings (a form), a folder in
  the sidebar (a list) and a name in a thread's header — three surfaces that each say a
  *part* of what a workspace is and none that answers "what is this project, and what has
  happened in it". `components/project-page.tsx` is that answer: the header (mark, name,
  the cwd as a copy button, description, Edit / New thread), four tiles, a 30-day activity
  strip, the project's threads, and the rails beside them (what it is worked on with, what
  is scheduled against it, what it has accumulated). The **live** half is the store's —
  `state.sessions` already carries every thread with its process state, so the thread list,
  the running/waiting dots and the scheduled rows need no request and are right the moment a
  turn starts; the status reading is the sidebar's exactly (`turnActive` ?? `promptActive`,
  a pending permission or elicitation outranking both). The **settled** half exists only in
  SQLite and arrives as one `GET /api/projects/:id/stats` (`server/src/project-stats.ts`,
  `lib/workspace/project-stats.ts`) — one route, so the page paints once, refetched on mount
  and by Refresh and **never on a timer**: nothing in it is worth a poll, and the half that
  moves is the half that already moves on its own. Two rules in the numbers. **Turns, not
  events**: an event is a streaming chunk and a long turn is thousands of them, so
  `session_events.kind = "turn_started"` — journaled exactly once per turn — is the only
  countable that means anything to a person, and the activity strip is grouped by
  `date(at, 'unixepoch', 'localtime')` in SQLite (a UTC bucket cuts every evening in half
  for half the world) and re-expanded client-side into a fixed run of days, because a bar
  chart missing its empty days reads as busy. And **a tile skeletons rather than zeroes**
  while the fetch is out: a 0 that becomes 400 is a statement the page made and took back.
  `cwdExists` is the one health answer it can give — a project whose directory has moved
  spawns nothing, and that failure otherwise surfaces as an ENOENT inside a thread. The
  page is reached from the folder's hover control in the sidebar, the project name in a
  thread's header, the palette's Projects group and the settings row — settings keeps the
  *form*, this is the workspace as a thing with a history.
- **A project is a directory, and a directory is not one git repository.** It can hold
  several, or sit inside one, so `server/src/git.ts` addresses a `RepoContext` rather than
  "the project's git": a `dir` (always inside the project, and the cwd every invocation
  runs in — which is what scopes `add --all`, `reset` and `status` to what the panel
  listed), a `scope` (the repo-relative prefix of that dir, because porcelain v2 prints
  paths relative to the *worktree root* wherever git was run — stripped on the way out, so
  a project nested in a monorepo shows `index.ts` and never `packages/app/index.ts`, and
  needing no repair on the way back in since pathspecs are read from the cwd), and a `path`
  (where the repo sits in the project; `""` is the project itself, and the client joins it
  back on with `repoPath` before opening an editor). `repositories()` is a bounded
  breadth-first walk for `.git` that does not descend through a checkout it has already
  found — what is under one is that checkout's business. A subdirectory named as `repo` must be a worktree
  *root*: otherwise the enclosing repository would answer under a path prefix that is a
  lie, and staging one of those rows would stage a different file. `fileAt` is the one
  call with no `repo` at all — its `path` is project-relative and a file belongs to exactly
  one worktree, so the server derives it, and the editor's descriptor does not grow a
  second answer that can drift from the path beside it. The routes are still served; the
  only client left reading them is the editor panel's diff mode, since the source-control
  panel is gone.
- **Backup is one JSON document, and import is one transaction.** `server/src/backup.ts`
  exports every user-data table in `db/schema.ts` (agents, profiles with their links,
  the library, projects, knowledge, previews, sessions with their links, queue,
  schedules, the event log, tasks, web-search usage, push tokens) plus config.json's
  `webSearch` block — never the server's token/host/port, the `agent_options` probe
  cache, or the `history_*` rows (meaningless without the snapshot files). Two opt-outs:
  `secrets=0` blanks profile keys, MCP header/env values and the search token, and
  `journals=0` leaves the transcripts out (the bulk of any install; a thread without one
  still revives through `session/load`). `GET /api/backup` downloads it;
  `POST /api/backup/import?mode=merge|replace` validates it against `BundleSchema` and
  writes it — `merge` upserts by id with a non-cascading `ON CONFLICT DO UPDATE` (an
  `INSERT OR REPLACE` would fire the cascades and take a profile's links with it),
  `replace` empties every table first. A thread's queue/schedules/log are replaced as a
  unit for every thread the bundle names (a merged log is two accounts stitched together);
  child rows whose parent exists nowhere are counted as `orphaned`, not fatal; a blank
  secret keeps the install's existing value, so a redacted bundle merged over its own
  install changes nothing. The route retires the threads it is about to rewrite first
  (`SessionManager.retireAll`) and `reload()`s the manager after — that is the same code
  the constructor runs at boot, and it leaves a live process untouched, rebuilds
  process-less rows (closing peers reading a changed archive), and drops rows that are
  gone. The client page is Settings › Backup (`components/settings/backup.tsx`): it reads
  the counts out of the chosen file locally, confirms, and hard-reloads after an import.
  `pnpm test:backup` round-trips it. The `agent_quota` cache is left out for the same
  reason the probe cache is — a percentage restored onto another machine describes an
  account that machine may not be logged into — but an agent's `quotaProbe` **is**
  carried, because a restored row keeps its `seededVersion` and would never be backfilled.
- **Subscription quota is read by asking the runtime's own CLI, out of band.** ACP has no
  field for "how much of your plan is left", and the transcript's per-turn `Usage` is
  tokens, not windows — a plan's five-hour and weekly limits live on the *account*. So
  `server/src/quota.ts` runs what a person would: `claude -p "/usage" --output-format
  json` (that command is registered `supportsNonInteractive`, answers from local state
  with no API round trip, ~2.3s) and `codex app-server`'s JSON-RPC `account/read` +
  `account/rateLimits/read`. The command is **data on the agent** — `AgentDef.quotaProbe`,
  `{kind, command, args}`, seeded and backfilled like `spawnCategories`/`liveConfig` — so
  a user who repoints `command` can repoint this too; `kind` picks the adapter, because a
  CLI printing prose and a JSON-RPC server are not the same conversation. It names the
  plain CLI, never the ACP binary: the adapter is a session and a session is not what has
  an account. Two rules carry the design. **The snapshot is normalized (`QuotaSnapshot` in
  `protocol.ts`, so there is one copy of the shape) and the raw text is always kept** —
  one adapter parses prose, prose moves between releases, and a wording change has to
  degrade to "here is the report, unparsed" rather than to a card claiming 0%. And **"no
  quota" is an answer, not a failure**: an agent on a gateway or an API key has no
  windows, which is the common case here, so it reads `api-key` and the UI says so in
  words — never a zeroed bar, which is a different statement. (Verified: a codex on
  `auth_mode: apikey` answers `-32600 chatgpt authentication required to read rate
  limits`.) Codex's app-server is a *server*, so the probe kills it as soon as both
  answers land — waiting for it to exit cost the full 30s timeout for a reply that
  arrived in one. Readings are cached in `agent_quota` keyed `profileId:agentId` with a
  5-minute TTL — a quota moves on its own, so unlike the option probe this expires rather
  than being keyed by everything that could change it — coalesced by an in-flight map, and
  `?refresh=1` is the escape hatch. Errors are cached too: a missing binary re-spawned on
  every render is the one case where retrying hardest helps least. `SessionManager.refreshQuota`
  re-reads when a turn settles (the turn is what spent it) and fans out the live-only,
  absolute `quota` event — never journaled, or a replay would redraw last week's
  percentages as now — skipping child sessions and threads with no peer attached, and
  swallowing its own failure, since a missing `claude` must not surface as an error on a
  turn that succeeded. `GET /api/quota` is every probe-capable agent on its virtual
  Default profile (no credentials, so the agent runs on its own `claude`/`codex login` —
  which is what a subscription *is*); `GET /api/quota/:agentId?profileId=` is one pair.
  Settings › Usage (`components/settings/quota.tsx`) draws windows, not runtimes — a
  runtime metering three windows renders with no edit — with a profile selector, a Refresh
  and the raw report folded underneath; the composer's stats popover carries the same bars
  under the turn's own numbers (asked for once, on first open, then kept current by the
  event). **Settings › Usage is the only surface that lists plans.** The sidebar had a
  Usage row — a peak-percentage badge over `fetchAllQuota`, polled every ten minutes,
  hidden when nothing reported — and it is gone: it was the one nav row that *worked*
  rather than navigated, making the sidebar ask the server a question nobody had posed,
  on a timer, for a number whose only use is to send you to the page that shows it
  properly. The composer popover keeps its bars because they are about the turn you are
  in. `pnpm test:quota` pins both parsers against captured fixtures.
- **The other plan is the provider's, and it is read from the profile — which outranks
  the agent's probe.** The rule above asks a *runtime's* CLI about the machine's own
  login, which is the right question for `claude`/`codex login` and nonsense for a
  gateway: a thread running Claude Code against a Z.AI GLM Coding Plan spends z.ai's
  five-hour and weekly windows, while `claude -p /usage` answers confidently about an
  Anthropic account that turn never touched. The account being spent belongs to the
  *credentials*, so the reader does too — `profiles.usage` (`ProfileUsage` in
  `db/schema.ts`: a `kind`, an optional host, an optional separate token), declared
  exactly the way `quotaProbe` is and dispatched to an adapter in
  `server/src/usage-api.ts`. Set, it wins in `runProbe`, and everything below the choice
  is shared — one `QuotaSnapshot`, one cache, one `quota` event — so nothing downstream
  knows which reader ran. **The adapter owns the endpoint**: `ProfileUsage` never carries
  a URL to fetch, a header name or a response path, because these are the routes a
  provider's own dashboard calls rather than ones it documents (z.ai's wants the key in a
  bare `Authorization` with *no* `Bearer`, and buries its windows under integer unit
  codes — `unit:3, number:5` is the rolling five hours, `unit:6, number:1` the week);
  expressing that as configuration would make the profile form a small programming
  language and the next provider still would not fit it. An unknown `kind` therefore
  throws rather than falling through to whichever adapter is the default branch, which is
  the one thing the agent-side `runProbe` still does. Two consequences worth stating.
  **The cache key changes shape**: a probe's answer is the (profile, agent) pair's, a
  provider's is the *profile's* alone — one account whatever runtime spends it — so it
  keys `<profileId>:usage` and Claude Code and Codex on the same plan share one reading
  instead of making the same call twice and drawing two cards. `invalidateQuota` takes
  the profile rather than its id for exactly that reason, and `updateProfile` now drops
  every `agent_quota` row under the profile (the TTL covers a number that moved; it does
  not cover a number that is now about a different account). And the reading has a
  `source` (`"agent" | "profile"`, absent on rows journaled before this existed, which
  were all agents'): `GET /api/quota` lists provider plans *first* and then the
  probe-capable agents, `GET /api/quota/profile/:profileId` is one plan on its own, and
  Settings › Usage picks `ProfileQuotaCard` or `AgentQuotaCard` on it — same
  `QuotaBody` underneath, no agent selector on the provider one because there is no
  agent. Configured in the profile form's "Plan usage" section, where the token follows
  the same write-only bargain as `apiKey` (a boolean comes back; empty on save keeps the
  stored one) and empty means "use the profile's own key", which is the ordinary case.
  The one built-in adapter is `zai` — `GET {host}/api/monitor/usage/quota/limit`, host
  inferred from the profile's own base URL so a `bigmodel.cn` gateway reads the CN
  platform — and adding a provider is `USAGE_KINDS`, a branch in `readProfileUsage`, and
  a label in `USAGE_PROVIDERS`. `pnpm test:quota` covers `foldZaiQuota` and
  `zaiQuotaUrl` beside the other two parsers.
- Test agent: `server/test/fake-agent.mjs` (registered as `fake-echo`), drives the UI without
  credentials. It answers raw NDJSON, which the SDK on the other end is happy with — it
  validates inbound `session/update` params but not responses.
- No visual testing: don't drive the UI with Playwright/browser automation or take screenshots
  to check work. Verify with `tsc -b` and reasoning about the code; the user checks the UI.
