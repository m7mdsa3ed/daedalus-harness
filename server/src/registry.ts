import { desc, eq, like } from "drizzle-orm";
import { agentOptions, agents as agentsTable, db } from "./db/index.js";
import { gatewayUrlFor } from "./gateway-shim.js";
import { writeCodexModelCatalog } from "./model-catalog.js";
import { profileBaseUrl, type Profile } from "./profiles.js";
import type { Project } from "./projects.js";

/**
 * An ACP agent definition. `args`/`env` values may contain {placeholders}
 * resolved from the active profile: {apiKey} {baseUrl} {model} {smallModel} {cwd}.
 * An env entry whose placeholders resolve empty is omitted entirely.
 */
export interface AgentDef {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /**
   * ACP config categories this agent can only take at spawn time, mapped to the
   * session field that feeds its env template. Everything not listed here is
   * applied live over `session/set_config_option`.
   *
   * This is the one piece of "which knob restarts the process" that used to be
   * a hardcoded pair of category names in the client. It belongs to the agent,
   * so it is declared with the agent.
   */
  spawnCategories?: Record<string, "model" | "effort"> | null;
}

/** A default agent, plus the seed releases that bear on it. Give a new default
    the next unused `since` and installs pick it up — see `seedAgents`. */
type SeedAgent = AgentDef & {
  /** The seed release whose work this row still needs: bumped whenever a
      release adds something to it, which is what re-runs `backfill`. */
  since: number;
  /**
   * The release that first shipped this agent. Fixed forever, unlike `since`.
   *
   * The two are the same until a release backfills an existing agent, and then
   * they must not be: `since` is how far this install has been carried, but
   * "has this install ever been offered this agent" is what says whether a
   * missing row was deleted on purpose. Bumping `since` alone answers that
   * question wrongly and resurrects the row.
   */
  introduced: number;
  /**
   * What this seed release ADDS to a row that already exists. Returns only the
   * fields to change, and only ever fields a release introduced — never a
   * wholesale replacement, because `name`/`command`/`args`/`env` are the user's.
   * A release that adds a key *inside* an env template (see the codex catalog
   * below) is the case this exists for: it can merge the key in without
   * touching whatever else the user put there.
   */
  backfill?: (existing: AgentDef) => Partial<AgentDef>;
};

/** The `{placeholder}` that resolves to a generated Codex model catalog. Named
    for its dialect because the file it points at is Codex-shaped: an agent that
    wants one asks for it by using this name in its env. */
const CODEX_CATALOG_VAR = "codexModelCatalog";

/**
 * Add `model_catalog_json` to an existing codex row's CODEX_CONFIG.
 *
 * The key is new in this seed release, and without it a gateway model keeps
 * falling back to made-up metadata (see model-catalog.ts). Adding one key is the
 * narrowest edit that fixes it; anything the user changed around it survives,
 * and a template that already has the key is left exactly as it is.
 *
 * Textual, not `JSON.parse` → merge → `stringify`: the template is not JSON yet.
 * Its numeric slots (`"model_context_window":{contextWindow}`) are unquoted on
 * purpose, so it only becomes parseable once the placeholders are filled — which
 * is what `resolveEnvValue` does, and why the pruner runs there and not here.
 */
function withCodexCatalogKey(env: Record<string, string>): Record<string, string> {
  const template = env.CODEX_CONFIG;
  if (!template?.trimStart().startsWith("{")) return env;
  if (template.includes("model_catalog_json")) return env;
  const at = template.indexOf("{") + 1;
  const key = `"model_catalog_json":"{${CODEX_CATALOG_VAR}}"`;
  const rest = template.slice(at).trimStart();
  return {
    ...env,
    CODEX_CONFIG: template.slice(0, at) + key + (rest.startsWith("}") ? "" : ",") + template.slice(at),
  };
}

/** The two env names Claude Code has used for its cheap side-job model. */
const SMALL_MODEL_VARS = ["ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"] as const;

/**
 * Name the model Claude Code's cheap side-jobs run on.
 *
 * Claude Code runs those on a second, smaller model — and the one that matters
 * here is the Bash permission classifier, which is what decides whether a
 * command is safe in `auto` mode. Nothing in this template ever named that
 * model, so against a profile's {baseUrl} the *gateway* chose it: it maps the
 * built-in Haiku id onto whatever its own cheap tier is. When that tier is an
 * experimental preview it flaps, and the classifier fails closed — no verdict
 * means no Bash, for commands as ordinary as a build, while the main model on
 * the same endpoint is perfectly healthy.
 *
 * {smallModel} resolves to the session model (`resolveSpawn`) — which is what
 * the profile already promises everywhere else: one model id, the one the
 * gateway is known to serve, used for the main model, the side-jobs and the
 * alias switches alike. A separate cheap tier was tried and unmade: it is one
 * more id the gateway may not serve, and the classifier pays for it every Bash
 * command. A user who wants a different tier pins the key by hand — `env`
 * spreads last.
 *
 * Both names because the var was renamed across Claude Code releases and the
 * harness does not pin the binary. An unset {smallModel} — a profile with no
 * models at all — prunes them away, handing the choice back to the agent exactly
 * as it does for ANTHROPIC_MODEL. `env` spreads last, so a key the user already
 * put there is theirs and survives.
 */
function withSmallModelKeys(env: Record<string, string>): Record<string, string> {
  return { ...Object.fromEntries(SMALL_MODEL_VARS.map((k) => [k, modelVar("smallModel")])), ...env };
}

/**
 * Move a row already pinned to {model} onto {smallModel}.
 *
 * Seed 3 wrote `{model}` into these two keys; seed 4 gives the profile its own
 * say. Only that exact value is rewritten: anything else in there is a real
 * choice someone made, and `withSmallModelKeys` adds the keys when they are
 * missing entirely.
 */
function withSmallModelVar(env: Record<string, string>): Record<string, string> {
  const out = withSmallModelKeys(env);
  for (const key of SMALL_MODEL_VARS) {
    if (out[key] === "{model}") out[key] = modelVar("smallModel");
  }
  return out;
}

/**
 * The env names Claude Code resolves its `sonnet`/`opus`/`fable` aliases
 * through. Unlike the haiku pair these are not side-jobs — they are the models
 * the CLI *switches the session to* on its own:
 *
 *   - entering plan mode upgrades a session on the haiku alias to `sonnet`
 *     (the plan-mode constituent — the failure this exists for: a gateway
 *     session pinned to a custom model sits in the haiku slot via
 *     ANTHROPIC_DEFAULT_HAIKU_MODEL, the upgrade resolved the alias to the
 *     bare `claude-sonnet-5`, the gateway serves no such unprefixed id, and
 *     the turn died with model_not_found the moment the agent called
 *     EnterPlanMode);
 *   - the `opusplan` alias resolves to `opus` in plan mode and `sonnet` out;
 *   - automatic model fallback on third-party providers recognizes a model as
 *     Fable 5 by id, which is the `fable` alias's var.
 *
 * Each of those names a built-in Anthropic id the profile's gateway does not
 * serve, so every one of them is pinned to {model} — the model the session
 * already runs, the one id the gateway is known to serve. The aliases keep
 * their meaning (the switch still happens) but land somewhere that answers.
 * An unset {model} — the Default profile, a profile with no catalog — prunes
 * the keys away and the aliases resolve to the agent's own defaults, exactly
 * as ANTHROPIC_MODEL does. `env` spreads last, so a key the user already put
 * there is theirs and survives.
 */
const ALIAS_MODEL_VARS = [
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
] as const;

/** Pin Claude Code's model aliases to the selected model. New in seed 5;
    `backfill` merges the keys into rows that predate them. */
function withAliasModelKeys(env: Record<string, string>): Record<string, string> {
  return { ...Object.fromEntries(ALIAS_MODEL_VARS.map((k) => [k, modelVar("model")])), ...env };
}

/**
 * Claude Code's 1M-context window is opted into **by the model id**, not by a
 * number: the CLI reads a `[1m]` suffix off the id it is given, strips it, and
 * sends the long-context beta on every request. Nothing else turns it on — an
 * env var carrying the window (the shape Codex uses) is not read here — so a
 * profile whose model declares a 1M `contextWindow` was silently running on the
 * default 200k, and the agent reported that as the window it had.
 *
 * So every key that names the model for Claude Code carries the suffix
 * conditionally: `{longContext?[1m]}` emits it only when the *selected* model's
 * catalog entry says the window is a million or more (`resolveSpawn`), and
 * resolves to nothing otherwise — including for a profile with no catalog,
 * where the model itself already prunes away. It rides the alias and side-job
 * keys too, because those are pinned to the same id and a 1M session that
 * quietly drops to 200k on a plan-mode switch is the same bug again.
 */
const LONG_CONTEXT_MARKER = "[1m]";
const LONG_CONTEXT_SUFFIX = `{longContext?${LONG_CONTEXT_MARKER}}`;

/** The model id a Claude Code env key should carry, 1M suffix included. */
function modelVar(name: "model" | "smallModel"): string {
  return `{${name}}${LONG_CONTEXT_SUFFIX}`;
}

/** Append the 1M conditional to keys an older seed wrote as a bare `{model}`
    / `{smallModel}`. Only those exact values: anything else is a real choice. */
function withLongContextSuffix(env: Record<string, string>): Record<string, string> {
  const out = { ...env };
  for (const key of [...SMALL_MODEL_VARS, ...ALIAS_MODEL_VARS, "ANTHROPIC_MODEL"]) {
    if (out[key] === "{model}") out[key] = modelVar("model");
    else if (out[key] === "{smallModel}") out[key] = modelVar("smallModel");
  }
  return out;
}

/**
 * Claude Code's endpoint is the harness's own gateway shim, not the profile's
 * URL. `{gatewayUrl}` resolves to `/gw/<key>/<profile>/<agent>` on this
 * server, which forwards to the profile's base URL and repairs the one reply
 * shape gateways get wrong for Claude Code — a non-streaming Messages call
 * answered as an OpenAI chat completion, which is what the auto-mode
 * permission classifier reads and what made it fail closed on a healthy
 * endpoint (see gateway-shim.ts). It is empty whenever `{baseUrl}` is, so the
 * Default profile still prunes the key away, and it *is* `{baseUrl}` when no
 * shim is up (a test, a probe before boot). New in seed 8; the backfill moves
 * only a key that still holds the exact seeded `{baseUrl}` — anything else is
 * the user's own endpoint and stays.
 */
function withGatewayUrl(env: Record<string, string>): Record<string, string> {
  return env.ANTHROPIC_BASE_URL === "{baseUrl}" ? { ...env, ANTHROPIC_BASE_URL: "{gatewayUrl}" } : env;
}

/**
 * The same move for Codex, inside its CODEX_CONFIG template: the provider's
 * `base_url` goes through the shim, which is where Codex's `namespace` tools
 * are flattened for a gateway that cannot read them (gateway-shim.ts). The
 * `{baseUrl?…}` conditionals around it stay keyed on the raw URL — the shim
 * URL is empty exactly when that is. Textual, like `withCodexCatalogKey`, and
 * for the same reason; only the exact seeded slot moves.
 */
function withCodexGatewayUrl(env: Record<string, string>): Record<string, string> {
  const template = env.CODEX_CONFIG;
  if (!template) return env;
  const seeded = '"base_url":"{baseUrl}"';
  return template.includes(seeded) ? { ...env, CODEX_CONFIG: template.replace(seeded, '"base_url":"{gatewayUrl}"') } : env;
}

/** Model and effort are env at spawn for all three agents we ship. */
const SPAWN_CATEGORIES: Record<string, "model" | "effort"> = {
  model: "model",
  thought_level: "effort",
};

/*
 * Agents are spawned by their globally installed binary, not through `npx`.
 * npx re-resolves the package on every spawn — and a thread spawns an agent on
 * create, on revive, and on every profile or model change — so it put a package
 * lookup in front of each one. The binaries come from:
 *
 *   npm install -g @agentclientprotocol/claude-agent-acp @agentclientprotocol/codex-acp
 *
 * A missing one fails the spawn with ENOENT, which surfaces in the thread. To
 * go back to the self-installing form, set command to "npx" and args to
 * ["-y", "<package>"].
 */
const DEFAULT_AGENTS: SeedAgent[] = [
  {
    since: 8,
    introduced: 1,
    // Seed 4 moved the haiku keys to {smallModel}; seed 5 added the alias keys;
    // seed 6 appends the 1M conditional to all of them; seed 8 routes the
    // endpoint through the gateway shim. One backfill applies all of them,
    // because an install stamped below 4 jumps straight here and never sees
    // the earlier rules on its own.
    backfill: (existing) => ({
      env: withGatewayUrl(withLongContextSuffix(withAliasModelKeys(withSmallModelVar(existing.env)))),
    }),
    id: "claude-code",
    name: "Claude Code",
    command: "claude-agent-acp",
    args: [],
    env: withAliasModelKeys(
      withSmallModelKeys({
        ANTHROPIC_API_KEY: "{apiKey}",
        ANTHROPIC_BASE_URL: "{gatewayUrl}",
        ANTHROPIC_MODEL: modelVar("model"),
      }),
    ),
    spawnCategories: SPAWN_CATEGORIES,
  },
  {
    // Official ACP adapter for OpenAI Codex. Auth: CODEX_API_KEY, or ChatGPT
    // OAuth (`codex login`) when no key is set. Model/effort/base-URL flow
    // through CODEX_CONFIG (JSON merged into the Codex session config): a
    // profile Base URL generates a "daedalus" model_providers entry; with no
    // base URL the whole block prunes away and Codex uses its default
    // provider. wire_api is "responses" — the only one codex still accepts
    // (0.148 refuses "chat"); a chat-completions-only gateway is reached
    // through the harness's shim, which is also what base_url points at.
    // MODEL_PROVIDER repeats the choice because codex-acp's session/load path
    // (getResumeModelProvider) ignores CODEX_CONFIG.model_provider and falls
    // back to "openai" — without it every revived thread 401s on api.openai.com.
    // model_catalog_json is what stops Codex inventing metadata for a gateway
    // model id: model_context_window alone does not (see model-catalog.ts).
    // Seed 7 re-runs the same backfill: rows were found without the key (an
    // env edit in Settings pastes whatever template the user had), and a seed
    // already stamped never looks again. The merge is idempotent, so a row
    // that still has the key is left exactly as it is. Seed 9 routes the
    // provider's base_url through the gateway shim (withCodexGatewayUrl).
    since: 9,
    introduced: 2,
    backfill: (existing) => ({ env: withCodexGatewayUrl(withCodexCatalogKey(existing.env)) }),
    id: "codex",
    name: "Codex",
    command: "codex-acp",
    args: [],
    spawnCategories: SPAWN_CATEGORIES,
    env: {
      CODEX_API_KEY: "{apiKey}",
      MODEL_PROVIDER: "{baseUrl?daedalus}",
      CODEX_CONFIG:
        '{"model":"{model}","model_reasoning_effort":"{effort}","model_context_window":{contextWindow},"model_max_output_tokens":{maxOutputTokens},"model_catalog_json":"{codexModelCatalog}","model_provider":"{baseUrl?daedalus}","model_providers":{"daedalus":{"name":"{baseUrl?Daedalus gateway}","base_url":"{gatewayUrl}","env_key":"{baseUrl?CODEX_API_KEY}","wire_api":"{baseUrl?responses}"}}}',
    },
  },
  {
    // OpenCode's first-party ACP adapter (`opencode acp`, opencode.ai/docs/acp).
    // OpenCode does not honor OPENCODE_API_KEY / OPENCODE_BASE_URL /
    // OPENCODE_MODEL as first-class env vars — configuration reaches it via
    // OPENCODE_CONFIG_CONTENT (its documented runtime override env var,
    // opencode.ai/docs/config). We plumb three harness-controlled vars —
    // DAEDALUS_OPENCODE_API_KEY / _BASE_URL / _MODEL — from the active profile
    // and reference them inside the JSON via OpenCode's own {env:...}
    // substitution. When the profile leaves a value empty the DAEDALUS_* var
    // is pruned from the spawned env (see resolveEnvValue / pruneJson); the
    // matching {env:DAEDALUS_*} inside the JSON substitutes to "" and OpenCode
    // falls back to its own auth cascade (OpenCode app login, ANTHROPIC_API_KEY
    // / OPENAI_API_KEY already in the host shell). The DAEDALUS_* vars are
    // normally set in .env (or shell) for a global default; a stored profile
    // overrides them per-thread.
    since: 1,
    introduced: 1,
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    args: ["acp"],
    spawnCategories: SPAWN_CATEGORIES,
    env: {
      DAEDALUS_OPENCODE_API_KEY: "{apiKey}",
      DAEDALUS_OPENCODE_BASE_URL: "{baseUrl?https://api.opencode.ai}",
      DAEDALUS_OPENCODE_MODEL: "{model}",
      OPENCODE_CONFIG_CONTENT:
        '{"model":"{env:DAEDALUS_OPENCODE_MODEL}","provider":{"opencode":{"npm":"@ai-sdk/openai-compatible","name":"OpenCode","options":{"baseURL":"{env:DAEDALUS_OPENCODE_BASE_URL}","apiKey":"{env:DAEDALUS_OPENCODE_API_KEY}"}}}}',
    },
  },
];

/**
 * Add the defaults this install has never been offered, and nothing else.
 *
 * The old rule was "seed the file if it is empty", which meant an install that
 * had ever run could never receive an agent added in a later release — OpenCode
 * shipped and no existing user saw it. Every row records the seed release that
 * introduced it, so the highest one present is how far this install has been
 * seeded, and only defaults newer than that are inserted.
 *
 * Two things fall out of that: a user's edits to a built-in are never
 * overwritten, and a built-in they deliberately deleted does not come back.
 */
export function seedAgents(): void {
  const applied =
    db.select({ v: agentsTable.seededVersion }).from(agentsTable).orderBy(desc(agentsTable.seededVersion)).get()
      ?.v ?? 0;
  for (const { since, introduced, backfill, ...agent } of DEFAULT_AGENTS) {
    if (since <= applied) continue;
    const existing = db.select().from(agentsTable).where(eq(agentsTable.id, agent.id)).get();
    if (!existing) {
      /* This install was already offered this agent in an earlier release and
         does not have it, so it was deleted — the one case the whole
         seeded-version scheme exists to respect. `since > applied` alone cannot
         tell that apart from a fresh install, because a backfill bumps `since`
         past every row present; `introduced` is the half that does not move.
         Nothing is stamped either: there is no row to carry a version, and the
         re-check next boot is a no-op. */
      if (introduced <= applied) continue;
      db.insert(agentsTable)
        .values({ ...agent, spawnCategories: agent.spawnCategories ?? null, seededVersion: since })
        .run();
      continue;
    }
    /* The row is older than this seed release — an install that already had
       this agent before the field existed. Stamp it as offered, and fill in
       only what the release ADDED. Never name, command, args or env wholesale:
       those are the fields a user edits, and silently replacing them is how a
       harness loses someone's gateway configuration. A release that adds a
       single key inside one of them says so with `backfill`. */
    db.update(agentsTable)
      .set({
        seededVersion: since,
        spawnCategories: existing.spawnCategories ?? agent.spawnCategories ?? null,
        ...backfill?.(existing),
      })
      .where(eq(agentsTable.id, agent.id))
      .run();
    /* The probe's cached answer was recorded by the old spawn, and what a
       release adds here is exactly the kind of thing that changes it — a real
       catalog is what makes Codex advertise an effort selector for a gateway
       model at all. Drop this agent's entries so the next draft asks again. */
    db.delete(agentOptions).where(like(agentOptions.key, `%:${agent.id}:%`)).run();
  }
}

export function listAgents(): AgentDef[] {
  return db.select().from(agentsTable).all();
}

export function getAgent(id: string): AgentDef | undefined {
  return db.select().from(agentsTable).where(eq(agentsTable.id, id)).get();
}

/**
 * `{key}` → the var's value; `{key?literal}` → the literal only when the var is
 * non-empty. Conditionals let JSON env templates emit whole blocks (e.g. a
 * Codex model_providers entry) that the pruner removes as a unit when the
 * driving var is unset.
 */
function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)(\?[^}]*)?\}/g, (_, key: string, literal?: string) => {
    const value = vars[key] ?? "";
    if (literal !== undefined) return value ? literal.slice(1) : "";
    return value;
  });
}

/** Drop empty strings, nulls, and the containers they hollow out; undefined = nothing left. */
function pruneJson(value: unknown): unknown {
  if (value === null) return undefined;
  if (typeof value === "string") return value === "" ? undefined : value;
  if (Array.isArray(value)) {
    const pruned = value.map(pruneJson).filter((v) => v !== undefined);
    return pruned.length ? pruned : undefined;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const pruned = pruneJson(entry);
      if (pruned !== undefined) out[key] = pruned;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value;
}

/**
 * Resolve one env template. JSON-object templates (e.g. Codex's CODEX_CONFIG)
 * are pruned after placeholder fill so an unset {model}/{effort} disappears
 * instead of becoming `"model": ""`; a fully-hollow object omits the var.
 */
export function resolveEnvValue(template: string, vars: Record<string, string>): string | undefined {
  const value = fill(template, vars);
  if (!value) return undefined;
  if (template.trimStart().startsWith("{") && !/^\{\w+\}$/.test(template.trim())) {
    try {
      const pruned = pruneJson(JSON.parse(value));
      return pruned === undefined ? undefined : JSON.stringify(pruned);
    } catch {
      return value; // not JSON after all — pass through
    }
  }
  return value;
}

/** Resolve an agent definition against a profile (agent config) + project (workspace). */
export function resolveSpawn(
  agent: AgentDef,
  profile: Profile,
  project: Project,
  model?: string,
  effort?: string,
) {
  const resolvedModel = model || profile.defaultModel || "";
  // Catalog metadata for the selected model. Fills unquoted JSON slots, so the
  // no-value form is the literal `null` (pruned away), not an empty string.
  const modelMeta = profile.models?.find((m) => m.id === resolvedModel);
  const vars: Record<string, string> = {
    apiKey: profile.apiKey ?? "",
    /* The profile's shared endpoint unless it names one for this agent: a
       gateway that serves several runtimes often serves them at different
       paths (an Anthropic-messages path for Claude Code, an OpenAI-responses
       path for Codex) — the one thing on a profile that is per-agent. */
    baseUrl: profileBaseUrl(profile, agent.id),
    /* The same endpoint behind this server's gateway shim (see
       `withGatewayUrl`); the raw URL when no shim is configured. */
    gatewayUrl:
      gatewayUrlFor(profile.id, agent.id, profileBaseUrl(profile, agent.id)) || profileBaseUrl(profile, agent.id),
    model: resolvedModel,
    /* Always the session model: a profile means "run everything on this
       model", and the cheap side-jobs (the auto-mode classifier) and the alias
       switches (plan mode's sonnet upgrade) are no exception — a different id
       here is a model the gateway may not serve, which is the failure
       `withSmallModelKeys`/`withAliasModelKeys` document. A profile with no
       models at all resolves both to "" and the keys prune away — the agent
       keeps its own choice, as it does for the model itself. */
    smallModel: resolvedModel,
    effort: effort ?? "",
    /* Drives `{longContext?[1m]}` on every key that names a model for Claude
       Code. Non-empty = emit the suffix (see `fill`), so this is the *catalog's*
       answer to "is this a 1M model": nothing else turns the beta on. Empty
       whenever the profile has no entry for the selected model — the model
       itself prunes away there too — and empty for an id that already carries
       the suffix, since a `sonnet[1m][1m]` names nothing. */
    longContext:
      (modelMeta?.contextWindow ?? 0) >= 1_000_000 && !resolvedModel.endsWith(LONG_CONTEXT_MARKER)
        ? "1"
        : "",
    contextWindow: modelMeta?.contextWindow ? String(modelMeta.contextWindow) : "null",
    maxOutputTokens: modelMeta?.maxOutputTokens ? String(modelMeta.maxOutputTokens) : "null",
    cwd: project.cwd,
  };
  /* Costs a file write and (once per process) a `codex debug models` spawn, so
     it is only paid when an env template actually asks for it. A profile with
     no models resolves it empty, and the key it fills prunes away — which is
     the agent keeping its own catalog, exactly as elsewhere. */
  if (Object.values(agent.env).some((t) => t.includes(`{${CODEX_CATALOG_VAR}}`))) {
    vars[CODEX_CATALOG_VAR] = writeCodexModelCatalog(profile.id, profile.models ?? []) ?? "";
  }
  const env: Record<string, string> = {};
  for (const [key, template] of Object.entries(agent.env)) {
    const value = resolveEnvValue(template, vars);
    if (value !== undefined) env[key] = value;
  }
  return {
    command: agent.command,
    args: agent.args.map((a) => fill(a, vars)),
    env,
    cwd: project.cwd,
  };
}
