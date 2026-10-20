/* ── A streaming answer, cut where markdown cannot see across ──
   A live answer re-renders on every painted word, and `Prose` used to parse,
   highlight and reconcile the *whole* message each time — O(message) per word.
   Cut into top-level blocks, every block but the last is a string that no
   longer changes, so a memo skips it and only the tail is parsed again.

   The cut is conservative on purpose: a wrong one changes what is drawn, a
   missed one only costs the parse it would have saved. So a boundary is a
   blank line outside any fence whose next line starts flush-left and is not a
   list marker or a quote (either could be the same list or quote continuing —
   a loose list's items are one `<ol>`), and a text holding a reference
   definition or a footnote is never cut, since those resolve across the
   whole document. Each block keeps its trailing blank lines, so the blocks
   join back to the text exactly. */

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const REFERENCE = /^ {0,3}\[[^\]]+\]:/m
const CONTINUES = /^(?:[ \t]|[-*+](?:[ \t]|$)|\d+[.)](?:[ \t]|$)|>)/

export function splitBlocks(text: string): string[] {
  if (REFERENCE.test(text)) return [text]
  const lines = text.split("\n")
  const blocks: string[] = []
  let start = 0 // char offset of the current block
  let offset = 0 // char offset of line i
  let fence: string | null = null
  let blank = false // the previous line was blank, outside a fence
  for (const line of lines) {
    const open = FENCE.exec(line)?.[1]
    if (fence === null) {
      if (blank && line.trim() !== "" && !CONTINUES.test(line) && offset > start) {
        blocks.push(text.slice(start, offset))
        start = offset
      }
      if (open) fence = open
      blank = !open && line.trim() === ""
    } else if (open && open[0] === fence[0] && open.length >= fence.length && line.trim() === open) {
      fence = null
      blank = false
    }
    offset += line.length + 1
  }
  blocks.push(text.slice(start))
  return blocks
}
