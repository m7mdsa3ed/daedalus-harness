import type { Hono } from "hono";
import { stream } from "hono/streaming";

import {
  devStatus,
  restartDevServer,
  runDevTask,
  startDevServer,
  stopDevServer,
  subscribeDevStatus,
} from "../dev-server.js";
import * as git from "../git.js";
import { proxyPreviewRequest } from "../preview-proxy.js";
import type { DevStatus } from "../protocol.js";
import { ScaffoldInputSchema, listTemplates, scaffoldProject } from "../templates.js";
import { WorkspaceError, projectRoot } from "../workspace-fs.js";
import { workspace } from "./helpers.js";

/** The Build mode: templates, scaffolding a project from one, the managed
    dev server and its status stream, and the preview's own traffic. The
    socket-upgrade half of the preview — Vite's HMR — stays in index.ts's
    `server.on("upgrade")` handler, before the token check, like the IDE's. */
export function builderRoutes(app: Hono): void {
  app.get("/api/templates", (c) => c.json(listTemplates()));

  /* Copies the template, records the project and answers with it; the install
     and the dev server start behind the response. A failure before the row
     exists removes what was written (see templates.ts, "The crux"). With no
     template (`templateId` null or "scratch") the project is an empty
     directory with the rules file and no dev command: there is nothing to
     start until the agent's first turn has built a stack, and the session
     manager senses the command off the directory when that turn ends. */
  app.post("/api/projects/from-template", async (c) => {
    const parsed = ScaffoldInputSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    try {
      const project = await scaffoldProject(parsed.data);
      if (project.devCommand)
        startDevServer(project.id).catch((error) =>
          console.error(`[dev-server] start after scaffold failed for ${project.id}`, error),
        );
      return c.json({ project }, 201);
    } catch (err) {
      if (err instanceof WorkspaceError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  app.get("/api/projects/:id/dev", (c) => workspace(c, () => devStatus(c.req.param("id"))));

  app.post("/api/projects/:id/dev", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { action?: unknown };
    const id = c.req.param("id");
    return workspace(c, () => {
      switch (body.action) {
        case "start":
          return startDevServer(id);
        case "stop":
          projectRoot(id);
          return stopDevServer(id);
        case "restart":
          return restartDevServer(id);
        case "build":
        case "check":
          return runDevTask(id, body.action);
        default:
          throw new WorkspaceError(`unknown dev action: ${String(body.action)}`, 400);
      }
    });
  });

  /* Status changes as NDJSON, the shape `/watch` uses and for the same reason:
     EventSource cannot carry the bearer token. The first line is the status
     now, so a subscriber never has to ask twice. */
  app.get("/api/projects/:id/dev/events", (c) => {
    const id = c.req.param("id");
    let first: DevStatus;
    try {
      first = devStatus(id);
    } catch (err) {
      if (err instanceof WorkspaceError) return c.json({ error: err.message }, err.status);
      throw err;
    }

    return stream(c, async (s) => {
      c.header("Content-Type", "application/x-ndjson");
      c.header("Cache-Control", "no-store");
      const queue: DevStatus[] = [first];
      const wake = { fn: null as (() => void) | null };
      const off = subscribeDevStatus(id, (status) => {
        queue.push(status);
        wake.fn?.();
      });
      s.onAbort(() => {
        off();
        wake.fn?.();
      });
      try {
        while (!s.closed && !s.aborted) {
          const next = queue.shift();
          if (next) {
            await s.write(JSON.stringify(next) + "\n");
            continue;
          }
          await new Promise<void>((resolve) => {
            wake.fn = () => {
              wake.fn = null;
              resolve();
            };
            setTimeout(() => wake.fn?.(), 30_000).unref?.();
          });
          if (queue.length === 0) await s.write("\n");
        }
      } finally {
        off();
      }
    });
  });

  /* The project's commits as restore points, and the two writes over them.
     Git's own surface (status, stage, commit…) stays on /git; these are the
     Build-mode verbs — a checkpoint is "commit everything under this name"
     and a restore is a new commit with an old tree — and both answer the
     refreshed list so the drawer never has to ask twice. */
  app.get("/api/projects/:id/history", (c) => {
    const limit = Number(c.req.query("limit") ?? "50");
    return workspace(c, () => git.log(c.req.param("id"), { limit: Number.isFinite(limit) ? limit : 50 }));
  });

  app.post("/api/projects/:id/history", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      action?: unknown;
      hash?: unknown;
      message?: unknown;
    };
    const id = c.req.param("id");
    return workspace(c, async () => {
      switch (body.action) {
        case "checkpoint": {
          const result = await git.checkpoint(id, typeof body.message === "string" ? body.message : "");
          return { ...result, commits: await git.log(id) };
        }
        case "restore": {
          if (typeof body.hash !== "string") throw new WorkspaceError("a restore needs a commit hash", 400);
          const result = await git.restoreTo(id, body.hash);
          return { ...result, commits: await git.log(id) };
        }
        default:
          throw new WorkspaceError(`unknown history action: ${String(body.action)}`, 400);
      }
    });
  });

  /* The preview's own traffic. Authorized by the per-boot key in the path and
     nothing else — an iframe cannot send a bearer — see preview-proxy.ts. */
  app.all("/preview/*", (c) => proxyPreviewRequest(c.req.raw));
}
