/* ── What a runtime's own files say its prompt was made of ──
 *
 * The harness cannot see the request of a runtime it does not proxy (a Default
 * profile, a subscription login), and the runtime does not announce it either.
 * But each of the three that most people run keeps part of it on disk, and the
 * parts differ — which is the reason this file is three readers and one shape:
 *
 *   claude-jsonl     system prompt by section, built-in and surfaced tool
 *                    schemas, the deferred tool list, MCP instructions, skills,
 *                    subagent types, CLAUDE.md files, the environment. Nothing
 *                    missing (on a version that writes `prompt_snapshot`).
 *   codex-rollout    the system prompt, the developer messages and the
 *                    environment/AGENTS.md messages. No tool schemas.
 *   opencode-sqlite  the context it injects (environment, date, MCP guidance,
 *                    skill guidance, the tool listing). Neither its own system
 *                    prompt nor tool schemas.
 *
 * What a file does not hold is `missing`, in words, and travels with the numbers
 * so the panel says "not available" rather than drawing a smaller prompt. The
 * counts are ours (gpt-tokenizer) — proportions, which the client scales to the
 * request's real total.
 *
 * Reading is sync and cheap on purpose, and never on the event path: `emit`
 * asks `promptPrefixOf` (a cache read) and `refreshPromptPrefix` schedules the
 * next read. A JSONL is read from where it stopped; a SQLite file is opened
 * read-only for one row. A file that is missing, newer than we understand or
 * locked is a `null` — the prompt is then inferred from the transcript, as it
 * always was.
 */
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { countTokens } from "gpt-tokenizer";

export type PromptFilesFormat = "claude-jsonl" | "codex-rollout" | "opencode-sqlite";

export interface PrefixItem {
  name: string;
  tokens: number;
}

/** The static part of a request, as the runtime's files describe it. */
export interface PromptPrefix {
  system: number;
  tools: number;
  mcp: number;
  /** What this runtime's files do not hold, as noun phrases. */
  missing: string[];
  items: { system: PrefixItem[]; tools: PrefixItem[]; mcp: PrefixItem[] };
  /** Bumped when the contents change, so a caller sends the item lists once. */
  version: number;
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/* The same prompt text is counted on every rebuild; counting 40k characters is
   the expensive part, so a text is counted once. */
const counted = new Map<string, number>();
function tokens(text: string): number {
  if (!text) return 0;
  const known = counted.get(text);
  if (known !== undefined) return known;
  const n = countTokens(text);
  if (counted.size > 256) counted.clear();
  counted.set(text, n);
  return n;
}

const item = (name: string, text: string): PrefixItem => ({ name, tokens: tokens(text) });
const sum = (items: PrefixItem[]) => items.reduce((n, i) => n + i.tokens, 0);

/** The first line that says something, as a short name. */
function label(text: string, fallback: string): string {
  const line = text.split("\n").map((l) => l.replace(/^[#>\-*\s]+/, "").trim()).find(Boolean);
  if (!line) return fallback;
  return line.length > 48 ? `${line.slice(0, 48)}…` : line;
}

function build(
  state: { system: PrefixItem[]; tools: PrefixItem[]; mcp: PrefixItem[] },
  missing: string[],
  version: number,
): PromptPrefix {
  return { system: sum(state.system), tools: sum(state.tools), mcp: sum(state.mcp), missing, items: state, version };
}

/* ── reading a JSONL from where it stopped ── */

class Tail {
  private offset = 0;
  constructor(readonly path: string) {}

  /** The complete lines appended since the last call, and whether the file
      shrank under us (a rewrite — the caller starts its state over). */
  read(): { lines: string[]; restarted: boolean } {
    const size = statSync(this.path).size;
    const restarted = size < this.offset;
    if (restarted) this.offset = 0;
    if (size === this.offset) return { lines: [], restarted };
    const buffer = Buffer.alloc(size - this.offset);
    const fd = openSync(this.path, "r");
    try {
      readSync(fd, buffer, 0, buffer.length, this.offset);
    } finally {
      closeSync(fd);
    }
    const end = buffer.lastIndexOf(0x0a);
    if (end < 0) return { lines: [], restarted };
    this.offset += end + 1;
    return { lines: buffer.subarray(0, end).toString("utf8").split("\n"), restarted };
  }
}

interface Reader {
  /** Folds in what the file gained; null when there is nothing (yet) to say. */
  read(): PromptPrefix | null;
}

/* ── Claude Code ── */

const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

function findClaude(id: string): string | null {
  const root = join(claudeHome(), "projects");
  try {
    for (const dir of readdirSync(root)) {
      const path = join(root, dir, `${id}.jsonl`);
      try {
        statSync(path);
        return path;
      } catch {
        /* not in this project */
      }
    }
  } catch {
    /* no projects directory */
  }
  return null;
}

class ClaudeReader implements Reader {
  private tail: Tail | null = null;
  private version = 0;
  private built: PromptPrefix | null = null;
  private dirty = true;
  private snapshot: { sections: string[]; identity: string; tools: Json[] | null } | null = null;
  private deferred = new Set<string>();
  private records = new Map<string, Json>();
  private mcp = new Map<string, string>();
  private agents = new Map<string, string>();
  private skills = "";
  private rules: { path: string; content: string }[] = [];
  private env = "";

  constructor(private readonly id: string) {}

  private reset() {
    this.snapshot = null;
    this.deferred.clear();
    this.records.clear();
    this.mcp.clear();
    this.agents.clear();
    this.skills = "";
    this.rules = [];
    this.env = "";
    this.dirty = true;
  }

  private apply(a: Json) {
    switch (a.type) {
      case "prompt_snapshot": {
        const sections = list(a.systemPrompt).map(str).filter((s) => s && s !== "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__");
        const tools = Array.isArray(a.tools) ? list(a.tools).map(record).filter((t): t is Json => !!t) : null;
        this.snapshot = { sections, identity: str(a.cliPrefix), tools: tools ?? this.snapshot?.tools ?? null };
        break;
      }
      case "deferred_tools_delta":
        for (const n of list(a.addedNames).map(str)) this.deferred.add(n);
        for (const n of list(a.removedNames).map(str)) this.deferred.delete(n);
        break;
      case "deferred_tools_record":
        for (const e of list(a.entries).map(record)) if (e && str(e.name)) this.records.set(str(e.name), e);
        break;
      case "mcp_instructions_delta": {
        const names = list(a.addedNames).map(str);
        list(a.addedBlocks).map(str).forEach((block, i) => names[i] && this.mcp.set(names[i], block));
        for (const n of list(a.removedNames).map(str)) this.mcp.delete(n);
        break;
      }
      case "agent_listing_delta": {
        const types = list(a.addedTypes).map(str);
        list(a.addedLines).map(str).forEach((line, i) => types[i] && this.agents.set(types[i], line));
        for (const t of list(a.removedTypes).map(str)) this.agents.delete(t);
        break;
      }
      case "skill_listing":
        this.skills = a.isInitial === false ? `${this.skills}\n${str(a.content)}` : str(a.content);
        break;
      case "instructions":
        this.rules = list(a.files)
          .map(record)
          .filter((f): f is Json => !!f)
          .map((f) => ({ path: str(f.path), content: str(f.content) }));
        break;
      case "environment":
        this.env = JSON.stringify(a.snapshot ?? {});
        break;
      default:
        return false;
    }
    return true;
  }

  read(): PromptPrefix | null {
    if (!this.tail) {
      const path = findClaude(this.id);
      if (!path) return null;
      this.tail = new Tail(path);
    }
    const { lines, restarted } = this.tail.read();
    if (restarted) this.reset();
    for (const line of lines) {
      if (!line.includes('"attachment":{"type":"')) continue;
      try {
        const a = record(record(JSON.parse(line))?.attachment);
        if (a && this.apply(a)) this.dirty = true;
      } catch {
        /* a half-written or foreign line */
      }
    }
    if (this.dirty) {
      this.built = this.build();
      this.dirty = false;
    }
    return this.built;
  }

  private build(): PromptPrefix {
    const system: PrefixItem[] = [];
    const tools: PrefixItem[] = [];
    const mcp: PrefixItem[] = [];
    const snap = this.snapshot;
    if (snap?.identity) system.push(item("System prompt › Identity", snap.identity));
    snap?.sections.forEach((s, i) => system.push(item(`System prompt › ${label(s, `Section ${i + 1}`)}`, s)));
    if (this.skills) system.push(item("Skills › listing", this.skills));
    if (this.agents.size) system.push(item("Subagent types › listing", [...this.agents.values()].join("\n")));
    for (const rule of this.rules) system.push(item(`Project rules › ${rule.path.replace(homedir(), "~")}`, rule.content));
    if (this.env) system.push(item("Environment", this.env));
    const place = (def: Json) => {
      const name = str(def.name);
      (name.startsWith("mcp__") ? mcp : tools).push(item(name, JSON.stringify(def)));
    };
    snap?.tools?.forEach(place);
    for (const def of this.records.values()) place(def);
    if (this.deferred.size) tools.push(item(`Deferred tool names (${this.deferred.size})`, [...this.deferred].join("\n")));
    for (const [server, block] of this.mcp) mcp.push(item(`${server} instructions`, block));
    const missing = !snap ? ["the system prompt", "tool schemas"] : snap.tools ? [] : ["tool schemas"];
    return build({ system, tools, mcp }, missing, ++this.version);
  }
}

/* ── Codex ── */

const codexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");

function findCodex(id: string): string | null {
  const root = join(codexHome(), "sessions");
  const sub = (dir: string) => {
    try {
      return readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
  };
  // Newest day first: a thread being read is almost always a recent one.
  for (const y of sub(root))
    for (const m of sub(join(root, y)))
      for (const d of sub(join(root, y, m)))
        for (const file of sub(join(root, y, m, d)))
          if (file.startsWith("rollout-") && file.endsWith(`${id}.jsonl`)) return join(root, y, m, d, file);
  return null;
}

/** A `user` message Codex writes that is context, not something a person said. */
const CODEX_CONTEXT = ["<environment_context>", "<user_instructions>", "# AGENTS.md", "<INSTRUCTIONS>"];

class CodexReader implements Reader {
  private tail: Tail | null = null;
  private version = 0;
  private built: PromptPrefix | null = null;
  private dirty = true;
  private base = "";
  private messages: { group: string; text: string }[] = [];

  constructor(private readonly id: string) {}

  read(): PromptPrefix | null {
    if (!this.tail) {
      const path = findCodex(this.id);
      if (!path) return null;
      this.tail = new Tail(path);
    }
    const { lines, restarted } = this.tail.read();
    if (restarted) {
      this.base = "";
      this.messages = [];
      this.dirty = true;
    }
    for (const line of lines) {
      const isMeta = line.includes('"type":"session_meta"');
      if (!isMeta && !(line.includes('"type":"response_item"') && line.includes('"type":"message"'))) continue;
      try {
        const o = record(JSON.parse(line));
        const p = record(o?.payload);
        if (!p) continue;
        if (isMeta) {
          this.base = str(p.base_instructions) || (record(p.base_instructions) ? str(record(p.base_instructions)?.text) : "");
          this.dirty = true;
          continue;
        }
        const role = str(p.role);
        const text = list(p.content).map((c) => str(record(c)?.text)).join("");
        if (role === "developer") this.messages.push({ group: "Developer instructions", text });
        else if (role === "user" && CODEX_CONTEXT.some((m) => text.trimStart().startsWith(m)))
          this.messages.push({ group: "Context", text });
        else continue;
        this.dirty = true;
      } catch {
        /* a half-written or foreign line */
      }
    }
    if (this.dirty) {
      const system: PrefixItem[] = [];
      if (this.base) system.push(item("System prompt › Base instructions", this.base));
      this.messages.forEach((m, i) => system.push(item(`${m.group} › ${label(m.text, `Message ${i + 1}`)}`, m.text)));
      const missing = this.base ? ["tool schemas"] : ["the system prompt", "tool schemas"];
      this.built = build({ system, tools: [], mcp: [] }, missing, ++this.version);
      this.dirty = false;
    }
    return this.built;
  }
}

/* ── OpenCode ── */

interface Sqlite {
  prepare(sql: string): { get(...args: string[]): Record<string, unknown> | undefined };
  close(): void;
}

function openOpencode(): Sqlite | null {
  const sqlite = process.getBuiltinModule?.("node:sqlite") as
    | { DatabaseSync: new (path: string, options: { readOnly: boolean }) => Sqlite }
    | undefined;
  if (!sqlite) return null;
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  try {
    return new sqlite.DatabaseSync(join(data, "opencode", "opencode.db"), { readOnly: true });
  } catch {
    return null;
  }
}

/** A blob is a JSON document; a string document is its own text. */
function blobText(value: unknown): string {
  const raw = str(value);
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : raw;
  } catch {
    return raw;
  }
}

class OpencodeReader implements Reader {
  private version = 0;
  private built: PromptPrefix | null = null;
  private signature = "";

  constructor(private readonly id: string) {}

  read(): PromptPrefix | null {
    const db = openOpencode();
    if (!db) return this.built;
    try {
      const row = db.prepare("select current_values from instruction_state where session_id = ?").get(this.id);
      if (!row) return this.built;
      const current = str(row.current_values);
      if (current === this.signature && this.built) return this.built;
      const keys = record(JSON.parse(current)) ?? {};
      const blob = db.prepare("select value from instruction_blob where hash = ?");
      const system: PrefixItem[] = [];
      const tools: PrefixItem[] = [];
      const mcp: PrefixItem[] = [];
      for (const [key, hash] of Object.entries(keys)) {
        const text = blobText(blob.get(str(hash))?.value);
        if (!text) continue;
        if (key === "core/mcp-guidance") {
          try {
            const servers = list(JSON.parse(text)).map(record).filter((s): s is Json => !!s);
            for (const s of servers) mcp.push(item(`${str(s.server) || "server"} instructions`, str(s.instructions)));
            if (servers.length) continue;
          } catch {
            /* not the shape we know: counted whole below */
          }
          mcp.push(item("MCP guidance", text));
        } else if (key === "core/codemode") tools.push(item("Tool listing", text));
        else if (key === "core/skill-guidance") system.push(item("Skills › listing", text));
        else if (key === "core/environment") system.push(item("Environment", text));
        else if (key === "core/date") system.push(item("Date", text));
        else system.push(item(`Instructions › ${key.replace(/^core\//, "")}`, text));
      }
      this.signature = current;
      this.built = build({ system, tools, mcp }, ["its own system prompt", "tool schemas"], ++this.version);
      return this.built;
    } catch {
      return this.built;
    } finally {
      db.close();
    }
  }
}

/* ── the cache the bridge asks ── */

interface Entry {
  reader: Reader;
  prefix: PromptPrefix | null;
  /** When the file was last read, so a stream of usage updates costs a stat a
      couple of times a second at most, not a read each. */
  at: number;
  scheduled: boolean;
  failed: boolean;
}

const entries = new Map<string, Entry>();
const MIN_GAP_MS = 2_000;
const MAX_ENTRIES = 64;

function readerFor(format: PromptFilesFormat, id: string): Reader {
  return format === "claude-jsonl" ? new ClaudeReader(id) : format === "codex-rollout" ? new CodexReader(id) : new OpencodeReader(id);
}

const keyOf = (format: PromptFilesFormat, id: string) => `${format}:${id}`;

/** The newest reading for this runtime session, or undefined if none is in. */
export function promptPrefixOf(format: PromptFilesFormat, id: string): PromptPrefix | undefined {
  return entries.get(keyOf(format, id))?.prefix ?? undefined;
}

/** Re-read the file soon, off the caller's stack. Throttled; a failure is
    swallowed once and the prompt is inferred from the transcript instead. */
export function refreshPromptPrefix(format: PromptFilesFormat, id: string): void {
  const key = keyOf(format, id);
  let entry = entries.get(key);
  if (!entry) {
    if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value!);
    entry = { reader: readerFor(format, id), prefix: null, at: 0, scheduled: false, failed: false };
    entries.set(key, entry);
  }
  if (entry.scheduled || Date.now() - entry.at < MIN_GAP_MS) return;
  entry.scheduled = true;
  const target = entry;
  setImmediate(() => {
    target.scheduled = false;
    target.at = Date.now();
    try {
      target.prefix = target.reader.read() ?? target.prefix;
    } catch (error) {
      if (!target.failed) console.warn(`[prompt-files] ${key}: ${error instanceof Error ? error.message : error}`);
      target.failed = true;
    }
  });
}

/** One reading, now, with no cache or throttle — what a test (or a tool that
    wants the answer rather than the latest) asks for. */
export function readPromptPrefixNow(format: PromptFilesFormat, id: string): PromptPrefix | null {
  return readerFor(format, id).read();
}

/** Test seam: forget everything read. */
export function resetPromptFiles(): void {
  entries.clear();
  counted.clear();
}
