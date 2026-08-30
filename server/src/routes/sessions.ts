import type { Hono } from "hono";
import { getAgent } from "../registry.js";
import { getProfile, profileSupports, resolveProfileAgent } from "../profiles.js";
import { getProject } from "../projects.js";
import type { SessionManager } from "../sessions.js";

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
      configChoices,
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
    });
    /* Wait for the handshake. A 201 therefore means the agent has answered
       session/new, its settings have been applied, and the first `session_config`
       is already in the log — so the socket the client opens next inherits a
       thread that is genuinely ready rather than one still booting. */
    await session.bridge!.ready;
    return c.json({ id: session.id }, 201);
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

  // What the agent process has been printing. The client shows this when a thread
  // fails in a way ACP won't explain — the agent's own stack trace is the answer
  // and it never travels over the protocol.
  app.get("/api/sessions/:id/stderr", (c) => {
    const session = sessions.get(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    return c.json({ lines: sessions.stderrTail(session.id) });
  });

  // Delete is reversible by default: the process dies, the thread stays in the
  // list marked deleted. `?purge=1` is the irreversible one.
  app.delete("/api/sessions/:id", (c) => {
    const purge = c.req.query("purge") === "1";
    const ok = purge ? sessions.purge(c.req.param("id")) : sessions.softDelete(c.req.param("id"));
    return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  app.post("/api/sessions/:id/restore", (c) =>
    sessions.restore(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404),
  );
}
