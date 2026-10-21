/* ── MCP calls ── a call into an MCP server, in either of the two forms
   runtimes send. */
import type { ToolItem } from "../store"
import { asRecord, str } from "./helpers"
import { formatMcpName, parseMcpToolName, toolIdentity } from "./naming"
import { stringifyOutput } from "./output"

/**
 * A call into an MCP server, in either of the two forms runtimes send.
 *
 * Claude Code and OpenCode flatten the server into the tool name
 * (`mcp__<server>__<tool>`) and pass the arguments as the raw input; Codex
 * keeps them apart — `mcp.<server>.<tool>` as the title, `{server, tool,
 * arguments}` as the input, `{result, error}` as the output, and `kind:
 * "execute"`, which is what used to route an MCP call into the shell layout
 * and print a `$` prompt in front of nothing.
 */
export interface McpCall {
  server: string
  tool: string
  arguments?: unknown
  result?: unknown
  error?: unknown
}

export function extractMcpCall(
  item: Pick<ToolItem, "title" | "meta" | "rawInput"> & { rawOutput?: unknown }
): McpCall | null {
  const input = asRecord(item.rawInput)
  const output = asRecord(item.rawOutput)
  const flagged = asRecord(item.meta)?.is_mcp_tool_call === true

  const server = str(input?.server)
  const tool = str(input?.tool)
  if (server && tool && (flagged || "arguments" in (input ?? {}))) {
    return {
      server,
      tool,
      arguments: input?.arguments,
      result: output?.result,
      error: output?.error ?? undefined,
    }
  }

  const name = toolIdentity(item)
  if (!name) return null
  const dotted = /^mcp\.([^.]+)\.(.+)$/.exec(name)
  if (dotted) {
    return {
      server: dotted[1],
      tool: dotted[2],
      arguments: item.rawInput,
      result: output?.result ?? item.rawOutput,
      error: output?.error ?? undefined,
    }
  }
  const parsed = parseMcpToolName(name)
  if (!parsed) return null
  return { server: parsed.server, tool: parsed.tool, arguments: item.rawInput, result: item.rawOutput }
}

/**
 * An MCP server's name folded to the key every dialect agrees on.
 *
 * The library row keeps the name the user typed (`GitHub Work`), Claude Code
 * and OpenCode flatten it into the tool name with its punctuation replaced
 * (`mcp__GitHub_Work__search_code`), and Codex dots it (`mcp.GitHub_Work.…`),
 * so the only comparison that holds across all three is case- and
 * punctuation-blind. Used to give a call its server's own mark.
 */
export function mcpServerKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

/**
 * An MCP server's name as a person typed it.
 *
 * Not `formatMcpName`: that one splits on a case boundary, which is right for a
 * tool's identifier (`createTask` really is two words) and wrong for a name —
 * the dialect folded the row's punctuation, never its words, so `GitHub_Work`
 * is "GitHub Work" and not "Git Hub Work", and `Clickup` does not become a
 * different product. A word the dialect lowercased is capitalised; a word that
 * still has its case is left alone.
 */
export function mcpServerLabel(name: string): string {
  return name
    .replace(/[_\-.]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word === word.toLowerCase() ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ")
}

/** The pair a row is titled with — the server, then the tool without the
    vendor's own name repeated in front of it, because Clickup's server names
    its tools `clickup_get_task` and "Clickup · Clickup Get Task" says it twice. */
export function mcpCallLabel(call: McpCall): { server: string; tool: string } {
  const server = mcpServerLabel(call.server)
  const tool = formatMcpName(call.tool)
  const foldedServer = server.toLowerCase()
  const trimmed = tool.toLowerCase().startsWith(`${foldedServer} `)
    ? tool.slice(server.length).trim()
    : tool
  return { server, tool: trimmed }
}

/**
 * Which of an integration's colours a server wears.
 *
 * Derived from its name, the same bargain `InitialMark` makes for a project's
 * initial: a server somebody adds tomorrow gets a colour without anyone
 * choosing one, and the same server is the same colour on every device and in
 * every transcript. Normalised through `mcpServerKey` first, so the dialects'
 * three spellings of one name cannot come out as three colours.
 *
 * Pure and here rather than beside the palette, because *which* colour is a fact
 * about the name and *what colour* is drawing (`MCP_TINTS`, `tool-parts.tsx`).
 */
export function mcpTintIndex(server: string, count: number): number {
  if (count <= 0) return 0
  /* FNV-1a with one avalanche step: the multiply alone leaves the low bits — the
     bits a modulus reads — poorly mixed, so eight integrations landed on six
     colours. Spreading them is the whole job of this function. */
  let hash = 0x811c9dc5
  for (const ch of mcpServerKey(server)) {
    hash = (hash ^ ch.charCodeAt(0)) >>> 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return ((hash ^ (hash >>> 13)) >>> 0) % count
}

/* The argument keys that name the thing an MCP tool acted on, best first.
   A server's arguments are its own vocabulary, but these are the same word in
   most of them — and `Clickup · Get task` on a row has not told the reader
   which task. Ordered so the most specific subject wins: a query or a path
   says more than the `id` a list tool was pointed at, and `id` sits last
   because plenty of servers put a workspace's id there. */
const SUBJECT_KEYS = [
  "query",
  "q",
  "search",
  "search_query",
  "searchQuery",
  "pattern",
  "command",
  "url",
  "uri",
  "path",
  "file",
  "file_path",
  "filePath",
  "sql",
  "libraryName",
  "library_name",
  "task_id",
  "taskId",
  "issue",
  "issue_id",
  "pull_number",
  "repo",
  "owner",
  "name",
  "title",
  "subject",
  "symbol",
  "prompt",
  "description",
  "email",
  "id",
]

/** What an MCP call was about, in the server's own words: a task's name, a
    search's query, a file's path. Null when the arguments name nothing the
    caller can recognise — a server whose whole input is ids the row already
    shows. */
export function mcpSubject(call: McpCall): string | null {
  const args = asRecord(call.arguments)
  if (!args) {
    const scalar = str(call.arguments)
    return scalar?.trim() || null
  }
  for (const key of SUBJECT_KEYS) {
    const value = str(args[key])
    if (value && value.trim()) return value.trim()
  }
  return null
}

export interface McpAnswer {
  /** What the server answered, as text — MCP's content blocks flattened, so a
      result is the letter rather than `{content:[{type:"text",text:"…"}]}`. */
  text: string
  /** The machine-readable half, when the server sent one (`structuredContent`).
      Drawn as a tree of its own, because it is the same answer stated, not
      more of it. */
  structured?: unknown
  /** The server said the call failed — MCP's own `isError`, not a throw. */
  failed: boolean
  /** The answer as a document, when it is one. A view can then say what it has
      (a list's length) and draw the tree without parsing the text again — the
      sample `text` is the same bytes, so the two can never disagree. */
  document?: unknown
}

/** The answer parsed as a document, or undefined. The first-character guard
    keeps a five-megabyte log from being handed to `JSON.parse` only to be told
    it is a log. */
function parseDocument(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

/** MCP's content blocks as text. An image is said, never inlined: its data is
    a base64 wall, and the one place that is drawn is `ContentBlockView`. */
function blocksText(blocks: unknown[]): string {
  return blocks
    .map((entry) => {
      const block = asRecord(entry)
      if (!block) return typeof entry === "string" ? entry : ""
      if (typeof block.text === "string") return block.text
      if (block.type === "image") return "[image]"
      const resource = asRecord(block.resource)
      return str(resource?.uri) ?? str(block.uri) ?? ""
    })
    .filter((text) => text.trim().length > 0)
    .join("\n\n")
}

/**
 * An MCP result, as the reader wants it.
 *
 * The envelope is the reason this exists: a server answers
 * `{content:[{type:"text",text}], structuredContent, isError}`, and drawn as it
 * arrived that is a JSON tree three levels deep around the answer — the reply
 * itself is an escaped string inside `content[0].text`. Flattening the blocks
 * and lifting the structured half beside them is what makes an MCP result read
 * like an answer. `fallback` is the item's own `rawOutput`, for the dialect
 * that keeps the result outside the envelope.
 */
export function mcpAnswer(call: McpCall, fallback?: unknown): McpAnswer {
  const answer = readAnswer(call, fallback)
  return { ...answer, document: parseDocument(answer.text) }
}

/** The answer's parts, before the text is read as a document. */
function readAnswer(call: McpCall, fallback?: unknown): McpAnswer {
  const reported = call.error !== null && call.error !== undefined
  const value = call.result !== undefined && call.result !== null ? call.result : fallback
  const envelope = asRecord(value)
  const structured = envelope?.structuredContent ?? envelope?.structured_content
  const failed =
    reported ||
    envelope?.isError === true ||
    envelope?.is_error === true ||
    (envelope?.error !== null && envelope?.error !== undefined)
  /* One wrapper down: `{result, error}` is how a runtime hands a call's answer
     along — `stringifyOutput` reads the same one — and the letter is inside. */
  const inner = envelope?.result
  if (
    envelope &&
    !Array.isArray(value) &&
    inner !== undefined &&
    inner !== null &&
    (typeof inner === "string" || Array.isArray(inner) || asRecord(inner) !== null)
  ) {
    const answer = readAnswer({ ...call, result: inner, error: undefined })
    return { text: answer.text, structured: answer.structured ?? structured, failed }
  }
  const blocks = Array.isArray(value)
    ? value
    : Array.isArray(envelope?.content)
      ? (envelope.content as unknown[])
      : null
  if (blocks) return { text: blocksText(blocks), structured, failed }
  if (typeof value === "string") return { text: value, structured, failed }
  if (value === undefined || value === null) return { text: "", structured, failed }
  /* No envelope and no blocks: the runtime's own wrapper around the answer
     (`{output}`, `{text}`, `{stdout}` — our own runtime sends the first), read
     by the same unwrapper every other output goes through, and a bare object
     comes back as the document it is. */
  return { text: stringifyOutput(value).text, structured, failed }
}
