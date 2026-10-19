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
  them. Five are journaled and replayed on attach — `update`, `session_config`,
  `config_notice`, `turn_started`, `turn_ended` — and the rest are live-only. A permission or elicitation is
  **not** journaled: it lives in `bridge.pending` for exactly as long as the agent is blocked
  on it, so a peer attaching mid-question is handed what is still open and an answered
  request simply is not there. First answer wins; a loser is told directly so its card still
  clears. `settleAll` answers everything when the process dies, because the agent's promise
  is held here now and nothing else would ever settle it.
  The one thing the server still does not interpret is a `session/update` payload — it
  forwards them whole.

- **The cross-thread inbox reads `bridge.pending` and nothing else.** `GET /api/pending`
  (`SessionManager.pendingAll`) lists every open permission and elicitation on every live,
  undeleted thread, oldest first (`askedAt`, stamped on the entry in `park`) — there is no
  journal to read it from, by design. `POST /api/sessions/:id/pending/:requestId
  {optionId}` answers a **permission** by one of the options the agent offered
  (`answerPending`), and it is `bridge.answer(requestId, response)` with no origin peer: the
  same first-answer-wins settle a socket's `answer_permission` takes, so every attached peer
  gets `request_answered` (none of them caused it) and a slower answer gets a 409. An
  elicitation is refused there — its fields are drawn in its thread.

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
  takes instead. The door does not trust the row it was handed: `start` returns the server's
  own `archived`, and a `revive` open that comes back archived **spawns** rather than stopping
  at the document — the row is a list read a moment ago and is not the authority on whether a
  process is behind the thread, so a thread that was retired (or whose agent died) between
  that read and the archive read used to be left with no process and nothing coming, and every
  send answered "stuck reading from the archive with no agent running". One retry, and a
  second archive answer is a real error rather than a circle. Automatic rungs are unaffected:
  they ask with `revive: false`, so nothing respawns behind the reader's back. Two exceptions,
  both the server's to state rather than the client's to guess. A read whose `caught_up` says `promptActive` **does** attach: a running turn's
  answer arrives on a socket or nowhere, and a permission the agent is blocked on rides
  the same wire. And a command that is not a prompt — a queue edit, a mode change, a
  config pick — opens one lazily inside `ThreadSocket.request` (`ensureSocket`), which is
  the archived thread's old queue path, now the general one; it still refuses to reopen a
  socket that *died*, because that is a failure to report rather than a peer nobody asked
  for. **A dropped socket is answered by the ladder, and never by a
  respawn.** The close code is what splits it (`isRecoverableClose`, beside `failureFor`
  in `lib/thread/phase.ts`): 4000, 4001, 4002 and 4004 say something about the *thread* —
  it is gone, its process exited, another device took it — and those are still said once,
  with the server's own reason and a Revive/Reconnect button. Anything else (no code at
  all, a bare 1006, the client's own watchdog code 4100) says only that the path died,
  which is a server restart or a network blink, and both come back — so `onStatus` books
  the ladder, and when the five rungs are spent the thread *parks*, which the health poll
  and the `online` listener un-park the moment the server answers. **1001 is the exception
  that is announced**: the server closes with 1001 and says it is restarting (over a durable
  sandbox, that its agents keep running), so the ladder gets twelve rungs (~70 s,
  `RECONNECT_MAX_ATTEMPTS_RESTARTING`, sticky for that outage) and the banner says
  "The server is restarting" without counting — parking at ~16 s drew an error over a thread
  that was about to be fine. Over a durable sandbox the server also skips its fixed 2 s
  shutdown drain (`DURABLE_SETTLE_MS`), which exists only for direct children's SIGKILL
  escalation, and `attach`/`snapshot` wait for a thread held for boot adoption
  (`whenAdopted`, 20 s) so an early reconnect is handed the live thread. What an automatic rung
  does NOT do is put a process back: it opens with `revive: false`, so a live agent gets
  its socket and an idle-retired one is read from its journal and left `read`, sendable,
  with the revive still the user's to ask for. (A retired thread with no journal to read
  is the one rung that stops: there is nothing to reattach to, so it reports the failure
  with a Revive button rather than climbing.) A rung that succeeds clears the ladder even
  when no socket came up, since the `read` outcome never raises `connected`. `revive()` —
  the button, and `ready`'s `parked`/`reconnecting` cases — is unchanged: it clears the
  counters and asks for the process. The two things a reader does to a socketless thread are still
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
  turns. **The turn rail never pages for its ticks**: `attached` also carries `turns`, the
  journal's whole turn list (one `turn_started` + excerpt per turn, oldest first, including
  the turns withheld behind `earlier` — `SessionJournal.turnTicks`), so the rail draws
  every tick up front and a jump to a withheld turn pages back to its seq first. Omitted
  on a resume, where the client already holds the thread. **A log does not have to begin with a `turn_started`, and that is the case the
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
  both ends. **A run of streamed chunks is replayed as the one event it draws**
  (`SessionJournal.coalescedPage`), which is where most of a long thread went: a model
  streams its reasoning a few characters at a time and every delta is a journaled event, so
  one turn on this install's largest thread is 81,686 `agent_thought_chunk`s holding 0.33MB
  of text inside 15.1MB of envelope — an average of 4.1 characters each — and the client
  folds every one of them straight back into the single item they came from (`appendText`).
  Merged, that windowed replay is 545 events and 1.35MB in place of 82,978 and 17.9MB, and
  the transcript is identical. **The merge is a read, never a write.** A journal that merged
  on the way in would have to answer a socket resuming *inside* a run — the cursor is an
  event count and a merged row is one row for many of them — and every way of answering that
  either loses the run's tail or repeats its head; computed per request from rows nothing has
  touched, a resume simply merges what it asked for and the run is cut exactly where the
  cursor is. Postgres decides the boundaries — `lag` over a signature that is the whole event
  minus what the journal itself added to it (its `seq`, and the `at` stamp `append` writes on
  every row) and minus the text, so a runtime that starts sending a new key on a chunk breaks
  the run instead of being merged away. **The clock is on that list for the same reason the seq
  is.** Left in the signature, `at` made every chunk its own run — two chunks of one run differ
  in it whenever they land in different milliseconds, which is all of them — so a streamed run
  stopped merging into the one event it draws. The merged event stands at the **last** seq of
  its run, because the client advances to `seq + 1` and everything up to there is now in it,
  and it carries an **`endAt`**: where the run stopped being written. That is the half the
  client cannot see for itself — it holds one event per run, and an event's own `at` is when the
  run *began* — so `at` beside `endAt` is a step's measured length, and it replays: a reloaded
  thought says "Thought for 12s" instead of having no end to subtract its start from. A run of
  one row is left exactly as the log wrote it: nothing merged it, so there is no second end to
  state and a replay stays the log.
  Two things downstream are therefore counted and not lengths: `EarlierPage.from` states
  where a page begins (subtracting the page's length from the window left it short, and the
  next page would fold turns already on screen a second time), and the replay progress bar
  reads the last event's seq rather than adding up frame lengths. What is *not* merged still
  comes off the payload column **as text** and goes straight on the socket: it is already the
  JSON the browser needs, so parsing it to re-serialize it once per peer is work with no
  reader — the `::text` cast sits inside the `case` that selects it, so a replay pays it for
  the few hundred rows it sends rather than for every row it reads. `windowStart`'s byte
  budget counts the same way (a chunk costs its text, not its envelope), because counting a
  cost nothing pays withheld turns that would have fitted many times over. And the scan is
  paged, so a replay costs a page of
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
  arriving thousands of times a turn would pay more for zlib than it saves. **The HTTP
  document is compressed too** (`hono/compress`, on `/replay`, `/earlier` and the trajectory's `/spans` and
  nowhere else): the read moved off the socket and left the socket's compression behind, on
  the most compressible bytes this server sends — 1.35MB of frames go out as 302KB, and on a
  phone that is the whole of the wait. Scoped to those three because everything else under
  `/api` is a small JSON object, and because a codec must not sit between a line and the
  reader on the streaming routes.
  It is a container, not a sixth journaled kind: `attached`/`caught_up` still bracket it and
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
  turns the wait into a quantity: `ThreadState.replay` drives a bar in `ThreadStatus` instead
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

- **Current state is handed over on `caught_up`, never inferred from the replay.** The queue,
  the hold and a staged config change ride there because they are not journaled at all. The
  **context reading** rides there for a harder reason: it *is* journaled — every
  `usage_update` the agent sends is an ordinary `update` event — and folding those was still
  wrong, because a replay is a *window* onto the log and the reading is a fact about now. A
  tail of short turns can contain no `usage_update` at all, and the ring drew "—" for a
  thread the agent had just said was 80% full; a `load_earlier` page contains *older*
  readings, so scrolling up walked the ring backwards. So the newest reading is kept on the
  session and written to its row (`sessions.context`, set in `SessionManager.emit` at the one
  place every event passes, persisted by the turn-boundary `persist` that already writes
  `last_activity_at`), and `caught_up` states it after the replay, where it is the last word.
  A subagent's reading is its own step's and never the thread's — the same line the reducer
  draws. The one place with no `caught_up` behind it is a `load_earlier` re-fold, so
  `onRewound` puts the carried value back the way it puts `turnActive` back.

- **A replay that *replaces* a transcript commits once, not per frame** (`ConnectOpts.seamless`).
  The frame-by-frame paint above is right for an open, where there is nothing on screen and
  the alternative is a blank pane; it is wrong for a restart, where what is on screen is a
  correct rendering of this very conversation and the reader would be watching it be cleared
  and redrawn to end up where it started. So the restart path holds the whole rebuild —
  `thread-reset` included, since that is buffered too — and lands it in one commit at
  `caught_up`. The progress still reports, because the *wait* is real even when the change
  is not.
- **A restart is announced, and `kept` says whether it costs the reader anything.** The
  respawn's problem is that `session/load` re-narrates the whole conversation as ordinary
  updates, duplicating what is already journaled. There are two ways to answer that, and
  `restart.kept` is which one was taken.

  `kept: false` is the old bargain and still the fallback: the log is **cleared** and the
  load refills it, so every one of those re-narrated events is fanned out to the sockets
  that are still attached, where they are not news but the transcript already on screen said
  again. `ThreadConnection.restarting` gates `send`/`sendStream` for exactly that window and
  `"ready"` rebuilds from 0, every cursor into the replaced log naming nothing. Before this
  event existed only the device that had asked for the change knew to do any of that, and
  every other one appended the conversation to itself.

  `kept: true` — the ordinary case for a setting change on a live thread — **keeps the log
  and drops the narration instead**. The bridge already knows which updates are narration
  (`historyReplay`, set around the whole `session/load`), so `Session.quietLoad` is read at
  `SessionManager.emit`, the one chokepoint both the journal append and the fan-out pass
  through, and they are dropped where they are produced. Nothing is appended, no seq moves,
  every cursor stays valid, and the socket that was open across the respawn simply carries
  on: the client sets `restarting = false`, does no rebuild, and returns the phase straight
  to `live`. That is what makes a persona or agent change stop reloading the transcript —
  and it is also what stops the clear taking the journaled `turn_started`/`turn_ended` rows
  with it, which `rewindPoint`, the turn rail's ticks and every window are read from and
  which the load never restates. (Before this, changing a persona silently disabled rewind
  on that thread and emptied its turn list.)

  Kept only where the log really is holding this conversation, and the check is
  `restartWith`'s: a live process (so `pruneJournals`, which only touches threads with none,
  has not dropped the archive), a non-empty log, and no second respawn queued behind this
  one — a rewind's respawn *must* clear, because clearing and refilling is how it truncates.
  Stated on `"started"` as well as `"ready"`, because the client's deafness starts there and
  a peer that goes deaf on the kept path drops the new process's `spawn_config` and
  `session_config` with no reattach coming to state them again. And taken back by
  `historyLost` moving across the respawn: a load that came back **without** the
  conversation makes the journal a record of something the process does not hold, so that
  one answers `kept: false` and the rebuild it forces is how the news reaches a peer at all
  (`historyLost` is stated on `attached`).

  **A kept restart still has to be on the open chain, and that is the one thing it left
  behind.** `kept: false` ends in `openFromStore`, which *is* a chain link, so everything
  waiting on `ThreadConnection.settled()` waits correctly. `kept: true` opens nothing — that
  is its whole point — and `markReviving("config")` is raised from the socket callback
  instead, so the chain was idle underneath a phase saying a process was being replaced.
  `ready()`'s `default:` case handles an in-flight phase by awaiting `settled()` on the
  documented grounds that every such phase is raised inside `openNow`; with nothing on the
  chain that resolved in the same tick, the loop saw no progress and reported the thread as
  *stuck waiting for the agent to restart on the new settings*. It was masked only because
  `composerLock` refused to submit during `reviving` — which Retry, the palette and
  queue-send never went through, and which staging then removed on purpose. So the kept path
  takes a chain link of its own (`holdForRestart`, released at `ready`/`failed`/`destroy`,
  with a 60s floor so a socket dying mid-restart cannot wedge the chain forever). `ready()`
  needs no change; a send issued during a config restart waits it out and lands after it.

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
- **A revive resumes when the journal is whole, and loads when it is not.** ACP
  `session/resume` (stable 2026-04) reattaches a session **without replaying it**, which is
  the whole cost a revive used to pay twice: the agent narrated the conversation and the
  server cleared its journal to make room for the narration. `respawnNow` now keeps the log
  and asks for a resume (`BridgeOptions.load.resume`) whenever `Session.journalClean` says
  the journal *is* the conversation: written live by a handshake that succeeded in this
  server run, not pruned since, and not left behind by a load that fell back to a fresh
  session (`historyLost`). It is false at boot — an unclean stop may have lost the tail —
  so the first revive after a restart still clears and loads, and that load is what makes it
  true again. An agent that does not advertise `sessionCapabilities.resume`, or refuses one,
  gets `session/load` with its narration dropped (`quietLoad`); only if that fails too does
  the thread start fresh. A rewind passes `clear` — truncating is what it is for.
  **The clear waits for the spawn to be proven**: the load's events are held in
  `Session.loadBuffer` and the journal is emptied and refilled only once `bridge.ready`
  resolves, so a revive that fails (agent missing, handshake timeout) leaves the archive
  whole and readable. Whatever can be checked before the old process is closed — agent,
  profile, install — is checked first, and a failure after it ends `exited`, never a
  half-live session with no bridge.
- **A process is the pool's; a session is the thread's** (`acp-connection.ts`). An
  `AcpConnection` owns the child, its stdio and the one `initialize`; each `AcpBridge` is one
  session on it and routes by id (`ConnectionRoute.ownsSession`: its own id, the id a
  load/resume is asking for, and its subagents' ids). A frame about a session nobody has an
  id for yet — a `session/new` in flight — belongs to whoever is creating, so creations on a
  shared connection are serialised (`AcpConnection.create`). **Sharing is the runtime's to
  say** (`AgentDef.sharedProcess`): only one that takes a thread's env *per session* can
  share, because a process's env is fixed and most of a thread's env is its own (the gateway
  URL names the thread). claude-code does (`_meta.claudeCode.options.env`), so its process is
  spawned with none of the profile's env and every thread in one cwd keys the same one
  (`AcpPool.key` — command, args, cwd, env). Everything else gets a connection of its own and
  behaves exactly as before: the bridge closing is the process dying. On a shared one, a
  bridge closing is `session/close`, and the process is kept warm for `IDLE_TTL_MS` (5 min,
  acpx's default) with nobody on it; the draft's options probe asks on that same pooled
  process, so a thread's first message starts at `session/new` with `initialize` already
  paid. A resume of an id waits for that id's close (`whenClosed`): claude-agent-acp answers
  a resume of a live session from memory, without the new bridge's `_meta`. A crash takes
  every session on the process down (Zed's behaviour); a handshake that cannot finish on a
  shared process kills it, because the pool would hand the wedge to the next thread.
- **A barrel is a rename shim, not an abstraction.** It makes swapping the *package* a
  three-file change; it does nothing for swapping the *shapes*. What a replacement must
  carry is the whole of `protocol.ts`'s vocabulary (`SessionUpdate`, `RequestPermissionRequest`,
  `CreateElicitationRequest`, `SessionConfigOption`, `SessionModeState`, `Usage`, …) plus
  the calls the bridge makes: `initialize` with our capability set (see "Capabilities we
  advertise"), `session/new`, `session/resume` and `session/load` (the two resume paths — see "A revive
  resumes"), `session/close`, `session/list`,
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
  change, not a round trip: `actions.startThreadIn` mints a UUID, puts a `draft: true`
  `SessionMeta` in the store and navigates. `POST /api/sessions` (which accepts that id,
  rejecting non-UUIDs and collisions) is not called — and no agent process is spawned —
  until the first message, in `actions.send` — and that POST does not answer until the
  handshake is done, so a 201 means the thread is genuinely ready. **The first message rides
  that POST** (`prompt: {text, attachmentIds}`): the server starts the turn with no origin
  peer before answering `{id, turnId}`, the client tags its bubble with the turn and attaches
  `fresh` — no HTTP read in front, and the replay's journaled `turn_started` redraws the
  bubble (`seamless`). It used to follow over a socket opened afterwards, and a reload in
  that window lost words the composer had already cleared. A prompt that fails after the
  create is answered (`promptError`), not thrown — the thread exists. **A retry of the same
  id gets the first POST's answer** for ten minutes (the route's `creating` map), so a lost
  201 never becomes a 409 loop or a second prompt; past that a 409 makes the client adopt
  the server's row. **A handshake that fails collapses the thread in `start`, for every
  caller** — create used to leave it `exited:false` on a dead bridge with its child alive
  until the idle sweep. Everything that treats the server's list as
  the authority has to let drafts through: the `sessions` reducer **merges** instead of
  replacing, `refreshSessions` prunes against server ids **plus** draft ids, and
  `connectThread` returns early for a draft since there is nothing to connect to. A route
  for a thread the server has never heard of is adopted as a fresh draft rather than 404ing.
  **A draft's tab also survives a reload**, which the server's list cannot say: the row is
  persisted per device (`lib/draft-sessions.ts`) and `bootstrap` re-mints it before the
  boot's `prunePanels` runs, but only for a draft the saved dock layout still names a tab for
  — a closed tab stays closed, and an id the server now reports is an ordinary thread.
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
  agent* out of these rows: the agent restores from its own store, and `respawnNow` either
  clears the log before a `session/load` refills it or keeps the log and has the agent say
  nothing (`session/resume`, or a load whose narration is dropped — `restart.kept`, above) —
  never both accounts at once, so they can never be stitched together. That rule
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
- **The import dialog is also the recovery surface, which is what its filters are for.** The
  agent's own store outlives the harness's rows, so a thread deleted here is still in the runtime and comes back through
  this dialog. A machine-wide listing runs to hundreds of rows, so finding the window that
  went missing is a matter of narrowing: **status** (`Not here yet` is the default, because
  the dialog exists to add what is missing), a **time window** measured against each row's
  `updatedAt`, an order, and the search over title *and* cwd. **A row with no date is never
  filtered out by a window** — the runtimes may answer without one, and "we don't know when"
  is not "older than that". Filters survive a rescan and a change of agent (they are how the
  user is reading, not what was read); the scan's *answer* never does. **A conversation
  already in Trash is restored, never imported**: the row naming it still exists, and a
  second import would be two threads on one conversation — so that row offers
  `actions.restoreThread`, and the dialog remembers what it restored rather than making the
  user pay for another scan to see it. "Select all" spans every group on screen, because the
  question a recovery asks ("everything from Tuesday") is rarely one directory.

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

## AIR: the dialect we are spoken to in

- **The harness declares `_meta.jetbrains.air` in `CLIENT_CAPABILITIES`, and both adapters
  then treat it as JetBrains AIR** (codex-acp ≥ 2.0.1, claude-agent-acp ≥ 0.84.0; their own
  docs are the adapters' `AIR.md`). It was declared for `asyncTasks` — the background-task
  lifecycle (`async_task_*`, rerouted past the SDK's update union in `acp-bridge.ts`) — and
  the key is a whole dialect, not one feature: it gives things and takes them away. The
  capability list (`AIR_META`) carries, beside `asyncTasks`:
  - `nativeSubagentSessions` — the AIR spelling of the RFD's `clientCapabilities.subagents`,
    which a released SDK may strip. Both are sent; a Claude Code `Agent`/`Task` child now
    gets a session of its own, the way codex's did ("Subagents").
  - `sessionFailure` — a warning or a failed turn is a typed record
    (`protocol.ts` `SessionFailure`: `id`, `revision`, `category`, `severity`, `title`,
    `details?`, `actions`) instead of a `Warning:` text chunk, a JSON-RPC error or
    `_meta.codex.error`. It arrives two ways: on a `session_info_update` at
    `_meta.jetbrains.air.sessionFailure` (an ordinary update, journaled, the server never
    reads it), and — for a failure that ends the running turn, answered `end_turn` — on the
    prompt's *answer*, which the bridge parses (`parseSessionFailure`) and puts on
    `turn_ended.failure`. Journaled with the turn's end, so a replay draws it again. The
    client hands the second door to the first reader (`thread-socket.ts`), so there is one
    rule: **one row per `id`, placed where its first record arrived, replaced only by a
    higher `revision`**. Actions are the agent's and never inferred from `category`; only
    `retry` has a door on a row today. **A `warning` that is not `advisory` is a status, not a
    record** (`ErrorItem.transient`, e.g. Claude's "Reconnecting to Claude, attempt 1 of 10."):
    no transcript row, said by the working line (`workingMessage`) only while it is the newest
    item, gone the moment a step lands after it. A severity `error` still makes the turn's verdict a
    failure.
  - `recommendedValue` — model and effort selectors name the runtime's recommendation, and
    Claude Code replaces its ambiguous `default` row with concrete values. The client reads
    it generically (`session-options.ts` `recommendedValue`, only if it names one of the
    selector's own values) and the config menu and palette draw a muted "Recommended".
  - `planContentDelta` — codex sends a markdown plan whole once, then `plan.content: ""`
    with the appended text at `_meta.jetbrains.air.contentDelta`.
- **What it costs.** **`_meta.terminal_output_delta` must be declared beside `jetbrains`**,
  or an AIR client gets no command output at all — codex sends a Bash step with nothing in
  it, and Claude Code draws no terminal. Claude's `_meta.claudeCode` shrinks to `toolName`,
  `parentToolUseId` and `toolResponse` *markers* (`status`, `isAsync`) — the full tool
  response is gone, so a question's answers, a web search's hits and a workflow launch are
  read from the result text. **Edit's `rawInput` has no `old_string`/`new_string` and
  Write's no `content`: the `diff` content block is the source** (`extractEdits` falls back
  to it), and a permission request carries little more than the id and a title, so the
  approval card reads it together with the transcript's own row (`permissionToolCall`).
  A Bash description is `air.commandTitle`; a subagent call says `air.subagent: true`.
- **An update is a delta.** A `tool_call_update` omits every top-level field unchanged since
  the last report, and `_meta` is filtered per key (the terminal chunks excepted), so the
  client's `mergeMeta` merges plain objects all the way down — a one-level merge wiped the
  rest of `air` on every update.
- **Old journals keep their old shapes.** A thread journaled before the upgrade replays
  `claudeCode.toolResponse`, `claudeCode.title`, `codex.subagent` and the rest verbatim, so
  **no old reader is deleted**; each new source is read beside it, new first. The namespace
  is spelled once, `VENDOR_META.air` in `lib/tools/helpers.ts`, read through `vendorMeta`.
- **ACP's own `notice` update is claimed too** (`session.notices`): warnings, deprecations and
  config problems the agent used to keep to itself. It is live by the spec and journaled by
  us like every update, so the client keys its row on the text and a replay does not draw it
  twice.

## Subagents

- **Subagents: the store is flat, the transcript is a tree, and there are three ways a
  runtime says whose work an update is.** ACP v1 has no subagent concept, so every
  runtime improvised and none agree. Claude Code (`claude-agent-acp`) sends the child's
  work on the *parent's* session, each update stamped `_meta.claudeCode.parentToolUseId`
  = the `toolCallId` of the `Task`/`Agent` call that launched it — but withholds the
  child's prose and thinking unless the client claims
  `clientCapabilities._meta["subagent-transcript"]`, and attributes best-effort: a child's
  `tool_call` can go out unowned and be told its parent on a later update. That is the
  pre-0.84 shape, still read for old journals: since 0.84 a client that negotiates native
  subagent sessions (we do, see "AIR") gets Claude Code's children the way Codex's arrive
  below. Codex
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
  shape. **OpenCode 2 (`@opencode/cli`, 2.0.26) ships it — but OpenCode 1 does not, so
  until the opencode row runs 2.x the harness reads OpenCode's children itself, on the
  server, and there is no fourth shape.** 2.x's `opencode acp` projects a child onto the
  root with `_meta["opencode/child-session"]` and no lifecycle; a client that opts in with
  `clientCapabilities._meta["opencode/child-session-updates"]` (we do) gets the child on an
  extension notification instead — `opencode/session/child_update {rootSessionId,
  childSessionId, parentSessionId, depth, title?, type}`, `status` created/running/completed/
  interrupted/failed or `update` carrying the child's `SessionUpdate`, sent **without**
  ACP's `_` prefix — which `agentStream` translates into the RFD sequence the feed below
  synthesises (`translateOpencodeChildUpdate`). Its `subagent` call names the child only
  on completion (`rawOutput.metadata.sessionID`, a `<subagent sessionID state>` wrapper in
  the content), so the client links a running call to its child by title (= the call's
  `description`). **This is the only OpenCode path** (seed 30): 1.x dropped every child
  event, and the harness used to read them off the process's `/event` bus through a sidecar
  (`subagentFeed: "opencode-http"`, spawned with `--port`/`--hostname`). 2.x's `acp` rejects
  those flags — every thread exited 1 — so the sidecar is gone. 2.x attaches to a shared
  background service (`opencode service`), and a per-thread `OPENCODE_CONFIG_CONTENT` still
  reaches the session (checked against 2.0.29: the env's model is the session's). Not
  covered: children after a revive (`session/load` replays the parent alone). Two things on the server make the RFD path possible. The SDK's `SessionUpdate`
  union is **closed** and `acp.client()` validates every `session/update` against it in a
  router that runs *before any handler* — so `agentStream` re-addresses the two RFD
  variants to `_daedalus/subagent_update` on the way in and the bridge listens on both
  names (`protocol.ts` declares `SubagentSpawned`/`SubagentStateUpdate` and the widened
  `SessionUpdate` both ends use). **The RFD has since moved on and the SDK with it**: from
  SDK 1.6 the union carries one upsert, `subagent_update {sessionId (child), title?,
  description?, capabilities?, state?}` on the parent's session, with `state` a snapshot
  (`running`, `idle` + `stopReason`, `requires_action`, `unknown`), and the draft pair is
  gone from it. The adapters (claude-agent-acp 0.89, codex-acp 2.2) still send the draft —
  so the reroute stays — and a runtime that switches is **translated into the draft pair
  in the same rewrite** (`server/src/subagent-update.ts`, per-process state because an
  upsert omits what it does not change): first sight or a rename or a wake-up is a
  `subagent_spawned`, `idle` is a `subagent_state_update` (`cancelled` → cancelled,
  `error`/`refusal` → failed, else completed). Nothing downstream learns a second shape.
  The RFD's `session_message(_chunk)` (messages between sessions) passes through unread.
  And the `update` event gains an optional `sessionId`,
  set **only** when the update is a child's, so every event journaled before subagents
  existed keeps its exact shape. On the client, ownership is resolved in one place —
  `applySessionUpdate`'s `owner`: `lib/tools.parentToolIdOf(_meta)` first (the two `_meta`
  shapes; the store still never reads `_meta` itself), else the child session id when the
  event carries one. The meta outranks the session on purpose — **but only when the tool
  row it names exists**: a workflow step's own Task tree arrives mirrored with the step's
  `sessionId` AND the Task attribution, and session-first filed every inner row under the
  step — the tree Claude Code's native transcript nests, flattened. Yet claude-agent-acp
  with native subagent sessions **withholds the Task/Agent row itself** (its "control"
  updates return null) while every child update keeps `parentToolUseId`; meta-first there
  filed the whole child under a head that never arrives and it drew flat. Codex does the
  same with `spawnAgent`. `owner` lands as `parentId` on every item; `subagent_spawned` becomes a
  `SubagentItem` (`subagent:<sessionId>`), and Claude's spawn `prompt` (the full brief) is
  kept on it. **One subagent is one step, whatever announced it**: a session whose launch
  call also arrived — ours (`_meta.daedalus.parentToolUseId` on the spawn) or OpenCode's
  `task` (its output names the child session) — is folded with it at view time
  (`sessionLaunches` → `SubagentGroup.launch`: the call gives brief, report and agent type,
  the session the rail, state and usage), and Codex's later `sendInput`/`wait`/`closeAgent`
  rows nest under the child session they name. `client/src/lib/subagents.check.mjs` drives
  every shape through the reducer and row builder. The store
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


## Pause

- **ACP has no pause, so the harness owns one — and only its own runtime takes it.** The
  spec's one interruption is `session/cancel`: the agent stops its model and tool calls,
  the client answers every open permission with `cancelled`, and the prompt returns
  `stopReason: "cancelled"` — the step in flight is gone. `session/resume` and
  `session/load` are reattachment, not un-pausing; the Subagent Sessions RFD advertises
  `cancel`, `prompt` and `close` on a child and nothing else. Claude Code's and Codex's
  adapters therefore cannot be paused, only cancelled and re-prompted (context kept, step
  lost). The `agent/` runtime owns its loop, so it can hold: `Session.gate` is awaited at
  the top of `prepareStep` — the boundary between one step's tool results and the next
  model call — in the main turn and in every subagent loop, so a held parent holds its
  workers too. The pair is `_daedalus/session/pause` / `_daedalus/session/resume`
  (extension methods, `_`-prefixed as the spec asks, registered through the SDK's
  string-method `onRequest` overload), advertised as
  `agentCapabilities._meta["daedalus/pause"]` — `_meta` being the slot ACP reserves for
  exactly this, and one the SDK's initialize schema keeps. Both answer at once with
  `{paused, turnActive}`: a pause takes effect when the step in flight ends, and the flag,
  not the step, is what the peers are told. The gate races the turn's abort, so a cancel
  while held ends the turn as `cancelled` (an abort raised inside `prepareStep` reaches the
  stream as an error part, which `pumpStream` folds back into `aborted`) and **a cancel
  clears the pause** on both ends — a pause is part of what a cancel abandons. A paused
  session with no turn open holds its next prompt at its first step, which is why the
  composer's toggle stays while `paused` even after the turn has ended.
  On the wire: `AcpBridge.pause()/resume()` behind the `pause`/`resume` commands, gated on
  `bridge.canPause`, answered with the **absolute, live-only `paused` event** to every peer
  including the one that asked — it is current state like `queue`, never journaled, and
  `caught_up` carries it on attach. `session_config.canPause` is the offer, on the same
  carrier and by the same rules as `promptCapabilities`. The fake agent takes the pair with
  a flag and nothing else, which is what `test:workflow` exercises the bridge path with;
  the gate itself is `agent/test/turn.test.ts`.
- **A runtime that owns no loop we reach is held from inside its own hooks** — same API, a
  different mechanism, picked by the agent row (`pauseVia`), never by the agent's id. For
  `"acp-meta"` (Claude Code) the bridge puts
  `_meta.claudeCode.options.settings.hooks` on session/new|load|resume: an HTTP hook on
  `PostToolBatch` (every step's tools are back, the next model call not yet made — the same
  boundary `Session.gate` holds at, subagents included) and on `UserPromptSubmit` (a pause
  with no turn open holds the next prompt), both calling `POST /ph/<key>/<threadId>`. That
  route answers `{}` at once, or — while the thread is paused — when it is resumed. **Late,
  never "no"**: a `block` on `PostToolBatch` ends the turn, which is a cancel. The gate
  follows `setHold` and nothing else, so resume, cancel and a dying process all open it. The
  hook's `timeout` is a week, because a timed-out hook is discarded and the loop goes on — a
  pause lifted by nobody; `HELD_TURN_MAX_MS` is still what gives up on a hold. It fails open
  (a harness that is down is a failed hook, and the turn continues), and a user
  `allowedHttpHookUrls` that misses 127.0.0.1 skips it — ours is not added, because defining
  that key at any tier blocks every other HTTP hook. The runtime's own pair wins where both
  exist: it holds inside a step, the hooks only between. Verified against the CLI
  claude-agent-acp 0.81.0 launches (2.1.280): a hook held 6s held the loop 6s and the turn
  finished normally. Codex is the next door (`"env"`, its `[hooks]` in `CODEX_CONFIG`),
  pending a way past its per-hash hook trust review.

## Held turns — a failure waits at the same boundary

- **A turn that fails does not end; it holds — and "fails" is every way it can.** An error
  part, a call that threw before the stream (`makeModel`, `failNoModel`), and — this is the
  part that was silently wrong — a **finish reason** that says the step did not do what was
  asked. `failedFinish` covers `error`, `content-filter` and `length`; `mapFinishReason` used
  to send an unrecognised reason to `end_turn`, so a provider reporting `finishReason: "error"`
  with no error part ended the turn as a *success* with the answer stopped mid-sentence.
  `other`/`unknown` are still not failures: a provider that has said nothing has not said
  something went wrong. These three are read only when a hold can actually be taken —
  unattended, `max_tokens` and `refusal` stay the legitimate ACP stop reasons they are, so a
  run does not start failing on them.
- **A failed tool call does not hold.** It is drawn as a failed `tool_call_update` and handed
  back to the model, which is the whole point of the `tool-error` path and of `repair.ts`
  beside it: the runtime already recovers from its own bad calls, and stopping the turn to ask
  a human would take that away. The same rule sends a subagent's failure to the parent as an
  ordinary tool error rather than holding anything.
- A provider error — a rate limit, a spent quota, a key that stopped working — used to throw
  the whole turn away, and with it every tool call it had already made. The runtime already owns a step boundary and already knows
  how to wait at it, so a failure holds there instead, and the user changes the model or the
  profile (which the harness does *on the running process*, `applyConfigLive`) and lets it go
  on. `turn.ts` re-reads `session.modelId` on every pass, so the change is the whole of what
  makes the next attempt different. Nothing recovers on its own past the auto-retries: no
  model fallback. Those come first — four, at 2s doubling (~30s), each wait floored by the
  provider's Retry-After and capped at 60s (`retryDelayMs`), and abortable so a Stop is not
  stuck behind one — and the hold is what happens when they are spent. **A wall that will
  still be there in thirty seconds is held at once** (`isRetriableStreamError`): a five-hour
  usage cap, a spent quota, a dead key arrive as 429/403 too, and retrying into them only
  cost the user the wait before the same hold.
- **A retry is said out loud, because the silence was being read as work.** Those two
  auto-retries used to be a line on the agent's stderr and nothing else: a thread would sit
  for three seconds with the working line still shimmering under the name of a tool call that
  had already failed, and if a retry worked the user never learned anything had happened. So
  `turn.ts` announces each one as `_daedalus/session/retry` before the backoff — never after,
  because the backoff *is* the silence being explained — carrying the attempt, the total, the
  delay and the failure itself through the same `describeHold` split a hold uses. Absolute
  and live-only exactly like the hold: `attempt: null` ends it, `caught_up` carries it
  (`session-socket.ts` › `retryFields`), and **nothing about it is journaled** — a retry that
  succeeded is not something a replay should redraw. The clearing notice is owed on every way
  out of the loop, so it hangs off the turn's own `finally` rather than being paired with each
  `return`, and the bridge clears it again at `settleTurn` for the runtime that dies
  mid-backoff and never gets to. Out of retries, the notice is taken back *before* the
  `paused` goes out: it is the same failure one step later, and two live states describing one
  turn is one of them drawn over the other.
- **The count is the harness's retries, not the provider's.** The AI SDK does its own
  (`maxRetries`, 3 attempts by default) *inside* one `streamText` call, with no callback to
  hang a notice on — they surface only inside the final message ("Failed after 3 attempts").
  Reporting them per-attempt means owning the retry policy here with `maxRetries: 0`, which is
  a change to what gets retried and not only to what gets said. It was documented before it
  was set: every 9router hold in the log began "Failed after 3 attempts" — three SDK tries
  inside six seconds, then a `RetryError` whose name the classifier did not match, so a 429
  that said "retry after a brief wait" went straight to a hold. `unwrapRetry` reads the
  inner error wherever a failure is read, in case the SDK ever wraps one again.
- **One wait, two reasons.** `Session.held` is `paused || errorHold !== null` and `gate()`
  loops on it, so a new reason to hold never needs a new gate. `holdError()` **resolves**
  with `"released" | "cancelled"` and never throws — a throw would reach the turn's outer
  catch and end a Stop as a red failure instead of the clean `stopReason: "cancelled"` a
  cancel has always had. A resume lets go of both reasons; a user pause never overwrites a
  failure already waiting, because the failure is the more useful of the two to read.
- **The pair grew its one missing direction.** A pause is asked for from the server and
  answered in the same reply; a hold is taken at the agent's end, so it can only arrive as
  `_daedalus/session/paused` — a notification, same capability, handled beside the others in
  `acp-bridge.ts`. It widens the existing event rather than adding one:
  `paused { paused, reason?: "user" | "error", error? }`, still absolute, still live-only,
  still carried on `caught_up` (`session-socket.ts` › `pausedFields`). `RESUME_METHOD` takes
  an options bag from the start (`{ compact? }`) because context length is the one hold a
  model change often cannot fix, and "compact and continue" must not need a second method.
- **A held turn is still `turnActive`.** There is no `turn_ended`, `lastTurnError` stays
  null, no "turn failed" push fires, and the client draws it as an open turn in a stopped
  state — the working line reads `Held — <the provider's own sentence>` and the composer's
  Play button is the Continue. An `ErrorRow` would be the wrong offer: re-sending the prompt
  is exactly what the hold exists to avoid.
- **Nobody in front of the thread means no hold.** `whenTurnSettled` is what workflows
  (`workflows.ts`) and routines (`routines.ts`) await, and a held turn never settles — a
  scheduled run would block forever where it used to fail and report. `spawnAgent` passes
  `DAEDALUS_AGENT_HOLD_ON_ERROR=0` for a session with a `parentSessionId` or an autonomy
  policy, which is exactly the set with no human at a config menu. The idle sweep is the
  backstop: a hold older than `HELD_TURN_MAX_MS` with no peers is cancelled, because a held
  turn keeps `promptActive` true and would otherwise pin its process for good.
- **Subagents do not hold.** `runSubagent` re-sends its whole prompt on every attempt and
  keeps no accumulated messages, so a held-then-continued child would re-run every tool it
  had already run — the opposite of the guarantee. Its failure stays a thrown error, which
  becomes a `tool-error` part, which the parent carries on from. One `errorHold` slot per
  session is the other reason: a step's parallel children would freeze each other.
- **A failed attempt persists only what it finished.** The write of `responseMessages` now
  happens *after* the outcome is known, and on the failing path only down to
  `settledPrefix` — the longest run of messages in which every tool call has its result.
  Written before the check (as it was), a failed attempt left an assistant message carrying
  a call with no result in an append-only file for good, and the next `session/load` handed
  it straight to a provider that rejects it. Steered words are the other exception: they are
  persisted and journaled as they arrive, so a rollback puts them back rather than dropping
  them. Usage is summed across attempts, since a hold makes a multi-attempt turn ordinary
  and the last attempt's tokens would under-report exactly the expensive turns.

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

## Trajectory: OpenTelemetry spans

A thread's trajectory is its OpenTelemetry spans, stored in `trace_spans` and drawn by the
Trajectory panel (thread dock, and `/t/:id/trace`). It replaced a trace page that re-read the
journal: the journal says what was *said*; a span says what *happened*, when, for how long and
under what.

- **One tracer, two sources.** `server/src/tracing.ts` owns a `BasicTracerProvider` whose store
  processor keeps open spans in memory (served with `end: null`, so a running turn draws live)
  and batches finished ones into the table. The harness's spans are read off ACP by
  `server/src/bridge-trace.ts`, which the bridge *tells* at the moments it already knows about
  and never asks. A runtime's own spans arrive finished over `_daedalus/trace` and are written by
  `ingest` with `source: "agent"` — never re-started through the tracer, which would mint new ids
  and break the tree.
- **One trace per turn.** The turn is the root; `session/prompt` is under it and carries its
  W3C `traceparent` in `_meta`. A runtime that advertises `daedalus/trace` in its `initialize`
  `_meta` (ours) parents its spans under that request — the AI SDK's GenAI spans via
  `@ai-sdk/otel`: `invoke_agent`, `step N`, `chat <model>` with time to first chunk, prompt and
  answer, `execute_tool <name>` with arguments and result. **For every other runtime the bridge
  derives them** from updates — a model span from the last boundary to the next tool call (its
  duration is request *and* decode; `daedalus.ttft_ms` is the first chunk), a tool span from
  `tool_call` to its terminal status, a subagent under the tool call that spawned it. Never both:
  a self-tracing runtime's calls would be drawn twice and its tokens counted twice.
- **For every runtime**: the handshake (`session/new|load|resume`), permission and elicitation
  waits with their outcome, and `retry`/`paused`/`cancel`/`steer` as span events.
- **`kind` is decided at write time** (`daedalus.kind`, else the GenAI operation), so the list
  never parses attributes. A runtime's own `turn` is stored as `agent`: the turn is ours.
- **The list elides, the span route does not.** A model span's input is the whole prompt every
  step; `GET /api/sessions/:id/spans` cuts strings at `TRACE_LIST_VALUE_LIMIT` and names them in
  `elided`, and `GET …/spans/:spanId` returns the span whole. Storage caps one value at 256KB.
- **Export is standard OTLP** when `OTEL_EXPORTER_OTLP_(TRACES_)ENDPOINT` is set — the harness
  exports its spans, the agent exports its own from the same env. Not backed up: a restored
  install starts recording afresh. Deleting a thread cascades its spans.

## Durable agent processes (`DAEDALUS_SANDBOX=hosted`)

Goal: `pm2 restart` of the server does not kill running agents. Off by default
(`direct`: children of the server, killed on shutdown, as before).

- **The seam is `server/src/sandbox/`.** The bridge only sees a `Handle` (stdin/stdout/stderr,
  `exited`, `kill`, `detach`, `offset`, `lossy`). `DirectSandbox` is a child process;
  `HostedSandbox` launches a detached **per-agent host** (`src/agent-host.ts`, stdlib only) that
  owns the child's pipes, buffers numbered stdout lines in a ring (8 MB, `lossy` on overflow) and
  serves `data/agents/<id>.sock` (ndJSON: attach/write/kill in; attached/data/stderr/exit out;
  one client, a new one replaces the old). Stderr is **live**: pushed per chunk while attached, and
  its 64 KB tail is replayed once on attach, marked `replay`. `<id>.json` (0600, dir 0700) is written
  last and carries `error` / `exited` and a **redacted** spec (command, args, cwd, env *names* — never
  values: the full spec lives only in memory). A host lingers 60 s after an unattended child exit so a
  returning server reads the replay and exit code. `attach` is bounded (5 s,
  `DAEDALUS_HOST_ATTACH_TIMEOUT_MS`), because boot adoption awaits it before the server listens.
- **pm2 must not treekill** (`treekill: false` in `ecosystem.config.cjs`): a detached host is still the
  server's child, and pm2 walks the descendant tree on stop/restart.
- **The persisted offset means "host lines consumed"**, never lines seen, and the JSON-RPC counter is
  persisted as a *reservation* ahead of use, so a crash can never hand an old id out again.
  The `WireLedger` exists only for a durable sandbox (or an adopt); under `direct` it is plain `ndJsonStream`.
- **Shutdown detaches, it does not retire** (`SessionManager.shutdown`, hosted only): retiring
  would reject the in-flight prompt and journal a `turn_ended` that `adoptTurn` must write
  itself. Explicit stop, trash, idle sweep, restart route and respawn still `kill()`.
  `pnpm pm2:kill-agents` is the "stop everything" command. Switching hosted to direct: run it first.
- **Adopt on boot** (`src/adopt-boot.ts`, after `recoverAtBoot`, before `serve`): `agent_processes`
  rows x `sandbox.list()`; no row kills the host, no host drops the row, lossy kills both.
  `AcpConnection.adopt` skips `initialize` from the saved result. JSON-RPC ids are shifted by the
  persisted high-water mark (`WireLedger`), and the ledger's offset is in **host lines**, counting
  the blank and non-JSON lines the parser refuses. A prompt whose reply arrived while the server
  was down ends through `bridge.adoptTurn`.
- **Loopback credentials are stable** (`loopback-secret.ts`, `data/loopback-secret`, HMAC-derived),
  because a surviving agent still holds the old URLs. Deleting that file strands every adopted agent.
- **An adopted turn keeps its duration.** The old turn timer died with the old server, so
  `adoptTurn` takes the journal's `turn_started.at` as `startedAt` and reports `durationMs` as
  wall clock from there — downtime included, ending at the settle (for a reply that arrived
  while down, that is adoption, the real finish is not recorded). `toolDurationMs` is left
  **unset**, not 0: the per-tool timings died with the process, and a figure covering only the
  part seen since adoption would be wrong. Time to first token is unknown and not emitted.
- **A question the agent is blocked on survives a restart.** The `WireLedger` tracks inbound
  `session/request_permission` and `elicitation/create` frames whole, by id, until the matching
  outbound response (same id, `result`/`error`) goes out, and persists them with the process
  (`agent_processes.pending_requests`, saved urgently on add and remove). After the bridges
  exist, `bindOne` calls `ledger.reinject()`, which puts each saved frame into the inbound
  stream, so the SDK dispatches it to the ordinary handler: `bridge.pending` is rebuilt, peers
  see it on attach, and the answer leaves with the id the agent waits on (agent→client ids are
  never shifted). If the host's replay from the saved offset delivers the same id too, it is
  delivered once (whichever comes first wins, the other is dropped). A request whose session has
  no bridge reaches the connection's `SINK` and is answered `cancelled`. `fs/*` and `terminal/*`
  are not tracked: they are answered by the machine in milliseconds and re-running one (a
  write) is not safe.
- **Known limits**: only threads with a prompt in flight are bound on boot (idle process-of-its-own
  threads are not kept: no thread->host column); a crash between writing an answer and
  persisting its removal re-asks a question the agent already has the answer to (the stale
  answer is ignored by the agent); after SIGKILL some updates can journal twice (progress is
  persisted at most 500 ms late); `turnChanges.closeOrphans()` still closes an adopted turn's
  measurement. Terminals (node-pty) are not hosted and still die with the server.
