# Daedalus Harness

Generic ACP (Agent Client Protocol) harness. Four parts, one repo.

This file is the **rules only**, kept short because it is read on every turn. The mechanism
and the reasoning — the failure each rule was written for — live in `docs/`, linked per
section. **Read the linked file before changing the behaviour a rule describes**; every one
of them cost a bug. `CLAUDE.md` is a symlink to this file.

## The four parts → `docs/architecture.md`

- **`server/` is the ACP client** (Node 22 + Hono + ws): one agent process per thread, one
  `AcpBridge` (`src/acp-bridge.ts`) per process, derived state to the browser over a
  WebSocket (`src/protocol.ts`). It owns profiles (provider config + the MCP/skill/command
  links its threads get), projects (a cwd and a name — nothing linked), the library, personas,
  bearer auth, the event log and FCM push. `data/` holds secrets — gitignored, never commit.
- **Storage is SQLite via Drizzle** (`server/src/db/`), better-sqlite3, synchronous because
  spawn paths are. Every query goes through the `db` exported by `db/index.ts`. Links are join
  tables with `ON DELETE CASCADE`, so a dangling id cannot exist and nothing filters for one.
  `data/config.json` is the deliberate holdout: bootstrap only, needed before any database.
- **`client/`** — Vite + React 19 + Tailwind v4 + shadcn on **Base UI, NOT Radix**: compose
  triggers with `render={...}` not `asChild`; `SelectValue` needs explicit children. **The
  browser does not speak ACP** — `src/lib/thread-socket.ts` is a plain WebSocket and
  `@agentclientprotocol/sdk` is a devDependency, imported type-only.
- **`agent/` is the harness's own ACP runtime** (id `daedalus`): a loop on the Vercel AI SDK,
  OpenAI-compatible chat completions only, configured entirely through `DAEDALUS_AGENT_*` env
  from the profile (the literal `"null"` means unset). It reads the repo's
  `AGENT.md`/`AGENTS.md`/`CLAUDE.md` on **every turn**. Its own guide is `agent/docs/`.
- **No build-time client config**: server URL and token are entered at runtime.

## Commands

- Server `cd server && pnpm dev` (prints token) / `pnpm test`. Client `cd client && pnpm dev`
  / `build` / `electron:dev` / `electron:dist:win`. Agent `cd agent && pnpm test`.
- Typecheck `pnpm exec tsc -b` (client), `pnpm exec tsc --noEmit` (server).
- `tsconfig` uses `erasableSyntaxOnly` — no TS constructor parameter properties.
- eslint crashes at startup (typescript-eslint vs typescript 7 — pre-existing).
- **Schema change: edit `server/src/db/schema.ts`, run `pnpm db:push`.** No migration files
  exist. **A table push does not know about is a table push drops** — anything the server
  reads must be declared there. The FTS5 index is the one exception.
- **Agents spawn by their globally installed binary, never `npx`** (~0.4s vs ~3.2s, and a
  thread spawns on create, revive and every profile/model change). codex-acp **≥ 1.7.0**.
  Seeding backfills new fields but **never** replaces name/command/args/env — those are the
  user's, and so are `install`/`icon` (descriptive, not protocol).
- **What the harness believes about a runtime is a column on its row, never a comparison
  against its id.** `spawnCategories`, `liveConfig`, `quotaProbe`, `personaVia`,
  `subagentFeed`, `rewindVia`, `workflowsVia`, `workspaceLayout`, `builtinTools`,
  `catalogProbe`, `discovery`, `install`, `icon` — a user who repoints `command` at a fork
  repoints these with it, and nothing outside `registry.ts` spells a vendor's tool name,
  config path, install line or id.
- **Whether an agent is installed is measured, never assumed** (`server/src/agent-status.ts`),
  and versions come from the ACP `initialize` answer, never a parsed `--version`.
- **Deployed built, not with tsx**: `pnpm pm2:start` builds, pushes the schema and starts on
  port **4001** from `DAEDALUS_PORT` (env wins over `data/config.json` for `host`/`port` and
  only those). One instance, fork mode.
- **The PWA needs https, so dev has `pnpm dev:tunnel`.** It does not start the server, and
  while it runs both ports are public behind only the bearer token.

## Protocol and transport → `docs/protocol.md`

- **The server is the ACP client; the browser is a subscriber.** Nothing but the bridge may
  attach a `data` listener to the child's stdout. Commands get exactly one `reply`; events fan
  out minus the peer that caused them. **The server never interprets a `session/update`.**
- **Four kinds are journaled and replayed** — `update`, `session_config`, `turn_started`,
  `turn_ended`; the rest are live-only. **A permission or elicitation is never journaled** —
  it lives in `bridge.pending` while the agent blocks. First answer wins.
- **State is handed over on `caught_up`; only history is replayed.** The queue, the hold and
  a staged change are not journaled — and **the context reading is journaled and still not
  the replay's to decide**: a window may hold no `usage_update` and a `load_earlier` page
  holds older ones. The newest is the row's (`sessions.context`), said after the replay.
- **A thread is opened over HTTP, and a socket is opened by an outgoing message and by
  nothing else.** Replay and the socket are one code path through the same `handle` switch —
  one parser, one set of callbacks. `ready()` is the one door to a live socket. **A dropped
  socket reattaches on its own, and never respawns**: a close that says nothing about the
  thread (no code, 1006, the client's own watchdog) books the ladder, which asks for the
  thread *as it is* — a live process gets its socket, a retired one is read from its
  journal. Only a send or the button puts a process back. The four codes that mean the
  thread is gone or taken over (4000/4001/4002/4004) are still said once, with a button.
- **A run of streamed chunks is replayed as the one event it draws, and the merge is a
  read** (`coalescedPage`) — never an append, because a cursor resuming *inside* a run has
  to be answerable, and it is only answerable from rows nothing merged. The merged event
  stands at its run's **last** seq. Downstream of it, what spans the log is counted in seqs
  and never in events: `EarlierPage.from`, and the replay's progress.
- **A restart keeps the journal and drops the load's narration, not the other way round**
  (`restart.kept`): the clear is what made a setting change cost every peer a rebuild, and it
  took the turn boundaries `rewindPoint`, the turn rail and every window are read from with
  it. Kept only where the log is *holding* this conversation — live process, non-empty log,
  no respawn queued — never for a rewind (clearing IS its truncation), and taken back by a
  `historyLost`. Where it is not kept the old bargain stands: **while a restart runs the
  doomed socket's events are dropped** — a cleared journal being refilled is the transcript
  already on screen, said again — and **a replay that replaces a transcript commits once,
  not per frame** (`seamless`).
- **The ACP SDK is named in one file per half** — `server/src/acp.ts`, `agent/src/acp.ts`,
  the client's `@daedalus/acp`. Import `acp` from there, never from the package. The version
  is pinned exactly in all three manifests.
- **`session_config` is absolute — never make it a delta.** Replay start is *stated* on
  `attached`, never inferred. **Windows and `load_earlier` pages are counted in steps
  (turns), never events** — and a window opens at a turn boundary, so the gap above it comes
  too, along with **every `!` command**: a shell row belongs to no turn, and one the reader ran
  can never be something the replay withholds. Thread-scoped callbacks go through `send`, never
  `dispatch`.
- **ACP schema is the source for modes, config options and usage** — render generically,
  never hardcode per-agent knowledge in the client.
- **The client mints session ids and threads start as drafts**: no row and no agent until the
  first message, so anything treating the server's list as authoritative must let drafts
  through — including the boot prune, which is why the row is persisted per device and
  re-minted before it runs (`lib/draft-sessions.ts`).
- **An agent's session id is earned, not announced** (`acp_session_provisional`): only a
  *proven* id may replace a proven one. **The journal is a cache for reading, never a source
  for resuming** — a revive is always `session/load`.
- **Importing a thread writes a pointer, never a transcript.** Listing is ACP's
  `session/list`, never a runtime's files.
- **A capability we don't advertise is a feature the agent turns off.** Questions arrive as
  `elicitation/create`, not permission requests; narrow with
  `isFormElicitation`/`isUrlElicitation`, never `mode === "form"`.
- **ACP has no pause, so pause is the harness's own pair** (`_daedalus/session/pause`), taken
  only by our runtime, which holds at its next model step with nothing lost. A cancel clears
  the pause on both ends.
- **A failed turn is held at that same boundary, not ended** — the second reason the loop
  waits, and the same wait. **Any** failure holds, not a chosen list: an error part, a thrown
  call, and the finish reasons that mean the step did not do what was asked (`error`,
  `content-filter`, `length` — the first of which used to be reported as a clean `end_turn`).
  **A failed tool call is not one of them**: it goes back to the model, which is what it is
  for. It keeps every settled step, tells the harness why
  (`_daedalus/session/paused`, the pair's one agent→client direction), and waits for a model
  change and a resume. **A held turn is still `turnActive`**: no `turn_ended`, no error row,
  and `reason: "error"` on the absolute `paused` event is a state to draw, never a failure to
  record. **A thread with nobody in front of it never holds** (`DAEDALUS_AGENT_HOLD_ON_ERROR`,
  off for a workflow step or a scheduled run), because `whenTurnSettled` would wait forever.
  Subagents never hold: theirs would re-run every tool it already ran.
- **A retry is said, not just logged** (`_daedalus/session/retry`): announced *before* the
  backoff, because the backoff is the silence it explains, and absolute and live-only like the
  hold — `caught_up` carries it, nothing journals it, and it is taken back before a `paused`
  goes out in its place. The count is **the harness's** retries; the AI SDK's own are inside
  one `streamText` call and reporting those means owning the policy (`maxRetries: 0`).
- **A failed attempt persists nothing it did not finish.** The JSONL is append-only, so the
  write is what is delayed — down to the last step whose tool calls all came back. An
  assistant message carrying a call with no result is what the next `session/load` hands back
  to a provider that rejects it.
- **Subagents: the store is flat, the transcript is a tree.** Ownership is resolved in one
  place and lands as `parentId`; consumers reading `thread.items` must ignore `parentId`
  items where the thread's own are meant. OpenCode's children are read off the side of the
  process, server-side — nothing downstream learns a fourth shape.
- Agent stderr is spliced into errors on the way out; every route throw becomes the
  `{ error }` shape the client parses.
- **Test agent** `server/test/fake-agent.mjs` (`fake-echo`) drives the UI without credentials
  (`pnpm fake:agent` writes its row). Samples are scenes; the default turn stays small,
  because a turn is what the replay window is measured in.

## Profiles, models, config, personas → `docs/profiles-and-config.md`

- **A profile is a provider, not an agent; a thread is a (profile, agent) pair.** The agent is
  chosen at draft time, lives on `sessions.agent_id`, and survives a respawn.
- **The profile decides who owns the model — and only the model and the effort.** Every other
  agent option passes through untouched and stays live.
- **Being env at spawn does not mean being env forever.** `POST /api/sessions/:id/config` is
  the one door; it answers `{live}` and falls through to respawn when it cannot. **Respawn is
  atomic and server-side**, never driven from the browser.
- **A change that costs the process is staged when it is picked, and the next spawn takes
  it** — held in `session.stagedConfig`, fanned as the absolute live-only `staged_config`.
  **Two mechanisms, no third and no timer**: `respawnNow` *folds* the patch into any spawn
  that happens anyway (the revive behind a send, a rewind, the restart route) as a value
  substitution — never by re-entering `applyConfig`, which recurses into a second spawn — and
  `flushStagedNow` takes it outright, from the two doors a turn can start at: `prompt`, and
  `resumeTurn` (Continue on a held turn, which is the hold's own promise — it waits for a
  model change and a resume).
  A **queue drain never flushes** (it calls `startTurn` directly) and neither does a **steer**
  (`!promptActive` is the test), so the old `continued` rule survives: no restart between two
  messages the user sent together — **except into a held turn** (`|| paused`), where the flush
  is the whole point: the "never staged onto a hold" guard below reads the hold at *pick* time,
  so a pick made during the retry window would otherwise be stranded behind a steer. Never
  staged: `defer:false`, a **held** turn (stopped
  *waiting* for the change), and an **agent** change — a different runtime, whose `session/load`
  would name an id in the *old* one's store. **A flush that fails re-stages and refuses to
  send**; a patch whose profile went stale is dropped with a notice, never thrown inside a
  prompt. There is no `turn_ended` flush: a turn ending is not a reason to respawn for a user
  who is still reading.
- **The route answers the decision, not the restart.** `{restarting:true}`, and the sequence
  reports itself as `restart` started/ready/failed to **every** peer — a device that was not
  holding the menu used to fold the reload's re-narration in as news. Answering early is
  conditional on the caller saying it can hear those events (`follow`).
- **A pick is drawn before it lands, as an overlay and never as a patch of the row**
  (`ThreadState.pendingConfig`, read through `configView`): the row is the server's and a
  list refresh replaces it. **Picks coalesce** — one request per menu, not per row.
- **Nothing about these settings asks before it acts.** They are reversible, and the undo is
  on the toast a restart raises, not a dialog in front of a menu row.
- **A setting a person changed is said in the transcript, and `origin` is what says a person
  changed it.** One emitter per door — `applyConfig` diffs a *reading* per setting taken
  before and after (never the request: a menu sends model and effort on every call), and the
  agent's own selectors write theirs in `setMode`/`setConfigOption`, gated on the peer that
  asked so a restore never narrates its own bookkeeping. Idle or mid-turn, live or respawn,
  the row is the same; only *when* it lands differs, because a running turn holds it for its
  step boundary. Reporting all of them is safe because `showConfigNotices` can hide them —
  the reader picks, not the server.
- **A setting survives a change to a different one.** A restart copies the agent's selectors
  off the live process (`captureRestoreState`), and a revive that has no process to copy from
  replays them from `sessions.config_choices` — the same row-shaped bargain `mode_id` makes,
  and the reason an idle-retired thread no longer comes back on the agent's defaults. Model
  and effort keep their own columns; a value written twice can disagree with itself.
- **A message typed into a running turn is queued, not steered — and the queue is the
  server's.** Steering is explicit (`prompt {steer:true}`, ⌘⇧Enter). The `queue` event is
  absolute and reaches every peer including the origin.
- **Escape stops the turn and takes back the message that has not landed** (`cancel
  {reclaim:true}`), newest first and one only, back into an empty composer. Atomic and
  server-side, and **the take-back comes before the cancel**: a settle is a step boundary, and
  `flushSteers` would draw the held steer's bubble. A queued row never left the server; a held
  steer is unwound only while it is still held (`takeSteer`) — **past its boundary nothing
  comes back**, which is never a reason to reach for an older message. Opt-in, because the
  message leaves the queue: only a caller with somewhere to put the words may ask.
- **Claude Code reaches a profile's gateway through the harness's own shim**
  (`server/src/gateway-shim.ts`), which forwards byte for byte and makes exactly one repair.
  **The key in the path is the credential** — minted per boot, never stored.
- **A persona goes in through each runtime's own door** (`AgentDef.personaVia`); **nothing is
  pasted in front of the user's message**. Changing it always costs a respawn.
- **Rules are the layer above personas** (`server/src/rules.ts`): one global block plus one per
  project, composed and folded into every spawn **beneath** the persona through the same doors.
  Spawn-time like a persona — a change costs a respawn — and backup carries them upsert-per-key.
- **Every agent gets a virtual "Default" profile** (`default:<agentId>`) with no credentials
  and deliberately no models. Never written to `data/`, uneditable.
- **A draft cannot ask a process that does not exist**: option sets come from a live session
  or a cached one-shot probe, coalesced so two tabs cost one spawn.

## MCP, skills, commands, workflows → `docs/mcp-and-workflows.md`

- **MCP servers, skills and commands have two owners and the agent gets the union** (profile
  links, thread picks). All link tables go through the one helper `server/src/db/links.ts`.
- **Skills and commands are materialised into the directory the runtime declares**
  (`AgentDef.workspaceLayout`), inside the project's cwd every thread of the project shares —
  pass the union across every live thread in that cwd **that shares the layout**, never one
  thread's. A runtime that declares none (codex, which resolves both only under
  `$CODEX_HOME`) is written nothing, and the link pickers say so rather than going quiet.
  The cwd itself is made deliberately (`ensureProjectDir`), not as a side effect of a mkdir.
- **The harness's own MCP servers are library rows, not profile toggles** (`BUILTIN_MCP`); a
  tool that cannot answer is not advertised at all. **Disallowing a runtime's built-in
  equivalent must travel with an allow rule for the MCP namespace**, or Claude Code's
  auto-mode classifier reads the MCP call as circumvention and blocks it. **Which tools those
  are, and the door that closes them, are the agent row's** (`builtinTools`) — the bridge
  spells no tool name.
- **An HTTP MCP server that demands OAuth is fronted by a second shim, and the child never
  holds the token.** `mcp_servers.auth` is a **stored** answer, never a typed one; the
  callback route is unauthenticated by necessity, so **the `state` is the credential**.
- **Workflows are the harness's, except where the runtime says it has its own**
  (`AgentDef.workflowsVia === "native"` — Claude Code: linking ours disallows its better one,
  so ours is not offered). A definition is **declarative JSON**, never a script. **Every step is a real thread** on the parent's own profile, agent, model,
  effort, persona and links. One level, never a tree. Nothing survives a restart.
- **A run pauses as a state, never as a cancel-and-restart**, and its clocks stand still. A
  restart ends a paused run as it ends a running one.

## Client and UI → `docs/client.md`

- **State has two owners, split by what moves it**: the reducer in `src/lib/store.tsx` holds
  what the *socket* writes; everything a *route* answers is TanStack Query
  (`src/lib/queries/`). One owner per slice, nothing mirrored; writes **invalidate** rather
  than re-read by hand. Thread-lifecycle side effects stay in `src/lib/actions.ts`.
- **Built-in themes are generated** — `pnpm themes` writes both the CSS and
  `src/lib/builtin-themes.ts`, and that table is the only place a built-in exists. Three
  gates run first (WCAG AA, no duplicate design signature, every preset value and font used).
  Radius steps are **multiples** of `--radius`, never offsets.
- **Reading a tool call is `lib/tools/`; drawing one is `components/tool-views/`.** **No
  component matches on a vendor tool name** — a new runtime's tool is one file's edit. ACP
  `kind` decides the layout family only; web views match the tool's **leaf** name. A vendor's
  `_meta` namespace is named once, in `lib/tools/helpers.ts` (`vendorMeta`); the readers know
  the shape, never the key.
- **A fenced `openui-lang` block is a generated view, and it is inert.** The model writes a program
  in `openui-lang` (`@openuidev/react-lang`) and the client draws the UI it describes —
  splitting the message and handing each prose run to `Prose` is what turns the fence
  (`ProseWithOpenui` in `tool-parts.tsx`; **every** run of agent prose goes through it, not
  just the tail of one that also carries an insight or plan block), and the
  parser, the library and recharts ride the lazy `components/openui-view.tsx` chunk, so a
  transcript that never holds a fence never pays for any of it. **Nothing it writes can act**:
  no `toolProvider` is passed, so a `Query()`/`Mutation()` is dropped rather than run, and the
  prompt carries `bindings:false`/`toolCalls:false` so a form is never offered — a generated
  view composes what the model already knows, and every tool call stays an ACP one with a
  permission in front of it. **An unclosed fence draws too, from the moment it opens** — the
  language puts `root` first and resolves forward references as their statements arrive, so a
  program fills in over the answer rather than appearing at the end; what that demands is that
  the drawing be forgiving, so the "came out empty" fallback is suspended while the row is
  still being written (a one-line program is legitimately an empty shell). A fence that will
  not parse falls back to the source, and the components are the harness's own (`Notice`, `Empty`,
  `harness-table`, the `--chart-*` tokens) in `lib/openui/library.tsx` — the component table,
  which is one file's edit. **The prompt is generated from that table, never hand-written**:
  `pnpm openui` in client/ runs `scripts/gen-openui.mjs` (the library's own prompt generator,
  under Node) into `agent/src/openui-prompt.ts`, and `pnpm openui:check` is the drift gate —
  so the text the model is told and the components the reader gets cannot disagree. Adding a
  component is the library edit and one regeneration. **A generated view reflows on the panel's
  width, not the window's** — the components carry `@panel-sm:` variants (`StatRow` falls two-up,
  `KeyValue` stacks key over value, the chart's tick gutters shrink), because the one thing the
  model cannot control is how wide the box it lands in is. The lane is written for a thread with a
  **reader**: a subagent's answer is a report to its caller, and an unattended run
  (`holdOnError` off, the workflow-step and scheduled-run case) wants prose it can grep.
  **The toggle governs the asking, never the drawing** (`sessions.ui_blocks`, "Draw answers as
  UI"): off, the model is not told the lane exists — and a fence that arrives anyway, whether
  the user typed it or the toggle was flipped back on mid-thread, still renders, because the
  renderer reads no switch. That is what makes a mid-thread flip change nothing already on
  screen.
- **⌘K's root page never asks the server**; searching is a destination owning its own query,
  debounce and abort. Rows are data, not JSX, and cmdk's own filter is off.
- Device-local state lives in tiny stores (`lib/drafts.ts`, `lib/view-options.ts`,
  `lib/keybindings.ts`) — how a transcript is drawn is the reader's property, not the
  conversation's. **A pin is not one of them**: it is a fact about the thread
  (`sessions.pinned_at`, `PATCH /api/sessions/:id {pinned}`), so it follows the thread to
  every device, and its timestamp is the order the pinned group is drawn in.
- **"New thread" always creates a thread**: every door — ⌘N, the sidebar row, the strip's `+`,
  the palette, a project's own `+`, the app shortcut — mints a draft through the one
  `actions.startThreadIn` and opens it as a tab of its own, so pressing it twice is two
  threads. The landing console is where the dock lands when the last tab closes, not a stop on
  the way to starting something; only the project page's queued terminal/IDE still opens a
  draft behind its own gesture. **No list draws a draft** — `isListed`, not `isTopLevel`, is
  what the sidebar, Recents, the project page, the palette and the schedule form filter by.
  **A draft's tab survives a reload** (`lib/draft-sessions.ts`): the row is persisted per
  server and re-minted on boot only for the tabs the saved layout still names, so a closed tab
  stays closed and a sent thread comes from the server. **It takes the caret itself** — a
  draft's composer is focused when it is the routed thread or when the caller says so
  (`autoFocus`, which is the console's, whose route is `/`); never on touch.
- **Every route is a tab, and the dock is the main area on every route.** A thread is a
  `chat` panel; everything else — settings, a project's page, the inbox, schedules, routines,
  the board route, a trace, the landing console — is a `page` panel whose descriptor is its
  path, rendered through the app's one route table against *that* path
  (`workspace/page-panel.tsx`, `<Routes location>`). **The URL points the tab, and focusing a
  tab writes the URL** — the same pair chats had, with `location.key` in the deps so a sidebar
  row for a tab just closed opens it again. **A page is a place you visit, not a thing you
  keep, so the dock holds one browsing tab** (`openPage`): a tab already standing for the
  place (`pageKey` — every settings section is one tab whose path moves, a project's page and
  a trace are places of their own) is pointed at the new path, else the *unpinned* page tab is
  repointed, else one opens beside what you are looking at. **A pin is how a page is kept** —
  a pinned page tab is never repointed to another place. A tab per place was the first
  version, and reading settings, then the schedules, then a project left three tabs beside a
  chat none of them were about. Inside a page tab `--app-header-h` is the measured overlap,
  so no route pads for a header that is not over it; the title is written forward only,
  never "Page". The tab wears the mark its sidebar row wears (`PageIcon`).
- **The console is spent by the thread it starts** (`consumeConsole`, on the chat route effect,
  asked *before* the chat opens because opening it is what makes it the active panel, and only
  for a routed draft — the console mints one and navigates to it before sending, so it can
  never spend a page tab you are merely reading). Closing the last tab lands on it.
- **Opening a thread opens a tab, never replacing the one you were reading** — `newTab` at
  both doors (the route effects *and* `handleDockReady`, which can run after them). An open
  thread is focused, not duplicated. **A tab's title is
  only written forward**: dockview serializes titles, so a chat with no session row yet keeps
  the restored one rather than being renamed to the placeholder.
- **Sidebar order and the period a row is filed under are `activityAt` — the last turn, never
  `createdAt`. Reading is not activity.** Pinned and Recents are shortcuts, not places.
- **Everything with a face is drawn by `components/entity-icon.tsx`.** No component draws a
  folder for a project, and **an agent's mark is the server's** (`AgentDef.icon`, `"app"` =
  the harness's own) — the client holds no table of which runtimes exist. A **kind** wears the
  kind's glyph (`PANEL_ICONS`, for the menu that opens one); an **open panel** wears
  `PanelIcon`, and a chat's is its thread's agent — four threads used to be four identical
  speech bubbles.
- **The composer is `components/composer.tsx`: one card, two rows** — what *adds to* the
  message behind "+", what governs *how it sends* behind the chevron beside Send. Touch
  targets follow `useCoarsePointer` (the device); what Enter means follows `useIsMobile`
  (the width).
- **The composer is one width, and it does not move.** Narrowing it while unfocused and
  giving the width back on `:focus-within` was tried and removed: every box in the unit —
  the shelf, the card, the notices, the scope row — measures against
  `--harness-composer-width`, so the whole unit breathes on every click in and out of the
  textarea, which is motion the reader did not ask for at the exact moment they are aiming
  at something.
- **The shelf has a surface of its own** (`--shelf`, `bg-shelf`), derived from `--composer`
  and **darker than it in both modes — which is two declarations, not one**: darker is toward
  the foreground in a light palette and toward the *background* in a dark one, where
  `--composer` is already the lighter of the two tones. It wore `--surface`, which is the
  *page's* ground and resolves to the same thing `--composer` does in a light palette, so the
  shelf, the composer and the page were one flat band with an invisible tuck between them.
  Derived, never picked, so every generated palette gets it for nothing. **Neither the composer
  nor the shelf draws a hairline ring** — the two grounds meeting is the seam, and the
  composer's only ring is the destructive one while voice is listening.
- **The shelf has a floor and a pile, and the floor is what is permanently true.** Project,
  tools and the context ring are `ComposerStrip`'s `footer` (`DraftScopeRow`) — always drawn,
  never a card, on **both** sides of the first message: a started thread's project only stops
  being *editable*, it never stops being *said*, and the tab does not repeat it. It wears the
  shelf's `--shelf`, never the composer's `--composer`: the strip and the box below it are two
  surfaces, and giving the floor the composer's ground made them one flat band.
  **The tuck is worn by whoever is last** — the footer when there is one, the cards when there
  is not, never both. **A tools menu's side is the caller's, never inferred from `editable`.**
- **The pile is only what is about the message being typed** — attachments, parked pastes, the
  history notice, the two completers, the archive notice.
- **A reading of the thread is a 24px trigger over a popover, in the footer's end cluster** —
  the checklist's progress, the running-subagent count, what the last turn wrote, the context
  ring (`TodoIndicator`, `AgentsIndicator`, `ChangesIndicator`, `ContextIndicator`). One kind
  of question, one shape, one place; each
  draws nothing when it has nothing to say. A popover is a fixed surface, so those lists scroll
  without taking room from the transcript. **A floating summary pill over the composer was
  tried and removed** — see `docs/client.md`.
- **The queue is drawn as the user messages it is**, dashed, at the very **end** of the flow —
  after the approval and the question, because a queued message is the conversation's future.
  **Editing one takes it back to the composer** (`queueRemove`, then `fill`, and only on
  success): there is no second editor in the transcript, and cancelling is the same gesture.
  **A scroller item that renders nothing still reserves its intrinsic size**, so the caller
  gates (`thread.queue.length`) and the component only draws.
- **A slash command is either the agent's or the harness's and the composer draws one list**;
  the agent's shadows the harness's, and a draft is offered no harness commands. An `@`
  mention is text *and* a `resource_link`, added server-side for any `~`/absolute/relative
  path that exists — the scope is the person's, never only the cwd.
  A `!` line is a **shell command and the composer's third completer**: the project's helpers
  are suggested, picking one fills its *command* into the box, and the send path *consumes* the
  line rather than prompting (`shellLineFor`) so it never reaches the agent. It runs on the
  server against the project, and the result is **journaled as a `_daedalus/shell` row** — two
  updates, `running` then `done`, under one caller-minted `shellId` — part of the transcript,
  replayed on reload, no turn and no prompt; the one route that takes a command up from the
  browser (`POST /api/sessions/:id/shell`). A line that IS a saved helper's command runs as that
  helper (its cwd and env); anything else runs as itself. It draws as a **Bash step** — the same
  icon, heading rule (`toolHeading`) and `ShellPane` as an `execute` tool call, open by default
  and from the moment it starts — because that is what it is; only the agent's absence differs.
- **Every surface a caret can land in clears the soft keyboard.** The page does not resize
  when one opens (`overlays-content`), so a fixed surface at the bottom is a surface
  *behind* the keys. Ride it with a named recipe from `lib/keyboard-inset.ts` —
  `KEYBOARD_LIFT`, `KEYBOARD_CENTER`, `KEYBOARD_RISE`, `cn`'d last — never a fresh calc. A
  Base UI positioner is **padded, not moved** (`useKeyboardCollisionPadding`), and only
  where the visual viewport did not already shrink, or a flyout rises by two keyboards. A
  field on an ordinary form is `lib/keyboard-caret.ts`'s, because the browser's own
  scroll-into-view is the thing `overlays-content` turned off.
- **"Mobile" is two questions: width is the panel's, the pointer is the device's.** Layout
  uses the `@panel-*` container queries; touch targets and centred surfaces stay on media
  queries.
- **A key that is bound is a key that is listed and a key that can be moved.** Nothing reads
  `KEYS` to bind — use `useShortcut(id, handler)`; chords print through
  `components/shortcut.tsx` and nowhere else.
- **A restart the user asked for is not a thread coming back from the dead**, and the wait
  says which (`ConnPhase.reviving.because`): one paragraph explaining idle-retirement used to
  be shown to someone who had just picked a persona. **A wait in front of a transcript that
  is staying put is not drawn until it lasts** (`waitDelayMs`) — a respawn usually beats it,
  and a headline plus a paragraph that appears and vanishes is flicker announcing a wait
  nobody waited for. The gate is the caller's, because a scroller item that renders nothing
  still reserves its size.
- **Errors are never `String(err)`** — normalize through `lib/errors.ts`. A failure belonging
  to a thread goes IN that thread; a surface with the user's attention holds its own; toasts
  are for failures with no surface to go back to. **An error a surface could render as
  emptiness must be rendered as an error.** Toasts only through `lib/toast.ts`.
- **Every drawn error carries a Copy, and it is never gated on having a detail** — a failure
  with only a headline is the one with the *least* to select by hand, having no well under it
  to open. `components/ui/copy-button.tsx` is the one button, and its tick is the feedback, not
  a toast: these sit *inside* the thing that failed, where a toast about a copy competes with
  the failure being read and on a dialog lands behind it. A failed **tool call** gets its copy
  from `CodeBlock`, the one place all four `SmartBlock tone="error"` call sites land.
- **The dock holds six panel kinds: chat, ide, terminal, web, tasks, page**, and **Monaco is the
  text surface and the diff and nothing else** — the official `monaco-editor`, so there is no
  workbench and no "initialize once per page" rule.
- **Source control starts from `GET …/git/repos`, never from "the project's git"**: a section
  per repository, and every read and write names its `repo`. **Status paths are
  repository-relative** — `projectPath(repo, path)` is the one join back to the file routes.
  **A comparison names both its sides**, never just the left: a staged row is HEAD ↔ index and
  an unstaged one index ↔ worktree, or staging shows edits made after it. **Branches, stashes
  and the log are read when asked for** — the branch list on the menu's open, the two sections
  on their first expand — never with the status, which the watch stream re-reads.
- **Monaco's workers are wired by `?worker` import, never by path**, and
  `MonacoEnvironment.getWorker` answers for **every** label while `getWorkerUrl` is never
  defined — a `?worker` import makes a stale path a build error instead of a blank editor.
  **A worker entry is the module that installs `self.onmessage`** (`editor.worker.js`), never
  the library beside it that only exports `start` (`editor.worker.start.js`): pointed at the
  latter the worker boots, answers nothing, and every worker-backed feature dies quietly —
  the visible one being the diff, which drew both files whole with nothing marked changed.
- **A tab is one slab, rounded on all four sides** (`.dock-tab`, `index.css`), and
  **every tab has a ground** — three weights of one material: the tab you are on, the one you
  are pointing at, the rest. A surface that only appears on click reads as the selection
  rather than as the shape a tab has. (A browser's shape — top-rounded, flared into the panel
  — was tried and removed: the flare only reads against a filled toolbar, and everything under
  these tabs is transparent by design.) It carries the **panel's own mark** (`PanelIcon` — a
  chat's is its agent's), its title, its **reading** (`PanelStatusDot`), and the ⋮ and
  close, **both of which appear on hover or focus** (always where there is no pointer, and the
  ⋮ holds itself visible while its menu is open) — **not** the thread's context reading, which
  the composer's footer says once. The ⋮ and the right-click menu render one `items` array, so
  they cannot drift. Sizing is a browser's — one width whether it is alone or one of nine, so
  **no `singleTabMode`** — but wider than a browser's, because a thread is named after what it
  is doing, and the emptiness beside a lone tab is the void container's to drag the window by.
  **That width is a `width`, never a `flex-basis`**: reordering is dockview's own
  (`theme.tabAnimation: "smooth"` — the dragged tab collapses, the strip slides apart around
  the gap, everything FLIPs home on drop) and it collapses the tab with `width: 0`, which a
  basis outranks. `dndTabIndicator: "line"` is the other half — the default is a half-width
  fill over every tab, which is a row of slabs the size of half a tab, not an insertion point.
- **Dockview owns the tab's ARIA and the strip's keyboard; the tab owns its face.** The Tabs
  pattern — `role="tablist"`/`tab`/`tabpanel`, `aria-selected`, `aria-controls`, a roving
  tabindex, arrows/Home/End/Enter — is dockview-core's and is already correct, on one
  condition: **nothing rendered inside `role="tab"` may be focusable**, or the arrow keys go
  dead (dockview matches `event.target` against the tab element) and the strip stops being one
  tab stop. So the ⋮ and the close are `tabIndex={-1}`, `Delete` closes and `Shift`+`F10`
  opens the menu on the tab itself, and the tab draws a focus ring. What dockview cannot know
  is what the panel is doing, so `useTabLabel` folds the reading and the pin into its
  `aria-label`. **Dockview's own overflow list is off** — `TabActions` draws the better one.
  A narrow strip **keeps the tab and nothing else** (`index.css`): every other one is in
  `TabActions`' list, so nothing is collapsed, swapped or picked by viewport — one tab is laid
  out where four marks used to be, and hiding one is `display`.
- **Every strip is the app header's own row** (`--dv-tabs-and-actions-container-height`): a
  strip in the band and a strip docked under it are the same bar, and a shorter one below
  reads as a lesser thing rather than as another group of the same kind. **The header row and
  the tabs stand outside the card, on every route.** `SidebarInset` is the column, not the
  card — `index.css` takes the variant's radius, shadow and background back off it — and the
  card is what is *under* the header: the routes box on every other route (header in flow,
  `--app-header-h` zeroed inside so no route pads for an overlay that is not over it), and
  with the dock mounted each group's content container, the strip in flow above it (the only
  box in dockview's tree below a strip and above the content, which is what makes a split two
  strips over two cards; the header stays an overlay there so the top groups can join its
  row). **What separates two groups is the gutter between their cards**;
  `--dv-separator-border` is transparent, because dockview's line runs the full view height,
  through the band and down the gap.
- **A tab strip carries what is about its own group** — the **+** and the tab list, **against
  the last tab and not at the strip's end** (`.dv-void-container { order: 1 }`, which moves
  the one flex item that has to move and leaves dockview's tree alone). The + is the browser's
  affordance and opens into *this* group, which is what makes a per-group copy unambiguous; its rows are `WorkspacePanelItems`, the same array the header menu rendered,
  passed `flat` because the button already asked the submenu's question. **The openers come
  down through `useDockOpeners`**, never re-derived in the strip: which project a panel
  belongs to is `app-shell`'s answer, and every surface calls the one `openWorkspacePanel`.
  The bell and the palette trigger stay in the sidebar header, which does not split and is on
  every route.
- **On a narrow screen only the tab you are on is drawn** — every other tab is in the strip's
  list (`TabActions`, the switcher from two tabs up), because a row of marks is a second thing
  to read beside the list that already names every tab. It is entirely `index.css`, keyed on
  dockview's `dv-active-tab`/`dv-inactive-tab`: **a hide and not a collapse** (`display: none`,
  the class it already toggles), so there is no width or opacity to interpolate and a tab
  switch is one frame — the instant a browser gives a tab switch. Nothing is picked by
  viewport either: the mark is the panel's own (`PanelIcon`) on every strip, and `initialsOf`
  is the assignee avatar's again. What is *not* hidden keeps the wide strip's one-column title
  container, whose `transition` was for a collapse that no longer happens; dockview's own
  reorder is the strip's only motion (`--dock-tab-duration`).
- **The app header's controls are the tab's material *and its height*** (`.header-chip` beside
  `.panel-tab-chip` in `index.css`; `HEADER_CHIP` carries `size-8`, the tab's `h-8`): the
  sidebar toggle, the view-settings sliders and that group's tabs are one row whenever a group
  joins the band, so a pill of `--background` at 24px next to a rounded rectangle of
  `--composer` at 32px is two bars pretending to be one. **There is no ⋯ menu**
  — what it held went to the surface each half belongs to: opening a thread or a panel is the
  strip's +, and how transcripts are drawn on this device is the sliders beside the sidebar
  toggle, which is the app's other device-level control.
- **Opening a panel never splits the dock** — every kind arrives the way a new thread does, a
  tab beside what you are looking at, and `OpenPanelOptions.direction` is read as "do not
  replace what is in front of me" and nothing more. It used to split when the window was wide
  and no group of that kind existed yet, so the same click cut the dock in half the first time
  and opened a tab the second, rearranging a layout the reader had built. **Splitting is asked
  for by name**: `splitActive` (the chord, the palette row), which says which panel it moves.
- **A panel kind is a surface, and a surface that reads the URL cannot be one** — the board
  panel keeps "which board, which task" in its descriptor (`lib/tasks-location.ts`), never in
  the route. **What a panel is doing is data the panel publishes and the tab draws**
  (`lib/workspace/panel-status.ts`), never a glyph in its title. **A pinned tab is one every
  bulk close steps over** — its own Close still names it. **A preset rearranges what is open;
  a saved layout carries its contents**, which is why it is asked for by name. **A float is
  restored whole or not at all and a popout is never reopened**: its panels come home to the
  grid before the layout is counted.
- **The terminal panel's chrome is the product**: scrollback search, copy/paste, clear, type
  size and the key row. **Ctrl+C copies with a selection, interrupts without one**; **clear is
  the view, never the server's scrollback**; **an exited shell gets a new one, never a
  reconnect**. The bell and the shell's OSC title are how a terminal nobody is watching
  speaks — status and tab title.
- **Every colour handed to xterm is a hex, and its background is opaque**: the palettes are
  `oklch` (which xterm's parser drops) and `transparent` without `allowTransparency` is black
  — the two halves of "the terminal has no light mode". Re-read on the mode *and* the colour
  theme. **A keycap's label is its content, and an icon-only control carries a `title`.**
- **The helper key row follows the soft keyboard** (`--keyboard-inset`; the page does not
  resize, so a row at the bottom is a row *behind* the keyboard). It **wraps and stops at two
  rows** rather than scrolling sideways, with compact 28px caps — under the app's 44px touch
  target on purpose, because a keyboard of 44px keys covers the terminal it drives. **How a
  terminal is drawn is the device's** (`lib/workspace/terminal-prefs.ts`), and `keyRow: "auto"`
  asks the pointer, never the width.
- **How much of a panel the app header covers is measured, never assumed.** The dock sets
  `--dock-header-overlap` on each group for its tab strip; **a panel measures its own**
  `--dock-content-overlap` (`lib/workspace/panel-overlap.ts`), because `defaultRenderer="always"`
  renders panel content outside the group element, where nothing the dock sets can reach it.
  The old constant reserved the header's height in every group, including the ones nowhere near
  it — twice, in the strip's margin and the panel's own padding.
- **What is open inside the IDE is the IDE's state, never the dock's** (`lib/ide/editors.ts`,
  a module store — persisted per server and project, so its tabs survive a reload). Only the
  tabs and the focus are stored; a reveal is one-shot and a dirty flag is derived, rebuilt by
  the editor re-reading its buffer. **`open.ts` and `editors.ts` name nothing from Monaco**, because every
  reader loads the transcript that imports them; Monaco is a dynamic import, excluded by
  chunk name from the service worker's precache.
- **A turn's changes are measured by git, never read off the transcript** — tree snapshots at
  `turn_started`/`turn_ended` through a scratch index; **the real index is never touched**.
  **What git measures is a window, not an author**, so the *reading* is gated on the transcript
  (`couldTouchFiles`, ACP `kind` and no vendor name): a turn that only read, searched,
  fetched or thought draws nothing, because in a cwd shared with another thread, an editor or
  a build it would otherwise claim their diff. The gate is a **read-only allowlist** — an
  unrecognised kind still draws — and it decides only what is drawn, never what is recorded.
  **It is drawn in the footer's end cluster, not under the turn** (`ChangesIndicator`): it is
  the newest gated turn's, which is a reading of the thread and belongs where the other three
  are, and the file list a chip could never hold is what its popover is for. `ThreadView` picks
  the turn (the last value of `withTurnChanges`) — the composer holds no opinion about which.
  **Reviewing a turn is source control narrowed to its paths** (`lib/ide/scm-filter.ts`), not a
  surface of its own: the files are already where they can be staged, discarded and committed,
  and a second list that could do none of that was the changes tab this replaced. The
  narrowing is one derivation of the status, so every count and every "stage all" follows it.
- A project's own page reads its settled half from one `/stats` call, on mount and by Refresh
  and **never on a timer**. **Turns, not events**, are counted; a tile skeletons rather than
  zeroes. **Header carries a "Run" dropdown** for the project's custom helper commands
  (`project_helpers`). **A helper runs in a terminal panel, never in a dialog** — a saved
  shell line asks things, and only a PTY can be answered — so it has no timeout, its stored
  `cwd`/`env` are read server-side and never sent up, and `confirm` asks before the terminal
  exists.
- **A message the app draws is one of two boxes, never a bespoke one.** `Notice`
  (`components/notice.tsx`) is every alert — four semantic tones, two densities, glyph and
  `role` derived from the tone. `Empty` (`components/empty.tsx`) is the dashed box for "there is
  nothing here" (`sm` inline, `lg` page — what `EmptyCard` used to re-spell). Absence and news
  never share a component.
- **The composer's two surfaces split by subject.** A note above the strip
  (`components/composer/notices.tsx`) is about *sending*; everything about the *turn* — the wait,
  the working line, a held turn, an approval, a question, the queue — is at the foot of the
  transcript (`thread-view.tsx`), where the next thing happens. **A footer reading is a mark that
  grows words**: icon always, label `@panel-sm` only, and its count as a text badge where the
  label shows and a bubble on the mark where it does not.

## Tasks → `docs/tasks.md`

- **A board is a project of work, not a kanban**: it owns its key, columns, sprints, saved
  views and custom fields. **A column's `category` is what the harness knows** — everything
  counting "done" reads `completed_at`, never the column name. `wip_limit` is advisory.
- **The tree is `parent_id`**, same board only, never a descendant; deleting a parent
  *detaches*. Every change is written to `task_activity` — **history is recorded, not
  diffed**. **No foreign keys**; every cascade is by hand.
- `lib/tasks-view.ts` is the pure half; how a board is *read* is device-local, a *saved* view
  is the server's. Every view takes the one `ViewProps` contract and never touches the cache.

## PWA and notifications → `docs/pwa-and-notifications.md`

- **One service worker (`client/src/sw.ts`), and no Firebase inside it** — the browser
  restarts the worker per event, so only top-level code is guaranteed to have run. **The push
  payload is a contract: data-only**, carrying `title`/`body`/`sessionId`.
- Updates are `registerType: "prompt"`: the new worker only `skipWaiting()`s on the user's
  Reload.
- **Registering for push is reversible and the reverse must reach the server.**
- `new Notification()` is not available everywhere and push does not cover the gap; both paths
  build their options in `lib/notification-shape.ts`. In Electron the OS layer is Electron's
  own `Notification`, preferred with **no permission check**.
- **A backgrounded page is not a detached one, and only the page can say which it is**: only
  the turn-end push gate reads `watchers(session)` — fan-out, idle sweep and peer counts still
  count sockets. It is `freeze`/`resume`, not `visibilitychange`.

## Ops: git, backup, quota → `docs/ops.md`

- **A project is a directory, and a directory is not one git repository.** `server/src/git.ts`
  addresses a `RepoContext`, never "the project's git".
- **Backup is one JSON document and import is one transaction.** Never exported: the server
  token/host/port, the probe cache, `history_*` rows.
- **Subscription quota is read by asking the runtime's own CLI, out of band**, naming the
  plain CLI and never the ACP binary. **"No quota" is an answer, not a failure** — never a
  zeroed bar.
- **The provider's plan is read from the profile, which outranks the agent's probe.** The
  adapter owns the endpoint; an unknown `kind` throws rather than falling through. Settings ›
  Usage is the only surface that lists plans.
- **A profile preset is a starting point, never a stored kind**: nothing about it is saved on
  the profile.

## Testing

- **No visual testing**: don't drive the UI with Playwright/browser automation or take
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
| `docs/tasks.md` | boards, keys, columns and categories, the parent tree, activity, sprints, links, custom fields, views |
| `docs/ops.md` | git, backup/import, agent quota, provider plan usage |
| `agent/docs/` | the Daedalus Agent runtime: prompting, managing it from the harness, standalone use |
