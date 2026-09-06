import { readFileSync, statSync } from "node:fs";
import type { ToolCallRepairFunction, ToolSet } from "ai";

/* Repairing a tool call is cheaper than failing one. Every failure here costs
   a whole round trip — the model gets an error back, re-reads the schema and
   guesses again — and the guesses that fail are nearly always the same four
   shapes: a Claude-Code tool name, a Claude-Code parameter name, arguments
   double-encoded as a JSON string, or a scalar typed as its string. None of
   them are ambiguous, so none of them need the model's help; they are fixed
   here, deterministically, before the call is emitted. Anything that is
   genuinely ambiguous returns null and becomes an ordinary tool error. */

/** Names other harnesses use for the same tool. Normalized on both sides. */
const TOOL_ALIASES: Record<string, string> = {
  read: "read_file",
  readfile: "read_file",
  view: "read_file",
  cat: "read_file",
  openfile: "read_file",
  write: "write_file",
  writefile: "write_file",
  create: "write_file",
  createfile: "write_file",
  edit: "edit_file",
  editfile: "edit_file",
  str_replace: "edit_file",
  strreplace: "edit_file",
  strreplaceeditor: "edit_file",
  replace: "edit_file",
  multiedit: "edit_file",
  shell: "bash",
  run: "bash",
  runcommand: "bash",
  terminal: "bash",
  exec: "bash",
  execute: "bash",
  bashtool: "bash",
  findfiles: "glob",
  fileglob: "glob",
  find: "glob",
  ls: "glob",
  search: "grep",
  ripgrep: "grep",
  searchfiles: "grep",
  codesearch: "grep",
  todowrite: "write_todos",
  writetodos: "write_todos",
  updatetodos: "write_todos",
  todo: "write_todos",
  plan: "write_todos",
  updateplan: "write_todos",
  askuserquestion: "ask_user",
  askquestion: "ask_user",
  question: "ask_user",
  agent: "task",
  subagent: "task",
  dispatchagent: "task",
};

/** Parameter names for the same field. Applied only when the tool's schema has
    the target property and does not already carry a value for it. */
const PARAM_ALIASES: Record<string, string[]> = {
  path: ["file_path", "filepath", "filename", "file", "target_file", "abs_path", "dir", "directory", "folder", "root"],
  content: ["contents", "text", "body", "data", "file_text", "new_content", "new_text"],
  old_string: ["old_str", "oldstring", "old", "old_text", "search", "find", "target"],
  new_string: ["new_str", "newstring", "new", "new_text", "replacement", "replace_with"],
  replace_all: ["replaceall", "all", "global", "expected_replacements"],
  command: ["cmd", "shell_command", "script", "commands", "bash_command", "input"],
  timeout_ms: ["timeout", "timeoutms", "timeout_seconds", "time_out"],
  pattern: ["regex", "query", "search", "search_pattern", "glob_pattern", "expression", "q"],
  glob: ["file_pattern", "include", "filter", "file_glob", "type"],
  ignore_case: ["ignorecase", "case_insensitive", "insensitive", "i"],
  offset: ["start", "start_line", "from", "line", "skip"],
  limit: ["count", "num_lines", "lines", "max", "length", "end_line"],
  todos: ["items", "tasks", "todo", "entries", "list", "plan"],
  prompt: ["task", "instructions", "brief", "message", "input", "goal"],
  description: ["desc", "title", "name", "summary"],
};

/** Wrappers a model puts its arguments inside when it over-nests. */
const WRAPPER_KEYS = ["input", "arguments", "args", "parameters", "params", "tool_input", "toolInput", "properties"];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

interface JsonSchemaish {
  properties?: Record<string, { type?: string | string[]; items?: unknown }>;
  required?: string[];
}

/** `functions.read_file`, `Read`, `read-file` all name the same tool. */
export function resolveToolName(name: string, available: string[]): string | null {
  const bare = name.includes(".") ? (name.split(".").pop() as string) : name;
  const key = norm(bare);
  const exact = available.find((t) => norm(t) === key);
  if (exact) return exact;
  const aliased = TOOL_ALIASES[key];
  if (aliased && available.includes(aliased)) return aliased;
  /* An MCP tool the model addressed by its leaf name (`search` for
     `mcp__exa__search`) — unambiguous only when exactly one leaf matches. */
  const leaves = available.filter((t) => norm(t.split("__").pop() ?? t) === key);
  return leaves.length === 1 ? (leaves[0] as string) : null;
}

/** The first complete JSON value in `text` starting at `from`, and where it
    ended. Two calls whose argument deltas were merged into one buffer arrive
    as `{…}{…}`: valid JSON followed by more valid JSON, which `JSON.parse`
    rejects whole. Scanning is string-aware, so a brace inside a value never
    closes the object. */
function firstJsonValue(text: string, from: number): { value: unknown; end: number } | null {
  const open = text[from];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) {
      try {
        return { value: JSON.parse(text.slice(from, i + 1)), end: i + 1 };
      } catch {
        return null; // balanced but not valid: nothing here to salvage
      }
    }
  }
  return null; // truncated: an unclosed object is not repairable here
}

/** JSON out of a string a model wrote as prose, a fence, doubled, or twice
    over. `onExtra` is told what came after the value that was kept. */
function parseLoose(raw: string, onExtra?: (rest: string) => void): unknown {
  const text = raw.trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    // fall through to the salvage paths
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // not the fence either
    }
  }
  /* Take the first value and say what was dropped: a second object here is a
     second call the model still owes, and it reissues it once it sees only
     the first one answered. */
  const start = text.search(/[{[]/);
  if (start !== -1) {
    const found = firstJsonValue(text, start);
    if (found) {
      const rest = text.slice(found.end).trim();
      if (rest) onExtra?.(rest);
      return found.value;
    }
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch {
      // give up: an unbalanced or truncated object is not repairable here
    }
  }
  return null;
}

/** `"{\"path\":…}"` and `{input:{…}}` both mean the object one level in. */
function unwrap(value: unknown): unknown {
  let cur = value;
  for (let depth = 0; depth < 3; depth++) {
    if (typeof cur === "string") {
      const inner = parseLoose(cur);
      if (inner === null || typeof inner !== "object") return cur;
      cur = inner;
      continue;
    }
    if (cur && typeof cur === "object" && !Array.isArray(cur)) {
      const keys = Object.keys(cur as Record<string, unknown>);
      const only = keys.length === 1 ? (keys[0] as string) : null;
      if (only && WRAPPER_KEYS.includes(only)) {
        const inner = (cur as Record<string, unknown>)[only];
        if (inner && (typeof inner === "object" || typeof inner === "string")) {
          cur = inner;
          continue;
        }
      }
    }
    return cur;
  }
  return cur;
}

function renameKeys(input: Record<string, unknown>, schema: JsonSchemaish): Record<string, unknown> {
  const props = schema.properties ?? {};
  const names = Object.keys(props);
  if (names.length === 0) return input;
  const out: Record<string, unknown> = {};
  const leftovers: [string, unknown][] = [];
  for (const [key, value] of Object.entries(input)) {
    if (key in props) out[key] = value;
    else leftovers.push([key, value]);
  }
  for (const [key, value] of leftovers) {
    const k = norm(key);
    const byCase = names.find((n) => norm(n) === k);
    const byAlias = names.find((n) => (PARAM_ALIASES[n] ?? []).some((a) => norm(a) === k));
    const target = byCase ?? byAlias;
    if (target && !(target in out)) out[target] = value;
    else out[key] = value; // unknown and unmappable: leave it for the validator
  }
  /* A single-property tool given a bare scalar (`"src/a.ts"` for glob) means
     that property — there is nothing else it could mean. */
  return out;
}

function coerce(input: Record<string, unknown>, schema: JsonSchemaish): Record<string, unknown> {
  const props = schema.properties ?? {};
  const out: Record<string, unknown> = { ...input };
  for (const [key, value] of Object.entries(out)) {
    const spec = props[key];
    if (!spec) continue;
    const types = Array.isArray(spec.type) ? spec.type : spec.type ? [spec.type] : [];
    if (types.length === 0 || typeof value === "undefined" || value === null) continue;
    if (types.includes("number") || types.includes("integer")) {
      if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) out[key] = Number(value);
      continue;
    }
    if (types.includes("boolean") && typeof value === "string") {
      const v = value.trim().toLowerCase();
      if (v === "true" || v === "false") out[key] = v === "true";
      continue;
    }
    if (types.includes("array") && typeof value === "string") {
      const parsed = parseLoose(value);
      if (Array.isArray(parsed)) out[key] = parsed;
      continue;
    }
    if (types.includes("string") && typeof value !== "string") {
      out[key] = typeof value === "object" ? JSON.stringify(value) : String(value);
    }
  }
  return out;
}

/** Everything the schema demands is present, and nothing is left unnamed. */
function satisfies(input: Record<string, unknown>, schema: JsonSchemaish): boolean {
  const props = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    const value = input[key];
    if (value === undefined || value === null) return false;
  }
  return Object.keys(input).every((k) => k in props);
}

/** Every complete JSON value in `text`, plus whatever was left over.

    Two calls whose argument deltas were merged into one buffer arrive as
    `{…}{…}`, and the sibling they were stolen from arrives as `{}` or as a
    tail with its head missing. Both halves of that are one problem, so the
    text is drained rather than parsed: what this call needs comes out first,
    and what is left is held for the sibling that is about to ask for it. */
function harvest(text: string): { values: unknown[]; rest: string } {
  const values: unknown[] = [];
  let cur = text.trim();
  for (;;) {
    const start = cur.search(/[{[]/);
    if (start === -1) break;
    const found = firstJsonValue(cur, start);
    if (!found) break;
    values.push(found.value);
    cur = cur.slice(found.end).trim();
  }
  return { values, rest: cur };
}

interface ToolCallPart {
  type?: string;
  input?: unknown;
  args?: unknown;
}
interface Messageish {
  role?: string;
  content?: unknown;
}

/** Paths this attempt has already named, newest first. A model that leaves
    `path` off an edit is a model still working in the file it named a moment
    ago, and the transcript is where that file is written down. */
function recentPaths(messages: unknown): string[] {
  if (!Array.isArray(messages)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = messages.length - 1; i >= 0 && out.length < 12; i--) {
    const msg = messages[i] as Messageish;
    if (!msg || !Array.isArray(msg.content)) continue;
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const part = msg.content[j] as ToolCallPart;
      if (!part || part.type !== "tool-call") continue;
      const input = (part.input ?? part.args) as Record<string, unknown> | undefined;
      const path = input && typeof input === "object" ? input.path : undefined;
      if (typeof path === "string" && path && !seen.has(path)) {
        seen.add(path);
        out.push(path);
      }
    }
  }
  return out;
}

const CONTENT_PROBE_LIMIT = 4_000_000;
/** How much unfinished argument text is worth holding for the next call. */
const CARRY_LIMIT = 200_000;

/** Does `path` hold `needle`? Silent on anything unreadable or huge — a probe
    that throws must not turn a repairable call into a crashed one. */
function fileContains(path: string, needle: string): boolean {
  try {
    if (statSync(path).size > CONTENT_PROBE_LIMIT) return false;
    return readFileSync(path, "utf8").includes(needle);
  } catch {
    return false;
  }
}

/** The file an edit meant, decided by evidence rather than by guess.

    `path` is the one argument a model drops (it is writing the two big
    strings and forgets the small one), and the failure it costs is a whole
    round trip for an argument the transcript already contains. Resolution is
    ordered by how much it proves:

    1. Exactly one candidate whose text actually holds `old_string` — that is
       not a guess, it is the only file the edit could have applied to.
    2. Several hold it: ambiguous, and an edit landed in the wrong file is
       damage, so this stays a plain error.
    3. None hold it: the most recently named file, which cannot silently
       succeed — `edit_file` will refuse it and say which file it looked in,
       which is the answer the model needs and the schema error was not. */
function resolvePath(
  toolName: string,
  input: Record<string, unknown>,
  messages: unknown,
  readFiles: Map<string, number> | undefined,
): string | null {
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const p of [...recentPaths(messages), ...[...(readFiles?.keys() ?? [])].reverse()]) {
    if (!seen.has(p)) {
      seen.add(p);
      candidates.push(p);
    }
  }
  if (candidates.length === 0) return null;

  const needle = input.old_string;
  if (typeof needle === "string" && needle.length > 0) {
    const holding = candidates.filter((p) => fileContains(p, needle));
    if (holding.length === 1) return holding[0] as string;
    if (holding.length > 1) return null; // ambiguous: not ours to pick
  }
  /* Nothing to check the guess against, so only where a wrong guess is
     harmless: a re-read costs context, an edit that misses says so, and
     write_file would overwrite the wrong file outright. */
  if (toolName !== "edit_file" && toolName !== "read_file") return null;
  return candidates[0] as string;
}

export interface RepairOptions {
  /** Told, on stderr, about every repair that was made. */
  onRepair?(note: string): void;
  /** The session's read set, newest last — one half of "which file did it
      mean", the other being the messages the repair callback is handed. */
  readFiles?: Map<string, number>;
}

export function makeRepairToolCall(opts: RepairOptions | ((note: string) => void) = {}): ToolCallRepairFunction<ToolSet> {
  const { onRepair, readFiles } = typeof opts === "function" ? { onRepair: opts, readFiles: undefined } : opts;
  /* Salvage is scoped to the step, because that is the scope the damage has:
     the calls whose arguments were merged were emitted together, and a value
     left over from one step must never be handed to the next one. The step is
     identified by the message list it was prepared from. */
  let stepKey = -1;
  let pending: unknown[] = [];
  let carry = "";

  return async ({ toolCall, tools, inputSchema, error, messages }) => {
    try {
      const available = Object.keys(tools);
      const toolName = available.includes(toolCall.toolName)
        ? toolCall.toolName
        : resolveToolName(toolCall.toolName, available);
      if (!toolName) return null;

      const step = Array.isArray(messages) ? messages.length : -1;
      if (step !== stepKey) {
        stepKey = step;
        pending = [];
        carry = "";
      }

      const schema = (await inputSchema({ toolName })) as JsonSchemaish;
      /* This call's own text first, behind anything a previous call in the
         step could not finish — a head and its tail are only whole together. */
      const drained = harvest(`${carry}${toolCall.input ?? ""}`);
      /* Joined with nothing between them: a head and its tail were one buffer
         before the stream split them, and a separator inserted here lands
         inside whatever string the split fell in the middle of. Only an
         unfinished value is worth carrying, and only so much of one — prose
         and punctuation are noise that would otherwise accumulate all step. */
      carry = /[{[]/.test(drained.rest) ? drained.rest.slice(-CARRY_LIMIT) : "";
      const mine = drained.values.length ? drained.values : [parseLoose(toolCall.input ?? "")];
      const candidates = [...mine, ...pending];

      let chosen: Record<string, unknown> | null = null;
      let takenFrom = -1;
      let best: Record<string, unknown> | null = null;
      for (let i = 0; i < candidates.length; i++) {
        const shaped = shape(unwrap(candidates[i]), schema);
        if (!shaped) continue;
        const repaired = coerce(renameKeys(shaped, schema), schema);
        if (best === null) best = repaired;
        if (satisfies(repaired, schema)) {
          chosen = repaired;
          takenFrom = i;
          break;
        }
      }

      /* What this call did not use is what a sibling is missing. Its own
         leftovers join the queue; a value taken out of the queue leaves it. */
      const stolen = takenFrom >= mine.length ? takenFrom - mine.length : -1;
      pending = pending.filter((_, i) => i !== stolen);
      for (let i = 0; i < mine.length; i++) if (i !== takenFrom) pending.push(mine[i]);

      /* Last resort: the one argument models actually drop. */
      let filledPath = false;
      if (!chosen && best && !("path" in best) && (schema.properties ?? {}).path) {
        const path = resolvePath(toolName, best, messages, readFiles);
        if (path) {
          const withPath = { ...best, path };
          if (satisfies(withPath, schema)) {
            chosen = withPath;
            filledPath = true;
          }
        }
      }
      if (!chosen) return null;

      const changed = toolName !== toolCall.toolName || JSON.stringify(chosen) !== toolCall.input;
      if (!changed) return null;
      const how =
        filledPath
          ? `; filled path from the transcript`
          : takenFrom > 0
            ? `; recovered arguments merged into a sibling call`
            : pending.length
              ? `; held ${pending.length} salvaged argument object(s) for sibling calls`
              : "";
      onRepair?.(`repaired tool call ${toolCall.toolName} → ${toolName} (${(error as Error).name})${how}`);
      return { ...toolCall, toolName, input: JSON.stringify(chosen) };
    } catch {
      return null; // a repair that throws is a failure the model should see
    }
  };
}

/** A candidate as an argument object, or null when it cannot be one. A bare
    scalar or array can only be the tool's single required property. */
function shape(value: unknown, schema: JsonSchemaish): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  const required = schema.required ?? [];
  const props = Object.keys(schema.properties ?? {});
  const target = (required.length === 1 ? required[0] : null) ?? (props.length === 1 ? props[0] : null);
  return target ? { [target]: value } : null;
}
