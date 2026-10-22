/* The runnable check behind parallel-batch brackets and the gaps between them.

     ../server/node_modules/.bin/tsx src/lib/tool-batches.check.mjs   (from client/)
*/
import assert from "node:assert"

import { layoutBatches } from "./tool-batches.ts"

const timing = { burstMs: 250, gapMinMs: 1000 }

// Sequential calls: no batch, a wait is said past the threshold.
let rows = layoutBatches([{ start: 0, end: 1000 }, { start: 3500, end: 4000 }, { start: 4100, end: 4200 }], timing)
assert.deepEqual(rows.map((r) => r.size), [undefined, undefined, undefined])
assert.equal(rows[0].gapMs, 2500)
assert.equal(rows[1].gapMs, undefined) // 100ms is the turn's pace

// One response by timing: three calls in a burst, the bracket spans all three.
rows = layoutBatches([{ start: 0, end: 900 }, { start: 5, end: 300 }, { start: 8, end: 2000 }, { start: 6000, end: 6100 }], timing)
assert.deepEqual(rows.map((r) => [r.index, r.size]), [[1, 3], [2, 3], [3, 3], [undefined, undefined]])
assert.deepEqual(rows.map((r) => r.edge), ["start", "middle", "end", undefined])
assert.equal(rows[2].gapMs, 4000) // from the batch's *latest* end
assert.equal(rows[0].gapMs, undefined)

// A late call that starts while the batch is still running joins it.
rows = layoutBatches([{ start: 0, end: 5000 }, { start: 1000, end: 2000 }], timing)
assert.deepEqual(rows.map((r) => r.size), [2, 2])

// A call still running overlaps whatever starts after it, and a batch with no
// end has no wait to measure.
rows = layoutBatches([{ start: 0 }, { start: 2 }, { start: 9000 }], timing)
assert.deepEqual(rows.map((r) => r.size), [3, 3, 3])
assert.ok(rows.every((r) => r.gapMs === undefined))

// A notice between two calls of a batch is inside its bracket, with no index.
rows = layoutBatches([{ start: 0, end: 10 }, {}, { start: 20, end: 30 }], timing)
assert.deepEqual(rows.map((r) => r.edge), ["start", "middle", "end"])
assert.equal(rows[1].index, undefined)
assert.deepEqual(layoutBatches([{}, {}], timing), [{}, {}])

// The runtime's step id beats timing in both directions.
// Same id, far apart in time: one batch.
rows = layoutBatches([{ start: 0, end: 10, step: "a" }, { start: 5000, end: 5010, step: "a" }], timing)
assert.deepEqual(rows.map((r) => r.size), [2, 2])
// Different ids, same millisecond: two batches (a fast second request).
rows = layoutBatches([{ start: 0, end: 10, step: "a" }, { start: 12, end: 20, step: "b" }], timing)
assert.deepEqual(rows.map((r) => r.size), [undefined, undefined])
// An id on one side only falls back to timing.
rows = layoutBatches([{ start: 0, end: 10, step: "a" }, { start: 5, end: 20 }], timing)
assert.deepEqual(rows.map((r) => r.size), [2, 2])

// The options are the reader's: a wider window groups more, Off draws no waits.
rows = layoutBatches([{ start: 0, end: 10 }, { start: 600, end: 700 }], { burstMs: 1000, gapMinMs: null })
assert.deepEqual(rows.map((r) => r.size), [2, 2])
rows = layoutBatches([{ start: 0, end: 10 }, { start: 5000, end: 5100 }], { burstMs: 250, gapMinMs: null })
assert.equal(rows[0].gapMs, undefined)
rows = layoutBatches([{ start: 0, end: 10 }, { start: 5000, end: 5100 }], { burstMs: 250, gapMinMs: 10000 })
assert.equal(rows[0].gapMs, undefined)

// The batch says what it cost together: first start to latest end, on its last
// call, and nothing while a call is still out.
rows = layoutBatches([{ start: 0, end: 900 }, { start: 5, end: 300 }, { start: 8, end: 2000 }], timing)
assert.deepEqual(rows.map((r) => r.spanMs), [undefined, undefined, 2000])
rows = layoutBatches([{ start: 0, end: 900 }, { start: 5 }], timing)
assert.ok(rows.every((r) => r.spanMs === undefined))
rows = layoutBatches([{ start: 0, end: 10 }, { start: 5000, end: 5100 }], timing)
assert.ok(rows.every((r) => r.spanMs === undefined)) // a lone call has no batch
console.log("tool-batches: ok")
