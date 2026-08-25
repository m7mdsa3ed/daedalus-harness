import { join } from "node:path";
import { DATA_DIR, readJson, writeJson } from "./config.js";
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
}

const AGENTS_PATH = join(DATA_DIR, "agents.json");

const DEFAULT_AGENTS: AgentDef[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    env: {
      ANTHROPIC_API_KEY: "{apiKey}",
      ANTHROPIC_BASE_URL: "{baseUrl}",
      ANTHROPIC_MODEL: "{model}",
    },
  },
  {
    // Official ACP adapter for OpenAI Codex. Auth: CODEX_API_KEY, or ChatGPT
    // OAuth (`codex login`) when no key is set. Model/effort/base-URL flow
    // through CODEX_CONFIG (JSON merged into the Codex session config): a
    // profile Base URL generates a "daedalus" model_providers entry; with no
    // base URL the whole block prunes away and Codex uses its default
    // provider. wire_api is "responses" — edit to "chat" for
    // chat-completions-only gateways.
    id: "codex",
    name: "Codex",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp"],
    env: {
      CODEX_API_KEY: "{apiKey}",
      CODEX_CONFIG:
        '{"model":"{model}","model_reasoning_effort":"{effort}","model_provider":"{baseUrl?daedalus}","model_providers":{"daedalus":{"name":"{baseUrl?Daedalus gateway}","base_url":"{baseUrl}","env_key":"{baseUrl?CODEX_API_KEY}","wire_api":"{baseUrl?responses}"}}}',
    },
  },
];

export function listAgents(): AgentDef[] {
  const agents = readJson<AgentDef[]>(AGENTS_PATH, []);
  if (agents.length === 0) {
    writeJson(AGENTS_PATH, DEFAULT_AGENTS);
    return DEFAULT_AGENTS;
  }
  return agents;
}

export function getAgent(id: string): AgentDef | undefined {
  return listAgents().find((a) => a.id === id);
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
