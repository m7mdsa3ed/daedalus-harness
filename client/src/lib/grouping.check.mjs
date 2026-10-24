/* One runnable check behind the tool-run fold: what belongs inside a run, what
   ends one, and where a mid-turn setting change lands.

     ../server/node_modules/.bin/tsx src/lib/grouping.check.mjs   (from client/)
*/
import assert from "node:assert"

import { buildRows, proseGapAfter, rowTailId, shareRows, streamingRowIds } from "./transcript-rows.ts"

const tool = (id) => ({ kind: "tool", id, title: id, status: "completed", toolKind: "read", content: [] })
const thought = (id) => ({ kind: "thought", id, text: "thinking" })
const edit = (id) => ({ kind: "tool", id, title: id, status: "completed", toolKind: "edit", content: [] })
const prose = (id) => ({ kind: "agent", id, text: "said something" })
const notice = (id, config = true) => ({ kind: "notice", id, text: "Model: A -> B", ...(config ? { config: true } : {}) })
const kinds = (rows) => rows.map((row) => row.kind).join(",")
/* A call into an MCP server, the way a runtime announces it: the flattened name
   is the whole identity, and `other` is the kind every MCP tool arrives under. */
const mcp = (id, server, tool = "get_error") => ({
  kind: "tool",
  id,
  title: `mcp__${server}__${tool}`,
  status: "completed",
  toolKind: "other",
  content: [],
})

// A run of two calls is one row, and its steps keep arrival order.
assert.equal(kinds(buildRows([tool("a"), tool("b")], true)), "run", "two calls fold")

// Consecutive calls to ONE MCP server are one run: the integration is the group.
{
  const out = buildRows([mcp("a", "Bugsnag"), mcp("b", "Bugsnag", "list_projects")], true)
  assert.equal(kinds(out), "run", `one server folds into one run, got ${kinds(out)}`)
  assert.deepEqual(out[0].items.map((item) => item.id), ["a", "b"])
}

// Two servers' calls are two groups, never one "mcp" run — the whole point of
// keying a run by the integration.
{
  const out = buildRows([mcp("a", "Bugsnag"), mcp("b", "Clickup")], true)
  assert.equal(kinds(out), "tool-group", `two servers do not fold together, got ${kinds(out)}`)
  assert.deepEqual(out[0].children.map((child) => child.id), ["a", "b"])
}

// Interleaved: no run reorders, so each stretch of one server stands alone, and
// the group holds them in arrival order.
{
  const out = buildRows([mcp("a", "Bugsnag"), mcp("b", "Clickup"), mcp("c", "Bugsnag")], true)
  assert.equal(kinds(out), "tool-group", `interleaved servers group, got ${kinds(out)}`)
  assert.deepEqual(out[0].children.map((child) => child.id), ["a", "b", "c"])
}

// The same server either side of another's call is two stretches, not one run.
{
  const out = buildRows(
    [mcp("a", "Bugsnag"), mcp("b", "Bugsnag"), mcp("c", "Clickup"), mcp("d", "Bugsnag"), mcp("e", "Bugsnag")],
    true
  )
  assert.equal(kinds(out), "tool-group")
  assert.deepEqual(out[0].children.map((child) => child.kind), ["run", "tool", "run"])
}

// A setting changed BETWEEN two calls is part of the run, in its place.
{
  const out = buildRows([tool("a"), notice("n1"), tool("b")], true)
  assert.equal(kinds(out), "run", `interior notice stays inside the run, got ${kinds(out)}`)
  assert.deepEqual(out[0].items.map((item) => item.id), ["a", "n1", "b"], "arrival order, notice in the middle")
}

// A thought rides inside the run it explains: the reasoning leading a run or
// sitting between two of its calls is part of the group, in its place. The
// counting line still counts calls only.
{
  const out = buildRows([tool("a"), tool("b"), thought("t1"), tool("c"), tool("d")], true)
  assert.equal(kinds(out), "run", `an interior thought stays inside the run, got ${kinds(out)}`)
  assert.deepEqual(out[0].items.map((item) => item.id), ["a", "b", "t1", "c", "d"])
}

// A leading thought opens the run; a trailing one is the live tail and stands
// after it.
{
  const lead = buildRows([thought("t1"), tool("a"), tool("b")], true)
  assert.equal(kinds(lead), "run", `got ${kinds(lead)}`)
  assert.deepEqual(lead[0].items.map((item) => item.id), ["t1", "a", "b"])
  const tail = buildRows([tool("a"), tool("b"), thought("t1")], true)
  assert.equal(kinds(tail), "run,thought", `got ${kinds(tail)}`)
  assert.deepEqual(tail[0].items.map((item) => item.id), ["a", "b"])
}

// Held thoughts and notices keep arrival order when a call settles them.
{
  const out = buildRows([tool("a"), notice("n1"), thought("t1"), tool("b")], true)
  assert.equal(kinds(out), "run", `got ${kinds(out)}`)
  assert.deepEqual(out[0].items.map((item) => item.id), ["a", "n1", "t1", "b"])
}

// A notice and a thought both trailing: the run, then them in order.
{
  const out = buildRows([tool("a"), tool("b"), notice("n1"), thought("t1")], true)
  assert.equal(kinds(out), "run,notice,thought", `got ${kinds(out)}`)
}

// `think -> edit -> think -> 3 edits -> think` with edits grouped (`groupEdits`):
// the thinking between them rides in the run, the last thought trails it.
{
  const out = buildRows(
    [thought("t1"), edit("e1"), thought("t2"), edit("e2"), edit("e3"), edit("e4"), thought("t3")],
    true,
    false,
    false,
    true
  )
  assert.equal(kinds(out), "run,thought", `got ${kinds(out)}`)
  assert.deepEqual(out[0].items.map((item) => item.id), ["t1", "e1", "t2", "e2", "e3", "e4"])
}

// A thought before prose trails the run it followed, and prose starts a new one.
{
  const out = buildRows([tool("a"), tool("b"), thought("t1"), prose("p1"), tool("c"), tool("d")], true)
  assert.equal(kinds(out), "run,thought,agent,run", `got ${kinds(out)}`)
}

// One call with the thinking around it is rows, not a fold: a group needs a
// second call to count.
{
  const out = buildRows([thought("t1"), tool("a"), thought("t2")], true)
  assert.equal(kinds(out), "thought,tool,thought", `got ${kinds(out)}`)
}

// What a group cannot be is a group of one step: thinking stays the rows it was,
// and so does one call.
{
  assert.equal(kinds(buildRows([thought("t1"), thought("t2")], true)), "thought,thought")
  assert.equal(kinds(buildRows([tool("a")], true)), "tool")
}

// Prose ends a run too, and is drawn where it arrived.
{
  const out = buildRows([tool("a"), tool("b"), prose("p1"), tool("c"), tool("d")], true)
  assert.equal(kinds(out), "run,agent,run", `got ${kinds(out)}`)
  assert.deepEqual(out[0].items.map((item) => item.id), ["a", "b"])
  assert.deepEqual(out[2].items.map((item) => item.id), ["c", "d"])
}

// Mixed views under the same stretch: one parent group, its same-view children
// split, the thought riding in the group.
{
  const out = buildRows([tool("a"), thought("t1"), edit("e1"), tool("b")], true, false, false, true)
  assert.equal(kinds(out), "tool-group", `got ${kinds(out)}`)
  assert.deepEqual(out[0].items.map((item) => item.id), ["a", "t1", "e1", "b"])
}

// A notice BEFORE the first call is a break: the run starts after it.
{
  const out = buildRows([notice("n1"), tool("a"), tool("b")], true)
  assert.equal(kinds(out), "notice,run", `a leading notice is not swept in, got ${kinds(out)}`)
}

// A notice AFTER the last call ends the run and is drawn after it — it is the
// item the turn's footer anchors on.
{
  const out = buildRows([tool("a"), tool("b"), notice("n1")], true)
  assert.equal(kinds(out), "run,notice", `a trailing notice is not swept in, got ${kinds(out)}`)
  assert.equal(rowTailId(out[0]), "b", "the run still ends on its last call")
}

// One call is not a run, so a notice beside it has nothing to join.
{
  const out = buildRows([tool("a"), notice("n1"), prose("p1")], true)
  assert.equal(kinds(out), "tool,notice,agent", `a lone call stays a step, got ${kinds(out)}`)
}

// An interrupt rule is not a setting change: it breaks the run either way.
{
  const out = buildRows([tool("a"), notice("n1", false), tool("b")], true)
  assert.equal(kinds(out), "tool,notice,tool", `an interrupt rule is not absorbed, got ${kinds(out)}`)
}

// Grouping off draws every item where it arrived.
{
  const out = buildRows([tool("a"), notice("n1"), tool("b")], false)
  assert.equal(kinds(out), "tool,notice,tool")
}

// A rebuild keeps every group whose parts did not move, and only those.
{
  const a = tool("a"), b = tool("b"), c = tool("c"), d = tool("d")
  const first = buildRows([a, b, prose("p"), c, d], true)
  const p = first[1]
  assert.strictEqual(shareRows(first, buildRows([a, b, p, c, d], true)), first, "nothing moved: the same array")
  const d2 = { ...d, status: "failed" }
  const shared = shareRows(first, buildRows([a, b, p, c, d2], true))
  assert.strictEqual(shared[0], first[0], "an untouched run keeps its object")
  assert.notStrictEqual(shared[2], first[2], "a changed run is new")
  assert.strictEqual(shared[2].items[1], d2, "and carries the new item")
  assert.strictEqual(shared[2].items[0], c, "beside the old one")
}

// The wait before a reply is measured from the last call, through any reasoning
// that ended the step: a trailing thought is the live tail, not part of the fold,
// so it stands between the run and the prose and used to hide the gap entirely.
{
  const timed = (id, startedAt, endedAt) => ({ ...tool(id), startedAt, endedAt })
  const thinking = (id, at) => ({ ...thought(id), at })
  const said = (id, at) => ({ ...prose(id), at })
  const out = buildRows([timed("a", 0, 1000), thinking("t", 1000), said("p", 5000)], true)
  assert.equal(kinds(out), "tool,thought,agent", `the tail thought stays put, got ${kinds(out)}`)
  assert.equal(proseGapAfter(out, 2), 4000, "the wait runs from the call, across the thought")

  // Anything a person sent in between is a break, not a wait to measure across.
  const spoken = buildRows([timed("a", 0, 1000), { kind: "user", id: "u", text: "hi", at: 3000 }, said("p", 5000)], true)
  assert.equal(proseGapAfter(spoken, 2), undefined, "a message between them ends it")

  // And nothing above a reply means nothing to subtract from.
  assert.equal(proseGapAfter(buildRows([said("p", 5000)], true), 0), undefined)
}

// What an open turn is still writing: the newest row, and the group under a
// thought standing at the tail. The trailing thought is outside the fold it
// explains, so reading "is this the tail" off `rowTailId` alone left the group
// folding shut the moment the model started thinking and opening again when the
// call after it landed.
{
  const calls = buildRows([tool("a"), tool("b")], true)
  assert.deepEqual([...streamingRowIds(calls, "b")], ["a"], `a live run is live, got ${kinds(calls)}`)

  const thinking = buildRows([tool("a"), tool("b"), thought("t1")], true)
  assert.deepEqual([...streamingRowIds(thinking, "t1")].sort(), ["a", "t1"], `the fold under a trailing thought stays live`)

  // A leading thought with no run under it is only itself — there is no fold to
  // keep open, and a group of one call is a step, not a group.
  const lead = buildRows([thought("t1"), tool("a")], true)
  assert.deepEqual([...streamingRowIds(lead, "a")], ["a"])

  // Prose already on screen does not become unfinished because the agent has
  // started thinking again: only a group is read through a trailing thought.
  const after = buildRows([tool("a"), tool("b"), thought("t1"), prose("p1"), thought("t2")], true)
  assert.deepEqual([...streamingRowIds(after, "t2")], ["t2"], `got ${kinds(after)}`)

  // A row that is not the tail at all is never live — including a trailing
  // thought whose id is not what the rows actually end in.
  assert.deepEqual([...streamingRowIds(calls, "nope")], [])
  assert.deepEqual([...streamingRowIds(calls, undefined)], [])
  assert.deepEqual([...streamingRowIds(thinking, "b")], [])
}

// Inside an "Answers only" fold the newest item is a level down, and the run a
// trailing thought belongs to is a child of the fold: asked against the fold's
// own rows, the same reading answers.
{
  const fold = buildRows([tool("a"), tool("b"), tool("c"), thought("t1")], true, true, false, false, true)
  assert.equal(kinds(fold), "work-fold")
  const inner = fold[0].rows
  assert.equal(kinds(inner), "run,thought")
  assert.deepEqual([...streamingRowIds(inner, "t1")].sort(), ["a", "t1"])
  assert.deepEqual([...streamingRowIds(fold, "t1")], [fold[0].id])
}

console.log("grouping.check: ok")
