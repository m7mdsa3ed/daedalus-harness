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
  links its threads get), projects (a cwd and a name — nothing linked), the library,
  bearer auth, the event log and FCM push. `data/` holds secrets — gitignored, never commit.
- **Storage is PostgreSQL via Drizzle** (`server/src/db/`, node-postgres pooled, so database
  work is async; `DATABASE_URL` wins over `data/config.json`'s `databaseUrl`). Every query goes
  through the `db` exported by `db/index.ts`. Links are join
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
  exist, and **`db:push` is plain `drizzle-kit push` — it takes no backup first**.
  **A table push does not know about is a table
  push drops** — anything the server reads must be declared there. The FTS index is maintained
  outside Drizzle.
- **Agents spawn by their globally installed binary, never `npx`** (~0.4s vs ~3.2s, and a
  thread spawns on create, revive and every profile/model change). codex-acp **≥ 2.0.1**,
  claude-agent-acp **≥ 0.89.0** — the AIR shape below (and rules on its `customInstructions` key) (and `ToolCall.name`, the tool's own
  name, which `lib/tools/naming.ts` prefers over a vendor `_meta` block). Claude's
  `workflow_progress` passthrough and its `SendMessage` resume fixes (a resumed child is keyed on its
  launch id, not the SendMessage's, and a load registers the replayed children) are
  `server/scripts/patch-claude-acp.mjs` (check: `patch-claude-acp.check.mjs`), re-run per upgrade.
  Seeding backfills new fields but **never** replaces name/command/args/env — those are the
  user's, and so are `install`/`icon` (descriptive, not protocol).
- **What the harness believes about a runtime is a column on its row, never a comparison
  against its id.** `spawnCategories`, `liveConfig`, `quotaProbe`, `personaVia`,
  `rewindVia`, `workflowsVia`, `callsVia`, `workspaceLayout`, `builtinTools`, `sharedProcess`,
  `catalogProbe`, `discovery`, `install`, `icon` — a user who repoints `command` at a fork
  repoints these with it, and nothing outside `registry.ts` spells a vendor's tool name,
  config path, install line or id.
- **Whether an agent is installed is measured, never assumed** (`server/src/agent-status.ts`),
  and versions come from the ACP `initialize` answer, never a parsed `--version`. **So is
  whether it is logged in, and logging in is the agent's own `authMethods`, never a vendor
  command** (`agent-login.ts`): a `terminal` method runs in a setup terminal, an agent-handled
  one is ACP `authenticate` streamed as NDJSON; only a method the probe returned runs,
  credential-taking ones stay a profile's, and `NO_BROWSER` is the probe's spawn env alone.
- **First run is measured, never flagged**: `setup.sh` gets a clone to a running server, the
  client's `?server=&token=` link is stripped on read, and the landing wizard's steps and the
  app's `ready` are one reading (`useSetupState`) — a virtual Default counts only when its agent
  can run. The desktop app's SSH connect trusts a host only by a confirmed fingerprint and keeps
  one tunnel per host on a fixed local port. → `docs/plans/first-run.md`.
- **Deployed built, not with tsx**: `pnpm pm2:start` builds, pushes the schema and
  starts on port **4001** from `DAEDALUS_PORT` (env wins over `data/config.json` for
  `host`/`port` and only those). One instance, fork mode.
- **The PWA needs https, so dev has `pnpm dev:tunnel`.** It does not start the server, and
  while it runs both ports are public behind only the bearer token.

## Protocol and transport → `docs/protocol.md`

- **The server is the ACP client; the browser is a subscriber.** Nothing but the bridge may
  attach a `data` listener to the child's stdout. Commands get exactly one `reply`; events fan
  out minus the peer that caused them. **The server never interprets a `session/update`.**
- **Four kinds are journaled and replayed** — `update`, `session_config`, `turn_started`,
  `turn_ended`; the rest are live-only. **A permission or elicitation is never journaled** —
  it lives in `bridge.pending` while the agent blocks. First answer wins. **The cross-thread
  inbox reads that map and nothing else** (`GET /api/pending`), and its answer route is
  `bridge.answer` with no origin peer — the socket's own door, so a lost race is a 409.
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
- **Client and server builds are versioned by one integer and gated on feature names**
  (`server/src/compat.ts`, both halves via `@daedalus/compat`): `/api/health` says `api` and
  `minClientApi` unauthenticated, `/api/meta` says `features`, a missing `api` is 0. Additive =
  a `FEATURES` entry and no bump, read with `useFeature`; **never compare versions**. Breaking =
  expand (client reads both shapes, ships first), migrate (bump `API`), contract (drop the old
  reader, raise `MIN_SERVER_API`); one level of support, a raise is a CHANGELOG line. Only a
  definite answer blocks (`incompatible-server.tsx`), never loading/offline. The server never
  self-updates. → `docs/protocol.md` "Versioning".
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
  for resuming** — the agent restores from its own store: `session/resume` (no replay) when
  the journal is whole (`Session.journalClean`, false at boot) and the agent offers it,
  `session/load` otherwise. A rewind always clears and loads.
- **A process is the pool's; a session is the thread's** (`acp-connection.ts`). One
  `AcpConnection` per process, one `initialize`, frames routed by session id, creations
  serialised. **Only a runtime that takes a thread's env per session shares**
  (`sharedProcess`, claude-code via `_meta`); the rest get a process of their own and a
  bridge closing kills it, as before. A shared bridge closing is `session/close`, and the
  process stays warm 5 min — the draft's probe asks on it, so the first message skips
  `initialize`. A crash takes every session on the process with it.
- **Agent processes can outlive the server** (`DAEDALUS_SANDBOX=hosted`, default `direct`). The
  bridge sees a `Handle` from `server/src/sandbox/`, never a `ChildProcess`; a hosted agent runs
  under its own detached host, shutdown *detaches* it, and boot *adopts* it from `agent_processes`
  without a second `initialize`. A change to spawn, stdio or turn settlement must hold under both.
  Loopback keys are derived from `data/loopback-secret`, so they survive a restart.
  → `docs/protocol.md` "Durable agent processes".
- **A draft creates nothing; a prewarmed process is the one thing that exists early**
  (`prewarm.ts`, feature `draftPrewarm`). Typing boots an agent ahead of the first message, and it
  stops at `initialize` -- no row, no journal, no `session/new`, no token -- because everything past
  the handshake is one thread's picks, which the draft is still changing. **It is claimed only
  when the spawn it would have done is byte-identical** (`specKeyFor` over the spec `start` has
  already resolved, compared at `sessions.ts:1749`); a mismatch kills it and the thread spawns
  cold, which is also what a runtime that cannot be prewarmed, a hosted sandbox, and every
  failure simply do. **A runtime whose threads share one process is warmed in the pool instead**
  (`warmShared`), because `start` spawns it keyed on a spec without the thread's env — the env
  rides `_meta` — so a draft-keyed entry could never be claimed; the pool entry is what its own
  `pool.acquire` finds.
- **Importing a thread writes a pointer, never a transcript.** Listing is ACP's
  `session/list`, never a runtime's files.
- **The harness is an AIR client** (`_meta.jetbrains.air` in `CLIENT_CAPABILITIES`), declared
  for `asyncTasks` and adopted for `nativeSubagentSessions`, `sessionFailure`,
  `recommendedValue` and `planContentDelta`. Both adapters then speak a different dialect,
  and it costs: **`terminal_output_delta` must be declared or a command has no output at
  all**; Claude's full `claudeCode.toolResponse` and the text in Edit/Write `rawInput` are
  gone — **the diff content block is the source**; a `tool_call_update` and its `_meta` are
  **deltas**, so the client merges `_meta` recursively. **Old journals keep old shapes**, so
  an old reader is never deleted — the new source goes beside it. The namespace is spelled
  once, `VENDOR_META.air`. → `docs/protocol.md` "AIR".
- **A capability we don't advertise is a feature the agent turns off.** Questions arrive as
  `elicitation/create`, not permission requests; narrow with
  `isFormElicitation`/`isUrlElicitation`, never `mode === "form"`.
- **ACP has no pause, so pause is the harness's own — one API, a mechanism per runtime.**
  `bridge.pause()/resume()`, `session_config.canPause` and the `paused` event are the same for
  every agent; what holds the loop is our runtime's `_daedalus/session/pause` where it is
  advertised, else the row's `pauseVia` (`"acp-meta"`: Claude Code's `PostToolBatch` /
  `UserPromptSubmit` HTTP hooks, `pause-hooks.ts`, whose answer is **late, never "no"** — a
  blocked step hook ends the turn). No mechanism, no `canPause`, no control drawn. Either way
  it holds at the next step boundary with nothing lost, and a cancel clears it.
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
  items where the thread's own are meant. **A running child whose spawn says
  `capabilities.cancel` has a Stop on its row** (`POST /api/sessions/:id/subagents/:childId/cancel`):
  an ask is cancelled through its run (the parent is told), a runtime's own child gets ACP
  `session/cancel` on its id; a workflow step is its card's to stop, never its row's. OpenCode 2's children arrive on its own `opencode/session/child_update`, translated on the
  way in — nothing downstream learns a fourth shape. The Daedalus agent's
  `task` children have stable ids and saved conversation state: use `list_agents` to find a
  child and `send_message` to follow up. A stopped or failed child resumes from its last
  complete model/tool step; a running child rejects a message instead of racing. This resumes
  the conversation, not an in-flight model request or unfinished tool call.
- **A model call is one record (`_daedalus/model_call`, the `ModelCall` under `call`), whoever
  observed it — no spans.** Which door a runtime has is `AgentDef.callsVia`, ordered
  (`CallDoor`: `acp`, `otlp`, `proxy`, `files`); `chooseDoor` runs once per process in
  `SessionManager.start`, the first that attaches is the thread's for its life, said on
  `session_config.callsVia`, and the implicit last is `usage`. **That choice is the double-count
  guard**: a `usage_update` rows only on a `usage` thread (`usageFallback`) — the removed design
  had four producers and the client reconciled them. Every door hands a draft to `recordCall`
  and touches nothing else; the emit lands in `fileCall`, the one path that fills `step`/turn
  and writes the `model_calls` row for a record the runtime sent and a server-built one alike.
  Every server-built record is counted by `model-calls/prompt-parts.ts` **after** the response
  ended (the shim once froze every socket counting inside the forward) and anchored to the
  billed prompt; a part a door cannot see is `unseen` → `null`, named in `missing` in words,
  never "overhead". → `docs/protocol.md` "Model calls".
- Agent stderr is spliced into errors on the way out; every route throw becomes the
  `{ error }` shape the client parses.

## Profiles, models, config → `docs/profiles-and-config.md`

- **A runtime's behaviour switches are a field on its row, not a paragraph of env to type.**
  `AgentDef.behavior` / `AgentBehaviorSwitch` is the only place a client learns that
  `DAEDALUS_AGENT_HOLD_ON_ERROR` is a switch, what it is called in words, and what it does with
  the key absent — so `Settings › Agents` draws controls and no component spells a key. The
  **declarations are the seed's and the values are the person's**, exactly like
  `name`/`command`/`args`/`env`: `AgentInputSchema.behaviorValues` is the only writable half, a
  key the row does not declare is dropped, and `resolveSpawn` writes **only the switches somebody
  changed** over the env templates — which is what leaves an untouched switch on the runtime's own
  default and lets a later seed move that default without contradicting a value nobody chose.
  Reset restores the declarations and clears the values.
- **A profile is a provider, not an agent; a thread is a (profile, agent) pair.** The agent is
  chosen at draft time, lives on `sessions.agent_id`, and survives a respawn.
- **A model's price is one number, and when it is not, the schedule is a sentence.** `pricing`
  is the listed per-Mtok rate; `ModelDef.peak` says when that rate is not what a request costs —
  `windows` (free-form, `server/src/peak.ts`), `when: "peak" | "off-peak"` and `multiplier`,
  defaulting to peak x2. Providers do not agree on a shape (DeepSeek raises two weekday UTC
  windows, Alibaba discounts a Beijing night), so the grammar is **one parser aliased into both
  halves** (`@daedalus/peak`, like `@daedalus/tps`) and never a column per vendor, and a sentence
  it cannot read is no schedule at all — never a guess, because a billing fact is not a place to
  infer. The composer's `PeakIndicator` is the only thing that acts on one and its phase is
  **what the price is doing, never which side of the windows the clock is on** (`bandLabel`) —
  those part company on an `off-peak` card, where the hours inside the window are the cheap ones.
  A moment at the listed price is `Off-peak` only where the windows are the dear ones; on an
  `off-peak` card it says `Listed price`, and `standard` is what an absent window means for
  *either* `when`: "cheap because it is not peak" is a discount nobody granted. The *tone* is
  what costs say (warn above the listed price, muted at it, success for a real discount), and
  the face leads with the reader's own clock — `Peak in 40m`, `1h 12m left` — because the
  distance to the next change is the only number somebody about to send can act on. Every
  boundary is read in the reader's time first with the provider's spelling beside it, and a
  next rise that is not the next change at all (a weekday card seen on a Saturday) is named
  too: `upcomingTransitions` decides it from the band each edge *opens*, so an `off-peak`
  card's window closing — the hour getting dearer — is not reported as a discount starting. **Which families bill by the clock is a
  fact, not a default** (`server/src/peak-schedules.ts`): DeepSeek and the Z.AI/Zhipu coding
  plans are named there and backfilled once at boot, matched on the leaf id; Anthropic, OpenAI
  and Mistral are deliberately absent — Anthropic removed its peak-hour reduction on 2026-05-06
  and the other two vary by tier rather than by hour.
- **The profile decides who owns the model — and only the model and the effort.** Every other
  agent option passes through untouched and stays live.
- **Being env at spawn does not mean being env forever.** `POST /api/sessions/:id/config` is
  the one door; it answers `{live}` and falls through to respawn when it cannot. **Respawn is
  atomic and server-side**, never driven from the browser.
- **Every pick on a started thread is staged, never taken** — live-capable ones too (model,
  effort, and the agent's own mode/options, `StagedConfig.modeId`/`options`, door
  `{pick}` on `POST …/config`). A steer nobody approved moved the permission mode and the
  model under an answer being written. What takes a patch is a turn starting (`prompt`), a
  spawn (`respawnNow`'s fold), or the reader's **Apply now** (`{applyStaged}` →
  `approveStaged`): a running turn is **steered** with only what the process can take as it
  is (`steerStaged`: picks + a live model/effort move; never a respawn, never throws) and the
  rest stays staged; an idle thread takes the whole patch. A queue drain steers too, and
  still never restarts. → `docs/profiles-and-config.md` "What a change costs".
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
  server's.** Steering is a composer send action only (`prompt {steer:true}`, ⌘Enter); queued
  rows wait for the turn to finish unless the user chooses Send now. The `queue` event is
  absolute and reaches every peer including the origin.
- **Escape stops the turn and can take back the newest queued row** (`cancel {reclaim:true}`),
  one only, back into an empty composer. Atomic and server-side, and **the take-back comes
  before the cancel**: a queued row never left the server. A steer is already on the wire and
  **the runtime keeps it through a cancel**, so a stop never re-queues one — the cancel's settle
  is its step boundary and it lands as a bubble (re-queueing showed a message waiting that the
  agent already had, then sent it twice). Opt-in, because the
  reclaimed message leaves the queue: only a caller with somewhere to put the words may ask.
- **Claude Code reaches a profile's gateway through the harness's own shim**
  (`server/src/gateway-shim.ts`), which forwards byte for byte and makes exactly one repair.
  **The key in the path is the credential** — derived (HMAC) from `data/loopback-secret`, so stable across restarts and never written anywhere else; a leaked key is revoked by rotating that file (every key changes, stranding adopted agents), not by restarting.
- **A persona is how a whole thread is worked on; a command is what one message asks.**
  Personas are library rows (`personas`, Settings › Personas, `/api/personas`), one per thread
  (`sessions.persona_id`, project default `projects.default_persona_id`), picked in the config
  menu like the model. The text heads the spawn instructions, **above the rules**
  (`resolvePersonaSpawn`), read at spawn so an edit or a delete (= none) lands on the next one.
  **A change on a started thread is a message, never a respawn**: the system prompt stays on the
  persona it carries (`sessions.system_persona_id`, frozen at the first change) so the provider's
  prompt cache still hits, and the next prompt carries a `<persona>` block (`personaSwitchBlock`,
  `persona_pending`) that the journal never holds and the bubble folds out. A rewind or fork
  says it again; an agent move unfreezes it. Model and effort stay the profile's: the rows' legacy `thinking`/`effort` columns
  are declared and never read. A workflow step inherits its parent's persona; an ask does not.
  **A new thread's first message may pick it** (`persona-classify.ts`, in `POST /api/sessions`
  before `create`, so it is a spawn input and never a respawn): only a persona nobody picked
  (the draft still holds the project default), only on the install's **decision model**
  (`side-models.ts` lane, `decide.ts`: one call, a probability per persona) — never a chat
  model, and with none chosen there is no call and no fallback — and anything but a
  catalogue id is no pick. Said as an ordinary
  `Persona` config notice, undone by an ordinary pick; `projects.default_classify_persona`
  and `config.classifyPersona: false` turn it off.
  **Saved prompts are gone** — they became `commands` rows (`legacy-prompts.ts`, once at boot,
  marker `savedPromptsToCommands`); `saved_prompts` stays declared until that has run
  everywhere. Personas are no longer copied into commands.
- **Rules ride the spawn-instruction doors** (`AgentDef.personaVia`, `{personaPrompt}`,
  `{personaFile}`): `server/src/rules.ts`, one global block plus one per
  project, beneath the thread's persona, plus the spawn trailers. Spawn-time — a change costs a respawn. Claude Code's and the Daedalus agent's door is AIR's
  `_meta.jetbrains.air.customInstructions` (`"air-meta"`, re-sent on new/load/resume; the
  bridge logs a runtime that never advertised it); **codex stays on `"env"`** because codex-acp reads that key on
  `session/new` only, so a revived thread would never get a change.
- **Every agent gets a virtual "Default" profile** (`default:<agentId>`) with no credentials
  and deliberately no models. Never written to `data/`, uneditable.
- **A draft cannot ask a process that does not exist**: option sets come from a live session
  or a cached one-shot probe, coalesced so two tabs cost one spawn.
- **A project carries the settings a thread started in it opens with** (`projects.default_*`,
  `PATCH /api/projects/:id/defaults`), because that is the scope the change is about —
  changing the project changes the model, and the pick follows the person to every device.
  `lib/thread-defaults.ts` is down to the one field a project row cannot hold: which project
  the front door opens in. A project that has named no pair has the resolved fallback written
  back (`seedProjectPair` on draft mint), and a pick publishes only **the keys it names** —
  a whole-row write would clobber a concurrent one from another device. `configChoices` is
  one object on the wire and is merged from the draft row, never from a cache the last write
  has not answered yet.

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
- **What an MCP server offers is read, remembered and drawn without being asked for.** The
  listing (`mcp-check.ts` → `mcp_catalog`) expires on a TTL like the quota does rather than
  being invalidated, is coalesced per row server-side, and every library row draws its counts
  from the one shared query (`useMcpCatalog`). **Check means connect *now*** — `POST …/check`
  is the only door that refuses the stored answer. The row's badge links to the server's own
  page (`settings/mcp-detail.tsx`, `/settings/mcp/:id/tools`), which draws **both sides of
  each contract** — a tool's input fields and its `outputSchema`, a prompt's arguments, a
  resource's URI and type, each as a field list with the raw schema one fold below — as a
  rail of what the server offers beside one entry's contract. It is a reading and nothing
  more: running an entry from Settings was the playground, and it is gone. The listing reads
  on a **pooled client per row** (the composer's reads share it; only Check connects fresh).
  **Something that ran and failed is an answer, not an error** — only a call that never
  happened is one.
- **A thread's MCP prompts and resources reach the composer through the harness's own client,
  for every runtime**: `/server:prompt` is a harness command that *fills* the composer with the
  rendered text, and a resource picked from `@` is read into a `File` and goes the attachment
  path. The agent's own `server:prompt` wins the name collision. The Daedalus agent itself
  speaks the rest — media, instructions, `list_changed`, elicitation, sampling (behind a
  permission), roots, progress — and joins a tool's images to the next step as a user message,
  because an OpenAI-compatible tool message is text only.
- **There is no browser and no CDP.** The Preview panel draws a project's files and diffs and
  nothing else (`web-panel.tsx`); Electron opens no debugging port, runs no `<webview>`, and no
  `chrome-devtools-mcp` row is shipped. Boot still deletes any leftover `builtin:browser` row.
- **The marketplace indexes nothing** (`server/src/mcp-registry.ts`): Browse proxies an MCP
  Registry's `GET /v0/servers` (`config.mcpRegistryUrl`, the official one by default) and maps
  `server.json` onto `McpServerInput` — `version=latest` or a search is twenty copies of one
  server, one row per package *or* remote, and **installing is the existing form prefilled**,
  never a one-click POST, because half of what publishers ship is a placeholder or an API key.
  **The registry never says how a remote authenticates**: a browsed row is `auth: "none"` and
  the save path's probe decides.
- **Workflows are the harness's, except where the runtime says it has its own**
  (`AgentDef.workflowsVia === "native"` — Claude Code: linking ours disallows its better one,
  so ours is not offered). A definition is **declarative JSON**; a script is Claude Code's API,
  name for name, and its saved workflows live in Claude Code's own `.claude/workflows/`.
  **A run starts in the background and its end is a message** (`<task-notification>` through
  the scheduler's `fire`), never a poll the agent has to keep up. **Every step is a real thread** on the parent's own profile, agent, model,
  effort, persona and links. One level, never a tree. **A restart resumes a run, it does not end it**: the script replays from the journal, a completed step is never re-run, an unresolved gate resumes, and a step in flight follows its `onRestart` (`resume` by default). Downtime is not run time (`run_recovered`). Anything hashed or handed back to a script crosses `canon()` first, because `jsonb` reorders keys. Design: `docs/workflow-engine-v2.md`.
- **A run pauses as a state, never as a cancel-and-restart**, and its clocks stand still. A
  restart ends a paused run as it ends a running one.
- **Asking another agent is the one door to another pair** (`builtin:agents`, `agents-mcp.ts`,
  `WorkflowEngine.ask`): a **one-step run** whose step names its own profile and agent, so
  the child, the mirroring, the cost and the cancel are the workflow's. Drawn as a plain
  subagent — no workflow `_meta`, a `_meta.daedalus.ask` pair instead, so its row is named by
  the `description` the caller gave it (else `agent · profile`) and wears the asked agent's
  own mark and an `AskAgentChip` naming the pair, because it is the one worker in a
  transcript that is not this thread's agent. The parent's model and mode ids never cross to another
  pair — the child starts on its profile's default model and its runtime's default mode.
  Offered to every runtime, Claude Code included (it rivals nothing), one level, and capped
  apart from workflows. The asked agent sees only the brief, and runs in the caller's project unless `projectId` names another (`WorkflowStep.projectId`; the parent's worktree is not carried across). **A thread with live children is never idle-retired** (`bridge.background`: runs, asks and a runtime's own background tasks), because retiring the parent cancels them. **The user picks the profile and
  model, per agent per thread** (`sessions.ask_profiles`, seeded by `projects.default_ask_profiles`,
  the "Ask agents" rows of the config menus): read at ask time, so no respawn; unset, the `agents`
  server raises a picker by MCP elicitation (the client draws it as the config menu's rows),
  and a set choice outranks the model's arguments. **An ask's child is granted every permission**
  (`ASK_AUTONOMY`), and **any child's question that still parks is repeated live on its parent**
  (`<childId>:<requestId>`, `from`) and answered there — never left where nobody reads.

## Client and UI → `docs/client.md`

- **State has two owners, split by what moves it**: the reducer in `src/lib/store.tsx` holds
  what the *socket* writes; everything a *route* answers is TanStack Query
  (`src/lib/queries/`). One owner per slice, nothing mirrored; writes **invalidate** rather
  than re-read by hand. Thread-lifecycle side effects stay in `src/lib/actions.ts`.
- **Default is the only built-in theme and it is shadcn's stock palette** (`:root` / `.dark` in
  `index.css`; `styles/themes.css` is hand-maintained and adds only radius, fonts, depth and
  tracking). Every other theme is user-made, from the studio. Radius steps are **multiples** of
  `--radius`, never offsets.
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
  permission in front of it. **The one thing it may reach is the network, and only through `Image` and `Map`**: `Image`
  loads a remote URL on a click, and `Map` is Google Maps (`lib/openui/google-map.tsx`, its own
  lazy chunk, loaded on a click ("Show map" or a location row) because every rendered map is a billed load) with a directions panel whose
  routing, search and places-along-the-route are the server's (`/api/geo/*`, `server/src/geo.ts`:
  Google's Routes and Places APIs under `config.geo.googleServerKey`). **Two keys, two doors**:
  the Maps JavaScript key (`geo.googleMapsKey`, referrer-restricted) is handed to the browser by
  `GET /api/geo/config`; the server key never leaves the server; with no key the map says how to set one. **An unclosed fence draws too, from the moment it opens** — the
  language puts `root` first and resolves forward references as their statements arrive, so a
  program fills in over the answer rather than appearing at the end; what that demands is that
  the drawing be forgiving, so the "came out empty" fallback is suspended while the row is
  still being written (a one-line program is legitimately an empty shell). A fence that will
  not parse falls back to the source, and the components are the harness's own (`Notice`, `Empty`,
  the `--chart-*` tokens) in `lib/openui/library.tsx` — the component table, which is one
  file's edit. **Anything framed goes through its `Box`, which asks where it is** — a card on
  the page, a recessed well inside another frame, a bare cell in a `StatRow` — so no generated
  component picks its own ground, and one type scale (`TITLE`/`BODY`/`META`/`LABEL`) sizes all
  of them. **The prompt is generated from that table, never hand-written**:
  `pnpm openui` in client/ runs `scripts/gen-openui.mjs` (the library's own prompt generator,
  under Node) into `server/src/openui-prompt.ts`, and `pnpm openui:check` is the drift gate —
  so the text the model is told and the components the reader gets cannot disagree. **The
  table travels in the spawn trailer, like the suggestions one** (`OPENUI_INSTRUCTIONS`,
  `personas.ts`), so every runtime on a profile is asked with the same components — it used
  to be pushed by our own runtime alone, which told every other one the lane was not for it.
  **The table is generated as head + one section per group + tail**, and **a thread names which
  groups it is taught** (`sessions.ui_groups`, project default `projects.default_ui_groups`,
  `uiGroups` on the wire) — **the set is the only switch**: empty = the model is not told the
  lane exists, non-empty = on, and `layout` is forced into any non-empty set because `Stack`, the
  root, lives there (so unticking it in the picker is "off"). `sessions.ui_blocks` and
  `projects.default_ui_blocks` are legacy, still declared, read only by `uiGroupsOf` (a row with
  no set of its own: `false` = off, else all), never written. **The set governs the asking, never
  the drawing**: a fence naming a group the thread was not taught still renders.
  It travels the way `suggestKinds` does, through the same staged-config / respawn door and the
  same project defaults. Adding a component is a file in `lib/openui/components/`, an entry in
  `lib/openui/groups.ts` (plain data, no React, so the picker never pulls the lazy chunk), its
  notes in `library.tsx` and one `pnpm openui`. **A generated view reflows on the panel's
  width, not the window's** — the components carry `@panel-sm:` variants (`StatRow` falls two-up,
  `KeyValue` stacks key over value, the chart's tick gutters shrink, and a **`Table` becomes one
  block per row** — first column its name, the rest named facts under it — because a five-column
  grid in a phone panel was a sideways scroller showing two of them), because the one thing the
  model cannot control is how wide the box it lands in is. The lane is written for a thread with a
  **reader**: a subagent's answer is a report to its caller, and an unattended run
  (`holdOnError` off, the workflow-step and scheduled-run case) wants prose it can grep.
  **The set governs the asking, never the drawing** (`sessions.ui_groups`, "Draw answers as
  UI"): empty, the model is not told the lane exists — and a fence that arrives anyway, whether
  the user typed it or the toggle was flipped back on mid-thread, still renders, because the
  renderer reads no switch. That is what makes a mid-thread flip change nothing already on
  screen.
- **An aside is a thread, not an annotation store** (`thread-view/aside-window.tsx`): "Aside"
  on a transcript selection mints a draft on the parent's pair with the passage quoted in its
  composer, drawn in a mini window over the parent. The link is `forkedFromSessionId` (turn
  null) and the flag is `sessions.aside_quote` — the sidebar badges it, and the parent marks
  the passage with the CSS Custom Highlight API (`aside-highlights.ts`, one shared `aside`
  highlight, matched ignoring whitespace), never by rewriting its rows. A click on the mark
  reopens it; "Open as tab" (sent or still a draft) is the same thread in the dock.
- **⌘K's root page never asks the server**; searching is a destination owning its own query,
  debounce and abort. Rows are data, not JSX, and cmdk's own filter is off.
- Device-local state lives in tiny stores (`lib/drafts.ts`, `lib/layout-options.ts`,
  `lib/keybindings.ts`) — how a transcript is drawn is the reader's property, not the
  conversation's. **A pin is not one of them**: it is a fact about the thread
  (`sessions.pinned_at`, `PATCH /api/sessions/:id {pinned}`), so it follows the thread to
  every device, and its timestamp is the order the pinned group is drawn in.
- **"New thread" is a quick action; "New tab" is the gesture.** ⌘N, the sidebar row, the strip's +
  and the palette open a New tab (see the tab rule above). A thread itself is begun from the New tab
  page, ⌘K's ask row or a project's + — every one mints a draft through the one
  `actions.startThreadIn`. **No list draws a draft** — `isListed`, not `isTopLevel`, is what the
  sidebar, Recents, the project page, the palette and the schedule form filter by. **A draft's tab
  survives a reload** (`lib/draft-sessions.ts`): the row is persisted per server and re-minted on
  boot only for the tabs the saved layout still names, so a closed tab stays closed and a sent
  thread comes from the server. **It takes the caret itself** — a draft's composer is focused when
  it is the routed thread or when the caller says so (`autoFocus`, which the New tab page's is);
  never on touch.
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
- **A tab is an isolated outlet, like a browser's, and "New tab" is the front door.** It shows whatever it
  is navigated to and can show anything — **including what another tab is already showing**: the same
  thread, settings section or project page may stand in as many tabs as you open, so a tab is never
  found by what it holds and its id is unique (`tabId` on a chat descriptor, a counter on a page's).
  Two doors in `dock.tsx`: **`navigateActive(path)`** is what the address bar does (a sidebar row, ⌘K,
  a link, a notification) — the tab in front *becomes* that place, in the same spot, and does nothing
  when it is already there (which is what makes switching tabs idempotent: the dock writes the
  focused tab's path to the URL and the URL writes it back); a pinned tab, or none, gets a new tab
  instead. **`openTab(path)`** is a new tab, always — ⌘N, the sidebar's "New tab" row, the strip's +,
  the palette — and opens on the **New tab page** (`/`, `landing/landing-page.tsx`): the composer to
  start a thread in that tab, and quick actions (New thread, Tasks, Automations, Inbox,
  Settings, the first projects) that each navigate *that* tab. A thread started from a project's +
  or ⌘K's ask row mints a draft and opens it in a tab of its own (`startThread`, `openInNewTab`).
  Several mounted views of one thread share its connection: exactly one holder opens it
  (`useThreadConnection`).
- **Sidebar order and the period a row is filed under are `activityAt` — the last turn, never
  `createdAt`. Reading is not activity.** Pinned and Recents are shortcuts, not places.
- **The sidebar has two contents and the reader picks, never the route or the active panel.**
  The footer's gear swaps the thread list for the settings sections (`sidebar/settings-nav.tsx`)
  and "Back to threads" swaps it back — **neither navigates**; a section row is what opens a page,
  in the tab in front. It was a reading of the active panel's path before, which made the gear
  a redirect. State lives in `app-shell` (`settingsNav`). The in-page `SectionPicker` survives for
  a phone, gated on `isMobile` (the device), never the panel's width.
- **Every page answers each UI question one way, from one kit** (`settings/primitives.tsx` "The
  kit", `page-primitives.tsx`, `components/ui/data-table.tsx`) - settings, the theme studio,
  routines, schedules, the inbox and the project page alike. *Switch the page's view*: `TabBar`
  (underline tabs under the header, sticky, the same at every width, scrolling sideways rather
  than turning into a dropdown). *Jump within a long form*: `FormShell` (the same bar as
  scroll-spied anchors). *Pick a value*: `Segmented` (2-4 short words) | `ui/Select` (more) |
  `ChoiceTiles` (options you must see - mode, layout, tool-step style). *Filter a list*: the
  `DataTable` toolbar. *Open an item*: a table row into its own page (a route, `settingsFormPath` and
  friends) - never a sheet. *Say a state*: `StatusBadge`. *Create*: the header's action.
  **There is no vertical rail, master-detail column, section dropdown or native `<select>` inside
  a page - the sidebar is the app's one vertical navigation, and on a phone the overview list
  plus a "Settings" back link (`BackToSettings`) is its form.** A `DropdownMenu` is an *action*
  menu (row "more", "Send test"), never a way to pick a value or navigate. Every list or
  collection is the `DataTable` (a wide panel: sticky-header table with a pinned title column and
  hover-revealed actions; a narrow one, `useIsNarrow`: a continuous list with a "more" button,
  swipe rails, selection and Load more). A page is `PageHeader`/`SurfaceHeader`/`FormPageHeader`
  (one look; `flush` or a following `FormShell` bar means the bar draws the rule) -> `TabBar` ->
  `StatStrip` -> blocks (`SectionHead` over a card). No page draws its own card, tab row, tile
  grid, rail or status colour. Drift is found by grepping for old `ui/tabs`,
  `tabs-subtle`, `segmented-control`, `toggle-group`, local `role="radiogroup"`, native selects,
  `bg-emerald-*`/`text-amber-*` and bare `sm:`/`md:` layout classes in those pages (dialog
  `sm:max-w-*` excepted). Reflow is the panel's (`@panel-*`) or the block's own container; the
  32px between blocks is `Section`'s (`data-kit-block`, which `PageForm` reads). A missing
  piece is a kit edit, never a second tab or sheet in a page. `primitives.tsx` is shared past
  settings. The dock's tabs, the command palette and the thread inspector have their own rules.
- **Everything with a face is drawn by `components/entity-icon.tsx`.** No component draws a
  folder for a project, and **an agent's mark is the server's** (`AgentDef.icon`, `"app"` =
  the harness's own) — the client holds no table of which runtimes exist. A **kind** wears the
  kind's glyph (`PANEL_ICONS`, for the menu that opens one); an **open panel** wears
  `PanelIcon`, and a chat's is its thread's agent — four threads used to be four identical
  speech bubbles.
- **The composer is `components/composer/composer.tsx`: one card, two rows** — what *adds to* the
  message behind "+", what governs *how it sends* behind the chevron beside Send. Touch
  targets follow `useCoarsePointer` (the device); what Enter means follows `useIsMobile`
  (the width).
- **The composer is one width, and it does not move.** Narrowing it while unfocused and
  giving the width back on `:focus-within` was tried and removed: every box in the unit —
  the shelf, the card, the notices, the scope row — measures against
  `--harness-composer-width`, so the whole unit breathes on every click in and out of the
  textarea, which is motion the reader did not ask for at the exact moment they are aiming
  at something.
- **After the first message the composer is the mini one, and the advanced form is a toggle on it
  — nothing is hidden behind a button of its own.** `ThreadView` hands `Composer` `compact`
  (the thread is not empty), and the mini box is the project's mark (a read-out), the agent's
  marks (the settings chip, `iconOnly`), the add menu, the editor, the toggle and Send on one line:
  **the two faces stand down while the reader is writing** (`marksDown` — the box has the caret
  or holds words), folded to zero width with an ease rather than unmounted so the words do not
  jump under the caret, because a reading of a thread already chosen is not what a line being
  typed into is for; the "+" stays, since adding to a message is done while writing it. **Words
  that wrap stack the line** (`stacked`, the editor's `onWrapChange`): the editor takes a full row
  over the same controls, latched until the box empties, up to the card's `max-h-40`. The
  scope row, the chip's words and the readings come back with the toggle
  (remembered per thread for the life of the page, `ADVANCED_THREADS`). The MCP servers are
  a row of the chip's menu, so they come back with it. A draft and the landing
  console are the full box — the first message is written in it. `ThreadView` also hands it the
  scroller's own pin (`useFollowStream.pinned`) as `collapsed`: leaving the tail folds an advanced
  box back to mini, and **a fill re-opens it** (`revealed`), because a suggested follow-up, a
  queued row's Edit or an "Ask about this" has to be seen. Only a voice call still takes the box
  away (the `composer-pill`, a clip-path morph that keeps the height it reserves,
  `--composer-dock-h`). A composer that collapsed *itself* — on a narrow panel or a short window —
  was tried and removed: it took the box away from someone who was typing, on no gesture at all.
- **The shelf has a surface of its own** (`--shelf`, `bg-shelf`), derived from `--composer`
  and **darker than it in both modes — which is two declarations, not one**: darker is toward
  the foreground in a light palette and toward the *background* in a dark one, where
  `--composer` is already the lighter of the two tones. It wore `--surface`, which is the
  *page's* ground and resolves to the same thing `--composer` does in a light palette, so the
  shelf, the composer and the page were one flat band with an invisible tuck between them.
  Derived, never picked, so every generated palette gets it for nothing. **Neither the composer
  nor the shelf draws a hairline ring** — the two grounds meeting is the seam, and the
  composer's only ring is the destructive one while voice is listening.
- **The send row has one voice key, and the modes are behind it**
  (`composer/voice-button.tsx`): a dictated note (`Mic`, the browser's own speech API) and a
  call (`AudioLines`, a configured backend) are the same gesture at different lengths, and as
  two buttons **which one existed depended on two unrelated facts** — and a mini line had
  room for neither. **A click runs the pick and never opens the menu**: the fold beside it
  (`ChevronDown`, hover-revealed under a mouse and always drawn under a finger) chooses which
  mode that click runs, persisted in `composer-prefs` so the pick follows the hand. **A live
  mode outranks the pick** — the same key stops what it started — and a mode this browser or
  server cannot run stays listed, disabled, saying why. `voiceCall`/`voiceNote` (`⌥C`/`⌥D`)
  pick their mode *before* running it, or the key would be counting down a call the reader
  never chose.
- **The shelf has a floor and a pile, and the floor is what is permanently true.** Project,
  tools and the context ring are `ComposerStrip`'s `footer` (`DraftScopeRow`) — always drawn,
  never a card, on **both** sides of the first message: a started thread's project only stops
  being *editable*, it never stops being *said*, and the tab does not repeat it. It wears the
  shelf's `--shelf`, never the composer's `--composer`: the strip and the box below it are two
  surfaces, and giving the floor the composer's ground made them one flat band.
  **The tuck is worn by whoever is last** — the footer when there is one, the cards when there
  is not, never both. **A tools menu's side is the caller's, never inferred from `editable`.**
- **The pile is only what is about the message being typed** — attachments, the history
  notice, the two completers, the archive notice.
- **The box is a Tiptap view of a plain string, never a markdown document**
  (`composer/composer-editor.tsx`, `editor-text.ts`): `text` stays the exact message sent, and a
  `[pasted text #n]` token, a finished `@path` mention and a run of `> ` lines all draw as the
  one inline chip (no card, no border) and serialise back to the same characters. The ref is a `TextSurface` (a textarea's
  `value`/`selectionStart`/`setSelectionRange`/`focus`), so the completers and the history walk
  never learn the editor exists. Markdown WYSIWYG escapes what was typed (`snake\_case`), which
  breaks `/`, `!`, `@` and history recall. Keys are taken in the capture phase and ProseMirror
  honours their `preventDefault`. "Ask about this" on a transcript selection is `ComposerHandle.quote`.
- **A reading of the thread is a 24px trigger over a popover, in the footer's end cluster** —
  the checklist's progress, the running-subagent count, what the last turn wrote, the context
  ring (`TodoIndicator`, `AgentsIndicator`, `ChangesIndicator`, `ContextIndicator`), **and the
  tools the thread carries** (`ThreadToolsMenu`). One kind of question, one shape, one place;
  each draws nothing when it has nothing to say. **The tools menu belongs in the cluster, not
  on the row's start** — what a thread carries is the same kind of fact as how full its window
  is, and a picker with a divider in front of it was the one thing in the row pretending not to
  be a reading. A popover is a fixed surface, so those lists scroll
  without taking room from the transcript. **A floating summary pill over the composer was
  tried and removed** — see `docs/client.md`.
- **A reading's words are its own dress, and which dress is named once** — from
  `components/composer/indicator.tsx`, never per component: `ReadingBadge` is the value in words
  where the *panel* has room (`@panel-sm`, never the viewport — a chat squeezed beside a terminal
  is narrow for the same reason a phone is) and `ReadingBubble` is the same number riding the
  mark where it does not, **never both**. The tools menu is a reading too: a **menu** where the
  others have a popover, and the count in the same two dresses. **The project is the one control
  that keeps its words on every width** — it names where the work lands, so its badge is
  `always` and it truncates rather than going quiet. Whether a reading draws at all stays each
  one's own answer (`total === 0` renders nothing on a started thread; a draft still draws the
  picker, its bubble withheld at zero).
- **The queue is drawn as the user messages it is**, dashed, at the very **end** of the flow —
  after the approval and the question, because a queued message is the conversation's future.
  **Editing one takes it back to the composer** (`queueRemove`, then `fill`, and only on
  success): there is no second editor in the transcript, and cancelling is the same gesture.
  **A scroller item that renders nothing still reserves its intrinsic size**, so the caller
  gates (`thread.queue.length`) and the component only draws.
- **A slash command is either the agent's or the harness's and the composer draws one list**;
  the agent's shadows the harness's, and a draft is offered no harness commands. An `@`
  mention is text *and* a `resource_link`, added server-side for any `~`/absolute/relative
  path that exists — the scope is the person's, never only the cwd. A typed `@kind:ref` (`thread`, `commit`, `branch`, `tag`, `git`, `run`, `kb`, `term`, `mcp`, and `@path:40-80` for lines) is expanded at send into a `<context>` block by `POST /api/mentions/context`; sources are one file each on both halves (`client/src/lib/mentions/`, `server/src/mentions/`) and the kind list is copied in both, `test:mentions` failing on drift. → `docs/mention-sources.md`.
  A `!` line is a **shell command and the composer's third completer**: the project's helpers
  **and the scripts its `package.json` files declare** (root and one directory deep,
  `GET /api/projects/:id/scripts`, read off the disk and never stored — helpers first, a row
  the person wrote outranks one the package shipped) **and what the project keeps running**
  (`shell_history`, a per-project tally the shell route itself bumps — never the browser —
  read back through `GET /api/projects/:id/shell-history`; **server-side, not device-local**,
  because the line you build with belongs to the workspace, and it orders the other two lists
  as well as filling its own "Recent" one) are suggested, picking one fills its
  *command* into the box, and the send path *consumes* the
  line rather than prompting (`shellLineFor`) so it never reaches the agent — **send and
  forget, like a prompt**: the box clears on the send, and the running row is where the line
  and any failure are said. It runs on the
  server against the project, and the result is **journaled as a `_daedalus/shell` row** — two
  updates, `running` then `done`, under one caller-minted `shellId` — part of the transcript,
  replayed on reload, no turn and no prompt; the one route that takes a command up from the
  browser (`POST /api/sessions/:id/shell`). A line that IS a saved helper's command runs as that
  helper (its cwd and env); anything else runs as itself — including a nested package's script,
  whose suggested line carries its own `cd`. It draws as a **Bash step** — the same
  icon, heading rule (`toolHeading`) and `ShellPane` as an `execute` tool call, open by default
  and from the moment it starts — because that is what it is; only the agent's absence differs.
- **Every surface a caret can land in clears the soft keyboard.** The page does not resize
  when one opens (`overlays-content`), so a fixed surface at the bottom is a surface
  *behind* the keys. Ride it with a named recipe from `lib/keyboard-inset.ts` —
  `KEYBOARD_LIFT`, `KEYBOARD_CENTER`, `KEYBOARD_RISE`, `cn`'d last — never a fresh calc.
  **Edge-to-edge is cleared at the portal, never in a `ui/` component** (shadcn's, which a
  reinstall reverts): every Base UI surface lands in `[data-base-ui-portal]`, and
  index.css makes that wrapper the **float box** — the viewport less the status bar, a
  landscape notch, and the home indicator *or* the keyboard. A flyout's wrapper *clips*,
  which is what floating-ui collides against and sizes `--available-height` to (no
  `collisionPadding` anywhere); a dialog's is its containing block, floored above the
  indicator but not the keyboard, which the dialog rides itself; sheets, drawers and toasts
  are edge surfaces that pad themselves and are not boxed. Anything sized by hand reads
  `--float-h`/`--float-w`/`--float-bottom`, never `100dvh`/`100vw`. A
  field on an ordinary form is `lib/keyboard-caret.ts`'s, because the browser's own
  scroll-into-view is the thing `overlays-content` turned off.
- **The phone has no bottom navigation bar**: the header's sidebar trigger opens the mobile
  thread drawer, and every bottom-anchored surface pads by `--safe-bottom` for the home
  indicator. **A sideways swipe on the strip, never the transcript, is `cycleTab`**
  (`useTabSwipe` in `dock-surface.tsx`). → `docs/client.md` "The phone".
- **"Mobile" is two questions: width is the panel's, the pointer is the device's.** Layout
  uses the `@panel-*` container queries; touch targets and centred surfaces stay on media
  queries.
- **A key that is bound is a key that is listed and a key that can be moved.** Nothing reads
  `KEYS` to bind — use `useShortcut(id, handler)`; chords print through
  `components/shortcut.tsx` and nowhere else.
- **The tab strip's keys all act on the group you are looking at** — digits jump, Alt+↓/↑ walk
  it wrapping, Alt+W closes the tab in front through the guarded door its ✕ uses
  (`setTabIndex`/`cycleTab`/`closeActiveTab`, which the palette's rows call too); ⌘Tab is the
  browser's own, so it rides `RESERVED` to the desktop shell like ⌘1…9 and ⌘⇧T, and **⌘W is
  never the close chord** because Electron gives it to close-window. **The panes have a family too**: ⌥←/→ walks them, ⌥⇧+arrows resizes the divider, ⌘⌥+arrows
  *sends the tab in front* to the pane that way (or splits one off; a lone tab stays put), ⌘⇧PgUp/PgDn
  reorders it within its strip (a pin never crosses the unpinned), ⌘⌥0 evens the row and column
  (`moveTab`/`sendTab`/`equalizePanes` on the dock; the palette and the tab's menu call the same).
- **The desktop shell names a shortcut, never an action** (`lib/desktop.ts`): the native
  menu, the tray and the quick-entry hotkey send a `ShortcutId` and the renderer runs
  `runShortcut(id)` — the chord's own handler. **A thread popout is one transcript and no
  shell** (`lib/popout.ts`): it never saves a layout, never restores or prunes drafts, and
  never notifies — it shares the main window's origin, so every store is the main window's.
- **A restart the user asked for is not a thread coming back from the dead**, and the wait
  says which (`ConnPhase.reviving.because`): one paragraph explaining idle-retirement used to
  be shown to someone who had just picked a persona. **A wait in front of a transcript that
  is staying put is not drawn until it lasts** (`waitDelayMs`) — a respawn usually beats it,
  and a headline plus a paragraph that appears and vanishes is flicker announcing a wait
  nobody waited for. The gate is the caller's, because a scroller item that renders nothing
  still reserves its size.
- **No native tooltip is ever drawn**: `components/title-tooltips.tsx` lifts every `title`
  attribute on hover/focus-visible (dockview's and xterm's included) and draws it as the app's
  tooltip, moving it to `aria-label`/`aria-description`. Write `title="…"`; never wrap a
  control in a `Tooltip` just to label it.
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
- **One dockview instance; tabs are grouped by dockview's own tab groups.** A tab group is a
  coloured, labelled, collapsible chip over a run of tabs **in one strip** — never across two.
  The chip's menu is dockview's (rename, colour, collapse) except **Close group, which is
  ours** (`closeTabGroup`), because dockview's removes panels past the close guard and the
  reopen stack. Colours are `TAB_GROUP_COLORS` (`--primary`, `--chart-*`), never dockview's
  fixed hues, and the chip is a tint with the foreground on it, not white on a colour. A dock
  inside a tab (`group` panels) was the first version: every question had to be asked of two
  instances, a drag between them was never accepted, and half the tab menu did nothing on a
  grouped tab. **A layout that still holds one is unpacked on load** (`unpackGroupPanels` in
  `layout.ts`, checked by `layout.check.mjs`): each group tab becomes its tabs, in place, as
  one tab group. **The bottom panel is dockview's edge group**, reached only by a tab's "Move
  to the bottom panel" (`revealEdgeGroupWithData`, which removes it with its last panel) —
  nothing *opens* there. Pinning, layout undo, keyboard docking, wrap/searchable overflow and
  the drop compass are dockview **enterprise** modules, inert in this build: ours stay ours.
- **The outer dock holds five panel kinds: chat, terminal, web, tasks, page** (a thread's own
  terminal, preview and board live in its thread dock). **There is no IDE** — no editor panel,
  no file explorer, no code-server; the preview is the project's window. **Monaco is the
  diff and nothing else** — the official `monaco-editor`, so there is no
  workbench and no "initialize once per page" rule.
- **Source control starts from `GET …/git/repos`, never from "the project's git"**, and every
  read and write names its `repo`. **Status paths are repository-relative** —
  `projectPath(repo, path)` is the one join back to the file routes. **A comparison names both
  its sides**, never just the left: a fully staged row is HEAD ↔ index and anything with work
  on disk is index ↔ worktree, or staging shows edits made after it. **Branches, stashes and
  the log are read when asked for** — the branch list on the picker's open, the stash and
  history lists on their tab's first open — never with the status, which the watch stream
  re-reads.
- **The working set is drawn as VS Code draws it: Merge Changes, Staged Changes, Changes**
  (`scmGroups` in `lib/workspace/working-set.ts`), the verb on the row (+ / − / ↺) and on
  each header and folder for everything under it; the commit box above the scroller, stashes
  and history folded and capped at the foot. A path staged *and* edited again is a row in each
  group — accepted on purpose, because each row opens its own half (HEAD ↔ index above, index
  ↔ disk below). It replaced one ticked list with a tri-state (`workingSet`), which still
  answers the **counts**, where a path is one path. A conflicted file is never "staged"; its
  + is "mark resolved".
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
  these tabs is transparent by design.) Three weights of one material, and **no colour on any
  of them**: resting is a 4% wash of the foreground, hover the same wash at 8%, and the active
  tab the card's own ground and its `shadow-sm`. Hover sits *between* the two weights rather
  than on top of the active one — pointing must not look like selecting — and the resting wash
  is what makes a row of six tabs something to aim at rather than six pieces of text; it is
  deliberately under the 7% that is a full step of the page's ramp (`--app-ground-step`).
  If a tab should ever be marked the way an active tab in a *browser* is marked, it is the
  ground that says it, because **no tab wears a colour**: the reading is `PanelStatusDot`'s,
  which is a *state* and stays a dot. Corners are `--radius` less the cell's 2px inset, so the
  tab's corner sits just inside the card's `--radius-xl` instead of colliding with it. It
  carries the **panel's own mark** (`PanelIcon` — a chat's is its agent's), its title and its
  **reading** (`PanelStatusDot`) as one box, and the ⋮ and close **floating over that box's end**
  — **not** the thread's context reading, which the composer's footer says once. **The controls
  are an overlay and reserve no room**: absolutely positioned against the chip's trailing inset,
  so a title owns the whole of the tab's width and the strip pays no gutter for a pair of things
  that exist only while you point at one tab. What they cover when they appear, the title has
  already stopped saying — it fades under them (`--tab-fade-w`, a registered length declared on
  the **chip**, which is what knows whether it is hovered, focused or holding the ⋮'s menu open;
  the transition rides the title's mask alone, because a registered property every element
  inherits would invalidate style for the whole app), and the fade is the width of what is
  actually there, the pin included. **The pin is a `[data-tab-action]` too**, which is what lets
  it be the one control drawn before you point. The ⋮ and the right-click menu render one `items`
  array, so they cannot drift. Sizing is a browser's — one width whether it is alone or one of nine, so
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
  reads as a lesser thing rather than as another group of the same kind. **The sidebar has two layouts, and the reader picks** (Settings › Appearance › Sidebar
  layout, `sidebarVariant` in `lib/layout-options.ts`, device-local; the open/closed state is the one sidebar fact that stays in `lib/sidebar-layout.ts`, because a toggle must not re-render every transcript row). **Flush** (default,
  `Sidebar variant="sidebar"`): a rail with no border, the content filling the rest, a top group's
  strip an overlay on its content under a progressive blur (panels pad by the measured
  `--dock-content-overlap`). **Inset** (`variant="inset"`, `p-0` on the container): the shell stands on
  `--app-ground`, the rail is transparent over it, the strip is in the row on the ground with the
  card below it (no blur at `md`+), and each group's content a rounded shadowed
  card with `--app-frame-gap` of air. Every inset rule in `index.css` is keyed on
  `html[data-sidebar-layout="inset"]`, written by the shell and by `index.html` before first paint, so
  the two never mix; the arrangement is the same on a phone (strip in the row, card below, no blur). What separates two groups is a hairline (flush) or the
  gutter between their cards (inset); `--dv-separator-border` is transparent, because dockview's line
  runs the full view height, through the band.
- **A tab strip carries what is about its own group** — the **+**, the layout presets
  (`LAYOUT_PRESETS`, applied to the strip's own instance, never on a phone) and the tab list, **against
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
  sidebar toggle's cluster and that group's tabs are one row whenever a group joins the band, so
  a pill of `--background` at 24px next to a rounded rectangle of `--composer` at 32px is two
  bars pretending to be one. **There is no ⋯ menu**, and **the header holds one control** —
  the sidebar toggle. Opening a thread or a panel is the strip's +; what the app can search and
  which notifications have arrived are rows in the sidebar, which is where a place you go is
  named, and **how transcripts are drawn is Settings › Appearance › Transcript**
  (`LayoutSettings`, ⌥V goes there). The space switch is the sidebar footer's icon, not a header chip. The header is the band the *tabs* join, so what stands in it
  is the tab's own material and height and nothing that is about the app rather than this group.
- **Under Electron the header band clears the OS's own controls, measured.** Windows/Linux pad
  the band's right by the caption overlay (`env(titlebar-area-width)` + 12px, 148px fallback);
  macOS pads its left by 80px for the traffic lights whenever the sidebar is collapsed or a
  sheet (`index.css`). The strip pads by the header's content box, so it follows both.
  **The window material is the reader's** (Settings › Appearance › Desktop window,
  `window-translucent.json`, read by preload synchronously): off means no vibrancy/acrylic/mica,
  an opaque window colour and no `data-desktop-vibrancy`, so the page paints its own grounds.
  A creation-time option — a change needs a restart.
- **A chat tab's second row carries the project, the model and the thread's age** (`relativeAge`
  in `lib/settings.ts`, re-rendered by the minute); the title mask fades both rows under the
  hover controls. "Duplicate tab" is the menu's way to a second outlet on the same place.
- **A thread's MCP servers are a row in the settings menu, not a chip of their own**
  (`thread-tools/mcp-section.tsx`, drawn by both `SessionConfigPopover` and
  `DraftConfigPopover`): a submenu of switches beside Model and Effort, because a link is a
  **spawn input** like the pair and a revive reads it — where the permission mode is not, which
  is why the mode stays under "Agent options" on the live process's own channel. Header with
  "N of M" and the staged note, a filter past eight servers, Library and Built-in groups of rows
  (mark, name, a status dot — connected / needs authorization / error / not checked, from the
  stored catalog and never a fresh connect — transport or the failure, tool count, switch), and
  Clear / Manage in the submenu. A row the agent requires is on and locked ("required by
  <agent>"), read off `requiredMcp` rather than a table of runtimes. It is a `ToolRow` and not
  a `ToolSection` — one status dot and one lock reason the skills list has no use for. Alt+M
  and Alt+S both open the menu that holds it.
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
- **A turn's changes are measured by git, never read off the transcript** — tree snapshots at
  `turn_started`/`turn_ended` through a scratch index; **the real index is never touched**.
  **What git measures is a window, not an author**, so the *reading* is gated on the transcript
  (`couldTouchFiles`, ACP `kind` and no vendor name): a turn that only read, searched,
  fetched or thought draws nothing, because in a cwd shared with another thread, an editor or
  a build it would otherwise claim their diff. The gate is a **read-only allowlist** — an
  unrecognised kind still draws — and it decides only what is drawn, never what is recorded.
  **Two threads in one repository are told apart while the window is open, never after**: the
  recorder watches the project for as long as a turn runs, and a path written while another
  *owner* (a child thread's owner is its parent) had a turn running is `shared`, naming them.
  The server reads no transcript; the client clears `shared` for a path its own tool calls name
  (`claimShared`). A child thread's turns are listed and nudged to its parent.
  **It is drawn in the footer's end cluster, not under the turn** (`ChangesIndicator`): it is
  the newest gated turn's, which is a reading of the thread and belongs where the other three
  are, and the file list a chip could never hold is what its popover is for. `ThreadView` picks
  the turn (the last value of `withTurnChanges`) — the composer holds no opinion about which.
  **The Source Control panel is the Git half and nothing else** (`thread-view/source-control.tsx`, on the `workspace/scm/` pieces; a Sublime Merge layout as a dockview of its own: Locations, History, Files and Diff panes, hideable, movable and kept per device (`workspace/scm/scm-dock.tsx`), with hunk/line staging). The turn Review half (timeline, review drafts, viewed marks, Revert turn) was removed from the client; the server's `changes/*` and `turn-changes/:id/revert` routes remain, unused.
- **A chat tab on a wide screen is a thread dock** (`workspace/thread-dock.tsx`): a nested
  dockview holding the transcript and the panels about *that* thread — Source Control, Plan, Agents,
  Details (`ThreadSection`, the inspector's readings one panel each), Terminal, Preview —
  **never the board**, which is the server's and not a thread's, so it always opens in the outer dock.
  **It opens as the transcript alone, and the transcript wears no strip** (`syncStrips`: a
  group holding only it has its header hidden); **every other panel comes from the + floating
  over it, and lands at its kind's own place** (`SLOT`: readings a column at the right edge,
  preview beside the transcript, a shell under it — later ones join that group).
  **It is one surface, not a dock of cards**: panes are flush and meet at a hairline, and the
  other panes' strips are title bars — bare tabs, an underline in front (`.dock-nested`).
  Each thread keeps its arrangement on this device (`lib/workspace/thread-docks.ts`).
  **A closed world**: nothing crosses between it and the outer dock (dockview refuses a
  foreign drop by default), which is what the removed group panel lacked. **A hidden chat tab
  is `display: none`** (`ChatPanel`), because the inner dock's `always` overlays escape the
  outer's `visibility` and drew over every other tab. Its panels get a `DockContext` of the
  thread dock's own, so a terminal's restart, close guard and a preview's helper land inside.
  **A thread's shell starts in `threadCwd` and dies with the thread** (`sessionId` on the
  terminal, `killSessionTerminals` on trash and purge). With a thread in front, every opener —
  the outer +, ⌃`, the palette — routes terminal and preview into its dock
  (`threadDock`); the outer kinds remain for a page in front. **On a phone
  it is the same dock, stacked**: every panel is a tab in the transcript's group, nothing
  splits or drags, and a wide layout folds on the way in (`stack`). "Open in inspector"
  opens the reading's panel (`InspectorContext`).
- **Hunk actions reuse the existing doors** - stage is the `apply` git route (`cached`, a patch cut by `lib/workspace/diff-patch.ts` from git's own diff; the Monaco diff's `HunkBar` cuts its own with `lib/workspace/hunks.ts`), and git's preimage check refuses what moved.
- **Reverting a turn restores exactly its paths to its start tree, in the working tree only**
  (`git.revertTurn`, `POST …/turn-changes/:turnId/revert`): written out of a scratch index,
  **never the real one**, never another path. It **refuses (409 with the paths) when any of
  them changed since the turn's end tree** unless `force`, and refuses while a turn runs.
- **The thread graph (`/graph`) fetches nothing of its own**: the session list for threads,
  asks and harness steps, the held threads' transcript rows for their own subagents and
  workflows (`threadGraph`, `lib/thread/thread-graph.ts`), and `agentState` over
  `threadStatus`. **One worker is one node** — a transcript head whose `sessionId` is a listed
  session is that session, and a harness run is `workflow:<runId>` from either side. **A list's
  live state for a thread with no socket is the server's snapshot of its bridge** —
  `waiting`/`held`/`context` on `GET /api/sessions`, derived in `list()` and never stored — and
  **the live thread outranks it** wherever a tab holds one. The snapshot moves only when the
  list is re-read, so the page re-reads it every 10s while visible, and holds a connection to
  at most 12 active top-level threads so their workers load.
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
- **The composer is about what you type; everything about the state of the thread is at the
  foot of the transcript.** The wait, the working line, a held turn, an approval, a question,
  the queue — and **this device's connection** — are all at the foot of the transcript
  (`thread-view.tsx`), where the next thing happens. The connection is a `Notice`
  (`components/thread-view/thread-status.tsx`), not a reading: it is a sentence with a button, readable
  in place, and it used to be one on the shelf's floor, where it took the shelf's own ground
  with it. **So nothing on the shelf is ever wrong** — no `tone` prop, no `--shelf-*` token,
  one `GROUND` — and the shelf holds only facts about the thread (`footer`) or about the
  message being typed (the pile). **A footer reading is a mark that grows words**: icon
  always, label `@panel-sm` only, and its count as a text badge where the label shows and a
  bubble on the mark where it does not.
- **A thread that is not ready or has stopped always says which, and always has a control.**
  A reconnect is calm (`info`) and an error only once parked; a failed revive, a failed
  restart and a parked ladder each name themselves, with the cause folded and Copy on the card.
  A wait that lasts (`CLOCK_MS`) shows its clock and a Cancel (`actions.cancelWait`, which
  abandons the request — the words go back to the box, the server finishes what it began). A
  missing agent (424) is a setup step: the install line, Settings › Agents, and a mark in the
  draft's agent picker from `useAgentsStatus`. A turn the process ended under is "The agent
  stopped during this turn" with Continue/Retry. **A failure recorded in the thread is never
  toasted as well** — `resume` and `reconnectThread` record, their callers stay silent.

## Tasks → `docs/tasks.md`

- **A board is a project of work, not a kanban**: it owns its key, columns, sprints, saved
  views and custom fields. **A column's `category` is what the harness knows** — everything
  counting "done" reads `completed_at`, never the column name. `wip_limit` is advisory.
- **The tree is `parent_id`**, same board only, never a descendant; deleting a parent
  *detaches*. Every change is written to `task_activity` — **history is recorded, not
  diffed**. **No foreign keys**; every cascade is by hand.
- **A thread started on a task carries `sessions.task_id`, and the agent writes back through
  `builtin:harness`.** Who wrote a comment or an activity row is said by the loopback
  (`x-harness-actor`), never by the agent's own `author`. The card moves to in-progress when
  the first turn starts and is **never** completed by a turn ending — that is the agent's call.
  → `docs/tasks.md` "Agents and tasks".
- `lib/tasks-view.ts` is the pure half; how a board is *read* is device-local, a *saved* view
  is the server's. Every view takes the one `ViewProps` contract and never touches the cache.

## PWA and notifications → `docs/pwa-and-notifications.md`

- **One service worker (`client/src/sw.ts`), and no Firebase inside it** — the browser
  restarts the worker per event, so only top-level code is guaranteed to have run. **The push
  payload is a contract: data-only**, carrying `title`/`body`/`sessionId`.
- Updates are `registerType: "prompt"`: the new worker only `skipWaiting()`s on the user's
  Reload.
- **A notification click steers the open window in the page, never reloads it**: the
  worker posts `OPEN_PATH` to the window it controls and the route effect opens the tab;
  `navigate()`/`openWindow` are only for a window it does not control, or none.
- **Registering for push is reversible and the reverse must reach the server.**
- `new Notification()` is not available everywhere and push does not cover the gap; both paths
  build their options in `lib/notification-shape.ts`. In Electron the OS layer is Electron's
  own `Notification`, preferred with **no permission check**.
- **A backgrounded page is not a detached one, and only the page can say which it is**: only
  the turn-end push gate reads `watchers(session)` — fan-out, idle sweep and peer counts still
  count sockets. It is `freeze`/`resume`, not `visibilitychange`.

## Ops: git, quota → `docs/ops.md`

- **A project is a directory, and a directory is not one git repository.** `server/src/git.ts`
  addresses a `RepoContext`, never "the project's git".
- **An isolated thread runs in its own worktree, and where a thread runs is `threadCwd`**
  (`sessions.worktree`, project-relative `.daedalus/worktrees/<id>` on branch
  `daedalus/<id>`): spawn, bridge cwd, snapshots, `!` lines and materialisation (unioned per
  *thread* cwd) all ask it, never `project.cwd`. Made before the thread exists, only at a
  repository root, ignored via `.git/info/exclude` — **never the user's `.gitignore`**. The
  column never moves; archiving leaves the checkout, removing it is its own route and refuses
  uncommitted work unless forced.
- **The file library is one `files` table: folders and files in a tree, `parent_id` NULL is the
  root** (`server/src/files.ts`, `routes/files.ts`, Settings › Files). **Bytes are a
  `StorageProvider`'s** (`storage/provider.ts`: `local` default, others implement the one
  interface and a line in `PROVIDERS`); a row records its provider, so they mix. No FK on
  `parent_id` — delete is a recursive walk that releases bytes only when no other row shares
  them. **A copy is a row, never bytes** (`copyFile` points at the same key). The client's one
  surface is `FileExplorer` (`components/files/`: tree, list/grid, details, search, desktop
  keys and drag-and-drop; how it is drawn is device-local, `explorerPrefs`), and **its preview
  reuses the workspace Preview panel's converters** (`office-preview.ts`, `Slides`, `Prose`,
  `Highlighted`) — a blob opened in a tab is only ever an inert type, since a blob URL has the
  app's origin. Its one chooser is `FilePicker` over it in pick mode: the
  composer's "From library" (`multiple`; bytes → `File` → the ordinary attachment path) and
  every logo field's Upload (one; → `logoFromFile` → a small `data:` URL on the row).
- **Subscription quota is read by asking the runtime's own CLI, out of band**, naming the
  plain CLI and never the ACP binary. **"No quota" is an answer, not a failure** — never a
  zeroed bar.
- **The provider's plan is read from the profile, which outranks the agent's probe.** The
  adapter owns the endpoint; an unknown `kind` throws rather than falling through. Settings ›
  Usage is the only surface that lists plans — and, on its Spend tab, the `model_calls`
  ledger (`GET /api/usage/calls`); a thread's own reading is its Trace panel. → `docs/ops.md`.
- **A profile preset is a starting point, never a stored kind**: nothing about it is saved on
  the profile.

## Changelog → `CHANGELOG.md`

- **Nothing is committed without its changelog line.** Before every commit, add each
  user- or developer-visible feature, change, removal or fix the commit carries to
  `CHANGELOG.md`, under `## [Unreleased]` (create it above the newest release if absent),
  in a `### YYYY-MM-DD` section for the day the work was done, newest day first. Check the
  diff, not your memory of the session: work from other threads in the tree goes in too.
- **One line per bullet** — `server/src/meta.ts` parses the file line by line for
  `GET /api/meta` — led by a bold sentence stating the new behaviour, then what it does
  and how. Name removals as removals; skip pure churn (formatting, lockfiles, test drift).
- **A release** renames `[Unreleased]` to `[x.y.z] - date` and bumps the root
  `package.json` in the same commit; the day sections stay as they are.

## Testing

- **No visual testing**: don't drive the UI with Playwright/browser automation or take
  screenshots to check work. Verify with `tsc -b` and reasoning about the code; the user
  checks the UI.

## Where the detail lives

| File | Covers |
| --- | --- |
| `docs/architecture.md` | server, storage, the `agent/` runtime, agent registry/seeding, deploy, schema push, dev tunnel |
| `docs/protocol.md` | ACP bridge, thread open, replay/windowing, session ids, import, capabilities, subagents |
| `docs/profiles-and-config.md` | profiles, models, live reconfiguration, queue, gateway shim, option probe |
| `docs/mcp-and-workflows.md` | built-in MCP rows, the MCP OAuth shim, workflows, link ownership |
| `docs/client.md` | state ownership, theming, palette, sidebar, tool views, shortcuts, errors, toasts, dock, project page |
| `docs/pwa-and-notifications.md` | service worker, FCM, notification shape, backgrounded pages |
| `docs/tasks.md` | boards, keys, columns and categories, the parent tree, activity, sprints, links, custom fields, views |
| `docs/ops.md` | git, agent quota, provider plan usage |
| `agent/docs/` | the Daedalus Agent runtime: prompting, managing it from the harness, standalone use |
