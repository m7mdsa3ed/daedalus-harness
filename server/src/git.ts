/* ── Git ──
 *
 * Structured git for the source-control panel. Three rules, and they are the
 * whole file:
 *
 * **Argument arrays, never a shell string.** Every value that reaches here came
 * from a browser — a branch name, a path, a commit message. `execFile` with an
 * array has no shell to inject into; a template string would make every one of
 * those an injection point, and "it is only my own machine" is exactly the
 * assumption that makes it worth doing properly.
 *
 * **Porcelain v2 with `-z`.** The human-readable status is not a format, it is
 * a rendering: it quotes and escapes non-ASCII paths, and a filename with a
 * newline in it silently becomes two entries. v2 is documented as stable and
 * `-z` means NUL-separated, so a path is whatever bytes lie between the
 * separators.
 *
 * **Every call is bounded.** A timeout, an output ceiling, and a structured
 * error. A repository can be enormous, a hook can hang, and `git log` on a
 * monorepo will happily hand back more than a browser wants.
 *
 * **A project is not one repository.** The cwd a project names is a directory,
 * and a directory relates to git in three ways: it *is* a worktree root, it
 * *contains* several (a folder of checkouts, a monorepo of independent repos),
 * or it *sits inside* one. All three are addressed the same way — a
 * `RepoContext`, which is a working directory plus the two path translations
 * that make its answers project-relative:
 *
 *   - `dir` is the cwd every invocation runs in, and it is always inside the
 *     project. That is what scopes `add --all`, `reset` and `status` to the
 *     part of the repository this project can see.
 *   - `scope` is the repo-relative prefix of `dir`, because porcelain paths are
 *     relative to the *worktree root* no matter where git was run — so for a
 *     project nested inside a larger repo they arrive carrying a prefix the
 *     browser has never heard of. It is stripped on the way out; paths on the
 *     way back in need no repair, since they are pathspecs and git reads those
 *     relative to the cwd.
 *   - `path` is where the repo sits in the project, `""` for the project
 *     itself. The client joins it onto a file's path to open an editor, which
 *     is the only reason it travels.
 *
 * Discovery (`repositories`) is a bounded breadth-first walk for `.git`, and it
 * does not descend through one repository looking for another: what is under a
 * checkout is that checkout's business (a submodule, a vendored tree), and the
 * walk would otherwise pay for every `node_modules` that happens to contain a
 * package published from its own repo.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { copyFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

import {
  DEFAULT_IGNORES,
  WorkspaceError,
  projectRoot,
  relativePath,
  resolveInProject,
} from "./workspace-fs.js";
import type { ChangedFile } from "./db/schema.js";

export type { ChangedFile } from "./db/schema.js";

/** Longest any single git invocation may run. Hooks are the usual culprit. */
const TIMEOUT_MS = 20_000;
/** Output ceiling per invocation. Past it the call fails rather than buffering. */
const MAX_BUFFER = 8 * 1024 * 1024;

const fail = (status: 400 | 403 | 404 | 409 | 413, message: string) =>
  new WorkspaceError(message, status);

export interface GitFile {
  /** Project-relative, POSIX-separated. */
  path: string
  /** Where it moved from, for a rename. */
  from?: string;
  index: GitState;
  worktree: GitState;
}

export type GitState =
  | "unmodified"
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "ignored"
  | "conflicted";

export interface GitStatus {
  /** False when the project is not a repository at all. */
  repository: boolean;
  /** Where this repository sits in the project; `""` is the project itself.
      Every path below is relative to it. */
  repo: string;
  branch: string | null;
  /** Null on a detached HEAD or a branch with no upstream. */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** True before the first commit — `HEAD` does not resolve yet. */
  unborn: boolean;
  staged: GitFile[];
  unstaged: GitFile[];
  untracked: GitFile[];
  conflicted: GitFile[];
}

interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * One git invocation in a project.
 *
 * `-c core.quotepath=false` so paths come back as bytes rather than as octal
 * escapes, and `--no-optional-locks` so reading status cannot block a `git`
 * the user is running in a terminal next door — this panel refreshes on every
 * file event, and taking the index lock to do it would be a nasty surprise.
 */
function run(cwd: string, args: string[], env?: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["--no-optional-locks", "-c", "core.quotepath=false", ...args],
      {
        cwd,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        ...(env ? { env: { ...process.env, ...env } } : {}),
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, stderr });
        const err = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        if (err.code === "ENOENT")
          return reject(fail(404, "git is not installed on the Daedalus server"));
        if (err.killed) return reject(fail(409, `git timed out after ${TIMEOUT_MS / 1000}s`));
        /* git's own message is the useful one — "pathspec did not match",
           "nothing to commit", the pre-commit hook's output. `stderr` is where
           it lives, and flattening it to "command failed" is how a panel ends
           up unable to explain itself. */
        const message = (stderr || stdout || err.message).trim();
        reject(fail(409, message.slice(0, 4000)));
      },
    );
  });
}

/** The worktree root that owns a directory, or null when none does. */
async function toplevelOf(dir: string): Promise<string | null> {
  try {
    const { stdout } = await run(dir, ["rev-parse", "--show-toplevel"]);
    return stdout.trim() || null;
  } catch (err) {
    /* "not a git repository" is a normal answer here, not a failure — the panel
       renders an initialize state for it. A missing binary still throws. */
    if (err instanceof WorkspaceError && err.status === 404) throw err;
    return null;
  }
}

interface RepoContext {
  /** Absolute; every invocation's cwd, always inside the project. */
  dir: string;
  /** Repo-relative prefix of `dir`. `""` when `dir` is the worktree root. */
  scope: string;
  /** Project-relative position of `dir`. `""` is the project itself. */
  path: string;
}

/**
 * The repository a request is about, or null when there is none.
 *
 * `repo` is a project-relative directory the client picked out of
 * `repositories()`. It is resolved through `resolveInProject` like every other
 * client path — the value names a directory an agent's commands will run in,
 * and "it came from our own list" is not a check.
 */
async function contextFor(projectId: string, repo?: string): Promise<RepoContext | null> {
  const root = projectRoot(projectId);
  const dir = resolveInProject(root, repo);
  const top = await toplevelOf(dir);
  if (!top) return null;
  const path = relativePath(root, dir);
  /* A named subdirectory has to be a worktree root of its own. Without this a
     `repo` of `packages/app` inside one big repository would answer with the
     whole repository's status under a path prefix that is not where those files
     live — every row wrong, and staging one of them a different file. */
  if (path !== "" && relative(top, dir) !== "")
    throw fail(400, `${path} is not a git repository root`);
  return { dir, scope: relativePath(top, dir), path };
}

async function repoOrThrow(projectId: string, repo?: string): Promise<RepoContext> {
  const context = await contextFor(projectId, repo);
  if (!context) throw fail(400, "this project is not a git repository");
  return context;
}

export interface GitRepo {
  /** Project-relative; `""` is the project directory itself. */
  path: string;
  /** What to call it — the directory's own name, or "Project" at the root. */
  name: string;
  branch: string | null;
}

/** How deep below the project a repository is still found. */
const DISCOVER_DEPTH = 4;
/** Directories the walk may look at before it gives up. */
const DISCOVER_VISIT_LIMIT = 4000;
/** Past this many repositories, stop walking — this is a picker, not a report. */
const DISCOVER_MAX = 50;

const isRepoDir = (dir: string): boolean => existsSync(join(dir, ".git"));

/**
 * Every repository this project can see: the project's own, if it has one,
 * followed by the ones in its subdirectories.
 *
 * The root entry is whatever git says the project directory belongs to, which
 * includes a worktree rooted *above* it — the project is a subtree of a larger
 * checkout, and its status is that checkout's, scoped.
 */
export async function repositories(projectId: string): Promise<GitRepo[]> {
  const root = projectRoot(projectId);
  const found: string[] = [];
  if (await toplevelOf(root)) found.push("");

  /* Breadth-first, so a shallow repository is found before the budget runs out
     on a deep one — the same reason `searchEntries` walks this way. */
  let frontier = [{ dir: root, depth: 0 }];
  let visited = 0;
  while (frontier.length > 0 && found.length < DISCOVER_MAX) {
    const next: typeof frontier = [];
    for (const { dir, depth } of frontier) {
      if (depth >= DISCOVER_DEPTH || visited > DISCOVER_VISIT_LIMIT) break;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable directory: not an error, just not searchable
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if (DEFAULT_IGNORES.includes(entry.name) || entry.name.startsWith(".")) continue;
        if (++visited > DISCOVER_VISIT_LIMIT) break;
        const child = join(dir, entry.name);
        if (isRepoDir(child)) {
          // A checkout's insides belong to that checkout — do not descend.
          found.push(relativePath(root, child));
          if (found.length >= DISCOVER_MAX) break;
          continue;
        }
        next.push({ dir: child, depth: depth + 1 });
      }
    }
    frontier = next;
  }

  const named = found.map((path) => ({
    path,
    name: path === "" ? "Project" : (path.split("/").pop() ?? path),
  }));
  /* One `rev-parse` each, so the picker can print branches. It is the reason
     the list is capped: this is N processes, and the walk above is cheap by
     comparison. */
  return Promise.all(
    named.map(async (repo) => ({
      ...repo,
      branch: await currentBranch(join(root, repo.path.split("/").join(sep))),
    })),
  );
}

async function currentBranch(dir: string): Promise<string | null> {
  try {
    const { stdout } = await run(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const name = stdout.trim();
    return name === "HEAD" || name === "" ? null : name;
  } catch {
    // An unborn branch answers with an error here; the status route has the
    // authoritative answer, and a missing name is not worth failing a list over.
    return null;
  }
}

const CODES: Record<string, GitState> = {
  ".": "unmodified",
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "conflicted",
  T: "modified", // typechange — a file became a symlink or vice versa
};

const stateOf = (code: string): GitState => CODES[code] ?? "modified";

/**
 * `git status --porcelain=v2 -z --branch --untracked-files=all`, parsed.
 *
 * The `-z` records are NUL-separated, and a rename record is *two* NUL-
 * separated fields (the path, then where it came from) inside one record —
 * which is the detail that makes a naive `split("\0")` walk out of step for
 * the rest of the file.
 *
 * `scope` is the prefix every path is reported under and this project cannot
 * see past — a record outside it is dropped rather than shown at a path that
 * does not exist here. It is `""` for all but a project nested inside a larger
 * checkout, where the `-- .` pathspec already keeps most of them out.
 */
function parseStatus(stdout: string, scope: string): Omit<GitStatus, "repository" | "repo"> {
  const inScope = (path: string) =>
    scope === "" || path === scope || path.startsWith(`${scope}/`);
  const strip = (path: string) => (scope === "" ? path : path.slice(scope.length + 1));

  const parts = stdout.split("\0");
  const status: Omit<GitStatus, "repository" | "repo"> = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    unborn: false,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };

  for (let i = 0; i < parts.length; i += 1) {
    const line = parts[i];
    if (!line) continue;

    if (line.startsWith("# ")) {
      const [, key, ...rest] = line.split(" ");
      const value = rest.join(" ");
      if (key === "branch.head") status.branch = value === "(detached)" ? null : value;
      else if (key === "branch.upstream") status.upstream = value;
      else if (key === "branch.oid" && value === "(initial)") status.unborn = true;
      else if (key === "branch.ab") {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) {
          status.ahead = Number(match[1]);
          status.behind = Number(match[2]);
        }
      }
      continue;
    }

    if (line.startsWith("? ")) {
      const path = line.slice(2);
      if (inScope(path))
        status.untracked.push({ path: strip(path), index: "untracked", worktree: "untracked" });
      continue;
    }

    if (line.startsWith("! ")) continue; // ignored; only present if asked for

    if (line.startsWith("u ")) {
      // Unmerged: `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
      const fields = line.split(" ");
      const path = fields.slice(10).join(" ");
      if (inScope(path))
        status.conflicted.push({ path: strip(path), index: "conflicted", worktree: "conflicted" });
      continue;
    }

    if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const renamed = line.startsWith("2 ");
      const fields = line.split(" ");
      const xy = fields[1] ?? "..";
      // `1`: fields 0-7 are metadata, the path is the rest.
      // `2`: one extra field (the rename score), and the source path is the
      //      NEXT NUL-separated record — consumed here so the loop stays in step.
      const path = fields.slice(renamed ? 9 : 8).join(" ");
      const from = renamed ? parts[++i] : undefined;
      if (!inScope(path)) continue;
      const index = stateOf(xy[0] ?? ".");
      const worktree = stateOf(xy[1] ?? ".");
      const file: GitFile = {
        path: strip(path),
        /* A rename out of the visible subtree keeps the arrow off the row
           rather than pointing at a path this project cannot open. */
        ...(from && inScope(from) ? { from: strip(from) } : {}),
        index,
        worktree,
      };
      if (index !== "unmodified") status.staged.push(file);
      if (worktree !== "unmodified") status.unstaged.push(file);
      continue;
    }
  }

  return status;
}

export async function status(projectId: string, repo?: string): Promise<GitStatus> {
  const context = await contextFor(projectId, repo);
  if (!context)
    return {
      repository: false,
      repo: repo ?? "",
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      unborn: false,
      staged: [],
      unstaged: [],
      untracked: [],
      conflicted: [],
    };

  /* `-- .` and not the whole repository: with a `scope` the rest of the
     checkout is not this project's, and asking for it would mean parsing (and
     on a large monorepo, buffering) changes that are then dropped. `--branch`
     still reports, pathspec or not. */
  const { stdout } = await run(context.dir, [
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--untracked-files=all",
    "--",
    ".",
  ]);
  return { repository: true, repo: context.path, ...parseStatus(stdout, context.scope) };
}

/** `--` before paths, always: a file called `-f` or `--cached` is a valid file
    and must not be read as a flag. */
const pathspec = (paths: string[]): string[] => ["--", ...paths];

export async function stage(projectId: string, paths: string[], repo?: string): Promise<void> {
  const { dir } = await repoOrThrow(projectId, repo);
  /* `.` rather than nothing: `add --all` is repository-wide wherever it is run
     from, and "stage everything" on a project inside a larger checkout must
     mean everything *this panel listed*. */
  if (paths.length === 0) await run(dir, ["add", "--all", "--", "."]);
  else await run(dir, ["add", "--", ...paths]);
}

export async function unstage(projectId: string, paths: string[], repo?: string): Promise<void> {
  const { dir } = await repoOrThrow(projectId, repo);
  /* `reset` and not `restore --staged`: before the first commit there is no
     HEAD to restore from, and `reset` handles the unborn branch. */
  await run(dir, ["reset", "--quiet", ...pathspec(paths.length === 0 ? ["."] : paths)]);
}

/**
 * Throw away working-tree changes.
 *
 * Untracked files are NOT deleted here even though the panel lists them
 * alongside modifications: `git restore` does not touch them, and quietly
 * `rm`-ing a file git has never seen is not something "discard changes" should
 * be able to do. The panel deletes those through the ordinary file route,
 * where the confirmation says "delete".
 */
export async function discard(projectId: string, paths: string[], repo?: string): Promise<void> {
  const { dir } = await repoOrThrow(projectId, repo);
  if (paths.length === 0) throw fail(400, "discard needs an explicit list of paths");
  await run(dir, ["restore", "--worktree", ...pathspec(paths)]);
}

export interface CommitResult {
  output: string;
}

export async function commit(
  projectId: string,
  message: string,
  options: { amend?: boolean; repo?: string } = {},
): Promise<CommitResult> {
  const { dir } = await repoOrThrow(projectId, options.repo);
  if (!message.trim() && !options.amend) throw fail(400, "a commit needs a message");
  const args = ["commit", "--message", message];
  if (options.amend) args.push("--amend");
  const { stdout, stderr } = await run(dir, args);
  // Hooks write to both, and their output is the interesting part of a commit
  // that did something surprising.
  return { output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") };
}

export interface BranchList {
  current: string | null;
  branches: string[];
}

export async function branches(projectId: string, repo?: string): Promise<BranchList> {
  const { dir } = await repoOrThrow(projectId, repo);
  const { stdout } = await run(dir, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  return {
    current: await currentBranch(dir),
    branches: stdout.split("\n").map((l) => l.trim()).filter(Boolean),
  };
}

export async function checkout(
  projectId: string,
  branch: string,
  options: { create?: boolean; repo?: string } = {},
): Promise<void> {
  const { dir } = await repoOrThrow(projectId, options.repo);
  if (!branch.trim()) throw fail(400, "a branch needs a name");
  /* A leading `-` is refused here rather than left to `--` placement, because
     placement does not save you: in `git checkout <name> --`, a `<name>` of
     `--force` is parsed as checkout's own `--force` flag — which discards the
     working tree — since it sits before the `--`, not after it. `-b <name>`
     happens to bind the value and git then rejects it, but relying on that
     difference between two branches of one function is exactly the kind of
     thing that breaks quietly. git's own ref rules forbid a leading `-`
     anyway, so nothing legitimate is lost. */
  if (branch.startsWith("-")) throw fail(400, "a branch name cannot start with '-'");
  await run(dir, options.create ? ["checkout", "-b", branch, "--"] : ["checkout", branch, "--"]);
}

/* ── History: the checkpoints Build mode restores to ──
   The App builder persona commits after every completed change, so the log
   is a list of restore points in the user's own words. Restoring is a *new
   commit* whose tree is the old one, never a reset: the history stays whole,
   the dev server's watcher sees an ordinary write, and a restore can itself
   be restored from. Anything uncommitted is committed first under its own
   name, so the one thing a restore never does is lose work. */

export interface GitCommit {
  hash: string;
  short: string;
  subject: string;
  author: string;
  /** Unix seconds. */
  at: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

const RS = "\x1e";
const US = "\x1f";
/** The most `log` hands back however large the limit asked for. */
const LOG_MAX = 200;

/** The most recent commits, newest first, with a per-commit shortstat. An
    unborn repository is an empty list, not an error. */
export async function log(
  projectId: string,
  options: { limit?: number; repo?: string } = {},
): Promise<GitCommit[]> {
  const { dir } = await repoOrThrow(projectId, options.repo);
  const limit = Math.max(1, Math.min(LOG_MAX, Math.floor(options.limit ?? 50)));
  let stdout: string;
  try {
    ({ stdout } = await run(dir, [
      "log",
      `--max-count=${limit}`,
      "--shortstat",
      `--format=${RS}%H${US}%h${US}%s${US}%an${US}%at`,
    ]));
  } catch (err) {
    /* No commits yet — `git log` on an unborn branch is a 128, and a fresh
       scaffold whose `git init` succeeded but whose commit did not is one. */
    if (err instanceof WorkspaceError && /does not have any commits|bad default revision|unknown revision/i.test(err.message))
      return [];
    throw err;
  }
  const out: GitCommit[] = [];
  for (const chunk of stdout.split(RS)) {
    if (!chunk.trim()) continue;
    const [head = "", ...rest] = chunk.split("\n");
    const [hash = "", short = "", subject = "", author = "", at = "0"] = head.split(US);
    if (!hash) continue;
    const stat = rest.join("\n");
    const files = /(\d+) files? changed/.exec(stat);
    const ins = /(\d+) insertions?/.exec(stat);
    const del = /(\d+) deletions?/.exec(stat);
    out.push({
      hash,
      short,
      subject,
      author,
      at: Number(at) || 0,
      filesChanged: files ? Number(files[1]) : 0,
      insertions: ins ? Number(ins[1]) : 0,
      deletions: del ? Number(del[1]) : 0,
    });
  }
  return out;
}

/** Whether the worktree has anything to commit, untracked files included. */
async function isDirty(dir: string): Promise<boolean> {
  const { stdout } = await run(dir, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
  return stdout.length > 0;
}

/** Commit under the harness's own identity when the machine has none — the
    same fallback `templates.ts` uses for the scaffold commit. */
async function commitAll(dir: string, message: string): Promise<void> {
  await run(dir, ["add", "--all"]);
  try {
    await run(dir, ["commit", "--quiet", "--message", message]);
  } catch (err) {
    if (!(err instanceof WorkspaceError) || !/user\.(name|email)|Please tell me who you are/i.test(err.message)) throw err;
    await run(dir, [
      "-c", "user.name=Daedalus", "-c", "user.email=daedalus@localhost",
      "commit", "--quiet", "--message", message,
    ]);
  }
}

/** Commit everything as a named checkpoint. Answers whether there was
    anything to commit — a clean tree is not a failure, it is "already
    checkpointed". */
export async function checkpoint(
  projectId: string,
  message: string,
  options: { repo?: string } = {},
): Promise<{ committed: boolean; commit: GitCommit | null }> {
  const { dir } = await repoOrThrow(projectId, options.repo);
  const text = message.trim() || "Checkpoint";
  if (!(await isDirty(dir))) return { committed: false, commit: null };
  await commitAll(dir, text);
  const [commit = null] = await log(projectId, { limit: 1, repo: options.repo });
  return { committed: true, commit };
}

const HASH = /^[0-9a-f]{7,40}$/;

/**
 * Make the working tree what it was at `hash`, as a new commit on top.
 *
 * Uncommitted work is committed first ("Checkpoint before restore"), then the
 * index and worktree are read from the target tree (`read-tree -u --reset`
 * removes what the target does not have, which `checkout <hash> -- .` would
 * not) and committed. Untracked, ignored files — `node_modules`, `.env` —
 * are not the tree's and are left alone. Restoring to HEAD's own tree is a
 * no-op answered as such.
 */
export async function restoreTo(
  projectId: string,
  hash: string,
  options: { repo?: string } = {},
): Promise<{ restored: boolean; commit: GitCommit | null }> {
  const { dir } = await repoOrThrow(projectId, options.repo);
  const target = hash.trim();
  if (!HASH.test(target)) throw fail(400, "a restore needs a commit hash");
  let full: string;
  let subject: string;
  try {
    ({ stdout: full } = await run(dir, ["rev-parse", "--verify", `${target}^{commit}`]));
    ({ stdout: subject } = await run(dir, ["log", "-1", "--format=%s", full.trim()]));
  } catch {
    throw fail(404, `no such commit: ${target}`);
  }
  full = full.trim();
  if (await isDirty(dir)) await commitAll(dir, "Checkpoint before restore");
  const { stdout: headTree } = await run(dir, ["rev-parse", "HEAD^{tree}"]);
  const { stdout: targetTree } = await run(dir, ["rev-parse", `${full}^{tree}`]);
  if (headTree.trim() === targetTree.trim()) return { restored: false, commit: null };
  await run(dir, ["read-tree", "-u", "--reset", full]);
  await commitAll(dir, `Restore to ${full.slice(0, 7)}: ${subject.trim()}`.slice(0, 200));
  const [commit = null] = await log(projectId, { limit: 1, repo: options.repo });
  return { restored: true, commit };
}

export type Comparison = "worktree" | "staged" | "head";

/**
 * The other side of a comparison — what the editor's diff mode puts on the
 * left. The right side is the working file, which the client already has.
 *
 * `path` is **project-relative**, and the repository is derived from it rather
 * than named: a file belongs to exactly one worktree, the one enclosing it, and
 * the editor that asks for this holds a project path and nothing else. Making
 * it carry a repository as well would put a second, redundant answer in the
 * panel descriptor — where it would be serialized, restored, and eventually
 * disagree with the path beside it.
 *
 * An empty string is a real answer (the file is new, or was deleted), so
 * "missing on that side" is not an error.
 */
export async function fileAt(
  projectId: string,
  path: string,
  comparison: Comparison,
): Promise<{ content: string; missing: boolean }> {
  if (comparison === "worktree") return { content: "", missing: true };
  const root = projectRoot(projectId);
  const absolute = resolveInProject(root, path);
  /* Up to the nearest directory that exists: a file deleted along with its
     folder still has a revision to show, and `rev-parse` needs somewhere to
     run. Never above the project. */
  let dir = dirname(absolute);
  while (dir !== root && !existsSync(dir)) dir = dirname(dir);
  if (!(await toplevelOf(dir))) throw fail(400, "this file is not in a git repository");

  /* `./` in front, so the revision's path is read relative to the cwd rather
     than to the worktree root — the same translation `scope` does for status,
     done here by git itself. */
  const name = relativePath(dir, absolute);
  const ref = comparison === "staged" ? `:./${name}` : `HEAD:./${name}`;
  try {
    const { stdout } = await run(dir, ["show", ref]);
    return { content: stdout, missing: false };
  } catch {
    return { content: "", missing: true };
  }
}

/* ── Trees: what a turn did to the worktree ──
   The review panel measures a turn by git, not by the transcript: an edit tool
   declares what it changed, a `sed` in a shell does not, and the two have to
   read the same. So the worktree is photographed as a tree object before and
   after each turn (session_turn_changes), and everything below is arithmetic
   on trees — a diff between two of them, or between one and a snapshot taken
   right now. Snapshots go through a scratch index so the real one, the thing
   `stage`/`unstage` edit and the user's own terminal reads, is never touched. */

/** The directory git runs in for a cwd, or `null` when it is not inside a
    worktree. It is the cwd itself, not the worktree root: a project inside a
    larger checkout is measured — and its diffs are cut — at the project
    (`--relative` below), the way `status` scopes itself with `-- .`. */
export async function repoDirAt(cwd: string): Promise<string | null> {
  return (await toplevelOf(cwd)) ? cwd : null;
}

/**
 * Write the whole worktree — tracked, modified, untracked, but not ignored —
 * as a tree object, and answer its id. The scratch index starts as a copy of
 * the real one so git's stat cache carries over and only files that actually
 * changed are re-hashed; on a repository with no index yet it starts empty.
 * The object is dangling (nothing references it) and git will prune it after
 * its grace period, which is why a reader treats a missing tree as
 * "unavailable" rather than as an error.
 */
export async function snapshotTree(dir: string): Promise<string> {
  const { stdout } = await run(dir, ["rev-parse", "--git-path", "index"]);
  const realIndex = join(dir, stdout.trim());
  const scratch = join(tmpdir(), `daedalus-index-${randomBytes(6).toString("hex")}`);
  try {
    if (existsSync(realIndex)) await copyFile(realIndex, scratch);
    const env = { GIT_INDEX_FILE: scratch };
    await run(dir, ["add", "--all", "--", "."], env);
    const tree = await run(dir, ["write-tree"], env);
    return tree.stdout.trim();
  } finally {
    await unlink(scratch).catch(() => {});
  }
}

/** Whether an object is still in the store — a turn's trees can be gc'd. */
export async function hasObject(dir: string, oid: string): Promise<boolean> {
  try {
    await run(dir, ["cat-file", "-e", `${oid}^{tree}`]);
    return true;
  } catch {
    return false;
  }
}

const STATUS_OF: Record<string, ChangedFile["status"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "added",
  T: "modified",
};

/**
 * The files that differ between two trees, with per-file line counts. Two
 * invocations — `--name-status` for the kind of change and `--numstat` for the
 * counts — joined on the path, because git has no single `-z` format that
 * carries both. Renames are detected so a moved file reads as one row.
 */
export async function diffTrees(dir: string, from: string, to: string): Promise<ChangedFile[]> {
  const [names, nums] = await Promise.all([
    run(dir, ["diff", "--relative", "--name-status", "-z", "-M", from, to]),
    run(dir, ["diff", "--relative", "--numstat", "-z", "-M", from, to]),
  ]);
  const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  {
    /* `--numstat -z`: `<add>\t<del>\t<path>\0`, or for a rename
       `<add>\t<del>\t\0<from>\0<to>\0`. `-` on both counts means binary. */
    const parts = nums.stdout.split("\0");
    for (let i = 0; i < parts.length; i++) {
      const head = parts[i];
      if (!head) continue;
      const [add, del, inline] = head.split("\t");
      let path = inline;
      if (path === undefined || path === "") {
        i += 2;
        path = parts[i] ?? "";
      }
      counts.set(path, {
        additions: add === "-" ? 0 : Number(add) || 0,
        deletions: del === "-" ? 0 : Number(del) || 0,
        binary: add === "-" && del === "-",
      });
    }
  }
  const files: ChangedFile[] = [];
  const parts = names.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    const kind = code[0];
    let from: string | undefined;
    let path: string;
    if (kind === "R" || kind === "C") {
      from = parts[++i] ?? "";
      path = parts[++i] ?? "";
    } else {
      path = parts[++i] ?? "";
    }
    const count = counts.get(path) ?? { additions: 0, deletions: 0, binary: false };
    files.push({
      path,
      ...(from !== undefined && kind === "R" ? { from } : {}),
      status: STATUS_OF[kind] ?? "modified",
      ...count,
    });
  }
  return files;
}

/** The unified patch between two trees, for one path or for everything. */
export async function patchBetween(dir: string, from: string, to: string, path?: string): Promise<string> {
  const { stdout } = await run(dir, [
    "diff",
    "--relative",
    "-M",
    "--no-color",
    "--no-ext-diff",
    from,
    to,
    ...(path ? ["--", path] : []),
  ]);
  return stdout;
}

/**
 * Apply a unified patch — one hunk the panel cut out of a file's diff — to the
 * index (`cached`, "stage this hunk") or, reversed, to the worktree ("discard
 * this hunk"). git checks the preimage, so a hunk whose surroundings have
 * moved on since the diff was drawn is refused with git's own explanation
 * rather than applied somewhere else.
 */
export async function applyPatch(
  projectId: string,
  patch: string,
  options: { cached?: boolean; reverse?: boolean; repo?: string } = {},
): Promise<void> {
  const { dir } = await repoOrThrow(projectId, options.repo);
  if (!patch.trim()) throw fail(400, "an empty patch applies nothing");
  const args = ["apply", "--whitespace=nowarn"];
  if (options.cached) args.push("--cached");
  if (options.reverse) args.push("--reverse");
  args.push("-");
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      "git",
      ["--no-optional-locks", ...args],
      { cwd: dir, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) return resolve();
        const message = (stderr || stdout || error.message).trim();
        reject(fail(409, message.slice(0, 4000)));
      },
    );
    child.stdin?.end(patch.endsWith("\n") ? patch : `${patch}\n`);
  });
}

/* ── Stash ──
   The working set's parking spot: set aside the uncommitted work (staged and
   unstaged alike, untracked only when asked) so a branch can be switched or a
   piece of work paused, then brought back with `apply` (which keeps the stash)
   or `pop` (which drops it). Each entry is `stash@{<n>}`; `n` is a stable index
   the list reports, and the verbs take that number rather than the message — a
   message is text from the browser and would be a pathspec/ref injection point
   if it reached a shell, whereas the numeric index is an argument git parses as
   an object name. An empty working set is not an error: "stash" with nothing to
   stash simply does nothing, and answering 409 would turn a no-op button into a
   failure. */

export interface StashEntry {
  /** The `stash@{n}` index, newest first (`git stash list` reports 0 as newest). */
  index: number;
  /** `stash@{n}` — the ref the apply/pop/drop verbs take. */
  ref: string;
  message: string;
  /** Unix seconds of the stash's author date, or null when git omits it. */
  at: number | null;
}

/** Whether there is anything to stash — `git stash` on a clean tree is a no-op
    that we answer as "nothing stashed" rather than an error. */
async function isStashable(dir: string): Promise<boolean> {
  const { stdout } = await run(dir, [
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=all",
  ]);
  return stdout.length > 0;
}

export async function stashPush(
  projectId: string,
  options: { message?: string; repo?: string } = {},
): Promise<{ created: boolean }> {
  const { dir } = await repoOrThrow(projectId, options.repo);
  if (!(await isStashable(dir))) return { created: false };
  const args = ["stash", "push", "-m", options.message?.trim() || "Stash"];
  const { stdout, stderr } = await run(dir, args);
  // "No local changes to save" is git's own clean-tree answer; treat as no-op.
  if (/No local changes to save/i.test(stderr) || /No local changes to save/i.test(stdout))
    return { created: false };
  return { created: true };
}

export async function stashList(projectId: string, repo?: string): Promise<StashEntry[]> {
  const { dir } = await repoOrThrow(projectId, repo);
  /* `%H` full hash keeps the ref unambiguous, `%gd` is the `stash@{n}`, `%s` the
     message, and a date only when one exists. Entries are NUL-grouped (`-z`) —
     a message containing a newline cannot then split across rows. */
  const { stdout } = await run(dir, [
    "stash",
    "list",
    "-z",
    "--format=%gd%x1f%s%x1f%ad%x1e",
    "--date=unix",
  ]);
  const entries: StashEntry[] = [];
  for (const group of stdout.split("\x1e")) {
    if (!group) continue;
    const [ref, message = "", date] = group.split("\x1f");
    if (!ref) continue;
    const match = /stash@\{(\d+)\}/.exec(ref);
    entries.push({
      index: match ? Number(match[1]) : entries.length,
      ref,
      message,
      at: date && /^\d+$/.test(date) ? Number(date) : null,
    });
  }
  return entries;
}

const stashRef = (index: number): string => `stash@{${index}}`;

export async function stashApply(projectId: string, index: number, repo?: string): Promise<void> {
  const { dir } = await repoOrThrow(projectId, repo);
  await run(dir, ["stash", "apply", stashRef(index)]);
}

export async function stashPop(projectId: string, index: number, repo?: string): Promise<void> {
  const { dir } = await repoOrThrow(projectId, repo);
  await run(dir, ["stash", "pop", stashRef(index)]);
}

export async function stashDrop(projectId: string, index: number, repo?: string): Promise<void> {
  const { dir } = await repoOrThrow(projectId, repo);
  await run(dir, ["stash", "drop", stashRef(index)]);
}
