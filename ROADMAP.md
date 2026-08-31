# Daedalus Harness — improvement roadmap

Derived from the verified gap register. Every item names files and functions; nothing
below requires further discovery. Tiers are ordered by value ÷ effort within each tier.

Conventions used here:
- Server tests are `tsx` scripts under `server/test/`, registered as `test:<name>` in
  `server/package.json` and `&&`-chained into `test`. New suites follow that shape.
- No schema change below requires a migration file: edit `server/src/db/schema.ts`,
  run `pnpm db:push`.

---

## A. Must-fix

### A1. Reconcile the FTS index on backup import
**Gap 1** · `server/src/backup.ts` (`importBundle`), `server/src/search.ts`
(`deleteSearchIndex`, `indexEventRow`)

`importBundle` deletes and re-inserts `session_events` rows but never touches
`session_events_fts`, which has no FK and no cascade. After an import, search returns
stale snippets for deleted events and nothing at all for imported transcripts, with
`search_meta.fts_backfill = 'done'` blocking any repair at boot.

**Fix.** Inside `importBundle`'s transaction:
1. In `replace` mode, `tx.run(sql\`delete from session_events_fts\`)` alongside the
   table-emptying pass.
2. In `merge` mode, call `deleteSearchIndex([...owned])` (widened to accept a `Tx` runner
   — currently it closes over the module `db`) before the per-session event delete loop.
3. After inserting each event row, call `indexEventRow(tx, row)` with the parsed payload,
   mirroring `SessionJournal.flush` (`session-journal.ts:75-99`) and `backfillSearchIndex`.

Because `indexEventRow` needs a parsed payload and the bundle stores payloads as JSON
text, parse once and reuse; skip unparseable rows exactly as `backfillSearchIndex` does.

**Test.** Extend `server/test/backup.test.ts`: seed two sessions with journaled prose,
export, wipe, import in both modes, and assert `searchEvents("<phrase>")` returns hits
for imported sessions and zero hits for sessions the import removed.

---

### A2. Import must not write events into sessions the bundle does not name
**Gap 2** · `server/src/backup.ts:581-601`, `server/src/sessions.ts` (`retireAll`, `reload`)

`keep()` filters incoming events against every session id in the table, while the
delete-first pass covers only `owned`. A bundle carrying events for a session it does not
export appends them into that session's live log — the "two accounts stitched together"
the surrounding comment claims to prevent — and if the session has a live bridge its
in-memory `eventCount` is now stale, so the next `append` collides on `(session_id, seq)`
and is dropped.

**Fix.** Change `keep()` to filter against `owned` only (the bundled session id set), and
count the discarded rows into `ImportSummary` as `orphaned`, matching how orphaned child
rows are already reported. This makes "a thread's log is replaced as a unit" literally
true: an event may only be written for a session the bundle also carries.

**Test.** In `server/test/backup.test.ts`, hand-build a bundle whose `sessionEvents`
references a session absent from `bundle.sessions`; assert the target session's log is
byte-identical after `importBundle(..., "merge")` and that `summary.sessionEvents.orphaned`
counts the skipped rows.

---

### A3. Scope workflow run routes to the calling thread
**Gap 4** · `server/src/routes/workflows.ts` (`resolveCaller`), `server/src/workflows.ts`
(`WorkflowRunner.status`, `.wait`, `.cancel`)

`resolveCaller` validates the per-boot key and that the session exists, but the status /
wait / cancel handlers pass a bare `runId` and never compare it against `run.parent`. Any
agent with the boot key — every thread linking `builtin:workflow` — can read another
thread's run definition, inputs and per-step outputs, or cancel it.

**Fix.** Give `status`/`wait`/`cancel` a required `parentSessionId` parameter and return
`undefined` (→ 404, not 403; do not confirm existence) when `run.parent !== parentSessionId`.
Pass the session id `resolveCaller` already resolved. Keep the check inside `WorkflowRunner`
rather than in the route so the HTTP layer cannot be the only guard.

**Test.** New `server/test/workflow-authz.test.ts` (or a case in `workflow.test.ts`): start
a run on session A, then issue `GET /wf/<key>/<B>/runs/<runId>` and `POST …/cancel` for a
second session B; assert 404 and that the run is still running.

---

### A4. Close peers (or broadcast history loss) on respawn
**Gap 5** · `server/src/sessions.ts` (`respawnNow`, `onHistoryLost`),
`server/src/session-socket.ts`

`respawnNow` calls `this.log.clear(session)` with no `closePeers`. A second device stays
attached with a cursor past the new end while `eventCount` restarts at 0, then appends
fresh events numbered from 0 onto its old transcript. The justification in the comment at
`sessions.ts:775-780` — "a respawn forces every peer to reconnect anyway" — holds only for
the initiating client, which closes its own socket in `client/src/lib/actions.ts`.

**Fix.** Call `this.closePeers(session)` immediately after `this.log.clear(session)` in
`respawnNow`, before the new bridge is constructed. Every peer then reconnects and takes
the ordinary fresh-attach path (`from: 0`, `resumed: false`), which is exactly the state
the cleared log describes. If a silent reconnect is undesirable in the UI, have the client
distinguish it via the existing `attached.resumed` flag rather than adding an event kind.

**Test.** `server/test/bridge.test.ts` already exercises multi-peer; add a case that
attaches two fake peers, respawns, and asserts both sockets close and the second peer's
replay begins at seq 0 with no events from before the respawn.

---

### A5. Make the IDE lock file non-readable, and stop trusting `verifyPid` only on Linux
**Gaps 6 + 7** · `server/src/ide.ts` (`writeLock`, `readLock`, `verifyPid`,
`adoptOrphans`, `startIde`)

Two defects in one file, and they compound:
- `writeLock` writes `{pid, port, key}` with `writeFileSync` and no mode → 0644. That key
  is the sole credential for an `--auth none` code-server exposed at `/ide/<key>/` with
  `x-frame-options` and `frame-ancestors` stripped: arbitrary file read/write plus a shell
  on the host, for any local user or any copy of `data/`.
- `verifyPid` returns `false` unconditionally off Linux, so `adoptOrphans` deletes the
  lock and `continue`s *without signalling* — the running editor is orphaned — and
  `startIde`'s stale-lock kill is gated on the same predicate, so it spawns a second
  code-server on the same `--user-data-dir`. Two extension hosts on one user-data-dir is
  the corruption the file's own comments warn about.

**Fix.**
1. `writeLock`: `writeFileSync(path, json, { mode: 0o600 })` and `chmodSync` the
   containing `data/ide/<projectId>` to `0o700` when created. Document in `CLAUDE.md`'s
   IDE section that the lock file is a stored shell credential.
2. `verifyPid`: add a portable fallback for non-Linux — `process.kill(pid, 0)` to test
   liveness, combined with a **port ownership** probe (`healthy(port)` already exists,
   `ide.ts:499`) and a match on the lock's recorded port. Liveness + a healthy code-server
   on the recorded port is a strictly better signal than "assume dead".
3. `adoptOrphans`: when a lock cannot be verified but the pid *is* alive, `killPid` before
   deleting the lock, so the non-adoptable editor is never left orphaned.

**Test.** `server/test/ide.test.ts`: assert the lock file's mode is `0o600`; simulate a
stale lock whose pid is alive but whose port answers nothing and assert exactly one
process is spawned and the stale pid was signalled.

---

### A6. Don't prune journals an import just restored
**Gap 8** · `server/src/backup.ts:218-224`, `server/src/sessions.ts:515-521`,
`server/src/session-journal.ts` (`prune`)

Imported events keep their original `at`. `pruneJournals` drops whole logs whose
`max(at)` is older than `sessionJournalRetentionDays` (30 by default), so a 60-day-old
bundle restored onto a fresh install loses every transcript within the hour.

**Fix.** Add `journal_restored_at` (integer, nullable) to `sessions` in
`db/schema.ts`, set it in `importBundle` for every session whose events the bundle
carried, and have `SessionJournal.prune` compute the cutoff per session as
`max(max(at), journal_restored_at)`. Retention then means "30 days since it was last
here", which is what the setting is for. `pnpm db:push` after the schema edit.

**Test.** `server/test/backup.test.ts`: import a bundle stamped 60 days back, run the same
prune call `SessionManager` makes, assert the logs survive; then advance the injected
clock past retention and assert they are dropped.

---

### A7. Deliver-then-delete for one-shot schedules, and surface the failure
**Gap 3** · `server/src/scheduler.ts` (`deliver`, `fire`), `server/src/db/schema.ts`
(`scheduled` — `lastError`, `skippedAt` already exist)

`deliver()` deletes the row for `everyMs === null` and then calls `void fire(...)`. Any
failure inside `fire` — a respawn throw, a rejected `bridge.ready`, the silent `return` on
a missing profile or project — leaves the row gone, the prompt unsent, `lastError` unwritten
and nothing in the UI.

**Fix.** Make `deliver` await `fire` (it is already invoked from an async sweep) and:
- delete a one-shot row only after `fire` resolves;
- on rejection, write `lastError` (and bump `skipCount`) via `updateScheduled`, keep the
  row, and leave it for the next sweep — bounded by a retry ceiling so a permanently
  broken schedule does not fire every 15s forever;
- turn the silent `return` on a missing profile/project into a written `lastError`.

**Test.** New `server/test/scheduler.test.ts`: a one-shot schedule pointed at a session
whose profile was deleted; assert the row survives with a non-null `lastError`, and that a
schedule whose `fire` succeeds is deleted exactly once.

---

### A8. Preserve `enabled` and the error fields across backup round-trips
**Gap 9** · `server/src/backup.ts:184-192, 606-607`, `server/src/db/schema.ts:483`

`ScheduledRow` omits `enabled`, `skippedAt`, `lastError`, `skipCount`, and the rows go
through `insertChunked`, so `enabled` falls back to its schema default of `1`. A paused
schedule — including one paused *because* it was misfiring — is re-armed by any
export/import round trip and fires on the next 15s sweep.

**Fix.** Add the four columns to `ScheduledRow` in the zod schema and to the export
projection; leave the version at 1 and make the fields optional with the current defaults,
so older bundles still validate. Once every column round-trips, switch the schedules table
to `upsertChunked` for consistency with the other user-data tables.

**Test.** `server/test/backup.test.ts`: create a disabled schedule with a `lastError`,
round-trip it, assert all four fields survive in both `merge` and `replace`.

---

### A9. Carry accumulated terminal bytes and merged meta across a re-announced `tool_call`
**Gap 19** · `client/src/lib/store.tsx:455-475` (`applySessionUpdate`)

The `tool_call` branch builds a fresh item with `meta: metaOf(update)` and
`terminal: applyTerminalMeta(undefined, metaOf(update))` and replaces the existing item
wholesale, carrying forward only `parentId` and `name`. The `tool_call_update` branch does
the opposite (`mergeMeta`, `applyTerminalMeta(i.terminal, …)`). A Codex shell call that
has been streaming through `_meta.terminal_output_delta` and is then re-announced loses
every chunk received so far.

**Fix.** When an item with the same `toolCallId` already exists, take the update branch's
merge semantics: `meta: mergeMeta(existing.meta, metaOf(update))` and
`terminal: applyTerminalMeta(existing.terminal, metaOf(update))`. New ids keep the current
path. This is a two-line change inside the existing `if (existing)` guard.

**Test.** Covered by the store reducer suite introduced in B1 — a `tool_call` →
`tool_call_update` (terminal delta) → `tool_call` sequence must retain both chunks.

---

### A10. Key the turn Sources strip on the row it will actually be looked up by
**Gap 20** · `client/src/components/thread-view.tsx:86-101` (`withTurnSources`),
`client/src/lib/transcript-rows.ts:66-68` (`rowTailId`)

`withTurnSources` keys the map by `rootOf(last).id`; lookup goes through `rowTailId(row)`,
which for a `workflow-group` returns the **last** step's id. A turn whose final item lands
in step 2 of 4 never matches, and its sources strip disappears.

**Fix.** Build the map by running the *same* `rowTailId` over the built rows rather than
by deriving a key from the raw tail item — i.e. compute rows first, then attribute each
turn's sources to `rowTailId(rowContainingTail)`. `rowTailId` becomes the single definition
of "which row ends this turn", used on both sides.

**Test.** Part of the `transcript-rows` suite in B1: a fixture where a turn's last item is
mirrored from a non-final workflow step must still yield a sources row.

---

### A11. Constrain CORS and validate WebSocket `Origin`
**Gap 12** · `server/src/index.ts:94` (`app.use("*", cors())`), `:139-165` (upgrade handler)

Bare `cors()` emits `Access-Control-Allow-Origin: *` for `/api/*`, `/gw/*`, `/ide/*` and
`/wf/*`, and nothing validates `Host` or the WebSocket `Origin`. `/api/health` is an
unauthenticated oracle for a supplied token. The bearer token still gates everything, so
this is unnecessary reachability rather than an authentication bypass — but it is
reachability from any page the user visits on the same LAN.

**Fix.** Add `allowedOrigins: string[]` to `data/config.json` (`server/src/config.ts`),
defaulting to `[]` = permissive so no existing install breaks. When non-empty:
`cors({ origin: (o) => allowedOrigins.includes(o) ? o : null })`, and reject the WebSocket
upgrade when `req.headers.origin` is present and not in the list. Leave `/ide/*` and
`/gw/*` out of the origin check — they are consumed by an iframe and a child process, not
by XHR. Document the key in `CLAUDE.md`.

**Test.** A case in `server/test/bridge.test.ts` asserting a disallowed `Origin` fails the
upgrade while a token-only, origin-less client (Electron, the CLI) still connects.

---

### A12. Deny-list the key-in-path prefixes in the service worker
**Gap 13** · `client/src/sw.ts:52`

The `NavigationRoute` denylist is `[/^\/api\//, /^\/ws(\/|$)/]`. In a same-origin
deployment the IDE iframe's `src="/ide/<key>/"` is a navigation request answered with the
precached SPA shell — a blank panel the app cannot diagnose.

**Fix.** Extend the denylist to `[/^\/api\//, /^\/ws(\/|$)/, /^\/ide\//, /^\/gw\//, /^\/wf\//]`.
One-line change; ships with the next service worker, which the prompt-update toast will
offer.

**Test.** None automated (no client test harness for the worker); verify by loading the
IDE panel in a same-origin build.

---

### A13. Return the page's own `from` instead of subtracting row counts
**Gaps 17 + 18** · `server/src/session-journal.ts:165-167` (`eventsFrom`), `:254-266`
(`earlierPage`), `client/src/lib/thread-socket.ts:442` (`fetchEarlier`)

Two places advance a seq cursor by a row count, which is correct only while seqs are
dense. The flush drop path (`session-journal.ts:100-111`) advances `eventCount` before it
can fail, so gaps are producible. With a gap, `eventsFrom` re-sends a page's last event and
`fetchEarlier` prepends an overlap into `this.raw`, duplicating turns on screen.

**Fix.**
- `eventsFrom`: set `cursor = page[page.length - 1].seq + 1` instead of `cursor += page.length`.
- `earlierPage`: add `from` (the first event's seq) to the returned `EarlierPage`, plumb it
  through the `earlier` reply in `session-socket.ts`, and have `fetchEarlier` set
  `this.windowFrom = page.from` rather than subtracting. The server knows the number
  exactly; the client should not re-derive it.

**Test.** `server/test/search.test.ts` already builds journals; add a case to a new
`server/test/journal.test.ts` that inserts events with a deliberate seq gap and asserts
`eventsFrom` paging emits each seq exactly once, and that `earlierPage().from` equals the
first returned seq.

---

### A14. Guard the FTS backfill cursor against rowid reuse
**Gap 21** · `server/src/search.ts:197-236` (`backfillSearchIndex`)

Progress is `rowid > cursor`, and SQLite reuses rowids after the highest rows are deleted
(`session_events` has no `AUTOINCREMENT`). An interrupted backfill followed by a `clear()`
or `prune()` of the newest rows leaves later inserts at rowids ≤ cursor, skipped forever
once the marker flips to `'done'`.

**Fix.** Cheapest durable option: add `AUTOINCREMENT` semantics by keying the backfill on
`(session_id, seq)` instead — page ordered by `session_id, seq` with a composite cursor
stored as JSON in `search_meta`. Alternative, if that is too invasive: record
`max(rowid)` at backfill start, treat it as an upper bound, and on completion verify
`count(*)` of unindexed rows is zero before writing `'done'`.
Either way, add a `?rebuild=1` escape hatch on the search route (or a `pnpm search:reindex`
script) that resets `search_meta.fts_backfill` and rebuilds — today there is *no* repair path.

**Test.** `server/test/search.test.ts`: interrupt a backfill, delete the tail, insert new
events, and assert a subsequent boot indexes them.

---

### A15. Make the journal flush retry path atomic
**Gap 16** · `server/src/session-journal.ts:100-110` (`flush`)

The happy path indexes inside `db.transaction`; the row-by-row retry does the event insert
and `indexEventRow` as two implicit transactions. If the FTS insert throws, the event row
is already committed — permanently unsearchable — and the `console.error` names the event
as "dropped" when it was not.

**Fix.** Wrap each retried row in its own `this.db.transaction((tx) => { insert; indexEventRow(tx, row) })`
so a failed index rolls the event back and the "dropped" log is accurate. Log the seq and
session id so the gap is diagnosable.

**Test.** `server/test/journal.test.ts` (new, per A13): inject an `indexEventRow` failure
and assert the event row is absent rather than half-written.

---

### A16. Constant-time bearer comparison; stop accepting `?token=` where it is avoidable
**Gaps 22 + 23** · `server/src/index.ts:116, :156`, `server/src/routes/helpers.ts:5-8`,
`server/src/routes/misc.ts:107-111`

Plain `!==` guards the 192-bit bearer token while `safeKeyEqual` guards every path key —
the weaker check protects the stronger credential. And `/api/backup`'s refusal of
query-string auth ("a full-secret export URL is exactly the thing that ends up in browser
history and proxy logs") is true of the token on every other route and of the mandatory
`/ws?token=`.

**Fix.**
1. Export `safeKeyEqual` from a shared module (it currently lives beside its callers) and
   use it for the bearer comparison in both the HTTP guard and the upgrade handler.
2. Keep `?token=` for `/ws` (a browser WebSocket cannot set headers) but drop it for
   `/api/*` except where a download link needs it; audit `client/src/lib/settings.ts` for
   any caller relying on it first. Not urgent at 192 bits — bundle it with A11.

**Test.** A case asserting a wrong token of the same length is rejected, and that a
query-string token no longer authenticates `/api/sessions`.

---

### A17. Two small client rendering defects
**Gaps 10 + 11**

- **A subagent's plan seizes the composer shelf** — `client/src/components/composer-status.tsx:353`.
  `thread.items.find(item => item.kind === "plan")` takes the first plan of any owner, even
  though plans are keyed `plan@<owner>` precisely so a child's cannot replace the thread's,
  and the sibling `ComposerTodo` (`:403`) already guards with `!item.parentId`.
  **Fix:** add the same `&& !item.parentId` predicate.
- **A markdown/file plan renders nowhere** — `composer-status.tsx:353-354`,
  `client/src/components/thread-view.tsx:206`. A `plan_update` of type `markdown`/`file`
  yields `entries: []`, `ComposerPlan` returns `null` on empty entries, and thread-view
  filters out plans with `parentId === undefined`. `PlanStep`
  (`thread-cards.tsx:421-435`) already handles both variants but is reachable only for a
  subagent's plan. **Fix:** in `ComposerPlan`, return `null` only when the plan has neither
  entries nor markdown/file content, and render the non-entry variants through the existing
  `PlanStep` markup.

**Test.** Fixture cases in the B1 client suite.

---

### A18. Harden the deploy path
**Gaps 14 + 15** · `server/ecosystem.config.cjs:29-32`, `server/package.json:10`

`max_restarts: 10` with no `min_uptime` and no backoff: a fast-failing boot burns the
budget in seconds and parks the app `errored` silently — `server/logs/error-14.log` already
contains 36 `EADDRINUSE 0.0.0.0:4001` cycles. No `max_memory_restart`; logs grow unbounded.
And `pm2:start` chains `pnpm db:push` with no `--force` under a process manager with no
TTY, so a destructive diff blocks on stdin and the `&&` chain never reloads pm2 — the old
build keeps serving.

**Fix.**
- `ecosystem.config.cjs`: add `min_uptime: "30s"`, `exp_backoff_restart_delay: 1000`,
  `max_memory_restart: "1G"`; install and configure `pm2-logrotate`.
- `server/package.json`: split the deploy into `pm2:start` (build + reload only) and an
  explicit `db:push` the operator runs, or use `drizzle-kit push --force` *only* behind a
  separate `db:push:ci` script, never the interactive one. Keeping push out of the deploy
  chain is what `CLAUDE.md` already prescribes for boot; the same reasoning applies here.
- Fix the `EADDRINUSE` itself: the shutdown path leaves port 4001 held. Verify
  `shutdown()` in `server/src/index.ts` closes the HTTP server and the `ws` server before
  `process.exit`, and that `SHUTDOWN_DRAIN_MS` is not exceeded by the pm2 kill timeout
  (set `kill_timeout` above it).

---

## B. High-leverage enhancements

### B1. A client test harness, starting with the reducer (**M**)
There are zero client tests and 189 client TS files. Every replay-correctness claim in
`CLAUDE.md` rests on three pure modules — `lib/store.tsx`'s reducer, `lib/transcript-rows.ts`,
`lib/tools/*` — all of which are pure functions over recorded events and therefore the
cheapest possible things to test.

Add `vitest` to `client/`, a `test` script, and three suites:
- `store.test.ts` — feed recorded `session/update` sequences through `applySessionUpdate`:
  ownership resolution (`owner`, both `_meta` shapes and the child-session-id fallback),
  `appendText` coalescing on kind *and* `parentId`, `applyTerminalMeta` accumulation, the
  A9 re-announce case, compaction patch semantics (absent ≠ empty).
- `transcript-rows.test.ts` — `buildRows` nesting with a child preceding its parent,
  orphan flattening, `mergeWorkflowRuns`, `rowTailId` (A10).
- `tools.test.ts` — `toolViewOf`/`extract*` over one fixture per runtime shape, including
  `mcp__web-search__web_search` name parsing and `extractWebSearch`'s four result shapes.

Fixtures come free: dump real `session_events` payloads from a dev database.

### B2. Server test coverage on the irreversible paths (**M**)
**Gap 25.** Ranked by blast radius, none currently covered:
- the auth boundary — `/api/*` bearer, `/ws?token=`, and that `/gw`, `/ide`, `/wf` reject a
  wrong key (only the gateway 404 is tested);
- journal retention and purge (`sessions.ts:515-537`) — code that *destroys* transcripts,
  plus the `days > 0` trash guard;
- `materialize.ts` — the union-across-live-threads rule exists because it once yanked
  symlinks out from under a sibling thread;
- `push.ts` — batching at exactly 500, where an off-by-one costs *every* device;
- `scheduler.ts` mid-turn deferral (pairs with A7);
- `shutdown()` ordering (pairs with A18).

Also: un-`&&`-chain `server/package.json`'s `test` so the first failure stops hiding every
later suite — run them sequentially via a small `test/all.mjs` that reports all results and
exits non-zero if any failed.

### B3. CI (**S**)
There is no `.github/`. A single workflow running `pnpm -C server exec tsc --noEmit`,
`pnpm -C client exec tsc -b`, `pnpm -C server test` and (after B1) `pnpm -C client test` on
push turns every item above into a regression guard instead of a one-time fix. Do this
immediately after B1/B2 land, not before — a red CI on day one gets ignored.

### B4. Revive ESLint (**S**)
**Gap 24.** `eslint .` throws at config load: `typescript-eslint@8` does not support
`typescript@~7.0.2`. 189 files — including the reducer and every hook-heavy component —
have had no `react-hooks` linting (exhaustive-deps, rules-of-hooks) since the TS 7 bump.
Options in order of preference: upgrade `typescript-eslint` to a TS-7-supporting release;
failing that, run `eslint-plugin-react-hooks` standalone with the non-type-aware parser,
which is where the real value is. Add an eslint config and script to `server/` too (it has
neither). Expect a large first-run backlog — fix `rules-of-hooks` errors, warn-only on the
rest.

### B5. Structured logging and a health surface (**M**)
Today the only diagnostic is `console.log`/`console.error` into an unrotated pm2 file, and
several failure paths (`scheduler.fire`, `SessionJournal.flush`'s retry, `ide.adoptOrphans`)
log and continue with nothing that surfaces. Introduce a tiny `server/src/log.ts` —
level + a `{ sessionId, runId, projectId }` context object, JSON lines — and route the
existing call sites through it. Then extend `/api/health` (authenticated branch) with
counts that make the sharp edges visible: live bridges, threads mid-turn, pending
permissions, running workflow runs, queued messages, last journal flush error, FTS backfill
state. Every one of those is already in memory or one query away.

### B6. Bound the journal-write failure mode (**S**)
`SessionJournal.flush`'s retry path currently increments `eventCount` before the write can
fail, which is what makes seq gaps possible (root cause of A13/A14). Advance `eventCount`
only on a successful commit, and expose the count of dropped events through B5's health
surface. Small change, removes the precondition for two other bugs.

### B7. Client render-cost measurement on long transcripts (**M**)
The batching work (`?batch=1`, the `attached`/`caught_up` buffer) was driven by a real
symptom, but nothing measures it. Add a dev-only timing hook around the `batch` reducer
action and `buildRows`, reported through the existing debug surface. `buildRows` runs on
every store commit over the full item list; if it shows up, memoise it per
`(items.length, lastItemVersion)` — but measure first.

### B8. Make `search_meta` repairable from the UI (**S**)
Pairs with A1/A14. A "Rebuild search index" action in Settings that resets
`search_meta.fts_backfill` and re-runs `backfillSearchIndex` turns a class of permanent
corruption into a button. The function already exists; it needs a route and a control.

---

## C. Product opportunities

### Cheap, because the architecture already carries them

**C1. Thread export / share (S–M).** The journal is already a durable, ordered,
self-describing event log, and `buildRows` already turns it into a tree. A read-only
export — markdown, or a static HTML page replaying the same rows — is a new consumer of
`SessionJournal.eventsFrom` plus the existing client render path. No agent, no process.

**C2. Workflow templates and a run history view (M).** `workflow_runs` already stores one
row per run with a `steps` JSON column, and every step is a real, searchable, revivable
session. A "runs of this workflow across all threads" page is one query; saving a validated
definition as a reusable, parameterised template is a library row beside
`builtin:workflow` — the same shape `BUILTIN_MCP` already uses.

**C3. Per-project or per-profile usage and cost reporting (M).** ACP usage arrives on
`session_config` and is already journaled; the web-search ledger already exists with the
`mirrored` flag preventing double-counting. Aggregating tokens by project, profile and
model is a query plus a page — the data is captured, just never summed.

**C4. Cross-thread search filters (S).** `searchEvents` already returns session ids and the
FTS index already carries every journaled event. Filtering by project, profile, agent or
date range is a join against `sessions`, not new indexing work.

**C5. A "resume this thread elsewhere" handoff (M).** `acp_session_id` plus the
provisional/proven ranking already models "which agent store holds this conversation".
Exporting that pointer with the profile and cwd lets a thread be picked up on another
install running the same agent — the id is the only thing that matters and it is already
the one thing the system refuses to get wrong.

**C6. Notification rules (S).** `push.ts` already batches, topics and TTLs; `hostFor`
already gates children out. Per-thread or per-project mute, and "notify only on permission
requests", are predicates in front of an existing send path.

### Expensive, and worth knowing why

**C7. Multi-user / multi-tenant.** Every ownership decision in the server is
single-tenant by construction: one bearer token gates everything, the `/gw`, `/ide` and
`/wf` keys are process-global capabilities minted per boot and shared by every child, the
`SessionManager` holds one in-memory map of bridges, and `code-server` runs `--auth none`
with the harness's own uid. Adding users means a real identity model, per-user key
derivation on three key-in-path routes, per-user process isolation (uid or container) for
agents and editors, and row-level scoping on every table in `db/schema.ts`. This is a
rewrite of the trust boundary, not a feature.

**C8. Horizontal scaling / clustering.** `ecosystem.config.cjs` runs fork mode
deliberately: the agent child processes, the WebSocket peers and the synchronous
better-sqlite3 handle are all owned by one process, and a second fork could not see
another's bridges. Scaling out requires a process-routing layer (which node owns thread X),
a shared event bus for the journal fan-out, and an async database driver — but the driver
was chosen *because* `getProfile`/`getAgent`/`listProjects` are called from synchronous
spawn paths, so that change reaches `resolveSpawn` and everything above it. Vertical
scaling is the honest answer here.

---

## Suggested 2-week sequencing

Assumes one engineer. Items in parentheses are the tier IDs above.

**Week 1 — stop the bleeding, then build the net.**

- *Day 1* — Data-loss and security triage, all server-side, all independently testable:
  **A3** (workflow authz), **A5** (IDE lock mode + `verifyPid` fallback), **A7**
  (schedule deliver-then-delete). Ship these first; they are the ones where the failure is
  silent and irreversible.
- *Day 2* — Backup correctness as one unit, since all three touch `importBundle`:
  **A1** (FTS reconcile), **A2** (event scoping), **A8** (schedule fields). Extend
  `server/test/backup.test.ts` alongside, not after.
- *Day 3* — **A6** (retention vs restore; needs the schema column and `pnpm db:push`) and
  **A4** (respawn closes peers). Both change behaviour visible to a second device — verify
  manually with two browsers before moving on.
- *Day 4* — Journal integrity: **B6** (advance `eventCount` only on commit) first, because
  it removes the precondition, then **A15** (atomic retry), **A13** (seq-based cursors,
  both ends), **A14** (backfill cursor + repair path). New `server/test/journal.test.ts`
  covers all four.
- *Day 5* — **B3** CI skeleton (typecheck + server tests) and **A18** deploy hardening,
  including the `EADDRINUSE` root cause in `shutdown()`. Ending the week with CI green
  means everything after this is guarded.

**Week 2 — client correctness, then leverage.**

- *Day 6* — **B1** part one: vitest in `client/`, fixtures dumped from a dev database,
  `store.test.ts` written against *current* behaviour so the next day's fixes are visible
  as diffs.
- *Day 7* — Client fixes with the tests in place: **A9** (terminal/meta merge),
  **A10** (`rowTailId` keying), **A17** (both plan defects), **A12** (SW denylist).
- *Day 8* — **B1** part two: `transcript-rows.test.ts` and `tools.test.ts`; wire the client
  suite into CI.
- *Day 9* — **A11** + **A16** (CORS, Origin, constant-time bearer, `?token=` audit) as one
  security pass, plus **B2**'s auth-boundary suite, which is the natural test for it.
- *Day 10* — **B4** (revive ESLint; expect a backlog — land `rules-of-hooks` as errors,
  everything else as warnings) and **B5** (structured logging + health counts), which makes
  the remaining `console.error` paths from week 1 actually observable.

**Deferred past the two weeks, in order:** the rest of **B2** (retention, `materialize`,
`push`, scheduler, shutdown suites), **B8** (search rebuild button), **B7** (render-cost
measurement), then tier C — of which **C1** and **C4** are the smallest first wins.
