/* The one runnable check behind subagent nesting: every runtime's wire shape
   draws as ONE subagent step with the child's events inside it.

     ../server/node_modules/.bin/tsx src/lib/subagents.check.mjs   (from client/)
*/
import assert from "node:assert"

import { applySessionUpdate } from "./store/session-update.ts"
import { buildRows } from "./transcript-rows.ts"
import { extractAgentMessage, extractSubagent } from "./tools/subagents.ts"

/** Feed `[update, sessionId?]` pairs through the reducer, build the rows. */
const rows = (frames) => {
  let items = []
  for (const [update, sessionId] of frames) items = applySessionUpdate(items, update, false, sessionId)
  return buildRows(items, false, true)
}
const text = (t) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } })
const spawn = (id, extra = {}) => ({ sessionUpdate: "subagent_spawned", subagentSessionId: id, name: "Explore", task: "look around", capabilities: {}, ...extra })
const tool = (id, extra = {}) => ({ sessionUpdate: "tool_call", toolCallId: id, title: id, status: "in_progress", ...extra })

/** One top-level subagent group holding `kids` child rows. */
const assertOneStep = (out, kids) => {
  const groups = out.filter((r) => r.kind === "subagent-group")
  assert.equal(groups.length, 1, `one step, got ${out.map((r) => r.kind).join(",")}`)
  assert.equal(groups[0].children.length, kids)
  return groups[0]
}

// Claude Code, native sessions: the Task row is withheld, every child update
// still names it in `parentToolUseId`, and arrives on the child's session.
{
  const meta = { claudeCode: { parentToolUseId: "toolu_task" } }
  const out = rows([
    [spawn("task1", { prompt: "the whole brief" })],
    [{ ...text("reading"), _meta: meta }, "task1"],
    [tool("toolu_read", { _meta: meta }), "task1"],
    [{ sessionUpdate: "tool_call_update", toolCallId: "toolu_read", status: "completed", _meta: meta }, "task1"],
  ])
  assert.equal(out.length, 1, "nothing flat beside the step")
  const step = assertOneStep(out, 2)
  assert.equal(step.head.prompt, "the whole brief")
}

// Workflow mirror: the Task row DOES exist on the step's session, so the meta
// still wins and the Task tree nests inside the step.
{
  const meta = { claudeCode: { parentToolUseId: "toolu_task" } }
  const out = rows([
    [spawn("step")],
    [tool("toolu_task", { title: "Task", rawInput: { description: "d", prompt: "p", subagent_type: "x" } }), "step"],
    [tool("toolu_inner", { _meta: meta }), "step"],
  ])
  const step = assertOneStep(out, 1)
  assert.equal(step.children[0].kind, "subagent-group")
  assert.equal(step.children[0].children[0].id, "toolu_inner")
}

// Our runtime: a `task` call AND a spawn naming it — one step, launch folded in.
{
  const out = rows([
    [tool("call_1", { title: "task", rawInput: { description: "d", prompt: "p" } })],
    [spawn("child1", { _meta: { daedalus: { parentToolUseId: "call_1", model: "m" } } })],
    [text("child prose"), "child1"],
    [tool("child_read"), "child1"],
  ])
  const step = assertOneStep(out, 2)
  assert.equal(step.head.kind, "subagent")
  assert.equal(step.launch?.id, "call_1")
}

// OpenCode: the server's RFD feed plus a `task` call whose output names the
// child session — one step.
{
  const out = rows([
    [tool("oc_task", { title: "task", rawInput: { description: "d", prompt: "p" } })],
    [spawn("ses_child")],
    [tool("oc_read"), "ses_child"],
    [{ sessionUpdate: "tool_call_update", toolCallId: "oc_task", status: "completed", rawOutput: { output: '<task id="ses_child" state="completed"><task_result>done</task_result></task>' } }],
  ])
  const step = assertOneStep(out, 1)
  assert.equal(step.launch?.id, "oc_task")
}

// Codex, native sessions: spawnAgent withheld; the parent's `wait` naming the
// child thread goes under the child's step.
{
  const out = rows([
    [spawn("thr_child")],
    [tool("child_cmd"), "thr_child"],
    [tool("wait_1", { title: "wait", rawInput: { senderThreadId: "root", receiverThreadIds: ["thr_child"], agentsStates: {} } })],
  ])
  const step = assertOneStep(out, 2)
  assert.ok(step.children.some((r) => r.id === "wait_1"))
}

// Codex, native sessions, the inferred worst case: a `spawnAgent` that starts,
// never names its receiver and never completes — folded by its prompt.
{
  const collab = (receivers) => ({ prompt: "audit it", senderThreadId: "root", receiverThreadIds: receivers, agentsStates: {} })
  const out = rows([
    [tool("spawn_1", { title: "spawnAgent", rawInput: collab([]) })],
    [spawn("thr_2", { task: "audit it" })],
    [tool("child_cmd2"), "thr_2"],
  ])
  const step = assertOneStep(out, 1)
  assert.equal(step.launch?.id, "spawn_1")
  assert.equal(out.length, 1)
}

// OpenCode 2 (`opencode acp` 2.0.26, shapes from a live run, translated by the
// server): a `subagent` call, the child announced by title, its work on its
// own session — one step while it runs, and still one once the call reports
// its child in `metadata.sessionID` and the `<subagent>` wrapper.
{
  const launch = tool("call_sub", { title: "subagent", name: "subagent", kind: "think", rawInput: { agent: "general", description: "Run ls and report", prompt: "Run ls" } })
  const running = [
    [launch],
    [spawn("ses_kid", { name: "Run ls and report", task: "Run ls and report" })],
    [tool("ses_kid:call_1", { title: "Run ls and report: shell", _meta: { "opencode/child-session": { id: "ses_kid", parentID: "ses_root", depth: 1 } } }), "ses_kid"],
  ]
  let step = assertOneStep(rows(running), 1)
  assert.equal(step.launch?.id, "call_sub", "linked by title while it runs")
  const done = [...running, [{ sessionUpdate: "tool_call_update", toolCallId: "call_sub", status: "completed",
    content: [{ type: "content", content: { type: "text", text: '<subagent sessionID="ses_kid" state="completed">\nentries: a b\n</subagent>' } }],
    rawOutput: { metadata: { sessionID: "ses_kid", status: "completed", truncated: false } } }]]
  step = assertOneStep(rows(done), 1)
  assert.equal(step.launch?.id, "call_sub")
  const call = extractSubagent(step.launch)
  assert.equal(call.result, "entries: a b", "the report is the child's text, not the wrapper or the metadata")
  assert.equal(call.state, "completed")
}

// Daedalus, RFD: the `task` call is withheld and the spawn's `task` is trimmed,
// so the whole brief rides `_meta.daedalus.prompt` onto the session head.
{
  const brief = "x".repeat(600)
  const out = rows([[spawn("d1", { task: `${brief.slice(0, 500)}…`, _meta: { daedalus: { parentToolUseId: "call_1", prompt: brief } } })]])
  const step = assertOneStep(out, 0)
  assert.equal(step.head.prompt, brief, "the head carries the untrimmed brief")
}

// A follow-up to a subagent reads the same from both dialects, and Claude
// Code's JSON status says whether it landed.
{
  const claude = (text) => ({
    title: "SendMessage",
    meta: { claudeCode: { toolName: "SendMessage" } },
    rawInput: { to: "afdd4444e1281efa0", message: "Resume your task", summary: "Resume backend core" },
    content: [{ type: "content", content: { type: "text", text } }],
  })
  const woke = extractAgentMessage(claude('{"success":true,"message":"Resuming agent afdd444","resumedAgentId":"afdd4444e1281efa0"}'))
  assert.deepEqual([woke.to, woke.delivered, woke.resumed, woke.summary], ["afdd4444e1281efa0", true, "afdd4444e1281efa0", "Resume backend core"])
  const missed = extractAgentMessage(claude('{"success":false,"message":"No agent named \'x\' is reachable."}'))
  assert.equal(missed.delivered, false)
  assert.match(missed.reply, /not reachable|is reachable/)
  const ours = extractAgentMessage({ title: "send_message", rawInput: { agent: "explorer", message: "go on" }, rawOutput: "Done: 3 files" })
  assert.deepEqual([ours.to, ours.delivered, ours.reply], ["explorer", undefined, "Done: 3 files"])
  assert.equal(extractAgentMessage({ title: "Bash", rawInput: {} }), null)
}

// Two subagents thinking at once interleave on one socket. Each run merges
// into ITS OWN stream, not into whatever the wire happened to say last — the
// other order drew one thinking child as a row per chunk of the other's, each
// with its own clock ("Thinking 10s 910ms", "Thinking 10s 637ms", "Thinking 4s
// 611ms" over fragments of one sentence).
{
  const thought = (text) => ({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } })
  let items = []
  for (const [text, sessionId] of [
    ["Since the token", "sa"],
    [" itself is a 256-bit secret, this le", "sa"],
    ["XIF or", "sb"],
    ["ak is negligible, but to avoid it", "sa"],
    ["whatever", "sb"],
  ]) {
    items = applySessionUpdate(items, thought(text), false, sessionId)
  }
  const a = items.filter((i) => i.parentId === "subagent:sa")
  const b = items.filter((i) => i.parentId === "subagent:sb")
  assert.equal(a.length, 1, `the interleaved run is one item, got ${a.length}`)
  assert.equal(a[0].text, "Since the token itself is a 256-bit secret, this leak is negligible, but to avoid it")
  assert.equal(b.length, 1, "and so is the one it interleaved with")
  assert.equal(b[0].text, "XIF orwhatever")
}

console.log("subagents.check: ok")
