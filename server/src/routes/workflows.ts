import type { Hono } from "hono";
import { z } from "zod";
import { WorkflowError, type WorkflowRunner } from "../workflows.js";

/** How long one long-poll may hold before answering with the run as it stands.
    Under every agent runtime's MCP tool timeout we know of (codex: 60s). */
const MAX_WAIT_SEC = 55;

const RunInput = z.object({ definition: z.unknown(), inputs: z.unknown().optional() });

/**
 * The loopback the `workflow` MCP server drives — outside `/api`, so outside
 * the bearer check: the per-boot key in the path is the credential (the
 * `/gw`/`/ide` rule), and the session id after it names the thread the call is
 * made for, which is the only thread it may start or read runs on.
 */
export function workflowRoutes(app: Hono, deps: { runner: WorkflowRunner }): void {
  const { runner } = deps;
  const base = "/wf/:key/:sessionId";

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
}

function waitSec(raw: string | undefined): number {
  const n = Number(raw ?? 0) || 0;
  return Math.max(0, Math.min(MAX_WAIT_SEC, Math.floor(n)));
}
