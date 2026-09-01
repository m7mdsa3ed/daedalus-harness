import type * as acp from "@agentclientprotocol/sdk"
import type {
  EarlierPage,
  HistoryLost,
  JournaledEvent,
  PromptReply,
  QueuedMessage,
  QuotaSnapshot,
  SessionUpdate,
  ThreadCommand,
  ThreadEvent,
  WireError,
} from "@daedalus/protocol"
import { api, wsUrl, type ServerSettings } from "./settings"

/**
 * How much of a thread's tail to ask for on a fresh attach, in **steps** (turns).
 *
 * The window is the *minimum* of two budgets, whichever binds first: this many
 * turns, or `REPLAY_WINDOW_BYTES` payload bytes — the half the *server* keeps,
 * because a step is a turn and a turn is not a size (one is a sentence, the
 * next is a build log). Below the window the transcript arrives whole and
 * `earlier` is 0, so nothing about short threads changes — no button, no
 * paging, no retained raw events. Long threads open with only their tail, and
 * the rest is paged back on demand (`load_earlier`).
 */
export const REPLAY_WINDOW_STEPS = 10

/**
 * How often a connected socket asks the server whether it is still there.
 *
 * The server pings at the frame level (`index.ts`), which the browser answers
 * by itself and never surfaces to JS — so that half proves the client is alive
 * to the SERVER and tells this end nothing. This is the other direction, and
 * it has to be an application-level `ping` command precisely because an idle
 * thread is legitimately silent for hours: without asking, "heard nothing" and
 * "the path is dead" are the same observation.
 */
const LIVENESS_PING_MS = 30_000
/** Two missed rounds, plus room for a slow answer. */
const LIVENESS_SILENCE_MS = LIVENESS_PING_MS * 2 + 15_000
/** The close code a socket the watchdog gave up on reports. Deliberately
    outside `NON_RECONNECTABLE_CLOSE_CODES` (a dead path is the case that most
    wants a reconnect) and unknown to `failureFor`, whose default — "lost the
    connection to the server, it may have restarted" — is exactly right. */
const SILENT_CLOSE_CODE = 4100


/**
 * The browser's end of one thread.
 *
 * The ACP client lives on the server now (`server/src/acp-bridge.ts`), so this
 * is not a protocol implementation — it is a socket that sends commands and
 * dispatches events. Payloads are still ACP-shaped, because the transcript
 * renders them, but nothing here knows what a JSON-RPC frame is.
 */

/** A failure the agent reported, carried across as JSON-RPC's own shape. The
    code and `data` are load-bearing: `lib/errors.ts` reads the first for its
    title and the second for the agent's stderr. */
export class AgentError extends Error {
  code: number
  data?: unknown
  constructor(error: WireError) {
    super(error.message)
    this.name = "AgentError"
    this.code = error.code
    this.data = error.data
  }
}

/**
 * The attach bracket as one HTTP document — what `GET /api/sessions/:id/replay`
 * answers, and what `ThreadSocket.load` folds.
 *
 * Deliberately the socket's own three events rather than a shape of its own:
 * they go straight back through `handle`, so nothing here is a second wire
 * format and a server that grows a field on `attached` grows it in both
 * transports at once.
 */
interface ReplayDocument {
  attached: Extract<ThreadEvent, { ev: "attached" }>
  frames: Extract<ThreadEvent, { ev: "replay" }>[]
  caughtUp: Extract<ThreadEvent, { ev: "caught_up" }>
}

export interface ThreadCloseInfo {
  clientInitiated: boolean
  code?: number
  reason?: string
}

export interface ThreadCallbacks {
  /** `historyReplay` is true for the updates a `session/load` streamed back —
      the reducer takes user chunks only then. `sessionId` is set when the
      update is a subagent's (see the `update` event in the protocol). */
  onUpdate: (update: SessionUpdate, historyReplay: boolean, sessionId?: string) => void
  /** The agent is asking something. Answer with `answerPermission`. */
  onPermission: (requestId: string, request: acp.RequestPermissionRequest) => void
  onElicitation: (requestId: string, request: acp.CreateElicitationRequest) => void
  /** Somebody (another device, or the agent giving up) settled a question this
      device may also be showing. */
  onRequestAnswered: (requestId: string) => void
  onStatus: (status: "connecting" | "connected" | "closed", closeInfo?: ThreadCloseInfo) => void
  /** The session's modes and config options, whole — from `session/new`,
      `session/load`, or any accepted change from any device. */
  onSessionConfig: (
    modes: acp.SessionModeState | null | undefined,
    modeId: string | undefined,
    configOptions: acp.SessionConfigOption[] | undefined
  ) => void
  /** The thread moved to another profile, model or effort without restarting.
      Fanned out to every device, this one included — the server resolves what
      a cleared value means, so the answer is what to draw. */
  onSpawnConfig: (profileId: string, model: string, effort: string, personaId?: string) => void
  /** Time-to-first-update for a turn, ms, measured server-side. */
  onTtft: (ms: number) => void
  /** What is left of the subscription this thread spends, re-read after a turn
      settled. Absolute and live-only — never journaled, so a replay never
      redraws an old percentage as though it were now. */
  onQuota: (quota: QuotaSnapshot) => void
  /** A turn began. Only ever seen for a prompt this device did NOT send — its
      own message is already on screen. `catchingUp` marks the replay. */
  onTurnStarted: (turnId: string, text: string, catchingUp: boolean) => void
  /** `continued` says the queue is draining into a new turn right behind this
      one — nothing to announce as finished. */
  onTurnEnded: (
    usage: acp.Usage | null,
    error: WireError | undefined,
    promptText: string | undefined,
    catchingUp: boolean,
    continued: boolean,
    /** Which turn's numbers those are — what lets a turn print its own cost
        where it sits, rather than only feeding the thread's running total. */
    turnId: string
  ) => void
  /** The thread's queue, whole. Every change to it arrives this way — this
      device's own included, since the ids are the server's. */
  onQueue: (items: QueuedMessage[]) => void
  /** The replay is about to start.

      `resumed` says whether it continues the transcript already on screen (this
      device's own cursor) or replaces it. It is the server's word rather than
      an inference from `from > 0`, because `from` now has two sources: this
      device's cursor, and a window the server chose for a thread too long to
      send whole.

      `earlier` is how many **steps** (turns) sit *before* the replay and were
      not sent — 0 for everything but a windowed attach. `archived` means there
      is no agent process behind the thread and what follows is the journal
      alone. `historyLost` is set when the agent refused to reload this thread's
      conversation: the replay that follows is an empty transcript, and the only
      difference between that and a brand new thread is this field. */
  onAttached: (
    info: { from: number; to: number; resumed: boolean; earlier: number; archived: boolean },
    historyLost?: HistoryLost
  ) => void
  /** A `replay` frame landed and its events have been folded. `done`/`total`
      are events, counted against the window the server named in `attached`, and
      exist so a long replay can say how long it is rather than apologising for
      taking a while — the same bargain the service worker's precache bar makes.
      Not raised at all when the server did not state a total (one that predates
      the field, or a non-batch replay with no frames to count): a total of zero
      is not a small number, it is the absence of one, and a bar drawn against
      it is a lie that jumps. */
  onReplayProgress: (done: number, total: number) => void
  /** A `load_earlier` page arrived and the transcript is about to be re-folded
      from the start of the widened window. Brackets the re-fold with
      `onRewound` exactly as `attached`/`caught_up` bracket a replay — same
      buffer, same one commit, same suppressed notifications. */
  onRewind: () => void
  onRewound: (earlier: number) => void
  /** The replay is over; everything after this is live. `promptActive` is read
      server-side in the same tick as the log it follows, so it cannot pair a
      stale turn state with a fresh replay window. */
  onCaughtUp: (cursor: number, promptActive: boolean, queue: QueuedMessage[]) => void
  /** The journal position this device has folded up to, as it moves — so the
      cursor a reconnect resumes from describes what is actually on screen and
      not merely what was there when this socket attached. Raised on every
      journaled event, live and replayed alike; cheap on purpose, because it is
      called at the rate the agent streams. */
  onCursor: (cursor: number) => void
  /** A background task this thread's agent launched appended a journal line —
      the server tails the file (see /api/tasks/watch) and streams the rest. */
  onTaskEvent: (transcriptDir: string, event: Record<string, unknown>) => void
}

interface Deferred {
  resolve: (result: unknown) => void
  reject: (error: unknown) => void
}

export class ThreadSocket {
  readonly serverSessionId: string
  private settings: ServerSettings
  private callbacks: ThreadCallbacks
  private ws: WebSocket | null = null
  private nextId = 1
  private inflight = new Map<number, Deferred>()
  private clientInitiatedClose = false
  private closeInfo: ThreadCloseInfo = { clientInitiated: false }
  /** True between `attached` and `caught_up`: everything in that window is
      history, and history must not raise notifications for turns that finished
      hours ago. Also true across a re-fold, for the same reason. */
  private catchingUp = false
  /**
   * The journaled events this socket has folded, kept so a `load_earlier` page
   * can be folded in *front* of them.
   *
   * Only retained when the server said history was hidden (`earlier > 0`), and
   * that condition is the whole design: the reducer builds the transcript by
   * appending, so an older event cannot be inserted into it — the only way to
   * place one correctly is to fold the whole widened window again from the
   * start. Doing that needs the events, and keeping them costs roughly a second
   * copy of the transcript. A thread that arrived whole can never page back, so
   * it pays none of it.
   */
  private raw: JournaledEvent[] | null = null
  /**
   * The journal position this device has folded up to: one past the highest
   * seq it has seen. What a reconnect resumes from.
   *
   * It has to advance with every journaled event, and for a long time it did
   * not — it was written once, from `caught_up`, and then stood still for the
   * rest of the session. Everything after that point was already on screen and
   * the saved cursor did not know it, so a socket that dropped an hour into a
   * thread resumed from the hour-old position, and the server — correctly —
   * replayed the whole hour as the delta the client had asked for. A resume
   * *keeps* the transcript and appends (that is what makes it cheap), so the
   * hour arrived twice: every message, every tool call, every turn, folded a
   * second time onto the end of the conversation it duplicated.
   *
   * Advanced in `handle` rather than in `fold`, which is exactly the split that
   * already exists there: a `load_earlier` re-fold runs the held events through
   * `fold` again, and those are events this cursor is long past.
   */
  private cursor = 0
  /** The seq of the `turn_started` that opens the earliest step this socket
      holds, and how many steps (turns) are behind it on the server. */
  private windowFrom = 0
  private earlier = 0
  /** Events replayed so far in this attach, and how many the server said were
      coming. Reset by every `attached`; 0/0 outside a replay. */
  private replayed = 0
  private replayTotal = 0
  /** The `loadEarlier` in flight, if any — see the re-entrancy note there. */
  private earlierInFlight: Promise<void> | null = null
  /**
   * A page of history fetched before anybody asked for it, and the
   * `windowFrom` it was fetched against.
   *
   * Paging back is two costs with very different shapes: a round trip to the
   * server, which on a phone behind a tunnel is most of the wait, and the
   * re-fold, which is CPU here and cannot start until the events arrive. Only
   * the first can be paid in advance — so it is, when the reader gets near the
   * top of the transcript, and the click that follows pays the fold alone. The
   * stash is keyed by the position it was fetched for, because a page that
   * arrived and was then folded describes a window that no longer exists.
   */
  private earlierPrefetch: { before: number; page: EarlierPage } | null = null
  private prefetchInFlight: Promise<void> | null = null
  /** When this socket last heard ANY frame from the server, and the timer that
      checks it. Started at `caught_up` rather than at `connect()`: a replay is
      a socket that is provably talking, and a watchdog over it could only ever
      fire on a healthy connection mid-stream. */
  private lastSeenAt = 0
  private watchdog: ReturnType<typeof setInterval> | null = null
  /** Set by the first answered ping. Until then silence is not evidence: a
      server that predates the `ping` command answers nothing at all, and
      enforcing the deadline against one would reconnect a healthy socket every
      75 seconds forever. */
  private livenessProven = false
  /**
   * Whether this thread has been folded from the HTTP snapshot already, and
   * whether it was served with no agent behind it.
   *
   * A socket is not opened by a read at all any more — `archived` merely says
   * one can never be, since the thread has no process behind it. Either way the
   * journal is reachable over HTTP for what a reader does (paging back), and a
   * socket is opened lazily by the first thing that genuinely needs one: a
   * command (see `ensureSocket`), or a prompt, which goes through
   * `ThreadConnection.ready()`.
   */
  private loaded = false
  private archived = false

  constructor(serverSessionId: string, settings: ServerSettings, callbacks: ThreadCallbacks) {
    this.serverSessionId = serverSessionId
    this.settings = settings
    this.callbacks = callbacks
  }

  get connected(): boolean {
    return this.ws !== null
  }

  /** How many journaled events are still on the server, ahead of the oldest one
      this socket holds. 0 means the transcript on screen is the whole thread. */
  get earlierAvailable(): number {
    return this.earlier
  }

  /** True once `load()` has folded a snapshot, so a caller can tell "nothing on
      screen yet" from "read, and deliberately without a socket". */
  get isLoaded(): boolean {
    return this.loaded
  }

  /** Served from the journal with no agent process behind it. */
  get isArchived(): boolean {
    return this.archived
  }

  /** `close()` was called on this object — it is a husk, whatever else it
      holds, and a caller must build a new one rather than reuse it. */
  get isDisposed(): boolean {
    return this.clientInitiatedClose
  }

  /**
   * Read the thread over HTTP and fold it, before any socket exists.
   *
   * This is how a thread is opened now. The document is the same
   * `attached` / `replay` frames / `caught_up` bracket the socket sends
   * (`GET /api/sessions/:id/replay`), so it goes through the same `handle`
   * switch, drives the same callbacks and there is still exactly one parser —
   * the transport is the only thing that changed. What that buys is the whole
   * of the opening wait: a read used to cost a WebSocket handshake, an attach
   * and a paced stream of frames before its first line could be drawn, where
   * this is one request on a connection the browser already holds, compressed
   * whole, parsed once.
   *
   * The socket that follows is then a *resume* from `caught_up.cursor` — a
   * delta, and usually an empty one — rather than the thing the wait was made
   * of. And when the thread came back archived there is no socket at all:
   * nothing is going to be said on it, and `loadEarlier` and the queue edits
   * both have an HTTP answer of their own.
   *
   * Status is left alone here beyond "connecting": what "connected" means is
   * still the socket, and `startThread` says it for the archived case where
   * there will never be one.
   */
  async load(opts: { cursor?: number } = {}): Promise<{ archived: boolean }> {
    this.callbacks.onStatus("connecting")
    const cursor = opts.cursor ?? 0
    const params = new URLSearchParams({ cursor: String(cursor) })
    /* Same rule as `connect`: a resume asks for a delta whose size it already
       knows, and windowing that would hide events this device is missing. */
    if (cursor === 0) params.set("window", String(REPLAY_WINDOW_STEPS))
    const doc = await api<ReplayDocument>(
      this.settings,
      `/api/sessions/${this.serverSessionId}/replay?${params}`
    )
    this.handle(doc.attached)
    for (const frame of doc.frames) this.handle(frame)
    this.handle(doc.caughtUp)
    this.loaded = true
    this.archived = doc.attached.archived ?? false
    return { archived: this.archived }
  }

  /** Resolves once the replay is done and the thread is live. */
  connect(opts: { cursor?: number } = {}): Promise<void> {
    this.callbacks.onStatus("connecting")
    this.clientInitiatedClose = false
    this.closeInfo = { clientInitiated: false }
    const cursor = opts.cursor ?? 0
    /* A resume asks for a delta it already knows the size of, so windowing it
       would hide events this device is actually missing. The server refuses to
       window a resume for the same reason; sending 0 keeps the two ends saying
       the same thing rather than relying on one of them to correct the other. */
    const ws = new WebSocket(
      wsUrl(this.settings, this.serverSessionId, cursor, cursor > 0 ? 0 : REPLAY_WINDOW_STEPS)
    )
    this.ws = ws

    return new Promise<void>((resolve, reject) => {
      let settled = false
      /* No timer on the replay: a long thread legitimately takes longer than
         any fixed budget to stream, and a deadline here turned a slow replay
         into "Couldn't connect to this thread" for a socket that was healthy
         and mid-stream. The promise still settles on `caught_up` or on the
         socket closing (below), so it cannot hang. */
      const done = (error?: unknown) => {
        if (settled) return
        settled = true
        if (error) reject(error)
        else resolve()
      }

      ws.addEventListener("message", (event) => {
        let parsed: ThreadEvent
        try {
          parsed = JSON.parse(String(event.data)) as ThreadEvent
        } catch {
          return
        }
        // Any frame at all is proof the path is alive — the watchdog's deadline
        // is measured from here, and the ping it sends is only there to make an
        // idle thread produce one.
        this.lastSeenAt = Date.now()
        // `caught_up` is what "connected" means: before it, the socket is
        // replaying and a caller that acted on it would prompt into history.
        if (parsed.ev === "caught_up") {
          this.callbacks.onStatus("connected")
          this.startWatchdog()
          /* A socket opened while the page is frozen is not a peer that can
             draw anything either. Rare (a frozen page starts no connection),
             but a reconnect that lands during a freeze would otherwise silence
             the push for a thread nobody is watching. */
          if (pageFrozen) this.setBackground(true)
          done()
        }
        this.handle(parsed)
      })

      ws.addEventListener("close", (event) => {
        this.closeInfo = {
          clientInitiated: this.clientInitiatedClose,
          code: event.code,
          reason: event.reason,
        }
        /* This promise is about THIS socket, so it settles whatever else has
           happened since — including `close()` being called on us mid-connect
           (a respawn, or a second open replacing this one), which nulls
           `this.ws` and would otherwise leave the caller awaiting a connection
           that can never arrive. A close we asked for is not a failure to
           report, so it resolves; a close that happened to us keeps the
           server's own account as the rejection. `done` is idempotent, so a
           socket that had already caught up is unaffected either way. */
        if (this.closeInfo.clientInitiated) done()
        else done(new Error(explain(this.closeInfo)))
        // A later connect() owns the status now; reporting this one's close
        // would mark a live connection dead and book a phantom reconnect.
        if (this.ws !== ws) return
        this.ws = null
        this.stopWatchdog()
        this.failInflight(new Error(this.closeInfo.reason || "the connection to the thread closed"))
        this.callbacks.onStatus("closed", this.closeInfo)
      })

      ws.addEventListener("error", () => {
        // 'close' always follows, and it carries the reason — this only exists
        // so a socket that never opened does not hang the promise silently.
        if (this.ws === ws && ws.readyState === WebSocket.CLOSED) {
          done(new Error("couldn't open a connection to this thread"))
        }
      })
    })
  }

  private handle(event: ThreadEvent): void {
    switch (event.ev) {
      case "attached": {
        this.catchingUp = true
        /* An older server does not send these three. `from > 0` was the only
           signal it had, and for such a server it still means exactly what it
           used to — it never windows, so a non-zero `from` can only be this
           device's own cursor. */
        const resumed = event.resumed ?? event.from > 0
        /* A resume reports `earlier: 0` and a `from` that is this device's own
           cursor — both true statements about the delta, and both wrong about
           the window. This socket now routinely follows an HTTP read of the
           same thread (`load`), so the window it holds was established by that
           document and the resume must not overwrite it: doing so moved
           `windowFrom` to the end of the log and zeroed `earlier`, which took
           the "Load earlier steps" button off a windowed thread the moment it
           finished opening. Kept only when this object is the one that read it;
           a socket attaching with nothing behind it still learns both here. */
        const earlier = event.earlier ?? 0
        if (!(resumed && this.loaded)) {
          this.windowFrom = event.from
          this.earlier = earlier
        }
        /* The replay starts here, so this is what has been folded before any of
           it arrives — a resume's own cursor, or the start of the window the
           server chose. */
        this.cursor = event.from
        // How much replay is coming, in events. Zero when the server said
        // nothing (an older one, which never had the field) — see onReplayProgress.
        this.replayTotal = Math.max(0, (event.to ?? 0) - event.from)
        this.replayed = 0
        // Only worth carrying the events when there is something to fold them
        // in front of; see `raw`.
        if (!resumed) this.raw = earlier > 0 ? [] : null
        // Fetched against a window this attach has just redrawn.
        this.earlierPrefetch = null
        this.callbacks.onAttached(
          {
            from: event.from,
            to: event.to ?? event.from,
            resumed,
            earlier: this.earlier,
            archived: event.archived ?? false,
          },
          event.historyLost
        )
        return
      }
      case "caught_up":
        this.catchingUp = false
        /* The server's cursor is the end of the replay it just sent. Ours is
           the end of what we folded, which is the same number — unless a live
           event overtook the bracket (an older server, which does not hold one
           back while the archive streams), in which case ours is ahead and the
           server's would give that event back on the next resume. */
        this.cursor = Math.max(this.cursor, event.cursor)
        this.callbacks.onCaughtUp(this.cursor, event.promptActive, event.queue ?? [])
        return
      /* The replay, arriving whole. Unrolled through this same switch so there
         is no second parser: `catchingUp` is already true (the `attached` that
         precedes it set it), the callbacks see exactly what a one-frame-per-
         event server would have sent, and only the number of times the browser
         wakes up to receive it changed. */
      case "replay":
        for (const journaled of event.events) this.handle(journaled)
        /* Said once per frame rather than once per event: the frame is already
           the unit the server cut the replay into and the unit the reducer
           commits, so it is the only point at which the count and what is on
           screen agree. Clamped, because the log can grow between the total the
           server read at attach and the last frame it sends — a bar that says
           1.1 of 1 is worse than one that sits at full for a beat. */
        if (this.replayTotal > 0) {
          this.replayed = Math.min(this.replayTotal, this.replayed + event.events.length)
          this.callbacks.onReplayProgress(this.replayed, this.replayTotal)
        }
        return
      case "update":
      case "session_config":
      case "turn_started":
      case "turn_ended":
        // Monotonic: a re-attach mid-flight must never walk the cursor back to
        // a position this device has already read past.
        this.cursor = Math.max(this.cursor, event.seq + 1)
        this.callbacks.onCursor(this.cursor)
        this.raw?.push(event)
        this.fold(event)
        return
      case "permission":
        this.callbacks.onPermission(event.requestId, event.request)
        return
      case "elicitation":
        this.callbacks.onElicitation(event.requestId, event.request)
        return
      case "request_answered":
        this.callbacks.onRequestAnswered(event.requestId)
        return
      case "queue":
        this.callbacks.onQueue(event.items)
        return
      case "spawn_config":
        this.callbacks.onSpawnConfig(event.profileId, event.model, event.effort, event.personaId)
        return
      case "ttft":
        this.callbacks.onTtft(event.ms)
        return
      case "quota":
        this.callbacks.onQuota(event.quota)
        return
      case "task_event":
        this.callbacks.onTaskEvent(event.transcriptDir, event.event)
        return
      case "reply": {
        const pending = this.inflight.get(event.id)
        if (!pending) return
        this.inflight.delete(event.id)
        if (event.error) pending.reject(new AgentError(event.error))
        else pending.resolve(event.result)
        return
      }
    }
  }

  /** Put one journaled event through its callback. Split out of `handle` so a
      re-fold can replay the events this socket already holds without recording
      them a second time. */
  private fold(event: JournaledEvent): void {
    switch (event.ev) {
      case "update":
        this.callbacks.onUpdate(event.update, event.historyReplay, event.sessionId)
        return
      case "session_config":
        this.callbacks.onSessionConfig(event.modes, event.modeId, event.configOptions)
        return
      case "turn_started":
        this.callbacks.onTurnStarted(event.turnId, event.text, this.catchingUp)
        return
      case "turn_ended":
        this.callbacks.onTurnEnded(
          event.usage,
          event.error,
          event.promptText,
          this.catchingUp,
          event.continued ?? false,
          event.turnId
        )
        return
    }
  }

  // ---- commands ----

  /**
   * Send a prompt. Resolves once the server has dispatched it, not when the
   * turn ends — the turn's outcome (and its failure) reaches every device on
   * the thread as `turn_ended`, so waiting here would report it twice.
   */
  async prompt(text: string, opts: { steer?: boolean } = {}): Promise<PromptReply> {
    return (await this.request((id) => ({
      id,
      cmd: "prompt",
      text,
      ...(opts.steer ? { steer: true } : {}),
    }))) as PromptReply
  }

  async cancel(): Promise<void> {
    await this.request((id) => ({ id, cmd: "cancel" }))
  }

  // ---- the queue ----
  // Every one of these is answered with a `queue` event as well as its reply;
  // the reply is for the caller's own error handling, the event is the state.

  async queueAdd(text: string): Promise<PromptReply> {
    return (await this.request((id) => ({ id, cmd: "queue_add", text }))) as PromptReply
  }

  async queueUpdate(itemId: string, text: string): Promise<void> {
    await this.request((id) => ({ id, cmd: "queue_update", itemId, text }))
  }

  async queueRemove(itemId: string): Promise<void> {
    await this.request((id) => ({ id, cmd: "queue_remove", itemId }))
  }

  async queueClear(): Promise<void> {
    await this.request((id) => ({ id, cmd: "queue_clear" }))
  }

  /** Interrupt the running turn and send what is queued in its place — one
      item, or everything combined. Atomic on the server. */
  async queueSendNow(itemId?: string): Promise<string> {
    const result = await this.request((id) => ({
      id,
      cmd: "queue_send_now",
      ...(itemId ? { itemId } : {}),
    }))
    return (result as { turnId: string }).turnId
  }

  /** Inject one queued item into the running turn without stopping it. */
  async queueSteer(itemId: string): Promise<string> {
    const result = await this.request((id) => ({ id, cmd: "queue_steer", itemId }))
    return (result as { turnId: string }).turnId
  }

  /**
   * Fetch the page of history before the oldest step on screen and re-fold the
   * transcript around it. Pages are whole steps (turns): the server cuts only
   * at `turn_started` boundaries, so what lands in front never begins mid-turn.
   *
   * The re-fold is the whole subtlety. The reducer builds the transcript by
   * appending — a tool call updates the item it already made, a compaction
   * upserts by id — so an older event cannot simply be prepended to the result;
   * it has to be folded in its own place, which means folding everything after
   * it again too. So this brackets the work the same way a replay is bracketed:
   * `onRewind` clears the items and opens the buffer, every held event goes
   * through the same callbacks in order, `onRewound` commits it as one render.
   * `catchingUp` stays true throughout, so re-folding a turn that failed hours
   * ago does not re-notify anybody about it.
   *
   * Answered by the journal, not by the agent, so it works on an archived
   * thread — which is where paging back mostly happens.
   */
  loadEarlier(): Promise<void> {
    /* Not re-entrant: two overlapping pages would both splice `raw` and move
       `windowFrom`, folding the same turns in twice. A second caller shares
       the page already on its way instead. */
    if (this.earlierInFlight) return this.earlierInFlight
    if (this.earlier <= 0 || !this.raw) return Promise.resolve()
    const inFlight = this.fetchEarlier().finally(() => {
      if (this.earlierInFlight === inFlight) this.earlierInFlight = null
    })
    this.earlierInFlight = inFlight
    return inFlight
  }

  /**
   * Fetch the next page of history without folding it, so the wait is over
   * before the reader asks.
   *
   * Fire-and-forget by design: nothing on screen changes, a failure is not
   * worth reporting (the button is still there and will ask again for real),
   * and it must never contend with a `loadEarlier` that is genuinely in
   * flight. Called when the top of the transcript comes near the viewport.
   */
  prefetchEarlier(): void {
    if (this.earlier <= 0 || !this.raw) return
    if (this.earlierInFlight || this.prefetchInFlight) return
    if (this.earlierPrefetch?.before === this.windowFrom) return
    const before = this.windowFrom
    this.prefetchInFlight = this.requestEarlier(before)
      .then((page) => {
        // The window moved while this was out — a real page landed first, and
        // this one is about a boundary that no longer exists.
        if (this.windowFrom === before) this.earlierPrefetch = { before, page }
      })
      .catch(() => {})
      .finally(() => {
        this.prefetchInFlight = null
      })
  }

  /** A page of history, from whichever transport is already there. Paging back
      is a read of the journal — the socket answers it without a bridge, and
      HTTP answers it without a socket, which is the case an archived thread is
      in for the whole of its life. */
  private async requestEarlier(before: number): Promise<EarlierPage> {
    if (!this.ws) {
      return await api<EarlierPage>(
        this.settings,
        `/api/sessions/${this.serverSessionId}/earlier?before=${before}`
      )
    }
    return (await this.request((id) => ({ id, cmd: "load_earlier", before }))) as EarlierPage
  }

  private async fetchEarlier(): Promise<void> {
    const before = this.windowFrom
    /* A prefetch that is still out is the page this call wants: wait for it
       rather than asking for the same range twice. */
    if (this.prefetchInFlight) await this.prefetchInFlight
    const stashed = this.earlierPrefetch?.before === before ? this.earlierPrefetch.page : null
    this.earlierPrefetch = null
    const page = stashed ?? (await this.requestEarlier(before))
    if (!this.raw) return // reattached under us; that replay is the authority
    const held = this.raw
    this.raw = [...page.events, ...held]
    this.windowFrom -= page.events.length
    this.earlier = page.earlier
    this.callbacks.onRewind()
    this.catchingUp = true
    try {
      for (const event of this.raw) this.fold(event)
    } finally {
      this.catchingUp = false
      this.callbacks.onRewound(this.earlier)
    }
  }

  async setMode(modeId: string): Promise<void> {
    await this.request((id) => ({ id, cmd: "set_mode", modeId }))
  }

  async setConfigOption(configId: string, value: string | boolean) {
    const result = await this.request((id) => ({ id, cmd: "set_config_option", configId, value }))
    return (result as { configOptions?: acp.SessionConfigOption[] } | undefined)?.configOptions
  }

  answerPermission(requestId: string, response: acp.RequestPermissionResponse): void {
    this.post({ cmd: "answer_permission", requestId, response })
  }

  answerElicitation(requestId: string, response: acp.CreateElicitationResponse): void {
    this.post({ cmd: "answer_elicitation", requestId, response })
  }

  /**
   * Tell the server whether this peer can still raise a notification itself.
   *
   * Best-effort by design: it is sent from a `freeze` handler, which is the
   * last code the page runs, and a socket that is not open at that moment has
   * nothing to correct — a reconnect re-sends it (`connect`), and a client that
   * never comes back stops being a peer at all, which is the same answer.
   */
  setBackground(background: boolean): void {
    try {
      this.post({ cmd: "background", background })
    } catch {
      /* Not connected: there is no peer to be in the background. */
    }
  }

  close(): void {
    this.clientInitiatedClose = true
    this.stopWatchdog()
    // The close event may not fire before the caller checks, so stamp the flag
    // here — otherwise onStatus reads a close we asked for as one we didn't and
    // schedules a phantom reconnect.
    this.closeInfo = { ...this.closeInfo, clientInitiated: true }
    const ws = this.ws
    this.ws = null
    this.failInflight(new Error("the thread was closed"))
    ws?.close()
  }

  // ---- liveness ----

  private startWatchdog(): void {
    if (this.watchdog) return
    this.lastSeenAt = Date.now()
    this.watchdog = setInterval(() => this.beat(), LIVENESS_PING_MS)
  }

  private stopWatchdog(): void {
    if (!this.watchdog) return
    clearInterval(this.watchdog)
    this.watchdog = null
  }

  private beat(): void {
    if (!this.ws) {
      this.stopWatchdog()
      return
    }
    if (this.livenessProven && Date.now() - this.lastSeenAt > LIVENESS_SILENCE_MS) {
      this.giveUp()
      return
    }
    /* A rejection here is the socket dying, which the close path already
       reports — and an unhandled one would surface as a global error about a
       thread that is merely reconnecting. The deadline above is what acts on
       silence; this only has to be sent. */
    this.request((id) => ({ id, cmd: "ping" })).then(
      () => {
        this.livenessProven = true
      },
      () => {},
    )
  }

  /**
   * Report a socket that stopped answering as closed, without waiting for the
   * browser to notice.
   *
   * `ws.close()` alone would not do: the closing handshake needs the very peer
   * that has stopped answering, so the event can be minutes away or never. So
   * the status is synthesized here and the real `close` — whenever it lands —
   * is swallowed by the `this.ws !== ws` guard, exactly as it is for a socket
   * a reconnect has already replaced. `clientInitiatedClose` is deliberately
   * NOT set: this is a dead connection being reported, not one we are done
   * with, and `onStatus` has to book the ordinary reconnect for it.
   */
  private giveUp(): void {
    const ws = this.ws
    if (!ws) return
    this.stopWatchdog()
    this.ws = null
    const reason = "the connection stopped answering"
    this.closeInfo = { clientInitiated: false, code: SILENT_CLOSE_CODE, reason }
    this.failInflight(new Error(reason))
    this.callbacks.onStatus("closed", this.closeInfo)
    try {
      ws.close()
    } catch {
      /* already unusable — the point was the status, which is out */
    }
  }

  // ---- plumbing ----

  private post(command: ThreadCommand): void {
    /* A socket exists from the moment `connect()` builds it, but it cannot be
       written to until the browser has finished the handshake — sending into a
       CONNECTING socket throws a DOMException the caller reads as a failure of
       the command rather than of the timing. Everything that can wait goes
       through `whenWritable` first; this is the floor under the few sends that
       cannot (an answer, the background flag). */
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
      throw new Error(notConnected(this.closeInfo))
    this.ws.send(JSON.stringify(command))
  }

  /**
   * Wait out a handshake that is still in flight.
   *
   * `this.ws` is assigned synchronously in `connect()`, so a caller can hold a
   * socket object several hundred milliseconds before it is writable — which
   * is the ordinary case for a thread whose route opened one while
   * `createSession` was opening another. Resolves on `open` (writable) and on
   * `close` (never will be; the caller's own null/readyState check then gives
   * the real message).
   */
  private whenWritable(): Promise<void> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.CONNECTING) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const settle = () => {
        ws.removeEventListener("open", settle)
        ws.removeEventListener("close", settle)
        resolve()
      }
      ws.addEventListener("open", settle)
      ws.addEventListener("close", settle)
    })
  }

  /**
   * Open the socket for a thread that was read without one.
   *
   * This is the ordinary way a socket comes up for anything that is not a
   * prompt: a read leaves the thread socketless on purpose, and a queue edit, a
   * mode change or a config pick is a user action that needs a peer.
   *
   * Never for a thread whose socket *died*, though — that is a connection that
   * failed rather than one nobody has asked for, and reopening it from under a
   * command would hide the failure instead of reporting it. `closeInfo.code` is
   * the tell: a thread that has never had a socket has never had a close
   * either. `ThreadConnection.ready()` is what brings one of those back, on a
   * send.
   */
  private async ensureSocket(): Promise<void> {
    if (this.ws) return
    if (!this.loaded || this.closeInfo.code !== undefined || this.clientInitiatedClose) return
    await this.connect({ cursor: this.cursor })
  }

  private async request(build: (id: number) => ThreadCommand): Promise<unknown> {
    // A queue parked on an archived thread is still the user's words, and
    // editing one is the one thing a reader does that needs a command.
    await this.ensureSocket().catch(() => {})
    // The socket may be one another path opened a moment ago and is still
    // shaking hands — a command is worth the wait, unlike the two fire-and-
    // forget posts above.
    await this.whenWritable()
    if (!this.ws) return Promise.reject(new Error(notConnected(this.closeInfo)))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.inflight.set(id, { resolve, reject })
      try {
        this.post(build(id))
      } catch (error) {
        this.inflight.delete(id)
        reject(error)
      }
    })
  }

  private failInflight(error: Error): void {
    for (const pending of this.inflight.values()) pending.reject(error)
    this.inflight.clear()
  }
}

function notConnected(info: ThreadCloseInfo): string {
  return info.reason ? `Not connected to the agent — ${info.reason}` : "Not connected to the agent"
}

/** A request in flight when the socket died rejects with something generic,
    while the close frame carries the server's own reason — unknown thread,
    thread deleted, agent exited. That reason is the answer. */
function explain(info: ThreadCloseInfo): string {
  if (!info.reason) return "the connection to this thread closed"
  return `${info.reason}${info.code ? ` (${info.code})` : ""}`
}

/* ── Frozen pages ──
   A backgrounded PWA on Android is not a disconnected one: the page stops
   running while its socket stays open, and the browser answers the server's
   WebSocket pings from its network stack, so the server sees a peer attached
   and suppresses the push — while the page that was meant to raise the
   notification instead is frozen and raises nothing. Neither end can see the
   gap on its own, so the page says so on the way into it.

   `freeze`/`resume` and not `visibilitychange`: a merely hidden page still runs
   its handlers and still shows its own notification (lib/notifications.ts), and
   claiming the background there would earn a second one from the server. These
   two fire exactly when the page stops and starts being able to act.

   The handler is registered once, at module scope, and *broadcasts*: a freeze
   is a property of the page, not of a thread, and what holds the live sockets
   is the connection registry (lib/thread/registry.ts), which subscribes here.
   It used to walk a `liveThreads` map exported from this file — a second
   registry of the same objects, which is exactly the parallel bookkeeping the
   registry exists to end. */
let pageFrozen = false
const frozenListeners = new Set<(frozen: boolean) => void>()

/** Told whenever the page freezes or resumes, and told the current answer at
    once — a subscriber that mounts inside a freeze must not miss it. */
export function subscribePageFrozen(fn: (frozen: boolean) => void): () => void {
  frozenListeners.add(fn)
  if (pageFrozen) fn(true)
  return () => frozenListeners.delete(fn)
}

/** Whether the page is frozen right now — for a socket opening mid-freeze,
    which has no event of its own to learn from. */
export function isPageFrozen(): boolean {
  return pageFrozen
}

function setPageFrozen(frozen: boolean): void {
  pageFrozen = frozen
  for (const fn of frozenListeners) fn(frozen)
}

if (typeof document !== "undefined") {
  // Not in TS's DocumentEventMap, hence the plain-string overload.
  document.addEventListener("freeze", () => setPageFrozen(true))
  document.addEventListener("resume", () => {
    setPageFrozen(false)
    /* Everything that arrived while the page was frozen is delivered now, in
       one go — including the `turn_ended` the server has already pushed a
       notification for. Announcing it again, on a device the user is by
       definition looking at, is the duplicate this window exists to prevent;
       the in-app toast still shows, which is the right amount of saying it. */
    void import("./notifications").then(({ suppressSystemNotifications }) =>
      suppressSystemNotifications()
    )
  })
}
