/* ── Is a pasted body a document or a blob? ──
   A paste is parked as a chip because it was too long to sit in the composer,
   and what arrives is usually one of two things: a brief, a spec, a pull request
   body — markdown someone wrote, whose headings, lists and tables are half of
   what it says — or a file's worth of something else, a stack trace above all.

   The second must never be read as the first. A trace has no blank lines, and
   markdown's rule for a line break inside a paragraph is to join it to the one
   before, so forty frames would come back as one paragraph of run-on text: the
   popover would be *less* readable than the `<pre>` it replaced.

   So the question is decided, never assumed. Markdown's own evidence answers it
   when it is there — a heading, a list item at a line's start, a quote, a fence,
   a table, a reference definition — because a document that holds one is one.
   Failing that, a short run of plain lines is still a paragraph, while a long
   one with nothing between is line-broken data and stays verbatim. */

/** A line that runs to the panel's edge unchanged is not prose. */
const LONG = 200
/** This many plain lines in a row, with nothing between them, is a log. */
const RUN = 4

const EVIDENCE = [
  /^ {0,3}#{1,6} /m, // an ATX heading
  /^ {0,3}(?:[-*+]|\d+[.)]) /m, // a list item
  /^ {0,3}> /m, // a quote
  /^ {0,3}(?:`{3,}|~{3,})/m, // a fence
  /^ {0,3}\|.*\|/m, // a table row
  /^ {0,3}\[[^\]]+\]:/m, // a reference definition
]
const FENCE = /^ {0,3}(?:`{3,}|~{3,})/

/** The longest run of consecutive non-blank lines outside any fence. */
function longestRun(text: string): number {
  let fence: string | null = null
  let run = 0
  let longest = 0
  for (const line of text.split("\n")) {
    const open = FENCE.exec(line)?.[0].trimStart() ?? null
    if (fence !== null) {
      if (open && open[0] === fence[0] && open.length >= fence.length) fence = null
      continue
    }
    if (open) {
      fence = open
      run = 0
      continue
    }
    if (line.trim() === "") {
      run = 0
      continue
    }
    run += 1
    longest = Math.max(longest, run)
  }
  return longest
}

/** Whether a pasted body should be drawn as markdown rather than as a `<pre>`. */
export function readsAsMarkdown(text: string): boolean {
  const body = text.trim()
  if (!body) return false
  if (body.split("\n").some((line) => line.length > LONG)) return false
  if (EVIDENCE.some((rule) => rule.test(body))) return true
  return longestRun(body) < RUN
}
