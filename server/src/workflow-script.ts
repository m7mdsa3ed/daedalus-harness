/*
 * Running an agent-authored orchestration script.
 *
 * **This reverses the rule the declarative engine was built on.** That rule —
 * written at the top of `workflow-schema.ts` — said the server must never
 * interpret a *program* an agent wrote, only data it could validate, draw and
 * replay up front. The reason it fell is that the thing a script buys is not
 * convenience but capability: fanning out over a list the run itself
 * discovered, looping until a search goes dry, judging N attempts against each
 * other. A static graph cannot express any of those, and Claude Code's own
 * workflows are built almost entirely out of them, so Codex and OpenCode were
 * getting a strictly weaker tool. Both engines now stand: a definition is
 * still the right answer for a fixed pipeline, and `workflow-schema.ts` still
 * validates one up front.
 *
 * What makes the reversal affordable here is that the agent writing the script
 * **already runs shell commands on this machine**. A script can therefore do
 * nothing a `Bash` call could not, so the sandbox below is not a security
 * boundary and is not asked to be one: it is there to keep an honest script
 * from reaching things it has no business touching by accident, and to make
 * the failure legible when it does. The isolation that matters is the same one
 * the declarative engine has — every agent the script spawns is a real child
 * session with its own permission mode, inherited from the parent.
 *
 * The API is deliberately Claude Code's, name for name (`agent`, `parallel`,
 * `pipeline`, `phase`, `log`, `args`, `budget`, `meta`), so a script written
 * for one engine runs on the other. That includes the awkward parts: `Date.now`,
 * `Math.random` and `new Date()` all throw, because a script that reads a clock
 * cannot be replayed, and a harness whose scripts quietly diverge from the
 * documented ones would be worse than one that has none.
 *
 * No database, no session manager, no `Session` — `agent()` arrives as a
 * callback, so all of this is unit-testable with no agent at all
 * (`test/workflow-script.test.ts`).
 */
import vm from "node:vm";

export const SCRIPT_LIMITS = {
  /** Source bytes. A workflow script is a page or two; anything past this is
      not a script but a payload. */
  sourceBytes: 256 * 1024,
  /** Agents one run may spawn in its lifetime. A runaway-loop backstop set far
      above any real workflow, exactly as Claude Code's 1000 is — lower here
      because every one of ours is a whole session with a process behind it. */
  maxAgents: 200,
  /** Items one `parallel`/`pipeline` call may take. Passing more is an error
      rather than a silent truncation. */
  maxItems: 1024,
  /** How long the script's own synchronous code may run before a compile or a
      turn of the loop is called wedged. Nothing to do with how long the agents
      take — they are awaited, and the script is idle while they work. */
  syncTimeoutMs: 5_000,
  /** Phase titles, and the length of one. */
  maxPhases: 32,
  maxLabel: 80,
} as const;

export class ScriptError extends Error {}

export interface ScriptMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases: { title: string; detail?: string }[];
}

/** What the engine hands the sandbox: the one call that does real work, plus
    the run's bookkeeping. Everything else in the API is arithmetic over these. */
export interface ScriptHooks {
  /** Spawn one agent and resolve with its output — text, or the validated
      object when a schema was asked for. Rejects if the agent failed; the API
      turns that into `null` where Claude Code's does. */
  agent(spec: {
    prompt: string;
    label: string;
    phase: string | null;
    schema?: Record<string, unknown>;
    model?: string;
    effort?: string;
  }): Promise<unknown>;
  /** A phase was entered. Titles are declared in `meta.phases`; this is the
      script saying which one it is on. */
  phase(title: string): void;
  log(message: string): void;
  /** Output tokens spent so far by every agent of this run. */
  spent(): number;
  /** Aborted when the run is cancelled; every await races it. */
  signal: AbortSignal;
}

/**
 * `export const meta = {…}`, read without running anything else.
 *
 * The engine needs the name and the phase list *before* the script runs — they
 * name the run and draw its outline — and Claude Code requires the object to be
 * a pure literal for the same reason. Evaluated as an expression in an empty
 * context, so a `meta` that tries to compute itself fails here rather than
 * producing a name nobody can predict.
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
  const meta = value as Partial<ScriptMeta> | null;
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
  return { name: name.slice(0, 80), description: description.slice(0, 500), phases };
}

/** The end of the object literal that starts at `from`, by brace depth, with
    strings, template literals and comments skipped so a `}` inside one does not
    close it early. */
function balancedEnd(source: string, from: string | number): number {
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

export interface RunScriptResult {
  result: unknown;
  agents: number;
}

/**
 * Compile and run the script.
 *
 * The body is wrapped in an async function, which is what makes top-level
 * `await` and a top-level `return` — both of which every documented Claude Code
 * workflow uses — mean what their authors think they mean. `export` is stripped
 * from the `meta` line on the way in; nothing else in the source is rewritten.
 */
export async function runScript(opts: {
  source: string;
  args: unknown;
  hooks: ScriptHooks;
  budgetTotal: number | null;
}): Promise<RunScriptResult> {
  const { hooks } = opts;
  if (opts.source.length > SCRIPT_LIMITS.sourceBytes) {
    throw new ScriptError(`a workflow script is at most ${SCRIPT_LIMITS.sourceBytes} bytes`);
  }
  let agents = 0;
  let currentPhase: string | null = null;

  const budget = {
    total: opts.budgetTotal,
    spent: () => hooks.spent(),
    remaining: () => (opts.budgetTotal === null ? Infinity : Math.max(0, opts.budgetTotal - hooks.spent())),
  };

  const label = (value: unknown, fallback: string): string => {
    const text = typeof value === "string" ? value.trim() : "";
    return (text || fallback).slice(0, SCRIPT_LIMITS.maxLabel);
  };

  async function agent(prompt: unknown, options?: Record<string, unknown>): Promise<unknown> {
    if (hooks.signal.aborted) throw new ScriptError("the run was cancelled");
    if (typeof prompt !== "string" || !prompt.trim()) throw new ScriptError("agent(prompt): prompt must be a non-empty string");
    if (agents >= SCRIPT_LIMITS.maxAgents) {
      throw new ScriptError(`this run has spawned ${SCRIPT_LIMITS.maxAgents} agents, which is the cap`);
    }
    if (budget.total !== null && budget.remaining() <= 0) {
      throw new ScriptError(`the run's token budget (${budget.total}) is spent`);
    }
    agents += 1;
    const index = agents;
    const schema = options?.schema;
    if (schema !== undefined && (typeof schema !== "object" || schema === null || Array.isArray(schema))) {
      throw new ScriptError("agent(…, {schema}): schema must be a JSON Schema object");
    }
    /* Claude Code's `opts.phase` names the group this one agent belongs to,
       which is what keeps a pipeline stage out of a race with the global
       `phase()` cursor; without one the agent joins whatever phase the script
       is on. */
    const phase = typeof options?.phase === "string" ? options.phase : currentPhase;
    return hooks.agent({
      prompt,
      label: label(options?.label, `agent ${index}`),
      phase,
      ...(schema ? { schema: schema as Record<string, unknown> } : {}),
      ...(typeof options?.model === "string" ? { model: options.model } : {}),
      ...(typeof options?.effort === "string" ? { effort: options.effort } : {}),
    });
  }

  /* A thunk that throws resolves to `null` rather than rejecting the whole
     call — Claude Code's contract, and the reason its examples all end in
     `.filter(Boolean)`. A cancelled run is the exception: it rethrows, because
     a cancelled run must stop and not quietly return a list of nulls. */
  const settle = async (thunk: unknown, what: string): Promise<unknown> => {
    if (typeof thunk !== "function") throw new ScriptError(`${what}: expected a function`);
    try {
      return await (thunk as () => unknown)();
    } catch (error) {
      if (hooks.signal.aborted) throw error;
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

  async function parallel(thunks: unknown): Promise<unknown[]> {
    const list = checkItems(thunks, "parallel(thunks)");
    return Promise.all(list.map((thunk, i) => settle(thunk, `parallel()[${i}]`)));
  }

  /** Every item through every stage independently — no barrier between them,
      so a fast item reaches the last stage while a slow one is still on the
      first. A stage that throws drops that item to `null` and skips its rest. */
  async function pipeline(items: unknown, ...stages: unknown[]): Promise<unknown[]> {
    const list = checkItems(items, "pipeline(items)");
    for (const [i, stage] of stages.entries()) {
      if (typeof stage !== "function") throw new ScriptError(`pipeline(): stage ${i + 1} is not a function`);
    }
    return Promise.all(
      list.map(async (item, index) => {
        let value: unknown = item;
        for (const [i, stage] of stages.entries()) {
          try {
            value = await (stage as (v: unknown, item: unknown, index: number) => unknown)(value, item, index);
          } catch (error) {
            if (hooks.signal.aborted) throw error;
            hooks.log(`pipeline()[${index}] stage ${i + 1} failed: ${describeError(error)}`);
            return null;
          }
        }
        return value;
      }),
    );
  }

  function phase(title: unknown): void {
    if (typeof title !== "string" || !title.trim()) throw new ScriptError("phase(title): title must be a non-empty string");
    currentPhase = title.trim().slice(0, SCRIPT_LIMITS.maxLabel);
    hooks.phase(currentPhase);
  }

  function log(message: unknown): void {
    hooks.log(String(message).slice(0, 2_000));
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
    phase,
    log,
    args: opts.args,
    budget,
    console: { log, warn: log, error: log, info: log, debug: log },
    __forbid: (what: unknown) => forbidden(String(what))(),
  };
  const context = vm.createContext(sandbox, { name: "workflow" });
  /* Patched inside the realm, because that is the only place its own `Math` and
     `Date` can be reached. `__forbid` is captured by the closures here and then
     taken off the global, so the script cannot see the hatch it was patched
     through. */
  vm.runInContext(
    `(() => {
       const forbid = __forbid;
       Math.random = () => forbid("Math.random()");
       const Real = Date;
       Date = new Proxy(Real, {
         construct: (target, argv) => (argv.length === 0 ? forbid("new Date()") : new target(...argv)),
         get: (target, key) => (key === "now" ? () => forbid("Date.now()") : Reflect.get(target, key)),
       });
     })()`,
    context,
    { timeout: 1000, filename: "workflow-bootstrap.js" },
  );
  delete sandbox.__forbid;

  const wrapped = `(async () => {\n${stripMetaExport(opts.source)}\n})()`;
  let script: vm.Script;
  try {
    script = new vm.Script(wrapped, { filename: "workflow.js" });
  } catch (error) {
    throw new ScriptError(`the script does not parse: ${describeError(error)}`);
  }
  let promise: unknown;
  try {
    promise = script.runInContext(context, { timeout: SCRIPT_LIMITS.syncTimeoutMs });
  } catch (error) {
    throw new ScriptError(describeError(error));
  }
  const result = await Promise.race([
    Promise.resolve(promise),
    new Promise((_resolve, reject) => {
      if (hooks.signal.aborted) reject(new ScriptError("the run was cancelled"));
      hooks.signal.addEventListener("abort", () => reject(new ScriptError("the run was cancelled")), { once: true });
    }),
  ]);
  return { result: jsonSafe(result), agents };
  return { result, agents };
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

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
