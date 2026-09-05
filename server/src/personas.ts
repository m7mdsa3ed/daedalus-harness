import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { DATA_DIR } from "./config.js";
import { db, personas as personasTable } from "./db/index.js";
import { usesPersonaFile, type AgentDef } from "./registry.js";

/**
 * A persona is how a thread wants to be worked on.
 *
 * A thread already says who is answering (the agent), on whose credentials (the
 * profile), with which engine (the model) and how hard it is allowed to think
 * (the effort). What it could not say was any of the things a person actually
 * asks for: think this one through properly; don't think, just do it; talk to
 * me, don't touch the files; make the smallest change that works. Effort is the
 * closest existing lever and it is a number on a dial, not an instruction —
 * and on a gateway profile the agent frequently offers no dial at all.
 *
 * Two rules hold this together, and both are the reason it is not simply a
 * string the composer pastes in front of the prompt.
 *
 * **It goes in through the runtime's own door.** Every agent we ship has one,
 * and each is a different shape (`AgentDef.personaVia` in registry.ts says which
 * an agent takes, declared with the agent so a user who repoints `command` can
 * repoint this too):
 *
 *   - claude-agent-acp reads `_meta.systemPrompt` on `session/new`. An object
 *     there is merged over `{type:"preset", preset:"claude_code"}` with the
 *     type and preset locked, so `{append}` adds to the CLI's own prompt rather
 *     than replacing it — and `_meta.claudeCode.options` is spread wholesale
 *     into the Agent SDK's query options, which is where `thinking` lives.
 *   - codex reads `developer_instructions` out of its config, which reaches it
 *     through the `CODEX_CONFIG` env template the registry already builds.
 *     (`base_instructions` is the other candidate and is not one: it replaces
 *     codex's entire system prompt, and it is not a `ConfigToml` key.)
 *   - opencode reads `instructions`, which is a list of *file paths*, out of
 *     `OPENCODE_CONFIG_CONTENT` — hence `writePersonaPrompt` below.
 *
 * So the prompt the user typed is still exactly the prompt that is journaled,
 * the transcript says what was said, and nothing has to be stripped back out on
 * replay.
 *
 * **Thinking and effort are two axes, not one.** claude-code exposes both and
 * they do different things: effort is the agent's own configured level, while
 * `thinking` is the extended-thinking budget the SDK hands the API. A persona
 * may set either, both or neither; an agent that has only one of them gets only
 * the one it has, and a null is always "leave it alone" rather than "off".
 */

export interface PersonaDef {
  id: string;
  name: string;
  description: string;
  prompt: string;
  /** null = leave the runtime's own default alone; 0 = off; >0 = token budget. */
  thinking: number | null;
  /** A value out of the agent's own effort selector, or null for unchanged. */
  effort: string | null;
  /** 0 for the user's own; the seed release for a built-in. */
  seededVersion: number;
  sortOrder: number;
}

export const PersonaInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  prompt: z.string().min(1),
  /** Non-negative: 0 is a real value ("no thinking"), negative is not. */
  thinking: z.number().int().min(0).nullable().default(null),
  effort: z.string().nullable().default(null),
  sortOrder: z.number().int().default(0),
});

export type PersonaInput = z.infer<typeof PersonaInputSchema>;

/* ── CRUD ──
 * The same shape `library.ts` gives skills and commands, so the routes are the
 * routes those already have. `seededVersion` is not in the input: a built-in is
 * the seed's to stamp, and editing one is allowed but does not make it yours to
 * renumber. */
export const personas = {
  list: (): PersonaDef[] =>
    db.select().from(personasTable).orderBy(asc(personasTable.sortOrder), asc(personasTable.name)).all(),
  get: (id: string): PersonaDef | undefined =>
    db.select().from(personasTable).where(eq(personasTable.id, id)).get(),
  create(input: PersonaInput): PersonaDef {
    const persona: PersonaDef = { id: randomUUID(), seededVersion: 0, ...input };
    db.insert(personasTable).values(persona).run();
    return persona;
  },
  update(id: string, input: PersonaInput): PersonaDef | undefined {
    const existing = personas.get(id);
    if (!existing) return undefined;
    db.update(personasTable).set(input).where(eq(personasTable.id, id)).run();
    return { ...existing, ...input };
  },
  remove: (id: string): boolean =>
    db.delete(personasTable).where(eq(personasTable.id, id)).run().changes > 0,
};

/* ── The built-ins ──
 *
 * Seeded exactly the way `DEFAULT_AGENTS` is (registry.ts, `seedAgents`), with
 * the same two versions and for the same reason: `since` is how far this install
 * has been carried, `introduced` is the release that first offered the row, and
 * only the pair can tell "this install has never seen this persona" apart from
 * "the user deleted it". With one version, adding a ninth persona would
 * resurrect the eight somebody had cleaned out.
 *
 * The prompts are written to be *appended* to a real coding agent's own system
 * prompt, so none of them re-states the basics and none of them contradicts the
 * runtime's own rules about tools or permissions — a persona is a preference,
 * not a jailbreak, and an instruction that fights the agent's prompt is one the
 * agent has to resolve mid-turn.
 */
type SeedPersona = Omit<PersonaDef, "seededVersion"> & {
  since: number;
  introduced: number;
};

const SEED_PERSONAS: SeedPersona[] = [
  {
    since: 1,
    introduced: 1,
    id: "builtin:think-more",
    name: "Think more",
    description: "Deliberate. Explore the problem before touching anything.",
    sortOrder: 10,
    thinking: 24_000,
    effort: "high",
    prompt: [
      "Work deliberately on this thread. Before you change anything, understand the",
      "problem: read the code that is actually involved, trace the paths that matter,",
      "and say what you found. Prefer being right to being quick.",
      "",
      "When there is more than one reasonable approach, weigh them explicitly and pick",
      "one, giving the reason. Consider the failure cases, the edge cases and what the",
      "change costs elsewhere in the codebase before you commit to it. If something is",
      "genuinely ambiguous, say so rather than picking silently.",
    ].join("\n"),
  },
  {
    since: 1,
    introduced: 1,
    id: "builtin:think-less",
    name: "Think less",
    description: "Act immediately. No deliberation, no preamble.",
    sortOrder: 20,
    thinking: 0,
    effort: "low",
    prompt: [
      "Act immediately on this thread. The task is understood; do it.",
      "",
      "Skip the deliberation, the options survey and the preamble. Don't restate the",
      "request back, don't narrate a plan for work you are about to do anyway, and",
      "don't explain a change that speaks for itself. Make the change, then say in one",
      "or two lines what you did. If the request is genuinely unclear, ask one short",
      "question instead of guessing at length.",
    ].join("\n"),
  },
  {
    since: 1,
    introduced: 1,
    id: "builtin:general-chat",
    name: "General chat",
    description: "Talk it through. Read anything, change nothing unless asked.",
    sortOrder: 30,
    thinking: null,
    effort: null,
    prompt: [
      "This thread is a conversation, not a work order. Answer in prose.",
      "",
      "Read whatever you need to answer accurately — files, history, the web if it is",
      "available — but do not modify anything. No edits, no writes, no commits, no",
      "commands with side effects. If the answer is a change, describe the change or",
      "show it as a snippet and let the user ask for it; treat an explicit \"do it\" as",
      "the moment that permission arrives.",
      "",
      "Answer the question that was asked, at the length it deserves. Ground claims",
      "about this codebase in what you actually read, and cite file:line so they can be",
      "checked. Say plainly when you don't know.",
    ].join("\n"),
  },
  {
    since: 1,
    introduced: 1,
    id: "builtin:quick-fix",
    name: "Quick fix",
    description: "The smallest correct change. No refactors, no drive-by cleanups.",
    sortOrder: 40,
    thinking: null,
    effort: null,
    prompt: [
      "Make the smallest correct change that fixes this, and nothing else.",
      "",
      "No refactors, no renames, no reformatting, no tidying of code you happened to",
      "read on the way. Match the surrounding style rather than improving it. Do not",
      "add abstractions, options or configuration the fix does not need, and do not",
      "extend the change to the other places the same pattern appears unless the user",
      "asked for that.",
      "",
      "Correct still means correct: understand the actual cause rather than silencing",
      "the symptom. If the honest fix is genuinely large, say so in a sentence and",
      "describe it before doing it. If you notice other problems while you are in",
      "there, mention them at the end — do not fix them.",
    ].join("\n"),
  },
  {
    since: 1,
    introduced: 1,
    id: "builtin:lazy",
    name: "Lazy",
    description: "Do exactly what was asked and stop. Ask before widening scope.",
    sortOrder: 50,
    thinking: null,
    effort: null,
    prompt: [
      "Do exactly what was asked, then stop.",
      "",
      "Take the request at its literal scope. Don't add tests, documentation, error",
      "handling, logging or adjacent improvements that were not requested. Don't",
      "anticipate the next step and do it too. Don't go looking for related work.",
      "",
      "If doing the task properly turns out to require something outside that scope,",
      "stop and ask rather than doing it — one short question, then wait. Keep the",
      "reply brief: what you did, and anything the user now has to decide.",
    ].join("\n"),
  },
  {
    since: 1,
    introduced: 1,
    id: "builtin:plan-first",
    name: "Plan first",
    description: "Write the plan, wait for approval, then build it.",
    sortOrder: 60,
    thinking: 16_000,
    effort: "high",
    prompt: [
      "Plan before you build on this thread.",
      "",
      "For anything beyond a trivial edit, first investigate enough to be specific,",
      "then write the plan: what you understand the goal to be, the files you will",
      "change and what each change is, anything you had to assume, and what you are",
      "deliberately leaving out. Name real paths and real functions — a plan that",
      "could describe any codebase has not been researched.",
      "",
      "Then wait. Do not start implementing until the user approves or amends it. If",
      "the plan turns out to be wrong once you start, stop and say so rather than",
      "quietly building something else.",
    ].join("\n"),
  },
  {
    since: 1,
    introduced: 1,
    id: "builtin:review",
    name: "Review",
    description: "Read-only critique. Find the problems, cite them, propose nothing unasked.",
    sortOrder: 70,
    thinking: 16_000,
    effort: "high",
    prompt: [
      "This thread is a review. Find what is wrong; do not change anything.",
      "",
      "Read the code properly before judging it — a review built on a skimmed diff is",
      "worth less than no review. Report findings most serious first, each one citing",
      "file:line and stating the concrete failure: the input or state that triggers it",
      "and what goes wrong. Separate real defects from matters of taste, and say which",
      "is which.",
      "",
      "Do not write fixes unless the user asks for them. Do not pad the list to look",
      "thorough — if the code is fine, say it is fine. Verify a suspicion against the",
      "code before you report it; a confident wrong finding costs more than a missed",
      "one.",
    ].join("\n"),
  },
  {
    since: 1,
    introduced: 1,
    id: "builtin:teach",
    name: "Teach",
    description: "Explain as you go: the reasoning, the tradeoffs, the why.",
    sortOrder: 80,
    thinking: null,
    effort: null,
    prompt: [
      "Explain as you go on this thread. The user wants to understand the work, not",
      "just receive it.",
      "",
      "Say why before what: the reason a piece of code is shaped the way it is, what",
      "the alternatives were and why this one wins, and which parts are genuine",
      "constraints versus conventions that could have gone the other way. Point at the",
      "real code (file:line) rather than describing it in the abstract.",
      "",
      "Prefer showing over doing where showing teaches more — a short worked example",
      "over a silent large edit. Call out the non-obvious parts and the ones people",
      "usually get wrong. Don't lecture about things the user clearly already knows.",
    ].join("\n"),
  },
  {
    since: 2,
    introduced: 2,
    id: "builtin:app-builder",
    name: "App builder",
    description: "Build the app in the preview: complete features, checked, committed, summarised.",
    sortOrder: 5,
    thinking: null,
    effort: "medium",
    prompt: [
      "You are building a web app in this project for someone who will mostly see",
      "the running preview, not the code. The harness runs the dev server with hot",
      "reload: never start, stop or reconfigure it, and never change its port or",
      "base path. Before your first change, read AGENTS.md and the existing files.",
      "",
      "Build the complete feature the user asked for, not a sketch: real components,",
      "real state, sensible empty, loading and error states, a responsive layout,",
      "Tailwind utilities and accessible markup. Keep components small and put each",
      "in its own file. Prefer editing what is there over rewriting it.",
      "",
      "After your changes, run the project's check script and fix what it reports.",
      "Commit when a change is complete, with a one-line message that describes the",
      "change from the user's point of view (\"Add a dark mode toggle\", not \"wip\"):",
      "every commit is a restore point the user can roll back to from the preview's",
      "History. Reply with a 2-4 line summary of what changed and what to try in",
      "the preview - no code dumps in the reply.",
      "",
      "When given an error report from the preview, fix the root cause, not the",
      "symptom. A report may carry a component chain (\"Button < TodoItem < App\") or",
      "an HTML snippet: use them to find the file. When given a selected element,",
      "change that element and nothing else unless asked. If the same error comes",
      "back after your fix, say what you tried and ask before trying again.",
    ].join("\n"),
  },
];

/**
 * Insert the built-in personas this install has never been offered.
 *
 * The rules are `seedAgents`' rules, verbatim, because they answer the same
 * question: only rows newer than the highest `since` present are considered, an
 * absent row whose `introduced` this install is already past was deleted on
 * purpose and does not come back, and an existing row is never overwritten —
 * the name, the prompt and the two dials are the user's the moment they touch
 * them.
 */
export function seedPersonas(): void {
  const applied =
    db
      .select({ v: personasTable.seededVersion })
      .from(personasTable)
      .orderBy(desc(personasTable.seededVersion))
      .get()?.v ?? 0;
  for (const { since, introduced, ...persona } of SEED_PERSONAS) {
    if (since <= applied) continue;
    const existing = db.select().from(personasTable).where(eq(personasTable.id, persona.id)).get();
    if (existing) {
      // Offered before and still here: stamp it as carried this far and leave
      // every field alone. There is nothing a release has added to a persona
      // yet, so unlike `seedAgents` there is no backfill hook — when there is
      // one, it belongs here and it may not touch name/prompt/thinking/effort.
      db.update(personasTable)
        .set({ seededVersion: since })
        .where(eq(personasTable.id, persona.id))
        .run();
      continue;
    }
    if (introduced <= applied) continue; // deleted on purpose
    db.insert(personasTable).values({ ...persona, seededVersion: since }).run();
  }
}

/* ── Reaching the agent ── */

/** What a spawn needs to know about the thread's persona, once. Resolved from
    the row so nothing downstream has to know a persona is a database row. */
export interface PersonaSpawn {
  id: string;
  prompt: string;
  thinking: number | null;
  /** Where `prompt` was written for a runtime that will only read instructions
      off disk. Filled by `resolvePersonaSpawn` when — and only when — the
      agent's env template names `{personaFile}`. */
  file?: string;
}

/**
 * The thread's persona, ready to spawn with: the row resolved, and the prompt
 * written to disk if this agent is one that reads it from there.
 *
 * `agent` decides whether a file is written rather than the persona doing it
 * unconditionally, for the reason `resolveSpawn` gives about the Codex catalog:
 * it is a file write on every spawn, and a runtime that takes the text inline
 * has no use for it.
 */
export function resolvePersonaSpawn(
  sessionId: string,
  id: string | null | undefined,
  agent: AgentDef | undefined,
  suggestFollowups?: boolean | null,
): PersonaSpawn | undefined {
  const persona = id ? personas.get(id) : undefined;
  // A persona deleted under a live thread reads as none — see the schema's note
  // on why `sessions.persona_id` is not a foreign key.
  const base: PersonaSpawn | undefined = persona?.prompt
    ? { id: persona.id, prompt: persona.prompt, thinking: persona.thinking }
    : undefined;
  // Folded here rather than at the call site so the file below holds the same
  // text the inline doors carry — an agent that reads instructions off disk
  // must see the trailer too.
  const spawn = withFollowupSuggestions(base, suggestFollowups);
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
export const SUGGEST_FOLLOWUPS_INSTRUCTIONS = `After your final answer, suggest 2-3 natural follow-up prompts the user may want to ask next. Emit them as one fenced block named \`${SUGGEST_FOLLOWUPS_FENCE}\`, one prompt per line, with no other text inside the fence:

\`\`\`${SUGGEST_FOLLOWUPS_FENCE}
<first follow-up prompt>
<second follow-up prompt>
\`\`\`

Omit the block when no follow-up makes sense. Never put anything but follow-up prompts in it.`;

/**
 * The spawn instructions for a thread: its persona, plus the suggestions
 * trailer when the thread asked for it. Returns undefined when there is
 * nothing to instruct — the caller's placeholders resolve empty exactly as
 * they do for a thread with no persona.
 */
export function withFollowupSuggestions(
  persona: PersonaSpawn | undefined,
  enabled: boolean | null | undefined,
): PersonaSpawn | undefined {
  if (!enabled) return persona;
  if (!persona) return { id: "suggestions", prompt: SUGGEST_FOLLOWUPS_INSTRUCTIONS, thinking: null };
  if (persona.prompt.includes(SUGGEST_FOLLOWUPS_INSTRUCTIONS)) return persona;
  return { ...persona, prompt: `${persona.prompt}\n\n${SUGGEST_FOLLOWUPS_INSTRUCTIONS}` };
}

/** The effort a persona asks for, if it asks for one. Separate from
    `personaSpawn` because it is consumed by the model/effort plumbing rather
    than by the spawn, and because "unchanged" has to stay distinguishable from
    "no persona". */
export function personaEffort(id: string | null | undefined): string | undefined {
  return (id ? personas.get(id)?.effort : null) ?? undefined;
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
