/* ── Edits and diffs ── before/after pairs carried in tool input, and the
   line-churn arithmetic the row summaries use. */
import type { ToolItem } from "../store"
import { asRecord, str } from "./helpers"
import { isOneOf } from "./naming"

/**
 * Some runtimes carry an edit's before/after in the tool *input* instead of
 * emitting a `diff` content block — snake_case (Claude Code, Codex) or
 * camelCase (OpenCode). Surface it so those edits render as a diff rather than
 * as raw JSON.
 */
export interface EditInputDiff {
  oldText: string
  newText: string
  path?: string
}

export function extractEditInput(item: Pick<ToolItem, "rawInput" | "locations">): EditInputDiff | null {
  const input = asRecord(item.rawInput)
  if (!input) return null
  const oldText = str(input.old_string) ?? str(input.oldString) ?? str(input.old_str)
  const newText = str(input.new_string) ?? str(input.newString) ?? str(input.new_str)
  if (oldText === null || newText === null) return null
  return {
    oldText,
    newText,
    path: str(input.file_path) ?? str(input.filePath) ?? str(input.path) ?? item.locations[0]?.path,
  }
}

/**
 * Every before/after pair a write carries, in order.
 *
 * `extractEditInput` answers the single-hunk case; this one also covers the
 * two shapes that used to fall through to a JSON dump: a `MultiEdit`, whose
 * hunks are an array nested one level down and which is therefore the *only*
 * kind of edit the transcript could not draw, and a whole-file `Write`, whose
 * "before" is the absence of a file rather than a field.
 */
export function extractEdits(item: Pick<ToolItem, "title" | "meta" | "rawInput" | "locations">): EditInputDiff[] {
  const input = asRecord(item.rawInput)
  if (!input) return []
  const path =
    str(input.file_path) ?? str(input.filePath) ?? str(input.path) ?? item.locations[0]?.path

  const nested = input.edits ?? input.replacements ?? input.changes
  if (Array.isArray(nested)) {
    const hunks = nested.flatMap((entry) => {
      const record = asRecord(entry)
      if (!record) return []
      const oldText = str(record.old_string) ?? str(record.oldString) ?? str(record.old_str)
      const newText = str(record.new_string) ?? str(record.newString) ?? str(record.new_str)
      if (oldText === null || newText === null) return []
      return [{
        oldText,
        newText,
        path: str(record.file_path) ?? str(record.filePath) ?? path ?? undefined,
      }]
    })
    if (hunks.length > 0) return hunks
  }

  const single = extractEditInput(item)
  if (single) return [single]

  // A create: the whole file is the "after" and there is no "before". Guarded
  // on the tool actually being a write — plenty of calls carry a `content`
  // field that is not a file body.
  const content = str(input.content) ?? str(input.new_source)
  if (content !== null && isOneOf(item, ["write", "writefile", "write_file", "create_file"])) {
    return [{ oldText: "", newText: content, path: path ?? undefined }]
  }
  return []
}

/** Multiset line difference — honest churn counts without a full LCS. */
export function diffStats(
  oldText: string | null | undefined,
  newText: string
): { added: number; removed: number } {
  const oldLines = oldText ? oldText.split("\n") : []
  const counts = new Map<string, number>()
  for (const line of oldLines) counts.set(line, (counts.get(line) ?? 0) + 1)
  let added = 0
  for (const line of newText.split("\n")) {
    const seen = counts.get(line) ?? 0
    if (seen > 0) counts.set(line, seen - 1)
    else added++
  }
  let removed = 0
  for (const count of counts.values()) removed += count
  return { added, removed }
}
