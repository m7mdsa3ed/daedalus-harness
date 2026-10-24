/* `@mcp:<serverId>/<uri>` — a resource one of the thread's MCP servers serves,
   read through the harness's own client at send and inlined
   (`server/src/mentions/resolvers/mcp.ts`). That is how a GitHub PR, a Bugsnag
   error or a ClickUp task becomes a mention without a bespoke integration: any
   server that lists resources or resource templates contributes.

   Two kinds of row. A **fixed resource** inserts its whole token. A **template**
   (`github://repos/{owner}/{repo}/pull/{n}`) inserts the token up to its first
   variable and leaves it open; once the template has exactly one variable and
   the server declared `completions`, what is typed after the prefix is asked of
   the server (`completion/complete`) and its answers are the rows. A template
   with several variables, or a server without completion, is typed by hand —
   the prefix is still offered, and the finished token is read all the same. */
import { Plug } from "lucide-react"
import { McpIcon } from "@/components/entity-icon"
import { useMcpServers } from "@/lib/queries/catalog"
import { api, ApiError, loadSettings, type McpServerDef, type ThreadMcpServer } from "@/lib/settings"
import { defineKindSource } from "../kind"
import type { KindMatch, MentionCtx } from "../types"

export interface McpMatch extends KindMatch {
  /** A template prefix: the pick leaves the token open for the variable. */
  open?: boolean
  serverId: string
}

const LIMIT = 8
const SIMPLE_VAR = /^[^{}]*\{([A-Za-z0-9_]+)\}[^{}]*$/

/** The part of a template before its first variable. */
const prefixOf = (template: string) => template.slice(0, template.indexOf("{"))

/** `serverId/uri` → both halves; null for a half-typed ref. */
function splitRef(ref: string): { serverId: string; uri: string } | null {
  const slash = ref.indexOf("/")
  return slash > 0 ? { serverId: ref.slice(0, slash), uri: ref.slice(slash + 1) } : null
}

/** What names a resource to a reader: the last path segment of its URI. */
function tail(uri: string): string {
  const clean = uri.split(/[?#]/)[0].replace(/\/+$/, "")
  return clean.slice(clean.lastIndexOf("/") + 1) || uri
}

const live = (ctx: MentionCtx) => (ctx.mcpServers ?? []).filter((s) => s.ok)

async function complete(ctx: MentionCtx, server: ThreadMcpServer, template: string, argument: string, value: string, signal: AbortSignal) {
  const settings = loadSettings()
  if (!settings || !ctx.sessionId) throw new ApiError({ status: 0, path: "/api", serverMessage: "not connected" })
  const params = new URLSearchParams({ template, argument, value })
  const { values } = await api<{ values: string[] }>(
    settings,
    `/api/sessions/${encodeURIComponent(ctx.sessionId)}/mcp/${encodeURIComponent(server.id)}/complete?${params}`,
    { signal },
  )
  return values
}

function listing(ctx: MentionCtx, q: string): McpMatch[] {
  const out: McpMatch[] = []
  for (const server of live(ctx)) {
    for (const r of server.resources) {
      const uri = r.uri ?? r.name
      if (q && !`${server.name} ${r.description ?? ""} ${uri}`.toLowerCase().includes(q)) continue
      out.push({ ref: `${server.id}/${uri}`, serverId: server.id, label: r.description || tail(uri), description: uri, aside: server.name })
    }
    for (const t of server.resourceTemplates) {
      const template = t.uri ?? t.name
      if (!template.includes("{")) continue
      if (q && !`${server.name} ${t.description ?? ""} ${template}`.toLowerCase().includes(q)) continue
      out.push({
        ref: `${server.id}/${prefixOf(template)}`,
        serverId: server.id,
        open: true,
        label: t.description || template,
        description: template,
        aside: server.name,
      })
    }
  }
  return out.slice(0, LIMIT)
}

export const mcpSource = defineKindSource<McpMatch, McpServerDef[]>({
  kind: "mcp",
  icon: Plug,
  hint: "A resource an MCP server serves",
  debounceMs: 200,
  errorLabel: "Couldn't ask the MCP server",
  useData: () => useMcpServers(),
  available: (ctx) => !!ctx.sessionId && live(ctx).some((s) => s.resources.length > 0 || s.resourceTemplates.length > 0),
  async search(query, ctx, _library, signal) {
    const q = query.trim().toLowerCase()
    const typed = splitRef(query)
    const server = typed && live(ctx).find((s) => s.id === typed.serverId)
    if (server && typed) {
      // A template whose prefix has been typed in full, with one variable the server can complete.
      for (const t of server.resourceTemplates) {
        const template = t.uri ?? t.name
        const variable = SIMPLE_VAR.exec(template)?.[1]
        const prefix = prefixOf(template)
        if (!variable || !server.completions || !typed.uri.startsWith(prefix)) continue
        const after = template.slice(template.indexOf("}") + 1)
        const values = await complete(ctx, server, template, variable, typed.uri.slice(prefix.length), signal)
        return values.slice(0, LIMIT).map((value) => ({
          ref: `${server.id}/${prefix}${value}${after}`,
          serverId: server.id,
          label: value,
          description: `${prefix}${value}${after}`,
          aside: server.name,
        }))
      }
      return listing(ctx, typed.uri.toLowerCase()).filter((m) => m.serverId === server.id)
    }
    return listing(ctx, q)
  },
  insert: (match) => ({ type: "text", text: `@mcp:${match.ref}`, open: !!match.open }),
  face(ref) {
    const parsed = splitRef(ref)
    return { icon: Plug, label: parsed ? tail(parsed.uri) : ref }
  },
  useFace(ref) {
    const library = useMcpServers()
    const parsed = ref === null ? null : splitRef(ref)
    if (!parsed) return null
    const server = library.find((s) => s.id === parsed.serverId)
    return {
      icon: Plug,
      mark: server ? <McpIcon server={server} className="size-3.5 self-center" /> : undefined,
      label: tail(parsed.uri),
      aside: server?.name,
    }
  },
  row: (match) => ({
    icon: Plug,
    label: match.label,
    description: match.description,
    aside: match.aside,
    badge: match.open ? "mcp template" : "mcp",
  }),
})
