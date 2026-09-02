/* ── The part of a file a call was about ──
   ACP's `ToolCallLocation` carries a path and, at best, a single `line`. That
   is enough to scroll to, and not enough to *show* — a Read of lines 400-460
   and an edit that rewrote one function both arrive as "line 400", and an
   editor that only puts a caret there leaves the reader to work out where the
   agent stopped looking.

   The span is in the call's own `rawInput`, in whichever spelling the runtime
   uses, so reading it belongs here with the rest of the quarantine rather than
   in the component that draws the link. Best-effort throughout: no range is a
   fine answer, and a wrong one is worse than none, so anything that does not
   parse as a pair of positive line numbers is dropped. */
import type * as acp from "@daedalus/acp"
import type { ToolItem } from "../store"
import { asRecord } from "./helpers"
import { extractEdits } from "./edits"
import { toolKindOf } from "./naming"

/** 1-based, inclusive at both ends. `end` is absent when the call named a
    point rather than a span. */
export interface FileRange {
  line: number
  end?: number
}

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined

/** Lines in a chunk of text, for the span an edit's replacement covers. A
    trailing newline does not start a line. */
const lineSpan = (text: string): number => text.replace(/\n$/, "").split("\n").length

/**
 * The line range a tool call was about, for one of its locations.
 *
 * Four sources, in the order they are trusted:
 *
 * - an explicit pair on the input (`start_line`/`end_line`, `line`/`endLine`,
 *   a `range` object) — the runtime said so outright;
 * - Claude Code's `Read`, which pages a file as `offset` + `limit` and is by
 *   far the most common windowed read in a transcript;
 * - an edit, whose span is its replacement's height at the location's line —
 *   the lines that now exist because of the call, which is what "show me what
 *   it changed" means when the editor is looking at the file rather than a
 *   diff;
 * - the location's own `line`, which is the point ACP already gave us.
 *
 * Null when nothing names a line at all, which is most calls: a link with no
 * range opens the file at the top, exactly as before.
 */
export function fileRangeOf(
  item: Pick<ToolItem, "title" | "meta" | "rawInput" | "locations" | "toolKind">,
  location?: acp.ToolCallLocation
): FileRange | null {
  const input = asRecord(item.rawInput)
  const at = location ?? item.locations[0]

  const explicitStart =
    num(input?.start_line) ?? num(input?.startLine) ?? num(asRecord(input?.range)?.start)
  const explicitEnd = num(input?.end_line) ?? num(input?.endLine) ?? num(asRecord(input?.range)?.end)
  if (explicitStart) {
    return { line: explicitStart, ...(explicitEnd && explicitEnd >= explicitStart ? { end: explicitEnd } : {}) }
  }

  /* Claude Code's `Read` pages a file as `offset` + `limit`, and its `offset`
     is a *line number* (the numbers it prints beside the text start there),
     not an index — so it is taken as one, with 0 meaning the top for any
     runtime that does treat it as an index. The two readings differ by a
     single line, which is the right size of error for a highlight and the
     wrong size for arithmetic that pretended to be exact.

     `limit` is a count. A window that runs past the end of the file is clamped
     by the editor, which has the file; this side does not. */
  const offset = typeof input?.offset === "number" && input.offset >= 0 ? Math.floor(input.offset) : undefined
  const limit = num(input?.limit)
  if (offset !== undefined) {
    const start = Math.max(1, offset)
    return { line: start, ...(limit ? { end: start + limit - 1 } : {}) }
  }

  const line = num(at?.line)
  if (!line) return null

  if (toolKindOf(item) === "edit") {
    const hunk = extractEdits({ ...item, locations: item.locations }).find(
      (edit) => !edit.path || !at?.path || edit.path === at.path
    )
    const height = hunk ? lineSpan(hunk.newText) : 0
    if (height > 1) return { line, end: line + height - 1 }
  }

  return { line }
}

/** The range as a person writes it — `42` or `42-58` — for a link's label and
    its tooltip. */
export function formatRange(range: FileRange): string {
  return range.end && range.end > range.line ? `${range.line}-${range.end}` : `${range.line}`
}
