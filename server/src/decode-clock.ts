/* ── A turn's decode clock ──
 *
 * What a turn's output speed is measured on (`TurnGeneration`, tps.ts): the
 * time the model spent *writing*, over the tokens it wrote in that time.
 *
 * Two sources, never mixed in one turn:
 *   - the runtime's own reading, when it sends one on the prompt answer
 *     (`_meta.daedalus.generation`, `generationFromMeta`). Our runtime meters
 *     every model call as it answers and counts the tool-call arguments it
 *     streams, which no ACP update can show from outside. This is the speed.
 *   - this clock, for a runtime that sends none: from a generation's first
 *     chunk to the tool call that ends it, or the turn's end. It can only see
 *     prose, while the usage it is divided into also counts the tokens a tool
 *     call's arguments cost (a `Write` is thousands of them) — so it answers
 *     only for a turn that made no tool call, where the two are the same
 *     tokens. A turn with tools falls back to the labelled wall-clock
 *     throughput rather than to a rate with an unseen numerator.
 *
 * The bridge calls in at the moments it already knows about and this holds no
 * state past the turn it is timing. A subagent's chunks are never counted: its
 * decode runs inside the parent's step and is billed to its own session.
 */
import type * as acp from "./acp.js";
import type { SessionUpdate, TurnGeneration, TurnWaits, WireError } from "./protocol.js";

/** Whether an update is the model's own output — prose, thought, or the
    opening of a tool call. The moment time to first token stops. */
export function isModelOutput(update: SessionUpdate): boolean {
  return (
    update.sessionUpdate === "agent_message_chunk" ||
    update.sessionUpdate === "agent_thought_chunk" ||
    update.sessionUpdate === "tool_call"
  );
}

/* A decode under a tenth of the wait before it measured delivery, not
   writing — the agent's `BURST_RATIO` (metering.ts) and `stepRate`'s (tps.ts),
   applied to this clock too: a gateway that holds the answer until it is whole
   hands it over in one burst, and 683 tokens over the 60ms that burst took was
   drawn as 11k tok/s. */
const BURST_RATIO = 10;

export class DecodeClock {
  private running = false;
  private decodeMs = 0;
  private openedAt = 0;
  /** When the turn's first chunk landed — the end of its lead. */
  private leadEndedAt: number | null = null;
  private firstChunkAt: number | null = null;
  private sawToolCall = false;
  private sawThought = false;

  /** A turn opened: start from nothing. A steer joining it does not call. */
  start(): void {
    this.running = true;
    this.decodeMs = 0;
    this.openedAt = Date.now();
    this.leadEndedAt = null;
    this.firstChunkAt = null;
    this.sawToolCall = false;
    this.sawThought = false;
  }

  /** One update of the thread's own stream (never a subagent's). */
  onUpdate(update: SessionUpdate): void {
    if (!this.running) return;
    if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
      if (update.sessionUpdate === "agent_thought_chunk") this.sawThought = true;
      this.firstChunkAt ??= Date.now();
      this.leadEndedAt ??= this.firstChunkAt;
    } else if (update.sessionUpdate === "tool_call") {
      this.sawToolCall = true;
      this.close();
    }
  }

  /** The turn settled: the output it wrote over the decode time seen, or
      nothing when no generation was timed, the turn's output is not all prose,
      or the prose arrived in one buffered burst. Reasoning the runtime billed
      but never streamed was written before the first chunk — its time is in
      the lead, so its tokens are not in the numerator either. */
  end(usage: acp.Usage | null | undefined): TurnGeneration | undefined {
    if (!this.running) return undefined;
    this.close();
    this.running = false;
    const hidden = this.sawThought ? 0 : (usage?.thoughtTokens ?? 0);
    const output = (usage?.outputTokens ?? 0) - hidden;
    const leadMs = this.leadEndedAt === null ? 0 : this.leadEndedAt - this.openedAt;
    if (this.sawToolCall || !(output > 0) || !(this.decodeMs > 0) || this.decodeMs * BURST_RATIO < leadMs) return undefined;
    return { outputTokens: output, decodeMs: Math.round(this.decodeMs) };
  }

  private close(): void {
    if (this.firstChunkAt === null) return;
    this.decodeMs += Date.now() - this.firstChunkAt;
    this.firstChunkAt = null;
  }
}

/** The runtime's own generation reading off a `session/prompt` answer's
    `_meta`. Three answers, because two of them are different kinds of nothing:
    a reading; `null`, the runtime measured and found no call it could stand
    behind (a gateway that buffered the whole answer) — which must also keep
    the decode clock from timing that same output; and `undefined`, a runtime
    that measures nothing or sent a half-record, dropped rather than repaired
    like `parseSessionFailure`. */
export function generationFromMeta(meta: unknown): TurnGeneration | null | undefined {
  const own = (meta as { daedalus?: Record<string, unknown> } | null | undefined)?.daedalus;
  if (!own || !("generation" in own)) return undefined;
  const raw = own.generation;
  if (raw === null) return null;
  if (typeof raw !== "object") return undefined;
  const { outputTokens, decodeMs, waits } = raw as Record<string, unknown>;
  const said = waitsFromMeta(waits);
  if (typeof outputTokens === "number" && outputTokens > 0 && typeof decodeMs === "number" && decodeMs > 0) {
    return { outputTokens, decodeMs, ...(said ? { waits: said } : {}) };
  }
  return said ? { outputTokens: 0, decodeMs: 0, waits: said } : undefined;
}

/** The waits off a generation record: a positive total and any named part that
    is a positive number, or nothing. */
function waitsFromMeta(raw: unknown): TurnWaits | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { totalMs, heldMs, compactMs, retryMs } = raw as Record<string, unknown>;
  if (typeof totalMs !== "number" || !(totalMs > 0)) return undefined;
  const part = (ms: unknown) => (typeof ms === "number" && ms > 0 ? ms : undefined);
  return {
    totalMs,
    ...(part(heldMs) ? { heldMs: heldMs as number } : {}),
    ...(part(compactMs) ? { compactMs: compactMs as number } : {}),
    ...(part(retryMs) ? { retryMs: retryMs as number } : {}),
  };
}

/** What a turn that threw had already spent. The runtime rides it on the
    error's `data.daedalus` (a rejected prompt has no response to carry it);
    the error that goes on to be drawn is returned without it. */
export function spendFromError(error: WireError): {
  error: WireError;
  usage: acp.Usage | null;
  generation?: TurnGeneration | null;
} {
  const data = error.data as { daedalus?: { usage?: unknown; generation?: unknown } } | null | undefined;
  const spend = data && typeof data === "object" ? data.daedalus : undefined;
  if (!spend || typeof spend !== "object") return { error, usage: null };
  const { daedalus: _spend, ...rest } = data as Record<string, unknown>;
  const usage = spend.usage as acp.Usage | undefined;
  return {
    error: { ...error, data: Object.keys(rest).length > 0 ? rest : undefined },
    usage: usage && typeof usage === "object" && typeof usage.totalTokens === "number" ? usage : null,
    generation: "generation" in spend ? generationFromMeta({ daedalus: { generation: spend.generation } }) : undefined,
  };
}
