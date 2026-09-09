import { AgentError, type ThreadCallbacks, type ThreadSocket } from "../thread-socket"
import { optionKey, saveAgentOptions, savePromptCapabilities } from "../agent-options"
import { appendTaskEvent } from "../task-events"
import { notifyThreadEvent } from "../notifications"
import type { TextItem } from "../store"
import { recordThreadError } from "./record-error"
import { isRecoverableClose } from "./phase"
import { makeReplaySink } from "./replay-buffer"
import {
  foldAttached,
  foldCaughtUp,
  foldCursor,
  foldReplayProgress,
  foldRewind,
  foldRewound,
} from "./replay"
import type { CallbackHost, FoldContext } from "./fold-context"

/**
 * The one set of callbacks a `ThreadSocket` folds into — live events and
 * replayed ones alike.
 *
 * One object, built once per socket. The socket's `handle` switch is the one
 * parser and this is the one sink under it, which is what makes an HTTP replay
 * and a live connection the same code path: `ThreadSocket.load` and
 * `ThreadSocket.connect` hand their events to the very same functions, so a
 * field added to `attached` reaches both transports at once.
 *
 * `owner` resolves to the socket these callbacks belong to. A function rather
 * than the socket itself because the callbacks are built *while* constructing
 * it — see the guard in `onStatus`, which is what stops a closing socket from
 * speaking for the one that replaced it.
 */
export function makeThreadCallbacks(
  host: CallbackHost,
  owner: () => ThreadSocket
): ThreadCallbacks {
  const id = host.id
  const { getState } = host
  /* Everything thread-scoped goes through the sink's `send`, never `dispatch`
     — see lib/thread/replay-buffer.ts for the buffer it opens across a replay
     and the two rules that keep it honest. */
  const sink = makeReplaySink(host.dispatch, () => host.state.restarting)
  const { send, sendStream, flush } = sink
  const ctx: FoldContext = { host, sink, owner, carried: [], attachedArchived: false }
  return {
    onUpdate: (update, historyReplay, sessionId) => {
      sendStream({ type: "update", id, update, allowUserChunks: historyReplay, sessionId })
    },
    onSessionTitle: (title) => send({ type: "agent-session-title", id, title }),
    /* The agent is blocked on this question until somebody answers it. The
       server holds its promise now, so `resolve` is a message rather than a
       callback: it names the request the server minted, which is also how a
       peer's answer is matched against this card. */
    onPermission: (requestId, request) => {
      notifyThreadEvent("permissionNeeded", id, host.titleOf(), request.toolCall?.title ?? undefined)
      send({
        type: "permission",
        id,
        requestId,
        permission: {
          requestId,
          request,
          resolve: (response) => {
            send({ type: "permission", id, requestId, permission: null })
            owner().answerPermission(requestId, response)
          },
        },
      })
    },
    onElicitation: (requestId, request) => {
      notifyThreadEvent("questionAsked", id, host.titleOf(), request.message)
      send({
        type: "elicitation",
        id,
        requestId,
        elicitation: {
          requestId,
          request,
          resolve: (response) => {
            send({ type: "elicitation", id, requestId, elicitation: null })
            owner().answerElicitation(requestId, response)
          },
        },
      })
    },
    /* Somebody else settled this question — another device answered it, or the
       agent's process died holding it. Either way the card is stale and the
       answer is no longer ours to give. */
    onRequestAnswered: (requestId) => {
      const thread = getState().threads[id]
      if (thread?.permissions.some((p) => p.requestId === requestId)) {
        send({ type: "permission", id, requestId, permission: null })
      }
      if (thread?.elicitations.some((e) => e.requestId === requestId)) {
        send({ type: "elicitation", id, requestId, elicitation: null })
      }
    },
    onStatus: (status, closeInfo) => {
      /* A respawn or a reconnect installs a new socket for this same session
         id while the old one is still closing. The old instance's closing
         status is about a connection nobody is using — letting it through
         marks the live thread dead and, worse, books a reconnect against it. */
      if (!host.isCurrent(owner())) return
      /* A close that says nothing about the thread — a bare 1006, no code at
         all, the watchdog giving up on a silent path — is the server having
         restarted or the network having blinked, and both come back. So this
         end comes back with them, rather than leaving a dead banner in front
         of a thread that is still there: the ladder reattaches, and when it
         is spent the thread parks, which the health poll un-parks the moment
         the server answers again.

         What it still does not do is put a process back. An automatic
         attempt asks for the thread as it is (`revive: false`), so a live
         agent gets its socket and a retired one is read from its journal —
         nothing respawns behind the reader's back. The codes that mean the
         thread itself is gone or taken over are the failure they always were
         (`isRecoverableClose`), with the reason and a button. */
      if (status === "connected") {
        host.clearRecovery()
        host.apply({ type: "socket-live" })
      } else if (status === "closed") {
        const recoverable =
          !closeInfo?.clientInitiated && !host.isDisposed() && isRecoverableClose(closeInfo?.code)
        host.apply({
          type: "socket-closed",
          willReconnect: recoverable,
          clientInitiated: closeInfo?.clientInitiated,
          reason: closeInfo?.reason,
          code: closeInfo?.code,
        })
        /* After the phase, never before: `scheduleReconnect` writes
           `retry-scheduled` (or `parked`), and that is the state the reader
           is owed — a close landing over the top of it is the ordering bug
           `reduceConn` was written to make impossible. */
        if (recoverable) {
          host.scheduleReconnect(
            new Error(closeInfo?.reason || "the connection to the thread closed"),
            host.probe()
          )
        }
        /* A dead socket ends any turn it was carrying, and settles it: the
           turn is the server's and it runs on with nobody attached, but
           nothing here is going to hear the end of it, so leaving the tools
           in flight would leave a working indicator nothing could clear. The
           next open re-folds the server's own account over the top. */
        send({ type: "turn-active", id, active: false, settle: true })
      }
      /* Last, so the status and whatever history was already buffered commit
         together: a close during the replay is the one exit `caught_up` never
         gets to make. */
      if (status !== "connected") flush()
    },
    /* The session's whole settings state, from wherever it changed: the
       handshake, this device, or another one. It is absolute, so applying it
       twice is the same as applying it once. */
    onSessionConfig: (modes, modeId, configOptions, promptCapabilities, canPause, canCompact) => {
      if (
        modes !== undefined ||
        configOptions !== undefined ||
        promptCapabilities !== undefined ||
        canPause !== undefined ||
        canCompact !== undefined
      ) {
        /* Left out means unchanged, and the reducer is what resolves it:
           inside a batched replay this action is not committed yet, so reading
           the current value here would read the thread as it was before the
           replay began. */
        send({
          type: "session-config",
          id,
          modes: modes ?? null,
          configOptions,
          promptCapabilities,
          canPause,
          canCompact,
        })
      } else if (modeId) {
        send({ type: "mode", id, modeId })
      }
      /* Remember what this profile's agent offers. A draft has no process to
         ask, so without this a new thread cannot show a single setting until
         it has already started — see lib/agent-options. The modes ride along:
         an agent that advertises them only on the `modes` channel (daedalus)
         would otherwise stay modeless in every draft menu. */
      const meta = getState().sessions.find((s) => s.id === id)
      /* Modes ride along on their own: a `current_mode_update` that arrives
         without a `session_config` (claude-agent-acp moves the mode on one
         channel and the twin on the other) still refreshes the remembered
         list the draft menu reads — otherwise a new thread keeps offering
         the probe's stale answer until some thread happens to restate its
         full options. */
      if (meta?.profileId && meta.agentId && (configOptions?.length || modes)) {
        saveAgentOptions(
          optionKey(meta.profileId, meta.agentId),
          configOptions ?? [],
          modes ?? undefined
        )
      }
      /* And what it can carry, on the same store and for the same reason:
         the next draft on this pair has to know whether an image will reach
         the model before it has a process to ask. */
      if (meta?.profileId && meta.agentId && promptCapabilities) {
        savePromptCapabilities(optionKey(meta.profileId, meta.agentId), promptCapabilities)
      }
    },
    /* The thread was moved to another profile, model or effort with nothing
       restarted. Live-only, so it never arrives inside a replay — and it
       carries the row's own state rather than the agent's, which is why it
       patches the session and not the thread. */
    onConfigNotice: (text) => send({ type: "notice", id, text, config: true }),
    /* The server's answer about where this thread ended up, which is also
       what ends this device's optimism about it: the row moves and the
       overlay the menu was drawing from is dropped in the same commit, so
       the value never flickers between the two. */
    onSpawnConfig: (profileId, model, effort, personaId, suggestFollowups) => {
      send({ type: "spawn-config", id, profileId, model, effort, personaId, suggestFollowups })
      send({ type: "pending-config", id, patch: null })
    },
    onStagedConfig: (config) => send({ type: "staged-config", id, config }),
    /* The process is being replaced under this thread. See `restarting` for
       why the gate goes up here rather than on the reattach: between these
       two events the server clears the journal and a `session/load` narrates
       the whole conversation back into it, and every one of those events is
       fanned out to this still-attached socket. Folding them would append the
       transcript to itself — on every device that was not the one holding the
       menu, which is exactly the case nothing used to tell. */
    onRestart: (state, kept, error) => {
      if (state === "started") {
        /* …unless the server kept the log (`kept`). Then there is no
           narration coming — it is dropped where it is produced — and going
           deaf here would throw away the two events that DO arrive, the new
           process's `spawn_config` and `session_config`, with no reattach
           coming to state them again. */
        host.state.restarting = !kept
        /* The user asked for this by changing a setting — not a thread whose
           agent had stopped, which is the other caller of this. */
        host.markReviving("config")
        /* …and on the kept path nothing else will: no open runs, so the chain
           would be idle under a phase that says a process is being replaced,
           and `ready()` would read that as a thread stuck in `reviving`. The
           other path is fine as it always was — its `openFromStore` below is
           the chain link. */
        if (kept) host.holdForRestart()
        return
      }
      if (state === "failed") {
        // The hold is released by the `detach()` at the end of this branch.
        host.state.restarting = false
        /* `settle: false`: the restart failing says nothing about whether the
           agent's turn is over, and the thread now needs reviving — which the
           transcript's own controls offer. */
        recordThreadError(
          send,
          id,
          new AgentError(error ?? { code: 0, message: "The agent could not be restarted." }),
          "Couldn't restart the agent",
          { settle: false }
        )
        send({ type: "pending-config", id, patch: null })
        host.detach()
        return
      }
      /* Up, on the settings that were asked for — and the log was never
         touched, so there is nothing to rebuild: this socket is still
         attached, its cursor still names the same place, and the transcript
         on screen was never wrong. All that is left is to stop saying a
         process is being replaced. The phase goes straight back to `live`
         rather than through an open, because no open happened. */
      if (kept) {
        host.state.restarting = false
        host.apply({ type: "socket-live" })
        /* Last, so anything the hold was making wait — a send that arrived
           mid-restart, which is now allowed to (`composerLock`) — resumes
           against a connection that is already `live`. */
        host.endRestartHold()
        return
      }
      /* The log WAS cleared under this socket, so the cursor names nothing
         and the transcript has to be rebuilt — `seamless`, because what is on
         screen is a correct transcript of this very conversation and there is
         no reason for the reader to watch it disappear and come back. */
      host.forgetJournal()
      void host.openFromStore({ revive: true, seamless: true })
    },
    onTtft: (ms) => send({ type: "ttft", id, ms }),
    onQuota: (quota) => send({ type: "quota", id, quota }),
    onTurnChanges: (turn) => send({ type: "turn-changes", id, turn }),
    /* The catalog is TanStack Query's; the row is refetched, not patched
       in from a socket frame (docs/client.md, "one owner per slice"). */
    onTurnEnded: (usage, error, promptText, catchingUp, continued, turnId, durationMs) => {
      send({ type: "turn-active", id, active: false })
      if (usage) send({ type: "usage", id, usage, turnId, durationMs })
      if (error) {
        // Recorded in the transcript either way — a failure that survived a
        // reload is still the answer to the message above it, and carries the
        // text so the row can offer Retry.
        const info = recordThreadError(send, id, error, "The agent couldn't answer this message", {
          retryText: promptText,
          /* Off the user bubble this turn opened — `turn_ended` carries no
             attachments (Retry is text, deliberately), and the refs the
             journaled `turn_started` carried are already on that item. */
          retryAttachments: (
            getState().threads[id]?.items.find(
              (item) => item.kind === "user" && item.turnId === turnId
            ) as TextItem | undefined
          )?.attachments,
        })
        /* And on the row, so every list says it too — the transcript is the
           only place a failure was ever visible before, and a thread whose
           last turn failed is one of the two readings worth acting on. Sent
           on a replayed turn as well: folding the log is how a thread this
           device has just opened learns which of its turns was the last one.
           A Stop is not a failure and clears the row like a clean turn. */
        send({
          type: "turn-verdict",
          id,
          error: info.kind === "cancelled" ? null : info.title,
        })
        if (!catchingUp && info.kind !== "cancelled") {
          notifyThreadEvent("turnFailed", id, host.titleOf(), info.title)
        }
      } else {
        send({ type: "turn-verdict", id, error: null })
      }
      if (!error && !catchingUp && !continued) {
        // Notifying on replay would re-announce every turn in the thread on
        // every reload — on a phone, as a push. And not for a turn the queue
        // is about to continue: "finished" would announce a pause that is not
        // there.
        notifyThreadEvent("turnFinished", id, host.titleOf())
      }
    },
    onQueue: (items) => send({ type: "queue", id, items }),
    /* A turn began on words this device did not type — either another peer
       prompted, or this is the replay rebuilding the transcript. Only the
       first is live activity. */
    onTurnStarted: (turnId, text, catchingUp, attachments) => {
      send({ type: "user-message", id, text, turnId, attachments })
      send({ type: "session-title", id, title: text.slice(0, 60) })
      if (!catchingUp) send({ type: "turn-active", id, active: true })
    },
    /* The replay bracket — one fold per callback, in lib/thread/replay.ts.
       Still this object's properties and still this socket's only sink: the
       history and the live stream go into the same place, in the same order,
       through the same buffer. */
    onAttached: (...args) => foldAttached(ctx, ...args),
    onReplayProgress: (...args) => foldReplayProgress(ctx, ...args),
    onCursor: (...args) => foldCursor(ctx, ...args),
    onPaused: (hold) => {
      send({ type: "paused", id, ...hold })
    },
    onRetry: (retry) => {
      send({ type: "retry", id, retry })
    },
    onCaughtUp: (...args) => foldCaughtUp(ctx, ...args),
    onRewind: (...args) => foldRewind(ctx, ...args),
    onRewound: (...args) => foldRewound(ctx, ...args),
    // A background task's journal grew server-side. Into the module store, not
    // the reducer: the events are keyed by transcript dir, not by thread, and
    // the panel reading them subscribes there (lib/task-events).
    onTaskEvent: (transcriptDir, event) => {
      appendTaskEvent(transcriptDir, event)
    },
  }
}
