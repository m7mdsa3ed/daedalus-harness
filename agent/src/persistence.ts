import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
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
/* A compaction barrier: on read, messages before it are dropped — the summary
   message that follows it is what the model sees, while the update records
   (the human-readable transcript) are all kept for replay. */
interface CompactRecord {
  t: "compact";
}
type Record_ = MetaRecord | MsgRecord | UpdateRecord | CompactRecord;

export interface SessionHistory {
  cwd: string;
  messages: ModelMessage[];
  updates: UpdateParams[];
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

  create(sessionId: string, cwd: string): void {
    this.append(sessionId, { t: "meta", cwd, createdAt: Date.now() });
    this.index.set(sessionId, { sessionId, cwd, title: null, updatedAt: Date.now() });
    this.flushIndex();
  }

  has(sessionId: string): boolean {
    return existsSync(this.file(sessionId));
  }

  appendMessages(sessionId: string, messages: ModelMessage[]): void {
    for (const m of messages) this.append(sessionId, { t: "msg", m });
  }

  appendUpdate(sessionId: string, u: UpdateParams): void {
    this.append(sessionId, { t: "update", u });
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

  read(sessionId: string): SessionHistory | null {
    const path = this.file(sessionId);
    const history: SessionHistory = { cwd: "", messages: [], updates: [] };
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
      else history.updates.push(record.u);
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
    return history;
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
}
