import { desc, eq } from "drizzle-orm";
import { agents as agentsTable, db } from "./db/index.js";
import type { Profile } from "./profiles.js";
import type { Project } from "./projects.js";

/**
 * An ACP agent definition. `args`/`env` values may contain {placeholders}
 * resolved from the active profile: {apiKey} {baseUrl} {model} {cwd}.
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

/** A default agent, plus the seed release that introduced it. Give a new
    default the next unused `since` and installs pick it up — see `seedAgents`. */
type SeedAgent = AgentDef & { since: number };

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
    since: 1,
    id: "claude-code",
    name: "Claude Code",
    command: "claude-agent-acp",
    args: [],
    env: {
      ANTHROPIC_API_KEY: "{apiKey}",
      ANTHROPIC_BASE_URL: "{baseUrl}",
      ANTHROPIC_MODEL: "{model}",
    },
    spawnCategories: SPAWN_CATEGORIES,
  },
  {
    // Official ACP adapter for OpenAI Codex. Auth: CODEX_API_KEY, or ChatGPT
    // OAuth (`codex login`) when no key is set. Model/effort/base-URL flow
    // through CODEX_CONFIG (JSON merged into the Codex session config): a
    // profile Base URL generates a "daedalus" model_providers entry; with no
    // base URL the whole block prunes away and Codex uses its default
    // provider. wire_api is "responses" — edit to "chat" for
    // chat-completions-only gateways.
    // MODEL_PROVIDER repeats the choice because codex-acp's session/load path
    // (getResumeModelProvider) ignores CODEX_CONFIG.model_provider and falls
    // back to "openai" — without it every revived thread 401s on api.openai.com.
    since: 1,
    id: "codex",
    name: "Codex",
    command: "codex-acp",
    args: [],
    spawnCategories: SPAWN_CATEGORIES,
    env: {
      CODEX_API_KEY: "{apiKey}",
      MODEL_PROVIDER: "{baseUrl?daedalus}",
      CODEX_CONFIG:
        '{"model":"{model}","model_reasoning_effort":"{effort}","model_context_window":{contextWindow},"model_max_output_tokens":{maxOutputTokens},"model_provider":"{baseUrl?daedalus}","model_providers":{"daedalus":{"name":"{baseUrl?Daedalus gateway}","base_url":"{baseUrl}","env_key":"{baseUrl?CODEX_API_KEY}","wire_api":"{baseUrl?responses}"}}}',
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
  for (const { since, ...agent } of DEFAULT_AGENTS) {
    if (since <= applied) continue;
    const existing = db.select().from(agentsTable).where(eq(agentsTable.id, agent.id)).get();
    if (!existing) {
      db.insert(agentsTable)
        .values({ ...agent, spawnCategories: agent.spawnCategories ?? null, seededVersion: since })
        .run();
      continue;
    }
    /* The row is older than this seed release — an install that already had
       this agent before the field existed. Stamp it as offered, and fill in
       only what the release ADDED. Never name, command, args or env: those are
       the fields a user edits, and silently replacing them is how a harness
       loses someone's gateway configuration. */
    db.update(agentsTable)
      .set({
        seededVersion: since,
        spawnCategories: existing.spawnCategories ?? agent.spawnCategories ?? null,
      })
      .where(eq(agentsTable.id, agent.id))
      .run();
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
    baseUrl: profile.baseUrl ?? "",
    model: resolvedModel,
    effort: effort ?? "",
    contextWindow: modelMeta?.contextWindow ? String(modelMeta.contextWindow) : "null",
    maxOutputTokens: modelMeta?.maxOutputTokens ? String(modelMeta.maxOutputTokens) : "null",
    cwd: project.cwd,
  };
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
