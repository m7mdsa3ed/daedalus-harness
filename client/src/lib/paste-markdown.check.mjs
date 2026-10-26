/* A pasted body is drawn as markdown only when it is a document. What the
   decision has to keep apart is a brief (headings, lists, a table — read better
   laid out) and a blob (a stack trace, a log, minified JSON — destroyed by the
   paragraph rule that joins a line to the one above it).

     ../server/node_modules/.bin/tsx src/lib/paste-markdown.check.mjs   (from client/)
*/
import assert from "node:assert"

import { readsAsMarkdown } from "./paste-markdown.ts"

const md = (text) => assert.equal(readsAsMarkdown(text), true, `should read as markdown:\n${text}`)
const raw = (text) => assert.equal(readsAsMarkdown(text), false, `should stay verbatim:\n${text}`)

// A brief: a heading is evidence, and a wrapped paragraph under it is prose.
md("# Brief\n\nSomething about the work, wrapped\nover two lines.")
md("Some words first.\n\n- one\n- two\n\nAnd after the list.")
md("Steps:\n\n1. do this\n2. then that")
md("> a quoted line\n\nand the reply to it.")
md("```ts\nconst a = 1\n```\n\nAbove was a fence.")
md("| a | b |\n| - | - |\n| 1 | 2 |")
md("[ref]: https://example.com\n\nThe link is [ref].")
// Two short paragraphs with no syntax at all are still a document.
md("One sentence here.\n\nAnd a second paragraph.")

// A stack trace: no blank lines, and far more consecutive lines than a
// paragraph — joined by markdown it would be one run-on block.
raw(
  [
    "Traceback (most recent call last):",
    '  File "app.py", line 12, in <module>',
    "    main()",
    '  File "app.py", line 8, in main',
    "    run()",
    "TypeError: 'NoneType' object is not callable",
  ].join("\n")
)
// A log: same shape across hundreds of lines.
raw(
  Array.from({ length: 40 }, (_, i) => `2026-10-25T09:0${i % 10}:00Z INFO worker ${i} tick`).join("\n")
)
// A minified blob has one line the panel's width would swallow.
raw(JSON.stringify({ a: 1, b: "x".repeat(400) }))
// An empty or whitespace-only paste draws nothing either way.
raw("")
raw("   \n\n  ")

// Four plain lines is where line-broken data starts; three is still a paragraph
// that was pasted hard-wrapped.
raw("one\ntwo\nthree\nfour")
md("one\ntwo\nthree")

// Fence evidence wins over a long body: the fence is the document's own word.
md("Intro\n\n```\n" + Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n```")

console.log("paste-markdown: ok")
