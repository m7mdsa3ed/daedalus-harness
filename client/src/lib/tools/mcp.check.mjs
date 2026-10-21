/* The runnable check behind the MCP reader: the three dialects' shapes come out
   as one call, the row says what the call was about, and the envelope is
   unwrapped to the answer instead of drawn as JSON three levels deep.

     ../server/node_modules/.bin/tsx src/lib/tools/mcp.check.mjs   (from client/)
*/
import assert from "node:assert"

import { extractMcpCall, mcpAnswer, mcpCallLabel, mcpServerKey, mcpServerLabel, mcpSubject } from "./mcp.ts"
import { toolHeading } from "./heading.ts"

// Claude Code / OpenCode: flattened name, arguments as the raw input.
const flat = extractMcpCall({
  title: "mcp__Clickup__create_task",
  meta: { claudeCode: {} },
  rawInput: { name: "Fix login", list_id: "901" },
  rawOutput: { content: [{ type: "text", text: '{"id":"86a1"}' }] },
})
assert.deepEqual([flat.server, flat.tool], ["clickup", "create_task"])

// Codex: the pair kept apart, the envelope hoisting the result.
const codex = extractMcpCall({
  title: "mcp.Clickup.get_task",
  meta: {},
  rawInput: { server: "Clickup", tool: "get_task", arguments: { task_id: "86a1" } },
  rawOutput: { result: { content: [{ type: "text", text: "Mobile kanban" }] }, error: null },
})
assert.deepEqual([codex.server, codex.tool], ["Clickup", "get_task"])
assert.equal(codex.error, undefined)

// Not an MCP call at all.
assert.equal(extractMcpCall({ title: "Bash", meta: {}, rawInput: { command: "ls" } }), null)

// A name folded the way all three spellings agree on.
assert.equal(mcpServerKey("GitHub Work"), mcpServerKey("GitHub_Work"))
assert.equal(mcpServerKey("Mawared HR"), "mawaredhr")

// The pair a row is titled with: a person's spelling of the server, and the
// vendor's name not said twice (`clickup_get_task` on a server called Clickup).
assert.equal(mcpServerLabel("GitHub_Work"), "GitHub Work")
assert.equal(mcpServerLabel("chrome-devtools"), "Chrome Devtools")
assert.equal(mcpServerLabel("Clickup"), "Clickup")
assert.deepEqual(mcpCallLabel({ server: "Clickup", tool: "clickup_get_task" }), {
  server: "Clickup",
  tool: "Get Task",
})
assert.deepEqual(mcpCallLabel({ server: "context7", tool: "query-docs" }), {
  server: "Context7",
  tool: "Query Docs",
})

// The subject: the argument that names the thing acted on, never the workspace id.
assert.equal(mcpSubject({ server: "s", tool: "t", arguments: { name: "Fix login", id: "900" } }), "Fix login")
assert.equal(mcpSubject({ server: "s", tool: "t", arguments: { owner: "o", repo: "r", path: "src/a.ts" } }), "src/a.ts")
assert.equal(mcpSubject({ server: "s", tool: "t", arguments: { limit: 20 } }), null)
assert.equal(mcpSubject({ server: "s", tool: "t", arguments: "a scalar" }), "a scalar")

// The answer: content blocks flattened, structured content lifted out, failure said.
const answer = mcpAnswer({
  server: "s",
  tool: "t",
  result: {
    content: [{ type: "text", text: '{"id":"86a1"}' }, { type: "image" }],
    structuredContent: { id: "86a1" },
    isError: false,
  },
})
assert.equal(answer.text, '{"id":"86a1"}\n\n[image]')
assert.deepEqual(answer.structured, { id: "86a1" })
assert.equal(answer.failed, false)
assert.equal(mcpAnswer({ server: "s", tool: "t", result: { content: [], isError: true } }).failed, true)
assert.equal(mcpAnswer({ server: "s", tool: "t", result: "plain" }).text, "plain")
assert.equal(mcpAnswer({ server: "s", tool: "t" }, { ok: true }).text, '{\n  "ok": true\n}')
assert.equal(mcpAnswer({ server: "s", tool: "t" }, { result: { content: [{ type: "text", text: "deep" }] } }).text, "deep")

// The runtime's own wrapper around the answer, not a document to unfold.
assert.equal(mcpAnswer({ server: "s", tool: "t" }, { output: "the letter" }).text, "the letter")
assert.equal(mcpAnswer({ server: "s", tool: "t" }, { text: "the letter" }).text, "the letter")
// A bare object IS the answer, so it stays the document it is.
assert.equal(mcpAnswer({ server: "s", tool: "t", result: { count: 2 } }).text, '{\n  "count": 2\n}')

// The row: the integration and the tool in the title, the subject as its caption.
const heading = toolHeading({
  title: "mcp__Clickup__create_task",
  meta: {},
  rawInput: { name: "Fix login", list_id: "901" },
})
assert.equal(heading.title, "Clickup · Create Task")
assert.equal(
  toolHeading({ title: "mcp__GitHub_Work__search_code", meta: {}, rawInput: { query: "Socket" } }).title,
  // The runtime lowercased the prefix, so the case of "GitHub" is gone before
  // the reader sees it; the library's own spelling is the row's mark, not its text.
  "Github Work · Search Code"
)
assert.equal(heading.detail, "Fix login")
assert.equal(heading.prose, false)

// The web's own rules still claim a web MCP tool before this one does.
const web = toolHeading({
  title: "mcp__web-search__web_search",
  meta: {},
  rawInput: { query: "reducer" },
})
assert.equal(web.title, "Search the web for “reducer”")

console.log("mcp.check: ok")
