import { generate } from "./ai.js";
import { HttpError } from "./http-error.js";
import type { Profile } from "./profiles.js";

/* ── The harness's house styles ──
 *
 * Three questions the harness asks a model on the user's behalf: rewrite this
 * draft, describe this diff, name this diff. The *call* is not here — every one
 * of them is one `generate()` against a profile's endpoint (`server/src/ai.ts`,
 * the one file that names the AI SDK on this half). What is here is the only
 * thing that actually differs between them: the system prompt, and the input
 * ceiling.
 *
 * Routes call `enhancePrompt`, never the SDK, and never a turn on a thread's
 * agent — see `ai.ts` for why.
 */

/** Past this the draft is a document, not a prompt — refuse rather than bill a
    rewrite of something the user pasted wholesale. The ceiling is the *user's*
    typing; a prompt the server gathered itself is capped where it is gathered
    (`git.COMMIT_PROMPT_DIFF_MAX`) and must clear this one, or a diff of a size
    the harness deliberately allows is refused by the call it was gathered for. */
const MAX_INPUT_CHARS = 12_000;

/** Headroom over the 60 KB diff cap for the file list and the wrapper. */
const MAX_DIFF_CHARS = 80_000;

const ENHANCE_SYSTEM = `Rewrite this draft into a clear, specific prompt for an AI coding agent. Keep the user's intent exactly — do not add new requirements, do not answer it, do not explain your changes. Prefer concrete verbs, file paths and constraints over vague asks; structure with short sections or bullets when the draft has more than one ask. Return only the rewritten prompt, no preamble.

Preserve verbatim, never reword: @file mentions, /slash commands, code fences, and [pasted text #n] tokens.`;

/**
 * The commit-message half, which is a different question from the prompt half
 * and therefore a different system prompt: a commit message describes work that
 * has already happened, in a house style, rather than instructing anyone.
 */
const COMMIT_SYSTEM = `Write a commit message for the changes shown. Follow the conventional-commit style: a subject line of at most 72 characters ("feat: …", "fix: …", "refactor: …"), then a blank line and, only where the change needs it, a short body saying why rather than what.

Describe what the diff actually does — read it, do not invent work that is not there. The file list is a summary of the diff, not a substitute for reading it. Return only the commit message, no preamble and no code fences.

Where the author has already written a message, that is the one to rewrite: keep their intent and their emphasis, correct it only where the diff contradicts it, and do not swap their reading of the change for your own.`;

/**
 * The branch-name half. Same diff, a third question: a branch name is what the
 * work will be *called* while it is in progress, so it is short, lowercase and
 * shaped like a ref — and the one thing that matters here is that the answer is
 * usable verbatim, because `git checkout -b` takes it as typed. Hence the hard
 * constraints in the prompt rather than a sanitiser afterwards: a name the model
 * would have got wrong is better rejected than silently rewritten into something
 * that no longer describes the work.
 */
const BRANCH_SYSTEM = `Name a git branch for the changes shown. Return only the name — no preamble, no quotes, no code fences, nothing else.

Rules: a conventional prefix ("feat/", "fix/", "refactor/", "chore/", "docs/"), then two to four hyphenated lowercase words describing the work. ASCII letters, digits, hyphens and the one slash only. At most 40 characters. Describe what the diff actually does; do not invent work that is not there.`;

/**
 * The task half: a board task's title and rough notes in, a structured
 * description out. Markdown, because that is what `tasks.description` stores,
 * and GFM task lists for the work, because the editor draws them as checkboxes.
 */
const TASK_SYSTEM = `Turn a task's title and rough notes into a clear task description in GitHub-flavoured markdown. Open with one or two sentences on the problem and the goal, then a "## Scope" section of "- [ ]" checklist items, then "## Notes" only when the input has context worth keeping. Keep every fact, link, name and already-ticked "- [x]" item from the input; do not invent requirements, numbers or deadlines. With only a title, write the smallest sensible description and checklist for it. Return only the markdown — no preamble, no code fence around it, and do not repeat the title as a heading.`;

export type EnhanceKind = "prompt" | "commit" | "branch" | "task";

/** The style and the words a failure wears, per question. One table, so adding
    a fourth is a row rather than a second `if` chain. */
const STYLES: Record<EnhanceKind, { system: string; label: string; max: number }> = {
  prompt: { system: ENHANCE_SYSTEM, label: "rewrite", max: MAX_INPUT_CHARS },
  commit: { system: COMMIT_SYSTEM, label: "commit message draft", max: MAX_DIFF_CHARS },
  branch: { system: BRANCH_SYSTEM, label: "branch name draft", max: MAX_DIFF_CHARS },
  task: { system: TASK_SYSTEM, label: "task description draft", max: MAX_INPUT_CHARS },
};

export interface EnhanceInput {
  text: string;
  /** Explicit model; falls back to the profile default, then its first model. */
  model?: string;
  signal?: AbortSignal;
  /** Which house style to write in. Defaults to the prompt rewrite. */
  kind?: EnhanceKind;
}

export async function enhancePrompt(profile: Profile, input: EnhanceInput): Promise<string> {
  const text = input.text.trim();
  if (!text) throw new HttpError("nothing to enhance", 400);
  const style = STYLES[input.kind ?? "prompt"];
  if (text.length > style.max) {
    throw new HttpError(`prompt is too long to enhance (${text.length} of ${style.max} characters)`, 400);
  }
  return generate(profile, {
    system: style.system,
    prompt: text,
    model: input.model,
    signal: input.signal,
    label: style.label,
  });
}
