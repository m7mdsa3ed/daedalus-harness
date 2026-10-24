// Self-check for the v2 workflow sandbox (src/workflows/sandbox.ts): the
// deterministic runtime of an agent-authored orchestration script.
//
// No agent, no database, no session manager: every primitive is checked
// against a fake `SandboxHooks` that records what the sandbox asked of the
// engine, so ordering, validation, caps and the clock ban are all asserted
// in-process. Ports every applicable case of workflow-script.test.ts.
import assert from "node:assert/strict";
import { SCRIPT_LIMITS, type AgentSpec, type Budgets, type SandboxHooks } from "../src/workflows/types.js";
import { ScriptError, UNLIMITED, extractMeta, runScript } from "../src/workflows/sandbox.js";

const META = `export const meta = { name: 'demo', description: 'a demo' }\n`;

interface Recorded {
  specs: AgentSpec[];
  prompts: string[];
  labels: string[];
  phases: (string | null)[];
  logs: string[];
  entered: string[];
  calls: string[];
  state: Record<string, unknown>;
}

interface Fake {
  hooks: SandboxHooks;
  rec: Recorded;
  abort: AbortController;
  usage: { tokens: number; costUsd: number; agents: number };
  budgets: Budgets;
}

function harness(
  reply: (spec: AgentSpec) => unknown = (s) => `out:${s.label}`,
  over: Partial<SandboxHooks> = {},
): Fake {
  const rec: Recorded = { specs: [], prompts: [], labels: [], phases: [], logs: [], entered: [], calls: [], state: {} };
  const abort = new AbortController();
  const usage = { tokens: 0, costUsd: 0, agents: 0 };
  const budgets: Budgets = {};
  const hooks: SandboxHooks = {
    async agent(spec) {
      rec.specs.push(spec);
      rec.prompts.push(spec.prompt);
      rec.labels.push(spec.label);
      rec.phases.push(spec.phase);
      rec.calls.push(`agent:${spec.label}`);
      const out = reply(spec);
      if (out instanceof Error) throw out;
      return out;
    },
    async approve(text, opts) {
      rec.calls.push(`approve:${text}:${opts.options.join("|")}:${opts.timeoutSec ?? ""}`);
      return opts.options[0];
    },
    async sleep(s) { rec.calls.push(`sleep:${s}`); },
    async until(t) { rec.calls.push(`until:${t}`); },
    async waitFor(name, opts) { rec.calls.push(`waitFor:${name}:${opts.timeoutSec ?? ""}`); return { name, got: true }; },
    async sh(cmd, opts) { rec.calls.push(`sh:${cmd}:${opts.cwd ?? ""}:${opts.timeoutSec ?? ""}`); return { exitCode: 0, stdout: "hi\n", stderr: "" }; },
    async artifact(name, data) { rec.calls.push(`artifact:${name}:${JSON.stringify(data)}`); },
    setState(path, value) { rec.state[path] = value; rec.calls.push(`setState:${path}`); },
    getState: (path) => rec.state[path],
    phase: (t) => rec.entered.push(t),
    log: (m) => rec.logs.push(m),
    usage: () => usage,
    budgets: () => budgets,
    signal: abort.signal,
    ...over,
  };
  return { hooks, rec, abort, usage, budgets };
}

const run = (source: string, over: { args?: unknown; fake?: Fake } = {}) => {
  const fake = over.fake ?? harness();
  return { promise: runScript({ source, args: over.args, hooks: fake.hooks }), ...fake };
};

const isScriptError = (re: RegExp) => (e: unknown) => e instanceof ScriptError && re.test((e as Error).message);

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
  assert.equal(meta.inputs, undefined);

  assert.equal(extractMeta(`export const meta = { name: '}', description: 'x' }`).name, "}");

  const rejects = (source: string, what: string) =>
    assert.throws(() => extractMeta(source), (e: unknown) => e instanceof ScriptError, what);
  rejects("const meta = {}", "meta must be exported");
  rejects("export const meta = { description: 'x' }", "a name is required");
  rejects("export const meta = { name: 'x' }", "a description is required");
  rejects("export const meta = { name: something, description: 'x' }", "no variables");
  rejects("export const meta = { name: nameOf(), description: 'x' }", "no calls");
  rejects("export const meta = { name: 'x', description: 'y', inputs: 5 }", "inputs must be an object");

  // v2: whenToUse and a JSON-schema `inputs`, back in the host realm.
  const rich = extractMeta(`export const meta = {
    name: 'a', description: 'b', whenToUse: 'when c',
    inputs: { type: 'object', properties: { branch: { type: 'string' } }, required: ['branch'] },
  }`);
  assert.equal(rich.whenToUse, "when c");
  assert.deepEqual(rich.inputs, { type: "object", properties: { branch: { type: "string" } }, required: ["branch"] });
  assert.equal(Object.getPrototypeOf(rich.inputs), Object.prototype, "inputs is host-realm JSON");
}

// ---- the shape of a script: top-level await and a top-level return ----
{
  const { promise, rec } = run(`${META}
    phase('Read')
    const a = await agent('read the server', { label: 'server' })
    return { a }
  `);
  const { result } = await promise;
  assert.deepEqual(result, { a: "out:server" });
  assert.deepEqual(rec.entered, ["Read"]);
  assert.deepEqual(rec.phases, ["Read"], "an agent joins the phase the script is on");
  assert.deepEqual(rec.labels, ["server"]);
}

// ---- default label is a deterministic counter; phase defaults to the cursor ----
{
  const { promise, rec } = run(`${META}
    await agent('a')
    phase('P')
    await Promise.all([agent('b'), agent('c', { label: '  ' })])
    await agent('d', { phase: 'Other' })
  `);
  await promise;
  assert.deepEqual(rec.labels, ["agent-1", "agent-2", "agent-3", "agent-4"]);
  assert.deepEqual(rec.phases, [null, "P", "P", "Other"]);
}

// ---- parallel is a barrier; a thrown thunk is a null, not a failed run ----
{
  const fake = harness((s) => (s.label === "b" ? new Error("boom") : `out:${s.label}`));
  const { result } = await run(`${META}
      return await parallel([
        () => agent('x', { label: 'a' }),
        () => agent('x', { label: 'b' }),
        () => agent('x', { label: 'c' }),
      ])
    `, { fake }).promise;
  assert.deepEqual(result, ["out:a", null, "out:c"], "a failed thunk is null so .filter(Boolean) works");
  assert.ok(fake.rec.logs.some((l) => l.includes("boom")), "and the failure is still said out loud");
}

// ---- pipeline: every item through every stage, no barrier between them ----
{
  const { result } = await run(`${META}
      return await pipeline(
        ['x', 'y'],
        (item) => agent('find in ' + item, { label: 'find:' + item }),
        (found, item, index) => agent('verify ' + found, { label: 'verify:' + item + ':' + index }),
      )
    `).promise;
  assert.deepEqual(result, ["out:verify:x:0", "out:verify:y:1"], "later stages see the original item and its index");
}
{
  const fake = harness((s) => (s.label.startsWith("find:y") ? new Error("nope") : `out:${s.label}`));
  const { result } = await run(`${META}
      return await pipeline(['x','y'], (i) => agent('f', { label: 'find:' + i }), (v, i) => agent('v', { label: 'verify:' + i }))
    `, { fake }).promise;
  assert.deepEqual(result, ["out:verify:x", null]);
  assert.ok(!fake.rec.labels.includes("verify:y"), "the rest of a dropped item's chain does not run");
}
{
  // No barrier: item 0's second stage starts before item 1's first stage finishes.
  const order: string[] = [];
  let release!: () => void;
  const gated = new Promise<void>((r) => { release = r; });
  const fake = harness(undefined, {
    async agent(spec) {
      order.push(`start:${spec.label}`);
      if (spec.label === "s1:1") await gated;
      if (spec.label === "s2:0") release();
      order.push(`end:${spec.label}`);
      return spec.label;
    },
  });
  await run(`${META}
    return await pipeline([0, 1], (i) => agent('a', { label: 's1:' + i }), (v, i) => agent('b', { label: 's2:' + i }))`, { fake }).promise;
  assert.ok(order.indexOf("start:s2:0") < order.indexOf("end:s1:1"), "pipeline has no barrier between stages");
}

// ---- args, log, and an explicit per-agent phase ----
{
  const { promise, rec } = run(`${META}
      log('starting ' + args.what)
      console.log('a', { b: 1 })
      phase('One')
      await agent('a', { label: 'a' })
      await agent('b', { label: 'b', phase: 'Two' })
    `, { args: { what: "things" } });
  await promise;
  assert.deepEqual(rec.logs, ["starting things", 'a {"b":1}']);
  assert.deepEqual(rec.phases, ["One", "Two"], "opts.phase overrides the cursor");
}

// ---- args and agent results arrive as the realm's own objects ----
{
  const fake = harness(() => ({ k: [1, 2] }));
  const { result } = await run(`${META}
    const r = await agent('x')
    return { a: args instanceof Object, r: r instanceof Object, arr: r.k instanceof Array, al: Array.isArray(args.l) }`,
    { args: { l: [1] }, fake }).promise;
  assert.deepEqual(result, { a: true, r: true, arr: true, al: true });
}

// ---- budget: v1 shape (output tokens) plus the v2 meters ----
{
  const fake = harness();
  fake.budgets.tokens = 100;
  fake.hooks.agent = async () => { fake.usage.tokens += 40; fake.usage.agents += 1; return "ok"; };
  const { result } = await run(`${META}
      const out = []
      while (budget.total && budget.remaining() > 30) out.push(await agent('go', { label: 'a' + out.length }))
      return { n: out.length, remaining: budget.remaining(), total: budget.total, spent: budget.spent(),
               tokens: [budget.tokens.total, budget.tokens.spent(), budget.tokens.remaining()],
               agents: [budget.agents.total, budget.agents.spent()] }
    `, { fake }).promise;
  assert.deepEqual(result, { n: 2, remaining: 20, total: 100, spent: 80, tokens: [100, 80, 20], agents: [null, 2] });
}
{
  const fake = harness();
  fake.budgets.costUsd = 1.5;
  fake.usage.costUsd = 0.25;
  const { result } = await run(`${META}\nreturn { total: budget.total, unlimited: budget.remaining(), cost: budget.costUsd.remaining(), costTotal: budget.costUsd.total, a: budget.agents.remaining() }`, { fake }).promise;
  assert.deepEqual(result, { total: null, unlimited: UNLIMITED, cost: 1.25, costTotal: 1.5, a: UNLIMITED },
    "no target: total is null and remaining() is a large finite number (JSON-safe), not Infinity");
  assert.ok(Number.isFinite(UNLIMITED));
}

// ---- the clock is not readable ----
for (const expr of ["Date.now()", "new Date()", "Math.random()", "Date()", "new Date().getTime()", "(new Date(0)).constructor.now()"]) {
  await assert.rejects(() => run(`${META}\nreturn ${expr}`).promise, isScriptError(/unreplayable/), `${expr} must be refused`);
}
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
  isScriptError(/past the cap/),
  "too many items is an error, not a silent truncation",
);
await assert.rejects(
  () => run(`${META}\nawait map(Array.from({length: ${SCRIPT_LIMITS.maxItems + 1}}, () => 1), () => 1)`).promise,
  isScriptError(/past the cap/),
  "map is capped too",
);
await assert.rejects(
  () => run(`${META}\n// ${"x".repeat(SCRIPT_LIMITS.sourceBytes)}`).promise,
  (e: unknown) => e instanceof ScriptError,
  "an oversized source is refused",
);
await assert.rejects(
  () => run(`${META}\nfor (let i = 0; i < ${SCRIPT_LIMITS.maxAgents + 1}; i++) await agent('go', { label: 'a' })`).promise,
  isScriptError(/cap/),
  "the agent cap is a runaway-loop backstop",
);

// ---- a syntax error names itself rather than crashing the run ----
await assert.rejects(() => run(`${META}\nthis is not javascript`).promise, isScriptError(/does not parse/));

// ---- a sync loop is timed out ----
await assert.rejects(() => run(`${META}\nwhile (true) {}`).promise, /timed out/i);

// ---- the return value crosses as JSON ----
{
  const { result } = await run(`${META}\nreturn { a: [1, { b: undefined, c: 2 }], d: new Date(0) }`).promise;
  assert.deepEqual(result, { a: [1, { c: 2 }], d: "1970-01-01T00:00:00.000Z" });
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
}

// ---- cancellation wins, and does not become a list of nulls ----
{
  const fake = harness();
  fake.hooks.agent = async () => { fake.abort.abort(); throw new Error("cancelled underneath"); };
  await assert.rejects(
    () => run(`${META}\nreturn await parallel([() => agent('a', { label: 'a' })])`, { fake }).promise,
    "a cancelled run stops rather than returning nulls",
  );
}
{
  // Abort races every await: a hook that never settles does not wedge the run.
  const fake = harness(undefined, { agent: () => new Promise(() => {}), sleep: () => new Promise(() => {}) });
  for (const call of ["agent('x')", "sleep(5)", "approve('ok?')"]) {
    const f = harness(undefined, { agent: () => new Promise(() => {}), sleep: () => new Promise(() => {}), approve: () => new Promise(() => {}) });
    const p = run(`${META}\nawait ${call}`, { fake: f });
    setTimeout(() => f.abort.abort(), 10);
    await assert.rejects(() => p.promise, isScriptError(/cancelled/), `${call} races the abort`);
  }
  void fake;
  const pre = harness();
  pre.abort.abort();
  await assert.rejects(() => run(`${META}\nawait agent('x')`, { fake: pre }).promise, isScriptError(/cancelled/));
  assert.deepEqual(pre.rec.calls, [], "an already-aborted run calls no hook");
}

// ---- agent options: v2 spec, validation, unknown names ----
{
  const { promise, rec } = run(`${META}
    await agent('p', {
      label: 'L', schema: { type: 'object' }, model: 'm', effort: 'high', isolation: 'worktree', projectId: 'pid',
      agentType: ' reviewer ', profile: 'pr', agent: 'ag', system: 'sys',
      retry: { max: 2, backoffSec: 1, fallbackModel: 'fb' }, tools: { allow: ['Read'], deny: ['Bash'] },
      timeoutSec: 60, onRestart: 'rerun', resumeSession: 'sess', concurrencyKey: 'repo', priority: 3,
    })
    await agent('q', { retry: 1 })`);
  await promise;
  assert.deepEqual(rec.specs[0], {
    prompt: "p", label: "L", title: "L", phase: null, schema: { type: "object" }, model: "m", effort: "high", isolation: "worktree",
    projectId: "pid", agentType: "reviewer", profile: "pr", agent: "ag", system: "sys",
    retry: { max: 2, backoffSec: 1, fallbackModel: "fb" }, tools: { allow: ["Read"], deny: ["Bash"] },
    timeoutSec: 60, onRestart: "rerun", resumeSession: "sess", concurrencyKey: "repo", priority: 3,
  });
  assert.equal(Object.getPrototypeOf(rec.specs[0].schema), Object.prototype, "the spec is host-realm JSON, so it hashes");
  assert.deepEqual(rec.specs[1].retry, { max: 1 }, "retry: n is shorthand for {max: n}");
}
for (const [opts, re] of [
  ["{ lable: 'x' }", /unknown option 'lable'.*Valid options: label, title, phase/],
  ["{ isolation: 'remote' }", /only 'worktree'/],
  ["{ schema: [] }", /JSON Schema object/],
  ["{ onRestart: 'sometimes' }", /onRestart/],
  ["{ timeoutSec: -1 }", /timeoutSec/],
  ["{ retry: { max: 2, nope: 1 } }", /unknown option 'nope'/],
  ["{ retry: {} }", /max/],
  ["{ tools: { allow: 'Read' } }", /array of non-empty strings/],
  ["{ model: 5 }", /string/],
  ["5", /options must be an object/],
] as const) {
  await assert.rejects(() => run(`${META}\nawait agent('x', ${opts})`).promise, isScriptError(re), opts);
}
await assert.rejects(() => run(`${META}\nawait agent('  ')`).promise, isScriptError(/non-empty/));

// ---- map: bounded, ordered, null on throw ----
{
  let live = 0;
  let peak = 0;
  const started: string[] = [];
  const fake = harness(undefined, {
    async agent(spec) {
      started.push(spec.label);
      live += 1; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, spec.label === "i0" ? 20 : 1));
      live -= 1;
      if (spec.label === "i3") throw new Error("bad item");
      return spec.label;
    },
  });
  const { result } = await run(`${META}
    return await map([0,1,2,3,4,5], (x, i) => agent('p' + x, { label: 'i' + x }), { concurrency: 2 })`, { fake }).promise;
  assert.deepEqual(result, ["i0", "i1", "i2", null, "i4", "i5"], "input order, a thrown item is null");
  assert.equal(peak, 2, "concurrency bound honoured");
  assert.ok(fake.rec.logs.some((l) => /bad item/.test(l)));
  assert.deepEqual(started.slice(0, 2), ["i0", "i1"], "items start in input order");
  assert.deepEqual([...started].sort(), ["i0", "i1", "i2", "i3", "i4", "i5"]);

  const f2 = harness();
  const { result: r2 } = await run(`${META}\nreturn await map([1,2,3,4,5,6,7], (x) => x * 2)`, { fake: f2 }).promise;
  assert.deepEqual(r2, [2, 4, 6, 8, 10, 12, 14], "default concurrency works for plain functions");
  await assert.rejects(() => run(`${META}\nawait map('no', () => 1)`).promise, isScriptError(/expected an array/));
  await assert.rejects(() => run(`${META}\nawait map([1], 5)`).promise, isScriptError(/function/));
  await assert.rejects(() => run(`${META}\nawait map([1], () => 1, { concurrency: 0 })`).promise, isScriptError(/concurrency/));
  await assert.rejects(() => run(`${META}\nawait map([1], () => 1, { threads: 2 })`).promise, isScriptError(/unknown option/));
}

// ---- vote ----
{
  const fake = harness((s) => (s.prompt === "odd" ? "B" : "A"));
  const { result } = await run(`${META}
    return await vote(3, (i) => agent(i === 1 ? 'odd' : 'even', { label: 'v' + i }))`, { fake }).promise;
  assert.deepEqual(result, { winner: "A", winnerIndex: 0, candidates: ["A", "B", "A"], votes: [2, 1, 2] });
}
{
  // Object candidates compare by stable JSON (key order irrelevant); ties go to the first.
  const { result } = await run(`${META}
    const shapes = [{ a: 1, b: 2 }, { b: 2, a: 1 }, { z: 9 }]
    return await vote(3, (i) => shapes[i])`).promise;
  assert.deepEqual((result as { winner: unknown; votes: number[] }).winner, { a: 1, b: 2 });
  assert.deepEqual((result as { votes: number[] }).votes, [2, 2, 1]);
  const { result: tie } = await run(`${META}\nreturn await vote(2, (i) => 'x' + i)`).promise;
  assert.equal((tie as { winner: string }).winner, "x0", "a tie goes to the first");
}
{
  // A failed attempt is a null candidate that never wins.
  const { result } = await run(`${META}
    return await vote(3, async (i) => { if (i < 2) throw new Error('x'); return 'only' })`).promise;
  assert.deepEqual(result, { winner: "only", winnerIndex: 2, candidates: [null, null, "only"], votes: [0, 0, 1] });
  const { result: none } = await run(`${META}\nreturn await vote(2, () => { throw new Error('x') })`).promise;
  assert.deepEqual(none, { winner: null, winnerIndex: null, candidates: [null, null], votes: [0, 0] });
}
{
  // A judge function picks by index or by {index}; its argument is the candidates.
  let seen: unknown;
  const fake = harness();
  const { result } = await run(`${META}
    return await vote(3, (i) => 'c' + i, { judge: async (cands) => { return { index: 2 } } })`, { fake }).promise;
  void seen;
  assert.deepEqual(result, { winner: "c2", winnerIndex: 2, candidates: ["c0", "c1", "c2"], votes: [0, 0, 1] });
  const { result: byNum } = await run(`${META}\nreturn (await vote(2, (i) => 'c' + i, { judge: (c) => c.length - 1 })).winner`).promise;
  assert.equal(byNum, "c1");
  await assert.rejects(() => run(`${META}\nawait vote(2, (i) => i, { judge: () => 9 })`).promise, isScriptError(/judge must answer/));
  // A judge that throws falls back to the majority.
  const f2 = harness();
  const { result: fb } = await run(`${META}\nreturn (await vote(3, (i) => i === 2 ? 'b' : 'a', { judge: () => { throw new Error('judge down') } })).winner`, { fake: f2 }).promise;
  assert.equal(fb, "a");
  assert.ok(f2.rec.logs.some((l) => /judge down/.test(l)));
  // judgePrompt = a built-in judge agent, which sees every candidate.
  const f3 = harness((s) => (s.label === "vote-judge" ? { index: 1 } : `r:${s.label}`));
  const { result: jp } = await run(`${META}
    return await vote(2, (i) => agent('go', { label: 'm' + i }), { judgePrompt: 'Pick the better one.' })`, { fake: f3 }).promise;
  assert.equal((jp as { winner: string }).winner, "out:m1".replace("out", "r"));
  const judgeSpec = f3.rec.specs.find((s) => s.label === "vote-judge")!;
  assert.match(judgeSpec.prompt, /Pick the better one\.[\s\S]*Candidate 0:\nr:m0[\s\S]*Candidate 1:\nr:m1/);
  assert.ok(judgeSpec.schema, "the judge asks for a structured index");
  await assert.rejects(() => run(`${META}\nawait vote(0, () => 1)`).promise, isScriptError(/at least 1/));
  await assert.rejects(() => run(`${META}\nawait vote(2, () => 1, { judge: 5 })`).promise, isScriptError(/function/));
}

// ---- refine ----
{
  const seenFeedback: unknown[] = [];
  const { result } = await run(`${META}
    const fb = []
    const out = await refine(
      (round, feedback) => { fb.push(feedback); return 'draft' + round },
      (cand, round) => ({ ok: round === 2, feedback: 'fix ' + cand }),
      { maxRounds: 5 })
    return { out, fb }`).promise;
  void seenFeedback;
  assert.deepEqual(result, { out: { value: "draft2", rounds: 3, ok: true }, fb: [undefined, "fix draft0", "fix draft1"].map((x) => x ?? null) });
}
{
  const { result } = await run(`${META}\nreturn await refine((r) => r, () => ({ ok: false, feedback: 'no' }))`).promise;
  assert.deepEqual(result, { value: SCRIPT_LIMITS.defaultRounds - 1, rounds: SCRIPT_LIMITS.defaultRounds, ok: false },
    "stops at the default round cap, with the last candidate");
  const { result: bare } = await run(`${META}\nreturn await refine(() => 'x', () => true)`).promise;
  assert.deepEqual(bare, { value: "x", rounds: 1, ok: true }, "a bare boolean verdict is accepted");
  await assert.rejects(() => run(`${META}\nawait refine(() => 1, () => 'fine')`).promise, isScriptError(/\{ok: boolean/));
  await assert.rejects(() => run(`${META}\nawait refine(() => { throw new Error('mk') }, () => true)`).promise, /mk/);
  await assert.rejects(() => run(`${META}\nawait refine(() => 1, () => true, { maxRounds: 0 })`).promise, isScriptError(/maxRounds/));
  // Agents inside refine get deterministic default labels.
  const f = harness();
  await run(`${META}\nawait refine(() => agent('w'), (c) => ({ ok: false }), { maxRounds: 2 })`, { fake: f }).promise;
  assert.deepEqual(f.rec.labels, ["agent-1", "agent-2"]);
}

// ---- route ----
{
  const f = harness();
  const { result } = await run(`${META}
    return await route(() => agent('which?', { label: 'cls' }), {
      'out:cls': (l) => 'matched ' + l,
      default: () => 'fallback',
    })`, { fake: f }).promise;
  assert.equal(result, "matched out:cls");
  const { result: obj } = await run(`${META}
    return await route(async () => ({ label: 'zzz' }), { a: () => 1, default: () => 'dflt' })`).promise;
  assert.equal(obj, "dflt");
  await assert.rejects(
    () => run(`${META}\nawait route(() => 'nope', { alpha: () => 1, beta: () => 2 })`).promise,
    isScriptError(/no branch for "nope".*"alpha", "beta"/),
    "names the labels it has",
  );
  await assert.rejects(() => run(`${META}\nawait route(() => 5, { a: () => 1 })`).promise, isScriptError(/string or \{label\}/));
  await assert.rejects(() => run(`${META}\nawait route(() => 'a', { a: 1 })`).promise, isScriptError(/function/));
  // Only the chosen branch runs.
  const f2 = harness();
  await run(`${META}\nawait route(() => 'a', { a: () => agent('A', { label: 'A' }), b: () => agent('B', { label: 'B' }) })`, { fake: f2 }).promise;
  assert.deepEqual(f2.rec.labels, ["A"]);
}

// ---- race ----
{
  const fake = harness(undefined, {
    async agent(spec) {
      await new Promise((r) => setTimeout(r, spec.label === "slow" ? 40 : 2));
      if (spec.label === "bad") throw new Error("bad lost");
      return spec.label;
    },
  });
  const { result } = await run(`${META}
    return await race([() => agent('s', { label: 'slow' }), () => agent('b', { label: 'bad' }), () => agent('f', { label: 'fast' })])`, { fake }).promise;
  assert.equal(result, "fast", "first FULFILLED wins; a quicker rejection does not");
  await new Promise((r) => setTimeout(r, 60)); // the loser settles later without crashing anything

  await assert.rejects(
    () => run(`${META}\nawait race([() => { throw new Error('first') }, () => Promise.reject(new Error('second'))])`).promise,
    /first/,
    "all rejected => the first error",
  );
  await assert.rejects(() => run(`${META}\nawait race([])`).promise, isScriptError(/at least one/));
  await assert.rejects(() => run(`${META}\nawait race([1])`).promise, isScriptError(/function/));
}

// ---- approve ----
{
  const f = harness();
  const { result } = await run(`${META}
    const a = await approve('ship it?')
    const b = await approve('which?', { options: ['x','y'], timeoutSec: 60 })
    return [a, b]`, { fake: f }).promise;
  assert.deepEqual(result, ["approve", "x"]);
  assert.deepEqual(f.rec.calls, ["approve:ship it?:approve|reject:", "approve:which?:x|y:60"]);
  // null (timeout) comes back as null; the hook's non-string garbage is null too.
  const f2 = harness(undefined, { approve: async () => null });
  const { result: n } = await run(`${META}\nreturn await approve('q', { timeoutSec: 1 })`, { fake: f2 }).promise;
  assert.equal(n, null);
  for (const [call, re] of [
    ["approve('')", /non-empty/],
    ["approve('q', { options: [] })", /options/],
    ["approve('q', { options: ['a','a'] })", /distinct/],
    ["approve('q', { timeoutSec: 0 })", /timeoutSec/],
    ["approve('q', { choices: [] })", /unknown option/],
  ] as const) {
    await assert.rejects(() => run(`${META}\nawait ${call}`).promise, isScriptError(re), call);
  }
}

// ---- sleep / until / waitFor / sh / artifact ----
{
  const f = harness();
  const { result } = await run(`${META}
    await sleep(0)
    await sleep(2.5)
    await until('2030-01-01T09:00:00Z')
    const sig = await waitFor('deploy.done', { timeoutSec: 30 })
    const out = await sh('echo hi', { cwd: 'sub', timeoutSec: 5 })
    await artifact('report.json', { a: [1, 2] })
    await artifact('notes.txt', 'plain')
    return { sig, out }`, { fake: f }).promise;
  assert.deepEqual(result, { sig: { name: "deploy.done", got: true }, out: { exitCode: 0, stdout: "hi\n", stderr: "" } });
  assert.deepEqual(f.rec.calls, [
    "sleep:0", "sleep:2.5", "until:2030-01-01T09:00:00Z", "waitFor:deploy.done:30",
    "sh:echo hi:sub:5", 'artifact:report.json:{"a":[1,2]}', 'artifact:notes.txt:"plain"',
  ]);
  const bad: [string, RegExp][] = [
    ["sleep(-1)", /sleep/], ["sleep(31 * 24 * 3600)", /at most/], ["sleep('1')", /number/], ["sleep()", /required/],
    ["until('tomorrow')", /ISO/], ["until(5)", /ISO/],
    ["waitFor('bad name')", /name/], ["waitFor('x', { timeoutSec: -2 })", /timeoutSec/],
    ["sh('')", /non-empty/], ["sh(5)", /non-empty/], [`sh('x'.repeat(9000))`, /at most 8192/], ["sh('x', { cwd: 5 })", /cwd/],
    ["artifact('../x', 1)", /name/], ["artifact('a b', 1)", /name/], ["artifact('ok')", /required/],
    ["artifact('ok', { f() {} })", /cannot be stored|functions/], ["artifact('ok', () => 1)", /cannot be stored|functions/],
  ];
  for (const [call, re] of bad) {
    const g = harness();
    await assert.rejects(() => run(`${META}\nawait ${call}`, { fake: g }).promise, isScriptError(re), call);
    assert.deepEqual(g.rec.calls, [], `${call} is refused before any hook`);
  }
}

// ---- state ----
{
  const f = harness();
  const { result } = await run(`${META}
    state.set('count', 1)
    state.set('obj.deep', { a: [1, { b: 2 }] })
    return { count: state.get('count'), obj: state.get('obj.deep'), missing: state.get('nope') === undefined,
             inst: state.get('obj.deep') instanceof Object }`, { fake: f }).promise;
  assert.deepEqual(result, { count: 1, obj: { a: [1, { b: 2 }] }, missing: true, inst: true });
  assert.deepEqual(f.rec.state, { count: 1, "obj.deep": { a: [1, { b: 2 }] } });
  assert.equal(Object.getPrototypeOf(f.rec.state["obj.deep"]), Object.prototype, "the hook gets host-realm JSON");
  for (const [call, re] of [
    ["state.set('x', () => 1)", /cannot be stored/],
    ["state.set('x', { f: () => 1 })", /cannot be stored/],
    ["state.set('x', undefined)", /required/],
    ["state.set('a b', 1)", /path/],
    ["state.get(5)", /path/],
  ] as const) {
    await assert.rejects(() => run(`${META}\n${call}`).promise, isScriptError(re), call);
  }
}

// ---- determinism: the same script + args calls hooks in the same order ----
{
  const script = `${META}
    phase('A')
    const r = await parallel([() => agent('1'), () => agent('2'), () => map([3,4,5], (x) => agent('m' + x), { concurrency: 2 })])
    const v = await vote(3, (i) => agent('v' + i))
    await refine((n, fb) => agent('r' + n), (c, n) => ({ ok: n === 1 }))
    state.set('done', true)
    return [r, v]`;
  const calls: string[][] = [];
  for (let i = 0; i < 3; i++) {
    const f = harness(undefined, {
      async agent(spec) {
        // Jittered completion times must not change the order of hook calls.
        await new Promise((r) => setTimeout(r, (spec.prompt.length * 7 + i * 3) % 5));
        f.rec.calls.push(`${spec.label}|${spec.prompt}`);
        return spec.prompt;
      },
    });
    f.rec.calls.length = 0;
    await run(script, { fake: f }).promise;
    calls.push([...f.rec.calls].filter((c) => !c.startsWith("setState")).sort());
  }
  assert.deepEqual(calls[1], calls[0]);
  assert.deepEqual(calls[2], calls[0]);
  // Labels are assigned in call order, independent of timing.
  const labelsOf = async () => {
    const f = harness(undefined, { async agent(spec) { await new Promise((r) => setTimeout(r, Math.random() * 3)); f.rec.specs.push(spec); return spec.prompt; } });
    await run(`${META}\nawait parallel([() => agent('a'), () => agent('b'), () => agent('c')])`, { fake: f }).promise;
    return f.rec.specs.map((s) => `${s.label}=${s.prompt}`).sort();
  };
  assert.deepEqual(await labelsOf(), ["agent-1=a", "agent-2=b", "agent-3=c"]);
  assert.deepEqual(await labelsOf(), ["agent-1=a", "agent-2=b", "agent-3=c"]);
}

// ---- workflow(): parity, one level, shared cap ----
{
  const fake = harness();
  fake.hooks.loadWorkflow = async (ref) => {
    assert.equal(ref, "child");
    return `export const meta = { name: 'child', description: 'c' }
      await agent('first')
      phase('Inner')
      const got = await agent('in:' + args.x, { label: 'kid' })
      let refused = false
      try { await workflow('child') } catch (e) { refused = /one level/.test(e.message) }
      return { got, refused }`;
  };
  const out = await run(`${META}
      const a = await agent('p', { label: 'iso', isolation: 'worktree', agentType: 'reviewer' })
      const nested = await workflow('child', { x: 7 })
      const bad = await parallel([() => agent('q', { isolation: 'remote' })])
      const after = await agent('z')
      return { a, nested, bad, after }`, { fake }).promise;
  assert.equal(fake.rec.specs[0].isolation, "worktree");
  assert.equal(fake.rec.specs[0].agentType, "reviewer");
  assert.deepEqual(out.result, { a: "out:iso", nested: { got: "out:kid", refused: true }, bad: [null], after: "out:agent-4" },
    "nested returns its result; nesting twice and isolation:'remote' are refused");
  assert.equal(fake.rec.prompts[2], "in:7", "the child reads its own args");
  assert.equal(fake.rec.phases[1], "▸ child", "a child agent before any phase() is grouped under its name");
  assert.equal(fake.rec.phases[2], "▸ child · Inner", "and under its name once it enters one");
  assert.equal(fake.rec.labels[3], "agent-4", "the child's agents share the run's counter");
  assert.equal(fake.rec.phases[3], null, "the parent's phase cursor is untouched by the child");

  const noLoad = harness();
  await assert.rejects(() => run(`${META}\nawait workflow('x')`, { fake: noLoad }).promise, isScriptError(/not available/));
  await assert.rejects(() => run(`${META}\nawait workflow(5)`, { fake }).promise, isScriptError(/ref is/));
}

console.log("workflow-sandbox: ok");
