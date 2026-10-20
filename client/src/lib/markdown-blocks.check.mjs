/* The one runnable check behind `splitBlocks`: a streaming answer is cut only
   where markdown cannot see across, and the cut loses nothing.

     ../server/node_modules/.bin/tsx src/lib/markdown-blocks.check.mjs   (from client/)
*/
import assert from "node:assert"

import { splitBlocks } from "./markdown-blocks.ts"

const roundTrip = (text) => {
  const blocks = splitBlocks(text)
  assert.strictEqual(blocks.join(""), text, `join loses text: ${JSON.stringify(text)}`)
  return blocks
}

// ── Paragraphs and headings are cut, each keeping its trailing blank line ──
assert.deepStrictEqual(roundTrip("# Title\n\nOne.\n\nTwo"), ["# Title\n\n", "One.\n\n", "Two"])
assert.deepStrictEqual(roundTrip("One line"), ["One line"])
assert.deepStrictEqual(roundTrip(""), [""])

// ── Never inside a fence, closed or still open ──
const fenced = "Intro\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\nAfter"
assert.deepStrictEqual(roundTrip(fenced), ["Intro\n\n", "```ts\nconst a = 1\n\nconst b = 2\n```\n\n", "After"])
assert.deepStrictEqual(roundTrip("Intro\n\n~~~\na\n\nb"), ["Intro\n\n", "~~~\na\n\nb"])
// A shorter run does not close a longer fence.
assert.strictEqual(roundTrip("````\n```\n\nx\n````").length, 1)

// ── Never inside a loose list, a quote or an indented continuation ──
assert.strictEqual(roundTrip("1. one\n\n2. two\n\n3. three").length, 1)
assert.strictEqual(roundTrip("- a\n\n- b\n\n* c").length, 1)
assert.strictEqual(roundTrip("- a\n\n  still a\n\n- b").length, 1)
assert.strictEqual(roundTrip("> quoted\n\n> still quoted").length, 1)
assert.strictEqual(roundTrip("text\n\n    code\n\n    more").length, 1)

// ── Never when something resolves across the document ──
assert.strictEqual(roundTrip("See [x].\n\nMore.\n\n[x]: https://example.com").length, 1)
assert.strictEqual(roundTrip("Note[^1].\n\nMore.\n\n[^1]: The note.").length, 1)

console.log("markdown-blocks: ok")
