# ACP bridge, replay & sessions

_Extracted from CLAUDE.md; the rationale behind the rules summarised there._

## The server is the ACP client

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

## Opening a thread over HTTP

- **A thread is opened over HTTP, and no socket follows: one is opened by an outgoing
  message and by nothing else.** Opening a thread is a *read*, and it used to be paid for as a
  connection: a WebSocket handshake, an attach, and a paced stream of replay frames
  before the first line of the transcript could be drawn. `GET /api/sessions/:id/replay`
  (`SessionSocket.snapshot`, exposed as `SessionManager.snapshot`) answers the **same
  bracket as one document** — `{attached, frames, caughtUp}`, where the three fields are
  literally the socket's own `attached` / `replay` / `caught_up` events — and
  `ThreadSocket.load` folds it through the very same `handle` switch, so the rule above
  still holds: one replay, one parser, one set of callbacks, and a field added to
  `attached` reaches both transports at once. The body is a generator of pre-serialized
  frames spliced straight in, so a replay is still never parsed and re-emitted on the
  server and a long thread is never held whole there — the same budget `sendFrame` pays
  on the socket. What the read does *not* have is a peer: nothing is registered on the
  session and a turn journaled while the body streams is simply not in it. That is the
  design rather than a gap — `caughtUp.cursor` is the `to` the document was bounded at,
  and the socket `startThread` opens next **resumes from exactly there**, so the gap
  arrives as the delta it is, on the connection that can also carry what comes after it.
  Two consequences. The socket that follows a send is a resume, which reports `earlier: 0` and a
  `from` that is this device's own cursor — both true about a delta and both wrong about
  the window — so `handle`'s `attached` case keeps the window it already folded when
  `resumed && this.loaded`, or finishing an open took the "Load earlier steps" button off
  every windowed thread. And **no open of any kind attaches a socket** — the archived
  thread's rule generalized: a peer that never sends is a connection held open for the
  duration of somebody's *reading*, on every thread the dock has mounted, against a server
  that counts peers to decide what to retire and whether to push. `ConnectOpts.revive`
  is what asks for one (a send, a revive, a reconnect the user pressed) and a view-open
  never sets it, so `ThreadConnection.start(cursor, live)` stops at the document and
  `reduceConn` lands on the new `{kind:"read"}` phase — read, up to date, deliberately
  unattached, which `composerLock` and `bannerFor` both treat as ordinary, since sending
  is what connects. `ready()` is the one door: `read`, `archived`, `idle` and `failed` all
  reach a live socket through it, so the refusal a send used to hit is a step the client
  takes instead. Two exceptions, both the server's to state rather than the client's to
  guess. A read whose `caught_up` says `promptActive` **does** attach: a running turn's
  answer arrives on a socket or nowhere, and a permission the agent is blocked on rides
  the same wire. And a command that is not a prompt — a queue edit, a mode change, a
  config pick — opens one lazily inside `ThreadSocket.request` (`ensureSocket`), which is
  the archived thread's old queue path, now the general one; it still refuses to reopen a
  socket that *died*, because that is a failure to report rather than a peer nobody asked
  for. **A dropped socket is no longer answered by the reconnect ladder**: `onStatus` says
  the close once, with the server's own reason and a Revive/Reconnect button, and the
  ladder is only ever re-entered by an attempt the user asked for (`ready`'s `parked` /
  `reconnecting` cases), which is what the health poll and the `online` listener still
  un-park. Nothing reattaches — or respawns an idle-retired agent — behind the reader's
  back. The two things a reader does to a socketless thread are still
  answered without it — paging back over `GET /api/sessions/:id/earlier`
  (`requestEarlier` picks the transport it already has), and editing a queue parked on it
  through a socket `ensureSocket` opens lazily at that moment. `openNow`'s short-circuit reads
  `isArchived` **and the `read` phase** beside `connected`, so navigating back to the
  route — or a row flipping to `exited` under it — does not re-fetch a transcript the
  store already holds. A failed read
  falls through to the socket rather than failing the open (an older server has no route),
  and the resume point is `max(asked, journalCursors)` — monotonic, so a read that failed
  *part way* continues after what it managed to fold rather than folding it twice.

## Live and replay are one code path

- **Live and replay are one code path.** `attached` and `caught_up` bracket the replay, and
  everything between them is the same event the live socket sends, so the client has no
  second parser. The bracket is
  load-bearing: without it a reload re-fires a desktop — and, with nobody watching, a push —
  notification for every turn in the thread. `session_config` carries **absolute** state,
  which is what makes it safe to journal and broadcast at once; never make it a delta.
  **Where the replay starts has three sources and only one meaning per attach**, which is
  why `attached` states it rather than leaving it to be inferred from `from > 0`: a fresh
  attach starts at 0; a *resume* starts at this device's own cursor (`journalCursors` /
  `resumeCursor` in `actions.ts`, so a dropped socket costs a delta and not the thread) —
  **which has to move with every journaled event, not be written once at `caught_up`**, the
  bug being that a cursor frozen at attach time described a transcript an hour out of date,
  so the resume asked for a delta the device already had and the whole hour was folded onto
  the end of itself a second time (`ThreadSocket.cursor`, raised in `handle` and not in
  `fold`, since a `load_earlier` re-fold runs events this cursor is long past); and
  a *windowed* attach starts wherever the server chose, because the thread was longer than
  `REPLAY_WINDOW_STEPS` **or heavier than `REPLAY_WINDOW_BYTES`** — two budgets, whichever
  binds first (`SessionJournal.windowStart`), because a step is a turn and a turn is not a
    size: one is a sentence, the next is a build log streamed through
    `_meta.terminal_output_delta`, so a handful of them is a screenful on one thread and megabytes
    on the next, and it was the second that left someone watching a spinner. Bytes is the
  budget `REPLAY_CHUNK_BYTES` already runs the *frame* cut on, for the same reason and on
  the same payloads; the window simply never had one. Steps are applied first, so the byte
  pass never measures more than the step window would have sent anyway, and it reads
  `length(payload)` rather than the payloads — the replay is sized without being
  materialized. **The window and every `load_earlier` page are counted in steps
  (turns), never events**: the server cuts only at journaled `turn_started` seqs
  (`SessionManager.turnStartAt`/`earlierPage`), so `attached.from` is always a turn's
  opening event and a page is whole turns — an event-counted cut landed mid-turn and the
  re-fold opened a half turn the reducer had never seen begin. `earlier` counts withheld
  turns. **A log does not have to begin with a `turn_started`, and that is the case the
  cut has to be written around**: a revive clears the journal and refills it from the
  `session/load` replay, which is the entire prior conversation with no turn boundaries in
  it, so the first `turn_started` is the turn taken *after* the revive. So the window is
  applied **only when a turn is actually being withheld** (`countTurnsBefore(cut) > 0` in
  `windowStart`) — jumping to "the first turn of the window" unconditionally looks
  equivalent and is not: a revived thread of one turn, far inside any window, replayed from
  that turn's seq and dropped everything the load had put back, while `earlier` said 0
  (there are no whole *turns* behind it) so nothing offered it back either. A server crash
  and the revive after it lost the conversation on screen with every event of it still in
  the table. For the same reason that head is not stranded at the other end: it is not a
  turn and so can never be a page of its own, so the `earlierPage` that reaches the oldest
  turn extends to seq 0 and takes it along. The first two replace the transcript, the third also replaces it — but
  `from` is large in the second and third alike, so `resumed` is a field and not a
  comparison. `earlier` says how much was withheld, and `load_earlier` fetches it a page at
  a time — **fetched before it is asked for**, when the top of the transcript comes within a
  screenful of the viewport (`prefetchEarlier`, an IntersectionObserver on the "Load earlier
  steps" row): paging back is a round trip plus a re-fold, only the round trip can be paid
  in advance, and it stays a button rather than becoming an infinite scroll because a
  re-fold moves the scroll position under the reader. Folding one of those pages is the
  awkward part: the reducer only appends, so an
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
  memory rather than the whole transcript, in **bytes as well as rows**: the DB page is
  sized from the last one's average event, since five hundred rows of terminal output is
  25MB fetched to emit five frames of five, which is the peak the paging exists to bound.
  **The frames are also paced against the socket** (`SessionSocket.sendFrame` awaits each
  write): pushing the whole window at a slow peer held it in this process's memory until it
  drained, and running the loop to completion meant one attach to a heavy thread got every
  tick before any other thread's turn did. Pacing it means it **yields**, which is a second
  rule and not a detail — a turn can now be journaled between two frames. So the replay is
  bounded at the `to` that `attached` names, everything past that reaches the peer as the
  live event it is, and a peer mid-replay holds its fan-out in `Peer.pending` until
  `caught_up` has gone out. Without the bound the trailing page and the buffer would each
  send that turn; without the buffer it would arrive before the history it follows. The
  attach bracket itself (`attached`, `caught_up`, replies) writes past the buffer, or the
  line that opens the replay would be held until the replay had ended. `session_events`
  carries a **partial index on the turn boundaries** (`session_events_turns`, `where kind =
  'turn_started'`) because every structural read is the same question — where do this
  session's turns begin — and one attach asks it four times: on the busiest thread in a real
  install (97k events) that is 16ms a call against a covering-index lookup's 0.01ms, and the
  scan was reading the terminal output and diffs it was skipping past. The socket is
  compressed above 8KB (`perMessageDeflate`, `threshold`), which is the frames and not the
  streamed `update`s: a frame is self-similar JSON that deflates five to ten times over, so
  this buys window back rather than trimming it, while a few hundred bytes of streamed text
  arriving thousands of times a turn would pay more for zlib than it saves.
  It is a container, not a fifth journaled kind: `attached`/`caught_up` still bracket it and
  `thread-socket.ts` unrolls it back through the same switch, so there is still one parser.
  It is **opt-in** (`?batch=1`, which `wsUrl` sets): a client that predates the shape would
  drop the frame, and with it the `caught_up` inside, leaving a thread that never finishes
  connecting rather than one that merely renders slowly. The client folds it to match: the
  bracket also opens and closes a **buffer** in `makeCallbacks`, so the history commits in
  `batch` actions — **one per frame** — rather than one render per event of a transcript
  nobody has looked at yet. It used to be one commit for the whole replay, which overshot in
  the other direction: the screen stayed empty for the *entire* wait, so a long thread said
  nothing until it could say everything. A frame is the server's own cut and a handful of
  them carry a window, so committing per frame paints the transcript progressively and still
  costs an order of magnitude fewer renders than an event at a time — `commit` keeps
  buffering where `flush` closes the buffer, and the array is replaced rather than emptied,
  since the actions in it have just been handed to the reducer. Each frame also raises
  `onReplayProgress`, counted against the `to` that `attached` now states — where the replay
  *ends*, which is a real bound on it and not just a reading of the log, so the count cannot
  be outrun by a turn streaming while the client connects — which is what
  turns the wait into a quantity: `ThreadState.replay` drives a bar in `StartingLine` instead
  of a line apologising for a length it had no evidence for. Before `attached` the client
  knows nothing about the thread's *size* (the wait is the network, the socket, or a server
  busy with another thread's turn), so that case says so instead, and a replay the server
  never sized — or one too short to be felt — draws no bar at all, on the service worker's
  rule: a spinner is how "not known yet" is said, and a bar against no total is a lie that
  jumps. Which is why everything thread-scoped in there goes through `send`, never
  `dispatch` (a direct dispatch jumps the queue and lands ahead of the `thread-reset` still
  sitting in the buffer — `recordError` takes the sink as an argument for exactly that
  reason), and why a socket that dies mid-replay flushes too: `caught_up` is the ordinary
  exit from the replay, not the only one. It also means a callback cannot read the state its
  own replay is building — `session_config` leaves `configOptions` out to mean *unchanged*
  and the **reducer** resolves it, because the value the callback would have read has not
  been committed yet.

## ACP schema is the source

- ACP schema is the source for modes/config options/usage — render generically, don't
  hardcode per-agent knowledge in the client.

## The SDK seam

- **The ACP SDK is named in one file per half**: `server/src/acp.ts` and `agent/src/acp.ts`
  are barrels over `@agentclientprotocol/sdk`, and the client reaches the same vocabulary
  through the `@daedalus/acp` tsconfig path onto the server's. Everything else imports
  `acp` from there — type-only in ~40 files, at runtime in exactly five: `acp-bridge.ts`
  (`acp.client()`, `ndJsonStream`, `methods`, `RequestError`, `PROTOCOL_VERSION`),
  `probe.ts` and `session-list.ts` (`acp.client().connectWith`), `agent/src/app.ts`
  (`acp.agent()`) and `agent/src/index.ts` (`ndJsonStream`). The version is **pinned
  exactly** in all three manifests, because the behaviour below is version-sensitive and the
  three installs are separate. `test:acp-units` asserts the runtime surface and the
  method-name table, so an SDK release that moves a symbol fails there rather than in a
  spawn.
- **A barrel is a rename shim, not an abstraction.** It makes swapping the *package* a
  three-file change; it does nothing for swapping the *shapes*. What a replacement must
  carry is the whole of `protocol.ts`'s vocabulary (`SessionUpdate`, `RequestPermissionRequest`,
  `CreateElicitationRequest`, `SessionConfigOption`, `SessionModeState`, `Usage`, …) plus
  the calls the bridge makes: `initialize` with our capability set (see "Capabilities we
  advertise"), `session/new`, `session/load` (the one resume path), `session/list`,
  `session/prompt` twice in flight for steering, `session/cancel`, `session/set_mode`,
  `session/set_config_option`, and the client side of `session/update`,
  `session/request_permission`, `elicitation/create` and `elicitation/complete`. An adapter
  that pre-interprets the update stream into a chat-shaped one — Vercel's
  `@ai-sdk/harness-acp` is the reference case — cannot sit behind this seam: it drops
  steering, compaction, per-turn usage, arbitrary config options, elicitation forms,
  `session/list`, the subagent RFD and `session/load`, requires a network sandbox with an
  exposed port instead of a local binary, and does not export the schema types, so the SDK
  would stay a dependency regardless. It would fit as an *additional* transport (below),
  never as a replacement.
- **The transport is the bridge's constructor argument, not the process.** `AcpBridge`
  takes an `acp.Stream`; `agentStream(proc)` is the ndJSON-over-stdio factory the one
  caller (`SessionManager.spawnAgent`) and the probe build, and it is where the inbound
  frame rewrite for the subagent RFD lives. A socket to a remote or sandboxed agent is a
  second factory beside it, with the protocol handling untouched. The caller keeps the
  process — stderr, exit, kill — and the bridge keeps only the conversation.
- **One fact, two workarounds, both of which any replacement must carry**: the SDK's
  generated schema is a *closed* union. On the client side `acp.client()` validates every
  `session/update` in a router that runs before any handler, so `agentStream` re-addresses
  the RFD's `subagent_spawned`/`subagent_state_update` (and our own
  `_daedalus/subagent_usage`) to `_daedalus/subagent_update` on the way in — see
  "Subagents". On the agent side the same schema *strips* capability keys it has not heard
  of, `subagents` above all, so `agent/src/app.ts` registers `initialize` with an identity
  parser. They are the same knowledge in two places because the two halves share types and
  nothing else; both go away the day the SDK's union carries the RFD.

## The client mints session ids; threads start as drafts

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

## An agent session id is earned, not announced

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

## Importing a thread

- **Importing a thread writes a pointer, never a transcript** — which is why the feature is
  two routes and no new lifecycle. Work started in `claude`, `codex` or `opencode` outside
  the harness is a real conversation in that agent's own store with nothing here naming it,
  and naming it is the whole of what a thread *is* (the rule above). So
  `POST /api/sessions/import` writes rows — `acpSessionId` set, `acpSessionProvisional`
  false, `exited` true, no process — through `SessionManager.importSession`, which is
  `create()` minus the `start()` (both build the row through the same `blankSession`). The
  row that leaves is exactly the shape an idle-retired thread has after a restart, so
  **opening it is the existing revive path**: `openThread` sees `exited && cursor === 0`,
  respawns, and `session/load` streams the conversation back as ordinary journaled updates
  that index for search and replay from then on. Nothing in the store, the reducer or the
  socket learned a word about imports. One round trip however many are picked, because none
  of them spawns anything. The listing is the other half and it is **ACP's own
  `session/list`** (`server/src/session-list.ts`), never a runtime's files: all three
  runtimes implement it (verified against claude-agent-acp, codex-acp 1.7 and opencode
  1.18), reading `~/.claude/projects/*.jsonl` or a rollout directory would be exactly the
  per-agent knowledge this codebase refuses to carry, and an agent that does not advertise
  `sessionCapabilities.list` — or answers `-32601` — comes back `{supported: false}`, which
  is an answer the dialog prints in words rather than an error. It asks with **no `cwd`
  filter** and follows `nextCursor` inside the one spawned process (`MAX_LIST_PAGES` /
  `MAX_LIST_SESSIONS`, `truncated` when the budget runs out), so the answer is machine-wide
  and each entry carries the directory it ran in: `components/import-threads.tsx` groups by
  that cwd, maps each to a project, and offers "Add project" for a directory the harness has
  never been pointed at — a conversation has to have a cwd to run in, and that is what a
  project is. Rows whose `acpSessionId` a thread already holds come back marked `existing`
  (deleted ones included, so a thread in Trash reads as Trash instead of being imported
  twice). The spawn/handshake/deadline/kill scaffolding is `withAgentConnection` in
  `probe.ts`, shared with the option probe — with one deliberate asymmetry: the probe
  materializes the profile's skills and model allowlist because it is about to open a
  session in that cwd, and the listing, which opens none, materializes nothing. The dialog
  defaults its scan to the agent's **virtual Default profile**: a listing is about the
  machine's own login, and codex filters its thread list by the spawned profile's model
  provider, so a gateway profile can answer with none of the CLI's work.

## Capabilities we advertise

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

## Subagents

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

## stderr in errors

- The server splices the agent's stderr into errors on the way out
  (`SessionManager.enrichError`, `data.stderr`) — "Internal error" is a code, not an
  explanation, and the explanation was only ever on stderr. When the process dies mid-turn
  the SDK rejects instantly with "ACP connection closed", which explains nothing while the
  stderr that does has not finished arriving — so the bridge **holds** that turn until
  `close(reason)` (called after `EXIT_DRAIN_MS`) has both the reason and the output.
  `GET /api/sessions/:id/stderr` exposes the tail. `app.onError` turns every route throw
  into the `{ error }` shape the client already parses.

## Test agent

- Test agent: `server/test/fake-agent.mjs` (registered as `fake-echo`), drives the UI without
  credentials. It answers raw NDJSON, which the SDK on the other end is happy with — it
  validates inbound `session/update` params but not responses.
- **It reaches a real install through `pnpm fake:agent`** (`test/install-fake-agent.ts`),
  which writes the `fake-echo` row into `data/daedalus.db` and nothing else. There is no
  `POST /api/agents` — an agent row is a contract with a binary somebody else ships, so the
  API only edits and resets seeded rows — and the fake is deliberately not in
  `DEFAULT_AGENTS`: seeding is what every install gets, and a test double is not something to
  ship into other people's pickers. Restart the server, start a thread on it (profile
  *Default*), delete the row from Settings › Agents when done.
- **The transcript is developed against it, so its samples are grouped into scenes.** An
  ordinary prompt streams `default` — the step rows plus the two subagent mechanisms — and
  `scene:<name>` streams one on its own (`steps`, `subagents`, `questions`, `other`,
  `workflow`, `all`; a bare `scene:` lists them). Everything else stays keyword-driven:
  `echo:`, `attachments:`, `perm:<kind>`, `perm-noallow`, `elicit:`, `ask:` (a full
  AskUserQuestion form — titled options with previews, an "Other" companion, a multi-select
  — answered back as the settled tool call that records the pick), `plan:` (a `switch_mode`
  permission carrying markdown), and the words `permission`, `fail`, `crash`, `compact`.
- **The default turn is deliberately not the whole catalogue.** A turn is the unit the replay
  window is measured in, so a fake turn heavy enough to pass `REPLAY_WINDOW_BYTES` would
  change what every windowing test is testing.
- `scene:workflow` fakes what the *server* stamps, not what an agent says: RFD spawns
  carrying `_meta.daedalus.workflow` (run id, the definition's whole outline, the phase) and
  the per-step `_daedalus/subagent_usage`. No runtime emits these — a real run is the
  harness's own engine — and without the scene the run row could only be seen by running a
  multi-step workflow against a real provider. `_daedalus/subagent_usage` is listed in
  `SUBAGENT_UPDATE_KINDS` for that reason: the SDK's closed union would otherwise drop it
  before the bridge saw it.
