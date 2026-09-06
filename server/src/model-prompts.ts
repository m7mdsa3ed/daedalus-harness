import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { DATA_DIR } from "./config.js";
import { db, modelPrompts as modelPromptsTable } from "./db/index.js";

/**
 * A model prompt: instruction text assigned to a model, so the thread's engine
 * is told what it is and what it is like to drive.
 *
 * Two halves, by design:
 *
 * **Auto-detect** lives in the runtime (`agent/src/model-prompts.ts`) — a
 * built-in calibration per model *family*, matched by substring off the model
 * id the thread is already running. It needs no configuration and follows a
 * live model change for free, because the runtime re-resolves it every turn.
 *
 * **Assignment** is this table — rows the user manages ("this text, for every
 * model whose id matches `qwen*`"), which win over the built-ins. The grain is
 * the model id, deliberately not a profile's catalog entry: the same id runs
 * under many profiles, and the prompt belongs to the model.
 *
 * Delivery is one JSON file (`writeModelPromptsLibrary`), materialized on
 * every write and at boot, and handed to the runtime through the
 * `{modelPromptsFile}` placeholder the way a persona travels as
 * `{personaFile}`. One file rather than one per session because the mapping is
 * global: a library edit reaches already-running threads on their next turn,
 * with no respawn — which is exactly what a live model change needs.
 */

export interface ModelPromptDef {
  id: string;
  name: string;
  /** Glob over the model id, matched case-insensitively. No `*` = exact id. */
  match: string;
  prompt: string;
  enabled: boolean;
  sortOrder: number;
  /** 0 for the user's own; the seed release for a built-in. */
  seededVersion: number;
}

export const ModelPromptInputSchema = z.object({
  name: z.string().min(1),
  match: z.string().min(1),
  prompt: z.string().min(1),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

export type ModelPromptInput = z.infer<typeof ModelPromptInputSchema>;

/* ── CRUD ──
 * The same shape `personas` gives its registry, so the library routes already
 * have this resource the moment it is listed there. Every write re-materializes
 * the JSON: the file is derived state, like the persona prompt files. */
export const modelPrompts = {
  list: (): ModelPromptDef[] =>
    db.select().from(modelPromptsTable).orderBy(asc(modelPromptsTable.sortOrder), asc(modelPromptsTable.name)).all(),
  get: (id: string): ModelPromptDef | undefined =>
    db.select().from(modelPromptsTable).where(eq(modelPromptsTable.id, id)).get(),
  create(input: ModelPromptInput): ModelPromptDef {
    const row: ModelPromptDef = { id: randomUUID(), seededVersion: 0, ...input };
    db.insert(modelPromptsTable).values(row).run();
    writeModelPromptsLibrary();
    return row;
  },
  update(id: string, input: ModelPromptInput): ModelPromptDef | undefined {
    const existing = modelPrompts.get(id);
    if (!existing) return undefined;
    db.update(modelPromptsTable).set(input).where(eq(modelPromptsTable.id, id)).run();
    writeModelPromptsLibrary();
    return { ...existing, ...input };
  },
  remove(id: string): boolean {
    const removed = db.delete(modelPromptsTable).where(eq(modelPromptsTable.id, id)).run().changes > 0;
    if (removed) writeModelPromptsLibrary();
    return removed;
  },
};

/* ── The built-ins ──
 *
 * Seeded exactly the way `SEED_PERSONAS` is (personas.ts, `seedPersonas`), with
 * the same two versions and for the same reason: `since` is how far this install
 * has been carried, `introduced` is the release that first offered the row, and
 * only the pair tells "never offered here" apart from "deleted on purpose".
 *
 * What belongs in one of these. A row is a *calibration* of how the base prompt
 * is followed on one engine — tool-call shape, verbosity, how much autonomy the
 * family assumes — never an identity and never a rule the base prompt already
 * states. Each is written against the family's *documented failure mode in an
 * agent loop*, not against its marketing: the line earns its tokens by naming
 * the thing this engine actually gets wrong here, and nothing else.
 *
 * The hard boundary is what a prompt can reach. A family's wire-level bugs —
 * DeepSeek's 400 when `reasoning_content` is not replayed, its rejection of
 * `tool_choice: "required"`, GLM's `!!!!` reasoning degeneration — are the
 * provider's and the bridge's to handle, and telling a model not to hit them
 * spends context on an instruction it cannot follow. Only behaviour the model
 * chooses belongs in a row.
 *
 * `match` is a glob over the model id and is wrapped in `*` on both sides on
 * purpose: the same engine arrives as `deepseek-v4-pro` direct and as
 * `deepseek/deepseek-v4-pro` through a gateway, and the id is anchored at both
 * ends when it is matched. A user's own row with a longer pattern (say
 * `*deepseek-v4-flash*`) still wins, which is the escape hatch from these.
 *
 * These shadow the runtime's own family table (`agent/src/model-prompts.ts`) for
 * the families they name — that table stays as the answer for an install that
 * deleted a row, and for the families no row covers.
 */
type SeedModelPrompt = Omit<ModelPromptDef, "seededVersion"> & {
  since: number;
  introduced: number;
};

const SEED_MODEL_PROMPTS: SeedModelPrompt[] = [
  {
    since: 1,
    introduced: 1,
    id: "builtin:deepseek",
    name: "DeepSeek",
    match: "*deepseek*",
    enabled: true,
    sortOrder: 10,
    prompt: [
      "- edit_file is where this family loses the most turns. Copy old_string out of the",
      "  read_file output verbatim, byte for byte, and include enough surrounding lines to be",
      "  unique. A re-typed or reflowed match fails.",
      "- If an edit fails twice, re-read the file rather than retrying a third variant. Retrying",
      "  a near-miss is the loop that ends in rewriting a whole file that needed three lines.",
      "- Emit tool calls as tool calls. Never write markup or prose that describes a call you",
      "  are about to make — under a long transcript with many tools this family drifts into",
      "  narrating the call instead of making it, and a narrated call never runs.",
      "- Pick the tool whose description matches the step. read_file, glob and grep are not",
      "  worth routing through bash.",
      "- Verify against the file rather than from recall of it. Confident recall of code you did",
      "  not read this turn is this family's characteristic wrong answer.",
      "- Your reasoning is returned on its own channel. Don't replay it in the final answer —",
      "  answer at the length the task earns, and let the work speak.",
    ].join("\n"),
  },
  {
    since: 1,
    introduced: 1,
    id: "builtin:gemini",
    name: "Google Gemini",
    match: "*gemini*",
    enabled: true,
    sortOrder: 20,
    prompt: [
      "- Precision over persuasion: this family follows exact instructions well and reads",
      "  emphasis and repetition as noise. Apply the rules above rather than restating them.",
      "- Keep to one markup idiom in a reply. Mixing Markdown and XML-ish tags degrades",
      "  instruction-following here more than either alone does.",
      "- Parallel tool calls and long tool lists are a strength here — orchestrating many tools",
      "  in one prompt is what this family is best at. Give each call its own complete JSON",
      "  arguments object.",
      "- The window is huge and recall inside it decays anyway: a long run drifts in its middle,",
      "  not at its first call. Re-read the file you are about to edit rather than trusting a",
      "  read from twenty tool calls ago, and quote what it actually said.",
      "- Factual recall unbacked by a tool is this family's weakest surface. If you did not read",
      "  it or run it this turn, say you are unsure rather than asserting it.",
      "- Work the task to completion before yielding. If a tool fails, read the error and try a",
      "  different approach; don't hand back a half-finished change for the user to diagnose.",
      "- You are already terse by default and the harness rewards that. Don't add a",
      "  conversational persona, and don't pad the final answer to look thorough.",
    ].join("\n"),
  },
  {
    since: 1,
    introduced: 1,
    id: "builtin:muse-spark",
    name: "Meta Muse Spark",
    match: "*muse-spark*",
    enabled: true,
    sortOrder: 30,
    prompt: [
      "- You are tuned to stop and confirm before consequential steps. This harness has a",
      "  permission layer that already asks, so proceed autonomously through ordinary work and",
      "  spend ask_user only on a genuine fork the transcript cannot settle. Your caution around",
      "  irreversible actions is worth keeping — it is confirming the reversible ones that",
      "  wastes the turn.",
      "- Work quietly and report once at the end. Running status updates are not wanted here;",
      "  write_todos is where a long plan's progress belongs.",
      "- Follow a skill or command exactly when one is invoked, including mid-sentence. Not",
      "  reading its instructions through to the end is this family's known miss.",
      "- Your efficiency instinct is right — fewer, better tool calls — but do not let it skip",
      "  the read before an edit. Prefer the range you need over the whole file.",
      "- Hold every stated constraint to the end of the task. Dropping one quietly on a long run",
      "  is worse here than saying you could not meet it.",
      "- A message arriving mid-task is steering. The newest instruction is authoritative;",
      "  re-aim at it rather than finishing the superseded version first.",
    ].join("\n"),
  },
  {
    since: 1,
    introduced: 1,
    id: "builtin:glm",
    name: "Zhipu GLM",
    match: "*glm*",
    enabled: true,
    sortOrder: 40,
    prompt: [
      "- Repetition is this family's one real failure mode, and it costs whole sessions. If a",
      "  call fails, the retry must differ: different arguments, a different tool, or a read to",
      "  find out why. The same tool with the same arguments twice is a loop — stop, and change",
      "  approach. Alternating between two calls that never advance is the same loop.",
      "- You cannot see the surface form of what you emit, only what you planned. When a command",
      "  keeps behaving as though part of it went missing, believe the result over your own",
      "  intent and rebuild the call from scratch rather than reasoning about it again.",
      "- Depend on nothing implicit in a bash command. Pass absolute paths, and give the tool a",
      "  cwd rather than prefixing a `cd` that can be dropped on the way out.",
      "- Interpret each tool result before choosing the next call, rather than firing a planned",
      "  sequence at the repository and reconciling afterwards.",
      "- You are at your best over long tool loops — keep going through a failed call rather",
      "  than handing the thread back at the first obstacle. Stopping to ask is right only when",
      "  you have tried a genuinely different approach and it also failed.",
      "- Your training optimises for concision. Follow it: no preamble before a tool call, no",
      "  restating the task before starting it, no summary of a change that speaks for itself.",
    ].join("\n"),
  },
];

/**
 * Insert the built-in model prompts this install has never been offered.
 *
 * `seedPersonas`' rules, verbatim and for the same reasons: only rows newer than
 * the highest `since` present are considered, an absent row whose `introduced`
 * this install is already past was deleted on purpose and stays deleted, and an
 * existing row is never overwritten — the match, the text and the enabled flag
 * are the user's the moment they touch them.
 *
 * The caller re-materializes the library file; this does not, so a boot that
 * seeds four rows still writes the file exactly once.
 */
export function seedModelPrompts(): void {
  const applied =
    db
      .select({ v: modelPromptsTable.seededVersion })
      .from(modelPromptsTable)
      .orderBy(desc(modelPromptsTable.seededVersion))
      .get()?.v ?? 0;
  for (const { since, introduced, ...row } of SEED_MODEL_PROMPTS) {
    if (since <= applied) continue;
    const existing = modelPrompts.get(row.id);
    if (existing) {
      // Offered before and still here: stamp it as carried this far and leave
      // every field alone. Nothing a release has added to a model prompt yet, so
      // there is no backfill hook — when there is one it belongs here, and it
      // may not touch name/match/prompt/enabled.
      db.update(modelPromptsTable).set({ seededVersion: since }).where(eq(modelPromptsTable.id, row.id)).run();
      continue;
    }
    if (introduced <= applied) continue; // deleted on purpose
    db.insert(modelPromptsTable).values({ ...row, seededVersion: since }).run();
  }
}

/* ── Reaching the agent ── */

/** Where the runtime's mapping lives: beside the database in the gitignored
    data dir, exactly like the persona prompts and the generated catalogs — and
    deliberately NOT in the project's cwd, which every thread of the project
    shares (`personas.ts` gives the full hazard). */
const LIBRARY_PATH = join(DATA_DIR, "model-prompts", "library.json");

/** The path the `{modelPromptsFile}` placeholder resolves to, with the
    separators a JSON string literal needs (the same repair the persona files
    and the Codex catalog make for Windows backslashes). */
export function modelPromptsFilePath(): string {
  return LIBRARY_PATH.replace(/\\/g, "/");
}

/** What the file holds: only what the runtime resolves against — the match and
    the text. Names, order and the enabled flags are management, and the row's
    order is folded into the entry order here so precedence needs no sort key
    on the far side. */
export function writeModelPromptsLibrary(): string {
  const entries = modelPrompts
    .list()
    .filter((r) => r.enabled && r.match.trim() && r.prompt.trim())
    .map((r) => ({ match: r.match.trim(), prompt: r.prompt }));
  const body = JSON.stringify({ version: 1, entries }, null, 2);
  mkdirSync(join(DATA_DIR, "model-prompts"), { recursive: true });
  writeFileSync(LIBRARY_PATH, body + "\n");
  return LIBRARY_PATH;
}
