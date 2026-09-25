/* ── The composer's text, as an editor document ──
   The composer's model is a plain string — the exact message that will be
   sent, which every completer, the history walk, the draft and the queue all
   read. The editor is a *view* of that string: a line is a paragraph, a
   `[pasted text #n]` token is an inline chip, and a run of `> ` lines is a
   quote card. Both directions live here, together with the one mapping every
   caret reader needs — a string offset to an editor position and back —
   so nothing downstream learns the editor exists.

   A quote is always followed by a blank line on the way out: a line straight
   after `> ` is a lazy continuation of the quote in markdown, which would fold
   the question into the excerpt it is asking about. */
import type { Editor, JSONContent } from "@tiptap/react"
import { pasteToken } from "@/lib/pastes"

type Doc = Editor["state"]["doc"]
type PMNode = ReturnType<Doc["child"]>

const QUOTE_LINE = /^>(?: (.*))?$/
const TOKEN = /\[pasted text #(\d+)\]/g

export function quoteLines(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n")
}

function paragraph(line: string, pastes: ReadonlySet<number>): JSONContent {
  const content: JSONContent[] = []
  let last = 0
  for (const match of line.matchAll(TOKEN)) {
    const n = Number(match[1])
    // A token with no parked body is just text someone typed.
    if (!pastes.has(n)) continue
    if (match.index > last) content.push({ type: "text", text: line.slice(last, match.index) })
    content.push({ type: "pasteToken", attrs: { n } })
    last = match.index + match[0].length
  }
  if (last < line.length) content.push({ type: "text", text: line.slice(last) })
  return content.length ? { type: "paragraph", content } : { type: "paragraph" }
}

export function textToContent(text: string, pastes: ReadonlySet<number>): JSONContent {
  const lines = text.split("\n")
  const blocks: JSONContent[] = []
  for (let i = 0; i < lines.length; i++) {
    if (QUOTE_LINE.test(lines[i])) {
      const quoted: string[] = []
      while (i < lines.length && QUOTE_LINE.test(lines[i])) {
        quoted.push(QUOTE_LINE.exec(lines[i])?.[1] ?? "")
        i++
      }
      blocks.push({ type: "quote", attrs: { text: quoted.join("\n") } })
      // The blank line after a quote is its separator, not a paragraph.
      if (lines[i] !== "") i--
      continue
    }
    blocks.push(paragraph(lines[i], pastes))
  }
  // A caret needs somewhere to land after a card.
  if (blocks.length === 0 || blocks[blocks.length - 1].type === "quote") {
    blocks.push({ type: "paragraph" })
  }
  return { type: "doc", content: blocks }
}

const separator = (previous: PMNode) => (previous.type.name === "quote" ? "\n\n" : "\n")

function inlineText(node: PMNode): string {
  if (node.isText) return node.text ?? ""
  if (node.type.name === "pasteToken") return pasteToken(node.attrs.n as number)
  return ""
}

function blockText(block: PMNode): string {
  if (block.type.name === "quote") return quoteLines(block.attrs.text as string)
  let out = ""
  block.forEach((child) => {
    out += inlineText(child)
  })
  return out
}

/** Blocks joined the way `docToText` joins them — shared with the clipboard,
    so copying out of the box gives what sending it would. */
export function blocksToText(blocks: Pick<Doc, "forEach" | "childCount" | "child">): string {
  let out = ""
  blocks.forEach((block, _offset, index) => {
    if (index > 0) out += separator(blocks.child(index - 1))
    out += block.isTextblock || block.type.name === "quote" ? blockText(block) : block.textContent
  })
  return out
}

export const docToText = (doc: Doc): string => blocksToText(doc)

/** The string offset an editor position stands for. */
export function posToOffset(doc: Doc, pos: number): number {
  let t = 0
  let result: number | null = null
  doc.forEach((block, blockPos, index) => {
    if (result !== null) return
    if (index > 0) t += separator(doc.child(index - 1)).length
    const text = blockText(block)
    if (block.type.name === "quote") {
      if (pos <= blockPos) result = t
      else if (pos <= blockPos + block.nodeSize) result = t + text.length
      else t += text.length
      return
    }
    const start = blockPos + 1
    if (pos > start + block.content.size) {
      t += text.length
      return
    }
    let acc = 0
    let found: number | null = null
    block.forEach((child, offset) => {
      if (found !== null) return
      const at = start + offset
      if (pos <= at) found = acc
      else if (child.isText && pos < at + child.nodeSize) found = acc + (pos - at)
      else acc += inlineText(child).length
    })
    result = t + (found ?? acc)
  })
  return result ?? t
}

/** The editor position a string offset lands on. An offset inside a chip's
    token lands after the chip; one inside a quote lands on the line after it. */
export function offsetToPos(doc: Doc, offset: number): number {
  let t = 0
  let result: number | null = null
  let afterQuote = false
  doc.forEach((block, blockPos, index) => {
    if (result !== null) return
    if (index > 0) t += separator(doc.child(index - 1)).length
    const text = blockText(block)
    if (block.type.name === "quote") {
      if (offset < t + text.length + 2) afterQuote = true
      t += text.length
      return
    }
    const start = blockPos + 1
    if (afterQuote) {
      result = start
      return
    }
    const rel = offset - t
    if (rel > text.length) {
      t += text.length
      return
    }
    let acc = 0
    block.forEach((child, childOffset) => {
      if (result !== null) return
      const at = start + childOffset
      const length = inlineText(child).length
      if (rel <= acc) result = at
      else if (child.isText && rel <= acc + length) result = at + (rel - acc)
      else if (!child.isText && rel < acc + length) result = at + 1
      acc += length
    })
    result ??= start + block.content.size
  })
  return result ?? doc.content.size
}
