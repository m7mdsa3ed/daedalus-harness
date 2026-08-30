import type * as acp from "@agentclientprotocol/sdk"
import type {
  EarlierPage,
  HistoryLost,
  JournaledEvent,
  PromptReply,
  QueuedMessage,
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
 */
export const REPLAY_WINDOW_STEPS = 60


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
  /** Time-to-first-update for a turn, ms, measured server-side. */
  onTtft: (ms: number) => void
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
    continued: boolean
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
    info: { from: number; resumed: boolean; earlier: number; archived: boolean },
    historyLost?: HistoryLost
  ) => void
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
  /** The `loadEarlier` in flight, if any — see the re-entrancy note there. */
  private earlierInFlight: Promise<void> | null = null

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
        // `caught_up` is what "connected" means: before it, the socket is
        // replaying and a caller that acted on it would prompt into history.
        if (parsed.ev === "caught_up") {
          this.callbacks.onStatus("connected")
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
        // Only worth carrying the events when there is something to fold them
        // in front of; see `raw`.
        if (!resumed) this.raw = earlier > 0 ? [] : null
        this.callbacks.onAttached(
          { from: event.from, resumed, earlier, archived: event.archived ?? false },
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
      case "ttft":
        this.callbacks.onTtft(event.ms)
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
          event.continued ?? false
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
    // The close event may not fire before the caller checks, so stamp the flag
    // here — otherwise onStatus reads a close we asked for as one we didn't and
    // schedules a phantom reconnect.
    this.closeInfo = { ...this.closeInfo, clientInitiated: true }
    const ws = this.ws
    this.ws = null
    this.failInflight(new Error("the thread was closed"))
    ws?.close()
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
