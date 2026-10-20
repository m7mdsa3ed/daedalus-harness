/* The one runnable check behind windowed rows' flow layout.

     ../server/node_modules/.bin/tsx src/lib/windowed-rows.check.mjs   (from client/)
*/
import assert from "node:assert"

import { findRow, flowRows } from "./windowed-rows.ts"

// 40px rows with a 4px gap, the list starting 100px into the scroller.
const item = (index) => ({ index, key: index, start: 100 + index * 44, end: 100 + index * 44 + 40 })
const end = item(99).end

// The first row's offset stands for everything above it; contiguous rows add nothing.
{
  const { rows, after } = flowRows([item(10), item(11), item(12)], 100, 4, end)
  assert.deepEqual(rows.map((r) => r.before), [440, 0, 0])
  // Rows 13..99 below: the spacer bottom lands on the list's end after one gap.
  assert.equal(after, end - item(12).end - 4)
  assert.equal(after, 87 * 44 - 4)
}

// Row 0 rendered: no offset at all.
assert.equal(flowRows([item(0), item(1)], 100, 4, end).rows[0].before, 0)

// A pinned far row: the skipped span (rows 13..49) minus the gap the flex already draws.
{
  const { rows } = flowRows([item(11), item(12), item(50)], 100, 4, end)
  assert.equal(rows[2].before, item(50).start - item(12).end - 4)
  assert.equal(rows[2].before, 37 * 44)
}

// The last row rendered: nothing below.
assert.equal(flowRows([item(98), item(99)], 100, 4, end).after, 0)
// Nothing rendered: nothing below either.
assert.deepEqual(flowRows([], 100, 4, end), { rows: [], after: 0 })

// A focused row is followed by key: in place, moved by a re-sort, or gone.
{
  const keys = ["a", "b", "c", "d"]
  const keyOf = (i) => keys[i]
  assert.equal(findRow({ index: 2, key: "c" }, 4, keyOf), 2)
  assert.equal(findRow({ index: 3, key: "b" }, 4, keyOf), 1)
  assert.equal(findRow({ index: 9, key: "d" }, 4, keyOf), 3)
  assert.equal(findRow({ index: 0, key: "z" }, 4, keyOf), null)
  assert.equal(findRow(null, 4, keyOf), null)
}

console.log("windowed-rows: ok")
