/*
 * The request bodies of workflows/routes.ts, as zod schemas.
 *
 * Their own module (re-exported from routes.ts) for one reason: routes.ts
 * reaches the database through the project and session modules, and a schema
 * is worth testing without one. This file imports zod, `graph.ts` (zod only)
 * and nothing else.
 */
import { z } from "zod";
import { BudgetsSchema } from "./graph.js";

/** The name a `waitFor` waits on (sandbox.ts: /^[\w.-]{1,80}$/). */
export const SIGNAL_NAME_RE = /^[\w.-]{1,80}$/;

/** What every way of starting a run can say about how it runs. */
const FlowFields = {
  budgets: BudgetsSchema.optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  concurrencyKey: z.string().min(1).max(80).optional(),
  onRestart: z.enum(["resume", "rerun", "fail"]).optional(),
};

/** `POST …/runs`: a declarative definition (the engine validates it in full). */
export const RunBody = z.object({
  definition: z.record(z.string(), z.unknown()),
  inputs: z.record(z.string(), z.unknown()).optional(),
  ...FlowFields,
});

/** `POST …/scripts`: a script, a saved workflow's name or a run to relaunch. `tokenBudget` is the v1 spelling of `budgets.tokens`. */
export const ScriptBody = z.object({
  script: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  resumeFromRunId: z.string().min(1).optional(),
  args: z.unknown().optional(),
  tokenBudget: z.number().int().positive().optional(),
  ...FlowFields,
});

/** `POST …/saved` (loopback): the script of one of this thread's runs, or source given directly. */
export const SaveBody = z
  .object({
    runId: z.string().min(1).optional(),
    script: z.string().min(1).optional(),
    scope: z.enum(["project", "personal"]).default("project"),
  })
  .refine((b) => (b.runId === undefined) !== (b.script === undefined), { message: "give either runId or script, not both and not neither" });

/** `POST /api/workflows/saved`: save from source, for a person. */
export const SaveSourceBody = z.object({
  source: z.string().min(1),
  scope: z.enum(["project", "personal"]).default("project"),
  projectId: z.string().min(1).optional(),
});

export const SignalBody = z.object({
  name: z.string().regex(SIGNAL_NAME_RE, "a signal name matches /^[\\w.-]{1,80}$/"),
  value: z.unknown().optional(),
});

export const ApproveBody = z.object({
  gateKey: z.string().min(1).max(200),
  choice: z.string().min(1).max(80),
});

/** `POST /api/projects/:id/workflows/run`: the Run button. */
export const RunSavedBody = z.object({
  name: z.string().min(1),
  args: z.unknown().optional(),
  budgets: BudgetsSchema.optional(),
  /** The thread the run hangs on. The engine has no parentless run, so the button names one. */
  sessionId: z.string().min(1).optional(),
});

/** The one-step body both an ask and a subagent share. `agent`/`profile` absent
    means the caller's own pair (a subagent); naming either makes it an ask. */
export const AskBody = z.object({
  profile: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
  prompt: z.string().min(1).max(20_000),
  description: z.string().min(1).max(120).optional(),
  projectId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  /** A helper role (`model-roles.md`), resolved on the server for the caller's
      own pair. Only meaningful with no `agent`/`profile`: the map names models
      in the caller's catalog. */
  role: z.string().min(1).max(80).optional(),
  effort: z.string().min(1).optional(),
  timeoutSec: z.number().int().positive().optional(),
});

export const ContinueBody = z.object({ prompt: z.string().max(20_000).optional() });

/** `POST …/steps`: one prompt handed to a worker. With no `agent`/`profile` it
    runs on the caller's own pair — a subagent; with them, on that pair — an ask.
    One shape, because it is one tool (`agent`) and one engine path. */
export const StepBody = AskBody;

/** A model role to resolve on the server (`model-roles.ts`): the role map names
    models in *the caller's* catalog, so a role is only meaningful on its own
    pair. Validated in the handler, where the thread is known. */
export const RoleBody = z.object({ role: z.string().min(1).max(80).optional() });

export const AskChoiceBody = z.object({
  agentId: z.string().min(1),
  profileId: z.string().min(1),
  model: z.string().min(1).optional(),
});

/** `?limit=` of a run list: 1..100, default 50. */
export const LimitQuery = z.coerce.number().int().min(1).max(100).catch(50);

/** `?scope=` of a saved-workflow delete. */
export const ScopeQuery = z.enum(["project", "personal"]).optional().catch(undefined);
