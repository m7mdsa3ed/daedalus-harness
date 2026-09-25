/* The one runnable check behind the composer's editor: a string loaded into
   the document comes back out as the same string, and every caret offset
   survives the trip to an editor position and back (landing past a chip or a
   quote card when it pointed inside one).

     ../server/node_modules/.bin/tsx src/components/composer/editor-text.check.mjs   (from client/)
*/
import assert from "node:assert"
import { Node, getSchema } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"

import { docToText, offsetToPos, posToOffset, textToContent } from "./editor-text.ts"

// The schema the editor builds, minus the React node views.
const schema = getSchema([
  StarterKit.configure({ blockquote: false, bulletList: false, codeBlock: false, hardBreak: false, heading: false, horizontalRule: false, listItem: false, orderedList: false }),
  Node.create({ name: "pasteToken", group: "inline", inline: true, atom: true, addAttributes: () => ({ n: { default: 0 } }) }),
  Node.create({ name: "quote", group: "block", atom: true, addAttributes: () => ({ text: { default: "" } }) }),
])
const load = (text, pastes = [1]) => schema.nodeFromJSON(textToContent(text, new Set(pastes)))

// Round trips that must be exact.
for (const text of [
  "",
  "hello",
  "one\ntwo\n\nthree",
  "see [pasted text #1] here",
  "[pasted text #1]",
  "[pasted text #2] is not parked",
  "> quoted\n\nquestion?",
  "> a\n>\n> b\n\n",
  "before\n\n> q\n\nafter [pasted text #1] end",
  "/compact now",
  "!pnpm test",
  "snake_case and *stars* and [brackets]",
]) {
  assert.strictEqual(docToText(load(text)), text, JSON.stringify(text))
}

// Structure: tokens with a body are chips, quotes are cards.
{
  const doc = load("a [pasted text #1] b\n\n> q")
  assert.strictEqual(doc.child(0).child(1).type.name, "pasteToken")
  assert.strictEqual(doc.child(2).type.name, "quote")
  assert.strictEqual(doc.child(2).attrs.text, "q")
  assert.strictEqual(doc.lastChild.type.name, "paragraph", "a paragraph after the last card")
}

// A line straight after a quote is separated on the way out.
assert.strictEqual(docToText(load("> q\nnext")), "> q\n\nnext")

// Every offset outside a chip or a card maps to a position and back.
{
  const text = "ab [pasted text #1] cd\nef\n\n> q1\n> q2\n\ngh"
  const doc = load(text)
  const token = "[pasted text #1]"
  const tokenStart = text.indexOf(token)
  const quoteStart = text.indexOf("> q1")
  const quoteEnd = text.indexOf("gh")
  for (let offset = 0; offset <= text.length; offset++) {
    const back = posToOffset(doc, offsetToPos(doc, offset))
    if (offset > tokenStart && offset < tokenStart + token.length) {
      assert.strictEqual(back, tokenStart + token.length, `inside the chip at ${offset}`)
    } else if (offset >= quoteStart && offset < quoteEnd) {
      assert.strictEqual(back, quoteEnd, `inside the quote at ${offset}`)
    } else {
      assert.strictEqual(back, offset, `offset ${offset}`)
    }
  }
}

console.log("editor-text: ok")
