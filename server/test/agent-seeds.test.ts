// Self-check for the seed releases that change a built-in's env after the fact:
// OpenCode taken back off the gateway shim (seed 33) and Claude Code's
// OpenTelemetry keys taken back (seed 35). Every call here is awaited — see registry.test.ts,
// whose async tests are not, so a failing assertion there never reports.
// Run: pnpm test:agent-seeds
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { agents as agentsTable, db } from "../src/db/index.js";
import { getAgent, seedAgents } from "../src/registry.js";
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

await test("a fresh install seeds Claude Code with no OpenTelemetry keys", async () => {
  await resetAgents([]);
  await seedAgents();
  const env = (await getAgent("claude-code"))!.env;
  assert.equal(Object.keys(env).filter((key) => key.startsWith("OTEL_") || key === "CLAUDE_CODE_ENABLE_TELEMETRY").length, 0);
});

await test("seed 35 takes the OpenTelemetry keys back, only where they hold the seeded template", async () => {
  await resetAgents([
    {
      id: "claude-code",
      seededVersion: 34,
      env: {
        MY_OWN: "keep me",
        CLAUDE_CODE_ENABLE_TELEMETRY: "{otlpUrl?1}",
        OTEL_TRACES_EXPORTER: "{otlpUrl?otlp}",
        OTEL_EXPORTER_OTLP_ENDPOINT: "{otlpUrl}",
        OTEL_LOG_TOOL_DETAILS: "0",
      },
    },
  ]);
  await seedAgents();
  const env = (await getAgent("claude-code"))!.env;
  assert.equal(env.MY_OWN, "keep me");
  assert.equal(env.OTEL_LOG_TOOL_DETAILS, "0", "a value the user set is theirs");
  for (const key of ["CLAUDE_CODE_ENABLE_TELEMETRY", "OTEL_TRACES_EXPORTER", "OTEL_EXPORTER_OTLP_ENDPOINT"])
    assert.equal(env[key], undefined, `${key} is taken back`);
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
