/* The one runnable check behind the Tokens panel's arithmetic.

     ../server/node_modules/.bin/tsx src/lib/token-breakdown.check.mjs   (from client/)
*/
import assert from "node:assert/strict"
import { promptParts, requestDetail, spanPromptParts, spendTime, subagentSpend, sumPromptParts, tokensByTurn } from "./token-breakdown.ts"
import { applySessionUpdate } from "./store/session-update.ts"
const total = (rows) => rows.reduce((n, r) => n + r.tokens, 0)
const tool = (id, title, out) => ({ kind: "tool", id, name: "read_file", title, rawInput: { path: title }, content: [{ type: "content", content: { type: "text", text: out } }], locations: [], status: "completed", startedAt: 0 })
const items = [
  { kind: "user", id: "u1", text: "a".repeat(400), turnId: "t1" },
  tool("k1", "Read a.ts", "b".repeat(2000)),
  tool("k2", "Read b.ts", "b".repeat(600)),
  { kind: "agent", id: "a1", text: "c".repeat(800) },
]
// --- inferred (another runtime) ---
const { turns, entries } = tokensByTurn(items, { a1: { used: 5000, size: 100000 } }, {})
const step = turns[0].steps[0]
const one = promptParts(step)
assert.ok(one.inferred)
assert.equal(total(Object.values(one.parts).map((tokens) => ({ tokens }))), 5000, "parts sum to used")
assert.ok(one.parts.overhead > 3000, "overhead is the remainder")
const tight = promptParts({ ...step, update: { used: 100, size: 1 } })
assert.ok(tight.parts.overhead <= 2, "only rounding is left over")
assert.equal(promptParts({ ...step, update: { used: 0, size: 1 } }), null)
assert.equal(sumPromptParts([step]).inferred, 1)
const d = requestDetail(turns[0].steps, 0, entries, one.parts)
const results = d.results
assert.equal(results.length, 1, "both reads fold under one tool")
assert.equal(results[0].children.length, 2)
assert.ok(results[0].children[0].tokens > results[0].children[1].tokens, "biggest first")
assert.ok(Math.abs(total(results) - one.parts.results) <= 1, "a part's rows add to the part")
assert.ok(Math.abs(total(d.user) - one.parts.user) <= 1)
// --- measured (our runtime), with the prefix item list ---
const meta = { daedalus: { breakdown: { total: 9000, system: 3000, tools: 2000, mcp: 1000, conversation: 3000, user: 500, assistant: 1000, results: 1500,
  items: { system: [{ name: "Core instructions › General", tokens: 50 }, { name: "Core instructions › Planning", tokens: 150 }, { name: "Rules", tokens: 100 }],
           tools: [{ name: "bash", tokens: 30 }, { name: "read_file", tokens: 10 }],
           mcp: [{ name: "mcp__gh__issue", tokens: 5 }, { name: "mcp__gh__pr", tokens: 5 }, { name: "mcp__web__search", tokens: 10 }] } } } }
const m = tokensByTurn(items, { a1: { used: 9000, size: 100000, _meta: meta } }, {})
const mp = promptParts(m.turns[0].steps[0])
assert.equal(mp.inferred, false)
const md = requestDetail(m.turns[0].steps, 0, m.entries, mp.parts)
assert.equal(total(md.system), 3000, "sections scale to the measured system figure")
const core = md.system.find((r) => r.name === "Core instructions")
assert.equal(core.children.length, 2, "headings fold under their section")
assert.equal(core.tokens, 2000)
assert.deepEqual(md.tools.map((r) => r.name), ["bash", "read_file"])
assert.equal(md.tools[0].tokens, 1500)
assert.equal(md.mcp.find((r) => r.name === "gh").children.length, 2, "MCP tools fold by server")
// a later step without items reuses the newest list before it
const two = tokensByTurn([...items, { kind: "agent", id: "a2", text: "more" }], { a1: { used: 9000, size: 1, _meta: meta }, a2: { used: 9100, size: 1, _meta: { daedalus: { breakdown: { ...meta.daedalus.breakdown, items: undefined } } } } }, {})
const p2 = promptParts(two.turns[0].steps[1])
assert.equal(total(requestDetail(two.turns[0].steps, 1, two.entries, p2.parts).tools), 2000, "item lists carry forward")
// --- steps carry what they produced and the turn they ran in ---
{
  const flat = tokensByTurn(
    [{ ...items[0], at: 1_000 }, ...items.slice(1), { kind: "user", id: "u2", text: "again", turnId: "t2", at: 60_000 }, tool("k3", "Edit c.ts", "ok")],
    { k1: { used: 100, size: 1 }, a1: { used: 200, size: 1 }, k3: { used: 300, size: 1 } },
    {},
    { k1: 4_000, a1: 9_000, k3: 62_000 }
  ).turns.flatMap((turn) => turn.steps)
  assert.deepEqual(flat.map((s) => [s.label, s.turn]), [["Read a.ts", 1], ["c".repeat(60) + "…", 1], ["Edit c.ts", 2]])
  // from the message, then from the step before; the new turn's message resets the clock
  assert.deepEqual(flat.map((s) => s.durationMs), [3_000, 5_000, 2_000])
}
// --- subagent time: summed over wakes, idle gap and a restated end excluded ---
{
  const up = (list, update, stamp) => applySessionUpdate(list, update, false, undefined, stamp)
  const spawn = { sessionUpdate: "subagent_spawned", subagentSessionId: "c1", name: "child", task: "t" }
  const end = { sessionUpdate: "subagent_state_update", subagentSessionId: "c1", state: "completed" }
  const usage = { sessionUpdate: "_daedalus/subagent_usage", subagentSessionId: "c1", usage: { totalTokens: 10, inputTokens: 6, outputTokens: 4 } }
  let list = up([], spawn, 1_000)
  list = up(list, spawn, 2_000) // restated while running: same run
  list = up(list, end, 31_000) // 30s
  list = up(list, end, 40_000) // restated end: not a second turn
  list = up(list, usage, 40_000)
  list = up(list, spawn, 100_000) // woken after 60s idle
  assert.equal(spendTime(subagentSpend(list)[0]), "running", "a woken child reads as running")
  list = up(list, end, 112_000) // +12s
  const [child] = subagentSpend(list)
  assert.equal(child.durationMs, 42_000, "running time only, over both wakes")
  assert.equal(spendTime(child), "42s")
}
// --- saved files (a runtime's own record of its prompt) ---
{
  const sum = (parts) => Object.values(parts).reduce((n, v) => n + v, 0)
  const prefix = (missing, extra = {}) => ({ daedalus: { prefix: { source: "files", system: 3000, tools: 1500, mcp: 500, missing, ...extra } } })
  // Everything saved: the tokenizer gap is spread over every part, none is "overhead".
  const full = tokensByTurn(items, { a1: { used: 12000, size: 100000, _meta: prefix([]) } }, {})
  const f = promptParts(full.turns[0].steps[0])
  assert.equal(f.source, "files")
  assert.deepEqual(f.missing, [])
  assert.equal(sum(f.parts), 12000, "parts sum to used")
  assert.ok(f.parts.overhead <= 2, "nothing missing leaves only rounding in overhead")
  assert.ok(f.parts.system > 3000 && f.parts.tools > 1500, "the gap is shared, not parked")
  // Something missing: the known parts stay as counted and the gap is the named overhead.
  const gap = tokensByTurn(items, { a1: { used: 12000, size: 100000, _meta: prefix(["tool schemas"]) } }, {})
  const g = promptParts(gap.turns[0].steps[0])
  assert.deepEqual(g.missing, ["tool schemas"])
  assert.equal(sum(g.parts), 12000)
  assert.equal(g.parts.system, 3000, "a missing part does not inflate the known ones")
  assert.ok(g.parts.overhead > 4000, "what the file cannot say is the overhead")
  // A prefix bigger than the request is scaled down to fit and never goes negative.
  const tight = promptParts({ ...gap.turns[0].steps[0], update: { used: 1000, size: 1, _meta: prefix(["tool schemas"]) } })
  assert.equal(sum(tight.parts), 1000)
  assert.ok(Object.values(tight.parts).every((n) => n >= 0))
  // Item lists ride the first reading and carry forward like the agent's own.
  const withItems = prefix([], { items: { system: [{ name: "System prompt > A", tokens: 1 }], tools: [{ name: "Bash", tokens: 1 }], mcp: [{ name: "mcp__gh__pr", tokens: 1 }] } })
  const two = tokensByTurn([...items, { kind: "agent", id: "a2", text: "more" }], { a1: { used: 12000, size: 1, _meta: withItems }, a2: { used: 12100, size: 1, _meta: prefix([]) } }, {})
  const p2 = promptParts(two.turns[0].steps[1])
  const detail = requestDetail(two.turns[0].steps, 1, two.entries, p2.parts)
  assert.deepEqual(detail.tools.map((r) => r.name), ["Bash"], "files' item lists carry forward")
  assert.equal(detail.mcp[0].name, "gh · pr", "MCP tools are named by server")
  // No prefix at all is still the transcript inference.
  assert.equal(promptParts(tokensByTurn(items, { a1: { used: 5000, size: 1 } }, {}).turns[0].steps[0]).source, "transcript")
}
// --- a model span's own account of its prompt (daedalus.prompt_parts) ---
{
  const attr = JSON.stringify({ source: "otlp", total: 1000, system: 400, tools: 300, mcp: 50, conversation: 250, user: 100, assistant: 50, results: 80, overhead: 0,
    items: { system: [{ name: "System prompt > A", tokens: 400 }], tools: [{ name: "Bash", tokens: 300 }], mcp: [] } })
  const got = spanPromptParts({ "daedalus.prompt_parts": attr })
  assert.equal(got.total, 1000)
  assert.equal(got.parts.history, 20, "what the role split did not name is the unsplit history")
  assert.equal(Object.values(got.parts).reduce((n, v) => n + v, 0), 1000, "the parts add up to the total")
  assert.equal(got.items.tools[0].name, "Bash")
  assert.equal(spanPromptParts({}), null, "a span with no parts says nothing")
  assert.equal(spanPromptParts({ "daedalus.prompt_parts": attr.slice(0, 50) }), null, "an elided (cut) value is not guessed at")
}
console.log("token breakdown checks ok")
