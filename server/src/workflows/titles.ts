/*
 * What a workflow step is CALLED to a reader, as opposed to what it is KEYED by.
 *
 * A step's `name` is the slug `sanitizeStepName` makes of its label — lowercase,
 * hyphenated, 40 characters, `agent-3` when the script said nothing. It is the
 * identity the card, the plan and the REST view join on, so it stays exactly
 * that. This is the other half: a `title` carried beside it, in words.
 *
 * Pure and deterministic (a function of the script's own arguments), so a replay
 * names every step the way the live run did. It is NOT part of the replay key
 * (`keyFields`), so retitling a step never re-runs it.
 */
import { SCRIPT_LIMITS } from "./types.js";

/** Longest title derived from a prompt. An explicit `title` may run to `maxLabel`. */
const DERIVED_MAX = 60;

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** `fix-bug_1` → `Fix bug 1`. A label that already has spaces was written to be read, so it is left alone. */
function humanize(label: string): string {
  const text = collapse(label);
  return capitalise(/\s/.test(text) || !/[_-]/.test(text) ? text : text.replace(/[_-]+/g, " "));
}

/** The prompt's first sentence: its opening line, minus markdown scaffolding. */
function fromPrompt(prompt: string): string {
  const line = prompt.split("\n").map((l) => l.replace(/^[\s#>*\-+\d.)]+/, "")).find((l) => l.trim()) ?? "";
  const sentence = collapse(line).split(/(?<=[.!?])\s/)[0]?.replace(/[.!?]+$/, "") ?? "";
  return capitalise(clip(sentence, DERIVED_MAX));
}

/**
 * The words a step reads by: its explicit `title`, else its `label` made
 * readable, else the first sentence of its prompt, else `Agent <n>`.
 */
export function stepTitle(input: { title?: string; label?: string; prompt: string; index: number }): string {
  const explicit = input.title ? clip(collapse(input.title), SCRIPT_LIMITS.maxLabel) : "";
  if (explicit) return explicit;
  const label = input.label ? clip(humanize(input.label), SCRIPT_LIMITS.maxLabel) : "";
  return label || fromPrompt(input.prompt) || `Agent ${input.index}`;
}

/** Makes titles distinct within a run (`Audit`, `Audit (2)`), in call order — as `uniqueName` does for slugs. */
export function titleRegistry(): (title: string) => string {
  const used = new Set<string>();
  return (title) => {
    let out = title;
    for (let n = 2; used.has(out); n += 1) out = `${title} (${n})`;
    used.add(out);
    return out;
  };
}
