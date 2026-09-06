/* ── Todo lists ── the agent's checklist, however its runtime spells one. */
import type { ToolItem } from "../store"
import { asRecord, str } from "./helpers"
import { isOneOf } from "./naming"

/**
 * The agent's checklist, however its runtime spells one.
 *
 * Claude Code's `TodoWrite` and OpenCode's `todowrite` both pass the whole list
 * as tool *input* and return nothing worth reading, and neither maps to ACP's
 * `plan` channel — so without this the most-repeated call in a long thread
 * renders as a JSON dump of the same array over and over. Codex is the
 * exception and needs nothing here: it sends a real ACP plan, which the
 * transcript already draws as a plan.
 *
 * Field names differ (`activeForm` vs `content`, an `id`/`priority` OpenCode
 * carries and Claude does not) and so does the status vocabulary, so both are
 * normalised onto ACP's own three statuses — the ones `PlanStep` already
 * knows how to colour.
 */
export interface TodoEntry {
  content: string
  status: "pending" | "in_progress" | "completed"
  priority?: "high" | "medium" | "low"
}

const TODO_STATUS: Record<string, TodoEntry["status"]> = {
  pending: "pending",
  todo: "pending",
  not_started: "pending",
  queued: "pending",
  in_progress: "in_progress",
  active: "in_progress",
  running: "in_progress",
  started: "in_progress",
  completed: "completed",
  done: "completed",
  complete: "completed",
  // A cancelled item is finished, not pending — folding it into `completed`
  // keeps the counter honest without inventing a fourth colour.
  cancelled: "completed",
  canceled: "completed",
  skipped: "completed",
}

const TODO_PRIORITY = new Set(["high", "medium", "low"])

function readTodoList(value: unknown): TodoEntry[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const todos: TodoEntry[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    if (!record) continue
    // `activeForm` is the present-tense phrasing Claude Code sends alongside
    // the imperative one; it is the better label while the item is running.
    const status = TODO_STATUS[String(record.status ?? "").toLowerCase()] ?? "pending"
    const content =
      (status === "in_progress" ? str(record.activeForm) : null) ??
      str(record.content) ??
      str(record.text) ??
      str(record.title) ??
      str(record.task) ??
      str(record.activeForm)
    if (!content) continue
    const priority = String(record.priority ?? "").toLowerCase()
    todos.push({
      content,
      status,
      priority: TODO_PRIORITY.has(priority) ? (priority as TodoEntry["priority"]) : undefined,
    })
  }
  return todos.length > 0 ? todos : null
}

export function extractTodos(item: Pick<ToolItem, "title" | "meta" | "rawInput" | "rawOutput">): TodoEntry[] | null {
  const input = asRecord(item.rawInput)
  // The list lives in the input; the output is an acknowledgement. Read the
  // output only as a fallback, for a runtime that echoes the list back and
  // sends no input at all.
  return (
    readTodoList(input?.todos) ??
    readTodoList(input?.todo_list) ??
    readTodoList(input?.items) ??
    readTodoList(asRecord(item.rawOutput)?.todos) ??
    (isOneOf(item, ["todowrite", "todoread", "todo_write", "update_plan"])
      ? readTodoList(item.rawInput)
      : null)
  )
}
