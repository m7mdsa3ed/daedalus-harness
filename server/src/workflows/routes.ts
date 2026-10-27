/*
 * Workflow engine v2: the HTTP doors.
 *
 * Two families, registered together because they speak to the same engine:
 *
 *  - `/wf/:key/:sessionId/...` — the loopback the `agents` MCP server drives
 *    (`agents-mcp.ts`, which absorbed the `workflow` server's tools). Outside `/api`, so outside
 *    the bearer check: the derived key in the path is the credential (the
 *    `/gw`/`/ide` rule), and the session id after it names the thread the call
 *    is made for — the only thread whose runs it may start, read or stop.
 *  - `/api/...` — the browser, behind the bearer (index.ts mounts the check on
 *    `/api/*` before the routes register). Addressed by the thread a run belongs
 *    to, which is also the check: a run id is not a credential, so a run of
 *    another thread is "no such run".
 *
 * Bodies are validated by the schemas in route-schemas.ts (re-exported below).
 * A refusal the engine names (`WorkflowError`) carries its own status; a body
 * that does not parse is a 400 with the zod issues, the shape every other
 * route here uses.
 */
import type { Context, Hono } from "hono";
import type { z } from "zod";
import { getProject } from "../projects.js";
import type { Session, SessionManager } from "../sessions.js";
import { WorkflowError, type WorkflowEngine } from "./engine.js";
import {
  ApproveBody,
  AskBody,
  AskChoiceBody,
  ContinueBody,
  LimitQuery,
  RunBody,
  RunSavedBody,
  SaveBody,
  SaveSourceBody,
  ScopeQuery,
  ScriptBody,
  SignalBody,
  StepBody,
} from "./route-schemas.js";
import { deleteSaved, listSaved, saveWorkflow, type ProjectRef } from "./saved.js";
import type { Budgets, RunView } from "./types.js";

export * from "./route-schemas.js";

/** How long one long-poll may hold before answering with the run as it stands.
    Under every agent runtime's MCP tool timeout we know of (codex: 60s). */
const MAX_WAIT_SEC = 55;

function waitSec(raw: string | undefined): number {
  const n = Number(raw ?? 0) || 0;
  return Math.max(0, Math.min(MAX_WAIT_SEC, Math.floor(n)));
}

/** The body as `schema` reads it, or a 400 answer carrying the issues. */
async function parse<S extends z.ZodType>(c: Context, schema: S): Promise<{ ok: true; data: z.infer<S> } | { ok: false; res: Response }> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return { ok: false, res: c.json({ error: parsed.error.issues }, 400) };
  return { ok: true, data: parsed.data };
}

/** An engine refusal answers with the status it named. Anything else is a bug and escapes to `app.onError`. */
async function guarded(c: Context, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof WorkflowError) return c.json({ error: error.message }, error.status);
    throw error;
  }
}

/** Only the keys that were given: the engine spreads these over a definition's own, and an `undefined` would erase one. */
function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** The project of a thread as the saved library names it. */
async function projectRefOf(projectId: string): Promise<(ProjectRef & { cwd: string }) | null> {
  const project = await getProject(projectId);
  return project ? { id: project.id, cwd: project.cwd } : null;
}

export function workflowRoutes(app: Hono, deps: { engine: WorkflowEngine; sessions: SessionManager }): void {
  const { engine, sessions } = deps;
  const base = "/wf/:key/:sessionId";

  /** The thread a loopback path speaks for, or a 404 answer. */
  const caller = (c: Context): Session | null => engine.resolveCaller(c.req.param("key") ?? "", c.req.param("sessionId") ?? "");

  /** A live thread by id, for the browser routes. */
  const thread = (c: Context): Session | null => {
    const session = sessions.get(c.req.param("id") ?? "");
    return session && session.deletedAt === null ? session : null;
  };

  /** A started run answered at once, or — with `?wait=` — as it stands when the wait is up. */
  const started = async (c: Context, view: RunView): Promise<Response> => {
    const wait = waitSec(c.req.query("wait"));
    return c.json(wait > 0 ? ((await engine.wait(view.id, wait * 1000)) ?? view) : view, 201);
  };

  // ===========================================================================
  // Loopback: /wf/:key/:sessionId — the `workflow` and `agents` MCP servers
  // ===========================================================================

  /* A run from a definition. Every run tells its thread when it ends
     (`notify`) — a wait included, because a wait that times out leaves the run
     going. A wait still blocked when it ends is handed the outcome instead, and
     nothing is sent after it. */
  app.post(`${base}/runs`, async (c) => {
    const parent = caller(c);
    if (!parent) return c.json({ error: "not found" }, 404);
    const body = await parse(c, RunBody);
    if (!body.ok) return body.res;
    const { definition, inputs, budgets, priority, concurrencyKey, onRestart } = body.data;
    return guarded(c, async () =>
      started(
        c,
        await engine.start(parent, {
          definition,
          args: inputs,
          ...(budgets ? { budgets: budgets as Budgets } : {}),
          flow: defined({ priority, concurrencyKey }),
          ...(onRestart ? { onRestart } : {}),
          notify: true,
        }),
      ),
    );
  });

  /* A run from a script rather than a definition. Its own route because the
     two payloads have nothing in common: one is a graph to validate, the other
     is a program whose only up-front check is that its `meta` parses. */
  app.post(`${base}/scripts`, async (c) => {
    const parent = caller(c);
    if (!parent) return c.json({ error: "not found" }, 404);
    const body = await parse(c, ScriptBody);
    if (!body.ok) return body.res;
    const { script, name, resumeFromRunId, args, tokenBudget, budgets, priority, concurrencyKey, onRestart } = body.data;
    // `tokenBudget` is the v1 spelling of budgets.tokens; the explicit field wins.
    const merged: Budgets = { ...(tokenBudget !== undefined ? { tokens: tokenBudget } : {}), ...budgets };
    return guarded(c, async () =>
      started(
        c,
        await engine.start(parent, {
          ...(script !== undefined ? { script } : {}),
          ...(name !== undefined ? { name } : {}),
          ...(resumeFromRunId !== undefined ? { resumeFromRunId } : {}),
          ...(args !== undefined ? { args } : {}),
          budgets: merged,
          flow: defined({ priority, concurrencyKey }),
          ...(onRestart ? { onRestart } : {}),
          notify: true,
        }),
      ),
    );
  });

  /* This thread's recent runs, newest first, no steps.
     Every kind is a run here (`kind`: workflow, ask or subagent), and all of
     them are this thread's — the one tool starts all three, so they are one
     list. `?workflows=1` narrows it to the multi-step kind for the surfaces
     that draw cards (`workflow_status` used to be the only reader). */
  app.get(`${base}/runs`, async (c) => {
    const parent = caller(c);
    if (!parent) return c.json({ error: "not found" }, 404);
    const limit = LimitQuery.parse(c.req.query("limit"));
    const workflowsOnly = c.req.query("workflows") === "1";
    // Fetch wide when the one-step runs are filtered out, so a burst of errands does not push every workflow off the page.
    const runs = await engine.listRuns(parent.id, workflowsOnly ? 100 : limit);
    return c.json({ runs: (workflowsOnly ? runs.filter((r) => r.kind === "workflow") : runs).slice(0, limit) });
  });

  /* A run of THIS thread: waiting on, reading and stopping are scoped by the
     thread, not just by the id, so a run id that leaks into another thread's
     context reads as "no such run". The `agents` server's asks are runs too,
     and wait/cancel on them come through here. */
  app.get(`${base}/runs/:id`, async (c) => {
    const parent = caller(c);
    if (!parent) return c.json({ error: "not found" }, 404);
    const id = c.req.param("id");
    const view = await engine.statusFor(parent.id, id);
    if (!view) return c.json({ error: "no such run" }, 404);
    const wait = waitSec(c.req.query("wait"));
    return c.json(wait > 0 ? ((await engine.wait(id, wait * 1000)) ?? view) : view);
  });

  /* Quiet: the caller is the parent's own agent, which hears the outcome in the
     tool's answer — a notification on top would say it twice. */
  app.post(`${base}/runs/:id/cancel`, async (c) => {
    const parent = caller(c);
    if (!parent) return c.json({ error: "not found" }, 404);
    const id = c.req.param("id");
    if (!(await engine.statusFor(parent.id, id))) return c.json({ error: "no such run" }, 404);
    engine.cancel(id, "cancelled by the agent", true);
    const view = await engine.statusFor(parent.id, id);
    return view ? c.json(view) : c.json({ error: "no such run" }, 404);
  });

  /* Hold and release, for the agent that started the run. Idempotent in
     effect: pausing a held run (or resuming a running one) changes nothing and
     answers the run as it stands, so a tool call retried by the runtime is
     harmless. */
  for (const verb of ["pause", "resume"] as const) {
    app.post(`${base}/runs/:id/${verb}`, async (c) => {
      const parent = caller(c);
      if (!parent) return c.json({ error: "not found" }, 404);
      const id = c.req.param("id");
      if (!(await engine.statusFor(parent.id, id))) return c.json({ error: "no such run" }, 404);
      engine[verb](id);
      return c.json(await engine.statusFor(parent.id, id));
    });
  }

  /* An external event for a `waitFor`. It is kept for the next waiter when
     nobody is waiting yet, so `delivered` is "taken", not "consumed". */
  app.post(`${base}/runs/:id/signal`, async (c) => {
    const parent = caller(c);
    if (!parent) return c.json({ error: "not found" }, 404);
    const body = await parse(c, SignalBody);
    if (!body.ok) return body.res;
    const id = c.req.param("id");
    const view = await engine.statusFor(parent.id, id);
    if (!view) return c.json({ error: "no such run" }, 404);
    if (!(await engine.signal(parent.id, id, body.data.name, body.data.value ?? null))) {
      return c.json({ error: `the signal was not delivered: the run is ${view.status}, or the value cannot be carried as JSON, or ${body.data.name}'s unread buffer is full` }, 409);
    }
    return c.json({ delivered: true, run: await engine.statusFor(parent.id, id) });
  });

  /* There is deliberately NO approval door in this family. An `approve()` is a HUMAN gate, and
     this family is reachable by the very agent whose script is waiting on it (the key in the
     path is a credential the agent holds): answering here would let the agent approve its own
     gate. Approvals are answered only by `POST /api/sessions/:id/workflows/:runId/approve`,
     behind the bearer token the person's app holds. `signal` above is the agent's door. */

  /* Saved workflows: the library behind the project and the personal scope,
     mirrored to the `.claude/workflows/` directories Claude Code reads, so
     either tool runs what the other saved. */
  app.get(`${base}/saved`, async (c) => {
    const parent = caller(c);
    if (!parent) return c.json({ error: "not found" }, 404);
    const project = await projectRefOf(parent.projectId);
    if (!project) return c.json({ error: "this thread's project no longer exists" }, 409);
    return c.json({ workflows: await listSaved(project) });
  });

  app.post(`${base}/saved`, async (c) => {
    const parent = caller(c);
    if (!parent) return c.json({ error: "not found" }, 404);
    const body = await parse(c, SaveBody);
    if (!body.ok) return body.res;
    const project = await projectRefOf(parent.projectId);
    if (!project) return c.json({ error: "this thread's project no longer exists" }, 409);
    const source = body.data.script ?? (await engine.scriptOf(parent.id, body.data.runId!));
    if (!source) return c.json({ error: "no script run with that id on this thread" }, 404);
    try {
      return c.json(await saveWorkflow({ source, scope: body.data.scope, project, projectCwd: project.cwd }), 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.delete(`${base}/saved/:name`, async (c) => {
    const parent = caller(c);
    if (!parent) return c.json({ error: "not found" }, 404);
    const project = await projectRefOf(parent.projectId);
    if (!project) return c.json({ error: "this thread's project no longer exists" }, 409);
    const scope = ScopeQuery.parse(c.req.query("scope"));
    const name = decodeURIComponent(c.req.param("name"));
    if (!(await deleteSaved(project, name, scope))) return c.json({ error: `no saved workflow "${name}"` }, 404);
    return c.json({ deleted: name });
  });

  /* The `agents` server's doors. Waiting on and cancelling an ask are the
     `/runs/:id` routes above: an ask is a one-step run. */
  app.get(`${base}/agents`, async (c) => {
    const parent = caller(c);
    if (!parent) return c.json({ error: "not found" }, 404);
    return c.json({ pairs: await engine.pairs(parent) });
  });

  /* What the person chose for each agent on this thread, read and (after they
     answered the picker with "remember") written by the `agents` server. */
  app.get(`${base}/ask-profiles`, (c) => {
    const parent = caller(c);
    if (!parent) return c.json({ error: "not found" }, 404);
    return c.json({ askProfiles: parent.askProfiles });
  });
  app.put(`${base}/ask-profiles`, async (c) => {
    const parent = caller(c);
    if (!parent) return c.json({ error: "not found" }, 404);
    const body = await parse(c, AskChoiceBody);
    if (!body.ok) return body.res;
    const { agentId, ...choice } = body.data;
    return c.json({ askProfiles: (await sessions.setAskProfiles(parent.id, { ...parent.askProfiles, [agentId]: choice })) ?? {} });
  });

  /* One prompt, one worker. Naming no `agent`/`profile` runs it on the caller's
     OWN pair (a subagent, drawn as a plain subagent); naming them makes it an
     ask of that pair. One route because it is one tool — the shape is decided by
     the arguments, never by which door was knocked on. */
  app.post(`${base}/steps`, async (c) => {
    const parent = caller(c);
    if (!parent) return c.json({ error: "not found" }, 404);
    const body = await parse(c, StepBody);
    if (!body.ok) return body.res;
    const { agent, profile } = body.data;
    return guarded(c, async () =>
      started(
        c,
        agent || profile
          ? await engine.ask(parent, body.data)
          : await engine.subagent(parent, {
              prompt: body.data.prompt,
              ...(body.data.description ? { description: body.data.description } : {}),
              ...(body.data.model ? { model: body.data.model } : {}),
              ...(body.data.role ? { role: body.data.role } : {}),
              ...(body.data.effort ? { effort: body.data.effort } : {}),
              ...(body.data.timeoutSec ? { timeoutSec: body.data.timeoutSec } : {}),
            }),
      ),
    );
  });

  /* The `agents` server's original door, kept for a server and a client build
     from either side of the rename: `agent` calls `/steps`, and nothing else
     does. Same body, same handler, so a tool still calling `/asks` is not a
     different code path. */
  app.post(`${base}/asks`, async (c) => {
    const parent = caller(c);
    if (!parent) return c.json({ error: "not found" }, 404);
    const body = await parse(c, AskBody);
    if (!body.ok) return body.res;
    return guarded(c, async () => started(c, await engine.ask(parent, body.data)));
  });

  /* A one-step run picked back up: a NEW run on the SAME child thread, its
     conversation intact. Works on any run that is not running — an ask, a
     subagent, or a workflow run, which is continued by relaunching the step
     that failed with its thread resumed (what `onRestart: "resume"` already
     does after a reboot). */
  app.post(`${base}/runs/:id/continue`, async (c) => {
    const parent = caller(c);
    if (!parent) return c.json({ error: "not found" }, 404);
    const body = await parse(c, ContinueBody);
    if (!body.ok) return body.res;
    const id = c.req.param("id");
    if (!(await engine.statusFor(parent.id, id))) return c.json({ error: "no such run" }, 404);
    return guarded(c, async () => started(c, await engine.continueRun(parent, id, body.data.prompt)));
  });

  /* An ask that failed, timed out or was stopped, picked up where it stopped —
     the same child thread, its conversation intact (`continueAsk`). */
  app.post(`${base}/asks/:id/continue`, async (c) => {
    const parent = caller(c);
    if (!parent) return c.json({ error: "not found" }, 404);
    const body = await parse(c, ContinueBody);
    if (!body.ok) return body.res;
    return guarded(c, async () => started(c, await engine.continueRun(parent, c.req.param("id"), body.data.prompt)));
  });

  // ===========================================================================
  // Browser: /api — behind the bearer
  // ===========================================================================

  /* Stop a child from its row, whoever owns it: an ask is the engine's,
     anything else the runtime's own (`session/cancel` on the child's id). */
  app.post(`/api/sessions/:id/subagents/:childId/cancel`, async (c) => {
    const session = thread(c);
    if (!session) return c.json({ error: "not found" }, 404);
    const childId = c.req.param("childId");
    if (engine.cancelChild(session.id, childId)) return c.json({ cancelled: true });
    if (await session.bridge?.cancelChild(childId)) return c.json({ cancelled: true });
    return c.json({ error: "no running child with that id on this thread" }, 404);
  });

  /* Runs of a thread, newest first (header only; asks included, flagged `ask`). */
  app.get(`/api/sessions/:id/workflows`, async (c) => {
    const session = thread(c);
    if (!session) return c.json({ error: "not found" }, 404);
    return c.json({ runs: await engine.listRuns(session.id, LimitQuery.parse(c.req.query("limit"))) });
  });

  app.get(`/api/sessions/:id/workflows/:runId`, async (c) => {
    const session = thread(c);
    if (!session) return c.json({ error: "not found" }, 404);
    const view = await engine.statusFor(session.id, c.req.param("runId"));
    return view ? c.json(view) : c.json({ error: "no such run" }, 404);
  });

  /* The person's Stop. Not quiet: the parent's agent is told its run was stopped. */
  app.post(`/api/sessions/:id/workflows/:runId/cancel`, async (c) => {
    const session = thread(c);
    if (!session) return c.json({ error: "not found" }, 404);
    const runId = c.req.param("runId");
    const view = await engine.statusFor(session.id, runId);
    if (!view) return c.json({ error: "no such run" }, 404);
    if (!engine.cancel(runId, "stopped by the user")) return c.json({ error: `the run is already ${view.status}` }, 409);
    return c.json(await engine.statusFor(session.id, runId));
  });

  for (const verb of ["pause", "resume"] as const) {
    app.post(`/api/sessions/:id/workflows/:runId/${verb}`, async (c) => {
      const session = thread(c);
      if (!session) return c.json({ error: "not found" }, 404);
      const runId = c.req.param("runId");
      const view = await engine.statusFor(session.id, runId);
      if (!view) return c.json({ error: "no such run" }, 404);
      if (!engine[verb](runId)) {
        const state = view.status === "paused" ? "already paused" : view.status === "running" ? "already running" : `already ${view.status}`;
        return c.json({ error: `the run is ${state}` }, 409);
      }
      return c.json(await engine.statusFor(session.id, runId));
    });
  }

  app.post(`/api/sessions/:id/workflows/:runId/signal`, async (c) => {
    const session = thread(c);
    if (!session) return c.json({ error: "not found" }, 404);
    const body = await parse(c, SignalBody);
    if (!body.ok) return body.res;
    const runId = c.req.param("runId");
    const view = await engine.statusFor(session.id, runId);
    if (!view) return c.json({ error: "no such run" }, 404);
    if (!(await engine.signal(session.id, runId, body.data.name, body.data.value ?? null))) {
      return c.json({ error: `the signal was not delivered: the run is ${view.status}, or the value cannot be carried as JSON` }, 409);
    }
    return c.json({ delivered: true, run: await engine.statusFor(session.id, runId) });
  });

  /* The ONLY door that answers an approve() gate; bearer-gated, so only the person's app reaches it. */
  app.post(`/api/sessions/:id/workflows/:runId/approve`, async (c) => {
    const session = thread(c);
    if (!session) return c.json({ error: "not found" }, 404);
    const body = await parse(c, ApproveBody);
    if (!body.ok) return body.res;
    const runId = c.req.param("runId");
    const view = await engine.statusFor(session.id, runId);
    if (!view) return c.json({ error: "no such run" }, 404);
    const gate = view.gates.find((g) => g.key === body.data.gateKey && g.kind === "approval");
    if (!gate) return c.json({ error: `no approval "${body.data.gateKey}" on this run` }, 404);
    if (gate.status !== "waiting") return c.json({ error: "that approval is already answered" }, 409);
    if (gate.options && !gate.options.includes(body.data.choice)) {
      return c.json({ error: `choice must be one of: ${gate.options.join(", ")}` }, 400);
    }
    if (!(await engine.answerApproval(session.id, runId, body.data.gateKey, body.data.choice, "user"))) {
      return c.json({ error: "the approval could not be answered (already answered, or the run is over)" }, 409);
    }
    return c.json({ answered: true, run: await engine.statusFor(session.id, runId) });
  });

  /* The library, for the Run form and the project page. `projectId` selects
     the project scope; without one only the personal library is visible. */
  app.get(`/api/workflows/saved`, async (c) => {
    const projectId = c.req.query("projectId");
    const project = projectId ? await projectRefOf(projectId) : null;
    if (projectId && !project) return c.json({ error: "no such project" }, 404);
    return c.json({ workflows: await listSaved(project) });
  });

  app.post(`/api/workflows/saved`, async (c) => {
    const body = await parse(c, SaveSourceBody);
    if (!body.ok) return body.res;
    const { source, scope, projectId } = body.data;
    const project = projectId ? await projectRefOf(projectId) : null;
    if (projectId && !project) return c.json({ error: "no such project" }, 404);
    if (scope === "project" && !project) return c.json({ error: "a project workflow needs a projectId" }, 400);
    try {
      return c.json(await saveWorkflow({ source, scope, project, projectCwd: project?.cwd ?? null }), 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  /* `:id` is the library row's id (or its name). `projectId` is needed to see
     a project-scope row; `scope` narrows when the name exists in both. */
  app.delete(`/api/workflows/saved/:id`, async (c) => {
    const projectId = c.req.query("projectId");
    const project = projectId ? await projectRefOf(projectId) : null;
    if (projectId && !project) return c.json({ error: "no such project" }, 404);
    const id = decodeURIComponent(c.req.param("id"));
    if (!(await deleteSaved(project, id, ScopeQuery.parse(c.req.query("scope"))))) return c.json({ error: "not found" }, 404);
    return c.json({ deleted: id });
  });

  /*
   * The Run button: start a saved workflow with `args`.
   *
   * TODO(engine): `WorkflowEngine.start` takes a PARENT thread (`Session`) — the run hangs
   * on it, notifies it, shows its card in its transcript and is capped per parent. There is
   * no door for a parentless run (no `startDetached`, and `workflow_runs.parent_session_id`
   * is the only owner). So the button must name the thread it hangs on (`sessionId`, a live
   * thread of this project); without one this answers 501 until the engine grows a
   * parentless owner (a project-scoped run with no transcript to mirror into).
   */
  app.post(`/api/projects/:id/workflows/run`, async (c) => {
    const body = await parse(c, RunSavedBody);
    if (!body.ok) return body.res;
    const projectId = c.req.param("id");
    if (!(await getProject(projectId))) return c.json({ error: "no such project" }, 404);
    if (!body.data.sessionId) {
      return c.json(
        {
          error:
            "not implemented: the engine has no parentless run — pass sessionId, the thread of this project the run should hang on (TODO: a project-owned run in WorkflowEngine)",
        },
        501,
      );
    }
    const parent = sessions.get(body.data.sessionId);
    if (!parent || parent.deletedAt !== null || parent.projectId !== projectId) {
      return c.json({ error: "sessionId is not a live thread of this project" }, 404);
    }
    return guarded(c, async () => {
      const view = await engine.start(parent, {
        name: body.data.name,
        ...(body.data.args !== undefined ? { args: body.data.args } : {}),
        ...(body.data.budgets ? { budgets: body.data.budgets as Budgets } : {}),
        trigger: { kind: "user" },
        notify: true,
      });
      return c.json(view, 201);
    });
  });
}
