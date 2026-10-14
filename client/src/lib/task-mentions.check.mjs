/* The one runnable check behind task mentions: the bubble folds the block the
   server appends back out, and nothing else.

     ../server/node_modules/.bin/tsx src/lib/task-mentions.check.mjs   (from client/)
*/
import assert from "node:assert"
import { TASK_MENTION_RE, splitTaskContext } from "./task-mentions.ts"

const block = [
  "",
  "",
  "<tasks>",
  "The message above mentions 2 tasks...",
  "",
  '<task key="TASK-11" id="a">',
  "Title: one",
  "</task>",
  "",
  '<task key="TASK-12" id="b">',
  "Title: two",
  "Description:",
  "line",
  "</task>",
  "</tasks>",
].join("\n")

{
  const out = splitTaskContext(`fix @TASK-11 and @TASK-12${block}`)
  assert.strictEqual(out.text, "fix @TASK-11 and @TASK-12")
  assert.strictEqual(out.tasks.get("TASK-11"), "Title: one")
  assert.strictEqual(out.tasks.get("TASK-12"), "Title: two\nDescription:\nline")
}

// No block, or one that is not the tail: the text is untouched.
for (const text of ["plain @TASK-1", "typed <tasks>\n<task key=\"X-1\">\nx\n</task>\n</tasks> then more"]) {
  const out = splitTaskContext(text)
  assert.strictEqual(out.text, text)
  assert.strictEqual(out.tasks.size, 0)
}

assert.ok(TASK_MENTION_RE.test("see @TASK-11."))
assert.ok(!TASK_MENTION_RE.test("me@TASK-11 @task-11 @TASK-x"))

console.log("task-mentions: ok")
