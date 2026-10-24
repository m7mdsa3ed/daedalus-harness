import type * as acp from "./acp.js";
import type { LanguageModelCallEndEvent, LanguageModelUsage } from "ai";

/* ── What a turn spent, and how fast it wrote it ──
 *
 * Everything the turn reports about tokens and speed is read off one place:
 * the AI SDK's `onLanguageModelCallEnd`, which fires once per provider call
 * after the response is parsed and *before* any tool runs. That timing is the
 * point. `finish-step` and `finish` arrive only after a step's tools have run
 * and never arrive for a stream that was aborted, so a turn cancelled during a
 * tool call used to answer `usage: null` for model calls the provider had
 * already billed. A call is metered the moment it answers.
 */

/** What one model call wrote and how long the model spent writing it. Mirrors
    `TurnGeneration` in the server's `protocol.ts`; the pair is the wire shape
    of `PromptResponse._meta.daedalus.generation`. */
export interface TurnGeneration {
  outputTokens: number;
  decodeMs: number;
  waits?: TurnWaits;
}

/** The time between a turn's model requests, and what part of it the agent can
    name. Mirrors `TurnWaits` in the server's `protocol.ts`. What is left of
    `totalMs` once the named parts are out is the tools (their approvals
    included) and the harness's own work. */
export interface TurnWaits {
  totalMs: number;
  heldMs?: number;
  compactMs?: number;
  retryMs?: number;
}

export type WaitCause = "heldMs" | "compactMs" | "retryMs";

/** What one model request's wait was made of, stamped on the first tool call it
    made (`_meta.daedalus.lead`): the causes booked since the request before it,
    how long the model took to its first output, and how long it wrote before
    the call opened. What the client's gap has beyond these is the tools
    settling and the harness's own work. */
export interface StepLead extends Partial<Record<WaitCause, number>> {
  ttftMs?: number;
  writeMs?: number;
}

export type CallMetering = Pick<LanguageModelCallEndEvent, "usage" | "performance"> &
  Partial<Pick<LanguageModelCallEndEvent, "content">>;

const sum = (x: number | undefined, y: number | undefined): number | undefined =>
  x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);

const firstNumber = (...values: unknown[]): number | undefined => {
  for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
};

export function totalOf(usage: LanguageModelUsage): number {
  return usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

/* The OpenAI-compatible provider hard-codes `cacheWrite: undefined`, because
   `/chat/completions` has no standard field for a write, so a gateway that
   reports one is read here, off the provider's own body (`usage.raw`), and put
   in the standard slot. Two shapes exist, and what separates them is whether
   `prompt_tokens` already counts the write:
   - `prompt_tokens_details.cache_write_tokens` / `cache_creation_tokens`
     (OpenRouter and the like) — inside `prompt_tokens`, like the read.
   - a top-level `cache_creation_input_tokens`, Anthropic's own field name
     (9Router and other Anthropic-fronting gateways) — *beside* it. Measured:
     the call that wrote 17,525 tokens answered `prompt_tokens: 11`, and the
     next one, reading them, answered 17,536. The gateway says so itself with
     `prompt_tokens_details.cache_creation_in_prompt: false`; only an explicit
     `true` makes it an inside count. Not reading this left the first request
     of every thread drawn as a few dozen tokens and 0% cache, and the context
     ring a fraction of what the window actually held. */
export function normalizeUsage(usage: LanguageModelUsage): LanguageModelUsage {
  const details = usage.inputTokenDetails;
  if (details?.cacheWriteTokens !== undefined) return usage;
  const raw = usage.raw as
    | { prompt_tokens_details?: Record<string, unknown>; cache_creation_input_tokens?: unknown }
    | undefined;
  const prompt = usage.inputTokens;
  const read = details?.cacheReadTokens ?? 0;
  const beside = firstNumber(raw?.cache_creation_input_tokens);
  const inside =
    firstNumber(raw?.prompt_tokens_details?.cache_write_tokens, raw?.prompt_tokens_details?.cache_creation_tokens) ??
    (raw?.prompt_tokens_details?.cache_creation_in_prompt === true ? beside : undefined);
  if (inside !== undefined) {
    return {
      ...usage,
      inputTokenDetails: {
        ...details,
        cacheWriteTokens: inside,
        noCacheTokens: prompt === undefined ? details?.noCacheTokens : Math.max(0, prompt - read - inside),
      },
    };
  }
  if (beside === undefined || beside <= 0) return usage;
  return {
    ...usage,
    inputTokens: (prompt ?? 0) + beside,
    totalTokens: (usage.totalTokens ?? (prompt ?? 0) + (usage.outputTokens ?? 0)) + beside,
    inputTokenDetails: {
      ...details,
      cacheWriteTokens: beside,
      noCacheTokens: details?.noCacheTokens ?? Math.max(0, (prompt ?? 0) - read),
    },
  };
}

/* One turn, one usage figure, however many calls and attempts it took. Summed
   field by field rather than by `totalTokens` alone, because every one of them
   is drawn separately — the cache rate above all (`toAcpUsage`). `raw` is one
   provider response's own body and means nothing summed, so it is dropped. */
export function addUsage(a: LanguageModelUsage | null, b: LanguageModelUsage): LanguageModelUsage {
  if (!a) return b;
  return {
    ...a,
    inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    totalTokens: sum(a.totalTokens, b.totalTokens),
    inputTokenDetails: {
      noCacheTokens: sum(a.inputTokenDetails?.noCacheTokens, b.inputTokenDetails?.noCacheTokens),
      cacheReadTokens: sum(a.inputTokenDetails?.cacheReadTokens, b.inputTokenDetails?.cacheReadTokens),
      cacheWriteTokens: sum(a.inputTokenDetails?.cacheWriteTokens, b.inputTokenDetails?.cacheWriteTokens),
    },
    outputTokenDetails: {
      ...a.outputTokenDetails,
      textTokens: sum(a.outputTokenDetails?.textTokens, b.outputTokenDetails?.textTokens),
      reasoningTokens: sum(a.outputTokenDetails?.reasoningTokens, b.outputTokenDetails?.reasoningTokens),
    },
    raw: undefined,
  };
}

/* `inputTokens` in this protocol is the part of the prompt the provider had to
   read *fresh* — the client adds the cache figures back to it to draw "the
   prompt" and divides by that sum to draw the cache rate (`lib/tokens.ts`).
   OpenAI-compatible `prompt_tokens`, which is all this runtime ever speaks,
   means the opposite: it is the whole prompt with the cache read (and a
   gateway's cache write) counted inside it. Reported raw, every cached token
   was counted twice — a turn that really hit cache on 89% of its prompt was
   drawn as 47%, and no amount of caching could ever have moved it past 50%.
   Subtract both, floor at zero for a provider that ever reports more cache than
   prompt. */
export function toAcpUsage(usage: LanguageModelUsage | null): acp.Usage | null {
  if (!usage) return null;
  const read = usage.inputTokenDetails?.cacheReadTokens ?? null;
  const write = usage.inputTokenDetails?.cacheWriteTokens ?? null;
  return {
    totalTokens: totalOf(usage),
    inputTokens: Math.max(0, (usage.inputTokens ?? 0) - (read ?? 0) - (write ?? 0)),
    outputTokens: usage.outputTokens ?? 0,
    thoughtTokens: usage.outputTokenDetails?.reasoningTokens ?? null,
    cachedReadTokens: read,
    cachedWriteTokens: write,
  };
}

/* A call whose output landed in one burst after a long silence was *buffered*
   — by a gateway that holds the answer until it is whole, or by a model that
   thought for seconds first — and the span after its first chunk is not the
   time the tokens took to write, it is how long the network took to hand over
   what was already written. Dividing by it read a 683-token answer as 4,646
   tok/s (a gateway released ~66 chunks in 60ms, six seconds after the tool
   result). Real decoding is never a small fraction of the wait that preceded
   it *and* the answer's own length; a call whose decode is under a tenth of its
   time to first output is left out, and the turn's labelled wall-clock
   throughput stands in for it. */
const BURST_RATIO = 10;

/* The model's own writing time for one call, or nothing when it cannot be told.
   The SDK's `timeToFirstOutputMs` counts the first chunk of *any* output —
   text, reasoning or the opening of a tool call's arguments — so the span after
   it is the stretch in which the call's streamed tokens were produced, tool
   arguments included. Three things keep the ratio honest:
   - reasoning the provider billed but never streamed was written *before* the
     first chunk, so its tokens are taken out of the numerator (the time it took
     is already in the time to first output);
   - a call that arrived as one chunk has no decode to divide by;
   - a buffered call (`BURST_RATIO`) has a decode that measures delivery, not
     writing. */
export function generationOf(call: CallMetering): TurnGeneration | undefined {
  const { timeToFirstOutputMs, responseTimeMs, timeBetweenOutputChunksMs } = call.performance;
  if (timeToFirstOutputMs === undefined || timeBetweenOutputChunksMs === undefined) return undefined;
  const decodeMs = responseTimeMs - timeToFirstOutputMs;
  if (!(decodeMs > 0) || decodeMs * BURST_RATIO < timeToFirstOutputMs) return undefined;
  const reasoningStreamed = call.content?.some((part) => part.type === "reasoning") ?? true;
  const hidden = reasoningStreamed ? 0 : (call.usage.outputTokenDetails?.reasoningTokens ?? 0);
  const output = (call.usage.outputTokens ?? 0) - hidden;
  return output > 0 ? { outputTokens: output, decodeMs: Math.round(decodeMs) } : undefined;
}

/** A turn's running tally. One per turn; a subagent's calls are recorded on its
    own attempt's meter and on the parent's, so the child's card and the
    turn's bill both come out of the same calls. */
export class Meter {
  usage: LanguageModelUsage | null = null;
  generation: TurnGeneration | undefined;
  /* When each root-loop request was in flight, on the performance clock. A
     call is placed by its end (when the SDK reports it) less its own length. */
  private spans: Array<[number, number]> = [];
  private causes: Record<WaitCause, number> = { heldMs: 0, compactMs: 0, retryMs: 0 };
  private taken: Record<WaitCause, number> = { heldMs: 0, compactMs: 0, retryMs: 0 };

  /** The cause time booked since the last call, per cause — one request's lead. */
  take = (): Partial<Record<WaitCause, number>> => {
    const out: Partial<Record<WaitCause, number>> = {};
    for (const cause of Object.keys(this.causes) as WaitCause[]) {
      const ms = Math.round(this.causes[cause] - this.taken[cause]);
      this.taken[cause] = this.causes[cause];
      if (ms > 0) out[cause] = ms;
    }
    return out;
  };

  /** Place a root-loop request on the clock. Only the loop's own calls: a
      subagent's run inside the parent's tool call and would hide the very
      wait the tool made. */
  span = (call: CallMetering): void => {
    const end = performance.now();
    this.spans.push([end - call.performance.responseTimeMs, end]);
  };

  /** Run `work` and book its time to `cause`. Counted only once a request has
      answered — before that there is no "between" for it to be in. */
  async during<T>(cause: WaitCause, work: () => Promise<T>): Promise<T> {
    const counts = this.spans.length > 0;
    const started = performance.now();
    try {
      return await work();
    } finally {
      if (counts) this.causes[cause] += performance.now() - started;
    }
  }

  /** Time between the first request starting and the last one ending that no
      request was in flight for. Overlapping requests count once. */
  waits(): TurnWaits | undefined {
    if (this.spans.length < 2) return undefined;
    const spans = [...this.spans].sort((a, b) => a[0] - b[0]);
    let busy = 0;
    let [from, to] = spans[0];
    let last = to;
    for (const [start, end] of spans.slice(1)) {
      if (start > to) {
        busy += to - from;
        from = start;
        to = end;
      } else to = Math.max(to, end);
      last = Math.max(last, end);
    }
    busy += to - from;
    const totalMs = Math.round(last - spans[0][0] - busy);
    if (totalMs <= 0) return undefined;
    const named = (cause: WaitCause) => {
      const ms = Math.min(totalMs, Math.round(this.causes[cause]));
      return ms > 0 ? { [cause]: ms } : {};
    };
    return { totalMs, ...named("heldMs"), ...named("compactMs"), ...named("retryMs") };
  }

  /** What the turn reports about its model calls, or `null` when it can say
      nothing. A record with no tokens is a turn that has waits and no speed. */
  reading(): TurnGeneration | null {
    const waits = this.waits();
    if (!this.generation && !waits) return null;
    return { outputTokens: 0, decodeMs: 0, ...this.generation, ...(waits ? { waits } : {}) };
  }

  record = (call: CallMetering): void => {
    this.usage = addUsage(this.usage, normalizeUsage(call.usage));
    const generation = generationOf(call);
    if (generation) {
      this.generation = {
        outputTokens: (this.generation?.outputTokens ?? 0) + generation.outputTokens,
        decodeMs: (this.generation?.decodeMs ?? 0) + generation.decodeMs,
      };
    }
  };

  /** The `_meta` a `session/prompt` answer carries. Always said, `null` when
      no call could be timed: that is the runtime telling the harness it
      measured and found nothing, which is not the same as a runtime that
      measures nothing — only the first must stop the harness's own clock from
      timing the same buffered output and drawing the number this refused. */
  meta(): { daedalus: { generation: TurnGeneration | null } } {
    return { daedalus: { generation: this.reading() } };
  }
}
