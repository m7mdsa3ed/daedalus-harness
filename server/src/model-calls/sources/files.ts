/* ── The files door: a runtime's own session store, read-only ──
 *
 * The harness cannot see the request of a runtime it does not proxy (a Default
 * profile, a subscription login), but each of the three most people run keeps
 * part of it on disk, and the parts differ — which is why this is three readers
 * and one draft:
 *
 *   claude-jsonl     the `prompt_snapshot` attachment (system prompt by section,
 *                    tool schemas on a version that writes them) plus the
 *                    instructions/environment/skills/MCP attachments beside it;
 *                    a bill per assistant message (`message.usage`). Not the
 *                    conversation as sent.
 *   codex-rollout    `session_meta` (base instructions), the developer and
 *                    context messages, the conversation; a bill per
 *                    `token_count` event. No tool schemas.
 *   opencode-sqlite  `instruction_state` (the context it injects) and a bill
 *                    per assistant `message` row, via `node:sqlite`. Neither its
 *                    own system prompt nor tool schemas nor the conversation.
 *
 * What a store does not hold is `missing`, in the adapter's words, and travels
 * with the numbers (`prompt-parts.ts`), so the panel says "not available". The
 * door attaches when the store is on this machine, waits for the ACP session id
 * to be earned (`thread.acpSessionId()`, polled — the port has no hook), finds
 * the file, reads it from where it stopped on a debounced `fs.watch`, and hands
 * each bill to `recordCall`. A file that is missing, locked or unreadable yields
 * nothing, and is tried again on the next tick.
 *
 * A bill written before the thread attached belongs to a previous life of this
 * session (a revive, a `session/load`) and was filed then — the state (snapshot,
 * rollout lines) is still folded in, the record is not re-rowed.
 */
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type * as acp from "../../acp.js";
import type { CallDoor } from "../../protocol.js";
import { recordCall, type Attached, type CallSource, type CallThread, type ModelCallDraft } from "../index.js";
import { fromClaudeSnapshot, fromCodexRollout, fromOpencodeInstructions, type RequestShape } from "../prompt-parts.js";

export type FilesFormat = Extract<CallDoor, { kind: "files" }>["format"];

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const when = (value: unknown): number => (typeof value === "number" ? value : Date.parse(str(value)) || Date.now());

/** Test seam: how often the door looks for the file, and how long a burst of
    writes settles before a read. */
export const filesTiming = { pollMs: 2_000, debounceMs: 400 };

export interface FilesReader {
  /** Where the store keeps this session, once it does; null until then. */
  path(): string | null;
  /** The bills the store gained since the last read, shaped. Throws on a store
      it cannot read (locked, unknown schema) — the door treats that as nothing. */
  read(): ModelCallDraft[];
}

/** Say `items` on the first draft and whenever the prefix changes, not every step. */
function prefixKey(shape: RequestShape): string {
  return [...shape.system, ...shape.tools].map((s) => `${s.name}:${s.text.length}`).join("|");
}

/* ── reading a JSONL from where it stopped ── */

class Tail {
  private offset = 0;
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }

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

/* ── Claude Code ── */

const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

/** `~/.claude/projects/<encoded cwd>/<id>.jsonl` — the encoding has changed
    across versions, so every project directory is tried. */
function findClaude(id: string): string | null {
  const root = join(claudeHome(), "projects");
  try {
    for (const dir of readdirSync(root)) {
      const path = join(root, dir, `${id}.jsonl`);
      if (existsSync(path)) return path;
    }
  } catch {
    /* no projects directory */
  }
  return null;
}

class ClaudeReader implements FilesReader {
  private readonly id: string;
  private tail: Tail | null = null;
  private snapshot: Json | null = null;
  /** The attachments beside the snapshot that are also in the system prompt. */
  private extras = new Map<string, { name: string; text: string }>();
  /** Requests filed: Claude writes one line per content block, all carrying
      the request's one bill. */
  private seen = new Set<string>();
  private lastPrefix = "";

  constructor(id: string) {
    this.id = id;
  }

  path(): string | null {
    if (!this.tail) {
      const path = findClaude(this.id);
      if (path) this.tail = new Tail(path);
    }
    return this.tail?.path ?? null;
  }

  private reset() {
    this.snapshot = null;
    this.extras.clear();
    this.seen.clear();
    this.lastPrefix = "";
  }

  private apply(a: Json) {
    switch (a.type) {
      case "prompt_snapshot":
        /* A version that writes no `tools` keeps the last snapshot's, if any. */
        this.snapshot = Array.isArray(a.tools) || !this.snapshot?.tools ? a : { ...a, tools: this.snapshot.tools };
        break;
      case "mcp_instructions_delta": {
        const names = list(a.addedNames).map(str);
        list(a.addedBlocks).map(str).forEach((text, i) => names[i] && this.extras.set(`mcp:${names[i]}`, { name: `mcp__${names[i]} instructions`, text }));
        for (const n of list(a.removedNames).map(str)) this.extras.delete(`mcp:${n}`);
        break;
      }
      case "agent_listing_delta": {
        const types = list(a.addedTypes).map(str);
        list(a.addedLines).map(str).forEach((line, i) => types[i] && this.extras.set(`agent:${types[i]}`, { name: "Subagent types › listing", text: line }));
        for (const t of list(a.removedTypes).map(str)) this.extras.delete(`agent:${t}`);
        break;
      }
      case "skill_listing": {
        const prior = a.isInitial === false ? (this.extras.get("skills")?.text ?? "") : "";
        this.extras.set("skills", { name: "Skills › listing", text: `${prior}${prior ? "\n" : ""}${str(a.content)}` });
        break;
      }
      case "instructions":
        for (const key of [...this.extras.keys()]) if (key.startsWith("rule:")) this.extras.delete(key);
        for (const f of list(a.files).map(record))
          if (f) this.extras.set(`rule:${str(f.path)}`, { name: `Project rules › ${str(f.path).replace(homedir(), "~")}`, text: str(f.content) });
        break;
      case "environment":
        this.extras.set("env", { name: "Environment", text: JSON.stringify(a.snapshot ?? {}) });
        break;
    }
  }

  private shape(): RequestShape {
    if (!this.snapshot) {
      /* No snapshot yet (an older version, or the file is young): nothing seen. */
      return {
        system: [],
        tools: [],
        messages: [],
        unseen: ["system", "tools", "mcp", "user", "assistant", "results"],
        missing: ["the system prompt", "tool schemas", "the conversation"],
      };
    }
    const shape = fromClaudeSnapshot(this.snapshot);
    for (const extra of this.extras.values()) (extra.name.startsWith("mcp__") ? shape.tools : shape.system).push(extra);
    return shape;
  }

  private bill(o: Json): ModelCallDraft | null {
    const message = record(o.message);
    const usage = record(message?.usage);
    if (!message || !usage) return null;
    const key = str(o.requestId) || str(message.id);
    if (!key || this.seen.has(key)) return null;
    this.seen.add(key);
    const input = num(usage.input_tokens);
    const read = num(usage.cache_read_input_tokens);
    const write = num(usage.cache_creation_input_tokens);
    const output = num(usage.output_tokens);
    const thinking = record(usage.output_tokens_details)?.thinking_tokens;
    const billed: acp.Usage = {
      totalTokens: input + read + write + output,
      inputTokens: input,
      outputTokens: output,
      cachedReadTokens: read,
      cachedWriteTokens: write,
      thoughtTokens: typeof thinking === "number" ? thinking : null,
    };
    const called = list(message.content)
      .map(record)
      .filter((b): b is Json => b?.type === "tool_use" && !!str(b.name))
      .map((b) => str(b.name));
    const shape = this.shape();
    const key2 = prefixKey(shape);
    const items = key2 !== this.lastPrefix;
    this.lastPrefix = key2;
    return {
      callId: key,
      at: when(o.timestamp),
      who: o.isSidechain === true ? "subagent" : "turn",
      model: str(message.model) || "unknown",
      ...(str(message.stop_reason) ? { finishReason: str(message.stop_reason) } : {}),
      source: "files",
      billed,
      ...(called.length ? { called } : {}),
      shape,
      items,
    };
  }

  read(): ModelCallDraft[] {
    if (!this.path()) return [];
    const { lines, restarted } = this.tail!.read();
    if (restarted) this.reset();
    const drafts: ModelCallDraft[] = [];
    for (const line of lines) {
      const isBill = line.includes('"type":"assistant"') && line.includes('"usage"');
      if (!isBill && !line.includes('"attachment":{"type":"')) continue;
      try {
        const o = record(JSON.parse(line));
        if (!o) continue;
        const a = record(o.attachment);
        if (a) this.apply(a);
        else if (o.type === "assistant") {
          const draft = this.bill(o);
          if (draft) drafts.push(draft);
        }
      } catch {
        /* a half-written or foreign line */
      }
    }
    return drafts;
  }
}

/* ── Codex ── */

const codexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");

/** `~/.codex/sessions/<y>/<m>/<d>/rollout-<stamp>-<id>.jsonl`, newest day first. */
function findCodex(id: string): string | null {
  const root = join(codexHome(), "sessions");
  const sub = (dir: string) => {
    try {
      return readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
  };
  for (const y of sub(root))
    for (const m of sub(join(root, y)))
      for (const d of sub(join(root, y, m)))
        for (const file of sub(join(root, y, m, d)))
          if (file.startsWith("rollout-") && file.endsWith(`${id}.jsonl`)) return join(root, y, m, d, file);
  return null;
}

class CodexReader implements FilesReader {
  private readonly id: string;
  private tail: Tail | null = null;
  /** `session_meta` and every `response_item` so far — what `fromCodexRollout` shapes.
      ponytail: unbounded for the session's life; a rollout is a few MB at most. */
  private kept: Json[] = [];
  private model = "unknown";
  private lastPrefix = "";

  constructor(id: string) {
    this.id = id;
  }

  path(): string | null {
    if (!this.tail) {
      const path = findCodex(this.id);
      if (path) this.tail = new Tail(path);
    }
    return this.tail?.path ?? null;
  }

  read(): ModelCallDraft[] {
    if (!this.path()) return [];
    const { lines, restarted } = this.tail!.read();
    if (restarted) {
      this.kept = [];
      this.lastPrefix = "";
    }
    const drafts: ModelCallDraft[] = [];
    for (const line of lines) {
      if (!/"type":"(session_meta|response_item|turn_context|event_msg)"/.test(line)) continue;
      try {
        const o = record(JSON.parse(line));
        const p = record(o?.payload);
        if (!o || !p) continue;
        if (o.type === "session_meta" || o.type === "response_item") this.kept.push(o);
        else if (o.type === "turn_context") this.model = str(p.model) || this.model;
        else if (p.type === "token_count") {
          /* `last_token_usage` is the response just answered; `info` is null on
             a rate-limit-only event, and all zeros before the first response.
             OpenAI counts cached tokens inside `input_tokens`. */
          const last = record(record(p.info)?.last_token_usage);
          if (!last) continue;
          const input = num(last.input_tokens);
          const cached = num(last.cached_input_tokens);
          const output = num(last.output_tokens);
          if (input + output === 0) continue;
          const shape = fromCodexRollout(this.kept);
          const key = prefixKey(shape);
          drafts.push({
            callId: randomUUID(),
            at: when(o.timestamp),
            who: "turn",
            model: this.model,
            source: "files",
            billed: {
              totalTokens: input + output,
              inputTokens: Math.max(0, input - cached),
              outputTokens: output,
              cachedReadTokens: cached,
              cachedWriteTokens: null,
              thoughtTokens: num(last.reasoning_output_tokens) || null,
            },
            shape,
            items: key !== this.lastPrefix,
          });
          this.lastPrefix = key;
        }
      } catch {
        /* a half-written or foreign line */
      }
    }
    return drafts;
  }
}

/* ── OpenCode ── */

const opencodeDb = () => join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "opencode.db");

type Sqlite = import("node:sqlite").DatabaseSync;

/** `node:sqlite` is a builtin from Node 22.13; before that there is no reader. */
function openSqlite(path: string): Sqlite | null {
  const sqlite = process.getBuiltinModule?.("node:sqlite") as { DatabaseSync: new (p: string, o: { readOnly: boolean }) => Sqlite } | undefined;
  if (!sqlite || !existsSync(path)) return null;
  return new sqlite.DatabaseSync(path, { readOnly: true });
}

class OpencodeReader implements FilesReader {
  private readonly id: string;
  /** `time_updated` of the newest row read; a row updates when its response completes. */
  private after = 0;
  private seen = new Set<string>();
  private lastPrefix = "";

  constructor(id: string) {
    this.id = id;
  }

  path(): string | null {
    const path = opencodeDb();
    return existsSync(path) ? path : null;
  }

  read(): ModelCallDraft[] {
    const path = this.path();
    const db = path ? openSqlite(path) : null;
    if (!db) return [];
    try {
      const rows = db
        .prepare("select id, time_updated, data from message where session_id = ? and time_updated > ? order by time_updated")
        .all(this.id, this.after) as { id: string; time_updated: number; data: string }[];
      if (!rows.length) return [];
      const state = db.prepare("select current_values from instruction_state where session_id = ?").get(this.id) as { current_values: string } | undefined;
      const blob = db.prepare("select value from instruction_blob where hash = ?");
      const current = (state && record(JSON.parse(state.current_values))) ?? {};
      const shape = fromOpencodeInstructions(
        Object.fromEntries(Object.entries(current).map(([k, v]) => [k, str(v)])),
        (hash) => str((blob.get(hash) as { value?: unknown } | undefined)?.value) || undefined,
      );
      const key = prefixKey(shape);
      const drafts: ModelCallDraft[] = [];
      for (const row of rows) {
        this.after = Math.max(this.after, row.time_updated);
        const data = record(JSON.parse(row.data));
        const tokens = record(data?.tokens);
        const time = record(data?.time);
        const cache = record(tokens?.cache);
        /* An assistant row is written on creation with zero tokens and again
           when its response completes; a failed one stays at zero. */
        if (!data || data.role !== "assistant" || !tokens || !time?.completed || this.seen.has(row.id)) continue;
        const input = num(tokens.input);
        const output = num(tokens.output);
        if (input + output === 0) continue;
        this.seen.add(row.id);
        const at = num(time.created) || row.time_updated;
        drafts.push({
          callId: row.id,
          at,
          ms: num(time.completed) - at,
          who: "turn",
          model: str(data.modelID) || "unknown",
          ...(str(data.finish) ? { finishReason: str(data.finish) } : {}),
          source: "files",
          billed: {
            totalTokens: input + output + num(cache?.read) + num(cache?.write),
            inputTokens: input,
            outputTokens: output,
            cachedReadTokens: num(cache?.read),
            cachedWriteTokens: num(cache?.write),
            thoughtTokens: num(tokens.reasoning) || null,
          },
          ...(num(data.cost) > 0 ? { costUsd: num(data.cost) } : {}),
          shape,
          items: key !== this.lastPrefix,
        });
        this.lastPrefix = key;
      }
      return drafts;
    } finally {
      db.close();
    }
  }
}

/* ── the door ── */

const STORE: Record<FilesFormat, { root: () => string; open: (id: string) => FilesReader }> = {
  "claude-jsonl": { root: () => join(claudeHome(), "projects"), open: (id) => new ClaudeReader(id) },
  "codex-rollout": { root: () => join(codexHome(), "sessions"), open: (id) => new CodexReader(id) },
  "opencode-sqlite": { root: opencodeDb, open: (id) => new OpencodeReader(id) },
};

/** One reader over one session's store — what the tests drive directly. */
export const openReader = (format: FilesFormat, id: string): FilesReader => STORE[format].open(id);

/**
 * Attached: poll for the earned session id and its file, read, then watch the
 * file (the store's directory for SQLite, whose writes land in the WAL beside
 * it) and read on a debounce. The poll stays if `fs.watch` refuses. Reads are
 * serialised so steps land in file order, and a bill from before `since` is a
 * previous life's.
 */
function tailStore(thread: CallThread, format: FilesFormat): Attached {
  const since = Date.now() - 1_000;
  const tag = `[model-calls] files/${format} ${thread.id.slice(0, 8)}`;
  let reader: FilesReader | null = null;
  let watcher: FSWatcher | null = null;
  let debounce: NodeJS.Timeout | null = null;
  let reading: Promise<void> | null = null;
  let again = false;
  let warned = false;
  let stopped = false;
  /** The first record of this life carries `items` whatever the reader thinks:
      the prefix it compared against was a previous life's. */
  let filed = false;

  const read = (): Promise<void> => {
    if (reading) {
      again = true;
      return reading;
    }
    reading = (async () => {
      do {
        again = false;
        let drafts: ModelCallDraft[] = [];
        try {
          drafts = reader?.read() ?? [];
        } catch (error: unknown) {
          if (!warned) console.warn(`${tag}: ${error instanceof Error ? error.message : String(error)}`);
          warned = true;
        }
        for (const draft of drafts) {
          if (stopped) break;
          if (draft.at < since) continue;
          if (!filed) draft.items = true;
          filed = true;
          await recordCall(thread, draft).catch((error: unknown) =>
            console.warn(`${tag}: record failed: ${error instanceof Error ? error.message : String(error)}`),
          );
        }
      } while (again && !stopped);
    })().finally(() => {
      reading = null;
    });
    return reading;
  };

  const bump = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void read(), filesTiming.debounceMs);
  };

  /* Until the file is found, and again whenever `fs.watch` is not holding it. */
  let poll: NodeJS.Timeout | null = null;
  const tick = () => {
    if (!reader) {
      const id = thread.acpSessionId();
      if (!id) return;
      reader = STORE[format].open(id);
    }
    const path = reader.path();
    if (!path) return;
    void read();
    try {
      const dir = format === "opencode-sqlite";
      const name = basename(path);
      watcher = watch(dir ? dirname(path) : path, (_event, file) => {
        if (!dir || (typeof file === "string" && file.startsWith(name))) bump();
      });
      watcher.on("error", () => {
        watcher?.close();
        watcher = null;
        if (!stopped) poll ??= setInterval(tick, filesTiming.pollMs);
      });
      if (poll) clearInterval(poll);
      poll = null;
    } catch {
      /* no inotify here: the poll reads */
    }
  };
  poll = setInterval(tick, filesTiming.pollMs);

  return {
    stop() {
      stopped = true;
      if (poll) clearInterval(poll);
      poll = null;
      if (debounce) clearTimeout(debounce);
      watcher?.close();
      watcher = null;
    },
  };
}

export const filesSource: CallSource = {
  kind: "files",
  async attach(thread, door) {
    if (door.kind !== "files" || !(door.format in STORE)) return null;
    /* The store has to be on this machine; the session's own file comes later. */
    if (!existsSync(STORE[door.format].root())) return null;
    return tailStore(thread, door.format);
  },
};
