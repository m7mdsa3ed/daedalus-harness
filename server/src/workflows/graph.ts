/*
 * Workflow engine v2: the declarative front door.
 *
 * A definition is JSON the server can validate before a single agent spawns
 * (duplicate names, cycles, a template that reads a step it never waited for)
 * and is then *compiled into a script*, so the engine has exactly one
 * scheduler: the sandbox runs the generated program like any other.
 *
 * Pure: zod and arithmetic only. It is imported by the `workflow` MCP server,
 * which is a separate process, so nothing here may touch the database, the
 * config or a session. Unit-tested in `test/workflow-graph.test.ts` by
 * executing the generated source against a fake sandbox.
 *
 * Ported from v1 `workflow-schema.ts` (which stays until the lead deletes
 * it); `readySteps`/`dependentsOf` are gone with the declarative scheduler.
 */
import { z } from "zod";
import { ENGINE_LIMITS } from "./types.js";
import type { Budgets, OnRestart, ScriptMeta } from "./types.js";

export const STEP_NAME_RE = /^[a-z][a-z0-9_-]{0,39}$/i;
/** The name a `forEach` binds its element to: a plain identifier. */
const ITEM_NAME_RE = /^[A-Za-z_]\w{0,31}$/;
const RESERVED_ITEM_NAMES = new Set(["inputs", "steps", "index"]);

export const LIMITS = {
  maxSteps: 64,
  /** Phases in one definition. A phase is a barrier. */
  maxPhases: 12,
  /* The engine's numbers, not a second set: a graph and a script are one
     scheduler, so a run's default width cannot depend on how it was written. */
  maxParallel: ENGINE_LIMITS.maxConcurrency,
  defaultParallel: ENGINE_LIMITS.defaultConcurrency,
  /** Of a step's final prose kept as its output (and shown to the next step). */
  outputBytes: 256 * 1024,
} as const;

const JsonSchemaObject = z.record(z.string(), z.unknown());

export const StepOutputSchema = z.union([z.literal("text"), z.object({ schema: JsonSchemaObject })]);

export const RetrySchema = z.object({
  max: z.number().int().min(0).max(5).describe("Extra attempts after the first (0-5)."),
  backoffSec: z.number().positive().max(3600).optional().describe("Seconds before retry n is backoffSec * 2^(n-1). Default 2."),
  fallbackModel: z.string().min(1).optional().describe("Model used from the second attempt on."),
});

export const ToolsSchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
});

export const BudgetsSchema = z.object({
  tokens: z.number().int().positive().optional().describe("Output tokens, all agents of the run."),
  costUsd: z.number().positive().optional().describe("Estimated spend in USD."),
  agents: z.number().int().positive().optional().describe("Agents the run may start in its lifetime."),
  wallSec: z.number().int().positive().optional().describe("Wall-clock seconds, paused time excluded."),
});

/** `{{ref}}` is compared to a literal; every condition given must hold. With none given it means truthy. */
export const WhenSchema = z.object({
  ref: z.string().min(1).describe('What to test: "steps.<name>.output[.path]" or "inputs.<key>[.path]".'),
  equals: z.unknown().optional().describe("Run only if the value equals this (deep, JSON)."),
  notEquals: z.unknown().optional().describe("Run only if the value differs from this."),
  truthy: z.boolean().optional().describe("true: run only if the value is truthy; false: only if falsy."),
});

export const ForEachSchema = z.object({
  ref: z.string().min(1).describe('An array: "steps.<name>.output[.path]" or "inputs.<key>[.path]". The step runs once per element.'),
  as: z.string().optional().describe('Name the element goes by in the prompt: {{<as>}} / {{<as>.field}}. Default "item". {{index}} is the position.'),
  concurrency: z.number().int().min(1).max(LIMITS.maxParallel).optional().describe("Items of this step in flight at once. Default: as many as the run allows."),
});

export const WorkflowStepSchema = z.object({
  name: z.string().regex(STEP_NAME_RE, "a step name is a letter followed by up to 39 letters, digits, _ or -"),
  title: z.string().min(1).max(80).optional().describe("What the step reads as in the run's card, e.g. 'Audit the auth routes'. Default: the name made readable."),
  prompt: z.string().min(1).max(20_000),
  dependsOn: z.array(z.string()).default([]),
  output: StepOutputSchema.default("text"),
  timeoutSec: z.number().int().positive().max(ENGINE_LIMITS.stepTimeoutSec.max).optional(),
  model: z.string().min(1).optional().describe("Model for this step instead of the parent's."),
  effort: z.string().min(1).optional(),
  retry: RetrySchema.optional(),
  tools: ToolsSchema.optional().describe("Tool names this step may / may not use."),
  onRestart: z.enum(["resume", "rerun", "fail"]).optional().describe("What to do with this step if the server restarts while it runs."),
  isolation: z.literal("worktree").optional().describe("Run in a checkout of its own."),
  agentType: z.string().min(1).optional().describe("A library slash command whose body leads the prompt."),
  profile: z.string().min(1).optional().describe("Run on another profile (id or name)."),
  agent: z.string().min(1).optional().describe("Run on another agent (id or name)."),
  when: WhenSchema.optional().describe("Run only if this holds; otherwise the step is skipped with a null output (dependents still run)."),
  forEach: ForEachSchema.optional().describe("Fan out: run once per element; the output is the array of per-item outputs."),
});

export const WorkflowPhaseSchema = z.object({
  name: z.string().regex(STEP_NAME_RE, "a phase name is a letter followed by up to 39 letters, digits, _ or -"),
  description: z.string().max(500).optional(),
  steps: z.array(WorkflowStepSchema).min(1).max(LIMITS.maxSteps),
});

/** The definition's fields, without the graph checks — what the MCP tool
    advertises as its input schema. `steps` and `phases` are the two ways of
    writing the same thing; exactly one is given. */
export const WorkflowDefinitionShape = {
  name: z.string().min(1).max(80).describe("A short name for the workflow."),
  description: z.string().max(500).optional(),
  steps: z
    .array(WorkflowStepSchema)
    .min(1)
    .max(LIMITS.maxSteps)
    .optional()
    .describe("The steps, as one flat graph ordered by dependsOn. Give this OR phases, not both."),
  phases: z
    .array(WorkflowPhaseSchema)
    .min(1)
    .max(LIMITS.maxPhases)
    .optional()
    .describe(
      "The steps grouped into named stages that run one after another: a phase starts only once every step of the phase before it has completed, and its own steps run in parallel. Give this OR steps, not both.",
    ),
  maxParallel: z.number().int().min(1).max(LIMITS.maxParallel).default(LIMITS.defaultParallel).describe("Steps running at once."),
  totalTimeoutSec: z.number().int().positive().max(ENGINE_LIMITS.totalTimeoutSec.max).optional(),
  budgets: BudgetsSchema.optional().describe("Run limits; hitting one stops new agents and ends the run with its partial result."),
  priority: z.number().int().min(-100).max(100).optional().describe("Higher runs first when the global agent pool is contended."),
  concurrencyKey: z.string().min(1).max(80).optional().describe("Runs sharing a key share one concurrency pool."),
  onRestart: z.enum(["resume", "rerun", "fail"]).default("resume").describe("Default for a step in flight at a server restart."),
  inputs: JsonSchemaObject.optional().describe("JSON Schema for the run's inputs ({{inputs.key}}); drives the Run form."),
};

const RawDefinitionSchema = z.object(WorkflowDefinitionShape);
type RawDefinition = z.infer<typeof RawDefinitionSchema>;

export interface PhaseRef {
  index: number;
  name: string;
}

/** A phase as the run reports it — the outline the client draws before a step has spawned. */
export interface PhaseSummary {
  name: string;
  description?: string;
  steps: string[];
}

export type WorkflowStep = z.infer<typeof WorkflowStepSchema> & { phase?: PhaseRef };

/** A validated definition, always in one shape: a flat step list whose edges
    include the desugared phase barriers. */
export interface WorkflowDefinition {
  name: string;
  description?: string;
  steps: WorkflowStep[];
  phases: PhaseSummary[];
  maxParallel: number;
  totalTimeoutSec?: number;
  budgets: Budgets;
  priority?: number;
  concurrencyKey?: string;
  onRestart: OnRestart;
  inputs?: Record<string, unknown>;
}

function normalizeDefinition(raw: RawDefinition): { def: WorkflowDefinition; paths: (string | number)[][] } {
  const steps: WorkflowStep[] = [];
  const phases: PhaseSummary[] = [];
  const paths: (string | number)[][] = [];
  if (raw.phases?.length) {
    raw.phases.forEach((phase, p) => {
      const previous = phases[p - 1]?.steps ?? [];
      phase.steps.forEach((step, i) => {
        steps.push({
          ...step,
          phase: { index: p, name: phase.name },
          dependsOn: [...new Set([...step.dependsOn, ...previous])],
        });
        paths.push(["phases", p, "steps", i]);
      });
      phases.push({ name: phase.name, description: phase.description, steps: phase.steps.map((s) => s.name) });
    });
  } else {
    (raw.steps ?? []).forEach((step, i) => {
      steps.push({ ...step });
      paths.push(["steps", i]);
    });
  }
  return {
    def: {
      name: raw.name,
      description: raw.description,
      steps,
      phases,
      maxParallel: raw.maxParallel,
      totalTimeoutSec: raw.totalTimeoutSec,
      budgets: raw.budgets ?? {},
      priority: raw.priority,
      concurrencyKey: raw.concurrencyKey,
      onRestart: raw.onRestart,
      inputs: raw.inputs,
    },
    paths,
  };
}

/** A `when.ref` / `forEach.ref` as the reference it names, or null. Braces optional. */
function parseRefExpr(text: string): TemplateRef | null {
  const t = text.trim().replace(/^\{\{\s*/, "").replace(/\s*\}\}$/, "");
  const refs = collectRefs(`{{${t}}}`);
  const ref = refs[0];
  if (refs.length !== 1 || ref.raw !== `{{${t}}}`) return null;
  return ref.root === "inputs" || ref.root === "steps" ? ref : null;
}

/** The braceless expression for a parsed ref (`steps.a.output.b`). */
function refExpr(ref: TemplateRef): string {
  if (ref.root === "inputs") return ["inputs", ...ref.path].join(".");
  if (ref.root === "steps") return ["steps", ref.step, "output", ...ref.path].join(".");
  throw new Error("not an input or step reference");
}

export const WorkflowDefinitionSchema = RawDefinitionSchema.superRefine((raw, ctx) => {
  const hasSteps = (raw.steps?.length ?? 0) > 0;
  const hasPhases = (raw.phases?.length ?? 0) > 0;
  if (hasSteps === hasPhases) {
    ctx.addIssue({
      code: "custom",
      path: [],
      message: hasSteps ? "give either steps or phases, not both" : "a workflow needs steps (or phases of steps)",
    });
    return;
  }
  const { def, paths } = normalizeDefinition(raw);
  if (def.steps.length > LIMITS.maxSteps) {
    ctx.addIssue({ code: "custom", path: ["phases"], message: `a workflow has at most ${LIMITS.maxSteps} steps in all` });
  }
  if (def.inputs) {
    try {
      compileOutputSchema(def.inputs);
    } catch (error) {
      ctx.addIssue({ code: "custom", path: ["inputs"], message: `inputs is a schema this server cannot compile: ${describe(error)}` });
    }
  }
  const phaseNames = new Set<string>();
  def.phases.forEach((phase, p) => {
    if (phaseNames.has(phase.name)) ctx.addIssue({ code: "custom", path: ["phases", p, "name"], message: `duplicate phase "${phase.name}"` });
    phaseNames.add(phase.name);
  });
  const names = new Set<string>();
  const phaseOf = new Map<string, number>();
  def.steps.forEach((step, i) => {
    if (names.has(step.name)) ctx.addIssue({ code: "custom", path: [...paths[i], "name"], message: `duplicate step "${step.name}"` });
    names.add(step.name);
    if (step.phase) phaseOf.set(step.name, step.phase.index);
  });
  def.steps.forEach((step, i) => {
    const at = paths[i];
    const here = phaseOf.get(step.name);
    for (const dep of step.dependsOn) {
      if (!names.has(dep)) {
        ctx.addIssue({ code: "custom", path: [...at, "dependsOn"], message: `"${step.name}" depends on unknown step "${dep}"` });
      } else if (dep === step.name) {
        ctx.addIssue({ code: "custom", path: [...at, "dependsOn"], message: `"${step.name}" depends on itself` });
      } else if (here !== undefined && (phaseOf.get(dep) ?? -1) > here) {
        ctx.addIssue({
          code: "custom",
          path: [...at, "dependsOn"],
          message: `"${step.name}" depends on "${dep}", which is in a later phase`,
        });
      }
    }
    /* A template may only read a step whose output is guaranteed to exist:
       a direct dependency, or any step of an earlier phase (a barrier means
       every step of it has settled). */
    const deps = new Set(step.dependsOn);
    const checkRead = (ref: TemplateRef, where: (string | number)[], what: string) => {
      if (ref.root !== "steps" || deps.has(ref.step)) return;
      const there = phaseOf.get(ref.step);
      if (here !== undefined && there !== undefined && there < here) return;
      ctx.addIssue({
        code: "custom",
        path: where,
        message: def.phases.length
          ? `"${step.name}" reads ${what}{{steps.${ref.step}…}} but does not depend on "${ref.step}" and it is not in an earlier phase`
          : `"${step.name}" reads ${what}{{steps.${ref.step}…}} but does not depend on "${ref.step}"`,
      });
    };
    const itemName = step.forEach?.as ?? "item";
    if (step.forEach?.as !== undefined && (!ITEM_NAME_RE.test(step.forEach.as) || RESERVED_ITEM_NAMES.has(step.forEach.as))) {
      ctx.addIssue({
        code: "custom",
        path: [...at, "forEach", "as"],
        message: `"${step.name}" forEach.as must be an identifier other than inputs, steps or index`,
      });
    }
    for (const ref of collectRefs(step.prompt, itemName)) {
      if (ref.root === "item" || ref.root === "index") {
        if (!step.forEach) {
          ctx.addIssue({
            code: "custom",
            path: [...at, "prompt"],
            message: `"${step.name}" reads ${ref.raw} but has no forEach`,
          });
        }
        continue;
      }
      checkRead(ref, [...at, "prompt"], "");
    }
    for (const key of ["when", "forEach"] as const) {
      const spec = step[key];
      if (!spec) continue;
      const ref = parseRefExpr(spec.ref);
      if (!ref) {
        ctx.addIssue({
          code: "custom",
          path: [...at, key, "ref"],
          message: `"${step.name}" has a ${key}.ref "${spec.ref}" that is not inputs.<key> or steps.<name>.output`,
        });
        continue;
      }
      checkRead(ref, [...at, key, "ref"], `${key} `);
    }
    if (step.retry && step.retry.max === 0 && step.retry.fallbackModel) {
      ctx.addIssue({
        code: "custom",
        path: [...at, "retry"],
        message: `"${step.name}" names a fallbackModel but retry.max is 0, so it would never be used`,
      });
    }
    if (step.output !== "text") {
      try {
        compileOutputSchema(step.output.schema);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          path: [...at, "output"],
          message: `"${step.name}" has an output schema this server cannot compile: ${describe(error)}`,
        });
      }
    }
  });
  const cycle = findCycle(def.steps);
  if (cycle) ctx.addIssue({ code: "custom", path: ["steps"], message: `dependency cycle: ${cycle.join(" → ")}` });
}).transform((raw) => normalizeDefinition(raw).def);

/** What the tool takes before validation. */
export type WorkflowDefinitionInput = z.input<typeof WorkflowDefinitionSchema>;

export const InputsSchema = z.record(z.string(), z.unknown()).default({});

// ---- graph ----

/** A dependency cycle as the list of names that close it, or null. */
function findCycle(steps: WorkflowStep[]): string[] | null {
  const deps = new Map(steps.map((s) => [s.name, s.dependsOn]));
  const state = new Map<string, "in" | "done">();
  const stack: string[] = [];
  const visit = (name: string): string[] | null => {
    const seen = state.get(name);
    if (seen === "done") return null;
    if (seen === "in") return [...stack.slice(stack.indexOf(name)), name];
    state.set(name, "in");
    stack.push(name);
    for (const dep of deps.get(name) ?? []) {
      if (!deps.has(dep)) continue;
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(name, "done");
    return null;
  };
  for (const s of steps) {
    const found = visit(s.name);
    if (found) return found;
  }
  return null;
}

/** Steps in dependency order, stable by definition order. Assumes a valid (acyclic) definition. */
function topoOrder(steps: WorkflowStep[]): WorkflowStep[] {
  const byName = new Map(steps.map((s) => [s.name, s]));
  const placed = new Set<string>();
  const out: WorkflowStep[] = [];
  while (out.length < steps.length) {
    const before = out.length;
    for (const s of steps) {
      if (placed.has(s.name)) continue;
      if (s.dependsOn.every((d) => placed.has(d) || !byName.has(d))) {
        placed.add(s.name);
        out.push(s);
      }
    }
    if (out.length === before) throw new Error("dependency cycle");
  }
  return out;
}

/** What the client card draws before anything spawns: one entry per phase, or
    a single unnamed one for a flat definition. */
export function outlineOf(def: WorkflowDefinition): { name: string | null; steps: string[] }[] {
  if (def.phases.length) return def.phases.map((p) => ({ name: p.name, steps: [...p.steps] }));
  return [{ name: null, steps: def.steps.map((s) => s.name) }];
}

// ---- templates ----

/** `{{ inputs.key }}`, `{{ steps.name.output }}`, `{{ steps.name.output.a.0.b }}`,
    and inside a forEach `{{ item }}`, `{{ item.field }}`, `{{ index }}`. */
const REF_RE = /\{\{\s*([A-Za-z_][\w-]*(?:\.[\w-]+)*)\s*\}\}/g;

export type TemplateRef =
  | { root: "inputs"; path: string[]; raw: string }
  | { root: "steps"; step: string; path: string[]; raw: string }
  | { root: "item"; path: string[]; raw: string }
  | { root: "index"; raw: string };

/** Every well-formed reference in a template. Anything else between braces is
    left alone at render time, so markdown and code in a prompt survive.
    `itemName` is what the element is called (`forEach.as`, default "item"). */
export function collectRefs(template: string, itemName = "item"): TemplateRef[] {
  const out: TemplateRef[] = [];
  for (const m of template.matchAll(REF_RE)) {
    const parts = m[1].split(".");
    const raw = m[0];
    if (parts[0] === "inputs" && parts.length >= 2) out.push({ root: "inputs", path: parts.slice(1), raw });
    else if (parts[0] === "steps" && parts.length >= 3 && parts[2] === "output") {
      out.push({ root: "steps", step: parts[1], path: parts.slice(3), raw });
    } else if (parts[0] === itemName) out.push({ root: "item", path: parts.slice(1), raw });
    else if (parts.length === 1 && parts[0] === "index") out.push({ root: "index", raw });
  }
  return out;
}

export class TemplateError extends Error {}

export interface RenderContext {
  inputs: Record<string, unknown>;
  /** Completed steps' outputs — a string for text steps, parsed JSON otherwise. */
  steps: Record<string, unknown>;
  /** Inside a forEach: the element (`{{item}}`, or `{{<itemName>}}`). Present-but-undefined counts as present. */
  item?: unknown;
  /** Inside a forEach: the element's position (`{{index}}`). */
  index?: number;
  /** What the element is called. Default "item". */
  itemName?: string;
}

/** Walk a dotted path into a value. A path that walks off it is a `TemplateError`. */
function walk(value: unknown, path: string[], raw: string): unknown {
  for (const key of path) {
    if (value === null || typeof value !== "object") throw new TemplateError(`${raw}: "${key}" is not a property of a ${typeof value}`);
    const next = Array.isArray(value) ? value[Number(key)] : (value as Record<string, unknown>)[key];
    if (next === undefined) throw new TemplateError(`${raw}: no "${key}"`);
    value = next;
  }
  return value;
}

/** Fill a step's prompt. A missing input, an unknown or unfinished step, or a
    path that walks off the value is a `TemplateError`: the step fails before a
    prompt is ever sent rather than sending a prompt with a hole in it. */
export function renderTemplate(template: string, ctx: RenderContext): string {
  const hasItem = Object.hasOwn(ctx, "item");
  const itemName = ctx.itemName ?? "item";
  return template.replace(REF_RE, (raw, expr: string) => {
    const parts = expr.split(".");
    let value: unknown;
    let path: string[];
    if (parts[0] === "inputs" && parts.length >= 2) {
      if (!Object.hasOwn(ctx.inputs, parts[1])) throw new TemplateError(`${raw}: no input named "${parts[1]}"`);
      value = ctx.inputs[parts[1]];
      path = parts.slice(2);
    } else if (parts[0] === "steps" && parts.length >= 3 && parts[2] === "output") {
      if (!Object.hasOwn(ctx.steps, parts[1])) throw new TemplateError(`${raw}: step "${parts[1]}" has no output yet`);
      value = ctx.steps[parts[1]];
      path = parts.slice(3);
    } else if (hasItem && parts[0] === itemName) {
      value = ctx.item;
      path = parts.slice(1);
    } else if (hasItem && parts.length === 1 && parts[0] === "index") {
      value = ctx.index;
      path = [];
    } else {
      return raw;
    }
    return stringify(walk(value, path, raw));
  });
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

/** Pre-flight for the half of the refs validation cannot check: inputs are
    known only when the run starts. Reads the prompts, `when`/`forEach` refs and
    the `required` list of the inputs schema. */
export function missingInputs(def: WorkflowDefinition, inputs: Record<string, unknown>): string[] {
  const missing = new Set<string>();
  const need = (key: string) => {
    if (!Object.hasOwn(inputs, key)) missing.add(key);
  };
  for (const step of def.steps) {
    for (const ref of collectRefs(step.prompt, step.forEach?.as ?? "item")) {
      if (ref.root === "inputs") need(ref.path[0]);
    }
    for (const spec of [step.when, step.forEach]) {
      const ref = spec && parseRefExpr(spec.ref);
      if (ref && ref.root === "inputs") need(ref.path[0]);
    }
  }
  const required = def.inputs?.required;
  if (Array.isArray(required)) for (const key of required) if (typeof key === "string") need(key);
  return [...missing];
}

// ---- JSON output ----

const FENCE_RE = /```(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;

export class OutputError extends Error {}

/** The JSON value a step's prose carries: the last ```json fence, else a bare
    fence whose body starts with `{`/`[`, else the whole text. */
export function extractJsonOutput(text: string): unknown {
  const fences = [...text.matchAll(FENCE_RE)].map((m) => m[1].trim()).filter((b) => /^[[{]/.test(b));
  const candidates = fences.length ? [fences[fences.length - 1]] : [text.trim()];
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* fall through */
    }
  }
  throw new OutputError(
    fences.length ? "the last ```json fence is not valid JSON" : "the reply carries no JSON (expected one ```json fence)",
  );
}

/** A JSON Schema as a zod validator. Throws on a schema zod cannot express. */
export function compileOutputSchema(schema: Record<string, unknown>): z.ZodType {
  return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
}

/** Validate a step's JSON output; a string of issues on failure. */
export function validateOutput(schema: Record<string, unknown>, value: unknown): { ok: true; value: unknown } | { ok: false; issues: string } {
  const result = compileOutputSchema(schema).safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  const issues = result.error.issues
    .map((i) => `${i.path.length ? i.path.join(".") + ": " : ""}${i.message}`)
    .join("; ");
  return { ok: false, issues };
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---- compile to a script ----

/** JSON that is also safe as JavaScript source (U+2028/9 escaped). */
const lit = (value: unknown): string =>
  JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

/**
 * The runtime the generated script carries with it: a copy of the renderer
 * (so the script is self-contained and replays identically whatever the
 * server later learns), the `when` test, a bounded fan-out and the step
 * runner. Plain ES2020, no Date, no randomness, nothing but `agent`, `phase`
 * and `log` from the sandbox.
 */
const RUNTIME = String.raw`
const __inputs = typeof args === "object" && args !== null && !Array.isArray(args) ? args : {};
const __outputs = {};
const __status = {};
const __phases = {};
const __has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
class TemplateError extends Error {}
const __REF_RE = /\{\{\s*([A-Za-z_][\w-]*(?:\.[\w-]+)*)\s*\}\}/g;
function __str(v) {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v, null, 2);
  return String(v);
}
function __walk(value, path, raw) {
  for (const key of path) {
    if (value === null || typeof value !== "object") throw new TemplateError(raw + ': "' + key + '" is not a property of a ' + typeof value);
    const next = Array.isArray(value) ? value[Number(key)] : value[key];
    if (next === undefined) throw new TemplateError(raw + ': no "' + key + '"');
    value = next;
  }
  return value;
}
function __resolve(expr, raw, ctx, lenient) {
  const parts = expr.split(".");
  let value, path;
  if (parts[0] === "inputs" && parts.length >= 2) {
    if (!__has(ctx.inputs, parts[1])) {
      if (lenient) return { value: undefined };
      throw new TemplateError(raw + ': no input named "' + parts[1] + '"');
    }
    value = ctx.inputs[parts[1]];
    path = parts.slice(2);
  } else if (parts[0] === "steps" && parts.length >= 3 && parts[2] === "output") {
    if (!__has(ctx.steps, parts[1])) {
      if (lenient) return { value: undefined };
      throw new TemplateError(raw + ': step "' + parts[1] + '" has no output yet');
    }
    value = ctx.steps[parts[1]];
    path = parts.slice(3);
  } else if (ctx.hasItem && parts[0] === ctx.itemName) {
    value = ctx.item;
    path = parts.slice(1);
  } else if (ctx.hasItem && parts.length === 1 && parts[0] === "index") {
    value = ctx.index;
    path = [];
  } else {
    return null;
  }
  if (!lenient) return { value: __walk(value, path, raw) };
  try {
    return { value: __walk(value, path, raw) };
  } catch (e) {
    return { value: undefined };
  }
}
function __render(tpl, ctx) {
  return tpl.replace(__REF_RE, (raw, expr) => {
    const r = __resolve(expr, raw, ctx, false);
    return r === null ? raw : __str(r.value);
  });
}
function __ref(expr, ctx, lenient) {
  const r = __resolve(expr, "{{" + expr + "}}", ctx, lenient);
  if (r === null) throw new TemplateError("{{" + expr + "}} is not a reference");
  return r.value;
}
function __eq(a, b) {
  return a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));
}
function __holds(w, ctx) {
  const v = __ref(w.ref, ctx, true);
  let any = false;
  if (__has(w, "equals")) { any = true; if (!__eq(v, w.equals)) return false; }
  if (__has(w, "notEquals")) { any = true; if (__eq(v, w.notEquals)) return false; }
  if (__has(w, "truthy")) { any = true; if (!!v !== w.truthy) return false; }
  return any ? true : !!v;
}
async function __pool(n, limit, fn) {
  const results = new Array(n).fill(null);
  let next = 0;
  const width = Math.max(1, Math.min(limit || n, n));
  const workers = [];
  for (let w = 0; w < width; w++) {
    workers.push((async () => {
      while (next < n) {
        const i = next++;
        results[i] = await fn(i);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}
function __msg(e) {
  return e && typeof e === "object" && typeof e.message === "string" ? e.message : String(e);
}
function __call(s, label, ctx) {
  return agent(__render(s.prompt, ctx), Object.assign({}, s.opts, { label: label }));
}
async function __run(s) {
  if (s.phase !== null && !__phases[s.phase]) {
    __phases[s.phase] = true;
    phase(s.phase);
  }
  const failedDep = s.deps.find((d) => __status[d] === "failed");
  if (failedDep !== undefined) {
    __outputs[s.name] = null;
    __status[s.name] = "failed";
    log('skipped step "' + s.name + '": dependency "' + failedDep + '" did not complete');
    return;
  }
  try {
    const base = { inputs: __inputs, steps: __outputs };
    if (s.when && !__holds(s.when, base)) {
      __outputs[s.name] = null;
      __status[s.name] = "skipped";
      log('skipped step "' + s.name + '": its "when" condition on ' + s.when.ref + " does not hold");
      return;
    }
    let out;
    if (s.forEach) {
      const items = __ref(s.forEach.ref, base, false);
      if (!Array.isArray(items)) throw new TemplateError("forEach {{" + s.forEach.ref + "}} is not an array");
      const itemName = s.forEach.as || "item";
      let failures = 0;
      out = await __pool(items.length, s.forEach.concurrency, async (i) => {
        try {
          const ctx = { inputs: __inputs, steps: __outputs, hasItem: true, item: items[i], index: i, itemName: itemName };
          return await __call(s, s.name, ctx);
        } catch (e) {
          failures++;
          log('step "' + s.name + '" item ' + i + " failed: " + __msg(e));
          return null;
        }
      });
      if (items.length > 0 && failures === items.length) throw new Error("every one of the " + items.length + " items failed");
    } else {
      out = await __call(s, s.name, base);
    }
    __outputs[s.name] = out;
    __status[s.name] = "ok";
  } catch (e) {
    __outputs[s.name] = null;
    __status[s.name] = "failed";
    log('step "' + s.name + '" failed: ' + __msg(e));
  }
}
`;

/** The agent() options a step carries (everything but the label, which is per call). */
function agentOpts(step: WorkflowStep): Record<string, unknown> {
  const opts: Record<string, unknown> = {};
  if (step.title) opts.title = step.title;
  if (step.output !== "text") opts.schema = step.output.schema;
  if (step.model) opts.model = step.model;
  if (step.effort) opts.effort = step.effort;
  if (step.isolation) opts.isolation = step.isolation;
  if (step.agentType) opts.agentType = step.agentType;
  if (step.profile) opts.profile = step.profile;
  if (step.agent) opts.agent = step.agent;
  if (step.retry) opts.retry = step.retry;
  if (step.tools) opts.tools = step.tools;
  if (step.timeoutSec) opts.timeoutSec = step.timeoutSec;
  if (step.onRestart) opts.onRestart = step.onRestart;
  return opts;
}

/**
 * Compile a validated definition to a script in the Claude-Code-compatible
 * dialect. The source begins with a pure-literal `export const meta`, then
 * builds the DAG with promises — a step starts as soon as every step it
 * depends on has settled; how many run at once is the engine's business — and
 * ends with `return { steps: { <name>: output | null } }`.
 *
 * Sandbox surface used: `agent(prompt, opts)`, `phase(title)`, `log(message)`,
 * `args`, top-level `await` and `return`. Nothing else. Every step's label is
 * its name (a forEach step's items all carry it; their prompts differ).
 */
export function compileDefinition(def: WorkflowDefinition): { source: string; meta: ScriptMeta } {
  const meta: ScriptMeta = {
    name: def.name,
    description: def.description ?? def.name,
    phases: def.phases.map((p) => (p.description ? { title: p.name, detail: p.description } : { title: p.name })),
    plan: outlineOf(def).map((phase) => ({
      name: phase.name,
      steps: phase.steps.map((name) => ({ name, title: def.steps.find((s) => s.name === name)?.title ?? name })),
    })),
    ...(def.inputs ? { inputs: def.inputs } : {}),
  };
  const ordered = topoOrder(def.steps);
  const varOf = new Map(def.steps.map((s, i) => [s.name, `p${i}`]));
  const lines: string[] = [];
  lines.push(`export const meta = ${lit(meta)};`);
  lines.push("");
  lines.push(`// Compiled from the declarative workflow definition ${lit(def.name)}. Do not edit: the definition is the source.`);
  lines.push(RUNTIME.trim());
  lines.push("");
  for (const step of def.steps) {
    const data: Record<string, unknown> = {
      name: step.name,
      phase: step.phase?.name ?? null,
      deps: step.dependsOn,
      prompt: step.prompt,
      opts: agentOpts(step),
    };
    if (step.forEach) {
      const ref = parseRefExpr(step.forEach.ref);
      data.forEach = { ...step.forEach, ref: ref ? refExpr(ref) : step.forEach.ref };
    }
    if (step.when) {
      const ref = parseRefExpr(step.when.ref);
      data.when = { ...step.when, ref: ref ? refExpr(ref) : step.when.ref };
    }
    lines.push(`const s_${varOf.get(step.name)} = ${lit(data)};`);
  }
  lines.push("");
  for (const step of ordered) {
    const v = varOf.get(step.name)!;
    const waits = step.dependsOn.map((d) => `p_${varOf.get(d)}`);
    const head = waits.length ? `Promise.all([${waits.join(", ")}])` : "Promise.resolve()";
    lines.push(`const p_${v} = ${head}.then(() => __run(s_${v})); // ${lit(step.name)}`);
  }
  lines.push("");
  lines.push(`await Promise.all([${def.steps.map((s) => `p_${varOf.get(s.name)}`).join(", ")}]);`);
  lines.push(`const __result = {};`);
  lines.push(`for (const name of ${lit(def.steps.map((s) => s.name))}) __result[name] = __has(__outputs, name) ? __outputs[name] : null;`);
  lines.push(`return { steps: __result };`);
  lines.push("");
  return { source: lines.join("\n"), meta };
}
