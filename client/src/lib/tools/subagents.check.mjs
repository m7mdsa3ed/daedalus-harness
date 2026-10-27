/* The runnable check behind the subagent reader's NAME COLLISION: the harness's
   own `agent` tool shares its leaf name with every runtime's own subagent
   launcher, and the two must not be read as one another.

     ../server/node_modules/.bin/tsx src/lib/tools/subagents.check.mjs   (from client/)

   The rule under test is `docs/plans/agent-tool.md`'s: the harness's tool is
   recognised by what it carries and by the MCP server it came from — never by
   adding a name to the native list — and an `agent` call that started a WORKFLOW
   is not a subagent launch at all (its steps are, and the run card is theirs).
*/
import assert from "node:assert"

import { AGENT, ASK_AGENT, askInfoOf, extractSubagent, isSubagentLaunch, workflowInfoOf } from "./subagents.ts"

/* The harness's own tool, one step: the MCP prefix is the tell, and its answer
   names the child thread and the reply. */
const own = extractSubagent({
  title: "Hand work to an agent",
  name: "mcp__agents__agent",
  meta: {},
  rawInput: { prompt: "audit the auth flow", description: "Audit auth" },
  rawOutput: { content: [{ type: "text", text: JSON.stringify({ id: "run-1", status: "completed", threadId: "child-1", output: "all good" }) }] },
})
assert.ok(own, "the harness's agent call is a subagent launch")
assert.equal(own.tool, AGENT)
assert.equal(own.ask, true, "it names the pair it went to, like an ask")
assert.equal(own.sessionId, "child-1", "its answer names the child thread")
assert.equal(own.result, "all good")
assert.equal(own.description, "Audit auth")

/* Codex's dialect of the same name: a dotted prefix, not an underscore. */
const codexOwn = extractSubagent({
  title: "mcp.agents.agent",
  name: "mcp.agents.agent",
  meta: {},
  rawInput: { prompt: "x" },
  rawOutput: '{"id":"r","status":"running","threadId":"c"}',
})
assert.ok(codexOwn, "Codex's dotted form is the same tool")
assert.equal(codexOwn.tool, AGENT)

/* Claude Code's OWN Agent tool is a bare name, and stays the runtime's. */
const native = extractSubagent({
  title: "Agent",
  name: "agent",
  meta: { claudeCode: { subagent: true } },
  rawInput: { description: "Explore", prompt: "look around", subagent_type: "Explore" },
  content: [{ type: "content", content: { type: "text", text: "found it" } }],
})
assert.ok(native, "the runtime's own Agent is still a subagent")
assert.equal(native.tool, undefined, "and is not read as the harness's tool")
assert.equal(native.agentType, "Explore")
assert.equal(native.description, "Explore")

/* An `agent` call that started a workflow is NOT a subagent launch: it has no
   child of its own, and drawing it as one would put a stray row above the run. */
const run = extractSubagent({
  title: "mcp__agents__agent",
  name: "mcp__agents__agent",
  meta: {},
  rawInput: { steps: [{ name: "one", prompt: "p" }] },
  rawOutput: { content: [{ type: "text", text: JSON.stringify({ id: "run-2", status: "running", steps: [{ name: "one" }] }) }] },
})
assert.equal(run, null, "a workflow call is the run card's business")

/* The retired tool name still reads, for a journal written before the merge. */
const legacy = extractSubagent({
  title: "Ask another agent",
  name: ASK_AGENT,
  meta: {},
  rawInput: { prompt: "x", description: "Look" },
  rawOutput: { content: [{ type: "text", text: '{"askId":"a","status":"completed","threadId":"t","output":"ok"}' }] },
})
assert.ok(legacy)
assert.equal(legacy.tool, ASK_AGENT)
assert.equal(legacy.ask, true)

/* The spawn's own meta is what the row is drawn from, and the one-step run on
   the thread's own pair carries none of it (no chip, no card). */
assert.equal(askInfoOf({ daedalus: { ask: { agent: "Codex", profile: "OpenAI", agentId: "codex", profileId: "p" } } })?.agent, "Codex")
assert.equal(askInfoOf({}), undefined)
assert.equal(workflowInfoOf({ daedalus: { workflow: { runId: "r", name: "n", step: "s" } } })?.runId, "r")
assert.equal(workflowInfoOf({ daedalus: { ask: { agent: "Codex" } } }), undefined, "an ask is not a run")

/* `isSubagentLaunch` is what the transcript asks to find the row a child's work
   groups under: all three launch shapes answer yes, a lifecycle row still no. */
assert.equal(isSubagentLaunch({ title: "mcp__agents__agent", name: "mcp__agents__agent", meta: {}, rawInput: { prompt: "x" } }), true)
assert.equal(
  isSubagentLaunch({ title: "Agent", name: "agent", meta: { codex: { subagent: { path: "/a/b", activity: "interacted" } } }, rawInput: {} }),
  false,
)

console.log("subagents check ok")
