/* The one runnable check behind the `repl` reader: the three result forms the
   agent writes (agent/src/tools/repl.ts `resultText` and its stop notes) come
   apart into value, error and console the way the view expects.

     pnpm exec tsx src/lib/tools/code.check.mjs   (from client/)
*/
import assert from "node:assert"

import { codeRunSummary, extractCodeRun, parseCodeResult } from "./code.ts"

// A returned value, with console lines after it.
assert.deepEqual(parseCodeResult('{\n  "missing": []\n}\n\nconsole:\nchecked 11\ndone'), {
  result: '{\n  "missing": []\n}',
  error: null,
  stopped: false,
  logs: ["checked 11", "done"],
})

// A throw, and the stop notes.
const threw = parseCodeResult("The script threw:\nError: boom\n    at repl.js:2:9")
assert.equal(threw.error, "Error: boom\n    at repl.js:2:9")
assert.equal(threw.stopped, false)
assert.equal(parseCodeResult("[script cancelled]").stopped, true)
assert.equal(parseCodeResult("[script killed after 600s]").stopped, true)
assert.equal(parseCodeResult("[the script sandbox exited (1) before the script finished]\noops").stopped, true)
assert.equal(parseCodeResult("Could not start the script sandbox: ENOENT").stopped, true)
// A returned string that merely mentions brackets is a value.
assert.equal(parseCodeResult("[1,2]").result, "[1,2]")

// The row: only our `repl`, never an MCP server's tool of the same leaf name.
const item = (over) => ({
  title: "check links",
  name: "repl",
  meta: undefined,
  status: "completed",
  rawInput: { code: "return 1", description: "check links" },
  content: [{ type: "content", content: { type: "text", text: '{\n  "missing": [\n    "two.md"\n  ]\n}' } }],
  ...over,
})
const run = extractCodeRun(item({}))
assert.equal(run?.language, "javascript")
assert.equal(codeRunSummary(run), '{"missing":["two.md"]}')
assert.equal(extractCodeRun(item({ name: "mcp__python__repl" })), null)
assert.equal(extractCodeRun(item({ rawInput: {} })), null)
assert.equal(extractCodeRun(item({ status: "in_progress" }))?.result, null)
assert.equal(codeRunSummary(extractCodeRun(item({ content: [{ type: "content", content: { type: "text", text: "The script threw:\nx" } }] }))), "threw")

// The tally: read off the row's own _meta, most-called first, junk dropped.
const tallied = extractCodeRun(item({ meta: { daedalus: { stepId: "s", repl: { calls: { grep: 2, edit_file: 129, read_file: 38, bogus: "x", zero: 0 } } } } }))
assert.deepEqual(tallied?.calls, [
  { name: "edit_file", count: 129 },
  { name: "read_file", count: 38 },
  { name: "grep", count: 2 },
])
assert.deepEqual(extractCodeRun(item({}))?.calls, [])

console.log("code.check.mjs passed")
