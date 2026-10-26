/* ── An agent's environment, read three ways ──
   The env box used to be one textarea of `NAME=value` lines and that was the
   whole problem: the same wall of text held three genuinely different things and
   told you which was which only if you already knew.

     - **Driven by the profile** — a key the runtime ships still holding its
       `{placeholder}` (`ANTHROPIC_API_KEY: {apiKey}`). These are not settings on
       the agent at all: they are the wiring that tells it where the profile's
       credentials, endpoint and model go, and editing one is almost always a
       mistake. The placeholder's name is the value, so the editor says what fills
       it instead of showing `{apiKey}` and letting it look editable.

     - **Mine** — plain keys, and seeded keys somebody overwrote. This is what
       people used the textarea for, and it is rows of typed fields now.

     - **Advanced** — a JSON-object template (`CODEX_CONFIG`,
       `OPENCODE_CONFIG_CONTENT`). A several-thousand-character merge is a real
       thing an expert edits and the wrong thing to put behind a one-line field,
       so it stays text.

   The `{placeholders}` are what makes "driven" and "mine" distinguishable, and
   the harness fills them at spawn (`server/src/registry.ts › fill`). Whether a
   key is driven is decided against **what this release seeds** — passed in, never
   guessed — for the same reason a behaviour switch compares against its
   declarations: a seeded key somebody overwrote is theirs.

   The one property that matters: **merging never changes a key it did not mean
   to change.** A reading can be wrong and only mislabels a row; a merge that
   dropped a seeded template would break the spawn and still say "saved". */
import { type KeyValueRow } from "@/lib/key-value-rows"

/** A template's placeholders: `{model}`, `{baseUrl?daedalus/}`, `{longContext?[1m]}`. */
const PLACEHOLDER = /\{(\w+)(\?[^}]*)?\}/g

/** What each placeholder is, in words a reader can act on. The names are the
    `vars` keys `resolveSpawn` builds; one this table does not know is shown as
    itself rather than guessed at. */
export const PLACEHOLDERS: Record<string, string> = {
  apiKey: "the profile's API key",
  baseUrl: "the profile's base URL",
  gatewayUrl: "the profile's base URL, through the harness gateway",
  protocol: "the profile link's wire protocol",
  model: "the thread's model",
  smallModel: "the thread's model (helper calls use it too)",
  effort: "the thread's reasoning effort",
  longContext: "whether the model has a 1M window",
  contextWindow: "the model's context window",
  maxOutputTokens: "the model's output limit",
  modelWindows: "every model's context window, as a map",
  modelRoles: "the thread's role → model map",
  codexModelCatalog: "a generated model catalog for this profile",
  cwd: "the project's directory",
  daedalusAgentEntry: "the installed runtime's entry point",
  personaPrompt: "the thread's rules, as text",
  personaFile: "the file the thread's rules are written to",
  modelPromptsFile: "the model-prompt library",
}

const known = (name: string) => PLACEHOLDERS[name] ?? `{${name}}`

/** Is this template driven by the profile rather than set by a person? */
export const isDriven = (value: string) => /\{\w+(?:\?[^}]*)?\}/.test(value)

/** `{key?literal}` emits its literal only when the placeholder resolves — the
    seeds use it to drop a whole JSON block for a profile with no base URL. */
export const isConditional = (value: string) => /\{\w+\?/.test(value)

/* A JSON-object template — the values that must stay text.
 *
 * The `"key":` test is what keeps a placeholder out of this bucket: `{apiKey}` is
 * a brace-delimited *placeholder*, and a naive "starts with `{`" read it as a
 * config object and buried the profile's own wiring in the advanced fold. A JSON
 * object has a quoted member name and a colon; a placeholder never does. */
export const isJsonTemplate = (key: string, value: string) => {
  if (/_CONFIG\b|_CONFIG_JSON\b/.test(key)) return true
  const trimmed = value.trimStart()
  return trimmed.startsWith("{") && /"[^"]*"\s*:/.test(trimmed)
}

/** A value's placeholders, as the sentence a reader needs ("the profile's API
    key"), deduped and in order of first appearance. */
export function placeholdersOf(value: string): string[] {
  const seen = new Set<string>()
  for (const match of value.matchAll(PLACEHOLDER)) seen.add(known(match[1]))
  return [...seen]
}

export interface EnvSplit {
  /** Seeded and still holding its placeholder: the profile fills it. */
  driven: { name: string; value: string }[]
  /** A JSON-object template: text, and folded away. */
  advanced: { name: string; value: string }[]
  /** Plain values, and seeded keys somebody overwrote. */
  mine: KeyValueRow[]
}

/** Which bucket each key belongs to. `seeded` is what the runtime ships. */
export function splitEnv(env: Record<string, string> | undefined, seeded: Record<string, string>): EnvSplit {
  const driven: EnvSplit["driven"] = []
  const advanced: EnvSplit["advanced"] = []
  const mine: KeyValueRow[] = []
  for (const [name, value] of Object.entries(env ?? {})) {
    if (isJsonTemplate(name, value)) advanced.push({ name, value })
    else if (seeded[name] !== undefined && seeded[name] === value && isDriven(value)) driven.push({ name, value })
    else mine.push({ id: name, name, value })
  }
  return { driven, advanced, mine }
}

/** The env to save: the person's rows, plus every driven and advanced key exactly
    as it was read. `advanced` overrides the read copy, because a template is the
    one thing edited by hand outside the rows. */
export function mergeEnv(
  split: EnvSplit,
  rows: KeyValueRow[],
  advanced?: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { name, value } of split.driven) out[name] = value
  for (const { name, value } of split.advanced) out[name] = value
  Object.assign(out, advanced ?? {})
  for (const row of rows) {
    const name = row.name.trim()
    if (name) out[name] = row.value
  }
  return out
}
