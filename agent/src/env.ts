import { homedir } from "node:os";
import { join } from "node:path";

export type Effort = "minimal" | "low" | "medium" | "high" | "xhigh";
export const EFFORTS: Effort[] = ["minimal", "low", "medium", "high", "xhigh"];

export interface AgentEnv {
  apiKey: string | null;
  baseUrl: string | null;
  model: string;
  smallModel: string;
  effort: Effort | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  personaFile: string | null;
  /** Read AGENTS.md / CLAUDE.md from the workspace. Off with `0`/`false`. */
  projectInstructions: boolean;
  /** Send `prompt_cache_key` so a router keeps a thread on one backend. Off with `0`/`false`. */
  promptCacheKey: boolean;
  /** Whether a failed turn holds at a step boundary instead of ending, waiting
      for a model change and a resume (`hold.ts`). Off with `0`/`false` — which
      is what the harness spawns a thread with nobody in front of it as, since
      a hold there would wait forever. */
  holdOnError: boolean;
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
    personaFile: str(env.DAEDALUS_AGENT_PERSONA_FILE),
    projectInstructions: !["0", "false", "off"].includes(
      (str(env.DAEDALUS_AGENT_PROJECT_INSTRUCTIONS) ?? "").toLowerCase(),
    ),
    promptCacheKey: !["0", "false", "off"].includes(
      (str(env.DAEDALUS_AGENT_PROMPT_CACHE_KEY) ?? "").toLowerCase(),
    ),
    holdOnError: !["0", "false", "off"].includes(
      (str(env.DAEDALUS_AGENT_HOLD_ON_ERROR) ?? "").toLowerCase(),
    ),
    home: str(env.DAEDALUS_AGENT_HOME) ?? join(homedir(), ".daedalus-agent"),
  };
}
