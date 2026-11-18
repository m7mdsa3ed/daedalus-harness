// Self-check for the seed releases that change a built-in's env after the fact:
// OpenCode taken back off the gateway shim (seed 33) and Claude Code's
// OpenTelemetry keys taken back (seed 35). Every call here is awaited — see registry.test.ts,
// whose async tests are not, so a failing assertion there never reports.
// Run: pnpm test:agent-seeds
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { agents as agentsTable, db } from "../src/db/index.js";
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

async function resetAgents(rows: { id: string; env: Record<string, string>; seededVersion: number; personaVia?: "acp-meta" | "air-meta" | "env" | "acp-system-prompt" }[]) {
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

// Seed 38: the runtime's own behaviour switches. The declarations are the
// seed's, a value the user set survives a reseed, and the env the spawn builds
// carries only the ones actually turned — an untouched switch writes nothing,
// which is what leaves the runtime's own default in charge.
await test("seed 38 declares the daedalus behaviour switches and keeps the values a user set", async () => {
  await resetAgents([]);
  await seedAgents();
  const seeded = (await getAgent("daedalus"))!.behavior!;
  const keys = seeded.switches.map((s) => s.key);
  assert.ok(keys.includes("DAEDALUS_AGENT_HOLD_ON_ERROR"), keys.join(","));
  assert.equal(seeded.values, undefined, "a fresh row has nothing turned");

  await resetAgents([{ id: "daedalus", seededVersion: 37, env: {}, behavior: { switches: seeded.switches, values: { DAEDALUS_AGENT_TITLES: false } } } as never]);
  await seedAgents();
  assert.deepEqual((await getAgent("daedalus"))!.behavior!.values, { DAEDALUS_AGENT_TITLES: false }, "the user's switches are theirs");
});

await test("a behaviour switch writes its env only where it was turned", async () => {
  await resetAgents([]);
  await seedAgents();
  const off = await getAgent("daedalus");
  off!.behavior!.values = { DAEDALUS_AGENT_HOLD_ON_ERROR: false };
  const spawn = resolveSpawn(off!, profile, project, "m", undefined, undefined, undefined, [], []);
  assert.equal(spawn.env.DAEDALUS_AGENT_HOLD_ON_ERROR, "0", "off writes the off spelling");
  assert.equal(spawn.env.DAEDALUS_AGENT_TITLES, undefined, "an untouched switch writes nothing");
});

// Seed 40: ACP's own `systemPrompt` as the spawn-instruction door for the two
// runtimes whose adapters advertise it, with the old door kept as the fallback
// — `"air-meta"` is what the bridge falls back to on its own, and codex's
// `{personaPrompt}` key stays in the template so an adapter that does not
// advertise the capability still gets its `developer_instructions`.
await test("seed 40 seeds claude-code and codex on acp-system-prompt, and only those two", async () => {
  await resetAgents([]);
  await seedAgents();
  assert.equal((await getAgent("claude-code"))!.personaVia, "acp-system-prompt");
  assert.equal((await getAgent("codex"))!.personaVia, "acp-system-prompt");
  assert.equal((await getAgent("opencode"))!.personaVia, "env", "opencode has no adapter advertising it");
  assert.equal((await getAgent("daedalus"))!.personaVia, "air-meta", "the daedalus agent keeps AIR's key");
  // The env fallback is declared by the template, not by the door's name.
  assert.match((await getAgent("codex"))!.env.CODEX_CONFIG ?? "", /"developer_instructions":"\{personaPrompt\}"/);
  assert.ok(
    !Object.values((await getAgent("claude-code"))!.env).some((v) => v.includes("{personaPrompt}") || v.includes("{personaFile}")),
    "claude-code's env names no persona placeholder, so its fallback is air-meta",
  );
});

await test("seed 40 moves the seeded doors forward and leaves any other door alone", async () => {
  await resetAgents([
    { id: "claude-code", seededVersion: 39, env: { MY_OWN: "keep" }, personaVia: "air-meta" },
    { id: "codex", seededVersion: 39, env: {}, personaVia: "env" },
  ]);
  await seedAgents();
  assert.equal((await getAgent("claude-code"))!.personaVia, "acp-system-prompt", "air-meta was the seeded default");
  assert.equal((await getAgent("claude-code"))!.env.MY_OWN, "keep", "env is the user's");
  assert.equal((await getAgent("codex"))!.personaVia, "acp-system-prompt", "env was the seeded default");

  await resetAgents([
    { id: "claude-code", seededVersion: 27, env: {}, personaVia: "acp-meta" },
    { id: "codex", seededVersion: 27, env: {} },
  ]);
  await seedAgents();
  assert.equal((await getAgent("claude-code"))!.personaVia, "acp-system-prompt", "the pre-28 default moves too");
  assert.equal((await getAgent("codex"))!.personaVia, "acp-system-prompt", "a row with no door gets the new one");

  await resetAgents([
    { id: "claude-code", seededVersion: 39, env: {}, personaVia: "env" },
    { id: "codex", seededVersion: 39, env: {}, personaVia: "air-meta" },
  ]);
  await seedAgents();
  assert.equal((await getAgent("claude-code"))!.personaVia, "env", "a door that was never the seed's stays");
  assert.equal((await getAgent("codex"))!.personaVia, "air-meta", "a door that was never the seed's stays");
});

// Seed 41: Claude Code's subagent launcher goes off beside `Workflow` when the
// `agents` server is linked. A row seeded at 20 already has `builtinTools`, so
// the column-level backfill never reaches it — the key is added inside it.
await test("seed 41 adds the subagent launcher to a claude-code row's built-ins and keeps a user's own list", async () => {
  const seeded20 = { via: "acp-meta" as const, tools: { webSearch: ["WebSearch", "WebFetch"], workflow: ["Workflow"] } };
  await resetAgents([{ id: "claude-code", seededVersion: 40, env: {}, builtinTools: seeded20 } as never]);
  await seedAgents();
  const tools = (await getAgent("claude-code"))!.builtinTools!.tools;
  assert.deepEqual(tools.subagent, ["Agent", "Task"]);
  assert.deepEqual(tools.workflow, ["Workflow"], "the rest of the row is untouched");

  const mine = { ...seeded20, tools: { ...seeded20.tools, subagent: [] as string[] } };
  await resetAgents([{ id: "claude-code", seededVersion: 40, env: {}, builtinTools: mine } as never]);
  await seedAgents();
  assert.deepEqual((await getAgent("claude-code"))!.builtinTools!.tools.subagent, [], "a list the user wrote is theirs");
});

console.log(`agent-seeds: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
