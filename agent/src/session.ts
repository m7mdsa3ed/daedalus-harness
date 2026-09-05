import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type * as acp from "./acp.js";
import type { ModelMessage } from "ai";
import { EFFORTS, type AgentEnv, type Effort } from "./env.js";
import type { McpHandle } from "./mcp.js";
import type { CommandDef, SkillDef } from "./commands.js";
import type { ErrorHold, Release } from "./hold.js";

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
  /** A pause the harness asked for (`_daedalus/session/pause`). Read by the
      gate every model step passes through, so a paused turn stops at the next
      step boundary with nothing thrown away, and a paused session's next
      prompt waits at its first step. Cleared by `resume()` and by `cancel()`:
      a cancel abandons the turn, and a pause is part of what it abandons. */
  paused: boolean;
  /** A turn that failed and is waiting to be told what to try instead, rather
      than ending and throwing its tool calls away (`hold.ts`). The second
      thing that holds the loop, and deliberately independent of `paused`: one
      is the user's toggle and the other is the turn's own state, so neither
      can silently clear the other. `held` is what the gate reads. */
  errorHold: ErrorHold | null;
  /** Whether a failed turn holds at all. False for a thread with nobody in
      front of it — a workflow step, a scheduled run — where a hold would wait
      forever for a model change no one is going to make, and failing fast is
      the answer the run needs. */
  holdOnError: boolean;
  private resumeWaiters: ((release: Release) => void)[];
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
  /** Files this session has read, and the mtime it read them at. An edit that
      cannot find its `old_string` is usually an edit written from memory, so
      the fs tools use this to say *why* — never read, or read before someone
      else changed it — instead of "not found". */
  readFiles: Map<string, number>;

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
    this.paused = false;
    this.errorHold = null;
    this.holdOnError = env.holdOnError;
    this.resumeWaiters = [];
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
    this.readFiles = new Map();
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

  /** Whether anything is holding the loop — the user's pause, a failed turn,
      or both. One question, so a new reason to hold never needs a new gate. */
  get held(): boolean {
    return this.paused || this.errorHold !== null;
  }

  cancel(): void {
    this.paused = false;
    this.errorHold = null;
    this.abort?.abort();
    this.release("cancelled");
  }

  pause(): void {
    this.paused = true;
  }

  /** Lets go of both reasons. A resume is the user saying "carry on", and they
      are not asked which of the two holds they meant. */
  resume(): void {
    this.paused = false;
    this.errorHold = null;
    this.release("released");
  }

  /**
   * Hold a turn that failed, and answer how the wait ended.
   *
   * **It resolves; it never throws.** A cancel here has to end the turn as
   * `stopReason: "cancelled"` — the same clean ending a cancel has always had —
   * and an exception would travel to the turn's outer catch and end it as a
   * failure instead, which is a red card for a Stop the user pressed.
   */
  async holdError(hold: ErrorHold, signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) return "cancelled";
    this.errorHold = hold;
    while (this.errorHold !== null) {
      const release = await this.waitForRelease(signal);
      if (release === "cancelled" || signal?.aborted) {
        this.errorHold = null;
        return "cancelled";
      }
    }
    return "released";
  }

  /**
   * The step boundary. Returns at once while the session is running; while it
   * is held, waits for `resume()` — or for the turn's abort, which ends the
   * wait as a cancellation (the SDK's own abort shape, so the stream reads it
   * as `aborted` rather than as a failure). Nothing is retried or replayed
   * around it: the step before it finished whole, and the one after it has not
   * begun, which is what makes this a pause and not an interrupt.
   */
  async gate(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError();
    /* A loop, not an `if`: two things can hold this, so being let go of once
       does not mean being let go of. */
    while (this.held) {
      await this.waitForRelease(signal);
      if (signal?.aborted) throw abortError();
    }
  }

  private waitForRelease(signal?: AbortSignal): Promise<Release> {
    return new Promise<Release>((resolve) => {
      const done = (release: Release) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(release);
      };
      const onAbort = () => done("cancelled");
      this.resumeWaiters.push(done);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private release(release: Release): void {
    for (const w of this.resumeWaiters.splice(0)) w(release);
  }
}

function abortError(): Error {
  const err = new Error("The turn was cancelled while paused.");
  err.name = "AbortError";
  return err;
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
