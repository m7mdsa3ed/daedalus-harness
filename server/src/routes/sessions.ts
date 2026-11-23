import { HttpError } from "../http-error.js";
import { spliceStderr } from "../stderr-ring.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Hono } from "hono";
import { z } from "zod";
import { enhancePrompt } from "../enhance.js";
import { streamFormBuilder } from "../ai.js";
import { getAgent, profileHasAgent } from "../registry.js";
import { defaultProfileFor, getProfile, profileSupports, resolveProfileAgent } from "../profiles.js";
import { mcpServers, personas } from "../library.js";
import { getConfig } from "../config.js";
import { classifyGate, classifyPersona, personaLane } from "../persona-classify.js";
import { readPersonaDecision } from "../side-models.js";
import { getProject } from "../projects.js";
import { getTask } from "../tasks-board.js";
import { archiveFilterOf, listAgentSessions } from "../session-list.js";
import { listCalls } from "../model-calls/index.js";
import { threadCwd, type SessionManager } from "../sessions.js";
import * as git from "../git.js";
import { listHelpers } from "../project-helpers.js";
import { recordShellRun } from "../shell-history.js";
import { runShellLine } from "../shell.js";
import type { Scope } from "../turn-changes.js";
import { containedPath, projectRoot } from "../workspace-fs.js";
import { UUID_RE, workspace } from "./helpers.js";
import { normalizeSuggestKinds, normalizeUiGroups } from "../personas.js";

/** Which profile (and model) `ask_agent` uses, by agent id. */
const AskProfilesSchema = z.record(z.string(), z.object({ profileId: z.string().min(1), model: z.string().min(1).optional() }));

/* The sidebar's page size, and the ceiling a caller may ask for. A page is a
   screenful-and-then-some of threads; the top end is the most a single read of
   the list is allowed to cost, since every row carries live state. */
const PAGE_SIZE_DEFAULT = 40;
const PAGE_SIZE_MAX = 200;

/** A query number, clamped into range — `fallback` when absent or unparseable. */
function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/* The thread's role → model assignment (`docs/model-roles.md`): a role id and a
   profile model id (`""` = the session model). Shared by the create route and
   the config route, which both carry it as a spawn input. */
const helperModelsSchema = z.array(z.object({ role: z.string(), model: z.string() }));

/** Threads: list, create, respawn/revive, stderr, delete/restore. */
/** What `POST /api/sessions` answers: the thread, and — when the create carried
    the first message — the turn it started, or why it could not. */
type Created = { id: string; turnId?: string; promptError?: string };

/* A lost 201 is retried with the same client-minted id. Held a while past
   settling so the retry — or a second POST racing the first — gets the first
   one's answer rather than a 409 on a thread its own message created. */
const CREATE_MEMORY_MS = 10 * 60_000;

export function sessionRoutes(app: Hono, deps: { sessions: SessionManager }): void {
  const { sessions } = deps;
  const creating = new Map<string, Promise<Created>>();

  /* Live threads by default; `?deleted=1` includes the trash (what the client's
     sidebar asks for, since its Trash section renders from the same list).

     `?ids=a,b` answers just those rows, whatever their age. The sidebar reads a
     *page* of the list (the route below), so a tool or a reconnect that needs
     one thread's current row — a thread outside the loaded window — asks for it
     by name rather than pulling the whole list with it. */
  app.get("/api/sessions", (c) => {
    const list = sessions.list();
    const idsParam = c.req.query("ids");
    if (idsParam !== undefined) {
      const ids = new Set(idsParam.split(",").map((s) => s.trim()).filter(Boolean));
      return c.json(list.filter((s) => ids.has(s.id)));
    }
    return c.json(c.req.query("deleted") === "1" ? list : list.filter((s) => s.deletedAt === null));
  });

  /* ── One page of the sidebar's list ──
     The sidebar must not pull every thread the server has ever held just to
     draw its top few, so this answers a slice by activity — newest first, the
     order the sidebar sorts in — the count behind it, and the two sets a paged
     list can never leave to the window: every trashed thread (deleted rows are
     too old to ever fall in a recent page, and the Trash section draws from the
     same response) and every pinned thread (a pin is deliberate and is drawn
     wherever its age puts it). The client folds these back into one list and
     advances `offset` by `sessions.length`; `total` is over live rows only, so
     "load more" knows where the window ends. */
  app.get("/api/sessions/page", (c) => {
    const all = sessions.list();
    /* Paged over top-level threads only: a child (an ask, a workflow step) is
       drawn under its parent, so it rides along with whichever page or pin
       carries the parent (`children`) rather than taking a slot of its own. */
    const top = all
      .filter((s) => s.deletedAt === null && !s.parentSessionId)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    /* Hidden threads take no slot in the paged window: they ride along as a
       set of their own (`hidden`), the way the trash does, so the "Hidden"
       filter has every one of them however old and a long hidden tail never
       starves the default list. */
    const hidden = top.filter((s) => s.hiddenAt);
    const live = top.filter((s) => !s.hiddenAt);
    const trashed = all
      .filter((s) => s.deletedAt !== null)
      .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
    const pinned = live
      .filter((s) => s.pinnedAt)
      .sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0));
    const limit = clampInt(c.req.query("limit"), PAGE_SIZE_DEFAULT, 1, PAGE_SIZE_MAX);
    const offset = clampInt(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const page = live.slice(offset, offset + limit);
    const parents = new Set([...page, ...pinned, ...hidden].map((s) => s.id));
    return c.json({
      sessions: page,
      total: live.length,
      trashed,
      pinned,
      hidden,
      children: all.filter((s) => s.deletedAt === null && s.parentSessionId && parents.has(s.parentSessionId)),
    });
  });

  /* The branch and uncommitted line counts of every listed thread's checkout,
     for the sidebar. Read off the disk and never stored; threads sharing a cwd
     share one read (`git.summaryOf`). A thread with nothing to say is absent. */
  app.get("/api/sessions/git-summary", async (c) => {
    const entries = sessions
      .list()
      .filter((s) => s.deletedAt === null && !s.parentSessionId)
      .flatMap((s) => {
        const live = sessions.get(s.id);
        return live?.project ? [[s.id, threadCwd(live, live.project)] as const] : [];
      });
    const out: Record<string, git.DirSummary> = {};
    await Promise.all(
      entries.map(async ([id, cwd]) => {
        const summary = await git.summaryOf(cwd).catch(() => null);
        if (summary) out[id] = summary;
      }),
    );
    return c.json(out);
  });

  /* The cross-thread inbox: every question a live agent is blocked on. */
  app.get("/api/pending", (c) => c.json(sessions.pendingAll()));

  /* Answer one from that inbox. Permissions only — a form or a URL question
     is answered in its thread, where its fields are drawn. */
  app.post("/api/sessions/:id/pending/:requestId", async (c) => {
    const body = z.object({ optionId: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "optionId is required" }, 400);
    const result = sessions.answerPending(c.req.param("id"), c.req.param("requestId"), body.data.optionId);
    if (result === "gone") return c.json({ error: "already answered" }, 409);
    if (result === "bad") return c.json({ error: "not an option this request offered" }, 400);
    return c.json({ ok: true });
  });

  app.patch("/api/sessions/:id/links", async (c) => {
    const parsed = z.object({
      key: z.enum(["mcpServerIds", "skillIds", "commandIds"]),
      ids: z.array(z.string()),
    }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "key and ids are required" }, 400);
    const { key, ids } = parsed.data;
    const staged = sessions.stageLinks(c.req.param("id"), key, ids);
    return c.json({ ok: true, staged });
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
      suggestKinds,
      uiGroups,
      personaId,
      askProfiles,
      configChoices,
      helperModels: rawHelperModels,
      title,
      mcpServerIds,
      skillIds,
      commandIds,
      worktree,
      aside,
      taskId,
      prompt,
    } = await c.req.json();
    // The thread's own picks, on top of the project's and the profile's. Stale
    // ids link nothing (db/links.ts), so nothing here has to be validated.
    const ids = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    /* The draft's role → model assignment (`docs/model-roles.md`): a spawn input
       like model and effort, so it is written on the row at create. Absent reads
       as no helpers; a malformed one is refused rather than silently dropped. */
    const parsedHelpers = helperModelsSchema.safeParse(rawHelperModels ?? []);
    if (!parsedHelpers.success) {
      return c.json({ error: "helperModels must be an array of { role, model }" }, 400);
    }
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
      const pending = creating.get(id);
      if (pending) return c.json(await pending, 201);
      if (sessions.get(id)) return c.json({ error: "session already exists" }, 409);
    }
    /* A thread started on a task: the card has to exist, and the thread has to
       carry the harness MCP or its instructions would name tools it cannot
       call. The row is put in the library if it never was, and added to the
       thread's own picks — the user's picks are kept, nothing is removed. */
    let task: string | undefined;
    const linkedIds = ids(mcpServerIds);
    if (typeof taskId === "string" && taskId) {
      if (!(await getTask(taskId))) return c.json({ error: "unknown task" }, 404);
      task = taskId;
      const harness = await mcpServers.ensureBuiltin("harness");
      if (!linkedIds.includes(harness.id)) linkedIds.push(harness.id);
    }
    const first =
      prompt && typeof prompt === "object" && typeof prompt.text === "string"
        ? { text: prompt.text as string, attachmentIds: ids(prompt.attachmentIds) }
        : null;
    const draftPersona = typeof personaId === "string" && personaId ? personaId : null;
    const run = async (): Promise<Created> => {
      /* The first message may pick the persona (`persona-classify.ts`) — but
         only one nobody picked: the draft still carries the project's default.
         Here and not later because no row and no agent exist yet, so the pick
         is a spawn input rather than a respawn. It is asked of the install's
         decision model and of nothing else: no decision model, no call.
         The lane's profile is what must be reachable, not the thread's, so a
         thread on a virtual Default is classified too. */
      const skip = classifyGate({
        text: first?.text,
        globalSwitch: getConfig().classifyPersona,
        projectSwitch: project.defaults?.classifyPersona,
        draftPersonaId: draftPersona,
        projectPersonaId: project.defaults?.personaId,
      });
      /* What the thread says about it, when there is anything to say: a pick, or
         why there was none. A feature that fails in silence cannot be told from
         one that does not work, so only the reader's own switches stay quiet. */
      let said: string | null = skip && !skip.silent ? `not classified — ${skip.reason}` : null;
      const lane = skip ? null : await personaLane();
      let persona = draftPersona;
      const catalogue = lane ? await personas.list() : [];
      if (!skip && !lane) {
        said = "not classified — no decision model is available (Settings › AI)";
      } else if (lane && first && !catalogue.some((p) => p.id !== draftPersona)) {
        said = "not classified — there is no other persona to choose from";
      } else if (lane && first) {
        const outcome = await classifyPersona({
          profile: lane.profile,
          model: lane.model,
          projectName: project.name,
          text: first.text,
          personas: catalogue,
          thresholds: await readPersonaDecision(),
        });
        if (outcome.picked === null) {
          said = `kept — ${outcome.reason}`;
        } else {
          persona = outcome.picked;
          said = `${catalogue.find((p) => p.id === persona)?.name ?? persona} — ${outcome.reason}`;
        }
      }
      const session = await sessions.create(profile, agentId, project, model, effort, id, configChoices, {
        mcpServerIds: linkedIds,
        skillIds: ids(skillIds),
        commandIds: ids(commandIds),
      }, {
        taskId: task,
        // Omitted reads as the default set; an empty array is a draft that
        // asked for none.
        suggestKinds: Array.isArray(suggestKinds) ? normalizeSuggestKinds(suggestKinds) : undefined,
        // The drawn-UI lane, the same draft-picked spawn input: empty is off,
        // omitted (or not an array) reads as all.
        uiGroups: Array.isArray(uiGroups) ? normalizeUiGroups(uiGroups) : undefined,
        // The draft's persona, or the one its first message picked.
        personaId: persona,
        // Which profile and model `ask_agent` uses per agent; omitted = ask.
        askProfiles: AskProfilesSchema.safeParse(askProfiles).data,
        // The draft's permission mode, picked against the agent's probed `modes`.
        // Best-effort like the config choices: a mode the agent does not offer
        // costs the pick, not the thread. The bridge guards on the agent's own
        // mode list, so this needs no per-agent knowledge here.
        modeId: typeof modeId === "string" && modeId ? modeId : undefined,
        /* The draft's role → model assignment. A malformed one was refused above,
           so this is the shape the row wants. */
        helperModels: parsedHelpers.data,
        /* A draft can be renamed before it has ever been sent to, and that name
           has to survive becoming a real thread — `create` keeps it and the
           first-prompt sniff then leaves it alone. */
        title: typeof title === "string" && title.trim() ? title.trim() : undefined,
        /* "Isolate in a git worktree", picked on the draft: the server makes the
           checkout before the thread exists, and refuses in git's words when
           the project cannot have one. */
        worktree: worktree === true,
        /* An aside: the thread it was selected in, and the passage. The parent
           is provenance only (a chip, a highlight), so an id naming nothing is
           harmless — it links to nothing, as a purged fork parent does. */
        aside:
          aside && typeof aside.of === "string" && typeof aside.quote === "string" && aside.quote.trim()
            ? { of: aside.of, quote: aside.quote.slice(0, 4000) }
            : undefined,
      });
      /* Wait for the handshake. A 201 therefore means the agent has answered
         session/new, its settings have been applied, and the first `session_config`
         is already in the log — so the socket the client opens next inherits a
         thread that is genuinely ready rather than one still booting. */
      await session.bridge!.ready;
      /* Said once, in the row a hand pick writes, so the reader sees what the
         classifier did and its undo is the ordinary persona pick. A pick reads
         `Persona: None → Writer — 87% match for your first message; next was no persona at 9%`; everything else reads
         `Persona: not classified — why` or `Persona: kept — why`.

         It is said **after** the first message, not before: the classifier ran
         on those words and the line is about them, so it belongs under the
         bubble they draw (`turn_started`). `now` because the turn has only just
         opened — there is no step to hold it for. */
      const sayPersona = () => {
        if (said === null) return;
        const name = (id: string | null) => (id && catalogue.find((p) => p.id === id)?.name) || "None";
        session.bridge!.noteConfigChange("Persona", persona !== draftPersona ? name(draftPersona) : undefined, said, {
          now: true,
        });
      };
      /* The first message rides the create, so it is on the server the moment
         the draft is: it used to follow over a socket opened afterwards, and a
         reload in between lost words the composer had already cleared. No origin
         peer — `turn_started` is journaled, and the socket the client opens next
         draws the bubble from it. A failure here is the prompt's, not the
         thread's: the thread exists, so it is answered, not thrown. */
      if (!first) {
        sayPersona();
        return { id: session.id };
      }
      try {
        const reply = await sessions.prompt(session.id, first.text, undefined, { attachmentIds: first.attachmentIds });
        sayPersona();
        return "turnId" in reply ? { id: session.id, turnId: reply.turnId } : { id: session.id };
      } catch (error) {
        sayPersona();
        return { id: session.id, promptError: error instanceof Error ? error.message : String(error) };
      }
    };
    const result = run();
    if (typeof id === "string") {
      creating.set(id, result);
      const forget = () => setTimeout(() => creating.delete(id), CREATE_MEMORY_MS).unref();
      // A failed create is forgotten at once: its id may be tried again.
      result.then(forget, () => creating.delete(id));
    }
    return c.json(await result, 201);
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
    const { profileId, agentId: askedAgent, projectId, archived: askedArchived } = await c.req.json();
    /* Archived sessions are left out unless asked for — `archived` in the
       body or the query (`include` / `only`, or `true` for include). Sent to
       the runtime only where it advertises the capability (`session-list.ts`). */
    const archived = archiveFilterOf(askedArchived ?? c.req.query("archived"));
    const profile = await getProfile(profileId);
    if (!profile) return c.json({ error: "unknown profile" }, 404);
    const agentId = resolveProfileAgent(profile, askedAgent);
    if (!agentId || !await getAgent(agentId)) {
      return c.json({ error: "unknown agent for this profile" }, 404);
    }
    const project = await getProject(projectId);
    if (!project) return c.json({ error: "unknown project" }, 404);
    return c.json(await listAgentSessions(profile, agentId, project, { archived }));
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
    try {
      // A revive: a thread another device already brought up is answered as it
      // is, not respawned under it — so this route is idempotent.
      await sessions.respawn(session.id, profile, agentId, project, model, effort, { revive: true });
    } catch (error) {
      // The agent's own words for why it would not come up, bounded.
      const message = spliceStderr({ stderr: sessions.stderrTail(session.id), stderrCount: 0, stderrMark: 0 }, error instanceof Error ? error.message : String(error));
      throw error instanceof HttpError ? new HttpError(message, error.status) : new Error(message);
    }
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
   * Change this thread's profile, model or effort — the *first* thing
   * a client asks for all three, because it is the only side that can tell
   * whether a restart is needed.
   *
   * Three answers, not two.
   *
   * A live change answers `{live: true}` and every socket stays exactly where
   * it was. One that costs the process is **staged** — `{live: false, staged}`
   * — and taken by the next spawn, which for a thread nobody is sending to is
   * no spawn at all; the turn that needs it is what makes one happen. That is
   * now the common answer, not the mid-turn exception it started as.
   *
   * `{live: false, restarting: true}` is left for the two callers that ask for
   * the restart itself — `defer: false` ("Apply now") and an agent change,
   * which is never staged — and it is answered *before* the restart rather than
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
      sessions.cancelStaged(session);
      return c.json({ ok: true, live: false, staged: null });
    }
    /* The agent's own selectors — the mode, and every option it advertises —
       staged like the spawn settings are: nothing is placed on the process
       until a turn starts or `applyStaged` approves it. */
    if (body.pick && typeof body.pick === "object") {
      const { modeId, options } = body.pick;
      const staged = sessions.stagePick(session.id, {
        modeId: typeof modeId === "string" ? modeId : undefined,
        options: options && typeof options === "object" ? options : undefined,
      });
      return c.json({ ok: true, live: false, staged });
    }
    /* "Apply now": the reader's approval of what is staged. A running turn is
       steered with what the process can take; the rest stays staged. */
    if (body.applyStaged === true) {
      const staged = await sessions.approveStaged(session.id);
      return c.json({ ok: true, live: true, staged });
    }
    /* The floor under "apply now": the staged change, for any field this body
       does not name. The client sends the staged patch back explicitly (it
       holds it — `staged_config` is absolute and reaches every peer), because a
       body always names model and effort and would otherwise overwrite the
       change it was asked to take. This is what answers a caller that does
       not. */
    const staged = body.defer === false ? (sessions.stagedRequest(session.id) ?? {}) : {};
    const { profileId, agentId: askedAgent, model, effort, suggestKinds, uiGroups, personaId, helperModels } = {
      ...staged,
      ...body,
    };
    /* The thread's role → model map, patched like model and effort: spawn-time,
       so it stages and costs a respawn. Absent means unchanged. */
    const parsedHelpers = helperModels === undefined ? null : helperModelsSchema.safeParse(helperModels);
    if (parsedHelpers && !parsedHelpers.success) {
      return c.json({ error: "helperModels must be an array of { role, model }" }, 400);
    }
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
        // Omitted means unchanged; a set that differs changes the suggestions
        // trailer and respawns.
        suggestKinds: Array.isArray(suggestKinds) ? normalizeSuggestKinds(suggestKinds) : undefined,
        // The drawn-UI lane: spawn text, and a set that differs costs the
        // process (`applyConfigLive` compares as sets); empty is off.
        uiGroups: Array.isArray(uiGroups) ? normalizeUiGroups(uiGroups) : undefined,
        // The persona: spawn text like the lane above. Omitted = unchanged,
        // null or "" = none.
        personaId: personaId === undefined ? undefined : typeof personaId === "string" && personaId ? personaId : null,
        // The role → model map: read at spawn (the env var and the materialised
        // files), so a change costs the process like a profile move.
        helperModels: parsedHelpers ? parsedHelpers.data : undefined,
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
      suggestKinds: session.suggestKinds,
      uiGroups: session.uiGroups,
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
    /* How many turns the page holds — the reader's pick, clamped by the journal
       (`earlierPageSteps`). Absent keeps the old fixed page size, which is what
       a client that predates the setting sends. */
    const steps = Number(c.req.query("steps"));
    const page = await sessions.earlierPage(c.req.param("id"), before, Number.isFinite(steps) ? steps : undefined);
    return page ? c.json(page) : c.json({ error: "not found" }, 404);
  });

  // What the agent process has been printing. The client shows this when a thread
  // fails in a way ACP won't explain — the agent's own stack trace is the answer
  // and it never travels over the protocol.
  /* The thread's model calls out of the ledger, newest first, paged by `at`
     (`?before=<at>&limit=`) — the Trace panel's cold read; the live ones ride
     the journal as `_daedalus/model_call`. Answers for a retired thread too:
     the ledger is the install's, not the process's. */
  app.get("/api/sessions/:id/calls", async (c) => {
    const before = Number(c.req.query("before"));
    const limit = Number(c.req.query("limit"));
    return c.json({ calls: await listCalls(c.req.param("id"), { before: before || undefined, limit: limit || undefined }) });
  });

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
    if (raw === "thread" || raw === "branch") return { kind: raw };
    if (raw.startsWith("turn:") && raw.length > 5) return { kind: "turn", turnId: raw.slice(5) };
    return null;
  };

  /* Undo one ended turn's files in the working tree — never the index, never
     another path. 409 `{error, conflicts}` when a path moved since the turn
     ended, unless `force`. */
  app.post("/api/sessions/:id/turn-changes/:turnId/revert", async (c) => {
    const id = c.req.param("id");
    if (!sessions.get(id)) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { force?: unknown; partial?: unknown };
    /* Paths to take this thread's edits out of, not restore whole (a peer wrote them too). */
    const partial: Record<string, { oldText: string; newText: string }[]> = {};
    if (body.partial && typeof body.partial === "object")
      for (const [path, edits] of Object.entries(body.partial))
        if (Array.isArray(edits))
          partial[path] = edits.filter(
            (e): e is { oldText: string; newText: string } => typeof e?.oldText === "string" && typeof e?.newText === "string",
          );
    /* Refusals are HttpErrors (git's are WorkspaceErrors), which app.onError
       shapes with their status. */
    const result = await sessions.revertTurn(id, c.req.param("turnId"), body.force === true, partial);
    if (result.reverted.length === 0 && result.conflicts.length > 0)
      return c.json(
        { error: `${result.conflicts.length} of this turn's files changed since it ended`, conflicts: result.conflicts },
        409,
      );
    return c.json(result);
  });

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
  /* Remove an isolated thread's worktree (`SessionManager.removeWorktree`):
     refused with what would be lost while it has uncommitted work, unless
     `force=1`. */
  app.delete("/api/sessions/:id/worktree", async (c) => {
    const ok = await sessions.removeWorktree(c.req.param("id"), c.req.query("force") === "1");
    return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

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
    const { title, pinned, hidden, notify, askProfiles } = await c.req.json();
    if (!sessions.get(c.req.param("id"))) return c.json({ error: "not found" }, 404);
    // Which profile (and model) `ask_agent` uses per agent on this thread.
    // Travels alone, like a pin.
    if (askProfiles !== undefined && title === undefined) {
      const parsed = AskProfilesSchema.safeParse(askProfiles);
      if (!parsed.success) return c.json({ error: "askProfiles must map an agent id to { profileId, model? }" }, 400);
      return c.json({ askProfiles: (await sessions.setAskProfiles(c.req.param("id"), parsed.data)) ?? {} });
    }
    // Pinning is the other thing this row edits, and it travels alone: a menu
    // toggling a pin has no title to send.
    if (typeof pinned === "boolean" && title === undefined) {
      return c.json({ pinnedAt: sessions.setPinned(c.req.param("id"), pinned) ?? null });
    }
    // Hiding travels alone for the same reason.
    if (typeof hidden === "boolean" && title === undefined) {
      return c.json({ hiddenAt: sessions.setHidden(c.req.param("id"), hidden) ?? null });
    }
    // Muting too; null hands the thread back to the default (off while hidden).
    if ((typeof notify === "boolean" || notify === null) && title === undefined) {
      return c.json({ notify: sessions.setNotify(c.req.param("id"), notify) ?? null });
    }
    if (typeof title !== "string") return c.json({ error: "title must be a string" }, 400);
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

  const FormBuilderSchema = z.object({
    profileId: z.string().min(1),
    model: z.string().optional(),
    schema: z.record(z.string(), z.unknown()),
    value: z.record(z.string(), z.unknown()),
    messages: z.array(z.unknown()).min(1).max(40),
  });

  app.post("/api/form-builder", async (c) => {
    const parsed = FormBuilderSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "profileId, schema, value, and messages are required" }, 400);
    if (JSON.stringify(parsed.data.schema).length > 32_000) {
      return c.json({ error: "form schema is too large" }, 413);
    }
    if (JSON.stringify(parsed.data.messages).length > 64_000) {
      return c.json({ error: "chat history is too large" }, 413);
    }
    const profile = await getProfile(parsed.data.profileId);
    if (!profile) return c.json({ error: "unknown profile" }, 404);
    if (!await profileHasAgent(profile)) return c.json({ error: "profile has no supported agent" }, 409);

    const result = await streamFormBuilder({
      profile,
      model: parsed.data.model,
      messages: parsed.data.messages as import("ai").UIMessage[],
      schema: parsed.data.schema as import("ai").JSONSchema7,
      value: parsed.data.value,
      signal: c.req.raw.signal,
    });
    return result.toUIMessageStreamResponse();
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

  /* A `!` line from the composer: run it against the thread's project and put
     the result in the transcript. Not a turn — nothing is queued, no prompt
     goes out, and the agent is never told the line happened. It IS journaled,
     though (`_daedalus/shell`), which is what makes it part of the
     conversation: it sits where it was run and comes back on a reload, unlike
     the enhance above, which sends nothing.

     A line that is one of the project's saved helper commands runs **as** that
     helper — its own directory and environment — because the row is the
     definition, and that is what picking one in the composer filled in.
     Anything else runs in the project root. The command travels from the
     browser here and nowhere else: this is the one route that takes one. */
  const ShellSchema = z.object({ command: z.string(), shellId: z.string().optional() });

  app.post("/api/sessions/:id/shell", async (c) => {
    const session = sessions.get(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    if (session.deletedAt !== null) return c.json({ error: "session deleted" }, 409);
    const parsed = ShellSchema.safeParse(await c.req.json().catch(() => ({})));
    const typed = parsed.success ? parsed.data.command.trim() : "";
    if (!typed) return c.json({ error: "command is required" }, 400);
    /* The caller mints this so it can draw the row before this request lands.
       A caller that does not — curl, a test — still gets a row of its own. */
    const shellId = (parsed.success ? parsed.data.shellId?.trim() : "") || randomUUID();

    /* A worktree thread's line runs in its worktree, where its agent works. */
    const project = await projectRoot(session.projectId);
    const root = session.worktree ? join(project, session.worktree) : project;
    const helper = (await listHelpers(session.projectId)).find(
      (candidate) => candidate.command.trim() === typed || candidate.name === typed,
    );
    const command = helper?.command ?? typed;
    const run = { sessionUpdate: "_daedalus/shell" as const, shellId, command };

    /* Counted here rather than in the composer: this is the one door a line
       comes through, so every run counts and the browser keeps no books. The
       *resolved* line, so a helper reached by its name and one reached by its
       command are one row — and one that orders the helper itself, which the
       completer ranks by the same tally. A thread with no project has nowhere
       to file it. */
    if (session.projectId) await recordShellRun(session.projectId, command);

    /* Said BEFORE the work, not after: the row has to be on screen while the
       line runs, or a command that takes a few seconds reads as one that did
       nothing at all. The two updates carry the same `shellId`, so the second
       settles the first rather than starting a second row. */
    sessions.emitOn(session.id, {
      ev: "update",
      seq: 0,
      historyReplay: false,
      update: { ...run, status: "running" },
    });

    const result = await runShellLine({
      cwd: containedPath(root, helper?.cwd ?? null),
      command,
      env: helper?.env ?? undefined,
    });

    sessions.emitOn(session.id, {
      ev: "update",
      seq: 0,
      historyReplay: false,
      update: {
        ...run,
        status: "done",
        output: result.output,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
      },
    });
    return c.json({ shellId, command, ...result });
  });

  /* The same line from a draft, which has no row to journal into and must not
     get one for this: the line runs in the project root (a draft's worktree
     does not exist yet) and the answer is the only record — nothing is
     journaled, fanned out or tallied. The draft draws it from this reply. */
  const DraftShellSchema = z.object({ command: z.string(), projectId: z.string() });

  app.post("/api/shell", async (c) => {
    const parsed = DraftShellSchema.safeParse(await c.req.json().catch(() => ({})));
    const typed = parsed.success ? parsed.data.command.trim() : "";
    if (!parsed.success || !typed) return c.json({ error: "command and projectId are required" }, 400);
    const { projectId } = parsed.data;
    const root = await projectRoot(projectId);
    const helper = (await listHelpers(projectId)).find(
      (candidate) => candidate.command.trim() === typed || candidate.name === typed,
    );
    const command = helper?.command ?? typed;
    const result = await runShellLine({
      cwd: containedPath(root, helper?.cwd ?? null),
      command,
      env: helper?.env ?? undefined,
    });
    return c.json({ command, ...result });
  });

  /* The same rewrite for a draft, which has no server row yet: the profile and
     the model travel in the body instead of being read off a session. The
     draft's *agent* deliberately does not — the rewrite goes to the profile's
     shared endpoint, so there is nothing here for it to select (see
     `profileHasAgent`). `profileId` is the rewrite's provider — the thread's
     own draft profile unless the picker chose another. */
  const DraftEnhanceSchema = z.object({
    text: z.string(),
    profileId: z.string(),
    model: z.string().optional(),
    /* A board task's description rather than an agent prompt (`enhance.ts`). */
    kind: z.enum(["prompt", "task"]).optional(),
  });

  app.post("/api/enhance", async (c) => {
    const parsed = DraftEnhanceSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "text and profileId are required" }, 400);
    const profile = await getProfile(parsed.data.profileId);
    if (!profile) return c.json({ error: "unknown profile" }, 404);
    // The agent only decides which per-agent base URL is NOT used (see
    // `enhance.ts`), so a profile serving several is as usable as one serving a
    // single runtime (`profileHasAgent`). What is refused: a profile with
    // nothing known behind it, which must not be offered the rewrite silently.
    if (!await profileHasAgent(profile)) {
      return c.json({ error: "unknown agent for this profile" }, 404);
    }
    const enhanced = await enhancePrompt(profile, {
      text: parsed.data.text,
      model: parsed.data.model || undefined,
      kind: parsed.data.kind,
    });
    return c.json({ enhanced });
  });
}
