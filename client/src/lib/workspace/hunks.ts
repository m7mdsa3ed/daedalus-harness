/* ── One hunk of a diff, cut out and acted on ──
   Monaco computes the diff the Changes tab draws; these two turn one of its
   line changes into the two things the tab can do with it:

   - **stage** it: a unified patch of that hunk alone, with its context read off
     the *original* (the index), for `git apply --cached` — git checks the
     preimage, so a hunk whose surroundings moved is refused with git's words.
   - **revert** it: the worktree text with that hunk's lines put back, written
     through the file route with the version it was read at — the file route's
     409 is the same refusal for the same reason.

   Pure and Monaco-free (the shape is structural), so a transcript chunk that
   imports it never pays for the editor. */

/** Monaco's `ILineChange`, the fields read here. An `EndLineNumber` of 0 means
    that side has no lines: the start is then the line *after which* the other
    side's lines sit. */
export interface LineChange {
  originalStartLineNumber: number
  originalEndLineNumber: number
  modifiedStartLineNumber: number
  modifiedEndLineNumber: number
}

const CONTEXT = 3

function splitLines(text: string): { lines: string[]; eol: boolean } {
  if (text === "") return { lines: [], eol: true }
  const eol = text.endsWith("\n")
  const lines = (eol ? text.slice(0, -1) : text).split("\n")
  return { lines, eol }
}

function sides(change: LineChange, o: string[], m: string[]) {
  const removedAt =
    change.originalEndLineNumber === 0 ? change.originalStartLineNumber : change.originalStartLineNumber - 1
  const removed =
    change.originalEndLineNumber === 0 ? [] : o.slice(removedAt, change.originalEndLineNumber)
  const addedAt =
    change.modifiedEndLineNumber === 0 ? change.modifiedStartLineNumber : change.modifiedStartLineNumber - 1
  const added = change.modifiedEndLineNumber === 0 ? [] : m.slice(addedAt, change.modifiedEndLineNumber)
  return { removedAt, removed, addedAt, added }
}

/** A patch that applies this one hunk to `original`. `path` is relative to
    the directory git runs in (the repository's `dir`). */
export function hunkPatch(path: string, original: string, modified: string, change: LineChange): string {
  const o = splitLines(original)
  const m = splitLines(modified)
  const { removedAt, removed, added } = sides(change, o.lines, m.lines)
  const before = o.lines.slice(Math.max(0, removedAt - CONTEXT), removedAt)
  const afterAt = removedAt + removed.length
  const after = o.lines.slice(afterAt, afterAt + CONTEXT)
  const ctxStart = removedAt - before.length
  const oldCount = before.length + removed.length + after.length
  const newCount = before.length + added.length + after.length
  const start = (count: number) => (count === 0 ? ctxStart : ctxStart + 1)

  /* `\ No newline at end of file` after a line that is its file's last and
     has none. A context line is both files' line; it only gets the marker when
     both lack one — when they disagree the line did change, git says so, and
     the refusal is shown rather than guessed around. */
  const noEol = "\\ No newline at end of file"
  const oLast = o.lines.length - 1
  const out: string[] = [`--- a/${path}`, `+++ b/${path}`, `@@ -${start(oldCount)},${oldCount} +${start(newCount)},${newCount} @@`]
  before.forEach((line) => out.push(` ${line}`))
  removed.forEach((line, i) => {
    out.push(`-${line}`)
    if (!o.eol && removedAt + i === oLast) out.push(noEol)
  })
  added.forEach((line, i) => {
    out.push(`+${line}`)
    if (!m.eol && i === added.length - 1 && change.modifiedEndLineNumber === m.lines.length) out.push(noEol)
  })
  after.forEach((line, i) => {
    out.push(` ${line}`)
    if (!o.eol && !m.eol && afterAt + i === oLast) out.push(noEol)
  })
  return `${out.join("\n")}\n`
}

/** `modified` with this hunk's lines replaced by the original's. */
export function revertHunk(original: string, modified: string, change: LineChange): string {
  const o = splitLines(original)
  const m = splitLines(modified)
  const { removed, addedAt, added } = sides(change, o.lines, m.lines)
  const lines = [...m.lines.slice(0, addedAt), ...removed, ...m.lines.slice(addedAt + added.length)]
  /* The last line's newline goes back too when the hunk reached the end. */
  const reachesEnd = addedAt + added.length >= m.lines.length
  const eol = reachesEnd ? o.eol : m.eol
  return lines.length === 0 ? "" : `${lines.join("\n")}${eol ? "\n" : ""}`
}
