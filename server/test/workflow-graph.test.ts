// Self-check for the declarative workflow front door (src/workflows/graph.ts):
//   - validation (ported from workflow-schema.test.ts) plus the v2 fields.
//   - template helpers: renderTemplate with item/index, missingInputs, JSON output.
//   - compileDefinition: the generated source is EXECUTED against a fake
//     sandbox (node:vm) and checked for dependency order, skip-on-failure,
//     `when`, `forEach`, phases and the result shape.
// Run: DAEDALUS_DATA_DIR=/tmp/x pnpm exec tsx test/workflow-graph.test.ts
import "./require-temp-data.js";
import assert from "node:assert/strict";
import vm from "node:vm";

const {
  WorkflowDefinitionSchema,
  compileDefinition,
  extractJsonOutput,
  missingInputs,
  outlineOf,
  renderTemplate,
  validateOutput,
  collectRefs,
} = await import("../src/workflows/graph.js");

let passed = 0;
const failures: string[] = [];
const queue: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  queue.push({ name, fn });
}

const good = {
  name: "review",
  steps: [
    { name: "a", prompt: "echo:A" },
    { name: "b", prompt: "echo:B" },
    { name: "c", prompt: "{{steps.a.output}}+{{steps.b.output}}+{{inputs.x}}", dependsOn: ["a", "b"] },
  ],
};

const refuse = (def: unknown, re: RegExp) => {
  const r = WorkflowDefinitionSchema.safeParse(def);
  assert.equal(r.success, false);
  const text = r.success ? "" : r.error.issues.map((i) => i.message).join("\n");
  assert.match(text, re);
};
const parse = (def: unknown) => WorkflowDefinitionSchema.parse(def);

// ---- validation (ported) ----
test("accepts a pipeline and fills the defaults", () => {
  const r = parse(good);
  assert.equal(r.maxParallel, 3);
  assert.equal(r.steps[0].output, "text");
  assert.deepEqual(r.steps[0].dependsOn, []);
  assert.equal(r.onRestart, "resume");
  assert.deepEqual(r.budgets, {});
});
test("refuses a bad step name", () => refuse({ ...good, steps: [{ name: "1st step", prompt: "x" }] }, /step name/));
test("refuses a duplicate step", () => refuse({ ...good, steps: [{ name: "a", prompt: "x" }, { name: "a", prompt: "y" }] }, /duplicate/));
test("refuses an unknown dependency", () => refuse({ ...good, steps: [{ name: "a", prompt: "x", dependsOn: ["zz"] }] }, /unknown step "zz"/));
test("refuses a self dependency", () => refuse({ ...good, steps: [{ name: "a", prompt: "x", dependsOn: ["a"] }] }, /itself/));
test("refuses a cycle", () =>
  refuse(
    { ...good, steps: [{ name: "a", prompt: "x", dependsOn: ["b"] }, { name: "b", prompt: "y", dependsOn: ["a"] }] },
    /cycle: (a → b → a|b → a → b)/,
  ));
test("refuses a template that reads a non-dependency", () =>
  refuse({ ...good, steps: [{ name: "a", prompt: "x" }, { name: "b", prompt: "{{steps.a.output}}" }] }, /does not depend on "a"/));
test("refuses more than the step cap", () =>
  refuse({ ...good, steps: Array.from({ length: 65 }, (_, i) => ({ name: `s${i}`, prompt: "x" })) }, /Too big|at most|<=/i));
test("accepts 64 steps", () => {
  assert.equal(parse({ ...good, steps: Array.from({ length: 64 }, (_, i) => ({ name: `s${i}`, prompt: "x" })) }).steps.length, 64);
});
test("maxParallel goes to 16 and no further", () => {
  assert.equal(parse({ ...good, maxParallel: 16 }).maxParallel, 16);
  refuse({ ...good, maxParallel: 17 }, /Too big|<=/i);
});
test("refuses an output schema zod cannot compile", () =>
  refuse({ ...good, steps: [{ name: "a", prompt: "x", output: { schema: { type: "nonsense" } } }] }, /cannot compile/));

const phased = {
  name: "review",
  phases: [
    { name: "research", steps: [{ name: "a", prompt: "echo:A" }, { name: "b", prompt: "echo:B" }] },
    { name: "implement", steps: [{ name: "c", prompt: "{{steps.a.output}}" }] },
    { name: "verify", steps: [{ name: "d", prompt: "{{steps.a.output}}+{{steps.c.output}}" }] },
  ],
};

test("desugars phases into edges and keeps the outline", () => {
  const def = parse(phased);
  assert.deepEqual(def.steps.map((s) => s.name), ["a", "b", "c", "d"]);
  assert.deepEqual(def.steps.map((s) => s.dependsOn), [[], [], ["a", "b"], ["c"]]);
  assert.deepEqual(def.steps.map((s) => s.phase?.name), ["research", "research", "implement", "verify"]);
  assert.deepEqual(def.phases, [
    { name: "research", description: undefined, steps: ["a", "b"] },
    { name: "implement", description: undefined, steps: ["c"] },
    { name: "verify", description: undefined, steps: ["d"] },
  ]);
});
test("a flat definition has no phases and keeps its edges", () => {
  const def = parse(good);
  assert.deepEqual(def.phases, []);
  assert.equal(def.steps[0].phase, undefined);
  assert.deepEqual(def.steps[2].dependsOn, ["a", "b"]);
});
test("a phase step may read any earlier phase without an edge", () => {
  assert.equal(WorkflowDefinitionSchema.safeParse(phased).success, true);
});
test("refuses reading a step in the same phase without an edge", () =>
  refuse(
    { name: "w", phases: [{ name: "one", steps: [{ name: "a", prompt: "x" }, { name: "b", prompt: "{{steps.a.output}}" }] }] },
    /not in an earlier phase/,
  ));
test("refuses depending on a later phase", () =>
  refuse(
    {
      name: "w",
      phases: [
        { name: "one", steps: [{ name: "a", prompt: "x", dependsOn: ["b"] }] },
        { name: "two", steps: [{ name: "b", prompt: "y" }] },
      ],
    },
    /in a later phase/,
  ));
test("refuses both steps and phases, and neither", () => {
  refuse({ ...good, phases: phased.phases }, /either steps or phases/);
  refuse({ name: "w" }, /needs steps/);
});
test("refuses a duplicate step across phases", () =>
  refuse(
    {
      name: "w",
      phases: [
        { name: "one", steps: [{ name: "a", prompt: "x" }] },
        { name: "two", steps: [{ name: "a", prompt: "y" }] },
      ],
    },
    /duplicate step "a"/,
  ));
test("refuses more than the step cap across phases", () =>
  refuse(
    {
      name: "w",
      phases: [
        { name: "one", steps: Array.from({ length: 40 }, (_, i) => ({ name: `a${i}`, prompt: "x" })) },
        { name: "two", steps: Array.from({ length: 40 }, (_, i) => ({ name: `b${i}`, prompt: "x" })) },
      ],
    },
    /at most 64 steps/,
  ));
test("refuses more than 12 phases", () =>
  refuse(
    { name: "w", phases: Array.from({ length: 13 }, (_, i) => ({ name: `p${i}`, steps: [{ name: `s${i}`, prompt: "x" }] })) },
    /Too big|<=/i,
  ));
test("refuses a duplicate phase", () =>
  refuse(
    {
      name: "w",
      phases: [
        { name: "one", steps: [{ name: "a", prompt: "x" }] },
        { name: "one", steps: [{ name: "b", prompt: "y" }] },
      ],
    },
    /duplicate phase "one"/,
  ));

// ---- v2 fields ----
test("accepts the per-step v2 fields", () => {
  const def = parse({
    name: "w",
    budgets: { tokens: 1000, costUsd: 2 },
    priority: 5,
    concurrencyKey: "repo",
    onRestart: "rerun",
    inputs: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
    steps: [
      {
        name: "a",
        prompt: "{{inputs.x}}",
        model: "m",
        effort: "high",
        retry: { max: 2, backoffSec: 1, fallbackModel: "m2" },
        tools: { allow: ["Read"], deny: ["Bash"] },
        timeoutSec: 60,
        onRestart: "fail",
        isolation: "worktree",
        agentType: "reviewer",
        profile: "p",
        agent: "codex",
      },
    ],
  });
  assert.equal(def.steps[0].retry?.max, 2);
  assert.equal(def.budgets.tokens, 1000);
  assert.equal(def.onRestart, "rerun");
  assert.equal(def.priority, 5);
  assert.equal(def.concurrencyKey, "repo");
});
test("refuses retry.max above 5, a bad onRestart and a bad isolation", () => {
  refuse({ ...good, steps: [{ name: "a", prompt: "x", retry: { max: 6 } }] }, /Too big|<=/i);
  refuse({ ...good, steps: [{ name: "a", prompt: "x", onRestart: "later" }] }, /./);
  refuse({ ...good, steps: [{ name: "a", prompt: "x", isolation: "vm" }] }, /./);
});
test("refuses a fallbackModel with no retries", () =>
  refuse({ ...good, steps: [{ name: "a", prompt: "x", retry: { max: 0, fallbackModel: "m" } }] }, /fallbackModel/));
test("refuses an inputs schema zod cannot compile", () => refuse({ ...good, inputs: { type: "nonsense" } }, /inputs is a schema/));
test("when/forEach refs obey the read rule", () => {
  refuse(
    { name: "w", steps: [{ name: "a", prompt: "x" }, { name: "b", prompt: "y", when: { ref: "steps.a.output", truthy: true } }] },
    /reads when \{\{steps\.a…\}\} but does not depend on "a"/,
  );
  refuse(
    { name: "w", steps: [{ name: "a", prompt: "x" }, { name: "b", prompt: "y", forEach: { ref: "steps.a.output" } }] },
    /reads forEach \{\{steps\.a…\}\}/,
  );
  assert.equal(
    WorkflowDefinitionSchema.safeParse({
      name: "w",
      steps: [{ name: "a", prompt: "x" }, { name: "b", prompt: "y", dependsOn: ["a"], when: { ref: "{{ steps.a.output.ok }}", equals: true } }],
    }).success,
    true,
  );
});
test("refuses a when/forEach ref that is not an input or step", () =>
  refuse({ name: "w", steps: [{ name: "a", prompt: "x", when: { ref: "nope.x" } }] }, /not inputs\.<key> or steps\.<name>\.output/));
test("refuses {{item}} without a forEach, accepts it with one", () => {
  refuse({ name: "w", steps: [{ name: "a", prompt: "{{item}}" }] }, /has no forEach/);
  assert.equal(parse({ name: "w", steps: [{ name: "a", prompt: "{{item.x}} {{index}}", forEach: { ref: "inputs.xs" } }] }).steps.length, 1);
});
test("forEach.as renames the element and may not shadow", () => {
  assert.equal(
    parse({ name: "w", steps: [{ name: "a", prompt: "{{file}}", forEach: { ref: "inputs.xs", as: "file" } }] }).steps.length,
    1,
  );
  refuse({ name: "w", steps: [{ name: "a", prompt: "x", forEach: { ref: "inputs.xs", as: "steps" } }] }, /identifier other than/);
});
test("a forEach step may read an earlier step's array through a dependency", () => {
  assert.equal(
    WorkflowDefinitionSchema.safeParse({
      name: "w",
      steps: [
        { name: "list", prompt: "x", output: { schema: { type: "array" } } },
        { name: "each", prompt: "{{item}}", dependsOn: ["list"], forEach: { ref: "steps.list.output", concurrency: 2 } },
      ],
    }).success,
    true,
  );
});

// ---- templates ----
test("renderTemplate fills inputs and outputs", () => {
  const out = renderTemplate("{{steps.a.output}}+{{ steps.b.output }}+{{inputs.x}} {{not.a.ref}}", {
    inputs: { x: "x" },
    steps: { a: "A", b: { k: [1, { z: "deep" }] } },
  });
  assert.equal(out, 'A+{\n  "k": [\n    1,\n    {\n      "z": "deep"\n    }\n  ]\n}+x {{not.a.ref}}');
});
test("renderTemplate walks dotted paths into JSON", () => {
  const out = renderTemplate("{{steps.j.output.findings.0}} / {{steps.j.output.n}}", { inputs: {}, steps: { j: { findings: ["one"], n: 2 } } });
  assert.equal(out, "one / 2");
});
test("renderTemplate throws on a hole", () => {
  assert.throws(() => renderTemplate("{{inputs.missing}}", { inputs: {}, steps: {} }), /no input named "missing"/);
  assert.throws(() => renderTemplate("{{steps.z.output}}", { inputs: {}, steps: {} }), /no output yet/);
  assert.throws(() => renderTemplate("{{steps.j.output.nope}}", { inputs: {}, steps: { j: { a: 1 } } }), /no "nope"/);
});
test("renderTemplate resolves item and index only with an item context", () => {
  assert.equal(renderTemplate("{{item.n}} #{{index}} {{item}}", { inputs: {}, steps: {}, item: { n: "a" }, index: 3 }), 'a #3 {\n  "n": "a"\n}');
  assert.equal(renderTemplate("{{item}} {{index}}", { inputs: {}, steps: {} }), "{{item}} {{index}}");
  assert.equal(renderTemplate("{{f}}", { inputs: {}, steps: {}, item: "x", index: 0, itemName: "f" }), "x");
  assert.throws(() => renderTemplate("{{item.q}}", { inputs: {}, steps: {}, item: { n: 1 }, index: 0 }), /no "q"/);
});
test("collectRefs sees item and index", () => {
  const refs = collectRefs("{{item.a}} {{index}} {{inputs.x}}");
  assert.deepEqual(refs.map((r) => r.root), ["item", "index", "inputs"]);
});
test("missingInputs names what the run was not given", () => {
  const def = parse(good);
  assert.deepEqual(missingInputs(def, {}), ["x"]);
  assert.deepEqual(missingInputs(def, { x: 1 }), []);
});
test("missingInputs reads when/forEach refs and the inputs schema's required", () => {
  const def = parse({
    name: "w",
    inputs: { type: "object", required: ["req"] },
    steps: [{ name: "a", prompt: "x", when: { ref: "inputs.flag" }, forEach: { ref: "inputs.list" } }],
  });
  assert.deepEqual(missingInputs(def, {}).sort(), ["flag", "list", "req"]);
});
test("outlineOf draws phases, or one unnamed list", () => {
  assert.deepEqual(outlineOf(parse(phased)), [
    { name: "research", steps: ["a", "b"] },
    { name: "implement", steps: ["c"] },
    { name: "verify", steps: ["d"] },
  ]);
  assert.deepEqual(outlineOf(parse(good)), [{ name: null, steps: ["a", "b", "c"] }]);
});

test("extractJsonOutput takes the last json fence", () => {
  const text = 'First try:\n```json\n{"a":1}\n```\nBetter:\n```json\n{"a":2}\n```\n';
  assert.deepEqual(extractJsonOutput(text), { a: 2 });
});
test("extractJsonOutput accepts a bare fence and bare JSON", () => {
  assert.deepEqual(extractJsonOutput("```\n[1,2]\n```"), [1, 2]);
  assert.deepEqual(extractJsonOutput(' {"b": true} '), { b: true });
});
test("extractJsonOutput refuses prose", () => {
  assert.throws(() => extractJsonOutput("no json here"), /no JSON/);
  assert.throws(() => extractJsonOutput("```json\n{oops}\n```"), /not valid JSON/);
});
test("validateOutput reports issues", () => {
  const schema = { type: "object", required: ["findings"], properties: { findings: { type: "array" } } };
  assert.equal(validateOutput(schema, { findings: [] }).ok, true);
  const bad = validateOutput(schema, { nope: 1 });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.issues, /findings/);
});

// ---- compileDefinition, executed against a fake sandbox ----

interface Call {
  prompt: string;
  opts: Record<string, unknown>;
}
interface Fake {
  calls: Call[];
  /** "start:<label>" / "end:<label>" in the order they happened. */
  events: string[];
  phases: string[];
  logs: string[];
  result: unknown;
  meta: any;
}

/** Run compiled source in a vm. `handler` answers an agent call (may throw or return a promise). */
async function execute(
  source: string,
  args: unknown,
  handler: (prompt: string, opts: Call["opts"]) => unknown = (_p, o) => `out:${o.label}`,
): Promise<Fake> {
  const fake: Fake = { calls: [], events: [], phases: [], logs: [], result: undefined, meta: undefined };
  // `export const meta` is a module form: the sandbox lifts it; here we strip the keyword.
  const metaMatch = /^export const meta = (.*);$/m.exec(source);
  assert.ok(metaMatch, "source begins with a literal meta");
  assert.ok(source.startsWith("export const meta = "), "meta is the first statement");
  fake.meta = JSON.parse(metaMatch[1]);
  const body = source.replace(/^export const meta = /m, "const meta = ");
  const context = vm.createContext({
    args,
    agent: async (prompt: string, rawOpts: Call["opts"]) => {
      const opts = JSON.parse(JSON.stringify(rawOpts)) as Call["opts"];
      fake.calls.push({ prompt, opts });
      fake.events.push(`start:${opts.label}`);
      try {
        await Promise.resolve();
        return await handler(prompt, opts);
      } finally {
        fake.events.push(`end:${opts.label}`);
      }
    },
    parallel: async (thunks: (() => unknown)[]) => Promise.all(thunks.map((t) => t())),
    phase: (title: string) => fake.phases.push(title),
    log: (message: string) => fake.logs.push(message),
    Date: undefined,
  });
  const script = new vm.Script(`(async () => {\n${body}\n})()`);
  // Cross-realm objects have another Object.prototype: compare as plain JSON.
  fake.result = JSON.parse(JSON.stringify(await script.runInContext(context)));
  return fake;
}

const idx = (f: Fake, e: string) => {
  const i = f.events.indexOf(e);
  assert.ok(i >= 0, `${e} happened`);
  return i;
};

test("compiled source is self-contained and begins with a literal meta", () => {
  const { source, meta } = compileDefinition(parse({ ...good, description: "d", inputs: { type: "object" } }));
  assert.ok(source.startsWith("export const meta = "));
  assert.deepEqual(meta, { name: "review", description: "d", phases: [], inputs: { type: "object" } });
  assert.doesNotMatch(source, /\b(require|import\s*\(|Date\.|Math\.random|__render\(\s*\)|process\.)/);
});
test("meta carries the phases", () => {
  const { meta } = compileDefinition(parse({ ...phased, phases: phased.phases.map((p, i) => (i === 0 ? { ...p, description: "look" } : p)) }));
  assert.deepEqual(meta.phases, [{ title: "research", detail: "look" }, { title: "implement" }, { title: "verify" }]);
  assert.equal(meta.description, "review");
});
test("runs the DAG in dependency order and returns the step outputs", async () => {
  const { source } = compileDefinition(parse(good));
  const f = await execute(source, { x: "X" });
  assert.deepEqual(f.calls.map((c) => c.opts.label).sort(), ["a", "b", "c"]);
  // a and b start immediately (before either ends); c only after both ended
  assert.ok(idx(f, "start:b") < idx(f, "end:a"));
  assert.ok(idx(f, "start:c") > idx(f, "end:a") && idx(f, "start:c") > idx(f, "end:b"));
  assert.equal(f.calls.find((c) => c.opts.label === "c")!.prompt, "out:a+out:b+X");
  assert.deepEqual(f.result, { steps: { a: "out:a", b: "out:b", c: "out:c" } });
});
test("the agent label equals the step name, and options pass through", async () => {
  const def = parse({
    name: "w",
    steps: [
      {
        name: "a",
        prompt: "p",
        model: "m",
        effort: "low",
        retry: { max: 1 },
        tools: { deny: ["Bash"] },
        timeoutSec: 30,
        onRestart: "rerun",
        isolation: "worktree",
        agentType: "rev",
        profile: "pr",
        agent: "ag",
        output: { schema: { type: "object" } },
      },
    ],
  });
  const f = await execute(compileDefinition(def).source, {}, () => ({ ok: 1 }));
  assert.deepEqual(f.calls[0].opts, {
    schema: { type: "object" },
    model: "m",
    effort: "low",
    isolation: "worktree",
    agentType: "rev",
    profile: "pr",
    agent: "ag",
    retry: { max: 1 },
    tools: { deny: ["Bash"] },
    timeoutSec: 30,
    onRestart: "rerun",
    label: "a",
  });
  assert.deepEqual(f.result, { steps: { a: { ok: 1 } } });
});
test("a failed step becomes null, siblings continue, dependents are skipped with a log", async () => {
  const def = parse({
    name: "w",
    steps: [
      { name: "bad", prompt: "x" },
      { name: "ok", prompt: "y" },
      { name: "after", prompt: "z", dependsOn: ["bad"] },
      { name: "deeper", prompt: "z", dependsOn: ["after"] },
      { name: "indep", prompt: "z", dependsOn: ["ok"] },
    ],
  });
  const f = await execute(compileDefinition(def).source, {}, (_p, o) => {
    if (o.label === "bad") throw new Error("boom");
    return `out:${o.label}`;
  });
  assert.deepEqual(f.calls.map((c) => c.opts.label).sort(), ["bad", "indep", "ok"]);
  assert.deepEqual(f.result, { steps: { bad: null, ok: "out:ok", after: null, deeper: null, indep: "out:indep" } });
  assert.ok(f.logs.some((l) => /"bad" failed: boom/.test(l)));
  assert.ok(f.logs.some((l) => /skipped step "after".*"bad"/.test(l)));
  assert.ok(f.logs.some((l) => /skipped step "deeper".*"after"/.test(l)));
});
test("a template hole fails that step before agent() is called", async () => {
  const f = await execute(compileDefinition(parse(good)).source, {}); // no input x
  assert.deepEqual(f.calls.map((c) => c.opts.label).sort(), ["a", "b"]);
  assert.deepEqual(f.result, { steps: { a: "out:a", b: "out:b", c: null } });
  assert.ok(f.logs.some((l) => /no input named "x"/.test(l)));
});
test("phases announce themselves once, at the first step started, and act as barriers", async () => {
  const f = await execute(compileDefinition(parse(phased)).source, {});
  assert.deepEqual(f.phases, ["research", "implement", "verify"]);
  assert.ok(idx(f, "start:c") > idx(f, "end:a") && idx(f, "start:c") > idx(f, "end:b"));
  assert.ok(idx(f, "start:d") > idx(f, "end:c"));
  assert.equal(f.calls.find((c) => c.opts.label === "d")!.prompt, "out:a+out:c");
});
test("when: equals / notEquals / truthy decide whether a step runs", async () => {
  const def = parse({
    name: "w",
    steps: [
      { name: "gate", prompt: "g", output: { schema: { type: "object" } } },
      { name: "yes", prompt: "y", dependsOn: ["gate"], when: { ref: "steps.gate.output.mode", equals: "deep" } },
      { name: "no", prompt: "n", dependsOn: ["gate"], when: { ref: "steps.gate.output.mode", notEquals: "deep" } },
      { name: "flag", prompt: "f", dependsOn: ["gate"], when: { ref: "{{steps.gate.output.ok}}", truthy: true } },
      { name: "input", prompt: "i", when: { ref: "inputs.on" } },
      { name: "missing", prompt: "m", when: { ref: "inputs.absent", truthy: true } },
      { name: "after", prompt: "a", dependsOn: ["no"] },
    ],
  });
  const f = await execute(compileDefinition(def).source, { on: 1 }, (_p, o) => (o.label === "gate" ? { mode: "deep", ok: false } : `out:${o.label}`));
  assert.deepEqual(f.calls.map((c) => c.opts.label).sort(), ["after", "gate", "input", "yes"]);
  // a skipped step is null, not a failure: its dependents still run
  assert.deepEqual(f.result, {
    steps: { gate: { mode: "deep", ok: false }, yes: "out:yes", no: null, flag: null, input: "out:input", missing: null, after: "out:after" },
  });
  assert.ok(f.logs.some((l) => /skipped step "no".*when/.test(l)));
});
test("forEach runs once per element with item/index in the prompt and returns the array", async () => {
  const def = parse({
    name: "w",
    steps: [
      { name: "list", prompt: "l", output: { schema: { type: "array" } } },
      { name: "each", prompt: "[{{index}}] {{item.name}}", dependsOn: ["list"], forEach: { ref: "steps.list.output" } },
      { name: "all", prompt: "{{steps.each.output}}", dependsOn: ["each"] },
    ],
  });
  const f = await execute(compileDefinition(def).source, {}, (p, o) => (o.label === "list" ? [{ name: "x" }, { name: "y" }, { name: "z" }] : `out:${p}`));
  const each = f.calls.filter((c) => c.opts.label === "each");
  assert.deepEqual(each.map((c) => c.prompt), ["[0] x", "[1] y", "[2] z"]);
  assert.deepEqual((f.result as any).steps.each, ["out:[0] x", "out:[1] y", "out:[2] z"]);
  assert.ok(idx(f, "start:all") > f.events.lastIndexOf("end:each"));
});
test("forEach over inputs, with a renamed element and a concurrency cap", async () => {
  const def = parse({
    name: "w",
    steps: [{ name: "each", prompt: "{{file}}@{{index}}", forEach: { ref: "inputs.files", as: "file", concurrency: 2 } }],
  });
  let live = 0;
  let peak = 0;
  const f = await execute(compileDefinition(def).source, { files: ["a", "b", "c", "d", "e"] }, async (p) => {
    live++;
    peak = Math.max(peak, live);
    await Promise.resolve();
    await Promise.resolve();
    live--;
    return p;
  });
  assert.deepEqual((f.result as any).steps.each, ["a@0", "b@1", "c@2", "d@3", "e@4"]);
  assert.equal(peak, 2);
});
test("forEach: an item that fails is null, every item failing fails the step; an empty array is []", async () => {
  const mk = (extra: Record<string, unknown> = {}) =>
    compileDefinition(parse({ name: "w", steps: [{ name: "each", prompt: "{{item}}", forEach: { ref: "inputs.xs" }, ...extra }, { name: "next", prompt: "n", dependsOn: ["each"] }] })).source;
  const partial = await execute(mk(), { xs: ["ok", "bad", "ok2"] }, (p) => {
    if (p === "bad") throw new Error("nope");
    return p;
  });
  assert.deepEqual((partial.result as any).steps, { each: ["ok", null, "ok2"], next: "n" });
  const all = await execute(mk(), { xs: ["bad", "bad"] }, () => {
    throw new Error("nope");
  });
  assert.deepEqual((all.result as any).steps, { each: null, next: null });
  assert.ok(all.logs.some((l) => /every one of the 2 items failed/.test(l)));
  const none = await execute(mk(), { xs: [] });
  assert.deepEqual((none.result as any).steps.each, []);
  assert.deepEqual(none.calls.map((c) => c.opts.label), ["next"]);
});
test("forEach over a non-array fails the step", async () => {
  const f = await execute(
    compileDefinition(parse({ name: "w", steps: [{ name: "each", prompt: "{{item}}", forEach: { ref: "inputs.xs" } }] })).source,
    { xs: "str" },
  );
  assert.deepEqual(f.result, { steps: { each: null } });
  assert.ok(f.logs.some((l) => /is not an array/.test(l)));
});
test("when and forEach combine: a false when skips the fan-out", async () => {
  const def = parse({
    name: "w",
    steps: [{ name: "each", prompt: "{{item}}", when: { ref: "inputs.go", truthy: true }, forEach: { ref: "inputs.xs" } }],
  });
  const f = await execute(compileDefinition(def).source, { go: false, xs: [1, 2] });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.result, { steps: { each: null } });
});
test("prompts with braces that are not refs survive", async () => {
  const def = parse({ name: "w", steps: [{ name: "a", prompt: "code: `${x}` {{not a ref}} {a: 1}" }] });
  const f = await execute(compileDefinition(def).source, {});
  assert.equal(f.calls[0].prompt, "code: `${x}` {{not a ref}} {a: 1}");
});
test("hostile text in names and prompts cannot break out of the source", async () => {
  const def = parse({
    name: "w\u2028\"; throw 1; //",
    description: "`${process}` \u2029",
    steps: [{ name: "a", prompt: "\"; throw new Error('x'); // \u2028 `${1+1}` \\" }],
  });
  const { source } = compileDefinition(def);
  const f = await execute(source, {});
  assert.equal(f.calls[0].prompt, "\"; throw new Error('x'); // \u2028 `${1+1}` \\");
  assert.deepEqual(f.result, { steps: { a: `out:a` } });
});
test("args that are not an object read as no inputs", async () => {
  const f = await execute(compileDefinition(parse({ name: "w", steps: [{ name: "a", prompt: "{{inputs.k}}" }] })).source, undefined);
  assert.deepEqual(f.result, { steps: { a: null } });
});
test("the compiled script's render agrees with renderTemplate", async () => {
  const tpl = "{{inputs.o.k.0}} | {{inputs.s}} | {{inputs.n}} | {{inputs.nul}} | {{ inputs.o }}";
  const inputs = { o: { k: ["v"] }, s: "str", n: 4, nul: null };
  const f = await execute(compileDefinition(parse({ name: "w", steps: [{ name: "a", prompt: tpl }] })).source, inputs);
  assert.equal(f.calls[0].prompt, renderTemplate(tpl, { inputs, steps: {} }));
});

for (const { name, fn } of queue) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(`\n${passed} passed${failures.length ? `, ${failures.length} failed: ${failures.join(", ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
