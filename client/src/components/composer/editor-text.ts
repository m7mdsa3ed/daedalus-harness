/* ── The composer's text, as an editor document ──
   The composer's model is a plain string — the exact message that will be
   sent, which every completer, the history walk, the draft and the queue all
   read. The editor is a *view* of that string: a line is a paragraph, and three
   things are inline chips inside one — a `[pasted text #n]` token, a finished
   `@path` mention, and a run of `> ` lines (a quote). Both directions live here,
   together with the one mapping every caret reader needs — a string offset to
   an editor position and back — so nothing downstream learns the editor exists.

   A quote is a chip in the view and still a markdown block in the string: it
   is written on a line of its own and always followed by a blank line, because
   a line straight after `> ` is a lazy continuation of the quote in markdown,
   which would fold the question into the excerpt it is asking about. Loaded
   back, the quote rides at the start of the line that follows it. */
import type { Editor, JSONContent } from "@tiptap/react"
import { pasteToken } from "@/lib/pastes"
import { MENTION_KINDS } from "@/lib/mentions/grammar"

type Doc = Editor["state"]["doc"]
type PMNode = ReturnType<Doc["child"]>

const QUOTE_LINE = /^>(?: (.*))?$/
/* A paste token, a finished mention, or a link. A mention is `@` at a word
   boundary, a path-looking run (a `/`, `.` or `~` in it — `@channel` in prose
   stays text), a task key (`@DAE-12`, see `file-mentions.tsx`) or a typed
   reference of a known kind (`@thread:abc`, `lib/mentions/grammar.ts` — an
   unknown `@foo:bar` stays text), then a space or the line's end. A token still ending in `/` is a directory being drilled
   into by the completer, and one ending in punctuation is a sentence's. A link
   is an http(s) run; trailing sentence punctuation is trimmed below. */
const INLINE = new RegExp(
  String.raw`\[pasted text #(\d+)\]|(?<=^|[\s(])@([^\s@]*[/.~][^\s@]*|[A-Z][A-Z0-9]{1,5}-\d+|(?:${MENTION_KINDS.join("|")}):[^\s@]+)(?=\s|$)|https?:\/\/[^\s<>()]+`,
  "g",
)
const NOT_A_MENTION_END = /[/.,;:!?)\]}'"]$/
/* A trailing `.`/`,`/`)` is almost always the sentence's, not the URL's. */
const NOT_A_LINK_END = /[.,;:!?)\]}'"]+$/

export function quoteLines(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n")
}

function inline(line: string, pastes: ReadonlySet<number>): JSONContent[] {
  const content: JSONContent[] = []
  let last = 0
  for (const match of line.matchAll(INLINE)) {
    let chip: JSONContent
    let end = match.index + match[0].length
    if (match[1] !== undefined) {
      const n = Number(match[1])
      // A token with no parked body is just text someone typed.
      if (!pastes.has(n)) continue
      chip = { type: "pasteToken", attrs: { n } }
    } else if (match[2] !== undefined) {
      if (NOT_A_MENTION_END.test(match[2])) continue
      chip = { type: "mention", attrs: { path: match[2] } }
    } else {
      /* The URL proper, with its sentence's punctuation left outside the chip —
         the trailing run stays text, matched last. */
      const url = match[0].replace(NOT_A_LINK_END, "")
      if (!url) continue
      chip = { type: "link", attrs: { url } }
      end = match.index + url.length
    }
    if (match.index > last) content.push({ type: "text", text: line.slice(last, match.index) })
    content.push(chip)
    last = end
  }
  if (last < line.length) content.push({ type: "text", text: line.slice(last) })
  return content
}

export function textToContent(text: string, pastes: ReadonlySet<number>): JSONContent {
  const lines = text.split("\n")
  const blocks: JSONContent[] = []
  // Quotes waiting for the line they lead.
  let pending: JSONContent[] = []
  for (let i = 0; i < lines.length; i++) {
    if (QUOTE_LINE.test(lines[i])) {
      const quoted: string[] = []
      while (i < lines.length && QUOTE_LINE.test(lines[i])) {
        quoted.push(QUOTE_LINE.exec(lines[i])?.[1] ?? "")
        i++
      }
      pending.push({ type: "quote", attrs: { text: quoted.join("\n") } })
      // The blank line after a quote is its separator, not a paragraph.
      if (lines[i] !== "") i--
      continue
    }
    const content = [...pending, ...inline(lines[i], pastes)]
    pending = []
    blocks.push(content.length ? { type: "paragraph", content } : { type: "paragraph" })
  }
  if (pending.length) blocks.push({ type: "paragraph", content: pending })
  if (blocks.length === 0) blocks.push({ type: "paragraph" })
  return { type: "doc", content: blocks }
}

function inlineText(node: PMNode): string {
  if (node.isText) return node.text ?? ""
  switch (node.type.name) {
    case "pasteToken":
      return pasteToken(node.attrs.n as number)
    case "mention":
      return `@${node.attrs.path as string}`
    case "link":
      return node.attrs.url as string
    case "quote":
      return `${quoteLines(node.attrs.text as string)}\n\n`
    default:
      return ""
  }
}

/** Each child's share of the string. A quote is the one piece whose text
    depends on what precedes it: it starts a line of its own. */
function pieces(block: PMNode): string[] {
  const out: string[] = []
  let line = ""
  block.forEach((child) => {
    let piece = inlineText(child)
    if (child.type.name === "quote" && line !== "" && !line.endsWith("\n")) piece = `\n${piece}`
    out.push(piece)
    line += piece
  })
  return out
}

/** Blocks joined the way `docToText` joins them — shared with the clipboard,
    so copying out of the box gives what sending it would. */
export function blocksToText(blocks: Pick<Doc, "forEach">): string {
  const lines: string[] = []
  blocks.forEach((block) => {
    lines.push(block.isTextblock ? pieces(block).join("") : block.textContent)
  })
  return lines.join("\n")
}

export const docToText = (doc: Doc): string => blocksToText(doc)

/** The string offset an editor position stands for. */
export function posToOffset(doc: Doc, pos: number): number {
  let t = 0
  let result: number | null = null
  doc.forEach((block, blockPos, index) => {
    if (result !== null) return
    if (index > 0) t += 1
    const parts = pieces(block)
    const start = blockPos + 1
    if (pos > start + block.content.size) {
      t += parts.join("").length
      return
    }
    let acc = 0
    let found: number | null = null
    block.forEach((child, offset, i) => {
      if (found !== null) return
      const at = start + offset
      if (pos <= at) found = acc
      else if (child.isText && pos < at + child.nodeSize) found = acc + (pos - at)
      else acc += parts[i].length
    })
    result = t + (found ?? acc)
  })
  return result ?? t
}

/** The editor position a string offset lands on. An offset inside a chip's
    text lands after the chip. */
export function offsetToPos(doc: Doc, offset: number): number {
  let t = 0
  let result: number | null = null
  doc.forEach((block, blockPos, index) => {
    if (result !== null) return
    if (index > 0) t += 1
    const parts = pieces(block)
    const length = parts.join("").length
    const start = blockPos + 1
    const rel = offset - t
    if (rel > length) {
      t += length
      return
    }
    let acc = 0
    block.forEach((child, childOffset, i) => {
      if (result !== null) return
      const at = start + childOffset
      const size = parts[i].length
      if (rel <= acc) result = at
      else if (child.isText && rel <= acc + size) result = at + (rel - acc)
      else if (!child.isText && rel < acc + size) result = at + child.nodeSize
      acc += size
    })
    result ??= start + block.content.size
  })
  return result ?? doc.content.size
}
