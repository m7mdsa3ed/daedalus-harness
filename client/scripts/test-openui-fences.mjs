import assert from "node:assert/strict"
import { splitOpenuiFences } from "../src/lib/openui/fences.ts"

const program = 'root = Stack([body])\nbody = Section("Hello")'
for (const tag of ["openui-lang", "openui", "ui-lang"]) {
  assert.deepEqual(splitOpenuiFences(`before\n\`\`\`${tag}\n${program}\n\`\`\`\nafter`, false), [
    "before\n",
    {
      start: 7,
      end: 7 + `\`\`\`${tag}\n${program}\n\`\`\``.length,
      code: program + "\n",
      open: false,
    },
    "\nafter",
  ], `recognizes closed ${tag} fences`)
}

assert.deepEqual(splitOpenuiFences(`\`\`\`ui-lang\n${program}`, true), [
  { start: 0, end: `\`\`\`ui-lang\n${program}`.length, code: program, open: true },
], "recognizes an unclosed ui-lang fence while streaming")
assert.deepEqual(splitOpenuiFences(`\`\`\`ui-lang\n${program}`, false), [
  `\`\`\`ui-lang\n${program}`,
], "leaves an unclosed ui-lang fence as prose after the row settles")
assert.deepEqual(splitOpenuiFences("```ui-lang\n" + program + "\n```\n\n```suggest-prompts\nnext\n```", false), [
  { start: 0, end: (`\`\`\`ui-lang\n${program}\n\`\`\``).length, code: program + "\n", open: false },
  "\n\n```suggest-prompts\nnext\n```",
], "keeps following suggestions outside the OpenUI fence")

console.log("openui fence tests passed")
