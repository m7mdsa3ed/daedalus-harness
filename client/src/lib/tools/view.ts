/* ── View selection and summaries ── which layout a call gets, and the
   one-line story its closed row tells. Imports every other module; nothing
   here is imported back. */
import type { ToolItem } from "../store"
import { diffStats, extractEdits } from "./edits"
import { extractMcpCall } from "./mcp"
import { toolKindOf } from "./naming"
import { toolOutputText } from "./output"
import { extractFindings, extractPlanProposal, extractQuestions, extractSkill } from "./structured"
import { extractSubagent } from "./subagents"
import { hasTerminalContent } from "./terminal"
import { extractTodos } from "./todos"
import { extractWebFetch, extractWebSearch } from "./web"

// ─── Summary ─────────────────────────────────────────────────────────────────

/**
 * The one-line story of a tool call — churn for edits, match counts for
 * searches, an actual line of output otherwise — so the closed row already
 * says what happened and the expansion is for reading, not for finding out.
 *
 * While the call runs, output is still arriving, so the *last* line is whatever
 * it just produced. Once it settles the last line is usually a trailing blank
 * or a prompt echo, and the *first* line is the one worth freezing on the row.
 */
export function toolSummary(item: ToolItem, active: boolean): string | null {
  if (item.status === "failed") return "error"

  /* A question's story is the answer, not the first line of whatever the
     bridge echoed back — so a collapsed row already says what was chosen. */
  const questions = extractQuestions(item)
  if (questions) {
    const picked = questions.flatMap((question) => question.answer ?? [])
    if (picked.length > 0) {
      const line = picked.join(", ")
      return line.length > 44 ? `${line.slice(0, 44)}…` : line
    }
  }

  const diffs = item.content.filter(
    (block): block is Extract<typeof block, { type: "diff" }> => block.type === "diff"
  )
  const churn = diffs.length
    ? diffs.reduce(
        (total, block) => {
          const stats = diffStats(block.oldText, block.newText)
          return { added: total.added + stats.added, removed: total.removed + stats.removed }
        },
        { added: 0, removed: 0 }
      )
    : (() => {
        // Every hunk, not just the first: a MultiEdit's churn is the sum of
        // its edits, and a Write's is the whole file it created.
        const edits = extractEdits(item)
        if (edits.length === 0) return null
        return edits.reduce(
          (total, edit) => {
            const stats = diffStats(edit.oldText, edit.newText)
            return { added: total.added + stats.added, removed: total.removed + stats.removed }
          },
          { added: 0, removed: 0 }
        )
      })()
  if (churn) return `+${churn.added} −${churn.removed}`

  const { text } = toolOutputText(item, 100_000)
  const lines = text.split("\n").filter((line) => line.trim().length > 0)
  if (lines.length === 0) return null

  if (toolKindOf(item) === "search") {
    return `${lines.length} ${lines.length === 1 ? "match" : "matches"}`
  }

  const line = (active ? lines[lines.length - 1] : lines[0]).trim()
  return line.length > 44 ? `${line.slice(0, 44)}…` : line
}

// ─── View selection ──────────────────────────────────────────────────────────

/**
 * Which layout a call gets. One switch, evaluated in priority order, so the
 * transcript component has a single place to dispatch on and the ordering
 * decisions (a todo list beats its `think` kind; a terminal beats everything,
 * because its content block is a handle rather than a payload) are stated once
 * here rather than implied by the nesting of ifs in a component.
 *
 * The tail of the list is the ACP `kind` — unchanged, and still the answer for
 * every agent that sends one and every tool nobody has taught this file about.
 */
export type ToolView =
  | "todos"
  | "edit"
  | "terminal"
  | "mcp"
  | "subagent"
  | "websearch"
  | "webfetch"
  | "questions"
  | "findings"
  | "plan"
  | "skill"
  | "execute"
  | "read"
  | "search"
  | "fetch"
  | "generic"

/* Cached per item object. The store replaces an item whenever its content
   changes (the reducer's new-array-of-old-refs), so identity is an *exact*
   key: a hit can never be stale. Worth caching because a row asks three
   times per render — `toolHasDetail`, `toolOpensByDefault` and `ToolDetail`
   — and each ask used to walk the 11-extractor chain re-parsing
   rawInput/rawOutput. A WeakMap so a dropped transcript drops its entries. */
const TOOL_VIEW_CACHE = new WeakMap<ToolItem, ToolView>()

export function toolViewOf(item: ToolItem): ToolView {
  const hit = TOOL_VIEW_CACHE.get(item)
  if (hit !== undefined) return hit
  const view = computeToolView(item)
  TOOL_VIEW_CACHE.set(item, view)
  return view
}

function computeToolView(item: ToolItem): ToolView {
  // A diff is the point of the call whatever produced it, and an edit's own
  // content block is already the diff — so both edit paths answer first.
  if (item.content.some((block) => block.type === "diff")) return "edit"
  if (extractEdits(item).length > 0) return "edit"
  if (extractTodos(item)) return "todos"
  if (extractPlanProposal(item) !== null) return "plan"
  if (extractQuestions(item)) return "questions"
  if (extractFindings(item)) return "findings"
  if (extractSubagent(item)) return "subagent"
  if (extractSkill(item)) return "skill"
  if (extractWebSearch(item)) return "websearch"
  if (extractWebFetch(item)) return "webfetch"
  if (extractMcpCall(item)) return "mcp"
  // Only after the specialised views: Codex files a terminal under `execute`
  // and an MCP call under `execute` too, and both want their own layout.
  if (hasTerminalContent(item)) return "terminal"

  const kind = toolKindOf(item)
  if (kind === "execute" || kind === "read" || kind === "search" || kind === "fetch") return kind
  return "generic"
}
