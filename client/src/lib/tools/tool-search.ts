/* ── Tool search ── a runtime that holds its tools back and loads them on
   request. Claude Code's `ToolSearch` and the Daedalus agent's `search_tools`
   (the AI SDK's `toolSearch()`) are the same act in two dialects:

   - Claude Code: `{query, max_results}` in, where a query of `select:a,b` loads
     named tools outright; out, one `Tool: <name>` text block per loaded tool —
     names only.
   - AI SDK: `{query}` in; out, `rawOutput: {tools: [{name, description}]}`.

   Recognised by name, and failing that by shape — a `query` in and a
   `{tools: [{name}]}` out — so the next runtime that ships the same idea
   (OpenAI's `tool_search`, a gateway's meta-tool) draws as one without a
   table edit. */
import type { ThreadItem, ToolItem } from "../store"
import { asRecord, str } from "./helpers"
import { bareIdentity, parseMcpToolName } from "./naming"

const NAMES = ["toolsearch", "tool_search", "search_tools", "searchtools"]

export interface LoadedTool {
  name: string
  description?: string
}

export interface ToolSearchCall {
  /** The keywords searched for — null when the call named its tools outright. */
  query: string | null
  /** The tools a `select:` asked for by name, before the result says which loaded. */
  selected: string[]
  /** What the search loaded. Empty until the result lands, and on a miss. */
  tools: LoadedTool[]
}

type Readable = Pick<ToolItem, "title" | "meta" | "rawInput"> &
  Partial<Pick<ToolItem, "name" | "rawOutput" | "content">>

export function extractToolSearch(item: Readable): ToolSearchCall | null {
  const input = asRecord(item.rawInput)
  const fromOutput = toolsOf(item.rawOutput)
  const named = bareIdentity(item)
  /* The shape fallback skips an MCP tool: a server that answers `{tools: […]}`
     (a registry listing, a gateway's catalogue) lists tools, it loads none. */
  const byShape = fromOutput !== null && str(input?.query) !== null && !parseMcpToolName(item.name ?? item.title)
  if (!(named !== null && NAMES.includes(named)) && !byShape) return null

  const raw = str(input?.query) ?? ""
  const select = /^select:(.+)$/i.exec(raw.trim())
  const selected = select ? select[1].split(",").map((n) => n.trim()).filter(Boolean) : []
  return {
    query: select ? null : raw.trim() || null,
    selected,
    tools: fromOutput ?? toolsInText(item.content ?? []),
  }
}

/**
 * Every tool the thread's own searches loaded, first load first — read off
 * the transcript, which is where the Daedalus agent reads it too. A
 * subagent's searches are left out: what it loads is its own. A later search
 * that carries a description fills in an earlier one that did not.
 */
export function loadedTools(items: ThreadItem[]): LoadedTool[] {
  const byName = new Map<string, LoadedTool>()
  for (const item of items) {
    if (item.kind !== "tool" || item.parentId || item.status !== "completed") continue
    for (const tool of extractToolSearch(item)?.tools ?? []) {
      byName.set(tool.name, { ...byName.get(tool.name), ...tool })
    }
  }
  return [...byName.values()]
}

/* `{tools: [{name, description?}]}`, the AI SDK's answer — also what arrives
   as the result's text when a runtime sends no `rawOutput`. */
function toolsOf(value: unknown): LoadedTool[] | null {
  const list = asRecord(value)?.tools
  if (!Array.isArray(list)) return null
  const tools: LoadedTool[] = []
  for (const entry of list) {
    const record = asRecord(entry)
    const name = str(record?.name)
    if (name) tools.push({ name, ...(str(record?.description) ? { description: str(record?.description)! } : {}) })
  }
  return tools
}

function toolsInText(content: ToolItem["content"]): LoadedTool[] {
  const tools: LoadedTool[] = []
  for (const block of content) {
    if (block.type !== "content" || block.content.type !== "text") continue
    const text = block.content.text.trim()
    if (text.startsWith("{")) {
      try {
        const parsed = toolsOf(JSON.parse(text))
        if (parsed) tools.push(...parsed)
        continue
      } catch {
        /* Not JSON after all — fall through to the line form. */
      }
    }
    for (const match of text.matchAll(/^Tool:\s*(\S+)\s*$/gm)) tools.push({ name: match[1] })
  }
  return tools
}
