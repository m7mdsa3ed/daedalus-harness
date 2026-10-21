// Self-check for the seed releases that name how a runtime is *read* rather than
// how it is spawned: which saved file explains its prompt (seed 32), whether it
// exports OpenTelemetry to the harness (seed 34), and OpenCode taken back off the
// gateway shim (seed 33). Every call here is awaited — see registry.test.ts,
// whose async tests are not, so a failing assertion there never reports.
// Run: pnpm test:agent-seeds
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { agents as agentsTable, db } from "../src/db/index.js";
import { configureOtlp, otlpUrlFor } from "../src/otlp.js";
import { getAgent, resolveSpawn, seedAgents } from "../src/registry.js";
import type { Profile } from "../src/profiles.js";
import type { Project } from "../src/projects.js";

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    failures.push(`${name}\n    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}

async function resetAgents(rows: { id: string; env: Record<string, string>; seededVersion: number }[]) {
  await db.delete(agentsTable);
  for (const row of rows) await db.insert(agentsTable).values({ name: row.id, command: row.id, args: [], spawnCategories: null, ...row });
}

const project = { id: "w1", name: "ws", cwd: "/tmp/agent-seeds" } as Project;
const profile = { id: "p1", name: "gw", agents: {}, baseUrl: "https://gw.example/v1", apiKey: "sk", models: [{ id: "m", label: "M", reasoningEfforts: [] }], defaultModel: "m", smallModel: "", logoUrl: "" } as Profile;

await test("a fresh install names the saved file for each runtime, and our own has none", async () => {
  await resetAgents([]);
  await seedAgents();
  assert.equal((await getAgent("claude-code"))?.promptFiles, "claude-jsonl");
  assert.equal((await getAgent("codex"))?.promptFiles, "codex-rollout");
  assert.equal((await getAgent("opencode"))?.promptFiles, "opencode-sqlite");
  assert.equal((await getAgent("daedalus"))?.promptFiles, null, "it measures its own prompt");
});

await test("only Claude Code is marked as exporting OpenTelemetry, in its dialect", async () => {
  await resetAgents([]);
  await seedAgents();
  assert.equal((await getAgent("claude-code"))?.telemetryVia, "claude-otlp");
  for (const id of ["codex", "opencode", "daedalus"]) assert.equal((await getAgent(id))?.telemetryVia, null, id);
});

await test("a row from before the columns gets them and keeps the env it had", async () => {
  await resetAgents([{ id: "claude-code", seededVersion: 31, env: { MY_OWN: "keep me", OTEL_LOG_TOOL_DETAILS: "0" } }]);
  await seedAgents();
  const claude = await getAgent("claude-code");
  assert.equal(claude?.promptFiles, "claude-jsonl");
  assert.equal(claude?.telemetryVia, "claude-otlp");
  assert.equal(claude?.env.MY_OWN, "keep me");
  assert.equal(claude?.env.OTEL_LOG_TOOL_DETAILS, "0", "a value the user set is theirs");
  assert.equal(claude?.env.OTEL_TRACES_EXPORTER, "{otlpUrl?otlp}", "the switches that were absent are added");
});

await test("a thread's spawn points Claude Code's exporter at its own URL and body directory", async () => {
  await resetAgents([]);
  await seedAgents();
  configureOtlp({ port: 4777 });
  const claude = (await getAgent("claude-code"))!;
  const { env } = resolveSpawn(claude, profile, project, "m", "", "thread-1");
  assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, otlpUrlFor("thread-1"));
  assert.match(env.OTEL_EXPORTER_OTLP_ENDPOINT!, /^http:\/\/127\.0\.0\.1:4777\/otlp\/[^/]+\/thread-1$/);
  assert.equal(env.CLAUDE_CODE_ENABLE_TELEMETRY, "1");
  assert.equal(env.OTEL_EXPORTER_OTLP_PROTOCOL, "http/json");
  assert.equal(env.OTEL_TRACES_EXPORTER, "otlp");
  assert.equal(env.OTEL_METRICS_EXPORTER, "none");
  assert.match(env.OTEL_LOG_RAW_API_BODIES!, /^file:.*otlp-bodies\/thread-1$/);
});

await test("with no thread to name (a probe) nothing is exported, so nothing goes to a default collector", async () => {
  await resetAgents([]);
  await seedAgents();
  const claude = (await getAgent("claude-code"))!;
  const { env } = resolveSpawn(claude, profile, project, "m");
  for (const key of ["CLAUDE_CODE_ENABLE_TELEMETRY", "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_TRACES_EXPORTER", "OTEL_LOG_RAW_API_BODIES"])
    assert.equal(env[key], undefined, `${key} prunes away`);
});

await test("seed 33 takes OpenCode back off the gateway shim, only where the template is untouched", async () => {
  const shimmed =
    '{"permission":"allow","instructions":["{personaFile}"],"model":"{baseUrl?daedalus/}{model}","provider":{"daedalus":{"npm":"{baseUrl?@ai-sdk/openai-compatible}","name":"{baseUrl?Daedalus}","options":{"baseURL":"{gatewayUrl}","apiKey":"{apiKey}","includeUsage":true},"models":{"{model}":{"name":"{model}"}}}}}';
  await resetAgents([{ id: "opencode", seededVersion: 32, env: { OPENCODE_CONFIG_CONTENT: shimmed } }]);
  await seedAgents();
  const env = (await getAgent("opencode"))?.env.OPENCODE_CONFIG_CONTENT ?? "";
  assert.ok(env.includes('"baseURL":"{baseUrl}"') && !env.includes("gatewayUrl") && !env.includes("includeUsage"), env);
  // An edited template is the user's.
  const mine = shimmed.replace('"permission":"allow"', '"permission":"ask"');
  await resetAgents([{ id: "opencode", seededVersion: 32, env: { OPENCODE_CONFIG_CONTENT: mine } }]);
  await seedAgents();
  assert.equal((await getAgent("opencode"))?.env.OPENCODE_CONFIG_CONTENT, mine);
});

console.log(`agent-seeds: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
