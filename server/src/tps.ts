import type { TpsStats, TurnGeneration } from "./protocol.js";

/**
 * Output speed — one pure function, run at both ends.
 *
 * A module of its own for the reason `delivery.ts` is: `protocol.ts` is
 * type-only for the browser, and this is a *function* the server (the row it
 * persists) and the client (the live fold before `caught_up` replaces it) both
 * run, so the two must not drift.
 *
 * Two readings, never mixed in one figure:
 *   - **generation** — output tokens over the time the model spent writing
 *     them (`TurnGeneration`, measured off the turn's model spans). This is
 *     the speed. Tool calls, prefill, permission waits and holds are not in it.
 *   - **throughput** — output tokens over the turn's wall clock. Kept for the
 *     turns that have no generation (a runtime the harness cannot time, a
 *     journal from before it measured), and never drawn as "speed" beside a
 *     generation figure.
 *
 * `min`/`max` follow whichever reading the stats are in. The first turn with a
 * generation switches a thread over and drops the throughput extrema, which
 * were a different quantity; after that a turn without one leaves them alone.
 */
export interface TurnReading {
  outputTokens: number;
  durationMs?: number;
  toolDurationMs?: number;
  generation?: TurnGeneration;
}

const rateOf = (tokens: number, ms: number): number | null => {
  const rate = (tokens * 1000) / ms;
  return tokens > 0 && ms > 0 && Number.isFinite(rate) ? rate : null;
};

/** A model span's time to first token in ms: the harness's own reading
    (`daedalus.ttft_ms`, also what the OTLP intake writes), else the AI SDK's
    GenAI attribute, which is in seconds. */
export function ttftMsOf(attributes: Record<string, unknown>): number | null {
  const ms = attributes["daedalus.ttft_ms"];
  if (typeof ms === "number" && Number.isFinite(ms)) return ms;
  const s = attributes["gen_ai.client.operation.time_to_first_chunk"];
  return typeof s === "number" && Number.isFinite(s) ? s * 1000 : null;
}

/** One finished model span's share of a turn's generation, or null when it
    cannot be timed: no output count, no first-token time, or no decode left. */
export function spanGeneration(span: {
  start: number;
  end: number | null;
  attributes: Record<string, unknown>;
}): TurnGeneration | null {
  if (span.end === null) return null;
  const output = span.attributes["gen_ai.usage.output_tokens"];
  const ttft = ttftMsOf(span.attributes);
  if (typeof output !== "number" || !(output > 0) || ttft === null) return null;
  const decodeMs = span.end - span.start - ttft;
  return decodeMs > 0 ? { outputTokens: output, decodeMs } : null;
}

export function generationRate(generation: TurnGeneration | undefined): number | null {
  return generation ? rateOf(generation.outputTokens, generation.decodeMs) : null;
}

export function addTps(stats: TpsStats | null, turn: TurnReading): TpsStats | null {
  const wall = turn.durationMs !== undefined ? rateOf(turn.outputTokens, turn.durationMs) : null;
  const gen = generationRate(turn.generation);
  if (wall === null && gen === null) return stats;

  const base: TpsStats = stats ?? { min: 0, max: 0, outputTokens: 0, durationMs: 0 };
  const next: TpsStats = { ...base };
  if (wall !== null) {
    next.outputTokens = base.outputTokens + turn.outputTokens;
    next.durationMs = base.durationMs + turn.durationMs!;
  }
  if (turn.toolDurationMs !== undefined) next.toolDurationMs = (base.toolDurationMs ?? 0) + turn.toolDurationMs;

  const inGeneration = base.decodeMs !== undefined;
  if (gen !== null) {
    const first = !stats || !inGeneration;
    next.min = first ? gen : Math.min(base.min, gen);
    next.max = first ? gen : Math.max(base.max, gen);
    next.generatedTokens = (base.generatedTokens ?? 0) + turn.generation!.outputTokens;
    next.decodeMs = (base.decodeMs ?? 0) + turn.generation!.decodeMs;
  } else if (!inGeneration) {
    next.min = stats ? Math.min(base.min, wall!) : wall!;
    next.max = stats ? Math.max(base.max, wall!) : wall!;
  }
  return next;
}

/** The thread's average, token-weighted, and which reading it is. */
export function tpsAverage(stats: TpsStats | null): { rate: number; kind: "generation" | "throughput" } | null {
  if (!stats) return null;
  if (stats.decodeMs !== undefined) {
    const rate = rateOf(stats.generatedTokens ?? 0, stats.decodeMs);
    return rate === null ? null : { rate, kind: "generation" };
  }
  const rate = rateOf(stats.outputTokens, stats.durationMs);
  return rate === null ? null : { rate, kind: "throughput" };
}
