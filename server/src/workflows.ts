/*
 * Harness-owned workflows: the engine.
 *
 * Claude Code has a Workflow tool; Codex and OpenCode do not, and the harness
 * could only ever *watch* Claude Code's (tasks.ts tails its journal). This is
 * the one every agent gets. A definition (workflow-schema.ts) is a set of
 * named steps with edges; a run puts each step in a **real thread** — a
 * session of its own, on the parent's project, carrying `parentSessionId` —
 * prompts it once, waits for the turn to settle, keeps its final prose (or
 * the JSON it was asked for) as the step's output, and retires it. Steps whose
 * dependencies are done run side by side, up to the caps.
 *
 * The parent sees all of it without learning anything new: on the parent's
 * session the runner emits the same three updates the ACP subagent RFD sends —
 * `subagent_spawned`, the child's own `update`s re-addressed with its
 * `sessionId`, `subagent_state_update` — as ordinary journaled `update`s, so
 * the client's existing subagent rail draws the step live and replays it from
 * the log. The child keeps its own log too: that is what "Open thread" reads.
 *
 * The agent reaches this through the `workflow` MCP server (workflow-mcp.ts),
 * a process the agent spawns, which can only talk to the manager over HTTP —
 * `/wf/<key>/<sessionId>/…` (routes/workflows.ts), the key minted per boot
 * like the gateway shim's and the session id naming the caller, so a server
 * can act for exactly the thread that asked. A step is never handed that
 * server: one level, never a tree.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, workflowRuns as runsTable, type WorkflowRunStatus, type WorkflowStepRecord } from "./db/index.js";
import { safeKeyEqual } from "./gateway-shim.js";
import { getProfile } from "./profiles.js";
import { getProject } from "./projects.js";
import type { ThreadEvent } from "./protocol.js";
import type { Session, SessionManager, TurnOutcome } from "./sessions.js";
import {
  InputsSchema,
  LIMITS,
  OutputError,
  TemplateError,
  WorkflowDefinitionSchema,
  dependentsOf,
  describe,
  extractJsonOutput,
  missingInputs,
  readySteps,
  renderTemplate,
  validateOutput,
  type WorkflowDefinition,
  type WorkflowStep,
} from "./workflow-schema.js";
import { HttpError } from "./http-error.js";
import {
  SCRIPT_LIMITS,
  ScriptError,
  extractMeta,
  runScript,
  type ScriptMeta,
} from "./workflow-script.js";

/** Step threads alive at once, across every run. */
const MAX_LIVE_CHILDREN = 8;
/** Runs one thread may have going at once — a model that calls `run_workflow`
    twice by mistake gets told, not a second fleet. */
const MAX_RUNS_PER_PARENT = 2;

export class WorkflowError extends HttpError {
  declare status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message, status);
  }
}

/** A run as the tools and routes report it. */
export interface RunView {
  id: string;
  name: string;
  status: WorkflowRunStatus;
  error: string | null;
  createdAt: number;
  endedAt: number | null;
  steps: WorkflowStepRecord[];
  /** A script run's own answer — whatever its body returned. A definition has
      none: its answer is its steps' outputs, which are already here.
      In memory only, and so present for as long as the run is (it is kept for
      ten minutes past its end, which is the window the tool reads it in). The
      row keeps the steps, which is the durable record; a return value is the
      script's summary of them and is not worth a column. */
  result?: unknown;
}

/** A run started from a script rather than a definition. The definition it
    carries is the one the engine builds *as it goes* — see `startScript`. */
interface ScriptState {
  source: string;
  meta: ScriptMeta;
  /** Labels already used, so a script that labels two agents alike still gets
      two rows: the client joins a run's outline to its steps by name. */
  used: Set<string>;
  /** Output tokens every agent of this run has spent, for `budget`. */
  spent: number;
}

interface Run {
  id: string;
  parent: Session;
  /** For a script run this grows: each `agent()` appends the step it spawned,
      so one runner, one card and one set of records serve both engines. */
  def: WorkflowDefinition;
  script?: ScriptState;
  inputs: Record<string, unknown>;
  status: WorkflowRunStatus;
  error: string | null;
  createdAt: number;
  endedAt: number | null;
  steps: Map<string, WorkflowStepRecord>;
  /** Outputs of completed steps, for the templates of the ones after them. */
  outputs: Record<string, unknown>;
  /** Aborted on cancel; every running step's wait is racing it. */
  abort: AbortController;
  /** The run's clock. Paused with the run: a deadline that kept advancing
      through a hold would fail the run for the time the user spent thinking. */
  totalTimer: PausableTimer;
  /** Every running step's own clock, for the same reason. */
  stepTimers: Set<PausableTimer>;
  waiters: ((view: RunView) => void)[];
  /** Steps holding between a step's prompts (the JSON repair turn) until the
      run is running again — see `whenRunning`. */
  resumeWaiters: (() => void)[];
}

/**
 * A timeout that can stand still. `setTimeout` has no pause, and re-arming
 * one by hand at every hold is how a clock ends up armed twice; this keeps
 * the remaining time itself and re-arms exactly once on resume.
 */
class PausableTimer {
  private handle: ReturnType<typeof setTimeout> | null = null;
  private remaining: number;
  private armedAt = 0;
  private fn: () => void;
  constructor(ms: number, fn: () => void) {
    this.remaining = ms;
    this.fn = fn;
    this.arm();
  }
  private arm(): void {
    this.armedAt = Date.now();
    this.handle = setTimeout(() => {
      this.handle = null;
      this.fn();
    }, this.remaining);
    this.handle.unref();
  }
  pause(): void {
    if (!this.handle) return;
    clearTimeout(this.handle);
    this.handle = null;
    this.remaining = Math.max(0, this.remaining - (Date.now() - this.armedAt));
  }
  resume(): void {
    if (this.handle || this.remaining < 0) return;
    this.arm();
  }
  clear(): void {
    if (this.handle) clearTimeout(this.handle);
    this.handle = null;
    this.remaining = -1;
  }
}

type UpdateEvent = Extract<ThreadEvent, { ev: "update" }>;

export class WorkflowRunner {
  private key = randomBytes(24).toString("hex");
  private runs = new Map<string, Run>();
  private liveChildren = 0;
  /** Script agents waiting for a child slot. Woken by `pump`, which every
      finished step calls for every run. */
  private slotWaiters: (() => void)[] = [];

  constructor(
    private manager: SessionManager,
    private opts: { port: number },
  ) {}

  /** What a thread's `workflow` MCP server is handed: the loopback address that
      names it. The key is the credential — `/wf` is outside the bearer check. */
  urlFor(session: Pick<Session, "id">): string {
    return `http://127.0.0.1:${this.opts.port}/wf/${this.key}/${session.id}`;
  }

  /** The thread a `/wf/<key>/<sessionId>` path speaks for, or null. */
  resolveCaller(key: string, sessionId: string): Session | null {
    if (!safeKeyEqual(key, this.key)) return null;
    const session = this.manager.get(sessionId);
    return session && session.deletedAt === null ? session : null;
  }

  // ---- lifecycle ----

  /** Validate and start. Synchronous: the run exists and its first steps are
      spawning by the time this returns. Throws `WorkflowError`. */
  start(parent: Session, definition: unknown, inputsRaw?: unknown): RunView {
    if (parent.parentSessionId) throw new WorkflowError("a workflow step cannot start a workflow", 409);
    const parsed = WorkflowDefinitionSchema.safeParse(definition);
    if (!parsed.success) throw new WorkflowError(`invalid workflow: ${issues(parsed.error)}`);
    const def = parsed.data;
    const inputsParsed = InputsSchema.safeParse(inputsRaw ?? {});
    if (!inputsParsed.success) throw new WorkflowError(`invalid inputs: ${issues(inputsParsed.error)}`);
    const inputs = inputsParsed.data;
    const missing = missingInputs(def, inputs);
    if (missing.length) throw new WorkflowError(`the definition reads inputs that were not given: ${missing.join(", ")}`);
    const active = [...this.runs.values()].filter((r) => r.parent === parent && !terminal(r.status));
    if (active.length >= MAX_RUNS_PER_PARENT) {
      throw new WorkflowError(`this thread already has ${active.length} workflow(s) running — wait for or cancel one first`, 409);
    }
    /* Every step runs as the parent runs — its profile, agent, model and
       effort. A step is the same actor working in another thread, never a
       second identity: the credentials, catalog and way of working the user
       picked for the thread are the ones its workflow spends. */
    if (!getProfile(parent.profileId)) throw new WorkflowError("this thread's profile no longer exists", 409);
    if (!getProject(parent.projectId)) throw new WorkflowError("this thread's project no longer exists", 409);

    const now = Date.now();
    const run: Run = {
      id: randomUUID(),
      parent,
      def,
      inputs,
      status: "running",
      error: null,
      createdAt: now,
      endedAt: null,
      steps: new Map(
        def.steps.map((s) => [
          s.name,
          {
            name: s.name,
            phase: s.phase?.name ?? null,
            status: "pending",
            sessionId: null,
            attempt: 0,
            output: null,
            error: null,
            startedAt: null,
            endedAt: null,
          },
        ]),
      ),
      outputs: {},
      abort: new AbortController(),
      totalTimer: new PausableTimer((def.totalTimeoutSec ?? LIMITS.totalTimeoutSec.default) * 1000, () =>
        this.finishRun(run, "failed", `timed out after ${def.totalTimeoutSec ?? LIMITS.totalTimeoutSec.default}s`),
      ),
      stepTimers: new Set(),
      waiters: [],
      resumeWaiters: [],
    };
    this.runs.set(run.id, run);
    db.insert(runsTable)
      .values({
        id: run.id,
        parentSessionId: parent.id,
        name: def.name,
        definition: def as unknown as Record<string, unknown>,
        inputs,
        status: run.status,
        error: null,
        steps: [...run.steps.values()],
        createdAt: now,
        endedAt: null,
      })
      .run();
    this.pump(run);
    return this.view(run);
  }

  /**
   * Start a run from an agent-authored script.
   *
   * The same runner, the same records, the same card: what differs is only who
   * decides what runs next. A definition says so up front and `pump` computes
   * it; a script says so by running, and each `agent()` call appends the step
   * it spawned to the very `def` the rest of this class reads. So a script's
   * agents are steps of exactly the same kind — real child threads, with the
   * repair turn, the timeouts, the pause and the cancel — and everything
   * downstream (the client card, replay, `workflow_runs`) learns nothing new.
   *
   * The outline is `meta.phases`, which is why Claude Code requires it to be a
   * literal: the card draws a run's shape from its first step, and a shape that
   * could only be known by running would leave nothing to draw.
   */
  startScript(parent: Session, source: unknown, args?: unknown, budgetTotal?: unknown): RunView {
    if (parent.parentSessionId) throw new WorkflowError("a workflow step cannot start a workflow", 409);
    if (typeof source !== "string" || !source.trim()) throw new WorkflowError("script must be a non-empty string");
    let meta: ScriptMeta;
    try {
      meta = extractMeta(source);
    } catch (error) {
      throw new WorkflowError(describe(error));
    }
    const active = [...this.runs.values()].filter((r) => r.parent === parent && !terminal(r.status));
    if (active.length >= MAX_RUNS_PER_PARENT) {
      throw new WorkflowError(`this thread already has ${active.length} workflow(s) running — wait for or cancel one first`, 409);
    }
    if (!getProfile(parent.profileId)) throw new WorkflowError("this thread's profile no longer exists", 409);
    if (!getProject(parent.projectId)) throw new WorkflowError("this thread's project no longer exists", 409);

    const now = Date.now();
    const totalTimeoutSec = LIMITS.totalTimeoutSec.default;
    const def: WorkflowDefinition = {
      name: meta.name,
      description: meta.description,
      steps: [],
      // Declared up front so the card can name the stages before any of them
      // has an agent in it; the step lists fill in as the script fans out.
      phases: meta.phases.map((p) => ({ name: p.title, description: p.detail, steps: [] })),
      maxParallel: LIMITS.maxParallel,
      totalTimeoutSec,
    };
    const run: Run = {
      id: randomUUID(),
      parent,
      def,
      script: { source, meta, used: new Set(), spent: 0 },
      inputs: {},
      status: "running",
      error: null,
      createdAt: now,
      endedAt: null,
      steps: new Map(),
      outputs: {},
      abort: new AbortController(),
      totalTimer: new PausableTimer(totalTimeoutSec * 1000, () =>
        this.finishRun(run, "failed", `timed out after ${totalTimeoutSec}s`),
      ),
      stepTimers: new Set(),
      waiters: [],
      resumeWaiters: [],
    };
    this.runs.set(run.id, run);
    db.insert(runsTable)
      .values({
        id: run.id,
        parentSessionId: parent.id,
        name: def.name,
        definition: { script: source, meta } as unknown as Record<string, unknown>,
        inputs: {},
        status: run.status,
        error: null,
        steps: [],
        createdAt: now,
        endedAt: null,
      })
      .run();
    void this.driveScript(run, args, typeof budgetTotal === "number" && budgetTotal > 0 ? Math.floor(budgetTotal) : null);
    return this.view(run);
  }

  /** Run the script to its end, and make its answer the run's answer. */
  private async driveScript(run: Run, args: unknown, budgetTotal: number | null): Promise<void> {
    const script = run.script!;
    try {
      const { result } = await runScript({
        source: script.source,
        args,
        budgetTotal,
        hooks: {
          agent: (spec) => this.scriptAgent(run, spec),
          phase: (title) => this.ensurePhase(run, title),
          log: (message) => this.logLine(run, message),
          spent: () => script.spent,
          signal: run.abort.signal,
        },
      });
      if (terminal(run.status)) return;
      /* The script's return value is the run's output. Kept on the run rather
         than on a step, because it is the thing the agent asked for and no
         step produced it. */
      run.outputs.__result = result ?? null;
      this.finishRun(run, "completed", null);
    } catch (error) {
      if (terminal(run.status)) return;
      this.finishRun(run, "failed", error instanceof ScriptError ? error.message : describe(error));
    }
  }

  /** A phase the script entered. Unknown titles are appended rather than
      refused: `meta.phases` is documentation the author may drift from, and a
      stage that ran is a stage the card must show. */
  private ensurePhase(run: Run, title: string): number {
    const at = run.def.phases.findIndex((p) => p.name === title);
    if (at !== -1) return at;
    run.def.phases.push({ name: title, steps: [] });
    return run.def.phases.length - 1;
  }

  private logLine(run: Run, message: string): void {
    // A script's own narration, on the parent's transcript where the run is.
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

  /**
   * `agent()`: one step of a script run.
   *
   * Waits for a child slot, appends the step to the growing definition, and
   * hands it to the very `runStep` a declarative step goes through — so a
   * script's agent gets the repair turn, the clocks, the pause and the cancel
   * for free, and appears on the card as the same row.
   */
  private async scriptAgent(
    run: Run,
    spec: { prompt: string; label: string; phase: string | null; schema?: Record<string, unknown>; model?: string; effort?: string },
  ): Promise<unknown> {
    const script = run.script!;
    await this.acquireSlot(run);
    if (terminal(run.status) || run.abort.signal.aborted) throw new ScriptError("the run was cancelled");

    /* Two agents a script labelled alike must still be two rows: the card joins
       a run's outline to its steps by name. The label is kept readable and only
       the repeat is numbered. */
    let name = sanitizeStepName(spec.label);
    if (script.used.has(name)) {
      let n = 2;
      while (script.used.has(`${name}-${n}`)) n += 1;
      name = `${name}-${n}`;
    }
    script.used.add(name);

    const phaseIndex = spec.phase === null ? -1 : this.ensurePhase(run, spec.phase);
    const step: WorkflowStep = {
      name,
      prompt: spec.prompt,
      dependsOn: [],
      literal: true,
      output: spec.schema ? { schema: spec.schema } : "text",
      ...(phaseIndex === -1 ? {} : { phase: { index: phaseIndex, name: run.def.phases[phaseIndex].name } }),
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.effort ? { effort: spec.effort } : {}),
    };
    run.def.steps.push(step);
    if (phaseIndex !== -1) run.def.phases[phaseIndex].steps.push(name);
    run.steps.set(name, {
      name,
      phase: step.phase?.name ?? null,
      status: "pending",
      sessionId: null,
      attempt: 0,
      output: null,
      error: null,
      startedAt: null,
      endedAt: null,
    });

    await this.runStep(run, step);
    const record = run.steps.get(name);
    if (record?.status === "completed") return run.outputs[name];
    if (run.abort.signal.aborted) throw new ScriptError("the run was cancelled");
    /* Thrown, not returned: `parallel`/`pipeline` turn it into the `null` the
       script's own `.filter(Boolean)` expects, and a bare `await agent(…)`
       fails the run, which is what an unguarded call should do. */
    throw new Error(record?.error ?? `step "${name}" did not complete`);
  }

  /** Wait until this run may start another child: the global ceiling and the
      run's own width. Woken by `pump`, which every finished step calls. */
  private async acquireSlot(run: Run): Promise<void> {
    const free = () =>
      this.liveChildren < MAX_LIVE_CHILDREN &&
      [...run.steps.values()].filter((s) => s.status === "running").length < run.def.maxParallel;
    while (!free()) {
      if (terminal(run.status) || run.abort.signal.aborted) return;
      await new Promise<void>((resolve) => {
        this.slotWaiters.push(resolve);
        run.abort.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    // A held run stops at the boundary, exactly as a declarative one does.
    await this.whenRunning(run);
  }

  status(runId: string): RunView | null {
    const run = this.runs.get(runId);
    if (run) return this.view(run);
    const row = db.select().from(runsTable).where(eq(runsTable.id, runId)).get();
    return row
      ? { id: row.id, name: row.name, status: row.status, error: row.error, createdAt: row.createdAt, endedAt: row.endedAt, steps: row.steps }
      : null;
  }

  /** `status`, but only for a run of that thread's — the browser's routes
      name a thread, and a run id on another thread is not theirs to touch. */
  statusFor(parentId: string, runId: string): RunView | null {
    const run = this.runs.get(runId);
    if (run) return run.parent.id === parentId ? this.view(run) : null;
    const row = db.select().from(runsTable).where(eq(runsTable.id, runId)).get();
    return row && row.parentSessionId === parentId ? this.status(runId) : null;
  }

  /** The run's view once it is over, or as it stands when `timeoutMs` runs out. */
  wait(runId: string, timeoutMs: number): Promise<RunView | null> {
    const run = this.runs.get(runId);
    if (!run) return Promise.resolve(this.status(runId));
    if (terminal(run.status)) return Promise.resolve(this.view(run));
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

  cancel(runId: string, reason = "cancelled"): boolean {
    const run = this.runs.get(runId);
    if (!run || terminal(run.status)) return false;
    this.finishRun(run, "cancelled", reason);
    return true;
  }

  /**
   * Hold the run. No pending step starts; every running step that can be
   * paused (its thread's agent advertises the harness's pause — our own
   * runtime) holds at its next step boundary; a step that cannot runs to its
   * end and its dependents wait. Both clocks stop. What ACP has instead is
   * `session/cancel`, and a cancel throws the step away — the whole reason
   * this is a state of the run and not a cancel-and-restart.
   */
  pause(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running") return false;
    run.status = "paused";
    run.totalTimer.pause();
    for (const t of run.stepTimers) t.pause();
    for (const child of this.liveSteps(run)) {
      if (child.bridge?.canPause) void child.bridge.pause().catch(() => {});
    }
    this.persist(run);
    this.emitState(run);
    return true;
  }

  resume(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.status !== "paused") return false;
    run.status = "running";
    run.totalTimer.resume();
    for (const t of run.stepTimers) t.resume();
    for (const child of this.liveSteps(run)) {
      if (child.bridge?.paused) void child.bridge.resume().catch(() => {});
    }
    this.persist(run);
    this.emitState(run);
    for (const w of run.resumeWaiters.splice(0)) w();
    this.pump(run);
    return true;
  }

  /** The threads of the run's running steps, live. */
  private liveSteps(run: Run): Session[] {
    const out: Session[] = [];
    for (const s of run.steps.values()) {
      if (s.status !== "running" || !s.sessionId) continue;
      const child = this.manager.get(s.sessionId);
      if (child && !child.exited) out.push(child);
    }
    return out;
  }

  /** Resolves when the run is running or over — what a step waits on before
      sending a prompt of its own into a hold. */
  private whenRunning(run: Run): Promise<void> {
    if (run.status !== "paused") return Promise.resolve();
    return new Promise((resolve) => run.resumeWaiters.push(resolve));
  }

  /** The run's hold, said on the parent — journaled with the spawns it holds,
      so a replayed card stands still where the live one did. */
  private emitState(run: Run): void {
    this.manager.emitOn(run.parent.id, {
      ev: "update",
      seq: 0,
      historyReplay: false,
      update: { sessionUpdate: "_daedalus/workflow_state", runId: run.id, paused: run.status === "paused" },
    });
  }

  /** The parent's process is gone (retired, deleted, crashed): nobody is
      waiting on the answer any more, and its steps must not run on. */
  cancelForParent(parentId: string, reason: string): void {
    for (const run of this.runs.values()) {
      if (run.parent.id === parentId && !terminal(run.status)) this.finishRun(run, "cancelled", reason);
    }
  }

  /** At boot: nothing survives a restart (every step thread was this process's
      child), so what the table says was running is over. The parent's log is
      told, so a reopened thread shows the steps as disconnected rather than
      forever running. */
  recoverAtBoot(): void {
    const rows = db.select().from(runsTable).where(inArray(runsTable.status, ["running", "paused"])).all();
    for (const row of rows) {
      const steps = row.steps.map((s) => ({
        ...s,
        status: s.status === "running" ? ("failed" as const) : s.status === "pending" ? ("skipped" as const) : s.status,
        error: s.status === "running" ? "server restarted" : s.error,
        endedAt: s.status === "running" ? Date.now() : s.endedAt,
      }));
      db.update(runsTable)
        .set({ status: "failed", error: "server restarted", steps, endedAt: Date.now() })
        .where(eq(runsTable.id, row.id))
        .run();
      for (const s of row.steps) {
        if (s.status === "running" && s.sessionId) {
          this.manager.emitOn(row.parentSessionId, stateUpdate(s.sessionId, "disconnected"));
        }
      }
    }
    if (rows.length) console.log(`[workflows] closed ${rows.length} run(s) interrupted by the restart`);
  }

  shutdown(): void {
    for (const run of this.runs.values()) {
      if (!terminal(run.status)) this.finishRun(run, "cancelled", "server shutting down");
    }
  }

  // ---- scheduling ----

  private pump(run: Run): void {
    /* A script decides what runs next by running; there is no ready set to
       compute. Its agents take their slots through `acquireSlot` instead, which
       the same `finally` below releases. */
    if (run.script) {
      for (const wake of this.slotWaiters.splice(0)) wake();
      return;
    }
    if (terminal(run.status)) return;
    const done = new Set([...run.steps.values()].filter((s) => s.status === "completed").map((s) => s.name));
    const started = new Set([...run.steps.values()].filter((s) => s.status !== "pending").map((s) => s.name));
    const running = [...run.steps.values()].filter((s) => s.status === "running").length;
    const ready = readySteps(run.def, done, started);
    /* A paused run starts nothing — but is still allowed to finish: a step
       that was already running when the hold began may be the last one, and
       a run with nothing left to do is complete, held or not. */
    let slots = run.status === "paused" ? 0 : Math.min(run.def.maxParallel - running, MAX_LIVE_CHILDREN - this.liveChildren);
    for (const step of ready) {
      if (slots <= 0) break;
      slots -= 1;
      void this.runStep(run, step);
    }
    const pending = [...run.steps.values()].filter((s) => s.status === "pending" || s.status === "running");
    if (pending.length === 0) {
      const failed = [...run.steps.values()].find((s) => s.status === "failed");
      this.finishRun(run, failed ? "failed" : "completed", failed ? `step "${failed.name}" failed: ${failed.error}` : null);
    } else if (running === 0 && ready.length === 0 && this.liveChildren < MAX_LIVE_CHILDREN && run.status !== "paused") {
      // Pending steps none of which can ever run: a dependency was skipped.
      for (const s of pending) this.patchStep(run, s.name, { status: "skipped", endedAt: Date.now() });
      this.pump(run);
    }
  }

  private async runStep(run: Run, step: WorkflowStep): Promise<void> {
    this.patchStep(run, step.name, { status: "running", startedAt: Date.now() });
    this.liveChildren += 1;
    let child: Session | null = null;
    let unsubscribe = () => {};
    let text = "";
    let textBytes = 0;
    try {
      /* A script wrote this prompt in JavaScript, so it is already whatever
         its author meant — running it through the template engine would eat
         any `{{…}}` they had legitimately typed. */
      const prompt = step.literal
        ? step.prompt
        : renderTemplate(step.prompt, { inputs: run.inputs, steps: run.outputs });
      const profile = getProfile(run.parent.profileId);
      if (!profile) throw new WorkflowError("this thread's profile no longer exists", 409);
      const project = getProject(run.parent.projectId);
      if (!project) throw new WorkflowError("this thread's project no longer exists", 409);
      // A step inherits how its parent was configured — the permission mode
      // above all, so a step does not ask what the parent would not.
      const restore = run.parent.bridge?.captureRestoreState() ?? {
        modeId: run.parent.modeId ?? undefined,
        configOptions: [],
      };
      child = this.manager.create(profile, run.parent.agentId, project, step.model ?? run.parent.model, step.effort ?? run.parent.effort, undefined, undefined, run.parent.links, {
        parentSessionId: run.parent.id,
        title: `${run.def.name} · ${step.name}`,
        restore,
        /* And how the parent works, for the same reason: a step is the same
           actor working in another thread, so a parent running "quick fix"
           must not spawn steps that refactor. */
        personaId: run.parent.personaId,
        /* And whether it offers follow-ups, for the same reason: the step's
           answer reads in the parent's transcript, where a missing fence
           would be the inconsistency showing. */
        suggestFollowups: run.parent.suggestFollowups,
      });
      this.patchStep(run, step.name, { sessionId: child.id });
      const childId = child.id;
      this.manager.emitOn(run.parent.id, {
        ev: "update",
        seq: 0,
        historyReplay: false,
        update: {
          sessionUpdate: "subagent_spawned",
          subagentSessionId: childId,
          name: step.name,
          task: firstLine(prompt),
          capabilities: { cancel: true },
          /* What tells the client this subagent is a workflow step — and of
             which run — so a run draws as one card, not N stray rows. Rides
             the journaled spawn, so the layout replays for free.
             `plan` is the whole outline, repeated on every spawn: a run is
             drawn from the definition and filled in by the steps that have
             started, so the card shows the shape the user wrote from the
             first step rather than growing a row every time one spawns. It is
             a dozen names, and repeating it is what keeps it journaled — an
             outline sent once would be an event kind of its own. */
          _meta: {
            daedalus: {
              workflow: {
                runId: run.id,
                /* The thread the run belongs to, so the card — which is drawn
                   from the log with no thread of its own in hand — can address
                   `/api/sessions/:id/workflows/:runId/…`. */
                sessionId: run.parent.id,
                name: run.def.name,
                step: step.name,
                index: run.def.steps.findIndex((s) => s.name === step.name),
                total: run.def.steps.length,
                phase: step.phase,
                plan: planOf(run.def),
              },
            },
          },
        },
      });
      /* Everything the child journals is said again on the parent, addressed
         to the child — that is the RFD's shape and the reducer files it under
         the spawn above. A grandchild's RFD update (a Codex step spawning its
         own) keeps its own id and nests one level further. The child's own
         prose is also kept here: ACP's prompt response carries no text, so the
         stream is the only place a step's answer can be read from. */
      unsubscribe = this.manager.subscribe(childId, (event) => {
        /* What the step's turn cost, said again on the parent. The turn event
           itself is NOT mirrored — a child's turn boundaries on the parent's
           log would cut its replay windows at turns it never had — so the
           usage is lifted out of it onto an update of our own, which journals
           and replays like everything else the step reports. Per turn, so a
           step that took a repair turn reports twice and the client sums. */
        if (event.ev === "turn_ended" && event.usage) {
          /* What `budget` counts. Output tokens, as Claude Code's does — the
             number a run is actually steered by, and the one a reader means by
             "how much has this spent". */
          if (run.script) run.script.spent += event.usage.outputTokens ?? event.usage.totalTokens ?? 0;
          this.manager.emitOn(run.parent.id, {
            ev: "update",
            seq: 0,
            historyReplay: false,
            update: {
              sessionUpdate: "_daedalus/subagent_usage",
              subagentSessionId: childId,
              usage: event.usage,
            },
          });
          return;
        }
        if (event.ev !== "update" || event.historyReplay) return;
        this.manager.emitOn(run.parent.id, { ...event, seq: 0, sessionId: event.sessionId ?? childId });
        if (event.sessionId) return;
        const u = event.update;
        if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text" && textBytes < LIMITS.outputBytes) {
          text += u.content.text;
          textBytes += Buffer.byteLength(u.content.text);
        }
      });
      await child.bridge!.ready;

      let attempt = 0;
      let output: unknown;
      let issue: string | null = null;
      let next: string = prompt;
      for (;;) {
        /* Between prompts (the repair turn) as well as before the first: a
           step does not put a prompt into a held run. */
        await this.whenRunning(run);
        attempt += 1;
        text = "";
        textBytes = 0;
        this.patchStep(run, step.name, { attempt });
        const outcome = await this.promptAndWait(run, child, next, step);
        if (outcome.kind === "cancelled") {
          this.closeStep(run, step.name, "cancelled", run.error ?? "cancelled", childId);
          return;
        }
        if (outcome.kind === "timeout") throw new WorkflowError(`timed out after ${stepTimeoutSec(step)}s`);
        if (outcome.error) throw new WorkflowError(outcome.error.message);
        if (outcome.interrupted) throw new WorkflowError("the step's turn was cancelled");
        if (step.output === "text") {
          output = text;
          break;
        }
        try {
          const value = extractJsonOutput(text);
          const checked = validateOutput(step.output.schema, value);
          if (checked.ok) {
            output = checked.value;
            break;
          }
          issue = checked.issues;
        } catch (error) {
          issue = error instanceof OutputError ? error.message : describe(error);
        }
        if (attempt >= 2) throw new WorkflowError(`the reply did not match the output schema: ${issue}`);
        next = `Your previous reply did not validate against the required JSON schema: ${issue}\nReply with only a single JSON value in a \`\`\`json fence, nothing else.`;
      }
      run.outputs[step.name] = output;
      this.patchStep(run, step.name, { output });
      this.closeStep(run, step.name, "completed", null, childId);
    } catch (error) {
      const message = error instanceof TemplateError ? `template: ${error.message}` : describe(error);
      // Nothing downstream can run now; its own dependents follow.
      for (const name of dependentsOf(run.def, step.name)) {
        if (run.steps.get(name)?.status === "pending") this.patchStep(run, name, { status: "skipped", endedAt: Date.now() });
      }
      this.closeStep(run, step.name, "failed", message, child?.id ?? null);
    } finally {
      unsubscribe();
      this.liveChildren -= 1;
      if (child) this.manager.retire(child);
      // Every run, not just this one: the slot that just freed may be the
      // global one another run was waiting on.
      for (const r of this.runs.values()) this.pump(r);
    }
  }

  /** One prompt to the child and the wait for its turn, raced against the
      step's clock and the run's cancel. */
  private async promptAndWait(
    run: Run,
    child: Session,
    text: string,
    step: WorkflowStep,
  ): Promise<{ kind: "settled"; error?: TurnOutcome["error"]; interrupted: boolean } | { kind: "timeout" } | { kind: "cancelled" }> {
    if (run.abort.signal.aborted) return { kind: "cancelled" };
    const reply = await this.manager.prompt(child.id, text);
    if (!("turnId" in reply)) throw new WorkflowError("the step's thread was busy"); // a fresh child never is
    const settled = this.manager.whenTurnSettled(child.id, reply.turnId);
    let timer: PausableTimer | undefined;
    let onAbort = () => {};
    const result = await Promise.race<{ kind: "settled"; error?: TurnOutcome["error"]; interrupted: boolean } | { kind: "timeout" } | { kind: "cancelled" }>([
      settled.then((o) => ({ kind: "settled" as const, ...o })),
      new Promise((resolve) => {
        timer = new PausableTimer(stepTimeoutSec(step) * 1000, () => resolve({ kind: "timeout" }));
        // Born held if the run is: a step whose child is being paused right
        // now must not have its clock running while it stands.
        if (run.status === "paused") timer.pause();
        run.stepTimers.add(timer);
      }),
      new Promise((resolve) => {
        onAbort = () => resolve({ kind: "cancelled" });
        run.abort.signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    if (timer) {
      timer.clear();
      run.stepTimers.delete(timer);
    }
    run.abort.signal.removeEventListener("abort", onAbort);
    if (result.kind !== "settled") {
      // The turn is still open in the child; ask it to stop before the retire
      // that follows kills it, so its own log ends on a cancel, not a crash.
      await child.bridge?.cancel().catch(() => {});
      settled.catch(() => {});
    }
    return result;
  }

  private closeStep(run: Run, name: string, status: WorkflowStepRecord["status"], error: string | null, childId: string | null): void {
    this.patchStep(run, name, { status, error, endedAt: Date.now() });
    if (childId) this.manager.emitOn(run.parent.id, stateUpdate(childId, status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed"));
  }

  private finishRun(run: Run, status: Exclude<WorkflowRunStatus, "running">, error: string | null): void {
    if (terminal(run.status)) return;
    run.status = status;
    run.error = error;
    run.endedAt = Date.now();
    run.totalTimer.clear();
    for (const s of run.steps.values()) {
      if (s.status === "pending") this.patchStep(run, s.name, { status: "cancelled", endedAt: run.endedAt });
    }
    // Running steps hear this through their race and close themselves — a
    // held one included: its child's cancel releases the pause with the turn.
    run.abort.abort();
    for (const w of run.resumeWaiters.splice(0)) w();
    this.persist(run);
    const view = this.view(run);
    for (const w of run.waiters.splice(0)) w(view);
    // Kept for status reads until the parent is done with it; the row is the
    // durable record. A bounded grace so a cancelled run can still be read.
    setTimeout(() => {
      if (this.runs.get(run.id) === run) this.runs.delete(run.id);
    }, 10 * 60_000).unref();
  }

  // ---- bookkeeping ----

  private patchStep(run: Run, name: string, patch: Partial<WorkflowStepRecord>): void {
    const current = run.steps.get(name);
    if (!current) return;
    run.steps.set(name, { ...current, ...patch });
    this.persist(run);
  }

  private persist(run: Run): void {
    db.update(runsTable)
      .set({
        status: run.status, error: run.error, steps: [...run.steps.values()], endedAt: run.endedAt })
      .where(eq(runsTable.id, run.id))
      .run();
  }

  private view(run: Run): RunView {
    return {
      id: run.id,
      name: run.def.name,
      status: run.status,
      error: run.error,
      createdAt: run.createdAt,
      endedAt: run.endedAt,
      steps: [...run.steps.values()],
      ...(run.script ? { result: run.outputs.__result ?? null } : {}),
    };
  }
}

function terminal(status: WorkflowRunStatus): boolean {
  return status !== "running" && status !== "paused";
}

function stepTimeoutSec(step: WorkflowStep): number {
  return step.timeoutSec ?? LIMITS.stepTimeoutSec.default;
}

function stateUpdate(childId: string, state: "completed" | "failed" | "cancelled" | "disconnected"): UpdateEvent {
  return {
    ev: "update",
    seq: 0,
    historyReplay: false,
    update: { sessionUpdate: "subagent_state_update", subagentSessionId: childId, state },
  };
}

/** The run's outline for the client: its phases and their steps, or the one
    unnamed phase a flat definition is. Named `null` rather than left out so the
    client has one thing to draw either way — a table with no bands. */
function planOf(def: WorkflowDefinition): { name: string | null; steps: string[] }[] {
  if (def.phases.length) return def.phases.map((p) => ({ name: p.name, steps: p.steps }));
  return [{ name: null, steps: def.steps.map((s) => s.name) }];
}

/** A script's free-text label as a step name: the shape the client, the
    records and the child's title all expect. */
function sanitizeStepName(label: string): string {
  const cleaned = label.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const named = /^[a-z]/.test(cleaned) ? cleaned : `agent-${cleaned}`;
  return named.slice(0, 40).replace(/-+$/, "") || "agent";
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

function issues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.length ? i.path.join(".") + ": " : ""}${i.message}`).join("; ");
}
