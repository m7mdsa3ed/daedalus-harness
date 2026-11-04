/* One runnable check behind the hairline after a workflow run: a run still
   going draws none, a finished one is closed off from what came next, and one
   with nothing after it leaves the transcript's tail alone.

     ../server/node_modules/.bin/tsx src/lib/workflow-separator.check.mjs
   (from client/)
*/
import assert from "node:assert"

import { applySessionUpdate } from "./store/session-update.ts"
import { buildRows, separatorAfterRun } from "./transcript-rows.ts"

/** The engine writes the draft pair; the RFD's `subagent_update` is the
    canonical shape. Both must draw the same card (the server's translation,
    `subagent-update.ts`, restated). */
const ENDINGS = {
  completed: { state: "idle", stopReason: "end_turn" },
  failed: { state: "idle", stopReason: "error" },
  cancelled: { state: "idle", stopReason: "cancelled" },
  disconnected: { state: "_daedalus/disconnected" },
}
const toRfd = (u) =>
  u.sessionUpdate === "subagent_spawned"
    ? { sessionUpdate: "subagent_update", sessionId: u.subagentSessionId, title: u.name, description: u.task, capabilities: {}, state: { state: "running" }, _meta: u._meta }
    : u.sessionUpdate === "subagent_state_update"
      ? { sessionUpdate: "subagent_update", sessionId: u.subagentSessionId, state: ENDINGS[u.state] }
      : u
const STAMP = 1_700_000_000_000
/** Feed `[update, sessionId?]` pairs through the reducer in both shapes, build the rows. */
const rows = (frames) => {
  const reduce = (shape) => {
    let items = []
    for (const [update, sessionId] of frames) items = applySessionUpdate(items, shape(update), false, sessionId, STAMP)
    return items
  }
  const draft = reduce((u) => u)
  // A text run's id is minted off a process-wide counter: the one honest difference.
  const minted = (items) => items.map((i) => (/^(agent|thought|user|notice)-\d+$/.test(i.id) ? { ...i, id: `${i.kind}-*` } : i))
  assert.deepStrictEqual(minted(reduce(toRfd)), minted(draft), "the RFD's subagent_update and the draft pair build the same items")
  return buildRows(draft, false, true)
}
const text = (t) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } })
const step = (runId, index, total) => ({
  sessionUpdate: "subagent_spawned",
  subagentSessionId: `${runId}-${index}`,
  name: "Plan",
  task: "plan it",
  capabilities: {},
  _meta: { daedalus: { workflow: { runId, name: "Ship it", step: `step ${index}`, index, total } } },
})
const settle = (runId, index, state = "completed") => ({
  sessionUpdate: "subagent_state_update",
  subagentSessionId: `${runId}-${index}`,
  state,
})
const hold = (runId, paused) => ({ sessionUpdate: "_daedalus/workflow_state", runId, paused })
/** The rows that open with a rule, asked the way `thread-view` asks. */
const ruled = (out) => out.flatMap((_, i) => (separatorAfterRun(out, i) ? [i] : []))
const kinds = (out) => out.map((row) => row.kind).join(",")

// Still running: no rule, however much arrives after it.
{
  const out = rows([[step("run1", 0, 2)], [text("while it works")]])
  assert.equal(kinds(out), "workflow-group,agent")
  assert.equal(out[0].finished, false, "a run with a step in flight is not finished")
  assert.deepEqual(ruled(out), [], "no rule while the run is going")
}

// Held is live too, however quiet its steps are.
{
  const out = rows([[step("run1", 0, 1)], [settle("run1", 0)], [hold("run1", true)], [text("while it is held")]])
  assert.equal(out[0].finished, false, "a held run is not finished")
  assert.deepEqual(ruled(out), [], "no rule while the run is held")
}

// Finished, with events after it: the next row opens with the rule.
for (const state of ["completed", "failed", "cancelled"]) {
  const out = rows([[step("run1", 0, 1)], [settle("run1", 0, state)], [text("after the run")]])
  assert.equal(kinds(out), "workflow-group,agent")
  assert.equal(out[0].finished, true, `a ${state} run is finished`)
  assert.deepEqual(ruled(out), [1], `the reply after a ${state} run opens with the rule`)
}

// A run that dies on its second of four steps never spawns the rest. The
// definition's count cannot be what says it is over, or it never would be.
{
  const out = rows([
    [step("run1", 0, 4)],
    [settle("run1", 0)],
    [step("run1", 1, 4)],
    [settle("run1", 1, "failed")],
    [text("the run failed")],
  ])
  assert.equal(out[0].finished, true, "a failed run is finished with steps still unspawned")
  assert.deepEqual(ruled(out), [1], "the reply after a failed run opens with the rule")
}

// Finished, and nothing after it: no trailing rule.
{
  const out = rows([[step("run1", 0, 1)], [settle("run1", 0)]])
  assert.equal(kinds(out), "workflow-group")
  assert.equal(out[0].finished, true)
  assert.deepEqual(ruled(out), [], "nothing after the run, so nothing trails")
}

// Two runs in one thread: each finished one that is followed by events gets its
// own rule, and a running tail draws none.
{
  const out = rows([
    [step("run1", 0, 1)],
    [settle("run1", 0)],
    [text("after the first")],
    [step("run2", 0, 2)],
    [text("while the second works")],
  ])
  assert.equal(kinds(out), "workflow-group,agent,workflow-group,agent")
  assert.deepEqual(ruled(out), [1], `one rule per finished run, got ${ruled(out)}`)
}

// Both finished, both followed: two rules.
{
  const out = rows([
    [step("run1", 0, 1)],
    [settle("run1", 0)],
    [text("after the first")],
    [step("run2", 0, 1)],
    [settle("run2", 0)],
    [text("after the second")],
  ])
  assert.equal(kinds(out), "workflow-group,agent,workflow-group,agent")
  assert.deepEqual(ruled(out), [1, 3], `each finished run gets its own rule, got ${ruled(out)}`)
}

/* ── A native (Claude Code) run ──
   Its steps are previews of agents inside the CLI, and a queued agent reads as
   running for as long as the run does, so the run's own task state is what says
   it is over. The launch row is what the run stands in place of. */
const launch = { sessionUpdate: "tool_call", toolCallId: "t1", title: "Workflow", status: "in_progress", content: [] }
const spawned = {
  sessionUpdate: "async_task_spawned",
  asyncTaskId: "wf1",
  name: "Audit",
  taskType: "workflow",
  description: "audit",
  showInTranscript: true,
  canStop: true,
  toolCallId: "t1",
}
const progress = (state) => ({
  sessionUpdate: "async_task_progress",
  asyncTaskId: "wf1",
  workflowProgress: [{ type: "workflow_agent", index: 0, label: "look", state }],
})
const ended = (state) => ({ sessionUpdate: "async_task_state_update", asyncTaskId: "wf1", state })
const launched = {
  sessionUpdate: "tool_call_update",
  toolCallId: "t1",
  status: "completed",
  content: [
    {
      type: "content",
      content: {
        type: "text",
        text: "Workflow launched in background. Task ID: wf1\nSummary: audit\nTranscript dir: /tmp/wf\nRun ID: wf1",
      },
    },
  ],
}

// Its one agent is done, but the task is still running: not finished.
{
  const out = rows([[launch], [spawned], [progress("done")], [launched], [text("while it works")]])
  assert.equal(kinds(out), "workflow-group,agent", "the run stands where its launch was")
  assert.equal(out[0].finished, false, "the task's state decides, not its agents'")
  assert.deepEqual(ruled(out), [], "no rule while the task runs")
}

for (const state of ["completed", "failed", "stopped"]) {
  const out = rows([[launch], [spawned], [progress("done")], [launched], [ended(state)], [text("after the run")]])
  assert.equal(out[0].finished, true, `a ${state} task is finished`)
  assert.deepEqual(ruled(out), [1], `the reply after a ${state} task opens with the rule`)
}

/* ── "Answers only" ──
   The layout folds the run's card into a `work-fold`, so the row above the next
   answer is the fold and not the workflow. The rule still belongs there, and is
   read off the fold's last inner row. */
const folded = (frames) => {
  let items = []
  for (const [update, sessionId] of frames) items = applySessionUpdate(items, update, false, sessionId)
  return buildRows(items, false, true, false, false, true)
}

// Finished and folded, with an answer after it: the answer opens with the rule.
{
  const out = folded([[step("run1", 0, 1)], [settle("run1", 0)], [text("after the run")]])
  assert.equal(kinds(out), "work-fold,agent", "the run's card is inside the fold")
  assert.equal(out[0].rows[0].kind, "workflow-group")
  assert.deepEqual(ruled(out), [1], "the answer after a folded run opens with the rule")
}

// Still running and folded: no rule.
{
  const out = folded([[step("run1", 0, 2)], [text("while it works")]])
  assert.equal(kinds(out), "work-fold,agent")
  assert.deepEqual(ruled(out), [], "no rule while a folded run is going")
}

// Folded with nothing after it: no trailing rule.
{
  const out = folded([[step("run1", 0, 1)], [settle("run1", 0)]])
  assert.equal(kinds(out), "work-fold")
  assert.deepEqual(ruled(out), [], "nothing after the fold, so nothing trails")
}

// The fold's last inner row is the test, not its first: a finished run followed
// by another piece of folded work puts no rule at the end of the fold.
{
  const out = folded([
    [step("run1", 0, 1)],
    [settle("run1", 0)],
    [{
      sessionUpdate: "tool_call",
      toolCallId: "t9",
      title: "Read a file",
      kind: "read",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "read" } }],
    }],
    [text("after the work")],
  ])
  assert.equal(kinds(out), "work-fold,agent")
  assert.equal(kinds(out[0].rows), "workflow-group,tool", `got ${kinds(out[0].rows)}`)
  assert.deepEqual(ruled(out), [], "the fold does not end in the run, so no rule")
}

console.log("workflow-separator.check: ok")
