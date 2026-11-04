/*
 * Workflow engine v2: the run lifecycle.
 *
 * Replaces v1 `WorkflowRunner` (workflows.ts). One engine, one journal: a run
 * is a script (a JSON definition is compiled to one by graph.ts) executed by
 * the sandbox, whose every await point is a journaled event. This file owns
 * what surrounds that: starting (validation, caps, the header row), the
 * per-run services the pure core and the gates need (clocks that stand still
 * while paused, a slot scheduler, budgets, the parent's inbox, a shell), the
 * run's pause / cancel / finish, the live view, notifications and the boot
 * recovery that RESUMES a run from its journal instead of failing it.
 *
 * Where things live:
 *   drive.ts   the pure replay core (keys, replay, budgets, slots). Injected store + step runner.
 *   step.ts    one agent step (child thread, retries, JSON repair, mirroring).
 *   gates.ts   approve / sleep / waitFor / sh / artifact / state.
 *   limits.ts  PausableTimer, FlowScheduler, BudgetTracker.
 *
 * `ask` / `continueAsk` are thin wrappers over the same path: a one-step script
 * whose only call is `agent(prompt, {profile, agent, …})`, drawn as a plain
 * subagent (`_meta.daedalus.ask`), capped apart from workflows.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type * as acp from "../acp.js";
import { stanceFor, type AutonomyPolicy } from "../autonomy.js";
import { DATA_DIR } from "../config.js";
import { HttpError } from "../http-error.js";
import { derive } from "../loopback-secret.js";
import { safeKeyEqual } from "../gateway-shim.js";
import { listModelRoles } from "../model-roles.js";
import { getProfile } from "../profiles.js";
import { getProject, type Project } from "../projects.js";
import { getAgent, modelRoleDefs } from "../registry.js";
import type { ThreadEvent } from "../protocol.js";
import { createScheduled, fire } from "../scheduler.js";
import { threadCwd, type Session, type SessionManager } from "../sessions.js";
import { drive, usageOf, wallSecOf, type DriveOutcome, type RunStore, type SlotScheduler, type StepCall, type StepOutcome, type StepRunner, type StoredHeader } from "./drive.js";
import { foldRun } from "./fold.js";
import { Gates } from "./gates.js";
import {
  InputsSchema,
  WorkflowDefinitionSchema,
  compileDefinition,
  describe,
  missingInputs,
  validateOutput,
} from "./graph.js";
import { Journal } from "./journal.js";
import { BudgetTracker, FlowScheduler, PausableTimer, type BudgetKind } from "./limits.js";
import { ScriptError, extractMeta } from "./sandbox.js";
import { loadSaved } from "./saved.js";
import { listPairs, runAgentStep, type AgentPair, type AskInfo, type StepContext } from "./step.js";
import {
  ENGINE_LIMITS,
  canon,
  isTerminal,
  type Budgets,
  type FlowControl,
  type JournalEvent,
  type JournalPayload,
  type OnRestart,
  type RunKind,
  type RunSpec,
  type RunStatus,
  type RunView,
  type Trigger,
  runKindOf,
} from "./types.js";

export type { AgentPair, AskInfo, RunKind };

/** The cap per kind — split by shape on purpose: consulting two agents must not
    lock a thread out of a workflow, and a fan-out of subagents must not take
    every workflow slot. The numbers are `ENGINE_LIMITS`', beside every other
    engine ceiling, so they are tuned in one place. */
const CAPS: Record<RunKind, number> = {
  ask: ENGINE_LIMITS.asksPerParent,
  subagent: ENGINE_LIMITS.subagentsPerParent,
  workflow: ENGINE_LIMITS.runsPerParent,
};

/** Which kind a live run or a stored spec is (`runKindOf` in types.ts, so the
    notification here and the `kind` the fold reports cannot disagree). */
const kindOfRun = (run: { ask: AskInfo | null; spec: EngineSpec }): RunKind => runKindOf(run.spec);
const kindOfSpec = (spec: EngineSpec): RunKind => runKindOf(spec);
/** How long a finished run stays readable from memory. */
const GRACE_MS = 10 * 60_000;
/** A cancel waits this long for its steps to unwind before it writes the run's end. */
const UNWIND_MS = 5_000;
const NOTIFY_BYTES = 32 * 1024;

export class WorkflowError extends HttpError {
  declare status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message, status);
  }
}

/** What the engine keeps on `RunSpec` beyond the contract (jsonb, so extra keys survive). */
type EngineSpec = RunSpec & {
  /** Run-level wall clock (paused time excluded) that FAILS the run. Absent = none at all. */
  totalTimeoutSec?: number;
  /** Set when the run is an ask: the pair it went to. */
  ask?: AskInfo;
  /** A one-step run on the thread's OWN pair — a subagent. Drawn as a plain
      subagent (no `ask` chip, no workflow card), capped on its own, and
      continued like an ask by resuming its child thread. */
  subagent?: true;
  /** An ask's or a subagent's pass-through agent() options (projectId, model,
      effort, timeoutSec), kept so a continue repeats them. */
  askOptions?: Record<string, unknown>;
  /** The brief of a one-step run, kept so a continue can name it again (the
      original prompt is inside `source` and not worth parsing back out). */
  stepPrompt?: string;
};

/** An ask's child: allow every permission, park every question (for the
    parent to answer), no timer and no deadline beyond the step's own. */
export const ASK_AUTONOMY: AutonomyPolicy = {
  permissions: { default: "allow" },
  elicitations: "ask",
  askTimeoutSeconds: 0,
  askFallback: "cancel",
  maxRunSeconds: 0,
};

/** A run in a list: header only, no journal read. */
export interface RunSummary {
  id: string;
  name: string;
  status: RunStatus;
  error: string | null;
  createdAt: number;
  endedAt: number | null;
  trigger: Trigger;
  /** Kept for the client's existing reader; `kind` is the whole answer. */
  ask: boolean;
  kind: RunKind;
}

export interface StartInput {
  definition?: unknown;
  script?: string;
  name?: string;
  args?: unknown;
  budgets?: Budgets;
  flow?: FlowControl;
  trigger?: Trigger;
  notify?: boolean;
  onRestart?: OnRestart;
  resumeFromRunId?: string;
  /** Run-level wall clock in seconds that fails the run (not persisted by the contract; see `EngineSpec`). */
  totalTimeoutSec?: number;
}

export interface AskInput {
  profile?: string;
  agent?: string;
  prompt: string;
  /** The errand in the caller's words: titles the child and its row. */
  description?: string;
  /** Run in another project than the caller's; omitted = the caller's own. */
  projectId?: string;
  model?: string;
  /** A helper role — refused here: the role map names models in the caller's
      own catalog, so a role means nothing to another pair. */
  role?: string;
  effort?: string;
  timeoutSec?: number;
}

export interface EngineOptions {
  port: number;
  /** Tests / alternative storage. Default: the Postgres journal. */
  store?: RunStore;
  scheduler?: SlotScheduler & { dropRun?(runId: string): void };
  /** Test seams (default: the real project / profile tables, the real step runner, `fire`). */
  lookups?: { project?(id: string): Promise<Project | undefined>; profile?(id: string): Promise<unknown> };
  stepRunner?: StepRunner;
  notify?(parentId: string, text: string): void;
  /** How long a cancel waits for its steps to unwind (default 5 s). */
  unwindMs?: number;
}

/** The Postgres-backed `RunStore`. */
export function journalStore(): RunStore {
  const journal = new Journal();
  return {
    createRun: (row) => Journal.createRun(row),
    append: (runId, key, payload) => journal.append(runId, key, payload),
    events: (runId, since) => journal.events(runId, since),
    header: (runId) => journal.header(runId),
    setStatus: (runId, status, error, endedAt, result) => journal.setStatus(runId, status, error, endedAt, result),
    listRunsForParent: (parentId, limit) => journal.listRunsForParent(parentId, limit),
    runningRuns: () => journal.runningRuns(),
  };
}

// ---- one live run ------------------------------------------------------------------

interface Parked {
  id: string;
  withdrawn: boolean;
  resolve(choice: string | null): void;
  bridge: NonNullable<Session["bridge"]> | null;
  requestId: string | null;
  poll: ReturnType<typeof setInterval> | null;
  timer: PausableTimer | null;
}

interface Run {
  id: string;
  parent: Session;
  project: Project;
  spec: EngineSpec;
  ask: AskInfo | null;
  kind: RunKind;
  notify: boolean;
  createdAt: number;
  status: RunStatus;
  error: string | null;
  endedAt: number | null;
  result: unknown;
  events: JournalEvent[];
  abort: AbortController;
  /** Aborted by a shutdown: write nothing, the next boot resumes the run. */
  detached: boolean;
  /** Set by cancel / a clock / a budget timer: beats whatever the script returns. */
  forced: { status: Exclude<RunStatus, "running" | "paused">; error: string | null } | null;
  finalized: boolean;
  /** Set only once `finalize` has served the waiters and decided on the notification. */
  settled: boolean;
  /** Source loads in flight (`workflow(ref)`), so two parallel loads of one ref journal once. */
  loading: Map<string, Promise<string>>;
  tracker: BudgetTracker;
  gates: Gates;
  timers: Set<PausableTimer>;
  total: PausableTimer | null;
  wall: PausableTimer | null;
  children: Set<Session>;
  inflight: Set<Promise<unknown>>;
  parked: Map<string, Parked>;
  askSeq: number;
  waiters: ((view: RunView) => void)[];
  resumeWaiters: (() => void)[];
  priorEvents?: readonly JournalEvent[];
  driving: Promise<void> | null;
  writes: Promise<unknown>;
}

type UpdateEvent = Extract<ThreadEvent, { ev: "update" }>;

export class WorkflowEngine {
  private key = derive("wf");
  private runs = new Map<string, Run>();
  private store: RunStore;
  private scheduler: SlotScheduler & { dropRun?(runId: string): void };
  /** Runs rebuilt at boot and waiting for `resumeRecovered()`. */
  private recovering: Run[] = [];
  /** Launches past their cap check and not yet in `runs` (the createRun await), by parent + kind. */
  private launching = new Map<string, number>();
  /** Set by `shutdown()`: nothing new starts on an engine that is stopping. */
  private closed = false;

  constructor(
    private manager: SessionManager,
    private opts: EngineOptions,
  ) {
    this.store = opts.store ?? journalStore();
    this.scheduler = opts.scheduler ?? new FlowScheduler(ENGINE_LIMITS.liveChildren);
  }

  private getProject(id: string): Promise<Project | undefined> {
    return (this.opts.lookups?.project ?? getProject)(id);
  }

  private getProfile(id: string): Promise<unknown> {
    return (this.opts.lookups?.profile ?? getProfile)(id);
  }

  /** Whether a thread still has an ask or run going: asked by the session manager whenever it
      builds a bridge (`setRunsActive` is the bridge's, and a new bridge starts false) and by
      the idle sweep. */
  hasLive(parentId: string): boolean {
    for (const run of this.runs.values()) {
      if (run.parent.id === parentId && !run.detached && !isTerminal(run.status)) return true;
    }
    return false;
  }

  private assertOpen(): void {
    if (this.closed) throw new WorkflowError("the server is shutting down — try again after it restarts", 409);
  }

  // ---- loopback identity (unchanged from v1) ----------------------------------

  /** What a thread's `workflow` MCP server is handed: the loopback address that
      names it. The key is the credential — `/wf` is outside the bearer check. */
  urlFor(session: Pick<Session, "id">): string {
    return `http://127.0.0.1:${this.opts.port}/wf/${this.key}/${session.id}`;
  }

  /** The same loopback key under `/hm`, for the `harness` MCP server. */
  harnessUrlFor(session: Pick<Session, "id">): string {
    return `http://127.0.0.1:${this.opts.port}/hm/${this.key}/${session.id}`;
  }

  /** The thread a `/wf/<key>/<sessionId>` path speaks for, or null. */
  resolveCaller(key: string, sessionId: string): Session | null {
    if (!safeKeyEqual(key, this.key)) return null;
    const session = this.manager.get(sessionId);
    return session && session.deletedAt === null ? session : null;
  }

  // ---- start ---------------------------------------------------------------------

  /** Validate and start a run. Throws `WorkflowError`. */
  async start(parent: Session, input: StartInput): Promise<RunView> {
    this.assertOpen();
    if (parent.parentSessionId) throw new WorkflowError("a workflow step cannot start a workflow", 409);
    let source: string | undefined = input.script;
    let args = input.args;
    let meta;
    let budgets: Budgets = { ...input.budgets };
    let flow: FlowControl = { ...input.flow };
    let onRestart: OnRestart = input.onRestart ?? "resume";
    let totalTimeoutSec = input.totalTimeoutSec;
    let priorEvents: JournalEvent[] | undefined;
    let trigger: Trigger = input.trigger ?? { kind: "agent" };

    if (input.resumeFromRunId) {
      const prior = await this.store.header(input.resumeFromRunId);
      if (!prior || prior.parentSessionId !== parent.id) throw new WorkflowError("nothing to resume: no such run on this thread", 404);
      const live = this.runs.get(prior.id);
      if ((live && !isTerminal(live.status)) || !isTerminal(prior.status)) {
        throw new WorkflowError("that run is still going — cancel it before relaunching it", 409);
      }
      source ??= prior.spec.source;
      if (args === undefined) args = prior.spec.args;
      priorEvents = await this.store.events(prior.id);
      trigger = { kind: "resume", fromRunId: prior.id };
      budgets = { ...prior.spec.budgets, ...input.budgets };
      flow = { ...prior.spec.flow, ...input.flow };
      onRestart = input.onRestart ?? prior.spec.onRestart;
    }

    if (input.definition !== undefined) {
      const parsed = WorkflowDefinitionSchema.safeParse(input.definition);
      if (!parsed.success) throw new WorkflowError(`invalid workflow: ${issues(parsed.error)}`);
      const def = parsed.data;
      const inputsParsed = InputsSchema.safeParse(args ?? {});
      if (!inputsParsed.success) throw new WorkflowError(`invalid inputs: ${issues(inputsParsed.error)}`);
      const missing = missingInputs(def, inputsParsed.data);
      if (missing.length) throw new WorkflowError(`the definition reads inputs that were not given: ${missing.join(", ")}`);
      const compiled = compileDefinition(def);
      source = compiled.source;
      meta = compiled.meta;
      args = inputsParsed.data;
      budgets = { ...def.budgets, ...input.budgets };
      flow = {
        concurrency: def.maxParallel,
        ...(def.priority !== undefined ? { priority: def.priority } : {}),
        ...(def.concurrencyKey ? { concurrencyKey: def.concurrencyKey } : {}),
        ...input.flow,
      };
      onRestart = input.onRestart ?? def.onRestart;
      totalTimeoutSec ??= def.totalTimeoutSec;
    }

    const project = await this.getProject(parent.projectId);
    if (!project) throw new WorkflowError("this thread's project no longer exists", 409);
    if (source === undefined && input.name) {
      try {
        source = await loadSaved({ id: project.id, cwd: project.cwd }, threadCwd(parent, project), input.name);
      } catch (error) {
        throw new WorkflowError(describe(error), 404);
      }
    }
    if (typeof source !== "string" || !source.trim()) {
      throw new WorkflowError("give a definition, a script, a saved workflow's name, or a run to resume");
    }
    if (!meta) {
      try {
        meta = extractMeta(source);
      } catch (error) {
        throw new WorkflowError(describe(error));
      }
    }
    if (meta.inputs && args !== undefined) {
      try {
        const checked = validateOutput(meta.inputs, args);
        if (!checked.ok) throw new WorkflowError(`invalid args: ${checked.issues}`);
      } catch (error) {
        if (error instanceof WorkflowError) throw error;
        // A schema this server cannot compile is the author's to fix, not a reason to refuse the run.
      }
    }
    if (!(await this.getProfile(parent.profileId))) throw new WorkflowError("this thread's profile no longer exists", 409);

    const spec: EngineSpec = {
      source,
      meta,
      args: args === undefined ? null : canon(jsonClone(args)),
      budgets: cleanBudgets(budgets),
      flow: cleanFlow(flow),
      trigger,
      onRestart,
      ...(totalTimeoutSec ? { totalTimeoutSec: Math.min(totalTimeoutSec, ENGINE_LIMITS.totalTimeoutSec.max) } : {}),
    };
    return await this.launch(parent, project, spec, { notify: input.notify ?? false, kind: "workflow", priorEvents });
  }

  // ---- ask (a one-step run) ---------------------------------------------------------

  /** The (profile, agent) pairs a thread may `ask`. */
  pairs(parent: Session): Promise<AgentPair[]> {
    return listPairs(parent);
  }

  /**
   * Put one prompt to another (profile, agent) pair as a child thread of this
   * one and answer with its reply: a one-step run, so the spawn, the mirroring,
   * the cost, the clocks and the cancel are the workflow's own. Each side is
   * matched by id or by name (case-insensitive); the pair must be exactly one
   * of `pairs`. One level, like a step: a child cannot ask.
   */
  async ask(parent: Session, input: AskInput): Promise<RunView> {
    this.assertOpen();
    if (parent.parentSessionId) throw new WorkflowError("a subagent cannot ask another agent", 409);
    if (input.role) {
      throw new WorkflowError(
        `a role cannot cross to another pair: "${input.role}" names a model in this thread's own catalog. Drop the role, or name the model that profile serves`,
      );
    }
    const prompt = input.prompt.trim();
    if (!prompt) throw new WorkflowError("prompt must not be empty");
    const is = (id: string, name: string, q: string) => id === q || name.toLowerCase() === q.trim().toLowerCase();
    const all = await this.pairs(parent);
    /* The person's choice for this thread outranks whatever the model passed:
       the point of setting it is that the model does not get to pick. An ask
       that names no agent goes to the one agent the thread has a choice for,
       when there is exactly one. */
    let { profile, agent, model } = input;
    const preset = Object.entries(parent.askProfiles);
    const named = agent ? all.find((p) => is(p.agentId, p.agent, agent!)) : undefined;
    const set = named ? ([named.agentId, parent.askProfiles[named.agentId]] as const) : !agent && preset.length === 1 ? preset[0]! : undefined;
    if (set?.[1]) {
      agent = set[0];
      profile = set[1].profileId;
      model = set[1].model ?? model;
    }
    if (!profile || !agent) {
      throw new WorkflowError("no profile chosen for this agent on this thread — ask the user which profile to use (list_agents shows them)", 409);
    }
    const [wantProfile, wantAgent] = [profile, agent];
    const hits = all.filter((p) => is(p.profileId, p.profile, wantProfile) && is(p.agentId, p.agent, wantAgent));
    const known = () => all.map((p) => `${p.profile} / ${p.agent}`).join(", ") || "none";
    if (hits.length === 0) throw new WorkflowError(`no profile "${wantProfile}" with agent "${wantAgent}" — available: ${known()}`, 404);
    if (hits.length > 1) throw new WorkflowError(`"${wantProfile}" / "${wantAgent}" matches ${hits.length} pairs — name the profile by id`);
    const pair = hits[0]!;
    const projectId = input.projectId && input.projectId !== parent.projectId ? input.projectId : undefined;
    if (projectId && !(await this.getProject(projectId))) throw new WorkflowError(`no project "${projectId}"`, 404);
    if (!pair.installed) throw new WorkflowError(`${pair.agent} is not installed on this server`, 409);
    const description = input.description?.trim() || undefined;
    const name = description ? `Ask ${pair.agent}: ${description}` : `Ask ${pair.agent}`;
    return await this.launchAsk(parent, {
      name,
      prompt,
      pair,
      description,
      options: {
        ...(projectId ? { projectId } : {}),
        ...(model ? { model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(input.timeoutSec ? { timeoutSec: Math.min(input.timeoutSec, ENGINE_LIMITS.stepTimeoutSec.max) } : {}),
      },
    });
  }

  /**
   * A one-step run on the calling thread's OWN pair — a subagent, with every
   * one of a workflow's guarantees: a real thread that can be opened, that
   * survives a restart, that is counted against a cap and stopped the same way.
   * The step inherits the parent's profile, agent, model, effort and mode, as a
   * workflow step already does.
   */
  async subagent(
    parent: Session,
    input: {
      prompt: string;
      description?: string;
      /** Exact model id: wins over `role`. */
      model?: string;
      /** A helper role (`model-roles.md`), resolved here against the profile's
          catalog — the same lookup the runtime does for its own `task`. */
      role?: string;
      effort?: string;
      timeoutSec?: number;
      /** Another project to work in; absent or the thread's own = the thread's cwd. */
      projectId?: string;
    },
  ): Promise<RunView> {
    this.assertOpen();
    if (parent.parentSessionId) throw new WorkflowError("a subagent cannot hand work to another agent", 409);
    const prompt = input.prompt.trim();
    if (!prompt) throw new WorkflowError("prompt must not be empty");
    const project = await this.getProject(parent.projectId);
    if (!project) throw new WorkflowError("this thread's project no longer exists", 409);
    if (!(await this.getProfile(parent.profileId))) throw new WorkflowError("this thread's profile no longer exists", 409);
    const model = input.role ? await this.resolveRole(parent, input.role, input.model) : input.model;
    const projectId = input.projectId && input.projectId !== parent.projectId ? input.projectId : undefined;
    if (projectId && !(await this.getProject(projectId))) throw new WorkflowError(`no project "${projectId}"`, 404);
    const description = input.description?.trim() || undefined;
    return await this.launchOneStep(
      parent,
      project,
      {
        name: description ?? firstWords(prompt),
        prompt,
        description,
        options: {
          ...(projectId ? { projectId } : {}),
          ...(model ? { model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
          ...(input.timeoutSec ? { timeoutSec: Math.min(input.timeoutSec, ENGINE_LIMITS.stepTimeoutSec.max) } : {}),
        },
        kind: "subagent",
      },
    );
  }

  /**
   * Pick ANY run back up where it stopped.
   *
   * A one-step run continues on its own child thread, keeping its
   * conversation. A workflow run is relaunched from its journal
   * (`resumeFromRunId`): the script replays from the top, every call identical
   * to one that already completed answers from the journal without spawning or
   * costing anything, and only the failed, stopped or new calls run — which is
   * exactly what recovery does after a reboot. **A call that did not complete
   * does not start over**: it resumes the child thread that attempt left, so a
   * failed step's conversation survives the continue the way an ask's does
   * (`continueAsk`). A prompt cannot steer a script
   * (a changed prompt is a *new* call, by the replay rules), so one is refused
   * rather than quietly ignored.
   */
  async continueRun(parent: Session, runId: string, prompt?: string): Promise<RunView> {
    this.assertOpen();
    const live = this.runs.get(runId);
    if (live && !isTerminal(live.status)) throw new WorkflowError("that run is still going — wait for it instead", 409);
    const header = await this.store.header(runId);
    if (!header || header.parentSessionId !== parent.id) throw new WorkflowError("no such run on this thread", 404);
    if (!isTerminal(header.status)) throw new WorkflowError(`that run is ${header.status} — wait for it or stop it first`, 409);
    const spec = header.spec as EngineSpec;
    if (kindOfSpec(spec) === "workflow") {
      if (prompt?.trim()) {
        throw new WorkflowError(
          "a workflow run cannot be steered by a prompt: its steps are the script's. Send a new workflow for different words, or continue it as it stands",
        );
      }
      return await this.start(parent, { resumeFromRunId: runId, notify: true });
    }
    return await this.continueAsk(parent, runId, prompt);
  }

  /**
   * Pick a one-step run back up where it stopped — an ask's or a subagent's —
   * as a new run on the *same* child thread, which keeps its conversation
   * through a timeout, a cancel or a failure (`retire` kills the process, never
   * the log). The pair and the brief are the original's, so nothing is picked
   * or asked a second time.
   */
  async continueAsk(parent: Session, askId: string, prompt?: string): Promise<RunView> {
    this.assertOpen();
    const live = this.runs.get(askId);
    if (live && !isTerminal(live.status)) throw new WorkflowError("that run is still going — wait for it instead", 409);
    const header = await this.store.header(askId);
    if (!header || header.parentSessionId !== parent.id) throw new WorkflowError("no such run on this thread", 404);
    const spec = header.spec as EngineSpec;
    const one = spec.ask ? "ask" : spec.subagent ? "subagent" : null;
    if (!one) throw new WorkflowError("that is a multi-step run — continue it with a prompt of its own", 409);
    const view = await this.viewOf(header);
    const childId = view.steps.find((s) => s.sessionId)?.sessionId ?? null;
    if (!childId || this.manager.get(childId)?.parentSessionId !== parent.id) {
      throw new WorkflowError("that child's thread is gone — start a new one", 409);
    }
    const project = await this.getProject(parent.projectId);
    if (!project) throw new WorkflowError("this thread's project no longer exists", 409);
    const options = { ...(spec.askOptions ?? {}), resumeSession: childId };
    const text = prompt?.trim() || "Continue where you left off and finish the task.";
    return await this.launchOneStep(parent, project, {
      name: header.name,
      prompt: text,
      description: spec.ask?.description ?? (one === "subagent" ? header.name : undefined),
      options,
      ...(one === "ask" && spec.ask
        ? { pair: { agent: spec.ask.agent, profile: spec.ask.profile, agentId: spec.ask.agentId, profileId: spec.ask.profileId } }
        : {}),
      kind: one,
    });
  }

  /**
   * A helper role as a model id, for a one-step run on the caller's own pair.
   *
   * Resolved on the SERVER, unlike the runtime's own lookup, for two reasons:
   * the tool that asks may be any runtime (`agent` is offered to all of them),
   * and a role only means anything in the caller's catalog — the map names
   * models another pair very likely does not serve, which is why a role on
   * another pair is an error rather than a translation. `modelRoleDefs` is the
   * same resolution the spawn uses, so a role picked here is the model the
   * thread's own `task` would have picked. An unknown role is an answer naming
   * the known ones, never a silent fallback.
   */
  private async resolveRole(parent: Session, role: string, explicitModel?: string): Promise<string | undefined> {
    const [agent, profile, vocabulary] = await Promise.all([getAgent(parent.agentId), getProfile(parent.profileId), listModelRoles()]);
    const known = vocabulary.map((r) => r.id).join(", ") || "(none)";
    if (!agent || !profile) throw new WorkflowError("this thread's profile or agent no longer exists", 409);
    const defs = modelRoleDefs(agent, profile, vocabulary, parent.helperModels, parent.model);
    const wanted = role.trim().toLowerCase();
    const def = defs.find((d) => d.id === role.trim()) ?? defs.find((d) => d.label.toLowerCase() === wanted);
    if (!def) throw new WorkflowError(`unknown role "${role}" — this thread has: ${defs.map((d) => d.id).join(", ") || known}`);
    /* An unassigned role resolves to the session model, as it does at spawn. */
    return explicitModel ?? def.model;
  }

  /** The body both one-step paths share: the same script, the same spec, the
      same notification — only what the spec carries says which it is. */
  private async launchOneStep(
    parent: Session,
    project: Project,
    a: {
      name: string;
      prompt: string;
      description?: string;
      /** Absent = the parent's own pair. */
      pair?: { agent: string; profile: string; agentId: string; profileId: string };
      options: Record<string, unknown>;
      kind: "ask" | "subagent";
    },
  ): Promise<RunView> {
    const info: AskInfo | null = a.pair ? { ...a.pair, ...(a.description ? { description: a.description } : {}) } : null;
    const options = {
      label: a.kind,
      /* What the child's row reads as: the errand in the caller's words, else
         the first few words of the brief (see `titles.ts`). */
      ...(a.description ? { title: a.description } : {}),
      ...(info ? { profile: info.profileId, agent: info.agentId } : {}),
      ...a.options,
    };
    const meta = info
      ? { name: a.name, description: `Ask ${info.agent} · ${info.profile}`, phases: [] }
      : { name: a.name, description: a.description ?? "Subagent", phases: [] };
    const source = `export const meta = ${lit(meta)};\nreturn await agent(${lit(a.prompt)}, ${lit(options)});\n`;
    const spec: EngineSpec = {
      source,
      meta,
      args: null,
      budgets: {},
      flow: { concurrency: 1 },
      trigger: { kind: "agent" },
      onRestart: "resume",
      ...(info ? { ask: info } : { subagent: true as const }),
      askOptions: a.options,
      stepPrompt: a.prompt,
    };
    /* `notify`: an answer that outlives the call's own wait arrives as a
       <task-notification>, as a background workflow's does, so the caller is
       never left polling. One that lands inside a wait is handed to that waiter
       instead, and no message says it twice. */
    return await this.launch(parent, project, spec, { notify: true, kind: a.kind });
  }

  private async launchAsk(
    parent: Session,
    a: {
      name: string;
      prompt: string;
      pair: { agent: string; profile: string; agentId: string; profileId: string };
      description?: string;
      options: Record<string, unknown>;
    },
  ): Promise<RunView> {
    const project = await this.getProject(parent.projectId);
    if (!project) throw new WorkflowError("this thread's project no longer exists", 409);
    return await this.launchOneStep(parent, project, { ...a, kind: "ask" });
  }

  // ---- launch / recover -------------------------------------------------------------

  private async launch(
    parent: Session,
    project: Project,
    spec: EngineSpec,
    o: { notify: boolean; kind: RunKind; priorEvents?: JournalEvent[] },
  ): Promise<RunView> {
    this.assertOpen();
    /* The cap counts runs already standing AND launches that passed this check and are still
       awaiting their row (`createRun` is async): without the second term ten concurrent calls
       all read "0 active". Reserved before the first await, released once the run is in `runs`
       (or the launch failed). Keyed by the parent's id, not its object. */
    const slot = `${parent.id}:${o.kind}`;
    const active = [...this.runs.values()].filter((r) => r.parent.id === parent.id && kindOfRun(r) === o.kind && !isTerminal(r.status)).length;
    const inFlight = this.launching.get(slot) ?? 0;
    const cap = CAPS[o.kind];
    if (active + inFlight >= cap) {
      throw new WorkflowError(
        o.kind === "ask"
          ? `this thread already has ${active + inFlight} asks running — wait for or cancel one first`
          : o.kind === "subagent"
            ? `this thread already has ${active + inFlight} subagents running — wait for or cancel one first`
            : `this thread already has ${active + inFlight} workflow(s) running — wait for or cancel one first`,
        409,
      );
    }
    this.launching.set(slot, inFlight + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const n = (this.launching.get(slot) ?? 1) - 1;
      if (n <= 0) this.launching.delete(slot);
      else this.launching.set(slot, n);
    };
    const id = randomUUID();
    const now = Date.now();
    let created = false;
    try {
      const first = await this.store.createRun({
        id,
        parentSessionId: parent.id,
        projectId: project.id,
        name: spec.meta.name,
        spec,
        notify: o.notify,
        createdAt: now,
      });
      created = true;
      if (this.closed) throw new WorkflowError("the server is shutting down — try again after it restarts", 409);
      const run = this.buildRun({
        id,
        parent,
        project,
        spec,
        ask: spec.ask ?? null,
        kind: o.kind,
        notify: o.notify,
        createdAt: now,
        status: "running",
        events: [first],
        ...(o.priorEvents ? { priorEvents: o.priorEvents } : {}),
      });
      release(); // the run is in `runs` now and counts as active
      this.startDrive(run);
      return this.view(run);
    } catch (error) {
      release();
      if (created) {
        // A row with no driver would read "running" forever (and be resumed at the next boot).
        this.runs.delete(id);
        const message = describe(error);
        await this.store.append(id, null, { kind: "run_finished", status: "failed", error: message, result: null }).catch(() => {});
        await this.store.setStatus(id, "failed", message, Date.now()).catch(() => {});
        this.manager.setRunsActive(parent.id, this.hasLive(parent.id));
      }
      throw error;
    }
  }

  private buildRun(o: {
    id: string;
    parent: Session;
    project: Project;
    spec: EngineSpec;
    ask: AskInfo | null;
    kind: RunKind;
    notify: boolean;
    createdAt: number;
    status: RunStatus;
    events: JournalEvent[];
    priorEvents?: readonly JournalEvent[];
  }): Run {
    const run = {
      id: o.id,
      parent: o.parent,
      project: o.project,
      spec: o.spec,
      ask: o.ask,
      kind: o.kind,
      notify: o.notify,
      createdAt: o.createdAt,
      status: o.status,
      error: null,
      endedAt: null,
      result: undefined,
      events: o.events,
      abort: new AbortController(),
      detached: false,
      forced: null,
      finalized: false,
      settled: false,
      loading: new Map(),
      tracker: new BudgetTracker(o.spec.budgets),
      timers: new Set(),
      total: null,
      wall: null,
      children: new Set(),
      inflight: new Set(),
      parked: new Map(),
      askSeq: 0,
      waiters: [],
      resumeWaiters: [],
      priorEvents: o.priorEvents,
      driving: null,
      writes: Promise.resolve(),
    } as unknown as Run;

    // Resumed state: spend so far, so budgets and clocks continue rather than restart.
    const used = usageOf(o.events);
    run.tracker.seed(used);
    if (o.status === "paused") run.tracker.pauseClock();
    run.gates = new Gates(this.gateHost(run), run.priorEvents);

    if (run.kind !== "ask") {
      /* Armed only when the run names one: an unset `totalTimeoutSec` is no wall
         clock at all, not a default somebody else chose (it used to be two hours,
         which failed long workflows by themselves). `budgets.wallSec` is the
         explicit budget and stays its own clock. */
      const totalSec = run.spec.totalTimeoutSec === undefined
        ? null
        : Math.min(run.spec.totalTimeoutSec, ENGINE_LIMITS.totalTimeoutSec.max);
      if (totalSec !== null) {
        run.total = this.clock(run, Math.max(1_000, (totalSec - used.wallSec) * 1000), () =>
          this.markEnding(run, "failed", `timed out after ${totalSec}s`),
        );
      }
    }
    const wallSec = run.spec.budgets.wallSec;
    if (wallSec !== undefined) {
      run.wall = this.clock(run, Math.max(0, (wallSec - used.wallSec) * 1000), () =>
        this.markEnding(run, "budget_exceeded", "budget exceeded: wallSec"),
      );
    }
    this.runs.set(run.id, run);
    this.manager.setRunsActive(run.parent.id, true);
    return run;
  }

  private startDrive(run: Run): void {
    if (run.driving) return;
    const gates = run.gates;
    const outcome = drive({
      runId: run.id,
      spec: run.spec,
      append: (key, payload) => this.append(run, key, payload),
      events: () => run.events,
      ...(run.priorEvents ? { priorEvents: run.priorEvents } : {}),
      runStep: (call) => (this.opts.stepRunner ? this.opts.stepRunner(call) : this.runStep(run, call)),
      scheduler: this.scheduler,
      tracker: run.tracker,
      gateHooks: gates.hooks(),
      signal: run.abort.signal,
      whenRunning: () => this.whenRunning(run),
      loadWorkflow: (ref) => this.loadWorkflow(run, ref),
      onReplayed: (step) => {
        /* A step answered from the journal never spawns, so nothing says its end on the parent's
           transcript this boot; the card would sit on "running". The client dedups a repeat. */
        if (step.sessionId) this.manager.emitOn(run.parent.id, stateUpdate(step.sessionId, step.kind));
      },
      onLog: (message) => this.logLine(run, message),
      flush: () => gates.flush(),
    });
    run.driving = outcome.then(
      (o) => this.finalize(run, o),
      (error: unknown) => this.finalize(run, { status: "failed", error: describe(error), result: null, budget: null }),
    );
  }

  /**
   * `workflow(ref)`: a saved workflow's source, journaled the first time a ref loads and served
   * from the journal ever after, so an edit to the file (or the ref moving) between a crash and
   * the replay cannot hand the script different code than the one that ran.
   */
  private loadWorkflow(run: Run, ref: string | { scriptPath: string }): Promise<string> {
    const refKey = typeof ref === "string" ? ref : `path:${ref.scriptPath}`;
    const journaled = run.events.find((e) => e.payload.kind === "workflow_loaded" && e.payload.ref === refKey);
    if (journaled && journaled.payload.kind === "workflow_loaded") return Promise.resolve(journaled.payload.source);
    const inflight = run.loading.get(refKey);
    if (inflight) return inflight;
    const load = (async () => {
      let source: string;
      try {
        source = await loadSaved({ id: run.project.id, cwd: run.project.cwd }, threadCwd(run.parent, run.project), ref);
      } catch (error) {
        throw new ScriptError(describe(error));
      }
      const sha = createHash("sha256").update(source).digest("hex");
      await this.append(run, `workflow:${sha.slice(0, 16)}`, { kind: "workflow_loaded", ref: refKey, sha, source });
      return source;
    })();
    run.loading.set(refKey, load);
    void load.then(
      () => run.loading.delete(refKey),
      () => run.loading.delete(refKey),
    );
    return load;
  }

  /**
   * Boot. For each run the last process left running or paused: rebuild it from
   * its header and journal, and (unless `resume` is false) resume it by
   * replaying the script — completed keys answer from the journal, unresolved
   * gates resume, an in-flight step follows its `onRestart` policy.
   *
   * A run whose parent thread is not loaded (deleted, or the row is gone) is
   * marked failed 'parent thread unavailable after restart' and the parent is
   * told through a scheduled message, as v1 did for every run. The parent's
   * process is NOT needed to resume: a step spawns its own child, and the
   * finishing notification revives the parent through `fire`.
   *
   * With `resume: false` the runs are registered (readable, cancellable) but
   * nothing spawns until `resumeRecovered()` — for a caller that wants agent
   * adoption (`DAEDALUS_SANDBOX=hosted`) to claim its threads first.
   */
  async recoverAtBoot(opts: { resume?: boolean } = {}): Promise<void> {
    await this.manager.ready;
    const rows = await this.store.runningRuns();
    let failedCount = 0;
    for (const row of rows) {
      if (this.runs.has(row.id)) continue;
      const parent = this.manager.get(row.parentSessionId);
      let events = await this.store.events(row.id);
      /* The journal already ends the run (the crash fell between `run_finished` and the row):
         fix the row up from it. Driving it again would re-run a finished script. The parent
         was never told — `finalize` tells it only after the row is written, and a waiter's
         tool call died with the process — so it is told now, by the same scheduled message
         `failRow` leaves. */
      const finished = events.find((e) => e.payload.kind === "run_finished");
      if (finished && finished.payload.kind === "run_finished") {
        const { status, error, result } = finished.payload;
        await this.store
          .setStatus(row.id, status, error, finished.at, result ?? null)
          .catch((e: unknown) => console.error(`[workflows] could not fix up run ${row.id.slice(0, 8)}`, e));
        if (parent && parent.deletedAt === null) {
          await this.notifyLater(row, foldRun({ ...row, status, error, endedAt: finished.at }, events));
        }
        continue;
      }
      if (!parent || parent.deletedAt !== null) {
        await this.failRow(row, events, "parent thread unavailable after restart", false);
        failedCount += 1;
        continue;
      }
      const project = await this.getProject(parent.projectId);
      if (!project || !(await this.getProfile(parent.profileId))) {
        await this.failRow(row, events, "parent thread unavailable after restart", true);
        failedCount += 1;
        continue;
      }
      /* The downtime is not run time: `run_recovered` closes the running stretch at the last event
         before the crash and reopens it here (`wallSecOf`). Written BEFORE the run is built so the
         clocks it seeds from already exclude the gap. */
      try {
        events = [...events, await this.store.append(row.id, null, { kind: "run_recovered" })];
      } catch (error) {
        console.error(`[workflows] could not journal the recovery of run ${row.id.slice(0, 8)}`, error);
      }
      const spec = { ...(row.spec as EngineSpec), args: canon((row.spec as EngineSpec).args) };
      const run = this.buildRun({
        id: row.id,
        parent,
        project,
        spec,
        ask: spec.ask ?? null,
        kind: kindOfSpec(spec),
        notify: row.notify,
        createdAt: row.createdAt,
        status: row.status === "paused" ? "paused" : "running",
        events,
      });
      this.recovering.push(run);
    }
    if (this.recovering.length || failedCount) {
      console.log(`[workflows] recovered ${this.recovering.length} run(s) from the journal, failed ${failedCount}`);
    }
    if (opts.resume !== false) this.resumeRecovered();
  }

  /** Start driving the runs `recoverAtBoot` registered. Idempotent. */
  resumeRecovered(): void {
    for (const run of this.recovering.splice(0)) {
      if (run.finalized || isTerminal(run.status)) continue; // cancelled before it resumed
      if (run.status === "paused") this.emitState(run);
      // The bridge may have been built since registration (or not yet): say it again now.
      this.manager.setRunsActive(run.parent.id, true);
      this.startDrive(run);
    }
  }

  private async failRow(row: StoredHeader, events: JournalEvent[], error: string, tellParent: boolean): Promise<void> {
    const at = Date.now();
    const finish: JournalPayload = { kind: "run_finished", status: "failed", error, result: null };
    await this.store.append(row.id, null, finish).catch(() => {});
    await this.store.setStatus(row.id, "failed", error, at).catch(() => {});
    const view = foldRun({ ...row, status: "failed", error, endedAt: at }, [...events, { runId: row.id, seq: Number.MAX_SAFE_INTEGER, at, key: null, payload: finish }]);
    if (!tellParent) return;
    // The parent's log is told, so a reopened thread shows the steps as disconnected
    // rather than forever running.
    for (const s of view.steps) {
      if (s.sessionId && (s.status === "running" || s.status === "retrying")) {
        this.manager.emitOn(row.parentSessionId, stateUpdate(s.sessionId, "disconnected"));
      }
    }
    await this.notifyLater(row, view);
  }

  /** A run's end told to its parent from boot, when the run asked to be (`notify`). A
      scheduled message rather than a prompt now: boot has not adopted the agents yet,
      and the scheduler starts after it has. */
  private async notifyLater(row: StoredHeader, view: RunView): Promise<void> {
    if (!row.notify) return;
    const text = notification(view, kindOfSpec(row.spec as EngineSpec));
    if (this.opts.notify) return this.opts.notify(row.parentSessionId, text);
    await createScheduled({ sessionId: row.parentSessionId, text, nextAt: Date.now(), ephemeral: true }).catch(() => {});
  }

  // ---- reads ----------------------------------------------------------------------------

  async status(runId: string): Promise<RunView | null> {
    const run = this.runs.get(runId);
    if (run) return this.view(run);
    const header = await this.store.header(runId);
    return header ? await this.viewOf(header) : null;
  }

  /** `status`, but only for a run of that thread's. */
  async statusFor(parentId: string, runId: string): Promise<RunView | null> {
    const run = this.runs.get(runId);
    if (run) return run.parent.id === parentId ? this.view(run) : null;
    const header = await this.store.header(runId);
    return header && header.parentSessionId === parentId ? await this.viewOf(header) : null;
  }

  /** A thread's runs, newest first. */
  async listRuns(parentId: string, limit = 50): Promise<RunSummary[]> {
    const rows = await this.store.listRunsForParent(parentId, limit);
    return rows.map((row) => {
      const live = this.runs.get(row.id);
      return {
        id: row.id,
        name: row.name,
        status: live ? live.status : row.status,
        error: live ? live.error : row.error,
        createdAt: row.createdAt,
        endedAt: live ? live.endedAt : row.endedAt,
        trigger: row.spec.trigger,
        ask: !!(row.spec as EngineSpec).ask,
        kind: kindOfSpec(row.spec as EngineSpec),
      };
    });
  }

  /** A script run's source, for saving it — only a run of that thread's. */
  async scriptOf(parentId: string, runId: string): Promise<string | null> {
    const header = await this.store.header(runId);
    return header && header.parentSessionId === parentId ? header.spec.source : null;
  }

  /** The run's view once it is over, or as it stands when `timeoutMs` runs out. */
  wait(runId: string, timeoutMs: number): Promise<RunView | null> {
    const run = this.runs.get(runId);
    if (!run) return this.status(runId);
    /* `settled`, not `finalized`: between the two the run's end is still being written and the
       notification is still undecided. A wait that returned early there would be told the outcome
       while `finalize` — seeing no waiter — sent it again as a message. Registered instead, the
       waiter is served by `finalize` and the notification is withheld. */
    if (run.settled || run.detached) return Promise.resolve(this.view(run));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        run.waiters = run.waiters.filter((w) => w !== done);
        resolve(this.view(run));
      }, timeoutMs);
      const done = (view: RunView) => {
        clearTimeout(timer);
        resolve(view);
      };
      run.waiters.push(done);
    });
  }

  private async viewOf(header: StoredHeader): Promise<RunView> {
    const view = foldRun(header, await this.store.events(header.id));
    if (view.result === undefined && header.result !== null && header.result !== undefined) view.result = header.result;
    return view;
  }

  /** Re-folded from the in-memory journal on every read: an event is in `run.events` the
      moment its append resolves, so a read after an `await append()` never misses it. */
  private view(run: Run): RunView {
    const view = foldRun(
      {
        id: run.id,
        name: run.spec.meta.name,
        status: run.status,
        error: run.error,
        createdAt: run.createdAt,
        endedAt: run.endedAt,
        spec: run.spec,
      },
      run.events,
    );
    if (view.result === undefined && run.result !== undefined) view.result = run.result;
    return view;
  }

  // ---- control -----------------------------------------------------------------------------

  /** `quiet`: the caller is the parent's own agent, which hears the outcome in the tool's answer. */
  cancel(runId: string, reason = "cancelled", quiet = false): boolean {
    const run = this.runs.get(runId);
    if (!run || isTerminal(run.status)) return false;
    if (quiet) run.notify = false;
    this.markEnding(run, "cancelled", reason);
    return true;
  }

  /** The person's Stop on a one-step run's row (an ask, or a subagent on the parent's own
      pair): the run, found by the child thread it spawned. Not quiet — the parent is told it
      was stopped. A workflow step is its card's to stop. */
  cancelChild(parentId: string, childId: string): boolean {
    for (const run of this.runs.values()) {
      if (run.kind === "workflow" || run.parent.id !== parentId || isTerminal(run.status)) continue;
      if (this.view(run).steps.some((s) => s.sessionId === childId)) return this.cancel(run.id, "stopped by the user");
    }
    return false;
  }

  /**
   * Hold the run. No pending step starts; every running step that can be paused
   * (its thread's agent advertises a pause) holds at its next step boundary; a
   * step that cannot runs to its end. Every clock stops: the run's and every
   * step's timers, the backoffs, the approval timeouts, and the budget's wall
   * clock. A cancel would throw the step away — the whole reason this is a state
   * of the run and not a cancel-and-restart.
   */
  pause(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running") return false;
    run.status = "paused";
    run.tracker.pauseClock();
    for (const t of run.timers) t.pause();
    run.total?.pause();
    run.wall?.pause();
    for (const child of run.children) {
      if (child.bridge?.canPause) void child.bridge.pause().catch(() => {});
    }
    this.persistStatus(run, "paused");
    this.journal(run, null, { kind: "run_paused" });
    this.emitState(run);
    return true;
  }

  resume(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.status !== "paused") return false;
    run.status = "running";
    run.tracker.resumeClock();
    for (const t of run.timers) t.resume();
    run.total?.resume();
    run.wall?.resume();
    for (const child of run.children) {
      if (child.bridge?.paused) void child.bridge.resume().catch(() => {});
    }
    this.persistStatus(run, "running");
    this.journal(run, null, { kind: "run_resumed" });
    this.emitState(run);
    for (const w of run.resumeWaiters.splice(0)) w();
    return true;
  }

  /** Deliver an external signal to a run of that thread's. False when nobody is waiting and the name is unknown. */
  async signal(parentId: string, runId: string, name: string, value: unknown): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run || run.parent.id !== parentId || isTerminal(run.status)) return false;
    return await run.gates.signal(name, value);
  }

  /** Answer a parked approval by its gate key. */
  async answerApproval(parentId: string, runId: string, gateKey: string, choice: string, by: string): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run || run.parent.id !== parentId || isTerminal(run.status)) return false;
    return await run.gates.answerApproval(gateKey, choice, by);
  }

  /** The parent's process is gone (retired, deleted, crashed): nobody is waiting on the
      answer any more, and its steps must not run on. */
  cancelForParent(parentId: string, reason: string): void {
    for (const run of this.runs.values()) {
      if (run.parent.id === parentId && !isTerminal(run.status)) this.markEnding(run, "cancelled", reason);
    }
  }

  /**
   * The server is stopping. Unlike v1 this does NOT end the runs: each is
   * detached (its steps stop, nothing more is written) and its row stays
   * `running`, so the next boot's `recoverAtBoot` resumes it from the journal.
   */
  shutdown(): void {
    this.closed = true;
    for (const run of this.runs.values()) {
      if (run.finalized) continue;
      run.detached = true;
      this.clearClocks(run);
      this.endParked(run);
      run.abort.abort();
      for (const w of run.resumeWaiters.splice(0)) w();
      const view = this.view(run);
      for (const w of run.waiters.splice(0)) w(view);
    }
  }

  // ---- finishing ------------------------------------------------------------------------------

  /** Flip the run to a terminal status in memory NOW (so the caps, `cancel` and reads see it)
      and abort; `finalize` writes the end once the script has unwound. */
  private markEnding(run: Run, status: Exclude<RunStatus, "running" | "paused">, error: string | null): void {
    // A detached run (server shutdown) is resumed by the next boot, not ended by the parent's process going away.
    if (run.detached || run.forced || run.finalized || isTerminal(run.status)) return;
    run.forced = { status, error };
    run.status = status;
    run.error = error;
    run.endedAt = Date.now();
    this.clearClocks(run);
    run.abort.abort();
    for (const w of run.resumeWaiters.splice(0)) w();
    this.manager.setRunsActive(run.parent.id, this.anyLive(run.parent.id, run));
    // Not driving yet (a recovered run nobody resumed): nothing will unwind, end it now.
    if (!run.driving) void this.finalize(run, { status, error, result: null, budget: null });
  }

  private async finalize(run: Run, outcome: DriveOutcome): Promise<void> {
    if (run.finalized) return;
    if (run.detached) {
      // A shutdown: the row stays as it was, the journal holds the truth, the next boot resumes.
      run.finalized = true;
      return;
    }
    run.finalized = true;
    const status = run.forced?.status ?? outcome.status;
    const error = run.forced ? run.forced.error : outcome.error;
    run.status = status;
    run.error = error;
    run.endedAt = run.endedAt ?? Date.now();
    run.result = canon(outcome.result);
    /* Whatever fails below, the waiters are served and the parent is told: a run that ended must
       never leave `wait` hanging or the parent un-notified because a write threw. */
    let detached = false;
    try {
      this.clearClocks(run);
      this.endParked(run);
      if (!run.abort.signal.aborted) run.abort.abort(); // reaps abandoned `race` losers and stragglers
      for (const w of run.resumeWaiters.splice(0)) w();
      // Let the steps unwind (they journal their own end) before the run's end is written.
      if (run.inflight.size) {
        await Promise.race([Promise.allSettled([...run.inflight]), new Promise((r) => setTimeout(r, this.opts.unwindMs ?? UNWIND_MS).unref())]);
      }
      /* A child that outlived the window (a step wedged past UNWIND_MS) has nobody left to retire
         it. A shutdown keeps them: the next boot adopts what is still running. */
      if (!run.detached) {
        for (const child of [...run.children]) {
          try {
            this.manager.retire(child);
          } catch {
            /* already gone */
          }
        }
        run.children.clear();
      }
      // Pause / resume status writes and journal writes share this chain, so the end below is last.
      await run.writes.catch(() => {});
      if (run.detached) {
        detached = true; // a shutdown arrived while unwinding: it already served the waiters
        return;
      }
      try {
        await this.append(run, null, { kind: "run_finished", status, error, result: run.result ?? null });
      } catch {
        /* the row below is still the durable verdict */
      }
      await this.store.setStatus(run.id, status, error, run.endedAt, run.result ?? null).catch((e: unknown) =>
        console.error(`[workflows] could not save run ${run.id.slice(0, 8)}`, e),
      );
    } catch (e) {
      console.error(`[workflows] finalizing run ${run.id.slice(0, 8)} failed`, e);
    } finally {
      if (!detached) {
        try {
          this.scheduler.dropRun?.(run.id);
          this.manager.setRunsActive(run.parent.id, this.anyLive(run.parent.id, run));
        } catch (e) {
          console.error(`[workflows] cleanup of run ${run.id.slice(0, 8)} failed`, e);
        }
        const view = this.view(run);
        /* Someone blocked in `wait` is handed the outcome right here, so a message
           saying it again would be news twice. A wait that arrived while we were writing is
           in `waiters` too (it only short-cuts once `settled`). */
        const told = run.waiters.length > 0;
        for (const w of run.waiters.splice(0)) w(view);
        run.settled = true;
        if (run.notify && !told) {
          const text = notification(view, run.kind);
          if (this.opts.notify) this.opts.notify(run.parent.id, text);
          else void fire(run.parent.id, text, this.manager);
        }
        // Kept for status reads until the parent is done with it; the journal is the durable record.
        setTimeout(() => {
          if (this.runs.get(run.id) === run) this.runs.delete(run.id);
        }, GRACE_MS).unref();
      }
    }
  }

  private anyLive(parentId: string, except: Run): boolean {
    return [...this.runs.values()].some((r) => r !== except && r.parent.id === parentId && !isTerminal(r.status));
  }

  // ---- per-run services ------------------------------------------------------------------------

  private async append(run: Run, key: string | null, payload: JournalPayload): Promise<JournalEvent> {
    /* A detached run (server shutdown) writes nothing, as `shutdown` promises: the abort makes
       the script unwind, and a compiled definition logs every in-flight step as "failed: the
       run was cancelled" and every dependent as skipped on its way out. Journaled, those lines
       were replayed by the next boot as already said — the reader saw a cancellation that never
       happened, and the replay's log count no longer matched what the script will say. */
    if (run.detached) throw new WorkflowError("the server is shutting down — the run resumes at the next boot", 409);
    const event = await this.store.append(run.id, key, payload);
    run.events.push(event);
    return event;
  }

  /** A journal write nobody awaits (pause, resume): failures are logged by the store. */
  private journal(run: Run, key: string | null, payload: JournalPayload): void {
    run.writes = run.writes.then(() => this.append(run, key, payload)).catch(() => {});
  }

  /** On the same chain as the journal writes, so a late `paused` can never land after the run's
      final status (`finalize` awaits the chain before writing the end). */
  private persistStatus(run: Run, status: RunStatus): void {
    run.writes = run.writes.then(() => this.store.setStatus(run.id, status, null, null)).catch(() => {});
  }

  /** Resolves when the run is running or over — what a step waits on before sending a prompt into a hold. */
  private whenRunning(run: Run): Promise<void> {
    if (run.status !== "paused") return Promise.resolve();
    return new Promise((resolve) => run.resumeWaiters.push(resolve));
  }

  /** A clock that stands still while the run is paused; born held if the run is. */
  private clock(run: Run, ms: number, fn: () => void): PausableTimer {
    let timer: PausableTimer;
    timer = new PausableTimer(ms, () => {
      run.timers.delete(timer);
      fn();
    });
    run.timers.add(timer);
    if (run.status === "paused") timer.pause();
    return timer;
  }

  private clearClocks(run: Run): void {
    for (const t of run.timers) t.clear();
    run.timers.clear();
    run.total?.clear();
    run.wall?.clear();
  }

  private runStep(run: Run, call: StepCall): Promise<StepOutcome> {
    const ctx: StepContext = {
      runId: run.id,
      runName: run.spec.meta.name,
      manager: this.manager,
      parent: run.parent,
      signal: run.abort.signal,
      detached: () => run.detached,
      cancelReason: () => run.error,
      ask: run.ask,
      /* Without it `announce` stamps a one-step subagent as a one-step workflow, and the
         client draws a "0/1 steps" card where a plain subagent row belongs. */
      subagent: run.kind === "subagent",
      /* An ask grants every permission: the call is the person's go-ahead for its brief. A
         subagent on the parent's own pair is the same bargain — the call WAS the go-ahead —
         and what no policy can answer still parks, repeated on the parent. */
      ...(run.kind === "workflow" ? {} : { autonomy: ASK_AUTONOMY }),
      /* A step carries no clock unless it names `timeoutSec` — same bargain as the
         run's own. `stepTimeoutSec.default` is null, so the ternary is only kept to
         say out loud that an ask has never had one. */
      defaultTimeoutSec: ENGINE_LIMITS.stepTimeoutSec.default,
      defaultOnRestart: run.spec.onRestart,
      recovered: call.recovered,
      ...(call.resume ? { resume: call.resume } : {}),
      placement: () => call.placement,
      whenRunning: () => this.whenRunning(run),
      timer: (ms, fn) => {
        const timer = this.clock(run, ms, fn);
        return {
          clear: () => {
            timer.clear();
            run.timers.delete(timer);
          },
        };
      },
      append: (key, payload) => this.append(run, key, payload),
      track: (child) => {
        /* A child created after the run was cancelled (the create raced the abort) has no one
           left to retire it. A detached run keeps its children: the next boot adopts them. */
        if (run.abort.signal.aborted && !run.detached) {
          this.manager.retire(child);
          return;
        }
        run.children.add(child);
        if (run.status === "paused" && child.bridge?.canPause) void child.bridge.pause().catch(() => {});
      },
      untrack: (child) => {
        run.children.delete(child);
      },
    };
    const p = runAgentStep(ctx, call.spec, call.key, call.name);
    run.inflight.add(p);
    const done = () => run.inflight.delete(p);
    p.then(done, done);
    return p;
  }

  /** The script's own narration, on the parent's transcript where the run is. */
  private logLine(run: Run, message: string): void {
    this.manager.emitOn(run.parent.id, {
      ev: "update",
      seq: 0,
      historyReplay: false,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `${message}\n` },
        _meta: { daedalus: { workflowLog: { runId: run.id } } },
      },
    });
  }

  /** The run's hold, said on the parent — journaled with the spawns it holds, so a
      replayed card stands still where the live one did. */
  private emitState(run: Run): void {
    this.manager.emitOn(run.parent.id, {
      ev: "update",
      seq: 0,
      historyReplay: false,
      update: { sessionUpdate: "_daedalus/workflow_state", runId: run.id, paused: run.status === "paused" },
    });
  }

  // ---- the gates' host -------------------------------------------------------------------------

  private gateHost(run: Run) {
    return {
      runId: run.id,
      append: (key: string | null, payload: JournalPayload) => this.append(run, key, payload),
      events: () => run.events as readonly JournalEvent[],
      signal: run.abort.signal,
      whenRunning: () => this.whenRunning(run),
      timer: (ms: number): Promise<boolean> =>
        new Promise<boolean>((resolve) => {
          if (run.abort.signal.aborted) return resolve(false);
          let onAbort = () => {};
          const timer = this.clock(run, ms, () => {
            run.abort.signal.removeEventListener("abort", onAbort);
            resolve(true);
          });
          onAbort = () => {
            timer.clear();
            run.timers.delete(timer);
            resolve(false);
          };
          run.abort.signal.addEventListener("abort", onAbort, { once: true });
        }),
      now: () => Date.now(),
      artifactDir: async () => {
        const dir = join(DATA_DIR, "workflows", run.id, "artifacts");
        await mkdir(dir, { recursive: true });
        return dir;
      },
      cwd: () => threadCwd(run.parent, run.project),
      ask: (question: { text: string; options: string[]; timeoutSec?: number }) => this.park(run, question),
      withdraw: (id: string) => this.unpark(run, id),
      exec: (cmd: string, o: { cwd: string; timeoutSec: number }) => this.exec(run, cmd, o),
    };
  }

  /**
   * Put a question where the person is: the PARENT's `bridge.park`, so it shows in the
   * cross-thread inbox (`GET /api/pending`), in the parent's transcript as a permission
   * card, and fires the push when nobody is attached. A permission-shaped request is the
   * door the inbox can answer in one click (`answerPending`); the options map onto
   * `allow_once` (the first) and `reject_once` (the rest), and the option's name is the
   * text. The park is marked `humanOnly`, so a parent's autonomy policy (a routine's blanket
   * allow) never answers an approval for the person.
   *
   * If the parent has no live process yet (a run resumed at boot before its parent is
   * revived), the question is parked as soon as the parent has one: re-tried every 3s.
   */
  private park(run: Run, q: { text: string; options: string[]; timeoutSec?: number }): { id: string; answer: Promise<string | null> } {
    const id = `q${++run.askSeq}`;
    let resolveAnswer!: (choice: string | null) => void;
    const answer = new Promise<string | null>((resolve) => (resolveAnswer = resolve));
    const parked: Parked = { id, withdrawn: false, resolve: resolveAnswer, bridge: null, requestId: null, poll: null, timer: null };
    run.parked.set(id, parked);

    const tryPark = (): boolean => {
      const bridge = run.parent.bridge;
      if (parked.withdrawn || !bridge || run.parent.exited) return false;
      const title = `Workflow “${run.spec.meta.name}” asks: ${q.text}`;
      const toolCallId = `wf-${run.id}-${id}`;
      const sessionId = bridge.acpSessionId ?? run.parent.id;
      const request: acp.RequestPermissionRequest = {
        sessionId,
        toolCall: {
          toolCallId,
          title,
          kind: "other",
          status: "pending",
          rawInput: { workflow: run.spec.meta.name, runId: run.id, question: q.text },
        },
        options: q.options.map((name, i) => ({ optionId: `o${i}`, name, kind: i === 0 ? "allow_once" : "reject_once" })),
      };
      /* `humanOnly`: an approval is a person's call. The parent's autonomy policy (a routine's
         blanket allow, an auto-decline, an ask timeout) must neither answer it nor time it out,
         so it no longer needs to hide as a form elicitation; and nothing is auto-answered, so the
         gate can never journal a policy's answer as `by: "timeout"`. */
      const settled = bridge.park<unknown>("permission", request, toolCallId, { humanOnly: true });
      parked.bridge = bridge;
      for (const [requestId, entry] of bridge.pending) {
        if (entry.payload === request) parked.requestId = requestId;
      }
      void settled.then((response) => {
        if (parked.withdrawn) return resolveAnswer(null);
        const choice = decodeAnswer(response, q.options);
        // `undefined` = the process went away under the question (a close answers "cancelled"):
        // not an answer. The run is cancelled with its parent; waiting keeps the gate unresolved
        // in the journal instead of recording a timeout nobody chose.
        if (choice !== undefined) return resolveAnswer(choice);
        /* The SAME live bridge cancelled it (someone dismissed the card, or a cancel swept the
           pending map): re-parking would put the identical question straight back, forever. That
           is a "no". Only a bridge that is no longer the parent's live one — a respawn, a retire —
           means the question was lost with the process and is asked again on the next. */
        const current = run.parent.bridge;
        if (current === bridge && !run.parent.exited) return resolveAnswer(null);
        // Park it again on whatever process the parent has next.
        parked.bridge = null;
        parked.requestId = null;
        if (!parked.poll && !run.abort.signal.aborted) {
          parked.poll = setInterval(() => {
            if (tryPark() && parked.poll) {
              clearInterval(parked.poll);
              parked.poll = null;
            }
          }, 3_000);
          parked.poll.unref();
        }
      });
      return true;
    };

    if (!tryPark()) {
      parked.poll = setInterval(() => {
        if (tryPark() && parked.poll) {
          clearInterval(parked.poll);
          parked.poll = null;
        }
      }, 3_000);
      parked.poll.unref();
    }
    if (q.timeoutSec !== undefined) {
      parked.timer = this.clock(run, Math.max(0, q.timeoutSec * 1000), () => {
        this.unpark(run, id);
        resolveAnswer(null);
      });
    }
    return { id, answer };
  }

  /** Take a parked question back (answered elsewhere, timed out, run cancelled). */
  private unpark(run: Run, id: string): void {
    const parked = run.parked.get(id);
    if (!parked) return;
    run.parked.delete(id);
    parked.withdrawn = true;
    if (parked.poll) clearInterval(parked.poll);
    if (parked.timer) {
      parked.timer.clear();
      run.timers.delete(parked.timer);
    }
    const bridge = parked.bridge;
    if (bridge && parked.requestId && bridge.pending.has(parked.requestId)) {
      const entry = bridge.pending.get(parked.requestId)!;
      // Clears the card on every peer; the answer is ours, so nothing is waiting on it.
      bridge.answer(
        parked.requestId,
        entry.kind === "permission" ? { outcome: { outcome: "cancelled" } } : { action: "cancel" },
      );
    }
    parked.resolve(null);
  }

  private endParked(run: Run): void {
    for (const id of [...run.parked.keys()]) this.unpark(run, id);
  }

  /**
   * `sh`: a shell in the thread's cwd with a timeout and the run's abort.
   *
   * Policy, as far as the codebase lets it be honoured: refused when the parent's permission
   * mode reads as read-only / plan (generic reading of the ACP `modes` the agent advertised —
   * the id or name of the current mode; no per-agent table), and when the parent has an
   * autonomy policy that DENIES `execute`. Otherwise it runs with the thread's authority:
   * there is no door through which a harness-run command can be put to the agent's own
   * permission prompt, so an `ask` stance is not asked about. (The script's author already
   * had shell through the agent; the journal records every command.)
   */
  private exec(run: Run, cmd: string, o: { cwd: string; timeoutSec: number }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const parent = run.parent;
    const modes = parent.bridge?.modes;
    const current = modes?.availableModes.find((m) => m.id === modes.currentModeId);
    const label = `${modes?.currentModeId ?? ""} ${current?.name ?? ""}`;
    if (/(^|[^a-z])(plan|read[-_ ]?only|readonly)([^a-z]|$)/i.test(label)) {
      return Promise.reject(new Error(`sh refused: the thread is in a read-only permission mode (${label.trim()})`));
    }
    if (parent.autonomy && stanceFor(parent.autonomy, "execute") === "deny") {
      return Promise.reject(new Error("sh refused: this thread's autonomy policy denies running commands"));
    }
    return new Promise((resolve, reject) => {
      const CAP = 1024 * 1024;
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const child = spawn("sh", ["-c", cmd.replace(/\0/g, "")], { cwd: o.cwd, env: shellEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const kill = () => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, o.timeoutSec * 1000);
      const onAbort = () => kill();
      run.abort.signal.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (d: Buffer) => {
        if (stdout.length < CAP) stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        if (stderr.length < CAP) stderr += d.toString("utf8");
      });
      const end = () => {
        clearTimeout(timer);
        run.abort.signal.removeEventListener("abort", onAbort);
      };
      child.on("error", (error) => {
        end();
        reject(error);
      });
      child.on("close", (code, signal) => {
        end();
        if (run.abort.signal.aborted) return reject(new Error("the run was cancelled"));
        if (timedOut) return resolve({ exitCode: 124, stdout, stderr: `${stderr}\n[timed out after ${o.timeoutSec}s]`.trimStart() });
        resolve({ exitCode: code ?? (signal ? 128 : -1), stdout, stderr });
      });
    });
  }
}

// ---- helpers ------------------------------------------------------------------------------------

const SHELL_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "USER", "SHELL"] as const;
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL|^DAEDALUS_)/i;

/** What `sh` runs with: a short allow-list, never the server's whole environment (provider
    keys, the bearer token, the database URL). Anything secret-shaped is dropped even if listed. */
export function shellEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SHELL_ENV_KEYS) {
    const v = env[key];
    if (typeof v === "string" && !SECRET_NAME.test(key)) out[key] = v;
  }
  return out;
}

/** The option text a parked answer chose; null = explicitly declined; undefined = no answer (process gone). */
function decodeAnswer(response: unknown, options: string[]): string | null | undefined {
  const r = response as { outcome?: { outcome?: string; optionId?: string }; action?: string; content?: { choice?: unknown } } | null;
  if (r?.outcome) {
    if (r.outcome.outcome !== "selected") return undefined;
    const at = Number(/^o(\d+)$/.exec(r.outcome.optionId ?? "")?.[1]);
    return Number.isInteger(at) && options[at] !== undefined ? options[at]! : null;
  }
  if (r?.action === "accept") {
    const choice = r.content?.choice;
    return typeof choice === "string" && options.includes(choice) ? choice : null;
  }
  if (r?.action === "decline") return null;
  return undefined;
}

function stateUpdate(childId: string, state: "completed" | "failed" | "cancelled" | "disconnected"): UpdateEvent {
  return {
    ev: "update",
    seq: 0,
    historyReplay: false,
    update: { sessionUpdate: "subagent_state_update", subagentSessionId: childId, state },
  };
}

function issues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.length ? i.path.join(".") + ": " : ""}${i.message}`).join("; ");
}

function jsonClone(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return null;
  }
}

/** The first few words of a prompt, for a run nobody described: `3-8 words` is
    what the tool asks for, so this is the fallback and not the rule. */
function firstWords(prompt: string, max = 8): string {
  const line = prompt.split("\n").find((l) => l.trim()) ?? "";
  const words = line.trim().split(/\s+/).slice(0, max).join(" ");
  return words.length > 80 ? `${words.slice(0, 79)}…` : words || "Subagent";
}

/** JSON that is also safe as JavaScript source (U+2028/9 escaped). */
const lit = (value: unknown): string => JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

function cleanBudgets(b: Budgets): Budgets {
  const out: Budgets = {};
  for (const k of ["tokens", "costUsd", "agents", "wallSec"] as const) {
    const v = b[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = k === "costUsd" || k === "wallSec" ? v : Math.floor(v);
  }
  return out;
}

function cleanFlow(f: FlowControl): FlowControl {
  const out: FlowControl = {};
  if (typeof f.priority === "number" && Number.isFinite(f.priority)) out.priority = f.priority;
  if (typeof f.concurrency === "number" && f.concurrency >= 1) {
    out.concurrency = Math.min(Math.floor(f.concurrency), ENGINE_LIMITS.maxConcurrency);
  }
  if (typeof f.concurrencyKey === "string" && f.concurrencyKey.trim()) out.concurrencyKey = f.concurrencyKey.trim();
  return out;
}

// ---- the notification ---------------------------------------------------------------------------

/**
 * What a finished background run says to its parent thread. Shaped like Claude
 * Code's `<task-notification>` (`<usage>`, `<failures>`, a prose `<result>`, a
 * `<note>`), so an agent that knows one reads the other and the client draws
 * both as one card.
 *
 * The words follow the SHAPE: a one-step run (an ask, or a subagent on the
 * parent's own pair) reports its step's own answer, and points at the tool that
 * picks it back up; a workflow reports its steps and points at its run card. A
 * run stopped by a budget says which, with the spend; a run waiting on an
 * approval says so.
 */
export function notification(view: RunView, kind: RunKind = "workflow"): string {
  const one = kind !== "workflow";
  const failed = view.steps.filter((s) => s.status === "failed");
  const done = view.steps.filter((s) => s.status === "completed");
  const asked = one ? view.steps[0] : undefined;
  /* An ask's answer is the child's own words, not JSON wrapped around them —
     and a failed one still carries what it said before it stopped. */
  const body = asked
    ? typeof asked.output === "string"
      ? asked.output
      : asked.output == null
        ? ""
        : JSON.stringify(asked.output, null, 2)
    : view.result !== undefined && view.result !== null
      ? JSON.stringify(view.result, null, 2)
      : JSON.stringify(Object.fromEntries(done.map((s) => [s.name, s.output])), null, 2);
  const result =
    body.length > NOTIFY_BYTES
      ? `${body.slice(0, NOTIFY_BYTES)}\n… (truncated — call ${one ? "agent_status with this id" : "agent_status with this id"} for the whole of it)`
      : body;
  const sum = (key: "tokens" | "toolUses") => view.steps.reduce((n, s) => n + (s[key] ?? 0), 0);
  const usage = [
    ...(one ? [] : [`<agent_count>${view.steps.length}</agent_count>`, `<agents_done>${done.length}</agents_done>`, `<agents_error>${failed.length}</agents_error>`]),
    `<subagent_tokens>${sum("tokens")}</subagent_tokens>`,
    `<tool_uses>${sum("toolUses")}</tool_uses>`,
    `<duration_ms>${Math.max(0, (view.endedAt ?? Date.now()) - view.createdAt)}</duration_ms>`,
  ];
  const waiting = view.gates.filter((g) => g.kind === "approval" && g.status === "waiting");
  const b = view.budgets;
  const budget =
    view.status === "budget_exceeded"
      ? [
          `<budget>${[
            b.tokens !== undefined ? `tokens ${view.usage.tokens}/${b.tokens}` : "",
            b.costUsd !== undefined ? `costUsd ${view.usage.costUsd.toFixed(4)}/${b.costUsd}` : "",
            b.agents !== undefined ? `agents ${view.usage.agents}/${b.agents}` : "",
            b.wallSec !== undefined ? `wallSec ${b.wallSec}` : "",
          ]
            .filter(Boolean)
            .join(", ")}. The run stopped starting agents; the result below is partial.</budget>`,
        ]
      : [];
  return [
    "<task-notification>",
    `<task-id>${view.id}</task-id>`,
    `<status>${view.status}</status>`,
    `<summary>${one ? view.name : `Workflow "${view.name}"`} ${view.status.replace("_", " ")}${view.error ? `: ${view.error}` : ""}</summary>`,
    ...(asked?.sessionId
      ? [
          `<note>The task-id names this run. The child's thread (${asked.sessionId}) keeps its whole conversation; ` +
            (view.status === "completed"
              ? "call agent_message with this id and a prompt to send it a follow-up."
              : "call agent_message with this id (and a prompt, if it needs steering) to pick it up where it stopped — the result below is only what it said before then.") +
            "</note>",
        ]
      : []),
    ...(waiting.length
      ? [`<note>Waiting for approval (${waiting.map((g) => g.text ?? g.key).join("; ")}) — answer it from the inbox or the run card.</note>`]
      : []),
    ...budget,
    ...(failed.length ? [`<failures>\n${failed.map((s) => `[${s.name}] failed: ${s.error ?? "failed"}`).join("\n")}\n</failures>`] : []),
    ...(result.trim() && result.trim() !== "{}" ? [`<result>\n${result}\n</result>`] : []),
    `<usage>${usage.join("")}</usage>`,
    "</task-notification>",
  ].join("\n");
}

// Re-exported so callers import the whole surface from one place.
export { wallSecOf };
export type { BudgetKind };
