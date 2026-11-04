/*
 * Workflow engine v2: the fold. Pure — no database, config or session imports.
 *
 * The journal is the state; `foldRun` turns a run's header and its events into
 * the `RunView` every tool, route and client reads, and `stepOutputs` hands the
 * engine the answers it replays. Both tolerate what a real journal does to a
 * reader: a row delivered twice (same seq, the second is ignored) and rows out
 * of order (sorted by seq first).
 */
import {
  canon,
  runKindOf,
  type GateView,
  type JournalEvent,
  type RunSpec,
  type RunStatus,
  type RunView,
  type StepView,
} from "./types.js";

/** Lines of `log` a view keeps; the newest win. */
export const LOG_CAP = 500;

export interface RunHeaderInput {
  id: string;
  name: string;
  status: RunStatus;
  error: string | null;
  createdAt: number;
  endedAt: number | null;
  spec: RunSpec;
}

/** Sorted by seq, the first row of each seq kept. */
function ordered(events: JournalEvent[]): JournalEvent[] {
  const seen = new Set<number>();
  const out: JournalEvent[] = [];
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    out.push(event);
  }
  return out;
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Set `value` at a dot path, creating (or replacing non-object) parents on the way. */
function setPath(state: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".").filter((part) => part !== "");
  if (parts.length === 0 || parts.some((part) => UNSAFE_KEYS.has(part))) return;
  let cursor = state;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i]!;
    const next = cursor[part];
    if (isObject(next)) {
      cursor = next;
    } else {
      const created: Record<string, unknown> = {};
      cursor[part] = created;
      cursor = created;
    }
  }
  cursor[parts[parts.length - 1]!] = value;
}

function blankStep(key: string, name: string): StepView {
  return {
    name,
    key,
    phase: null,
    status: "pending",
    sessionId: null,
    attempt: 0,
    output: undefined,
    error: null,
    startedAt: null,
    endedAt: null,
    tokens: 0,
    toolUses: 0,
    costUsd: 0,
  };
}

export function foldRun(header: RunHeaderInput, events: JournalEvent[]): RunView {
  const steps = new Map<string, StepView>();
  const started = new Set<string>();
  const gates = new Map<string, GateView>();
  const state: Record<string, unknown> = {};
  const artifacts: RunView["artifacts"] = [];
  const logs: string[] = [];
  const phases: RunView["phases"] = (header.spec?.meta?.phases ?? []).map((phase) =>
    phase.detail === undefined ? { name: phase.title } : { name: phase.title, detail: phase.detail },
  );
  let finished: Extract<JournalEvent["payload"], { kind: "run_finished" }> | null = null;
  let finishedAt: number | null = null;

  const step = (key: string, name: string): StepView => {
    let view = steps.get(key);
    if (!view) {
      view = blankStep(key, name);
      steps.set(key, view);
    }
    return view;
  };

  for (const event of ordered(events)) {
    const { payload, key } = event;
    switch (payload.kind) {
      case "step_started": {
        if (key === null) break;
        const view = step(key, payload.name);
        view.name = payload.name;
        view.phase = payload.phase;
        view.sessionId = payload.sessionId || null;
        view.attempt = payload.attempt;
        view.startedAt = payload.startedAt;
        view.endedAt = null;
        view.error = null;
        view.status = "running";
        started.add(key);
        break;
      }
      case "step_retry": {
        if (key === null) break;
        const view = step(key, payload.name);
        view.status = "retrying";
        view.error = payload.error;
        break;
      }
      case "step_completed": {
        if (key === null) break;
        const view = step(key, payload.name);
        view.status = "completed";
        view.output = canon(payload.output);
        if (payload.sessionId !== null) view.sessionId = payload.sessionId;
        view.tokens = payload.tokens;
        view.toolUses = payload.toolUses;
        view.costUsd = payload.costUsd ?? 0;
        view.error = null;
        view.endedAt = event.at;
        break;
      }
      case "step_failed": {
        if (key === null) break;
        const view = step(key, payload.name);
        view.status = "failed";
        view.error = payload.error;
        if (payload.output !== undefined) view.output = canon(payload.output);
        if (payload.sessionId !== null) view.sessionId = payload.sessionId;
        view.tokens = payload.tokens;
        view.toolUses = payload.toolUses;
        view.endedAt = event.at;
        break;
      }
      case "step_skipped": {
        if (key === null) break;
        const view = step(key, payload.name);
        view.status = "skipped";
        // The reason rides on `error`: a StepView has no other place to say why.
        view.error = payload.reason;
        view.endedAt = event.at;
        break;
      }
      case "approval_asked": {
        const gateKey = key ?? `gate:${event.seq}`;
        gates.set(gateKey, {
          key: gateKey,
          kind: "approval",
          status: "waiting",
          text: payload.text,
          options: payload.options,
        });
        break;
      }
      case "approval_answered": {
        const gateKey = key ?? `gate:${event.seq}`;
        const gate: GateView = gates.get(gateKey) ?? { key: gateKey, kind: "approval", status: "waiting" };
        gate.status = payload.choice === null ? "timed_out" : "resolved";
        gate.choice = payload.choice;
        gates.set(gateKey, gate);
        break;
      }
      case "timer_set": {
        const gateKey = key ?? `timer:${event.seq}`;
        gates.set(gateKey, {
          key: gateKey,
          kind: "timer",
          status: "waiting",
          text: payload.reason,
          fireAt: payload.fireAt,
        });
        break;
      }
      case "timer_fired": {
        const gateKey = key ?? `timer:${event.seq}`;
        const gate: GateView = gates.get(gateKey) ?? { key: gateKey, kind: "timer", status: "waiting" };
        gate.status = "resolved";
        gates.set(gateKey, gate);
        break;
      }
      case "signal_waiting": {
        const gateKey = key ?? `signal:${payload.name}`;
        gates.set(gateKey, { key: gateKey, kind: "signal", status: "waiting", signal: payload.name });
        break;
      }
      case "signal_received": {
        const gateKey = key ?? `signal:${payload.name}`;
        const gate: GateView = gates.get(gateKey) ?? {
          key: gateKey,
          kind: "signal",
          status: "waiting",
          signal: payload.name,
        };
        gate.status = "resolved";
        gates.set(gateKey, gate);
        break;
      }
      case "state_set":
        setPath(state, payload.path, canon(payload.value));
        break;
      case "artifact":
        artifacts.push({ name: payload.name, relPath: payload.relPath, bytes: payload.bytes });
        break;
      case "log":
        logs.push(payload.message);
        if (logs.length > LOG_CAP) logs.splice(0, logs.length - LOG_CAP);
        break;
      case "phase":
        if (!phases.some((phase) => phase.name === payload.title)) phases.push({ name: payload.title });
        break;
      case "run_finished":
        finished = payload;
        finishedAt = event.at;
        break;
      case "run_started":
      case "shell":
      case "shell_started":
      case "run_paused":
      case "run_resumed":
      case "run_recovered":
      case "workflow_loaded":
        break;
      default:
        /* Nothing to fold into the view. Any kind a LATER build writes lands here too: an old
           reader of a newer journal must skip what it does not know, never throw. */
        break;
    }
  }

  let tokens = 0;
  let costUsd = 0;
  for (const view of steps.values()) {
    if (view.status === "completed" || view.status === "failed") {
      tokens += view.tokens;
      costUsd += view.costUsd;
    }
  }

  const view: RunView = {
    id: header.id,
    name: header.name,
    status: finished ? finished.status : header.status,
    error: finished ? finished.error : header.error,
    createdAt: header.createdAt,
    endedAt: header.endedAt ?? finishedAt,
    phases,
    steps: [...steps.values()],
    gates: [...gates.values()],
    state,
    artifacts,
    logs,
    usage: { tokens, costUsd, agents: started.size },
    budgets: header.spec?.budgets ?? {},
    kind: runKindOf(header.spec),
  };
  if (finished) view.result = canon(finished.result);
  return view;
}

/** The completed steps by key, last answer winning: what a replay serves. */
export function stepOutputs(events: JournalEvent[]): Map<string, { output: unknown; sessionId: string | null }> {
  const out = new Map<string, { output: unknown; sessionId: string | null }>();
  for (const event of ordered(events)) {
    if (event.payload.kind !== "step_completed" || event.key === null) continue;
    out.set(event.key, { output: canon(event.payload.output), sessionId: event.payload.sessionId });
  }
  return out;
}
