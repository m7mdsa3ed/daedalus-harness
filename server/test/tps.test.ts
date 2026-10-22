// Self-check for output speed (src/tps.ts), which both ends fold per turn.
//
//   - a model span's generation is its duration less its first-token time, and
//     the AI SDK's seconds attribute reads the same as the harness's ms one.
//   - a turn with a generation is measured on it, not on the wall clock: a turn
//     that spent most of its time in tools is not "slow".
//   - the first measured turn switches the thread's extrema over; a later turn
//     with no generation does not drag them back toward throughput.
//   - the average is token-weighted.
// Run: pnpm test:tps
import "./require-temp-data.js";
import assert from "node:assert/strict";

const { addTps, spanGeneration, tpsAverage, generationRate } = await import("../src/tps.js");

// --- spans ---
assert.deepEqual(
  spanGeneration({ start: 0, end: 3_000, attributes: { "gen_ai.usage.output_tokens": 200, "daedalus.ttft_ms": 1_000 } }),
  { outputTokens: 200, decodeMs: 2_000 },
);
assert.deepEqual(
  spanGeneration({ start: 0, end: 3_000, attributes: { "gen_ai.usage.output_tokens": 200, "gen_ai.client.operation.time_to_first_chunk": 1 } }),
  { outputTokens: 200, decodeMs: 2_000 },
  "the AI SDK's TTFT is in seconds",
);
assert.equal(spanGeneration({ start: 0, end: 3_000, attributes: { "gen_ai.usage.output_tokens": 200 } }), null, "no TTFT, no decode time");
assert.equal(spanGeneration({ start: 0, end: null, attributes: { "gen_ai.usage.output_tokens": 200, "daedalus.ttft_ms": 1 } }), null);
assert.equal(spanGeneration({ start: 0, end: 500, attributes: { "gen_ai.usage.output_tokens": 200, "daedalus.ttft_ms": 900 } }), null);

// --- one turn: 1,000 tokens in 50s of wall clock, 10s of it writing ---
const turn = { outputTokens: 1_000, durationMs: 50_000, toolDurationMs: 35_000, generation: { outputTokens: 1_000, decodeMs: 10_000 } };
let stats = addTps(null, turn)!;
assert.equal(generationRate(turn.generation), 100);
assert.equal(stats.min, 100, "the speed is generation, not 20 tok/s of wall clock");
assert.deepEqual(tpsAverage(stats), { rate: 100, kind: "generation" });
assert.equal(stats.durationMs, 50_000, "throughput inputs are still summed");
assert.equal(stats.toolDurationMs, 35_000);

// --- a thread that started on throughput switches over on its first measured turn ---
let old = addTps(null, { outputTokens: 100, durationMs: 10_000 })!;
assert.deepEqual(tpsAverage(old), { rate: 10, kind: "throughput" });
old = addTps(old, turn)!;
assert.equal(old.min, 100, "throughput extrema are dropped, not mixed in");
assert.equal(old.max, 100);
old = addTps(old, { outputTokens: 50, durationMs: 50_000 })!;
assert.equal(old.min, 100, "a later unmeasured turn leaves generation extrema alone");
assert.equal(tpsAverage(old)!.kind, "generation");

// --- weighted: a tiny fast turn does not pull a big slow one up to the mean ---
stats = addTps(null, { outputTokens: 4_000, durationMs: 1, generation: { outputTokens: 4_000, decodeMs: 100_000 } })!; // 40 tok/s
stats = addTps(stats, { outputTokens: 20, durationMs: 1, generation: { outputTokens: 20, decodeMs: 100 } })!; // 200 tok/s
assert.equal(stats.min, 40);
assert.equal(stats.max, 200);
assert.ok(Math.abs(tpsAverage(stats)!.rate - (4_020 * 1000) / 100_100) < 1e-9, "token-weighted, not (40+200)/2");

// --- nothing to divide ---
assert.equal(addTps(null, { outputTokens: 0, durationMs: 1_000 }), null);
assert.equal(addTps(null, { outputTokens: 10 }), null);
assert.equal(tpsAverage(null), null);

console.log("tps: ok");
