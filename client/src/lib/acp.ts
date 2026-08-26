import * as acp from "@agentclientprotocol/sdk"
import {
  createWebSocketStream,
} from "@agentclientprotocol/sdk/experimental/ws-client"
import { wsUrl, type McpServerDef, type Project, type ServerSettings } from "./settings"

export interface ThreadCloseInfo {
  clientInitiated: boolean
  code?: number
  reason?: string
}

export interface ThreadCallbacks {
  /** `replaying` is true while a session/load history replay is streaming. */
  onUpdate: (notification: acp.SessionNotification, replaying: boolean) => void
  onPermission: (
    request: acp.RequestPermissionRequest
  ) => Promise<acp.RequestPermissionResponse>
  /** The agent needs structured input — an AskUserQuestion form, an MCP
      elicitation, a URL flow. Resolves when the user answers or dismisses. */
  onElicitation: (
    request: acp.CreateElicitationRequest
  ) => Promise<acp.CreateElicitationResponse>
  /** A URL-mode elicitation finished out of band — the form can settle. */
  onElicitationComplete?: (elicitationId: string) => void
  onStatus: (status: "connecting" | "connected" | "closed", closeInfo?: ThreadCloseInfo) => void
  onTurnActive: (active: boolean) => void
  /** Modes + config options from the session/new response (fresh sessions). */
  onSessionConfig?: (
    modes: acp.SessionModeState | null,
    configOptions: acp.SessionConfigOption[]
  ) => void
  /** Time-to-first-update for a turn, ms. */
  onTtft?: (ms: number) => void
  /** Server-synthesized turn end (reaches clients that didn't send the prompt).
      `error` is the JSON-RPC error the prompt failed with, when it failed — the
      only way a peer that did not send the prompt learns the turn went wrong. */
  onTurnEnded?: (usage: acp.Usage | null, error?: unknown) => void
  /** Another device attached to this same thread sent a prompt. */
  onPeerPrompt?: (text: string) => void
  /** Another device answered the permission request for this tool call. */
  onPeerAnswered?: (toolCallId: string | undefined) => void
  /** Another device changed the session's mode or config options. */
  onPeerSettings?: (modeId: string | undefined, configOptions: acp.SessionConfigOption[] | undefined) => void
  /** A background task this thread's agent launched appended a journal line —
      the server tails the file (see /api/tasks/watch) and streams the rest. */
  onTaskEvent?: (transcriptDir: string, event: Record<string, unknown>) => void
}

export interface ConnectOptions {
  /** true runs session/new; on reattach the agent already holds the session. */
  fresh: boolean
  project: Project
  /** The project's MCP servers, already resolved from the library. */
  mcpServers?: McpServerDef[]
  cursor?: number
  acpSessionId?: string
  /** Restore the conversation via ACP session/load (after a respawn). */
  load?: boolean
}

/**
 * One live ACP connection to a server-side agent process. The browser is the
 * real ACP Client: the server only pipes frames between this WebSocket and the
 * agent's stdio.
 */
export class AcpThread {
  acpSessionId: string | null = null
  promptActive = false
  private replaying = false
  private turnStartedAt: number | null = null
  readonly serverSessionId: string
  private settings: ServerSettings
  private callbacks: ThreadCallbacks
  private connection: acp.ClientConnection | null = null
  private clientInitiatedClose = false
  private closeInfo: ThreadCloseInfo = { clientInitiated: false }

  constructor(serverSessionId: string, settings: ServerSettings, callbacks: ThreadCallbacks) {
    this.serverSessionId = serverSessionId
    this.settings = settings
    this.callbacks = callbacks
  }

  get connected(): boolean {
    return this.connection !== null
  }

  /**
   * fresh=true runs session/new; on reattach the agent process already holds
   * the session, so we only re-handshake and reuse the known ACP session id.
   */
  async connect(opts: ConnectOptions): Promise<void> {
    this.callbacks.onStatus("connecting")
    this.clientInitiatedClose = false
    this.closeInfo = { clientInitiated: false }
    const thread = this
    class TrackingWebSocket extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        this.addEventListener("close", (event) => {
          thread.closeInfo = {
            clientInitiated: thread.clientInitiatedClose,
            code: event.code,
            reason: event.reason,
          }
        })
      }
    }
    const stream = createWebSocketStream(wsUrl(this.settings, this.serverSessionId, opts.cursor ?? 0), {
      WebSocket: TrackingWebSocket,
    })
    this.connection = acp
      .client({ name: "daedalus" })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        if (this.turnStartedAt !== null) {
          this.callbacks.onTtft?.(performance.now() - this.turnStartedAt)
          this.turnStartedAt = null
        }
        this.callbacks.onUpdate(ctx.params, this.replaying)
      })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this.callbacks.onPermission(ctx.params)
      )
      .onRequest(acp.methods.client.elicitation.create, (ctx) =>
        this.callbacks.onElicitation(ctx.params)
      )
      .onNotification(acp.methods.client.elicitation.complete, (ctx) =>
        this.callbacks.onElicitationComplete?.(ctx.params.elicitationId)
      )
      // Bridge extension: the server synthesizes this when a prompt turn ends,
      // so a client that reattached mid-turn still learns the turn is over.
      .onNotification(
        "_daedalus/turn_ended",
        (params) => params as { usage: acp.Usage | null; error?: unknown },
        (ctx) => this.callbacks.onTurnEnded?.(ctx.params.usage, ctx.params.error)
      )
      // Peer sync: several devices can attach to one thread, and these two
      // frames carry what one peer does that the others would otherwise miss —
      // a prompt (which travels to the agent, not to them) and a permission
      // answer (which closes a dialog they are also showing).
      .onNotification(
        "_daedalus/peer_prompt",
        (params) => params as { text: string },
        (ctx) => this.callbacks.onPeerPrompt?.(ctx.params.text)
      )
      .onNotification(
        "_daedalus/request_answered",
        (params) => params as { toolCallId?: string },
        (ctx) => this.callbacks.onPeerAnswered?.(ctx.params.toolCallId)
      )
      .onNotification(
        "_daedalus/peer_settings",
        (params) => params as { modeId?: string; configOptions?: acp.SessionConfigOption[] },
        (ctx) => this.callbacks.onPeerSettings?.(ctx.params.modeId, ctx.params.configOptions)
      )
      // The server's tail of a background task's journal (see /api/tasks/watch):
      // one parsed journal line per notification, keyed by the transcript dir.
      .onNotification(
        "_daedalus/task_event",
        (params) => params as { transcriptDir: string; event: Record<string, unknown> },
        (ctx) => this.callbacks.onTaskEvent?.(ctx.params.transcriptDir, ctx.params.event)
      )
      .connect(stream)
    const connection = this.connection
    connection.closed.then(() => {
      // Superseded by a later connect(): that generation owns the status now,
      // and reporting this one's close would mark a live connection dead. A
      // plain close() leaves it null and still reports — the UI has to learn
      // the thread went down.
      if (this.connection && this.connection !== connection) return
      this.connection = null
      this.callbacks.onStatus("closed", this.closeInfo)
    })

    try {
      await this.handshake(opts)
    } catch (error) {
      // A half-open thread is worse than no thread: the composer would look
      // live and every prompt would fail. Drop it and let the caller report.
      this.close()
      throw this.explain(error)
    }
    this.callbacks.onStatus("connected")
  }

  /** Why the handshake really failed. A request that was in flight when the
      socket died rejects with something generic ("connection closed"), while
      the close frame carries the server's own reason — unknown session, session
      deleted, agent exited. That reason is the answer, so put it in front. */
  private explain(error: unknown): unknown {
    const { code, reason } = this.closeInfo
    if (!reason || this.connection) return error
    const explained = new Error(`${reason}${code ? ` (${code})` : ""}`)
    explained.cause = error
    return explained
  }

  private async handshake(opts: ConnectOptions): Promise<void> {
    if (!this.connection) throw new Error("connection closed before the handshake started")
    try {
      await this.connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          // The config menu already renders boolean options; without advertising
          // this, agents are within spec to withhold `type: "boolean"` entries
          // entirely — codex hides its fast-mode toggle on exactly this check.
          session: { configOptions: { boolean: {} } },
          // Same bargain for plans. ACP has two plan channels: the original
          // `plan` notification, and `plan_update`/`plan_removed`, which carry
          // markdown and file-backed plans as well as structured entries. An
          // agent only sends the second pair if the client says it can take
          // them, and `{}` means both — so without this a codex plan arrives as
          // nothing at all rather than as a plan we render badly.
          plan: {},
          // Same bargain a third time, and the highest-stakes one: without
          // form elicitation claude-agent-acp puts AskUserQuestion on the
          // session's disallowedTools — the model can't ask at all, not even
          // badly. Advertising it turns the tool back on and routes it (plus
          // MCP elicitations and codex's question bridge) to onElicitation.
          elicitation: { form: {}, url: {} },
        },
      })
    } catch (error) {
      // On reattach some agents reject a second initialize; the session still works.
      if (opts.fresh) throw error
      console.warn("re-initialize rejected, continuing", error)
    }

    // ACP's stdio MCP variant carries no `type` discriminator — strip ours.
    const mcpServers: acp.McpServer[] = (opts.mcpServers ?? []).map((s) =>
      s.type === "http"
        ? { type: "http", name: s.name, url: s.url, headers: s.headers }
        : { name: s.name, command: s.command, args: s.args, env: s.env }
    )
    if (opts.fresh) {
      const response = await this.connection.agent.request(acp.methods.agent.session.new, {
        cwd: opts.project.cwd,
        mcpServers,
      })
      this.acpSessionId = response.sessionId
      this.callbacks.onSessionConfig?.(response.modes ?? null, response.configOptions ?? [])
    } else if (opts.load && opts.acpSessionId) {
      // Fresh process, existing conversation: load streams the whole history
      // back as session/update notifications before responding.
      this.acpSessionId = opts.acpSessionId
      this.replaying = true
      try {
        const response = await this.connection.agent.request(acp.methods.agent.session.load, {
          sessionId: opts.acpSessionId,
          cwd: opts.project.cwd,
          mcpServers,
        })
        this.callbacks.onSessionConfig?.(response?.modes ?? null, response?.configOptions ?? [])
      } catch (error) {
        // Agent can't load sessions — continue with a fresh one (empty context).
        console.warn("session/load failed, starting fresh", error)
        const response = await this.connection.agent.request(acp.methods.agent.session.new, {
          cwd: opts.project.cwd,
          mcpServers,
        })
        this.acpSessionId = response.sessionId
        this.callbacks.onSessionConfig?.(response.modes ?? null, response.configOptions ?? [])
      } finally {
        this.replaying = false
      }
    } else {
      this.acpSessionId = opts.acpSessionId ?? null
    }
  }

  async prompt(text: string): Promise<acp.PromptResponse | undefined> {
    if (!this.connection) {
      throw new Error(
        this.closeInfo.reason
          ? `Not connected to the agent — ${this.closeInfo.reason}`
          : "Not connected to the agent"
      )
    }
    if (!this.acpSessionId) throw new Error("The agent never opened a session on this thread")
    const send = () =>
      this.connection!.agent.request(acp.methods.agent.session.prompt, {
        sessionId: this.acpSessionId!,
        prompt: [{ type: "text", text }],
      })
    if (!this.promptActive) {
      this.promptActive = true
      this.turnStartedAt = performance.now()
      this.callbacks.onTurnActive(true)
      try {
        return await send()
      } finally {
        this.promptActive = false
        this.turnStartedAt = null
        this.callbacks.onTurnActive(false)
      }
    }
    // Steering: a prompt while a turn is running. Agents that support prompt
    // queueing accept it; the rest reject it and the caller sees the error —
    // we never cancel the running turn on the user's behalf.
    return await send()
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.connection || !this.acpSessionId) throw new Error("Not connected to the agent")
    await this.connection.agent.request(acp.methods.agent.session.setMode, {
      sessionId: this.acpSessionId,
      modeId,
    })
  }

  /** Set a config option (model, thinking level, …); returns the updated set. */
  async setConfigOption(configId: string, value: string | boolean) {
    if (!this.connection || !this.acpSessionId) throw new Error("Not connected to the agent")
    const response = await this.connection.agent.request(
      acp.methods.agent.session.setConfigOption,
      {
        sessionId: this.acpSessionId,
        configId,
        // The request is a discriminated union and only the boolean variant
        // carries its tag: a bare string value IS the default variant, while a
        // bare boolean matches neither and agents reject it.
        ...(typeof value === "boolean" ? { type: "boolean" as const, value } : { value }),
      } as acp.SetSessionConfigOptionRequest
    )
    return response.configOptions
  }

  async cancel(): Promise<void> {
    if (!this.connection || !this.acpSessionId) return
    await this.connection.agent.notify(acp.methods.agent.session.cancel, {
      sessionId: this.acpSessionId,
    })
  }

  close(): void {
    this.clientInitiatedClose = true
    // The SDK tears the stream down synchronously inside close(), so `closed`
    // resolves before the socket's own close event can stamp closeInfo. Set the
    // flag here — keeping any code/reason already captured, which is what
    // explain() reads — or onStatus sees the connect() default, reads it as a
    // close we did not ask for, and schedules a phantom reconnect.
    this.closeInfo = { ...this.closeInfo, clientInitiated: true }
    this.connection?.close()
    this.connection = null
  }
}

/** Live threads keyed by server session id — outlives React renders. */
export const liveThreads = new Map<string, AcpThread>()
