import type { Hono } from "hono";
import { z } from "zod";
import type { SessionManager } from "../sessions.js";
import { getProject } from "../projects.js";
import { WorkflowError, type WorkflowRunner } from "../workflows.js";
import { listSaved, saveWorkflow } from "../workflow-saved.js";

/** How long one long-poll may hold before answering with the run as it stands.
    Under every agent runtime's MCP tool timeout we know of (codex: 60s). */
const MAX_WAIT_SEC = 55;

const RunInput = z.object({ definition: z.unknown(), inputs: z.unknown().optional() });
const AskInput = z.object({
  profile: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
  prompt: z.string().min(1).max(20_000),
  description: z.string().min(1).max(120).optional(),
  projectId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  timeoutSec: z.number().int().positive().optional(),
});
const ContinueInput = z.object({ prompt: z.string().max(20_000).optional() });
const AskChoiceInput = z.object({
  agentId: z.string().min(1),
  profileId: z.string().min(1),
  model: z.string().min(1).optional(),
});
const ScriptInput = z.object({
  script: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  resumeFromRunId: z.string().min(1).optional(),
  args: z.unknown().optional(),
  tokenBudget: z.number().int().positive().optional(),
});
const SaveInput = z.object({ runId: z.string().min(1), scope: z.enum(["project", "personal"]).default("project") });

/**
 * The loopback the `workflow` and `agents` MCP servers drive — outside `/api`, so outside
 * the bearer check: the derived key in the path is the credential (the
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
      /* Every run tells its thread when it ends — a wait included, because a
         wait that times out leaves the run going. A wait still blocked when it
         ends is handed the outcome instead, and nothing is sent after it. */
      const wait = waitSec(c.req.query("wait"));
      const view = await runner.startScript(parent, { ...body.data, notify: true });
      return c.json(wait > 0 ? await runner.wait(view.id, wait * 1000) : view, 201);
    } catch (error) {
      if (error instanceof WorkflowError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  });

  /* Saved workflows: the project's `.claude/workflows/` and the personal one,
     the directories Claude Code reads, so either tool runs what the other saved. */
  app.get(`${base}/saved`, async (c) => {
    const parent = runner.resolveCaller(c.req.param("key"), c.req.param("sessionId"));
    if (!parent) return c.json({ error: "not found" }, 404);
    const project = await getProject(parent.projectId);
    if (!project) return c.json({ error: "this thread's project no longer exists" }, 409);
    return c.json({ workflows: await listSaved(project.cwd) });
  });

  app.post(`${base}/saved`, async (c) => {
    const parent = runner.resolveCaller(c.req.param("key"), c.req.param("sessionId"));
    if (!parent) return c.json({ error: "not found" }, 404);
    const body = SaveInput.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.issues }, 400);
    const project = await getProject(parent.projectId);
    if (!project) return c.json({ error: "this thread's project no longer exists" }, 409);
    const source = await runner.scriptOf(parent.id, body.data.runId);
    if (!source) return c.json({ error: "no script run with that id on this thread" }, 404);
    try {
      return c.json(await saveWorkflow(project.cwd, source, body.data.scope), 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  /* The `agents` server's two doors. Waiting on and cancelling an ask are the
     `/runs/:id` routes below: an ask is a one-step run. */
  app.get(`${base}/agents`, async (c) => {
    const parent = runner.resolveCaller(c.req.param("key"), c.req.param("sessionId"));
    if (!parent) return c.json({ error: "not found" }, 404);
    return c.json({ pairs: await runner.pairs(parent) });
  });

  /* What the person chose for each agent on this thread, read and (after they
     answered the picker with "remember") written by the `agents` server. */
  app.get(`${base}/ask-profiles`, (c) => {
    const parent = runner.resolveCaller(c.req.param("key"), c.req.param("sessionId"));
    if (!parent) return c.json({ error: "not found" }, 404);
    return c.json({ askProfiles: parent.askProfiles });
  });
  app.put(`${base}/ask-profiles`, async (c) => {
    const parent = runner.resolveCaller(c.req.param("key"), c.req.param("sessionId"));
    if (!parent) return c.json({ error: "not found" }, 404);
    const body = AskChoiceInput.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.issues }, 400);
    const { agentId, ...choice } = body.data;
    return c.json({ askProfiles: (await sessions.setAskProfiles(parent.id, { ...parent.askProfiles, [agentId]: choice })) ?? {} });
  });

  app.post(`${base}/asks`, async (c) => {
    const parent = runner.resolveCaller(c.req.param("key"), c.req.param("sessionId"));
    if (!parent) return c.json({ error: "not found" }, 404);
    const body = AskInput.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.issues }, 400);
    try {
      const view = await runner.ask(parent, body.data);
      const wait = waitSec(c.req.query("wait"));
      return c.json(wait > 0 ? await runner.wait(view.id, wait * 1000) : view, 201);
    } catch (error) {
      if (error instanceof WorkflowError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  });

  /* An ask that failed, timed out or was stopped, picked up where it stopped —
     the same child thread, its conversation intact (`continueAsk`). */
  app.post(`${base}/asks/:id/continue`, async (c) => {
    const parent = runner.resolveCaller(c.req.param("key"), c.req.param("sessionId"));
    if (!parent) return c.json({ error: "not found" }, 404);
    const body = ContinueInput.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.issues }, 400);
    try {
      const view = await runner.continueAsk(parent, c.req.param("id"), body.data.prompt);
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
      const wait = waitSec(c.req.query("wait"));
      const view = await runner.start(parent, body.data.definition, body.data.inputs, true);
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
    const view = wait > 0 ? await runner.wait(id, wait * 1000) : await runner.status(id);
    return view ? c.json(view) : c.json({ error: "no such run" }, 404);
  });

  app.post(`${base}/runs/:id/cancel`, async (c) => {
    const parent = runner.resolveCaller(c.req.param("key"), c.req.param("sessionId"));
    if (!parent) return c.json({ error: "not found" }, 404);
    const id = c.req.param("id");
    runner.cancel(id, "cancelled by the agent", true);
    const view = await runner.status(id);
    return view ? c.json(view) : c.json({ error: "no such run" }, 404);
  });

  /* Hold and release, for the agent that started the run. Idempotent in
     effect: pausing a held run (or resuming a running one) changes nothing and
     answers the run as it stands, so a tool call retried by the runtime is
     harmless. */
  for (const verb of ["pause", "resume"] as const) {
    app.post(`${base}/runs/:id/${verb}`, async (c) => {
      const parent = runner.resolveCaller(c.req.param("key"), c.req.param("sessionId"));
      if (!parent) return c.json({ error: "not found" }, 404);
      const id = c.req.param("id");
      const view = await runner.status(id);
      if (!view) return c.json({ error: "no such run" }, 404);
      runner[verb](id);
      return c.json(await runner.status(id));
    });
  }

  /* Stop a child from its row, whoever owns it: an ask is the runner's,
     anything else the runtime's own (`session/cancel` on the child's id). */
  app.post(`/api/sessions/:id/subagents/:childId/cancel`, async (c) => {
    const session = sessions.get(c.req.param("id"));
    if (!session || session.deletedAt !== null) return c.json({ error: "not found" }, 404);
    const childId = c.req.param("childId");
    if (runner.cancelChild(session.id, childId)) return c.json({ cancelled: true });
    if (await session.bridge?.cancelChild(childId)) return c.json({ cancelled: true });
    return c.json({ error: "no running child with that id on this thread" }, 404);
  });

  /* The same two for the browser, behind the bearer: addressed by the thread
     the run belongs to, which is also the check — a run id is not a
     credential, so one on another thread is "no such run". */
  for (const verb of ["pause", "resume"] as const) {
    app.post(`/api/sessions/:id/workflows/:runId/${verb}`, async (c) => {
      const session = sessions.get(c.req.param("id"));
      if (!session || session.deletedAt !== null) return c.json({ error: "not found" }, 404);
      const runId = c.req.param("runId");
      const view = await runner.statusFor(session.id, runId);
      if (!view) return c.json({ error: "no such run" }, 404);
      if (!runner[verb](runId)) {
        const state = view.status === "paused" ? "already paused" : view.status === "running" ? "already running" : `already ${view.status}`;
        return c.json({ error: `the run is ${state}` }, 409);
      }
      return c.json(await runner.status(runId));
    });
  }
}

function waitSec(raw: string | undefined): number {
  const n = Number(raw ?? 0) || 0;
  return Math.max(0, Math.min(MAX_WAIT_SEC, Math.floor(n)));
}
