/* ── The project browser's tools ── the nine tools of the harness's own
   `browser` MCP server (`server/src/browser-mcp-tools.ts`): `tabs`,
   `navigate`, `snapshot`, `act`, `screenshot`, `evaluate`, `wait_for`, `logs`,
   `viewport`. Matched on the *leaf* name, like every other web reader here,
   and on the server too: `snapshot` and `act` are words any server may use,
   so a call that does not come from a server named `browser` is not ours.

   Every tool answers text in one shape (`report` in browser-agent.ts): a
   line saying what happened, then `tab <id>: <url> — <title>`, then a blank
   line and the accessibility snapshot, one node per line as
   `[uid] role "name" …`. `screenshot` adds an image block before its line. */
import type { ToolItem } from "../store"
import { asRecord, str } from "./helpers"
import { extractMcpCall, mcpAnswer, mcpServerKey } from "./mcp"
import { bareIdentity } from "./naming"
import { toolOutputText } from "./output"
import { displayUrl } from "./web"

export const BROWSER_TOOLS = [
  "tabs",
  "navigate",
  "snapshot",
  "act",
  "screenshot",
  "evaluate",
  "wait_for",
  "logs",
  "viewport",
] as const
export type BrowserTool = (typeof BROWSER_TOOLS)[number]

const LEAVES = new Set<string>(BROWSER_TOOLS)
const SERVER = "browser"

/** Where the tab was when the tool answered. */
export interface BrowserPage {
  tabId: string
  url: string
  title: string
}

export interface BrowserCall {
  tool: BrowserTool
  args: Record<string, unknown>
  /** The answer's text, image blocks left out. */
  text: string
  /** The answer's first line: `click done`, `status 200`, an error. */
  head: string | null
  page: BrowserPage | null
  /** The snapshot's node lines, indentation kept. Empty when it carried none. */
  snapshot: string[]
  image: { data: string; mimeType: string } | null
  failed: boolean
}

type BrowserItem = Pick<ToolItem, "title" | "meta" | "name" | "rawInput" | "content" | "status"> & {
  rawOutput?: unknown
}

/** A call into the browser server, or null for anything else. */
export function extractBrowserCall(item: BrowserItem): BrowserCall | null {
  const leaf = bareIdentity(item)
  if (leaf === null || !LEAVES.has(leaf)) return null
  const call = extractMcpCall(item)
  if (!call || mcpServerKey(call.server) !== SERVER) return null
  const answer = mcpAnswer(call, item.rawOutput)
  const text = (answer.text.trim() ? answer.text : contentText(item)).replace(/^\[image\]\s*/, "")
  const lines = text.split("\n")
  const pageAt = lines.findIndex((line) => PAGE_RE.test(line))
  const page = pageAt === -1 ? null : pageOf(lines[pageAt])
  const head = lines.slice(0, pageAt === -1 ? lines.length : pageAt).find((line) => line.trim()) ?? null
  return {
    tool: leaf as BrowserTool,
    args: asRecord(call.arguments) ?? asRecord(item.rawInput) ?? {},
    text,
    head: head?.trim() ?? null,
    page,
    snapshot: pageAt === -1 ? [] : lines.slice(pageAt + 1).filter((line) => NODE_RE.test(line)),
    image: imageOf(item, call.result ?? item.rawOutput),
    failed: answer.failed || item.status === "failed",
  }
}

/** `tab t3: https://example.com/ — Example Domain`. The title may be empty. */
const PAGE_RE = /^tab (\S+): (\S+)(?: — (.*))?$/
const pageOf = (line: string): BrowserPage | null => {
  const match = PAGE_RE.exec(line.trim())
  return match ? { tabId: match[1], url: match[2], title: (match[3] ?? "").trim() } : null
}

/** `  [3_12] button "Sign in" focused` — the uid, the role and the name. */
const NODE_RE = /^\s*\[([^\]\s]+)\]\s+(\S+)(?:\s+("(?:[^"\\]|\\.)*"))?/

function contentText(item: BrowserItem): string {
  const text = item.content
    .map((block) => (block.type === "content" && block.content.type === "text" ? block.content.text : ""))
    .filter(Boolean)
    .join("\n")
  return text || toolOutputText(item as ToolItem, 60_000).text
}

/* The image the call already carries: an ACP content block where the adapter
   put the MCP result's blocks, else the MCP envelope itself. */
function imageOf(item: BrowserItem, result: unknown): { data: string; mimeType: string } | null {
  for (const block of item.content) {
    if (block.type === "content" && block.content.type === "image")
      return { data: block.content.data, mimeType: block.content.mimeType }
  }
  const envelope = asRecord(result)
  const blocks = Array.isArray(result) ? result : Array.isArray(envelope?.content) ? envelope.content : []
  for (const entry of blocks as unknown[]) {
    const block = asRecord(entry)
    const data = str(block?.data)
    const mimeType = str(block?.mimeType) ?? str(block?.mime_type)
    if (block?.type === "image" && data && mimeType) return { data, mimeType }
  }
  return null
}

/** One node line as a reader names the element: `button "Sign in"`. */
export function browserNodeLabel(line: string): { uid: string; label: string } | null {
  const match = NODE_RE.exec(line)
  if (!match) return null
  let name = ""
  if (match[3]) {
    try {
      name = JSON.parse(match[3]) as string
    } catch {
      name = match[3].slice(1, -1)
    }
  }
  return { uid: match[1], label: name ? `${match[2]} "${clip(name, 40)}"` : match[2] }
}

/**
 * The element a uid named, read off the snapshot that issued it. A uid is
 * `<generation>_<n>` and a new snapshot starts a new generation, so the one
 * that names it is the newest earlier call whose snapshot holds it — never the
 * acting call's own answer, which is the page *after* the act.
 */
export function browserElementName(items: readonly unknown[], before: string, uid: string): string | null {
  const at = items.findIndex((entry) => asRecord(entry)?.id === before)
  const tag = `[${uid}]`
  for (let i = (at === -1 ? items.length : at) - 1; i >= 0; i--) {
    const entry = items[i] as Partial<ToolItem> | undefined
    if (entry?.kind !== "tool") continue
    const call = extractBrowserCall(entry as ToolItem)
    const line = call?.snapshot.find((node) => node.trimStart().startsWith(tag))
    if (line) return browserNodeLabel(line)?.label ?? null
  }
  return null
}

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max)}…` : value)

const ACT_VERBS: Record<string, string> = {
  click: "Click",
  dblclick: "Double-click",
  hover: "Hover",
  fill: "Fill",
  type: "Type into",
  press: "Press",
  select: "Select in",
  scroll: "Scroll",
  drag: "Drag",
  dialog: "Answer the dialog",
}

/** The verb an `act` or `navigate` row leads with. */
export function browserVerb(call: BrowserCall): string {
  if (call.tool === "act") return ACT_VERBS[str(call.args.action) ?? ""] ?? "Act on"
  if (call.tool === "navigate") {
    const action = str(call.args.action)
    if (action === "back") return "Go back"
    if (action === "forward") return "Go forward"
    if (action === "reload") return "Reload"
    return "Open"
  }
  return call.tool
}

/** What a `fill`, `type`, `press` or `select` put in, as the row quotes it. */
export function browserInput(call: BrowserCall): string | null {
  if (call.tool !== "act") return null
  const action = str(call.args.action)
  if (action === "press") return str(call.args.key)
  if (action === "fill" || action === "type") {
    const text = str(call.args.text)
    return text === null ? null : `"${clip(text, 40)}"`
  }
  if (action === "select" && Array.isArray(call.args.values)) return call.args.values.join(", ")
  return null
}

/** The row's title and caption, read off the input alone so a running call
    already says what it is doing. */
export function browserHeading(call: BrowserCall): { title: string; detail?: string } {
  const { args } = call
  const uid = str(args.uid)
  switch (call.tool) {
    case "tabs": {
      const action = str(args.action) ?? "list"
      const title =
        action === "new" ? "Open a browser tab" : action === "select" ? "Switch browser tab" : action === "close" ? "Close a browser tab" : "List browser tabs"
      const detail = str(args.url) ?? str(args.tabId) ?? undefined
      return { title, detail: detail && /^https?:/.test(detail) ? displayUrl(detail) : detail }
    }
    case "navigate": {
      const url = str(args.url)
      return url ? { title: "Open", detail: displayUrl(url) } : { title: browserVerb(call) }
    }
    case "snapshot":
      return { title: "Read the page" }
    case "act": {
      const input = browserInput(call)
      const target = uid ? `[${uid}]` : null
      const detail = [target, input].filter(Boolean).join(" ")
      return { title: browserVerb(call), detail: detail || undefined }
    }
    case "screenshot":
      return { title: uid ? "Screenshot an element" : "Screenshot the page", detail: uid ? `[${uid}]` : undefined }
    case "evaluate": {
      const code = str(args.function)?.trim().split("\n")[0]
      return { title: "Run JavaScript in the page", detail: code ? clip(code, 48) : undefined }
    }
    case "wait_for": {
      const text = str(args.text)
      return { title: "Wait for", detail: text ? `"${clip(text, 40)}"` : uid ? `[${uid}]` : undefined }
    }
    case "logs": {
      const request = typeof args.request === "number" ? args.request : null
      if (request !== null) return { title: "Read a network request", detail: `#${request}` }
      return { title: str(args.kind) === "network" ? "Read the network log" : "Read the console" }
    }
    case "viewport": {
      if (args.reset === true) return { title: "Reset the viewport" }
      if (args.mobile === true) return { title: "Set the viewport", detail: "phone" }
      const size = typeof args.width === "number" && typeof args.height === "number" ? `${args.width}×${args.height}` : undefined
      return { title: "Set the viewport", detail: size }
    }
  }
}

/** The closed row's one line: where the page ended up, how much the snapshot
    held — never the first line of a snapshot dump. */
export function browserSummary(call: BrowserCall): string | null {
  if (call.failed) return "error"
  if (call.tool === "screenshot") return call.image ? "image" : null
  if (call.tool === "snapshot") {
    const n = call.snapshot.length
    return n ? `${n} ${n === 1 ? "node" : "nodes"}` : null
  }
  if (call.page && (call.tool === "navigate" || call.tool === "act" || call.tool === "tabs"))
    return displayUrl(call.page.url, 44)
  return call.head ? clip(call.head, 44) : null
}
