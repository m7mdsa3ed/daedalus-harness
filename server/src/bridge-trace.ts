/* ── A bridge's spans ──
 *
 * What the harness can say about a thread's work from where it stands — the
 * client end of ACP — as OpenTelemetry spans (tracing.ts). The bridge calls
 * in at the moments it already knows about (a prompt going out, an update
 * arriving, a question parked, a turn settling) and holds no span itself.
 *
 * One trace per turn, rooted at the turn: the `session/prompt` request under
 * it, and under that whatever the turn did. What that is depends on who is
 * doing the telling:
 *
 *   - A runtime that traces itself (`daedalus/trace` in its `initialize`
 *     `_meta` — ours) is sent the request span's `traceparent` and parents its
 *     own spans under it; the model calls and tool executions are *its* spans,
 *     measured where they happen. Deriving them here as well would draw every
 *     call twice.
 *   - Every other runtime gets them derived from its updates: a **model** span
 *     from the last boundary (the prompt, or the tool call that just settled)
 *     to the next tool call or the turn's end — so its duration is the request
 *     *and* the decode, with the first chunk's arrival as `daedalus.ttft_ms` —
 *     and a **tool** span from `tool_call` to its terminal status. A subagent's
 *     updates nest under a span of their own, under the tool call that
 *     spawned it when the runtime says which.
 *
 * Permission and elicitation waits, retries and holds are the harness's to
 * see for every runtime, so they are drawn for every runtime.
 *
 * The same model spans are what a turn's output speed is measured on
 * (`TurnGeneration`, tps.ts): a runtime's own carry output tokens and a first
 * token time per call, so the turn's generation is their sum; otherwise the
 * thread's own stream says when the writing started and stopped, so that
 * decode time is summed and divided into the turn's usage. Either way the
 * tool calls, prefill and waits between them are not in the denominator.
 */
import type { Attributes, Span } from "@opentelemetry/api";

import type * as acp from "./acp.js";
import type { SessionUpdate, TurnGeneration } from "./protocol.js";
import { spanGeneration } from "./tps.js";
import { endSpan, onIngest, startSpan, traceparent } from "./tracing.js";

/** Text kept on a derived span — enough to recognise the answer by. */
const TEXT_LIMIT = 16_000;

type Update = SessionUpdate;

interface Generation {
  span: Span;
  text: string;
  thought: string;
  firstChunkAt: number | null;
  startedAt: number;
}

interface Lane {
  /** The span this lane's derived spans sit under — the request, or a subagent. */
  parent: Span;
  generation: Generation | null;
  /** When the last boundary was crossed: the model call after it started then. */
  boundaryAt: number;
}

const clip = (text: string) => (text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text);
const json = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  try {
    return clip(typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    return undefined;
  }
};

/** A tool call's content as text: what its blocks say, in order. */
function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content as { type?: string; content?: { type?: string; text?: string }; path?: string; newText?: string }[]) {
    if (block.type === "content" && block.content?.type === "text" && block.content.text) parts.push(block.content.text);
    else if (block.type === "diff" && block.path) parts.push(`diff ${block.path}\n${block.newText ?? ""}`);
    else if (block.type === "terminal") parts.push("[terminal]");
  }
  return parts.length ? clip(parts.join("\n")) : undefined;
}

export class BridgeTrace {
  private readonly threadId: string;
  private readonly selfTraced: () => boolean;
  private turn: Span | null = null;
  private request: Span | null = null;
  private readonly lanes = new Map<string, Lane>();
  private readonly tools = new Map<string, Span>();
  private readonly waits = new Map<string, Span>();
  private model = "";
  /** The running turn's generation, from a runtime's own model spans. */
  private reported: TurnGeneration = { outputTokens: 0, decodeMs: 0 };
  /** The running turn's decode time, read off the thread's own stream: from a
      generation's first chunk to the tool call that ends it, or the turn's
      end. Kept for every runtime, because a self-traced one's spans can land
      after the turn does (Claude Code exports OTLP on an interval). */
  private streamDecodeMs = 0;
  private streamFirstChunkAt: number | null = null;
  private readonly unsubscribe: () => void;

  constructor(threadId: string, selfTraced: () => boolean) {
    this.threadId = threadId;
    this.selfTraced = selfTraced;
    /* A runtime's spans carry the turn's trace id (it was handed the request's
       `traceparent`; the OTLP intake reparents onto it), which is how one is
       told apart from a late span of the turn before. */
    this.unsubscribe = onIngest(threadId, (span) => {
      if (span.kind !== "model" || !this.turn || span.traceId !== this.turn.spanContext().traceId) return;
      const gen = spanGeneration(span);
      if (!gen) return;
      this.reported.outputTokens += gen.outputTokens;
      this.reported.decodeMs += gen.decodeMs;
    });
  }

  /* ── Outside a turn ── */

  /** A span that belongs to no turn — the handshake, a load. Its own trace. */
  standalone(name: string, kind: "session" | "process", attributes?: Attributes): Span {
    return startSpan(this.threadId, name, kind, { attributes });
  }

  /* ── The turn ── */

  /** The first prompt of a turn opens it; a steer joining it is an event. */
  startTurn(turnId: string, text: string, attributes: Attributes): void {
    this.endTurn({ error: "superseded" });
    this.reported = { outputTokens: 0, decodeMs: 0 };
    this.streamDecodeMs = 0;
    this.streamFirstChunkAt = null;
    this.model = String(attributes["gen_ai.request.model"] ?? "");
    this.turn = startSpan(this.threadId, "turn", "turn", {
      attributes: { ...attributes, "daedalus.turn_id": turnId, "daedalus.prompt": clip(text) },
    });
  }

  steer(text: string): void {
    this.turn?.addEvent("steer", { "daedalus.prompt": clip(text) });
  }

  /** `session/prompt` going out. Returns the `_meta` it should carry. */
  startRequest(text: string): Record<string, string> {
    this.request = startSpan(this.threadId, "session/prompt", "request", {
      parent: this.turn,
      attributes: { "rpc.system": "jsonrpc", "rpc.method": "session/prompt", "daedalus.prompt": clip(text) },
    });
    this.lanes.set("", { parent: this.request, generation: null, boundaryAt: Date.now() });
    return { traceparent: traceparent(this.request) };
  }

  /** The answer to one `session/prompt` (a steer's answers are ignored: the
      turn's own request is the one that spans it). */
  endRequest(error?: unknown, stopReason?: string): void {
    if (!this.request) return;
    this.closeStream();
    this.closeLanes(error);
    endSpan(this.request, error, stopReason ? { "daedalus.stop_reason": stopReason } : undefined);
    this.request = null;
  }

  endTurn(result: {
    error?: unknown;
    usage?: acp.Usage | null;
    stopReason?: string;
    durationMs?: number;
    toolDurationMs?: number;
  }): TurnGeneration | undefined {
    if (!this.turn) return undefined;
    this.endRequest(result.error, result.stopReason);
    const generation = this.generation(result.usage);
    for (const span of this.tools.values()) endSpan(span, result.error ?? "turn ended with the call open");
    this.tools.clear();
    for (const span of this.waits.values()) endSpan(span, "turn ended while waiting");
    this.waits.clear();
    const usage = result.usage;
    const attributes: Attributes = {
      ...(result.stopReason ? { "daedalus.stop_reason": result.stopReason } : {}),
      ...(result.durationMs !== undefined ? { "daedalus.duration_ms": result.durationMs } : {}),
      ...(result.toolDurationMs !== undefined ? { "daedalus.tool_ms": result.toolDurationMs } : {}),
      ...(generation ? { "daedalus.decode_ms": Math.round(generation.decodeMs), "daedalus.generated_tokens": generation.outputTokens } : {}),
      ...(usage
        ? {
            "gen_ai.usage.input_tokens": usage.inputTokens + (usage.cachedReadTokens ?? 0) + (usage.cachedWriteTokens ?? 0),
            "gen_ai.usage.output_tokens": usage.outputTokens,
            "gen_ai.usage.cache_read.input_tokens": usage.cachedReadTokens ?? 0,
            "gen_ai.usage.cache_creation.input_tokens": usage.cachedWriteTokens ?? 0,
            "daedalus.usage.fresh_input_tokens": usage.inputTokens,
            "daedalus.usage.thought_tokens": usage.thoughtTokens ?? 0,
            "daedalus.usage.total_tokens": usage.totalTokens,
          }
        : {}),
    };
    endSpan(this.turn, result.error, attributes);
    this.turn = null;
    return generation;
  }

  /** What the turn's model calls wrote over the time they spent writing:
      the runtime's own model spans when they have arrived (exact counts per
      call), else the turn's output over the decode time seen on the stream —
      the only count a runtime that does not trace itself gives. */
  private generation(usage: acp.Usage | null | undefined): TurnGeneration | undefined {
    const r = this.reported;
    if (r.outputTokens > 0 && r.decodeMs > 0) return { outputTokens: r.outputTokens, decodeMs: Math.round(r.decodeMs) };
    const output = usage?.outputTokens ?? 0;
    return output > 0 && this.streamDecodeMs > 0 ? { outputTokens: output, decodeMs: Math.round(this.streamDecodeMs) } : undefined;
  }

  private closeStream(): void {
    if (this.streamFirstChunkAt === null) return;
    this.streamDecodeMs += Date.now() - this.streamFirstChunkAt;
    this.streamFirstChunkAt = null;
  }

  ttft(ms: number): void {
    this.turn?.setAttribute("daedalus.ttft_ms", ms);
  }

  event(name: string, attributes?: Attributes): void {
    (this.request ?? this.turn)?.addEvent(name, attributes);
  }

  /* ── Updates ── */

  /** `child` is a subagent's session id, absent for the thread's own. */
  onUpdate(update: Update, child?: string): void {
    if (!this.request) return;
    if (update.sessionUpdate === "usage_update") {
      const u = update as acp.UsageUpdate;
      this.turn?.setAttributes({ "daedalus.context.used": u.used, "daedalus.context.size": u.size });
      if (u.cost) this.turn?.setAttributes({ "daedalus.cost": u.cost.amount, "daedalus.cost.currency": u.cost.currency });
      return;
    }
    if (update.sessionUpdate === "subagent_spawned") {
      const spawned = update as { subagentSessionId?: string; name?: string; task?: string; _meta?: { daedalus?: { parentToolUseId?: string } } };
      if (!spawned.subagentSessionId || this.selfTraced()) return;
      const parent = this.tools.get(spawned._meta?.daedalus?.parentToolUseId ?? "") ?? this.request;
      const span = startSpan(this.threadId, `subagent ${spawned.name ?? ""}`.trim(), "agent", {
        parent,
        attributes: {
          "daedalus.subagent_session_id": spawned.subagentSessionId,
          ...(spawned.task ? { "daedalus.prompt": clip(spawned.task) } : {}),
        },
      });
      this.lanes.set(spawned.subagentSessionId, { parent: span, generation: null, boundaryAt: Date.now() });
      return;
    }
    if (update.sessionUpdate === "subagent_state_update") {
      const state = update as { subagentSessionId?: string; state?: string };
      const lane = this.lanes.get(state.subagentSessionId ?? "");
      if (lane && state.state && state.state !== "running") {
        this.closeGeneration(lane);
        endSpan(lane.parent, state.state === "failed" ? "subagent failed" : undefined, { "daedalus.subagent.state": state.state });
        this.lanes.delete(state.subagentSessionId ?? "");
      }
      return;
    }
    if (!child) {
      if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
        this.streamFirstChunkAt ??= Date.now();
      } else if (update.sessionUpdate === "tool_call") this.closeStream();
    }
    if (this.selfTraced()) return;
    const lane = this.laneFor(child);
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const gen = this.openGeneration(lane);
        const text = update.content.type === "text" ? update.content.text : "";
        if (gen.firstChunkAt === null) {
          gen.firstChunkAt = Date.now();
          gen.span.setAttribute("daedalus.ttft_ms", gen.firstChunkAt - gen.startedAt);
        }
        if (update.sessionUpdate === "agent_message_chunk") gen.text += text;
        else gen.thought += text;
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        /* A call ends the generation that asked for it. An agent may announce
           one already settled, so both kinds run the same close below. */
        if (!update.toolCallId) return;
        if (update.sessionUpdate === "tool_call") this.closeGeneration(lane);
        const span = this.tools.get(update.toolCallId) ?? this.openTool(lane, update);
        if (update.rawInput !== undefined) {
          const args = json(update.rawInput);
          if (args) span.setAttribute("gen_ai.tool.call.arguments", args);
        }
        if (update.status === "completed" || update.status === "failed") {
          const result = json(update.rawOutput) ?? contentText(update.content);
          endSpan(span, update.status === "failed" ? (result ?? "tool call failed") : undefined, {
            ...(result ? { "gen_ai.tool.call.result": result } : {}),
            "daedalus.tool.status": update.status,
          });
          this.tools.delete(update.toolCallId);
          lane.boundaryAt = Date.now();
        }
        return;
      }
      default:
        return;
    }
  }

  /* ── Waits ── */

  /** A permission or elicitation parked for an answer. */
  startWait(requestId: string, kind: "permission" | "elicitation", request: unknown, toolCallId?: string): void {
    const tool = toolCallId ? this.tools.get(toolCallId) : undefined;
    const title =
      kind === "permission"
        ? ((request as acp.RequestPermissionRequest).toolCall?.title ?? "")
        : ((request as { message?: string }).message ?? "");
    this.waits.set(
      requestId,
      startSpan(this.threadId, `${kind} ${title}`.trim().slice(0, 120), "permission", {
        parent: tool ?? this.request ?? this.turn,
        attributes: {
          "daedalus.permission.kind": kind,
          ...(toolCallId ? { "gen_ai.tool.call.id": toolCallId } : {}),
          ...(json(request) ? { "daedalus.permission.request": json(request)! } : {}),
        },
      }),
    );
  }

  endWait(requestId: string, outcome: string, auto?: string): void {
    const span = this.waits.get(requestId);
    if (!span) return;
    this.waits.delete(requestId);
    endSpan(span, undefined, { "daedalus.permission.outcome": outcome, ...(auto ? { "daedalus.permission.auto": auto } : {}) });
  }

  /** The process is gone: everything open ends, as a failure. */
  close(reason: unknown): void {
    this.endTurn({ error: reason ?? "the agent process closed" });
    this.unsubscribe();
  }

  /* ── Derived spans ── */

  private laneFor(child?: string): Lane {
    const own = this.lanes.get("")!;
    if (!child) return own;
    let lane = this.lanes.get(child);
    if (!lane) {
      /* An update that outran its `subagent_spawned`, or a runtime that never
         says one: its own span, under the request. */
      const span = startSpan(this.threadId, "subagent", "agent", {
        parent: this.request,
        attributes: { "daedalus.subagent_session_id": child },
      });
      lane = { parent: span, generation: null, boundaryAt: Date.now() };
      this.lanes.set(child, lane);
    }
    return lane;
  }

  private openGeneration(lane: Lane): Generation {
    if (lane.generation) return lane.generation;
    const startedAt = lane.boundaryAt;
    const span = startSpan(this.threadId, `chat ${this.model}`.trim(), "model", {
      parent: lane.parent,
      startTime: startedAt,
      attributes: { "gen_ai.operation.name": "chat", ...(this.model ? { "gen_ai.request.model": this.model } : {}) },
    });
    lane.generation = { span, text: "", thought: "", firstChunkAt: null, startedAt };
    return lane.generation;
  }

  private closeGeneration(lane: Lane, error?: unknown): void {
    const gen = lane.generation;
    if (!gen) return;
    lane.generation = null;
    const decodeMs = gen.firstChunkAt !== null ? Date.now() - gen.firstChunkAt : null;
    endSpan(gen.span, error, {
      ...(gen.text ? { "gen_ai.output.messages": JSON.stringify([{ role: "assistant", parts: [{ type: "text", content: clip(gen.text) }] }]) } : {}),
      ...(gen.thought ? { "daedalus.thought": clip(gen.thought) } : {}),
      "daedalus.output_chars": gen.text.length,
      ...(decodeMs !== null ? { "daedalus.decode_ms": decodeMs } : {}),
    });
  }

  private openTool(lane: Lane, update: acp.ToolCall | acp.ToolCallUpdate): Span {
    const name = (update as { name?: string | null }).name ?? update.title ?? "tool";
    const args = json(update.rawInput);
    const span = startSpan(this.threadId, `execute_tool ${name}`, "tool", {
      parent: lane.parent,
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": name,
        "gen_ai.tool.call.id": update.toolCallId,
        ...(update.title ? { "daedalus.tool.title": update.title } : {}),
        ...(update.kind ? { "daedalus.tool.kind": update.kind } : {}),
        ...(args ? { "gen_ai.tool.call.arguments": args } : {}),
      },
    });
    this.tools.set(update.toolCallId, span);
    return span;
  }

  private closeLanes(error?: unknown): void {
    for (const [id, lane] of this.lanes) {
      this.closeGeneration(lane, error);
      if (id !== "") endSpan(lane.parent, error);
    }
    this.lanes.clear();
  }
}
