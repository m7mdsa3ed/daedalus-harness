import type { Hono } from "hono";
import { z } from "zod";
import type { SessionManager } from "../sessions.js";
import { WorkflowError, type WorkflowRunner } from "../workflows.js";

/** How long one long-poll may hold before answering with the run as it stands.
    Under every agent runtime's MCP tool timeout we know of (codex: 60s). */
const MAX_WAIT_SEC = 55;

const RunInput = z.object({ definition: z.unknown(), inputs: z.unknown().optional() });
const ScriptInput = z.object({
  script: z.string().min(1),
  args: z.unknown().optional(),
  tokenBudget: z.number().int().positive().optional(),
});

/**
 * The loopback the `workflow` MCP server drives — outside `/api`, so outside
 * the bearer check: the per-boot key in the path is the credential (the
 * `/gw`/`/ide` rule), and the session id after it names the thread the call is
 * made for, which is the only thread it may start or read runs on.
 */
export function workflowRoutes(app: Hono, deps: { runner: WorkflowRunner; sessions: SessionManager }): void {
  const { runner, sessions } = deps;
  const base = "/wf/:key/:sessionId";

  /* A run from a script rather than a definition. Its own route because the
     two payloads have nothing in common: one is a graph to validate, the other
     is a program whose only up-front check is that its `meta` parses. */
  app.post(`${base}/scripts`, async (c) => {
    const parent = runner.resolveCaller(c.req.param("key"), c.req.param("sessionId"));
    if (!parent) return c.json({ error: "not found" }, 404);
    const body = ScriptInput.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.issues }, 400);
    try {
      const view = runner.startScript(parent, body.data.script, body.data.args, body.data.tokenBudget);
      const wait = waitSec(c.req.query("wait"));
      return c.json(wait > 0 ? await runner.wait(view.id, wait * 1000) : view, 201);
    } catch (error) {
      if (error instanceof WorkflowError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  });

  app.post(`${base}/runs`, async (c) => {
    const parent = runner.resolveCaller(c.req.param("key"), c.req.param("sessionId"));
    if (!parent) return c.json({ error: "not found" }, 404);
    const body = RunInput.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.issues }, 400);
    try {
      const view = runner.start(parent, body.data.definition, body.data.inputs);
      const wait = waitSec(c.req.query("wait"));
      return c.json(wait > 0 ? await runner.wait(view.id, wait * 1000) : view, 201);
    } catch (error) {
      if (error instanceof WorkflowError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  });

  app.get(`${base}/runs/:id`, async (c) => {
    const parent = runner.resolveCaller(c.req.param("key"), c.req.param("sessionId"));
    if (!parent) return c.json({ error: "not found" }, 404);
    const id = c.req.param("id");
    const wait = waitSec(c.req.query("wait"));
    const view = wait > 0 ? await runner.wait(id, wait * 1000) : runner.status(id);
    return view ? c.json(view) : c.json({ error: "no such run" }, 404);
  });

  app.post(`${base}/runs/:id/cancel`, (c) => {
    const parent = runner.resolveCaller(c.req.param("key"), c.req.param("sessionId"));
    if (!parent) return c.json({ error: "not found" }, 404);
    const id = c.req.param("id");
    runner.cancel(id, "cancelled by the agent");
    const view = runner.status(id);
    return view ? c.json(view) : c.json({ error: "no such run" }, 404);
  });

  /* Hold and release, for the agent that started the run. Idempotent in
     effect: pausing a held run (or resuming a running one) changes nothing and
     answers the run as it stands, so a tool call retried by the runtime is
     harmless. */
  for (const verb of ["pause", "resume"] as const) {
    app.post(`${base}/runs/:id/${verb}`, (c) => {
      const parent = runner.resolveCaller(c.req.param("key"), c.req.param("sessionId"));
      if (!parent) return c.json({ error: "not found" }, 404);
      const id = c.req.param("id");
      const view = runner.status(id);
      if (!view) return c.json({ error: "no such run" }, 404);
      runner[verb](id);
      return c.json(runner.status(id));
    });
  }

  /* The same two for the browser, behind the bearer: addressed by the thread
     the run belongs to, which is also the check — a run id is not a
     credential, so one on another thread is "no such run". */
  for (const verb of ["pause", "resume"] as const) {
    app.post(`/api/sessions/:id/workflows/:runId/${verb}`, (c) => {
      const session = sessions.get(c.req.param("id"));
      if (!session || session.deletedAt !== null) return c.json({ error: "not found" }, 404);
      const runId = c.req.param("runId");
      const view = runner.statusFor(session.id, runId);
      if (!view) return c.json({ error: "no such run" }, 404);
      if (!runner[verb](runId)) {
        const state = view.status === "paused" ? "already paused" : view.status === "running" ? "already running" : `already ${view.status}`;
        return c.json({ error: `the run is ${state}` }, 409);
      }
      return c.json(runner.status(runId));
    });
  }
}

function waitSec(raw: string | undefined): number {
  const n = Number(raw ?? 0) || 0;
  return Math.max(0, Math.min(MAX_WAIT_SEC, Math.floor(n)));
}
