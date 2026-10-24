/* A thread's MCP servers as its agent would be handed them: the one resolution
   the composer's `/` and `@` reads (`routes/library.ts`) and the `@mcp:`
   mention resolver (`mentions/resolvers/mcp.ts`) both stand on. */
import type * as acp from "./acp.js";
import { getConfig } from "./config.js";
import { getProject, type Project } from "./projects.js";
import { mcpServersFor, type SessionManager } from "./sessions.js";

export interface ThreadMcpServerDef {
  id: string;
  def: acp.McpServer;
}

/** Null when there is no such thread (or its project is gone). Resolved through
    `mcpServersFor`, the function a spawn uses, so a workflow server — which has
    no prompts or resources — is not among them. */
export async function threadMcpServers(sessions: SessionManager, sessionId: string): Promise<ThreadMcpServerDef[] | null> {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const project: Project | undefined = session.project ?? (await getProject(session.projectId));
  if (!project) return null;
  const ids = sessions.effectiveLinks(session).mcpServerIds;
  const resolved = await Promise.all(
    ids.map(async (id) => {
      const { servers } = await mcpServersFor({ mcpServerIds: [id] }, project, getConfig(), null);
      return servers[0] ? { id, def: servers[0] } : null;
    }),
  );
  return resolved.filter((r) => r !== null);
}
