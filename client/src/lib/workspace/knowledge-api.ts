/* The knowledge-base client. Mirrors `server/src/knowledge.ts` one call per route.

   The agent reaches the same table through the `knowledge` MCP server; this is
   the REST half so the user can see and edit entries in Settings › Projects.
   Mirrors git-api.ts: each function wraps `api()` with the active connection,
   so the panel never has to know where the server is. */
import { api, loadSettings, ApiError, type ServerSettings } from "@/lib/settings"

export interface KnowledgeEntry {
  id: string
  title: string
  content: string
  tags: string[]
  createdAt: number
  updatedAt: number
}

function server(): ServerSettings {
  const settings = loadSettings()
  if (!settings) throw new ApiError({ status: 0, path: "/api", serverMessage: "not connected" })
  return settings
}

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/knowledge`

export function listKnowledge(projectId: string, signal?: AbortSignal): Promise<KnowledgeEntry[]> {
  return api<KnowledgeEntry[]>(server(), base(projectId), { signal })
}

export function addKnowledge(
  projectId: string,
  body: { title: string; content: string; tags?: string[] },
): Promise<KnowledgeEntry> {
  return api<KnowledgeEntry>(server(), base(projectId), { method: "POST", body: JSON.stringify(body) })
}

export function deleteKnowledge(projectId: string, id: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(server(), `${base(projectId)}/${encodeURIComponent(id)}`, { method: "DELETE" })
}
