import type { Hono } from "hono";
import { z } from "zod";
import { enhancePrompt } from "../enhance.js";
import { getAgent } from "../registry.js";
import { getProfile, profileSupports, resolveProfileAgent } from "../profiles.js";
import { getProject } from "../projects.js";
import { listAgentSessions } from "../session-list.js";
import type { SessionManager } from "../sessions.js";
import { TRACE_PAGE_LIMIT } from "../protocol.js";
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
      modeId,
      personaId,
      suggestFollowups,
      configChoices,
      title,
      mcpServerIds,
      skillIds,
      commandIds,
    } = await c.req.json();
    const profile = await getProfile(profileId);
    if (!profile) return c.json({ error: "unknown profile" }, 404);
    // The thread is a (profile, agent) pair. `agentId` may be left out only when
    // the profile names one agent — the virtual Default, or an older client. A
    // virtual profile is resolved from its id, so an id naming an agent that
    // does not exist would otherwise reach spawn and fail there instead.
    const agentId = resolveProfileAgent(profile, askedAgent);
    if (!agentId || !await getAgent(agentId)) {
      return c.json({ error: "unknown agent for this profile" }, 404);
    }
    const project = await getProject(projectId);
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
    const session = await sessions.create(profile, agentId, project, model, effort, id, configChoices, {
      mcpServerIds: ids(mcpServerIds),
      skillIds: ids(skillIds),
      commandIds: ids(commandIds),
    }, {
      // Not validated: a persona id naming a row that is gone resolves to no
      // persona at spawn, which is what "gone" should mean — see
      // `resolvePersonaSpawn` and the schema's note on the missing foreign key.
      personaId: typeof personaId === "string" ? personaId : undefined,
      // Omitted reads as off — a draft that never asked is a thread that
      // never asked, the same default the row carries.
      suggestFollowups: typeof suggestFollowups === "boolean" ? suggestFollowups : undefined,
      // The draft's permission mode, picked against the agent's probed `modes`.
      // Best-effort like the config choices: a mode the agent does not offer
      // costs the pick, not the thread. The bridge guards on the agent's own
      // mode list, so this needs no per-agent knowledge here.
      modeId: typeof modeId === "string" && modeId ? modeId : undefined,
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
    const profile = await getProfile(profileId);
    if (!profile) return c.json({ error: "unknown profile" }, 404);
    const agentId = resolveProfileAgent(profile, askedAgent);
    if (!agentId || !await getAgent(agentId)) {
      return c.json({ error: "unknown agent for this profile" }, 404);
    }
    const project = await getProject(projectId);
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
    const profile = await getProfile(profileId);
    if (!profile) return c.json({ error: "unknown profile" }, 404);
    const agentId = resolveProfileAgent(profile, askedAgent);
    if (!agentId || !await getAgent(agentId)) {
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
      const project = await getProject(entry?.projectId);
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
    const profile = await getProfile(profileId ?? session.profileId);
    if (!profile) return c.json({ error: "unknown profile" }, 404);
    // The agent stays what it was unless the caller says otherwise — a profile
    // change is new credentials, not a new runtime — and whichever it is, the
    // profile has to be configured for it.
    const agentId = askedAgent ?? session.agentId;
    if (!profileSupports(profile, agentId) || !await getAgent(agentId)) {
      return c.json({ error: "unknown agent for this profile" }, 404);
    }
    const project = await getProject(session.projectId);
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
   * Three answers, not two.
   *
   * A live change answers `{live: true}` and every socket stays exactly where
   * it was. One that costs the process while a turn is running is **staged** —
   * `{live: false, staged}` — and taken at that turn's own boundary, which is
   * the next moment the setting would be read anyway; `defer: false` is the
   * caller's "now, and never mind the turn". Anything else restarts, and
   * answers `{live: false, restarting: true}` *before* the restart rather than
   * after it: the decision is immediate, the spawn → `session/load` → restore
   * that follows is seconds, and holding the answer open across it left the
   * browser with a blocked request and every other device with nothing at all.
   * The `restart` event is what reports the rest, to every peer.
   *
   * `cancelStaged` drops a staged change without applying it. The decisions are
   * all `SessionManager.applyConfig`'s, and they belong there rather than here
   * for the reason the respawn route already documents: split across two round
   * trips, a tab closing in the middle leaves a half-moved thread.
   */
  app.post("/api/sessions/:id/config", async (c) => {
    const session = sessions.get(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    if (session.deletedAt !== null) return c.json({ error: "session deleted" }, 409);
    const body = await c.req.json();
    if (body.cancelStaged === true) {
      sessions.clearStaged(session);
      return c.json({ ok: true, live: false, staged: null });
    }
    /* The floor under "apply now": the staged change, for any field this body
       does not name. The client sends the staged patch back explicitly (it
       holds it — `staged_config` is absolute and reaches every peer), because a
       body always names model and effort and would otherwise overwrite the
       change it was asked to take. This is what answers a caller that does
       not. */
    const staged = body.defer === false ? (sessions.stagedRequest(session.id) ?? {}) : {};
    const { profileId, agentId: askedAgent, model, effort, personaId, suggestFollowups } = {
      ...staged,
      ...body,
    };
    const profile = await getProfile(profileId ?? session.profileId);
    if (!profile) return c.json({ error: "unknown profile" }, 404);
    const agentId = askedAgent ?? session.agentId;
    if (!profileSupports(profile, agentId) || !await getAgent(agentId)) {
      return c.json({ error: "unknown agent for this profile" }, 404);
    }
    const project = await getProject(session.projectId);
    if (!project) return c.json({ error: "unknown project" }, 404);
    const result = await sessions.applyConfig(
      session.id,
      {
        profile,
        agentId,
        project,
        model,
        effort,
        // Omitted means unchanged; "" is a real value and means no persona.
        personaId: typeof personaId === "string" ? personaId : undefined,
        // Omitted means unchanged; a boolean flips the suggestions trailer and
        // respawns, like a persona change.
        suggestFollowups: typeof suggestFollowups === "boolean" ? suggestFollowups : undefined,
      },
      {
        defer: body.defer === false ? false : undefined,
        /* The caller states whether it holds a socket on this thread. Only one
           that does can be answered before the restart has happened, because
           only one that does will hear how it went. */
        follow: body.follow === true,
      },
    );
    return c.json({
      ok: true,
      live: result.live,
      /* Held for the running turn's boundary rather than taken — the caller
         draws it as the value it is about to be on, and nothing has restarted.
         `staged_config` says the same thing to every other peer. */
      ...(result.staged ? { staged: result.staged } : {}),
      /* The process is being replaced *now*, and this answer did not wait for
         it: what happens next arrives as the `restart` event. */
      ...(result.restarting ? { restarting: true } : {}),
      /* What the thread ended up on — for a live change, which has already
         landed. A restart's own answer is the `spawn_config` it emits when the
         new process is up, and a staged change has not moved the row at all, so
         both leave these reading as they did before the call. */
      profileId: session.profileId,
      model: session.model,
      effort: session.effort,
      personaId: session.personaId,
      suggestFollowups: session.suggestFollowups,
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

  /* Branch a thread at a turn — the fork the rewind machinery already makes,
     taken as a new thread instead of in place. Same single-call rule as
     `/rewind` and `/config`: fork, spawn and load all happen server-side, so
     a tab closing mid-fork cannot leave a half-born branch. The parent is
     untouched (no journal clear, no reattach from 0); the 201's `id` is a
     thread the client opens the ordinary way. Refusals are HttpErrors with
     their statuses (`SessionManager.fork`). */
  app.post("/api/sessions/:id/fork", async (c) => {
    const session = sessions.get(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    if (session.deletedAt !== null) return c.json({ error: "session deleted" }, 409);
    const body = await c.req.json().catch(() => ({}));
    const { turnId, id, title } = body;
    if (typeof turnId !== "string" || !turnId) return c.json({ error: "turnId is required" }, 400);
    /* The client mints the branch's id so it can route to the thread before
       this call returns — the same bargain `POST /api/sessions` makes, with
       the same two rules: a UUID, and free. */
    if (id !== undefined) {
      if (typeof id !== "string" || !UUID_RE.test(id)) {
        return c.json({ error: "id must be a UUID" }, 400);
      }
      if (sessions.get(id)) return c.json({ error: "session already exists" }, 409);
    }
    if (title !== undefined && typeof title !== "string") {
      return c.json({ error: "title must be a string" }, 400);
    }
    const child = await sessions.fork(session.id, turnId, {
      ...(id === undefined ? {} : { id }),
      ...(typeof title === "string" && title.trim() ? { title: title.trim().slice(0, 200) } : {}),
    });
    return c.json({ id: child.id, acpSessionId: child.liveAcpSessionId ?? child.acpSessionId }, 201);
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
      async pull(controller) {
        const next = await body.next();
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
  app.get("/api/sessions/:id/earlier", async (c) => {
    const before = Number(c.req.query("before") ?? 0);
    if (!Number.isFinite(before)) return c.json({ error: "before must be a number" }, 400);
    const page = await sessions.earlierPage(c.req.param("id"), before);
    return page ? c.json(page) : c.json({ error: "not found" }, 404);
  });

  /* The journal as raw pages for the trace view: every journaled event with
     the wall-clock stamp the replay path never carried, paged backwards from
     the head of the log (`before` = the newest event's seq + 1; absent means
     "the newest page"). The newest page first, because that is where a problem
     usually is — an archive far longer than a screenful is opened at its tail,
     not walked from the beginning. Live-only events (permissions, the queue,
     quota) are deliberately not here: only the five journaled kinds are. */
  app.get("/api/sessions/:id/trace", async (c) => {
    const rawBefore = c.req.query("before");
    const before = rawBefore === undefined ? 0 : Number(rawBefore);
    if (!Number.isFinite(before)) return c.json({ error: "before must be a number" }, 400);
    const rawLimit = Number(c.req.query("limit") ?? TRACE_PAGE_LIMIT);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(1, Math.round(rawLimit)), TRACE_PAGE_LIMIT)
      : TRACE_PAGE_LIMIT;
    const page = await sessions.trace(c.req.param("id"), before, limit);
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
  app.get("/api/sessions/:id/changes", async (c) => {
    const id = c.req.param("id");
    if (!sessions.get(id)) return c.json({ error: "not found" }, 404);
    return c.json({ turns: await sessions.turnChanges.list(id) });
  });

  const scopeOf = (raw: string | undefined): Scope | null => {
    if (!raw || raw === "uncommitted") return { kind: "uncommitted" };
    if (raw.startsWith("turn:") && raw.length > 5) return { kind: "turn", turnId: raw.slice(5) };
    return null;
  };

  app.get("/api/sessions/:id/changes/files", async (c) => {
    const id = c.req.param("id");
    if (!sessions.get(id)) return c.json({ error: "not found" }, 404);
    const scope = scopeOf(c.req.query("scope"));
    if (!scope) return c.json({ error: "scope must be `uncommitted` or `turn:<id>`" }, 400);
    return await workspace(c, () => sessions.turnChanges.files(id, scope));
  });

  app.get("/api/sessions/:id/changes/patch", async (c) => {
    const id = c.req.param("id");
    if (!sessions.get(id)) return c.json({ error: "not found" }, 404);
    const scope = scopeOf(c.req.query("scope"));
    if (!scope) return c.json({ error: "scope must be `uncommitted` or `turn:<id>`" }, 400);
    const path = c.req.query("path") || undefined;
    return await workspace(c, () => sessions.turnChanges.patch(id, scope, path));
  });

  // Delete is reversible by default: the process dies, the thread stays in the
  // list marked deleted. `?purge=1` is the irreversible one.
  app.delete("/api/sessions/:id", async (c) => {
    const purge = c.req.query("purge") === "1";
    const ok = purge ? await sessions.purge(c.req.param("id")) : await sessions.softDelete(c.req.param("id"));
    return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  /* Rename. PATCH because it edits one field of the thread and leaves the
     process, the transcript and everything else exactly as they were — it is
     answered with no bridge, like the queue edits, so naming an archived
     thread does not cost a spawn. */
  /* One file at one side of a scope — the IDE's diff editor reads both sides
     whole rather than a patch, since VS Code draws its own diff. */
  app.get("/api/sessions/:id/changes/file", async (c) => {
    const id = c.req.param("id");
    if (!sessions.get(id)) return c.json({ error: "not found" }, 404);
    const scope = scopeOf(c.req.query("scope"));
    if (!scope) return c.json({ error: "scope must be `uncommitted` or `turn:<id>`" }, 400);
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path is required" }, 400);
    const side = c.req.query("side") === "before" ? "before" : "after";
    return await workspace(c, () => sessions.turnChanges.file(id, scope, path, side));
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

  /* Rewrite the composer's draft into a sharper prompt, using the thread's own
     profile credentials through the AI SDK (`enhance.ts`). Not a turn: nothing
     is journaled, queued or sent to the agent — the box is replaced, unsent,
     and the user edits or sends the rewrite. The model is the thread's current
     one, falling back to the profile's default (`enhancePrompt` resolves it);
     `profileId` overrides the thread's profile when the picker chose another
     provider for the rewrite. */
  const EnhanceSchema = z.object({
    text: z.string(),
    model: z.string().optional(),
    profileId: z.string().optional(),
  });

  app.post("/api/sessions/:id/enhance", async (c) => {
    const session = sessions.get(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    if (session.deletedAt !== null) return c.json({ error: "session deleted" }, 409);
    const parsed = EnhanceSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "text is required" }, 400);
    const profile = parsed.data.profileId ? await getProfile(parsed.data.profileId) : await getProfile(session.profileId);
    if (!profile) return c.json({ error: "unknown profile" }, 404);
    const agentId = session.agentId;
    if (!profileSupports(profile, agentId) || !await getAgent(agentId)) {
      return c.json({ error: "unknown agent for this profile" }, 404);
    }
    const enhanced = await enhancePrompt(profile, {
      text: parsed.data.text,
      model: parsed.data.model || session.model || undefined,
    });
    return c.json({ enhanced });
  });

  /* The same rewrite for a draft, which has no server row yet: the profile (and
     agent, and model) travel in the body instead of being read off a session.
     `profileId` is the rewrite's provider — the thread's own draft profile
     unless the picker chose another. */
  const DraftEnhanceSchema = z.object({
    text: z.string(),
    profileId: z.string(),
    agentId: z.string().optional(),
    model: z.string().optional(),
  });

  app.post("/api/enhance", async (c) => {
    const parsed = DraftEnhanceSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "text and profileId are required" }, 400);
    const profile = await getProfile(parsed.data.profileId);
    if (!profile) return c.json({ error: "unknown profile" }, 404);
    // The agent only decides which per-agent base URL is NOT used (see
    // `enhance.ts`): resolution still 404s when it names nothing usable, so a
    // profile that serves no installed runtime is not offered it silently.
    const agentId = resolveProfileAgent(profile, parsed.data.agentId);
    if (!agentId || !await getAgent(agentId)) {
      return c.json({ error: "unknown agent for this profile" }, 404);
    }
    const enhanced = await enhancePrompt(profile, {
      text: parsed.data.text,
      model: parsed.data.model || undefined,
    });
    return c.json({ enhanced });
  });
}
