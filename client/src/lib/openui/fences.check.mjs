/* The OpenUI fence splitter must preserve valid fences and retain an
   unterminated fence after an interrupted turn settles.

     ../server/node_modules/.bin/tsx src/lib/openui/fences.check.mjs   (from client/)
*/
import assert from "node:assert"

import { splitOpenuiFences } from "./fences.ts"

const code = 'root = Stack([view])\nview = Section("Hello")'

assert.deepStrictEqual(splitOpenuiFences(`before\n\n\`\`\`openui-lang\n${code}\n\`\`\`\n\nafter`, false), [
  "before\n\n",
  { start: 8, end: 8 + `\`\`\`openui-lang\n${code}\n\`\`\``.length, code: `${code}\n`, open: false },
  "\n\nafter",
])

const partial = `intro\n\n\`\`\`openui-lang\n${code}`
const settled = splitOpenuiFences(partial, false)
assert.deepStrictEqual(settled, [
  "intro\n\n",
  { start: 7, end: partial.length, code, open: false },
])

const live = splitOpenuiFences(partial, true)
assert.deepStrictEqual(live, [
  "intro\n\n",
  { start: 7, end: partial.length, code, open: true },
])

assert.deepStrictEqual(splitOpenuiFences("A normal `openui-lang` mention", false), ["A normal `openui-lang` mention"])
assert.deepStrictEqual(splitOpenuiFences(`\`\`\`pasted-text #1\n${code}\n\`\`\``, false), [`\`\`\`pasted-text #1\n${code}\n\`\`\``])

console.log("openui-fences: ok")
