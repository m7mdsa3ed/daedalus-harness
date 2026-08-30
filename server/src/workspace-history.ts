import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DATA_DIR } from "./config.js";

export interface WorkspaceEntry {
  path: string;
  type: "file" | "directory" | "symlink";
  mode: number;
  mtimeMs: number;
  size?: number;
  hash?: string;
  target?: string;
}

export interface GitWorkspaceState {
  headRef: string | null;
  headOid: string | null;
  indexHash: string | null;
  indexPath: string | null;
}

export interface WorkspaceManifest {
  version: 1;
  root: string;
  entries: WorkspaceEntry[];
  git: GitWorkspaceState | null;
  totalBytes: number;
  digest: string;
}

export interface WorkspaceSnapshot extends WorkspaceManifest {
  id: string;
  createdAt: number;
}

export class WorkspaceConflictError extends Error {
  constructor() {
    super("The workspace changed after the last agent turn. Revert was blocked to avoid overwriting intervening edits.");
    this.name = "WorkspaceConflictError";
  }
}

/** The workspace is too big to snapshot. Thrown by `capture`/`manifest` only —
    the caller degrades the turn to "no checkpoint" rather than failing it, so
    this is a named class and not a bare Error. */
export class WorkspaceSnapshotLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceSnapshotLimitError";
  }
}

const HISTORY_DIR = join(DATA_DIR, "history");
const BLOBS_DIR = join(HISTORY_DIR, "blobs");
const SNAPSHOTS_DIR = join(HISTORY_DIR, "snapshots");

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedRoot(cwd: string): string {
  const root = resolve(cwd);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error(`workspace does not exist: ${root}`);
  return root;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/* What a snapshot is *not* about. A checkpoint exists to undo what an agent
   typed, and an agent does not type node_modules — but scanning one costs the
   whole byte budget (and reads every file to hash it), which is how a snapshot
   of a perfectly ordinary repo came back over half a gigabyte. In a git
   workspace the authority is git itself (tracked + untracked-not-ignored), so
   the project's own .gitignore decides; this list is the fallback for a
   workspace that is not a repo, plus whatever `history.ignore` adds. */
const DEFAULT_IGNORES = [
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".gradle",
  ".terraform",
  "coverage",
  ".pnpm-store",
];

function gitOutput(root: string, args: string[], raw = false): string | null {
  try {
    const out = execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    // A repo with nothing in it answers "" — which is an answer, not a failure,
    // so only the trimmed (single-value) callers treat empty as null.
    return raw ? out : out.trim() || null;
  } catch {
    return null;
  }
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

/** The set of paths a snapshot covers: everything else in the workspace is
    left alone, both when capturing and when restoring. */
interface Scope {
  /** Non-null when git enumerated the workspace: the exact files it listed,
      plus every directory on the way to one. Null means "walk and skip the
      ignored names". */
  files: Set<string> | null;
  directories: Set<string> | null;
  ignored: Set<string>;
}

export class WorkspaceSnapshotService {
  private readonly maxSnapshotBytes: number;
  private readonly ignored: Set<string>;

  constructor(maxSnapshotBytes = 512 * 1024 * 1024, ignore: string[] = []) {
    this.maxSnapshotBytes = maxSnapshotBytes;
    this.ignored = new Set([...DEFAULT_IGNORES, ...ignore]);
    mkdirSync(BLOBS_DIR, { recursive: true });
    mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  }

  capture(cwd: string): WorkspaceSnapshot {
    const manifest = this.scan(cwd, true);
    const id = randomUUID();
    const snapshot: WorkspaceSnapshot = { ...manifest, id, createdAt: Date.now() };
    writeFileSync(join(SNAPSHOTS_DIR, `${id}.json`), JSON.stringify(snapshot));
    return snapshot;
  }

  manifest(cwd: string): WorkspaceManifest {
    return this.scan(cwd, false);
  }

  load(id: string): WorkspaceSnapshot {
    const path = join(SNAPSHOTS_DIR, `${id}.json`);
    if (!existsSync(path)) throw new Error(`workspace snapshot not found: ${id}`);
    return JSON.parse(readFileSync(path, "utf8")) as WorkspaceSnapshot;
  }

  delete(snapshotId: string): void {
    rmSync(join(SNAPSHOTS_DIR, `${snapshotId}.json`), { force: true });
    const referenced = new Set<string>();
    for (const name of readdirSync(SNAPSHOTS_DIR)) {
      if (!name.endsWith(".json")) continue;
      try {
        const snapshot = JSON.parse(readFileSync(join(SNAPSHOTS_DIR, name), "utf8")) as WorkspaceSnapshot;
        for (const entry of snapshot.entries) if (entry.hash) referenced.add(entry.hash);
        if (snapshot.git?.indexHash) referenced.add(snapshot.git.indexHash);
      } catch (error) {
        console.warn(`[history] couldn't inspect snapshot ${name} during cleanup`, error);
      }
    }
    for (const hash of readdirSync(BLOBS_DIR)) {
      if (!referenced.has(hash)) rmSync(join(BLOBS_DIR, hash), { force: true });
    }
  }

  assertMatches(cwd: string, expected: WorkspaceManifest | null): void {
    if (!expected) return;
    if (this.manifest(cwd).digest !== expected.digest) throw new WorkspaceConflictError();
  }

  restore(cwd: string, snapshotId: string): WorkspaceSnapshot {
    const root = normalizedRoot(cwd);
    const snapshot = this.load(snapshotId);
    if (resolve(snapshot.root) !== root) throw new Error("snapshot belongs to a different workspace");

    /* Only what the snapshot covers is touched. Wiping the root instead — the
       older rule — deleted every ignored path with it, so a revert of a one-line
       edit also threw away node_modules, .venv and the build the workspace was
       mid-way through. */
    const current = new Map(this.scan(root, false).entries.map((entry) => [entry.path, entry]));
    const keep = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
    const stale = [...current.values()].filter((entry) => {
      const wanted = keep.get(entry.path);
      return !wanted || wanted.type !== entry.type;
    });
    for (const entry of stale) {
      if (entry.type !== "directory") rmSync(this.entryPath(root, entry.path), { force: true });
    }
    // Deepest first, so a directory is emptied of its own stale children before
    // it is removed; `recursive` then only sweeps what the scan never saw.
    for (const entry of stale.filter((e) => e.type === "directory").sort((a, b) => b.path.length - a.path.length)) {
      rmSync(this.entryPath(root, entry.path), { recursive: true, force: true });
    }

    const directories = snapshot.entries.filter((entry) => entry.type === "directory");
    for (const entry of directories) mkdirSync(this.entryPath(root, entry.path), { recursive: true, mode: entry.mode });
    for (const entry of snapshot.entries) {
      if (entry.type === "directory") continue;
      const path = this.entryPath(root, entry.path);
      const existing = current.get(entry.path);
      mkdirSync(dirname(path), { recursive: true });
      if (entry.type === "symlink") {
        if (existing?.type === "symlink" && existing.target === entry.target) continue;
        rmSync(path, { force: true });
        symlinkSync(entry.target ?? "", path);
      } else {
        if (!entry.hash) throw new Error(`snapshot file has no blob: ${entry.path}`);
        // Rewriting a file the agent never touched costs a copy and moves its
        // mtime, which is what every watcher in the workspace rebuilds on.
        if (existing?.hash === entry.hash && existing.mode === entry.mode && existing.mtimeMs === entry.mtimeMs) {
          continue;
        }
        copyFileSync(join(BLOBS_DIR, entry.hash), path);
        chmodSync(path, entry.mode);
        utimesSync(path, entry.mtimeMs / 1000, entry.mtimeMs / 1000);
      }
    }
    for (const entry of [...directories].reverse()) {
      const path = this.entryPath(root, entry.path);
      chmodSync(path, entry.mode);
      utimesSync(path, entry.mtimeMs / 1000, entry.mtimeMs / 1000);
    }
    this.restoreGit(root, snapshot.git);
    return snapshot;
  }

  /** Name what filled the budget: "too big" with no culprit is a dead end, and
      the culprit is usually one directory the project has not gitignored. */
  private tooBig(byTop: Map<string, number>): WorkspaceSnapshotLimitError {
    const worst = [...byTop.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, bytes]) => `${name} (${megabytes(bytes)})`)
      .join(", ");
    return new WorkspaceSnapshotLimitError(
      `The workspace is larger than the ${megabytes(this.maxSnapshotBytes)} checkpoint limit` +
        (worst ? `; the biggest paths are ${worst}` : "") +
        ". Ignore what does not need reverting (.gitignore, or history.ignore in config.json), or raise history.maxSnapshotBytes.",
    );
  }

  private entryPath(root: string, path: string): string {
    const resolved = resolve(root, path);
    if (!inside(root, resolved) || resolved === root) throw new Error(`invalid snapshot path: ${path}`);
    return resolved;
  }

  /* Ask git what the workspace *is*, and fall back to name matching when there
     is no answer. `--cached --others --exclude-standard` is tracked files plus
     untracked ones the project has not ignored — which is the same set the
     agent could plausibly have edited. Directories are derived from those
     paths: git cannot track an empty one, and restore no longer deletes what
     it did not capture, so an empty directory simply survives a revert. */
  private scopeOf(root: string): Scope {
    const listed = gitOutput(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], true);
    if (listed === null) return { files: null, directories: null, ignored: this.ignored };
    const files = new Set(listed.split("\0").filter(Boolean));
    const directories = new Set<string>();
    for (const path of files) {
      let directory = dirname(path);
      while (directory && directory !== "." && directory !== "/") {
        if (directories.has(directory)) break;
        directories.add(directory);
        directory = dirname(directory);
      }
    }
    return { files, directories, ignored: this.ignored };
  }

  private scan(cwd: string, storeBlobs: boolean): WorkspaceManifest {
    const root = normalizedRoot(cwd);
    const scope = this.scopeOf(root);
    const entries: WorkspaceEntry[] = [];
    const byTop = new Map<string, number>();
    let totalBytes = 0;

    const walk = (directory: string) => {
      for (const name of readdirSync(directory).sort()) {
        const absolute = join(directory, name);
        const path = relative(root, absolute).split(sep).join("/");
        const stat = lstatSync(absolute);
        const isDirectory = !stat.isSymbolicLink() && stat.isDirectory();
        if (scope.files) {
          if (isDirectory ? !scope.directories?.has(path) : !scope.files.has(path)) continue;
        } else if (scope.ignored.has(name)) {
          continue;
        }
        const base = { path, mode: stat.mode & 0o7777, mtimeMs: Math.trunc(stat.mtimeMs) };
        if (stat.isSymbolicLink()) {
          entries.push({ ...base, type: "symlink", target: readlinkSync(absolute) });
        } else if (isDirectory) {
          entries.push({ ...base, type: "directory" });
          walk(absolute);
        } else if (stat.isFile()) {
          const content = readFileSync(absolute);
          totalBytes += content.byteLength;
          const top = path.split("/")[0];
          byTop.set(top, (byTop.get(top) ?? 0) + content.byteLength);
          if (totalBytes > this.maxSnapshotBytes) throw this.tooBig(byTop);
          const hash = sha256(content);
          entries.push({ ...base, type: "file", size: content.byteLength, hash });
          if (storeBlobs) this.storeBlob(hash, content);
        } else {
          // A socket or a device node is not something a revert can put back.
          continue;
        }
      }
    };
    walk(root);
    const git = this.captureGit(root, storeBlobs);
    if (git?.indexHash && existsSync(join(BLOBS_DIR, git.indexHash))) {
      totalBytes += lstatSync(join(BLOBS_DIR, git.indexHash)).size;
    }
    const unsigned = { version: 1 as const, root, entries, git, totalBytes };
    return { ...unsigned, digest: sha256(JSON.stringify(unsigned)) };
  }

  private storeBlob(hash: string, content: Buffer): void {
    const path = join(BLOBS_DIR, hash);
    if (!existsSync(path)) writeFileSync(path, content, { flag: "wx" });
  }

  private captureGit(root: string, storeBlobs: boolean): GitWorkspaceState | null {
    if (!existsSync(join(root, ".git"))) return null;
    const top = gitOutput(root, ["rev-parse", "--show-toplevel"]);
    if (!top || resolve(top) !== root) return null;
    const indexRaw = gitOutput(root, ["rev-parse", "--git-path", "index"]);
    const indexPath = indexRaw ? (isAbsolute(indexRaw) ? indexRaw : resolve(root, indexRaw)) : null;
    let indexHash: string | null = null;
    if (indexPath && inside(root, indexPath) && existsSync(indexPath)) {
      const content = readFileSync(indexPath);
      indexHash = sha256(content);
      if (storeBlobs) this.storeBlob(indexHash, content);
    }
    return {
      headRef: gitOutput(root, ["symbolic-ref", "-q", "HEAD"]),
      headOid: gitOutput(root, ["rev-parse", "--verify", "HEAD"]),
      indexHash,
      indexPath: indexPath && inside(root, indexPath) ? relative(root, indexPath).split(sep).join("/") : null,
    };
  }

  private restoreGit(root: string, git: GitWorkspaceState | null): void {
    if (!git || !existsSync(join(root, ".git"))) return;
    if (git.indexHash && git.indexPath) {
      const indexPath = this.entryPath(root, git.indexPath);
      mkdirSync(dirname(indexPath), { recursive: true });
      copyFileSync(join(BLOBS_DIR, git.indexHash), indexPath);
    }
    if (!git.headOid) return;
    if (git.headRef) {
      execFileSync("git", ["-C", root, "symbolic-ref", "HEAD", git.headRef]);
      execFileSync("git", ["-C", root, "update-ref", git.headRef, git.headOid]);
    } else {
      execFileSync("git", ["-C", root, "update-ref", "--no-deref", "HEAD", git.headOid]);
    }
  }
}
