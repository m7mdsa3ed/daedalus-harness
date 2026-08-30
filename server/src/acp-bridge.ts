import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { performance } from "node:perf_hooks";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { materializeProject } from "./materialize.js";
import type { Profile } from "./profiles.js";
import type { Project } from "./projects.js";
import { getAgent, resolveSpawn } from "./registry.js";
import type { HistoryLost, HistoryStrategy, RestoreState, ThreadEvent, WireError } from "./protocol.js";
import type { Peer } from "./sessions.js";

/**
 * The ACP client, server-side.
 *
 * This is the half of the harness that speaks the protocol. One bridge per agent
 * process: it runs the handshake, owns the session, and turns everything the
 * agent says into the Daedalus events in protocol.ts. Nothing downstream —
 * neither the SessionManager nor the browser — sees a JSON-RPC frame.
 *
 * It used to be in the browser (`client/src/lib/acp.ts`), which forced the
 * server to arbitrate a protocol it did not speak: rewriting request ids so N
 * sockets could impersonate one ACP client. With one client here, N sockets are
 * just subscribers.
 */

/** Long enough for a cold agent to boot and answer `session/new`; short enough
    that a wedged one does not hold an HTTP request open forever. Same ceiling
    the probe uses, for the same reason. */
export const HANDSHAKE_TIMEOUT_MS = 25_000;

/** The session exists only in the agent's memory, so there is nothing to fork
    from yet. An ordinary state — the first turn of every thread is in it — not
    a failure, which is why it is a class and not a bare Error. */
export class SessionNotForkableError extends Error {
  constructor() {
    super("the agent has not committed this session to disk yet");
    this.name = "SessionNotForkableError";
  }
}

/**
 * Start an agent process. Both callers — a thread's bridge and the throwaway
 * one the options probe spawns — build the same child, from the same three
 * inputs, so this is the one place that knows how.
 */
export function spawnAgent(
  profile: Profile,
  project: Project,
  model?: string,
  effort?: string,
): ChildProcessWithoutNullStreams {
  const agent = getAgent(profile.agentId);
  if (!agent) throw new Error(`unknown agent: ${profile.agentId}`);
  materializeProject(project);
  const { command, args, env, cwd } = resolveSpawn(agent, profile, project, model, effort);
  return spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
}

/** The ndJSON stream over a spawned agent's stdio. From here on the SDK owns
    stdout — a stray 'data' listener anywhere else silently steals its bytes. */
export function agentStream(proc: ChildProcessWithoutNullStreams): acp.Stream {
  return acp.ndJsonStream(
    Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>,
  );
}

/** An agent request the agent is currently blocked on. Held here rather than in
    the journal because it is tied to the process's life, not the thread's: when
    the process goes, so does the question. A peer attaching later is sent
    whatever is still in this map, which is why replay needs no "skip the ones
    somebody already answered" filter — an answered request is simply gone. */
interface PendingRequest {
  requestId: string;
  kind: "permission" | "elicitation";
  /** Which tool call the question belongs to. The permission nests it under
      `toolCall`; the elicitation carries it flat. Either way it is what tells
      the other peers WHICH card the first answer just closed. */
  toolCallId?: string;
  /** The request itself, so a peer that attaches while the agent is still
      blocked can be handed the question rather than a dead thread. */
  payload: acp.RequestPermissionRequest | acp.CreateElicitationRequest;
  settle: (response: never) => void;
}

export interface BridgeHost {
  /** Journal (when the event is journaled) and fan out to every peer but
      `except` — which is how a peer avoids being told about its own action. */
  emit(event: ThreadEvent, except?: Peer): void;
  peerCount(): number;
  /** Mark where this turn's stderr starts, so a failure is explained by its own
      output and not the previous turn's. */
  markTurnStderr(): void;
  /** Splice the agent's stderr into an error on its way out. "Internal error"
      is a code, not an explanation, and the explanation was only on stderr. */
  enrichError(error: WireError): WireError;
  /** Push hooks. Fired only when nobody is attached to see the thread. */
  onPermissionRequest(): void;
  onElicitationRequest(): void;
  onTurnEnd(error?: unknown): void;
  onLogicalTurnEnd(turnId: string): void;
  /** The agent accepted a `session/new` or a `session/load`: this is the
      session the running process is on. `proven` says which — a load that
      answered is the strongest evidence an id can have (the agent found the
      transcript and read it back), while a fresh `session/new` id is one the
      agent holds in memory and may never flush. */
  onAcpSessionId(acpSessionId: string, proven: boolean): void;
  /** A turn has committed to the current session, so the agent has written it
      to its own store and a later `session/load` can find it.
      Until this fires the id is a promise, not a record: agents create the
      session in memory and flush their transcript lazily, so a process killed
      before its first turn (a server restart, a crash) leaves an id nothing can
      ever load. Such an id is still written down — see `acpSessionProvisional`;
      what this callback buys is the right to keep it against the next one. */
  onSessionDurable(): void;
  /** `session/load` was refused. The thread runs on a fresh session from here,
      but the id it failed on stays the thread's record of itself. */
  onHistoryLost(lost: HistoryLost): void;
  onSpawnStateChange(next: { model?: string; effort?: string }): void;
}

export interface BridgeOptions {
  cwd: string;
  mcpServers: acp.McpServer[];
  /** Restore an existing conversation instead of starting one. */
  load?: { acpSessionId: string };
  /** Settings a respawn has to put back once the new session exists. */
  restore?: RestoreState;
  /** Settings chosen on a draft, against the option set the agent last
      advertised. Applied right after `session/new`. */
  configChoices?: Record<string, string | boolean>;
  /** The model and effort of a thread whose profile carries no catalog, to be
      put back over ACP rather than through the process env — see
      `applyAgentOwned`. Empty for a profile that owns the catalog: there these
      two ARE the env, and `resolveSpawn` has already placed them. */
  agentOwned?: { model?: string; effort?: string };
  /** The web-search MCP server is replacing claude-code's built-in
      WebSearch/WebFetch. Only that agent declares those as server tools, so
      disallow them or the model keeps calling the originals instead of ours. */
  websearchViaMcp?: boolean;
}

export class AcpBridge {
  /** Resolves when the session exists and its settings have been applied. */
  readonly ready: Promise<void>;
  acpSessionId: string | null = null;
  /** Whether the agent has written this session down yet — a `session/load`
      answered it, or a turn has settled on it. An id it has only minted is not
      one it can resume, and forking is a resume (see `forkCheckpoint`). */
  sessionDurable = false;
  modes: acp.SessionModeState | null = null;
  configOptions: acp.SessionConfigOption[] = [];
  agentCapabilities: acp.AgentCapabilities = {};
  readonly pending = new Map<string, PendingRequest>();

  private readonly host: BridgeHost;
  private readonly connection: acp.ClientConnection;
  /** Prompts the agent has not answered yet. A turn is over when this hits
      zero — NOT when the first prompt returns, or steering (a second prompt
      sent mid-turn) would clear the indicator while the agent is still
      working. */
  private inflight = 0;
  private turnStartedAt: number | null = null;
  private ttftSent = false;
  private nextRequestId = 1;
  /** True while a `session/load` is streaming the conversation back, so the
      updates it produces are journaled as history rather than as news. */
  private historyReplay = false;
  private closed = false;
  /** Prompt texts whose turns are waiting on close() for a reason worth
      reporting — see onPromptRejected. */
  private readonly held: string[] = [];
  private currentTurnId: string | null = null;
  private currentTurnPrompt: string | null = null;

  constructor(host: BridgeHost, proc: ChildProcessWithoutNullStreams, opts: BridgeOptions) {
    this.host = host;
    const stream = agentStream(proc);
    this.connection = acp
      .client({ name: "daedalus" })
      .onNotification(acp.methods.client.session.update, (ctx) => this.onUpdate(ctx.params))
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this.park<acp.RequestPermissionResponse>(
          "permission",
          ctx.params,
          ctx.params.toolCall?.toolCallId,
        ),
      )
      .onRequest(acp.methods.client.elicitation.create, (ctx) =>
        this.park<acp.CreateElicitationResponse>(
          "elicitation",
          ctx.params,
          (ctx.params as { toolCallId?: string }).toolCallId,
        ),
      )
      .onNotification(acp.methods.client.elicitation.complete, (ctx) =>
        this.onElicitationComplete(ctx.params.elicitationId),
      )
      .connect(stream);
    this.ready = this.handshake(opts);
  }

  get promptActive(): boolean {
    return this.inflight > 0;
  }

  get historyStrategy(): HistoryStrategy {
    return this.agentCapabilities.sessionCapabilities?.fork != null
      ? "fork-checkpoint"
      : "unsupported";
  }

  // ---- handshake ----

  private async handshake(opts: BridgeOptions): Promise<void> {
    const deadline = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("the agent did not finish the handshake in time")),
        HANDSHAKE_TIMEOUT_MS,
      ).unref();
    });
    await Promise.race([this.runHandshake(opts), deadline]);
  }

  private async runHandshake(opts: BridgeOptions): Promise<void> {
    const initialized = await this.connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        // The agent runs beside us with its own filesystem; there is nothing
        // for this end to serve.
        fs: { readTextFile: false, writeTextFile: false },
        // The config menu already renders boolean options; without advertising
        // this, agents are within spec to withhold `type: "boolean"` entries
        // entirely — codex hides its fast-mode toggle on exactly this check.
        // Same bargain, and the one whose absence is invisible: an agent that
        // compacts its context is *required* to keep `compaction_update` and
        // `compaction_summary_chunk` to itself unless the client claims this,
        // so without it a long thread silently loses its history mid-turn and
        // the transcript shows nothing at all. `{}` is the whole contract.
        session: { compaction: {}, configOptions: { boolean: {} } },
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
        // MCP elicitations and codex's question bridge) to `park`.
        elicitation: { form: {}, url: {} },
      },
    });
    this.agentCapabilities = initialized.agentCapabilities ?? {};

    if (opts.load) {
      await this.loadSession(opts);
    } else {
      await this.newSession(opts);
    }

    // Only now is there something to apply settings to.
    if (opts.restore) await this.applyRestore(opts.restore);
    if (opts.agentOwned) await this.applyAgentOwned(opts.agentOwned);
    if (opts.configChoices) await this.applyChoices(opts.configChoices);
  }

  /**
   * The ACP `_meta` block carrying claude-code bridge options that this client
   * does not model itself. `_meta` is passed through intact (it is the
   * extensibility escape hatch), so dropping `disallowedTools` here is the only
   * way to switch the built-in web tools off. Empty for non-claude-code agents
   * and for sessions without the web-search server.
   */
  private claudeMeta(opts: BridgeOptions): Record<string, unknown> {
    if (!opts.websearchViaMcp) return {};
    return { claudeCode: { options: { disallowedTools: ["WebSearch", "WebFetch"] } } };
  }

  private async newSession(opts: BridgeOptions): Promise<void> {
    const response = await this.connection.agent.request(acp.methods.agent.session.new, {
      cwd: opts.cwd,
      mcpServers: opts.mcpServers,
      _meta: this.claudeMeta(opts),
    });
    this.adoptSession(response.sessionId, response.modes ?? null, response.configOptions ?? [], false);
  }

  /**
   * Branch the conversation so the turn about to run can be thrown away later.
   *
   * A fork is a *resume* on the agent's side — it mints a child id and replays
   * the parent's transcript into it — so it can only branch from a session the
   * agent has written down. A session id straight out of `session/new` is not
   * that: claude-agent-acp flushes the rollout lazily, so forking before the
   * first turn settles fails with ResourceNotFound naming the *child* it had
   * just minted (the parent is what was missing, but the error reports the id
   * it was creating), which read like the agent losing a session it had
   * invented one line earlier. Hence `sessionDurable`: the first turn of a
   * thread runs unforked, which is also what it means — there is no state
   * before it to revert to.
   *
   * The child is adopted *provisionally* for the same reason it could not be
   * forked from: nothing has settled on it yet. Until a turn does, the id worth
   * keeping on the record is the parent's, which still has the conversation.
   */
  async forkCheckpoint(cwd: string, mcpServers: acp.McpServer[]): Promise<string> {
    if (this.historyStrategy !== "fork-checkpoint") {
      throw new Error("the agent does not advertise session/fork");
    }
    if (!this.sessionDurable) throw new SessionNotForkableError();
    const response = await this.connection.agent.request(acp.methods.agent.session.fork, {
      sessionId: this.requireSession(),
      cwd,
      mcpServers,
    });
    this.adoptSession(
      response.sessionId,
      response.modes ?? this.modes,
      response.configOptions ?? this.configOptions,
      false,
    );
    return response.sessionId;
  }

  /**
   * Fresh process, existing conversation. `session/load` streams the whole
   * history back as `session/update` notifications before it responds — which
   * is why `historyReplay` is set around it: those updates are the transcript
   * being restated, not new activity, and the reducer on the other end needs to
   * know that to accept the user messages among them.
   *
   * The failure path is the delicate one. Falling back to a fresh session keeps
   * the thread usable, but the fallback's id must NOT replace the id that was
   * loaded: that id is the only pointer to a transcript which, more often than
   * not, is still sitting in the agent's store — a load can fail because the
   * agent was restarted mid-write, because it is a different agent, or because
   * it had not flushed the rollout yet. Overwriting it turned one transient
   * refusal into a thread that could never find its history again, and worse,
   * into a *chain*: each replacement id was itself unloadable, so the next
   * revive failed and replaced it too. The old id therefore stays on the record
   * until a turn proves the new session durable (see `onSessionDurable`), and
   * the refusal is reported instead of swallowed. The one id the fallback may
   * take over is a *provisional* one — an id no turn ever committed to, which
   * by definition has no transcript behind it to strand.
   */
  private async loadSession(opts: BridgeOptions): Promise<void> {
    const acpSessionId = opts.load!.acpSessionId;
    this.historyReplay = true;
    try {
      const response = await this.connection.agent.request(acp.methods.agent.session.load, {
        sessionId: acpSessionId,
        cwd: opts.cwd,
        mcpServers: opts.mcpServers,
        _meta: this.claudeMeta(opts),
      });
      this.adoptSession(acpSessionId, response?.modes ?? null, response?.configOptions ?? [], true);
    } catch (error) {
      // A deliberate close (respawn, retire) is not a load failure: the bridge
      // was shut on purpose, the fallback would be a `session/new` fired at a
      // dead connection, and the warn would make every normal respawn read
      // like a thread that lost its history. Only a real failure starts fresh.
      if (this.closed) throw error;
      // Agent can't load this session — continue with a fresh one (empty
      // context), and say so: a thread that quietly forgot its conversation
      // looks exactly like a thread that never had one.
      console.warn(`session/load failed for ${acpSessionId}, starting fresh`, error);
      this.host.onHistoryLost({ acpSessionId, error: this.host.enrichError(toWireError(error)) });
      await this.newSession(opts);
    } finally {
      this.historyReplay = false;
    }
  }

  private adoptSession(
    acpSessionId: string,
    modes: acp.SessionModeState | null,
    configOptions: acp.SessionConfigOption[],
    proven: boolean,
  ): void {
    this.acpSessionId = acpSessionId;
    this.sessionDurable = proven;
    this.modes = modes;
    this.configOptions = configOptions;
    this.host.onAcpSessionId(acpSessionId, proven);
    this.emitConfig();
  }

  /**
   * Put back the settings a restart reset.
   *
   * A profile is credentials and a model catalog — it says nothing about how you
   * like to work, so the permission mode and every other agent switch have to
   * come back exactly as they were. Best-effort throughout: an option the new
   * profile's agent no longer offers is a preference that no longer applies, not
   * a reason to throw a restored thread away.
   */
  private async applyRestore(restore: RestoreState): Promise<void> {
    if (restore.modeId && this.modes && this.modes.currentModeId !== restore.modeId) {
      try {
        await this.setMode(restore.modeId);
      } catch (error) {
        console.warn(`couldn't restore mode ${restore.modeId} after the restart`, error);
      }
    }
    for (const option of restore.configOptions) {
      const current = this.configOptions.find((o) => o.id === option.id);
      if (!current || current.currentValue === option.currentValue) continue;
      try {
        await this.setConfigOption(option.id, option.currentValue);
      } catch (error) {
        console.warn(`couldn't restore ${option.id} after the restart`, error);
      }
    }
  }

  /**
   * Put back the model and effort of a thread whose profile has no catalog.
   *
   * These are the two settings `applyRestore` deliberately drops, because for a
   * profile that owns a catalog they are process env and a respawn has already
   * placed them. A profile with no `models[]` is the opposite case: the agent
   * owns them, the value is an id out of the agent's OWN selector, and the only
   * thing that understands such an id is the selector it came from. Writing one
   * into the env instead is what broke a revived Default-profile thread —
   * claude-code's `opus[1m]` landing in ANTHROPIC_MODEL (and, pinned alongside
   * it, the sonnet/opus/fable alias vars) resolves to nothing the API serves,
   * and every turn died with `model_not_found`.
   *
   * By category, not by id: the record is "this thread runs on this model", and
   * which config id carries the model is the agent's business — it can differ
   * between agents and across upgrades. Best-effort like the rest of restore: a
   * value the agent no longer offers costs the pick, not the thread.
   */
  private async applyAgentOwned(state: { model?: string; effort?: string }): Promise<void> {
    const wanted = [
      ["model", state.model],
      ["thought_level", state.effort],
    ] as const;
    for (const [category, value] of wanted) {
      if (!value) continue;
      const option = this.configOptions.find((o) => o.type === "select" && o.category === category);
      if (!option || option.type !== "select" || option.currentValue === value) continue;
      try {
        await this.setConfigOption(option.id, value);
      } catch (error) {
        console.warn(`couldn't put ${category} back to ${value} after the restart`, error);
      }
    }
  }

  private async applyChoices(choices: Record<string, string | boolean>): Promise<void> {
    for (const [configId, value] of Object.entries(choices)) {
      try {
        await this.setConfigOption(configId, value);
      } catch (error) {
        console.warn(`the agent rejected the remembered ${configId} setting`, error);
      }
    }
  }

  /**
   * What a respawn has to put back — everything except the two settings the
   * profile owns, because those are precisely what is being changed.
   *
   * The rule is the client's `partitionSessionOptions` / `isModeTwin`, narrowed
   * to the part a restore needs. Captured while the old process is still up.
   */
  captureRestoreState(): RestoreState {
    const modeIds = new Set(this.modes?.availableModes.map((m) => m.id) ?? []);
    const configOptions = this.configOptions.filter((option) => {
      if (option.type !== "select") return true;
      if (option.category === "model" || option.category === "thought_level") return false;
      return !isModeTwin(option, modeIds);
    });
    return { modeId: this.modes?.currentModeId, configOptions };
  }

  // ---- agent -> us ----

  private onUpdate(notification: acp.SessionNotification): void {
    // Session-level updates change what `captureRestoreState` will report, so
    // they are tracked here as well as forwarded. Forwarded either way: the
    // reducer on the other end already handles both variants.
    const update = notification.update;
    if (update.sessionUpdate === "current_mode_update" && this.modes) {
      this.modes = { ...this.modes, currentModeId: update.currentModeId };
    } else if (update.sessionUpdate === "config_option_update") {
      this.configOptions = update.configOptions;
    }
    if (this.turnStartedAt !== null && !this.ttftSent) {
      this.ttftSent = true;
      this.host.emit({ ev: "ttft", ms: Math.round(performance.now() - this.turnStartedAt) });
    }
    this.host.emit({ ev: "update", seq: 0, update, historyReplay: this.historyReplay });
  }

  /**
   * The agent is asking the user something. Hold the promise, tell every peer,
   * and — when nobody is attached — let the push hook say so on a phone.
   */
  private park<R>(
    kind: "permission" | "elicitation",
    request: acp.RequestPermissionRequest | acp.CreateElicitationRequest,
    toolCallId: string | undefined,
  ): Promise<R> {
    const requestId = `r${this.nextRequestId++}`;
    return new Promise<R>((resolve) => {
      this.pending.set(requestId, {
        requestId,
        kind,
        toolCallId,
        payload: request,
        settle: resolve as (response: never) => void,
      });
      this.host.emit(
        kind === "permission"
          ? { ev: "permission", requestId, request: request as acp.RequestPermissionRequest }
          : { ev: "elicitation", requestId, request: request as acp.CreateElicitationRequest },
      );
      if (this.host.peerCount() === 0) {
        if (kind === "permission") this.host.onPermissionRequest();
        else this.host.onElicitationRequest();
      }
    });
  }

  /**
   * A URL-mode elicitation finished out of band. Accept it here rather than
   * relaying the notification and waiting for a browser: the flow is already
   * complete, and if nobody is attached there is no browser to wait for — the
   * agent would block on a question that has been answered.
   */
  private onElicitationComplete(elicitationId: string): void {
    for (const entry of this.pending.values()) {
      if (entry.kind !== "elicitation") continue;
      if (entry.requestId !== elicitationId && entry.toolCallId !== elicitationId) continue;
      this.settle(entry, { action: "accept" } as unknown as never);
      return;
    }
  }

  // ---- us -> agent ----

  /**
   * Send a prompt. Returns as soon as it is dispatched: `session/prompt` only
   * answers at turn end, and turn end already reaches every peer as an event —
   * so a prompt that fails is reported once, on `turn_ended`, rather than twice
   * in two shapes.
   */
  prompt(text: string, origin: Peer | undefined, turnId: string): void {
    const sessionId = this.requireSession();
    // The other peers never see this command (it goes to the agent, not to
    // them), so tell them a turn started and whose words started it.
    this.host.emit({ ev: "turn_started", seq: 0, turnId, text }, origin);
    if (this.inflight === 0) {
      this.currentTurnId = turnId;
      this.currentTurnPrompt = text;
      this.host.markTurnStderr();
      this.turnStartedAt = performance.now();
      this.ttftSent = false;
    }
    this.inflight++;
    void this.connection.agent
      .request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text }],
      })
      .then(
        (response) => this.settleTurn(response.usage ?? null, undefined, text),
        (error: unknown) => this.onPromptRejected(error, text),
      );
  }

  /**
   * A prompt came back an error — or the connection under it went away.
   *
   * The second case is why this is not a one-liner. When the agent dies the SDK
   * rejects instantly with "ACP connection closed", which explains nothing,
   * while the explanation is on stderr and has not finished arriving. So the
   * turn is *held* until `close()`, which the manager calls once the process's
   * pipes have drained and it knows how the process ended. Reporting straight
   * away would tell every peer the turn failed and say nothing about why.
   */
  private onPromptRejected(error: unknown, text: string): void {
    if (this.connection.signal.aborted && !this.closed) {
      this.held.push(text);
      return;
    }
    this.settleTurn(null, this.host.enrichError(toWireError(error)), text);
  }

  private settleTurn(usage: acp.Usage | null, error: WireError | undefined, text: string): void {
    // Steering: a second prompt sent mid-turn keeps the turn open. Only the one
    // that empties the set ends it.
    if (--this.inflight > 0) return;
    this.turnStartedAt = null;
    /* The session has content now, so the agent has written it down and a later
       `session/load` can find it. Before this point its id is unloadable, and
       recording an unloadable id is how a thread loses the transcript it had.
       Reported even for a failed turn: the prompt still reached the agent, and
       what makes the session findable is that it recorded anything at all. */
    if (this.acpSessionId) {
      this.sessionDurable = true;
      this.host.onSessionDurable();
    }
    const turnId = this.currentTurnId;
    const promptText = this.currentTurnPrompt ?? text;
    this.currentTurnId = null;
    this.currentTurnPrompt = null;
    if (!turnId) throw new Error("logical turn ended without an id");
    this.host.emit({ ev: "turn_ended", seq: 0, turnId, usage, error, promptText });
    this.host.onLogicalTurnEnd(turnId);
    if (this.host.peerCount() === 0) this.host.onTurnEnd(error);
  }

  async setMode(modeId: string, origin?: Peer): Promise<void> {
    const sessionId = this.requireSession();
    await this.connection.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId });
    if (this.modes) this.modes = { ...this.modes, currentModeId: modeId };
    this.emitConfig(origin);
  }

  async setConfigOption(
    configId: string,
    value: string | boolean,
    origin?: Peer,
  ): Promise<acp.SessionConfigOption[]> {
    const sessionId = this.requireSession();
    const response = await this.connection.agent.request(
      acp.methods.agent.session.setConfigOption,
      {
        sessionId,
        configId,
        // The request is a discriminated union and only the boolean variant
        // carries its tag: a bare string value IS the default variant, while a
        // bare boolean matches neither and agents reject it.
        ...(typeof value === "boolean" ? { type: "boolean" as const, value } : { value }),
      } as acp.SetSessionConfigOptionRequest,
    );
    if (response.configOptions) this.configOptions = response.configOptions;
    /* Model and reasoning effort are process env: `respawn` rebuilds them from
       the session record every time it revives a retired thread. A change made
       over ACP never touches that record, so without this the thread comes back
       on the model the user switched away from. */
    const category = this.configOptions.find((o) => o.id === configId)?.category;
    if (typeof value === "string") {
      if (category === "model") this.host.onSpawnStateChange({ model: value });
      else if (category === "thought_level") this.host.onSpawnStateChange({ effort: value });
    }
    this.emitConfig(origin);
    return this.configOptions;
  }

  async cancel(): Promise<void> {
    if (!this.acpSessionId) return;
    await this.connection.agent.notify(acp.methods.agent.session.cancel, {
      sessionId: this.acpSessionId,
    });
  }

  /**
   * A peer answering an open question. First answer wins; a slower peer gets
   * `null` back so the caller can still tell it to clear its card — today that
   * only happened if it had received the winner's broadcast first.
   */
  answer(requestId: string, response: unknown, origin?: Peer): { toolCallId?: string } | null {
    const entry = this.pending.get(requestId);
    if (!entry) return null;
    this.settle(entry, response as never, origin);
    return { toolCallId: entry.toolCallId };
  }

  /** The questions the agent is blocked on right now, as the events a peer
      attaching mid-question needs to see. This is what replaces scanning the
      log for still-open requests: the map holds exactly the open ones. */
  pendingEvents(): ThreadEvent[] {
    return [...this.pending.values()].map((entry) =>
      entry.kind === "permission"
        ? {
            ev: "permission",
            requestId: entry.requestId,
            request: entry.payload as acp.RequestPermissionRequest,
          }
        : {
            ev: "elicitation",
            requestId: entry.requestId,
            request: entry.payload as acp.CreateElicitationRequest,
          },
    );
  }

  private settle(entry: PendingRequest, response: never, except?: Peer): void {
    this.pending.delete(entry.requestId);
    entry.settle(response);
    this.host.emit(
      { ev: "request_answered", requestId: entry.requestId, toolCallId: entry.toolCallId },
      except,
    );
  }

  /**
   * Answer every open question so the agent is not left blocked on one nobody
   * can reach any more. Without this a dying or retired process takes its
   * questions with it and the agent hangs on a promise that will never settle.
   */
  settleAll(): void {
    for (const entry of [...this.pending.values()]) {
      this.settle(
        entry,
        (entry.kind === "permission"
          ? { outcome: { outcome: "cancelled" } }
          : { action: "cancel" }) as never,
      );
    }
  }

  close(reason?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.settleAll();
    // Whatever was held for want of an explanation now has one.
    if (this.held.length > 0) {
      const error = this.host.enrichError(
        toWireError(reason ?? new Error("the agent process is gone")),
      );
      for (const text of this.held.splice(0)) this.settleTurn(null, error, text);
    }
    this.connection.close(reason);
  }

  // ---- helpers ----

  private emitConfig(except?: Peer): void {
    this.host.emit(
      {
        ev: "session_config",
        seq: 0,
        modes: this.modes,
        modeId: this.modes?.currentModeId,
        configOptions: this.configOptions,
      },
      except,
    );
  }

  private requireSession(): string {
    if (this.closed) throw new Error("the agent process is gone");
    if (!this.acpSessionId) throw new Error("the agent never opened a session on this thread");
    return this.acpSessionId;
  }
}

/** Flatten anything thrown into the wire shape. The code matters: `errors.ts`
    on the other end reads it for the title, and -32800 is how a cancellation
    stays a cancellation instead of becoming a failure. */
export function toWireError(error: unknown): WireError {
  if (error instanceof acp.RequestError) {
    return { code: error.code, message: error.message, data: error.data };
  }
  if (error instanceof Error) return { code: -32603, message: error.message };
  return { code: -32603, message: String(error) };
}

/**
 * Is this option the same knob as the session's permission mode?
 *
 * Agents may advertise the mode twice — once as `modes`, once as a select config
 * option — and claude-agent-acp does exactly that. `category: "mode"` says so
 * outright; for agents that omit the category, an identical value set is the
 * only signal, and two selectors offering the same choices are the same knob.
 */
function isModeTwin(option: acp.SessionConfigOption, modeIds: ReadonlySet<string>): boolean {
  if (modeIds.size === 0 || option.type !== "select") return false;
  if (option.category === "mode") return true;
  const values = option.options
    .flatMap((entry) => ("options" in entry ? entry.options : [entry]))
    .map((choice) => choice.value);
  return values.length === modeIds.size && values.every((value) => modeIds.has(value));
}
