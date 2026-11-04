// Self-check for the workflow HTTP/MCP surface, with no database:
//   - the zod body schemas of workflows/route-schemas.ts (what routes.ts validates);
//   - the `workflow` MCP server (workflows/mcp.ts) spawned over stdio against a fake
//     loopback: tool names and input fields, the v1 aliases, and the request each tool makes.
// Run: DAEDALUS_DATA_DIR=/tmp/x pnpm exec tsx test/workflow-routes.test.ts
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ApproveBody,
  AskBody,
  LimitQuery,
  RunBody,
  RunSavedBody,
  SaveBody,
  SaveSourceBody,
  ScopeQuery,
  ScriptBody,
  SignalBody,
} from "../src/workflows/route-schemas.js";

let passed = 0;
const failures: string[] = [];
const queue: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  queue.push({ name, fn });
}

// ---- schemas ---------------------------------------------------------------

test("RunBody takes a definition and the v2 flow fields", () => {
  const r = RunBody.parse({
    definition: { name: "w", steps: [] },
    inputs: { a: 1 },
    budgets: { tokens: 1000, costUsd: 2.5, agents: 10, wallSec: 60 },
    priority: 5,
    concurrencyKey: "repo",
    onRestart: "rerun",
  });
  assert.equal(r.budgets?.tokens, 1000);
  assert.equal(RunBody.safeParse({ inputs: {} }).success, false, "a definition is required");
  assert.equal(RunBody.safeParse({ definition: {}, priority: 101 }).success, false);
  assert.equal(RunBody.safeParse({ definition: {}, onRestart: "later" }).success, false);
  assert.equal(RunBody.safeParse({ definition: {}, budgets: { tokens: -1 } }).success, false);
});

test("ScriptBody keeps tokenBudget as an alias and validates the rest", () => {
  const r = ScriptBody.parse({ script: "x", tokenBudget: 500, args: { q: 1 }, priority: -3 });
  assert.equal(r.tokenBudget, 500);
  assert.equal(ScriptBody.safeParse({ tokenBudget: 0 }).success, false);
  assert.equal(ScriptBody.safeParse({ name: "" }).success, false);
  assert.equal(ScriptBody.safeParse({ resumeFromRunId: "abc" }).success, true);
});

test("SaveBody needs exactly one of runId / script and defaults the scope", () => {
  assert.equal(SaveBody.parse({ runId: "r" }).scope, "project");
  assert.equal(SaveBody.safeParse({}).success, false);
  assert.equal(SaveBody.safeParse({ runId: "r", script: "s" }).success, false);
  assert.equal(SaveBody.safeParse({ script: "s", scope: "personal" }).success, true);
  assert.equal(SaveBody.safeParse({ script: "s", scope: "team" }).success, false);
});

test("SaveSourceBody / RunSavedBody", () => {
  assert.equal(SaveSourceBody.parse({ source: "s" }).scope, "project");
  assert.equal(SaveSourceBody.safeParse({ source: "" }).success, false);
  assert.equal(RunSavedBody.safeParse({ name: "audit", args: { a: 1 }, budgets: { agents: 3 } }).success, true);
  assert.equal(RunSavedBody.safeParse({ args: {} }).success, false);
});

test("SignalBody names follow the sandbox's waitFor rule", () => {
  assert.equal(SignalBody.safeParse({ name: "go.now-1_x", value: { a: 1 } }).success, true);
  assert.equal(SignalBody.safeParse({ name: "no spaces" }).success, false);
  assert.equal(SignalBody.safeParse({ name: "x".repeat(81) }).success, false);
  assert.equal(SignalBody.safeParse({}).success, false);
});

test("ApproveBody and AskBody", () => {
  assert.equal(ApproveBody.safeParse({ gateKey: "gate:0", choice: "approve" }).success, true);
  assert.equal(ApproveBody.safeParse({ gateKey: "gate:0" }).success, false);
  assert.equal(AskBody.safeParse({ prompt: "hi", description: "d" }).success, true);
  assert.equal(AskBody.safeParse({ prompt: "" }).success, false);
});

test("query helpers fall back instead of throwing", () => {
  assert.equal(LimitQuery.parse(undefined), 50);
  assert.equal(LimitQuery.parse("20"), 20);
  assert.equal(LimitQuery.parse("9999"), 50);
  assert.equal(ScopeQuery.parse("personal"), "personal");
  assert.equal(ScopeQuery.parse("nonsense"), undefined);
});

// ---- the MCP server over stdio -----------------------------------------------

interface Hit {
  method: string;
  url: string;
  body: unknown;
}

async function withServer<T>(fn: (client: Client, hits: Hit[]) => Promise<T>): Promise<T> {
  const hits: Hit[] = [];
  const http = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      hits.push({ method: req.method ?? "", url: req.url ?? "", body: text ? JSON.parse(text) : null });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "run-1", status: "running" }));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  /* The one `agents` server: `agent` and its four companions, with the workflow
     shapes on because this thread's runtime has no engine of its own. */
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", fileURLToPath(new URL("../src/agents-mcp.ts", import.meta.url))],
    env: {
      ...(process.env as Record<string, string>),
      AGENTS_URL: `http://127.0.0.1:${port}/wf/k/s`,
      AGENTS_WORKFLOWS: "1",
      AGENTS_ROLES: JSON.stringify([{ id: "small", label: "Small", description: "cheap", model: "m-small" }]),
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  try {
    return await fn(client, hits);
  } finally {
    await client.close().catch(() => {});
    http.close();
  }
}

const text = (r: object) => (((r as { content?: { text: string }[] }).content ?? [])[0]?.text ?? "");

test("one `agent` server carries every way of handing work on", async () => {
  await withServer(async (client) => {
    const { tools } = await client.listTools();
    const by = new Map(tools.map((t) => [t.name, t]));
    const expected: Record<string, string[]> = {
      agent: [
        "prompt",
        "description",
        "agent",
        "profile",
        "model",
        "effort",
        "projectId",
        "timeoutSec",
        "waitSec",
        "role",
        "steps",
        "phases",
        "script",
        "name",
        "args",
        "budgets",
        "maxParallel",
        "priority",
        "concurrencyKey",
        "onRestart",
        "totalTimeoutSec",
      ],
      agent_status: ["id", "waitSec"],
      agent_message: ["id", "prompt", "waitSec"],
      agent_control: ["id", "action", "name", "value"],
      agent_list: ["runs"],
      list_workflows: [],
      save_workflow: ["runId", "script", "scope"],
      delete_workflow: ["name", "scope"],
    };
    assert.deepEqual([...by.keys()].sort(), Object.keys(expected).sort());
    for (const [name, fields] of Object.entries(expected)) {
      const props = Object.keys((by.get(name)!.inputSchema as { properties?: object }).properties ?? {});
      assert.deepEqual(props.sort(), [...fields].sort(), name);
    }
    // Both dialects are documented where the model reads them, with the option
    // names `sandbox.ts` validates, and the rule for which to reach for.
    const manual = by.get("agent")!.description ?? "";
    for (const g of ["parallel", "pipeline", "phase", "budget", "map", "vote", "refine", "route", "race", "approve", "sleep", "until", "waitFor", "sh", "artifact", "state"]) {
      assert.ok(manual.includes(g), `the manual mentions ${g}`);
    }
    for (const o of ["resumeSession", "concurrencyKey", "fallbackModel", "judgePrompt", "maxRounds", "onRestart", "forEach", "when", "isolation", "agentType"]) {
      assert.ok(manual.includes(o), `the manual mentions ${o}`);
    }
    assert.match(manual, /WHICH SHAPE/);
    // The roles this thread names are advertised and resolved here.
    assert.match(manual, /`small` \(Small — cheap\)/);
  });
});

test("the workflow shapes are not advertised where the runtime has its own engine", async () => {
  const { tools } = await stdioTools({ AGENTS_WORKFLOWS: "" });
  const agent = tools.find((t) => t.name === "agent")!;
  const props = Object.keys((agent.inputSchema as { properties?: object }).properties ?? {});
  for (const field of ["steps", "phases", "script", "name", "args", "budgets", "maxParallel", "priority", "concurrencyKey", "onRestart", "totalTimeoutSec"]) {
    assert.ok(!props.includes(field), `${field} is not offered`);
  }
  assert.deepEqual(tools.map((t) => t.name).filter((n) => n.endsWith("_workflow")), []);
  const list = tools.find((t) => t.name === "agent_list")!;
  /* `runs` stays: subagents and asks are runs on every runtime, and their ids are what it finds. */
  assert.deepEqual(Object.keys((list.inputSchema as { properties?: object }).properties ?? {}), ["runs"]);
  const control = tools.find((t) => t.name === "agent_control")!;
  const controlProps = Object.keys((control.inputSchema as { properties?: object }).properties ?? {});
  assert.ok(!controlProps.includes("name") && !controlProps.includes("value"));
});

/** The server's tools under a chosen env, over a loopback nobody calls. */
async function stdioTools(env: Record<string, string>): Promise<{ tools: { name: string; description?: string; inputSchema: unknown }[] }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", fileURLToPath(new URL("../src/agents-mcp.ts", import.meta.url))],
    env: { ...(process.env as Record<string, string>), AGENTS_URL: "http://127.0.0.1:9/wf/k/s", ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  try {
    return (await client.listTools()) as never;
  } finally {
    await client.close().catch(() => {});
  }
}

test("the agent has no tool that answers an approval, and the manual says so", async () => {
  await withServer(async (client, hits) => {
    const { tools } = await client.listTools();
    assert.equal(tools.some((t) => /approv/i.test(t.name)), false, "no approval tool");
    const r = await client.callTool({ name: "answer_approval", arguments: { runId: "r", gateKey: "gate:0", choice: "approve" } }).catch(() => ({ isError: true }));
    assert.equal(r.isError, true);
    assert.equal(hits.length, 0, "nothing reached the loopback");
    assert.match(by(tools, "agent"), /answered by the user in the app only/);
  });
});

function by(tools: { name: string; description?: string }[], name: string): string {
  return tools.find((t) => t.name === name)?.description ?? "";
}

test("the loopback family has no approval route; the bearer-gated one is the only door", async () => {
  const { Hono } = await import("hono");
  const { workflowRoutes } = await import("../src/workflows/routes.js");
  const answered: string[] = [];
  const engine = {
    resolveCaller: () => ({ id: "s" }),
    statusFor: async () => ({ id: "r", status: "running", gates: [{ key: "gate:0", kind: "approval", status: "waiting", options: ["approve", "reject"] }] }),
    answerApproval: async (_p: string, _r: string, key: string) => (answered.push(key), true),
  };
  const sessions = { get: () => ({ id: "s", deletedAt: null }) };
  const app = new Hono();
  workflowRoutes(app, { engine, sessions } as never);
  const post = (url: string) =>
    app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gateKey: "gate:0", choice: "approve" }) });
  assert.equal((await post("/wf/k/s/runs/r/approve")).status, 404, "the agent's family cannot approve");
  assert.deepEqual(answered, []);
  assert.equal((await post("/api/sessions/s/workflows/r/approve")).status, 200);
  assert.deepEqual(answered, ["gate:0"]);
});

test("tools make the loopback calls the routes expect", async () => {
  await withServer(async (client, hits) => {
    /* One prompt with no pair is a subagent on the caller's own model, and it
       waits the default budget — verbatim what `ask_agent` did, because a
       one-step errand is the shape that answers soonest. */
    await client.callTool({ name: "agent", arguments: { prompt: "audit", description: "Audit it" } });
    assert.deepEqual(hits.at(-1), {
      method: "POST",
      url: "/wf/k/s/steps?wait=45",
      body: { prompt: "audit", description: "Audit it" },
    });
    /* Naming a pair is an ask — the same route, the pair carried through. */
    await client.callTool({ name: "agent", arguments: { prompt: "look", agent: "codex", profile: "openai" } });
    assert.equal(hits.at(-1)!.url, "/wf/k/s/steps?wait=45");
    assert.deepEqual((hits.at(-1)!.body as Record<string, unknown>).agent, "codex");
    /* `waitSec` is the only waiting model. */
    await client.callTool({ name: "agent", arguments: { prompt: "x", waitSec: 55 } });
    assert.equal(hits.at(-1)!.url, "/wf/k/s/steps?wait=55");
    /* A script and a saved workflow are `/scripts`; a graph is `/runs`, with
       the top-level pair as its steps' default. */
    await client.callTool({ name: "agent", arguments: { script: "s" } });
    assert.deepEqual(hits.at(-1), { method: "POST", url: "/wf/k/s/scripts?wait=0", body: { script: "s" } });
    await client.callTool({ name: "agent", arguments: { name: "saved", args: { a: 1 } } });
    assert.deepEqual((hits.at(-1)!.body as Record<string, unknown>), { name: "saved", args: { a: 1 } });
    await client.callTool({
      name: "agent",
      arguments: { steps: [{ name: "one", prompt: "p" }], agent: "codex", model: "m" },
    });
    const def = (hits.at(-1)!.body as { definition: { steps: Record<string, unknown>[] } }).definition;
    assert.equal(def.steps[0]!.agent, "codex", "the top-level pair is the default for every step");
    assert.equal(def.steps[0]!.model, "m");
    await client.callTool({ name: "agent_status", arguments: { id: "a b" } });
    assert.equal(hits.at(-1)!.url, "/wf/k/s/runs/a%20b");
    await client.callTool({ name: "agent_status", arguments: { id: "r", waitSec: 55 } });
    assert.equal(hits.at(-1)!.url, "/wf/k/s/runs/r?wait=55");
    await client.callTool({ name: "agent_message", arguments: { id: "r", prompt: "more" } });
    assert.equal(hits.at(-1)!.url, "/wf/k/s/runs/r/continue?wait=45");
    await client.callTool({ name: "agent_control", arguments: { id: "r", action: "signal", name: "go" } });
    assert.deepEqual(hits.at(-1), { method: "POST", url: "/wf/k/s/runs/r/signal", body: { name: "go", value: null } });
    await client.callTool({ name: "agent_control", arguments: { id: "r", action: "pause" } });
    assert.equal(hits.at(-1)!.url, "/wf/k/s/runs/r/pause");
    await client.callTool({ name: "delete_workflow", arguments: { name: "x y", scope: "personal" } });
    assert.deepEqual(hits.at(-1), { method: "DELETE", url: "/wf/k/s/saved/x%20y?scope=personal", body: null });
    /* `runs` asks for both halves, and they are issued together. */
    await client.callTool({ name: "agent_list", arguments: { runs: true } });
    const listed = hits.slice(-2).map((h) => h.url);
    assert.deepEqual(listed.sort(), ["/wf/k/s/agents", "/wf/k/s/runs?limit=20"]);
  });
});

test("a role is resolved here when it exists and named when it does not", async () => {
  await withServer(async (client, hits) => {
    await client.callTool({ name: "agent", arguments: { prompt: "x", role: "small" } });
    assert.equal((hits.at(-1)!.body as { model?: string }).model, "m-small");
    const before = hits.length;
    const bad = await client.callTool({ name: "agent", arguments: { prompt: "x", role: "nope" } });
    assert.equal(bad.isError, true);
    assert.match(text(bad), /Known roles: small/);
    assert.equal(hits.length, before, "an unknown role never reaches the loopback");
    /* A role on ANOTHER pair is the user's question, not a translation. */
    const crossed = await client.callTool({ name: "agent", arguments: { prompt: "x", role: "small", agent: "codex", profile: "openai" } });
    assert.equal(crossed.isError, true);
    assert.match(text(crossed), /cannot cross to another pair/);
  });
});

test("exactly one shape is enforced in words the model can act on", async () => {
  await withServer(async (client, hits) => {
    const before = hits.length;
    for (const args of [{}, { prompt: "a", script: "b" }, { args: { a: 1 } }]) {
      const r = await client.callTool({ name: "agent", arguments: args });
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(text(r), /give exactly one of|goes with/);
    }
    assert.equal(hits.length, before, "a bad shape never starts anything");
  });
});

test("a one-step workflow keeps its whole view; only an ask or a subagent is answered as its step", async () => {
  /* The loopback is faked per call, so the run's `kind` is what we hand back. */
  const shaped = (kind: string) => ({
    id: "r",
    status: "completed",
    steps: [{ sessionId: "child", output: "the answer", error: null, status: "completed" }],
    result: { summary: "whole" },
    gates: [],
    usage: { tokens: 10, costUsd: 0, agents: 1 },
    budgets: { tokens: 100 },
    artifacts: [{ name: "out", relPath: "out.txt", bytes: 3 }],
    kind,
  });
  for (const [kind, whole] of [["workflow", true], ["ask", false], ["subagent", false]] as const) {
    const { content } = await answerOf(shaped(kind));
    const got = JSON.parse(content) as Record<string, unknown>;
    assert.equal("threadId" in got, !whole, `${kind}: flattened=${!whole}`);
    if (whole) {
      assert.deepEqual(got.result, { summary: "whole" }, `${kind}: the result survives`);
      assert.deepEqual(got.budgets, { tokens: 100 });
      assert.equal((got.artifacts as unknown[]).length, 1);
      assert.deepEqual(got.usage, { tokens: 10, costUsd: 0, agents: 1 });
    } else {
      assert.equal(got.output, "the answer");
      assert.equal(got.threadId, "child");
    }
  }
});

/** Call the server's `agent_status` against a loopback answering a fixed run, and
    hand back the text the model would read. */
async function answerOf(run: unknown): Promise<{ content: string }> {
  const http = createServer((req: IncomingMessage, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(run));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", fileURLToPath(new URL("../src/agents-mcp.ts", import.meta.url))],
    env: { ...(process.env as Record<string, string>), AGENTS_URL: `http://127.0.0.1:${port}/wf/k/s`, AGENTS_WORKFLOWS: "1" },
    stderr: "ignore",
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  try {
    return { content: text(await client.callTool({ name: "agent_status", arguments: { id: "r" } })) };
  } finally {
    await client.close().catch(() => {});
    http.close();
  }
}

test("a graph can say everything a definition can: the plan, its inputs, and the limits", async () => {
  await withServer(async (client, hits) => {
    await client.callTool({
      name: "agent",
      arguments: {
        phases: [{ name: "read", steps: [{ name: "a", prompt: "p" }] }],
        args: { topic: "x" },
        budgets: { tokens: 5000, wallSec: 600 },
        maxParallel: 2,
        priority: 3,
        concurrencyKey: "repo",
        onRestart: "rerun",
        totalTimeoutSec: 1800,
        model: "m",
      },
    });
    const body = hits.at(-1)!.body as { definition: Record<string, unknown>; inputs?: unknown };
    assert.equal(hits.at(-1)!.url, "/wf/k/s/runs?wait=0");
    /* `args` is a graph's `inputs` — a parameterised plan used to be refused outright. */
    assert.deepEqual(body.inputs, { topic: "x" });
    assert.deepEqual(body.definition.phases, [{ name: "read", steps: [{ name: "a", prompt: "p", model: "m" }] }]);
    assert.deepEqual(body.definition.budgets, { tokens: 5000, wallSec: 600 });
    assert.equal(body.definition.maxParallel, 2);
    assert.equal(body.definition.priority, 3);
    assert.equal(body.definition.concurrencyKey, "repo");
    assert.equal(body.definition.onRestart, "rerun");
    assert.equal(body.definition.totalTimeoutSec, 1800);
    /* A script and a saved workflow take the same flow fields. */
    await client.callTool({ name: "agent", arguments: { script: "s", budgets: { agents: 4 }, priority: -1 } });
    assert.deepEqual((hits.at(-1)!.body as Record<string, unknown>).budgets, { agents: 4 });
    assert.equal((hits.at(-1)!.body as Record<string, unknown>).priority, -1);
    /* Nothing given means nothing sent — an `undefined` would erase a definition's own. */
    await client.callTool({ name: "agent", arguments: { steps: [{ name: "a", prompt: "p" }] } });
    const bare = (hits.at(-1)!.body as { definition: Record<string, unknown> }).definition;
    for (const key of ["budgets", "priority", "concurrencyKey", "onRestart", "maxParallel", "totalTimeoutSec"]) {
      assert.equal(key in bare, false, `${key} is absent when it was not given`);
    }
  });
});

test("steps and phases are one shape, and a one-step run refuses a workflow's limits", async () => {
  await withServer(async (client, hits) => {
    const before = hits.length;
    const both = await client.callTool({
      name: "agent",
      arguments: { steps: [{ name: "a", prompt: "p" }], phases: [{ name: "x", steps: [{ name: "b", prompt: "q" }] }] },
    });
    assert.equal(both.isError, true);
    assert.match(text(both), /OR `phases`, not both/);
    /* A budget on an errand is refused by name rather than silently dropped. */
    const flow = await client.callTool({ name: "agent", arguments: { prompt: "p", budgets: { tokens: 10 } } });
    assert.equal(flow.isError, true);
    assert.match(text(flow), /budgets.*belong.*workflow/);
    assert.match(text(flow), /timeoutSec/);
    assert.equal(hits.length, before, "a refused shape starts nothing");
  });
});

test("save_workflow refuses neither/both of runId and script before calling out", async () => {
  await withServer(async (client, hits) => {
    const before = hits.length;
    const r = await client.callTool({ name: "save_workflow", arguments: {} });
    assert.equal(r.isError, true);
    assert.match(text(r), /either runId or script/);
    assert.equal(hits.length, before);
  });
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
