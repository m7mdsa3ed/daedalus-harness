import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { desc, eq, like } from "drizzle-orm";
import { z } from "zod";
import { agentOptions, agents as agentsTable, db, type QuotaProbe } from "./db/index.js";
import { gatewayUrlFor } from "./gateway-shim.js";
import { writeCodexModelCatalog } from "./model-catalog.js";
// Type-only: personas.ts imports `usesPersonaFile` from here at runtime, and
// the dependency has to stay one-directional.
import type { PersonaSpawn } from "./personas.js";
import { profileBaseUrl, profileSupports, type Profile } from "./profiles.js";
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
  /**
   * How a model, effort or profile change reaches this agent without killing
   * it — the other half of `spawnCategories`, which only ever said which knobs
   * are env.
   *
   * Being env at spawn does not have to mean being env *forever*, and the two
   * agents we ship prove it in opposite directions:
   *
   *  - `"acp"` (claude-code): its own model selector takes a gateway's ids
   *    verbatim, provided they are in the `availableModels` allowlist it
   *    resolves out of the workspace's settings — which is why the harness
   *    writes that file (`materializeModelAllowlist`). A change is then one
   *    `session/set_config_option`, and the agent stays truthful about what it
   *    is running: its context window, its 1M beta and its mode gating all
   *    follow a model it was actually told about.
   *  - `"gateway"` (codex): it will not. Its `listModels` ignores
   *    `model_catalog_json` entirely — measured against codex-acp 1.7 / codex
   *    0.150, which answers `Invalid params` for every catalog model but the
   *    one it spawned on, and offers no reasoning-effort selector for a gateway
   *    id at all. So nothing is asked of the agent: the shim rewrites `model`
   *    and `reasoning.effort` on the request body it is already reading, and
   *    the harness is the only thing that knows the model changed.
   *
   * Null (opencode, and any agent someone adds) means neither is known to work,
   * and the change costs a respawn exactly as it always did.
   */
  liveConfig?: "acp" | "gateway" | null;
  /**
   * How to read this runtime's subscription quota, or null/absent when it has
   * none to read. Declared here rather than matched on the agent's id in
   * quota.ts for the same reason `spawnCategories` is: which knob restarts a
   * process, and which command reports a plan's usage, are facts about the
   * agent, and a user who repoints `command` at a different binary must be able
   * to repoint this one too.
   */
  quotaProbe?: QuotaProbe | null;
  /**
   * How a thread's persona (`personas.ts`) reaches this agent, or null/absent
   * when nothing is known to work and the persona is simply not applied.
   *
   * Declared with the agent for the same reason `spawnCategories`, `liveConfig`
   * and `quotaProbe` are: which door a runtime opens is a fact about the
   * runtime, and a user who repoints `command` at a fork has to be able to
   * repoint this with it.
   *
   *  - `"acp-meta"` (claude-code): the ACP `_meta` block on `session/new` and
   *    `session/load`. `_meta.systemPrompt` as an *object* is merged over the
   *    agent's own preset with the type and preset locked, so `{append}` adds
   *    to the CLI's system prompt instead of replacing it; and
   *    `_meta.claudeCode.options` is spread straight into the Agent SDK's query
   *    options, which is where the `thinking` budget goes. Built by
   *    `AcpBridge.sessionMeta`, not here — it is protocol, not environment.
   *  - `"env"` (codex, opencode): a key in the agent's own config template,
   *    filled from `{personaPrompt}` (inline text) or `{personaFile}` (a path).
   *    Which of the two an agent wants is the template's business — it asks by
   *    naming the placeholder — exactly as the Codex catalog does.
   */
  personaVia?: "acp-meta" | "env" | null;
  /**
   * Where this runtime's subagent transcripts come from when its ACP bridge
   * does not carry them, or null/absent when ACP is all there is.
   *
   *  - `"opencode-http"` (opencode): `opencode acp` drops every event of a
   *    child session on the floor (`docs/protocol.md`, "Subagents"). The
   *    process is spawned with `--port <n> --hostname 127.0.0.1` and a
   *    per-spawn `OPENCODE_SERVER_PASSWORD`, and the server subscribes to
   *    its `/event` bus and re-emits the children as RFD subagent updates
   *    (`opencode-subagents.ts`). Retire the day sst/opencode#40654 ships.
   *
   * Declarative like the three above it: a fact about the runtime behind
   * `command`, and not offered on `PUT /api/agents/:id` for the same reason.
   */
  subagentFeed?: "opencode-http" | null;
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

/* ── The two persona placeholders ──
 *
 * An `"env"` agent asks for a persona in one of two shapes, and it asks by
 * naming the placeholder rather than by being recognized here:
 *
 *   {personaPrompt} — the instruction text itself, for a runtime that takes it
 *     inline (codex's `developer_instructions`). It is substituted into a JSON
 *     *string literal* inside a config template, so the value handed to `fill`
 *     is already JSON-escaped — see `resolveSpawn`. That is the only reason it
 *     is safe: a persona is multi-line prose full of quotes and newlines, and
 *     dropping it raw into CODEX_CONFIG produced a template that no longer
 *     parsed, which `resolveEnvValue` then passed through verbatim.
 *   {personaFile} — a path to a file holding the same text, for a runtime that
 *     will only read instructions off disk (opencode's `instructions`, which is
 *     a list of paths). Written by `writePersonaPrompt`.
 *
 * Both resolve empty for a thread with no persona, and the key they fill prunes
 * away — the same contract `{model}` and `{codexModelCatalog}` already have.
 */
const PERSONA_PROMPT_VAR = "personaPrompt";
const PERSONA_FILE_VAR = "personaFile";

/** Does this agent's env ask for the persona as a file? What tells the caller
    whether writing one is worth the file write — the same "ask the template,
    don't match on the agent's id" rule the Codex catalog uses. */
export function usesPersonaFile(agent: AgentDef): boolean {
  return Object.values(agent.env).some((t) => t.includes(`{${PERSONA_FILE_VAR}}`));
}

/** Add codex's `developer_instructions` to an existing CODEX_CONFIG. Textual
    and single-key, exactly like `withCodexCatalogKey` and for the same reason:
    the template is not JSON until its placeholders are filled, and everything
    else in there is the user's. */
function withCodexPersonaKey(env: Record<string, string>): Record<string, string> {
  const template = env.CODEX_CONFIG;
  if (!template?.trimStart().startsWith("{")) return env;
  if (template.includes("developer_instructions")) return env;
  const at = template.indexOf("{") + 1;
  const key = `"developer_instructions":"{${PERSONA_PROMPT_VAR}}"`;
  const rest = template.slice(at).trimStart();
  return {
    ...env,
    CODEX_CONFIG: template.slice(0, at) + key + (rest.startsWith("}") ? "" : ",") + template.slice(at),
  };
}

/** The same move for opencode, whose `instructions` is a list of file paths —
    hence `{personaFile}` and not `{personaPrompt}`. A thread with no persona
    resolves it to `[""]`, which `pruneJson` empties and then drops entirely. */
function withOpencodePersonaKey(env: Record<string, string>): Record<string, string> {
  const template = env.OPENCODE_CONFIG_CONTENT;
  if (!template?.trimStart().startsWith("{")) return env;
  if (template.includes('"instructions"')) return env;
  const at = template.indexOf("{") + 1;
  const key = `"instructions":["{${PERSONA_FILE_VAR}}"]`;
  const rest = template.slice(at).trimStart();
  return {
    ...env,
    OPENCODE_CONFIG_CONTENT:
      template.slice(0, at) + key + (rest.startsWith("}") ? "" : ",") + template.slice(at),
  };
}

/** Enable OpenCode's non-interactive permission mode when the built-in config
    is still the user's untouched template. An explicit permission policy is
    always preserved: users who configured `ask`/`deny` keep that choice. */
function withOpencodeBypass(env: Record<string, string>): Record<string, string> {
  const template = env.OPENCODE_CONFIG_CONTENT;
  if (!template?.trimStart().startsWith("{")) return env;
  if (template.includes('"permission"') || template.includes('"permissions"')) return env;
  const at = template.indexOf("{") + 1;
  const key = '"permission":"allow"';
  const rest = template.slice(at).trimStart();
  return {
    ...env,
    OPENCODE_CONFIG_CONTENT:
      template.slice(0, at) + key + (rest.startsWith("}") ? "" : ",") + template.slice(at),
  };
}

/**
 * The quota probes seed 10 adds, by agent id.
 *
 * Both read what the runtime's own interactive command reports — `/usage` in
 * Claude Code, `/status` in Codex — through the one door each offers a script:
 *
 *   - `claude -p "/usage" --output-format json` works because that command is
 *     registered `supportsNonInteractive`. It answers from local state with no
 *     API round trip, so it is cheap enough to run per settled turn.
 *   - `codex app-server` speaks JSON-RPC over stdio and answers
 *     `account/rateLimits/read` with the same snapshot `/status` draws.
 *
 * Neither is the runtime's *ACP* binary: the ACP adapter is a session, and a
 * session is not what has an account. So these name the plain CLI, and the
 * agent's own `command` is left alone.
 */
const QUOTA_PROBES: Record<string, QuotaProbe> = {
  "claude-code": { kind: "claude-cli", command: "claude", args: ["-p", "/usage", "--output-format", "json"] },
  codex: { kind: "codex-app-server", command: "codex", args: ["app-server"] },
};

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

/* The in-repo first-party agent (agent/, built to agent/dist). Resolved the
   same from server/src (tsx dev) and server/dist (built), because both sit one
   level under server/; DAEDALUS_AGENT_ENTRY is the escape hatch for pointing a
   deploy somewhere else. A path that does not exist fails the spawn with the
   ENOENT the thread already knows how to show — same contract as a missing
   global binary. */
const DAEDALUS_AGENT_ENTRY =
  process.env.DAEDALUS_AGENT_ENTRY ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agent", "dist", "index.js");

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
    since: 12,
    introduced: 1,
    // Seed 4 moved the haiku keys to {smallModel}; seed 5 added the alias keys;
    // seed 6 appends the 1M conditional to all of them; seed 8 routes the
    // endpoint through the gateway shim; seed 10 adds the quota probe; seed 11
    // says the model can be changed without a restart; seed 12 says a persona
    // reaches this agent through ACP `_meta` (nothing in the env changes, so
    // the probe cache is untouched — see `seedAgents`). One backfill applies all
    // of them, because an install stamped below 4 jumps straight here and never
    // sees the earlier rules on its own.
    backfill: (existing) => ({
      env: withGatewayUrl(withLongContextSuffix(withAliasModelKeys(withSmallModelVar(existing.env)))),
      quotaProbe: existing.quotaProbe ?? QUOTA_PROBES["claude-code"],
      liveConfig: existing.liveConfig ?? "acp",
      personaVia: existing.personaVia ?? "acp-meta",
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
    quotaProbe: QUOTA_PROBES["claude-code"],
    liveConfig: "acp",
    personaVia: "acp-meta",
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
    // Seed 10 adds the quota probe; seed 11 says a model change reaches this
    // agent through the shim rather than through a restart — see `liveConfig`,
    // and note that it is *because* the catalog key above turned out not to
    // change what codex will accept live.
    // Seed 12 adds `developer_instructions` — codex's own append-shaped
    // instruction slot, and the door a persona reaches it through. Not
    // `base_instructions`: that replaces codex's entire system prompt and is
    // not a ConfigToml key at all.
    since: 12,
    introduced: 2,
    backfill: (existing) => ({
      env: withCodexPersonaKey(withCodexGatewayUrl(withCodexCatalogKey(existing.env))),
      quotaProbe: existing.quotaProbe ?? QUOTA_PROBES.codex,
      liveConfig: existing.liveConfig ?? "gateway",
      personaVia: existing.personaVia ?? "env",
    }),
    id: "codex",
    name: "Codex",
    command: "codex-acp",
    args: [],
    spawnCategories: SPAWN_CATEGORIES,
    quotaProbe: QUOTA_PROBES.codex,
    liveConfig: "gateway",
    personaVia: "env",
    env: {
      CODEX_API_KEY: "{apiKey}",
      MODEL_PROVIDER: "{baseUrl?daedalus}",
      CODEX_CONFIG:
        '{"developer_instructions":"{personaPrompt}","model":"{model}","model_reasoning_effort":"{effort}","model_context_window":{contextWindow},"model_max_output_tokens":{maxOutputTokens},"model_catalog_json":"{codexModelCatalog}","model_provider":"{baseUrl?daedalus}","model_providers":{"daedalus":{"name":"{baseUrl?Daedalus gateway}","base_url":"{gatewayUrl}","env_key":"{baseUrl?CODEX_API_KEY}","wire_api":"{baseUrl?responses}"}}}',
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
    // Seed 12 adds `instructions`, which is how a persona reaches OpenCode. It
    // is a list of *file paths*, not text, so it takes `{personaFile}` and
    // `writePersonaPrompt` puts the prompt somewhere for it to point at.
    // Seed 13 enables OpenCode's permission bypass for the built-in template;
    // this is deliberately merged only when no permission policy exists.
    // Seed 16 declares the subagent feed (`subagentFeed`, see AgentDef). It
    // is a fact about the runtime, not a template key, so the backfill sets it
    // beside the row's env without touching the env — which is also why the
    // probe cache is left alone: nothing the agent advertises changed.
    since: 16,
    introduced: 1,
    backfill: (existing) => ({
      env: withOpencodeBypass(withOpencodePersonaKey(existing.env)),
      personaVia: existing.personaVia ?? "env",
      subagentFeed: existing.subagentFeed ?? "opencode-http",
    }),
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    args: ["acp"],
    spawnCategories: SPAWN_CATEGORIES,
    personaVia: "env",
    subagentFeed: "opencode-http",
    env: {
      DAEDALUS_OPENCODE_API_KEY: "{apiKey}",
      DAEDALUS_OPENCODE_BASE_URL: "{baseUrl?https://api.opencode.ai}",
      DAEDALUS_OPENCODE_MODEL: "{model}",
      OPENCODE_CONFIG_CONTENT:
        '{"permission":"allow","instructions":["{personaFile}"],"model":"{env:DAEDALUS_OPENCODE_MODEL}","provider":{"opencode":{"npm":"@ai-sdk/openai-compatible","name":"OpenCode","options":{"baseURL":"{env:DAEDALUS_OPENCODE_BASE_URL}","apiKey":"{env:DAEDALUS_OPENCODE_API_KEY}"}}}}',
    },
  },
  {
    // The harness's own agent: agent/ in this repo, an ACP agent on the Vercel
    // AI SDK speaking OpenAI-compatible chat completions to whatever endpoint
    // the profile names. Spawned as `node <repo>/agent/dist/index.js` — build
    // it with `pnpm --dir agent build`; a missing dist fails the spawn with an
    // ENOENT that surfaces in the thread. `liveConfig: "acp"` because it takes
    // model and effort over session/set_config_option and reads the
    // materialized allowlist in <cwd>/.claude/settings.local.json as its model
    // catalog; `personaVia: "env"` through {personaFile}, which is also what
    // makes `usesPersonaFile` write the prompt to disk. No quota probe: it has
    // no login of its own, only the profile's key. `{gatewayUrl}` keeps the
    // endpoint retargetable per request when the shim is up, and falls back to
    // the raw base URL (or prunes away entirely on the Default profile).
    // Seed 15 adds DAEDALUS_AGENT_PROJECT_INSTRUCTIONS — the documented off
    // switch for the agent's AGENTS.md/CLAUDE.md walk (agent/src/env.ts). It is
    // a literal, not a placeholder: nothing on a profile decides it, it exists
    // in the template so Settings › Agents has a key to flip to "0". The
    // backfill merges it only where absent, so an edited row keeps its value.
    since: 15,
    introduced: 14,
    backfill: (existing) => ({
      env: { DAEDALUS_AGENT_PROJECT_INSTRUCTIONS: "1", ...existing.env },
    }),
    id: "daedalus",
    name: "Daedalus Agent",
    command: "node",
    args: ["{daedalusAgentEntry}"],
    spawnCategories: SPAWN_CATEGORIES,
    liveConfig: "acp",
    personaVia: "env",
    env: {
      DAEDALUS_AGENT_API_KEY: "{apiKey}",
      DAEDALUS_AGENT_BASE_URL: "{gatewayUrl}",
      DAEDALUS_AGENT_MODEL: "{model}",
      DAEDALUS_AGENT_SMALL_MODEL: "{smallModel}",
      DAEDALUS_AGENT_EFFORT: "{effort}",
      DAEDALUS_AGENT_CONTEXT_WINDOW: "{contextWindow}",
      DAEDALUS_AGENT_MAX_OUTPUT_TOKENS: "{maxOutputTokens}",
      DAEDALUS_AGENT_PERSONA_FILE: "{personaFile}",
      DAEDALUS_AGENT_PROJECT_INSTRUCTIONS: "1",
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
        .values({
          ...agent,
          spawnCategories: agent.spawnCategories ?? null,
          quotaProbe: agent.quotaProbe ?? null,
          liveConfig: agent.liveConfig ?? null,
          personaVia: agent.personaVia ?? null,
          subagentFeed: agent.subagentFeed ?? null,
          seededVersion: since,
        })
        .run();
      continue;
    }
    /* The row is older than this seed release — an install that already had
       this agent before the field existed. Stamp it as offered, and fill in
       only what the release ADDED. Never name, command, args or env wholesale:
       those are the fields a user edits, and silently replacing them is how a
       harness loses someone's gateway configuration. A release that adds a
       single key inside one of them says so with `backfill`. */
    const added = backfill?.(existing);
    db.update(agentsTable)
      .set({
        seededVersion: since,
        spawnCategories: existing.spawnCategories ?? agent.spawnCategories ?? null,
        quotaProbe: existing.quotaProbe ?? agent.quotaProbe ?? null,
        liveConfig: existing.liveConfig ?? agent.liveConfig ?? null,
        personaVia: existing.personaVia ?? agent.personaVia ?? null,
        subagentFeed: existing.subagentFeed ?? agent.subagentFeed ?? null,
        ...added,
      })
      .where(eq(agentsTable.id, agent.id))
      .run();
    /* The probe's cached answer was recorded by the old spawn, and a release
       that rewrites the env is exactly what changes it — a real catalog is what
       makes Codex advertise an effort selector for a gateway model at all. So
       the drop follows the env and nothing else: what an agent advertises is a
       function of the environment it was spawned in, and a release that only
       adds a field *beside* the env has changed nothing the agent would answer
       differently. (Seed 10 adds the quota probe, but both its rows share a
       backfill that also recomputes the env, so they still re-probe once.) */
    if (added?.env) db.delete(agentOptions).where(like(agentOptions.key, `%:${agent.id}:%`)).run();
  }
}

export function listAgents(): AgentDef[] {
  return db.select().from(agentsTable).all();
}

/**
 * The editable half of an agent row.
 *
 * Exactly the four fields the seed rules already treat as the user's — a
 * backfill adds keys a release introduces and never replaces `name`, `command`,
 * `args` or `env` — so an edit made here survives every future release for the
 * same reason a hand-edited `agents.json` always did. The declarative fields
 * beside them (`spawnCategories`, `liveConfig`, `personaVia`, `quotaProbe`) are
 * statements about what the protocol on the other end can do, not preferences:
 * telling the harness an agent takes a live model change does not make it take
 * one, so they stay the seed's and are not offered.
 */
export const AgentInputSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string().min(1), z.string()).default({}),
});
export type AgentInput = z.infer<typeof AgentInputSchema>;

/* The probe cache is keyed `profileId:agentId:cwd` and its answer is a function
   of the env this agent is spawned with — the same reason `seedAgents` evicts
   after a backfill and `updateProfile` evicts on save. Without this an edited
   command keeps answering the draft menu from the old binary until someone
   finds `?refresh=1`. */
function evictProbeCache(id: string): void {
  db.delete(agentOptions).where(like(agentOptions.key, `%:${id}:%`)).run();
}

/** Write the user's half of an agent row. A live thread keeps the process it
    already has — the edit reaches it at its next spawn, like every other change
    to how an agent is launched. */
export function updateAgent(id: string, input: AgentInput): AgentDef | undefined {
  const existing = db.select().from(agentsTable).where(eq(agentsTable.id, id)).get();
  if (!existing) return undefined;
  db.update(agentsTable).set(input).where(eq(agentsTable.id, id)).run();
  evictProbeCache(id);
  return getAgent(id);
}

/** Put a built-in back the way it ships, for the edit that turned out to be
    wrong. Only a built-in has a default to return to; an agent this release
    does not define answers undefined, which the route reads as a 404.

    Every nullable column is named explicitly, `?? null` and all. Drizzle drops
    an `undefined` from a `.set()`, so spreading a seed that simply omits
    `quotaProbe` or `liveConfig` would *keep* whatever the row holds — and a
    reset that leaves a field behind is the one thing this function must not
    do. `seededVersion` is deliberately not among them: it is how far the seed
    has carried this install, not part of the agent's definition, and rewinding
    it would make the next boot replay backfills the row has already had. */
export function resetAgent(id: string): AgentDef | undefined {
  const seed = DEFAULT_AGENTS.find((a) => a.id === id);
  if (!seed) return undefined;
  const existing = db.select().from(agentsTable).where(eq(agentsTable.id, id)).get();
  if (!existing) return undefined;
  db.update(agentsTable)
    .set({
      name: seed.name,
      command: seed.command,
      args: seed.args,
      env: seed.env,
      spawnCategories: seed.spawnCategories ?? null,
      liveConfig: seed.liveConfig ?? null,
      quotaProbe: seed.quotaProbe ?? null,
      personaVia: seed.personaVia ?? null,
      subagentFeed: seed.subagentFeed ?? null,
    })
    .where(eq(agentsTable.id, id))
    .run();
  evictProbeCache(id);
  return getAgent(id);
}

/** Whether this id is one this release ships a default for — what tells the UI
    a Reset is on offer. */
export function isBuiltInAgent(id: string): boolean {
  return DEFAULT_AGENTS.some((a) => a.id === id);
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

/* ── The model id an agent is told, vs the one the harness records ──
 *
 * They differ in exactly one way, and only for Claude Code: the 1M window is
 * opted into by a `[1m]` suffix on the id rather than by a number (see
 * `LONG_CONTEXT_SUFFIX`). The env template appends it through `{longContext?…}`
 * at spawn, so the same rule has to be available to everything that names a
 * model to a *running* agent — the live model change and the allowlist the
 * picker is built from. The session row keeps the catalog's own id either way:
 * it is what the profile lists and what every menu matches against.
 */

/** Does this profile's entry for `modelId` ask for the 1M suffix? Empty for an
    id that already carries it — `sonnet[1m][1m]` names nothing. */
function wantsLongContext(profile: Profile, modelId: string): boolean {
  const meta = profile.models?.find((m) => m.id === modelId);
  return (meta?.contextWindow ?? 0) >= 1_000_000 && !modelId.endsWith(LONG_CONTEXT_MARKER);
}

/** Whether this agent's env spells a model with the 1M conditional at all —
    the same "ask the template, don't match on the agent's id" rule
    `resolveSpawn` uses for the Codex catalog. */
function usesLongContext(agent: AgentDef): boolean {
  return Object.values(agent.env).some((t) => t.includes(LONG_CONTEXT_SUFFIX));
}

/** The id to hand this agent for one of the profile's models. */
export function agentModelId(agent: AgentDef, profile: Profile, modelId: string): string {
  if (!modelId || !usesLongContext(agent)) return modelId;
  return wantsLongContext(profile, modelId) ? modelId + LONG_CONTEXT_MARKER : modelId;
}

/** The catalog id behind an id an agent reported back. Only ever strips a
    suffix this profile would itself have added: a catalog whose ids genuinely
    end in `[1m]` keeps them, because the stripped form names nothing there. */
export function bareModelId(profile: Profile, modelId: string): string {
  if (!modelId.endsWith(LONG_CONTEXT_MARKER)) return modelId;
  if (profile.models?.some((m) => m.id === modelId)) return modelId;
  const stripped = modelId.slice(0, -LONG_CONTEXT_MARKER.length);
  return profile.models?.some((m) => m.id === stripped) ? stripped : modelId;
}

/**
 * Every model id this agent might be asked to run, across every profile that
 * can spawn it — what `materializeModelAllowlist` writes where Claude Code
 * looks for its `availableModels`.
 *
 * The union, deliberately, and not the one profile the thread is on: the
 * allowlist is read once at `session/new` and a thread outlives its profile
 * choice, so a list scoped to the spawning profile would make the *next*
 * profile's models unreachable without the restart this whole path exists to
 * avoid. Nothing is leaked by the width of it — an id is not a credential, and
 * only the harness's own menus ever pick one.
 *
 * `spawning` is the exception the union cannot express: `availableModels` is a
 * *replacement*, not an addition — Claude Code's picker offers exactly what is
 * in it — so a profile that overrides nothing must impose nothing, or the
 * Default profile (which is the agent on its own subscription, and which
 * deliberately has no `models[]`) opens a menu of some gateway's ids and none
 * of the agent's own. Empty here means the key is dropped and the agent keeps
 * its built-in list. Nothing is lost by narrowing it: a move on or off a
 * profile with no catalog is exactly the case `applyConfig` will not do live,
 * so the next profile's ids are written by the respawn that carries the thread
 * there.
 */
export function modelAllowlistFor(agent: AgentDef, spawning: Profile, profiles: Profile[]): string[] {
  if (!spawning.models?.length) return [];
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (!profileSupports(profile, agent.id)) continue;
    for (const model of profile.models ?? []) ids.add(agentModelId(agent, profile, model.id));
  }
  return [...ids];
}

/** Resolve an agent definition against a profile (agent config) + project (workspace). */
export function resolveSpawn(
  agent: AgentDef,
  profile: Profile,
  project: Project,
  model?: string,
  effort?: string,
  /** The thread being spawned for, when there is one — see `gatewayUrlFor`. */
  sessionId?: string,
  /** The thread's persona, for an agent that takes one through its env. Absent
      for a thread with no persona, for the probe (which opens no session), and
      for an `"acp-meta"` agent, whose persona travels in the ACP handshake
      instead — see `AgentDef.personaVia`. */
  persona?: PersonaSpawn,
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
      gatewayUrlFor(profile.id, agent.id, profileBaseUrl(profile, agent.id), sessionId) ||
      profileBaseUrl(profile, agent.id),
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
    longContext: wantsLongContext(profile, resolvedModel) ? "1" : "",
    contextWindow: modelMeta?.contextWindow ? String(modelMeta.contextWindow) : "null",
    maxOutputTokens: modelMeta?.maxOutputTokens ? String(modelMeta.maxOutputTokens) : "null",
    cwd: project.cwd,
    daedalusAgentEntry: DAEDALUS_AGENT_ENTRY,
    /* JSON-escaped, and only ever correct inside a JSON string literal — which
       is the only place a template names it. A persona is multi-line prose with
       quotes and apostrophes in it; substituted raw, it closed the string it
       was sitting in and CODEX_CONFIG stopped being parseable, at which point
       `resolveEnvValue` passes the wreckage through unpruned. `JSON.stringify`
       gives the escaped form; the slice drops the quotes the template already
       has. */
    [PERSONA_PROMPT_VAR]: persona ? JSON.stringify(persona.prompt).slice(1, -1) : "",
    /* Written by the caller, not here: it is one file per *session*, and this
       function is also called by the probe, which has no session. An agent that
       wants the file and a caller that did not write one resolve empty, and the
       key prunes away like every other unset one. */
    [PERSONA_FILE_VAR]: persona?.file ?? "",
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
