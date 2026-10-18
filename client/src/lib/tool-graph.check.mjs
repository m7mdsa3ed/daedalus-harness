/* The one runnable check behind the Branch tool layout's lanes.

     ../server/node_modules/.bin/tsx src/lib/tool-graph.check.mjs   (from client/)
*/
import assert from "node:assert"

import { layoutRun } from "./tool-graph.ts"

// Sequential steps stay on the trunk, which starts and ends on a dot.
let rows = layoutRun([{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }])
assert.deepEqual(rows.map((r) => r.lane), [0, 0, 0])
assert.deepEqual(rows[0].lines, [{ lane: 0, fromDot: true, toDot: false }])
assert.deepEqual(rows[2].lines, [{ lane: 0, fromDot: false, toDot: true }])

// Two parallel calls: B forks off at its row and merges into C.
rows = layoutRun([{ start: 0, end: 5 }, { start: 1, end: 3 }, { start: 6, end: 7 }])
assert.deepEqual(rows.map((r) => r.lane), [0, 1, 0])
assert.deepEqual(rows[1].forks, [1])
assert.deepEqual(rows[2].merges, [1])
assert.ok(rows[1].lines.some((l) => l.lane === 1 && l.fromDot && !l.toDot))

// A branch still running at the end of the run just stops on its last dot.
rows = layoutRun([{ start: 0, end: 5 }, { start: 1 }])
assert.deepEqual(rows[1].lines.filter((l) => l.lane === 1), [])

// No timing at all: everything on the trunk.
assert.deepEqual(layoutRun([{}, {}]).map((r) => r.lane), [0, 0])
console.log("tool-graph: ok")
