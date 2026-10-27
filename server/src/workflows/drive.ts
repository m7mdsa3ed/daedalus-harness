/*
 * Workflow engine v2: the pure core of a run.
 *
 * `drive` runs the script (sandbox.ts) with hooks that key every `agent()` call,
 * answer it from the journal when the journal already has the answer, enforce
 * the budgets, take a slot, and otherwise hand the call to an injected
 * `StepRunner`. It imports no database, no session manager and no config — at
 * runtime it needs only types, the sandbox, the fold and `limits.ts` — so it is
 * unit-tested with a fake store and a fake step runner
 * (`test/workflow-engine.test.ts`). `engine.ts` wires the real ones in.
 *
 * THE REPLAY RULES (what makes a restart safe):
 *  - A call's key is `stepKey(callHash(keyFields(spec)), occurrence)`; the
 *    occurrence counter is per run and per hash, taken SYNCHRONOUSLY when the
 *    sandbox calls the hook (the sandbox guarantees hook order is call order).
 *  - The replay source is a snapshot of the run's own journal taken when
 *    `drive` starts. A key with a `step_completed` there is answered from it:
 *    no slot, no child, no agent counted. A key with a `step_failed` fails the
 *    same way (the script took a branch on that failure; running it again
 *    could take the other). A key with `step_started` and nothing after it was
 *    in flight at the restart: the runner gets `recovered` and applies the
 *    step's `onRestart` policy.
 *  - `resumeFromRunId` supplies `priorEvents`: only COMPLETED keys are served
 *    from them (a relaunch is how a failure is retried). Each such answer is
 *    written into this run's own journal as a `step_completed`, so the run is
 *    self-contained and a later restart does not need the prior run.
 *  - `log` and `phase` are counted the same way: the nth call of a replay is
 *    the nth journaled one and writes nothing.
 *  - Replayed answers are released in the order they were originally journaled
 *    (`race()` depends on that to pick the same winner).
 */
import { foldRun } from "./fold.js";
import { BudgetTracker, type BudgetKind, type SlotRequest } from "./limits.js";
import { runScript, ScriptError } from "./sandbox.js";
import {
  ENGINE_LIMITS,
  callHash,
  canon,
  keyFields,
  stepKey,
  type AgentSpec,
  type JournalEvent,
  type JournalPayload,
  type RunSpec,
  type RunStatus,
  type SandboxHooks,
} from "./types.js";
import type { Placement, Recovered } from "./step.js";
import { titleRegistry } from "./titles.js";

// ---- the seams -----------------------------------------------------------------

/** The slice of the database layer the engine uses (`Journal`, adapted). */
export interface RunStore {
  createRun(row: {
    id: string;
    parentSessionId: string;
    projectId: string | null;
    name: string;
    spec: RunSpec;
    notify: boolean;
    createdAt: number;
  }): Promise<JournalEvent>;
  append(runId: string, key: string | null, payload: JournalPayload): Promise<JournalEvent>;
  events(runId: string, sinceSeq?: number): Promise<JournalEvent[]>;
  header(runId: string): Promise<StoredHeader | null>;
  setStatus(runId: string, status: RunStatus, error: string | null, endedAt: number | null, result?: unknown): Promise<void>;
  listRunsForParent(parentSessionId: string, limit: number): Promise<StoredHeader[]>;
  runningRuns(): Promise<StoredHeader[]>;
}

/** `RunHeader` of journal.ts, restated so this file needs no database import. */
export interface StoredHeader {
  id: string;
  parentSessionId: string;
  projectId: string | null;
  name: string;
  spec: RunSpec;
  status: RunStatus;
  error: string | null;
  result: unknown;
  notify: boolean;
  createdAt: number;
  endedAt: number | null;
}

/** What the runner is handed for one step that has to really run. */
export interface StepCall {
  spec: AgentSpec;
  key: string;
  /** Unique within the run, stable across replays. */
  name: string;
  /** Set when the journal says this step was in flight at a restart. */
  recovered: Recovered | null;
  /**
   * The child thread an EARLIER run left behind for this same call — a step that
   * failed, or one that was in flight when the run was stopped.
   *
   * A resumed run (`resumeFromRunId`) serves a completed call from the journal
   * and runs the rest again, so without this the step that failed would start
   * over in a fresh thread and lose what it had worked out — which is exactly
   * the conversation `agent_message` keeps for a one-step run. The runner
   * continues THIS thread instead, and falls back to a fresh spawn if it is
   * gone (deleted, or never persisted), the same bargain a restart's `resume`
   * policy makes.
   */
  resume?: Recovered | null;
  placement: Placement;
  /** Journals under this step's key. The runner writes step_started / _retry / _completed / _failed. */
  append(payload: JournalPayload): Promise<JournalEvent>;
  signal: AbortSignal;
}

export interface StepOutcome {
  output: unknown;
  sessionId: string | null;
  tokens: number;
  toolUses: number;
  costUsd?: number;
}

/** Runs one step to its journaled end. A thrown error is the step's failure; it may carry
    `tokens` / `costUsd` (a `StepError` does) so a failed step is still metered. */
export type StepRunner = (call: StepCall) => Promise<StepOutcome>;

/** `FlowScheduler` satisfies this. */
export interface SlotScheduler {
  acquire(req: SlotRequest): Promise<() => void>;
}

export class BudgetExceeded extends Error {
  kind: BudgetKind;
  constructor(kind: BudgetKind) {
    super(`budget exceeded: ${kind}`);
    this.name = "BudgetExceeded";
    this.kind = kind;
  }
}

export interface DriveOptions {
  runId: string;
  spec: RunSpec;
  /** Journals an event and keeps the engine's live view in step. */
  append(key: string | null, payload: JournalPayload): Promise<JournalEvent>;
  /** The run's own journal so far (read once, at the start, as the replay source). */
  events(): readonly JournalEvent[];
  /** `resumeFromRunId`'s journal. */
  priorEvents?: readonly JournalEvent[];
  runStep: StepRunner;
  scheduler: SlotScheduler;
  tracker: BudgetTracker;
  gateHooks: Pick<SandboxHooks, "approve" | "sleep" | "until" | "waitFor" | "sh" | "artifact" | "setState" | "getState">;
  signal: AbortSignal;
  /** Parks while the run is paused. */
  whenRunning(): Promise<void>;
  loadWorkflow?: SandboxHooks["loadWorkflow"];
  /** Side effects of a NEW (not replayed) log line / phase, e.g. the parent's transcript. */
  onLog?(message: string): void;
  onPhase?(title: string): void;
  /** Resolves once gate writes still in flight are durable; rejects with the first failure. */
  flush?(): Promise<void>;
  /** Called the first time a budget refuses an agent. */
  onBudget?(kind: BudgetKind): void;
  /** A step was answered from the journal (not run): lets the engine re-say its end on the parent. */
  onReplayed?(step: { name: string; sessionId: string | null; kind: "completed" | "failed" }): void;
}

export interface DriveOutcome {
  status: Exclude<RunStatus, "running" | "paused">;
  error: string | null;
  result: unknown;
  budget: BudgetKind | null;
}

// ---- helpers --------------------------------------------------------------------

/** A script's free-text label as a step name: the shape the client, the records
    and the child's title all expect. */
export function sanitizeStepName(label: string): string {
  const cleaned = label.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const named = /^[a-z]/.test(cleaned) ? cleaned : `agent-${cleaned}`;
  return named.slice(0, 40).replace(/-+$/, "") || "agent";
}

function ordered(events: readonly JournalEvent[]): JournalEvent[] {
  const seen = new Set<number>();
  const out: JournalEvent[] = [];
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    out.push(event);
  }
  return out;
}

interface Replayed {
  seq: number;
  kind: "completed" | "failed";
  output: unknown;
  sessionId: string | null;
  error?: string;
  tokens: number;
  costUsd: number;
  /** The journal has a `step_started` for it, so the fold counted it as an agent. */
  counted: boolean;
}

/** What a journal already knows about steps. */
export function replayIndex(events: readonly JournalEvent[]): {
  done: Map<string, Replayed>;
  inFlight: Map<string, Recovered>;
  logs: number;
  phases: number;
} {
  const done = new Map<string, Replayed>();
  const started = new Map<string, Recovered>();
  let logs = 0;
  let phases = 0;
  for (const event of ordered(events)) {
    const { payload, key } = event;
    if (payload.kind === "log") logs += 1;
    else if (payload.kind === "phase") phases += 1;
    if (key === null) continue;
    if (payload.kind === "step_started") started.set(key, { sessionId: payload.sessionId, attempt: payload.attempt });
    else if (payload.kind === "step_completed") {
      done.set(key, {
        seq: event.seq,
        kind: "completed",
        output: payload.output,
        sessionId: payload.sessionId,
        tokens: payload.tokens,
        costUsd: payload.costUsd ?? 0,
        counted: started.has(key),
      });
    } else if (payload.kind === "step_failed") {
      done.set(key, {
        seq: event.seq,
        kind: "failed",
        output: payload.output,
        sessionId: payload.sessionId,
        error: payload.error,
        tokens: payload.tokens,
        costUsd: 0,
        counted: started.has(key),
      });
    }
  }
  const inFlight = new Map<string, Recovered>();
  for (const [key, value] of started) if (!done.has(key)) inFlight.set(key, value);
  return { done, inFlight, logs, phases };
}

/** The wall-clock seconds a journal's run has been running, paused time excluded.
    Time between the last event and now is NOT counted (the server was down), and neither
    is the downtime before a `run_recovered`: the open running stretch is closed at the
    last event before it and reopened at the recovery event's own time. */
export function wallSecOf(events: readonly JournalEvent[]): number {
  let running: number | null = null;
  let ms = 0;
  let prevAt: number | null = null;
  let last = 0;
  for (const event of ordered(events)) {
    if (event.at > last) last = event.at;
    const kind = event.payload.kind;
    if (kind === "run_started") running = event.at;
    else if (kind === "run_paused" || kind === "run_finished") {
      if (running !== null) ms += Math.max(0, event.at - running);
      running = null;
    } else if (kind === "run_resumed") running = event.at;
    else if (kind === "run_recovered" && running !== null) {
      ms += Math.max(0, (prevAt ?? running) - running);
      running = event.at;
    }
    prevAt = event.at;
  }
  if (running !== null) ms += Math.max(0, last - running);
  return ms / 1000;
}

/** Usage totals of a journal, for seeding a `BudgetTracker` on a resumed run. */
export function usageOf(events: readonly JournalEvent[]): { tokens: number; costUsd: number; agents: number; wallSec: number } {
  const header = {
    id: "",
    name: "",
    status: "running" as RunStatus,
    error: null,
    createdAt: 0,
    endedAt: null,
    spec: { source: "", meta: { name: "", description: "", phases: [] }, args: null, budgets: {}, flow: {}, trigger: { kind: "agent" as const }, onRestart: "resume" as const },
  };
  const view = foldRun(header, [...events]);
  return { ...view.usage, wallSec: wallSecOf(events) };
}

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === "AbortError";

// ---- the run --------------------------------------------------------------------

export async function drive(opts: DriveOptions): Promise<DriveOutcome> {
  const { spec, signal, tracker } = opts;
  const snapshot = replayIndex(opts.events());
  const priorIndex = opts.priorEvents ? replayIndex(opts.priorEvents) : null;
  const prior = priorIndex?.done ?? new Map<string, Replayed>();
  /* The child thread an earlier run left for a call it did not complete: a step
     that FAILED, and one that was in flight when the run stopped. Read off the
     prior journal's `step_started`/`step_failed`, keyed exactly as the calls are
     — so the continue lands on the same conversation, not a lookalike. */
  const priorChild = new Map<string, Recovered>();
  if (priorIndex) {
    for (const [key, r] of priorIndex.done) {
      if (r.kind === "failed" && r.sessionId) priorChild.set(key, { sessionId: r.sessionId, attempt: 1 });
    }
    for (const [key, r] of priorIndex.inFlight) priorChild.set(key, r);
  }

  const occurrences = new Map<string, number>();
  const usedNames = new Set<string>();
  const uniqueTitle = titleRegistry();
  const registered: { name: string; phase: string | null; title: string }[] = [];
  const phaseNames: string[] = spec.meta.phases.map((p) => p.title);
  let budgetHit: BudgetKind | null = null;
  let logCalls = 0;
  let phaseCalls = 0;
  const pending = new Set<Promise<unknown>>();
  let writeFault: unknown = null;

  /* BUDGET READS ARE REPLAY-CONSISTENT. A resumed run's tracker is seeded with the journal's
     FINAL totals (budgets and the wall clock must continue, not restart), but a script that
     reads `budget.remaining()` in a loop must see what it saw live at the same point, or a
     replay would take a different number of turns than the original. So `usage()` hides the
     part of the seed the script has not observed yet: a replayed step's agent is revealed
     when the script calls it, its tokens/cost when its answer is released (the journaled
     order is the completion order). Live steps add to the tracker as before. */
  const hidden = { tokens: 0, costUsd: 0, agents: 0 };
  for (const r of snapshot.done.values()) {
    hidden.tokens += r.tokens;
    hidden.costUsd += r.costUsd;
    if (r.counted) hidden.agents += 1;
  }
  hidden.agents += snapshot.inFlight.size;
  {
    // A tracker nobody seeded (a test, a fresh run over a partial journal) has nothing to hide.
    const t0 = tracker.usage();
    if (t0.tokens < hidden.tokens) hidden.tokens = 0;
    if (t0.costUsd < hidden.costUsd) hidden.costUsd = 0;
    if (t0.agents < hidden.agents) hidden.agents = 0;
  }
  const reveal = (r: Replayed): void => {
    hidden.tokens = Math.max(0, hidden.tokens - r.tokens);
    hidden.costUsd = Math.max(0, hidden.costUsd - r.costUsd);
  };

  const track = <T>(p: Promise<T>): void => {
    const q = p.then(
      () => undefined,
      (error: unknown) => {
        writeFault ??= error;
      },
    );
    pending.add(q);
    void q.then(() => pending.delete(q));
  };

  const ensurePhase = (title: string): number => {
    let at = phaseNames.indexOf(title);
    if (at === -1) {
      phaseNames.push(title);
      at = phaseNames.length - 1;
    }
    return at;
  };

  const placementOf = (name: string): Placement => {
    const index = registered.findIndex((s) => s.name === name);
    const mine = registered[index];
    const plan: Placement["plan"] = phaseNames.length
      ? phaseNames.map((title) => ({ name: title, steps: registered.filter((s) => s.phase === title).map((s) => s.name) }))
      : [{ name: null, steps: registered.map((s) => s.name) }];
    return {
      index,
      total: registered.length,
      phase: mine?.phase != null ? { index: phaseNames.indexOf(mine.phase), name: mine.phase } : null,
      plan,
      title: mine?.title ?? name,
      titles: Object.fromEntries(registered.map((s) => [s.name, s.title])),
    };
  };

  // Replayed answers leave in journal order, one macrotask apart (see the header).
  const releases: { seq: number; go: () => void }[] = [];
  let releasing = false;
  const releaseInOrder = (seq: number): Promise<void> =>
    new Promise<void>((resolve) => {
      releases.push({ seq, go: resolve });
      if (releasing) return;
      releasing = true;
      setImmediate(function flush() {
        releases.sort((a, b) => a.seq - b.seq);
        const next = releases.shift();
        next?.go();
        if (releases.length) setImmediate(flush);
        else releasing = false;
      });
    });

  const uniqueName = (label: string): string => {
    let name = sanitizeStepName(label);
    if (usedNames.has(name)) {
      let n = 2;
      while (usedNames.has(`${name}-${n}`)) n += 1;
      name = `${name}-${n}`;
    }
    usedNames.add(name);
    return name;
  };

  const refuse = (kind: BudgetKind): never => {
    if (budgetHit === null) {
      budgetHit = kind;
      opts.onBudget?.(kind);
    }
    throw new BudgetExceeded(budgetHit);
  };

  const runOne = async (agentSpec: AgentSpec, key: string, name: string, recovered: Recovered | null): Promise<unknown> => {
    // (1) The journal already answered this call.
    const own = snapshot.done.get(key);
    if (own) {
      await releaseInOrder(own.seq);
      reveal(own);
      opts.onReplayed?.({ name, sessionId: own.sessionId, kind: own.kind });
      // Same shape the live path hands back: a jsonb round trip reorders keys.
      if (own.kind === "completed") return canon(own.output);
      throw new Error(own.error ?? `step "${name}" failed`);
    }
    // (2) A run being resumed answered it.
    const earlier = prior.get(key);
    if (earlier && earlier.kind === "completed") {
      await opts.append(key, {
        kind: "step_completed",
        name,
        output: earlier.output,
        sessionId: earlier.sessionId,
        tokens: 0,
        toolUses: 0,
      });
      await releaseInOrder(earlier.seq);
      return canon(earlier.output);
    }
    // (3) Budgets. A step that was already counted before the restart is not counted twice.
    if (budgetHit !== null) throw new BudgetExceeded(budgetHit);
    const over = tracker.exceeded();
    if (over) refuse(over);
    if (!recovered && !tracker.tryStartAgent()) refuse("agents");

    // (5, 6) A slot, with the run's width and the step's priority / key; a held run waits first.
    await opts.whenRunning();
    let release: () => void;
    try {
      release = await opts.scheduler.acquire({
        runId: opts.runId,
        priority: agentSpec.priority ?? opts.spec.flow.priority ?? 0,
        runConcurrency: Math.min(opts.spec.flow.concurrency ?? ENGINE_LIMITS.defaultConcurrency, ENGINE_LIMITS.maxConcurrency),
        ...(agentSpec.concurrencyKey ?? opts.spec.flow.concurrencyKey
          ? { key: (agentSpec.concurrencyKey ?? opts.spec.flow.concurrencyKey)!, keyLimit: 1 }
          : {}),
        signal,
      });
    } catch (error) {
      if (isAbort(error) || signal.aborted) throw new ScriptError("the run was cancelled");
      throw error;
    }
    try {
      await opts.whenRunning();
      if (signal.aborted) throw new ScriptError("the run was cancelled");
      // Budget crossed while this call waited for its slot.
      if (budgetHit !== null) throw new BudgetExceeded(budgetHit);
      const crossed = tracker.exceeded();
      if (crossed) refuse(crossed);

      // (7) Run it.
      try {
        const outcome = await opts.runStep({
          spec: agentSpec,
          key,
          name,
          recovered,
          ...(priorChild.has(key) ? { resume: priorChild.get(key)! } : {}),
          placement: placementOf(name),
          append: (payload) => opts.append(key, payload),
          signal,
        });
        tracker.addUsage({ tokens: outcome.tokens, costUsd: outcome.costUsd ?? 0 });
        return canon(outcome.output);
      } catch (error) {
        const spent = error as { tokens?: unknown; costUsd?: unknown };
        tracker.addUsage({
          tokens: typeof spent.tokens === "number" ? spent.tokens : 0,
          costUsd: typeof spent.costUsd === "number" ? spent.costUsd : 0,
        });
        throw error;
      }
    } finally {
      release(); // (8)
    }
  };

  /* Values the gates hand the script (a signal's payload, a state read, a shell's answer) crossed
     the journal too, so they get the same canonical shape on the live and the replayed side. */
  const gate = opts.gateHooks;
  const hooks: SandboxHooks = {
    ...gate,
    waitFor: async (name, o) => canon(await gate.waitFor(name, o)),
    sh: async (cmd, o) => canon(await gate.sh(cmd, o)),
    getState: (path) => canon(gate.getState(path)),
    agent(agentSpec) {
      // Everything order-sensitive happens here, before the first await.
      const hash = callHash(keyFields(agentSpec));
      const occurrence = occurrences.get(hash) ?? 0;
      occurrences.set(hash, occurrence + 1);
      const key = stepKey(hash, occurrence);
      const name = uniqueName(agentSpec.label);
      if (agentSpec.phase !== null) ensurePhase(agentSpec.phase);
      registered.push({ name, phase: agentSpec.phase, title: uniqueTitle(agentSpec.title ?? agentSpec.label) });
      const seen = snapshot.done.get(key);
      if (seen?.counted || snapshot.inFlight.has(key)) hidden.agents = Math.max(0, hidden.agents - 1);
      return runOne(agentSpec, key, name, snapshot.inFlight.get(key) ?? null);
    },
    phase(title) {
      ensurePhase(title);
      phaseCalls += 1;
      if (phaseCalls <= snapshot.phases) return;
      opts.onPhase?.(title);
      track(opts.append(null, { kind: "phase", title }));
    },
    log(message) {
      logCalls += 1;
      if (logCalls <= snapshot.logs) return;
      opts.onLog?.(message);
      track(opts.append(null, { kind: "log", message }));
    },
    usage: () => {
      const u = tracker.usage();
      return {
        tokens: Math.max(0, u.tokens - hidden.tokens),
        costUsd: Math.max(0, u.costUsd - hidden.costUsd),
        agents: Math.max(0, u.agents - hidden.agents),
      };
    },
    budgets: () => tracker.budgets(),
    signal,
    ...(opts.loadWorkflow ? { loadWorkflow: opts.loadWorkflow } : {}),
  };

  const settle = async (): Promise<unknown> => {
    // Writes the script did not wait for (log, phase, state) are durable before the run is called over.
    while (pending.size) await Promise.all([...pending]);
    await opts.flush?.();
    if (writeFault !== null) throw writeFault;
    return undefined;
  };

  try {
    // `args` and `result` go through canon like every value that crosses the journal.
    const { result: raw } = await runScript({ source: spec.source, args: canon(spec.args), hooks });
    const result = canon(raw);
    try {
      await settle();
    } catch (error) {
      return { status: "failed", error: `could not write the journal: ${messageOf(error)}`, result: result ?? null, budget: budgetHit };
    }
    return budgetHit !== null
      ? { status: "budget_exceeded", error: `budget exceeded: ${budgetHit}`, result: result ?? null, budget: budgetHit }
      : { status: "completed", error: null, result: result ?? null, budget: null };
  } catch (error) {
    await settle().catch(() => {});
    if (budgetHit !== null) {
      return { status: "budget_exceeded", error: `budget exceeded: ${budgetHit}`, result: null, budget: budgetHit };
    }
    if (signal.aborted) return { status: "cancelled", error: "cancelled", result: null, budget: null };
    return { status: "failed", error: messageOf(error), result: null, budget: null };
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}
