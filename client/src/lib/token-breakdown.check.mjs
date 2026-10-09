/* The one runnable check behind the Tokens panel's arithmetic.

     ../server/node_modules/.bin/tsx src/lib/token-breakdown.check.mjs   (from client/)
*/
import assert from "node:assert/strict"
import { promptParts, requestDetail, sumPromptParts, tokensByTurn } from "./token-breakdown.ts"
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
console.log("token breakdown checks ok")
