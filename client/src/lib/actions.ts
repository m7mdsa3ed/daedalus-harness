import * as React from "react"
import type * as acp from "@agentclientprotocol/sdk"
import { AgentError, liveThreads, ThreadSocket, type ThreadCallbacks } from "./thread-socket"
import { describeError, markReported, reportError } from "./errors"
import { uuid } from "./uuid"
import {
  alreadyAsked,
  loadAgentOptions,
  markAsked,
  optionKey,
  pruneAgentOptions,
  saveAgentOptions,
  saveProbedOptions,
  type AgentOptionSet,
} from "./agent-options"
import { pruneDrafts } from "./drafts"
import { defaultToolPicks, loadThreadDefaults } from "./thread-defaults"
import { appendTaskEvent } from "./task-events"
import { notifyThreadEvent } from "./notifications"
import { prunePins } from "./pins"
import {
  api,
  ApiError,
  profileAgentIds,
  updateScheduled,
  type AgentDef,
  type McpServerDef,
  type Persona,
  type Profile,
  type Project,
  type Routine,
  type RoutineInput,
  type RoutinePatch,
  type RoutineRun,
  type RoutineTrigger,
  type RoutineTriggerInput,
  type RoutineTriggerPatch,
  type ScheduledMessage,
  type ScheduledPatch,
  type ServerSettings,
  type SessionMeta,
  type SkillDef,
  type CommandDef,
} from "./settings"
import { fetchQuota, profileHasUsage } from "./quota"
import { emptyThread, useStore, type Action } from "./store"

const RECONNECT_MAX_ATTEMPTS = 5
const RECONNECT_BASE_DELAY_MS = 500
const RECONNECT_MAX_DELAY_MS = 8000
const NON_RECONNECTABLE_CLOSE_CODES = new Set([4000, 4002, 4004])
/** `revive: true` means "this thread needs a running agent" — spawn one rather
    than serving its journal read-only. Opening a thread does not set it;
    reconnecting, reviving and sending all do. */
interface ConnectOpts {
  revive?: boolean
}
const reconnectAttempts = new Map<string, number>()
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** Threads parked until the network (or the user) comes back: the backoff gave
    up, or `navigator.onLine` said an attempt could not succeed. The `online`
    and visibilitychange listeners below reset their counters and retry at
    once — a laptop waking from sleep should not wait out a dead backoff. */
const reconnectWaiting = new Set<string>()
/** What the window listeners call. Bound inside `useActions` (it needs the
    closure's `reconnectThread`); one Connected mounts at a time, so the last
    binding is the live one. */
let retryWaitingThreads: (() => void) | null = null
/** Bound the same way, for the catalog half of coming back: this client is a
    PWA that stays open for days, and profiles and agents are read once at boot
    and on a mutation *this device* made — so a profile added on the laptop, or
    an agent the server started offering after an upgrade, was invisible on the
    phone until it was reloaded. */
let refreshCatalogOnReturn: (() => void) | null = null
/** Throttle for the above. Returning to the tab is not a question anybody
    asked, so it must not become two requests per glance. */
let catalogRefreshedAt = 0
const CATALOG_REFRESH_MIN_MS = 60_000
const refreshCatalogIfStale = () => {
  if (Date.now() - catalogRefreshedAt < CATALOG_REFRESH_MIN_MS) return
  catalogRefreshedAt = Date.now()
  refreshCatalogOnReturn?.()
}
let networkListenersInstalled = false
/**
 * How often a parked thread asks whether the server is back.
 *
 * `online` and `visibilitychange` are the only other things that un-park one,
 * and neither fires for the case that parks threads most often: the server
 * restarts while the tab stays focused and the network never drops. There is a
 * network the whole time, so `navigator.onLine` stays true and says nothing
 * about whether anything is listening — so without this, a thread that gave up
 * during a deploy stays parked until somebody clicks Reconnect.
 */
const HEALTH_POLL_MS = 20_000
let healthPollTimer: ReturnType<typeof setInterval> | null = null
/** Bound inside `useActions` (it needs the settings), like the two above. */
let probeServer: (() => Promise<boolean>) | null = null
/** One probe answers every caller for a moment: a server restart drops every
    thread the dock has open, and each of them would otherwise ask separately,
    in the same tick, on every rung of its own ladder. */
const HEALTH_PROBE_TTL_MS = 1_000
let healthProbe: { at: number; promise: Promise<boolean> } | null = null
const serverReachable = (): Promise<boolean> => {
  // Nothing bound yet — assume reachable, so this can only ever remove work,
  // never gate a reconnect on a probe that cannot run.
  if (!probeServer) return Promise.resolve(true)
  const now = Date.now()
  if (healthProbe && now - healthProbe.at < HEALTH_PROBE_TTL_MS) return healthProbe.promise
  const promise = probeServer()
  healthProbe = { at: now, promise }
  return promise
}
/** Runs only while something is parked, and stops itself when nothing is —
    which is why no un-parking path has to remember to call it. */
const startHealthPoll = () => {
  if (healthPollTimer) return
  healthPollTimer = setInterval(() => {
    if (reconnectWaiting.size === 0) {
      clearInterval(healthPollTimer!)
      healthPollTimer = null
      return
    }
    // Offline is already covered by the `online` listener, and a probe against
    // a network that cannot answer is a request nobody can act on.
    if (typeof navigator !== "undefined" && !navigator.onLine) return
    void serverReachable().then((ok) => {
      if (ok) retryWaitingThreads?.()
    })
  }, HEALTH_POLL_MS)
}
const installNetworkListeners = () => {
  if (networkListenersInstalled || typeof window === "undefined") return
  networkListenersInstalled = true
  window.addEventListener("online", () => retryWaitingThreads?.())
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return
    retryWaitingThreads?.()
    refreshCatalogIfStale()
  })
}
/** The last journal cursor this client has folded into a thread's state, keyed
    by session id. On a reconnect to an *alive* process this is what lets us ask
    for the delta instead of rebuilding the transcript from zero — a full
    replay of a long thread is thousands of events the client already has in
    memory. Reset to 0 (pull it out) whenever the thread is respawned, since a
    respawn clears the server's journal. */
const journalCursors = new Map<string, number>()

/** Everything device-local a thread accumulates OUTSIDE the store — cursor,
    backoff state, the live socket. Module-level, so it outlives React and,
    without this, outlives the thread too: deleting or pruning a session left
    its entries behind forever. Called for every id the server no longer
    reports, and on the deleted-thread reconnect branch. */
const dropThreadRuntime = (sessionId: string) => {
  journalCursors.delete(sessionId)
  reconnectAttempts.delete(sessionId)
  reconnectWaiting.delete(sessionId)
  const timer = reconnectTimers.get(sessionId)
  if (timer) clearTimeout(timer)
  reconnectTimers.delete(sessionId)
  const socket = liveThreads.get(sessionId)
  if (socket) {
    socket.close()
    liveThreads.delete(sessionId)
  }
}

/** Side-effectful operations: REST calls + ACP thread lifecycle. */
export function useActions(settings: ServerSettings) {
  const { state, dispatch } = useStore()
  const stateRef = React.useRef(state)
  stateRef.current = state

  return React.useMemo(() => {
    /* Failures that belong to a thread are recorded IN that thread, not in a
       toast: the transcript is where the user is looking, it survives the four
       seconds a toast lives, and it is the only place that can offer the one
       useful next step (send that prompt again). */
    /** The socket a queue command goes down. Same refusal `send` gives a
        thread with no connection: the words are recorded, not lost. */
    const requireLive = (sessionId: string): ThreadSocket => {
      const thread = liveThreads.get(sessionId)
      if (!thread) {
        throw new Error("This thread has no live connection to its agent — revive it and send again.")
      }
      return thread
    }

    const recordError = (
      sessionId: string,
      err: unknown,
      context: string,
      retryText?: string,
      /* Where the row goes. Everything but the replay wants it committed now;
         the replay wants it in the same fold as the transcript it belongs to,
         or the error lands in a thread that is about to be reset out from
         under it. */
      emit: (action: Action) => void = dispatch,
      /* False when the failure is this device's connection rather than the
         agent's answer: a reconnect is coming and it re-folds the transcript,
         so nothing in flight is over. */
      settle = true,
    ) => {
      const info = describeError(err)
      console.error(`[${context}]`, err)
      // It has a home in the transcript now; the global net must not re-toast it
      // if a caller lets the rethrow escape.
      markReported(err)
      if (info.kind === "cancelled") return info
      emit({
        type: "error",
        id: sessionId,
        title: context,
        reason: info.title,
        detail: info.detail,
        retryText,
        settle,
      })
      return info
    }

    /** `silent` is the automatic-backoff path: a failed attempt is not worth a
        transcript row of its own — scheduleReconnect reports once, at give-up. */
    const reconnectThread = async (sessionId: string, silent = false) => {
      /* An automatic attempt asks the cheap unauthenticated question first.
         Every rung of every thread's ladder otherwise costs a full
         `/api/sessions?deleted=1` — the whole list, deleted rows included, once
         per open transcript per round — to discover what one shared health
         probe already knows. A user-initiated reconnect skips the gate: it was
         asked for, and it should fail against the real route rather than
         against a probe. */
      if (silent && !(await serverReachable())) {
        throw new ApiError({
          status: 0,
          path: "/api/health",
          serverMessage: "the server did not answer a health check",
        })
      }
      // User-initiated (or backoff-driven) reattach: drop any half-open socket so
      // openThread's `connected` short-circuit can't skip the reconnect.
      liveThreads.get(sessionId)?.close()
      const sessions = await api<SessionMeta[]>(settings, "/api/sessions?deleted=1")
      dispatch({ type: "sessions", sessions })
      const meta = sessions.find((s) => s.id === sessionId)
      if (!meta) throw new Error("This thread no longer exists on the server.")
      // Deleted mid-connection (another tab, another device): reconnecting is
      // not a thing that can succeed, so stop the backoff and say what happened
      // once, instead of retrying a revive the server must refuse.
      if (meta.deletedAt) {
        dropThreadRuntime(sessionId)
        dispatch({ type: "thread-status", id: sessionId, status: "closed" })
        dispatch({
          type: "error",
          id: sessionId,
          title: "This thread was deleted",
          reason: "It moved to Trash on this server — restore it to reopen it.",
        })
        return
      }
      /* Always `revive`, on every reconnect path. Opening a thread from the UI
         may serve its archive read-only, but a reconnect never should: the
         socket closed because the process died (or was taken over), and the
         thread the user is looking at was live a moment ago. Attaching to the
         journal instead would turn a crash into a silently read-only thread. */
      await (silent
        ? connectThread(meta, { revive: true })
        : openThread(meta, { revive: true }))
    }

    /** Put an agent process back under a thread that has none. */
    const revive = async (sessionId: string) => {
      reconnectAttempts.delete(sessionId)
      reconnectWaiting.delete(sessionId)
      await reconnectThread(sessionId)
    }

    const scheduleReconnect = (sessionId: string, lastError?: unknown) => {
      if (reconnectTimers.has(sessionId)) return
      /* Offline, every attempt is a guaranteed failure that burns the budget
         against a network that cannot answer. Park the thread instead — the
         `online` listener retries it the moment there is a network to try. */
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        reconnectWaiting.add(sessionId)
        startHealthPoll()
        dispatch({ type: "thread-status", id: sessionId, status: "connecting" })
        return
      }
      const attempt = (reconnectAttempts.get(sessionId) ?? 0) + 1
      if (attempt > RECONNECT_MAX_ATTEMPTS) {
        // Parked, not abandoned: coming back online or refocusing the tab
        // resets the counter and tries again without waiting for the user.
        reconnectWaiting.add(sessionId)
        /* The ladder is a fast detector, not the whole budget: five rungs cover
           about 16 seconds, and a deploy (build, schema push, restart) takes
           longer than that, so giving up before the server is back is the
           ORDINARY outcome rather than an edge case. The poll is the slow tail
           — one shared request every 20s that un-parks every thread at once. */
        startHealthPoll()
        // Giving up silently is how a thread ends up looking merely quiet.
        // Say so, in the thread, where the Revive button already lives.
        const info = lastError ? describeError(lastError) : undefined
        dispatch({
          type: "error",
          id: sessionId,
          title: `Lost the connection to this thread — ${RECONNECT_MAX_ATTEMPTS} reconnect attempts failed`,
          // The row is the end of the ladder, not the end of the attempt, and
          // saying only the first reads as abandoned — which is what sent people
          // hunting for a button the thread was about to make unnecessary.
          reason: `${info?.title ?? "The server or the agent process is no longer reachable."} Still watching — this reconnects on its own once the server answers.`,
          detail: info?.detail,
          // Parked, not abandoned — so nothing in the transcript is over
          // either. The reconnect this row promises re-folds it.
          settle: false,
        })
        return
      }

      reconnectAttempts.set(sessionId, attempt)
      dispatch({ type: "thread-status", id: sessionId, status: "connecting" })
      const backoff = Math.min(
        RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1),
        RECONNECT_MAX_DELAY_MS,
      )
      /* Jitter, so every thread a server restart dropped does not knock again
         in the same instant on every device. */
      const delayMs = backoff + Math.random() * backoff * 0.5
      reconnectTimers.set(
        sessionId,
        setTimeout(() => {
          reconnectTimers.delete(sessionId)
          void reconnectThread(sessionId, true).catch((error) => {
            console.warn(`Reconnecting thread ${sessionId} failed`, error)
            dispatch({ type: "thread-status", id: sessionId, status: "closed" })
            scheduleReconnect(sessionId, error)
          })
        }, delayMs),
      )
    }

    /* The network (or the user's attention) came back. Everything parked — and
       everything still sitting out a backoff timer — gets its counter reset
       and one immediate try; a failure re-enters `scheduleReconnect` and the
       ordinary backoff resumes from attempt one. */
    retryWaitingThreads = () => {
      if (typeof navigator !== "undefined" && !navigator.onLine) return
      const ids = new Set([...reconnectWaiting, ...reconnectTimers.keys()])
      reconnectWaiting.clear()
      for (const id of ids) {
        const timer = reconnectTimers.get(id)
        if (timer) {
          clearTimeout(timer)
          reconnectTimers.delete(id)
        }
        reconnectAttempts.delete(id)
        dispatch({ type: "thread-status", id, status: "connecting" })
        void reconnectThread(id, true).catch((error) => {
          console.warn(`Reconnecting thread ${id} failed`, error)
          dispatch({ type: "thread-status", id, status: "closed" })
          scheduleReconnect(id, error)
        })
      }
    }
    /* Bound like the two above, and for the same reason: the poll is
       module-level (it outlives React) but the question needs this connection's
       URL and token. `/api/health` exempts itself from the token check, so this
       answers on a server whose credentials have since changed — which is the
       right reading, since what it is asking is only "is anything listening". */
    probeServer = async () => {
      try {
        await api(settings, "/api/health")
        return true
      } catch {
        return false
      }
    }
    installNetworkListeners()

    /** The thread's title, for a notification about it. */
    const titleOf = (id: string) =>
      stateRef.current.sessions.find((s) => s.id === id)?.title || "Untitled thread"

    /* `owner` is filled in by startThread the moment the socket exists — see the
       guard in onStatus. */
    const makeCallbacks = (id: string, owner: { thread?: ThreadSocket }): ThreadCallbacks => {
      /* The replay is a few thousand events, and dispatching each one commits a
         render of a transcript nobody has looked at yet — which is what made a
         long thread visibly rebuild itself line by line. So between `attached`
         and `caught_up` the actions go into a list instead, and the whole
         history lands as one `batch`. Nothing else changes: the callbacks below
         run in the same order on the same events, and a live socket (buffer
         null) still commits every action the moment it arrives.

         Held back until the end, though, it overshot: the screen stayed empty
         for the *whole* replay, so the wait was total rather than progressive
         and a long thread said nothing until it could say everything. So the
         buffer is committed per `replay` frame (`commit`) and only closed at the
         end (`flush`) — the frame is the server's own cut, a handful of them
         carry a window, and the transcript paints from the first one while the
         rest are still arriving. Still an order of magnitude fewer renders than
         one per event, which is the cost the buffer exists to remove.

         Two rules keep it honest. Everything thread-scoped goes through `send`,
         never `dispatch` — a stray direct dispatch would jump the queue and land
         before the `thread-reset` that is still sitting in the buffer. And any
         exit from the replay flushes: `caught_up` is the ordinary one, a socket
         that dies mid-replay is the other, and without the second the history
         would be dropped on the floor along with the close status. */
      let buffer: Action[] | null = null
      const send = (action: Action) => {
        if (buffer) buffer.push(action)
        else dispatch(action)
      }
      /* The one hot dispatch: an agent streams text as dozens of chunks a
         second, and each one is a full state update. Marking it a transition
         lets React treat it as interruptible — a burst of chunks coalesces into
         the frames the display can actually show instead of one render per
         token. Everything else stays urgent (a permission appearing, a status
         flip, a turn ending) and goes through `send`. */
      const sendStream = (action: Action) => {
        if (buffer) buffer.push(action)
        else React.startTransition(() => dispatch(action))
      }
      const flush = () => {
        const pending = buffer
        buffer = null
        if (pending?.length) dispatch({ type: "batch", actions: pending })
      }
      /* Commit what has been folded so far and keep buffering. The array is
         replaced rather than emptied in place, because the actions in it are
         about to be handed to the reducer and a buffer that kept collecting
         into the same array would be mutating a batch already dispatched. */
      const commit = () => {
        const pending = buffer
        if (!pending?.length) return
        buffer = []
        dispatch({ type: "batch", actions: pending })
      }
      return {
        onUpdate: (update, historyReplay, sessionId) =>
          sendStream({ type: "update", id, update, allowUserChunks: historyReplay, sessionId }),
        /* The agent is blocked on this question until somebody answers it. The
           server holds its promise now, so `resolve` is a message rather than a
           callback: it names the request the server minted, which is also how a
           peer's answer is matched against this card. */
        onPermission: (requestId, request) => {
          notifyThreadEvent("permissionNeeded", id, titleOf(id), request.toolCall?.title ?? undefined)
          send({
            type: "permission",
            id,
            permission: {
              requestId,
              request,
              resolve: (response) => {
                send({ type: "permission", id, permission: null })
                owner.thread?.answerPermission(requestId, response)
              },
            },
          })
        },
        onElicitation: (requestId, request) => {
          notifyThreadEvent("questionAsked", id, titleOf(id), request.message)
          send({
            type: "elicitation",
            id,
            elicitation: {
              requestId,
              request,
              resolve: (response) => {
                send({ type: "elicitation", id, elicitation: null })
                owner.thread?.answerElicitation(requestId, response)
              },
            },
          })
        },
        /* Somebody else settled this question — another device answered it, or
           the agent's process died holding it. Either way the card is stale and
           the answer is no longer ours to give. */
        onRequestAnswered: (requestId) => {
          const thread = stateRef.current.threads[id]
          if (thread?.permission?.requestId === requestId) {
            send({ type: "permission", id, permission: null })
          }
          if (thread?.elicitation?.requestId === requestId) {
            send({ type: "elicitation", id, elicitation: null })
          }
        },
        onStatus: (status, closeInfo) => {
          /* A respawn or a reconnect installs a new socket for this same session
             id while the old one is still closing. The old instance's closing
             status is about a connection nobody is using — letting it through
             marks the live thread dead and, worse, books a reconnect against it. */
          if (owner.thread && liveThreads.get(id) !== owner.thread) return
          /* Whether this close is the end of the thread's story or an
             interruption in ours. A reconnect always revives and re-folds the
             transcript, so anything left in flight is about to be answered by
             the server's own account of it. */
          const willReconnect =
            status === "closed" &&
            !closeInfo?.clientInitiated &&
            !NON_RECONNECTABLE_CLOSE_CODES.has(closeInfo?.code ?? 0)
          if (status === "connected") {
            reconnectAttempts.delete(id)
            reconnectWaiting.delete(id)
          } else if (willReconnect) {
            // The close frame's reason is the server's own account of what
            // happened ("agent exited (1)") — carry it into the give-up message.
            scheduleReconnect(
              id,
              closeInfo?.reason
                ? new Error(`${closeInfo.reason}${closeInfo.code ? ` (${closeInfo.code})` : ""}`)
                : undefined
            )
          }
          send({
            type: "thread-status",
            id,
            status,
            closeCode: closeInfo?.code,
            closeReason: closeInfo?.reason,
          })
          /* A dead socket ends any turn it was carrying. The server does answer
             the prompts an exiting agent never will — but if the close beats the
             `turn_ended` to this tab, the working indicator would outlive the
             process and only a reload would clear it.

             The indicator is all it ends, though: `settle: false` while a
             reconnect is coming, because the turn is the server's and it runs
             on with nobody attached. Settling here is what made a backgrounded
             phone come back to failed tools and disconnected workflow steps
             that the very next attach contradicted. */
          if (status === "closed") {
            send({ type: "turn-active", id, active: false, settle: !willReconnect })
          }
          /* Last, so the status and whatever history was already buffered commit
             together: a close during the replay is the one exit `caught_up`
             never gets to make. */
          if (status !== "connected") flush()
        },
        /* The session's whole settings state, from wherever it changed: the
           handshake, this device, or another one. It is absolute, so applying it
           twice is the same as applying it once. */
        onSessionConfig: (modes, modeId, configOptions) => {
          if (modes !== undefined || configOptions !== undefined) {
            /* Left out means unchanged, and the reducer is what resolves it:
               inside a batched replay this action is not committed yet, so
               reading the current value here would read the thread as it was
               before the replay began. */
            send({ type: "session-config", id, modes: modes ?? null, configOptions })
          } else if (modeId) {
            send({ type: "mode", id, modeId })
          }
          /* Remember what this profile's agent offers. A draft has no process to
             ask, so without this a new thread cannot show a single setting until
             it has already started — see lib/agent-options. */
          const meta = stateRef.current.sessions.find((s) => s.id === id)
          if (meta?.profileId && meta.agentId && configOptions && configOptions.length > 0) {
            saveAgentOptions(optionKey(meta.profileId, meta.agentId), configOptions)
          }
        },
        /* The thread was moved to another profile, model or effort with nothing
           restarted. Live-only, so it never arrives inside a replay — and it
           carries the row's own state rather than the agent's, which is why it
           patches the session and not the thread. */
        onSpawnConfig: (profileId, model, effort, personaId) =>
          send({ type: "spawn-config", id, profileId, model, effort, personaId }),
        onTtft: (ms) => send({ type: "ttft", id, ms }),
        onQuota: (quota) => send({ type: "quota", id, quota }),
        onTurnEnded: (usage, error, promptText, catchingUp, continued, turnId) => {
          send({ type: "turn-active", id, active: false })
          if (usage) send({ type: "usage", id, usage, turnId })
          if (error) {
            // Recorded in the transcript either way — a failure that survived a
            // reload is still the answer to the message above it, and carries the
            // text so the row can offer Retry.
            const info = recordError(
              id,
              error,
              "The agent couldn't answer this message",
              promptText,
              send,
            )
            if (!catchingUp && info.kind !== "cancelled") {
              notifyThreadEvent("turnFailed", id, titleOf(id), info.title)
            }
          } else if (!catchingUp && !continued) {
            // Notifying on replay would re-announce every turn in the thread on
            // every reload — on a phone, as a push. And not for a turn the queue
            // is about to continue: "finished" would announce a pause that is
            // not there.
            notifyThreadEvent("turnFinished", id, titleOf(id))
          }
        },
        onQueue: (items) => send({ type: "queue", id, items }),
        /* A turn began on words this device did not type — either another peer
           prompted, or this is the replay rebuilding the transcript. Only the
           first is live activity. */
        onTurnStarted: (turnId, text, catchingUp) => {
          send({ type: "user-message", id, text, turnId })
          send({ type: "session-title", id, title: text.slice(0, 60) })
          if (!catchingUp) send({ type: "turn-active", id, active: true })
        },
        /* The replay is about to start. `resumed` decides what happens to what
           is already on screen: a resume is a delta this device asked for and
           the transcript is kept and extended, anything else replaces it. That
           used to be read off `from > 0`, which stopped being enough once the
           server could pick a `from` of its own for a windowed attach — a case
           where `from` is large and the transcript must still be replaced. */
        onAttached: ({ from, to, resumed, earlier, archived }, historyLost) => {
          buffer = []
          /* How long this is going to be, before any of it arrives. Zero total
             means the server did not say (one that predates the field), which
             is not the same as a short replay and must not read as one — see
             the `replay` field. */
          const total = Math.max(0, to - from)
          send({ type: "thread-replay", id, replay: total > 0 ? { done: 0, total } : null })
          /* Keep what is on screen when resuming; replace it otherwise. A reset
             would throw away the transcript a delta is about to extend, and a
             delta appended onto a stale transcript would double-render whatever
             the server re-sends. The status is left to the socket's `onStatus`
             flow (connecting → connected) and only committed at `caught_up`;
             touching it here would race the connect() we are inside. */
          if (!resumed) {
            send({ type: "thread-reset", id, thread: { ...emptyThread, status: "connecting" } })
          }
          send({ type: "thread-window", id, archived, earlier })
          /* The agent would not reload this conversation, so the replay about
             to arrive is empty. Said here rather than left to look like a quiet
             thread — and through `send`, so it lands inside the same fold as
             the (empty) transcript it belongs to rather than ahead of the reset
             above. Repeated on every reattach because the server holds it for
             as long as the process that failed the load is the one running. */
          if (historyLost)
            recordError(
              id,
              new AgentError(historyLost.error),
              "Couldn't restore this thread's history",
              undefined,
              send
            )
        },
        // A turn may still be running server-side; `turn_ended` clears it.
        /* A frame of history landed. Commit it — the transcript grows a screenful
           at a time instead of appearing whole at the end — and say where the
           replay has got to. */
        onReplayProgress: (done, total) => {
          send({ type: "thread-replay", id, replay: { done, total } })
          commit()
        },
        onCaughtUp: (cursor, promptActive, queue) => {
          journalCursors.set(id, cursor)
          send({ type: "thread-replay", id, replay: null })
          if (promptActive) send({ type: "turn-active", id, active: true })
          // Not journaled, so it rides here — the way an open permission is
          // handed over after the replay rather than replayed.
          send({ type: "queue", id, items: queue })
          flush()
        },
        /* A page of older history arrived and the socket is about to fold the
           widened window from the start. Everything but the items is carried
           over rather than reset to `emptyThread`: the agent may be mid-turn or
           holding a question open while someone scrolls back, and a question
           that vanished because the transcript above it grew would be a real
           loss. Only `items` is rebuilt, because only `items` is what the fold
           produces. Per-step usage goes with them: it is derived from where an
           update landed in the transcript being rebuilt (see `markStepUsage`),
           so carrying the cursor over would have the fold's first reading
           measured against a position from the last one. */
        onRewind: () => {
          buffer = []
          const current = stateRef.current.threads[id] ?? emptyThread
          send({
            type: "thread-reset",
            id,
            thread: { ...current, items: [], stepUsage: {}, usageMark: null },
          })
        },
        /* The re-fold is committed as one render. `turnActive` is put back
           afterwards because the fold derives it from the events it saw, and a
           turn this device started itself has no `turn_started` in the log to
           re-derive it from — the prompter is the one peer that never gets one. */
        onRewound: (earlier) => {
          const active = stateRef.current.threads[id]?.turnActive ?? false
          send({ type: "thread-window", id, earlier, loadingEarlier: false })
          if (active) send({ type: "turn-active", id, active: true })
          flush()
        },
        // A background task's journal grew server-side. Into the module store,
        // not the reducer: the events are keyed by transcript dir, not by
        // thread, and the panel reading them subscribes there (lib/task-events).
        onTaskEvent: (transcriptDir, event) => {
          appendTaskEvent(transcriptDir, event)
        },
      }
    }

    /**
     * Change a thread's profile, model or effort — and let the server say what
     * that costs.
     *
     * All three are placed by the agent's env at spawn, and all three used to
     * mean the same thing here: kill the process, spawn another, put the
     * conversation back. They do not any more. The endpoint and the credential
     * live behind the harness's own gateway URL, which names the *thread*, and
     * the model is either the agent's own selector or another rewrite on the
     * same wire — so the common case is one request that changes nothing
     * anybody can see. See CLAUDE.md.
     *
     * Which case it is cannot be known from here: it depends on the agent, on
     * whether the thread is behind the shim at all, and on whether the running
     * process will take the model. So the route decides and answers `live`, and
     * only the falsy answer does the reconnect dance — a live change arrives
     * back as a `spawn_config` event on the socket that is already open, on
     * this device and on every other.
     */
    const changeThreadConfig = async (
      meta: SessionMeta,
      next: { profileId?: string; model?: string; effort?: string; personaId?: string },
      context: string
    ) => {
      let live = false
      try {
        const reply = await api<{ live: boolean }>(settings, `/api/sessions/${meta.id}/config`, {
          method: "POST",
          body: JSON.stringify({
            profileId: next.profileId ?? meta.profileId,
            agentId: meta.agentId,
            model: next.model ?? meta.model ?? undefined,
            effort: next.effort ?? meta.effort ?? undefined,
            /* Deliberately not `?? meta.personaId`: sending the current value
               back would be indistinguishable from asking for it, and the
               server reads a *changed* persona as "apply its effort too". Only
               a real pick travels. */
            personaId: next.personaId,
          }),
        })
        live = reply.live
      } catch (error) {
        recordError(meta.id, error, context)
        throw error
      }
      await refreshSessions()
      if (live) return
      /* The server fell back to a respawn, so the event log was cleared under
         this socket: the saved cursor is past its end and the thread has to be
         attached again from 0. The same tail as `respawnThread`, which is still
         the path for a revive. */
      liveThreads.get(meta.id)?.close()
      journalCursors.delete(meta.id)
      try {
        await startThread(meta.id)
      } catch (error) {
        // The old process is gone by now, so a failure here leaves a thread
        // that needs reviving — say that, in the thread.
        recordError(meta.id, error, context)
        throw error
      }
    }

    /** Bring a draft into existence: tell the server (which spawns the agent
        and handshakes), adopt its row, then attach. The id travelled from the
        client, so the route the user is already looking at needs no correction. */
    const createSession = async (meta: SessionMeta) => {
      const project = stateRef.current.projects.find((p) => p.id === meta.projectId)
      const profile = stateRef.current.profiles.find((p) => p.id === meta.profileId)
      if (!project) throw new Error("Choose a project for this thread before sending.")
      if (!profile) throw new Error("Choose a profile for this thread before sending.")
      /* Spawning the agent and handshaking takes a second or two, and until the
         socket opens there is no status at all — so the thread would sit there
         looking like nothing had happened to the message just sent. */
      dispatch({ type: "thread-status", id: meta.id, status: "connecting" })
      await api<{ id: string }>(settings, "/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          id: meta.id,
          profileId: profile.id,
          /* The thread is a (profile, agent) pair: the profile may serve several
             agents, and which one answers is the draft's own pick. */
          agentId: meta.agentId,
          projectId: project.id,
          model: meta.model || undefined,
          effort: meta.effort || undefined,
          /* How this thread should be worked on. Picked on the draft like the
             rest of this, and — unlike a started thread's — free: nothing is
             running yet, so there is no respawn to pay for. */
          personaId: meta.personaId || undefined,
          /* Settings picked on the draft, against the option set the agent last
             advertised. The server applies them the moment session/new answers,
             best-effort: a remembered option the agent no longer offers must not
             stop the message that created the thread. */
          configChoices: meta.configChoices,
          /* The thread's own tool picks, on top of the project's and the
             profile's — the server links what still exists and spawns with
             the union. */
          mcpServerIds: meta.mcpServerIds ?? [],
          skillIds: meta.skillIds ?? [],
          commandIds: meta.commandIds ?? [],
          /* A draft renamed before it was ever sent to: the name travels with
             the create call, and the server's first-prompt sniff then leaves
             it alone. Left out when nobody has named it, so the sniff still
             titles the thread from what was typed. */
          title: meta.title && meta.title !== "New thread" ? meta.title : undefined,
        }),
      })
      // Swaps the draft row for the server's own — see the `sessions` reducer.
      await refreshSessions()
      await startThread(meta.id)
    }

    /** Open a socket, register it as the session's live one, and wait for the
        replay to finish. Every path that connects goes through here, so the
        ownership wiring the callbacks depend on exists in exactly one place. */
    const startThread = async (id: string, cursor = 0) => {
      const owner: { thread?: ThreadSocket } = {}
      const thread = new ThreadSocket(id, settings, makeCallbacks(id, owner))
      owner.thread = thread
      liveThreads.set(id, thread)
      await thread.connect({ cursor })
      return thread
    }

    /** The journal position to resume a reconnect from. 0 when this device has
        never folded this thread's journal (fresh connect or a page reload), or
        when the agent is about to be respawned — a respawn clears the journal,
        so a stale saved cursor would point past its end, which the server
        clamps back to 0 anyway. A value > 0 is the delta: "I already have this
        much; give me the rest." */
    const resumeCursor = (meta: SessionMeta): number => {
      if (meta.exited) return 0
      return journalCursors.get(meta.id) ?? 0
    }

    /* Profiles + the agent registry, together — see `refreshProfiles` below for
       why they are one call. Hoisted rather than left a method on the returned
       object because the visibility listener bound above calls it, and there is
       no `this` in scope here. */
    const refreshCatalog = async () => {
      const [profiles, agents, personas] = await Promise.all([
        api<Profile[]>(settings, "/api/profiles"),
        api<AgentDef[]>(settings, "/api/agents"),
        /* Read here too, and for the same reason the registry is: a persona
           added or edited on another device is otherwise invisible until a
           reload, and this client is a PWA that stays open for days. */
        api<Persona[]>(settings, "/api/personas"),
      ])
      // A deleted profile's remembered option set is dead weight, and its id
      // will never be asked for again.
      pruneAgentOptions(profiles.map((profile) => profile.id))
      dispatch({ type: "profiles", profiles })
      dispatch({ type: "agents", agents })
      dispatch({ type: "personas", personas })
    }

    /* What the visibility listener calls, bound the way `retryWaitingThreads`
       is. Ambient: nobody asked by looking at the tab, so a failure costs the
       refresh and nothing else. */
    refreshCatalogOnReturn = () => {
      void refreshCatalog().catch((error) => {
        console.warn("Couldn't re-read profiles and agents", error)
      })
    }

    /* Hoisted rather than left as a method on the returned object, for the same
       reason `refreshSessions` is: `scheduleMessage` and `cancelSchedule` both
       have to re-read the list after they change it, and a bare call to a
       sibling method does not resolve — there is no `this` in scope here. */
    const refreshScheduled = async () => {
      const scheduled = await api<ScheduledMessage[]>(settings, "/api/scheduled")
      dispatch({ type: "scheduled", scheduled })
    }

    /* Hoisted for the same reason `refreshScheduled` is: every routine mutation
       below has to re-read the list after it writes, and a bare call to a
       sibling method of the returned object does not resolve. */
    const refreshRoutines = async () => {
      const routines = await api<Routine[]>(settings, "/api/routines")
      dispatch({ type: "routines", routines })
    }

    /* Hoisted for the same reason: `runRoutine` re-reads the routine's runs
       after firing, and reaching a sibling through `this` would break the
       moment a component destructured the action off the object. */
    const refreshRoutineRuns = async (routineId: string, limit?: number) => {
      const query = limit ? `?limit=${limit}` : ""
      const runs = await api<RoutineRun[]>(
        settings,
        `/api/routines/${encodeURIComponent(routineId)}/runs${query}`
      )
      dispatch({ type: "routine-runs", routineId, runs })
      return runs
    }

    const refreshSessions = async () => {
      const sessions = await api<SessionMeta[]>(settings, "/api/sessions?deleted=1")
      // The server's list is the authority on what still exists, so this is the
      // one place that can tell a stale draft from a live one — except for
      // threads the server has never been told about. A draft thread is exactly
      // that, and pruning against the server alone would delete the half-written
      // message that has not been sent yet.
      const ids = [
        ...sessions.map((session) => session.id),
        ...stateRef.current.sessions.filter((s) => s.draft).map((s) => s.id),
      ]
      pruneDrafts(ids)
      prunePins(ids)
      /* The module-level maps leak the same way the device-local stores do — a
         cursor, a backoff timer or a live socket for a thread the server no
         longer reports is never coming back on its own. Same authority, same
         sweep. (A trashed thread is still in the list, so its socket is not
         torn down here; the deleted-branch in reconnectThread owns that.) */
      const live = new Set(ids)
      const stale = new Set<string>()
      for (const key of [
        ...liveThreads.keys(),
        ...journalCursors.keys(),
        ...reconnectAttempts.keys(),
        ...reconnectTimers.keys(),
        ...reconnectWaiting,
      ]) {
        if (!live.has(key)) stale.add(key)
      }
      for (const key of stale) dropThreadRuntime(key)
      dispatch({ type: "sessions", sessions })
    }

    /** Connect (or reattach to) a thread; the caller navigates to its route.
        Every failure below lands in the thread itself before it propagates, so
        a caller that only logs still leaves the user something to read. */
    const openThread = async (meta: SessionMeta, opts: ConnectOpts = {}) => {
      try {
        await connectThread(meta, opts)
      } catch (error) {
        recordError(meta.id, error, "Couldn't connect to this thread", undefined, dispatch, false)
        throw error
      }
    }

    const connectThread = async (meta: SessionMeta, opts: ConnectOpts = {}) => {
      // A draft has no server session and no agent process — there is nothing to
      // connect to until the first message brings it into existence.
      if (meta.draft) return
      if (liveThreads.get(meta.id)?.connected) return
      // A thread whose project was deleted can never open. Saying nothing left
      // it stuck on the connecting skeleton forever.
      if (!stateRef.current.projects.some((p) => p.id === meta.projectId)) {
        throw new Error(
          "This thread's project no longer exists, so there is no working directory to run the agent in."
        )
      }

      // A deleted thread is exited with no way back through the revive path —
      // restore is what brings it around. Throwing here also stops the
      // reconnect backoff from re-POSTing a respawn the server must refuse,
      // which is where the old "session deleted" retry loop came from.
      if (meta.deletedAt) {
        throw new Error(
          "This thread is in Trash — restore it from the thread list to open it again."
        )
      }

      /* No live process (idle-retired, or the server restarted). Two ways back,
         and which one is right depends on what the user is about to do.

         If the server still holds this thread's journal (`cursor > 0`), opening
         it is a *read*, and a read does not need an agent: attach, replay the
         archive, and show it read-only. Spawning a process and making it
         re-narrate the whole conversation through `session/load` — several
         seconds and a child process — to look at yesterday's work was the cost
         this avoids. Sending a message is what needs the agent, and
         `actions.send` revives on its own when that happens.

         With no journal (pruned by retention, or a thread from before the
         archive existed) there is nothing to read, so the revive happens here
         exactly as it always did. */
      if (meta.exited && meta.cursor > 0 && !opts.revive) {
        await startThread(meta.id, 0)
        return
      }
      if (meta.exited) {
        await api(settings, `/api/sessions/${meta.id}/respawn`, {
          method: "POST",
          body: JSON.stringify({
            profileId: meta.profileId,
            model: meta.model || undefined,
            effort: meta.effort || undefined,
          }),
        })
        await refreshSessions()
        /* Respawn cleared the server's journal; a saved cursor now points past
           its end. Dropping it makes the attach below a clean `from: 0` rebuild
           rather than leaning on the server's clamp. */
        journalCursors.delete(meta.id)
      }

      /* Attach from where this device last stopped, or the beginning of the log
         if it never filled this thread (or the journal was just cleared). The
         replay is bracketed (`attached` resets or extends, `caught_up` ends
         it), and it carries the same events the live socket sends — so there is
         no second parser here and no cursor to keep in step. A delta (`from >
         0`) keeps the transcript on screen and appends only the gap, which is
         what makes a reconnect to a long thread cheap. `caught_up` also carries
         whether a turn is still running, read server-side in the same tick as
         the log it follows: `meta.promptActive` is a snapshot from the last
         /api/sessions fetch, and stale-false loses the indicator while
         stale-true strands it. */
      await startThread(meta.id, resumeCursor(meta))
    }

    return {
      refreshSessions,

      async bootstrap() {
        const [
          profiles,
          projects,
          mcpServers,
          skills,
          commands,
          personas,
          agents,
          sessions,
          scheduled,
          routines,
        ] = await Promise.all([
            api<Profile[]>(settings, "/api/profiles"),
            api<Project[]>(settings, "/api/projects"),
            api<McpServerDef[]>(settings, "/api/mcp-servers"),
            api<SkillDef[]>(settings, "/api/skills"),
            api<CommandDef[]>(settings, "/api/commands"),
            api<Persona[]>(settings, "/api/personas"),
            api<AgentDef[]>(settings, "/api/agents"),
            api<SessionMeta[]>(settings, "/api/sessions?deleted=1"),
            api<ScheduledMessage[]>(settings, "/api/scheduled"),
            api<Routine[]>(settings, "/api/routines"),
          ])
        // Boot is a catalog read; the visibility throttle starts from here.
        catalogRefreshedAt = Date.now()
        dispatch({
          type: "bootstrap",
          profiles,
          projects,
          mcpServers,
          skills,
          commands,
          personas,
          agents,
          sessions,
          scheduled,
          routines,
        })
        return { profiles, projects, agents, sessions }
      },

      /**
       * Read this thread's plan usage once, on demand.
       *
       * The socket sends one of these after every settled turn, so a thread that
       * has been worked in already has one; this is for the other case — a
       * thread just opened, or an archived one with no process at all, whose
       * stats popover someone expanded. It asks under the thread's *own*
       * profile, and only when that profile names a plan of its own: a thread on
       * an API-key profile has no plan windows by construction, and the reading
       * an agent probe would give back is the machine's login, not that
       * profile's — Settings › Usage is where that answer lives.
       *
       * Failures are swallowed. The number is ambient, nobody asked a question
       * by opening a popover, and a missing `claude` binary would otherwise
       * raise a toast on every thread on the machine. Settings › Usage is where
       * the failure is reported, because there it is the answer.
       */
      async loadQuota(meta: SessionMeta) {
        /* The card is the profile's own plan. A profile without one has nothing
           to read — and asking would spawn the agent's CLI probe for a card the
           composer will not draw, so don't. Settings › Usage is where the
           machine reading is asked for, on purpose. */
        const profile = stateRef.current.profiles.find((p) => p.id === meta.profileId)
        if (!profileHasUsage(profile)) return
        try {
          const quota = await fetchQuota(settings, meta.agentId, { profileId: meta.profileId })
          dispatch({ type: "quota", id: meta.id, quota })
        } catch {
          /* ambient */
        }
      },

      /**
       * Re-read the profile list — and the agent registry with it.
       *
       * The two cannot be refreshed apart: every agent has a virtual "Default"
       * profile synthesized server-side (`defaultProfileFor`), so a registry
       * this client last read at boot means an agent added since — a seeded
       * one after a server upgrade, one added through the API — has a profile
       * in the list that no `state.agents` entry answers for. Both halves are
       * small and both are cheap.
       */
      refreshProfiles: refreshCatalog,

      async refreshProjects() {
        const projects = await api<Project[]>(settings, "/api/projects")
        dispatch({ type: "projects", projects })
      },

      async refreshMcpServers() {
        const mcpServers = await api<McpServerDef[]>(settings, "/api/mcp-servers")
        dispatch({ type: "mcp-servers", mcpServers })
      },

      async refreshSkills() {
        const skills = await api<SkillDef[]>(settings, "/api/skills")
        dispatch({ type: "skills", skills })
      },

      async refreshCommands() {
        const commands = await api<CommandDef[]>(settings, "/api/commands")
        dispatch({ type: "commands", commands })
      },

      async refreshPersonas() {
        const personas = await api<Persona[]>(settings, "/api/personas")
        dispatch({ type: "personas", personas })
      },

      refreshScheduled,

      /**
       * Schedule `text` to be sent to a thread's agent at `nextAt` (and again
       * every `everyMs`). The server owns delivery (scheduler.ts), so the
       * message goes out whether or not this tab is open — and a trashed thread
       * never receives it. For a draft thread, the draft is materialized first
       * (the server only schedules threads it knows), mirroring `send`.
       */
      async createSchedule(input: {
        sessionId: string
        text: string
        nextAt: number
        everyMs?: number | null
      }) {
        // A draft has no server row to schedule against — bring it into being
        // the way sending its first message would, then schedule the real one.
        const draft = stateRef.current.sessions.find(
          (s) => s.id === input.sessionId && s.draft
        )
        if (draft) {
          await createSession(draft)
        }
        await api<ScheduledMessage>(settings, "/api/scheduled", {
          method: "POST",
          body: JSON.stringify(input),
        })
        await refreshScheduled()
      },

      /**
       * Edit a schedule in place — text, time, recurrence, or pause/resume
       * (`enabled`). Any patch also resets the row's skip state server-side,
       * so resuming a parked schedule is just `{ enabled: true }`.
       */
      async updateSchedule(id: string, patch: ScheduledPatch) {
        await updateScheduled(settings, id, patch)
        await refreshScheduled()
      },

      async cancelSchedule(id: string) {
        await api(settings, `/api/scheduled/${id}`, { method: "DELETE" })
        await refreshScheduled()
      },

      // ---- routines ----
      /* The whole surface is here rather than half of it in lib/settings, for
         the reason the scheduled block already gives: a mutation's job is not
         done when the server answers 200, it is done when the list every screen
         reads has been re-read. A page calling `api()` itself would leave a
         deleted routine on screen until something else happened to refresh. */

      refreshRoutines,

      /**
       * A routine's runs, newest first. Read on demand — never at boot and
       * never on a timer: the list is per routine and grows without bound, and
       * only the routine's own page has ever wanted one. The store keys them by
       * routine, so a page that has not asked yet holds `undefined` rather than
       * `[]` — "not read" and "has never run" are different screens.
       */
      refreshRoutineRuns,

      async createRoutine(input: RoutineInput) {
        const routine = await api<Routine>(settings, "/api/routines", {
          method: "POST",
          body: JSON.stringify(input),
        })
        await refreshRoutines()
        return routine
      },

      /**
       * Edit a routine in place. Everything the form holds is patchable except
       * `dryRunCompleted`, which the server refuses: it is the engine's own
       * record that a run has completed under this routine, and a patch that
       * could set it would make the blanket-`allow` gate it guards decorative.
       */
      async updateRoutine(id: string, patch: RoutinePatch) {
        const routine = await api<Routine>(settings, `/api/routines/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        })
        await refreshRoutines()
        return routine
      },

      async deleteRoutine(id: string) {
        await api(settings, `/api/routines/${encodeURIComponent(id)}`, { method: "DELETE" })
        await refreshRoutines()
      },

      /**
       * Fire a routine by hand. Answers as soon as the run row exists, not when
       * the run is over — the caller wants the row to link to, and a review
       * that takes half an hour would otherwise be a request that hangs for it.
       * The returned run therefore usually reads `running` with a null
       * `sessionId`; the runs list is what fills in afterwards.
       *
       * `dryRun` forces `ask` everywhere for this one run whatever the
       * routine's policy says, and it is the run that clears the routine's
       * `dryRunCompleted` gate — so the routine is re-read after it, not just
       * the run list.
       */
      async runRoutine(id: string, opts: { text?: string; dryRun?: boolean } = {}) {
        const run = await api<RoutineRun>(
          settings,
          `/api/routines/${encodeURIComponent(id)}/run`,
          { method: "POST", body: JSON.stringify(opts) }
        )
        await Promise.all([refreshRoutines(), refreshRoutineRuns(id)])
        return run
      },

      /* Stop a run that is still going — the one action here that is about what
         is happening rather than about what will. Takes the routine id as well
         as the run's so the list can be re-read: a run row carries its routine,
         but the store is keyed by routine and there is nothing to look it up
         with once the caller has only a run. */
      async cancelRoutineRun(routineId: string, runId: string) {
        await api<{ stopped: boolean }>(
          settings,
          `/api/routines/runs/${encodeURIComponent(runId)}/cancel`,
          { method: "POST" }
        )
        await refreshRoutineRuns(routineId)
      },

      /* Triggers are returned, not stored. They are read on one routine's
         detail page, they are the only thing on it that no other screen shows,
         and a slice for them would be a cache with exactly one reader. */

      async listRoutineTriggers(routineId: string) {
        return api<RoutineTrigger[]>(
          settings,
          `/api/routines/${encodeURIComponent(routineId)}/triggers`
        )
      },

      async createRoutineTrigger(routineId: string, input: RoutineTriggerInput) {
        return api<RoutineTrigger>(
          settings,
          `/api/routines/${encodeURIComponent(routineId)}/triggers`,
          { method: "POST", body: JSON.stringify(input) }
        )
      },

      async updateRoutineTrigger(id: string, patch: RoutineTriggerPatch) {
        return api<RoutineTrigger>(
          settings,
          `/api/routines/triggers/${encodeURIComponent(id)}`,
          { method: "PATCH", body: JSON.stringify(patch) }
        )
      },

      async deleteRoutineTrigger(id: string) {
        await api(settings, `/api/routines/triggers/${encodeURIComponent(id)}`, {
          method: "DELETE",
        })
      },

      /**
       * Mint or rotate this trigger's long-lived token.
       *
       * The token is in this answer and nowhere else — only its sha-256 is
       * stored — so a caller that does not show it here cannot show it later,
       * and a rotation is a new mint. It is deliberately not put in the store:
       * a credential that outlives the dialog it was shown in is a credential
       * in a state dump.
       */
      async mintRoutineTriggerToken(id: string) {
        const { token } = await api<{ token: string }>(
          settings,
          `/api/routines/triggers/${encodeURIComponent(id)}/token`,
          { method: "POST" }
        )
        return token
      },

      /** Take the token away without deleting the trigger — a rotation backed
          out of, or one believed leaked. The trigger stays, inert to everything
          outside the server process. */
      async revokeRoutineTriggerToken(id: string) {
        await api(settings, `/api/routines/triggers/${encodeURIComponent(id)}/token`, {
          method: "DELETE",
        })
      },

      /**
       * Open a new thread without creating one. The id is minted here so the
       * route, the tab and the transcript all exist before anything touches the
       * network; the server is not told, and no agent process is spawned, until
       * the first message (see `send`). Synchronous on purpose — a new thread
       * should never be something you wait for.
       */
      newDraftThread(opts: {
        project: Project
        profile: Profile
        /** One of `profile.agents`; the profile's first when left out. */
        agentId?: string
        model?: string
        effort?: string
        /** Adopt this exact id instead of minting one — a reload that landed on
            a thread the server never heard of, which is what an unsent draft
            looks like from a fresh page. */
        id?: string
      }) {
        const { project, profile, model, effort } = opts
        const id = opts.id ?? uuid()
        /* The library picks come from the same remembered defaults the agent
           does — read here rather than by each caller, so a reload that
           re-adopts an unsent draft gets its MCP servers, skills and commands
           back along with its profile. */
        const defaults = loadThreadDefaults()
        const tools = defaultToolPicks(defaults)
        dispatch({
          type: "draft-session",
          session: {
            id,
            profileId: profile.id,
            projectId: project.id,
            agentId: opts.agentId ?? profileAgentIds(profile)[0] ?? "",
            model: model ?? "",
            effort: effort ?? "",
            /* Remembered like the tool picks, and read here for the same
               reason: a reload that re-adopts an unsent draft has to get back
               the way it was going to be worked on, not just its profile. */
            personaId: defaults.personaId ?? "",
            title: "New thread",
            createdAt: Date.now(),
            deletedAt: null,
            attached: false,
            exited: false,
            promptActive: false,
            cursor: 0,
            draft: true,
            ...tools,
          },
        })
        dispatch({ type: "thread-reset", id, thread: { ...emptyThread } })
        return id
      },

      /**
       * Find out what an agent can be configured with on a profile, once.
       *
       * The server answers by spawning one and killing it (see probe.ts), which
       * is the only way to ask — so this runs at most once per (profile, agent)
       * per page-load, and never when a live session has already told us. A
       * failure is silent on purpose: the menu falls back to saying the settings
       * appear once the thread starts, which is exactly what it said before.
       */
      async learnAgentOptions(profileId: string, agentId: string, projectId: string) {
        if (!agentId) return
        const key = optionKey(profileId, agentId)
        if (alreadyAsked(key) || loadAgentOptions(key).base.length > 0) return
        markAsked(key)
        try {
          const probed = await api<{
            configOptions: acp.SessionConfigOption[]
            byModel: AgentOptionSet["byModel"]
          }>(settings, `/api/profiles/${profileId}/options`, {
            method: "POST",
            body: JSON.stringify({ projectId, agentId }),
          })
          saveProbedOptions(key, {
            base: probed.configOptions ?? [],
            byModel: probed.byModel ?? {},
          })
        } catch (error) {
          console.warn(`Couldn't ask ${agentId} on ${profileId} what it supports`, error)
        }
      },

      /** Pick an agent setting on a thread that does not exist yet, against the
          option set that agent last advertised. Held until session/new can
          apply it — see `createSession`. */
      chooseDraftConfigOption(id: string, configId: string, value: string | boolean) {
        dispatch({ type: "draft-config-option", id, configId, value })
      },

      /** Retune a thread that does not exist yet. Model and effort are env at
          spawn, so until the process starts they are ours to change freely. */
      configureDraft(
        id: string,
        next: Partial<
          Pick<
            SessionMeta,
            | "projectId"
            | "profileId"
            | "agentId"
            | "model"
            | "effort"
            | "personaId"
            | "mcpServerIds"
            | "skillIds"
            | "commandIds"
          >
        >
      ) {
        dispatch({ type: "configure-draft", id, next })
      },

      openThread,

      /** Reattach to a thread whose socket was closed while the agent process is
          still alive — e.g. another device took it over (close code 4002).
          Same code path as revive; openThread respawns only if `meta.exited`. */
      async reconnectThread(sessionId: string) {
        const timer = reconnectTimers.get(sessionId)
        if (timer) {
          clearTimeout(timer)
          reconnectTimers.delete(sessionId)
        }
        reconnectAttempts.delete(sessionId)
        reconnectWaiting.delete(sessionId)
        await reconnectThread(sessionId)
      },

      async reviveThread(sessionId: string) {
        await revive(sessionId)
      },

      /**
       * Fetch the page of history above the transcript and fold it in.
       *
       * The socket owns the mechanics (it is the only thing holding the events
       * the re-fold needs); this only guards against stacking two pages and
       * marks the button busy while one is in flight.
       */
      async loadEarlier(sessionId: string) {
        const thread = liveThreads.get(sessionId)
        if (!thread || stateRef.current.threads[sessionId]?.loadingEarlier) return
        dispatch({ type: "thread-window", id: sessionId, loadingEarlier: true })
        try {
          await thread.loadEarlier()
        } catch (error) {
          dispatch({ type: "thread-window", id: sessionId, loadingEarlier: false })
          reportError(error, "Couldn't load earlier messages")
        }
      },

      /**
       * Send a prompt. A failure here is recorded in the transcript — with the
       * text, so the row can offer Retry — and then rethrown, so the composer
       * can react too. Callers must not toast it a second time.
       */
      async send(sessionId: string, text: string, opts: { steer?: boolean } = {}) {
        /* First message on a draft: show the message instantly, then create the
           thread on the server. A failure leaves the draft a draft and lands the
           text in a Retry row like any other send failure — and retrying re-runs
           this, which is correct: if the POST is what failed, the id is still
           free. */
        const draft = stateRef.current.sessions.find((s) => s.id === sessionId && s.draft)
        if (draft) {
          /* Show the message and connecting state instantly rather than waiting
             for the full server round-trip — the agent spawn, handshake and
             WebSocket replay can take seconds. On failure, clean up the
             optimistic state and record a Retry-able error. */
          dispatch({ type: "user-message", id: sessionId, text })
          dispatch({ type: "session-title", id: sessionId, title: text.slice(0, 60) })
          dispatch({ type: "turn-active", id: sessionId, active: true })
          try {
            await createSession(draft)
          } catch (error) {
            dispatch({ type: "thread-status", id: sessionId, status: "idle" })
            dispatch({ type: "drop-user-message", id: sessionId })
            dispatch({ type: "turn-active", id: sessionId, active: false })
            recordError(sessionId, error, "Couldn't start this thread", text)
            throw error
          }
          /* The optimistic bubble above does not survive the connect it is
             waiting for: the fresh attach is not a resume, so `onAttached`
             sends a `thread-reset` and the replay that follows is empty — the
             prompt has not been dispatched yet, so there is no journaled
             `turn_started` to redraw it from, and this device is the one peer
             that never gets one. The message simply vanished until a reload
             replayed it. So put it back, but only if the reset really took it:
             re-dispatching blindly would double the bubble on any path that
             kept the transcript. */
          const restored = stateRef.current.threads[sessionId]?.items ?? []
          if (!restored.some((item) => item.kind === "user" && !item.turnId)) {
            dispatch({ type: "user-message", id: sessionId, text })
            dispatch({ type: "session-title", id: sessionId, title: text.slice(0, 60) })
            dispatch({ type: "turn-active", id: sessionId, active: true })
          }
        }
        /* An archived thread is attached, but to the journal rather than to an
           agent — reading it needed no process, and this is the moment that
           stops being true. Revive before the prompt rather than refusing it:
           the user typed into a thread that looked open, and "revive it and
           send again" is a step the client can take on their behalf. The revive
           respawns, `session/load`s, and re-attaches, so the socket read below
           is deliberately taken afterwards. */
        if (stateRef.current.threads[sessionId]?.archived) {
          try {
            await revive(sessionId)
          } catch (error) {
            recordError(sessionId, error, "Couldn't restart this thread's agent", text)
            throw error
          }
        }
        // Read AFTER creating: that is what registered the thread.
        const thread = liveThreads.get(sessionId)
        if (!thread) {
          const error = new Error(
            "This thread has no live connection to its agent — revive it and send again."
          )
          recordError(sessionId, error, "Couldn't send the message", text)
          throw error
        }
        /* Steering — a prompt sent while a turn is already running — is why this
           is read BEFORE the dispatch below. If this send fails, it may only
           take back the indicator it turned on itself: a steer that never
           reaches the agent leaves the turn it was aimed at still running, and
           clearing the indicator there loses it until a reload (the server is
           still `promptActive`, so `caught_up` puts it straight back — which is
           exactly the "refresh brings it back" shape of the bug). */
        const alreadyRunning = stateRef.current.threads[sessionId]?.turnActive ?? false
        /* A message typed into a running turn is QUEUED, not steered, unless
           asked otherwise. No bubble and no indicator here: the `queue` event
           draws the row, and when the turn ends the drained prompt comes back
           as a `turn_started` with no origin — so this device draws the bubble
           then, exactly like every other peer. If the turn ended before this
           server saw this, `queue_add` drains at once and the same holds. */
        if (!draft && alreadyRunning && !opts.steer) {
          try {
            await thread.queueAdd(text)
          } catch (error) {
            recordError(sessionId, error, "Couldn't queue this message", text)
            throw error
          }
          return
        }
        /* A draft already dispatched its optimistic bubble and turn-active
           above — only emit them for threads that were already live. */
        if (!draft) {
          dispatch({ type: "user-message", id: sessionId, text })
          dispatch({ type: "session-title", id: sessionId, title: text.slice(0, 60) })
        }
        /* This device is the one peer that does not get a `turn_started` — it
           already put the message on screen — so it lights its own indicator.
           `turn_ended` is what clears it, here and everywhere else. */
        if (!draft) dispatch({ type: "turn-active", id: sessionId, active: true })
        try {
          /* Resolves when the server has dispatched the prompt, not when the
             turn ends: how the turn went reaches every device on the thread as
             `turn_ended`, and awaiting it here would report a failure twice. */
          const reply = await thread.prompt(text, opts)
          if ("queued" in reply) {
            /* The server was busy before this device knew — another peer or
               the scheduler started a turn. The words are on the queue row
               now, so the optimistic bubble comes back off. */
            dispatch({ type: "drop-user-message", id: sessionId })
            if (!alreadyRunning) dispatch({ type: "turn-active", id: sessionId, active: true })
            return
          }
          dispatch({ type: "tag-user-turn", id: sessionId, turnId: reply.turnId })
        } catch (error) {
          /* For a draft we set turn-active ourselves above, so clear it on
             failure — the prompt never reached the agent. For a non-draft
             where alreadyRunning was true, another turn is genuinely active
             and must not be disturbed. */
          if (!alreadyRunning || draft) dispatch({ type: "turn-active", id: sessionId, active: false })
          recordError(sessionId, error, "The agent couldn't answer this message", text)
          throw error
        }
      },

      /**
       * Change a thread's profile, model or effort — and let the server say
       * what that costs.
       *
       * All three are placed by the agent's env at spawn, and all three used to
       * mean the same thing here: kill the process, spawn another, put the
       * conversation back. They do not any more. The endpoint and the
       * credential live behind the harness's own gateway URL, which names the
       * *thread*, and the model is either the agent's own selector or another
       * rewrite on the same wire — so the common case is now one request that
       * changes nothing anybody can see. See CLAUDE.md.
       *
       * Which case it is, is not knowable from here: it depends on the agent,
       * on whether the thread is behind the shim, and on whether the running
       * process will take the model. So the route decides and answers `live`,
       * and only the falsy answer does the reconnect dance — a live change
       * arrives back as a `spawn_config` event on the socket that is already
       * open, on this device and every other.
       */
      changeThreadConfig,

      /**
       * Move a thread onto a different profile: different credentials, base URL
       * and model catalog.
       *
       * Model and effort are deliberately NOT carried over. They name a model in
       * the profile being left, which the profile being joined may not serve at
       * all, so the new profile's own default is the honest starting point —
       * and the server is what resolves "none" into it.
       */
      async changeProfile(meta: SessionMeta, profileId: string) {
        // Same agent, new provider: the menu only offers profiles that serve
        // this thread's agent, and the server refuses one that does not.
        await changeThreadConfig(
          meta,
          { profileId, model: "", effort: "" },
          "Couldn't move this thread to that profile"
        )
      },

      /** Change the model or reasoning effort of a thread whose profile carries
          its own model catalog. */
      async changeSpawnConfig(meta: SessionMeta, next: { model?: string; effort?: string }) {
        await changeThreadConfig(meta, next, "Couldn't change this thread's model")
      },

      /**
       * Change how this thread is worked on.
       *
       * Always a respawn — no runtime we ship will take a persona on a running
       * process — so `changeThreadConfig`'s `live: false` tail is the ordinary
       * path here rather than the fallback: the socket closes, the cursor is
       * dropped and the thread reattaches from 0 against the conversation
       * `session/load` has just restored. `""` is a real value and means no
       * persona; model and profile are left alone, because a persona says
       * nothing about either.
       */
      async changeThreadPersona(meta: SessionMeta, personaId: string) {
        await changeThreadConfig(
          meta,
          { personaId },
          "Couldn't change how this thread works"
        )
      },

      /* Mode and config changes are optimistic in the UI, so a rejection has to
         be loud — otherwise the control snaps back with no explanation. */
      async setMode(sessionId: string, modeId: string) {
        try {
          await liveThreads.get(sessionId)?.setMode(modeId)
        } catch (error) {
          recordError(sessionId, error, "The agent rejected that mode")
          throw error
        }
        dispatch({ type: "mode", id: sessionId, modeId })
      },

      async setConfigOption(sessionId: string, configId: string, value: string | boolean) {
        // Read the category first: the response replaces the whole option set,
        // and the category is what says whether this pick is also spawn state.
        const category = stateRef.current.threads[sessionId]?.configOptions.find(
          (option) => option.id === configId
        )?.category
        try {
          const configOptions = await liveThreads.get(sessionId)?.setConfigOption(configId, value)
          if (configOptions) dispatch({ type: "config-options", id: sessionId, configOptions })
        } catch (error) {
          recordError(sessionId, error, `The agent rejected that ${configId} setting`)
          throw error
        }
        /* Model and effort are also process env: the server rebuilds them from
           the session record every time it revives a retired thread. It records
           the change itself now (it knows the option's category), so all that is
           left here is to re-read the list this thread's row appears in. */
        if (category === "model" || category === "thought_level") await refreshSessions()
      },

      // ---- the queue ----
      // Each answers with a `queue` event to every peer; a failure lands in
      // the thread like any other, with the text where there is one to retry.

      async queueUpdate(sessionId: string, itemId: string, text: string) {
        try {
          await requireLive(sessionId).queueUpdate(itemId, text)
        } catch (error) {
          recordError(sessionId, error, "Couldn't edit the queued message", text)
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
          place. No "interrupted" notice: `turn_ended` → `turn_started` says
          it, and the server does all three steps whether or not this tab
          stays open. */
      async queueSendNow(sessionId: string, itemId?: string) {
        try {
          await requireLive(sessionId).queueSendNow(itemId)
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

      async stop(sessionId: string) {
        await liveThreads.get(sessionId)?.cancel()
        /* The agent writes its own "[Request interrupted by user]" turn, but
           only the session/load replay surfaces it — without this the rule (and
           the Continue button on it) would not appear until a reload. */
        dispatch({ type: "notice", id: sessionId, text: "Request interrupted by user" })
      },

      /** Name a thread by hand.
       *
       * A draft has no server row, so its name lives in the store until the
       * first message carries it into `POST /api/sessions` — which is why the
       * create call sends the title at all. For a started thread the server is
       * asked first and the store follows its answer, because the server is
       * what trims and caps it and a row saying something else is a list that
       * disagrees with the thread it names. */
      async renameThread(sessionId: string, title: string) {
        const next = title.trim()
        if (!next) return
        if (stateRef.current.sessions.find((s) => s.id === sessionId)?.draft) {
          dispatch({ type: "rename-session", id: sessionId, title: next })
          return
        }
        const { title: named } = await api<{ title: string }>(
          settings,
          `/api/sessions/${sessionId}`,
          { method: "PATCH", body: JSON.stringify({ title: next }) }
        )
        dispatch({ type: "rename-session", id: sessionId, title: named })
      },

      /** Reversible: the agent process dies, the thread moves to Trash.
          A draft has neither, and nothing to be restored from — closing it just
          forgets it. */
      async deleteThread(sessionId: string) {
        if (stateRef.current.sessions.find((s) => s.id === sessionId)?.draft) {
          dispatch({ type: "drop-draft-session", id: sessionId })
          return
        }
        liveThreads.get(sessionId)?.close()
        liveThreads.delete(sessionId)
        await api(settings, `/api/sessions/${sessionId}`, { method: "DELETE" })
        await refreshSessions()
      },

      /** Back out of Trash. The thread returns process-less; opening it revives. */
      async restoreThread(sessionId: string) {
        await api(settings, `/api/sessions/${sessionId}/restore`, { method: "POST" })
        await refreshSessions()
      },

      /** The irreversible one — after this only the agent's own store has it. */
      async purgeThread(sessionId: string) {
        if (stateRef.current.sessions.find((s) => s.id === sessionId)?.draft) {
          dispatch({ type: "drop-draft-session", id: sessionId })
          return
        }
        liveThreads.get(sessionId)?.close()
        liveThreads.delete(sessionId)
        await api(settings, `/api/sessions/${sessionId}?purge=1`, { method: "DELETE" })
        await refreshSessions()
      },
    }
  }, [settings, dispatch])
}

export type Actions = ReturnType<typeof useActions>
