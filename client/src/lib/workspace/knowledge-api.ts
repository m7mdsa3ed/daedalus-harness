/* The knowledge-base client. Mirrors `server/src/knowledge.ts` one call per route.

   The agent reaches the same table through the `knowledge` MCP server; this is
   the REST half so the user can see and edit entries in Settings › Projects.
   Each function takes the connection to talk to — the query hooks in
   lib/queries supply it from the active server — so nothing here reaches for
   a module-level active connection. */
import { api, type ServerSettings } from "@/lib/settings"

export interface KnowledgeEntry {
  id: string
  title: string
  content: string
  tags: string[]
  createdAt: number
  updatedAt: number
}

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/knowledge`

/** An entry as the cross-project list reports it: with its project named. */
export type KnowledgeEntryAcross = KnowledgeEntry & { projectId: string; projectName: string }

/** Every entry across every project, newest-updated first — Settings ›
    Knowledge base reads the whole store, not one workspace's slice. */
export function listAllKnowledge(
  settings: ServerSettings,
  signal?: AbortSignal
): Promise<KnowledgeEntryAcross[]> {
  return api<KnowledgeEntryAcross[]>(settings, "/api/knowledge", { signal })
}

export function listKnowledge(
  settings: ServerSettings,
  projectId: string,
  signal?: AbortSignal
): Promise<KnowledgeEntry[]> {
  return api<KnowledgeEntry[]>(settings, base(projectId), { signal })
}

export function addKnowledge(
  settings: ServerSettings,
  projectId: string,
  body: { title: string; content: string; tags?: string[] },
): Promise<KnowledgeEntry> {
  return api<KnowledgeEntry>(settings, base(projectId), {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function deleteKnowledge(
  settings: ServerSettings,
  projectId: string,
  id: string
): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(settings, `${base(projectId)}/${encodeURIComponent(id)}`, {
    method: "DELETE",
  })
}
