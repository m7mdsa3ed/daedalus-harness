/* The one runnable check behind a step saying how long it took once it is over:
   a settled thought and a settled tool call both read their two ends off what
   the journal sent, because the ticking counter is this device's and dies with
   the mount that started it.

     ../server/node_modules/.bin/tsx src/lib/step-timing.check.mjs   (from client/)
*/
import assert from "node:assert"

import { emptyThread } from "./store/thread.ts"
import { applyMetaUpdate, settleTools } from "./store/session-update.ts"

/* Through `applyMetaUpdate`, because that is the door the reducer's `update`
   action actually goes through — a stamp that stopped at `applySessionUpdate`
   would be dropped on the way and this check would not notice. */
const fold = (thread, update, stamp, endStamp) =>
  applyMetaUpdate(thread, update, false, undefined, stamp, undefined, undefined, endStamp)
/** The same fold on a `session/load` replay, where the stamps are the reload's. */
const history = (thread, update, stamp) =>
  applyMetaUpdate(thread, update, true, undefined, stamp, undefined, undefined, undefined)

const only = (thread) => {
  const items = thread.items
  assert.equal(items.length, 1, `one row, got ${items.map((i) => i.kind).join(",")}`)
  return items[0]
}

const thought = (text) => ({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } })

// ---- a thought: the replay merged the run, so both ends ride the one event ----

const START = 1_700_000_000_000
let t = fold(emptyThread, thought("Let me think"), START, START + 12_400)
let row = only(t)
assert.equal(row.at, START, "the run's start")
assert.equal(row.endedAt, START + 12_400, "and its end, so the length is measured")

// The client's own merge: a run split into two events (the journal's size cut)
// is one item — the first start, the last end.
t = fold(t, thought(" about it"), START + 12_400, START + 15_000)
row = only(t)
assert.equal(row.text, "Let me think about it", "both pieces are one item")
assert.equal(row.at, START, "which began where the run did")
assert.equal(row.endedAt, START + 15_000, "and ends where the run ended")

// Live: no run behind the update to have measured, so each chunk is its own
// end and the thought stops at its last word, not at the call that follows it.
t = fold(emptyThread, thought("live"), START, undefined)
row = only(t)
assert.equal(row.at, START, "a live chunk is stamped by this device")
assert.equal(row.endedAt, START, "and ends where it arrived")
t = fold(t, thought(" more"), START + 3_000, undefined)
row = only(t)
assert.equal(row.at, START, "the run still began at its first chunk")
assert.equal(row.endedAt, START + 3_000, "and ends at the last one to join it")

// A session/load replay is history: no start means no length either, even when
// the event does carry both ends.
t = history(emptyThread, thought("history"), START)
row = only(t)
assert.equal(row.at, undefined, "history has no honest start")
assert.equal(row.endedAt, undefined, "so it can have no honest length")

// ---- a tool call: the call opens on one update and settles on another ----

const call = (extra) => ({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read", status: "in_progress", ...extra })
const done = (extra) => ({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", ...extra })

t = fold(emptyThread, call({}), START)
row = only(t)
assert.equal(row.startedAt, START, "the call's start is the journal's stamp")
assert.equal(row.endedAt, undefined, "and a call still open has no end")

t = fold(t, done({}), START + 4_200)
row = only(t)
assert.equal(row.endedAt, START + 4_200, "the update that settled it is its end")

// A terminal status is never un-said: a runtime that re-announces the call does
// not move the ending.
const again = fold(t, call({ status: "completed" }), START + 9_000)
assert.equal(only(again).endedAt, START + 4_200, "the first ending stands")

// Announced already finished: one update, and it is both the call and its end.
t = fold(emptyThread, call({ status: "completed" }), START + 1_000)
assert.equal(only(t).endedAt, START + 1_000, "a settled announcement settles with it")

// A call still open when the turn ends is failed by `settleTools`, which has no
// clock of its own and so says nothing rather than inventing an ending.
t = fold(emptyThread, call({}), START + 300)
t = { ...t, items: settleTools(t.items) }
row = only(t)
assert.equal(row.status, "failed", "the open call is settled")
assert.equal(row.endedAt, undefined, "with no end it was never told")

// A session/load replay: the stamp is the reload's, not the call's.
t = history(emptyThread, call({}), START)
row = only(t)
assert.equal(row.endedAt, undefined, "history is left without one")
t = history(t, done({}), START + 6_000)
assert.equal(only(t).endedAt, undefined, "on both the call and its settling update")

console.log("step-timing.check: ok")
