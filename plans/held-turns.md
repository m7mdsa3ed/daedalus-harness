# Held turns — a failed turn waits for a model change instead of ending

## Context

When a turn on the harness's own runtime (`agent/`) dies on a provider error — a
rate limit, an exhausted quota, a bad key — the whole turn is thrown away.
`handlePrompt` retries twice at 1s/2s (`agent/src/turn.ts:101-107`), and when
that is not enough it rethrows (`:213-216`), which ACP reports as a JSON-RPC
error and the bridge turns into a `turn_ended` carrying it
(`server/src/acp-bridge.ts:1264-1311`). The client draws an `ErrorRow` whose only
offer is **Retry** — re-sending the same prompt text from scratch
(`client/src/components/thread-cards.tsx:296-420`, `thread-view.tsx:494`).

That is the wrong shape for this failure. A rate limit is fixed by changing the
model or the profile, and by the time you have done that the turn's work —
twenty tool calls, a file read, a build run — is gone. Retry pays for all of it
again.

Worse, the turn does not fail cleanly, and this is a live bug independent of the
feature:

- `turn.ts:169-182` pushes `result.responseMessages` into `session.messages`
  **and appends them to the session's JSONL** *before* the error check at `:185`.
  A failed turn therefore permanently persists partial assistant messages —
  including assistant messages carrying tool calls with no matching tool
  results, which most providers reject outright. The in-memory rollback at
  `:188`/`:206` never reaches disk: `agent/src/persistence.ts` is append-only and
  its only barrier is `{t:"compact"}`, which clears *everything* (`:173`).
- `prepareStep` (`:143-152`) pushes steered messages into `session.messages`,
  persists them, **and** journals a `user_message_chunk` for each. The rollback
  truncates to `msgsBefore`, which is *before* those steers — so a retried
  attempt today drops the user's steered words from memory while leaving them in
  the JSONL and leaving a duplicate bubble in the replay.
- `turn.ts:102-106` pops and re-pushes the same `userMessage` object on every
  retry. It reads like re-anchoring the user turn; it does nothing.

**The outcome we want:** a turn that fails is *held* at its step boundary rather
than ended. Every completed tool call and result stays. The user changes the
model from the thread config menu — which already works live and mid-turn
(`applyConfigLive`, `server/src/sessions.ts:1527-1620`) — presses Continue, and
the same turn carries on from the next model step against the new model. No
re-typed prompt, no duplicated user message, no repeated tool work. Nothing
recovers automatically: no model fallback, no Retry-After backoff. The user's
action is what resumes it.

This is not a new mechanism. The runtime already owns its loop and already holds
it at a step boundary for the harness's pause (`_daedalus/session/pause`,
`Session.gate` at `agent/src/session.ts:187-199`). A failure hold is the same
wait on the same gate with a different reason — and it is modelled that way
throughout, rather than as a parallel state.

## Scope

**In:** the held state in `agent/`, a `reason` on the existing `paused` event,
one new agent→server notification, an explicit Continue, and the write reordering
that makes a failed or held turn leave a clean history.

**Out, and deliberately:**

- **Subagent holds.** `runSubagent` (`turn.ts:426-535`) re-sends its whole prompt
  on every attempt and never accumulates `responseMessages`, so a held-then-
  continued subagent would re-run every tool it already ran — the exact thing
  this feature exists to prevent. And `session.hold` is one slot on a session
  that can have several subagents in flight in one step: one child's hold would
  freeze a sibling for a reason it never hit. A subagent provider error stays a
  thrown error → `tool-error` part → the parent carries on, which is already
  graceful. The prerequisite for changing this is giving `runSubagent` its own
  accumulated message list.
- **Compaction failure.** `turn.ts:78-86` already degrades to an uncompacted
  turn. Holding there turns a working fallback into a stall.
- **Tool errors.** They already go back to the model as `tool-error` and are not
  turn failures.
- **`refusal` / `max_tokens`.** These arrive as a `finish` part and map to a
  *successful* `PromptResponse` (`turn.ts:862-869`), not an error. They are not
  turn failures on the wire and are left alone.
- **Resuming across a respawn.** A profile change with no catalog, a persona
  change or an agent change kills the process (`respawnNow`, `sessions.ts:1661`)
  and the held turn goes with it. That case keeps today's behaviour — a
  `turn_ended` and a Retry row — but the write reordering finally makes it a
  *clean* retry. The config menu warns first (§6), and the prompt-level resume
  below is the fallback.
- **Automatic model fallback and Retry-After backoff.**

## Design

### 1. A hold is a reason on the pause — `agent/src/session.ts`

Replace `paused: boolean` (`:50`) with:

```ts
export type Hold =
  | { kind: "paused" }
  | { kind: "error"; message: string; detail?: string }
hold: Hold | null
```

- `gate(signal)` (`:187`) waits while `hold !== null`. Otherwise unchanged — it
  is still "the step before it finished whole, and the one after has not begun".
  It keeps throwing the fabricated `AbortError` (`:206-210`) on cancel, because
  it sits inside `prepareStep` where the SDK wants an abort shape.
- `pause()` sets `{kind:"paused"}`; `resume()` clears and releases; `cancel()`
  clears, aborts and releases. Meanings unchanged. A user pause taken while
  held-on-error must not overwrite the reason; one release path, one
  `resumeWaiters` list.
- **New `holdError(hold, signal): Promise<"released" | "cancelled">`.** It
  **resolves with a discriminant — it must not throw.** A throw would propagate
  to the outer catch at `turn.ts:213`, `settleParked(reject)` and rethrow, so
  pressing Stop on a held turn would draw a red failure card instead of the clean
  `stopReason: "cancelled"` that the existing pause-then-cancel test
  (`agent/test/turn.test.ts:132-159`) establishes as the contract.
- A `holdOnError` flag on the session, default true, set false for unattended
  sessions (§5).

### 2. The turn holds instead of throwing — `agent/src/turn.ts`

`handlePrompt`'s `for (let attempt = ...)` (`:101`) becomes a `while (true)` with
an explicit counter so the budget can reset after a hold. Drop the dead
pop-and-re-push preamble at `:102-106` rather than porting it.

**Fix the persistence divergence by reordering the writes, not by adding a
record.** Per attempt:

1. Push `generated` (`result.responseMessages`) into `session.messages` in
   memory — the retry/hold rollback needs it there — but **do not**
   `store.appendMessages` yet.
2. Check `outcome.error`.
3. On success: `store.appendMessages(session.id, generated)`, then continue as
   today.
4. On error: truncate memory to `msgsBefore` **and re-append any messages
   steered during this attempt**, which are already persisted and journaled and
   must survive. Keep them in a `steeredThisAttempt` array that `prepareStep`
   fills. Persist nothing else. This also fixes the pre-existing steer-drop and
   duplicate-bubble bugs.

No `{t:"rollback", n}` record: it would delete the user's own steered words on
replay, it is relative so a torn tail line misapplies it, and it makes `read()`
order-dependent in a way `compact` is not. If a case turns up that genuinely
cannot be reordered, the right shape is an **absolute** `{t:"keep", n}` barrier
applied as `history.messages.length = Math.min(history.messages.length, n)`.

Then, on a terminal error — non-retriable, or retries exhausted — when
`session.holdOnError`, not aborted, and not a subagent:

1. Set the hold and notify the harness (§3).
2. `const outcome = await session.holdError(...)`.
3. `"cancelled"` → return `{ stopReason: "cancelled", usage }` and
   `settleParked(resolve)`. `"released"` → reset the attempt counter and
   `continue`; `:120` re-evaluates `deps.makeModel(deps.env, session.modelId)`
   on every pass, so a model changed while held is picked up with no further
   plumbing.

The hold point must be reachable from **both** the inner catch and the outer
one: `failNoModel()` and `makeModel()` throw at `:120`, outside the inner `try`
at `:168`. `failNoModel` should hold — it is literally "no model configured, pick
one" — but when `readModelAllowlist` found no `availableModels` the select has
one entry and the hold is a dead end, so the UI needs a prominent Cancel.

**Accumulate usage across attempts.** `:199` returns the *last attempt's*
`outcome.totalUsage`. A turn that burned 60k tokens, hit a quota wall, held, and
finished on a second model would report only the second model's tokens, and
`refreshQuota` (`bridge-host.ts:73`) runs once at settle — so the ledger would
under-report exactly the expensive turns. A hold makes multi-attempt turns
common rather than an edge case, so sum a `turnUsage` in `handlePrompt` and
return that.

### 3. The wire — widen `paused`, do not add `held`

A new event, capability, bridge field and client state machine would duplicate a
pipeline that is already absolute and already carried on `caught_up`
(`protocol.ts:713`, `:782-785`). Note also that `AcpBridge.held` already exists
as the parked-prompts array (`acp-bridge.ts:415-419`), so a second `held` in that
file would collide.

- **`server/src/protocol.ts`**: widen the existing event to
  `{ ev: "paused"; paused: boolean; reason?: "user" | "error"; error?: WireError }`
  and give `caught_up` the same optional fields. Still live-only, still absolute,
  still never journaled.
- **`agent/src/app.ts`**: the one genuinely new piece is an **inbound**
  notification, because today the bridge only ever learns `paused` from its own
  request's reply (`acp-bridge.ts:1447-1453`) — there is no agent→server path.
  Add `_daedalus/session/paused { sessionId, paused, reason, message?, detail? }`
  as an agent→client notification, beside the existing `PAUSE_METHOD` /
  `RESUME_METHOD` (`app.ts:15-17`) and under the same `daedalus/pause`
  capability (`:116`).
- **`_daedalus/session/resume` grows an options bag from day one**:
  `{ sessionId, compact?: true }`. Context-length is the one hold a model change
  often cannot fix — `windowSize(env)` is env-derived, not model-derived, and
  `needsCompaction` is checked once at `turn.ts:76`, before the user message
  joins — so "Compact and continue" needs to be a second button later, not a
  second wire method.
- **`server/src/acp-bridge.ts`**: register the inbound handler beside the others
  (`:487-510`); set `this.paused` plus a new `pausedReason`/`pausedError` and
  emit the widened event. `session-socket.ts:207` and `:302` carry it on
  `caught_up`.
- The existing `resume` ThreadCommand (`protocol.ts:513-517`) releases both.
  `session_config.canPause` already gates the affordance. No new command.

### 4. Continue is explicit — `server/src/sessions.ts`

`applyConfigLive` already runs happily mid-turn and leaves the running turn
alone. **Do not auto-resume from it**: it fires for effort-only changes the user
never meant as a release, and it would be implicit where the user asked for
explicit. The held card carries **Continue**, and the config menu, after a
successful live change while held, surfaces "Continue the held turn".

One exception: the gateway-only retarget (`moving && !wire`, `sessions.ts:1599`),
where nothing is said to the agent at all and a resume is the only signal
available.

### 5. Unattended turns must not hold

`routines.ts:1127` and `workflows.ts:860` both `await manager.whenTurnSettled`.
A held turn never settles, so a scheduled routine or a workflow step that hits a
rate limit would **block forever** where today it fails fast and the run reports.
There is nobody at a config menu for these.

Set `holdOnError = false` for those sessions at spawn. The server already knows
which they are: `session.parentSessionId` marks a workflow step
(`bridge-host.ts:38`, `sessions.ts:507`). Routines drive an ordinary thread, so
they need an explicit flag on the prompt path. Do **not** lean on
`whenTurnSettled` timeouts.

### 6. The rest of the server

- **A hold deadline.** The idle sweep skips any session with
  `bridge.promptActive` (`sessions.ts:502-512`), and a held turn keeps
  `inflight ≥ 1`. With zero peers that pins a node process indefinitely, and rate
  limits are common. Record `heldSince` on the bridge; a session held longer than
  a generous, configurable deadline with `peers.size === 0` gets `bridge.cancel()`
  first — a clean `stopReason: "cancelled"`, the queue parks, no error card —
  and then retires normally.
- **Tell the user it held.** `onTurnEnd` (`server/src/index.ts:98-108`) is the
  only turn-lifecycle push and fires only from `settleTurn`, so the overnight
  case — the whole motivation — would be silent. Add `onTurnHeld` beside it in
  `bridge-host.ts:67`, an `addNotification("turn_held", …)` and a push with a new
  `turnHeld` event that `client/src/lib/notification-shape.ts` classifies as
  blocked, in the same family as `permissionNeeded`.
- **Warn before a respawn destroys a hold.** `POST /api/sessions/:id/config`
  (`routes/sessions.ts:236`) should be able to answer a preflight so
  `session-config.tsx` can say "this restarts the agent and ends the held turn"
  instead of silently destroying it.

### 7. The client

- `lib/thread/connection.ts` — the widened `paused` event and `caught_up` set a
  `pausedReason`/`pausedError` beside the existing pause state in
  `lib/store.tsx`. A held turn is **still `turnActive`**: no `ErrorRow`, no
  `lastTurnError`, no "turn failed" push.
- The composer's working line reads "Held — <reason>"; the existing Play button
  beside Stop (`components/composer.tsx:956-973`) is Continue; Stop still
  cancels.
- A held card in the transcript (`components/thread-cards.tsx`, drawn from
  `thread-items.tsx` like `ErrorRow`) says what failed, folds the detail the way
  `ErrorRow` does (`:353-368`), and offers Continue, Change model (opens
  `SessionConfigPopover`) and Cancel.
- The queue does not drain while held, which is correct — it drains at the real
  `turn_ended` — but the queue strip should say it is waiting rather than look
  stuck.

Steering a held turn already works for free: a non-steer prompt queues while
`promptActive` (`sessions.ts:1856`), and a steer lands in `steerQueue`, drained
by `prepareStep` *after* the gate. "Type a note, then Continue" does the right
thing with no new code.

## The other three runtimes — how much of this ports

Short answer: **the hold does not port; the resume does.**

### Why a hold is only possible for `daedalus`

A hold is a wait at a step boundary inside the model loop, and `agent/` is the
only runtime whose loop is ours. `CLAUDE.md` already states the rule — ACP's only
interruption is `session/cancel`, which throws the step in flight away, so pause
is the harness's own pair (`_daedalus/session/pause`) and is *taken only by our
runtime*. The wiring says the same: `AcpBridge.canPause` reads
`agentCapabilities._meta["daedalus/pause"]` (`server/src/acp-bridge.ts:1385-1387`)
and the only thing that sets it is `agent/src/app.ts:116`.

So for Claude Code, Codex and OpenCode there is no place to stand. We cannot hold
a step we are not running, we cannot roll back a history we do not own, and
faking it by cancelling and re-prompting would destroy the tool call in flight —
the precise opposite of the guarantee this feature exists to make. **Do not fake
a hold for a third-party runtime.**

### What does port: resume at prompt granularity

Their conversation is theirs, and it survives a failed turn. The runtime has
already recorded the user's prompt and whatever tool work completed before the
error, in its own rollout. That makes today's Retry the *wrong* verb for them:
re-sending the original prompt text (`turn_ended.promptText` →
`client/src/components/thread-view.tsx:494`) adds a second copy of a message
their history already has.

The right verb is the continuation nudge the client already owns —
`actions.send(sessionId, "Continue.")` at `thread-view.tsx:493`, today offered
only after an interrupt notice (`resumable`, `:485-489`, which explicitly
excludes `phase.kind === "failed"`). The change is small and entirely
server/client-side:

- Let a **failed** turn be resumable, not just an interrupted one — widen
  `resumable` and drop the `failed` exclusion for runtimes that have no hold.
- After a live config change on a thread whose last turn failed
  (`session.lastTurnError`, `server/src/sessions.ts:808-811`, already persisted
  and already reported by `list()`), offer **"Continue on the new model"** in the
  config menu and on the error row.

That is the option deliberately *not* taken for `daedalus` — it loses the
step-level guarantee — but for the other three it is the best that is available,
and it is strictly better than what they do now.

### What each runtime can actually do (`server/src/registry.ts`)

| Runtime | `liveConfig` | A model change mid-thread | Resume verb |
| --- | --- | --- | --- |
| `daedalus` | `"acp"` (`:644`) | live | **step-level hold + Continue** (this plan) |
| `claude-code` | `"acp"` (`:510`) | live, via `set_config_option` behind the gateway shim | `"Continue."` |
| `codex` | `"gateway"` (`:560`) | live — the row is what the shim reads and the child never learns it moved | `"Continue."` |
| `opencode` | **none** (`:601-606`) | **respawn** | `"Continue."` after the `session/load` |

OpenCode is the weakest case: with no `liveConfig`, every model or profile change
falls through to `respawnNow` (`sessions.ts:1661`), so even the prompt-level
resume costs a restart. `session/load` restores the conversation, and
`"Continue."` is still the right thing to send afterwards.

### Measure before building the shared half

Claude Code and Codex both retry internally and frequently surface a rate limit
as **prose in the transcript** rather than as a rejected `session/prompt` — in
which case there is no `turn_ended.error` to hang a resume off, and
`lastTurnError` stays null. Before building the shared "Continue on the new
model" affordance, drive each runtime into a real 429 (a profile with an
exhausted key) and record which of the three shapes comes back: a rejected
prompt, a `turn_ended` with an error, or ordinary assistant text. The affordance
can only attach to the first two.

### Recommended split

1. Build the step-level hold for `daedalus` (everything above). It is the only
   runtime that can have it, and it is the one this harness ships.
2. Then the shared, prompt-level "Continue on the new model" — server and client
   only, no agent work, reusing `turn_ended.promptText`, `lastTurnError` and the
   existing resume send. All four runtimes get it; for `daedalus` it is the
   fallback for the one case the hold cannot cover, a config change that forced a
   respawn.

## Build order

**Minimum viable slice** — agent-only plus the widened event; delivers the whole
goal (turn survives, tool work kept, change the model in the menu, press the
existing resume control, turn continues):

1. `agent/src/session.ts` — `Hold`, `gate`, `holdError`, `holdOnError`.
2. `agent/src/turn.ts` — `while(true)`; the write reordering and steer
   preservation; usage accumulation; the hold on terminal error;
   `"cancelled"` → `stopReason: "cancelled"`. `runSubagent` untouched.
3. `agent/src/app.ts` — emit `_daedalus/session/paused`; accept
   `_daedalus/session/resume { compact? }`.
4. `server/src/acp-bridge.ts` — inbound handler, `pausedReason`, widened emit.
5. `server/src/protocol.ts` + `session-socket.ts` — `reason`/`error` on `paused`
   and `caught_up`.
6. Client — `pausedReason` on the existing paused state, one label change.

**Then:** `holdOnError = false` for unattended sessions (§5 — do this before
anyone runs a routine against it), the hold deadline and sweep change, the
`onTurnHeld` push, the respawn-while-held warning, the dedicated held card, and
"Compact and continue".

**Last, and separately:** the shared prompt-level "Continue on the new model",
which is the only thing the other three runtimes can have and is also
`daedalus`'s fallback for a config change that forced a respawn. Server and
client only — measure the failure shapes first (see above).

## Verification

`cd agent && pnpm test`; `cd server && pnpm test`; `pnpm exec tsc --noEmit`
(server) and `pnpm exec tsc -b` (client).

**A test helper has to come first.** `scriptedModel`
(`agent/test/helpers/scripted.ts:70-81`) ignores its `modelId` argument and
shifts a global queue, so it cannot express "the old model fails, the new model
succeeds" — the entire feature. Add `scriptedModelsById` keyed on the factory's
second argument. Without it only the release is testable, not the switch.

**Must change:** `agent/test/turn.test.ts:191-211` pins "provider error: the turn
fails as a JSON-RPC error, not a hang". Its `assert.rejects` becomes a hang under
the new default. Split it — keep a `holdOnError: false` version asserting the
rejection, add the hold version.

**New tests**, same in-process `connectWith` shape:

- *hold and continue on a new model*: a script that completes a bash tool call
  then errors; assert the `_daedalus/session/paused {reason:"error"}`
  notification arrived and the `tool_call_update` `completed` is still there;
  `session/set_config_option {model:"test-model-2"}`; `_daedalus/session/resume`;
  assert `stopReason: "end_turn"`, that the text came from the second model's
  script, and that **the bash tool ran once**.
- *hold then cancel*: `stopReason: "cancelled"`, not a rejection, and the next
  prompt runs immediately (mirrors `:132-159`).
- *no duplicate user message*: after continue,
  `harness.updatesOf("user_message_chunk").length === 1`.
- *steer while held*: a second `session/prompt` while held — both promises
  resolve at the one turn end and the steered text appears once in the journal.
- `agent/test/persistence.test.ts`: after a held-and-continued turn, `store.read()`
  yields no assistant message carrying a tool call without a matching tool
  result, and exactly one copy of each steer.
- `agent/test/subagents.test.ts`: a subagent provider error still becomes a tool
  error and the parent turn completes — subagents do **not** hold.
- Server: a live model change while held neither settles the turn nor emits
  `turn_ended`; a workflow step's session does not hold.

**By hand:** point a thread at a profile with a deliberately bad key or an
exhausted model, send a prompt that uses a tool, watch it hold, switch the model
in the thread config menu, press Continue, and confirm the turn carries on
without re-running the tool. Per `CLAUDE.md` the UI is checked by the user, not
by browser automation.
