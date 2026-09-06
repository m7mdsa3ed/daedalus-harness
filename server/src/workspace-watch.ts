/* ── Project file watcher ──
 *
 * One watcher per active project, not one per editor. An editor-scoped watcher
 * sounds cheaper right up until a workspace has twenty files open and the
 * process is holding twenty recursive handles on the same tree; and it cannot
 * see the events that matter most — a file appearing, a directory being
 * renamed — because nothing was watching where they happened.
 *
 * Events are batched. A `pnpm install` or a branch switch produces thousands
 * within a second, and forwarding each one turns a file tree into a re-render
 * loop. Past a ceiling the batch stops carrying paths at all and says
 * `overflow` instead, which means "resync, I stopped counting" — a bounded
 * message beats an unbounded one that arrives too late to matter.
 *
 * Subscribers are ref-counted: the last one to leave closes the handle, so a
 * project nobody is looking at costs nothing.
 */
import { existsSync, lstatSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

import { DEFAULT_IGNORES, projectRoot } from "./workspace-fs.js";

/** How long events are collected before a batch goes out. */
const BATCH_MS = 120;
/** Paths in one batch before it degrades to an overflow notice. */
const MAX_BATCH_PATHS = 200;

export interface WatchEvent {
  /** Project-relative, POSIX-separated. Empty for the root itself. */
  path: string;
  /** What `fs.watch` reported. It does not distinguish create from delete —
      the client re-stats what it cares about, which it has to do anyway
      because the event can arrive after a second change. */
  kind: "change" | "rename";
}

export interface WatchBatch {
  projectId: string;
  events: WatchEvent[];
  /** True when too much happened to enumerate: drop local state and reload.
      Never silent — the server logs it too. */
  overflow: boolean;
}

type Listener = (batch: WatchBatch) => void;

/* ── One handle per directory, not one recursive handle ──
 * Node's recursive `fs.watch` on Linux walks the whole tree synchronously and
 * keeps every file in a map: on a project with its `node_modules` that is
 * ~18,000 directories, three seconds with the event loop blocked and hundreds
 * of megabytes — paid on every subscribe, and every install or build under it
 * overflows the batch. So the tree is walked here, skipping what the explorer
 * hides by default. `.git` is the exception: a ref moving under it is what the
 * git trigger reads, so it is watched — except `.git/objects`, which every
 * commit and turn snapshot fans new files into and which nothing reads. */
const UNWATCHED = new Set(DEFAULT_IGNORES.filter((name) => name !== ".git"));

const isGitDir = (relDir: string) => relDir === ".git" || relDir.endsWith("/.git");

interface TreeWatcher {
  close(): void;
}

function watchTree(
  root: string,
  onEvent: (kind: WatchEvent["kind"], path: string) => void,
  onError: (err: Error) => void,
): TreeWatcher {
  const handles = new Map<string, FSWatcher>();
  let closed = false;

  const watchable = (name: string, parentRel: string) =>
    !UNWATCHED.has(name) && !(name === "objects" && isGitDir(parentRel));

  /** Drop the handle on `dir` and on everything under it. */
  const forget = (dir: string) => {
    for (const [key, handle] of handles) {
      if (key === dir || key.startsWith(dir + "/")) {
        handle.close();
        handles.delete(key);
      }
    }
  };

  /** `announce` is for a directory that appeared under a watch: its contents
      were written before its handle existed, so each entry is reported as if
      it had been seen arriving — which is what the recursive watcher did. */
  const scan = (dir: string, relDir: string, announce = false) => {
    if (closed || handles.has(dir)) return;
    let handle: FSWatcher;
    try {
      handle = watch(dir, { persistent: false });
    } catch (err) {
      if (relDir === "") onError(err as Error);
      return; // gone between the listing and the watch — not an error
    }
    handles.set(dir, handle);
    handle.on("change", (kind, filename) => {
      const name = filename == null ? "" : filename.toString();
      const path = relDir === "" ? name : name === "" ? relDir : `${relDir}/${name}`;
      onEvent(kind === "rename" ? "rename" : "change", path);
      /* A rename in a directory is a child appearing or going: a new directory
         needs a handle of its own, a removed one must not keep a stale handle
         that would leave a recreation at the same path deaf. */
      if (kind !== "rename" || name === "" || !watchable(name, relDir)) return;
      const child = join(dir, name);
      if (!existsSync(child)) return forget(child);
      try {
        if (lstatSync(child).isDirectory()) scan(child, path, true);
      } catch {
        /* raced away again */
      }
    });
    handle.on("error", (err) => {
      if (relDir === "") return onError(err);
      forget(dir); // a subdirectory removed under its watch
    });
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      if (announce) onEvent("rename", rel);
      if (!entry.isDirectory() || !watchable(entry.name, relDir)) continue;
      scan(join(dir, entry.name), rel, announce);
    }
  };

  scan(root, "");
  return {
    close() {
      closed = true;
      for (const handle of handles.values()) handle.close();
      handles.clear();
    },
  };
}

interface ProjectWatch {
  watcher: TreeWatcher;
  listeners: Set<Listener>;
  /** Told when the watch is torn down under them — see `watchProject`. */
  closers: Set<() => void>;
  pending: Map<string, WatchEvent["kind"]>;
  overflow: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const watches = new Map<string, ProjectWatch>();

function flush(projectId: string): void {
  const watch = watches.get(projectId);
  if (!watch) return;
  watch.timer = null;
  const overflow = watch.overflow;
  const events = overflow
    ? []
    : [...watch.pending].map(([path, kind]) => ({ path, kind }));
  watch.pending.clear();
  watch.overflow = false;
  if (!overflow && events.length === 0) return;

  if (overflow) {
    console.warn(
      `[workspace] watcher for project ${projectId} overflowed (> ${MAX_BATCH_PATHS} paths in ${BATCH_MS}ms) — telling clients to resync`,
    );
  }
  const batch: WatchBatch = { projectId, events, overflow };
  for (const listener of [...watch.listeners]) {
    try {
      listener(batch);
    } catch (err) {
      // One bad subscriber must not cost the others their events.
      console.error("[workspace] watch listener threw", err);
    }
  }
}

/**
 * Subscribe to a project's file events. Returns the unsubscribe.
 *
 * Throws the usual `WorkspaceError` when the project is unknown or its
 * directory is missing — the caller is a route, and those are its 404s.
 *
 * `onClose` is called when the watch goes away for a reason that is not this
 * subscriber leaving — an `fs.watch` error tearing it down, the project being
 * deleted, the process shutting down. A route does not need it: its socket dies
 * with the request. A long-lived subscriber does, because otherwise its handle
 * is silently a no-op forever and whatever it was watching for simply stops
 * happening, with nothing anywhere saying so.
 */
export function watchProject(
  projectId: string,
  listener: Listener,
  onClose?: () => void,
): () => void {
  let entry = watches.get(projectId);
  if (!entry) {
    const root = projectRoot(projectId);
    const created: ProjectWatch = {
      watcher: watchTree(
        root,
        (kind, path) => {
          if (created.pending.size >= MAX_BATCH_PATHS) created.overflow = true;
          else created.pending.set(path, kind);
          created.timer ??= setTimeout(() => flush(projectId), BATCH_MS);
        },
        (err) => {
          console.error(`[workspace] watcher for project ${projectId} failed`, err);
          /* A dead watcher that stays subscribed is worse than none: the client
             would keep trusting a tree nothing is updating. Tell everyone to
             resync, then tear it down so the next subscribe starts a fresh one. */
          created.overflow = true;
          flush(projectId);
          closeWatch(projectId);
        },
      ),
      listeners: new Set(),
      closers: new Set(),
      pending: new Map(),
      overflow: false,
      timer: null,
    };
    watches.set(projectId, created);
    entry = created;
  }

  entry.listeners.add(listener);
  if (onClose) entry.closers.add(onClose);
  return () => {
    const current = watches.get(projectId);
    if (!current) return;
    current.listeners.delete(listener);
    if (onClose) current.closers.delete(onClose);
    if (current.listeners.size === 0) closeWatch(projectId);
  };
}

function closeWatch(projectId: string): void {
  const entry = watches.get(projectId);
  if (!entry) return;
  watches.delete(projectId);
  if (entry.timer) clearTimeout(entry.timer);
  entry.listeners.clear();
  try {
    entry.watcher.close();
  } catch {
    /* already gone */
  }
  /* After the entry is gone from the map, so a subscriber that resubscribes
     from here builds a fresh watch rather than adding itself to the one being
     torn down. */
  for (const closer of [...entry.closers]) {
    try {
      closer();
    } catch (err) {
      console.error("[workspace] watch closer threw", err);
    }
  }
  entry.closers.clear();
}

/** Drop every watcher — project deleted, or the process is shutting down. */
export function stopWatching(projectId?: string): void {
  if (projectId) return closeWatch(projectId);
  for (const id of [...watches.keys()]) closeWatch(id);
}

/** Watched project ids. For tests and for the shutdown path. */
export function watchedProjects(): string[] {
  return [...watches.keys()];
}
