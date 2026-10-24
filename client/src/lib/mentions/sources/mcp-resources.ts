/* A resource one of the thread's MCP servers offers. Picking one does not
   insert text: the token is removed and the resource is read and attached
   (`onResource`), because what it names is not a path the agent can open.
   Filtered here rather than asked for: the listing is already in the cache, and
   a server's resource list is a handful of rows, not a tree to walk. */
import { Plug } from "lucide-react"
import type { MentionSource } from "../types"

export interface McpResourceMatch {
  type: "mcp-resource"
  serverId: string
  server: string
  uri: string
  name: string
  mimeType?: string
}

const LIMIT = 8

export const mcpResourcesSource: MentionSource<McpResourceMatch> = {
  id: "mcp-resource",
  available: (ctx) => !!ctx.mcpServers?.length,
  search(query, ctx) {
    const q = query.toLowerCase()
    return (ctx.mcpServers ?? [])
      .flatMap((server) =>
        server.resources.map((r) => ({
          type: "mcp-resource" as const,
          serverId: server.id,
          server: server.name,
          uri: r.uri ?? r.name,
          name: r.description || r.uri || r.name,
          mimeType: r.mimeType,
        })),
      )
      .filter((r) => !q || `${r.server} ${r.name} ${r.uri}`.toLowerCase().includes(q))
      .slice(0, LIMIT)
  },
  key: (match) => `${match.serverId}:${match.uri}`,
  insert: (match, ctx) => ({ type: "remove", run: () => ctx.actions.onResource?.(match) }),
  face: () => null,
  row: (match) => ({
    icon: Plug,
    prefix: `${match.server}: `,
    label: match.name,
    aside: match.mimeType,
    badge: "MCP resource",
  }),
}
