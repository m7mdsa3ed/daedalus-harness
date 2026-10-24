import type { Hono } from "hono";
import { z } from "zod";
import { searchGit, type GitSearchKind } from "../mentions/git-search.js";
import { searchLocal, type LocalSearchKind } from "../mentions/local-search.js";
import { expandMentions } from "../mentions/index.js";
import { readMcpText } from "../mcp-check.js";
import { getProject } from "../projects.js";
import { threadMcpServers } from "../thread-mcp.js";
import { threadCwd, type SessionManager } from "../sessions.js";

const ContextSchema = z.object({
  text: z.string().max(200_000),
  projectId: z.string().min(1),
  /** Absent — or not a row yet — for a draft: the project's cwd stands in. */
  sessionId: z.string().min(1).optional(),
});

const GIT_KINDS: readonly string[] = ["commit", "branch", "tag", "git"] satisfies GitSearchKind[];
const LOCAL_KINDS: readonly string[] = ["kb", "run", "term"] satisfies LocalSearchKind[];

export function mentionRoutes(app: Hono, deps: { sessions: SessionManager }): void {
  /** A message's `@kind:ref` mentions → the `<context>` block the composer
      appends before it sends (mentions/expand.ts), so the transcript holds what
      the agent got. `claimed` is the `kind:ref` tokens a resolver took. */
  app.post("/api/mentions/context", async (c) => {
    const parsed = ContextSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { text, projectId, sessionId } = parsed.data;
    const session = sessionId ? deps.sessions.get(sessionId) : undefined;
    const project = session?.project ?? (await getProject(projectId));
    if (!project) return c.json({ error: "unknown project" }, 404);
    const cwd = session?.project ? threadCwd(session, session.project) : project.cwd;
    const servers = sessionId ? await threadMcpServers(deps.sessions, sessionId) : null;
    const readMcpResource = servers
      ? async (serverId: string, uri: string) => {
          const server = servers.find((s) => s.id === serverId);
          return server ? readMcpText(server.id, server.def, uri) : null;
        }
      : undefined;
    const out = await expandMentions(text, { projectId, sessionId, cwd, readMcpResource });
    return c.json({ text: out.text, claimed: [...out.claimed] });
  });
  /** Matches for `@commit:` / `@branch:` / `@tag:` / `@git:` (the thread's
      repository and the project's nested ones) and `@kb:` / `@run:` / `@term:`
      (this project's own records) — titles and one-line facts only. */
  app.get("/api/projects/:projectId/mentions/search", async (c) => {
    const kind = c.req.query("kind") ?? "";
    if (!GIT_KINDS.includes(kind) && !LOCAL_KINDS.includes(kind)) return c.json({ error: `unknown kind ${kind}` }, 400);
    const sessionId = c.req.query("session") || undefined;
    const session = sessionId ? deps.sessions.get(sessionId) : undefined;
    const project = session?.project ?? (await getProject(c.req.param("projectId")));
    if (!project) return c.json({ error: "unknown project" }, 404);
    const cwd = session?.project ? threadCwd(session, session.project) : project.cwd;
    const q = c.req.query("q") ?? "";
    return c.json({
      matches: LOCAL_KINDS.includes(kind)
        ? await searchLocal(project.id, sessionId, kind as LocalSearchKind, q)
        : await searchGit(project.id, cwd, kind as GitSearchKind, q),
    });
  });
}
