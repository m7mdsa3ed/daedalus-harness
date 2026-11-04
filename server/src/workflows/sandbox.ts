/*
 * The deterministic script runtime of the workflow engine (v2).
 *
 * Ported from `workflow-script.ts` (v1) and extended; see
 * docs/workflow-engine-v2.md for the why. The v1 file's long argument for
 * running an agent-authored program at all still holds and is not repeated: the
 * agent writing the script already runs shell commands here, so this is NOT a
 * security boundary, only a guard against accidents and a way to make the
 * failure legible. What it *is* is a determinism boundary.
 *
 * **Replay is the contract.** The engine journals every await point by a key it
 * derives from the call's arguments, and resumes a run by running the script
 * again from the top and answering each keyed call from the journal. So this
 * file must (a) call the hooks in an order that depends on nothing but the
 * script and its args — no clock, no randomness, no `Promise.race` ordering
 * tricks (`race` is the one documented exception, see there) — and (b) hand the
 * hooks plain host-realm JSON that hashes the same on every run.
 *
 * PURE: no database, no session manager. It only talks to `SandboxHooks`, so it
 * is unit-tested with a fake (`test/workflow-sandbox.test.ts`).
 */
import vm from "node:vm";
import { stepTitle } from "./titles.js";
import {
  ENGINE_LIMITS,
  SCRIPT_LIMITS,
  type AgentSpec,
  type OnRestart,
  type RetryPolicy,
  type SandboxHooks,
  type ScriptMeta,
} from "./types.js";

export class ScriptError extends Error {}

/** What `budget.remaining()` answers when there is no target. A large *finite*
    number (not `Infinity`) so it survives JSON, arithmetic and a UI meter; a
    script that wants "is there a target" reads `budget.total !== null`. */
export const UNLIMITED = Number.MAX_SAFE_INTEGER;

const MAX_SLEEP_SEC = 30 * 24 * 60 * 60;
const MAX_VOTE_CANDIDATE_CHARS = 20_000;
const NAME_RE = /^[\w.-]{1,80}$/;
const PATH_RE = /^[\w.-]{1,200}$/;
const SH_MAX_BYTES = 8 * 1024;

// ---- meta ----------------------------------------------------------------

/**
 * `export const meta = {…}`, read without running anything else.
 *
 * The engine needs the name, the phase list and the input schema *before* the
 * script runs — they name the run, draw its outline and build the Run form —
 * and Claude Code requires the object to be a pure literal for the same reason.
 * Evaluated as an expression in an empty context, so a `meta` that tries to
 * compute itself fails here rather than producing a name nobody can predict.
 */
export function extractMeta(source: string): ScriptMeta {
  const match = /(^|\n)\s*export\s+const\s+meta\s*=/.exec(source);
  if (!match) {
    throw new ScriptError("a workflow script must begin with `export const meta = { name, description }`");
  }
  const start = source.indexOf("=", match.index) + 1;
  const literal = source.slice(start, balancedEnd(source, start));
  let value: unknown;
  try {
    value = vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 1000 });
  } catch (error) {
    throw new ScriptError(
      `\`meta\` must be a literal object — no variables, calls or interpolation (${describeError(error)})`,
    );
  }
  const meta = value as (Partial<ScriptMeta> & { inputs?: unknown }) | null;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new ScriptError("`meta` must be an object");
  const name = typeof meta.name === "string" ? meta.name.trim() : "";
  const description = typeof meta.description === "string" ? meta.description.trim() : "";
  if (!name) throw new ScriptError("`meta.name` is required");
  if (!description) throw new ScriptError("`meta.description` is required");
  const phases: ScriptMeta["phases"] = [];
  if (meta.phases !== undefined) {
    if (!Array.isArray(meta.phases)) throw new ScriptError("`meta.phases` must be an array");
    for (const entry of meta.phases.slice(0, SCRIPT_LIMITS.maxPhases)) {
      const title = typeof (entry as { title?: unknown })?.title === "string" ? (entry as { title: string }).title.trim() : "";
      if (!title) continue;
      const detail = (entry as { detail?: unknown }).detail;
      phases.push({ title: title.slice(0, SCRIPT_LIMITS.maxLabel), ...(typeof detail === "string" ? { detail } : {}) });
    }
  }
  const whenToUse = typeof meta.whenToUse === "string" ? meta.whenToUse.trim().slice(0, 500) : "";
  let inputs: Record<string, unknown> | undefined;
  if (meta.inputs !== undefined && meta.inputs !== null) {
    if (typeof meta.inputs !== "object" || Array.isArray(meta.inputs)) {
      throw new ScriptError("`meta.inputs` must be a JSON Schema object");
    }
    // Back into the host realm, so it stores, hashes and compares like any other JSON.
    inputs = cloneJson(meta.inputs, "meta.inputs") as Record<string, unknown>;
  }
  const plan = planOf((meta as { plan?: unknown }).plan);
  return {
    name: name.slice(0, 80),
    description: description.slice(0, 500),
    ...(whenToUse ? { whenToUse } : {}),
    phases,
    ...(plan ? { plan } : {}),
    ...(inputs ? { inputs } : {}),
  };
}

/** A `meta.plan` as the compiler writes it, or nothing: a malformed one is
    dropped rather than refused, because it only decides what a card draws. */
function planOf(raw: unknown): ScriptMeta["plan"] {
  if (!Array.isArray(raw)) return undefined;
  const out: NonNullable<ScriptMeta["plan"]> = [];
  for (const phase of raw.slice(0, SCRIPT_LIMITS.maxPhases)) {
    const p = phase as { name?: unknown; steps?: unknown };
    if (!Array.isArray(p?.steps)) return undefined;
    const steps: { name: string; title: string }[] = [];
    for (const step of p.steps) {
      const s = step as { name?: unknown; title?: unknown };
      if (typeof s?.name !== "string" || !s.name) return undefined;
      steps.push({ name: s.name, title: typeof s.title === "string" && s.title ? s.title.slice(0, SCRIPT_LIMITS.maxLabel) : s.name });
    }
    out.push({ name: typeof p.name === "string" && p.name ? p.name.slice(0, SCRIPT_LIMITS.maxLabel) : null, steps });
  }
  return out.length ? out : undefined;
}

/** The end of the object literal that starts at `from`, by brace depth, with
    strings, template literals and comments skipped so a `}` inside one does not
    close it early. */
export function balancedEnd(source: string, from: string | number): number {
  let i = typeof from === "number" ? from : 0;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  if (source[i] !== "{") throw new ScriptError("`meta` must be an object literal");
  let depth = 0;
  for (; i < source.length; i += 1) {
    const c = source[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < source.length && source[i] !== quote) i += source[i] === "\\" ? 2 : 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      i = source.indexOf("*/", i + 2);
      if (i === -1) throw new ScriptError("unterminated comment in `meta`");
      i += 1;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  throw new ScriptError("`meta` is not a closed object literal");
}

/** A clock a script may not read. Claude Code forbids these so a run can be
    replayed from its cached results; ours forbids them so the two engines take
    the same scripts, and so a "flaky" workflow cannot be blamed on a clock. */
function forbidden(what: string): () => never {
  return () => {
    throw new ScriptError(
      `${what} is not available in a workflow script — it would make the run unreplayable. ` +
        "Pass a timestamp in through `args`, or vary a prompt by its index.",
    );
  };
}

// ---- small helpers ---------------------------------------------------------

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  // An error made inside the script's realm is not `instanceof` our Error.
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A value as plain host-realm JSON; functions, symbols and bigints are refused
    rather than silently dropped. A property that is `undefined` is dropped, as
    JSON does. */
function cloneJson(value: unknown, what: string): unknown {
  if (value === undefined) return undefined;
  let text: string | undefined;
  try {
    text = JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") {
        throw new ScriptError(`${what}: ${typeof v}s cannot be stored — values must be plain JSON`);
      }
      return v;
    });
  } catch (error) {
    if (error instanceof ScriptError) throw error;
    throw new ScriptError(`${what}: value is not JSON-serialisable (${describeError(error)})`);
  }
  return text === undefined ? undefined : (JSON.parse(text) as unknown);
}

/** Key-sorted JSON, so two objects that say the same thing compare equal. */
function stable(value: unknown): string {
  try {
    const text = JSON.stringify(value, (_k, v: unknown) =>
      isPlainObject(v)
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
        : v,
    );
    return text ?? "undefined";
  } catch {
    return String(value);
  }
}

function str(value: unknown, what: string, opts: { max?: number } = {}): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ScriptError(`${what} must be a string`);
  if (opts.max !== undefined && value.length > opts.max) throw new ScriptError(`${what} is at most ${opts.max} characters`);
  return value.trim() ? value : undefined;
}

function num(value: unknown, what: string, opts: { min?: number; max?: number; int?: boolean; gt?: number } = {}): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ScriptError(`${what} must be a finite number`);
  if (opts.int && !Number.isInteger(value)) throw new ScriptError(`${what} must be an integer`);
  if (opts.min !== undefined && value < opts.min) throw new ScriptError(`${what} must be at least ${opts.min}`);
  if (opts.gt !== undefined && value <= opts.gt) throw new ScriptError(`${what} must be greater than ${opts.gt}`);
  if (opts.max !== undefined && value > opts.max) throw new ScriptError(`${what} must be at most ${opts.max}`);
  return value;
}

function strList(value: unknown, what: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim())) {
    throw new ScriptError(`${what} must be an array of non-empty strings`);
  }
  return value.slice() as string[];
}

function checkOptions(options: unknown, what: string, valid: readonly string[]): Record<string, unknown> {
  if (options === undefined || options === null) return {};
  if (!isPlainObject(options)) throw new ScriptError(`${what}: options must be an object`);
  const unknown = Object.keys(options).filter((k) => !valid.includes(k));
  if (unknown.length) {
    throw new ScriptError(`${what}: unknown option${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `'${k}'`).join(", ")}. Valid options: ${valid.join(", ")}`);
  }
  return options;
}

const AGENT_OPTIONS = [
  "label", "title", "phase", "schema", "model", "effort", "isolation", "projectId", "agentType",
  "profile", "agent", "system", "retry", "tools", "timeoutSec", "onRestart", "resumeSession",
  "concurrencyKey", "priority",
] as const;

// ---- the run ------------------------------------------------------------------

export interface RunScriptResult {
  result: unknown;
}

export interface RunScriptOptions {
  source: string;
  args: unknown;
  hooks: SandboxHooks;
  /** Defaults to `hooks.signal`. Aborting it fails every pending await. */
  signal?: AbortSignal;
}

interface Shared {
  /** Agents started by this run, parent and `workflow()` child together. */
  agents: { n: number };
  gate: AbortGate;
  hooks: SandboxHooks;
}

interface AbortGate {
  /** Run `fn`, racing its promise against the abort signal. */
  run<T>(fn: () => Promise<T> | T): Promise<T>;
  dispose(): void;
}

/** One listener on the signal for the whole run, however many awaits are racing
    it (an AbortSignal warns past ten). Every promise that has been run through
    it has its rejection handled, so an abandoned `race` loser cannot crash the
    process with an unhandled rejection later. */
function abortGate(signal: AbortSignal): AbortGate {
  const waiting = new Set<(error: Error) => void>();
  const cancelled = () => new ScriptError("the run was cancelled");
  const onAbort = () => {
    for (const reject of [...waiting]) reject(cancelled());
    waiting.clear();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return {
    run<T>(fn: () => Promise<T> | T): Promise<T> {
      let p: Promise<T>;
      try {
        p = Promise.resolve(fn());
      } catch (error) {
        p = Promise.reject(error);
      }
      if (signal.aborted) {
        p.catch(() => {});
        return Promise.reject(cancelled());
      }
      return new Promise<T>((resolve, reject) => {
        waiting.add(reject);
        p.then(
          (v) => { waiting.delete(reject); resolve(v); },
          (e: unknown) => { waiting.delete(reject); reject(e); },
        );
      });
    },
    dispose: () => signal.removeEventListener("abort", onAbort),
  };
}

/**
 * Compile and run the script.
 *
 * The body is wrapped in an async function, which is what makes top-level
 * `await` and a top-level `return` — both of which every documented Claude Code
 * workflow uses — mean what their authors think they mean. `export` is stripped
 * from the `meta` line on the way in; nothing else in the source is rewritten.
 *
 * Rejects with the hook's own error when a hook rejects and the script lets it
 * through (so the engine can `instanceof` its own error classes), and with a
 * `ScriptError` for everything the script itself did wrong.
 */
export async function runScript(opts: RunScriptOptions): Promise<RunScriptResult> {
  const signal = opts.signal ?? opts.hooks.signal;
  const gate = abortGate(signal);
  try {
    return await execute(opts, { agents: { n: 0 }, gate, hooks: opts.hooks }, null);
  } finally {
    gate.dispose();
  }
}

async function execute(opts: RunScriptOptions, shared: Shared, nestedGroup: string | null): Promise<RunScriptResult> {
  const { hooks, gate } = shared;
  const signal = opts.signal ?? hooks.signal;
  if (opts.source.length > SCRIPT_LIMITS.sourceBytes) {
    throw new ScriptError(`a workflow script is at most ${SCRIPT_LIMITS.sourceBytes} bytes`);
  }
  if (signal.aborted) throw new ScriptError("the run was cancelled");

  const group = (title: string | null): string | null =>
    nestedGroup ? (title ? `${nestedGroup} · ${title}` : nestedGroup).slice(0, SCRIPT_LIMITS.maxLabel) : title;
  let currentPhase: string | null = nestedGroup;

  /* Values coming back from hooks are host-realm objects; a script that does
     `x instanceof Array` or `Object.getPrototypeOf(x) === Object.prototype`
     would see strangers. A JSON round trip through the realm's own JSON makes
     them its own. Filled in once the context exists. */
  let parse: (text: string) => unknown = (text) => JSON.parse(text) as unknown;
  const intoRealm = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    try {
      return parse(JSON.stringify(value));
    } catch {
      return value;
    }
  };

  // ---- budget ----
  type MeterKey = "tokens" | "costUsd" | "agents";
  const meter = (kind: MeterKey) => {
    const total = (): number | null => {
      const t = hooks.budgets()[kind];
      return typeof t === "number" && Number.isFinite(t) ? t : null;
    };
    const spent = (): number => hooks.usage()[kind] ?? 0;
    return {
      get total() { return total(); },
      spent,
      remaining: (): number => {
        const t = total();
        return t === null ? UNLIMITED : Math.max(0, t - spent());
      },
    };
  };
  const tokens = meter("tokens");
  const budget = {
    /** v1 shape: the output-token target (null = none), what was spent, what is left. */
    get total() { return tokens.total; },
    spent: tokens.spent,
    remaining: tokens.remaining,
    tokens,
    costUsd: meter("costUsd"),
    agents: meter("agents"),
  };

  // ---- agent ----
  async function agent(prompt: unknown, options?: unknown): Promise<unknown> {
    if (signal.aborted) throw new ScriptError("the run was cancelled");
    if (typeof prompt !== "string" || !prompt.trim()) throw new ScriptError("agent(prompt): prompt must be a non-empty string");
    const o = checkOptions(options, "agent(prompt, opts)", AGENT_OPTIONS);
    const what = (name: string) => `agent(…, {${name}})`;
    if (shared.agents.n >= SCRIPT_LIMITS.maxAgents) {
      throw new ScriptError(`this run has spawned ${SCRIPT_LIMITS.maxAgents} agents, which is the cap`);
    }
    if (o.isolation !== undefined && o.isolation !== "worktree") {
      throw new ScriptError(`${what("isolation")}: only 'worktree' is supported here, not ${JSON.stringify(o.isolation)}`);
    }
    if (o.schema !== undefined && !isPlainObject(o.schema)) throw new ScriptError(`${what("schema")}: schema must be a JSON Schema object`);
    if (o.onRestart !== undefined && o.onRestart !== "resume" && o.onRestart !== "rerun" && o.onRestart !== "fail") {
      throw new ScriptError(`${what("onRestart")}: must be 'resume', 'rerun' or 'fail'`);
    }
    const label = str(o.label, what("label"));
    const title = str(o.title, what("title"));
    const phaseOpt = str(o.phase, what("phase"));
    const model = str(o.model, what("model"));
    const effort = str(o.effort, what("effort"));
    const projectId = str(o.projectId, what("projectId"));
    const agentType = str(o.agentType, what("agentType"));
    const profile = str(o.profile, what("profile"));
    const agentId = str(o.agent, what("agent"));
    const system = str(o.system, what("system"));
    const resumeSession = str(o.resumeSession, what("resumeSession"));
    const concurrencyKey = str(o.concurrencyKey, what("concurrencyKey"), { max: 200 });
    const timeoutSec = num(o.timeoutSec, what("timeoutSec"), { gt: 0, max: ENGINE_LIMITS.stepTimeoutSec.max });
    const priority = num(o.priority, what("priority"));

    let retry: RetryPolicy | undefined;
    if (o.retry !== undefined && o.retry !== null) {
      const raw = typeof o.retry === "number" ? { max: o.retry } : o.retry;
      const r = checkOptions(raw, what("retry"), ["max", "backoffSec", "fallbackModel"]);
      const max = num(r.max, "agent(…, {retry.max})", { min: 0, max: 10, int: true });
      if (max === undefined) throw new ScriptError("agent(…, {retry}): `max` (extra attempts, 0..10) is required");
      const backoffSec = num(r.backoffSec, "agent(…, {retry.backoffSec})", { min: 0, max: 3600 });
      const fallbackModel = str(r.fallbackModel, "agent(…, {retry.fallbackModel})");
      retry = { max, ...(backoffSec !== undefined ? { backoffSec } : {}), ...(fallbackModel ? { fallbackModel } : {}) };
    }

    let tools: AgentSpec["tools"];
    if (o.tools !== undefined && o.tools !== null) {
      const t = checkOptions(o.tools, what("tools"), ["allow", "deny"]);
      const allow = strList(t.allow, "agent(…, {tools.allow})");
      const deny = strList(t.deny, "agent(…, {tools.deny})");
      tools = { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) };
    }

    shared.agents.n += 1;
    const index = shared.agents.n;
    /* Claude Code's `opts.phase` names the group this one agent belongs to,
       which keeps a pipeline stage out of a race with the global `phase()`
       cursor; without one the agent joins whatever phase the script is on. */
    const phase = phaseOpt ? group(phaseOpt.trim().slice(0, SCRIPT_LIMITS.maxLabel)) : currentPhase;
    const spec: AgentSpec = {
      prompt,
      label: (label ?? `agent-${index}`).trim().slice(0, SCRIPT_LIMITS.maxLabel),
      title: stepTitle({ title, label, prompt, index }),
      phase,
      ...(o.schema ? { schema: cloneJson(o.schema, what("schema")) as Record<string, unknown> } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(o.isolation ? { isolation: "worktree" as const } : {}),
      ...(projectId ? { projectId } : {}),
      ...(agentType ? { agentType: agentType.trim() } : {}),
      ...(profile ? { profile } : {}),
      ...(agentId ? { agent: agentId } : {}),
      ...(system ? { system } : {}),
      ...(retry ? { retry } : {}),
      ...(tools ? { tools } : {}),
      ...(timeoutSec !== undefined ? { timeoutSec } : {}),
      ...(o.onRestart ? { onRestart: o.onRestart as OnRestart } : {}),
      ...(resumeSession ? { resumeSession } : {}),
      ...(concurrencyKey ? { concurrencyKey } : {}),
      ...(priority !== undefined ? { priority } : {}),
    };
    // The hook is called synchronously, before any await: the order of hook
    // calls is the order the script called agent(), which replay depends on.
    // Cloned so the engine hashes and stores host-realm JSON (arrays built from realm input included).
    const clean = cloneJson(spec, "agent(prompt, opts)") as AgentSpec;
    return intoRealm(await gate.run(() => hooks.agent(clean)));
  }

  // ---- fan-out ----

  /* A thunk that throws resolves to `null` rather than rejecting the whole
     call — Claude Code's contract, and the reason its examples all end in
     `.filter(Boolean)`. A cancelled run is the exception: it rethrows, because
     a cancelled run must stop and not quietly return a list of nulls. */
  const settle = async (thunk: () => unknown, what: string): Promise<unknown> => {
    try {
      return await thunk();
    } catch (error) {
      if (signal.aborted) throw error;
      hooks.log(`${what} failed: ${describeError(error)}`);
      return null;
    }
  };

  const checkItems = (items: unknown, what: string): unknown[] => {
    if (!Array.isArray(items)) throw new ScriptError(`${what}: expected an array`);
    if (items.length > SCRIPT_LIMITS.maxItems) {
      throw new ScriptError(`${what}: ${items.length} items is past the cap of ${SCRIPT_LIMITS.maxItems}`);
    }
    return items;
  };

  const needFn = (value: unknown, what: string): ((...a: unknown[]) => unknown) => {
    if (typeof value !== "function") throw new ScriptError(`${what}: expected a function`);
    return value as (...a: unknown[]) => unknown;
  };

  async function parallel(thunks: unknown): Promise<unknown[]> {
    const list = checkItems(thunks, "parallel(thunks)");
    const fns = list.map((thunk, i) => needFn(thunk, `parallel()[${i}]`));
    return Promise.all(fns.map((fn, i) => settle(fn, `parallel()[${i}]`)));
  }

  /** Every item through every stage independently — no barrier between them,
      so a fast item reaches the last stage while a slow one is still on the
      first. A stage that throws drops that item to `null` and skips its rest. */
  async function pipeline(items: unknown, ...stages: unknown[]): Promise<unknown[]> {
    const list = checkItems(items, "pipeline(items)");
    const fns = stages.map((stage, i) => needFn(stage, `pipeline(): stage ${i + 1}`));
    return Promise.all(
      list.map(async (item, index) => {
        let value: unknown = item;
        for (const [i, stage] of fns.entries()) {
          try {
            value = await stage(value, item, index);
          } catch (error) {
            if (signal.aborted) throw error;
            hooks.log(`pipeline()[${index}] stage ${i + 1} failed: ${describeError(error)}`);
            return null;
          }
        }
        return value;
      }),
    );
  }

  /** Bounded fan-out. Items START in input order (a worker only ever takes the
      next index), results come back in input order, a throwing item is `null`. */
  async function map(items: unknown, fn: unknown, options?: unknown): Promise<unknown[]> {
    const list = checkItems(items, "map(items)");
    const f = needFn(fn, "map(items, fn)");
    const o = checkOptions(options, "map(items, fn, opts)", ["concurrency"]);
    const concurrency = num(o.concurrency, "map(…, {concurrency})", { min: 1, max: SCRIPT_LIMITS.maxItems, int: true }) ?? 5;
    const out: unknown[] = new Array(list.length).fill(null);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < list.length) {
        if (signal.aborted) throw new ScriptError("the run was cancelled");
        const i = next++;
        out[i] = await settle(() => f(list[i], i, list), `map()[${i}]`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
    return out;
  }

  // ---- judgement ----

  const judgeIndex = (answer: unknown, candidates: unknown[]): number => {
    const bad = () => new ScriptError(`vote(): the judge must answer with the index of a candidate (0..${candidates.length - 1}) or {index}, got ${stable(answer).slice(0, 80)}`);
    let index: number | undefined;
    if (typeof answer === "number") index = answer;
    else if (typeof answer === "string" && /^\d+$/.test(answer.trim())) index = Number(answer);
    else if (isPlainObject(answer)) {
      if (Number.isInteger(answer.index)) index = answer.index as number;
      else if (Number.isInteger(answer.winner)) index = answer.winner as number;
      else {
        // The judge may hand back the winning candidate itself.
        const found = candidates.findIndex((c) => c !== null && stable(c) === stable(answer));
        if (found >= 0) index = found;
      }
    }
    if (index === undefined || !Number.isInteger(index) || index < 0 || index >= candidates.length || candidates[index] === null) throw bad();
    return index;
  };

  /**
   * `vote(n, make, {judge, judgePrompt})`: `make(i)` n times in parallel.
   * Winner: `judge(candidates)` (a function) if given, else — if `judgePrompt`
   * (a string) is given — a built-in judge agent labelled `vote-judge`, else
   * the majority by JSON-stable equality (a tie goes to the earliest). The
   * judge is not consulted with fewer than two successful candidates, and a
   * judge that throws falls back to the majority. Returns
   * `{winner, winnerIndex, candidates, votes}`; `candidates[i]` is `null` where
   * `make(i)` failed, `votes[i]` how many candidates agree with candidate i
   * (majority) or 1/0 for chosen/not (judge).
   */
  async function vote(n: unknown, make: unknown, options?: unknown): Promise<Record<string, unknown>> {
    const count = num(n, "vote(n)", { min: 1, max: SCRIPT_LIMITS.maxItems, int: true });
    if (count === undefined) throw new ScriptError("vote(n, make): n is required");
    const f = needFn(make, "vote(n, make)");
    const o = checkOptions(options, "vote(n, make, opts)", ["judge", "judgePrompt"]);
    if (o.judge !== undefined && typeof o.judge !== "function") throw new ScriptError("vote(…, {judge}): judge must be a function");
    const judgePrompt = str(o.judgePrompt, "vote(…, {judgePrompt})");
    const candidates = await Promise.all(Array.from({ length: count }, (_, i) => settle(() => f(i), `vote()[${i}]`)));
    const live = candidates.map((c, i) => (c === null || c === undefined ? -1 : i)).filter((i) => i >= 0);

    const keys = candidates.map((c) => (c === null || c === undefined ? null : stable(c)));
    const tally = new Map<string, number>();
    for (const k of keys) if (k !== null) tally.set(k, (tally.get(k) ?? 0) + 1);
    const majority = (): number => {
      let best = -1;
      let bestCount = 0;
      for (const i of live) {
        const c = tally.get(keys[i]!)!;
        if (c > bestCount) { best = i; bestCount = c; }
      }
      return best;
    };

    let winnerIndex = -1;
    let judged = false;
    if (live.length === 1) winnerIndex = live[0];
    else if (live.length > 1 && (o.judge || judgePrompt)) {
      try {
        const answer = o.judge
          ? await (o.judge as (c: unknown[]) => unknown)(candidates)
          : await agent(judgeText(judgePrompt!, candidates), {
              label: "vote-judge",
              schema: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] },
            });
        winnerIndex = judgeIndex(answer, candidates);
        judged = true;
      } catch (error) {
        if (signal.aborted || error instanceof ScriptError && /^vote\(\): the judge/.test(error.message)) throw error;
        hooks.log(`vote() judge failed, using the majority: ${describeError(error)}`);
      }
    }
    if (winnerIndex < 0 && live.length > 0) winnerIndex = majority();
    const votes = candidates.map((_, i) => (keys[i] === null ? 0 : judged ? (i === winnerIndex ? 1 : 0) : tally.get(keys[i]!)!));
    return {
      winner: winnerIndex >= 0 ? candidates[winnerIndex] : null,
      winnerIndex: winnerIndex >= 0 ? winnerIndex : null,
      candidates,
      votes,
    };
  }

  const judgeText = (prompt: string, candidates: unknown[]): string => {
    const body = candidates
      .map((c, i) => {
        if (c === null || c === undefined) return `Candidate ${i}: (failed — do not choose)`;
        const text = typeof c === "string" ? c : stable(c);
        return `Candidate ${i}:\n${text.length > MAX_VOTE_CANDIDATE_CHARS ? `${text.slice(0, MAX_VOTE_CANDIDATE_CHARS)}\n…(truncated)` : text}`;
      })
      .join("\n\n");
    return `${prompt}\n\n${body}\n\nAnswer with the index of the best candidate as JSON: {"index": <number>}.`;
  };

  /**
   * `refine(make, check, {maxRounds})`: evaluator-optimizer. Round numbers are
   * 0-based, like indices elsewhere: `make(round, previousFeedback)` then
   * `check(candidate, round)` which answers `{ok, feedback?}` (or a bare
   * boolean). Stops at the first `ok` or after `maxRounds`; returns
   * `{value, rounds, ok}` where `value` is the last candidate. A throw from
   * make/check propagates.
   */
  async function refine(make: unknown, check: unknown, options?: unknown): Promise<Record<string, unknown>> {
    const mk = needFn(make, "refine(make, check)");
    const ck = needFn(check, "refine(make, check)");
    const o = checkOptions(options, "refine(make, check, opts)", ["maxRounds"]);
    const maxRounds = num(o.maxRounds, "refine(…, {maxRounds})", { min: 1, max: 50, int: true }) ?? SCRIPT_LIMITS.defaultRounds;
    let value: unknown = null;
    let feedback: unknown = undefined;
    let ok = false;
    let rounds = 0;
    for (let round = 0; round < maxRounds; round += 1) {
      if (signal.aborted) throw new ScriptError("the run was cancelled");
      value = await mk(round, feedback);
      rounds = round + 1;
      const raw = await ck(value, round);
      const verdict = typeof raw === "boolean" ? { ok: raw } : raw;
      if (!isPlainObject(verdict) || typeof verdict.ok !== "boolean") {
        throw new ScriptError("refine(): check must answer {ok: boolean, feedback?: string}");
      }
      ok = verdict.ok;
      if (ok) break;
      feedback = verdict.feedback;
    }
    return { value, rounds, ok };
  }

  /** `route(classify, branches)`: classify once, run one branch. `classify` may
      be a function (awaited) or the label itself. */
  async function route(classify: unknown, branches: unknown): Promise<unknown> {
    if (!isPlainObject(branches)) throw new ScriptError("route(classify, branches): branches must be an object of functions");
    const names = Object.keys(branches);
    for (const name of names) needFn(branches[name], `route(): branch '${name}'`);
    const raw = typeof classify === "function" ? await (classify as () => unknown)() : await classify;
    const label = typeof raw === "string" ? raw.trim() : isPlainObject(raw) && typeof raw.label === "string" ? raw.label.trim() : null;
    if (label === null) throw new ScriptError("route(): the classifier must answer a string or {label}");
    const key = Object.prototype.hasOwnProperty.call(branches, label) ? label : Object.prototype.hasOwnProperty.call(branches, "default") ? "default" : null;
    if (key === null) {
      throw new ScriptError(`route(): no branch for ${JSON.stringify(label)}; the branches are ${names.map((n) => JSON.stringify(n)).join(", ") || "(none)"}`);
    }
    return (branches[key] as (label: string) => unknown)(label);
  }

  /**
   * `race(thunks)`: every thunk is started now, in order; the first to
   * FULFIL wins and the rest are abandoned (not awaited; the engine cancels
   * their children when the run ends). All rejected => the error of the
   * lowest-indexed thunk. Which one wins depends on timing: for a replay to
   * pick the same winner the engine must serve journaled completions in the
   * order they were originally journaled.
   */
  async function race(thunks: unknown): Promise<unknown> {
    const list = checkItems(thunks, "race(thunks)");
    if (list.length === 0) throw new ScriptError("race(thunks): expected at least one function");
    const fns = list.map((t, i) => needFn(t, `race()[${i}]`));
    return gate.run(
      () =>
        new Promise<unknown>((resolve, reject) => {
          const errors: unknown[] = new Array(fns.length);
          let failed = 0;
          fns.forEach((fn, i) => {
            let p: Promise<unknown>;
            try {
              p = Promise.resolve(fn());
            } catch (error) {
              p = Promise.reject(error);
            }
            p.then(
              (value) => resolve(intoRealm(value)),
              (error: unknown) => {
                errors[i] = error;
                failed += 1;
                if (failed === fns.length) reject(errors[0]);
              },
            );
          });
        }),
    );
  }

  // ---- gates ----

  async function approve(text: unknown, options?: unknown): Promise<string | null> {
    if (typeof text !== "string" || !text.trim()) throw new ScriptError("approve(text): text must be a non-empty string");
    if (text.length > 10_000) throw new ScriptError("approve(text): text is at most 10000 characters");
    const o = checkOptions(options, "approve(text, opts)", ["options", "timeoutSec"]);
    let choices = ["approve", "reject"];
    if (o.options !== undefined) {
      const list = strList(o.options, "approve(…, {options})");
      if (!list || list.length === 0 || list.length > 10 || new Set(list).size !== list.length || list.some((c) => c.length > 80)) {
        throw new ScriptError("approve(…, {options}) must be 1..10 distinct strings of at most 80 characters");
      }
      choices = list;
    }
    const timeoutSec = num(o.timeoutSec, "approve(…, {timeoutSec})", { gt: 0, max: MAX_SLEEP_SEC });
    const answer = await gate.run(() => hooks.approve(text, { options: choices, ...(timeoutSec !== undefined ? { timeoutSec } : {}) }));
    return typeof answer === "string" ? answer : null;
  }

  async function sleep(seconds: unknown): Promise<void> {
    const s = num(seconds, "sleep(seconds)", { min: 0, max: MAX_SLEEP_SEC });
    if (s === undefined) throw new ScriptError("sleep(seconds): seconds is required");
    await gate.run(() => hooks.sleep(s));
  }

  async function until(iso: unknown): Promise<void> {
    if (typeof iso !== "string" || !iso.trim() || Number.isNaN(Date.parse(iso))) {
      throw new ScriptError("until(isoTimestamp): expected an ISO 8601 string such as '2030-01-01T09:00:00Z'");
    }
    await gate.run(() => hooks.until(iso));
  }

  async function waitFor(name: unknown, options?: unknown): Promise<unknown> {
    if (typeof name !== "string" || !NAME_RE.test(name)) throw new ScriptError("waitFor(name): name must match /^[\\w.-]{1,80}$/");
    const o = checkOptions(options, "waitFor(name, opts)", ["timeoutSec"]);
    const timeoutSec = num(o.timeoutSec, "waitFor(…, {timeoutSec})", { gt: 0, max: MAX_SLEEP_SEC });
    return intoRealm(await gate.run(() => hooks.waitFor(name, timeoutSec !== undefined ? { timeoutSec } : {})));
  }

  async function sh(cmd: unknown, options?: unknown): Promise<unknown> {
    if (typeof cmd !== "string" || !cmd.trim()) throw new ScriptError("sh(cmd): cmd must be a non-empty string");
    if (Buffer.byteLength(cmd) > SH_MAX_BYTES) throw new ScriptError(`sh(cmd): cmd is at most ${SH_MAX_BYTES} bytes`);
    const o = checkOptions(options, "sh(cmd, opts)", ["cwd", "timeoutSec", "idempotent"]);
    const cwd = str(o.cwd, "sh(…, {cwd})", { max: 1024 });
    if (cwd !== undefined && cwd.includes("\0")) throw new ScriptError("sh(…, {cwd}) contains a NUL byte");
    const timeoutSec = num(o.timeoutSec, "sh(…, {timeoutSec})", { gt: 0, max: ENGINE_LIMITS.stepTimeoutSec.max });
    if (o.idempotent !== undefined && typeof o.idempotent !== "boolean") throw new ScriptError("sh(…, {idempotent}) must be a boolean");
    const idempotent = o.idempotent === true;
    const result = await gate.run(() =>
      hooks.sh(cmd, { ...(cwd ? { cwd } : {}), ...(timeoutSec !== undefined ? { timeoutSec } : {}), ...(idempotent ? { idempotent: true } : {}) }),
    );
    return intoRealm(result);
  }

  async function artifact(name: unknown, data: unknown): Promise<void> {
    if (typeof name !== "string" || !NAME_RE.test(name)) throw new ScriptError("artifact(name, data): name must match /^[\\w.-]{1,80}$/");
    if (data === undefined) throw new ScriptError("artifact(name, data): data is required (use null for nothing)");
    const clean = typeof data === "string" ? data : cloneJson(data, "artifact(name, data)");
    await gate.run(() => hooks.artifact(name, clean));
  }

  const state = {
    get(path: unknown): unknown {
      if (typeof path !== "string" || !PATH_RE.test(path)) throw new ScriptError("state.get(path): path must match /^[\\w.-]{1,200}$/");
      return intoRealm(hooks.getState(path));
    },
    set(path: unknown, value: unknown): void {
      if (typeof path !== "string" || !PATH_RE.test(path)) throw new ScriptError("state.set(path, value): path must match /^[\\w.-]{1,200}$/");
      if (value === undefined) throw new ScriptError("state.set(path, value): value is required (use null to clear)");
      hooks.setState(path, cloneJson(value, "state.set(path, value)"));
    },
  };

  // ---- structure ----

  function phase(title: unknown): void {
    if (typeof title !== "string" || !title.trim()) throw new ScriptError("phase(title): title must be a non-empty string");
    currentPhase = group(title.trim().slice(0, SCRIPT_LIMITS.maxLabel));
    hooks.phase(currentPhase!);
  }

  /** Another workflow as one step of this one. It shares this run's agent cap,
      cancel, budget and journal; its agents are drawn under its own name. One
      level only. */
  async function workflow(ref: unknown, childArgs?: unknown): Promise<unknown> {
    if (nestedGroup) throw new ScriptError("workflow() cannot be called from inside a nested workflow — one level only");
    if (!hooks.loadWorkflow) throw new ScriptError("workflow() is not available here");
    const valid =
      (typeof ref === "string" && ref.trim()) ||
      (isPlainObject(ref) && typeof ref.scriptPath === "string" && ref.scriptPath.trim());
    if (!valid) throw new ScriptError("workflow(ref): ref is a saved workflow's name or {scriptPath}");
    const plainRef = typeof ref === "string" ? ref : { scriptPath: (ref as { scriptPath: string }).scriptPath };
    const source = await gate.run(() => hooks.loadWorkflow!(plainRef));
    const meta = extractMeta(source);
    const { result } = await execute(
      { source, args: cloneJson(childArgs, "workflow(ref, args)"), hooks, signal },
      shared,
      `▸ ${meta.name}`.slice(0, SCRIPT_LIMITS.maxLabel),
    );
    return intoRealm(result);
  }

  function log(...messages: unknown[]): void {
    const text = messages
      .map((m) => {
        if (typeof m === "string") return m;
        if (m !== null && typeof m === "object") {
          try { return JSON.stringify(m); } catch { /* fall through */ }
        }
        return String(m);
      })
      .join(" ");
    hooks.log(text.slice(0, 2_000));
  }

  /* Only the API goes in. A fresh vm context already has every standard
     built-in of its own, and injecting the host's would be worse than useless:
     `{...Math}` copies nothing (its methods are non-enumerable), and a script
     mixing host and context intrinsics gets `instanceof` answers that are true
     in one realm and false in the other. So the realm supplies the language and
     the bootstrap below takes the clock out of it. What is absent is absent
     because Node's globals — `process`, `require`, the timers, `fetch` — are
     not part of that language and never reach a context. */
  const sandbox: Record<string, unknown> = {
    agent,
    parallel,
    pipeline,
    map,
    vote,
    refine,
    route,
    race,
    approve,
    sleep,
    until,
    waitFor,
    sh,
    artifact,
    state,
    phase,
    log,
    workflow,
    budget,
    console: { log, warn: log, error: log, info: log, debug: log },
    __forbid: (what: unknown) => forbidden(String(what))(),
  };
  const context = vm.createContext(sandbox, { name: "workflow" });
  /* Patched inside the realm, because that is the only place its own `Math` and
     `Date` can be reached. `__forbid` is captured by the closures here and then
     taken off the global, so the script cannot see the hatch it was patched
     through. `Date()` called as a function, and `x.constructor` on a date, are
     the two other doors to the real clock and are closed the same way. */
  vm.runInContext(
    `(() => {
       const forbid = __forbid;
       Math.random = () => forbid("Math.random()");
       const Real = Date;
       const Patched = new Proxy(Real, {
         apply: () => forbid("Date()"),
         construct: (target, argv, newTarget) =>
           argv.length === 0 ? forbid("new Date()") : Reflect.construct(target, argv, newTarget === Patched ? target : newTarget),
         get: (target, key) => (key === "now" ? () => forbid("Date.now()") : Reflect.get(target, key)),
       });
       Object.defineProperty(Real.prototype, "constructor", { value: Patched, writable: true, configurable: true });
       Date = Patched;
     })()`,
    context,
    { timeout: 1000, filename: "workflow-bootstrap.js" },
  );
  delete sandbox.__forbid;
  const realmParse = vm.runInContext("(text) => JSON.parse(text)", context) as (text: string) => unknown;
  parse = realmParse;
  sandbox.args = intoRealm(cloneJson(opts.args, "args"));

  const wrapped = `(async () => {\n${stripMetaExport(opts.source)}\n})()`;
  let script: vm.Script;
  try {
    script = new vm.Script(wrapped, { filename: "workflow.js" });
  } catch (error) {
    throw new ScriptError(`the script does not parse: ${describeError(error)}`);
  }
  let promise: Promise<unknown>;
  try {
    promise = script.runInContext(context, { timeout: SCRIPT_LIMITS.syncTimeoutMs }) as Promise<unknown>;
  } catch (error) {
    throw new ScriptError(describeError(error));
  }
  let result: unknown;
  try {
    result = await gate.run(() => promise);
  } catch (error) {
    // A hook's own error passes through untouched; what the script itself threw
    // (made of the realm's Error, so not one of ours) becomes a ScriptError.
    if (error instanceof Error) throw error;
    throw new ScriptError(describeError(error), { cause: error });
  }
  return { result: jsonSafe(result) };
}

/** `export const meta = …` → `const meta = …`. The only rewrite: the source is
    otherwise the author's, so a stack trace still points where they look. */
function stripMetaExport(source: string): string {
  return source.replace(/(^|\n)(\s*)export\s+const\s+meta\s*=/, "$1$2const meta =");
}

/**
 * The script's return value, as the rest of the harness will hold it.
 *
 * Everything a script builds is made of the *context's* intrinsics, so an
 * object it returns has a prototype from another realm — it serialises fine and
 * compares as a stranger, which is a trap worth closing once here rather than
 * at every reader. The value is persisted, shown and handed back to the agent
 * as JSON anyway, so the round trip is the contract rather than a workaround.
 */
function jsonSafe(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    // A cycle, or something JSON has no word for; its text is still an answer.
    return String(value);
  }
}
