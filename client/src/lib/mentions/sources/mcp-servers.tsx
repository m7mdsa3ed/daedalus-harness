/* A library MCP server not yet linked to this draft. Picking one does not
   insert text: the token is removed and the server is linked to the draft. */
import { Plug } from "lucide-react"
import { McpIcon } from "@/components/entity-icon"
import { mcpNeedsAuth, mcpSubtitle, type McpServerDef } from "@/lib/settings"
import { useMcpServers } from "@/lib/queries/catalog"
import type { MentionSource } from "../types"

export interface McpServerMatch {
  type: "mcp-server"
  server: McpServerDef
}

const LIMIT = 8

export const mcpServersSource: MentionSource<McpServerMatch, McpServerDef[]> = {
  id: "mcp-server",
  useData: () => useMcpServers(),
  available: (ctx) => ctx.draft,
  search(query, ctx, library) {
    if (query.includes("/")) return []
    const q = query.toLowerCase()
    return library
      .filter((server) => !ctx.linked.has(server.id))
      .filter((server) => `${server.name} ${mcpSubtitle(server)}`.toLowerCase().includes(q))
      .slice(0, LIMIT)
      .map((server) => ({ type: "mcp-server" as const, server }))
  },
  key: (match) => match.server.id,
  insert: (match, ctx) => ({ type: "remove", run: () => ctx.actions.onMcpServer?.(match.server) }),
  face: () => null,
  row: ({ server }) => ({
    icon: Plug,
    mark: <McpIcon server={server} className="size-4" />,
    label: server.name,
    description: mcpSubtitle(server),
    badge: mcpNeedsAuth(server) ? "needs auth" : "enable MCP",
  }),
}
