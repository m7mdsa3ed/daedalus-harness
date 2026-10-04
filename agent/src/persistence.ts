import {
  appendFileSync,
  closeSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ModelMessage } from "ai";
import type { UpdateParams } from "./types.js";

export interface IndexEntry {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: number;
}

export interface ToolErrorRecord {
  timestamp: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  cwd: string;
  model: string;
  input: unknown;
  error: {
    name: string;
    message: string;
    stack?: string;
    cause?: unknown;
    details?: Record<string, unknown>;
  };
}

interface MetaRecord {
  t: "meta";
  cwd: string;
  createdAt: number;
}
interface MsgRecord {
  t: "msg";
  m: ModelMessage;
}
interface UpdateRecord {
  t: "update";
  u: UpdateParams;
}
/* The permission mode a `session/set_mode` confirmed. State, not transcript:
   it survives compaction and is what a `session/load` answers as the current
   mode, so a revived thread comes back on the mode it was left in rather than
   the default a fresh session starts on. */
interface ModeRecord {
  t: "mode";
  mode: string;
}
/* A compaction barrier: on read, messages before it are dropped — the summary
   message that follows it is what the model sees, while the update records
   (the human-readable transcript) are all kept for replay. */
interface CompactRecord {
  t: "compact";
}
export type SubagentStatus = "running" | "completed" | "stopped" | "failed";
export interface SubagentEntry {
  id: string;
  name: string;
  task: string;
  status: SubagentStatus;
  messages: ModelMessage[];
}
interface SubagentRecord {
  t: "subagent";
  id: string;
  name: string;
  task: string;
  status: SubagentStatus;
}
interface SubagentMessagesRecord {
  t: "subagent_messages";
  id: string;
  messages: ModelMessage[];
}
interface SubagentStatusRecord {
  t: "subagent_status";
  id: string;
  status: SubagentStatus;
}
type Record_ =
  | MetaRecord
  | MsgRecord
  | UpdateRecord
  | CompactRecord
  | ModeRecord
  | SubagentRecord
  | SubagentMessagesRecord
  | SubagentStatusRecord;

export interface SessionHistory {
  cwd: string;
  messages: ModelMessage[];
  updates: UpdateParams[];
  /** The last confirmed mode, or null when the session never left default. */
  mode: string | null;
  /** What the provider last said the *root* loop's context measured, out of
      the journaled `usage_update`s. Restored on load so a revived thread knows
      how full it already is: a session that comes back at 190k of a 200k
      window has to compact on its first turn, and `lastTokens` starting at
      zero is what let it skip straight past that. */
  lastTokens: number;
  subagents: SubagentEntry[];
}

const LIST_PAGE = 100;
const INDEX_FLUSH_MS = 500;
const READ_CHUNK = 64 * 1024;

/* One exit hook for however many stores a process holds (tests hold several),
   so a debounced index write still lands on a clean exit. */
const dirtyStores = new Set<SessionStore>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const s of dirtyStores) s.flushIndex();
  });
}

/* One JSONL file per session — `msg` records are the model-facing history,
   `update` records are the replay stream `session/load` sends back — plus an
   index.json for `session/list`. The store is the agent's own
   (~/.daedalus-agent), like the other runtimes own theirs: it is what makes
   the harness's import-via-session/list meaningful. */
export class SessionStore {
  home: string;
  index: Map<string, IndexEntry>;
  private flushTimer: NodeJS.Timeout | null = null;
  private activeSubagents = new Set<string>();
  private toolErrorsFd: number | null = null;

  constructor(home: string) {
    this.home = home;
    mkdirSync(join(home, "sessions"), { recursive: true });
    this.index = new Map();
    const indexPath = join(home, "index.json");
    if (existsSync(indexPath)) {
      try {
        const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as IndexEntry[];
        for (const e of parsed) this.index.set(e.sessionId, e);
      } catch {
        // A corrupt index loses the listing, never the transcripts.
      }
    }
  }

  private file(sessionId: string): string {
    return join(this.home, "sessions", `${sessionId}.jsonl`);
  }

  /* The in-memory map is the authority; index.json is only for the next
     process. touch() runs once per prompt, so it schedules a debounced flush
     rather than rewriting the whole index each time — a crash inside the
     window loses at most INDEX_FLUSH_MS of recency bumps, never a session:
     create() (and a title landing) still flush synchronously, so session/list
     answers after any crash. */
  flushIndex(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    dirtyStores.delete(this);
    const entries = [...this.index.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    writeFileSync(join(this.home, "index.json"), JSON.stringify(entries, null, 2));
  }

  private scheduleFlush(): void {
    dirtyStores.add(this);
    installExitHook();
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushIndex();
    }, INDEX_FLUSH_MS);
    this.flushTimer.unref?.();
  }

  private append(sessionId: string, record: Record_): void {
    appendFileSync(this.file(sessionId), `${JSON.stringify(record)}\n`);
  }

  /** A line written exactly as it was read — the fork path's copy primitive. */
  private appendRaw(sessionId: string, line: string): void {
    appendFileSync(this.file(sessionId), `${line}\n`);
  }

  appendToolError(record: ToolErrorRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    if (this.toolErrorsFd === null) {
      const path = join(this.home, "tool-errors.jsonl");
      this.toolErrorsFd = openSync(path, "a", 0o600);
      try {
        fchmodSync(this.toolErrorsFd, 0o600);
      } catch (error) {
        closeSync(this.toolErrorsFd);
        this.toolErrorsFd = null;
        throw error;
      }
    }
    let offset = 0;
    while (offset < line.length) offset += writeSync(this.toolErrorsFd, line, offset, "utf8");
  }

  create(sessionId: string, cwd: string): void {
    this.append(sessionId, { t: "meta", cwd, createdAt: Date.now() });
    this.index.set(sessionId, { sessionId, cwd, title: null, updatedAt: Date.now() });
    this.flushIndex();
  }

  has(sessionId: string): boolean {
    return existsSync(this.file(sessionId));
  }

  /** Drop a session's log and its index entry — the store half of
      `session/delete`. True when anything was there; false is the caller's
      cue to answer `invalid params` rather than pretend. */
  delete(sessionId: string): boolean {
    const known = this.index.delete(sessionId);
    let removed = false;
    try {
      rmSync(this.file(sessionId));
      removed = true;
    } catch {
      // No file — the index entry is still worth dropping.
    }
    if (known || removed) this.flushIndex();
    return known || removed;
  }

  appendMessages(sessionId: string, messages: ModelMessage[]): void {
    for (const m of messages) this.append(sessionId, { t: "msg", m });
  }

  appendUpdate(sessionId: string, u: UpdateParams): void {
    this.append(sessionId, { t: "update", u });
  }

  setMode(sessionId: string, mode: string): void {
    this.append(sessionId, { t: "mode", mode });
  }

  appendCompaction(sessionId: string): void {
    this.append(sessionId, { t: "compact" });
  }

  touch(sessionId: string, title?: string): void {
    const entry = this.index.get(sessionId);
    if (!entry) return;
    entry.updatedAt = Date.now();
    if (title && !entry.title) {
      entry.title = title; // a title lands once per session — worth a sync flush
      this.flushIndex();
    } else {
      this.scheduleFlush();
    }
  }

  /** The generated title replaces the first-line one `touch` landed. */
  retitle(sessionId: string, title: string): void {
    const entry = this.index.get(sessionId);
    if (!entry) return;
    entry.title = title;
    this.flushIndex();
  }

  read(sessionId: string): SessionHistory | null {
    const path = this.file(sessionId);
    const history: SessionHistory = {
      cwd: "",
      messages: [],
      updates: [],
      mode: null,
      lastTokens: 0,
      subagents: [],
    };
    const subagents = new Map<string, SubagentEntry>();
    const applyLine = (line: string): void => {
      if (!line.trim()) return;
      let record: Record_;
      try {
        record = JSON.parse(line) as Record_;
      } catch {
        return; // a torn tail line (crash mid-write) loses one record, not the session
      }
      if (record.t === "meta") history.cwd = record.cwd;
      else if (record.t === "msg") history.messages.push(record.m);
      else if (record.t === "compact") history.messages = [];
      else if (record.t === "mode") history.mode = record.mode;
      else if (record.t === "subagent") {
        subagents.set(record.id, {
          id: record.id,
          name: record.name,
          task: record.task,
          status: record.status,
          messages: [],
        });
      } else if (record.t === "subagent_messages") {
        const entry = subagents.get(record.id);
        if (entry) entry.messages.push(...record.messages);
      } else if (record.t === "subagent_status") {
        const entry = subagents.get(record.id);
        if (entry) entry.status = record.status;
      } else {
        history.updates.push(record.u);
        /* The provider's own reading of the last step, cache included — the
           figure compaction thresholds against. Only the session's own updates
           count: a subagent's steps are journaled in this same file addressed
           to the child id, and its context is a fraction of the parent's. */
        if (record.u.sessionId === sessionId) {
          const update = record.u.update as { sessionUpdate?: string; used?: unknown };
          if (update.sessionUpdate === "usage_update" && typeof update.used === "number" && Number.isFinite(update.used)) {
            history.lastTokens = update.used;
          }
        }
      }
    };
    /* Streamed a chunk at a time — a long session's file is never held whole
       as one string plus its split() copy. */
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return null;
    }
    try {
      const buf = Buffer.alloc(READ_CHUNK);
      const decoder = new StringDecoder("utf8");
      let pending = "";
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, null);
        if (n <= 0) break;
        pending += decoder.write(buf.subarray(0, n));
        let nl = pending.indexOf("\n");
        while (nl >= 0) {
          applyLine(pending.slice(0, nl));
          pending = pending.slice(nl + 1);
          nl = pending.indexOf("\n");
        }
      }
      applyLine(pending + decoder.end());
    } finally {
      closeSync(fd);
    }
    history.subagents = [...subagents.values()];
    return history;
  }

  createSubagent(sessionId: string, entry: Omit<SubagentEntry, "messages">): void {
    this.append(sessionId, { t: "subagent", ...entry });
    this.activeSubagents.add(`${sessionId}:${entry.id}`);
  }

  claimSubagent(sessionId: string, id: string): boolean {
    const key = `${sessionId}:${id}`;
    if (this.activeSubagents.has(key)) return false;
    this.activeSubagents.add(key);
    return true;
  }

  releaseSubagent(sessionId: string, id: string): void {
    this.activeSubagents.delete(`${sessionId}:${id}`);
  }

  appendSubagentMessages(sessionId: string, id: string, messages: ModelMessage[]): void {
    if (messages.length > 0) this.append(sessionId, { t: "subagent_messages", id, messages });
  }

  setSubagentStatus(sessionId: string, id: string, status: SubagentStatus): void {
    this.append(sessionId, { t: "subagent_status", id, status });
  }

  listSubagents(sessionId: string): SubagentEntry[] {
    return (this.read(sessionId)?.subagents ?? []).map((entry) => {
      if (entry.status !== "running" || this.activeSubagents.has(`${sessionId}:${entry.id}`)) return entry;
      this.setSubagentStatus(sessionId, entry.id, "stopped");
      return { ...entry, status: "stopped" };
    });
  }

  subagent(sessionId: string, id: string): SubagentEntry | null {
    return this.listSubagents(sessionId).find((entry) => entry.id === id || entry.name === id) ?? null;
  }

  list(cwd: string | null | undefined, cursor: string | null | undefined): {
    sessions: IndexEntry[];
    nextCursor: string | null;
  } {
    const all = [...this.index.values()]
      .filter((e) => (cwd ? e.cwd === cwd : true))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const offset = cursor ? Number.parseInt(cursor, 10) || 0 : 0;
    const page = all.slice(offset, offset + LIST_PAGE);
    return {
      sessions: page,
      nextCursor: offset + LIST_PAGE < all.length ? String(offset + LIST_PAGE) : null,
    };
  }

  /* ---- fork ---- */

  /** Read the log as its raw lines, torn tail included. The lines are what a
      fork copies — never a parse and a re-stringify, which is how a record the
      reader of today has not met survives into the fork the reader of tomorrow
      reads. */
  private lines(sessionId: string): string[] {
    const out: string[] = [];
    let fd: number;
    try {
      fd = openSync(this.file(sessionId), "r");
    } catch {
      return out;
    }
    try {
      const buf = Buffer.alloc(READ_CHUNK);
      const decoder = new StringDecoder("utf8");
      let pending = "";
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, null);
        if (n <= 0) break;
        pending += decoder.write(buf.subarray(0, n));
        let nl = pending.indexOf("\n");
        while (nl >= 0) {
          out.push(pending.slice(0, nl));
          pending = pending.slice(nl + 1);
          nl = pending.indexOf("\n");
        }
      }
      if (pending) out.push(pending + decoder.end());
    } finally {
      closeSync(fd);
    }
    return out;
  }

  /**
   * Copy a session's log into a fresh session id, cut at an ACP message id —
   * the persisted half of the fork-point extension `session/fork` carries.
   *
   * The two streams in one file cut differently, and the difference is the
   * whole method. `update` records (the replay a `session/load` sends back)
   * carry the message id the cut is named for, so the boundary is exact there;
   * `msg` records (what the model sees) do not carry ids at all — but the
   * records of the turn that produced `point` are appended only once the turn
   * has settled, *after* every update that turn streamed. So the honest cut
   * for both streams is: everything up to and including the turn's own
   * records, which ends at the first record that could only belong to what
   * came after — the next turn's opening user message, or a compaction
   * barrier raised at its door (cut *before* the barrier: the summary behind
   * it describes a history that runs past the cut, and keeping the barrier
   * without the summary would hand `read` a license to drop the prefix it was
   * kept for).
   *
   * `point === null` is the spec's own fork-at-tip: the whole log, no cut.
   * Returns the new id, or null when no record carries `point` — a caller that
   * asked to cut where there is nothing to cut at, which is its refusal to
   * answer, not this store's.
   */
  fork(fromId: string, point: string | null): string | null {
    const raw = this.lines(fromId);
    if (raw.length === 0) return null;
    const parse = (line: string): Record_ | null => {
      try {
        return JSON.parse(line) as Record_;
      } catch {
        return null;
      }
    };
    let cut = raw.length;
    if (point !== null) {
      let seen = -1;
      for (let i = 0; i < raw.length; i += 1) {
        const record = parse(raw[i]!);
        if (
          record &&
          record.t === "update" &&
          (record.u.update as { messageId?: string } | null)?.messageId === point
        ) {
          seen = i;
        }
      }
      if (seen < 0) return null;
      for (let i = seen + 1; i < raw.length; i += 1) {
        const record = parse(raw[i]!);
        if (record && (record.t === "compact" || (record.t === "msg" && record.m.role === "user"))) {
          cut = i;
          break;
        }
      }
    }
    const source = this.index.get(fromId);
    const meta = parse(raw[0]!);
    const cwd = source?.cwd ?? (meta?.t === "meta" ? meta.cwd : "");
    const newId = randomUUID();
    /* create() writes the new meta record and the index entry; the copied
       lines then follow it, source meta skipped — line 0 is always the
       source's own. */
    this.create(newId, cwd);
    for (const line of raw.slice(1, cut)) this.appendRaw(newId, line);
    if (source?.title) this.touch(newId, source.title);
    return newId;
  }
}

