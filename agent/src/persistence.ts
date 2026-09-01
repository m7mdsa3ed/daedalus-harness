import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

/* One JSONL file per session — `msg` records are the model-facing history,
   `update` records are the replay stream `session/load` sends back — plus an
   index.json for `session/list`. The store is the agent's own
   (~/.daedalus-agent), like the other runtimes own theirs: it is what makes
   the harness's import-via-session/list meaningful. */
export class SessionStore {
  home: string;
  index: Map<string, IndexEntry>;

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

  private saveIndex(): void {
    const entries = [...this.index.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    writeFileSync(join(this.home, "index.json"), JSON.stringify(entries, null, 2));
  }

  private append(sessionId: string, record: Record_): void {
    appendFileSync(this.file(sessionId), `${JSON.stringify(record)}\n`);
  }

  create(sessionId: string, cwd: string): void {
    this.append(sessionId, { t: "meta", cwd, createdAt: Date.now() });
    this.index.set(sessionId, { sessionId, cwd, title: null, updatedAt: Date.now() });
    this.saveIndex();
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
    if (title && !entry.title) entry.title = title;
    this.saveIndex();
  }

  read(sessionId: string): SessionHistory | null {
    const path = this.file(sessionId);
    if (!existsSync(path)) return null;
    const history: SessionHistory = { cwd: "", messages: [], updates: [] };
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let record: Record_;
      try {
        record = JSON.parse(line) as Record_;
      } catch {
        continue; // a torn tail line (crash mid-write) loses one record, not the session
      }
      if (record.t === "meta") history.cwd = record.cwd;
      else if (record.t === "msg") history.messages.push(record.m);
      else if (record.t === "compact") history.messages = [];
      else history.updates.push(record.u);
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
