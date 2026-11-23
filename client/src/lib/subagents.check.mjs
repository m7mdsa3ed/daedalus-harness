/* The one runnable check behind subagent nesting: every runtime's wire shape
   draws as ONE subagent step with the child's events inside it — and the two
   shapes a subagent is announced in build ONE tree. The canonical shape is the
   RFD's `subagent_update`; the superseded draft pair (`subagent_spawned` /
   `subagent_state_update`) is what old journals hold and the workflow engine
   still writes, so every scenario below is fed in the draft AND, translated
   the way the server translates a draft frame on the way in, in the RFD's, and
   the items must come out identical.

     ../server/node_modules/.bin/tsx src/lib/subagents.check.mjs   (from client/)
*/
import assert from "node:assert"

import { applySessionUpdate } from "./store/session-update.ts"
import { buildRows } from "./transcript-rows.ts"
import { extractAgentMessage, extractSubagent } from "./tools/subagents.ts"

/** The server's translation of a draft frame (`subagent-update.ts`), restated
    here so a frame fed in the draft can be fed again in the RFD's shape. */
const ENDINGS = {
  completed: { state: "idle", stopReason: "end_turn" },
  failed: { state: "idle", stopReason: "error" },
  cancelled: { state: "idle", stopReason: "cancelled" },
  disconnected: { state: "_daedalus/disconnected" },
}
const toRfd = (update) => {
  if (update.sessionUpdate === "subagent_spawned") {
    const { subagentSessionId, name, task, capabilities, prompt, cwd, additionalDirectories, _meta, ...rest } = update
    const daedalus = _meta?.daedalus
    const meta = prompt !== undefined && daedalus?.prompt === undefined ? { ...(_meta ?? {}), daedalus: { ...(daedalus ?? {}), prompt } } : _meta
    return {
      ...rest,
      sessionUpdate: "subagent_update",
      sessionId: subagentSessionId,
      title: name,
      description: task,
      capabilities: capabilities?.cancel ? { cancel: {} } : {},
      state: { state: "running" },
      ...(cwd !== undefined ? { cwd } : {}),
      ...(additionalDirectories !== undefined ? { additionalDirectories } : {}),
      ...(meta !== undefined ? { _meta: meta } : {}),
    }
  }
  if (update.sessionUpdate === "subagent_state_update") {
    const { subagentSessionId, state, _meta } = update
    return { sessionUpdate: "subagent_update", sessionId: subagentSessionId, state: ENDINGS[state], ...(_meta !== undefined ? { _meta } : {}) }
  }
  return update
}
const STAMP = 1_700_000_000_000

/** Reduce `[update, sessionId?]` pairs with a fixed clock. */
const reduce = (frames, shape = (u) => u) => {
  let items = []
  for (const [update, sessionId] of frames) items = applySessionUpdate(items, shape(update), false, sessionId, STAMP)
  return items
}
/** A text run's id is minted off a process-wide counter (`mintItemId`), so
    two reductions of one transcript differ there and nowhere else. */
const MINTED = /^(agent|thought|user|notice)-\d+$/
const minted = (items) => items.map((i) => (MINTED.test(i.id) ? { ...i, id: `${i.kind}-*` } : i))
/** Feed the frames in both shapes, insist on one tree, build the rows. */
const rows = (frames) => {
  const draft = reduce(frames)
  const rfd = reduce(frames, toRfd)
  assert.deepStrictEqual(minted(rfd), minted(draft), "the RFD's subagent_update and the draft pair build the same items")
  return buildRows(draft, false, true)
}
const text = (t) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } })
const spawn = (id, extra = {}) => ({ sessionUpdate: "subagent_spawned", subagentSessionId: id, name: "Explore", task: "look around", capabilities: {}, ...extra })
const ended = (id, state = "completed") => ({ sessionUpdate: "subagent_state_update", subagentSessionId: id, state })
const rfd = (id, extra = {}) => ({ sessionUpdate: "subagent_update", sessionId: id, ...extra })
const head = (items, id) => items.find((i) => i.kind === "subagent" && i.id === `subagent:${id}`)
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

// The lifecycle, in both shapes: announced running, ended by each ending —
// the same row, the same clock, the same capability.
{
  for (const state of ["completed", "failed", "cancelled", "disconnected"]) {
    const frames = [[spawn("kid", { capabilities: { cancel: true }, cwd: "/w/kid" })], [tool("c1"), "kid"], [ended("kid", state)]]
    const draft = reduce(frames)
    assert.deepStrictEqual(minted(reduce(frames, toRfd)), minted(draft), `${state}: one tree`)
    const row = head(draft, "kid")
    assert.equal(row.state, state)
    assert.equal(row.capabilities.cancel, true, "an RFD `cancel: {}` reads as the draft's `cancel: true`")
    assert.equal(row.cwd, "/w/kid")
    assert.equal(row.durationMs, 0, "settled on the same clock it started on")
  }
}

// RFD semantics the draft cannot say: an omitted field is unchanged, `null`
// clears one, a running beat and `requires_action` keep the child at work,
// `unknown` keeps what was known, and a bare ending for a child nobody
// announced is a stray in both shapes.
{
  let items = reduce([[rfd("k", { title: "Explore", description: "look", capabilities: { cancel: {} }, state: { state: "running" }, cwd: "/w/k", additionalDirectories: ["/w/shared"] })]])
  assert.equal(head(items, "k").state, "running")
  items = applySessionUpdate(items, rfd("k", { state: { state: "requires_action" } }), false, undefined, STAMP)
  assert.equal(head(items, "k").state, "running", "blocked on a question is still at work")
  items = applySessionUpdate(items, rfd("k", { description: "look harder", cwd: null }), false, undefined, STAMP)
  assert.deepEqual([head(items, "k").name, head(items, "k").task, head(items, "k").cwd, head(items, "k").additionalDirectories], ["Explore", "look harder", undefined, ["/w/shared"]])
  items = applySessionUpdate(items, rfd("k", { state: { state: "unknown" } }), false, undefined, STAMP)
  assert.equal(head(items, "k").state, "running", "unknown keeps what was known")
  items = applySessionUpdate(items, rfd("k", { state: { state: "idle", stopReason: "refusal" }, capabilities: null }), false, undefined, STAMP + 1500)
  assert.deepEqual([head(items, "k").state, head(items, "k").capabilities, head(items, "k").durationMs], ["failed", {}, 1500])
  items = applySessionUpdate(items, rfd("k", { state: { state: "running" } }), false, undefined, STAMP + 5000)
  assert.equal(head(items, "k").runningSince, STAMP + 5000, "woken: a new clock, the settled time kept")
  assert.equal(head(items, "k").durationMs, 1500)
  // A title cleared falls back; an announcement with no title still announces.
  items = applySessionUpdate(items, rfd("k", { title: null }), false, undefined, STAMP)
  assert.equal(head(items, "k").name, "Subagent")
  const bare = reduce([[rfd("anon", { state: { state: "running" } })]])
  assert.equal(head(bare, "anon")?.name, "Subagent", "running is an announcement")
  for (const stray of [[[ended("ghost")]], [[rfd("ghost", { state: { state: "idle", stopReason: "end_turn" } })]]]) {
    assert.equal(reduce(stray).length, 0, "an ending for a child nobody announced is dropped")
  }
}

// Our runtime's own frames (agent/src/turn.ts): announced with the brief in
// `_meta.daedalus.prompt`, ended by `idle`. The item reads as the draft did.
{
  const items = reduce([
    [tool("call_1", { title: "task", rawInput: { description: "d", prompt: "p" } })],
    [rfd("child", { title: "explorer", description: "look", state: { state: "running" }, cwd: "/w", _meta: { daedalus: { parentToolUseId: "call_1", model: "m", role: "r", prompt: "the whole brief" } } })],
    [text("child prose"), "child"],
    [rfd("child", { state: { state: "idle", stopReason: "end_turn" } })],
  ])
  const row = head(items, "child")
  assert.deepEqual([row.name, row.task, row.prompt, row.model, row.role, row.state, row.cwd], ["explorer", "look", "the whole brief", "m", "r", "completed", "/w"])
  assert.equal(items.find((i) => i.parentId === "subagent:child")?.text, "child prose", "the child's work files under it")
}

// An RFD runtime's ending may carry the child's bill (`idle.usage`): added once
// on the settle, not again on a restated snapshot, and never for a child our
// own runtime billed on `_daedalus/subagent_usage` (which leaves it out). A
// limit is a failure, and an unreported reason is not a success.
{
  const bill = { totalTokens: 30, inputTokens: 20, outputTokens: 10 }
  let items = reduce([[rfd("u", { title: "Explore", state: { state: "running" } })]])
  assert.equal(head(items, "u").usage, undefined)
  items = applySessionUpdate(items, rfd("u", { state: { state: "idle", stopReason: "end_turn", usage: bill } }), false, undefined, STAMP)
  assert.deepEqual([head(items, "u").state, head(items, "u").usage], ["completed", bill], "the ending's usage lands on the row")
  items = applySessionUpdate(items, rfd("u", { state: { state: "idle", stopReason: "end_turn", usage: bill } }), false, undefined, STAMP)
  assert.deepEqual(head(items, "u").usage, bill, "a restated ending is not a second bill")
  items = applySessionUpdate(items, rfd("u", { state: { state: "running" } }), false, undefined, STAMP)
  items = applySessionUpdate(items, rfd("u", { state: { state: "idle", stopReason: "end_turn", usage: bill } }), false, undefined, STAMP)
  assert.equal(head(items, "u").usage.totalTokens, 60, "a second turn adds, as _daedalus/subagent_usage does")
  // A child first met already ended, with its bill.
  const late = reduce([[rfd("late", { title: "Late", state: { state: "idle", stopReason: "end_turn", usage: bill } })]])
  assert.deepEqual(head(late, "late").usage, bill)
  // Stop reasons: a limit is a failure; omitted, null or unknown keeps the row's state.
  for (const reason of ["max_tokens", "max_turn_requests"]) {
    const cut = reduce([[rfd("c", { title: "Cut", state: { state: "running" } })], [rfd("c", { state: { state: "idle", stopReason: reason } })]])
    assert.equal(head(cut, "c").state, "failed", `${reason} is not a success`)
  }
  for (const state of [{ state: "idle" }, { state: "idle", stopReason: null }, { state: "idle", stopReason: "_vendor/odd" }]) {
    const kept = reduce([[rfd("n", { title: "N", state: { state: "running" } })], [rfd("n", { state })]])
    assert.equal(head(kept, "n").state, "running", "an unreported reason is not drawn as completed")
  }
}

// A `repl` script's calls (`<scriptId>:<n>`) go under the script, in order; a
// look-alike id under a tool that is not a script, and a call whose script is
// not in the transcript, stay where they arrived.
{
  const script = { name: "repl", rawInput: { code: "return 1" } }
  const items = reduce([
    [tool("s1", script)],
    [tool("s1:1", { name: "read_file" })],
    [tool("s1:2", { name: "grep" })],
    [tool("plain")],
    [tool("plain:1")],
    [tool("gone:1")],
  ])
  const out = buildRows(items, false, true)
  assert.deepEqual(out.map((r) => `${r.kind}:${r.id}`), ["script:s1", "tool:plain", "tool:plain:1", "tool:gone:1"])
  assert.deepEqual(out[0].children.map((r) => r.id), ["s1:1", "s1:2"])
  // A script that has made no call yet is still the script's row, so it does not remount when one lands.
  assert.equal(buildRows(reduce([[tool("s2", script)]]), false, true)[0].kind, "script")
}

console.log("subagents.check: ok")
