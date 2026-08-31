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
import { wsUrl, type ServerSettings } from "./settings"

/**
 * How much of a thread's tail to ask for on a fresh attach, in **steps** (turns).
 *
 * Generous on purpose: the point is not to make every thread lazy, it is to
 * stop a months-old archive from costing its whole history to open at the end.
 * Below this the transcript arrives whole and `earlier` is 0, so nothing about
 * the ordinary thread changes — no button, no paging, no retained raw events.
 *
 * Steps are only half the budget, and the half the *server* keeps: it also cuts
 * on `REPLAY_WINDOW_BYTES`, whichever binds first, because a step is a turn and
 * a turn is not a size. This number can afford to be generous precisely because
 * that one is not.
 */
export const REPLAY_WINDOW_STEPS = 60

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
    wants a reconnect) and unknown to `closedState`, whose default — "lost the
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
        // A later connect() owns the status now; reporting this one's close
        // would mark a live connection dead and book a phantom reconnect.
        if (this.ws !== ws) return
        this.ws = null
        this.stopWatchdog()
        this.failInflight(new Error(this.closeInfo.reason || "the connection to the thread closed"))
        this.callbacks.onStatus("closed", this.closeInfo)
        // A handshake that never finished: the close reason is the server's own
        // account (unknown thread, no running agent) and is the real answer.
        done(new Error(explain(this.closeInfo)))
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
        const earlier = event.earlier ?? 0
        this.windowFrom = event.from
        this.earlier = earlier
        // How much replay is coming, in events. Zero when the server said
        // nothing (an older one, which never had the field) — see onReplayProgress.
        this.replayTotal = Math.max(0, (event.to ?? 0) - event.from)
        this.replayed = 0
        // Only worth carrying the events when there is something to fold them
        // in front of; see `raw`.
        if (!resumed) this.raw = earlier > 0 ? [] : null
        this.callbacks.onAttached(
          {
            from: event.from,
            to: event.to ?? event.from,
            resumed,
            earlier,
            archived: event.archived ?? false,
          },
          event.historyLost
        )
        return
      }
      case "caught_up":
        this.catchingUp = false
        this.callbacks.onCaughtUp(event.cursor, event.promptActive, event.queue ?? [])
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

  private async fetchEarlier(): Promise<void> {
    const page = (await this.request((id) => ({
      id,
      cmd: "load_earlier",
      before: this.windowFrom,
    }))) as EarlierPage
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
    if (!this.ws) throw new Error(notConnected(this.closeInfo))
    this.ws.send(JSON.stringify(command))
  }

  private request(build: (id: number) => ThreadCommand): Promise<unknown> {
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

/** Live threads keyed by server session id — outlives React renders. */
export const liveThreads = new Map<string, ThreadSocket>()
