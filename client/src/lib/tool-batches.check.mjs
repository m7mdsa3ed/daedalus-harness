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
// While calls are out, the last call says how many: nothing once all have ended.
rows = layoutBatches([{ start: 0, end: 900 }, { start: 5 }, { start: 8 }], timing)
assert.deepEqual(rows.map((r) => r.running), [undefined, undefined, 2])
rows = layoutBatches([{ start: 0, end: 900 }, { start: 5, end: 300 }], timing)
assert.ok(rows.every((r) => r.running === undefined))
// The wait carries what the next batch's first call said it was made of.
rows = layoutBatches([{ start: 0, end: 10 }, { start: 5000, end: 5100, lead: { ttftMs: 4000 } }, { start: 5100, end: 5200, lead: { ttftMs: 1 } }], timing)
assert.deepEqual(rows[0].gapLead, { ttftMs: 4000 })
assert.equal(rows[1].gapLead, undefined) // a wait too short to say carries nothing
rows = layoutBatches([{ start: 0, end: 10 }, { start: 5000, end: 5100 }], timing)
assert.equal(rows[0].gapLead, undefined) // a runtime that does not say
// Reasoning that ended a step closes the batch above it, so the wait after the
// thinking is what is left once it stopped — not the whole thinking again.
// It joins no batch: it takes no place, no index and no size.
rows = layoutBatches([{ start: 0, end: 10 }, { end: 5000, quiet: true }, { start: 8000, end: 8100 }], timing)
assert.equal(rows[1].gapMs, 3000, "the wait runs from the thinking's end, and is drawn under it")
assert.equal(rows[0].gapMs, undefined)
assert.deepEqual([rows[1].index, rows[1].size, rows[1].edge], [undefined, undefined, undefined])
// A quiet row with nothing before it says nothing rather than inventing a batch.
rows = layoutBatches([{ end: 5000, quiet: true }, { start: 5100, end: 5200 }], timing)
assert.equal(rows[1].gapMs, undefined)
// One that ended the batch in a batch's own word: the bracket is still the calls.
rows = layoutBatches([{ start: 0, end: 10, step: "a" }, { start: 5, end: 20, step: "a" }, { end: 900, quiet: true }], timing)
assert.deepEqual(rows.map((r) => [r.index, r.size]), [[1, 2], [2, 2], [undefined, undefined]])
assert.equal(rows[1].spanMs, 20, "the bracket is the calls' own cost, not the thinking's")
console.log("tool-batches: ok")
