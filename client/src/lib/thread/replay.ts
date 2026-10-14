import { AgentError, type ThreadCallbacks } from "../thread-socket"
import { emptyThread } from "../store"
import { carryOf } from "./carry"
import { recordThreadError } from "./record-error"
import type { FoldContext } from "./fold-context"

/**
 * The replay bracket: `attached` … frames … `caught_up`, and the
 * `load_earlier` re-fold that reuses it.
 *
 * These are the bodies of six of the callbacks in `makeThreadCallbacks` and
 * nothing else — the object itself is still built in one place, from one
 * literal, and handed whole to one socket. Replay and the live socket remain
 * one code path through the same `handle` switch on the other side of it:
 * there is no second parser here, only the half of the sink that knows what a
 * bracket means.
 *
 * Every signature is taken from `ThreadCallbacks` rather than restated, so a
 * field added to the wire reaches these the way it reaches the socket.
 */
type Fold<K extends keyof ThreadCallbacks> = (
  ctx: FoldContext,
  ...args: Parameters<ThreadCallbacks[K]>
) => void

/* The replay is about to start. `resumed` decides what happens to what is
   already on screen: a resume is a delta this device asked for and the
   transcript is kept and extended, anything else replaces it. That used to
   be read off `from > 0`, which stopped being enough once the server could
   pick a `from` of its own for a windowed attach — a case where `from` is
   large and the transcript must still be replaced. */
export const foldAttached: Fold<"onAttached"> = (
  ctx,
  { from, to, resumed, earlier, archived, turns },
  historyLost
) => {
  const { host, sink } = ctx
  const id = host.id
  const { send } = sink
  ctx.attachedArchived = archived
  sink.open()
  /* How long this is going to be, before any of it arrives. Zero total
     means the server did not say (one that predates the field), which is
     not the same as a short replay and must not read as one. */
  const total = Math.max(0, to - from)
  host.apply({ type: "attached", total })
  /* Keep what is on screen when resuming; replace it otherwise. A reset
     would throw away the transcript a delta is about to extend, and a
     delta appended onto a stale transcript would double-render whatever
     the server re-sends. The status is left to the socket's `onStatus`
     flow and only committed at `caught_up`; touching it here would race
     the connect() we are inside. */
  if (!resumed) {
    /* Take the rows this device owns out of the transcript before it is
       replaced, and put them back once the replay has landed. Without
       this the reset simply deleted them: the message the user has just
       sent and not yet had acknowledged, and any failure this client had
       recorded — which is exactly how a failed send became an empty
       thread with no explanation in it. */
    ctx.carried = carryOf(host.getState().threads[id]?.items ?? [])
    /* What each turn did to the worktree survives the reset: it is not
       part of what the replay rebuilds — it is the server's own
       measurement, keyed by turn id and seeded once by
       `GET /api/sessions/:id/changes` when the transcript opened. That
       GET beats the replay to the store on a reload, so resetting to
       `emptyThread` here is what left the "N files changed" chips off
       every reloaded thread, with nothing to fetch them again. */
    send({
      type: "thread-reset",
      id,
      thread: {
        ...emptyThread,
        phase: host.phaseNow(),
        turnChanges: host.getState().threads[id]?.turnChanges ?? {},
        /* The journal's turn list survives the reset like `turnChanges`:
           it is the server's own measurement and the replay that follows
           only rebuilds what the window sent. Replaced below by this
           attach's own list when the server sent one. */
        turns: host.getState().threads[id]?.turns ?? [],
        /* And this device's own un-answered config change, for the same
           reason: the attach that follows a restart is the one moment it
           matters most, and resetting it here would blank the menus back
           to the settings the user has just moved away from — for the
           length of a `session/load`. It is dropped by the answer
           (`spawn_config`), never by a rebuild. */
        pendingConfig: host.getState().threads[id]?.pendingConfig ?? null,
      },
    })
    /* This attach's own table of contents, replacing what the reset
       carried over. Absent on an older server — which keeps the old list
       — and on no path but this one. */
    if (turns !== undefined) send({ type: "thread-turns", id, turns })
  }
  send({ type: "thread-window", id, archived, earlier })
  /* The agent would not reload this conversation, so the replay about to
     arrive is empty. Said here rather than left to look like a quiet
     thread — and through `send`, so it lands inside the same fold as the
     (empty) transcript it belongs to rather than ahead of the reset above.
     Repeated on every reattach because the server holds it for as long as
     the process that failed the load is the one running. */
  if (historyLost) {
    /* A warning, not a failure: the thread is usable and continues in a fresh
       session. The id the load was attempted with is still the only way back,
       so it is in the detail — and in what Copy takes. */
    recordThreadError(send, id, new AgentError(historyLost.error), "Couldn't restore this thread's history", {
      reason: "The agent could not load this conversation, so the thread continues in a fresh session.",
      severity: "warning",
      detail: `Lost session id: ${historyLost.acpSessionId}`,
    })
  }
}

/* A frame of history landed. Commit it — the transcript grows a screenful
   at a time instead of appearing whole at the end — and say where the
   replay has got to. */
export const foldReplayProgress: Fold<"onReplayProgress"> = (ctx, done, total) => {
  ctx.host.apply({ type: "replay-progress", done, total })
  /* …except when this replay is *replacing* a transcript that is on
     screen and correct. Then the progress is worth saying and the frames
     are not: they land together at `caught_up`, and the swap is one
     commit the reader never sees happen. See `ConnectOpts.seamless`. */
  if (!ctx.host.state.seamless) ctx.sink.commit()
}

/* The resume point, kept current as the thread streams rather than written
   once at `caught_up` — see `ThreadSocket.cursor` for what the frozen one
   cost. Deliberately not a dispatch: nothing renders from it, and it moves
   at the rate the agent writes. */
export const foldCursor: Fold<"onCursor"> = (ctx, cursor) => {
  ctx.host.state.cursor = cursor
}

export const foldCaughtUp: Fold<"onCaughtUp"> = (
  ctx,
  cursor,
  promptActive,
  queue,
  hold,
  staged,
  context,
  retry,
  tps
) => {
  const { host, sink } = ctx
  const id = host.id
  const { send, flush } = sink
  host.state.cursor = cursor
  host.state.seamless = false
  if (host.isCurrent(ctx.owner())) host.state.promptActiveAtLoad = promptActive
  /* The document (or the socket) reached the end of what it had. An
     archived thread stops here for good — there is no socket coming — and
     everything else is now waiting on one. */
  host.apply({ type: "caught-up", archived: ctx.attachedArchived })
  /* Inside the same fold as the transcript they belong to, so they are
     committed with it rather than appearing a frame later on top of a
     thread that had briefly lost them. */
  if (ctx.carried.length) {
    send({ type: "thread-carry", id, items: ctx.carried })
    ctx.carried = []
  }
  if (promptActive) send({ type: "turn-active", id, active: true })
  // Not journaled, so it rides here — the way an open permission is handed
  // over after the replay rather than replayed.
  send({ type: "queue", id, items: queue })
  send({ type: "paused", id, ...hold })
  /* And the retry, on the same terms: never journaled, seconds long, and
     the state a peer is most likely to attach in the middle of. */
  send({ type: "retry", id, retry })
  /* Absolute, and handed over here for the same reason the queue and the
     hold are: it is state the running turn is carrying, not history, so a
     replay never mentions it and an attaching peer would otherwise draw
     the menus as though nothing were waiting behind them. */
  send({ type: "staged-config", id, config: staged })
  /* And the context reading, which is the one of these four the replay
     *does* mention — and mentions wrongly. A window may hold no
     `usage_update` at all (a thread reopened at a tail of short turns
     drew "—" for a conversation the agent said was nearly full), and a
     `load_earlier` page holds older ones. The server keeps the newest on
     the row; it lands here, after the fold, so it is the last word. */
  send({ type: "thread-context", id, context })
  send({ type: "thread-tps", id, tps })
  flush()
}

/* A page of older history arrived and the socket is about to fold the
   widened window from the start. Everything but the items is carried over
   rather than reset to `emptyThread`: the agent may be mid-turn or holding
   a question open while someone scrolls back, and a question that vanished
   because the transcript above it grew would be a real loss. Per-step
   usage goes with the items: it is derived from where an update landed in
   the transcript being rebuilt, so carrying the cursor over would have the
   fold's first reading measured against a position from the last one. */
export const foldRewind: Fold<"onRewind"> = (ctx) => {
  const id = ctx.host.id
  ctx.sink.open()
  const current = ctx.host.getState().threads[id] ?? emptyThread
  ctx.sink.send({
    type: "thread-reset",
    id,
    thread: { ...current, items: [], stepUsage: {}, stepAt: {}, usageMark: null },
  })
}

/* The re-fold is committed as one render. `turnActive` is put back
   afterwards because the fold derives it from the events it saw, and a
   turn this device started itself has no `turn_started` in the log to
   re-derive it from — the prompter is the one peer that never gets one. */
export const foldRewound: Fold<"onRewound"> = (ctx, earlier) => {
  const id = ctx.host.id
  const { send, flush } = ctx.sink
  const before = ctx.host.getState().threads[id]
  const active = before?.turnActive ?? false
  send({ type: "thread-window", id, earlier, loadingEarlier: false })
  if (active) send({ type: "turn-active", id, active: true })
  /* Put back for the same reason: the fold derives the reading from the
     `usage_update`s in the widened window, and the ones it just paged in
     are older than the one on screen. There is no `caught_up` behind a
     re-fold to state it again, so the value carried across the reset is
     what stands. */
  send({ type: "thread-context", id, context: before?.context ?? null })
  flush()
}
