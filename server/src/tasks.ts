import { watch, type FSWatcher } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Tailing background-task journals.
 *
 * Some agents launch work that outlives the ACP turn — Claude Code's Workflow
 * tool answers "launched in background" and then appends progress to a
 * `journal.jsonl` in a transcript directory it names in the tool result. No
 * ACP frame ever carries that progress, and the file lives on this machine,
 * where the agent process runs — so the server is the only party that can
 * watch it. This tails the file and hands each new line to the caller, who
 * fans it out to the thread's peers as a `task_event`.
 *
 * The file itself is the durable store: a watch request answers with
 * everything parsed so far, and only later lines travel over the WebSocket —
 * nothing here touches the thread's event log, which would otherwise absorb an
 * unbounded second protocol it never replays correctly.
 */

const JOURNAL_FILE = "journal.jsonl";
/** Live watchers at once. Beyond it the longest-quiet one is dropped — the
    newest ask is the one a person is actually looking at. */
const MAX_WATCHERS = 32;
/** Nothing appended for this long = the task is over or abandoned. Clients
    re-watch periodically while a panel is open, which resets this — so it only
    ever reaps journals nobody is reading. */
const IDLE_MS = 15 * 60_000;
/** How often a watch whose directory does not exist yet looks for it. The
    agent announces the transcript dir as it launches the task, so the client
    asks a beat before the directory is created — see `watch`. */
const PENDING_POLL_MS = 2_000;
/** Per-read ceiling. A journal is a few KB of progress lines; anything growing
    past this is being read in slices rather than slurped in one allocation. */
const MAX_READ_BYTES = 4 * 1024 * 1024;

/** A refusal with the HTTP status it deserves — the route maps it straight. */
export class TaskDirError extends Error {
  status: 400 | 403 | 404;
  constructor(message: string, status: 400 | 403 | 404) {
    super(message);
    this.status = status;
  }
}

export interface SessionRef {
  id: string;
  acpSessionId?: string;
  deletedAt: number | null;
}

interface TaskWatch {
  /** The requested path, canonicalized once it exists. Also the map key. */
  key: string;
  dir: string;
  file: string;
  /** Daedalus session id — where the fan-out goes. */
  sessionId: string;
  /** Bytes of the file already consumed. */
  offset: number;
  /** Trailing partial line — a writer can be mid-append when we read. */
  buf: string;
  /** Set once the directory exists and is being watched directly. */
  watcher: FSWatcher | null;
  /** Set while the directory does not exist yet; replaced by `watcher`. */
  poll: ReturnType<typeof setInterval> | null;
  lastActivity: number;
  draining: boolean;
  dirty: boolean;
}

/**
 * The thread this path belongs to, or null.
 *
 * A live session's ACP id has to appear as a literal path segment. That is
 * what turns "read any directory on this machine" into "read a transcript dir
 * an agent actually disclosed for a thread" — the client only ever learns
 * these paths from a tool-call frame, and the server itself never interprets
 * those frames (see CLAUDE.md), so the client carrying it back is the honest
 * channel. Checked against the canonical path too, so a symlink cannot smuggle
 * the read somewhere else.
 */
function ownerOf(dir: string, sessions: SessionRef[]): SessionRef | null {
  const segments = dir.split(path.sep);
  return (
    sessions.find(
      (s) => s.deletedAt === null && s.acpSessionId && segments.includes(s.acpSessionId),
    ) ?? null
  );
}

export class TaskTailer {
  private watches = new Map<string, TaskWatch>();
  private emit: (sessionId: string, dir: string, event: unknown) => void;

  constructor(emit: (sessionId: string, dir: string, event: unknown) => void) {
    this.emit = emit;
    setInterval(() => {
      const now = Date.now();
      for (const w of this.watches.values()) {
        if (now - w.lastActivity > IDLE_MS) this.stop(w);
      }
    }, 60_000).unref();
  }

  /**
   * Validate the directory, start tailing it (idempotent), and return every
   * event journaled so far.
   *
   * A directory that does not exist yet is NOT an error: the tool result
   * naming it arrives as the task launches, so the client — which reads that
   * frame and asks immediately — routinely gets here first. Such a watch is
   * accepted, answers `pending`, and starts emitting the moment the journal
   * appears, which is why the client needs no retry loop of its own.
   */
  async watch(
    dirInput: unknown,
    sessions: SessionRef[],
  ): Promise<{ sessionId: string; events: unknown[]; pending: boolean }> {
    if (typeof dirInput !== "string" || !path.isAbsolute(dirInput)) {
      throw new TaskDirError("transcriptDir must be an absolute path", 400);
    }
    // resolve() first: the ownership check reads path segments, and `..` in
    // the input would otherwise let a segment be claimed and then escaped.
    const requested = path.resolve(dirInput);
    if (!ownerOf(requested, sessions)) {
      throw new TaskDirError("that directory does not belong to any thread's agent", 403);
    }

    // Canonicalize when it exists; a missing directory keeps the lexical path
    // and is canonicalized (and re-checked) at promotion.
    let dir = requested;
    let exists = false;
    try {
      dir = await realpath(requested);
      exists = true;
    } catch {
      /* not created yet — the poll below waits for it */
    }
    const owner = exists ? ownerOf(dir, sessions) : ownerOf(requested, sessions);
    if (!owner) {
      throw new TaskDirError("that directory does not belong to any thread's agent", 403);
    }
    if (exists && !(await stat(dir)).isDirectory()) {
      throw new TaskDirError("transcriptDir is not a directory", 400);
    }

    const existing = this.watches.get(dir);
    if (existing) {
      existing.lastActivity = Date.now();
      // Another tab (or a poll) asking about a dir already tailed: answer from
      // the file without touching the watcher's offset. An event straddling
      // this read and the live stream arrives twice; the client dedupes.
      return {
        sessionId: owner.id,
        events: await readEvents(existing.file),
        pending: existing.watcher === null,
      };
    }
    if (this.watches.size >= MAX_WATCHERS) {
      const oldest = [...this.watches.values()].sort(
        (a, b) => a.lastActivity - b.lastActivity,
      )[0];
      if (oldest) this.stop(oldest);
    }

    const w: TaskWatch = {
      key: dir,
      dir,
      file: path.join(dir, JOURNAL_FILE),
      sessionId: owner.id,
      offset: 0,
      buf: "",
      lastActivity: Date.now(),
      draining: false,
      dirty: false,
      watcher: null,
      poll: null,
    };
    this.watches.set(w.key, w);
    if (!exists) {
      /* Polling rather than watching an ancestor: the directory arrives
         several levels deep at once (…/subagents/workflows/wf_x), and
         fs.watch is not recursive, so an ancestor watch would simply never
         see it. A stat every couple of seconds on at most MAX_WATCHERS paths
         is the cheaper correct thing. */
      w.poll = setInterval(() => void this.promote(w, sessions), PENDING_POLL_MS);
      w.poll.unref();
      return { sessionId: owner.id, events: [], pending: true };
    }
    this.attach(w);
    // The first drain doubles as the response: everything already on disk,
    // with the offset left at EOF so live emits pick up exactly after it. The
    // watcher is already attached, so a line landing mid-read is not lost —
    // its change event folds into this drain via the dirty flag.
    const events = await this.drain(w, false);
    return { sessionId: owner.id, events, pending: false };
  }

  /** Start watching the directory itself. Watching the directory rather than
      the journal is deliberate: the file may not exist yet, and only a
      directory watch sees it appear. */
  private attach(w: TaskWatch): void {
    w.watcher = watch(w.dir, () => void this.drain(w, true).catch(() => {}));
    w.watcher.on("error", () => this.stop(w));
  }

  /** A pending watch's directory may have appeared. Re-verifies ownership
      against the canonical path — the name could have been created as a
      symlink pointing anywhere — then takes over from the poll. */
  private async promote(w: TaskWatch, sessions: SessionRef[]): Promise<void> {
    if (this.watches.get(w.key) !== w || w.watcher) return;
    let real: string;
    try {
      real = await realpath(w.dir);
      if (!(await stat(real)).isDirectory()) return;
    } catch {
      return; // still not there
    }
    if (!ownerOf(real, sessions)) {
      this.stop(w);
      return;
    }
    if (w.poll) clearInterval(w.poll);
    w.poll = null;
    w.dir = real;
    w.file = path.join(real, JOURNAL_FILE);
    this.attach(w);
    // Live from the first line: the client's initial response was empty, so
    // everything the journal holds has to arrive over the stream.
    await this.drain(w, true);
  }

  private stop(w: TaskWatch): void {
    w.watcher?.close();
    if (w.poll) clearInterval(w.poll);
    this.watches.delete(w.key);
  }

  /** Consume the file from the stored offset; complete JSON lines become
      events. `live` emits them; the initial drain returns them instead. */
  private async drain(w: TaskWatch, live: boolean): Promise<unknown[]> {
    if (this.watches.get(w.key) !== w) return [];
    if (w.draining) {
      w.dirty = true;
      return [];
    }
    w.draining = true;
    const events: unknown[] = [];
    try {
      do {
        w.dirty = false;
        let size: number;
        try {
          size = (await stat(w.file)).size;
        } catch {
          break; // journal not created yet — the dir watch will say when it is
        }
        // Shrunk = truncated/rewritten; the old offset points into nothing.
        if (size < w.offset) {
          w.offset = 0;
          w.buf = "";
        }
        if (size === w.offset) break;
        const fh = await open(w.file, "r");
        try {
          const len = Math.min(size - w.offset, MAX_READ_BYTES);
          const buffer = Buffer.alloc(len);
          const { bytesRead } = await fh.read(buffer, 0, len, w.offset);
          w.offset += bytesRead;
          w.buf += buffer.toString("utf8", 0, bytesRead);
          if (w.offset < size) w.dirty = true; // sliced — go around again
        } finally {
          await fh.close();
        }
        let nl: number;
        while ((nl = w.buf.indexOf("\n")) !== -1) {
          const line = w.buf.slice(0, nl);
          w.buf = w.buf.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            const event: unknown = JSON.parse(line);
            events.push(event);
            if (live) this.emit(w.sessionId, w.key, event);
          } catch {
            // a complete but unparseable line is noise, not a partial write —
            // partials have no newline yet and are still sitting in buf
          }
        }
      } while (w.dirty);
    } finally {
      w.draining = false;
    }
    if (events.length > 0) w.lastActivity = Date.now();
    return events;
  }
}

/** The whole journal, parsed — the watch response for an already-tailed dir. */
async function readEvents(file: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const events: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // trailing partial write
    }
  }
  return events;
}
