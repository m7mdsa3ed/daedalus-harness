import type { Hono } from "hono";
import { z } from "zod";
import { getAgent } from "../registry.js";
import { resolveProfileAgent, getProfile } from "../profiles.js";
import { getProject } from "../projects.js";
import { drop, prewarm, prewarmEnabled } from "../prewarm.js";
import type { SessionManager } from "../sessions.js";
import { UUID_RE } from "./helpers.js";

/**
 * A draft's agent, booted early (`docs/plans/prewarm.md`, `src/prewarm.ts`).
 *
 * A thread starts as a draft — the client mints the id and nothing exists on
 * the server until the first message — so its first send pays the whole cold
 * start. These two routes are how the composer asks for the process behind the
 * keystrokes instead: **the draft still creates no row and sends no prompt.**
 * All that exists afterwards is a spawned, `initialize`d process waiting to be
 * claimed by the thread `POST /api/sessions` finally makes.
 *
 * **Nothing here is an error the reader sees.** The routes answer `{ ok }` in
 * every non-validation case — a prewarm that could not start one says `false`,
 * and the only observable is that the first message is as slow as it always
 * was. `POST /api/sessions` is unchanged by any of this: a draft nobody warmed
 * spawns cold, exactly as today.
 *
 * What is resolved, and in what order, is deliberately the same as create's
 * (`routes/sessions.ts`), with the same wording for each refusal — a draft whose
 * profile or project has gone is a fact about the draft, not about warming, and
 * it should read the same here as it will on send.
 */

/** The draft's role → model assignment, as create carries it: a spawn input,
    so it is part of what makes a warm process the one the thread would start.
    Kept apart from `routes/sessions.ts`'s copy only because that one is local
    to that file; the shape and the refusal are identical. */
const helperModelsSchema = z.array(z.object({ role: z.string(), model: z.string() }));

const WarmSchema = z.object({
  id: z.string(),
  profileId: z.string().min(1),
  /** Left out only when the profile names one agent, as create allows. */
  agentId: z.string().min(1).optional(),
  projectId: z.string().min(1),
  model: z.string().optional(),
  effort: z.string().optional(),
  helperModels: helperModelsSchema.optional(),
});

/** What both routes answer. `ok` is a log line's worth of information, never a
    branch: `false` means no process was started (or the agent is already warm
    for something else), which costs the reader nothing they can see. */
type Answer = { ok: boolean };

export function prewarmRoutes(app: Hono, deps: { sessions: SessionManager }): void {
  const { sessions } = deps;

  /* Start an agent process for a draft, and answer before it has answered
     `initialize`.
     Returning first is the point rather than an optimisation: this is called
     from a debounced keystroke, and a request held open for the handshake (up to
     `PREWARM_TIMEOUT_MS`, seconds on a cold claude-agent-acp) would put the
     server's slowest spawn in front of the composer's next keystroke. The spawn
     is started before the answer is written, so a client that sends immediately
     after — which is the whole case — always finds it in flight. */
  app.post("/api/prewarm", async (c) => {
    /* A hosted agent outlives the server and boot adoption resurrects it by the
       row that names it; a prewarmed one has no row, so it would be left running
       with no thread and no reader. The routes still answer, in the same shape,
       so the client needs no second code path — it is simply never warm. */
    if (!prewarmEnabled()) return c.json({ ok: false } satisfies Answer);

    const parsed = WarmSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "id, profileId and projectId are required" }, 400);
    const { id, profileId, agentId: askedAgent, projectId, model, effort, helperModels } = parsed.data;

    /* Create's order, and create's words. The agent is resolved from the
       profile, so a virtual Default's id or an older client naming no agent
       resolves the one the thread will actually get. */
    const profile = await getProfile(profileId);
    if (!profile) return c.json({ error: "unknown profile" }, 404);
    const agentId = resolveProfileAgent(profile, askedAgent);
    const agent = agentId ? await getAgent(agentId) : undefined;
    if (!agentId || !agent) {
      return c.json({ error: "unknown agent for this profile" }, 404);
    }
    const project = await getProject(projectId);
    if (!project) return c.json({ error: "unknown project" }, 404);
    /* The id checks last, as create has them: a draft id that is not a UUID is
       not something to spawn against (it is the gateway URL's key), and one that
       already names a live thread has a process of its own — warming a second
       would be work create would refuse to claim. */
    if (!UUID_RE.test(id)) return c.json({ error: "id must be a UUID" }, 400);
    if (sessions.get(id)) return c.json({ error: "session already exists" }, 409);

    /* Not awaited, on purpose — see above. `prewarm` resolves only after the
       handshake and never rejects by design: every failure inside it is logged
       and reaped there, so all this `catch` guards is a bug becoming an
       unhandled rejection in an otherwise healthy server. `ok` therefore means
       "a spawn was started", which is the whole of what the client can act on —
       whether the agent then answers is create's problem, at send, with today's
       error and today's Retry row. Nothing a failed prewarm does is visible. */
    try {
      /* `shared` is read off the row rather than inferred, as everywhere else:
         a runtime whose threads share one process cannot be handed a process of
         this draft's own, so it warms the pool instead (`prewarm.ts`). */
      void prewarm(profile, agentId, project, {
        sessionId: id,
        model,
        effort,
        helperModels,
        shared: agent.sharedProcess === "acp-meta",
      }).catch(() => {});
    } catch {
      // The spawn never started, so there is nothing warm to promise.
      return c.json({ ok: false } satisfies Answer);
    }
    return c.json({ ok: true } satisfies Answer);
  });

  /* Forget it — the composer emptied, the draft's tab closed, or the draft was
     deleted. Idempotent and always `ok`: a cancel may arrive for a process that
     was claimed, swept, evicted or never started, and there is nothing to report
     about any of those. Never trusted as the guarantee either — the TTL and the
     cap in `prewarm.ts` are — so this is promptness only. */
  app.delete("/api/prewarm/:id", (c) => {
    if (prewarmEnabled()) drop(c.req.param("id"));
    return c.json({ ok: true } satisfies Answer);
  });
}
