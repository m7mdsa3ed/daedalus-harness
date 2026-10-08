/* Everything about a message on its way to the agent, and about the turn it
   starts: the send itself, the server-side queue behind it, pause/resume,
   compaction, a workflow run's hold, and the stop that takes back the message
   the user has not seen land yet.

   Kept as one file on purpose. Three of CLAUDE.md's rules are readable only
   because these sit together: a send flushes a staged config and **a queue
   drain and a steer do not**; the stop's take-back is asked for in the *same*
   call as the cancel, ahead of the settle that would flush a held steer; and a
   queued message never leaves the server until one of the queue commands here
   says so.

   Split out of the one 1500-line `useActions` memo; see `lib/actions.ts`. */

import type { AttachmentRef } from "@daedalus/protocol"
import { describeError, errorText } from "../errors"
import { ApiError } from "../settings"
import { toast } from "../toast"
import { uuid } from "../uuid"
import { postJson, type ActionsCore } from "./core"
import type { configActions } from "./config"

export function sendActions(
  core: ActionsCore,
  /* The config slice, for its flush alone: a pick made a moment before Enter
     has to be on the wire before the message it was made for. */
  config: Pick<ReturnType<typeof configActions>, "flushThreadConfig">
) {
  const {
    settings,
    dispatch,
    getState,
    threads,
    recordError,
    known,
    requireLive,
    createSession,
    cancelWait,
    refreshSessions,
  } = core
  const { flushThreadConfig } = config

  return {
    /** Stop waiting on a long start or revive; the typed message comes back
        through `send`'s own unsent path. */
    cancelWait,

    /**
     * Send a prompt. A failure here is recorded in the transcript — with the
     * text, so the row can offer Retry — and then rethrown, so the composer
     * can react too. Callers must not toast it a second time.
     */
    async send(
      sessionId: string,
      text: string,
      opts: {
        steer?: boolean
        /** What this message carries. The refs are already uploaded — the
            composer refuses to send while one is in flight — so this is a
            list of ids plus the names the optimistic bubble draws before the
            round trip. Unknown or foreign ids are dropped server-side rather
            than refused: a stale draft id must not fail a send whose text is
            fine. */
        attachments?: AttachmentRef[]
        /** Pin every attachment to the materialise-and-link branch. One
            caller: the error row's "Retry as file paths". */
        forceLink?: boolean
        /** Offered the words back when the send died before anything reached
            the server. The composer answers `true` when it has taken them —
            a persisted draft the user can edit, where the error row it would
            otherwise live on is `local` and dies with a reload. Callers with
            nowhere to put them (Retry, Continue, the palette) leave it unset
            and keep the row's Retry. */
        onUnsent?: () => boolean
      } = {}
    ) {
      const attachments = opts.attachments ?? []
      const attachmentIds = attachments.map((ref) => ref.id)
      /**
       * Record a failure whose message never left this device.
       *
       * The words end up in exactly one place, and whoever holds them is who
       * offers to send them again: the composer if it took them back, the
       * error row's Retry if it did not.
       */
      const recordUnsent = (error: unknown, context: string) => {
        const reclaimed = opts.onUnsent?.() === true
        /* The user's own Cancel on a long wait is not a failure and draws no
           row — unless the words had nowhere to go back to, in which case the
           row is the only place they survive. */
        if (describeError(error).kind === "cancelled") {
          if (!reclaimed) {
            recordError(sessionId, new Error("Cancelled before the agent was ready."), "Message not sent", {
              text,
              attachments,
            })
          }
          return
        }
        recordError(
          sessionId,
          error,
          reclaimed ? `${context} — the text is back in the composer` : context,
          reclaimed ? undefined : { text, attachments }
        )
      }
      /* First message on a draft: show the message instantly, then create the
         thread on the server with the message in the same request. A failure
         leaves the draft a draft and lands the text in a Retry row like any
         other send failure — and retrying re-runs this, which is correct: if
         the POST never landed the id is still free, and if only its answer was
         lost the server hands the same answer back for the same id. */
      const draft = getState().sessions.find((s) => s.id === sessionId && s.draft)
      if (draft) {
        /* Show the message and connecting state instantly rather than waiting
           for the full server round-trip — the agent spawn, handshake and
           WebSocket replay can take seconds. On failure, clean up the
           optimistic state and record a Retry-able error. */
        dispatch({ type: "user-message", id: sessionId, text, local: true, sending: true, attachments })
        /* Only when there are words to take it from: an image with no
           sentence is a real prompt, and the server's own title sniff skips
           an empty one too — a thread called "" is worse than "New thread". */
        if (text) dispatch({ type: "session-title", id: sessionId, title: text.slice(0, 60) })
        dispatch({ type: "turn-active", id: sessionId, active: true })
        /* The message rides the create (`createSession`), which is the whole
           of the send: nothing goes over a socket after it. A pick made just
           before Enter is already on the draft row the create reads. */
        let created
        try {
          created = await createSession(
            draft,
            { text, attachmentIds },
            () => dispatch({ type: "settle-user-message", id: sessionId })
          )
        } catch (error) {
          threads.for(sessionId).markIdle()
          dispatch({ type: "drop-user-message", id: sessionId })
          dispatch({ type: "turn-active", id: sessionId, active: false })
          /* A 409 is this id already taken on the server — a create that
             landed on another tab, or long enough ago that the server no
             longer answers the retry for it. The refresh adopts the server's
             row, so this stops being a draft that 409s on every retry. */
          if (error instanceof ApiError && error.status === 409) await refreshSessions().catch(() => {})
          recordUnsent(error, "Couldn't start this thread")
          throw error
        }
        if (created.promptError) {
          /* The thread exists; its first message did not start. Nothing of it
             reached the agent, so the bubble comes off and the words go back. */
          dispatch({ type: "drop-user-message", id: sessionId })
          dispatch({ type: "turn-active", id: sessionId, active: false })
          recordUnsent(new Error(created.promptError), "The agent couldn't take this message")
          throw new Error(created.promptError)
        }
        return
      }
      const conn = threads.for(sessionId)
      /* Steering — a prompt sent while a turn is already running — is why this
         is read BEFORE anything below lights the indicator. If this send
         fails, it may only take back the indicator it turned on itself: a
         steer that never reaches the agent leaves the turn it was aimed at
         still running, and clearing the indicator there loses it until a
         reload (the server is still `promptActive`, so `caught_up` puts it
         straight back — which is exactly the "refresh brings it back" shape of
         the bug).

         Read before `ready` as well as before the dispatch, which is the one
         thing this loses: `ready` may attach to a process another peer has
         since put to work, and this will not have heard yet. That case is
         already answered rather than newly broken — the prompt below comes
         back `{queued}` and the optimistic bubble comes off there. */
      const alreadyRunning = getState().threads[sessionId]?.turnActive ?? false
      /* A message typed into a running turn is QUEUED, not steered, unless
         asked otherwise. No bubble and no indicator for it: the `queue` event
         draws the row, and when the turn ends the drained prompt comes back
         as a `turn_started` with no origin — so this device draws the bubble
         then, exactly like every other peer. If the turn ended before this
         server saw this, `queue_add` drains at once and the same holds. */
      const queueing = alreadyRunning && !opts.steer
      /* Drawn BEFORE `ready`, for the same reason a draft's is drawn before
         its create: `ready` is not a lookup, it is however long it takes to
         get a process and a socket under this thread — a retired agent is
         respawned and narrates the whole conversation back through
         `session/load`, which is seconds. The composer has already cleared
         the box by now, so a message held until that landed was a message
         that existed nowhere at all, under a thread saying "Restarting the
         agent…".

         Safe because the attach that follows no longer eats it: a non-resumed
         attach carries this device's own `local` untagged rows across the
         reset and puts them back with the replay (lib/thread/carry.ts). That
         is what a draft has relied on since it started drawing early, and it
         was the only thing keeping this send behind the round trip. */
      if (!queueing) {
        dispatch({ type: "user-message", id: sessionId, text, local: true, attachments })
        if (text) dispatch({ type: "session-title", id: sessionId, title: text.slice(0, 60) })
        dispatch({ type: "turn-active", id: sessionId, active: true })
      }
      /* Not "is there a socket" but "make there be one". Every reason there
         might not be — an open nobody has asked for yet, one half way
         through, a process that was retired, a ladder mid-backoff, a thread
         parked waiting for a server to come back — is something `ready` waits
         for or brings about. What still throws has a real reason (Trash, a
         deleted project, a server that refused to spawn) and says it.

         This replaces a bare read of a map that answered "This thread has no
         live connection to its agent — revive it and send again": a statement
         about this device's bookkeeping, dressed up as one about the thread,
         telling the user to press a button the client could press itself. */
      /* A pick made a moment ago is sent before the message it was made for.
         `changeThreadConfig` debounces the POST (400ms, 800ms for a profile),
         so choosing a model and hitting Enter straight after used to start
         the turn on the old settings and land the change *behind* it — which
         now matters much more than it did, because the server no longer takes
         a process-costing change when it is picked: it stages it, and the
         next prompt is what flushes it. A patch still sitting in this buffer
         is one the server has not been told about at all.

         Silent, because the toast it would otherwise raise says when the
         change will apply, and the answer is "the message you just sent".
         Drawn after the optimistic bubble on purpose: `send` has already put
         the words on screen, and a round trip in front of that is a composer
         that clears into nothing. */
      await flushThreadConfig(sessionId, { silent: true })
      let thread
      try {
        thread = await conn.ready()
      } catch (error) {
        if (!queueing) {
          /* Nothing reached the server, so the optimism above comes back off
             — the draft's own create-failure branch, one thread older. A
             bubble left standing here is a message that was never sent,
             drawn as one that was, and `recordUnsent` is already putting the
             words where they can be sent again. */
          dispatch({ type: "drop-user-message", id: sessionId })
          dispatch({ type: "turn-active", id: sessionId, active: false })
        }
        recordUnsent(error, "Couldn't send the message")
        throw error
      }
      if (queueing) {
        try {
          await thread.queueAdd(text, attachmentIds)
        } catch (error) {
          recordUnsent(error, "Couldn't queue this message")
          throw error
        }
        return
      }
      /* Re-asserted, like the indicator below: a revive inside `ready`
         refreshed the list, swapping the row carrying the optimistic title for
         the server's. The reducer's guard ("New thread" only) keeps a name the
         user chose safe from this. */
      if (text) dispatch({ type: "session-title", id: sessionId, title: text.slice(0, 60) })
      /* This device is the one peer that does not get a `turn_started` — it
         already put the message on screen — so it lights its own indicator.
         `turn_ended` is what clears it, here and everywhere else.

         Re-asserted rather than skipped, even though every path above has
         already lit it: `ready` has just opened the thread, and a non-resumed
         attach replaces the transcript with `emptyThread`, whose `turnActive`
         is false. The bubble survives that (carry.ts) and this does not, so
         every message that had to revive a thread ran its whole turn with no
         working indicator at all.
         `caught_up` cannot cover it either: it only relights the indicator
         when the SERVER says `promptActive`, and the prompt below has not
         been sent yet. Idempotent, so the ordinary path pays nothing for it. */
      dispatch({ type: "turn-active", id: sessionId, active: true })
      try {
        /* Resolves when the server has dispatched the prompt, not when the
           turn ends: how the turn went reaches every device on the thread as
           `turn_ended`, and awaiting it here would report a failure twice. */
        const reply = await thread.prompt(text, {
          steer: opts.steer,
          attachmentIds,
          forceLink: opts.forceLink,
        })
        if ("queued" in reply) {
          /* The server was busy before this device knew — another peer or
             the scheduler started a turn. The words are on the queue row
             now, so the optimistic bubble comes back off. */
          dispatch({ type: "drop-user-message", id: sessionId })
          if (!alreadyRunning) dispatch({ type: "turn-active", id: sessionId, active: true })
          return
        }
        if (reply.deferred) {
          /* A steer whose bubble the server is holding until the running
             step ends. The words ARE on the wire — this is not the queued
             case — but where they belong in the transcript is not known yet,
             and no runtime reads them before that boundary either. So the
             optimistic bubble comes off exactly as it does for a queue, and
             the held `turn_started` draws it at the position a reload will
             agree with. The indicator stays lit: the turn is running. */
          dispatch({ type: "drop-user-message", id: sessionId })
          return
        }
        dispatch({ type: "tag-user-turn", id: sessionId, turnId: reply.turnId })
      } catch (error) {
        dispatch({ type: "settle-user-message", id: sessionId })
        /* Where alreadyRunning was true, another turn is genuinely active
           and must not be disturbed. */
        if (!alreadyRunning) dispatch({ type: "turn-active", id: sessionId, active: false })
        recordError(sessionId, error, "The agent couldn't answer this message", {
          text,
          attachments,
        })
        throw error
      }
    },

    // ---- the queue ----
    // Each answers with a `queue` event to every peer; a failure lands in
    // the thread like any other, with the text where there is one to retry.

    async queueUpdate(
      sessionId: string,
      itemId: string,
      text: string,
      /** Omitted leaves the item's attachments alone; an empty array clears
          them. */
      attachmentIds?: string[]
    ) {
      try {
        await requireLive(sessionId).queueUpdate(itemId, text, attachmentIds)
      } catch (error) {
        recordError(sessionId, error, "Couldn't edit the queued message", text)
        throw error
      }
    },

    async queueReorder(sessionId: string, ids: string[]) {
      try {
        await requireLive(sessionId).queueReorder(ids)
      } catch (error) {
        recordError(sessionId, error, "Couldn't reorder the queue")
        throw error
      }
    },

    async queueRemove(sessionId: string, itemId: string) {
      try {
        await requireLive(sessionId).queueRemove(itemId)
      } catch (error) {
        recordError(sessionId, error, "Couldn't remove the queued message")
        throw error
      }
    },

    async queueClear(sessionId: string) {
      try {
        await requireLive(sessionId).queueClear()
      } catch (error) {
        recordError(sessionId, error, "Couldn't clear the queue")
        throw error
      }
    },

    /** Interrupt the running turn and send the queue (or one item) in its
        place — the picked rows, or all of them with no ids. No "interrupted" notice: `turn_ended` → `turn_started` says
        it, and the server does all three steps whether or not this tab
        stays open. */
    async queueSendNow(sessionId: string, itemIds?: string[]) {
      try {
        await requireLive(sessionId).queueSendNow(itemIds)
      } catch (error) {
        recordError(sessionId, error, "Couldn't send the queued message")
        throw error
      }
    },

    async queueSteer(sessionId: string, itemId: string) {
      try {
        await requireLive(sessionId).queueSteer(itemId)
      } catch (error) {
        recordError(sessionId, error, "Couldn't steer with the queued message")
        throw error
      }
    },

    /** Hold the turn at its next step boundary, or let it go on. The
        `paused` event is what moves the toggle, this device's included, so
        nothing is dispatched here. */
    async pause(sessionId: string) {
      await requireLive(sessionId).pause()
    },

    async resume(sessionId: string) {
      try {
        await threads.for(sessionId).ready().then((socket) => socket.resume())
      } catch (error) {
        recordError(sessionId, error, "Couldn't continue the turn")
        throw error
      }
    },

    /** Summarize the context now. Nothing is dispatched on the way out: the
        compaction announces itself as ordinary `compaction_update` /
        `compaction_summary_chunk` updates, which the transcript already draws
        and the journal already replays — so the surface it belongs on is
        drawing it before this promise settles.

        The one case with nothing to show is the booked one: a running turn
        summarizes at its next step boundary, which can be a whole tool call
        away, and until then a button that visibly did nothing is a button the
        user presses again. That gets the toast; the other cases do not. */
    async compact(sessionId: string) {
      try {
        const reply = await requireLive(sessionId).compact()
        if (reply.deferred) toast("Compacting when this step ends")
      } catch (error) {
        recordError(sessionId, error, "Couldn't compact the conversation")
        throw error
      }
    },

    /**
     * Run a `!` line against the thread's project and put the result in the
     * transcript. Not a prompt: the server runs it (`server/src/shell.ts`) and
     * journals a `_daedalus/shell` row, so the agent is never told and no turn
     * runs.
     *
     * The row is fanned out to every attached peer, but this device may hold no
     * socket — a thread opened to read has none, by design (`phase.ts`) — so
     * the fan-out would not reach the very screen that asked for it and the
     * line would leave no trace until the next attach. Drawn here from the
     * answer when that is the case, and *not* when it is not, or a live thread
     * would show the same command twice.
     */
    async runShell(sessionId: string, command: string) {
      const shellId = uuid()
      /* Drawn before the request leaves: a `!` line can take seconds, and one
         that showed nothing until it finished would read as a line that was
         ignored. It is keyed by the id the server journals under, so what
         follows *patches* this row rather than adding a second — by fan-out to
         a live socket, by this dispatch when there is none (a thread opened to
         read holds no socket — `phase.ts`), and by both when both happen. */
      dispatch({
        type: "update",
        id: sessionId,
        update: { sessionUpdate: "_daedalus/shell", shellId, status: "running", command },
      })
      const result = await postJson<{
        output: string
        exitCode: number | null
        timedOut: boolean
      }>(settings, `/api/sessions/${sessionId}/shell`, { command, shellId }).catch((err) => {
        /* The row must settle even when the request dies: the composer no
           longer holds the line (a `!` send is send-and-forget, like a
           prompt), so a `running` row left standing is the only place the
           failure would ever be said. Settled as a failed run — a non-zero
           exit with the error as its output — then rethrown for the caller's
           own error surface. */
        dispatch({
          type: "update",
          id: sessionId,
          update: {
            sessionUpdate: "_daedalus/shell",
            shellId,
            status: "done",
            command,
            output: errorText(err, "the request failed"),
            exitCode: 1,
            timedOut: false,
          },
        })
        throw err
      })
      dispatch({
        type: "update",
        id: sessionId,
        update: {
          sessionUpdate: "_daedalus/shell",
          shellId,
          status: "done",
          command,
          output: result.output,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
        },
      })
    },

    /** Hold or release a harness workflow run of this thread. The hold is
        said back as a journaled `_daedalus/workflow_state` on the thread,
        which is what moves the card. */
    async setWorkflowPaused(sessionId: string, runId: string, paused: boolean) {
      await postJson(settings, `/api/sessions/${sessionId}/workflows/${runId}/${paused ? "pause" : "resume"}`, {})
    },

    /**
     * Stop the running turn.
     *
     * `onReclaim` is the composer offering to take back the message the user
     * has not seen land yet — the newest queued row, or a steer the running
     * step never read. Escape is one gesture, so the take-back and the
     * cancel are one call: the server takes the words back BEFORE the settle
     * behind the cancel would flush a held steer into the transcript, which
     * two round trips from here could not guarantee.
     *
     * Offered, never assumed: a caller with nowhere to put the words leaves
     * it unset and the queue is untouched, because a message removed with
     * nobody to hold it is a message the user lost. Nothing comes back when
     * a step boundary got there first — the words landed, and the transcript
     * is where they are.
     */
    async stop(sessionId: string, opts: { onReclaim?: (text: string) => void } = {}) {
      const reply = await known(sessionId)?.live?.cancel(!!opts.onReclaim)
      if (reply?.reclaimed) opts.onReclaim?.(reply.reclaimed.text)
      /* The agent writes its own "[Request interrupted by user]" turn, but
         only the session/load replay surfaces it — without this the rule (and
         the Continue button on it) would not appear until a reload. */
      dispatch({ type: "notice", id: sessionId, text: "Request interrupted by user" })
    },
  }
}
