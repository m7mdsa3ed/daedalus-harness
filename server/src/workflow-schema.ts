/*
 * The shape of a workflow definition, and the pure functions over it.
 *
 * Shared by the engine (`workflows.ts`) and the `workflow` MCP server
 * (`workflow-mcp.ts`), which is a separate process spawned by the agent — so
 * nothing here may import the database, the config or the session manager:
 * zod and arithmetic only. Everything is unit-tested without an agent
 * (`test/workflow-schema.test.ts`).
 *
 * A definition is declarative on purpose: steps, edges and templates are data
 * the server can validate up front — duplicate names, cycles, a template that
 * reads a step it never waited for — and then draw and replay.
 *
 * This file used to say that the server must therefore never interpret a
 * *program* an agent wrote. It does now (`workflow-script.ts`), because that
 * rule cost more than it bought: fanning out over a list the run discovered,
 * looping until a search goes dry and having agents check each other are the
 * shapes real workflows are made of, and none of them is a static graph. Both
 * engines stand, and a definition is still the better answer whenever the
 * pipeline can be written down in full — everything below runs before a single
 * agent spawns, where a script's only pre-flight is that its `meta` parses.
 */
import { z } from "zod";

/** The MCP server's name — what the agent sees the tools under
    (`mcp__workflow__run_workflow` in Claude Code, `mcp.workflow.run_workflow`
    in Codex). */
export const WORKFLOW_SERVER_NAME = "workflow";
/** Claude Code's own orchestration tool, disallowed on threads that link ours. */
export const CLAUDE_WORKFLOW_TOOL = "Workflow";

export const STEP_NAME_RE = /^[a-z][a-z0-9_-]{0,39}$/i;

export const LIMITS = {
  maxSteps: 16,
  /** Phases in one definition. A phase is a barrier, so this is how many times
      a run may stop and wait for everything before it. */
  maxPhases: 6,
  maxParallel: 5,
  defaultParallel: 3,
  /** Per step. */
  stepTimeoutSec: { default: 15 * 60, max: 60 * 60 },
  /** Whole run. */
  totalTimeoutSec: { default: 60 * 60, max: 3 * 60 * 60 },
  /** Of a step's final prose kept as its output (and shown to the next step). */
  outputBytes: 256 * 1024,
} as const;

const JsonSchemaObject = z.record(z.string(), z.unknown());

export const StepOutputSchema = z.union([z.literal("text"), z.object({ schema: JsonSchemaObject })]);

export const WorkflowStepSchema = z.object({
  name: z.string().regex(STEP_NAME_RE, "a step name is a letter followed by up to 39 letters, digits, _ or -"),
  prompt: z.string().min(1).max(20_000),
  dependsOn: z.array(z.string()).default([]),
  output: StepOutputSchema.default("text"),
  timeoutSec: z.number().int().positive().max(LIMITS.stepTimeoutSec.max).optional(),
});

/**
 * A phase: named steps that run side by side, behind a barrier.
 *
 * Phases are **sugar over the edges**, not a second way of scheduling. A
 * definition written in phases is desugared at parse time — every step of
 * phase k gains a `dependsOn` on every step of phase k-1 — so the engine sees
 * one flat DAG and `readySteps`, `dependentsOf`, the cycle check and the skip
 * cascade are all untouched by their existence. What phases buy is the two
 * things a flat list cannot say: a name for a stage of the work, and the
 * guarantee that lets a later step read an earlier one's output without
 * anybody writing the edges out by hand.
 */
export const WorkflowPhaseSchema = z.object({
  name: z.string().regex(STEP_NAME_RE, "a phase name is a letter followed by up to 39 letters, digits, _ or -"),
  description: z.string().max(500).optional(),
  steps: z.array(WorkflowStepSchema).min(1).max(LIMITS.maxSteps),
});

/** The definition's fields, without the graph checks — what the MCP tool
    advertises as its input schema, so the agent sees the shape. `steps` and
    `phases` are the two ways of writing the same thing; exactly one is given. */
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
  maxParallel: z.number().int().min(1).max(LIMITS.maxParallel).default(LIMITS.defaultParallel),
  totalTimeoutSec: z.number().int().positive().max(LIMITS.totalTimeoutSec.max).optional(),
};

const RawDefinitionSchema = z.object(WorkflowDefinitionShape);
type RawDefinition = z.infer<typeof RawDefinitionSchema>;

/** Where a step sits in the definition, for the client's run card and for the
    "may this template read that step" rule. */
export interface PhaseRef {
  index: number;
  name: string;
}

/** A phase as the run reports it — the outline the client draws before a step
    has spawned. Empty for a definition written as a flat `steps` list. */
export interface PhaseSummary {
  name: string;
  description?: string;
  steps: string[];
}

export type WorkflowStep = z.infer<typeof WorkflowStepSchema> & {
  phase?: PhaseRef;
  /* ── Set only by the script engine (workflow-script.ts) ──
     A script's agents are steps of exactly the same kind — the runner spawns,
     prompts, validates and retires them through the one path — but they are
     written in code rather than declared, so three things a definition fixes
     up front arrive per call instead. */
  /** The prompt is the author's own text and is NOT a template: a script
      composes its prompts in JavaScript, so `{{…}}` in one is whatever the
      author typed and must reach the agent untouched. */
  literal?: boolean;
  /** `agent(…, {model, effort})`. A definition's steps always run as the
      parent does; a script may spend a cheaper model on a mechanical stage. */
  model?: string;
  effort?: string;
};

/** A validated definition, always in the engine's one shape: a flat step list
    whose edges include the desugared phase barriers. */
export interface WorkflowDefinition {
  name: string;
  description?: string;
  steps: WorkflowStep[];
  phases: PhaseSummary[];
  maxParallel: number;
  totalTimeoutSec?: number;
}

/**
 * Both written forms as the one shape, with the barriers turned into edges.
 * Total and defensive — it runs before validation has passed, so it may not
 * assume the definition is well formed. `paths` is parallel to `def.steps` and
 * says where each step was written, so an issue points at what the agent sent.
 */
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
    },
    paths,
  };
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
        // Desugaring only ever adds an edge from the phase before, so a
        // forward edge is one the agent wrote. findCycle would catch it, but
        // "cycle" is the wrong word for what it did.
        ctx.addIssue({
          code: "custom",
          path: [...at, "dependsOn"],
          message: `"${step.name}" depends on "${dep}", which is in a later phase`,
        });
      }
    }
    /* A template may only read a step whose output is guaranteed to exist.
       Direct dependencies are one such guarantee — transitive ones are not,
       since the engine schedules on direct edges — and an earlier *phase* is
       the other, because a barrier means every step of it has completed. */
    const deps = new Set(step.dependsOn);
    for (const ref of collectRefs(step.prompt)) {
      if (ref.root !== "steps" || deps.has(ref.step)) continue;
      const there = phaseOf.get(ref.step);
      if (here !== undefined && there !== undefined && there < here) continue;
      ctx.addIssue({
        code: "custom",
        path: [...at, "prompt"],
        message: def.phases.length
          ? `"${step.name}" reads {{steps.${ref.step}…}} but does not depend on "${ref.step}" and it is not in an earlier phase`
          : `"${step.name}" reads {{steps.${ref.step}…}} but does not depend on "${ref.step}"`,
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

/** Every step whose dependencies are all in `done` and which is not itself in
    `done` or `started`. Readiness by "all deps completed", not by layer, so a
    fast branch never waits for a slow sibling. */
export function readySteps(def: WorkflowDefinition, done: ReadonlySet<string>, started: ReadonlySet<string>): WorkflowStep[] {
  return def.steps.filter(
    (s) => !done.has(s.name) && !started.has(s.name) && s.dependsOn.every((d) => done.has(d)),
  );
}

/** Every step that (transitively) depends on `name`. */
export function dependentsOf(def: WorkflowDefinition, name: string): string[] {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of def.steps) {
      if (out.has(s.name)) continue;
      if (s.dependsOn.some((d) => d === name || out.has(d))) {
        out.add(s.name);
        grew = true;
      }
    }
  }
  return [...out];
}

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

// ---- templates ----

/** `{{ inputs.key }}`, `{{ steps.name.output }}`, `{{ steps.name.output.a.0.b }}`. */
const REF_RE = /\{\{\s*([A-Za-z_][\w-]*(?:\.[\w-]+)*)\s*\}\}/g;

export type TemplateRef =
  | { root: "inputs"; path: string[]; raw: string }
  | { root: "steps"; step: string; path: string[]; raw: string };

/** Every well-formed reference in a template. Anything else between braces is
    left alone at render time, so markdown and code in a prompt survive. */
export function collectRefs(template: string): TemplateRef[] {
  const out: TemplateRef[] = [];
  for (const m of template.matchAll(REF_RE)) {
    const parts = m[1].split(".");
    const raw = m[0];
    if (parts[0] === "inputs" && parts.length >= 2) out.push({ root: "inputs", path: parts.slice(1), raw });
    else if (parts[0] === "steps" && parts.length >= 3 && parts[2] === "output") {
      out.push({ root: "steps", step: parts[1], path: parts.slice(3), raw });
    }
  }
  return out;
}

export class TemplateError extends Error {}

export interface RenderContext {
  inputs: Record<string, unknown>;
  /** Completed steps' outputs — a string for text steps, parsed JSON otherwise. */
  steps: Record<string, unknown>;
}

/** Fill a step's prompt. A missing input, an unknown or unfinished step, or a
    path that walks off the value is a `TemplateError`: the step fails before a
    prompt is ever sent rather than sending a prompt with a hole in it. */
export function renderTemplate(template: string, ctx: RenderContext): string {
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
    } else {
      return raw;
    }
    for (const key of path) {
      if (value === null || typeof value !== "object") throw new TemplateError(`${raw}: "${key}" is not a property of a ${typeof value}`);
      const next = Array.isArray(value) ? value[Number(key)] : (value as Record<string, unknown>)[key];
      if (next === undefined) throw new TemplateError(`${raw}: no "${key}"`);
      value = next;
    }
    return stringify(value);
  });
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

/** Pre-flight for the half of the refs validation cannot check: inputs are
    known only when the run starts. */
export function missingInputs(def: WorkflowDefinition, inputs: Record<string, unknown>): string[] {
  const missing = new Set<string>();
  for (const step of def.steps) {
    for (const ref of collectRefs(step.prompt)) {
      if (ref.root === "inputs" && !Object.hasOwn(inputs, ref.path[0])) missing.add(ref.path[0]);
    }
  }
  return [...missing];
}

// ---- JSON output ----

/** A JSON-fenced block; the *last* one is the answer (a model often shows its
    working in earlier fences). A bare fence counts when its body is a JSON
    value. */
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

/** A JSON Schema as a zod validator. Throws on a schema zod cannot express, which
    validation reports at definition time. */
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
