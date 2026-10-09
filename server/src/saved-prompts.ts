import { randomUUID } from "node:crypto";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, appSettings, personas as legacyPersonas, savedPrompts as promptsTable } from "./db/index.js";
import { HttpError } from "./http-error.js";
import { MENTION_RE, TRAILING } from "./mentions.js";

/**
 * Saved prompts: reusable text a message mentions as `@name`.
 *
 * On send the server expands each mention into the prompt's text in what the
 * agent receives only (`expandPrompts`, called from the bridge's `prompt`); the
 * journal, queue and history keep the literal `@name`. Nothing touches the
 * system prompt. They replace the old personas, which were chosen at thread
 * start (`migrateLegacyPersonas` carries the rows over).
 */

export interface PromptDef {
  id: string;
  /** The unique `@handle`. */
  name: string;
  /** Display name, e.g. `QuickFix`. Empty falls back to the handle. */
  title: string;
  description: string;
  prompt: string;
  /** 0 for the user's own; the seed release for a built-in. */
  seededVersion: number;
  sortOrder: number;
}

export const PROMPT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export const PromptInputSchema = z.object({
  name: z.string().regex(PROMPT_NAME_RE, "name is the @handle: lowercase letters, digits, - and _, starting with a letter or digit"),
  title: z.string().default(""),
  description: z.string().default(""),
  prompt: z.string().min(1),
  sortOrder: z.number().int().default(0),
});

export type PromptInput = z.infer<typeof PromptInputSchema>;

async function assertFreeName(name: string, selfId?: string): Promise<void> {
  const clash = (await db.select({ id: promptsTable.id }).from(promptsTable).where(eq(promptsTable.name, name)).limit(1))[0];
  if (clash && clash.id !== selfId) throw new HttpError(`a saved prompt named @${name} already exists`, 409);
}

/* The same shape `library.ts` gives skills and commands, so the routes are the
   routes those already have. */
export const savedPrompts = {
  list: async (): Promise<PromptDef[]> =>
    await db.select().from(promptsTable).orderBy(asc(promptsTable.sortOrder), asc(promptsTable.name)),
  get: async (id: string): Promise<PromptDef | undefined> =>
    (await db.select().from(promptsTable).where(eq(promptsTable.id, id)).limit(1))[0],
  async create(input: PromptInput): Promise<PromptDef> {
    await assertFreeName(input.name);
    const row: PromptDef = { id: randomUUID(), seededVersion: 0, ...input };
    await db.insert(promptsTable).values(row);
    return row;
  },
  async update(id: string, input: PromptInput): Promise<PromptDef | undefined> {
    const existing = await savedPrompts.get(id);
    if (!existing) return undefined;
    await assertFreeName(input.name, id);
    await db.update(promptsTable).set(input).where(eq(promptsTable.id, id));
    return { ...existing, ...input };
  },
  remove: async (id: string): Promise<boolean> =>
    ((await db.delete(promptsTable).where(eq(promptsTable.id, id))).rowCount ?? 0) > 0,
};

/**
 * `text` with every `@name` that names a saved prompt replaced by the prompt's
 * text, plus the handles that matched (so the caller does not also link them as
 * files). Case-sensitive; trailing punctuation stays after the expansion; an
 * unknown token is untouched. No `@` means no query.
 */
export async function expandPrompts(text: string): Promise<{ text: string; names: Set<string> }> {
  const names = new Set<string>();
  if (!text.includes("@")) return { text, names };
  const byName = new Map((await savedPrompts.list()).map((p) => [p.name, p.prompt]));
  if (byName.size === 0) return { text, names };
  const out = text.replace(MENTION_RE, (match, raw: string) => {
    const name = raw.replace(TRAILING, "");
    const prompt = byName.get(name);
    if (prompt === undefined) return match;
    names.add(name);
    return match.slice(0, match.length - raw.length - 1) + prompt + raw.slice(name.length);
  });
  return { text: out, names };
}

/* ── The built-ins ──
 *
 * Seeded exactly the way `DEFAULT_AGENTS` is (registry.ts, `seedAgents`), with
 * the same two versions and for the same reason: `since` is how far this install
 * has been carried, `introduced` is the release that first offered the row, and
 * only the pair can tell "this install has never seen this prompt" apart from
 * "the user deleted it". */
type SeedPrompt = Omit<PromptDef, "seededVersion" | "title"> & {
  since: number;
  introduced: number;
};

const MIGRATED_KEY = "savedPromptsMigrated";

/** `Think more` -> `think-more`. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "prompt";
}

/**
 * Once, at boot: copy every legacy `personas` row into `saved_prompts` (same id,
 * name slugged and deduped) and leave a marker so a prompt deleted afterwards
 * does not come back. Copying built-ins under their own ids is what stops the
 * seeder re-offering them.
 */
export async function migrateLegacyPersonas(): Promise<void> {
  if ((await db.select().from(appSettings).where(eq(appSettings.key, MIGRATED_KEY)).limit(1))[0]) return;
  const used = new Set((await db.select({ name: promptsTable.name }).from(promptsTable)).map((r) => r.name));
  const have = new Set((await db.select({ id: promptsTable.id }).from(promptsTable)).map((r) => r.id));
  for (const p of await db.select().from(legacyPersonas).orderBy(asc(legacyPersonas.sortOrder), asc(legacyPersonas.name))) {
    if (have.has(p.id)) continue;
    await db.insert(promptsTable).values({ ...p, name: uniqueSlug(p.name, used) });
  }
  await db.insert(appSettings).values({ key: MIGRATED_KEY, value: "1" }).onConflictDoNothing();
}

/** A free handle for `name`: its slug, else `slug-2`, `slug-3`… Adds it to `used`. */
export function uniqueSlug(name: string, used: Set<string>): string {
  const base = slug(name);
  let candidate = base;
  for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}`;
  used.add(candidate);
  return candidate;
}

const DEFAULT_PROMPTS: SeedPrompt[] = [
  {
    since: 1,
    introduced: 1,
    id: "builtin:think-more",
    name: "think-more",
    description: "Deliberate. Explore the problem before touching anything.",
    sortOrder: 10,
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
    name: "think-less",
    description: "Act immediately. No deliberation, no preamble.",
    sortOrder: 20,
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
    name: "general-chat",
    description: "Talk it through. Read anything, change nothing unless asked.",
    sortOrder: 30,
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
    name: "quick-fix",
    description: "The smallest correct change. No refactors, no drive-by cleanups.",
    sortOrder: 40,
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
    since: 2,
    introduced: 2,
    id: "builtin:rebuild",
    name: "rebuild",
    description: "Delete the current implementation and write it again to the new spec. No patching, no compat layers.",
    sortOrder: 45,
    prompt: [
      "This thread replaces an implementation; it does not fix or refactor one. The",
      "user has new instructions for how something should work, and the result must",
      "read as if it had been built that way from the first commit.",
      "",
      "First, learn the contract, not the code: who calls the thing being replaced,",
      "what goes in, what comes out, what the tests and docs promise, and where its",
      "boundary is. Read the old implementation only to extract that contract and to",
      "list every file it touches. Do not copy its structure, its names, its helpers",
      "or its workarounds — assume its design is the reason it is being replaced.",
      "",
      "Then delete it and write the replacement from the new instructions alone.",
      "Remove the old files, functions, types, flags and comments outright; do not",
      "leave a `legacy` path, a shim, an adapter, a feature flag, a `// removed` note",
      "or a compatibility layer, and do not keep an old branch \"just in case\". If",
      "the new logic makes an old concept meaningless, the concept goes too. Rewrite",
      "the callers, the tests and the docs so they describe only what now exists.",
      "",
      "Stay inside the boundary you found. Rebuild the thing asked for, not everything",
      "next to it; a caller changes only where the new contract forces it to. Keep",
      "what the user did not ask to change: data on disk, the wire protocol, public",
      "routes and the rest of the codebase's rules — a rewrite is not a schema",
      "migration unless the new instructions say it is.",
      "",
      "Finish whole. Search for every remaining reference to what you removed and",
      "clear it, run the typecheck and the tests, and report what was deleted, what",
      "replaced it, and anything in the old contract the new instructions did not",
      "cover so the user can decide.",
    ].join("\n"),
  },
  {
    since: 1,
    introduced: 1,
    id: "builtin:lazy",
    name: "lazy",
    description: "Do exactly what was asked and stop. Ask before widening scope.",
    sortOrder: 50,
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
    name: "plan-first",
    description: "Write the plan, wait for approval, then build it.",
    sortOrder: 60,
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
    name: "review",
    description: "Read-only critique. Find the problems, cite them, propose nothing unasked.",
    sortOrder: 70,
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
    name: "teach",
    description: "Explain as you go: the reasoning, the tradeoffs, the why.",
    sortOrder: 80,
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
];


/**
 * Insert the built-in prompts this install has never been offered.
 *
 * `seedAgents`' rules: only rows newer than the highest `since` present are
 * considered, an absent row whose `introduced` this install is already past was
 * deleted on purpose and does not come back, and an existing row is never
 * overwritten.
 */
export async function seedPrompts(): Promise<void> {
  const applied =
    (await db
      .select({ v: promptsTable.seededVersion })
      .from(promptsTable)
      .orderBy(desc(promptsTable.seededVersion))
      .limit(1))[0]?.v ?? 0;
  const used = new Set((await db.select({ name: promptsTable.name }).from(promptsTable)).map((r) => r.name));
  for (const { since, introduced, ...prompt } of DEFAULT_PROMPTS) {
    if (since <= applied) continue;
    const existing = (await db.select().from(promptsTable).where(eq(promptsTable.id, prompt.id)).limit(1))[0];
    if (existing) {
      await db.update(promptsTable).set({ seededVersion: since }).where(eq(promptsTable.id, prompt.id));
      continue;
    }
    if (introduced <= applied) continue; // deleted on purpose
    // A handle the user already took for their own prompt is theirs.
    await db.insert(promptsTable).values({ ...prompt, name: uniqueSlug(prompt.name, used), seededVersion: since });
  }
}
