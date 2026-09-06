import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  RoutineError,
  RoutineInputSchema,
  RoutinePatchSchema,
  TriggerInputSchema,
  TriggerPatchSchema,
  createRoutine,
  createTrigger,
  deleteRoutine,
  deleteTrigger,
  listRoutines,
  listTriggers,
  mintTriggerToken,
  revokeTriggerToken,
  updateRoutine,
  updateTrigger,
  type RoutineEngine,
  type RoutineTrigger,
} from "../routines.js";

/**
 * A RoutineError carries the status its refusal deserves — 404 for an unknown
 * routine or trigger, 409 for a state that forbids the write — which
 * app.onError would otherwise flatten into a 500. The same bargain
 * `workspace()` makes for WorkspaceError, kept local because the engine's
 * errors are the only ones these routes raise.
 */
const routine = async <T>(c: Context, run: () => T | Promise<T>, status: 200 | 201 = 200) => {
  try {
    return c.json((await run()) as object, status);
  } catch (err) {
    if (err instanceof RoutineError) return c.json({ error: err.message }, err.status);
    throw err;
  }
};

/**
 * A trigger as the client sees it: every column except the stored credential,
 * which becomes the boolean it is actually asked about.
 *
 * The same bargain the web-search config makes with its token, and for the same
 * reason: the UI's only questions are "does this trigger have a token" and "how
 * old is it" — the hash answers neither, and shipping a credential-shaped value
 * to a surface that has no use for it is how one ends up in a screenshot. The
 * *backup* still carries it (a restore that dropped it would silently break
 * every caller), under its own opt-in.
 */
const triggerView = (trigger: RoutineTrigger) => {
  const { secretHash, ...rest } = trigger;
  return { ...rest, hasToken: Boolean(secretHash) };
};

/** What "Run now" and the fire door carry. `text` is freeform and is NEVER
    parsed — it reaches the agent inside the untrusted wrapper (`firePrompt`),
    which is the whole of what stands between a leaked token and an instruction
    channel with a project's cwd in front of it. */
const FireInput = z.object({
  text: z.string().optional(),
  /** Force `ask` everywhere for this one run, whatever the routine's policy
      says. The client's first-class "dry run": it is the run that clears the
      routine's `dry_run_completed` gate, so the route has to be able to ask
      for it explicitly rather than inferring it from the routine's state. */
  dryRun: z.boolean().optional(),
});

export function routineRoutes(app: Hono, deps: { engine: RoutineEngine }): void {
  const { engine } = deps;

  app.get("/api/routines", (c) => c.json(listRoutines()));

  app.post("/api/routines", async (c) => {
    const parsed = RoutineInputSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return routine(c, () => createRoutine(parsed.data), 201);
  });

  app.patch("/api/routines/:id", async (c) => {
    const parsed = RoutinePatchSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return routine(c, () => updateRoutine(c.req.param("id"), parsed.data));
  });

  app.delete("/api/routines/:id", (c) =>
    deleteRoutine(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "unknown routine" }, 404),
  );

  /* Run now. Answers as soon as the run row exists, not when the run is over —
     the button wants the row to link to, and a review that takes half an hour
     would otherwise be a request that hangs for it. The engine's own rate limit
     is deliberately not applied: it guards the unauthenticated door below, and
     a bearer-authenticated person pressing a button is not that traffic. */
  app.post("/api/routines/:id/run", async (c) => {
    const parsed = FireInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return routine(c, () =>
      engine.fire(c.req.param("id"), {
        text: parsed.data.text ?? null,
        source: "manual",
        dryRun: parsed.data.dryRun ?? false,
      }),
      201,
    );
  });

  /* This routine's runs, newest first. A run is a row and not a projection, so
     this is the run list, the run detail and the digest all at once. */
  app.get("/api/routines/:id/runs", (c) =>
    routine(c, () => engine.runsOf(c.req.param("id"), Number(c.req.query("limit")) || 50)),
  );

  /* Stop a run that is still going.
     The one control this feature genuinely owes the user: everything else here
     configures what will happen, and this is the only way to intervene in what
     IS happening. A routine run is an ordinary thread, so its Stop button works
     too — but reaching it means knowing the run has a thread and finding it,
     which is the wrong amount of work when the reason you are looking is that
     an unattended agent is doing something you did not expect.

     The thread is left alone: it is a transcript somebody is about to read, and
     a cancelled run is exactly the one they will. Answers `{stopped}` rather
     than 404ing on a run that already ended — asking twice, or losing a race
     with a run that finished on its own, is not an error. */
  app.post("/api/routines/runs/:runId/cancel", (c) =>
    routine(c, () => ({ stopped: engine.cancelForRun(c.req.param("runId"), "stopped from the UI") })),
  );

  /* ── triggers ──
     Registered before the routine-scoped paths that share their segment count,
     so `/api/routines/triggers/<id>` can never be read as a routine id followed
     by a literal — a routine id is a UUID, but the ordering makes that a fact
     about the router rather than about how ids happen to be minted. */

  app.patch("/api/routines/triggers/:id", async (c) => {
    const parsed = TriggerPatchSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return routine(c, () => triggerView(updateTrigger(c.req.param("id"), parsed.data)));
  });

  app.delete("/api/routines/triggers/:id", (c) =>
    deleteTrigger(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "unknown trigger" }, 404),
  );

  /* Mint or rotate the trigger's long-lived token. The token is in the answer
     and nowhere else — only its sha-256 is stored — so a client that does not
     show it here cannot show it later, and a rotation is a new mint. */
  app.post("/api/routines/triggers/:id/token", (c) =>
    routine(c, () => ({ token: mintTriggerToken(c.req.param("id")) })),
  );

  /* Take the token away without deleting the trigger: a rotation the user
     backed out of, or one they believe leaked. The trigger stays, inert to
     everything outside this process. */
  app.delete("/api/routines/triggers/:id/token", (c) =>
    routine(c, () => {
      revokeTriggerToken(c.req.param("id"));
      return { ok: true };
    }),
  );

  app.get("/api/routines/:id/triggers", (c) => c.json(listTriggers(c.req.param("id")).map(triggerView)));

  /* A new trigger is created with a null clock on purpose (see routines.ts):
     null is inert, and the scheduler's sweep is the one thing that knows when
     the next slot is. It arms it on its next pass, within SWEEP_MS. */
  app.post("/api/routines/:id/triggers", async (c) => {
    const parsed = TriggerInputSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return routine(c, () => triggerView(createTrigger(c.req.param("id"), parsed.data)), 201);
  });

  /*
   * ── the fire door ──
   *
   * Outside `/api`, so outside the bearer check: the credential is in the path,
   * the `/gw` `/ide` `/wf` rule. This one differs from those three in the way
   * that matters, and deliberately — TWO credentials are accepted.
   *
   * The per-boot engine key is for callers inside this process (a chained
   * finish action, an MCP server), exactly as the other three routes work. A
   * trigger's stored token is for everything outside it, because a per-boot key
   * is a credential that changes on every restart: an alerting tool holding one
   * would have to re-read it from this machine after every deploy, which is not
   * a thing an alerting tool does. That is why this is the one credential in
   * the harness that is stored — hashed, and compared in constant time by
   * `verifyTriggerSecret`.
   *
   * The token may arrive in the path in place of the key, which is what a
   * webhook field can express, or as `Authorization: Bearer` for a caller that
   * can set headers — which is the better of the two, since a URL ends up in
   * proxy logs and browser history (the same reason `/api/backup` refuses
   * `?token=`). Both are handed to `authorizeFire`, which answers 404 for a bad
   * key, a bad token and an unknown routine alike: telling an unauthenticated
   * caller that a routine exists is telling it which ids are real.
   *
   * The rate limit is the engine's and applies to both. `overlap` stops two
   * agents from running in one cwd; it does nothing about a loop hammering this
   * route, which without a limit would mint a run row and a `skipped` verdict
   * thousands of times a minute.
   */
  const base = "/rt/:key/:routineId";

  app.post(`${base}/fire`, async (c) => {
    const path = c.req.param("key");
    const header = c.req.header("authorization");
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const auth = engine.authorizeFire(c.req.param("routineId"), {
      key: path,
      // The path segment is tried as a token too: a caller outside this process
      // has no boot key, and the path is the only place some webhook senders
      // can put a credential at all.
      token: bearer || path,
    });
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);
    const parsed = FireInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    /* `dryRun` is deliberately NOT read from this body: forcing `ask` on an
       unattended fire would park the run on a question nobody is there to
       answer, and the flag exists for a person pressing a button. */
    const view = await engine.fire(auth.routine.id, {
      text: parsed.data.text ?? null,
      source: "api",
      triggerId: auth.triggerId,
    });
    return c.json(view, 201);
  });
}
