import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import { OPENUI_FRAME_HEAD, OPENUI_FRAME_TAIL, OPENUI_GROUP_ORDER, OPENUI_GROUPS } from "./openui-prompt.js";
import { usesPersonaFile, type AgentDef } from "./registry.js";
import { globalRules, projectRules, type Rule } from "./rules.js";
import type { TaskBrief } from "./task-threads.js";

/**
 * The spawn-instruction doors. They carry the thread's persona (`personas`
 * table, `sessions.persona_id`), the standing rules beneath it (rules.ts) and
 * the thread's trailers below — one text, through whichever door the runtime
 * opens (`AgentDef.personaVia`, `{personaPrompt}`, `{personaFile}`).
 *
 *   - claude-agent-acp and the daedalus agent read AIR's
 *     `_meta.jetbrains.air.customInstructions` on every `session/new`, load and
 *     resume, appended to the runtime's own prompt rather than replacing it.
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
  /** The thread's persona row, resolved by the caller; absent = none. */
  persona?: { id: string; prompt: string } | null,
): Promise<PersonaSpawn | undefined> {
  // The persona first, the rules beneath it: who to be, then the standing rules.
  const parts = [persona?.prompt.trim(), ...(rules ?? []).map((r) => r.content)].filter(Boolean);
  const base: PersonaSpawn | undefined = parts.length
    ? { id: persona ? persona.id : "rules", prompt: parts.join("\n\n") }
    : undefined;
  // Folded here rather than at the call site so the file below holds the same
  // text the inline doors carry — an agent that reads instructions off disk
  // must see the trailer too.
  const spawn = withInstructionTrailers(base, behaviour);
  // Called even when there is no spawn, so a thread that has just had one
  // taken away does not leave the old text on disk for the next spawn to point
  // at — see `writePersonaPrompt`.
  if (agent && usesPersonaFile(agent)) {
    // Only an `"env"` door reads the file; for a `_meta` door this clears the
    // copy an earlier spawn left (a row seeded before seed 29 still names it).
    const file = writePersonaPrompt(sessionId, agent.personaVia === "env" ? spawn : undefined);
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

/* ── Quick replies ──
 *
 * The answer to a question the agent just asked, as a chip that sends in a
 * word or two ("Yes", "Option B"). Distinct from a follow-up, which is the
 * user's *next request*: a reply settles the answer in front of it. */

export const SUGGEST_REPLIES_FENCE = "suggest-replies";

export const SUGGEST_REPLIES_INSTRUCTIONS = `If your answer ends by asking the user a question they can settle in a few words — a yes/no, or a choice between options you listed — offer 2-4 ready answers in one fenced block named \`${SUGGEST_REPLIES_FENCE}\`, one reply per line, each as the user would type it (under 60 characters), with no other text inside the fence:

\`\`\`${SUGGEST_REPLIES_FENCE}
<first reply>
<second reply>
\`\`\`

Omit the block entirely when you asked nothing, or when the answer needs more than a few words.`;

/* ── Files worth opening ──
 *
 * Paths the user will want to look at next: the files the answer is about.
 * The client draws each as a chip that drops an `@path` mention into the box,
 * and the send path resolves a mention that exists (the same door as typing
 * one), so a line naming a file that is not there costs nothing worse than a
 * mention that attaches nothing. */

export const SUGGEST_FILES_FENCE = "suggest-files";

export const SUGGEST_FILES_INSTRUCTIONS = `If your answer is about particular files, list up to 3 of them that the user would most likely want to open next in one fenced block named \`${SUGGEST_FILES_FENCE}\`, one path per line, relative to the project root, with no other text inside the fence:

\`\`\`${SUGGEST_FILES_FENCE}
<path of the first file>
<path of the second file>
\`\`\`

Name only files that exist and that you have seen. Omit the block when your answer is not about specific files.`;

/* ── Other agents to ask ──
 *
 * A second opinion from another (profile, agent) pair — `builtin:agents`. The
 * trailer lists the pairs that exist today (`WorkflowEngine.pairs`, minus the
 * thread's own and any not installed) for the same reason the commands trailer
 * lists commands: a model left to invent a name offers one that fails. The
 * client turns a pick into a message that *names* the pair, which is what
 * `ask_agent` asks for before it will run without checking with the user. */

export const SUGGEST_AGENTS_FENCE = "suggest-agents";

/** One pair the model may suggest asking: how a person reads it ("Codex /
    OpenAI") and nothing else — the client writes the message from that. */
export interface SuggestableAgent {
  profile: string;
  agent: string;
}

export const suggestAgentName = (pair: SuggestableAgent) => `${pair.agent} / ${pair.profile}`;

export function suggestAgents(pairs: readonly SuggestableAgent[]): string {
  const list = pairs.map((pair) => `- ${suggestAgentName(pair)}`).join("\n");
  return `## Other agents
These other agents can be asked to take a task, each in a new thread of this project:

${list}

After your final answer, if a second opinion or a separate pass (a review, a test run, a different approach) would genuinely help, suggest at most one ask in one fenced block named \`${SUGGEST_AGENTS_FENCE}\`, one line, written as the agent's name exactly as listed above, then " | ", then the task as a phrase that follows "Ask <agent> to" (under 120 characters, e.g. "review this diff for race conditions") — and no other text inside the fence:

\`\`\`${SUGGEST_AGENTS_FENCE}
<agent exactly as listed> | <the task>
\`\`\`

Only ever name an agent from the list above. These are suggestions for the user to send — do not ask them yourself. Omit the block entirely when none would help.`;
}

/* ── Recommended project commands ──
 *
 * The same ask as the follow-ups above — "what next?" — answered with a line to
 * run instead of a sentence to send. A second fence, because the two are drawn
 * differently and acted on differently: a follow-up is filled into the box as
 * prose, a command is filled as a `!` line the send path runs against the
 * project (`project-commands.tsx`).
 *
 * The list is the whole point. A recommendation is only ever a command the
 * project *defines* — a saved helper (`project-helpers.ts`) or a package.json
 * script (`project-scripts.ts`) — so the trailer names them and the model is
 * told to recommend from nothing else, and the client drops a line that names
 * a command it does not have. A model left to invent a shell line would offer
 * one that fails, which is worse than offering none. */

/** Fence the model wraps recommended project commands in. Mirrored by the
    client's parser (`lib/suggestions.ts`). */
export const SUGGEST_COMMANDS_FENCE = "suggest-commands";

/** One command the model may recommend: the name a person knows it by and the
    shell line that runs it. Built from the project's own rows, so every line the
    model may name is one the harness can resolve and run. */
export interface SuggestableCommand {
  name: string;
  command: string;
}

/** Trailer listing the project's own commands and asking the model to recommend
    at most two of them. */
export function suggestCommands(commands: readonly SuggestableCommand[]): string {
  const list = commands.map((c) => `- ${c.name}: \`${c.command}\``).join("\n");
  return `## Project commands
The project this thread runs in defines these commands:

${list}

After your final answer, if one or two of them would genuinely help the user's next step, recommend them in one fenced block named \`${SUGGEST_COMMANDS_FENCE}\`, one command per line — each line the command itself, exactly as listed above, never the name — and no other text inside the fence:

\`\`\`${SUGGEST_COMMANDS_FENCE}
<the exact command from the list above>
\`\`\`

Only ever name a command from the list above; never invent one, and never recommend one the work does not call for. Omit the block entirely when none of them fit. These run in the project's shell, so the user sends the line — do not run them yourself.`;
}

/* ── The registry ──
 *
 * What a thread may close an answer with is a *set*, not a switch: each kind is
 * one fenced block, and the thread (or its project's defaults) names which it
 * wants. This table is the whole server half of a kind, so adding one is an
 * entry here and nothing else on this side:
 *   trailer(data) — the instruction text, or undefined when there is nothing
 *                   worth asking for (no commands defined, no other agent);
 *   a loader      — optional, in `sessions.ts` (`SUGGEST_LOADERS`): the spawn-time
 *                   facts `trailer` needs, read only while the kind is on.
 * The client's half is the same id in `lib/suggestions.ts`. Order is the
 * picker's; trailers go out in reverse so the first kind is the very last
 * thing in the instructions, as the follow-up block always was. An empty set
 * is "off". */
const SUGGEST_REGISTRY = {
  prompts: { trailer: (): string | undefined => SUGGEST_FOLLOWUPS_INSTRUCTIONS },
  commands: {
    trailer: (data: unknown) => {
      const commands = data as readonly SuggestableCommand[] | undefined;
      return commands?.length ? suggestCommands(commands) : undefined;
    },
  },
  replies: { trailer: (): string | undefined => SUGGEST_REPLIES_INSTRUCTIONS },
  files: { trailer: (): string | undefined => SUGGEST_FILES_INSTRUCTIONS },
  agents: {
    trailer: (data: unknown) => {
      const pairs = data as readonly SuggestableAgent[] | undefined;
      return pairs?.length ? suggestAgents(pairs) : undefined;
    },
  },
} satisfies Record<string, { trailer: (data: unknown) => string | undefined }>;

export type SuggestKind = keyof typeof SUGGEST_REGISTRY;
export const SUGGEST_KINDS = Object.keys(SUGGEST_REGISTRY) as SuggestKind[];

/** What a thread that has never picked asks for — exactly what the old boolean's
    "on" meant, so nothing changes until someone opens the picker. */
export const DEFAULT_SUGGEST_KINDS: readonly SuggestKind[] = ["prompts", "commands"];

/** `value` cut to known ids, deduped, in registry order — the one reading of a
    stored or posted set, so an id a later build dropped never reaches a trailer. */
export function normalizeSuggestKinds(value: unknown): SuggestKind[] {
  const asked = new Set(Array.isArray(value) ? value : []);
  return SUGGEST_KINDS.filter((kind) => asked.has(kind));
}

/** A row's set: its own when it has one, else what the legacy boolean said. */
export function suggestKindsOf(kinds: unknown, legacy?: boolean | null): SuggestKind[] {
  if (Array.isArray(kinds)) return normalizeSuggestKinds(kinds);
  return legacy === false ? [] : [...DEFAULT_SUGGEST_KINDS];
}

/** Whether two sets are the same set, whatever order they were picked in. */
export function sameSuggestKinds(a: unknown, b: unknown): boolean {
  return normalizeSuggestKinds(a).join() === normalizeSuggestKinds(b).join();
}

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
 *   — there is no separate switch: `uiGroups` is the one setting, and an empty
 *     set is "off" exactly as an empty `suggestKinds` is (`sessions.ui_blocks`
 *     is a legacy column, read only by `uiGroupsOf`);
 *   — the *rendering* is untouched by any of it. The client draws a fence
 *     whatever this says (see `ProseWithOpenui`), so a thread that never enabled
 *     the lane still renders one it is handed. */

/** The fence tag the client draws as a view. Mirrored by the client
    (`tool-parts.tsx`), which also accepts the bare `openui`. */
export const OPENUI_FENCE = "openui-lang";

/** What a thread's behaviour toggles and task fold into its instructions. */
export interface ThreadBehaviour {
  /** Which closing blocks to ask for (`SUGGEST_KINDS`); empty or absent = none. */
  suggestKinds?: readonly string[] | null;
  /** Which component groups to teach (`UI_GROUP_IDS`); empty or absent = the
      lane is not offered. A non-empty set always includes "layout". */
  uiGroups?: readonly string[] | null;
  /** What each enabled kind's loader read at spawn (`SUGGEST_LOADERS`, in
      `sessions.ts`), keyed by kind id — e.g. the project's own commands, so the
      trailer lists exactly the lines that exist and the model recommends only
      from them. */
  suggestData?: Partial<Record<SuggestKind, unknown>> | null;
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

/** The component groups a thread may be taught, in the order the prompt lists
    them (layout first — the root `Stack` lives there). The generated registry's
    own order, so a group added in the client library arrives here with a
    regeneration and nothing else. */
export const UI_GROUP_IDS: readonly string[] = OPENUI_GROUP_ORDER;

/** The group every program needs: `root = Stack(...)` is defined in it. */
const UI_GROUP_REQUIRED = "layout";

/** `value` cut to known ids, deduped, in registry order. Empty stays empty
    (drawn answers off); anything else gets layout forced in — the one reading
    of a posted or stored set, so a program is never taught without the
    container it has to start from. */
export function normalizeUiGroups(value: unknown): string[] {
  const asked = new Set(Array.isArray(value) ? value : []);
  if (asked.size === 0) return [];
  asked.add(UI_GROUP_REQUIRED);
  return UI_GROUP_IDS.filter((id) => asked.has(id));
}

/** A row's set: its own when it has one, else what the legacy `ui_blocks`
    switch said (off = none, on or never set = every group). */
export function uiGroupsOf(stored: unknown, legacyUiBlocks?: boolean | null): string[] {
  if (Array.isArray(stored)) return normalizeUiGroups(stored);
  return legacyUiBlocks === false ? [] : [...UI_GROUP_IDS];
}

/** Whether two sets are the same set. */
export function sameUiGroups(a: unknown, b: unknown): boolean {
  return normalizeUiGroups(a).join() === normalizeUiGroups(b).join();
}

/**
 * Trailer appended to the spawn instructions while a thread wants drawn answers.
 *
 * The component table IS here, generated from the client's own library
 * (`client/scripts/gen-openui.mjs` → `openui-prompt.ts`) — so the trailer is
 * self-contained exactly like the suggestions one, and every runtime on a
 * profile is told the same components the reader's app will draw. It used to
 * be a pointer, with the table pushed by our own runtime into its system prompt
 * — which meant every other runtime was told "this lane is not for you".
 *
 * `groups` narrows which component groups the table teaches (absent = all): a
 * thread that only ever wants tables and charts need not pay for maps in every
 * turn's context. The frame around them is the generator's, so the syntax
 * rules and examples are identical whatever is selected. */
export function openuiInstructions(groups?: readonly string[] | null): string {
  const picked = groups == null ? UI_GROUP_IDS : normalizeUiGroups(groups);
  return `## Drawing an answer

The client draws a fenced \`${OPENUI_FENCE}\` block as real UI, inline where the fence stood. It is a presentation lane and nothing else: nothing in it can read a file, run a command or reach the network — every tool call stays a normal tool call.

${OPENUI_FRAME_HEAD}${picked.map((id) => OPENUI_GROUPS[id]).join("")}${OPENUI_FRAME_TAIL}`;
}

/** The lane with every group, as it was before groups could be narrowed. */
export const OPENUI_INSTRUCTIONS = openuiInstructions();

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
  if (normalizeUiGroups(behaviour.uiGroups).length > 0) trailers.push({ id: "openui", text: openuiInstructions(behaviour.uiGroups) });
  for (const kind of normalizeSuggestKinds(behaviour.suggestKinds).reverse()) {
    const text = SUGGEST_REGISTRY[kind].trailer(behaviour.suggestData?.[kind]);
    if (text) trailers.push({ id: kind === "prompts" ? "suggestions" : kind, text });
  }
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
