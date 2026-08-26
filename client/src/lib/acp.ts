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
  onStatus: (status: "connecting" | "connected" | "closed", closeInfo?: ThreadCloseInfo) => void
  onTurnActive: (active: boolean) => void
  /** Modes + config options from the session/new response (fresh sessions). */
  onSessionConfig?: (
    modes: acp.SessionModeState | null,
    configOptions: acp.SessionConfigOption[]
  ) => void
  /** Time-to-first-update for a turn, ms. */
  onTtft?: (ms: number) => void
  /** Server-synthesized turn end (reaches clients that didn't send the prompt). */
  onTurnEnded?: (usage: acp.Usage | null) => void
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
  async connect(opts: {
    fresh: boolean
    project: Project
    /** The project's MCP servers, already resolved from the library. */
    mcpServers?: McpServerDef[]
    cursor?: number
    acpSessionId?: string
    /** Restore the conversation via ACP session/load (after a respawn). */
    load?: boolean
  }): Promise<void> {
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
      // Bridge extension: the server synthesizes this when a prompt turn ends,
      // so a client that reattached mid-turn still learns the turn is over.
      .onNotification(
        "_daedalus/turn_ended",
        (params) => params as { usage: acp.Usage | null },
        (ctx) => this.callbacks.onTurnEnded?.(ctx.params.usage)
      )
      .connect(stream)
    this.connection.closed.then(() => {
      this.connection = null
      this.callbacks.onStatus("closed", this.closeInfo)
    })

    try {
      await this.connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
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
    this.callbacks.onStatus("connected")
  }

  async prompt(text: string): Promise<acp.PromptResponse | undefined> {
    if (!this.connection || !this.acpSessionId) throw new Error("not connected")
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
    if (!this.connection || !this.acpSessionId) throw new Error("not connected")
    await this.connection.agent.request(acp.methods.agent.session.setMode, {
      sessionId: this.acpSessionId,
      modeId,
    })
  }

  /** Set a config option (model, thinking level, …); returns the updated set. */
  async setConfigOption(configId: string, value: string | boolean) {
    if (!this.connection || !this.acpSessionId) throw new Error("not connected")
    const response = await this.connection.agent.request(
      acp.methods.agent.session.setConfigOption,
      { sessionId: this.acpSessionId, configId, value } as acp.SetSessionConfigOptionRequest
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
    this.connection?.close()
    this.connection = null
  }
}

/** Live threads keyed by server session id — outlives React renders. */
export const liveThreads = new Map<string, AcpThread>()
