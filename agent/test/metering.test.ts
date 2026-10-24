// What a turn reports about tokens and speed (src/metering.ts, turn.ts):
//   - usage is metered per model call as it answers, so a turn cancelled in
//     the middle of a tool call still reports the calls that were billed
//   - the prompt is derived without double-counting cache reads or writes, and
//     a gateway's cache write (prompt_tokens_details) is lifted into the slot
//   - speed comes from the SDK's per-call timing, counts tool-argument tokens,
//     and leaves out a call that arrived as one chunk
//   - a turn that throws still hands its spend to the harness
// Run: pnpm test:metering
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { buildAgentApp } from "../src/app.js";
import { Meter, addUsage, generationOf, normalizeUsage, toAcpUsage } from "../src/metering.js";
import { connectPair, initialize, makeClient, promptOf, scriptedModel, testEnv, textScript, toolCallScript } from "./helpers/scripted.js";

const cwd = mkdtempSync(join(tmpdir(), "daedalus-agent-metering-"));

const cachedUsage = (total: number, read: number, write: number | undefined, out: number, raw?: object): LanguageModelV4Usage =>
  ({
    inputTokens: { total, noCache: total - read - (write ?? 0), cacheRead: read, cacheWrite: write },
    outputTokens: { total: out, text: out, reasoning: undefined },
    ...(raw ? { raw } : {}),
  }) as LanguageModelV4Usage;

const withUsage = (script: LanguageModelV4StreamPart[], usage: LanguageModelV4Usage): LanguageModelV4StreamPart[] => [
  ...script.slice(0, -1),
  { ...(script.at(-1) as object), usage } as LanguageModelV4StreamPart,
];

const sdkUsage = (inputTokens: number, cacheRead: number, cacheWrite: number | undefined, outputTokens: number, raw?: object) =>
  ({
    inputTokens,
    inputTokenDetails: { noCacheTokens: inputTokens - cacheRead - (cacheWrite ?? 0), cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
    outputTokens,
    outputTokenDetails: { textTokens: outputTokens, reasoningTokens: undefined },
    totalTokens: inputTokens + outputTokens,
    raw,
  }) as never;

// --- the prompt is never counted twice ---
{
  const usage = toAcpUsage(sdkUsage(1100, 1000, 40, 30))!;
  assert.equal(usage.inputTokens, 60, "fresh = prompt - read - write");
  assert.equal(usage.cachedReadTokens, 1000);
  assert.equal(usage.cachedWriteTokens, 40);
  assert.equal(usage.inputTokens + usage.cachedReadTokens! + usage.cachedWriteTokens!, 1100, "the three add back to the prompt");
  assert.equal(toAcpUsage(sdkUsage(100, 150, undefined, 1))!.inputTokens, 0, "never negative");
  console.log("metering: prompt split ok");
}

// --- a gateway's cache write is lifted from prompt_tokens_details ---
{
  const raw = { prompt_tokens: 1100, prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 40 } };
  const lifted = normalizeUsage(sdkUsage(1100, 1000, undefined, 30, raw));
  assert.equal(lifted.inputTokenDetails.cacheWriteTokens, 40);
  assert.equal(lifted.inputTokenDetails.noCacheTokens, 60);
  const anthropicShaped = normalizeUsage(sdkUsage(500, 0, undefined, 1, { prompt_tokens_details: { cache_creation_tokens: 200 } }));
  assert.equal(anthropicShaped.inputTokenDetails.cacheWriteTokens, 200);
  // The measured shape of a cache-creating call through the gateway: the write is
  // beside prompt_tokens, not inside it.
  const created = normalizeUsage(
    sdkUsage(11, 0, undefined, 8, { prompt_tokens: 11, cache_creation_input_tokens: 17525, prompt_tokens_details: { cache_creation_in_prompt: false } }),
  );
  assert.equal(created.inputTokens, 17536, "the prompt is the fresh tokens plus the write");
  assert.equal(created.totalTokens, 17544);
  assert.equal(created.inputTokenDetails.cacheWriteTokens, 17525);
  const drawn = toAcpUsage(created)!;
  assert.deepEqual([drawn.inputTokens, drawn.cachedReadTokens, drawn.cachedWriteTokens], [11, 0, 17525], "fresh stays 11; nothing is counted twice");
  const counted = normalizeUsage(
    sdkUsage(17536, 0, undefined, 8, { cache_creation_input_tokens: 17525, prompt_tokens_details: { cache_creation_in_prompt: true } }),
  );
  assert.equal(counted.inputTokens, 17536, "a gateway that says the write is inside the prompt is believed");
  assert.equal(toAcpUsage(counted)!.inputTokens, 11);
  const reading = normalizeUsage(sdkUsage(17536, 17525, undefined, 8, { cache_read_input_tokens: 17525 }));
  assert.equal(reading.inputTokens, 17536, "a read-only call is untouched");
  const explicit = sdkUsage(10, 0, 3, 1, { prompt_tokens_details: { cache_write_tokens: 9 } });
  assert.equal(normalizeUsage(explicit).inputTokenDetails.cacheWriteTokens, 3, "a reading the SDK already made is not overruled");
  const summed = addUsage(sdkUsage(100, 50, undefined, 5), sdkUsage(200, 100, 10, 5));
  assert.equal(summed.inputTokenDetails.noCacheTokens, 50 + 90, "noCacheTokens is summed, not kept from the first call");
  assert.equal(summed.raw, undefined, "one response's body is not a sum");
  console.log("metering: cache write ok");
}

// --- speed: tool arguments are inside the window; a one-chunk call is out ---
{
  const timed = (output: number, ttft: number | undefined, response: number, gaps: boolean) =>
    ({
      usage: sdkUsage(10, 0, undefined, output),
      performance: {
        timeToFirstOutputMs: ttft,
        responseTimeMs: response,
        timeBetweenOutputChunksMs: gaps ? { count: 2, min: 1, max: 9, mean: 5, median: 5, p95: 9 } : undefined,
      },
    }) as never;
  assert.deepEqual(generationOf(timed(100, 500, 2500, true)), { outputTokens: 100, decodeMs: 2000 });
  assert.equal(generationOf(timed(100, 500, 502, false)), undefined, "a single chunk has no decode to divide by");
  assert.equal(generationOf(timed(100, undefined, 2500, true)), undefined, "no first-output time, no reading");
  assert.equal(generationOf(timed(0, 500, 2500, true)), undefined);
  // The measured failure: a gateway held a 555-token answer (297 of it reasoning it
  // never streamed) for 6.2s, then released it in a burst of ~60ms.
  const burst = {
    usage: sdkUsage(6033, 0, undefined, 555),
    performance: { timeToFirstOutputMs: 6229, responseTimeMs: 6354, timeBetweenOutputChunksMs: { count: 66, min: 0, max: 33, mean: 1, median: 0 } },
    content: [{ type: "text", text: "..." }],
  } as never;
  (burst as { usage: { outputTokenDetails: { reasoningTokens: number } } }).usage.outputTokenDetails.reasoningTokens = 297;
  assert.equal(generationOf(burst), undefined, "output that landed in one burst measures delivery, not writing");
  // Hidden reasoning is written before the first chunk: out of the tokens, already in the wait.
  const hiddenThinking = {
    usage: sdkUsage(1000, 0, undefined, 400),
    performance: { timeToFirstOutputMs: 3000, responseTimeMs: 6000, timeBetweenOutputChunksMs: { count: 50, min: 20, max: 90, mean: 60, median: 55 } },
    content: [{ type: "text", text: "..." }],
  } as never;
  (hiddenThinking as { usage: { outputTokenDetails: { reasoningTokens: number } } }).usage.outputTokenDetails.reasoningTokens = 100;
  assert.deepEqual(generationOf(hiddenThinking), { outputTokens: 300, decodeMs: 3000 }, "unstreamed reasoning is not counted in the decode");
  (hiddenThinking as { content: unknown }).content = [{ type: "reasoning", text: "..." }, { type: "text", text: "..." }];
  assert.deepEqual(generationOf(hiddenThinking), { outputTokens: 400, decodeMs: 3000 }, "streamed reasoning is inside the window and counts");
  const meter = new Meter();
  meter.record(timed(100, 500, 2500, true));
  meter.record(timed(50, 100, 1100, true));
  assert.deepEqual(meter.generation, { outputTokens: 150, decodeMs: 3000 });
  assert.deepEqual(meter.meta(), { daedalus: { generation: { outputTokens: 150, decodeMs: 3000 } } });
  assert.deepEqual(new Meter().meta(), { daedalus: { generation: null } }, "an unmeasurable turn says so");
  console.log("metering: generation ok");
}

// --- the wait between requests is the clock no request was in flight on ---
{
  const call = (responseTimeMs: number) => ({ usage: sdkUsage(1, 0, undefined, 1), performance: { responseTimeMs } }) as never;
  const meter = new Meter();
  meter.span(call(0));
  await meter.during("retryMs", () => new Promise((resolve) => setTimeout(resolve, 60)));
  meter.span(call(0));
  const waits = meter.waits()!;
  assert.ok(waits.totalMs >= 55 && waits.totalMs < 250, `the gap is the wait: ${waits.totalMs}`);
  assert.ok(waits.retryMs! >= 55 && waits.retryMs! <= waits.totalMs, "the named cause is part of it");
  assert.equal(waits.heldMs, undefined, "a cause that took no time is not said");
  assert.deepEqual(meter.reading()?.waits, waits);
  assert.equal(meter.reading()?.decodeMs, 0, "waits without a speed is a record with none");

  const overlapping = new Meter();
  overlapping.span(call(1000));
  overlapping.span(call(1000));
  assert.equal(overlapping.waits(), undefined, "overlapping requests leave no gap");
  const first = new Meter();
  await first.during("heldMs", () => new Promise((resolve) => setTimeout(resolve, 20)));
  first.span(call(0));
  assert.equal(first.reading(), null, "time before the first request is not between requests");
  const taking = new Meter();
  taking.span(call(0));
  await taking.during("heldMs", () => new Promise((resolve) => setTimeout(resolve, 20)));
  const lead = taking.take();
  assert.ok(lead.heldMs! >= 15, "a lead is the causes booked since the last one");
  assert.deepEqual(taking.take(), {}, "and is taken once");
  console.log("metering: waits ok");
}

// --- a turn cancelled during a tool call still reports the call that was billed ---
{
  const tool = withUsage(toolCallScript("bash", { command: "sleep 5" }), cachedUsage(1000, 900, undefined, 50));
  const agent = buildAgentApp({ env: testEnv(), makeModel: scriptedModel([tool]) });
  const { app: client } = makeClient();
  await connectPair(agent, client, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    await ctx.request("session/set_mode", { sessionId, modeId: "bypassPermissions" });
    const turn = ctx.request("session/prompt", { sessionId, prompt: promptOf("run it") });
    await new Promise((r) => setTimeout(r, 400));
    await ctx.notify("session/cancel", { sessionId });
    const response = await turn;
    assert.equal(response.stopReason, "cancelled");
    assert.equal(response.usage?.outputTokens, 50, "the billed call is not lost to the cancel");
    assert.equal(response.usage?.cachedReadTokens, 900);
    assert.equal(response.usage?.inputTokens, 100);
  });
  console.log("metering: cancel keeps spend ok");
}

// --- two steps add up, cache included ---
{
  const agent = buildAgentApp({
    env: testEnv(),
    makeModel: scriptedModel([
      withUsage(toolCallScript("bash", { command: "true" }), cachedUsage(1000, 900, undefined, 50)),
      withUsage(textScript("done "), cachedUsage(1100, 1000, undefined, 30)),
    ]),
  });
  const { app: client, harness } = makeClient();
  await connectPair(agent, client, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    await ctx.request("session/set_mode", { sessionId, modeId: "bypassPermissions" });
    const response = await ctx.request("session/prompt", { sessionId, prompt: promptOf("go") });
    assert.deepEqual(
      [response.usage?.inputTokens, response.usage?.cachedReadTokens, response.usage?.outputTokens],
      [200, 1900, 80],
    );
    const lead = (harness.updatesOf("tool_call")[0].update as { _meta?: { daedalus?: { lead?: Record<string, number> } } })._meta
      ?.daedalus?.lead;
    assert.ok(lead && typeof lead.ttftMs === "number" && typeof lead.writeMs === "number", "a step's first call says where its wait went");
  });
  console.log("metering: steps sum ok");
}

// --- a turn that throws reports what it spent on the error ---
{
  let calls = 0;
  const agent = buildAgentApp({
    env: testEnv(),
    makeModel: () =>
      new MockLanguageModelV4({
        doStream: async () => {
          if (calls++ === 0) {
            return { stream: convertArrayToReadableStream(withUsage(toolCallScript("bash", { command: "true" }), cachedUsage(500, 0, undefined, 40))) };
          }
          throw new Error("provider is down");
        },
      }),
  });
  const { app: client } = makeClient();
  await connectPair(agent, client, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    await ctx.request("session/set_mode", { sessionId, modeId: "bypassPermissions" });
    let thrown: { data?: { daedalus?: { usage?: { outputTokens?: number } } } } | undefined;
    await ctx.request("session/prompt", { sessionId, prompt: promptOf("go") }).catch((e) => {
      thrown = e;
    });
    assert.ok(thrown, "the prompt still fails");
    assert.equal(thrown?.data?.daedalus?.usage?.outputTokens, 40, "the failed turn's spend rides the error");
  });
  console.log("metering: failed turn keeps spend ok");
}

console.log("metering.test.ts passed");
