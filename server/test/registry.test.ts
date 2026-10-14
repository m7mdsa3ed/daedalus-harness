// Self-check for the agent registry: env-template resolution against a profile
// (`resolveSpawn`) and the seed/backfill rules (`seedAgents`).
//
// The two things under test are the ones that have gone wrong in the field:
// an env key nobody filled in, so a gateway chose the model behind it; and a
// seed release resurrecting a built-in the user deleted on purpose.
//
// Runs against a real (temp) database, because seeding is a database rule —
// importing db/index.js migrates whatever DAEDALUS_DATA_DIR points at.
// Run: pnpm test:registry
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { agentOptions as agentOptionsTable, agents as agentsTable, db } from "../src/db/index.js";
import type { Profile } from "../src/profiles.js";
import type { Project } from "../src/projects.js";
import { configureGatewayShim } from "../src/gateway-shim.js";
import { getAgent, isBuiltInAgent, modelRoleDefs, resetAgent, withoutSubagentModelKey, resolveSpawn, seedAgents, updateAgent } from "../src/registry.js";
import type { PersonaSpawn } from "../src/personas.js";
import { checkInstalled, locateCommand, npmPackage } from "../src/agent-status.js";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push(`${name}\n    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}

const project = { id: "w1", name: "ws", cwd: "/tmp/daedalus-registry-test" } as Project;

/** A stored profile: a gateway, a catalog, and a default pick. */
function profileWith(over: Partial<Profile> = {}): Profile {
  return {
    id: "p1",
    name: "gateway",
    agents: { "claude-code": {} },
    baseUrl: "https://gw.example/v1",
    apiKey: "sk-test",
    models: [{ id: "gw/big", label: "Big", reasoningEfforts: [] }],
    defaultModel: "gw/big",
    smallModel: "",
    logoUrl: "",
    ...over,
  };
}

/** The virtual Default profile: no credentials, and above all no models. */
const virtualProfile = profileWith({
  id: "default:claude-code",
  baseUrl: "",
  apiKey: "",
  models: [],
  defaultModel: "",
  virtual: true,
});

const claudeEnv = {
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "{smallModel}",
  ANTHROPIC_SMALL_FAST_MODEL: "{smallModel}",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "{model}",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "{model}",
  ANTHROPIC_DEFAULT_FABLE_MODEL: "{model}",
  ANTHROPIC_API_KEY: "{apiKey}",
  ANTHROPIC_BASE_URL: "{baseUrl}",
  ANTHROPIC_MODEL: "{model}",
};
const claudeAgent = { id: "claude-code", name: "Claude Code", command: "claude-agent-acp", args: [], env: claudeEnv };

/* The seeded shape (seed 6): every key that names a model carries the 1M
   conditional, which `resolveSpawn` fills from the catalog. */
const MODEL = "{model}{longContext?[1m]}";
const SMALL = "{smallModel}{longContext?[1m]}";
const suffixedAgent = {
  ...claudeAgent,
  env: { ...claudeEnv, ANTHROPIC_MODEL: MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL, ANTHROPIC_SMALL_FAST_MODEL: SMALL },
};

/* ── resolveSpawn ───────────────────────────────────────────────────────── */

test("the small-model keys fall back to the session model", () => {
  const { env } = resolveSpawn(claudeAgent, profileWith(), project);
  // Without these two the gateway picks the classifier's model itself, which is
  // the whole failure: an experimental cheap tier flaps and auto mode has no
  // verdict, while ANTHROPIC_MODEL on the same endpoint is healthy.
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "gw/big");
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, "gw/big");
  assert.equal(env.ANTHROPIC_MODEL, "gw/big");
});

test("an explicit smallModel no longer splits the choice — one model everywhere", () => {
  // A profile means "run everything on this model": a stored smallModel is a
  // second id the gateway may not serve, so it does not reach the spawn env.
  const { env } = resolveSpawn(claudeAgent, profileWith({ smallModel: "gw/cheap" }), project);
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "gw/big");
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, "gw/big");
  assert.equal(env.ANTHROPIC_MODEL, "gw/big");
});

test("the session's model, not the profile default, drives both", () => {
  const { env } = resolveSpawn(claudeAgent, profileWith(), project, "gw/other");
  assert.equal(env.ANTHROPIC_MODEL, "gw/other");
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, "gw/other");
});

test("a null smallModel (a row predating the column) falls back", () => {
  const { env } = resolveSpawn(claudeAgent, profileWith({ smallModel: null }), project);
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, "gw/big");
});

test("the Default profile names no model at all", () => {
  const { env } = resolveSpawn(claudeAgent, virtualProfile, project);
  // Every key prunes away: the agent keeps its own credentials, its own model,
  // and — the point here — its own choice of cheap model.
  assert.deepEqual(env, {});
});

test("a helper model resolves through the catalog, or as written on the Default", () => {
  const roles = [{ id: "small", label: "Small", description: "", sortOrder: 0, createdAt: 0, updatedAt: 0 }];
  const helpers = [{ role: "small", model: "haiku" }];
  // A catalog that lacks the id: the helper falls back to the session model.
  assert.equal(modelRoleDefs(claudeAgent, profileWith(), roles, helpers, "gw/big")[0].model, "gw/big");
  // The Default has no catalog — the id came off the agent's own list.
  assert.equal(modelRoleDefs(claudeAgent, virtualProfile, roles, helpers)[0].model, "haiku");
  assert.equal(modelRoleDefs(claudeAgent, virtualProfile, roles, [{ role: "small", model: "" }])[0].model, "");
});

/* ── the 1M conditional ─────────────────────────────────────────────────── */

test("a 1M catalog model gets the [1m] suffix on every key that names it", () => {
  // Claude Code opts into the long-context beta BY THE ID, not by a window
  // number: without the suffix a 1M model quietly runs at 200k.
  const profile = profileWith({
    models: [{ id: "gw/big", label: "Big", contextWindow: 1_000_000, reasoningEfforts: [] }],
  });
  const { env } = resolveSpawn(suffixedAgent, profile, project);
  assert.equal(env.ANTHROPIC_MODEL, "gw/big[1m]");
  // The alias and side-job keys too: they are pinned to the same id, and a
  // session that drops to 200k on plan mode's sonnet switch is the same bug.
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "gw/big[1m]");
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, "gw/big[1m]");
});

test("a smaller window, an uncatalogued model and the Default profile get no suffix", () => {
  const { env: small } = resolveSpawn(suffixedAgent, profileWith(), project);
  assert.equal(small.ANTHROPIC_MODEL, "gw/big"); // catalogued at no window
  // A model the profile does not list has no window to read, so no suffix.
  const { env: unknown } = resolveSpawn(suffixedAgent, profileWith(), project, "gw/other");
  assert.equal(unknown.ANTHROPIC_MODEL, "gw/other");
  // And with no model at all the whole key prunes away, suffix included —
  // `{model}{longContext?[1m]}` must not resolve to a bare "[1m]".
  assert.deepEqual(resolveSpawn(suffixedAgent, virtualProfile, project).env, {});
});

test("an id that already carries [1m] is not given a second one", () => {
  const profile = profileWith({
    models: [{ id: "opus[1m]", label: "Opus 1M", contextWindow: 1_000_000, reasoningEfforts: [] }],
    defaultModel: "opus[1m]",
  });
  assert.equal(resolveSpawn(suffixedAgent, profile, project).env.ANTHROPIC_MODEL, "opus[1m]");
});

test("a user's own value for the key survives resolution", () => {
  const agent = { ...claudeAgent, env: { ...claudeEnv, ANTHROPIC_SMALL_FAST_MODEL: "pinned-by-hand" } };
  const { env } = resolveSpawn(agent, profileWith(), project);
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, "pinned-by-hand");
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "gw/big");
});

test("the alias keys follow the session model", () => {
  // Plan mode upgrades a haiku session to sonnet and `opusplan` switches
  // opus/sonnet across the plan boundary — every alias must land on a model
  // the gateway serves, which is the selected one.
  const { env } = resolveSpawn(claudeAgent, profileWith(), project, "gw/other");
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "gw/other");
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "gw/other");
  assert.equal(env.ANTHROPIC_DEFAULT_FABLE_MODEL, "gw/other");
  // …but a user who pointed an alias at a real gateway tier keeps it.
  const agent = { ...claudeAgent, env: { ...claudeEnv, ANTHROPIC_DEFAULT_SONNET_MODEL: "gw/sonnet" } };
  const { env: pinned } = resolveSpawn(agent, profileWith(), project);
  assert.equal(pinned.ANTHROPIC_DEFAULT_SONNET_MODEL, "gw/sonnet");
  assert.equal(pinned.ANTHROPIC_DEFAULT_OPUS_MODEL, "gw/big");
});

/* ── the persona placeholders ────────────────────────────────────────────── */

/* Codex's shape: the prompt inline, inside a JSON string literal in a JSON
   template. This is the pair of cases the escaping exists for — a persona is
   multi-line prose with quotes in it, and substituted raw it closed the string
   it was sitting in, leaving CODEX_CONFIG unparseable (which `resolveEnvValue`
   then passes through whole, unpruned, to the agent). */
const codexAgent = {
  id: "codex",
  name: "Codex",
  command: "codex-acp",
  args: [],
  env: {
    CODEX_CONFIG: '{"developer_instructions":"{personaPrompt}","model":"{model}"}',
  },
};
/* OpenCode's: `instructions` is a list of file paths, so the template names
   {personaFile} and the caller has written one. */
const opencodeAgent = {
  id: "opencode",
  name: "OpenCode",
  command: "opencode",
  args: ["acp"],
  env: { OPENCODE_CONFIG_CONTENT: '{"instructions":["{personaFile}"],"model":"{model}"}' },
};

const persona = (over: Partial<PersonaSpawn> = {}): PersonaSpawn => ({
  id: "px",
  prompt: "Answer in one line.",
  ...over,
});

test("a persona's prompt reaches codex as valid JSON", () => {
  const { env } = resolveSpawn(codexAgent, profileWith(), project, undefined, undefined, undefined, persona());
  const config = JSON.parse(env.CODEX_CONFIG) as Record<string, string>;
  assert.equal(config.developer_instructions, "Answer in one line.");
});

test("quotes, newlines and backslashes in a prompt do not break the template", () => {
  const prompt = 'Say "no".\nUse a \\ when you must.\tThen stop.';
  const { env } = resolveSpawn(
    codexAgent,
    profileWith(),
    project,
    undefined,
    undefined,
    undefined,
    persona({ prompt }),
  );
  const config = JSON.parse(env.CODEX_CONFIG) as Record<string, string>;
  assert.equal(config.developer_instructions, prompt, "the prompt survives the round trip verbatim");
});

test("no persona prunes the key away rather than sending an empty instruction", async () => {
  const { env } = resolveSpawn(codexAgent, profileWith(), project);
  const config = JSON.parse(env.CODEX_CONFIG) as Record<string, string>;
  assert.equal("developer_instructions" in config, false);
  assert.equal(config.model, "gw/big", "…and the rest of the template is untouched");
});

test("a file-shaped agent gets the path, and an empty list prunes to nothing", async () => {
  const { env } = resolveSpawn(
    opencodeAgent,
    profileWith(),
    project,
    undefined,
    undefined,
    undefined,
    persona({ file: "/tmp/personas/s1.md" }),
  );
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT).instructions, ["/tmp/personas/s1.md"]);
  const { env: bare } = resolveSpawn(opencodeAgent, profileWith(), project);
  assert.equal("instructions" in JSON.parse(bare.OPENCODE_CONFIG_CONTENT), false);
});

test("a persona with no file resolves the path empty even when it has a prompt", async () => {
  // The prompt is the *other* agent's shape; this one only reads a path, and
  // the writer is the caller's job (`resolvePersonaSpawn`).
  const { env } = resolveSpawn(opencodeAgent, profileWith(), project, undefined, undefined, undefined, persona());
  assert.equal("instructions" in JSON.parse(env.OPENCODE_CONFIG_CONTENT), false);
});

/* ── seedAgents ─────────────────────────────────────────────────────────── */

test("seed 27 takes back the seeded subagent-model key, never a user's own", () => {
  // Helper models are the daedalus runtime's alone now (docs/model-roles.md).
  assert.deepEqual(withoutSubagentModelKey({ CLAUDE_CODE_SUBAGENT_MODEL: "{subagentModel}", A: "1" }), { A: "1" });
  assert.deepEqual(withoutSubagentModelKey({ CLAUDE_CODE_SUBAGENT_MODEL: "my-model" }), {
    CLAUDE_CODE_SUBAGENT_MODEL: "my-model",
  });
});

async function resetAgents(rows: { id: string; env: Record<string, string>; seededVersion: number }[]) {
  await db.delete(agentsTable);
  for (const row of rows) {
    await db.insert(agentsTable)
      .values({ name: row.id, command: row.id, args: [], spawnCategories: null, ...row })
      ;
  }
}

test("OpenCode's built-in config bypasses permission prompts", async () => {
  resetAgents([]);
  seedAgents();
  const opencode = await getAgent("opencode");
  assert.equal(JSON.parse(opencode?.env.OPENCODE_CONFIG_CONTENT ?? "{}").permission, "allow");
});

test("OpenCode's endpoint is a provider of its own that declares the thread's model", async () => {
  await resetAgents([]);
  await seedAgents();
  const opencode = (await getAgent("opencode"))!;
  /* OpenCode 2 resolves `provider/<id>` against that provider's catalog; under
     the id `opencode` the catalog was Zen's, and a gateway model fell back to
     a Zen one sent to the gateway. */
  const { env } = resolveSpawn(opencode, profileWith(), project, "gw/big");
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.model, "daedalus/gw/big");
  assert.deepEqual(config.provider, {
    daedalus: {
      npm: "@ai-sdk/openai-compatible",
      name: "Daedalus",
      options: { baseURL: "https://gw.example/v1", apiKey: "sk-test" },
      models: { "gw/big": { name: "gw/big" } },
    },
  });
  assert.equal(Object.keys(env).some((k) => k.startsWith("DAEDALUS_OPENCODE_")), false);
});

test("a profile with no endpoint leaves OpenCode its own provider", async () => {
  await resetAgents([]);
  await seedAgents();
  const opencode = (await getAgent("opencode"))!;
  /* The Default profile: a hollow `opencode` override was a provider with no
     baseURL, and every prompt failed. Nothing but the bypass may remain. */
  const { env } = resolveSpawn(opencode, profileWith({ baseUrl: "", apiKey: "", models: [], defaultModel: "" }), project);
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT), { permission: "allow" });
});

test("OpenCode backfill preserves an explicit permission policy", async () => {
  resetAgents([
    {
      id: "opencode",
      seededVersion: 12,
      env: { OPENCODE_CONFIG_CONTENT: '{"permission":{"bash":"ask"},"model":"{model}"}' },
    },
  ]);
  seedAgents();
  const config = JSON.parse((await getAgent("opencode"))?.env.OPENCODE_CONFIG_CONTENT ?? "{}");
  assert.deepEqual(config.permission, { bash: "ask" });
  assert.equal(config.model, "{model}");
});

test("OpenCode backfill prefixes an unprefixed model field on a stored template", async () => {
  /* Existing installs store the pre-seed-21 template (no `opencode/` prefix);
  re-seeding must rewrite only the seeded unprefixed substring, leaving the
  user's permission policy and surrounding keys alone. */
  resetAgents([
    {
      id: "opencode",
      seededVersion: 20,
      env: {
        OPENCODE_CONFIG_CONTENT:
          '{"permission":"allow","model":"{env:DAEDALUS_OPENCODE_MODEL}","provider":{"opencode":{}}}',
      },
    },
  ]);
  seedAgents();
  const config = JSON.parse((await getAgent("opencode"))?.env.OPENCODE_CONFIG_CONTENT ?? "{}");
  assert.equal(config.model, "opencode/{env:DAEDALUS_OPENCODE_MODEL}");
  assert.equal(config.permission, "allow", "the user's permission policy is preserved");
});

test("seed 30 moves the seeded OpenCode template and drops only its own vars", async () => {
  const seeded21 =
    '{"permission":"allow","instructions":["{personaFile}"],"model":"opencode/{env:DAEDALUS_OPENCODE_MODEL}","provider":{"opencode":{"npm":"@ai-sdk/openai-compatible","name":"OpenCode","options":{"baseURL":"{env:DAEDALUS_OPENCODE_BASE_URL}","apiKey":"{env:DAEDALUS_OPENCODE_API_KEY}"}}}}';
  await resetAgents([
    {
      id: "opencode",
      seededVersion: 21,
      env: {
        OPENCODE_CONFIG_CONTENT: seeded21,
        DAEDALUS_OPENCODE_API_KEY: "{apiKey}",
        DAEDALUS_OPENCODE_MODEL: "{model}",
        DAEDALUS_OPENCODE_BASE_URL: "https://mine.example/v1",
        MY_KEY: "kept",
      },
    },
  ]);
  await seedAgents();
  const opencode = (await getAgent("opencode"))!;
  const [row] = await db.select().from(agentsTable).where(eq(agentsTable.id, "opencode"));
  assert.equal(row.seededVersion, 30);
  assert.equal(JSON.parse(opencode.env.OPENCODE_CONFIG_CONTENT).provider.daedalus.options.baseURL, "{baseUrl}");
  assert.equal("DAEDALUS_OPENCODE_API_KEY" in opencode.env, false);
  assert.equal("DAEDALUS_OPENCODE_MODEL" in opencode.env, false);
  assert.equal(opencode.env.DAEDALUS_OPENCODE_BASE_URL, "https://mine.example/v1", "an edited var is the user's");
  assert.equal(opencode.env.MY_KEY, "kept");
});

test("seed 30 leaves an edited OpenCode template alone", async () => {
  const mine = '{"permission":{"bash":"ask"},"model":"{model}"}';
  await resetAgents([{ id: "opencode", seededVersion: 21, env: { OPENCODE_CONFIG_CONTENT: mine, DAEDALUS_OPENCODE_MODEL: "{model}" } }]);
  await seedAgents();
  const opencode = (await getAgent("opencode"))!;
  assert.equal(opencode.env.OPENCODE_CONFIG_CONTENT, mine);
  assert.equal(opencode.env.DAEDALUS_OPENCODE_MODEL, "{model}", "its vars may still be read by it");
});

test("a fresh install gets the built-ins, pointed at {smallModel}", async () => {
  resetAgents([]);
  seedAgents();
  const claude = await getAgent("claude-code");
  assert.equal(claude?.env.ANTHROPIC_SMALL_FAST_MODEL, SMALL);
  assert.equal(claude?.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, SMALL);
  assert.equal(claude?.env.ANTHROPIC_DEFAULT_SONNET_MODEL, MODEL);
  assert.equal(claude?.env.ANTHROPIC_DEFAULT_OPUS_MODEL, MODEL);
  assert.equal(claude?.env.ANTHROPIC_DEFAULT_FABLE_MODEL, MODEL);
  assert.ok((await getAgent("codex")));
  assert.ok((await getAgent("opencode")));
});

test("the backfill moves a seed-3 row off {model} and keeps the user's edits", async () => {
  resetAgents([
    {
      id: "claude-code",
      seededVersion: 3,
      env: {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "{model}",
        ANTHROPIC_SMALL_FAST_MODEL: "{model}",
        ANTHROPIC_BASE_URL: "{baseUrl}",
        MY_OWN: "keep me",
      },
    },
    { id: "codex", seededVersion: 2, env: {} },
  ]);
  seedAgents();
  const claude = await getAgent("claude-code");
  assert.equal(claude?.env.ANTHROPIC_SMALL_FAST_MODEL, SMALL);
  assert.equal(claude?.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, SMALL);
  // Never a wholesale replacement: what the user put in the template is theirs.
  assert.equal(claude?.env.MY_OWN, "keep me");
  // Seed 8 routes the seeded endpoint through the gateway shim — only the
  // exact seeded value moves.
  assert.equal(claude?.env.ANTHROPIC_BASE_URL, "{gatewayUrl}");
});

test("seed 9 moves Codex's provider base_url onto the shim, only when it is the seeded slot", async () => {
  const seededTemplate = '{"model":"{model}","model_providers":{"daedalus":{"base_url":"{baseUrl}","wire_api":"{baseUrl?responses}"}}}';
  resetAgents([
    { id: "codex", seededVersion: 8, env: { CODEX_CONFIG: seededTemplate } },
    { id: "claude-code", seededVersion: 8, env: {} },
    { id: "opencode", seededVersion: 8, env: {} },
  ]);
  seedAgents();
  const moved = (await getAgent("codex"))?.env.CODEX_CONFIG ?? "";
  assert.ok(moved.includes('"base_url":"{gatewayUrl}"'));
  assert.ok(!moved.includes('"base_url":"{baseUrl}"'));
  // The catalog key rides along for a row that never got it.
  assert.ok(moved.includes("model_catalog_json"));
  // A hand-written URL is the user's.
  resetAgents([{ id: "codex", seededVersion: 8, env: { CODEX_CONFIG: '{"model_providers":{"daedalus":{"base_url":"https://my.gw/v1"}}}' } }]);
  seedAgents();
  assert.ok((await getAgent("codex"))?.env.CODEX_CONFIG.includes('"base_url":"https://my.gw/v1"'));
});

test("a base URL the user wrote by hand is not moved onto the shim", async () => {
  resetAgents([{ id: "claude-code", seededVersion: 7, env: { ANTHROPIC_BASE_URL: "https://my.gw/v1" } }]);
  seedAgents();
  assert.equal((await getAgent("claude-code"))?.env.ANTHROPIC_BASE_URL, "https://my.gw/v1");
});

test("{gatewayUrl} is the profile's endpoint until a shim is up, then the shim", () => {
  const agent = { ...claudeAgent, env: { ...claudeEnv, ANTHROPIC_BASE_URL: "{gatewayUrl}" } };
  assert.equal(resolveSpawn(agent, profileWith(), project).env.ANTHROPIC_BASE_URL, "https://gw.example/v1");
  // The Default profile has no gateway, so the key prunes away either way.
  assert.equal(resolveSpawn(agent, virtualProfile, project).env.ANTHROPIC_BASE_URL, undefined);
  configureGatewayShim({ port: 4321 });
  // Profile-scoped with no thread named (a probe), session-scoped with one —
  // which is what lets the thread's profile change under a running child.
  assert.match(
    resolveSpawn(agent, profileWith(), project).env.ANTHROPIC_BASE_URL ?? "",
    /^http:\/\/127\.0\.0\.1:4321\/gw\/[0-9a-f]{48}\/p\/p1\/claude-code$/,
  );
  assert.match(
    resolveSpawn(agent, profileWith(), project, undefined, undefined, "s1").env.ANTHROPIC_BASE_URL ?? "",
    /^http:\/\/127\.0\.0\.1:4321\/gw\/[0-9a-f]{48}\/s\/s1\/claude-code$/,
  );
  assert.equal(resolveSpawn(agent, virtualProfile, project).env.ANTHROPIC_BASE_URL, undefined);
  // A per-agent override on the profile is still what the shim fronts — the
  // shim resolves it by profile + agent at request time, so nothing to check
  // in the env beyond the pair being named.
});

test("the backfill adds the keys to a row that predates them", async () => {
  resetAgents([{ id: "claude-code", seededVersion: 1, env: { ANTHROPIC_MODEL: "{model}" } }]);
  seedAgents();
  const claude = await getAgent("claude-code");
  assert.equal(claude?.env.ANTHROPIC_SMALL_FAST_MODEL, SMALL);
  // Seed 5's alias keys arrive on the same jump — an install stamped 1 never
  // saw seed 4 on its own — and seed 6's 1M conditional rides along on all of
  // them, which is the only thing that turns the long-context beta on.
  assert.equal(claude?.env.ANTHROPIC_DEFAULT_SONNET_MODEL, MODEL);
  assert.equal(claude?.env.ANTHROPIC_DEFAULT_OPUS_MODEL, MODEL);
  assert.equal(claude?.env.ANTHROPIC_DEFAULT_FABLE_MODEL, MODEL);
});

test("a value that is neither missing nor {model} is left alone", async () => {
  resetAgents([{ id: "claude-code", seededVersion: 3, env: { ANTHROPIC_SMALL_FAST_MODEL: "haiku-x" } }]);
  seedAgents();
  assert.equal((await getAgent("claude-code"))?.env.ANTHROPIC_SMALL_FAST_MODEL, "haiku-x");
});

test("a deleted built-in is not resurrected by a later backfill", async () => {
  // claude-code was introduced in seed 1 and this install is past that, so its
  // absence is a deletion — not a fresh install owed the agent. Bumping `since`
  // to 4 for the backfill must not read as "never offered".
  resetAgents([
    { id: "codex", seededVersion: 2, env: {} },
    { id: "opencode", seededVersion: 1, env: {} },
  ]);
  seedAgents();
  assert.equal((await getAgent("claude-code")), undefined);
});

test("a genuinely new agent still reaches an install that has rows", async () => {
  // codex was introduced in seed 2; an install seeded only to 1 has never been
  // offered it, so it must arrive.
  resetAgents([{ id: "opencode", seededVersion: 1, env: {} }]);
  seedAgents();
  assert.ok((await getAgent("codex")));
});

test("seed 14 brings the first-party Daedalus agent to fresh and seeded installs alike", async () => {
  resetAgents([]);
  seedAgents();
  const daedalus = await getAgent("daedalus");
  assert.ok(daedalus, "fresh install gets it");
  assert.equal(daedalus?.command, "node");
  assert.equal(daedalus?.liveConfig, "acp");
  assert.equal(daedalus?.personaVia, "env");

  // An install seeded to 13 has never been offered it, so it arrives.
  resetAgents([{ id: "opencode", seededVersion: 13, env: {} }]);
  seedAgents();
  assert.ok((await getAgent("daedalus")));

  // Deleted on purpose stays deleted: this install is past seed 14.
  resetAgents([{ id: "opencode", seededVersion: 14, env: {} }]);
  seedAgents();
  assert.equal((await getAgent("daedalus")), undefined);
});

test("the Daedalus agent's spawn resolves the entry path and prunes like the rest", async () => {
  resetAgents([]);
  seedAgents();
  const daedalus = await getAgent("daedalus");
  assert.ok(daedalus);
  const spawn = resolveSpawn(daedalus, profileWith(), project, "gw-model", "high");
  // The args placeholder resolves to a real path ending in the built entry.
  assert.match(spawn.args[0] ?? "", /agent[/\\]dist[/\\]index\.js$/);
  assert.equal(spawn.env.DAEDALUS_AGENT_MODEL, "gw-model");
  assert.equal(spawn.env.DAEDALUS_AGENT_EFFORT, "high");
  assert.equal(spawn.env.DAEDALUS_AGENT_API_KEY, "sk-test");
  // The Default profile resolves the endpoint and key empty — both prune away,
  // and the agent falls back to its own defaults.
  const bare = resolveSpawn(daedalus, virtualProfile, project);
  assert.equal(bare.env.DAEDALUS_AGENT_BASE_URL, undefined);
  assert.equal(bare.env.DAEDALUS_AGENT_API_KEY, undefined);
});

test("an agent's user half is editable, and the probe cache goes with it", async () => {
  resetAgents([]);
  seedAgents();
  await db.insert(agentOptionsTable)
    .values([
      { key: "p1:daedalus:/tmp/x", options: {}, probedAt: 1 },
      { key: "p1:codex:/tmp/x", options: {}, probedAt: 1 },
    ])
    ;

  const updated = await updateAgent("daedalus", {
    name: "My Agent",
    command: "node",
    args: ["/opt/agent/index.js"],
    env: { DAEDALUS_AGENT_MODEL: "{model}", MY_OWN: "keep" },
  });
  assert.equal(updated?.name, "My Agent");
  assert.deepEqual(updated?.args, ["/opt/agent/index.js"]);
  assert.equal(updated?.env.MY_OWN, "keep");
  // The declarative half is the seed's and survives an edit untouched.
  assert.equal(updated?.liveConfig, "acp");
  assert.equal(updated?.personaVia, "env");

  // Its own probe answers are gone; another agent's are not.
  const keys = (await db.select().from(agentOptionsTable)).map((r) => r.key);
  assert.deepEqual(keys, ["p1:codex:/tmp/x"]);

  assert.equal(updateAgent("no-such-agent", { name: "x", command: "x", args: [], env: {} }), undefined);
});

test("a seed release never takes an edited agent back", async () => {
  resetAgents([]);
  seedAgents();
  updateAgent("daedalus", { name: "Mine", command: "bun", args: ["x.js"], env: { A: "1" } });
  seedAgents();
  const after = await getAgent("daedalus");
  assert.equal(after?.name, "Mine");
  assert.equal(after?.command, "bun");
  assert.deepEqual(after?.env, { A: "1" });
});

test("reset puts a built-in back, and only a built-in has one", async () => {
  resetAgents([]);
  seedAgents();
  const original = await getAgent("daedalus");
  await updateAgent("daedalus", { name: "Mine", command: "bun", args: ["x.js"], env: { A: "1" } });
  const restored = await resetAgent("daedalus");
  assert.equal(restored?.name, original?.name);
  assert.equal(restored?.command, "node");
  assert.deepEqual(restored?.args, original?.args);
  assert.deepEqual(restored?.env, original?.env);
  assert.equal(restored?.liveConfig, "acp");
  /* Every nullable declarative column is named in the write, not spread from a
     seed that may omit it — drizzle drops an `undefined` from a `.set()`, so a
     spread would leave whatever the row held. */
  assert.deepEqual(restored?.spawnCategories, original?.spawnCategories ?? null);
  assert.deepEqual(restored?.quotaProbe, original?.quotaProbe ?? null);
  assert.equal(restored?.personaVia, original?.personaVia ?? null);

  assert.ok(isBuiltInAgent("daedalus"));
  assert.ok(!isBuiltInAgent("something-someone-added"));
  // Nothing to reset to, and nothing to reset.
  assert.equal(resetAgent("something-someone-added"), undefined);
  resetAgents([]);
  assert.equal(resetAgent("daedalus"), undefined);
});

/* ── Seed 20: the facts that used to be literals elsewhere ──
   Each of these replaced a hardcoded id or path somewhere that had no business
   knowing one runtime from another, so what is asserted here is mostly that the
   *right* runtime carries each one and the others do not. */

test("seed 20 declares each runtime's workspace layout, and codex's is nothing", async () => {
  resetAgents([]);
  seedAgents();
  const claude = (await getAgent("claude-code"))?.workspaceLayout;
  assert.equal(claude?.dir, ".claude");
  assert.equal(claude?.skills, "skills");
  assert.equal(claude?.commands, "commands");
  assert.equal(claude?.argumentHintKey, "argument-hint");
  assert.deepEqual(claude?.modelAllowlist, { file: "settings.local.json", key: "availableModels" });
  // The harness's own runtime reads the same directory (agent/src/commands.ts).
  assert.deepEqual((await getAgent("daedalus"))?.workspaceLayout, claude);
  // OpenCode reads its own, and has no argument hint in its frontmatter.
  assert.equal((await getAgent("opencode"))?.workspaceLayout?.dir, ".opencode");
  assert.equal((await getAgent("opencode"))?.workspaceLayout?.argumentHintKey, undefined);
  assert.equal((await getAgent("opencode"))?.workspaceLayout?.modelAllowlist, undefined);
  /* Codex resolves skills and prompts only under $CODEX_HOME, so there is
     nowhere in a cwd to write them — and writing `.claude/` at it anyway is
     exactly what this replaced. */
  assert.equal((await getAgent("codex"))?.workspaceLayout, null);
});

test("seed 20 puts the workflow engine, the built-in tools and the catalog probe on the row", async () => {
  resetAgents([]);
  seedAgents();
  // What `sessions.ts` compared an agent id against.
  assert.equal((await getAgent("claude-code"))?.workflowsVia, "native");
  assert.equal((await getAgent("codex"))?.workflowsVia, null);
  assert.equal((await getAgent("opencode"))?.workflowsVia, null);
  // The two tool-name lists that used to be spelled inside the bridge.
  const tools = (await getAgent("claude-code"))?.builtinTools;
  assert.equal(tools?.via, "acp-meta");
  assert.deepEqual(tools?.tools.webSearch, ["WebSearch", "WebFetch"]);
  assert.deepEqual(tools?.tools.workflow, ["Workflow"]);
  assert.equal((await getAgent("codex"))?.builtinTools, null);
  // The module constant that read `codex` off PATH.
  assert.equal((await getAgent("codex"))?.catalogProbe?.kind, "codex-cli");
  assert.deepEqual((await getAgent("codex"))?.catalogProbe?.args, ["debug", "models"]);
  assert.equal((await getAgent("claude-code"))?.catalogProbe, null);
});

test("seed 20 carries the install line, the mark and the import paths", async () => {
  resetAgents([]);
  seedAgents();
  assert.match((await getAgent("claude-code"))?.install ?? "", /^npm install -g /);
  assert.match((await getAgent("claude-code"))?.icon ?? "", /^data:image\/png/);
  // The harness's own mark is the app's, not a fourth piece of flat art.
  assert.equal((await getAgent("daedalus"))?.icon, "app");
  assert.deepEqual((await getAgent("claude-code"))?.discovery?.mcp, [{ path: ".claude.json", format: "claude-json" }]);
  assert.deepEqual((await getAgent("codex"))?.discovery?.mcp, [{ path: ".codex/config.toml", format: "codex-toml" }]);
  // Nothing of OpenCode's is imported, which is a statement and not an omission.
  assert.equal((await getAgent("opencode"))?.discovery, null);
});

test("the seed 20 backfill fills a row that predates it without touching the env", async () => {
  resetAgents([
    { id: "claude-code", seededVersion: 19, env: { ANTHROPIC_MODEL: MODEL, MY_OWN: "keep me" } },
  ]);
  seedAgents();
  const claude = await getAgent("claude-code");
  assert.equal(claude?.workflowsVia, "native");
  assert.equal(claude?.workspaceLayout?.dir, ".claude");
  assert.ok(claude?.install);
  assert.equal(claude?.env.MY_OWN, "keep me");
  assert.equal(claude?.env.ANTHROPIC_MODEL, MODEL);
});

test("the seed 20 backfill leaves an icon the user cleared cleared", async () => {
  resetAgents([{ id: "claude-code", seededVersion: 19, env: {} }]);
  seedAgents();
  // A save with no icon clears it; a later re-seed must not put the art back,
  // because `icon` is the user's (it is art, not a claim about the protocol).
  updateAgent("claude-code", {
    name: "Claude Code",
    command: "claude-agent-acp",
    args: [],
    env: {},
    icon: null,
    install: null,
  });
  assert.equal((await getAgent("claude-code"))?.icon, null);
  seedAgents();
  assert.equal((await getAgent("claude-code"))?.icon, null);
});

test("a reset puts the install line and the mark back with everything else", async () => {
  resetAgents([]);
  seedAgents();
  updateAgent("codex", { name: "Mine", command: "codex-acp", args: [], env: {}, icon: null, install: null });
  assert.equal((await getAgent("codex"))?.icon, null);
  resetAgent("codex");
  assert.match((await getAgent("codex"))?.icon ?? "", /^data:image\/png/);
  assert.match((await getAgent("codex"))?.install ?? "", /^npm install -g /);
});

test("seeding twice changes nothing", async () => {
  resetAgents([]);
  seedAgents();
  const before = (await db.select().from(agentsTable).where(eq(agentsTable.id, "claude-code")))[0];
  seedAgents();
  assert.deepEqual((await db.select().from(agentsTable).where(eq(agentsTable.id, "claude-code")))[0], before);
});


/* ── Install detection (agent-status.ts) ──
   Pure: PATH and cwd are arguments, so a fake layout in a temp dir is the
   whole fixture. The one rule beyond "is the command on PATH" is that an
   absolute path among the args must exist — the harness's own agent is
   `node <entry>`, and `node` is always there. */
test("locateCommand finds a binary on PATH and nowhere else", () => {
  const root = mkdtempSync(join(tmpdir(), "daedalus-status-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "fake-acp"), "#!/bin/sh\n");
  chmodSync(join(bin, "fake-acp"), 0o755);
  writeFileSync(join(bin, "not-exec"), "");
  chmodSync(join(bin, "not-exec"), 0o644);
  const path = `${root}/nowhere:${bin}`;
  assert.equal(locateCommand("fake-acp", { path, cwd: root, exts: [] }), join(bin, "fake-acp"));
  assert.equal(locateCommand("missing-acp", { path, cwd: root, exts: [] }), null);
  assert.equal(locateCommand("not-exec", { path, cwd: root, exts: [] }), null);
  // A path is a path, not a PATH lookup: relative to cwd, or absolute.
  assert.equal(locateCommand("bin/fake-acp", { path: "", cwd: root, exts: [] }), join(bin, "fake-acp"));
  assert.equal(locateCommand(join(bin, "fake-acp"), { path: "", cwd: "/", exts: [] }), join(bin, "fake-acp"));
  assert.equal(locateCommand(join(bin, "gone"), { path, cwd: root, exts: [] }), null);
});

test("checkInstalled names what is missing — the command, or a file the args point at", async () => {
  resetAgents([]);
  await seedAgents();
  const missingCommand = { ...(await getAgent("codex"))!, command: "definitely-not-a-binary-here" };
  const a = checkInstalled(missingCommand, project);
  assert.equal(a.installed, false);
  assert.equal(a.missing, "definitely-not-a-binary-here");
  /* `node` exists; the entry it is handed does not. */
  const missingEntry = { ...(await getAgent("daedalus"))!, args: ["/nonexistent/daedalus/agent/dist/index.js"] };
  const b = checkInstalled(missingEntry, project);
  assert.equal(b.installed, false);
  assert.ok(b.path, "node itself was found");
  assert.equal(b.missing, "/nonexistent/daedalus/agent/dist/index.js");
  const present = { ...(await getAgent("daedalus"))!, args: [process.execPath] };
  assert.deepEqual(checkInstalled(present, project).installed, true);
});

console.log(`registry: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.error(`\nFAIL ${failure}`);
process.exit(failures.length ? 1 : 0);

test("npmPackage reads the package off an install line, and only an npm one", () => {
  assert.equal(npmPackage("npm install -g @agentclientprotocol/claude-agent-acp"), "@agentclientprotocol/claude-agent-acp");
  assert.equal(npmPackage("npm i -g codex-acp@1.7.0"), "codex-acp");
  assert.equal(npmPackage("curl -fsSL https://opencode.ai/install | bash"), null);
  assert.equal(npmPackage("pnpm --dir agent install && pnpm --dir agent build"), null);
  assert.equal(npmPackage(null), null);
});
