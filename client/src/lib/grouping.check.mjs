/* One runnable check behind the tool-run fold: what belongs inside a run, what
   ends one, and where a mid-turn setting change lands.

     ../server/node_modules/.bin/tsx src/lib/grouping.check.mjs   (from client/)
*/
import assert from "node:assert"

import { buildRows, rowTailId, shareRows } from "./transcript-rows.ts"

const tool = (id) => ({ kind: "tool", id, title: id, status: "completed", toolKind: "read", content: [] })
const thought = (id) => ({ kind: "thought", id, text: "thinking" })
const edit = (id) => ({ kind: "tool", id, title: id, status: "completed", toolKind: "edit", content: [] })
const prose = (id) => ({ kind: "agent", id, text: "said something" })
const notice = (id, config = true) => ({ kind: "notice", id, text: "Model: A -> B", ...(config ? { config: true } : {}) })
const kinds = (rows) => rows.map((row) => row.kind).join(",")

// A run of two calls is one row, and its steps keep arrival order.
assert.equal(kinds(buildRows([tool("a"), tool("b")], true)), "run", "two calls fold")

// A setting changed BETWEEN two calls is part of the run, in its place.
{
  const out = buildRows([tool("a"), notice("n1"), tool("b")], true)
  assert.equal(kinds(out), "run", `interior notice stays inside the run, got ${kinds(out)}`)
  assert.deepEqual(out[0].items.map((item) => item.id), ["a", "n1", "b"], "arrival order, notice in the middle")
}

// A thought ends the run it landed in and stands where it arrived: a fold holds
// calls, so reasoning is never hidden behind a counting line that only mentions
// calls.
{
  const out = buildRows([tool("a"), tool("b"), thought("t1"), tool("c"), tool("d")], true)
  assert.equal(kinds(out), "run,thought,run", `a thought splits the run, got ${kinds(out)}`)
  assert.deepEqual(out[0].items.map((item) => item.id), ["a", "b"])
  assert.deepEqual(out[2].items.map((item) => item.id), ["c", "d"])
}

// A leading thought and a trailing one are outside the fold too — the group is
// the calls, not the stretch around them.
{
  const lead = buildRows([thought("t1"), tool("a"), tool("b")], true)
  assert.equal(kinds(lead), "thought,run", `got ${kinds(lead)}`)
  assert.deepEqual(lead[1].items.map((item) => item.id), ["a", "b"])
  const tail = buildRows([tool("a"), tool("b"), thought("t1")], true)
  assert.equal(kinds(tail), "run,thought", `got ${kinds(tail)}`)
  assert.deepEqual(tail[0].items.map((item) => item.id), ["a", "b"])
}

// A notice still waiting when a thought arrives is trailing, not interior: the
// run it was in is drawn, then the notice, then the thought that ended it.
{
  const out = buildRows([tool("a"), tool("b"), notice("n1"), thought("t1"), tool("c"), tool("d")], true)
  assert.equal(kinds(out), "run,notice,thought,run", `got ${kinds(out)}`)
  assert.deepEqual(out[0].items.map((item) => item.id), ["a", "b"])
  assert.deepEqual(out[3].items.map((item) => item.id), ["c", "d"])
}

// `call -> think -> notice -> call` is four rows now: thinking settles nothing
// into the open, and a lone call is not a run for a notice to ride in.
{
  const out = buildRows([tool("a"), thought("t1"), notice("n1"), tool("b")], true)
  assert.equal(kinds(out), "tool,thought,notice,tool", `got ${kinds(out)}`)
}

// `think -> edit -> think -> 3 edits -> think`: every thought ends the run it
// lands in, so the three edits between two of them are the only fold
// (`groupEdits`, which `expandEdits` off arms in the transcript).
{
  const out = buildRows(
    [thought("t1"), edit("e1"), thought("t2"), edit("e2"), edit("e3"), edit("e4"), thought("t3")],
    true,
    false,
    false,
    true
  )
  assert.equal(kinds(out), "thought,tool,thought,run,thought", `got ${kinds(out)}`)
  assert.deepEqual(out[3].items.map((item) => item.id), ["e2", "e3", "e4"])
}

// One call with the thinking around it is three rows, not a fold: a group needs
// a second call to count.
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
// split — the calls on one side of a thought only, since the thought ended the
// run before them.
{
  const out = buildRows([tool("a"), thought("t1"), edit("e1"), tool("b")], true, false, false, true)
  assert.equal(kinds(out), "tool,thought,tool-group", `got ${kinds(out)}`)
  assert.deepEqual(out[2].items.map((item) => item.id), ["e1", "b"])
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

console.log("grouping.check: ok")
