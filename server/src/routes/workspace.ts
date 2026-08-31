import type { Hono } from "hono";
import { stream } from "hono/streaming";
import {
  ProjectInputSchema,
  createProject,
  deleteProject,
  updateProject,
  listProjects,
} from "../projects.js";
import { listDirectory } from "../fs.js";
import {
  WorkspaceError,
  createEntry,
  deleteEntry,
  listDir,
  projectRoot,
  readFile as readWorkspaceFile,
  readFileBytes,
  renameEntry,
  searchEntries,
  statFile,
  writeFile as writeWorkspaceFile,
} from "../workspace-fs.js";
import { stopWatching, watchProject, type WatchBatch } from "../workspace-watch.js";
import * as git from "../git.js";
import { createPreview, deletePreview, listPreviews } from "../previews.js";
import { createTerminal, killProjectTerminals, killTerminal, listTerminals } from "../terminals.js";
import { crud, flag, workspace } from "./helpers.js";

/** Projects and everything scoped to a project's directory: the workspace
    filesystem, saved previews, source control, the file watcher and the
    terminals' JSON half. */
export function workspaceRoutes(app: Hono): void {
  app.get("/api/projects", (c) => c.json(listProjects()));
  const projectCrud = crud(ProjectInputSchema);
  app.post("/api/projects", projectCrud.create(createProject));
  app.put("/api/projects/:id", projectCrud.update(updateProject));
  app.delete("/api/projects/:id", (c) => {
    const id = c.req.param("id");
    if (!deleteProject(id)) return c.json({ error: "not found" }, 404);
    // The directory may still exist, but nothing is allowed to look at it through
    // this project any more — and a watcher nobody can unsubscribe from is a
    // handle held until the process exits.
    stopWatching(id);
    killProjectTerminals(id);
    return c.json({ ok: true });
  });

  // Feeds the client's path autocomplete; ?path= (empty lists the home dir).
  // Handles its own errors: `not found` vs `not a directory` deserve real codes,
  // and app.onError would flatten both to 500.
  app.get("/api/fs/list", (c) => {
    try {
      return c.json(listDirectory(c.req.query("path") ?? ""));
    } catch (err) {
      const status = (err as { status?: number }).status;
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, status === 404 ? 404 : status === 400 ? 400 : 500);
    }
  });

  app.get("/api/projects/:projectId/tree", (c) =>
    workspace(c, () =>
      listDir(c.req.param("projectId"), c.req.query("path"), {
        hidden: flag(c, "hidden"),
        ignored: flag(c, "ignored"),
      }),
    ),
  );

  /* Feeds the composer's `@` menu. Separate from `/tree` because it answers a
     different question — "where is the file called roughly this", across the
     whole project — and a `?q=` on a listing route would be two routes wearing
     one path. */
  app.get("/api/projects/:projectId/files/search", (c) =>
    workspace(c, () => {
      const limit = Number(c.req.query("limit"));
      return searchEntries(c.req.param("projectId"), c.req.query("q"), {
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      });
    }),
  );

  app.get("/api/projects/:projectId/file", (c) =>
    workspace(c, () => readWorkspaceFile(c.req.param("projectId"), c.req.query("path") ?? "")),
  );

  /* Raw bytes, for the editor's image preview. Not folded into `/file`: that
     route answers JSON, and a route whose response type depends on a query flag
     is one the client has to guess about. `svg` is served as `image/svg+xml`
     because an <img> renders it inertly — it is never handed to a document. */
  app.get("/api/projects/:projectId/file-raw", async (c) => {
    try {
      const { bytes, contentType } = await readFileBytes(
        c.req.param("projectId"),
        c.req.query("path") ?? "",
      );
      return c.body(bytes as unknown as ArrayBuffer, 200, {
        "Content-Type": contentType,
        "Content-Disposition": "inline",
        "Cache-Control": "no-store",
        // Belt and braces next to the type allowlist above.
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "X-Content-Type-Options": "nosniff",
      });
    } catch (err) {
      if (err instanceof WorkspaceError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  app.get("/api/projects/:projectId/file-stat", (c) =>
    workspace(c, () => statFile(c.req.param("projectId"), c.req.query("path") ?? "")),
  );

  app.put("/api/projects/:projectId/file", async (c) => {
    const body = (await c.req.json()) as {
      content?: unknown;
      expectedVersion?: unknown;
      force?: unknown;
    };
    if (typeof body.content !== "string") return c.json({ error: "content must be a string" }, 400);
    return workspace(c, () =>
      writeWorkspaceFile(c.req.param("projectId"), c.req.query("path") ?? "", body.content as string, {
        expectedVersion: typeof body.expectedVersion === "string" ? body.expectedVersion : undefined,
        force: body.force === true,
      }),
    );
  });

  app.post("/api/projects/:projectId/files", async (c) => {
    const body = (await c.req.json()) as { path?: unknown; type?: unknown };
    if (typeof body.path !== "string") return c.json({ error: "path is required" }, 400);
    const type = body.type === "dir" ? "dir" : "file";
    return workspace(c, () => createEntry(c.req.param("projectId"), body.path as string, type));
  });

  app.patch("/api/projects/:projectId/files", async (c) => {
    const body = (await c.req.json()) as { from?: unknown; to?: unknown };
    if (typeof body.from !== "string" || typeof body.to !== "string")
      return c.json({ error: "from and to are required" }, 400);
    return workspace(c, () =>
      renameEntry(c.req.param("projectId"), body.from as string, body.to as string),
    );
  });

  app.delete("/api/projects/:projectId/files", async (c) => {
    const body = (await c.req.json()) as { path?: unknown };
    if (typeof body.path !== "string") return c.json({ error: "path is required" }, 400);
    return workspace(c, () => deleteEntry(c.req.param("projectId"), body.path as string));
  });

  /* Saved preview URLs. A project's dev-server address belongs to the project,
     not to a browser tab — you want the same one back on the phone that you saved
     on the laptop, which is why this is SQLite and not localStorage. */
  app.get("/api/projects/:projectId/previews", (c) =>
    workspace(c, () => listPreviews(c.req.param("projectId"))),
  );

  app.post("/api/projects/:projectId/previews", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { label?: unknown; url?: unknown };
    return workspace(c, () => createPreview(c.req.param("projectId"), body.label, body.url));
  });

  app.delete("/api/projects/:projectId/previews/:previewId", (c) =>
    deletePreview(c.req.param("previewId"))
      ? c.json({ ok: true })
      : c.json({ error: "no such preview" }, 404),
  );

  /* Source control. Every write names its paths explicitly — there is no
     "everything" shortcut on discard, because the one destructive operation here
     should not have a form where an empty list means the whole tree.

     `?repo=` / `body.repo` names which repository, project-relative, because a
     project directory can hold several (or sit inside one). Absent means the
     project's own — which is what every client before this sent. */
  app.get("/api/projects/:projectId/git/repos", (c) =>
    workspace(c, () => git.repositories(c.req.param("projectId"))),
  );

  app.get("/api/projects/:projectId/git/status", (c) =>
    workspace(c, () => git.status(c.req.param("projectId"), c.req.query("repo"))),
  );

  app.get("/api/projects/:projectId/git/branches", (c) =>
    workspace(c, () => git.branches(c.req.param("projectId"), c.req.query("repo"))),
  );

  app.get("/api/projects/:projectId/git/file", (c) => {
    const comparison = c.req.query("comparison");
    const side: git.Comparison =
      comparison === "staged" ? "staged" : comparison === "worktree" ? "worktree" : "head";
    /* No `?repo=`: the path is project-relative and names exactly one
       worktree, so the server derives it. */
    return workspace(c, () =>
      git.fileAt(c.req.param("projectId"), c.req.query("path") ?? "", side),
    );
  });

  app.post("/api/projects/:projectId/git/:action", async (c) => {
    const projectId = c.req.param("projectId");
    const action = c.req.param("action");
    const body = (await c.req.json().catch(() => ({}))) as {
      paths?: unknown;
      message?: unknown;
      branch?: unknown;
      create?: unknown;
      amend?: unknown;
      repo?: unknown;
    };
    const paths = Array.isArray(body.paths)
      ? body.paths.filter((p): p is string => typeof p === "string")
      : [];
    const repo = typeof body.repo === "string" ? body.repo : undefined;

    switch (action) {
      case "stage":
        return workspace(c, async () => {
          await git.stage(projectId, paths, repo);
          return git.status(projectId, repo);
        });
      case "unstage":
        return workspace(c, async () => {
          await git.unstage(projectId, paths, repo);
          return git.status(projectId, repo);
        });
      case "discard":
        return workspace(c, async () => {
          await git.discard(projectId, paths, repo);
          return git.status(projectId, repo);
        });
      case "commit":
        return workspace(c, async () => {
          const result = await git.commit(projectId, String(body.message ?? ""), {
            amend: body.amend === true,
            repo,
          });
          return { ...result, status: await git.status(projectId, repo) };
        });
      case "checkout":
        return workspace(c, async () => {
          await git.checkout(projectId, String(body.branch ?? ""), {
            create: body.create === true,
            repo,
          });
          return git.status(projectId, repo);
        });
      default:
        return c.json({ error: `unknown git action: ${action}` }, 404);
    }
  });

  /* Terminals. The list and the lifecycle are ordinary JSON routes; the bytes go
     over their own WebSocket (see the upgrade handler in index.ts) because a
     PTY stream has nothing to do with the thread protocol's journal and replay. */
  app.get("/api/projects/:projectId/terminals", (c) =>
    workspace(c, () => listTerminals(c.req.param("projectId"))),
  );

  app.post("/api/projects/:projectId/terminals", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { title, cols, rows } = body as { title?: string; cols?: number; rows?: number };
    return workspace(c, () => createTerminal(c.req.param("projectId"), { title, cols, rows }));
  });

  app.delete("/api/projects/:projectId/terminals/:terminalId", (c) =>
    killTerminal(c.req.param("terminalId"))
      ? c.json({ ok: true })
      : c.json({ error: "no such terminal" }, 404),
  );

  /* File events as an NDJSON stream rather than SSE: EventSource cannot set an
     Authorization header, and the alternative is the bearer token in a URL — in
     history, in logs, in whatever proxy is in front. `fetch` reads this fine. */
  app.get("/api/projects/:projectId/watch", (c) => {
    const projectId = c.req.param("projectId");
    /* Validate before streaming, not inside it: once `stream()` has taken the
       response there is no status left to send, so an unknown project would have
       been a 200 that immediately ends rather than the 404 it is. */
    try {
      projectRoot(projectId);
    } catch (err) {
      if (err instanceof WorkspaceError) return c.json({ error: err.message }, err.status);
      throw err;
    }

    return stream(c, async (s) => {
      c.header("Content-Type", "application/x-ndjson");
      c.header("Cache-Control", "no-store");
      const queue: WatchBatch[] = [];
      const wake = { fn: null as (() => void) | null };
      const off = watchProject(projectId, (batch) => {
        queue.push(batch);
        wake.fn?.();
      });
      s.onAbort(() => {
        off();
        wake.fn?.();
      });
      try {
        while (!s.closed && !s.aborted) {
          const batch = queue.shift();
          if (batch) {
            await s.write(JSON.stringify(batch) + "\n");
            continue;
          }
          await new Promise<void>((resolve) => {
            wake.fn = () => {
              wake.fn = null;
              resolve();
            };
            /* A blank-line heartbeat, so a connection that died is noticed by
               the write failing rather than by nothing ever happening in a repo
               where nothing is happening. */
            setTimeout(() => wake.fn?.(), 30_000).unref?.();
          });
          if (queue.length === 0) await s.write("\n");
        }
      } finally {
        off();
      }
    });
  });
}
