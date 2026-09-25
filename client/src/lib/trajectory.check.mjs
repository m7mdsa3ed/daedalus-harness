/* The one runnable check behind the Trajectory's readers.

     ../server/node_modules/.bin/tsx src/lib/trajectory.check.mjs   (from client/)
*/
import assert from "node:assert"

import { buildTree, flatten, spanTiming, totals, visibleRows } from "./trajectory.ts"

const span = (spanId, parentSpanId, kind, start, end, attributes = {}, status = "ok") => ({
  traceId: "t",
  spanId,
  parentSpanId,
  sessionId: "s",
  name: `${kind} ${spanId}`,
  kind,
  source: "harness",
  start,
  end,
  status,
  attributes,
  events: [],
})

const spans = [
  span("m1", "r", "model", 10, 1010, {
    "gen_ai.client.operation.time_to_first_chunk": 0.2,
    "gen_ai.usage.input_tokens": 100,
    "gen_ai.usage.output_tokens": 80,
  }),
  span("turn", null, "turn", 0, 2000, { "gen_ai.usage.input_tokens": 999 }),
  span("r", "turn", "request", 5, 1990),
  span("t1", "r", "tool", 1100, 1300, { "gen_ai.tool.name": "read_file" }, "error"),
  span("orphan", "gone", "process", 3000, null),
]

const roots = buildTree(spans)
assert.deepStrictEqual(roots.map((n) => n.span.spanId), ["turn", "orphan"])
const rows = flatten(roots)
assert.deepStrictEqual(rows.map((n) => [n.span.spanId, n.depth]), [["turn", 0], ["r", 1], ["m1", 2], ["t1", 2], ["orphan", 0]])
assert.strictEqual(rows[2].root.spanId, "turn")
assert.deepStrictEqual(flatten(roots, new Set(["r"])).map((n) => n.span.spanId), ["turn", "r", "orphan"])

// TTFT in seconds becomes ms; decode is the rest; tok/s over the decode.
const timing = spanTiming(spans[0])
assert.deepStrictEqual(timing, { duration: 1000, ttft: 200, decode: 800, tps: 100 })
// The harness's own ms reading wins.
assert.strictEqual(spanTiming(span("x", null, "model", 0, 10, { "daedalus.ttft_ms": 3, "gen_ai.client.operation.time_to_first_chunk": 9 })).ttft, 3)

const t = totals(spans, 3500)
assert.strictEqual(t.turns, 1)
assert.strictEqual(t.modelCalls, 1)
assert.strictEqual(t.toolCalls, 1)
assert.strictEqual(t.errors, 1)
assert.strictEqual(t.modelTime, 1000)
assert.strictEqual(t.toolTime, 200)
// The turn's own usage is not added on top of its model span's.
assert.strictEqual(t.input, 100)
assert.strictEqual(t.avgTps, 100)

const byId = new Map(spans.map((s) => [s.spanId, s]))
assert.deepStrictEqual(visibleRows(rows, byId, "read_file", new Set()).map((n) => n.span.spanId), ["turn", "r", "t1"])
assert.deepStrictEqual(visibleRows(rows, byId, "", new Set(["tool"])).map((n) => n.span.spanId), ["turn", "r", "m1", "orphan"])

console.log("trajectory: ok")

// ── prompt changes ──
{
  const { diffLines, diffMessages, previousModelCall } = await import("./trajectory.ts")
  assert.deepStrictEqual(diffLines("a\nb\nc", "a\nx\nc"), [
    { op: "same", text: "a" },
    { op: "del", text: "b" },
    { op: "add", text: "x" },
    { op: "same", text: "c" },
  ])
  assert.ok(diffLines("same", "same").every((l) => l.op === "same"))
  const d = diffMessages([{ r: 1 }, { r: 2 }], [{ r: 1 }, { r: 2 }, { r: 3 }])
  assert.deepStrictEqual(d, { kept: 2, removed: [], added: [{ r: 3 }] })
  assert.deepStrictEqual(diffMessages([{ r: 1 }, { r: 2 }], [{ r: 9 }]).removed.length, 2)

  const call = (spanId, traceId, start, agent = "daedalus.turn") => ({
    ...span(spanId, null, "model", start, start + 1, {
      "gen_ai.input.messages": "[]",
      "gen_ai.agent.name": agent,
    }),
    traceId,
  })
  const calls = [call("a1", "T1", 1), call("a2", "T1", 2), call("sub", "T2", 3, "daedalus.subagent"), call("b1", "T2", 4), call("b2", "T2", 5)]
  const b2 = calls[4]
  assert.strictEqual(previousModelCall(calls, b2, "call").spanId, "b1", "the call before, same agent")
  assert.strictEqual(previousModelCall(calls, b2, "turn").spanId, "a2", "the last call of the turn before")
  assert.strictEqual(previousModelCall(calls, calls[0], "call"), null)
}
console.log("prompt diff: ok")
