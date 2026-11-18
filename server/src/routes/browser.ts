import type { Hono } from "hono";
import { z } from "zod";
import { browserTabOf, runBrowserTool } from "../browser-agent.js";
import { isBrowserTool } from "../browser-mcp-tools.js";
import type {
  BrowserTabCreateResponse,
  BrowserTabDeleteResponse,
  BrowserTabsResponse,
} from "../browser-protocol.js";
import { getBrowserStatus } from "../browser-status.js";
import { closeTab, listTabs, openTab, profileDir } from "../browsers.js";
import { getProject } from "../projects.js";
import type { Session } from "../sessions.js";
import { flag } from "./helpers.js";

const CreateSchema = z.object({ url: z.string().min(1).max(32_768).optional() });

/** What the `/bm` loopback needs: the workflow engine's caller resolution, and
    the manager's door for the live-only `browser_activity` event. */
export interface BrowserMcpDeps {
  runner: { resolveCaller(key: string, sessionId: string): Pick<Session, "id" | "projectId"> | null };
  announce(sessionId: string, projectId: string, tabId: string): void;
}

/** The browser panel's REST half (docs/plans/browser.md, `browser-protocol.ts`).
    A refusal is a `BrowserError` with its status, which `app.onError` answers
    as `{ error }`. GET never launches a browser; POST and the socket do.
    Given `mcp`, also the `/bm` loopback the `browser` MCP server drives. */
export function browserRoutes(app: Hono, mcp?: BrowserMcpDeps): void {
  app.get("/api/browser/status", async (c) => c.json(await getBrowserStatus({ refresh: flag(c, "refresh") })));

  app.get("/api/projects/:id/browser/tabs", async (c) => {
    const id = c.req.param("id");
    if (!(await getProject(id))) return c.json({ error: "unknown project" }, 404);
    profileDir(id);
    return c.json(listTabs(id) satisfies BrowserTabsResponse);
  });

  app.post("/api/projects/:id/browser/tabs", async (c) => {
    const id = c.req.param("id");
    const parsed = CreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "bad request" }, 400);
    if (!(await getProject(id))) return c.json({ error: "unknown project" }, 404);
    const tab = await openTab(id, { url: parsed.data.url, openedBy: { kind: "user" } });
    return c.json({ tab } satisfies BrowserTabCreateResponse, 201);
  });

  app.delete("/api/projects/:id/browser/tabs/:tabId", async (c) => {
    const id = c.req.param("id");
    if (!(await getProject(id))) return c.json({ error: "unknown project" }, 404);
    if (!(await closeTab(id, c.req.param("tabId")))) return c.json({ error: "no such tab" }, 404);
    return c.json({ ok: true } satisfies BrowserTabDeleteResponse);
  });

  if (mcp) browserMcpRoutes(app, mcp);
}

/**
 * `/bm/<key>/<sessionId>/<tool>` — outside `/api`, so outside the bearer check:
 * the loopback key is the credential and the session id names the only thread
 * the call acts for (the `/hm` bargain, routes/harness.ts). The thread's
 * project names the browser; a subagent or workflow step is a thread of its
 * parent's project, so it drives the same browser on a tab of its own.
 */
function browserMcpRoutes(app: Hono, { runner, announce }: BrowserMcpDeps): void {
  /** Threads already told they are driving, this boot. */
  const announced = new Set<string>();

  app.post("/bm/:key/:sessionId/:tool", async (c) => {
    const caller = runner.resolveCaller(c.req.param("key") ?? "", c.req.param("sessionId") ?? "");
    if (!caller) return c.json({ error: "not found" }, 404);
    const tool = c.req.param("tool") ?? "";
    if (!isBrowserTool(tool)) return c.json({ error: `unknown browser tool: ${tool}` }, 404);
    const who = { projectId: caller.projectId, sessionId: caller.id };
    const result = await runBrowserTool(who, tool, await c.req.json().catch(() => ({})));
    if (!announced.has(caller.id)) {
      const tabId = browserTabOf(who);
      if (tabId) {
        announced.add(caller.id);
        announce(caller.id, caller.projectId, tabId);
      }
    }
    return c.json(result);
  });
}
