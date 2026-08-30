/* ── Names and vendor identity ── which tool a call was, and which kind to
   render it as, whatever the runtime called it. */
import type { ToolItem } from "../store"
import { asRecord, str } from "./helpers"

export type ToolKind = NonNullable<ToolItem["toolKind"]>

// ─── Names ───────────────────────────────────────────────────────────────────

/* ACP has no tool-name field — `title` is human-readable prose ("Read
   package.json") for most agents, but several send the bare identifier
   ("Bash", "mcp__crm__search"). Treat the title as a name only when it looks
   like one, so a prose title never gets matched against the table below. */
/* Hyphens and dots are part of a name too: an MCP server is registered as
   `web-search`, so its tools arrive as `mcp__web-search__web_search`, and a
   pattern that stopped at `[A-Za-z0-9_]` read that as prose — which made it
   the row's title, verbatim. Prose has spaces; a name does not. */
export const NAME_RE = /^(mcp__)?[A-Za-z_][\w.-]*$/

export function toolNameOf(item: Pick<ToolItem, "title">): string | null {
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

/**
 * Split the `mcp__<server>__<tool>` naming convention every harness uses for
 * MCP-provided tools. Null for ordinary tool names.
 */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  const words = (value: string) => value.replace(/_/g, " ").trim()
  // Codex's form. Its separator is a dot and a server name may not contain
  // one, so the first two segments are the whole answer and the rest of the
  // tool name (which may itself contain dots) is kept intact.
  const dotted = /^mcp\.([^.]+)\.(.+)$/.exec(name)
  if (dotted) return { server: words(dotted[1]), tool: words(dotted[2]) }
  if (!name.startsWith("mcp__")) return null
  const rest = name.slice("mcp__".length)
  const sep = rest.indexOf("__")
  if (sep <= 0) return { server: words(rest), tool: "" }
  return { server: words(rest.slice(0, sep)), tool: words(rest.slice(sep + 2)) }
}

/**
 * A tool name as a human reads it: an MCP tool names its server first, so a
 * row says which integration acted, not just `mcp__crm_kb__search_docs`.
 */
export function toolDisplayName(name: string): string {
  const mcp = parseMcpToolName(name)
  if (!mcp) return name
  return mcp.tool ? `${mcp.server} · ${mcp.tool}` : mcp.server
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
  const claude = str(asRecord(asRecord(item.meta)?.claudeCode)?.toolName)
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
