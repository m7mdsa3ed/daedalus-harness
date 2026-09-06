/**
 * The model layer of the system prompt: what the engine under Daedalus Agent
 * is told about itself.
 *
 * Two halves, in precedence order:
 *
 * 1. **Assigned rows** — the model-prompt library (`model_prompts` in the
 *    harness, materialized to one JSON file and handed over as
 *    `DAEDALUS_AGENT_MODEL_PROMPTS_FILE`). A row matches by glob over the
 *    model id, case-insensitively; this is the user's "this text, for that
 *    model". The file is re-read every turn, which is what lets a live model
 *    change swap the guidance with no respawn.
 * 2. **Built-in family calibrations** — the table below, matched by substring
 *    when no row matches. Short, honest defaults about how a family behaves
 *    through an OpenAI-compatible endpoint; a row beats them, always.
 *
 * The layer is assembled per turn and must stay byte-stable per model id and
 * library content — it sits early in the prompt, ahead of everything volatile,
 * so the prefix cache keeps working (see `systemPrompt`).
 */

import { readFileSync } from "node:fs";

export interface ModelPromptEntry {
  /** Glob over the model id (`gemini-2.5-pro` exact, `qwen*` family). */
  match: string;
  prompt: string;
}

/** Shape of the file `{modelPromptsFile}` points at — the server writes it
    (`server/src/model-prompts.ts`), a standalone user can hand-write it. */
export interface ModelPromptLibrary {
  version: number;
  entries: ModelPromptEntry[];
}

/** Reads the library fresh every call, by design: it is a few kilobytes, the
    turn is about to spend seconds in a model, and a library edit reaching a
    running thread on its next turn is the whole delivery model. A missing,
    empty or unparseable file reads as no rows — the built-ins stand alone,
    never a crashed turn. */
export function loadModelPrompts(path: string): ModelPromptEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ModelPromptLibrary>;
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(
      (e): e is ModelPromptEntry =>
        typeof e?.match === "string" && e.match.trim() !== "" && typeof e?.prompt === "string" && e.prompt.trim() !== "",
    );
  } catch {
    return [];
  }
}

/** Case-insensitive. An exact id beats every glob; among globs the longest
    pattern is the most specific (`gemini-2.5*` over `gemini*`); ties keep the
    library's order. Returns the matched row's text, or undefined. */
export function matchModelPrompt(modelId: string, entries: ModelPromptEntry[]): string | undefined {
  const id = modelId.toLowerCase();
  let best: { exact: boolean; length: number; prompt: string } | undefined;
  for (const entry of entries) {
    const match = entry.match.trim().toLowerCase();
    const exact = !match.includes("*");
    const hit = exact ? id === match : globToRegExp(match).test(id);
    if (!hit) continue;
    if (
      !best ||
      (exact && !best.exact) ||
      (exact === best.exact && match.length > best.length)
    ) {
      best = { exact, length: match.length, prompt: entry.prompt };
    }
  }
  return best?.prompt;
}

function globToRegExp(glob: string): RegExp {
  const source = glob
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`);
}

/* ── The built-in families ──
 *
 * Matched by substring off the model id, first hit wins, so order is
 * precedence: `gpt` must come before nothing that would shadow it, and the
 * open-weights families whose ids embed a vendor word (`deepseek-chat`,
 * `kimi-k2`, `glm-4`) are named by that word.
 *
 * Two honest limits. These are calibrations, not identities — the model is
 * whatever it is, and every line here is something the user can override with
 * a library row, which is the point of the rows. And none of them contradicts
 * the base prompt: they tune how it is followed (one tool call per message,
 * answer length, path discipline), they never re-legislate it.
 */
const FAMILIES: { test: RegExp; text: string }[] = [
  {
    test: /gemini/i,
    text: `- The window is huge and recall inside it decays anyway: re-read the file you are about to edit rather than trusting a read from twenty calls ago.
- Keep to one markup idiom in a reply; mixing Markdown and XML-ish tags costs instruction-following here.
- Parallel tool calls and long tool lists are a strength; give each call its own complete JSON arguments object.`,
  },
  {
    test: /claude|opus|sonnet|haiku/i,
    text: `- You follow long instruction stacks closely — apply them rather than restating them back.
- The formatting rules in the final-answer sections are exact: follow them without elaborating on them.
- Parallel tool calls are fine; give each call its own complete JSON arguments object.`,
  },
  {
    test: /qwen/i,
    text: `- Emit one tool call per message. Parallel calls from this family tend to arrive with their arguments merged into one buffer, which wastes a round trip even when the harness can repair it.
- For edit_file, copy old_string out of the read output verbatim — re-typed matches are this family's most common miss.
- Keep answers tight; skip restating the task before starting it.`,
  },
  {
    test: /deepseek/i,
    text: `- Copy old_string out of the read output byte for byte, with enough surrounding lines to be unique; a re-typed match fails.
- If an edit fails twice, re-read the file rather than retrying a third variant.
- Emit tool calls as tool calls — never markup describing a call you are about to make.`,
  },
  {
    test: /glm/i,
    text: `- If a call fails, the retry must differ. The same tool with the same arguments twice is a loop: stop and change approach.
- Pass absolute paths and a cwd rather than a \`cd\` prefix that can be dropped between plan and emission.
- Go straight at the task; skip restating it and skip preamble before tool calls.`,
  },
  {
    test: /muse|spark/i,
    text: `- Proceed autonomously through ordinary work: this harness has a permission layer, so don't stop to confirm reversible steps.
- Work quietly and report once at the end; a long plan's progress belongs in write_todos.
- Hold every stated constraint to the end of the task rather than dropping one quietly.`,
  },
  {
    test: /kimi/i,
    text: `- Emit one tool call per message — parallel calls tend to arrive with merged arguments.
- Name paths exactly as earlier results showed them, and prefer reading the range you need over whole files.
- Keep answers compact.`,
  },
  {
    test: /\bgpt|o\d\b|chatgpt/i,
    text: `- Parallel tool calls are fine; give each call its own complete JSON arguments object.
- The main drift to watch is verbosity: final answers stay at the length the task earns.
- Do not narrate the transcript back before acting on it.`,
  },
  {
    test: /grok/i,
    text: `- Parallel tool calls are fine; give each call its own complete JSON arguments object.
- Keep final answers tight and skip asides — wit is not requested and reads as padding here.
- Verify against files rather than asserting from memory of them.`,
  },
];

/** The family's calibration text, or null when the id names no family we know —
    the layer is then just the header line, which is still worth sending. */
export function familyPrompt(modelId: string): string | undefined {
  return FAMILIES.find((f) => f.test.test(modelId))?.text;
}

/** The whole layer for this turn's model: the header naming the engine, then
    the assigned row, else the built-in family text, else nothing more. */
export function modelPromptLayer(modelId: string, entries: ModelPromptEntry[]): string {
  const assigned = matchModelPrompt(modelId, entries);
  const family = assigned ? undefined : familyPrompt(modelId);
  const body = assigned ?? family;
  return [
    `## The engine under this agent`,
    ``,
    `You are Daedalus Agent running on the \`${modelId}\` model. Everything else in this prompt is written for any engine; the lines below are what this one should hear:`,
    ``,
    ...(body ? [body] : [`- No family-specific guidance is loaded for this model; follow the base prompt as written.`]),
  ].join("\n");
}
