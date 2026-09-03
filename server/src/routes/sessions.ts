import type { Hono } from "hono";
import { getAgent } from "../registry.js";
import { getProfile, profileSupports, resolveProfileAgent } from "../profiles.js";
import { getProject } from "../projects.js";
import { listAgentSessions } from "../session-list.js";
import type { SessionManager } from "../sessions.js";
import type { Scope } from "../turn-changes.js";
import { workspace } from "./helpers.js";

const UUID_RE =/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Threads: list, create, respawn/revive, stderr, delete/restore. */
export function sessionRoutes(app: Hono, deps: { sessions: SessionManager }): void {
  const { sessions } = deps;

  /* Live threads by default; `?deleted=1` includes the trash (what the client's
     sidebar asks for, since its Trash section renders from the same list). */
  app.get("/api/sessions", (c) => {
    const list = sessions.list();
    return c.json(c.req.query("deleted") === "1" ? list : list.filter((s) => s.deletedAt === null));
  });

  app.post("/api/sessions", async (c) => {
    const {
      id,
      profileId,
      agentId: askedAgent,
      projectId,
      model,
      effort,
      personaId,
      configChoices,
      title,
      mcpServerIds,
      skillIds,
      commandIds,
    } = await c.req.json();
    const profile = getProfile(profileId);
    if (!profile) return c.json({ error: "unknown profile" }, 404);
    // The thread is a (profile, agent) pair. `agentId` may be left out only when
    // the profile names one agent — the virtual Default, or an older client. A
    // virtual profile is resolved from its id, so an id naming an agent that
    // does not exist would otherwise reach spawn and fail there instead.
    const agentId = resolveProfileAgent(profile, askedAgent);
    if (!agentId || !getAgent(agentId)) {
      return c.json({ error: "unknown agent for this profile" }, 404);
    }
    const project = getProject(projectId);
    if (!project) return c.json({ error: "unknown project" }, 404);
    // The client mints the id so it can route to the thread before this call is
    // made. Anything it sends still has to be a UUID and still has to be free —
    // taking a live session's id would hand the caller someone else's agent.
    if (id !== undefined) {
      if (typeof id !== "string" || !UUID_RE.test(id)) {
        return c.json({ error: "id must be a UUID" }, 400);
      }
      if (sessions.get(id)) return c.json({ error: "session already exists" }, 409);
    }
    // The thread's own picks, on top of the project's and the profile's. Stale
    // ids link nothing (db/links.ts), so nothing here has to be validated.
    const ids = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    const session = sessions.create(profile, agentId, project, model, effort, id, configChoices, {
      mcpServerIds: ids(mcpServerIds),
      skillIds: ids(skillIds),
      commandIds: ids(commandIds),
    }, {
      // Not validated: a persona id naming a row that is gone resolves to no
      // persona at spawn, which is what "gone" should mean — see
      // `resolvePersonaSpawn` and the schema's note on the missing foreign key.
      personaId: typeof personaId === "string" ? personaId : undefined,
      /* A draft can be renamed before it has ever been sent to, and that name
         has to survive becoming a real thread — `create` keeps it and the
         first-prompt sniff then leaves it alone. */
      title: typeof title === "string" && title.trim() ? title.trim() : undefined,
    });
    /* Wait for the handshake. A 201 therefore means the agent has answered
       session/new, its settings have been applied, and the first `session_config`
       is already in the log — so the socket the client opens next inherits a
       thread that is genuinely ready rather than one still booting. */
    await session.bridge!.ready;
    return c.json({ id: session.id }, 201);
  });

  /**
   * What this runtime already has that the harness does not: the agent's own
   * `session/list`, spawned for the question and killed after it.
   *
   * POST rather than GET because it starts a process, which is the precedent
   * `POST /api/profiles/:id/options` set. `projectId` supplies only the cwd to
   * spawn *in* — the listing itself is machine-wide, and each session carries
   * the cwd it ran in so the client can group by project.
   */
  app.post("/api/sessions/importable", async (c) => {
    const { profileId, agentId: askedAgent, projectId } = await c.req.json();
    const profile = getProfile(profileId);
    if (!profile) return c.json({ error: "unknown profile" }, 404);
    const agentId = resolveProfileAgent(profile, askedAgent);
    if (!agentId || !getAgent(agentId)) {
      return c.json({ error: "unknown agent for this profile" }, 404);
    }
    const project = getProject(projectId);
    if (!project) return c.json({ error: "unknown project" }, 404);
    return c.json(await listAgentSessions(profile, agentId, project));
  });

  /**
   * Adopt those conversations as threads. One round trip however many are
   * picked: an import writes rows and spawns nothing (see
   * `SessionManager.importSession`), and opening one is what loads it.
   *
   * Each row carries its own `projectId` because the dialog groups by the cwd
   * the conversation ran in, and one import may span several projects.
   */
  app.post("/api/sessions/import", async (c) => {
    const {
      profileId,
      agentId: askedAgent,
      sessions: asked,
      mcpServerIds,
      skillIds,
      commandIds,
    } = await c.req.json();
    const profile = getProfile(profileId);
    if (!profile) return c.json({ error: "unknown profile" }, 404);
    const agentId = resolveProfileAgent(profile, askedAgent);
    if (!agentId || !getAgent(agentId)) {
      return c.json({ error: "unknown agent for this profile" }, 404);
    }
    if (!Array.isArray(asked) || asked.length === 0) {
      return c.json({ error: "no sessions to import" }, 400);
    }
    const ids = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    const links = {
      mcpServerIds: ids(mcpServerIds),
      skillIds: ids(skillIds),
      commandIds: ids(commandIds),
    };
    // Every thread already here, by the conversation it points at — what makes
    // a second import of the same session a skip rather than a duplicate.
    const taken = new Map(
      sessions
        .list()
        .filter((s) => s.acpSessionId)
        .map((s) => [s.acpSessionId as string, s.id]),
    );
    const created: { id: string; acpSessionId: string }[] = [];
    const skipped: { acpSessionId: string; reason: string }[] = [];
    for (const entry of asked) {
      const acpSessionId = typeof entry?.acpSessionId === "string" ? entry.acpSessionId : "";
      if (!acpSessionId) {
        skipped.push({ acpSessionId: String(entry?.acpSessionId ?? ""), reason: "no session id" });
        continue;
      }
      const existing = taken.get(acpSessionId);
      if (existing) {
        skipped.push({ acpSessionId, reason: "already imported" });
        continue;
      }
      const project = getProject(entry?.projectId);
      if (!project) {
        skipped.push({ acpSessionId, reason: "unknown project" });
        continue;
      }
      const session = sessions.importSession(
        profile,
        agentId,
        project,
        { acpSessionId, title: entry?.title ?? null, updatedAt: entry?.updatedAt ?? null },
        links,
      );
      taken.set(acpSessionId, session.id);
      created.push({ id: session.id, acpSessionId });
    }
    return c.json({ created, skipped }, created.length ? 201 : 200);
  });

  /**
   * Swap the agent process — a new profile, model or effort — and put the
   * conversation back. Also the revive path for a thread whose process is gone.
   *
   * This answers once the thread is usable: the server has spawned, handshaken,
   * replayed the conversation through session/load and restored the settings the
   * restart reset. It used to be three round trips the browser drove, which meant
   * a tab closing halfway through left a half-restored thread.
   */
  app.post("/api/sessions/:id/respawn", async (c) => {
    const session = sessions.get(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    // A deleted thread can only come back through restore; answering the respawn
    // attempt as a 4xx keeps a stale client's retry from reading as a server
    // fault in the logs.
    if (session.deletedAt !== null) return c.json({ error: "session deleted" }, 409);
    const { profileId, agentId: askedAgent, model, effort } = await c.req.json();
    const profile = getProfile(profileId ?? session.profileId);
    if (!profile) return c.json({ error: "unknown profile" }, 404);
    // The agent stays what it was unless the caller says otherwise — a profile
    // change is new credentials, not a new runtime — and whichever it is, the
    // profile has to be configured for it.
    const agentId = askedAgent ?? session.agentId;
    if (!profileSupports(profile, agentId) || !getAgent(agentId)) {
      return c.json({ error: "unknown agent for this profile" }, 404);
    }
    const project = getProject(session.projectId);
    if (!project) return c.json({ error: "unknown project" }, 404);
    await sessions.respawn(session.id, profile, agentId, project, model, effort);
    return c.json({
      ok: true,
      acpSessionId: session.liveAcpSessionId ?? session.acpSessionId,
      // The load was refused and this thread came up empty. The caller has just
      // been told the respawn succeeded, which on its own reads as "your history
      // is back" — it isn't, and the transcript it points at may still be
      // recoverable, so say which id could not be loaded.
      ...(session.historyLost ? { historyLost: session.historyLost } : {}),
    });
  });

  /**
   * Change this thread's profile, model, effort or persona — the *first* thing
   * a client asks for all four, because it is the only side that can tell
   * whether a restart is needed.
   *
   * A live change answers `{live: true}` and every socket stays exactly where
   * it was; one that could not be made live falls through to the same respawn
   * the route below performs and answers `{live: false}`, which is the caller's
   * signal that the event log was cleared and it has to reattach. The decision
   * itself is `SessionManager.applyConfig`, and it belongs there rather than
   * here for the reason the respawn route already documents: split across two
   * round trips, a tab closing in the middle leaves a half-moved thread.
   */
  app.post("/api/sessions/:id/config", async (c) => {
    const session = sessions.get(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    if (session.deletedAt !== null) return c.json({ error: "session deleted" }, 409);
    const { profileId, agentId: askedAgent, model, effort, personaId } = await c.req.json();
    const profile = getProfile(profileId ?? session.profileId);
    if (!profile) return c.json({ error: "unknown profile" }, 404);
    const agentId = askedAgent ?? session.agentId;
    if (!profileSupports(profile, agentId) || !getAgent(agentId)) {
      return c.json({ error: "unknown agent for this profile" }, 404);
    }
    const project = getProject(session.projectId);
    if (!project) return c.json({ error: "unknown project" }, 404);
    const { live } = await sessions.applyConfig(session.id, {
      profile,
      agentId,
      project,
      model,
      effort,
      // Omitted means unchanged; "" is a real value and means no persona.
      personaId: typeof personaId === "string" ? personaId : undefined,
    });
    return c.json({
      ok: true,
      live,
      // What the thread ended up on: a cleared model resolves to the profile's
      // default here, not in the client.
      profileId: session.profileId,
      model: session.model,
      effort: session.effort,
      personaId: session.personaId,
      acpSessionId: session.liveAcpSessionId ?? session.acpSessionId,
      ...(session.historyLost ? { historyLost: session.historyLost } : {}),
    });
  });

  /* Roll the thread back to before a turn — the conversation forked at the
     boundary (where the runtime can), the files restored to the turn's own
     tree (where git can), either or both by `scope`. Like `/config`, one call
     does the whole job: fork, restore, respawn and journal clear happen
     server-side, because split across round trips a tab closing in the middle
     would leave a half-rewound thread. The journal ends up cleared and
     refilled from the fork, so the caller reattaches from 0 exactly as it
     does after a non-live config change. Refusals are HttpErrors with their
     statuses (`SessionManager.rewind`), which app.onError shapes. */
  app.post("/api/sessions/:id/rewind", async (c) => {
    const session = sessions.get(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    if (session.deletedAt !== null) return c.json({ error: "session deleted" }, 409);
    const { turnId, scope } = await c.req.json().catch(() => ({}));
    if (typeof turnId !== "string" || !turnId) return c.json({ error: "turnId is required" }, 400);
    if (scope !== "conversation" && scope !== "files" && scope !== "both") {
      return c.json({ error: "scope must be conversation, files, or both" }, 400);
    }
    return c.json(await sessions.rewind(session.id, turnId, scope));
  });

  /* The transcript, read over HTTP.

     Opening a thread is a read, and a read does not need a socket: this is the
     same `attached` / `replay` frames / `caught_up` bracket the WebSocket
     attach sends, as one document, so the client folds it through the very same
     dispatch and there is still one parser (see `SessionSocket.snapshot`). The
     socket that follows resumes from `caughtUp.cursor` — a delta — and an
     archived thread opens no socket at all.

     Streamed rather than assembled: the frames come out of the journal
     pre-serialized and are spliced straight into the body, so a long thread is
     never held whole in this process. A refusal is decided before the first
     chunk, which is what lets it still be a status code. */
  app.get("/api/sessions/:id/replay", (c) => {
    const cursor = Number(c.req.query("cursor") ?? 0);
    const window = Number(c.req.query("window") ?? 0);
    const result = sessions.snapshot(c.req.param("id"), Number.isFinite(cursor) ? cursor : 0, {
      window: Number.isFinite(window) ? window : 0,
    });
    if ("refused" in result) {
      // "no such thread" is the only one of the three that is a missing row;
      // the other two are a thread that exists and cannot be read this way.
      const missing = result.refused.startsWith("no such thread");
      return c.json({ error: result.refused }, missing ? 404 : 409);
    }
    const body = result.body;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = body.next();
        if (next.done) controller.close();
        else controller.enqueue(new TextEncoder().encode(next.value));
      },
      cancel() {
        // The reader went away mid-body; stop paging SQLite for it.
        body.return(undefined as never);
      },
    });
    return c.body(stream, 200, { "content-type": "application/json; charset=utf-8" });
  });

  /* One page of history before `before`, the HTTP half of the socket's
     `load_earlier`. Paging back is a read of the journal — an archived thread
     is where it mostly happens — so it must not cost a socket any more than it
     costs a spawn. */
  app.get("/api/sessions/:id/earlier", (c) => {
    const before = Number(c.req.query("before") ?? 0);
    if (!Number.isFinite(before)) return c.json({ error: "before must be a number" }, 400);
    const page = sessions.earlierPage(c.req.param("id"), before);
    return page ? c.json(page) : c.json({ error: "not found" }, 404);
  });

  // What the agent process has been printing. The client shows this when a thread
  // fails in a way ACP won't explain — the agent's own stack trace is the answer
  // and it never travels over the protocol.
  app.get("/api/sessions/:id/stderr", (c) => {
    const session = sessions.get(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    return c.json({ lines: sessions.stderrTail(session.id) });
  });

  /* What each turn did to the worktree (turn-changes.ts). The list is the
     per-turn summary the transcript chips draw; `files` and `patch` read a
     scope live — a finished turn's two trees, a running turn's start tree
     against the disk, or `uncommitted` for HEAD against the disk. Staging,
     discarding and committing go through the project's git routes: the
     review panel is a view over one repository, and those already exist. */
  app.get("/api/sessions/:id/changes", (c) => {
    const id = c.req.param("id");
    if (!sessions.get(id)) return c.json({ error: "not found" }, 404);
    return c.json({ turns: sessions.turnChanges.list(id) });
  });

  const scopeOf = (raw: string | undefined): Scope | null => {
    if (!raw || raw === "uncommitted") return { kind: "uncommitted" };
    if (raw.startsWith("turn:") && raw.length > 5) return { kind: "turn", turnId: raw.slice(5) };
    return null;
  };

  app.get("/api/sessions/:id/changes/files", (c) => {
    const id = c.req.param("id");
    if (!sessions.get(id)) return c.json({ error: "not found" }, 404);
    const scope = scopeOf(c.req.query("scope"));
    if (!scope) return c.json({ error: "scope must be `uncommitted` or `turn:<id>`" }, 400);
    return workspace(c, () => sessions.turnChanges.files(id, scope));
  });

  app.get("/api/sessions/:id/changes/patch", (c) => {
    const id = c.req.param("id");
    if (!sessions.get(id)) return c.json({ error: "not found" }, 404);
    const scope = scopeOf(c.req.query("scope"));
    if (!scope) return c.json({ error: "scope must be `uncommitted` or `turn:<id>`" }, 400);
    const path = c.req.query("path") || undefined;
    return workspace(c, () => sessions.turnChanges.patch(id, scope, path));
  });

  // Delete is reversible by default: the process dies, the thread stays in the
  // list marked deleted. `?purge=1` is the irreversible one.
  app.delete("/api/sessions/:id", (c) => {
    const purge = c.req.query("purge") === "1";
    const ok = purge ? sessions.purge(c.req.param("id")) : sessions.softDelete(c.req.param("id"));
    return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  /* Rename. PATCH because it edits one field of the thread and leaves the
     process, the transcript and everything else exactly as they were — it is
     answered with no bridge, like the queue edits, so naming an archived
     thread does not cost a spawn. */
  /* One file at one side of a scope — the IDE's diff editor reads both sides
     whole rather than a patch, since VS Code draws its own diff. */
  app.get("/api/sessions/:id/changes/file", (c) => {
    const id = c.req.param("id");
    if (!sessions.get(id)) return c.json({ error: "not found" }, 404);
    const scope = scopeOf(c.req.query("scope"));
    if (!scope) return c.json({ error: "scope must be `uncommitted` or `turn:<id>`" }, 400);
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path is required" }, 400);
    const side = c.req.query("side") === "before" ? "before" : "after";
    return workspace(c, () => sessions.turnChanges.file(id, scope, path, side));
  });

  app.patch("/api/sessions/:id", async (c) => {
    const { title } = await c.req.json();
    if (typeof title !== "string") return c.json({ error: "title must be a string" }, 400);
    if (!sessions.get(c.req.param("id"))) return c.json({ error: "not found" }, 404);
    const named = sessions.rename(c.req.param("id"), title);
    // The row exists, so the only way back is an empty name — which is a bad
    // request, not a missing thread.
    if (named === null) return c.json({ error: "title must not be empty" }, 400);
    return c.json({ title: named });
  });

  app.post("/api/sessions/:id/restore", (c) =>
    sessions.restore(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404),
  );
}
