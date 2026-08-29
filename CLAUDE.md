# Daedalus Harness

Generic ACP (Agent Client Protocol) harness. Three parts, one repo:

- `server/` — Node 22 + Hono + ws. **The ACP client lives here.** It spawns an agent
  process per thread (agent registry, `{apiKey}`/`{baseUrl}`/`{model}`/`{cwd}` placeholders
  filled from profile + project) and drives the protocol over its stdio with
  `@agentclientprotocol/sdk` — one `AcpBridge` (`src/acp-bridge.ts`) per process, owning the
  handshake, `session/new`-vs-`session/load`, prompts, config, and the permission and
  elicitation requests the agent blocks on. What reaches the browser is *derived state*: the
  small command/event protocol in `src/protocol.ts`, over the same WebSocket. Also owns
  **profiles** (agent config: credentials/models, keys redacted from the API), **projects**
  (workspace: cwd + linked MCP/skill ids), the **library** of reusable MCP servers/skills,
  bearer-token auth, the event log (reconnect/replay), and FCM push.
  `data/` holds secrets — gitignored, never commit.
- **Storage is SQLite via Drizzle** (`server/src/db/`), not JSON files.
  `data/daedalus.db`, opened with better-sqlite3 — chosen over `node:sqlite`/libsql because
  it is what Drizzle's Node driver binds to *and* it is synchronous, and `getProfile`/
  `getAgent`/`listProjects` are called from sync paths (`spawnAgent` builds a child's env from
  all three). Every query goes through the `db` exported by `db/index.ts`, so the driver is
  swappable in one file. Schema in `db/schema.ts`; migrations are generated
  (`pnpm db:generate`) into `server/drizzle/` — **committed, and applied at boot** by
  `migrate()` — never `drizzle-kit push`. A pre-SQLite install is imported once on first boot
  and its files kept as `*.json.imported` (`importLegacyJson`). Two things the JSON could not
  express: a project's MCP/skill links are **join tables with `ON DELETE CASCADE`**, so a
  dangling id cannot exist and nothing filters for one any more; and the **event log is a
  table** (`session_events`) keyed `(session_id, seq)` rather than an unbounded in-memory
  array, so `cursor` is a monotonic seq, a replay is a range scan, and a long thread costs no
  RAM. `data/config.json`
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
  `components/ui/diff-view.tsx` is a dependency-free line LCS.
  Device-local, per-session state lives in its own tiny stores — `lib/drafts.ts`
  (unsent prompts), `lib/pins.ts` (pinned threads), `lib/view-options.ts`
  (timestamps/tool grouping) — all pruned from `refreshSessions`. The shelf above
  the composer is `components/composer-strip.tsx`; app icons regenerate from
  `client/build/icon.svg` via `pnpm icons`.
  Theme/layout ported from
  `/var/www/mawared-off/social-live-agent/ai-agent-web` (glass surfaces, Inter, step-row
  transcript). Electron shell lives in `client/electron/` (frameless, vibrancy/acrylic).
- No build-time client config: server URL + token are entered at runtime (localStorage).

## Commands

- Agents are spawned by their **globally installed binary**, not through `npx`:
  `npm install -g @agentclientprotocol/claude-agent-acp @agentclientprotocol/codex-acp`.
  npx re-resolves the package on every spawn, and a thread spawns on create, on revive and
  on every profile/model change — measured here at ~3.2s per spawn versus ~0.4s for the
  binary. A missing binary fails with ENOENT, which surfaces in the thread; the
  self-installing form is `command: "npx"`, `args: ["-y", "<package>"]`. Defaults live in
  `DEFAULT_AGENTS` (`server/src/registry.ts`); each carries a `since` seed version and
  `seedAgents()` inserts only the ones this install has never been offered, so **an agent
  added in a later release reaches installs that already have rows** (the old seed-if-empty
  rule could not). It backfills fields a release *adds* (e.g. `spawnCategories`) onto older
  built-in rows but never replaces name/command/args/env — those are the user's. A release
  that adds a single key *inside* one of them (the codex catalog key in `CODEX_CONFIG`) says
  so with a `backfill` on the seed entry, which merges that one key and leaves the rest; it
  also drops that agent's cached probe answers, since what the key adds is what the probe
  reports.
- Server: `cd server && pnpm dev` (prints token), `pnpm test` (bridge self-check against the
  fake agent: handshake, event log, replay, multi-peer, failure paths).
- **The server is deployed built, not with tsx.** `pnpm build` emits to `server/dist/` via
  `tsconfig.build.json` — the only place the server is emitted; `tsconfig.json` stays
  `noEmit` because it is what the editor and `tsc --noEmit` typecheck (tests included).
  `dist/` sits one level under `server/` exactly like `src/`, so every
  `join(dirname(fileURLToPath(import.meta.url)), "..")` — `data/`, `drizzle/` — resolves to
  the same directory built as it does under tsx. `pnpm serve` runs it; `pnpm pm2:start`
  builds and (re)starts `ecosystem.config.cjs` on **port 4001**, `pm2:stop` / `pm2:logs` for
  the rest. The port there is `DAEDALUS_PORT` in the env, not `data/config.json`: `pnpm dev`
  reads that same file, so a port written into it would move dev too. `loadConfig` therefore
  lets the env win for `host`/`port` and *only* those — token, FCM and idle timeout stay the
  file's, and the token-seeding write puts the file's own port back rather than persisting
  the override. One instance, fork mode: the agent child processes, the WebSocket peers and
  the SQLite handle are owned by this process, and a cluster fork could not see another
  fork's bridges.
- Schema change: edit `server/src/db/schema.ts`, run `pnpm db:generate`, commit the SQL in
  `server/drizzle/`. `pnpm db:studio` browses the database.
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
  second parser and no cursor to keep in step (it always attaches from 0). The bracket is
  load-bearing: without it a reload re-fires a desktop — and, with nobody watching, a push —
  notification for every turn in the thread. `session_config` carries **absolute** state,
  which is what makes it safe to journal and broadcast at once; never make it a delta.
  The replay travels in **bulk** — one `replay` frame per `REPLAY_CHUNK_SIZE` events rather
  than one frame per event — because the browser woke, parsed and re-rendered once per
  frame, and that, not the range scan, was what made a long thread visibly rebuild itself.
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
  *overridden* the agent: those ids reach it only through `{model}`/`{effort}`/
  `{contextWindow}` in the env template (`server/src/registry.ts`), so picking one respawns
  (`actions.changeSpawnConfig`). A profile that lists none defers to the agent, whose
  `category: "model"` / `"thought_level"` selectors apply through
  `session/set_config_option` — one call, safe mid-turn, no restart. The override is scoped
  to exactly those two settings: **every other agent option passes through untouched and
  stays live** in either case. This exists because an agent pointed at a gateway advertises
  its own catalog, which the endpoint does not serve — codex derives its effort list from
  the *current model's* metadata, so an unknown gateway model id yields no effort selector
  at all. **The profile's catalog is therefore written out as the agent's catalog** where an
  agent will read one: codex looks a model up by *slug* in its built-in list and an id it has
  never heard of gets invented metadata (`Model metadata for … not found. Defaulting to
  fallback metadata`) — a made-up context window, so compaction fires at the wrong point, and
  no reasoning levels, which is that missing effort selector. `model_context_window` does not
  silence it; only `model_catalog_json` does, and it takes a *path*. So
  `server/src/model-catalog.ts` writes `data/model-catalogs/<profileId>.json` on spawn and
  `{codexModelCatalog}` in the env template points at it. An entry carries far more than
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
  one-shot `POST /api/profiles/:id/options`. A profile that has no set of its own borrows a
  sibling profile's of the same agent (Default first) for display — the profile only
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
  Note that the event log does **not** cover this gap: `SessionManager`'s constructor
  deletes every row of `session_events` at boot, so a restart leaves `session/load` as the
  only route back to a transcript. `list()` and the respawn route report `liveAcpSessionId ??
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
- **One service worker, and no Firebase inside it.** `client/src/sw.ts` is the whole
  PWA: Workbox precache, an SPA navigation route bound to the precached shell, and the
  `push`/`notificationclick` handlers. vite-plugin-pwa builds it (`strategies:
  "injectManifest"`) and `lib/pwa.ts` registers it through `virtual:pwa-register` —
  which is the only thing that knows the worker is `/dev-sw.js?dev-sw` as a module in
  dev and a classic `/sw.js` in a build. Updates are `registerType: "prompt"`, not
  auto: a new worker installs and waits, and `registerPwa` offers it as one pinned
  sonner toast (fixed id, so an hourly re-check replaces rather than stacks) whose
  Reload calls `updateSW(true)` — the worker only `skipWaiting()`s on that message.
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
- **A key that is bound is a key that is listed.** `client/src/lib/shortcuts.ts` holds
  the chord vocabulary (`mod` = ⌘ or Ctrl), the matcher, and the `SHORTCUTS` table that
  `components/shortcuts-help.tsx` (`?` / `⌘/`, and a command-palette entry) prints — so a
  binding nobody can discover is a bug in one file, not two. `hooks/use-hotkey.ts` binds on
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
- **The IDE panel is a whole VS Code, and the harness owns the process.** The `ide`
  panel kind frames `code-server`, spawned per project by `server/src/ide.ts` and reached
  only through `server/src/ide-proxy.ts`. It is not a richer `editor` panel — that one is
  this app's own CodeMirror over the workspace filesystem API, with its theme, its save
  path and its close guard; nothing inside the frame is ours to draw. Pointing an iframe
  at `localhost:8080` was never an option: the page may be on a phone or behind
  `dev:tunnel`, where `localhost` is that device, so the only address the browser can be
  given is the harness's own. So code-server binds `127.0.0.1` on an ephemeral port with
  `--auth none`, and what is exposed is `/ide/<key>/…` — **a capability in the path, not a
  header and not a cookie**. An iframe cannot set `Authorization`, and every asset, font
  and WebSocket code-server asks for afterwards is a *relative* URL, so the credential has
  to be somewhere the browser repeats on its own; a cookie would need `SameSite=None;
  Secure` (the app's origin and the server's are different — Vite, a tunnel, Electron) and
  plain-http localhost refuses that. The key is 24 random bytes, minted by the
  authenticated `POST /api/projects/:id/ide`, held in memory, dead with the instance. The
  proxy strips the prefix before forwarding, which is code-server's documented sub-path
  shape, and it does three things on purpose: drops hop-by-hop headers, **drops
  `x-frame-options` and the `frame-ancestors` directive** (code-server refuses framing,
  which is right for the internet and wrong for the one caller that exists), and
  re-prefixes a `location` — a redirect to `/?folder=…` would otherwise walk the iframe out
  of the prefix and lose the key. The upgrade half is not optional: VS Code's whole session
  rides one WebSocket, so `/ide/*` is tunnelled in `server.on("upgrade")` **before** the
  token check, as raw piped sockets rather than a second `ws` server — this end has nothing
  to say about the protocol, and re-encoding frames would cost a copy per keystroke.
  Opening the panel starts the editor; closing it does not stop one (an extension host, a
  build and an unsaved buffer are what you close a laptop on) — `IDLE_MS` without proxy
  traffic sweeps it, and Stop is how you mean it now. Singleton per project because the
  server is: two extension hosts writing one `.vscode` is a corruption. A missing binary is
  a state, not an error — the panel prints the install command and never runs one.
- Test agent: `server/test/fake-agent.mjs` (registered as `fake-echo`), drives the UI without
  credentials. It answers raw NDJSON, which the SDK on the other end is happy with — it
  validates inbound `session/update` params but not responses.
- No visual testing: don't drive the UI with Playwright/browser automation or take screenshots
  to check work. Verify with `tsc -b` and reasoning about the code; the user checks the UI.
