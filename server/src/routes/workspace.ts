import type { Hono } from "hono";
import { stream } from "hono/streaming";
import { z } from "zod";
import { enhancePrompt } from "../enhance.js";
import { profileHasAgent } from "../registry.js";
import { getProfile } from "../profiles.js";
import {
  ProjectDefaultsPatchSchema,
  ProjectInputSchema,
  createProject,
  deleteProject,
  getProject,
  setProjectDefaults,
  updateProject,
  listProjects,
  reorderProjects,
} from "../projects.js";
import { listDirectory } from "../fs.js";
import { projectStats } from "../project-stats.js";
import {
  WorkspaceError,
  createEntry,
  deleteEntry,
  listDir,
  projectRoot,
  readFile as readWorkspaceFile,
  readFileBytes,
  renameEntry,
  searchContents,
  searchEntries,
  statFile,
  writeFile as writeWorkspaceFile,
} from "../workspace-fs.js";
import { stopWatching, watchProject, type WatchBatch } from "../workspace-watch.js";
import * as git from "../git.js";
import { createTerminal, killProjectTerminals, killTerminal, listTerminals } from "../terminals.js";
import {
  HelperInputSchema,
  addHelper,
  deleteHelper,
  getHelper,
  listHelpers,
  updateHelper,
} from "../project-helpers.js";
import { listProjectScripts } from "../project-scripts.js";
import { clearShellHistory, listShellHistory } from "../shell-history.js";
import { crud, flag, workspace } from "./helpers.js";

/** The one kind of address a preview may be — plain http(s). */
const PREVIEW_SCHEME = /^https?:\/\//i;

/**
 * Whether the project's dev server answers, probed *from the server* rather
 * than from the browser. A browser fetch to the dev server is blocked by CORS
 * (the dev server did not grant this origin), and a cross-origin iframe cannot
 * be inspected — but the server and the dev server share a machine, so a
 * loopback fetch answers the real question: "is it running?". The URL stored
 * is the person's own (localhost, a LAN address, a tunnel) — probing from the
 * server works because the harness runs where the dev server runs.
 *
 * Any HTTP response counts as "up": a dev server that answers 404 on its root
 * is still running, and the panel's job is to say so and load it.
 */
async function probePreview(url: string): Promise<boolean> {
  if (!PREVIEW_SCHEME.test(url)) return false;
  try {
    const res = await fetch(url, {
      method: "GET",
      // Headers, not the body: a slow-to-stream page is still up, and the
      // body of something like a deep endpoint is not the point of a probe.
      signal: AbortSignal.timeout(2500),
      redirect: "follow",
    });
    return typeof res.status === "number";
  } catch {
    return false;
  }
}

/** Projects and everything scoped to a project's directory: the workspace
    filesystem, source control, the file watcher and the terminals' JSON half. */
export function workspaceRoutes(app: Hono): void {
  app.get("/api/projects", async (c) => c.json(await listProjects()));
  const projectCrud = crud(ProjectInputSchema);
  app.post("/api/projects", projectCrud.create(createProject));
  /* Declared before `:id` so the literal wins the match, and answering with
     the reordered list means the client's invalidate has the truth already. */
  app.post("/api/projects/reorder", async (c) => {
    const body = await c.req.json().catch(() => null);
    const ids = z.array(z.string().min(1)).safeParse((body as { ids?: unknown } | null)?.ids);
    if (!ids.success) return c.json({ error: "ids must be an array of project ids" }, 400);
    return c.json(await reorderProjects(ids.data));
  });
  app.put("/api/projects/:id", projectCrud.update(updateProject));
  /* How a thread started here opens. Its own `PATCH` rather than a field on
     the editor's `PUT` for the reason `setProjectDefaults` gives: the composer
     writes this on every pick, without holding the rest of the project to send
     back with it. Keys not named are left alone. */
  app.patch("/api/projects/:id/defaults", async (c) => {
    const parsed = ProjectDefaultsPatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const updated = await setProjectDefaults(c.req.param("id"), parsed.data);
    return updated ? c.json(updated) : c.json({ error: "not found" }, 404);
  });
  app.delete("/api/projects/:id", async (c) => {
    const id = c.req.param("id");
    if (!await deleteProject(id)) return c.json({ error: "not found" }, 404);
    // The directory may still exist, but nothing is allowed to look at it through
    // this project any more — and a watcher nobody can unsubscribe from is a
    // handle held until the process exits.
    stopWatching(id);
    killProjectTerminals(id);
    return c.json({ ok: true });
  });

  /* Helper commands: the small shell actions a person runs against this
     workspace from its page's header. The rows are read back embedded on the
     project itself; these are the writes and the one async run. */
  app.get("/api/projects/:id/helpers", (c) => workspace(c, async () => await listHelpers(c.req.param("id"))));

  /* The scripts the project's own package.json files declare (root and one
     directory deep) — read off the disk, never stored, and suggested by the
     composer's `!` completer beside the saved helpers. */
  app.get("/api/projects/:id/scripts", (c) =>
    workspace(c, async () => await listProjectScripts(c.req.param("id")))
  );

  /* The `!` lines this project keeps running, most used first — the
     completer's third list, and the only one nobody wrote down. Recorded by
     the shell route itself, so there is no POST here. */
  app.get("/api/projects/:id/shell-history", (c) =>
    workspace(c, async () => await listShellHistory(c.req.param("id")))
  );

  /* Forget one line (`?line=`) or the project's whole history. Explicit
     gesture only, like the composer history's delete. */
  app.delete("/api/projects/:id/shell-history", (c) =>
    workspace(c, async () => ({
      ok: true as const,
      removed: await clearShellHistory(c.req.param("id"), c.req.query("line") || undefined),
    }))
  );

  app.post("/api/projects/:id/helpers", async (c) => {
    const parsed = HelperInputSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return workspace(c, async () => await addHelper(c.req.param("id"), parsed.data));
  });

  app.put("/api/projects/:id/helpers/:helperId", async (c) => {
    const parsed = HelperInputSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const updated = await workspace(c, async () =>
      await updateHelper(c.req.param("id"), c.req.param("helperId"), parsed.data),
    );
    return updated ? c.json(updated) : c.json({ error: "no such helper" }, 404);
  });

  app.delete("/api/projects/:id/helpers/:helperId", async (c) =>
    (await workspace(c, async () => await deleteHelper(c.req.param("id"), c.req.param("helperId"))))
      ? c.json({ ok: true })
      : c.json({ error: "no such helper" }, 404),
  );

  /* Running a helper *is* opening a terminal on it. The route answers with the
     `TerminalInfo` the browser then attaches a panel to, exactly as a plain
     new terminal does — so a helper gets the terminal's whole chrome (a PTY it
     can be answered through, scrollback, search, detach and reattach) instead
     of a captured-output dialog that could never answer a prompt.

     The command, the directory and the environment are read from the row here
     rather than sent up: they are the *stored* definition, and a client that
     could post its own would have turned a helper into an arbitrary-exec
     endpoint wearing a helper's name. */
  app.post("/api/projects/:id/helpers/:helperId/terminal", async (c) => {
    const id = c.req.param("id");
    const helper = await getHelper(id, c.req.param("helperId"));
    if (!helper) return c.json({ error: "no such helper" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const { cols, rows } = body as { cols?: number; rows?: number };
    return workspace(c, async () =>
      await createTerminal(id, {
        title: helper.name,
        command: helper.command,
        cwd: helper.cwd,
        env: helper.env ?? undefined,
        cols,
        rows,
      }),
    );
  });

  /* The project overview's numbers — the half the browser cannot derive from
     its own session list (turns, activity, what the project has learned). One
     route, because a page that asked six would redraw six times. */
  app.get("/api/projects/:id/stats", (c) => workspace(c, async () => await projectStats(c.req.param("id"))));

  /* The preview probe — `url` is the stored address, `up` is whether it
     answers from the server's own machine. The panel polls this while it is
     open: it is what turns "Start the dev server" into "the preview is up",
     with no CORS and no reading inside a plain iframe. */
  app.get("/api/projects/:id/preview", (c) =>
    workspace(c, async () => {
      const project = await getProject(c.req.param("id"));
      if (!project) throw new WorkspaceError("no such project", 404);
      const url = project.previewUrl ?? "";
      return { url, up: url ? await probePreview(url) : false };
    }),
  );

  /* The same probe, for an address the panel was *given* rather than one the
     project stores. The Browser panel's frame is sandboxed and cross-origin, so
     it cannot tell a refused connection (a port nobody is on) from a page that
     drew — both fire `load`. The one thing that can is a fetch from this side,
     so "nothing is answering" is measured rather than guessed. `up` is false
     only for an address that was actually tried and failed; a malformed one is
     the client's own to reject before it is ever framed. */
  app.get("/api/preview", async (c) =>
    c.json({ up: await probePreview(c.req.query("url") ?? "") }),
  );

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
    workspace(c, async () =>
      await listDir(c.req.param("projectId"), c.req.query("path"), {
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
    workspace(c, async () => {
      const limit = Number(c.req.query("limit"));
      return await searchEntries(c.req.param("projectId"), c.req.query("q"), {
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      });
    }),
  );

  /* Content search, for the IDE's "match file contents too" mode. A third
     question again — the name search answers "where is it", this one answers
     "where is it written" — and it reads bytes, so it is its own route rather
     than a flag on the one above. */
  app.get("/api/projects/:projectId/files/grep", (c) =>
    workspace(c, async () => {
      const limit = Number(c.req.query("limit"));
      return await searchContents(c.req.param("projectId"), c.req.query("q"), {
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
    workspace(c, async () => await statFile(c.req.param("projectId"), c.req.query("path") ?? "")),
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
    return workspace(c, async () => await createEntry(c.req.param("projectId"), body.path as string, type));
  });

  app.patch("/api/projects/:projectId/files", async (c) => {
    const body = (await c.req.json()) as { from?: unknown; to?: unknown };
    if (typeof body.from !== "string" || typeof body.to !== "string")
      return c.json({ error: "from and to are required" }, 400);
    return workspace(c, async () =>
      await renameEntry(c.req.param("projectId"), body.from as string, body.to as string),
    );
  });

  app.delete("/api/projects/:projectId/files", async (c) => {
    const body = (await c.req.json()) as { path?: unknown };
    if (typeof body.path !== "string") return c.json({ error: "path is required" }, 400);
    return workspace(c, async () => await deleteEntry(c.req.param("projectId"), body.path as string));
  });

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

  app.get("/api/projects/:projectId/git/log", (c) => {
    const limit = Number(c.req.query("limit"));
    return workspace(c, () =>
      git.log(c.req.param("projectId"), {
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        repo: c.req.query("repo"),
      }),
    );
  });

  app.get("/api/projects/:projectId/git/commit", (c) =>
    workspace(c, () =>
      git.commitDetail(c.req.param("projectId"), c.req.query("hash") ?? "", c.req.query("repo")),
    ),
  );

  app.get("/api/projects/:projectId/git/file", (c) => {
    const comparison = c.req.query("comparison");
    const side: git.Comparison =
      comparison === "staged" ? "staged" : comparison === "worktree" ? "worktree" : "head";
    /* No `?repo=`: the path is project-relative and names exactly one
       worktree, so the server derives it. */
    const rev = c.req.query("rev");
    return workspace(c, () =>
      git.fileAt(c.req.param("projectId"), c.req.query("path") ?? "", rev ? { rev } : side),
    );
  });

  /* Draft a commit message. A read route on the git prefix but a *write* to a
     model, so it is a POST, and it names the profile that pays for it — the
     same bargain the composer's enhancer makes, for the same reason: the key
     never leaves the server (`enhance.ts`). The diff is gathered here rather
     than sent up; see `git.commitMessagePrompt`. */
  const DraftMessageSchema = z.object({
    profileId: z.string(),
    model: z.string().optional(),
    repo: z.string().optional(),
    /* The same diff, asked a different question: a commit message or a branch
       name (`enhance.ts` holds both house styles). One route, because
       everything around the model call — the profile, the agent check, the
       gathering — is identical. */
    kind: z.enum(["commit", "branch"]).optional(),
    /* What is already in the commit box. Present means "sharpen this", absent
       means "write one" — the same route either way, because the gathering and
       the model call are identical and only a section of the prompt differs
       (`git.commitMessagePrompt`). Ignored for a branch name. */
    draft: z.string().optional(),
  });

  app.post("/api/projects/:projectId/git/draft-message", async (c) => {
    const parsed = DraftMessageSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "profileId is required" }, 400);
    const profile = await getProfile(parsed.data.profileId);
    if (!profile) return c.json({ error: "unknown profile" }, 404);
    /* The agent only decides which per-agent base URL is NOT used, so a profile
       serving several is as usable here as one serving a single runtime and
       naming none is not an error — see `profileHasAgent`. What is still
       refused: a profile with nothing known behind it, which must not be
       silently offered a draft. */
    if (!await profileHasAgent(profile)) {
      return c.json({ error: "unknown agent for this profile" }, 404);
    }
    const kind = parsed.data.kind ?? "commit";
    return workspace(c, async () => {
      const { prompt, files, staged } = await git.commitMessagePrompt(
        c.req.param("projectId"),
        parsed.data.repo,
        kind,
        parsed.data.draft,
      );
      const answer = await enhancePrompt(profile, {
        text: prompt,
        model: parsed.data.model || undefined,
        kind,
      });
      /* A branch name is handed to `checkout -b` as typed, so the one thing a
         chatty model can add — a code fence, quotes, a trailing sentence — is
         taken back off here. Nothing is *rewritten*: what is left is the first
         line the model wrote, and a name that is still invalid fails at git
         with git's own message rather than being guessed at. */
      const message =
        kind === "branch"
          ? (answer.split("\n").find((line) => line.trim()) ?? "").trim().replace(/^[`'"]+|[`'"]+$/g, "")
          : answer;
      return { message, files: files.length, staged };
    });
  });

  app.post("/api/projects/:projectId/git/:action", async (c) => {
    const projectId = c.req.param("projectId");
    const action = c.req.param("action");
    const body = (await c.req.json().catch(() => ({}))) as {
      paths?: unknown;
      message?: unknown;
      branch?: unknown;
      create?: unknown;
      track?: unknown;
      amend?: unknown;
      repo?: unknown;
      patch?: unknown;
      cached?: unknown;
      reverse?: unknown;
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
      /* One hunk, cut out of a diff by the review panel: `cached` stages it,
         `reverse` (without `cached`) discards it from the worktree. */
      case "apply":
        return workspace(c, async () => {
          await git.applyPatch(projectId, String(body.patch ?? ""), {
            cached: body.cached === true,
            reverse: body.reverse === true,
            repo,
          });
          return git.status(projectId, repo);
        });
      /* The two that leave the machine. They answer `{output, status}` like a
         commit does, because what the remote said is most of the answer — "Already
         up to date", a rejected non-fast-forward, the URL a branch was published
         to — and the status behind it is what repaints the ahead/behind. */
      case "pull":
      case "push":
      case "fetch":
        return workspace(c, async () => {
          const result = await git.sync(projectId, action, repo);
          return { ...result, status: await git.status(projectId, repo) };
        });
      case "undo":
        return workspace(c, async () => {
          const result = await git.undoCommit(projectId, repo);
          return { ...result, status: await git.status(projectId, repo) };
        });
      case "checkout":
        return workspace(c, async () => {
          await git.checkout(projectId, String(body.branch ?? ""), {
            create: body.create === true,
            track: body.track === true,
            repo,
          });
          return git.status(projectId, repo);
        });
      default:
        return c.json({ error: `unknown git action: ${action}` }, 404);
    }
  });

  /* Stash: the working set's parking spot. `stash` answers the new status (the
     way stage/unstage do) so the panel repaints; the rest answer only the status
     after the operation. `index` is the numeric `stash@{n}`, never a message, so
     it can never be read as a ref or pathspec. */
  app.get("/api/projects/:projectId/git/stashes", (c) =>
    workspace(c, () => git.stashList(c.req.param("projectId"), c.req.query("repo"))),
  );

  app.post("/api/projects/:projectId/git/stash", async (c) => {
    const projectId = c.req.param("projectId");
    const body = (await c.req.json().catch(() => ({}))) as { message?: unknown; repo?: unknown };
    const repo = typeof body.repo === "string" ? body.repo : undefined;
    return workspace(c, async () => {
      const { created } = await git.stashPush(projectId, {
        message: typeof body.message === "string" ? body.message : undefined,
        repo,
      });
      return { created, status: await git.status(projectId, repo) };
    });
  });

  /* apply / pop / drop are one shape: a stash index and what to do with it.
     `verb` is matched against a closed map rather than interpolated, so the
     path segment can never name a git subcommand of its own. */
  const STASH_VERBS = {
    apply: git.stashApply,
    pop: git.stashPop,
    drop: git.stashDrop,
  } as const;

  app.post("/api/projects/:projectId/git/stash/:verb", async (c) => {
    const projectId = c.req.param("projectId");
    const verb = c.req.param("verb");
    const action = Object.hasOwn(STASH_VERBS, verb)
      ? STASH_VERBS[verb as keyof typeof STASH_VERBS]
      : null;
    if (!action) return c.json({ error: `unknown stash action: ${verb}` }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { index?: unknown; repo?: unknown };
    const repo = typeof body.repo === "string" ? body.repo : undefined;
    const index = body.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0)
      return c.json({ error: "stash index must be a non-negative integer" }, 400);
    return workspace(c, async () => {
      await action(projectId, index, repo);
      return git.status(projectId, repo);
    });
  });

  /* Terminals. The list and the lifecycle are ordinary JSON routes; the bytes go
     over their own WebSocket (see the upgrade handler in index.ts) because a
     PTY stream has nothing to do with the thread protocol's journal and replay. */
  app.get("/api/projects/:projectId/terminals", (c) =>
    workspace(c, () => listTerminals(c.req.param("projectId"))),
  );

  app.post("/api/projects/:projectId/terminals", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    /* `cwd` is a thread's worktree (project-relative, clamped inside the project
       by `containedPath`) and `sessionId` ties the shell's life to that thread. */
    const { title, cols, rows, cwd, sessionId } = body as {
      title?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      sessionId?: string;
    };
    return workspace(c, async () =>
      await createTerminal(c.req.param("projectId"), {
        title,
        cols,
        rows,
        cwd: typeof cwd === "string" ? cwd : null,
        sessionId: typeof sessionId === "string" ? sessionId : null,
      }),
    );
  });

  app.delete("/api/projects/:projectId/terminals/:terminalId", (c) =>
    killTerminal(c.req.param("terminalId"))
      ? c.json({ ok: true })
      : c.json({ error: "no such terminal" }, 404),
  );

  /* File events as an NDJSON stream rather than SSE: EventSource cannot set an
     Authorization header, and the alternative is the bearer token in a URL — in
     history, in logs, in whatever proxy is in front. `fetch` reads this fine. */
  app.get("/api/projects/:projectId/watch", async (c) => {
    const projectId = c.req.param("projectId");
    /* Validate before streaming, not inside it: once `stream()` has taken the
       response there is no status left to send, so an unknown project would have
       been a 200 that immediately ends rather than the 404 it is. */
    try {
      await projectRoot(projectId);
    } catch (err) {
      if (err instanceof WorkspaceError) return c.json({ error: err.message }, err.status);
      throw err;
    }

    return stream(c, async (s) => {
      c.header("Content-Type", "application/x-ndjson");
      c.header("Cache-Control", "no-store");
      const queue: WatchBatch[] = [];
      const wake = { fn: null as (() => void) | null };
      const off = await watchProject(projectId, (batch) => {
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
