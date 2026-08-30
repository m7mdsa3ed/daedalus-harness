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
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { agents as agentsTable, db } from "../src/db/index.js";
import type { Profile } from "../src/profiles.js";
import type { Project } from "../src/projects.js";
import { configureGatewayShim } from "../src/gateway-shim.js";
import { getAgent, resolveSpawn, seedAgents } from "../src/registry.js";

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
    mcpServerIds: [],
    skillIds: [],
    commandIds: [],
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

/* ── seedAgents ─────────────────────────────────────────────────────────── */

function resetAgents(rows: { id: string; env: Record<string, string>; seededVersion: number }[]) {
  db.delete(agentsTable).run();
  for (const row of rows) {
    db.insert(agentsTable)
      .values({ name: row.id, command: row.id, args: [], spawnCategories: null, ...row })
      .run();
  }
}

test("a fresh install gets the built-ins, pointed at {smallModel}", () => {
  resetAgents([]);
  seedAgents();
  const claude = getAgent("claude-code");
  assert.equal(claude?.env.ANTHROPIC_SMALL_FAST_MODEL, SMALL);
  assert.equal(claude?.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, SMALL);
  assert.equal(claude?.env.ANTHROPIC_DEFAULT_SONNET_MODEL, MODEL);
  assert.equal(claude?.env.ANTHROPIC_DEFAULT_OPUS_MODEL, MODEL);
  assert.equal(claude?.env.ANTHROPIC_DEFAULT_FABLE_MODEL, MODEL);
  assert.ok(getAgent("codex"));
  assert.ok(getAgent("opencode"));
});

test("the backfill moves a seed-3 row off {model} and keeps the user's edits", () => {
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
  const claude = getAgent("claude-code");
  assert.equal(claude?.env.ANTHROPIC_SMALL_FAST_MODEL, SMALL);
  assert.equal(claude?.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, SMALL);
  // Never a wholesale replacement: what the user put in the template is theirs.
  assert.equal(claude?.env.MY_OWN, "keep me");
  // Seed 8 routes the seeded endpoint through the gateway shim — only the
  // exact seeded value moves.
  assert.equal(claude?.env.ANTHROPIC_BASE_URL, "{gatewayUrl}");
});

test("seed 9 moves Codex's provider base_url onto the shim, only when it is the seeded slot", () => {
  const seededTemplate = '{"model":"{model}","model_providers":{"daedalus":{"base_url":"{baseUrl}","wire_api":"{baseUrl?responses}"}}}';
  resetAgents([
    { id: "codex", seededVersion: 8, env: { CODEX_CONFIG: seededTemplate } },
    { id: "claude-code", seededVersion: 8, env: {} },
    { id: "opencode", seededVersion: 8, env: {} },
  ]);
  seedAgents();
  const moved = getAgent("codex")?.env.CODEX_CONFIG ?? "";
  assert.ok(moved.includes('"base_url":"{gatewayUrl}"'));
  assert.ok(!moved.includes('"base_url":"{baseUrl}"'));
  // The catalog key rides along for a row that never got it.
  assert.ok(moved.includes("model_catalog_json"));
  // A hand-written URL is the user's.
  resetAgents([{ id: "codex", seededVersion: 8, env: { CODEX_CONFIG: '{"model_providers":{"daedalus":{"base_url":"https://my.gw/v1"}}}' } }]);
  seedAgents();
  assert.ok(getAgent("codex")?.env.CODEX_CONFIG.includes('"base_url":"https://my.gw/v1"'));
});

test("a base URL the user wrote by hand is not moved onto the shim", () => {
  resetAgents([{ id: "claude-code", seededVersion: 7, env: { ANTHROPIC_BASE_URL: "https://my.gw/v1" } }]);
  seedAgents();
  assert.equal(getAgent("claude-code")?.env.ANTHROPIC_BASE_URL, "https://my.gw/v1");
});

test("{gatewayUrl} is the profile's endpoint until a shim is up, then the shim", () => {
  const agent = { ...claudeAgent, env: { ...claudeEnv, ANTHROPIC_BASE_URL: "{gatewayUrl}" } };
  assert.equal(resolveSpawn(agent, profileWith(), project).env.ANTHROPIC_BASE_URL, "https://gw.example/v1");
  // The Default profile has no gateway, so the key prunes away either way.
  assert.equal(resolveSpawn(agent, virtualProfile, project).env.ANTHROPIC_BASE_URL, undefined);
  configureGatewayShim({ port: 4321 });
  assert.match(
    resolveSpawn(agent, profileWith(), project).env.ANTHROPIC_BASE_URL ?? "",
    /^http:\/\/127\.0\.0\.1:4321\/gw\/[0-9a-f]{48}\/p1\/claude-code$/,
  );
  assert.equal(resolveSpawn(agent, virtualProfile, project).env.ANTHROPIC_BASE_URL, undefined);
  // A per-agent override on the profile is still what the shim fronts — the
  // shim resolves it by profile + agent at request time, so nothing to check
  // in the env beyond the pair being named.
});

test("the backfill adds the keys to a row that predates them", () => {
  resetAgents([{ id: "claude-code", seededVersion: 1, env: { ANTHROPIC_MODEL: "{model}" } }]);
  seedAgents();
  const claude = getAgent("claude-code");
  assert.equal(claude?.env.ANTHROPIC_SMALL_FAST_MODEL, SMALL);
  // Seed 5's alias keys arrive on the same jump — an install stamped 1 never
  // saw seed 4 on its own — and seed 6's 1M conditional rides along on all of
  // them, which is the only thing that turns the long-context beta on.
  assert.equal(claude?.env.ANTHROPIC_DEFAULT_SONNET_MODEL, MODEL);
  assert.equal(claude?.env.ANTHROPIC_DEFAULT_OPUS_MODEL, MODEL);
  assert.equal(claude?.env.ANTHROPIC_DEFAULT_FABLE_MODEL, MODEL);
});

test("a value that is neither missing nor {model} is left alone", () => {
  resetAgents([{ id: "claude-code", seededVersion: 3, env: { ANTHROPIC_SMALL_FAST_MODEL: "haiku-x" } }]);
  seedAgents();
  assert.equal(getAgent("claude-code")?.env.ANTHROPIC_SMALL_FAST_MODEL, "haiku-x");
});

test("a deleted built-in is not resurrected by a later backfill", () => {
  // claude-code was introduced in seed 1 and this install is past that, so its
  // absence is a deletion — not a fresh install owed the agent. Bumping `since`
  // to 4 for the backfill must not read as "never offered".
  resetAgents([
    { id: "codex", seededVersion: 2, env: {} },
    { id: "opencode", seededVersion: 1, env: {} },
  ]);
  seedAgents();
  assert.equal(getAgent("claude-code"), undefined);
});

test("a genuinely new agent still reaches an install that has rows", () => {
  // codex was introduced in seed 2; an install seeded only to 1 has never been
  // offered it, so it must arrive.
  resetAgents([{ id: "opencode", seededVersion: 1, env: {} }]);
  seedAgents();
  assert.ok(getAgent("codex"));
});

test("seeding twice changes nothing", () => {
  resetAgents([]);
  seedAgents();
  const before = db.select().from(agentsTable).where(eq(agentsTable.id, "claude-code")).get();
  seedAgents();
  assert.deepEqual(db.select().from(agentsTable).where(eq(agentsTable.id, "claude-code")).get(), before);
});

console.log(`registry: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.error(`\nFAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
