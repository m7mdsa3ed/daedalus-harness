/* The flowchart layout: loops keep their ranks, nothing overlaps, wide ranks wrap.

     node --experimental-strip-types src/lib/openui/flow-layout.check.mjs   (from client/)
*/
import assert from "node:assert"
import { layoutFlow } from "./flow-layout.ts"

const n = (id, width = 120, height = 48) => ({ id, width, height })
const e = (from, to) => ({ from, to })

// A retry loop no longer strands everything after it on one row.
{
  const { positions: p, back } = layoutFlow(
    [n("a"), n("b"), n("c"), n("d")],
    [e("a", "b"), e("b", "c"), e("c", "b"), e("c", "d")],
    "down"
  )
  assert.ok(p.get("a").y < p.get("b").y && p.get("b").y < p.get("c").y && p.get("c").y < p.get("d").y)
  assert.deepEqual([...back], [2]) // c→b is the edge that loops back
}

// Rows are spaced by the tallest node in them, so a tall node never overlaps the next rank.
{
  const { positions: p } = layoutFlow([n("a", 120, 200), n("b")], [e("a", "b")], "down")
  assert.ok(p.get("b").y - 24 >= p.get("a").y + 100)
}

// Siblings sit apart by their own widths.
{
  const { positions: p } = layoutFlow([n("r"), n("x", 300), n("y", 80)], [e("r", "x"), e("r", "y")], "down")
  const [l, r] = [p.get("x"), p.get("y")].sort((a, b) => a.x - b.x)
  const lw = l === p.get("x") ? 300 : 80
  const rw = l === p.get("x") ? 80 : 300
  assert.ok(r.x - rw / 2 >= l.x + lw / 2)
}

// A rank wider than the panel wraps onto extra rows; "right" swaps the axes and never wraps.
{
  const kids = ["1", "2", "3", "4", "5"]
  const nodes = [n("r"), ...kids.map((k) => n(k))]
  const edges = kids.map((k) => e("r", k))
  const down = layoutFlow(nodes, edges, "down", 2).positions
  assert.equal(new Set(kids.map((k) => down.get(k).y)).size, 3)
  const right = layoutFlow(nodes, edges, "right", 2).positions
  assert.equal(new Set(kids.map((k) => right.get(k).x)).size, 1)
  assert.ok(right.get("r").x < right.get("1").x)
}

// Barycenter untangles a crossing: a→d, b→c drawn in input order would cross.
{
  const { positions: p } = layoutFlow(
    [n("a"), n("b"), n("c"), n("d")],
    [e("a", "d"), e("b", "c")],
    "down"
  )
  assert.equal(p.get("a").x < p.get("b").x, p.get("d").x < p.get("c").x)
}

// Dangling edges, self loops and duplicate ids are ignored, not thrown on.
{
  const { positions: p } = layoutFlow([n("a"), n("a"), n("b")], [e("a", "a"), e("a", "zz"), e("a", "b")], "down")
  assert.equal(p.size, 2)
  assert.ok(p.get("a").y < p.get("b").y)
}

// Empty is empty.
assert.equal(layoutFlow([], [], "down").positions.size, 0)

console.log("flow-layout: ok")
