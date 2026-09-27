/* ── Names and vendor identity ── which tool a call was, and which kind to
   render it as, whatever the runtime called it. */
import type { ToolItem } from "../store"
import { asRecord, str, vendorMeta } from "./helpers"

export type ToolKind = NonNullable<ToolItem["toolKind"]>

// ─── Names ───────────────────────────────────────────────────────────────────

/* ACP grew a tool-name field (`ToolCall.name`, still marked experimental in
   SDK 1.4) and it is the answer when a runtime sends one — our own agent does,
   and it was the only runtime whose rows had no name at all, because its
   titles are prose by design ("Subagent: …", "Search for …").

   The title sniff stays for the three that do not send it yet: `title` is
   human-readable prose ("Read package.json") for most agents, but several send
   the bare identifier ("Bash", "mcp__crm__search"). Treat the title as a name
   only when it looks like one, so a prose title never gets matched against the
   table below. */
/* Hyphens and dots are part of a name too: an MCP server is registered as
   `web-search`, so its tools arrive as `mcp__web-search__web_search`, and a
   pattern that stopped at `[A-Za-z0-9_]` read that as prose — which made it
   the row's title, verbatim. Prose has spaces; a name does not. */
export const NAME_RE = /^(mcp__)?[A-Za-z_][\w.-]*$/

/* `name` is widened past `ToolItem`'s own: the reducer passes the raw ACP
   update, where the field is nullable (`null` and absent both mean "no name"). */
export function toolNameOf(item: Pick<ToolItem, "title"> & { name?: string | null }): string | null {
  const declared = item.name?.trim()
  if (declared) return declared.toLowerCase()
  const title = item.title.trim()
  return NAME_RE.test(title) ? title.toLowerCase() : null
}

/** Common tool names across runtimes → a display kind, when ACP didn't send one. */
const NAME_KINDS: Record<string, ToolKind> = {
  bash: "execute",
  shell: "execute",
  run: "execute",
  execute: "execute",
  terminal: "execute",
  read: "read",
  readfile: "read",
  read_file: "read",
  cat: "read",
  ls: "read",
  list: "read",
  write: "edit",
  writefile: "edit",
  write_file: "edit",
  edit: "edit",
  editfile: "edit",
  multiedit: "edit",
  str_replace: "edit",
  apply_patch: "edit",
  notebookedit: "edit",
  glob: "search",
  grep: "search",
  search: "search",
  find: "search",
  webfetch: "fetch",
  web_fetch: "fetch",
  fetch: "fetch",
  fetch_url: "fetch",
  fetch_page: "fetch",
  read_url: "fetch",
  websearch: "fetch",
  web_search: "fetch",
  search_web: "fetch",
  exa_search: "fetch",
  brave_web_search: "fetch",
  tavily_search: "fetch",
  task: "other",
  agent: "other",
  todowrite: "other",
  todoread: "other",
}

/** The kind to render a call as: the protocol's answer, else the name's.

    The name is read through `toolIdentity` (defined below, next to the rest of
    the vendor-shape readers) rather than off the title alone: Claude Code's
    titles are prose, so a call whose kind the adapter omitted used to fall all
    the way through to "other" even though its name was sitting in `_meta`. */
export function toolKindOf(item: Pick<ToolItem, "title" | "toolKind" | "meta">): ToolKind {
  /* `other` is the protocol saying nothing, not saying "other": Claude Code
     files every MCP tool under it, so a name that does say something — a
     `web_fetch`, a `search` — is the better answer and gets the icon. Any
     other kind the agent sent stands. */
  if (item.toolKind && item.toolKind !== "other") return item.toolKind
  const name = bareIdentity(item)
  if (!name) return item.toolKind ?? "other"
  if (/^select:/i.test(name)) return item.toolKind ?? "other"
  return NAME_KINDS[name] ?? item.toolKind ?? "other"
}

/**
 * The tool's own name with any MCP server prefix removed — `web_search` out of
 * `mcp__web-search__web_search` (Claude Code, OpenCode) or
 * `mcp.web-search.web_search` (Codex). An MCP server's tool is named by what
 * it does exactly as a built-in is, and every reader below that asks "is this a
 * web search" wants that name, not the server's. Bare names pass through.
 */
export function toolLeafName(name: string): string {
  const dotted = /^mcp\.[^.]+\.(.+)$/.exec(name)
  if (dotted) return dotted[1]
  if (!name.startsWith("mcp__")) return name
  const rest = name.slice("mcp__".length)
  const sep = rest.indexOf("__")
  return sep === -1 ? rest : rest.slice(sep + 2)
}

/** Present a server or tool identifier as a readable label. */
export function formatMcpName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/websearch/gi, "web search")
    .replace(/webfetch/gi, "web fetch")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word.length > 1 && word === word.toUpperCase() ? word : word[0].toUpperCase() + word.slice(1)))
    .join(" ")
}

export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  // Codex's form. Its separator is a dot and a server name may not contain
  // one, so the first two segments are the whole answer and the rest of the
  // tool name (which may itself contain dots) is kept intact.
  const dotted = /^mcp\.([^.]+)\.(.+)$/.exec(name)
  if (dotted) return { server: dotted[1], tool: dotted[2] }
  if (!name.startsWith("mcp__")) return null
  const rest = name.slice("mcp__".length)
  const sep = rest.indexOf("__")
  if (sep <= 0) return { server: rest, tool: "" }
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) }
}

/**
 * A tool name as a human reads it: an MCP tool names its server first, so a
 * row says which integration acted, not just `mcp__crm_kb__search_docs`.
 */
export function toolDisplayName(name: string): string {
  const selector = /^select:(.+)$/i.exec(name)
  if (selector) {
    const choices = selector[1].split(",").map((choice) => formatMcpName(choice.trim())).filter(Boolean)
    return choices.length ? `Select ${choices.join(" / ")}` : "Select tool"
  }
  const mcp = parseMcpToolName(name)
  if (!mcp) return name
  const server = formatMcpName(mcp.server)
  const tool = formatMcpName(mcp.tool)
  return tool ? `${server} · ${tool}` : server
}

/** Whether a selector-style tool identity includes one of the named tools. */
export function toolSelectorIncludes(
  item: Pick<ToolItem, "title" | "meta" | "name">,
  names: string[]
): boolean {
  const identity = toolIdentity(item)
  if (!identity) return false
  const selector = /^select:(.+)$/i.exec(identity)
  if (!selector) return false
  const selected = selector[1].split(",").map((choice) => choice.trim().toLowerCase())
  return names.some((name) => selected.includes(name.toLowerCase()))
}

/** Does the call use a multi-tool selector that includes both web actions? */
export function isWebToolSelector(item: Pick<ToolItem, "title" | "meta" | "name">): boolean {
  return toolSelectorIncludes(item, ["websearch"]) && toolSelectorIncludes(item, ["webfetch"])
}

/* ACP's kinds that cannot have written to the worktree: they read, they look
   something up, they think. Everything else may have — `edit`, `delete` and
   `move` say so, `execute` runs a shell that can `sed`, and `other` is the
   protocol saying *nothing* (Claude Code files every MCP tool under it), which
   is not the same as saying "harmless". The set is deliberately the
   read-only one rather than the writing one: a kind nobody anticipated — a
   future ACP verb, an MCP server that writes files — lands on "may have
   touched something", because a chip that appears over nothing is a smaller
   lie than one that hides real work. */
const READONLY_KINDS: ReadonlySet<ToolKind> = new Set([
  "read",
  "search",
  "fetch",
  "think",
  "switch_mode",
])

/**
 * Whether this call could have changed a file. Read off ACP's `kind` alone
 * (through `toolKindOf`, so a runtime that omits it still gets an answer from
 * its tool's name) — no vendor tool name is spelled here, and a new runtime's
 * writer needs no edit as long as it declares a kind.
 *
 * Used to gate the transcript's "N files changed" chip: the *measurement* is
 * git's and stays whole-worktree, but a turn that only read and searched
 * cannot be the author of a diff, and in a cwd shared with another thread or
 * the user's own editor it would otherwise claim one.
 */
export function couldTouchFiles(item: Pick<ToolItem, "title" | "toolKind" | "meta">): boolean {
  return !READONLY_KINDS.has(toolKindOf(item))
}

// ─── Vendor identity ─────────────────────────────────────────────────────────

/* Everything below reads *which tool this was*, not just what ACP called it.
   Three runtimes name the same act three ways — Claude Code's `TodoWrite`,
   OpenCode's `todowrite` and Codex's `update_plan` are one checklist; `Edit`,
   `edit` and `apply_patch` are one write — and ACP's `kind` deliberately does
   not distinguish them. `kind` still decides the *layout family* (that is the
   part that is protocol); the name decides which of the specialised views
   inside a family applies, and a name nobody recognises falls back to the
   family. Same quarantine rule as the rest of this file: the transcript asks
   questions here, it never matches on a vendor string itself. */

/**
 * The tool's own identifier, lowercased.
 *
 * `title` is prose for most Claude Code calls ("Read package.json"), so the
 * name has to come from the meta channel the adapter puts it on; Codex names
 * its MCP calls `mcp.<server>.<tool>` in the title and OpenCode sends the bare
 * identifier. Null when nothing in the payload looks like a name.
 */
export function toolIdentity(item: Pick<ToolItem, "title" | "meta" | "name">): string | null {
  const claude = str(vendorMeta(item.meta, "claudeCode")?.toolName)
  if (claude) return claude.toLowerCase()
  // The name the call was announced under, before an update retitled it in
  // prose (OpenCode's `websearch` → `Exa Web Search "…"`).
  if (item.name) return item.name
  const title = item.title.trim()
  // Codex's MCP form: `mcp.<server>.<tool>`, which NAME_RE rejects (dots).
  if (/^mcp\.[^.\s]+\.\S+$/.test(title)) return title.toLowerCase()
  return NAME_RE.test(title) ? title.toLowerCase() : null
}

/** The identity with any MCP server prefix stripped — `edit`, `todowrite`,
    `task`, and `web_search` out of `mcp__web-search__web_search`. It used to
    cut only the literal `mcp__`, which left `web-search__web_search` — a name
    nothing recognised, so the harness's own search server fell through to the
    generic MCP layout: an arguments table and one block of text. */
export const bareIdentity = (item: Pick<ToolItem, "title" | "meta">): string | null => {
  const name = toolIdentity(item)
  return name ? toolLeafName(name) : null
}

export const isOneOf = (item: Pick<ToolItem, "title" | "meta">, names: string[]): boolean => {
  const name = bareIdentity(item)
  return name !== null && names.includes(name)
}
