import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import { OPENUI_PROMPT } from "./openui-prompt.js";
import { usesPersonaFile, type AgentDef } from "./registry.js";
import { globalRules, projectRules, type Rule } from "./rules.js";
import type { TaskBrief } from "./task-threads.js";

/**
 * The spawn-instruction doors. Personas are gone (saved prompts replaced them,
 * `saved-prompts.ts`), but the machinery that carried a persona into each
 * runtime still carries the standing rules (rules.ts) and the thread's trailers
 * below — hence the historical `persona` names (`AgentDef.personaVia`,
 * `{personaPrompt}`, `{personaFile}`, `PersonaSpawn`), kept so no column,
 * template or user's agent row has to change.
 *
 *   - claude-agent-acp reads `_meta.systemPrompt` on `session/new`: `{append}`
 *     adds to the CLI's own prompt rather than replacing it.
 *   - codex reads `developer_instructions` out of its config, through the
 *     `CODEX_CONFIG` env template.
 *   - opencode reads `instructions`, a list of *file paths*, out of
 *     `OPENCODE_CONFIG_CONTENT` — hence `writePersonaPrompt` below.
 */

/* ── Reaching the agent ── */

/** The spawn instructions (rules + trailers; "persona" is the historical name).
    Resolved once so nothing downstream has to compose them. */
export interface PersonaSpawn {
  id: string;
  prompt: string;
  /** Where `prompt` was written for a runtime that will only read instructions
      off disk. Filled by `resolvePersonaSpawn` when — and only when — the
      agent's env template names `{personaFile}`. */
  file?: string;
}

/**
 * The thread's persona, ready to spawn with: the row resolved, and the prompt
 * written to disk if this agent is one that reads it from there.
 *
 * `rules` (see rules.ts) is the standing instruction items — global and project
 * layers already composed — folded in beneath the persona, so one text reaches
 * every door and no door learns rules exist. A thread with rules and no
 * persona spawns with just the rules.
 *
 * `agent` decides whether a file is written rather than the persona doing it
 * unconditionally, for the reason `resolveSpawn` gives about the Codex catalog:
 * it is a file write on every spawn, and a runtime that takes the text inline
 * has no use for it.
 */
export async function resolvePersonaSpawn(
  sessionId: string,
  agent: AgentDef | undefined,
  /** The thread's behaviour toggles — neither is a persona, both are folded
      into the same instruction text below. See `withInstructionTrailers`. */
  behaviour: ThreadBehaviour = {},
  rules?: Rule[],
): Promise<PersonaSpawn | undefined> {
  const rulesText = rules?.length ? rules.map((r) => r.content).join("\n\n") : undefined;
  const base: PersonaSpawn | undefined = rulesText ? { id: "rules", prompt: rulesText } : undefined;
  // Folded here rather than at the call site so the file below holds the same
  // text the inline doors carry — an agent that reads instructions off disk
  // must see the trailer too.
  const spawn = withInstructionTrailers(base, behaviour);
  // Called even when there is no spawn, so a thread that has just had one
  // taken away does not leave the old text on disk for the next spawn to point
  // at — see `writePersonaPrompt`.
  if (agent && usesPersonaFile(agent)) {
    const file = writePersonaPrompt(sessionId, spawn);
    if (spawn && file) spawn.file = file;
  }
  return spawn;
}

/* ── Follow-up suggestions ──
 *
 * A thread-level toggle rather than a persona: "offer me next prompts" is
 * orthogonal to "how to work". When on, the spawn's instruction text gains a
 * trailer asking the model to close each answer with 2–3 follow-up prompts in
 * one fenced block. The fence name is deliberately distinctive so the
 * client's parser never mistakes a real code block for suggestions — and the
 * client strips the block from the painted transcript, so the trailer must
 * say the block carries no prose, only the prompts.
 *
 * Applied by folding the trailer into the persona text (see
 * `withFollowupSuggestions`), so every runtime door — ACP `_meta` append,
 * `{personaPrompt}` inline, `{personaFile}` on disk — carries it with no
 * per-door change. */

/** Fence the model must wrap follow-up prompts in. Mirrored by the client's parser (`lib/suggestions.ts`). */
export const SUGGEST_FOLLOWUPS_FENCE = "suggest-prompts";

/** Trailer appended to the spawn instructions while a thread wants suggestions. */
export const SUGGEST_FOLLOWUPS_INSTRUCTIONS = `After your final answer, suggest 2-3 follow-up prompts the user might want to send next. Emit them as one fenced block named \`${SUGGEST_FOLLOWUPS_FENCE}\`, one prompt per line, with no other text inside the fence:

\`\`\`${SUGGEST_FOLLOWUPS_FENCE}
<first follow-up prompt>
<second follow-up prompt>
\`\`\`

Every prompt is a message the USER would type next, written so it can be sent as-is — a command or a question the user asks of you ("Show me the diff", "Merge the two servers via backup import", "What happens if two servers' projects conflict?"). Write them in the user's voice, never in yours. In particular, do not put your own questions to the user in the block: if you need their input to proceed, ask it in your answer's prose. Omit the block when no follow-up makes sense — for example when your answer has already asked the user what it needs to know, or nothing natural remains to suggest. Never put anything but follow-up prompts in it.`;

/* ── Drawn answers ──
 *
 * The other thread-level behaviour folded in at this seam, and it is the same
 * bargain as the suggestions trailer above: a toggle the thread owns, carried as
 * *instruction text* rather than as a capability of one runtime.
 *
 * That distinction is the point. Our own runtime could be told about this lane
 * with a `DAEDALUS_AGENT_*` variable, and it was — but a variable is a fact about
 * one agent, so any other runtime on a profile (Claude Code, Codex, whatever the
 * user repoints `command` at) would never be offered the lane at all. Going
 * through the persona door means the instructions ride the same three
 * deliveries every runtime already implements — ACP `_meta` append,
 * `{personaPrompt}` inline, `{personaFile}` on disk — so "the thread asked for
 * drawn answers" costs no per-runtime code and works everywhere.
 *
 * Two things stay where they were, deliberately:
 *   — `sessions.ui_blocks` remains a column, because it is also what the switch
 *     is drawn from;
 *   — the *rendering* is untouched by any of it. The client draws a fence
 *     whatever this says (see `ProseWithOpenui`), so a thread that never enabled
 *     the lane still renders one it is handed. */

/** The fence tag the client draws as a view. Mirrored by the client
    (`tool-parts.tsx`), which also accepts the bare `openui`. */
export const OPENUI_FENCE = "openui-lang";

/** What a thread's behaviour toggles and task fold into its instructions. */
export interface ThreadBehaviour {
  suggestFollowups?: boolean | null;
  uiBlocks?: boolean | null;
  /** The task the thread was started on, resolved at spawn so a respawn sees
      the card as it is now. */
  task?: TaskBrief | null;
}

/**
 * Trailer for a thread started on a board task. The task's own fields travel
 * through the `harness` MCP, so this says which task, which tools and when to
 * use them — and carries the column ids so moving the card needs no lookup.
 */
export function taskInstructions(task: TaskBrief): string {
  const columns = task.columns.map((c) => `${c.name} (${c.category}) = ${c.id}`).join("; ");
  return `## Your task on the board
This thread is working on task ${task.key}, "${task.title}" (id ${task.id}), now in "${task.status}". Use the harness MCP's harness_run:
- tasks_get {id} reads the description, checklist, comments and links. Read it before you start.
- tasks_comment {id, body} reports to the task: a short note when you hit something that changes the plan, and always one summary of what you did when you finish. Your name is added for you.
- tasks_update {id, statusId, ...} moves it. Columns: ${columns}. It moves to in-progress when you start; when the work is finished, move it to a done column, and never mark it done if you were stopped or are blocked (comment why instead).
Keep to this task. File a new one with tasks_create only for work you found that it does not cover.`;
}

/**
 * Trailer appended to the spawn instructions while a thread wants drawn answers.
 *
 * The component table IS here, generated from the client's own library
 * (`client/scripts/gen-openui.mjs` → `openui-prompt.ts`) — so the trailer is
 * self-contained exactly like the suggestions one, and every runtime on a
 * profile is told the same components the reader's app will draw. It used to
 * be a pointer, with the table pushed by our own runtime into its system prompt
 * — which meant every other runtime was told "this lane is not for you". */
export const OPENUI_INSTRUCTIONS = `## Drawing an answer

The client draws a fenced \`${OPENUI_FENCE}\` block as real UI, inline where the fence stood. It is a presentation lane and nothing else: nothing in it can read a file, run a command or reach the network — every tool call stays a normal tool call.

${OPENUI_PROMPT}`;

/**
 * The spawn instructions for a thread: its persona, plus a trailer for each
 * behaviour the thread turned on. Returns undefined when there is nothing to
 * instruct — the caller's placeholders resolve empty exactly as they do for a
 * thread with no persona.
 *
 * A list rather than a chain of `with…` folds. Each trailer is independent, so
 * the composition belongs in one place where the order is visible; the order
 * here is the order they read in, and suggestions stay last so the very end of
 * the instructions is still the follow-up block the client parses.
 */
export function withInstructionTrailers(
  persona: PersonaSpawn | undefined,
  behaviour: ThreadBehaviour,
): PersonaSpawn | undefined {
  const trailers: { id: string; text: string }[] = [];
  if (behaviour.task) trailers.push({ id: "task", text: taskInstructions(behaviour.task) });
  if (behaviour.uiBlocks) trailers.push({ id: "openui", text: OPENUI_INSTRUCTIONS });
  if (behaviour.suggestFollowups)
    trailers.push({ id: "suggestions", text: SUGGEST_FOLLOWUPS_INSTRUCTIONS });
  if (trailers.length === 0) return persona;

  /* Appended only where absent, and matched on the trailer itself: a thread
     whose persona happens to quote one of these is not a reason to send it
     twice, and a respawn must not double-append. */
  const fresh = trailers.filter((trailer) => !persona?.prompt.includes(trailer.text));
  if (fresh.length === 0) return persona;
  const joined = fresh.map((trailer) => trailer.text).join("\n\n");
  if (!persona) {
    // The thread's id becomes whichever behaviour is doing the instructing —
    // both is the only way to get here with no persona, and "behaviours" is the
    // honest name for text that is not one.
    return {
      id: fresh.length === 1 ? fresh[0]!.id : "behaviours",
      prompt: joined,
    };
  }
  return { ...persona, prompt: `${persona.prompt}\n\n${joined}` };
}

/* Where a persona's prompt goes when a runtime will only read one off disk.
   Beside the database in the gitignored data dir, exactly like the generated
   model catalogs — and deliberately NOT in the project's cwd, which is shared
   by every thread of the project: a per-session file written there is one the
   next thread's materialise sweep would either delete or inherit, which is the
   whole hazard `materializeFor` exists to manage. */
const PROMPT_DIR = join(DATA_DIR, "persona-prompts");

/**
 * Write a thread's persona prompt out and return its path, or undefined when
 * there is no persona — in which case the caller's placeholder resolves empty
 * and the whole `instructions` key prunes out of the config template.
 *
 * One file per session, rewritten on every spawn: it is derived state, and the
 * thread's persona is what it is derived from.
 */
export function writePersonaPrompt(sessionId: string, persona: PersonaSpawn | undefined): string | undefined {
  const path = join(PROMPT_DIR, `${sessionId.replace(/[^\w.-]/g, "_")}.md`);
  if (!persona) {
    // The thread had a persona at its last spawn and does not now. Leaving the
    // file would be harmless (nothing points at it any more) but it would also
    // be a stale copy of an instruction the user has taken back, sitting in the
    // data directory that gets backed up.
    rmSync(path, { force: true });
    return undefined;
  }
  mkdirSync(PROMPT_DIR, { recursive: true });
  writeFileSync(path, persona.prompt.endsWith("\n") ? persona.prompt : persona.prompt + "\n");
  // The path is substituted into a JSON string, so a Windows backslash would
  // escape its way out of it — the same repair `writeCodexModelCatalog` makes.
  return path.replace(/\\/g, "/");
}
