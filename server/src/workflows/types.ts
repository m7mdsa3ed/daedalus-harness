/*
 * Workflow engine v2: the shared contract.
 *
 * Types only (plus two tiny pure helpers). Every module in `workflows/` imports
 * from here and from nowhere sideways for shapes, so they can be written in
 * parallel. See docs/workflow-engine-v2.md for the why.
 *
 * Nothing in this file may import the database, the config or the session
 * manager: `sandbox.ts`, `graph.ts` and `journal.ts`'s fold are pure and are
 * unit-tested without an agent.
 */
import { createHash } from "node:crypto";

// ---- run header ----------------------------------------------------------

export type RunStatus =
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  /** A budget (tokens, cost, agents, wall time) stopped the run. Partial result kept. */
  | "budget_exceeded";

export const isTerminal = (s: RunStatus): boolean => s !== "running" && s !== "paused";

/** What started a run. */
export type Trigger =
  | { kind: "agent" } // run_workflow / run_script from a thread
  | { kind: "user" } // Run button
  | { kind: "routine"; routineId: string }
  | { kind: "schedule"; scheduleId: string }
  | { kind: "webhook"; hook: string }
  | { kind: "resume"; fromRunId: string };

export interface Budgets {
  /** Output tokens, all agents of the run. */
  tokens?: number;
  /** Estimated spend in USD. */
  costUsd?: number;
  /** Agents (steps) the run may start in its lifetime. */
  agents?: number;
  /** Wall-clock seconds, paused time excluded. */
  wallSec?: number;
}

/** Global flow control for one run. */
export interface FlowControl {
  /** Higher runs first when the global semaphore is contended. Default 0. */
  priority?: number;
  /** Steps of this run running at once. Default 5. */
  concurrency?: number;
  /** Runs sharing a key share one concurrency pool (e.g. one writer per repo). */
  concurrencyKey?: string;
}

/** Everything the engine needs to (re)start a run; stored on `workflow_runs`. */
export interface RunSpec {
  /** The program. A JSON definition is compiled to this by `graph.ts`. */
  source: string;
  meta: ScriptMeta;
  args: unknown;
  budgets: Budgets;
  flow: FlowControl;
  trigger: Trigger;
  /** How a step in flight at a restart is treated unless it says otherwise. */
  onRestart: OnRestart;
  /** Run-level wall clock in seconds that FAILS the run (paused time excluded). Absent = engine default. */
  totalTimeoutSec?: number;
  /** Set when the run is an `ask_agent`: the pair it went to. */
  ask?: { agent: string; profile: string; agentId: string; profileId: string; description?: string };
  /** An ask's pass-through agent() options, kept so `continue_agent` repeats them. */
  askOptions?: Record<string, unknown>;
}

export type OnRestart = "resume" | "rerun" | "fail";

export interface ScriptMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases: { title: string; detail?: string }[];
  /** JSON Schema for `args`; drives the Run form and validates a start. */
  inputs?: Record<string, unknown>;
}

// ---- agent() ------------------------------------------------------------

export interface RetryPolicy {
  /** Extra attempts after the first. */
  max: number;
  /** Seconds before retry n (1-based) is `backoffSec * 2^(n-1)`. Default 2. */
  backoffSec?: number;
  /** Model used from the second attempt on. */
  fallbackModel?: string;
}

/** What `agent(prompt, opts)` hands the engine. Pure data, so it hashes. */
export interface AgentSpec {
  prompt: string;
  label: string;
  /** What the step reads by (`titles.ts`). Display only: never part of the replay key. */
  title?: string;
  /** null = no phase. */
  phase: string | null;
  /** JSON Schema: the reply must be one ```json fence matching it. */
  schema?: Record<string, unknown>;
  model?: string;
  effort?: string;
  isolation?: "worktree";
  projectId?: string;
  /** Library slash command whose body leads the prompt. */
  agentType?: string;
  /** Another (profile, agent) pair, by id or name (replaces `ask_agent`). */
  profile?: string;
  agent?: string;
  system?: string;
  retry?: RetryPolicy;
  /** Tool names the step may / may not use (by the runtime's own names). */
  tools?: { allow?: string[]; deny?: string[] };
  timeoutSec?: number;
  onRestart?: OnRestart;
  /** Continue this child thread instead of spawning (replaces `continue_agent`). */
  resumeSession?: string;
  /** Steps with the same key never run at once, across runs. */
  concurrencyKey?: string;
  priority?: number;
}

/** The part of an AgentSpec that decides whether a journaled answer is still valid. */
export function keyFields(spec: AgentSpec): unknown[] {
  return [
    spec.prompt,
    spec.schema ?? null,
    spec.model ?? null,
    spec.effort ?? null,
    spec.isolation ?? null,
    spec.projectId ?? null,
    spec.agentType ?? null,
    spec.profile ?? null,
    spec.agent ?? null,
    spec.system ?? null,
    spec.tools ?? null,
  ];
}

/**
 * Canonical JSON: object keys sorted recursively, `undefined` dropped. Postgres `jsonb`
 * reorders keys (by length, then alphabetically), so a value that crossed the journal comes
 * back with a different key order than the one the script produced live. Anything hashed or
 * handed back to a replaying script must go through this on BOTH sides.
 */
export function canon<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => canon(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canon(v);
    }
    return out as T;
  }
  return value;
}

/** Hash of a call. The step key is `<hash>#<n>` where n counts earlier calls with the same hash. */
export function callHash(fields: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(canon(fields))).digest("hex").slice(0, 32);
}

export const stepKey = (hash: string, occurrence: number): string => `${hash}#${occurrence}`;

// ---- journal -------------------------------------------------------------

/**
 * One row of `workflow_events`: `(run_id, seq)` is the primary key, `seq`
 * starts at 1 and has no gaps. `key` names the call the event belongs to
 * (a step key, or `gate:<n>`/`timer:<n>`/`signal:<name>` for the gates).
 */
export type JournalPayload =
  | { kind: "run_started"; spec: RunSpec }
  | { kind: "phase"; title: string }
  | { kind: "log"; message: string }
  | { kind: "step_started"; name: string; phase: string | null; sessionId: string; attempt: number; startedAt: number }
  | { kind: "step_retry"; name: string; attempt: number; error: string; backoffSec: number; model?: string }
  | { kind: "step_completed"; name: string; output: unknown; sessionId: string | null; tokens: number; toolUses: number; costUsd?: number }
  | { kind: "step_failed"; name: string; error: string; output?: unknown; sessionId: string | null; tokens: number; toolUses: number }
  | { kind: "step_skipped"; name: string; reason: string }
  | { kind: "approval_asked"; text: string; options: string[]; timeoutSec?: number; askedAt: number }
  | { kind: "approval_answered"; choice: string | null; by: string; reason?: string }
  | { kind: "timer_set"; fireAt: number; reason: string }
  | { kind: "timer_fired" }
  | { kind: "signal_waiting"; name: string; timeoutSec?: number; waitedAt: number }
  | { kind: "signal_received"; name: string; value: unknown }
  | { kind: "state_set"; path: string; value: unknown }
  | { kind: "artifact"; name: string; relPath: string; bytes: number }
  | { kind: "shell"; cmd: string; cwd: string | null; exitCode: number; stdout: string; stderr: string }
  | { kind: "run_paused" }
  | { kind: "run_resumed" }
  /** Written at boot for every run being resumed: the downtime before it is NOT run time. */
  | { kind: "run_recovered" }
  | { kind: "shell_started"; cmd: string; cwd: string | null }
  | { kind: "workflow_loaded"; ref: string; sha: string; source: string }
  | { kind: "run_finished"; status: RunStatus; error: string | null; result: unknown };

export type JournalKind = JournalPayload["kind"];

export interface JournalEvent {
  runId: string;
  seq: number;
  at: number;
  key: string | null;
  payload: JournalPayload;
}

// ---- folded view -----------------------------------------------------------

export type StepStatus =
  | "pending"
  | "running"
  | "retrying"
  | "awaiting_approval"
  | "sleeping"
  | "waiting_signal"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped";

/** One step as the tools, routes and client report it: a fold over the journal. */
export interface StepView {
  name: string;
  key: string;
  phase: string | null;
  status: StepStatus;
  sessionId: string | null;
  attempt: number;
  output: unknown;
  error: string | null;
  startedAt: number | null;
  endedAt: number | null;
  tokens: number;
  toolUses: number;
  costUsd: number;
}

export interface GateView {
  key: string;
  kind: "approval" | "timer" | "signal";
  status: "waiting" | "resolved" | "timed_out";
  text?: string;
  options?: string[];
  fireAt?: number;
  signal?: string;
  choice?: string | null;
}

export interface RunView {
  id: string;
  name: string;
  status: RunStatus;
  error: string | null;
  createdAt: number;
  endedAt: number | null;
  phases: { name: string; detail?: string }[];
  steps: StepView[];
  gates: GateView[];
  state: Record<string, unknown>;
  artifacts: { name: string; relPath: string; bytes: number }[];
  logs: string[];
  usage: { tokens: number; costUsd: number; agents: number };
  budgets: Budgets;
  /** The script's own return value (or a compiled definition's step outputs). */
  result?: unknown;
}

// ---- sandbox <-> engine ------------------------------------------------------

/**
 * What the engine hands the sandbox. The sandbox is deterministic JavaScript
 * over these callbacks and never touches the database or a session. Every
 * callback that does real work is *keyed by the engine* from the call's
 * arguments, so the sandbox needs no knowledge of the journal.
 */
export interface SandboxHooks {
  agent(spec: AgentSpec): Promise<unknown>;
  approve(text: string, opts: { options: string[]; timeoutSec?: number }): Promise<string | null>;
  sleep(seconds: number): Promise<void>;
  until(isoTimestamp: string): Promise<void>;
  waitFor(name: string, opts: { timeoutSec?: number }): Promise<unknown>;
  sh(cmd: string, opts: { cwd?: string; timeoutSec?: number; idempotent?: boolean }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  artifact(name: string, data: unknown): Promise<void>;
  setState(path: string, value: unknown): void;
  getState(path: string): unknown;
  loadWorkflow?(ref: string | { scriptPath: string }): Promise<string>;
  phase(title: string): void;
  log(message: string): void;
  /** Run totals so far, for `budget`. */
  usage(): { tokens: number; costUsd: number; agents: number };
  budgets(): Budgets;
  signal: AbortSignal;
}

export const SCRIPT_LIMITS = {
  sourceBytes: 256 * 1024,
  /** Agents one run may start. Overridden downward by `Budgets.agents`. */
  maxAgents: 1000,
  maxItems: 4096,
  syncTimeoutMs: 5_000,
  maxPhases: 32,
  maxLabel: 80,
  /** Rounds a `refine` may run when the script names none. */
  defaultRounds: 3,
} as const;

export const ENGINE_LIMITS = {
  /** Child threads alive at once, all runs. */
  liveChildren: 16,
  /** Per run, unless FlowControl.concurrency. */
  defaultConcurrency: 5,
  maxConcurrency: 16,
  runsPerParent: 3,
  stepTimeoutSec: { default: 15 * 60, max: 6 * 60 * 60 },
  totalTimeoutSec: { default: 2 * 60 * 60, max: 24 * 60 * 60 },
  outputBytes: 256 * 1024,
} as const;

// ---- engine <-> gates seam ---------------------------------------------------

/**
 * What `gates.ts` needs from the engine. The engine implements this once per
 * run and hands it to `Gates`; gates never import the engine, the session
 * manager or the database.
 */
export interface GateHost {
  runId: string;
  /** Append a journal event and fold it into the live view; resolves once durable. */
  append(key: string | null, payload: JournalPayload): Promise<JournalEvent>;
  /** Events already journaled for this run (the replay source). */
  events(): readonly JournalEvent[];
  /** Aborted on cancel; every gate wait races it. */
  signal: AbortSignal;
  /** Resolves immediately while running, parks while the run is paused. */
  whenRunning(): Promise<void>;
  /** A pausable clock: `ms` of *running* time. Resolves true when it elapses, false on abort. */
  timer(ms: number): Promise<boolean>;
  now(): number;
  /** The directory the run may write artifacts to (created on demand). */
  artifactDir(): Promise<string>;
  /** Project cwd for `sh`. */
  cwd(): string;
  /** Park a question where the person is (inbox + parent transcript). Resolves with the
      chosen option, or null when `timeoutSec` elapses or the run is cancelled. The engine
      owns how (bridge.pending); the gate owns the journal. */
  ask(question: { text: string; options: string[]; timeoutSec?: number }): { id: string; answer: Promise<string | null> };
  /** Withdraw a parked question (answered elsewhere, timed out, run cancelled). */
  withdraw(id: string): void;
  /** Run a shell command in `cwd` under the parent's permission policy; the engine decides
      whether it needs a prompt. Rejects if denied. */
  exec(cmd: string, opts: { cwd: string; timeoutSec: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/** The slice of `Gates` the engine and routes call. */
export interface GatesApi {
  /** SandboxHooks implementations; the engine spreads these into its hooks. */
  hooks(): Pick<SandboxHooks, "approve" | "sleep" | "until" | "waitFor" | "sh" | "artifact" | "setState" | "getState">;
  /** Deliver an external signal (route / `signal_workflow` tool). Returns false if nobody is waiting AND the name is unknown. */
  signal(name: string, value: unknown): Promise<boolean>;
  /** Answer a parked approval from the UI/route by its gate key. */
  answerApproval(gateKey: string, choice: string, by: string): Promise<boolean>;
  /** Timers that were set before a restart and still have time left, so the engine can re-arm. */
  pendingTimers(): { key: string; fireAt: number }[];
}

// ---- MCP server names ----------------------------------------------------------

/** The MCP server's name: what the agent sees the tools under
    (`mcp__workflow__run_workflow` in Claude Code, `mcp.workflow.run_workflow` in Codex). */
export const WORKFLOW_SERVER_NAME = "workflow";
/** The `agents` MCP server: one thread asking another (profile, agent) pair. */
export const AGENTS_SERVER_NAME = "agents";
/** The `harness` MCP server: the agent managing this harness. */
export const HARNESS_SERVER_NAME = "harness";
