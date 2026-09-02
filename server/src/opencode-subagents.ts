/**
 * OpenCode's subagents, read off the side of the process.
 *
 * `opencode acp` runs OpenCode's HTTP server in-process and drives the ACP
 * agent as a client of it — and its event translator drops every event whose
 * session is not one ACP opened. A child session (the `task` tool) is exactly
 * that, so a thread on OpenCode sees the `task` call and its result and
 * nothing of what the child did. The data is there: the same process's
 * `/event` bus carries every session's events. This module subscribes to that
 * bus with a per-spawn password, keeps an allowlist rooted at the thread's
 * own session id, and re-emits each child's events as the ACP notifications
 * the bridge already understands — a child's updates on the child's session
 * id, `subagent_spawned` / `subagent_state_update` on the parent's, exactly
 * as a Codex RFD child arrives. Nothing downstream learns a fourth shape: the
 * journal, replay and the client tree see a subagent session.
 *
 * Two halves. `translateOpencodeEvent` is pure — state in, one bus event in,
 * notifications out — and is what the tests drive. `OpencodeSubagentFeed`
 * owns the socket: the fetch, the SSE framing, the retry while the server
 * comes up, and the abort when the process goes. The feed's `stream` is
 * merged into the bridge's inbound frames by `agentStream(proc, extra)`.
 *
 * Retirement condition: sst/opencode#40654 (`acp-subagent-events`) makes the
 * bridge itself project the children, in a shape the client already reads
 * (`_meta["opencode/child-session"]`). When it ships, drop `subagentFeed`
 * from the opencode seed and this file goes with it.
 *
 * Not here (see docs/plans/opencode-subagent-sidecar.md): backfill after a
 * `session/load` (the journal is cleared before a revive, so children vanish
 * from a revived thread until the next task runs), and a child's permission
 * asks, which OpenCode's bridge also drops and which the seeded
 * `"permission":"allow"` makes moot.
 */
import type * as acp from "./acp.js";
import type { SessionUpdate, SubagentSpawned, SubagentStateUpdate, SubagentUsage } from "./protocol.js";

/** What the bus sends: `{type, properties}`. Read defensively — the shape is
    versioned loosely, and an event this file does not recognise must cost
    nothing more than "no child rows". */
export interface OpencodeEvent {
  type?: unknown;
  properties?: unknown;
}

export interface Notification {
  jsonrpc: "2.0";
  method: "session/update";
  params: { sessionId: string; update: SessionUpdate };
}

/** OpenCode's tool names → ACP `kind`, the same map its own bridge uses. */
const TOOL_KIND: Record<string, acp.ToolKind> = {
  read: "read",
  edit: "edit",
  write: "edit",
  patch: "edit",
  multiedit: "edit",
  bash: "execute",
  glob: "search",
  grep: "search",
  list: "search",
  ls: "search",
  webfetch: "fetch",
  websearch: "fetch",
  todowrite: "think",
  todoread: "think",
  task: "other",
};

interface PartInfo {
  type: string;
  sessionId: string;
  messageId: string;
  sawDelta: boolean;
}

export class OpencodeTranslatorState {
  /** The thread's own OpenCode session id, once the handshake has answered. */
  root: string | null = null;
  /** Every session this feed speaks for: the root and its descendants. */
  readonly allowed = new Set<string>();
  /** child → parent, for addressing the lifecycle updates. */
  readonly parents = new Map<string, string>();
  /** `session.created` events seen before the root id was known. */
  readonly held: { id: string; parentId: string; title: string }[] = [];
  /** messageID → role, per `message.updated`. */
  readonly roles = new Map<string, string>();
  readonly parts = new Map<string, PartInfo>();
  /** Tool calls already announced, by callID. */
  readonly announced = new Set<string>();
  readonly failed = new Set<string>();
  readonly rootSessionId: () => string | null;

  constructor(rootSessionId: () => string | null) {
    this.rootSessionId = rootSessionId;
  }
}

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** The wrapper harness-opencode also unwraps: `{payload: {type, properties}}`
    on the multi-instance bus, and `data` as an alias of `properties`. */
function unwrap(event: OpencodeEvent): { type: string; props: Record<string, unknown> } | null {
  const outer = rec(event);
  if (!outer) return null;
  const inner = rec(outer.payload) ?? outer;
  const type = str(inner.type);
  if (!type) return null;
  return { type, props: rec(inner.properties) ?? rec(inner.data) ?? {} };
}

function notify(sessionId: string, update: SessionUpdate): Notification {
  return { jsonrpc: "2.0", method: "session/update", params: { sessionId, update } };
}

/**
 * One bus event → the ACP notifications it means, or none. Pure: every side
 * effect is on `state`. The order of the RFD contract is kept by
 * construction — a child is announced on its parent before any of its own
 * updates can be produced, because its id is only allowed by that same step.
 */
export function translateOpencodeEvent(state: OpencodeTranslatorState, event: OpencodeEvent): Notification[] {
  const out: Notification[] = [];
  if (state.root === null) {
    const root = state.rootSessionId();
    if (root) {
      state.root = root;
      state.allowed.add(root);
      for (const held of state.held.splice(0)) adopt(state, held, out);
    }
  }
  const parsed = unwrap(event);
  if (!parsed) return out;
  const { type, props } = parsed;

  switch (type) {
    case "session.created": {
      const info = rec(props.info) ?? props;
      const id = str(info.id);
      const parentId = str(info.parentID) ?? str(info.parentId);
      if (!id || !parentId) return out;
      const child = { id, parentId, title: str(info.title) ?? "" };
      if (state.root === null) state.held.push(child);
      else adopt(state, child, out);
      return out;
    }
    case "message.updated": {
      const info = rec(props.info);
      const id = str(info?.id);
      const sessionId = str(info?.sessionID);
      const role = str(info?.role);
      if (id && role && sessionId && state.allowed.has(sessionId)) state.roles.set(id, role);
      return out;
    }
    case "message.part.updated": {
      const part = rec(props.part);
      if (!part) return out;
      const sessionId = str(part.sessionID);
      const partId = str(part.id);
      const messageId = str(part.messageID) ?? "";
      const partType = str(part.type);
      if (!sessionId || !partId || !partType) return out;
      if (!state.allowed.has(sessionId)) return out;
      /* A `task` tool part is how a parent names its child when
         `session.created` was missed (the fallback): its metadata carries the
         child's session id. Read on the root and on children alike. */
      if (partType === "tool" && str(part.tool) === "task") {
        const toolState = rec(part.state);
        const meta = rec(toolState?.metadata);
        const childId = str(meta?.sessionId) ?? str(meta?.sessionID);
        if (childId && !state.allowed.has(childId)) {
          adopt(state, { id: childId, parentId: sessionId, title: str(toolState?.title) ?? "" }, out);
        }
      }
      /* The root's own parts arrive over ACP; only children are re-emitted. */
      if (sessionId === state.root) return out;
      const role = state.roles.get(messageId) ?? "assistant";
      if (role === "user") return out;
      const known = state.parts.get(partId) ?? { type: partType, sessionId, messageId, sawDelta: false };
      state.parts.set(partId, known);
      switch (partType) {
        case "text":
        case "reasoning": {
          /* Deltas carry the prose; the whole part is emitted only for a part
             that finished without any — the "missing final delta" case. */
          const time = rec(part.time);
          const text = str(part.text) ?? "";
          if (!known.sawDelta && time?.end !== undefined && text) {
            known.sawDelta = true;
            out.push(notify(sessionId, chunk(partType, text)));
          }
          return out;
        }
        case "tool": {
          const callId = str(part.callID) ?? partId;
          const toolState = rec(part.state) ?? {};
          const status = str(toolState.status) ?? "pending";
          const tool = str(part.tool) ?? "tool";
          const title = str(toolState.title) ?? tool;
          if (!state.announced.has(callId)) {
            state.announced.add(callId);
            out.push(
              notify(sessionId, {
                sessionUpdate: "tool_call",
                toolCallId: callId,
                title,
                kind: TOOL_KIND[tool] ?? "other",
                status: status === "completed" ? "completed" : status === "error" ? "failed" : "in_progress",
                rawInput: toolState.input,
                content: [],
                locations: [],
              } as SessionUpdate),
            );
            if (status === "pending" || status === "running") return out;
          }
          if (status === "completed" || status === "error") {
            const text = status === "completed" ? str(toolState.output) ?? "" : str(toolState.error) ?? "failed";
            if (status === "error") state.failed.add(sessionId);
            out.push(
              notify(sessionId, {
                sessionUpdate: "tool_call_update",
                toolCallId: callId,
                title,
                status: status === "completed" ? "completed" : "failed",
                content: text ? [{ type: "content", content: { type: "text", text } }] : [],
                rawOutput: { output: toolState.output, error: toolState.error, metadata: toolState.metadata },
              } as SessionUpdate),
            );
          }
          return out;
        }
        case "step-finish": {
          const parentId = state.parents.get(sessionId);
          if (!parentId) return out;
          const tokens = rec(part.tokens) ?? {};
          const cache = rec(tokens.cache) ?? {};
          const input = num(tokens.input);
          const output = num(tokens.output);
          const reasoning = num(tokens.reasoning);
          const usage: SubagentUsage = {
            sessionUpdate: "_daedalus/subagent_usage",
            subagentSessionId: sessionId,
            usage: {
              inputTokens: input,
              outputTokens: output,
              totalTokens: num(tokens.total) || input + output + reasoning,
              thoughtTokens: reasoning,
              cachedReadTokens: num(cache.read),
              cachedWriteTokens: num(cache.write),
              _meta: { opencode: { cost: num(part.cost) } },
            },
          };
          out.push(notify(parentId, usage));
          return out;
        }
        default:
          return out;
      }
    }
    case "message.part.delta": {
      const sessionId = str(props.sessionID);
      const partId = str(props.partID);
      const delta = str(props.delta);
      const field = str(props.field) ?? "text";
      if (!sessionId || !partId || !delta || field !== "text") return out;
      if (!state.allowed.has(sessionId) || sessionId === state.root) return out;
      const known = state.parts.get(partId);
      if (!known || (known.type !== "text" && known.type !== "reasoning")) return out;
      if ((state.roles.get(known.messageId) ?? "assistant") === "user") return out;
      known.sawDelta = true;
      out.push(notify(sessionId, chunk(known.type, delta)));
      return out;
    }
    case "session.status": {
      const sessionId = str(props.sessionID);
      const status = rec(props.status);
      if (!sessionId || str(status?.type) !== "idle") return out;
      const parentId = state.parents.get(sessionId);
      if (!parentId) return out;
      const update: SubagentStateUpdate = {
        sessionUpdate: "subagent_state_update",
        subagentSessionId: sessionId,
        state: state.failed.has(sessionId) ? "failed" : "completed",
      };
      out.push(notify(parentId, update));
      return out;
    }
    case "session.error": {
      const sessionId = str(props.sessionID);
      const parentId = sessionId ? state.parents.get(sessionId) : undefined;
      if (!sessionId || !parentId) return out;
      state.failed.add(sessionId);
      const update: SubagentStateUpdate = {
        sessionUpdate: "subagent_state_update",
        subagentSessionId: sessionId,
        state: "failed",
      };
      out.push(notify(parentId, update));
      return out;
    }
    default:
      return out;
  }
}

function adopt(
  state: OpencodeTranslatorState,
  child: { id: string; parentId: string; title: string },
  out: Notification[],
): void {
  if (!state.allowed.has(child.parentId) || state.allowed.has(child.id)) return;
  state.allowed.add(child.id);
  state.parents.set(child.id, child.parentId);
  const spawned: SubagentSpawned = {
    sessionUpdate: "subagent_spawned",
    subagentSessionId: child.id,
    name: child.title || "Subagent",
    task: child.title,
    capabilities: {},
    _meta: { opencode: { parentId: child.parentId } },
  };
  out.push(notify(child.parentId, spawned));
}

function chunk(type: "text" | "reasoning", text: string): SessionUpdate {
  return {
    sessionUpdate: type === "reasoning" ? "agent_thought_chunk" : "agent_message_chunk",
    content: { type: "text", text },
  } as SessionUpdate;
}

/* ── The socket ── */

export interface FeedOptions {
  port: number;
  password: string;
  username?: string;
  rootSessionId: () => string | null;
  /** Where to say what went wrong, once. Defaults to console.warn. */
  log?: (message: string) => void;
  /** Overridable for the test's fake bus. */
  fetch?: typeof fetch;
}

const BACKOFF_MS = [200, 400, 800, 1600, 3200, 5000];
const GIVE_UP_AFTER = 20;

/**
 * Parse `text/event-stream` bytes into the `data:` payloads of each block.
 * Exported for the test. The bus uses no `event:` names; everything is JSON
 * in `data:`.
 */
export function sseBlocks(): TransformStream<Uint8Array, string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (controller: TransformStreamDefaultController<string>, block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data) controller.enqueue(data);
  };
  return new TransformStream<Uint8Array, string>({
    transform(bytes, controller) {
      buffer += decoder.decode(bytes, { stream: true });
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match) break;
        flush(controller, buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.trim()) flush(controller, buffer);
    },
  });
}

export class OpencodeSubagentFeed {
  readonly stream: ReadableStream<acp.AnyMessage>;
  private controller: ReadableStreamDefaultController<acp.AnyMessage> | null = null;
  private readonly abort = new AbortController();
  private readonly state: OpencodeTranslatorState;
  private readonly opts: FeedOptions;
  private closed = false;

  constructor(opts: FeedOptions) {
    this.opts = opts;
    this.state = new OpencodeTranslatorState(opts.rootSessionId);
    this.stream = new ReadableStream<acp.AnyMessage>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => this.close(),
    });
    void this.run();
  }

  /** Stop reading and end the stream. Idempotent; called on process close. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    try {
      this.controller?.close();
    } catch {
      /* already closed */
    }
  }

  private emit(notification: Notification): void {
    if (this.closed) return;
    this.controller?.enqueue(notification as unknown as acp.AnyMessage);
  }

  private async run(): Promise<void> {
    const doFetch = this.opts.fetch ?? fetch;
    const auth = Buffer.from(`${this.opts.username ?? "opencode"}:${this.opts.password}`).toString("base64");
    const log = this.opts.log ?? ((message: string) => console.warn(`[opencode-subagents] ${message}`));
    let attempt = 0;
    while (!this.closed) {
      try {
        const res = await doFetch(`http://127.0.0.1:${this.opts.port}/event`, {
          headers: { authorization: `Basic ${auth}`, accept: "text/event-stream" },
          signal: this.abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        attempt = 0;
        const reader = res.body.pipeThrough(sseBlocks()).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          let event: OpencodeEvent;
          try {
            event = JSON.parse(value) as OpencodeEvent;
          } catch {
            continue;
          }
          for (const notification of translateOpencodeEvent(this.state, event)) this.emit(notification);
        }
        /* The server closed the stream without the process dying — reconnect. */
      } catch (err) {
        if (this.closed) return;
        attempt += 1;
        if (attempt === GIVE_UP_AFTER) {
          log(`giving up on the event bus at :${this.opts.port}: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (attempt >= GIVE_UP_AFTER) return;
      }
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]));
    }
  }
}
