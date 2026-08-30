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
    agentId: "claude-code",
    baseUrl: "https://gw.example/v1",
    apiKey: "sk-test",
    models: [{ id: "gw/big", label: "Big", reasoningEfforts: [] }],
    defaultModel: "gw/big",
    smallModel: "",
    webSearch: { enabled: false },
    knowledge: { enabled: false },
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
  assert.equal(claude?.env.ANTHROPIC_SMALL_FAST_MODEL, "{smallModel}");
  assert.equal(claude?.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "{smallModel}");
  assert.equal(claude?.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "{model}");
  assert.equal(claude?.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "{model}");
  assert.equal(claude?.env.ANTHROPIC_DEFAULT_FABLE_MODEL, "{model}");
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
  assert.equal(claude?.env.ANTHROPIC_SMALL_FAST_MODEL, "{smallModel}");
  assert.equal(claude?.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "{smallModel}");
  // Never a wholesale replacement: what the user put in the template is theirs.
  assert.equal(claude?.env.MY_OWN, "keep me");
  assert.equal(claude?.env.ANTHROPIC_BASE_URL, "{baseUrl}");
});

test("the backfill adds the keys to a row that predates them", () => {
  resetAgents([{ id: "claude-code", seededVersion: 1, env: { ANTHROPIC_MODEL: "{model}" } }]);
  seedAgents();
  const claude = getAgent("claude-code");
  assert.equal(claude?.env.ANTHROPIC_SMALL_FAST_MODEL, "{smallModel}");
  // Seed 5's alias keys arrive on the same jump — an install stamped 1 never
  // saw seed 4 on its own.
  assert.equal(claude?.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "{model}");
  assert.equal(claude?.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "{model}");
  assert.equal(claude?.env.ANTHROPIC_DEFAULT_FABLE_MODEL, "{model}");
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
