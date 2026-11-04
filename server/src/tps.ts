import type { ModelCall, TpsStats, TurnGeneration, TurnWaits } from "./protocol.js";

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
 *     them (`TurnGeneration`, measured off the thread's stream, `decode-clock.ts`). This is
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

export function generationRate(generation: TurnGeneration | undefined): number | null {
  return generation ? rateOf(generation.outputTokens, generation.decodeMs) : null;
}

const addWaits = (a: TurnWaits | undefined, b: TurnWaits): TurnWaits => ({
  totalMs: (a?.totalMs ?? 0) + b.totalMs,
  ...Object.fromEntries(
    (["heldMs", "compactMs", "retryMs"] as const)
      .map((key) => [key, (a?.[key] ?? 0) + (b[key] ?? 0)] as const)
      .filter(([, ms]) => ms > 0),
  ),
});

export function addTps(stats: TpsStats | null, turn: TurnReading): TpsStats | null {
  const wall = turn.durationMs !== undefined ? rateOf(turn.outputTokens, turn.durationMs) : null;
  const gen = generationRate(turn.generation);
  const waits = turn.generation?.waits;
  if (wall === null && gen === null && !waits) return stats;

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
  } else if (!inGeneration && wall !== null) {
    /* `stats` may exist for its waits alone, with no rate to take a min of. */
    const rated = base.outputTokens > 0;
    next.min = rated ? Math.min(base.min, wall) : wall;
    next.max = rated ? Math.max(base.max, wall) : wall;
  }
  if (waits) next.waits = addWaits(base.waits, waits);
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

/* A decode under a tenth of the wait before it measured delivery, not writing:
   a gateway that holds the answer until it is whole hands it over in one burst
   (the agent's own `BURST_RATIO`, metering.ts — applied here too because the
   proxy and OTLP doors cannot tell). */
const BURST_RATIO = 10;

/** One step's output speed — tokens per second after the first chunk, the
    figure benchmarks call output speed (Artificial Analysis, NVIDIA AIPerf's
    per-request decode). `null` where the door could not time a decode. */
export function stepRate(call: Pick<ModelCall, "billed" | "timing">): number | null {
  const { ttftMs, decodeMs, decodeTokens } = call.timing ?? {};
  if (decodeMs === undefined || (ttftMs !== undefined && decodeMs * BURST_RATIO < ttftMs)) return null;
  return rateOf(decodeTokens ?? call.billed.outputTokens, decodeMs);
}
