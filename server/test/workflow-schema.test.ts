// Self-check for the workflow definition schema (src/workflow-schema.ts):
//   - validation refuses bad names, unknown/self deps, cycles, a template that
//     reads a step it does not depend on, too many steps, a schema zod cannot
//     compile — and accepts a good pipeline with defaults filled in.
//   - readySteps/dependentsOf follow the edges.
//   - renderTemplate fills inputs, text and JSON outputs, dotted paths, and
//     throws on a hole rather than rendering one.
//   - extractJsonOutput takes the last ```json fence, a bare fence, bare JSON,
//     and refuses prose.
// Run: pnpm test:workflow-schema
import assert from "node:assert/strict";

const {
  WorkflowDefinitionSchema,
  dependentsOf,
  extractJsonOutput,
  missingInputs,
  readySteps,
  renderTemplate,
  validateOutput,
} = await import("../src/workflow-schema.js");

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`);
  }
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

console.log("workflow-schema");
test("accepts a pipeline and fills the defaults", () => {
  const r = WorkflowDefinitionSchema.parse(good);
  assert.equal(r.maxParallel, 3);
  assert.equal(r.steps[0].output, "text");
  assert.deepEqual(r.steps[0].dependsOn, []);
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
  refuse({ ...good, steps: Array.from({ length: 17 }, (_, i) => ({ name: `s${i}`, prompt: "x" })) }, /Too big|at most|<=/i));
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
  const def = WorkflowDefinitionSchema.parse(phased);
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
  const def = WorkflowDefinitionSchema.parse(good);
  assert.deepEqual(def.phases, []);
  assert.equal(def.steps[0].phase, undefined);
  assert.deepEqual(def.steps[2].dependsOn, ["a", "b"]);
});
test("a phase is a barrier: readySteps stops at it", () => {
  const def = WorkflowDefinitionSchema.parse(phased);
  assert.deepEqual(readySteps(def, new Set(), new Set()).map((s) => s.name), ["a", "b"]);
  assert.deepEqual(readySteps(def, new Set(["a"]), new Set(["a", "b"])).map((s) => s.name), []);
  assert.deepEqual(readySteps(def, new Set(["a", "b"]), new Set(["a", "b"])).map((s) => s.name), ["c"]);
});
test("a failed step in an early phase skips every later one", () => {
  const def = WorkflowDefinitionSchema.parse(phased);
  assert.deepEqual(dependentsOf(def, "b").sort(), ["c", "d"]);
});
test("a phase step may read any earlier phase without an edge", () => {
  // "d" reads "a", two phases back, and declares nothing.
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
        { name: "one", steps: Array.from({ length: 9 }, (_, i) => ({ name: `a${i}`, prompt: "x" })) },
        { name: "two", steps: Array.from({ length: 9 }, (_, i) => ({ name: `b${i}`, prompt: "x" })) },
      ],
    },
    /at most 16 steps/,
  ));

test("readySteps follows the edges", () => {
  const def = WorkflowDefinitionSchema.parse(good);
  assert.deepEqual(readySteps(def, new Set(), new Set()).map((s) => s.name), ["a", "b"]);
  assert.deepEqual(readySteps(def, new Set(["a"]), new Set(["a", "b"])).map((s) => s.name), []);
  assert.deepEqual(readySteps(def, new Set(["a", "b"]), new Set(["a", "b"])).map((s) => s.name), ["c"]);
});
test("dependentsOf is transitive", () => {
  const def = WorkflowDefinitionSchema.parse({
    ...good,
    steps: [...good.steps, { name: "d", prompt: "x", dependsOn: ["c"] }],
  });
  assert.deepEqual(dependentsOf(def, "a").sort(), ["c", "d"]);
  assert.deepEqual(dependentsOf(def, "d"), []);
});

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
test("missingInputs names what the run was not given", () => {
  const def = WorkflowDefinitionSchema.parse(good);
  assert.deepEqual(missingInputs(def, {}), ["x"]);
  assert.deepEqual(missingInputs(def, { x: 1 }), []);
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

console.log(`\n${passed} passed${failures.length ? `, ${failures.length} failed: ${failures.join(", ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
