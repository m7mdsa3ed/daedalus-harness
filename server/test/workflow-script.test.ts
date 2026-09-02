// Self-check for the script sandbox (src/workflow-script.ts): the engine that
// runs an agent-authored orchestration program.
//
// No agent and no session manager — `agent()` arrives as a hook, so everything
// the script layer decides (the API's contracts, the caps, the clock ban, what
// a thrown thunk does) is checked here in-process.
// Run: pnpm test:workflow-script
import assert from "node:assert/strict";
import {
  SCRIPT_LIMITS,
  ScriptError,
  extractMeta,
  runScript,
  type ScriptHooks,
} from "../src/workflow-script.js";

const META = `export const meta = { name: 'demo', description: 'a demo' }\n`;

interface Recorded {
  prompts: string[];
  labels: string[];
  phases: (string | null)[];
  logs: string[];
  entered: string[];
}

function harness(
  reply: (spec: { prompt: string; label: string }) => unknown = (s) => `out:${s.label}`,
  spent = () => 0,
): { hooks: ScriptHooks; rec: Recorded; abort: AbortController } {
  const rec: Recorded = { prompts: [], labels: [], phases: [], logs: [], entered: [] };
  const abort = new AbortController();
  const hooks: ScriptHooks = {
    async agent(spec) {
      rec.prompts.push(spec.prompt);
      rec.labels.push(spec.label);
      rec.phases.push(spec.phase);
      const out = reply(spec);
      if (out instanceof Error) throw out;
      return out;
    },
    phase: (t) => rec.entered.push(t),
    log: (m) => rec.logs.push(m),
    spent,
    signal: abort.signal,
  };
  return { hooks, rec, abort };
}

const run = (source: string, over: Partial<Parameters<typeof runScript>[0]> = {}) => {
  const { hooks, rec, abort } = harness();
  return { promise: runScript({ source, args: undefined, hooks, budgetTotal: null, ...over }), rec, abort };
};

// ---- meta ----
{
  const meta = extractMeta(`export const meta = {
    name: 'review',
    description: 'Review the diff', // a } inside a comment
    phases: [{ title: 'Find', detail: 'one per dimension' }, { title: 'Verify' }],
  }
  phase('Find')`);
  assert.equal(meta.name, "review");
  assert.deepEqual(meta.phases, [{ title: "Find", detail: "one per dimension" }, { title: "Verify" }]);

  // A brace inside a string must not close the literal early.
  assert.equal(extractMeta(`export const meta = { name: '}', description: 'x' }`).name, "}");

  const rejects = (source: string, what: string) =>
    assert.throws(() => extractMeta(source), (e: unknown) => e instanceof ScriptError, what);
  rejects("const meta = {}", "meta must be exported");
  rejects("export const meta = { description: 'x' }", "a name is required");
  rejects("export const meta = { name: 'x' }", "a description is required");
  // Pure literal: computing it would mean the run's name could not be known
  // before the run.
  rejects("export const meta = { name: something, description: 'x' }", "no variables");
  rejects("export const meta = { name: nameOf(), description: 'x' }", "no calls");
}

// ---- the shape of a script: top-level await and a top-level return ----
{
  const { promise, rec } = run(`${META}
    phase('Read')
    const a = await agent('read the server', { label: 'server' })
    return { a }
  `);
  const { result, agents } = await promise;
  assert.deepEqual(result, { a: "out:server" });
  assert.equal(agents, 1);
  assert.deepEqual(rec.entered, ["Read"]);
  assert.deepEqual(rec.phases, ["Read"], "an agent joins the phase the script is on");
  assert.deepEqual(rec.labels, ["server"]);
}

// ---- parallel is a barrier; a thrown thunk is a null, not a failed run ----
{
  const { hooks, rec } = harness((s) => (s.label === "b" ? new Error("boom") : `out:${s.label}`));
  const { result } = await runScript({
    source: `${META}
      const out = await parallel([
        () => agent('x', { label: 'a' }),
        () => agent('x', { label: 'b' }),
        () => agent('x', { label: 'c' }),
      ])
      return out
    `,
    args: undefined,
    hooks,
    budgetTotal: null,
  });
  assert.deepEqual(result, ["out:a", null, "out:c"], "a failed thunk is null so .filter(Boolean) works");
  assert.ok(rec.logs.some((l) => l.includes("boom")), "and the failure is still said out loud");
}

// ---- pipeline: every item through every stage, no barrier between them ----
{
  const { hooks } = harness();
  const { result } = await runScript({
    source: `${META}
      return await pipeline(
        ['x', 'y'],
        (item) => agent('find in ' + item, { label: 'find:' + item }),
        (found, item, index) => agent('verify ' + found, { label: 'verify:' + item + ':' + index }),
      )
    `,
    args: undefined,
    hooks,
    budgetTotal: null,
  });
  assert.deepEqual(result, ["out:verify:x:0", "out:verify:y:1"], "later stages see the original item and its index");
}
{
  // A stage that throws drops its item and skips the rest of that item's chain.
  const { hooks, rec } = harness((s) => (s.label.startsWith("find:y") ? new Error("nope") : `out:${s.label}`));
  const { result } = await runScript({
    source: `${META}
      return await pipeline(['x','y'], (i) => agent('f', { label: 'find:' + i }), (v, i) => agent('v', { label: 'verify:' + i }))
    `,
    args: undefined,
    hooks,
    budgetTotal: null,
  });
  assert.deepEqual(result, ["out:verify:x", null]);
  assert.ok(!rec.labels.includes("verify:y"), "the rest of a dropped item's chain does not run");
}

// ---- args, log, and an explicit per-agent phase ----
{
  const { hooks, rec } = harness();
  await runScript({
    source: `${META}
      log('starting ' + args.what)
      phase('One')
      await agent('a', { label: 'a' })
      await agent('b', { label: 'b', phase: 'Two' })
    `,
    args: { what: "things" },
    hooks,
    budgetTotal: null,
  });
  assert.deepEqual(rec.logs, ["starting things"]);
  assert.deepEqual(rec.phases, ["One", "Two"], "opts.phase overrides the cursor, which is what keeps stages out of a race");
}

// ---- budget ----
{
  let spent = 0;
  const { hooks } = harness(() => { spent += 40; return "ok"; }, () => spent);
  const { result, agents } = await runScript({
    source: `${META}
      const out = []
      while (budget.total && budget.remaining() > 30) out.push(await agent('go', { label: 'a' + out.length }))
      return { n: out.length, remaining: budget.remaining(), total: budget.total }
    `,
    args: undefined,
    hooks,
    budgetTotal: 100,
  });
  assert.deepEqual(result, { n: 2, remaining: 20, total: 100 });
  assert.equal(agents, 2);
  // With no target the loop guard is false, so `budget.total &&` is what keeps
  // an unbudgeted run off the agent cap.
  const { hooks: h2 } = harness();
  const { result: r2 } = await runScript({
    // `remaining()` is Infinity with no target, which is what makes the guard
    // above false rather than a number to compare — asserted as the comparison
    // the script actually makes, since Infinity has no JSON form to come back as.
    source: `${META}\nreturn { total: budget.total, unbounded: budget.remaining() === Infinity }`,
    args: undefined,
    hooks: h2,
    budgetTotal: null,
  });
  assert.deepEqual(r2, { total: null, unbounded: true });
}

// ---- the clock is not readable ----
for (const expr of ["Date.now()", "new Date()", "Math.random()"]) {
  await assert.rejects(
    () => run(`${META}\nreturn ${expr}`).promise,
    (e: unknown) => e instanceof ScriptError && /unreplayable/.test((e as Error).message),
    `${expr} must be refused`,
  );
}
// A date the script was *given* still works, which is the whole point of the
// stand-in rather than deleting `Date`.
{
  const { result } = await run(`${META}\nreturn new Date(args.at).getUTCFullYear()`, { args: { at: 0 } }).promise;
  assert.equal(result, 1970);
}

// ---- what is simply not there ----
for (const expr of ["process.env", "require('fs')", "setTimeout(() => {}, 1)", "fetch('http://x')"]) {
  await assert.rejects(() => run(`${META}\nreturn ${expr}`).promise, /is not defined/, `${expr} must be absent`);
}

// ---- caps ----
await assert.rejects(
  () => run(`${META}\nawait parallel(Array.from({length: ${SCRIPT_LIMITS.maxItems + 1}}, () => () => 1))`).promise,
  (e: unknown) => e instanceof ScriptError && /past the cap/.test((e as Error).message),
  "too many items is an error, not a silent truncation",
);
await assert.rejects(
  () => runScript({ source: `${META}\n// ${"x".repeat(SCRIPT_LIMITS.sourceBytes)}`, args: undefined, hooks: harness().hooks, budgetTotal: null }),
  (e: unknown) => e instanceof ScriptError,
  "an oversized source is refused",
);
{
  const { hooks } = harness();
  await assert.rejects(
    () => runScript({
      source: `${META}\nfor (let i = 0; i < ${SCRIPT_LIMITS.maxAgents + 1}; i++) await agent('go', { label: 'a' })`,
      args: undefined, hooks, budgetTotal: null,
    }),
    (e: unknown) => e instanceof ScriptError && /cap/.test((e as Error).message),
    "the agent cap is a runaway-loop backstop",
  );
}

// ---- a syntax error names itself rather than crashing the run ----
await assert.rejects(
  () => run(`${META}\nthis is not javascript`).promise,
  (e: unknown) => e instanceof ScriptError && /does not parse/.test((e as Error).message),
);

// ---- cancellation wins, and does not become a list of nulls ----
{
  const { hooks, abort } = harness(() => {
    abort.abort();
    throw new Error("cancelled underneath");
  });
  await assert.rejects(
    () => runScript({
      source: `${META}\nreturn await parallel([() => agent('a', { label: 'a' })])`,
      args: undefined, hooks, budgetTotal: null,
    }),
    "a cancelled run stops rather than returning nulls",
  );
}

console.log("workflow-script: ok");
