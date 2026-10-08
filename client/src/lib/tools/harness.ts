/* ── The harness meta-tools ── `harness_help` and `harness_run`, the two-tool
   face of the harness's own MCP server (`builtin:harness`). They reach every
   part of the harness, so a row for one should say *which operation ran*, not
   which server answered — and its result is the route's JSON, which reads as a
   list or a field-set rather than as a blob.

   This is the one place the client knows the server's two tool names; like
   every other reader here it answers a question (`extract*`) and never matches
   a vendor string itself. */
import type { ToolItem } from "../store"
import { asRecord, str } from "./helpers"
import { extractMcpCall } from "./mcp"
import { bareIdentity, formatMcpName } from "./naming"
import { toolOutputText } from "./output"

export type HarnessVerb = "help" | "run"

export interface HarnessCall {
  verb: HarnessVerb
  /** The harness operation (`tasks_create`), or null for a bare `harness_help`. */
  operation: string | null
  /** What the model passed for the operation — path, query and body together. */
  args: Record<string, unknown>
  /** `harness_help`'s filter, when it asked for one. */
  search: string | null
  error: unknown
}

const HARNESS_LEAVES = new Set(["harness_help", "harness_run"])

type HarnessItem = Pick<ToolItem, "title" | "meta" | "name" | "rawInput"> & { rawOutput?: unknown }

/**
 * A call into the harness server's two meta-tools, or null for everything else.
 *
 * Reached through `extractMcpCall`, so all three runtime shapes work — Claude
 * Code's flattened name, Codex's `{server, tool, arguments}`, and OpenCode's
 * bare identifier — and the server is checked too, so a different MCP server
 * that happens to expose a `harness_run` is not mistaken for ours.
 */
export function extractHarnessCall(item: HarnessItem): HarnessCall | null {
  const leaf = bareIdentity(item)
  if (leaf === null || !HARNESS_LEAVES.has(leaf)) return null
  const call = extractMcpCall(item)
  if (call?.server && call.server !== "harness") return null
  const input = asRecord(call?.arguments) ?? asRecord(item.rawInput) ?? {}
  if (leaf === "harness_help") {
    return { verb: "help", operation: str(input.tool), args: {}, search: str(input.search), error: call?.error }
  }
  return {
    verb: "run",
    operation: str(input.tool),
    args: asRecord(input.args) ?? {},
    search: null,
    error: call?.error,
  }
}

const cap = (value: string): string => (value ? value[0].toUpperCase() + value.slice(1) : value)

/* The verbs an operation name ends with, so `tasks_create` reads "Create tasks"
   rather than "Tasks Create". Anything outside the set falls back to the
   name-as-words, which is still better than the raw identifier. */
const IMPERATIVE = new Set([
  "list", "get", "create", "update", "delete", "set", "add", "remove", "fetch", "test", "run",
  "start", "complete", "reorder", "duplicate", "inject", "search", "install", "reset", "cancel",
  "answer", "comment", "link", "copy", "probe", "apply", "send", "read", "write", "describe",
  "browse", "import", "export", "enable", "disable", "restore", "clear", "rename",
])

/** `projects` → `project`, `entries` → `entry`: an operation on one row names one. */
const singular = (noun: string): string =>
  noun.endsWith("ies") ? `${noun.slice(0, -3)}y` : noun.endsWith("s") && !noun.endsWith("ss") ? noun.slice(0, -1) : noun

/** `tasks_create` → "Create task"; `tasks_list` → "List tasks"; `threads_pending_answer`
    → "Threads Pending Answer". Used for a row's title, never for a call the
    server makes. Only a list names the plural — every other verb acts on one. */
export function harnessOperationLabel(operation: string): string {
  const parts = operation.split("_").filter(Boolean)
  if (parts.length === 2 && IMPERATIVE.has(parts[1])) {
    return `${cap(parts[1])} ${parts[1] === "list" ? parts[0] : singular(parts[0])}`
  }
  return formatMcpName(operation)
}

export type HarnessEffect = "read" | "write" | "destroy"

const READ_VERBS = new Set(["list", "get", "stats", "search", "browse", "read", "describe", "probe", "test", "fetch"])
const DESTROY_VERBS = new Set(["delete", "remove", "cancel", "clear", "reset"])

/** What an operation does to the harness, read off its verb — the closed row
    wears it so a delete never looks like a list. */
export function harnessEffect(operation: string | null): HarnessEffect {
  const verb = operation?.split("_").pop() ?? ""
  if (READ_VERBS.has(verb)) return "read"
  return DESTROY_VERBS.has(verb) ? "destroy" : "write"
}

export type HarnessAction = "list" | "get" | "create" | "update" | "delete" | "run"

const CREATE_VERBS = new Set(["create", "add", "import", "install", "duplicate", "comment", "send", "start", "link", "copy"])
const UPDATE_VERBS = new Set(["update", "set", "reorder", "rename", "enable", "disable", "apply", "write", "complete", "answer", "restore"])

/** The shape of the act, for the row's mark: a list, a lookup, an add, an edit,
    a removal, or anything else the harness can be asked to do. */
export function harnessAction(operation: string | null): HarnessAction {
  const verb = operation?.split("_").pop() ?? ""
  if (verb === "list" || verb === "search" || verb === "browse") return "list"
  if (READ_VERBS.has(verb)) return "get"
  if (CREATE_VERBS.has(verb)) return "create"
  if (UPDATE_VERBS.has(verb)) return "update"
  return DESTROY_VERBS.has(verb) ? "delete" : "run"
}

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max)}…` : value)

/** What a call was *about* — the name or title it was given — for the row's
    caption, so "Create project" says which one. */
export function harnessSubject(call: HarnessCall): string | null {
  const label = str(call.args.name) ?? str(call.args.title) ?? str(call.args.key)
  return label ? clip(label, 48) : null
}

/** One value as a short cell. A `data:` URL is an image, never forty KB of base64. */
export function briefValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return ""
  if (typeof value === "string") {
    if (value.startsWith("data:")) return `inline ${value.slice(5, value.indexOf(";") > 0 ? value.indexOf(";") : 12)} · ${Math.ceil(value.length / 1365)} KB`
    return clip(value.replace(/\s+/g, " "), 64)
  }
  if (Array.isArray(value)) return value.length ? `${value.length} item${value.length === 1 ? "" : "s"}` : ""
  const record = asRecord(value)
  if (record) {
    const size = Object.keys(record).length
    return size ? `${size} field${size === 1 ? "" : "s"}` : ""
  }
  return String(value)
}

/** A record's non-empty fields as label/value pairs, long values clipped. */
export function harnessFields(record: Record<string, unknown>): { key: string; value: string }[] {
  return Object.entries(record)
    .map(([key, value]) => ({ key, value: briefValue(value) }))
    .filter((field) => field.value !== "")
}

/* The column a row is named by, then the ones that say the most about it. Ids
   and timestamps come after because they identify without describing. */
const LABEL_KEYS = ["name", "title", "key", "label"]
const PRIORITY_KEYS = ["status", "state", "kind", "type", "agentId", "model", "cwd", "path", "method", "description"]

export interface HarnessTable {
  columns: string[]
  rows: string[][]
  /** Rows the result had, which is more than `rows` once capped. */
  total: number
}

/** A list result as a table of at most three columns, or null when the rows
    are not records. The columns are *chosen*: the full shape is a click away. */
export function harnessTable(items: unknown[], limit = 10): HarnessTable | null {
  const records = items.map(asRecord)
  if (records.length === 0 || records.some((record) => record === null)) return null
  const rows = records as Record<string, unknown>[]
  const filled = (key: string) => rows.some((row) => briefValue(row[key]) !== "")
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter(filled)
  const head = LABEL_KEYS.find((key) => keys.includes(key)) ?? keys[0]
  if (!head) return null
  const rest = keys.filter((key) => key !== head)
  const ranked = [
    ...PRIORITY_KEYS.filter((key) => rest.includes(key)),
    ...rest.filter((key) => !PRIORITY_KEYS.includes(key) && key !== "id" && !key.endsWith("Id")),
  ]
  const columns = [head, ...ranked.slice(0, 2)]
  return {
    columns,
    rows: rows.slice(0, limit).map((row) => columns.map((key) => briefValue(row[key]))),
    total: rows.length,
  }
}

/** The operation's result, parsed when it is JSON (the tools answer in JSON). */
export function harnessResult(item: ToolItem): { value: unknown; text: string } {
  const { text } = toolOutputText(item, 200_000)
  const trimmed = text.trim()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { value: JSON.parse(trimmed), text }
    } catch {
      /* not JSON after all — drawn as text */
    }
  }
  return { value: null, text }
}

/** What a list result held, as the few names a closed row can show under its
    title — the answer without opening the step. Null for anything that is not
    a list of named rows (a lookup, a write, a still-running call). */
export function harnessPreview(item: ToolItem): { labels: string[]; more: number } | null {
  if (!extractHarnessCall(item)) return null
  const { value } = harnessResult(item)
  if (!Array.isArray(value) || value.length === 0) return null
  const labels = value
    .map((entry) => {
      const record = asRecord(entry)
      return record ? (LABEL_KEYS.map((key) => str(record[key])).find(Boolean) ?? null) : null
    })
    .filter((label): label is string => label !== null)
  if (labels.length === 0) return null
  return { labels: labels.slice(0, 4).map((label) => clip(label.trim(), 28)), more: value.length - 4 }
}

/** The closed row's one line: how many operations for a help, and a
    recognisable field for a run — never the first line of a JSON blob. */
export function harnessSummary(item: ToolItem): string | null {
  const call = extractHarnessCall(item)
  if (!call) return null
  if (item.status === "failed") return "error"
  const { value, text } = harnessResult(item)
  const record = asRecord(value)
  if (call.verb === "help") {
    if (record && typeof record.count === "number") return `${record.count} operations`
    return text.trim() ? "operations" : null
  }
  if (record) {
    const label = str(record.title) ?? str(record.name) ?? str(record.key) ?? str(record.error)
    if (label) return label.length > 44 ? `${label.slice(0, 44)}…` : label
  }
  if (Array.isArray(value)) {
    const resource = call.operation?.split("_")[0]
    return `${value.length} ${resource && value.length !== 1 ? resource : resource ? singular(resource) : "rows"}`
  }
  return null
}
