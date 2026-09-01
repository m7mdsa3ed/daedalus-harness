import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type * as acp from "@agentclientprotocol/sdk";
import type { ModelMessage } from "ai";
import { EFFORTS, type AgentEnv, type Effort } from "./env.js";
import type { McpHandle } from "./mcp.js";
import type { CommandDef, SkillDef } from "./commands.js";

export type ModeId = "default" | "acceptEdits" | "bypassPermissions" | "plan";

export const MODES: acp.SessionMode[] = [
  { id: "default", name: "Always ask", description: "Ask before edits and commands" },
  { id: "acceptEdits", name: "Accept edits", description: "Edits run without asking; commands still ask" },
  { id: "bypassPermissions", name: "Bypass permissions", description: "Run everything without asking" },
  { id: "plan", name: "Plan mode", description: "Read-only: explore and propose a plan" },
];

const EFFORT_NAMES: Record<Effort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
};

export interface SteerEntry {
  messages: ModelMessage[];
}

export class Session {
  id: string;
  cwd: string;
  mode: ModeId;
  modelId: string;
  /** Model ids offered by the select — the harness's materialized allowlist ∪ the spawned model. */
  models: string[];
  effort: Effort | null;
  autoCompact: boolean;
  messages: ModelMessage[];
  /** Prompts that arrived mid-turn; drained into the next model step. */
  steerQueue: SteerEntry[];
  abort: AbortController | null;
  turnActive: boolean;
  /** Sticky per-tool permission answers ("always allow/reject" for this session). */
  alwaysAllow: Set<string>;
  alwaysReject: Set<string>;
  mcp: McpHandle | null;
  commands: CommandDef[];
  skills: SkillDef[];
  /** Whether to read the workspace's own AGENTS.md / CLAUDE.md at all
      (`DAEDALUS_AGENT_PROJECT_INSTRUCTIONS`). */
  projectInstructions: boolean;
  /** Where `~/.claude/CLAUDE.md` is looked for. The OS home, held on the
      session rather than read at the point of use so a test can point the scan
      at a tree it controls. */
  instructionsHome: string;
  personaText: string | null;
  title: string | null;
  /** Last request's total token reading — what compaction thresholds against. */
  lastTokens: number;

  constructor(id: string, cwd: string, env: AgentEnv) {
    this.id = id;
    this.cwd = cwd;
    this.mode = "default";
    this.modelId = env.model;
    this.models = readModelAllowlist(cwd, env.model);
    this.effort = env.effort;
    this.autoCompact = true;
    this.messages = [];
    this.steerQueue = [];
    this.abort = null;
    this.turnActive = false;
    this.alwaysAllow = new Set();
    this.alwaysReject = new Set();
    this.mcp = null;
    this.commands = [];
    this.skills = [];
    this.projectInstructions = env.projectInstructions;
    this.instructionsHome = homedir();
    this.personaText = env.personaFile ? readOptional(env.personaFile) : null;
    this.title = null;
    this.lastTokens = 0;
  }

  modeState(): acp.SessionModeState {
    return { currentModeId: this.mode, availableModes: MODES };
  }

  configOptions(booleanCapable: boolean): acp.SessionConfigOption[] {
    const options: acp.SessionConfigOption[] = [];
    if (this.modelId) {
      options.push({
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: this.modelId,
        options: this.models.map((m) => ({ value: m, name: m })),
      });
    }
    options.push({
      type: "select",
      id: "effort",
      name: "Reasoning effort",
      category: "thought_level",
      currentValue: this.effort ?? "default",
      options: [
        { value: "default", name: "Default", description: "Provider default" },
        ...EFFORTS.map((e) => ({ value: e, name: EFFORT_NAMES[e] })),
      ],
    });
    if (booleanCapable) {
      options.push({
        type: "boolean",
        id: "autoCompact",
        name: "Auto-compact",
        description: "Summarize the conversation when it nears the context window",
        currentValue: this.autoCompact,
      });
    }
    return options;
  }

  /** Applies a set_config_option request; returns false for an unknown id/value. */
  setConfig(request: acp.SetSessionConfigOptionRequest): boolean {
    if (request.configId === "model" && typeof request.value === "string") {
      if (!this.models.includes(request.value)) return false;
      this.modelId = request.value;
      return true;
    }
    if (request.configId === "effort" && typeof request.value === "string") {
      if (request.value === "default") {
        this.effort = null;
        return true;
      }
      if (!EFFORTS.includes(request.value as Effort)) return false;
      this.effort = request.value as Effort;
      return true;
    }
    if (request.configId === "autoCompact" && typeof request.value === "boolean") {
      this.autoCompact = request.value;
      return true;
    }
    return false;
  }

  cancel(): void {
    this.abort?.abort();
  }
}

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/* The harness (liveConfig: "acp") materializes the union of every profile's
   catalog into <cwd>/.claude/settings.local.json `availableModels` — reading
   it back is what makes the model select offer more than the spawned id, and
   what `offersModel` on the server checks before a live switch. */
export function readModelAllowlist(cwd: string, spawned: string): string[] {
  const ids = new Set<string>();
  if (spawned) ids.add(spawned);
  try {
    const raw = JSON.parse(readFileSync(join(cwd, ".claude", "settings.local.json"), "utf8")) as {
      availableModels?: unknown;
    };
    if (Array.isArray(raw.availableModels)) {
      for (const entry of raw.availableModels) {
        if (typeof entry === "string") ids.add(entry);
        else if (entry && typeof entry === "object" && typeof (entry as { value?: unknown }).value === "string") {
          ids.add((entry as { value: string }).value);
        }
      }
    }
  } catch {
    // No file, or not JSON — the spawned model is the whole list.
  }
  return [...ids];
}
