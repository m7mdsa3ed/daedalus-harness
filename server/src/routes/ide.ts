import type { Hono } from "hono";
import { IdeThemeSchema, applyIdeTheme, ideStatus, startIde, stopIde } from "../ide.js";
import { proxyIdeRequest } from "../ide-proxy.js";
import { WorkspaceError } from "../workspace-fs.js";
import { workspace } from "./helpers.js";

/** The embedded editor. The socket upgrade half — which must run before the
    token check — stays in index.ts's `server.on("upgrade")` handler. */
export function ideRoutes(app: Hono): void {
  /* These three are the authenticated half — they say
     whether a VS Code is running for a project and start or stop one. The editor
     itself is not served from here: it answers on `/ide/<key>/…` below, outside
     `/api`, because an iframe cannot send an Authorization header and the key in
     the path is what stands in for one (see ide.ts). */
  app.get("/api/projects/:projectId/ide", (c) =>
    workspace(c, () => ideStatus(c.req.param("projectId"))),
  );

  /* The body is optional: `{ theme }` paints the editor in the app's palette
     before it first loads (see `applyIdeTheme`). An older panel sends none. */
  app.post("/api/projects/:projectId/ide", (c) =>
    workspace(c, async () => {
      const body = (await c.req.json().catch(() => null)) as { theme?: unknown } | null;
      const theme = body?.theme ? IdeThemeSchema.safeParse(body.theme) : null;
      return startIde(c.req.param("projectId"), theme?.success ? theme.data : undefined);
    }),
  );

  app.put("/api/projects/:projectId/ide/theme", (c) =>
    workspace(c, async () => {
      const parsed = IdeThemeSchema.safeParse(await c.req.json());
      if (!parsed.success) throw new WorkspaceError(parsed.error.message, 400);
      applyIdeTheme(c.req.param("projectId"), parsed.data);
      return { ok: true };
    }),
  );

  app.delete("/api/projects/:projectId/ide", (c) =>
    workspace(c, () => {
      stopIde(c.req.param("projectId"));
      return ideStatus(c.req.param("projectId"));
    }),
  );

  /* The editor's own traffic. Authorized by the unguessable key in the path and
     by nothing else — deliberately, since every asset under it is a relative URL
     the browser resolves on its own. `parseIdePath` is the only thing that turns
     one into a loopback port, and a key it does not know is a 404. */
  app.all("/ide/*", (c) => proxyIdeRequest(c.req.raw));
}
