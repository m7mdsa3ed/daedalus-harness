import type * as acp from "@agentclientprotocol/sdk"
import type { HistoryLost, ThreadCommand, ThreadEvent, WireError } from "@daedalus/protocol"
import { wsUrl, type ServerSettings } from "./settings"

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
      the reducer takes user chunks only then. */
  onUpdate: (update: acp.SessionUpdate, historyReplay: boolean) => void
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
  onTurnStarted: (text: string, catchingUp: boolean) => void
  onTurnEnded: (
    usage: acp.Usage | null,
    error: WireError | undefined,
    promptText: string | undefined,
    catchingUp: boolean
  ) => void
  /** The replay is about to start, from this position. `from` is 0 for every
      connect the client makes today, which is what makes it a full rebuild.
      `historyLost` is set when the agent refused to reload this thread's
      conversation — the replay that follows is an empty transcript, and the
      only difference between that and a brand new thread is this field. */
  onAttached: (from: number, historyLost?: HistoryLost) => void
  /** The replay is over; everything after this is live. `promptActive` is read
      server-side in the same tick as the log it follows, so it cannot pair a
      stale turn state with a fresh replay window. */
  onCaughtUp: (cursor: number, promptActive: boolean) => void
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
      hours ago. */
  private catchingUp = false

  constructor(serverSessionId: string, settings: ServerSettings, callbacks: ThreadCallbacks) {
    this.serverSessionId = serverSessionId
    this.settings = settings
    this.callbacks = callbacks
  }

  get connected(): boolean {
    return this.ws !== null
  }

  /** Resolves once the replay is done and the thread is live. */
  connect(opts: { cursor?: number } = {}): Promise<void> {
    this.callbacks.onStatus("connecting")
    this.clientInitiatedClose = false
    this.closeInfo = { clientInitiated: false }
    const ws = new WebSocket(wsUrl(this.settings, this.serverSessionId, opts.cursor ?? 0))
    this.ws = ws

    return new Promise<void>((resolve, reject) => {
      let settled = false
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
      case "attached":
        this.catchingUp = true
        this.callbacks.onAttached(event.from, event.historyLost)
        return
      case "caught_up":
        this.catchingUp = false
        this.callbacks.onCaughtUp(event.cursor, event.promptActive)
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
        this.callbacks.onUpdate(event.update, event.historyReplay)
        return
      case "session_config":
        this.callbacks.onSessionConfig(event.modes, event.modeId, event.configOptions)
        return
      case "turn_started":
        this.callbacks.onTurnStarted(event.text, this.catchingUp)
        return
      case "turn_ended":
        this.callbacks.onTurnEnded(event.usage, event.error, event.promptText, this.catchingUp)
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

  // ---- commands ----

  /**
   * Send a prompt. Resolves once the server has dispatched it, not when the
   * turn ends — the turn's outcome (and its failure) reaches every device on
   * the thread as `turn_ended`, so waiting here would report it twice.
   */
  async prompt(text: string): Promise<void> {
    await this.request((id) => ({ id, cmd: "prompt", text }))
  }

  async cancel(): Promise<void> {
    await this.request((id) => ({ id, cmd: "cancel" }))
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
