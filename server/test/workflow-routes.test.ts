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
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", fileURLToPath(new URL("../src/workflows/mcp.ts", import.meta.url))],
    env: { ...(process.env as Record<string, string>), WORKFLOW_URL: `http://127.0.0.1:${port}/wf/k/s` },
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

test("the workflow MCP server registers every v2 tool with its input fields", async () => {
  await withServer(async (client) => {
    const { tools } = await client.listTools();
    const by = new Map(tools.map((t) => [t.name, t]));
    const expected: Record<string, string[]> = {
      run_workflow: ["definition", "inputs", "budgets", "priority", "concurrencyKey", "onRestart", "waitSec"],
      run_script: ["script", "name", "resumeFromRunId", "args", "budgets", "tokenBudget", "priority", "concurrencyKey", "onRestart", "waitSec"],
      list_workflows: [],
      save_workflow: ["runId", "script", "scope"],
      delete_workflow: ["name", "scope"],
      wait_workflow: ["runId", "timeoutSec"],
      workflow_status: ["runId"],
      list_runs: ["limit"],
      cancel_workflow: ["runId"],
      pause_workflow: ["runId"],
      resume_workflow: ["runId"],
      signal_workflow: ["runId", "name", "value"],
    };
    assert.deepEqual([...by.keys()].sort(), Object.keys(expected).sort());
    for (const [name, fields] of Object.entries(expected)) {
      const props = Object.keys((by.get(name)!.inputSchema as { properties?: object }).properties ?? {});
      assert.deepEqual(props.sort(), [...fields].sort(), name);
    }
    // The manual documents the dialect it validates.
    const script = by.get("run_script")!.description ?? "";
    for (const g of ["agent", "parallel", "pipeline", "phase", "log", "budget", "workflow", "map", "vote", "refine", "route", "race", "approve", "sleep", "until", "waitFor", "sh", "artifact", "state"]) {
      assert.ok(script.includes(g), `run_script manual mentions ${g}`);
    }
    for (const o of ["resumeSession", "concurrencyKey", "fallbackModel", "judgePrompt", "maxRounds", "onRestart"]) {
      assert.ok(script.includes(o), `run_script manual mentions ${o}`);
    }
    const def = by.get("run_workflow")!.description ?? "";
    for (const f of ["forEach", "when", "retry", "isolation", "agentType", "timeoutSec", "{{inputs.NAME}}", "{{index}}"]) {
      assert.ok(def.includes(f), `run_workflow manual mentions ${f}`);
    }
  });
});

test("the agent has no tool that answers an approval, and the manual says so", async () => {
  await withServer(async (client, hits) => {
    const { tools } = await client.listTools();
    assert.equal(tools.some((t) => /approv/i.test(t.name)), false, "no approval tool");
    const r = await client.callTool({ name: "answer_approval", arguments: { runId: "r", gateKey: "gate:0", choice: "approve" } }).catch(() => ({ isError: true }));
    assert.equal(r.isError, true);
    assert.equal(hits.length, 0, "nothing reached the loopback");
    const manual = `${by(tools, "run_script")}\n${by(tools, "run_workflow")}`;
    assert.match(manual, /answered by the user in the app only/);
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
    await client.callTool({ name: "run_script", arguments: { script: "s", tokenBudget: 99, budgets: { agents: 3 } } });
    assert.deepEqual(hits.at(-1), {
      method: "POST",
      url: "/wf/k/s/scripts?wait=0",
      body: { budgets: { tokens: 99, agents: 3 }, script: "s" },
    });
    await client.callTool({ name: "run_script", arguments: { name: "saved", budgets: { tokens: 5 }, tokenBudget: 99 } });
    assert.equal((hits.at(-1)!.body as { budgets: { tokens: number } }).budgets.tokens, 5, "explicit budgets.tokens wins over the alias");
    await client.callTool({ name: "wait_workflow", arguments: { runId: "a b" } });
    assert.equal(hits.at(-1)!.url, "/wf/k/s/runs/a%20b?wait=45");
    await client.callTool({ name: "wait_workflow", arguments: { runId: "r", timeoutSec: 55 } });
    assert.equal(hits.at(-1)!.url, "/wf/k/s/runs/r?wait=55");
    await client.callTool({ name: "signal_workflow", arguments: { runId: "r", name: "go" } });
    assert.deepEqual(hits.at(-1), { method: "POST", url: "/wf/k/s/runs/r/signal", body: { name: "go", value: null } });
    await client.callTool({ name: "delete_workflow", arguments: { name: "x y", scope: "personal" } });
    assert.deepEqual(hits.at(-1), { method: "DELETE", url: "/wf/k/s/saved/x%20y?scope=personal", body: null });
    await client.callTool({ name: "list_runs", arguments: {} });
    assert.equal(hits.at(-1)!.url, "/wf/k/s/runs?limit=20");
    await client.callTool({ name: "pause_workflow", arguments: { runId: "r" } });
    assert.equal(hits.at(-1)!.url, "/wf/k/s/runs/r/pause");
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
