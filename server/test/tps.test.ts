// Self-check for output speed (src/tps.ts), which both ends fold per turn.
//
//   - a turn with a generation is measured on it, not on the wall clock: a turn
//     that spent most of its time in tools is not "slow".
//   - the first measured turn switches the thread's extrema over; a later turn
//     with no generation does not drag them back toward throughput.
//   - the average is token-weighted.
//   - the decode clock answers only for a turn it could see all of (no tool
//     call), and prefers the runtime's own reading when one is sent
//   - time to first token starts at the model's output, not at any update
// Run: pnpm test:tps
import "./require-temp-data.js";
import assert from "node:assert/strict";

const { addTps, tpsAverage, generationRate } = await import("../src/tps.js");

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

// --- the decode clock: prose only, never a numerator it cannot see ---
const { DecodeClock, generationFromMeta, spendFromError, isModelOutput } = await import("../src/decode-clock.js");
const chunk = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } as never;
const call = { sessionUpdate: "tool_call", toolCallId: "t", title: "t" } as never;
const usage = (output: number) => ({ totalTokens: output, inputTokens: 0, outputTokens: output }) as never;
{
  const clock = new DecodeClock();
  const real = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    clock.start();
    clock.onUpdate(chunk);
    now += 2_000;
    assert.deepEqual(clock.end(usage(200)), { outputTokens: 200, decodeMs: 2_000 }, "a prose-only turn is timed");

    clock.start();
    clock.onUpdate(chunk);
    now += 1_000;
    clock.onUpdate(call);
    now += 5_000;
    assert.equal(clock.end(usage(900)), undefined, "a turn with a tool call has output the clock cannot see");
  } finally {
    Date.now = real;
  }
}

// --- the runtime's own reading, and a failed turn's spend ---
assert.deepEqual(generationFromMeta({ daedalus: { generation: { outputTokens: 10, decodeMs: 500 } } }), { outputTokens: 10, decodeMs: 500 });
assert.equal(generationFromMeta({ daedalus: { generation: { outputTokens: 10 } } }), undefined, "a half-record is dropped");
assert.equal(generationFromMeta(null), undefined);
assert.equal(generationFromMeta({ daedalus: { generation: null } }), null, "a runtime that measured nothing says so, apart from one that measures nothing");
assert.equal(generationFromMeta({ daedalus: {} }), undefined);
{
  const spent = spendFromError({
    code: -32603,
    message: "boom",
    data: { stderr: "x", daedalus: { usage: { totalTokens: 7, inputTokens: 3, outputTokens: 4 }, generation: { outputTokens: 4, decodeMs: 100 } } },
  });
  assert.equal(spent.usage?.outputTokens, 4);
  assert.deepEqual(spent.generation, { outputTokens: 4, decodeMs: 100 });
  assert.deepEqual(spent.error.data, { stderr: "x" }, "the spend is taken off the error that gets drawn");
  const only = spendFromError({ code: 1, message: "m", data: { daedalus: { usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0 } } } });
  assert.equal(only.error.data, undefined);
  assert.equal(spendFromError({ code: 1, message: "m" }).usage, null);
}

// --- time to first token is the model's output, not the runtime's bookkeeping ---
assert.equal(isModelOutput(chunk), true);
assert.equal(isModelOutput(call), true);
assert.equal(isModelOutput({ sessionUpdate: "session_info_update", title: "t" } as never), false, "the title is sent before the model is called");
assert.equal(isModelOutput({ sessionUpdate: "current_mode_update", currentModeId: "default" } as never), false);
assert.equal(isModelOutput({ sessionUpdate: "usage_update", used: 1, size: 2 } as never), false);

console.log("tps: ok");
