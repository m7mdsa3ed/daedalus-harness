import { homedir } from "node:os";
import { join } from "node:path";

export type Effort = "minimal" | "low" | "medium" | "high" | "xhigh";
export const EFFORTS: Effort[] = ["minimal", "low", "medium", "high", "xhigh"];

/** One row of `DAEDALUS_AGENT_MODEL_ROLES`: a free-form helper-model tag a
    subagent may be spawned on. `id` is what assignments point at, `label` is
    what a person reads, `model` is the resolved model id (`""` when the role is
    unassigned, meaning the session model). */
export interface ModelRole {
  id: string;
  label: string;
  description: string;
  model: string;
}

export interface AgentEnv {
  apiKey: string | null;
  baseUrl: string | null;
  model: string;
  smallModel: string;
  effort: Effort | null;
  /** The *spawn* model's window, and the fallback for any model the map below
      has no entry for. Not the reading to threshold against on its own — see
      `modelWindows`. */
  contextWindow: number | null;
  maxOutputTokens: number | null;
  /** Every model this profile offers, by id → `[contextWindow, maxOutput]`.
      The model is a *live* setting (`Session.setConfig`) while env is read once
      at spawn, so a single `contextWindow` describes whichever model the thread
      happened to start on: switching a live thread to a 1M model pinned the
      ring at 100%, and switching down to a small one meant it never compacted
      until the provider refused the request. The whole map ships at spawn so
      nothing has to be pushed after one. */
  modelWindows: Record<string, [context: number, maxOutput: number]>;
  /** Input modalities by model id (`["text","image"]`), off the same map's
      third element. A model absent here is one the catalog says nothing about. */
  modelModalities: Record<string, string[]>;
  /** Named helper models a subagent may run on (the `task` tool's `role`), in
      the vocabulary's order, by id → `{ label, description, model }`. `model`
      is the profile's first model carrying the role (already resolved, catalog
      suffix and all), or `""` for an unassigned role — which falls back to the
      session model. Fixed at spawn: a subagent is the same process, so an
      assignment change costs a respawn like any spawn-time profile fact. Empty
      when the profile names none, and the `task` tool then advertises none. */
  modelRoles: ModelRole[];
  personaFile: string | null;
  /** Path to the model-prompt library (`{version, entries:[{match, prompt}]}`),
      re-read every turn so a library edit or a live model change lands on the
      next pass. Absent: the built-in family calibrations stand alone. */
  modelPromptsFile: string | null;
  /** Read AGENTS.md / CLAUDE.md from the workspace. Off with `0`/`false`. */
  projectInstructions: boolean;
  /** Send `prompt_cache_key` so a router keeps a thread on one backend. Off with `0`/`false`. */
  promptCacheKey: boolean;
  /** Whether a failed turn holds at a step boundary instead of ending, waiting
      for a model change and a resume (`hold.ts`). Off with `0`/`false` — which
      is what the harness spawns a thread with nobody in front of it as, since
      a hold there would wait forever. */
  holdOnError: boolean;
  /** Name a thread from its first message with the small model (`title.ts`). Off with `0`/`false`. */
  autoTitle: boolean;
  home: string;
}

/* The harness prunes env keys that resolve empty, and its unquoted-JSON
   placeholders ({contextWindow}, {maxOutputTokens}) resolve to the literal
   string "null" when the catalog has no answer — both spell "unset" here. */
function str(v: string | undefined): string | null {
  if (v === undefined || v === "" || v === "null") return null;
  return v;
}

function num(v: string | undefined): number | null {
  const s = str(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/* A malformed map is treated as an absent one: the window falls back to the
   spawn model's single figure, which is what this replaced. A gauge is not
   worth failing a spawn over. */
function windows(v: string | undefined): AgentEnv["modelWindows"] {
  const s = str(v);
  if (s === null) return {};
  try {
    const raw: unknown = JSON.parse(s);
    if (!raw || typeof raw !== "object") return {};
    const out: AgentEnv["modelWindows"] = {};
    for (const [id, pair] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(pair)) continue;
      const [ctx, max] = pair;
      if (typeof ctx !== "number" || !Number.isFinite(ctx) || ctx <= 0) continue;
      out[id] = [ctx, typeof max === "number" && Number.isFinite(max) && max > 0 ? max : 0];
    }
    return out;
  } catch {
    return {};
  }
}

function modalities(v: string | undefined): AgentEnv["modelModalities"] {
  const s = str(v);
  if (s === null) return {};
  try {
    const raw: unknown = JSON.parse(s);
    if (!raw || typeof raw !== "object") return {};
    const out: AgentEnv["modelModalities"] = {};
    for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
      const list = Array.isArray(entry) ? entry[2] : undefined;
      if (Array.isArray(list)) out[id] = list.filter((m): m is string => typeof m === "string");
    }
    return out;
  } catch {
    return {};
  }
}

/* The roles list, shaped like `windows()`'s contract: a malformed entry is a
   dropped entry, a malformed list an empty one. A role worth failing a spawn
   over is not one the harness would have shipped, and an unparsed table only
   costs the `task` tool an advert it should not have made. */
function roles(v: string | undefined): ModelRole[] {
  const s = str(v);
  if (s === null) return [];
  try {
    const raw: unknown = JSON.parse(s);
    if (!Array.isArray(raw)) return [];
    const out: ModelRole[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.id !== "string" || e.id === "") continue;
      out.push({
        id: e.id,
        label: typeof e.label === "string" && e.label !== "" ? e.label : e.id,
        description: typeof e.description === "string" ? e.description : "",
        model: typeof e.model === "string" ? e.model : "",
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): AgentEnv {
  const model = str(env.DAEDALUS_AGENT_MODEL) ?? "";
  const effortRaw = str(env.DAEDALUS_AGENT_EFFORT);
  return {
    apiKey: str(env.DAEDALUS_AGENT_API_KEY),
    baseUrl: str(env.DAEDALUS_AGENT_BASE_URL),
    model,
    smallModel: str(env.DAEDALUS_AGENT_SMALL_MODEL) ?? model,
    effort: EFFORTS.includes(effortRaw as Effort) ? (effortRaw as Effort) : null,
    contextWindow: num(env.DAEDALUS_AGENT_CONTEXT_WINDOW),
    maxOutputTokens: num(env.DAEDALUS_AGENT_MAX_OUTPUT_TOKENS),
    modelWindows: windows(env.DAEDALUS_AGENT_MODEL_WINDOWS),
    modelModalities: modalities(env.DAEDALUS_AGENT_MODEL_WINDOWS),
    modelRoles: roles(env.DAEDALUS_AGENT_MODEL_ROLES),
    personaFile: str(env.DAEDALUS_AGENT_PERSONA_FILE),
    modelPromptsFile: str(env.DAEDALUS_AGENT_MODEL_PROMPTS_FILE),
    projectInstructions: !["0", "false", "off"].includes(
      (str(env.DAEDALUS_AGENT_PROJECT_INSTRUCTIONS) ?? "").toLowerCase(),
    ),
    promptCacheKey: !["0", "false", "off"].includes(
      (str(env.DAEDALUS_AGENT_PROMPT_CACHE_KEY) ?? "").toLowerCase(),
    ),
    holdOnError: !["0", "false", "off"].includes(
      (str(env.DAEDALUS_AGENT_HOLD_ON_ERROR) ?? "").toLowerCase(),
    ),
    autoTitle: !["0", "false", "off"].includes((str(env.DAEDALUS_AGENT_TITLES) ?? "").toLowerCase()),
    home: str(env.DAEDALUS_AGENT_HOME) ?? join(homedir(), ".daedalus-agent"),
  };
}
