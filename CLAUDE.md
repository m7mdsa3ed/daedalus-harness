# Daedalus Harness

Generic ACP (Agent Client Protocol) harness. Four parts, one repo. This file is the
**rules**; the reasoning behind each one — the failure it was written for — lives in
`docs/`, linked per section. Read the linked file before changing the behaviour it
describes; every one of those rules cost a bug.

- `server/` — Node 22 + Hono + ws. **The ACP client lives here.** It spawns an agent process
  per thread (agent registry, `{apiKey}`/`{baseUrl}`/`{model}`/`{cwd}` placeholders filled
  from profile + project). One `AcpBridge` (`src/acp-bridge.ts`) per process owns the
  handshake, `session/new`-vs-`session/load`, prompts, config, and the permission and
  elicitation requests the agent blocks on. What reaches the browser is *derived state*: the
  command/event protocol in `src/protocol.ts`, over a WebSocket. The server also owns
  **profiles** (provider config: credentials/models, keys redacted from the API, plus the
  MCP/skill/command links every thread on it gets), **projects** (a cwd and a name — nothing
  linked), the **library** (MCP servers, skills, commands) and **personas** (named by a
  thread, not linked), bearer-token auth, the event log and FCM push. `data/` holds secrets —
  gitignored, never commit.
- **Storage is SQLite via Drizzle** (`server/src/db/`), `data/daedalus.db` via
  better-sqlite3 (synchronous, because `getProfile`/`getAgent`/`listProjects` are called from
  sync spawn paths). Every query goes through the `db` exported by `db/index.ts`, so the
  driver is swappable in one file. **The schema is `db/schema.ts`, pushed — there are no
  migration files** (`pnpm db:push`). Links are join tables with `ON DELETE CASCADE`
  (`profile_*`, `session_*`), so a dangling id cannot exist and nothing filters for one. The
  event log is a table (`session_events`, keyed `(session_id, seq)`) that outlives its
  process, buffered and flushed on the next tick in one transaction; every read and delete
  flushes first. `data/config.json` is the deliberate holdout: bootstrap
  (host/port/token/FCM path), hand-editable, needed before any database exists.
  → `docs/architecture.md`
- `client/` — Vite + React 19 + Tailwind v4 + shadcn (**Base UI, NOT Radix**: compose
  triggers with `render={...}`, not `asChild`; `SelectValue` needs explicit children for
  labels). The browser does **not** speak ACP — the server does. `src/lib/thread-socket.ts`
  is a plain WebSocket speaking `server/src/protocol.ts`; `@agentclientprotocol/sdk` is a
  devDependency, imported type-only. **State has two owners, split by what moves it**: the
  reducer in `src/lib/store.tsx` holds what the *socket* writes (the sessions list and every
  per-thread `ThreadState`), and everything a *route* answers is TanStack Query
  (`src/lib/queries/` — catalog, automations, read surfaces). One owner per slice, nothing
  mirrored between them; writes are mutations that **invalidate** rather than re-read by
  hand, keys are server-scoped through `queries/keys.ts`, and the cache is persisted to
  localStorage per server. Thread-lifecycle side effects stay in `src/lib/actions.ts`.
  Electron shell lives in `client/electron/`. → `docs/client.md`
- `agent/` — **the harness's own ACP agent runtime** ("Daedalus Agent", registry id
  `daedalus`), an agent loop on the Vercel AI SDK (`streamText` + tools), OpenAI-compatible
  chat completions only, spawned as `node agent/dist/index.js`. Configured entirely through
  `DAEDALUS_AGENT_*` env filled from the profile (the literal string `"null"` means unset).
  It implements the full surface the bridge negotiates — session/load replay, session/list,
  steering, permission modes, elicitation, plans, live config, MCP servers, materialized
  commands/skills, personas, compaction, the subagent RFD — and reads the repo's own
  `AGENTS.md`/`CLAUDE.md` on **every turn**. `agent/docs/` is its standalone guide; tests are
  in-process ACP clients over scripted `MockLanguageModelV4`s (`cd agent && pnpm test`).
  → `docs/architecture.md`
- No build-time client config: server URL + token are entered at runtime (localStorage).

## Commands

- Server: `cd server && pnpm dev` (prints token), `pnpm test` (bridge self-check against the
  fake agent: handshake, event log, replay, multi-peer, failure paths). Client:
  `cd client && pnpm dev` / `pnpm build` / `pnpm electron:dev` / `pnpm electron:dist:win`.
- Typecheck: `pnpm exec tsc -b` (client), `pnpm exec tsc --noEmit` (server).
- `tsconfig` uses `erasableSyntaxOnly` — no TS constructor parameter properties.
- eslint currently crashes at startup (typescript-eslint vs typescript 7 — pre-existing).
- **Schema change: edit `server/src/db/schema.ts`, run `pnpm db:push`.** No migration files
  are generated or committed; nothing applies SQL at boot to a database that already has a
  schema. Anything the server reads must be declared in `schema.ts` — a table push does not
  know about is a table push **drops**. The FTS5 index is the exception (`drizzle.config.ts`
  hides `session_events_fts*` via `tablesFilter`; `db/index.ts` creates it `IF NOT EXISTS` on
  every boot). `pnpm db:studio` browses the database.
- **Agents are spawned by their globally installed binary, not through `npx`**
  (`npm install -g @agentclientprotocol/claude-agent-acp @agentclientprotocol/codex-acp`,
  codex-acp **≥ 1.7.0** for subagent sessions) — ~0.4s versus ~3.2s per spawn, and a thread
  spawns on create, on revive and on every profile/model change. Defaults are `DEFAULT_AGENTS`
  (`server/src/registry.ts`); each carries `introduced` and `since` seed versions, and seeding
  backfills fields a release adds but never replaces name/command/args/env — those are the
  user's, and editable through `PUT /api/agents/:id`.
- **Whether an agent is installed is measured, never assumed** (`server/src/agent-status.ts`,
  `GET /api/agents/status`, Settings › Agents): the command is resolved like `spawn` does and
  every absolute path in the args must exist (an unbuilt `agent/dist` reads as not installed,
  not as `node` present); a missing one shows its install line. Versions come from the ACP
  `initialize` answer (`protocolVersion` + `agentInfo`), never a parsed `--version`. In-memory,
  5-minute TTL, evicted on row edit, `?refresh=1` re-measures. → `docs/architecture.md`
- **The server is deployed built, not with tsx.** `pnpm build` → `server/dist/` via
  `tsconfig.build.json` (`tsconfig.json` stays `noEmit` — it is what the editor and tests
  typecheck); `pnpm serve` runs it, `pnpm pm2:start` builds, pushes the schema and starts on
  port **4001** (`DAEDALUS_PORT` in the env, not `data/config.json` — `loadConfig` lets the
  env win for `host`/`port` and only those). One instance, fork mode: the child processes,
  peers and SQLite handle are this process's.
- **The PWA needs https, so dev has `pnpm dev:tunnel`** (Cloudflare quick tunnels over both
  halves — an https page may not open `ws://` to the server). It does not start the server.
  While it runs, both ports are on the public internet behind only the bearer token.
- Detail for all of the above: → `docs/architecture.md`

## Conventions

### Protocol and transport → `docs/protocol.md`

- **The server is the ACP client; the browser is a subscriber.** One `AcpBridge` per agent
  process holds the SDK connection over the child's stdio (nothing else may attach a `data`
  listener to stdout). N browser sockets are peers of the SessionManager, not of the agent.
  Commands carry a per-socket `id` and get exactly one `reply`; events fan out minus the peer
  whose action caused them. Four kinds are journaled and replayed on attach — `update`,
  `session_config`, `turn_started`, `turn_ended` — the rest are live-only. A permission or
  elicitation is **not** journaled: it lives in `bridge.pending` for exactly as long as the
  agent is blocked on it. First answer wins; `settleAll` answers everything when the process
  dies. The server never interprets a `session/update` payload — it forwards them whole.
- **A thread is opened over HTTP, and no socket follows: one is opened by an outgoing
  message and by nothing else.** `GET /api/sessions/:id/replay` answers the same
  `{attached, frames, caughtUp}` bracket the socket sends, folded through the very same
  `handle` switch — one replay, one parser, one set of callbacks. A view-open lands on the
  `read` phase (up to date, deliberately unattached) and `ConnectOpts.revive` is what asks for
  a socket; `ready()` is the one door to a live one. Two exceptions: a read whose `caught_up`
  says `promptActive` attaches, and a command that is not a prompt opens one lazily
  (`ensureSocket`). A dropped socket is reported once with the server's reason, never
  answered by the reconnect ladder — nothing reattaches, or respawns an idle-retired agent,
  behind the reader's back.
- **The ACP SDK is named in one file per half** — `server/src/acp.ts`, `agent/src/acp.ts`,
  and the client's `@daedalus/acp` path onto the server's; import `acp` from there, never
  from the package. `AcpBridge` takes an `acp.Stream`, not a process — `agentStream(proc)`
  is the stdio transport and the caller owns the child. The version is pinned exactly in all
  three manifests and `test:acp-units` asserts the runtime surface. A chat-shaped adapter
  (`@ai-sdk/harness-acp`) cannot replace the SDK behind this seam — → `docs/protocol.md`
  "The SDK seam" for the list of what it drops.
- **Live and replay are one code path.** `attached`/`caught_up` bracket the replay and
  everything between them is the same event the live socket sends, so the client has no second
  parser. `session_config` carries **absolute** state — never make it a delta. Replay start
  has three meanings, stated on `attached` rather than inferred: fresh (0), *resume* (this
  device's own cursor, which must move with every journaled event), *windowed*
  (`REPLAY_WINDOW_STEPS` or `REPLAY_WINDOW_BYTES`, whichever binds first). **Windows and
  `load_earlier` pages are counted in steps (turns), never events**, cut only at journaled
  `turn_started` seqs — and the window applies only when a turn is actually being withheld,
  because a revived log need not begin with one. Frames travel in bulk (`?batch=1`), paced
  against the socket, built from the payload column as text; the client commits one buffered
  `batch` per frame and raises `onReplayProgress` against the `to` `attached` names.
  Everything thread-scoped in the callbacks goes through `send`, never `dispatch`.
- ACP schema is the source for modes/config options/usage — render generically, never
  hardcode per-agent knowledge in the client.
- **The client mints session ids and threads start as drafts.** "New thread" is a route
  change; `POST /api/sessions` is not called — and no agent spawned — until the first message.
  Everything treating the server's list as authoritative must let drafts through.
- **An agent's session id is earned, not announced.** `acp_session_id` is written immediately
  but flagged `acp_session_provisional`; a settled turn or an answering `session/load` proves
  it, and from then on only another *proven* id may replace it. A refused load falls back to
  `session/new` but keeps a proven id and reports it as history lost. **The journal is a cache
  for reading, never a source for resuming** — a revive is always `session/load`, and
  `respawnNow` clears the log before the load refills it.
- **Importing a thread writes a pointer, never a transcript**: rows with `acpSessionId` set
  and no process, so opening one is the existing revive path. Listing is ACP's own
  `session/list`, never a runtime's files.
- **A capability we don't advertise is a feature the agent turns off** — elicitation forms
  (without which Claude Code cannot ask a question at all), codex boolean config options,
  plans, compaction. Questions arrive as `elicitation/create`, not as a permission request;
  narrow with `isFormElicitation`/`isUrlElicitation`, never `mode === "form"`. `decline` is a
  real answer; `cancel` aborts the tool call.
- **ACP has no pause — `session/cancel` throws the step away — so pause is the harness's own
  pair**, `_daedalus/session/pause`/`resume`, advertised by an agent as
  `agentCapabilities._meta["daedalus/pause"]` and taken only by our runtime, which holds at
  its next model step (`Session.gate` in `prepareStep`, subagents included) with nothing
  lost. `session_config.canPause` offers it; `pause`/`resume` commands answer with the
  absolute, live-only `paused` event, stated again on `caught_up`. A cancel clears the pause
  on both ends; a paused session with no turn open holds its next prompt at its first step.
- **Subagents: the store is flat, the transcript is a tree.** Three runtimes say ownership
  three ways; it is resolved in one place (`applySessionUpdate`'s `owner` — `_meta` outranks
  the child session id) and lands as `parentId` on every item, with `lib/transcript-rows.ts`
  building the tree at view time. Consumers reading `thread.items` must ignore `parentId`
  items where the thread's own are meant. **OpenCode's children are read off the side of the
  process, on the server** (`AgentDef.subagentFeed`, `server/src/opencode-subagents.ts`): its
  ACP bridge drops them, so the spawn gets `--port` plus a per-spawn password, the server
  subscribes to the `/event` bus and re-emits each child as an RFD subagent session through
  `agentStream(proc, extra)`. Nothing downstream learns a fourth shape. Retire it when
  sst/opencode#40654 ships.
- The server splices the agent's stderr into errors on the way out
  (`SessionManager.enrichError`); a turn dying with the process is held until the stderr has
  drained. `GET /api/sessions/:id/stderr` exposes the tail. `app.onError` turns every route
  throw into the `{ error }` shape the client parses.
- Test agent: `server/test/fake-agent.mjs` (registered as `fake-echo`) drives the UI without
  credentials — `cd server && pnpm fake:agent` writes its row into the database (there is no
  create route, and it is deliberately not a seeded default). Its samples are **scenes**: an ordinary prompt streams the step rows and the
  subagents, and `scene:<name>` streams one surface alone (`questions`, `other`, `workflow`,
  `all`; a bare `scene:` lists them). `ask:` is a live AskUserQuestion, `plan:` a plan
  approval. The default turn stays small on purpose — a turn is what the replay window is
  measured in.

### Profiles, models, config, personas → `docs/profiles-and-config.md`

- **A profile is a provider, not an agent, and a thread is a (profile, agent) pair.**
  `profiles.agents` is a map keyed by agent id — the key set is the contract (which agents the
  profile can spawn), the value carries an optional per-agent `baseUrl`. The agent is chosen
  at draft time and lives on the session (`sessions.agent_id`); a respawn keeps it.
- **The profile decides who owns the model — and only the model and the effort.** A profile
  with `models[]` overrides them through the env template; a profile with none defers to the
  agent's own `model`/`thought_level` selectors. Every other agent option passes through
  untouched and stays live. The profile's catalog is written out as the agent's catalog where
  one is read (`server/src/model-catalog.ts` → `{codexModelCatalog}`). `{smallModel}` and
  Claude Code's model *aliases* all carry `{model}`, because the CLI switches to them on its
  own and each names a built-in id a gateway does not serve.
- **Being env at spawn does not mean being env forever.** `POST /api/sessions/:id/config` is
  the one door; it answers `{live}` and falls through to respawn when it cannot. Which
  mechanism an agent gets is `AgentDef.liveConfig` (`"acp"` = its own selector, backed by the
  model allowlist materialized into `<cwd>/.claude/settings.local.json`; `"gateway"` = the
  shim's body rewrite). A live change fans out as `spawn_config` — absolute, live-only, not
  journaled. Respawn is **atomic and server-side** (`captureRestoreState`/`applyRestore`),
  never driven from the browser.
- **A message typed into a running turn is queued, not steered — and the queue is the
  server's** (`session_queue`, cascaded, surviving a restart). A `prompt` arriving while
  `bridge.promptActive` is answered `{queued, itemId}`. Steering is explicit
  (`prompt {steer:true}`, ⌘⇧Enter). The `queue` event is absolute and fans out to every peer
  including the origin. A drain combines everything queued into one prompt and only follows a
  turn that ended cleanly; queue edits are answered with no bridge.
- **Claude Code reaches a profile's gateway through the harness's own shim**
  (`server/src/gateway-shim.ts`, `{gatewayUrl}` → `/gw/<key>/s/<sessionId>/<agentId>`), which
  forwards byte for byte and makes exactly one repair: a non-streaming `/messages` reply
  shaped as a chat completion is rewritten into an Anthropic `message`. The key in the path is
  the credential (minted per boot, never stored), like `/ide/<key>/`. `pnpm test:gateway`.
- **A persona is how a thread wants to be worked on, and it goes in through each runtime's
  own door** (`AgentDef.personaVia`: `"acp-meta"` merges over the agent's own system prompt,
  `"env"` fills `{personaPrompt}` — JSON-escaped, only ever correct inside a JSON string — or
  `{personaFile}`, written under `data/persona-prompts/`, never the project cwd). **Nothing is
  pasted in front of the user's message.** Changing it always costs a respawn; a persona's
  effort applies when it is picked and never again.
- **Every agent gets a virtual "Default" profile** (`default:<agentId>`, no credentials and
  deliberately no `models`, which hands model and effort back to the agent), listed first,
  never written to `data/`, uneditable.
- **A draft cannot ask a process that does not exist**: `lib/agent-options.ts` holds each
  (profile, agent) pair's option set, filled by a live session or by a one-shot probe
  (`server/src/probe.ts`) cached in the database keyed `profileId:agentId:cwd`, with an
  in-flight map so two tabs cost one spawn. The probe walks the model list, since which
  options exist can depend on the model. A started thread that has advertised nothing runs the
  same probe. Saving a profile drops the device-local entries and evicts the server cache.

### MCP, skills, commands, workflows → `docs/mcp-and-workflows.md`

- **MCP servers, skills and commands have two owners, and the agent gets the union**: the
  profile links them, the thread picks its own at draft time (and reads them back afterwards
  as a read-out, not a picker). Both are cascading join tables read and written through the
  one descriptor-driven helper `server/src/db/links.ts`. Skills and commands are
  **materialised into the project's cwd**, which every thread of the project shares, so
  `materializeFor` passes the union across every live thread in that cwd — never one thread's
  set alone.
- **The harness's own MCP servers are library rows, not profile toggles** (`BUILTIN_MCP`,
  ids `builtin:web-search` / `builtin:knowledge` / `builtin:workflow`). The row is a handle
  storing no command, env or credentials, resolved at spawn. A tool that cannot answer is not
  advertised at all. Disallowing a runtime's built-in equivalent must travel with an **allow
  rule** for the MCP namespace, or Claude Code's auto-mode classifier reads the MCP call as
  circumvention of the deny rule and blocks it.
- **An HTTP MCP server that demands OAuth is fronted by a second shim, and the child never
  holds the token** (`server/src/mcp-oauth.ts` for the protocol — the SDK's primitives, not
  `auth()`/`OAuthClientProvider`; `mcp-shim.ts` for the credential, at
  `/mx/<key>/<serverId>`). A credential that expires cannot be delivered as a constant header
  fixed at `session/new`. Refreshes are coalesced by an in-flight map; `mcp_servers.auth` is a
  **stored** answer, never a typed one; tokens live in their own cascading `mcp_oauth` table;
  the callback route is unauthenticated by necessity, so **the `state` is the credential**
  (32 random bytes, single-use, ten-minute TTL). `pnpm test:mcp-oauth`.
- **Workflows are the harness's, not an agent's.** A definition is **declarative JSON**
  (`server/src/workflow-schema.ts`) and never a script; phases are sugar desugared at parse
  time into `dependsOn` edges, so `readySteps`, the cycle check and the skip cascade never
  learned what a phase is. **Every step is a real thread** (`sessions.parent_session_id`, not
  a foreign key — cascades are done by hand), created on the parent's own profile, agent,
  model, effort, persona and links. The parent sees it through the RFD's own events; a step's
  cost travels as `_daedalus/subagent_usage`, because `turn_ended` is not mirrored. One level,
  never a tree; the MCP server drives the engine over `/wf/<key>/<sessionId>/…`; nothing
  survives a restart (`recoverAtBoot`). `pnpm test:workflow-schema`, `pnpm test:workflow`.
- **A run pauses as a state, never as a cancel-and-restart** (`WorkflowRunner.pause`,
  status `paused`): no pending step starts, a running step whose child `canPause` is held
  at its step boundary (any other runs to its end and its dependents wait), and both clocks
  are `PausableTimer`s that stand still. Journaled on the parent as
  `_daedalus/workflow_state {runId, paused}` and stamped onto every step's `workflow` by
  the reducer, since a run has no item of its own; the spawn stamp carries the parent
  `sessionId` for the card's `/api/sessions/:id/workflows/:runId/pause|resume`. The agent
  gets `pause_workflow`/`resume_workflow`. A restart ends a paused run as it ends a running one.

### Client and UI → `docs/client.md`

- **A theme is colour plus corner radius, three font roles, a depth and a tracking.**
  Built-ins are **generated** — `client/scripts/gen-themes.mjs` (`pnpm themes`) writes
  `src/styles/themes.css` *and* `src/lib/builtin-themes.ts`; that one table is the only place
  a built-in exists. Three gates run before anything is written: WCAG AA on every
  foreground/surface pair, no two themes sharing a design signature, and every preset value
  and bundled font worn by at least one built-in. Radius steps are **multiples** of
  `--radius`, never offsets, and `--radius-pill` is stated rather than derived.
  `src/lib/theme-ramp.ts` is pure (no DOM) because both the generator and the studio's
  "Generate palette" run it. `src/lib/boot-colors.ts` is the colour before the app exists.
- **Reading a tool call is quarantined in `lib/tools.ts`; drawing one is
  `components/tool-views.tsx`** (over the primitives in `tool-parts.tsx`). No component
  matches on a vendor tool name — `toolViewOf` picks the layout and the matching `extract*`
  supplies the fields, so a new runtime's tool is one file's edit. ACP `kind` decides the
  layout *family* only; the web views match on the tool's **leaf** name.
- **⌘K's root page never asks the server.** The palette is a stack of pages
  (`components/command-palette/`); searching is a destination that owns its own query,
  debounce and abort. Rows are data, not JSX (`rank.ts`), and cmdk's own filter is off so the
  rows that are *about* the query can sit below every row that matches it.
- Device-local state lives in tiny stores: `lib/drafts.ts` and `lib/pins.ts` (per session,
  pruned from `refreshSessions`), `lib/view-options.ts` and `lib/keybindings.ts` (global and
  persisted — how a transcript is drawn is a property of the reader, not of the conversation).
- **Sidebar order and the period a row is filed under are `activityAt` — the last turn, never
  `createdAt`** (`sessions.last_activity_at`, bumped server-side on the journaled
  `turn_started`/`turn_ended`). **Reading is not activity.** Recents puts every running thread
  at the top; Pinned and Recents are shortcuts, not places, so a project folder still holds
  every one of its threads.
- **Everything with a face is drawn by `components/entity-icon.tsx`** — `EntityIcon` plus
  `AgentIcon`/`ProfileIcon`/`ProjectIcon`. No component draws a folder for a project.
- **The composer is `components/composer.tsx`: one card, two rows** — the box, and one
  toolbar where everything that *adds to* the message is behind the "+" menu and everything
  about *how it sends* (queue/steer, Schedule…, the Enter preference in
  `lib/composer-prefs.ts`) is behind the chevron beside a filled Send, also a long-press on
  Send on touch and a right-click on a mouse. Touch targets and the camera follow
  `useCoarsePointer` (the device); what Enter means follows `useIsMobile` (the width).
- **A slash command is either the agent's or the harness's, and the composer draws one
  list**; the agent's catalog shadows the harness's, and a draft thread is offered no harness
  commands. An `@` mention is text in the prompt *and* a `resource_link` beside it, added
  server-side only for a token that resolves to something existing inside the session's cwd.
- **"Mobile" is two questions: width is the panel's, the pointer is the device's.** Layout
  that needs room uses the `@panel-sm:`/`@panel-md:` container queries from
  `components/workspace/panel-container.tsx`; touch targets and viewport-centred surfaces stay
  on media queries. Panel height is published as `--panel-h` (the container is `inline-size`).
- **A key that is bound is a key that is listed** (`lib/shortcuts.ts` +
  `components/shortcuts-help.tsx`) **and a key that can be moved** (`lib/keybindings.ts`,
  keyed by `ShortcutId`, storing only the difference from the defaults). Nothing reads `KEYS`
  to bind — use `useShortcut(id, handler)`; chords are printed by `components/shortcut.tsx`
  and nowhere else. Thread keys are gated on `currentThreadId(location)` because the dock
  keeps every opened transcript mounted.
- **Errors are never `String(err)`** — `lib/errors.ts` normalizes everything into
  `{title, detail}`. A failure that belongs to a thread goes IN that thread
  (`actions.recordError`, which survives reload through the journaled `turn_ended`); a surface
  that has the user's attention holds its own (`captureError` + `components/error-note.tsx`);
  toasts are for failures with no surface to go back to. An error a surface could render as
  *emptiness* must be rendered as an error. Toasts are Base UI's, raised only through
  `lib/toast.ts`, and anything with a visible wait goes through `reportPromise`.
- **The dock holds five panel kinds: chat, editor, terminal, web and review.** The IDE,
  explorer, source-control, output and agents panels are gone from the client (the server's
  `ide.ts`, `ide-proxy.ts` and `git.ts` remain; git is read by the editor's diff mode and by
  the review panel). None of the subagent or workflow machinery was affected.
- **A turn's changes are measured by git, never read off the transcript.** The worktree is
  photographed as a tree object at `turn_started` and `turn_ended` (`git.snapshotTree`, a
  scratch index — the real one is never touched; `server/src/turn-changes.ts`,
  `session_turn_changes`), so a `sed` in a shell and an Edit tool read the same. The summary
  rides the live-only `turn_changes` event and `GET /api/sessions/:id/changes`; hunks are
  read live per scope (`turn:<id>` = its two trees, or start tree → disk while it runs;
  `uncommitted` = HEAD → disk, untracked included). The review panel (`review-panel.tsx`,
  keyed by session, opened from the footer chip) stages, discards and commits through the
  project's existing git routes plus `apply` for one hunk; git's refusal of a stale hunk is
  shown, not smoothed over. A project that is not a repository reads as a sentence.
- A project has a page of its own (`/projects/<id>`): the live half from the store, the
  settled half from one `GET /api/projects/:id/stats`, refetched on mount and by Refresh and
  **never on a timer**. **Turns, not events**, are what is counted, buckets are local-time,
  and a tile skeletons rather than zeroes.

### Tasks → `docs/tasks.md`

- **A board is a project of work, not a kanban**: it owns a `key`, its columns, sprints,
  saved views and custom field definitions (`server/src/boards.ts`); a task's `KEY-n` is
  minted from `boards.next_number` inside the create transaction and backfilled onto
  pre-key rows by `ensureDefaultBoard`. **A column's `category` is what the harness
  knows** — entering a `done` column stamps `completed_at`, leaving one clears it, and
  everything that counts "done" reads the stamp, never the name. `wip_limit` is advisory.
- **The tree is `parent_id`** (an epic's children or a task's subtasks, by the parent's
  `type`), same board only, never a descendant; deleting a parent *detaches*. Every change
  is written to `task_activity` by `updateTask` — history is recorded, not diffed. Sprints
  are `planned → active → closed`, one active per board, and completing one asks where the
  open tasks go, the way a column delete does. **No foreign keys**; every cascade is by hand.
- Client: `lib/tasks-view.ts` is the pure half (filters, grouping, sort, derived facts,
  saved-view ↔ `ViewState`); how a board is *read* is device-local, a *saved* view is the
  server's. Every view takes the one `ViewProps` contract and never touches the cache; the
  open task is `?task=<id>`. `pnpm test:boards`.

### Build mode → `docs/build-mode.md`

- **Build mode is composition, and a template is a directory.** `/build` scaffolds
  `templates/<id>/` (everything but `template.json`, lockfile included) into
  `config.appsDir` (`~/daedalus-apps`), `git init`s it, records a project with
  `devCommand`/`templateId`, and starts the dev server — the harness does it, never
  the agent's first turn. Scaffolding is the **one write outside a project root**
  and follows `plans/project-studio.md`'s rules (absolute existing parent, empty or
  absent target, undo on row failure). Every template honours `PORT` and
  `BASE_PATH` (leading and trailing slash) and ships an `AGENTS.md` saying the dev
  server is the harness's.
- **The dev server is a pinned terminal** (`server/src/dev-server.ts` over
  `terminals.ts`, `role: "dev"|"install"`), one per project, status absolute
  (`DevStatus`, streamed as NDJSON on `/api/projects/:id/dev/events`, never
  persisted client-side). Errors are read off its output as bursts (two blank
  lines or 400ms end a report). **Never kill a dev server by command pattern** —
  this host runs other Vite servers under pm2. Any project with `devCommand` set
  gets a preview, template or not.
- **The preview proxy keeps the prefix and the key is the credential.**
  `/preview/<key>/<projectId>/…` is outside `/api` (an iframe cannot send a bearer),
  key minted per boot and never stored; the app's `base` *is* the prefix, so the
  path is forwarded unchanged (Vite accepts its HMR upgrade only at
  `pathname === base`), `Host` is rewritten to loopback, frame headers dropped.
  Transport lives in `reverse-proxy.ts`, shared with `ide-proxy.ts`. HTML gets the
  bridge script injected (`preview-bridge.ts`); the iframe stays sandboxed
  **without `allow-same-origin`** (same origin as the harness = the token), so the
  bridge speaks only `postMessage` and the panel checks `event.source`.
- **`/build`'s prompt box is the thread composer on a real draft**, persona
  `builtin:app-builder`, project half of the scope row swapped for the stack picker;
  `beforeSend` scaffolds, re-points the draft's project and navigates, then the ordinary
  send materialises it. Never a lookalike textarea.
- **The stack is sensed from the prompt, never defaulted** (`client/src/lib/stack-sense.ts`,
  pure): each starter's `signals` in its manifest score the brief, a stack no starter ships
  (Next.js, Flask, Go…) answers *from scratch*, and an explicit card click outranks both.
  From scratch is `templateId: null` on `POST /api/projects/from-template` → an empty repo
  with the rules file, `templateId: "scratch"` (`SCRATCH_TEMPLATE_ID`, a sentinel no
  `templates/` directory may claim) and **no dev command**. The agent scaffolds the stack;
  at `turn_ended` the manager reads `daedalus.json` (`dev`/`check`/`build`/`install`) then
  `package.json` scripts (`templates.ts › detectDevCommand`), writes the command onto the
  row once, fans out the live-only `project_changed`, and starts the server. A project with
  no template reads its task and install commands the same way.
- The preview panel is the web panel with `viewId: "preview"` on a project: its
  URL comes from `DevStatus.url` at render, never from stored params. Browser and
  terminal errors merge into one strip whose "Fix" sends the bolt-shaped prompt to
  the project's thread; a picked element is appended to the composer draft, not
  sent. A page outside the dock **queues** panels (`lib/workspace/pending-panels.ts`)
  for the shell to open after `openChat`.
- **Every opener names the panel through `previewPanel(projectId)`** and is gated
  on `project.devCommand`. The panel **starts the server on mount, from `off`
  only** — never from `failed`/`exited`. A thread of a *scaffolded* project
  (`templateId` set) opens with its preview beside it, once per thread per page
  load, in the background.
- **Check and build are `DevStatus.task`**: the project's own script in a
  `role: "build"` terminal, one at a time, not tied to the run generation; its
  errors carry `source: "check" | "build"` and take the same Fix. **Auto-fix sends
  an error at most twice** (`AUTO_FIX_ROUNDS`, keyed by `errorSignature`) and only
  to an idle thread; the ledger clears on (re)start.
- **Restore is a new commit with the old tree, never a reset** (`git.ts ›
  restoreTo`: checkpoint anything uncommitted, `read-tree -u --reset`, commit).
  History is `git log --shortstat` in a record-separated format. The persona
  commits after each change in the user's words because each commit is a restore
  point. `pnpm test:history`.
- The bridge also forwards **every console level** (`daedalus:console`, rate-capped)
  and **failed fetches** (kind `network`), takes `daedalus:history`, and a pick
  carries the React **component chain** and an HTML snippet — React 19 has no
  `_debugSource`, so that is how the agent finds the file.

### PWA and notifications → `docs/pwa-and-notifications.md`

- **One service worker (`client/src/sw.ts`), and no Firebase inside it** — the browser kills
  and restarts the worker per event, so only top-level code is guaranteed to have run, and
  this client has no build-time config. Web Push is what the worker reads, so it needs none;
  the page still uses the SDK to mint a token (passed `serviceWorkerRegistration`, on a
  **named** app per Firebase project). Updates are `registerType: "prompt"`: the new worker
  only `skipWaiting()`s on the user's Reload, offered as one pinned toast with a real install
  progress bar. The push payload is therefore a contract: **data-only** messages carrying
  `title`/`body`/`sessionId`, batched at 500, with a one-hour TTL and a hashed `Topic`.
- Registering for push is reversible and the reverse must reach the server
  (`DELETE /api/push/register` + `deleteToken`, the latter skipped when another connected
  server shows the same token). The "already registered" cache re-POSTs weekly.
- `new Notification()` is not available everywhere and push does not cover the gap; both
  paths build their options in `lib/notification-shape.ts`. In the Electron shell the OS layer
  is Electron's own `Notification` over IPC, preferred with **no permission check**.
- **A backgrounded page is not a detached one, and only the page can say which it is**: the
  answerless `background` command sets `Peer.background`, and **only** the turn-end push gate
  reads `watchers(session)` — the fan-out, idle sweep and peer counts still count sockets. It
  is `freeze`/`resume` (Page Lifecycle), not `visibilitychange`.

### Ops: git, backup, quota → `docs/ops.md`

- **A project is a directory, and a directory is not one git repository.** `server/src/git.ts`
  addresses a `RepoContext` (`dir`, `scope`, `path`), never "the project's git"; `fileAt` is
  the one call with no repo, because a file belongs to exactly one worktree.
- **Backup is one JSON document, and import is one transaction** (`server/src/backup.ts`;
  `merge` upserts by id with a non-cascading `ON CONFLICT DO UPDATE`, `replace` empties every
  table first, and the route retires the threads it rewrites then `reload()`s the manager).
  Never exported: the server token/host/port, the probe cache, `history_*` rows.
  `pnpm test:backup`.
- **Subscription quota is read by asking the runtime's own CLI, out of band**
  (`AgentDef.quotaProbe`, `server/src/quota.ts`, naming the plain CLI and never the ACP
  binary). The snapshot is normalized (`QuotaSnapshot` in `protocol.ts`) and the raw text is
  always kept; **"no quota" is an answer, not a failure** — never a zeroed bar. Cached in
  `agent_quota` with a 5-minute TTL, errors included.
- **The other plan is the provider's, and it is read from the profile — which outranks the
  agent's probe** (`profiles.usage`, `server/src/usage-api.ts`). The adapter owns the
  endpoint; `ProfileUsage` never carries a URL, and an unknown `kind` throws rather than
  falling through. That reading is keyed `<profileId>:usage` — one account whatever runtime
  spends it. Settings › Usage is the only surface that lists plans. Adapters: `zai`,
  `minimax`, `kimi`, `synthetic`, `deepseek`, `openrouter`; each is a fold with a fixture in
  `pnpm test:quota`.
- **A profile preset is a starting point, never a stored kind** (`server/src/profile-presets.ts`,
  `GET /api/profile-presets`): a coding plan's per-runtime endpoints, usage reader and
  models.dev catalog, copied into the new-profile form. Nothing about the preset is saved
  on the profile; models are read from models.dev at request time, never listed in the
  preset; the route drops agents this install does not register.

## Testing

- No visual testing: don't drive the UI with Playwright/browser automation or take
  screenshots to check work. Verify with `tsc -b` and reasoning about the code; the user
  checks the UI.

## Where the detail lives

| File | Covers |
| --- | --- |
| `docs/architecture.md` | server, storage, the `agent/` runtime, agent registry/seeding, deploy, schema push, dev tunnel |
| `docs/protocol.md` | ACP bridge, thread open, replay/windowing, session ids, import, capabilities, subagents |
| `docs/profiles-and-config.md` | profiles, models, live reconfiguration, queue, gateway shim, personas, option probe |
| `docs/mcp-and-workflows.md` | built-in MCP rows, the MCP OAuth shim, workflows, link ownership |
| `docs/client.md` | state ownership, theming, palette, sidebar, tool views, shortcuts, errors, toasts, dock, project page |
| `docs/pwa-and-notifications.md` | service worker, FCM, notification shape, backgrounded pages |
| `docs/tasks.md` | the task workspace: boards, keys, columns and categories, the parent tree, activity, sprints, links, custom fields, views |
| `docs/build-mode.md` | templates, scaffolding, the managed dev server, the preview proxy and bridge, the build flow |
| `docs/ops.md` | git, backup/import, agent quota, provider plan usage |
