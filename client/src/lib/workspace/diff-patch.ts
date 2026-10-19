/* ── A unified diff, cut into things you can act on ──
   The merge view draws git's own `diff` output rather than Monaco's: the hunks
   are git's, so a hunk (or a few of its lines) goes back to `git apply` as the
   patch it already is. Three verbs ride on that, all the same patch with a
   different flag — stage (`--cached`), unstage (`--cached --reverse`) and
   discard (`--reverse`, worktree only).

   Pure and DOM-free, like `hunks.ts`; `diff-patch.check.mjs` runs it against git. */

export interface DiffLine {
  /** ' ' context, '+' added, '-' removed. */
  kind: " " | "+" | "-"
  text: string
  /** Followed by `\ No newline at end of file`. */
  noEol?: boolean
}

export interface Hunk {
  /** The `@@ -a,b +c,d @@ heading` line as git wrote it. */
  header: string
  oldStart: number
  newStart: number
  /** What follows the second `@@`: git's guess at the enclosing function. */
  heading: string
  lines: DiffLine[]
}

export interface FilePatch {
  /** Everything before the first hunk: `diff --git`, mode and rename lines, `---`/`+++`. */
  head: string[]
  hunks: Hunk[]
  binary: boolean
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/

export function parsePatch(text: string): FilePatch {
  const out: FilePatch = { head: [], hunks: [], binary: false }
  let hunk: Hunk | null = null
  for (const line of text.split("\n")) {
    const match = HUNK.exec(line)
    if (match) {
      hunk = { header: line, oldStart: Number(match[1]), newStart: Number(match[2]), heading: match[3] ?? "", lines: [] }
      out.hunks.push(hunk)
    } else if (!hunk) {
      if (/^Binary files .* differ$|^GIT binary patch/.test(line)) out.binary = true
      if (line) out.head.push(line)
    } else if (line.startsWith("\\")) {
      const last = hunk.lines[hunk.lines.length - 1]
      if (last) last.noEol = true
    } else if (line[0] === "+" || line[0] === "-" || line[0] === " ") {
      hunk.lines.push({ kind: line[0] as DiffLine["kind"], text: line.slice(1) })
    }
  }
  return out
}

/** The lines of a hunk a person can pick: the changed ones. */
export const isChange = (line: DiffLine): boolean => line.kind !== " "

/**
 * A patch for `hunk` alone, or for only the `picked` lines of it (indices into
 * `hunk.lines`). Applied forward, an unpicked '+' is left out and an unpicked
 * '-' stays as context; applied with `reverse` (the target already holds the
 * change) it is the other way round. Null when nothing picked is a change.
 */
export function patchFor(file: FilePatch, hunk: Hunk, picked?: ReadonlySet<number>, reverse = false): string | null {
  const body: string[] = []
  let oldCount = 0
  let newCount = 0
  let changed = false
  hunk.lines.forEach((line, index) => {
    let kind = line.kind
    if (picked && isChange(line) && !picked.has(index)) {
      const leftOut = reverse ? "-" : "+"
      if (kind === leftOut) return
      kind = " "
    } else if (isChange(line)) changed = true
    body.push(`${kind}${line.text}`)
    if (line.noEol) body.push("\\ No newline at end of file")
    if (kind !== "+") oldCount += 1
    if (kind !== "-") newCount += 1
  })
  if (!changed) return null
  const heading = hunk.heading ? ` ${hunk.heading}` : ""
  const start = oldCount === 0 ? hunk.oldStart : Math.max(1, hunk.oldStart)
  return [...file.head, `@@ -${start},${oldCount} +${start},${newCount} @@${heading}`, ...body, ""].join("\n")
}
