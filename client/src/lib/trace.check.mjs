/* One runnable check behind the Trace panel's reading of a thread's model
   calls: where a record is filed, what sums null-aware, and that nothing rows
   twice.

     node src/lib/trace.check.mjs   (from client/)
*/
import assert from "node:assert"

import {
  anchorItems,
  itemsAt,
  byTurn,
  calledCounts,
  mcpOfName,
  serverStats,
  toolStats,
  cacheSaved,
  costOf,
  fileCall,
  gapsOf,
  latestItems,
  mergeCalls,
  missingWords,
  openTurnId,
  rowsFromStepUsage,
  sumBilled,
  sumParts,
} from "./trace.ts"

const user = (id, turnId) => ({ kind: "user", id, text: "hi", ...(turnId ? { turnId } : {}) })
const call = (callId, extra = {}) => ({
  callId,
  at: 1,
  who: "turn",
  step: 1,
  model: "m",
  source: "acp",
  billed: { totalTokens: 130, inputTokens: 20, outputTokens: 10, cachedReadTokens: 80, cachedWriteTokens: 20 },
  ...extra,
})

// The open turn is the newest top-level user bubble's; a child's bubble is not the thread's.
assert.equal(openTurnId([user("a", "t1"), user("b", "t2"), { ...user("c", "t3"), parentId: "x" }]), "t2")
assert.equal(openTurnId([user("a")]), null)

// Filing dedups by callId and keeps the turn it was filed under.
{
  let calls = fileCall([], call("c1"), "t1")
  calls = fileCall(calls, call("c1"), "t2")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].turnId, "t1")
  calls = fileCall(calls, call("c2"), "t1", "child")
  assert.equal(calls[1].childId, "child", "a child's record names the child")
}

// A cold read and the live list merge into one list in `at` order, nothing twice.
{
  const stored = [{ ...call("c1", { at: 5 }), turnId: "t1" }]
  const live = [{ ...call("c1", { at: 5 }), turnId: "t1" }, { ...call("c0", { at: 2 }), turnId: null }]
  const merged = mergeCalls(stored, live)
  assert.deepEqual(merged.map((c) => c.callId), ["c0", "c1"])
}

// Billed sums; the prompt is fresh + read + written; cache saved is the read share.
{
  const billed = sumBilled([call("a"), call("b")])
  assert.deepEqual(billed, { input: 40, cacheRead: 160, cacheWrite: 40, output: 20, reasoning: 0, prompt: 240 })
  assert.equal(cacheSaved(billed), 160 / 240)
  assert.equal(cacheSaved(sumBilled([])), null)
}

// Parts sum null-aware: a part nobody saw stays null; one somebody saw sums what was seen.
{
  const parts = sumParts([
    call("a", { prompt: { system: 10, tools: null, mcp: 5, user: 1, assistant: 0, results: 0, unknown: 104 } }),
    call("b", { prompt: { system: 10, tools: null, mcp: null, user: 1, assistant: 0, results: 0, unknown: 109 } }),
    call("c"),
  ])
  assert.deepEqual(parts, { system: 20, tools: null, mcp: 5, user: 2, assistant: 0, results: 0, unknown: 213 })
  assert.equal(sumParts([call("c")]), null, "no split at all is null, not zeros")
}

// Cost only when reported; the newest items win; missing words each once.
assert.equal(costOf([call("a"), call("b", { costUsd: 0.5 }), call("c", { costUsd: 0.25 })]), 0.75)
assert.equal(costOf([call("a")]), null)
assert.deepEqual(latestItems([call("a", { items: { system: [], tools: [], mcp: [] } }), call("b")]).system, [])
assert.equal(latestItems([call("b")]), null)
assert.deepEqual(
  missingWords([call("a", { missing: ["tool schemas"] }), call("b", { missing: ["tool schemas", "the system prompt"] })]),
  ["tool schemas", "the system prompt"]
)

// Grouping keeps first-seen turn order, the turnless bucket included.
{
  const groups = byTurn([
    { ...call("a"), turnId: "t1" },
    { ...call("b"), turnId: null },
    { ...call("c"), turnId: "t1" },
  ])
  assert.deepEqual([...groups.keys()], ["t1", null])
  assert.equal(groups.get("t1").length, 2)
}

// An old journal: per-step readings become billed-only rows, numbered per turn.
{
  const items = [user("u1", "t1"), { kind: "agent", id: "a1" }, { kind: "tool", id: "x1" }, user("u2", "t2"), { kind: "agent", id: "a2" }]
  const rows = rowsFromStepUsage(items, { a1: { used: 100, size: 1000 }, x1: { used: 120, size: 1000 }, a2: { used: 50, size: 1000 } }, { a1: 7 }, "m")
  assert.deepEqual(rows.map((r) => [r.turnId, r.step, r.billed.inputTokens, r.at]), [["t1", 1, 100, 7], ["t1", 2, 120, 0], ["t2", 1, 50, 0]])
  assert.ok(rows.every((r) => r.source === "usage" && !r.prompt))
}

// MCP names in both dialects, and a server's guidance row.
assert.deepEqual(mcpOfName("mcp__web-search__web_search"), { server: "web-search", tool: "web_search" })
assert.deepEqual(mcpOfName("mcp.GitHub_Work.search_code"), { server: "GitHub_Work", tool: "search_code" })
assert.deepEqual(mcpOfName("mcp__web-search instructions"), { server: "web-search", tool: "instructions" })
assert.equal(mcpOfName("bash"), null)

// Tools: `called` sums every response; the history is the newest call's, never summed;
// a definition is its share of the anchored part, from the prefix the newest split carried.
{
  const prompt = { system: 100, tools: 60, mcp: 40, user: 10, assistant: 20, results: 70, unknown: 0 }
  const calls = [
    call("a", {
      called: ["bash", "bash"],
      prompt,
      items: { system: [], tools: [{ name: "bash", tokens: 30 }, { name: "read", tokens: 10 }], mcp: [{ name: "mcp__web__search", tokens: 5 }] },
      toolUse: [{ name: "bash", calls: 1, args: 5, results: 5 }],
    }),
    call("b", {
      called: ["mcp__web__search"],
      prompt,
      toolUse: [
        { name: "bash", calls: 2, args: 10, results: 50 },
        { name: "mcp__web__search", calls: 1, args: 4, results: 20 },
      ],
    }),
  ]
  const tools = toolStats(calls)
  const bash = tools.find((t) => t.name === "bash")
  assert.deepEqual(bash, { name: "bash", server: null, tool: "bash", called: 2, inHistory: 2, args: 10, results: 50, schema: 45 })
  const web = tools.find((t) => t.name === "mcp__web__search")
  assert.equal(web.server, "web")
  assert.equal(web.tool, "search")
  assert.equal(web.schema, 40, "the only MCP definition is the whole MCP part")
  const read = tools.find((t) => t.name === "read")
  assert.deepEqual([read.called, read.args, read.schema], [0, 0, 15], "a listed tool never called still shows its definition")
  assert.equal(tools[0].name, "bash", "heaviest first")
  const servers = serverStats(tools)
  assert.deepEqual(servers.map((g) => [g.server, g.tools.length, g.called]), [[null, 2, 2], ["web", 1, 1]])
  assert.equal(servers[0].schema, 60)
  assert.deepEqual(toolStats([call("x")]), [], "no tool data, no rows")
}

assert.deepEqual(calledCounts({ called: ["bash", "read", "bash"] }), [["bash", 2], ["read", 1]])
assert.deepEqual(calledCounts({}), [])

assert.deepEqual(anchorItems([{ name: "a", tokens: 1 }, { name: "b", tokens: 3 }], 100), [{ name: "b", tokens: 75 }, { name: "a", tokens: 25 }])
assert.deepEqual(anchorItems([{ name: "a", tokens: 1 }], null), [])
{
  const items = { system: [], tools: [], mcp: [] }
  assert.equal(itemsAt([call("a", { items }), call("b")], 1), items, "a prefix stands until it changes")
  assert.equal(itemsAt([call("a")], 0), null)
}

// The time between calls is split among what the thread says ran in it; the rest is said as unaccounted.
{
  const calls = [
    { ...call("a", { at: 1000, ms: 1000 }), turnId: "t1" },
    { ...call("b", { at: 302_000, ms: 500, step: 2 }), turnId: "t1" },
  ]
  const tool = (id, startedAt, endedAt, extra = {}) => ({ kind: "tool", id, title: id, name: id, status: "completed", startedAt, endedAt, ...extra })
  const items = [
    tool("bash", 2000, 62_000, { waitedMs: 10_000 }),
    tool("grep", 50_000, 70_000), // overlaps bash: the earlier claims the shared time
  ]
  const gap = gapsOf(calls, items).get("b")
  assert.equal(gap.ms, 300_000, "from the end of a response to the request of b")
  assert.deepEqual(gap.reasons.map((r) => [r.kind, r.label, r.ms]), [["tool", "bash", 50_000], ["tool", "grep", 8_000], ["permission", "bash", 10_000]].sort((x, y) => y[2] - x[2]))
  assert.equal(gap.unaccounted, 300_000 - 68_000)
  assert.equal(gapsOf(calls, items).has("a"), false, "the first call has no gap")
  assert.equal(gapsOf([calls[0], { ...calls[1], at: 5000 }], []).get("b").unaccounted, 3000, "nothing recorded: all of it is unaccounted")
  assert.equal(gapsOf([{ ...calls[0], ms: undefined }, calls[1]], items).size, 0, "no response time, no gap")
  // A message the reader sent ends the silence before the next turn.
  const next = { ...call("c", { at: 400_000 }), turnId: "t2" }
  const idle = gapsOf([calls[1], next], [{ kind: "user", id: "u", text: "hi", at: 390_000, turnId: "t2" }]).get("c")
  assert.deepEqual(idle.reasons.map((r) => [r.kind, r.ms]), [["idle", 390_000 - 302_500]])
}

// What the agent booked is taken out of the leftover; the rest is placed among the tools.
{
  const calls = [call("a", { at: 1000, ms: 1000 }), call("b", { at: 302_000, ms: 500, step: 2 })]
  const tool = (id, startedAt, endedAt, extra = {}) => ({ kind: "tool", id, title: id, name: id, status: "completed", startedAt, endedAt, ...extra })
  const items = [tool("bash", 2000, 12_000), tool("lead", 302_100, 302_200, { meta: { lead: true } })]
  const lead = (t) => (t.meta ? { heldMs: 200_000, retryMs: 30_000 } : undefined)
  const gap = gapsOf(calls, items, lead).get("b")
  assert.deepEqual(gap.reasons.map((r) => [r.kind, r.ms]), [["paused", 200_000], ["tool", 10_000], ["retry", 30_000]].sort((x, y) => y[1] - x[1]))
  assert.equal(gap.unaccounted, 300_000 - 240_000)
  assert.deepEqual(gap.silences, [{ where: "after-tools", ms: 60_000 }])
  const bare = gapsOf(calls, items).get("b")
  assert.equal(bare.unaccounted, 290_000)
  assert.deepEqual(bare.silences, [{ where: "after-tools", ms: 290_000 }])
  assert.deepEqual(gapsOf([calls[0], { ...calls[1], at: 5000 }], []).get("b").silences, [{ where: "quiet", ms: 3000 }])
}

console.log("trace: ok")
