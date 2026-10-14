/* The one runnable check behind the subagent report reader: field roles come
   out of real report shapes the way the view expects.

     ../server/node_modules/.bin/tsx src/lib/tools/report.check.mjs   (from client/)
*/
import assert from "node:assert"

import { isTable, parseReport, reportShape } from "./report.ts"

// Fenced, bare, prose, and cut-off text.
assert.deepEqual(parseReport('```json\n{"a":1}\n```'), { a: 1 })
assert.deepEqual(parseReport("[1]"), [1])
assert.equal(parseReport("All good."), null)
assert.equal(parseReport('{"task_id":"869fg2ycj","files_c…'), null)

// A finding: title, badges, location, the rest as text.
const issue = reportShape(
  { file: "src/a.ts", line: 12, severity: "high", problem: "Sync runs every 15s", fix: "x".repeat(80) },
  true
)
assert.equal(issue.title, "Sync runs every 15s")
assert.equal(issue.location, "src/a.ts:12")
assert.deepEqual(issue.badges.map((b) => [b.text, b.tone]), [["high", "bad"]])
assert.deepEqual(issue.texts.map((f) => f.key), ["fix"])
assert.equal(issue.facts.length, 0)

// A commit report at the top level: no title, booleans and shas sorted.
const commit = reportShape({
  task_id: "869fg2ycj",
  committed: true,
  commit_sha: "1763e8aa3f",
  files_changed: ["a.php"],
  summary: "y".repeat(100),
})
assert.equal(commit.title, undefined)
assert.deepEqual(commit.badges.map((b) => [b.text, b.tone]), [["Committed: yes", "good"]])
assert.deepEqual(commit.facts.map((f) => f.key), ["task_id", "commit_sha"])
assert.deepEqual(commit.groups.map((f) => f.key), ["files_changed"])
assert.deepEqual(commit.texts.map((f) => f.key), ["summary"])

// A long `result` is a paragraph, not a badge.
assert.deepEqual(reportShape({ result: "r".repeat(100) }).texts.map((f) => f.key), ["result"])

// Rows of short scalars are a table; anything nested is not.
assert.equal(isTable([{ key: "a", en: "A", ar: "ا" }]), true)
assert.equal(isTable([{ id: 1, queries: ["x"] }]), false)
assert.equal(isTable(["a"]), false)

console.log("report.check: ok")
