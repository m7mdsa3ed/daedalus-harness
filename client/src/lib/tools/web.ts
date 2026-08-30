/* ── Web search and web fetch ── a search of the web, as opposed to a search
   of the repo. */
import type { ToolItem } from "../store"
import { asRecord, str } from "./helpers"
import { isOneOf, toolKindOf } from "./naming"
import { stringifyOutput, toolOutputText } from "./output"

/**
 * A search of the web, as opposed to a search of the repo — two different acts
 * that ACP files under one `kind`. Codex reports its browsing as `kind:
 * "search"`, which sent it into the ripgrep layout: a "matches" counter over
 * prose, and `path:line:` splitting applied to sentences.
 *
 * Codex also uses this one call for three different actions (a query, opening
 * a page, finding within a page), which is why `action` is separate from
 * `query` rather than folded into it.
 *
 * The runtime does not matter: Claude Code's built-in `WebSearch`, OpenCode's
 * `websearch`, Codex's browsing and any MCP server whose tool is called
 * `web_search` (the harness's own included) all read the same way here, and
 * the result list is parsed out of whatever shape the tool answered in.
 */
export interface WebResult {
  title: string
  url: string
  /** The snippet under the link, when the tool returned one. Whitespace is
      collapsed — a snippet arrives as page text with paragraph breaks in it. */
  snippet?: string
}

export interface WebSearchCall {
  query?: string
  /** `search` | `openPage` | `findInPage`, when the runtime distinguishes. */
  action?: string
  url?: string
  pattern?: string
  allowedDomains?: string[]
  blockedDomains?: string[]
  results: WebResult[]
  /** What the tool wrote *besides* the result list — Claude Code's built-in
      `WebSearch` answers the query in prose after its links, and a fetcher
      that summarises returns only prose. Never a copy of the result lines. */
  summary?: string
  /** The tool's own failure text, when it folded an error into its output
      instead of failing the call (the harness's server does exactly that so
      the agent can react). */
  error?: string
}

/** A page read off the web: Claude Code's `WebFetch`, OpenCode's `webfetch`,
    an MCP `web_fetch`, or anything ACP filed under `kind: "fetch"` with a URL. */
export interface WebFetchCall {
  url: string
  /** What the agent asked of the page (Claude Code's `WebFetch` carries a
      `prompt` and answers it, rather than returning the page). */
  prompt?: string
  /** The page as the tool returned it — markdown for most fetchers. */
  text: string
  truncated: boolean
}

const WEB_SEARCH_NAMES = [
  "websearch",
  "web_search",
  "search_web",
  "web-search",
  "exa_search",
  "brave_web_search",
  "brave_search",
  "tavily_search",
  "google_search",
  "bing_search",
  "duckduckgo_search",
  "perplexity_search",
]

const WEB_FETCH_NAMES = [
  "webfetch",
  "web_fetch",
  "fetch_url",
  "fetch_page",
  "web-fetch",
  "read_url",
  "read_page",
  "exa_fetch",
  "tavily_extract",
  "fetch",
]

const strList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
  return out.length > 0 ? out : undefined
}

const isHttp = (value: string | null | undefined): value is string =>
  typeof value === "string" && /^https?:\/\//i.test(value)

/** A URL as a row prints it: host plus a trimmed path, no scheme, no query. */
export function displayUrl(url: string, max = 60): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "")
    const shown = `${parsed.host.replace(/^www\./, "")}${path}`
    return shown.length > max ? `${shown.slice(0, max - 1)}…` : shown
  } catch {
    return url.length > max ? `${url.slice(0, max - 1)}…` : url
  }
}

/** The host a URL belongs to, `www.` dropped — what a source chip is labelled
    with. Empty for a string that is not a URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}

/**
 * The query or the address a web call was made with, read off the input alone
 * — enough for a row heading, which has no output yet. Null for anything that
 * is not a web search or a web fetch.
 */
/** The tool's arguments: `rawInput` itself for most runtimes, and Codex's
    MCP form `{server, tool, arguments}` one level down. */
function webArgs(item: Pick<ToolItem, "rawInput">): Record<string, unknown> | null {
  const input = asRecord(item.rawInput)
  const nested = asRecord(input?.arguments)
  return nested && typeof input?.tool === "string" ? nested : input
}

export function webInput(
  item: Pick<ToolItem, "title" | "meta" | "rawInput" | "toolKind">
): { query?: string; url?: string } | null {
  const input = webArgs(item)
  const action = asRecord(input?.action)
  const codex = str(input?.type) === "webSearch" || action !== null
  if (codex || isOneOf(item, WEB_SEARCH_NAMES)) {
    const queries = strList(action?.queries)
    const query =
      str(action?.query) ?? (queries ? queries.join(", ") : null) ?? str(input?.query) ?? undefined
    const url = str(action?.url) ?? str(input?.url) ?? undefined
    return { query, url }
  }
  const url = str(input?.url)
  if (isHttp(url) && (isOneOf(item, WEB_FETCH_NAMES) || toolKindOf(item) === "fetch")) return { url }
  return null
}

/** `Title (https://…)` — one line per hit, which is how the ACP adapters
    format a runtime's native results. */
const HIT_RE = /^(.*?)\s*\((https?:\/\/[^\s)]+)\)\s*$/
/** `[Title](https://…)`, optionally as a list item. */
const MD_LINK_RE = /^(?:[-*+]|\d+\.)?\s*\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/
/** `N. Title` — the head of a numbered block whose next line is the URL and
    whose remaining lines are the snippet: the harness's own server and the
    cc-cli proxy both write results this way. */
const NUMBERED_RE = /^\s*(\d+)\.\s+(.+)$/

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim()

/** Results as a structured list, in any of the shapes a tool answers with:
    `[{title, url, description|snippet}]` flat, or Claude Code's native
    `[{content: [{title, url}]}]` where each entry holds one page of hits. */
function structuredResults(value: unknown): WebResult[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const record = asRecord(entry)
    if (!record) return []
    if (Array.isArray(record.content)) return structuredResults(record.content)
    const title = str(record.title)
    const url = str(record.url)
    if (!title || !isHttp(url)) return []
    // `excerpts[]` is Parallel's (OpenCode's built-in `websearch`): several
    // cuts from the page, read as one snippet.
    const excerpts = Array.isArray(record.excerpts)
      ? record.excerpts.filter((cut): cut is string => typeof cut === "string").join(" ")
      : null
    const snippet = str(record.description) ?? str(record.snippet) ?? str(record.text) ?? excerpts
    return [{ title, url, ...(snippet ? { snippet: collapse(snippet) } : {}) }]
  })
}

/** Exa's block form, which OpenCode's built-in `websearch` (and any Exa MCP
    server) answers in: hits separated by a `---` rule, each a run of
    `Label: value` lines — `Title:`, `URL:`, `Published:`, `Author:` — and the
    page's excerpt under `Highlights:` (or `Text:`), with `...` lines marking
    the cuts between highlights. Only the title, the URL and the excerpt are
    kept; the cut markers collapse into the snippet's own spacing. */
const LABEL_RE = /^(Title|URL|Published|Author|Score|Highlights|Text|Summary):\s*(.*)$/
function parseLabelledBlocks(text: string): WebResult[] {
  if (!/^URL:\s*https?:\/\//m.test(text)) return []
  return text.split(/\n\s*---+\s*\n/).flatMap((block) => {
    let title: string | undefined
    let url: string | undefined
    const excerpt: string[] = []
    let inExcerpt = false
    for (const raw of block.split("\n")) {
      const line = raw.trim()
      const label = LABEL_RE.exec(line)
      if (label) {
        const [, key, value] = label
        inExcerpt = key === "Highlights" || key === "Text" || key === "Summary"
        if (key === "Title") title = value.trim()
        else if (key === "URL") url = value.trim()
        else if (inExcerpt && value.trim()) excerpt.push(value.trim())
        continue
      }
      if (inExcerpt && line && line !== "...") excerpt.push(line)
    }
    if (!title || !isHttp(url)) return []
    const snippet = collapse(excerpt.join(" "))
    return [{ title, url, ...(snippet ? { snippet } : {}) }]
  })
}

/** Results out of prose: Exa's labelled blocks and numbered blocks first
    (they carry snippets), then
    the two one-line forms. Each parser only answers when it finds something,
    so a page's text — which is not a result list — yields nothing. */
export function parseWebResults(text: string): WebResult[] {
  const labelled = parseLabelledBlocks(text)
  if (labelled.length > 0) return labelled
  const lines = text.split("\n")
  const numbered: WebResult[] = []
  let current: { title: string; url?: string; snippet: string[] } | null = null
  const flush = () => {
    if (current?.url) {
      const snippet = collapse(current.snippet.join(" "))
      numbered.push({ title: current.title, url: current.url, ...(snippet ? { snippet } : {}) })
    }
    current = null
  }
  for (const raw of lines) {
    const head = NUMBERED_RE.exec(raw)
    if (head && (current === null || current.url !== undefined)) {
      flush()
      current = { title: head[2].trim(), snippet: [] }
      continue
    }
    if (!current) continue
    const line = raw.trim()
    if (current.url === undefined) {
      if (isHttp(line)) current.url = line
      else current.title = collapse(`${current.title} ${line}`)
      continue
    }
    current.snippet.push(line)
  }
  flush()
  if (numbered.length > 0) return numbered

  return lines.flatMap((raw) => {
    const line = raw.trim()
    const hit = HIT_RE.exec(line) ?? MD_LINK_RE.exec(line)
    return hit && hit[1] ? [{ title: hit[1].trim(), url: hit[2] }] : []
  })
}

/** Where a runtime puts a search's structured answer: `rawOutput` for most,
    and `_meta.claudeCode.toolResponse` for Claude Code's built-in `WebSearch`,
    whose `results[]` mixes `{content: [{title, url}]}` pages with the prose
    strings of its own answer. */
function webOutputRecord(item: Pick<ToolItem, "rawOutput" | "meta">): Record<string, unknown> | null {
  const raw = asRecord(item.rawOutput)
  // Codex's MCP envelope: the answer is `result`, and a server that returns
  // structured output puts it in `result.structuredContent`.
  const codex = asRecord(raw?.result)
  return (
    asRecord(codex?.structuredContent) ??
    codex ??
    raw ??
    asRecord(asRecord(asRecord(item.meta)?.claudeCode)?.toolResponse)
  )
}

function webResults(item: Pick<ToolItem, "rawOutput" | "content" | "meta">): WebResult[] {
  const output = webOutputRecord(item)
  const structured = structuredResults(output?.results ?? output?.hits ?? output?.data)
  if (structured.length > 0) return structured
  const text = stringifyOutput(item.rawOutput ?? textOf(item.content), 60_000).text
  // The structured list serialised into the output text — OpenCode's built-in
  // `websearch` returns Parallel's JSON as a string under `output`.
  const embedded = asRecord(parseJson(text))
  const fromText = structuredResults(embedded?.results ?? embedded?.hits ?? embedded?.data)
  if (fromText.length > 0) return fromText
  return parseWebResults(text)
}

function parseJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/** The prose a search tool wrote around its links: the strings among a
    structured `results[]`, else the output text with the result lines cut
    out. Empty when the output was nothing but the list. */
function webSummary(item: Pick<ToolItem, "rawOutput" | "content" | "meta">, results: WebResult[]): string | undefined {
  const structured = webOutputRecord(item)?.results
  if (Array.isArray(structured)) {
    const prose = structured.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    if (prose.length > 0) return prose.join("\n\n").trim()
  }
  if (results.length === 0) return undefined
  const urls = new Set(results.map((hit) => hit.url))
  const lines = stringifyOutput(item.rawOutput ?? textOf(item.content), 60_000).text.split("\n")
  const rest = lines.filter((raw) => {
    const line = raw.trim()
    const hit = HIT_RE.exec(line) ?? MD_LINK_RE.exec(line)
    if (hit && urls.has(hit[2])) return false
    if (NUMBERED_RE.test(line) || urls.has(line)) return false
    return true
  })
  // A numbered block's snippet lines are not prose either; only keep what is
  // left when the list itself was the one-line form.
  const text = rest.join("\n").trim()
  return text && !results.some((hit) => hit.snippet && text.includes(hit.snippet.slice(0, 40))) ? text : undefined
}

const textOf = (content: ToolItem["content"]): string =>
  content
    .map((block) => (block.type === "content" && block.content.type === "text" ? block.content.text : ""))
    .filter(Boolean)
    .join("\n")

/** A tool that folded its failure into its output rather than failing the
    call — the harness's own server does, so the agent can react. */
const foldedError = (text: string): string | undefined => {
  const line = text.trim().split("\n")[0] ?? ""
  return /^error:/i.test(line) ? line.replace(/^error:\s*/i, "") : undefined
}

export function extractWebSearch(item: ToolItem): WebSearchCall | null {
  const input = webArgs(item)
  const action = asRecord(input?.action)
  const codex = str(input?.type) === "webSearch" || action !== null
  if (!codex && !isOneOf(item, WEB_SEARCH_NAMES)) return null

  const queries = strList(action?.queries)
  const results = webResults(item)
  return {
    query:
      str(action?.query) ??
      (queries ? queries.join(", ") : null) ??
      str(input?.query) ??
      undefined,
    action: str(action?.type) ?? undefined,
    url: str(action?.url) ?? str(input?.url) ?? undefined,
    pattern: str(action?.pattern) ?? undefined,
    allowedDomains: strList(input?.allowed_domains ?? input?.allowedDomains),
    blockedDomains: strList(input?.blocked_domains ?? input?.blockedDomains),
    results,
    summary: webSummary(item, results),
    error: results.length === 0 ? foldedError(toolOutputText(item, 2_000).text) : undefined,
  }
}

export function extractWebFetch(item: ToolItem): WebFetchCall | null {
  const web = webInput(item)
  if (!web?.url || web.query) return null
  const input = webArgs(item)
  const { text, truncated } = toolOutputText(item, 60_000)
  return {
    url: web.url,
    prompt: str(input?.prompt) ?? undefined,
    text,
    truncated,
  }
}
