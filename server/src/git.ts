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
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { copyFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

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
  /** Lines added and removed on this side (index for a staged entry, disk for
      an unstaged one). Absent for untracked, conflicted and binary files. */
  insertions?: number;
  deletions?: number;
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
function run(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
  /* Exit codes that are an *answer* rather than a failure. `git diff` exits 1
     exactly when there is a difference to report, which is what some callers
     are asking for — and re-implementing the diff to avoid the code would be
     worse than naming it here. */
  allowExit: number[] = [],
  /* Everything here is local and fast except the two that talk to a remote,
     which wait on a network and an ssh agent rather than on a disk. */
  timeoutMs: number = TIMEOUT_MS,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["--no-optional-locks", "-c", "core.quotepath=false", ...args],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        ...(env ? { env: { ...process.env, ...env } } : {}),
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, stderr });
        const err = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        if (typeof err.code === "number" && allowExit.includes(err.code))
          return resolve({ stdout, stderr });
        if (err.code === "ENOENT")
          return reject(fail(404, "git is not installed on the Daedalus server"));
        if (err.killed) return reject(fail(409, `git timed out after ${timeoutMs / 1000}s`));
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
  const root = await projectRoot(projectId);
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
  const root = await projectRoot(projectId);
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

/** What the sidebar says about a thread's checkout: its branch and the lines
    HEAD ↔ disk differ by. Cached a few seconds per directory and coalesced, so a
    list of forty threads in three projects is three reads, however often it polls.
    ponytail: tracked files only (untracked ones have no diff against HEAD), and
    two git calls per distinct cwd — a worktree-per-thread fleet pays per thread. */
export interface DirSummary {
  branch: string | null;
  files: number;
  additions: number;
  deletions: number;
}

const SUMMARY_TTL_MS = 5_000;
const summaries = new Map<string, { at: number; value: Promise<DirSummary | null> }>();

export function summaryOf(dir: string): Promise<DirSummary | null> {
  const hit = summaries.get(dir);
  if (hit && Date.now() - hit.at < SUMMARY_TTL_MS) return hit.value;
  const value = (async (): Promise<DirSummary | null> => {
    const branch = await currentBranch(dir);
    // Not a repository (or an unborn one): nothing to say, which is not an error.
    if (branch === null && !(await repoDirAt(dir))) return null;
    let stat = "";
    try {
      stat = (await run(dir, ["diff", "HEAD", "--shortstat", "--no-ext-diff"])).stdout;
    } catch {
      /* no HEAD yet: the branch alone */
    }
    const n = (re: RegExp) => Number(re.exec(stat)?.[1] ?? 0);
    return { branch, files: n(/(\d+) files? changed/), additions: n(/(\d+) insertions?/), deletions: n(/(\d+) deletions?/) };
  })();
  summaries.set(dir, { at: Date.now(), value });
  return value;
}

export async function currentBranch(dir: string): Promise<string | null> {
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
      /* A copy: the two lists get different line counts. */
      if (worktree !== "unmodified") status.unstaged.push({ ...file });
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
  const [{ stdout }, cached, worktree] = await Promise.all([
    run(context.dir, [
      "status",
      "--porcelain=v2",
      "-z",
      "--branch",
      "--untracked-files=all",
      "--",
      ".",
    ]),
    numstat(context.dir, ["--cached"]),
    numstat(context.dir, []),
  ]);
  const parsed = parseStatus(stdout, context.scope);
  const attach = (files: GitFile[], stats: Map<string, LineStat>) => {
    for (const file of files) Object.assign(file, stats.get(file.path));
  };
  attach(parsed.staged, cached);
  attach(parsed.unstaged, worktree);
  return { repository: true, repo: context.path, ...parsed };
}

interface LineStat {
  insertions: number;
  deletions: number;
}

/** `git diff --numstat -z` → path ⇒ lines. A rename record is
    `ins\tdel\t\0from\0to`; a binary file is `-\t-` and is left out. */
export function parseNumstat(stdout: string): Map<string, LineStat & { from?: string }> {
  const stats = new Map<string, LineStat & { from?: string }>();
  const parts = stdout.split("\0");
  for (let i = 0; i < parts.length; i += 1) {
    const record = parts[i];
    if (!record) continue;
    const [ins = "", del = "", ...rest] = record.split("\t");
    let path = rest.join("\t");
    let from: string | undefined;
    if (!path) {
      from = parts[i + 1];
      path = parts[i + 2] ?? "";
      i += 2;
    }
    if (!path || ins === "-") continue;
    stats.set(path, { insertions: Number(ins) || 0, deletions: Number(del) || 0, ...(from ? { from } : {}) });
  }
  return stats;
}

/** Line counts for the working set, relative to `dir` like the status is. A
    failure (an unborn HEAD on an old git) is no counts, never no status. */
async function numstat(dir: string, extra: string[]): Promise<Map<string, LineStat>> {
  try {
    const { stdout } = await run(dir, ["diff", "--numstat", "-z", "--relative", "--no-ext-diff", ...extra, "--", "."]);
    const stats = parseNumstat(stdout);
    for (const value of stats.values()) delete value.from;
    return stats;
  } catch {
    return new Map();
  }
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
  /** Remote-tracking branches, `origin/main` shaped. A switcher offers these
      as "check this out", which is a *create* — see `checkout`'s `track`. */
  remotes: string[];
}

export async function branches(projectId: string, repo?: string): Promise<BranchList> {
  const { dir } = await repoOrThrow(projectId, repo);
  const refs = (out: string) => out.split("\n").map((l) => l.trim()).filter(Boolean);
  const [local, remote] = await Promise.all([
    run(dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
    run(dir, ["for-each-ref", "--format=%(refname:short)", "refs/remotes"]),
  ]);
  return {
    current: await currentBranch(dir),
    branches: refs(local.stdout),
    /* `origin/HEAD` is a symbolic ref pointing at the remote's default branch,
       not a branch of its own: offering it would check out whatever it aliases
       under a name nobody typed. */
    remotes: refs(remote.stdout).filter((name) => !name.endsWith("/HEAD")),
  };
}

export async function checkout(
  projectId: string,
  branch: string,
  options: { create?: boolean; track?: boolean; repo?: string } = {},
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

  /* Checking out a remote-tracking branch is a *create*: `origin/feature` is
     not something you can be on, so what the user means is a local branch of
     the same name set to track it. Spelled here rather than left to git's DWIM,
     which only fires when exactly one remote has the name and silently does
     something else when two do. The local name is the ref minus its remote,
     so `origin/release/2.0` becomes `release/2.0`. */
  if (options.track) {
    const local = branch.split("/").slice(1).join("/");
    if (!local) throw fail(400, `${branch} does not name a remote branch`);
    await run(dir, ["checkout", "-b", local, "--track", branch]);
    return;
  }
  await run(dir, options.create ? ["checkout", "-b", branch, "--"] : ["checkout", branch, "--"]);
}

/* ── The remote ──
   The only two operations in this file that leave the machine, which is what
   makes them different from everything above: they wait on a network and on
   whatever credential helper the machine has, so they get a timeout of their
   own rather than the 20s a local read is held to. Anything that would *ask*
   for a password would hang instead — `GIT_TERMINAL_PROMPT=0` turns that into
   an error the panel can print, and `GIT_SSH_COMMAND`'s `BatchMode` does the
   same for the ssh half. A repository with no credentials configured fails
   loudly here, which is the only honest outcome: this server has no terminal
   to type into. */
const REMOTE_TIMEOUT_MS = 120_000;

const REMOTE_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
};

export async function sync(
  projectId: string,
  action: "pull" | "push" | "fetch",
  repo?: string,
): Promise<{ output: string }> {
  const { dir } = await repoOrThrow(projectId, repo);
  /* A fetch moves no ref of ours, so it is safe anywhere — and it is what makes
     the ahead/behind the header draws true rather than as of the last pull. */
  if (action === "fetch") {
    const { stdout, stderr } = await run(dir, ["fetch", "--all", "--prune"], REMOTE_ENV, [], REMOTE_TIMEOUT_MS);
    return { output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || "Fetched." };
  }
  const state = await status(projectId, repo);
  if (state.unborn) throw fail(409, "this repository has no commits yet");

  /* `--ff-only`: a pull that has to merge or rebase is a decision, and this is
     a button in a composer. It fails with git's own "not possible to
     fast-forward", which says exactly what happened and leaves the worktree
     untouched — better than a merge conflict nobody asked a button for.

     A push with no upstream sets one on `origin`, because "publish this
     branch" is what the user means by Push on a branch they just created; with
     an upstream it is the plain push, and git decides what that means. */
  const args =
    action === "pull"
      ? ["pull", "--ff-only"]
      : state.upstream || !state.branch
        ? ["push"]
        : ["push", "--set-upstream", "origin", state.branch];

  const { stdout, stderr } = await run(dir, args, REMOTE_ENV, [], REMOTE_TIMEOUT_MS);
  // git says "Already up to date" / "Everything up-to-date" on stdout and the
  // interesting transfer narration on stderr; both are the answer.
  return { output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") };
}

/* ── History ──
   A wrapper over `git log` for the source-control panel, and the two
   tree-arithmetic restores `session_turn_changes` and a thread rewind use:
   putting the worktree at a tree is a *new commit* whose tree is the old one,
   never a reset — the history stays whole, a watcher sees an ordinary write,
   and the restore can itself be restored from. Anything uncommitted is
   committed first under its own name, so the one thing a restore never does
   is lose work. */

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
  /** Parent hashes, newest walk order. Two or more means a merge. Empty on a
      root commit, which is what the graph draws its lanes from. */
  parents: string[];
  /** Branch and tag names pointing here, as git decorates them. */
  refs: string[];
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
      `--format=${RS}%H${US}%h${US}%s${US}%an${US}%at${US}%P${US}%D`,
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
    const [hash = "", short = "", subject = "", author = "", at = "0", parentList = "", refList = ""] =
      head.split(US);
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
      parents: parentList ? parentList.trim().split(/\s+/) : [],
      refs: refList
        .split(",")
        .map((ref) => ref.trim().replace(/^HEAD -> /, ""))
        .filter(Boolean),
    });
  }
  return out;
}

export interface CommitFile {
  path: string;
  from?: string;
  /** One letter, as `--name-status` spells it: A M D R C T. */
  status: string;
  /** Null for a binary file. */
  insertions: number | null;
  deletions: number | null;
}

export interface CommitDetail extends GitCommit {
  email: string;
  /** The whole message, subject included. */
  body: string;
  committer: string;
  committedAt: number;
  files: CommitFile[];
}

/**
 * One commit, opened: its whole message, both identities and what it changed.
 * A merge is measured against its first parent — the change it brought to the
 * branch it landed on. `HEAD` is accepted beside a hash, for "amend the last
 * commit" to read the message it is amending.
 */
export async function commitDetail(projectId: string, rev: string, repo?: string): Promise<CommitDetail> {
  const { dir } = await repoOrThrow(projectId, repo);
  if (rev !== "HEAD" && !HASH.test(rev)) throw fail(400, "a commit needs a hash");
  let head: string;
  try {
    ({ stdout: head } = await run(dir, [
      "show",
      "-s",
      `--format=%H${US}%h${US}%an${US}%ae${US}%at${US}%cn${US}%ct${US}%P${US}%D${US}%B`,
      rev,
      "--",
    ]));
  } catch {
    throw fail(404, `no commit ${rev}`);
  }
  const [hash = "", short = "", author = "", email = "", at = "0", committer = "", committedAt = "0", parentList = "", refList = "", ...bodyParts] =
    head.split(US);
  const body = bodyParts.join(US).trim();
  const parents = parentList.trim() ? parentList.trim().split(/\s+/) : [];
  const range = parents[0] ? [parents[0], hash] : ["--root", hash];
  const diffArgs = ["diff-tree", "-r", "-M", "-z", "--no-commit-id", "--relative"];
  const [names, counts] = await Promise.all([
    run(dir, [...diffArgs, "--name-status", ...range]),
    run(dir, [...diffArgs, "--numstat", ...range]),
  ]);
  const stats = parseNumstat(counts.stdout);
  const files: CommitFile[] = [];
  const parts = names.stdout.split("\0");
  for (let i = 0; i < parts.length; i += 1) {
    const code = parts[i];
    if (!code) continue;
    const letter = code[0] ?? "M";
    const moved = letter === "R" || letter === "C";
    const from = moved ? parts[i + 1] : undefined;
    const path = parts[moved ? i + 2 : i + 1] ?? "";
    i += moved ? 2 : 1;
    const stat = stats.get(path);
    files.push({
      path,
      ...(from ? { from } : {}),
      status: letter,
      insertions: stat?.insertions ?? null,
      deletions: stat?.deletions ?? null,
    });
  }
  const sum = (key: "insertions" | "deletions") => files.reduce((total, file) => total + (file[key] ?? 0), 0);
  return {
    hash,
    short,
    subject: body.split("\n")[0] ?? "",
    author,
    email,
    at: Number(at) || 0,
    committer,
    committedAt: Number(committedAt) || 0,
    body,
    parents,
    refs: refList.split(",").map((ref) => ref.trim().replace(/^HEAD -> /, "")).filter(Boolean),
    filesChanged: files.length,
    insertions: sum("insertions"),
    deletions: sum("deletions"),
    files,
  };
}

/**
 * Take the last commit back, keeping everything it changed staged — VS Code's
 * "Undo Last Commit". A soft reset, so nothing on disk or in the index moves;
 * on a root commit there is no parent to reset to, so HEAD is unborn again.
 * Answers the message that was undone, so the box can hold it again.
 */
export async function undoCommit(projectId: string, repo?: string): Promise<{ output: string }> {
  const { dir } = await repoOrThrow(projectId, repo);
  const state = await status(projectId, repo);
  if (state.unborn) throw fail(409, "this repository has no commits yet");
  if (state.conflicted.length > 0) throw fail(409, "resolve the conflicts first");
  const { stdout: message } = await run(dir, ["log", "-1", "--format=%B"]);
  const hasParent = await run(dir, ["rev-parse", "--verify", "--quiet", "HEAD^"]).then(
    () => true,
    () => false,
  );
  if (hasParent) await run(dir, ["reset", "--soft", "HEAD~1"]);
  else await run(dir, ["update-ref", "-d", "HEAD"]);
  return { output: message.trim() };
}

/** Whether the worktree has anything to commit, untracked files included. */
async function isDirty(dir: string): Promise<boolean> {
  const { stdout } = await run(dir, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
  return stdout.length > 0;
}

/** Commit under the harness's own identity when the machine has none — the
    same fallback the checkpoint and rewind commits use. */
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

const HASH = /^[0-9a-f]{7,40}$/;

/**
 * The shared body of the restore below. Anything uncommitted is committed
 * first ("Checkpoint before restore"), then the index and worktree are put at
 * `tree` (`read-tree -u --reset` removes what the target does not have, which
 * `checkout <hash> -- .` would not) and the result is committed as `message`.
 * Answers whether anything was committed: a worktree already at `tree` is a
 * no-op, not a commit — but the checkpoint has already run by then, on
 * purpose, because a dirty tree that happens to match the target is still
 * the only place that work exists.
 */
async function applyTree(dir: string, tree: string, message: string): Promise<boolean> {
  if (await isDirty(dir)) await commitAll(dir, "Checkpoint before restore");
  const { stdout: headTree } = await run(dir, ["rev-parse", "HEAD^{tree}"]);
  if (headTree.trim() === tree) return false;
  await run(dir, ["read-tree", "-u", "--reset", tree]);
  await commitAll(dir, message);
  return true;
}

/** The new HEAD after one of the restores, or null when git answered before
    one was made. */
async function lastCommit(projectId: string, repo?: string): Promise<GitCommit | null> {
  const [commit = null] = await log(projectId, { limit: 1, repo });
  return commit;
}

/**
 * Make the working tree match a bare tree object — a thread rewind's file
 * half. The tree it is handed is one `git.snapshotTree` wrote at a turn's
 * start (`session_turn_changes.start_tree`): an object with no commit behind
 * it, and no ref holding it, so it is dangling and git's gc prunes it after
 * its grace period — a refusal (the same 404 an unknown commit gets) is the
 * honest answer once that has happened, not a silent no-op. There is no
 * commit to quote in the message, so the rewind names what it is instead.
 */
export async function restoreToTree(
  projectId: string,
  tree: string,
  options: { repo?: string } = {},
): Promise<{ restored: boolean; commit: GitCommit | null }> {
  const { dir } = await repoOrThrow(projectId, options.repo);
  const target = tree.trim();
  if (!HASH.test(target)) throw fail(400, "a rewind needs a tree hash");
  let full: string;
  try {
    ({ stdout: full } = await run(dir, ["rev-parse", "--verify", `${target}^{tree}`]));
  } catch {
    throw fail(404, `no such tree: ${target}`);
  }
  const applied = await applyTree(dir, full.trim(), "Rewind: restore files to an earlier turn");
  if (!applied) return { restored: false, commit: null };
  return { restored: true, commit: await lastCommit(projectId, options.repo) };
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
  comparison: Comparison | { rev: string },
): Promise<{ content: string; missing: boolean }> {
  if (comparison === "worktree") return { content: "", missing: true };
  /* A commit's side — the history's diff. A hash and nothing else, so the
     value can never be read as a ref expression or a flag. */
  if (typeof comparison === "object" && !HASH.test(comparison.rev)) throw fail(400, "a revision must be a commit hash");
  const root = await projectRoot(projectId);
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
  const ref =
    typeof comparison === "object"
      ? `${comparison.rev}:./${name}`
      : comparison === "staged"
        ? `:./${name}`
        : `HEAD:./${name}`;
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
  /* `resolve`, not `join`: in a linked worktree git prints the index's
     absolute path (`<main>/.git/worktrees/<id>/index`), and joining that onto
     `dir` names a file that does not exist — every snapshot then re-hashed the
     whole tree from an empty index. */
  const realIndex = resolve(dir, stdout.trim());
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

/**
 * One file as a tree holds it — a turn's before or after side, read whole for
 * the IDE's diff editor. `path` is relative to `dir` (the same `--relative`
 * cut `diffTrees` makes), so it is prefixed back to the repository root that
 * `<tree>:<path>` addresses. A path the tree does not have is `missing`, not
 * an error: an added file has no before, a deleted one no after.
 */
export async function blobAt(
  dir: string,
  tree: string,
  path: string,
): Promise<{ content: string; missing: boolean }> {
  const prefix = (await run(dir, ["rev-parse", "--show-prefix"])).stdout.trim();
  try {
    const { stdout } = await run(dir, ["show", `${tree}:${prefix}${path}`]);
    return { content: stdout, missing: false };
  } catch {
    return { content: "", missing: true };
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
/**
 * What a commit-message draft is written from: the staged diff when anything is
 * staged, the working tree otherwise, plus the file list.
 *
 * Composed **server-side** rather than sent up by the client. The diff is the
 * whole input to the prompt and it is routinely hundreds of kilobytes, the git
 * routes already know how to read it, and a client that had to ship it would be
 * re-implementing `git diff` to ask a question about git's own output.
 *
 * Capped: a rewrite is one short answer, and a 500 KB prompt is slow, expensive
 * and no more accurate than the first slice of it. The cap is applied to the
 * patch, never to the file list, so a huge diff still says *what* changed.
 */
const COMMIT_PROMPT_DIFF_MAX = 60_000;

export async function commitMessagePrompt(
  projectId: string,
  repo?: string,
  /* A branch name is the same question asked of the same diff — what is this
     work — so it is the same gathering, and only the headline (and the system
     prompt in `enhance.ts`) differ. A second copy of the untracked-file
     handling below is how the two would drift. */
  kind: "commit" | "branch" = "commit",
  /* What the author has already typed into the commit box, when they asked for
     it to be *sharpened* rather than written. The diff is gathered either way —
     a message is only worth rewriting against the work it describes — so this
     is one more section of the same prompt and not a second question. */
  draft?: string,
): Promise<{ prompt: string; files: string[]; staged: boolean }> {
  const { dir } = await repoOrThrow(projectId, repo);
  const state = await status(projectId, repo);

  /* Staged work is what a commit would actually contain, so it wins; a tree
     with nothing staged is the "stage everything first" flow, and its draft is
     about the working tree. */
  const staged = state.staged.length > 0;
  const listed = staged ? state.staged : [...state.unstaged, ...state.untracked];
  const files = listed.map(
    (file) => `${staged ? file.index : file.worktree} ${file.path}`,
  );

  /* A staged diff is `--cached`; the unstaged one is HEAD against the worktree,
     which is the same two sides the panel's own rows compare. An unborn HEAD
     has nothing to diff against, so the index is the empty tree. */
  const { stdout } = await run(dir, [
    "diff",
    "--relative",
    "-M",
    "--no-color",
    "--no-ext-diff",
    ...(staged ? ["--cached"] : []),
    ...(state.unborn && !staged ? ["--cached"] : []),
  ]);

  /* Untracked files are in no diff at all — `git diff` only knows about what
     git knows about — and they are routinely most of what a commit is. Without
     this the draft describes a change whose files it never saw, which is
     exactly the "invent work that is not there" failure the system prompt
     warns against. Read their contents in as added files. */
  if (!staged && state.untracked.length > 0) {
    const added: string[] = [];
    for (const file of state.untracked) {
      /* `--no-index` against `/dev/null` is what renders a file git does not
         track as a normal "new file" hunk. It exits 1 whenever there IS a
         difference — which is every time here — so 1 is an answer, not a
         failure. */
      try {
        const { stdout: one } = await run(
          dir,
          ["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-prefix", "/dev/null", file.path],
          undefined,
          [1],
        );
        if (one.trim()) added.push(one);
      } catch {
        /* A binary or unreadable untracked file contributes its name only. */
      }
      if (added.join("").length > COMMIT_PROMPT_DIFF_MAX) break;
    }
    if (added.length > 0) {
      return {
        prompt: buildPrompt(kind, staged, files, `${stdout}${added.join("")}`, draft),
        files,
        staged,
      };
    }
  }

  return { prompt: buildPrompt(kind, staged, files, stdout, draft), files, staged };
}

/** The prompt's own shape, in one place so both exits above agree. */
function buildPrompt(
  kind: "commit" | "branch",
  staged: boolean,
  files: string[],
  diff: string,
  draft?: string,
): string {
  const patch = diff.slice(0, COMMIT_PROMPT_DIFF_MAX);
  const scope = staged ? "staged" : "working-tree";
  /* Only the commit half can be sharpened: a branch name is a single token the
     author does not half-write, and a "draft" of one is a name, not a sketch. */
  const started = kind === "commit" ? (draft ?? "").trim() : "";

  return [
    kind === "branch"
      ? `Name a git branch for these ${scope} changes.`
      : started
        ? `Rewrite the author's commit message for these ${scope} changes.`
        : `Write a commit message for these ${scope} changes.`,
    ...(started
      ? [
          "",
          /* Last, after the diff, would bury it: the instruction that changes
             the job is the one the model should read first. */
          "The author has already written this. Keep what they meant and say it",
          "in the house style — sharpen it against the diff, do not replace their",
          "intent with your own reading of the change:",
          "```",
          started,
          "```",
        ]
      : []),
    "",
    "Files:",
    files.length > 0 ? files.join("\n") : "(none)",
    "",
    "Diff:",
    "```diff",
    patch.trim() || "(empty)",
    "```",
  ].join("\n");
}

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

/** NUL-separated `--name-only` output as a list. */
const names = (stdout: string): string[] => stdout.split("\0").filter(Boolean);

/**
 * Where "this branch" forked from — the merge-base of HEAD with the
 * repository's default branch: `origin/HEAD` when the remote says, else a
 * local `main` or `master`, whichever exists. Null (with the sentence the
 * panel shows) when there is no such branch, or HEAD *is* it.
 */
export async function branchBase(dir: string): Promise<{ base: string } | { unavailable: string }> {
  const verify = async (ref: string) => {
    try {
      return (await run(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).stdout.trim() || null;
    } catch {
      return null;
    }
  };
  const head = await verify("HEAD");
  if (!head) return { unavailable: "This repository has no commits yet, so there is no branch to compare." };
  let ref: string | null = null;
  try {
    ref = (await run(dir, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])).stdout.trim() || null;
  } catch {
    /* no remote default — fall through to the local names */
  }
  for (const candidate of [ref, "refs/heads/main", "refs/heads/master"]) {
    if (!candidate) continue;
    const tip = await verify(candidate);
    if (!tip) continue;
    if (tip === head) return { unavailable: "HEAD is the base branch — there is no branch of its own to compare." };
    const { stdout } = await run(dir, ["merge-base", "HEAD", tip], undefined, [1]);
    const base = stdout.trim();
    if (!base) return { unavailable: "This branch shares no history with the base branch." };
    return { base };
  }
  return { unavailable: "No base branch found (no origin/HEAD, main or master)." };
}

/**
 * Undo one turn in the working tree: every path that differs between `start`
 * and `end` is put back as `start` had it — rewritten, recreated, or deleted
 * when the turn created it. Nothing else is touched, and **never the real
 * index**: the files are written out of a scratch index holding `start`
 * (`checkout-index`), the same trick `snapshotTree` uses for reading.
 *
 * Refused — answered with the paths, nothing written — when any of those
 * paths has changed since `end` (a later turn, the user, an editor), unless
 * `force`, because reverting over that would silently take their work too.
 */
export async function revertTurn(
  dir: string,
  start: string,
  end: string,
  force: boolean,
): Promise<{ reverted: string[]; conflicts: string[] }> {
  /* Renames as their two halves: the new name goes, the old one comes back. */
  const paths = names((await run(dir, ["diff", "--relative", "--name-only", "--no-renames", "-z", start, end])).stdout);
  if (paths.length === 0) return { reverted: [], conflicts: [] };
  const now = await snapshotTree(dir);
  const conflicts = names(
    (await run(dir, ["diff", "--relative", "--name-only", "--no-renames", "-z", end, now, "--", ...paths.map(literal)])).stdout,
  );
  if (conflicts.length > 0 && !force) return { reverted: [], conflicts };

  const present = new Set(
    names((await run(dir, ["ls-tree", "-r", "--name-only", "-z", start, "--", ...paths.map(literal)])).stdout),
  );
  const restore = paths.filter((path) => present.has(path));
  for (const path of paths) if (!present.has(path)) await rm(join(dir, path), { force: true });
  if (restore.length > 0) {
    const scratch = join(tmpdir(), `daedalus-index-${randomBytes(6).toString("hex")}`);
    try {
      const env = { GIT_INDEX_FILE: scratch };
      await run(dir, ["read-tree", start], env);
      await run(dir, ["checkout-index", "-f", "--", ...restore], env);
    } finally {
      await unlink(scratch).catch(() => {});
    }
  }
  return { reverted: paths, conflicts };
}

/** A path as a pathspec that means exactly itself — no globbing. */
const literal = (path: string) => `:(literal)${path}`;

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

/* ── A thread's own worktree ──
   An isolated thread runs in `git worktree add <project>/.daedalus/worktrees/
   <id> -b daedalus/<id>` (the whole id, dashes dropped — a short prefix
   collides, and a branch outlives its worktree): a second checkout of the project's
   repository on a branch of its own, so two agents (or an agent and a person)
   never write the same files. Inside the project on purpose — every file and
   git route already addresses it as a project-relative path, and source control
   reaches it as a `repo` — and ignored through `.git/info/exclude`, never the
   user's `.gitignore`, so the project's own status and a turn's snapshot never
   see it. Only a project whose directory IS the repository root may isolate: a
   project nested in a larger checkout would have its thread's paths measured
   from two different roots. */

export const WORKTREES_DIR = ".daedalus/worktrees";

/** The branch a worktree was made on — its directory's own name. */
export const worktreeBranch = (rel: string): string => `daedalus/${rel.split("/").pop() ?? rel}`;

/** Make the worktree for a thread and answer its project-relative path. */
export async function createWorktree(cwd: string, sessionId: string): Promise<string> {
  const top = await toplevelOf(cwd);
  if (!top) throw fail(400, "this project is not a git repository, so it has no worktree to isolate in");
  if (realpathSync(top) !== realpathSync(cwd))
    throw fail(400, "isolating needs the project directory to be the repository's root");
  const rel = `${WORKTREES_DIR}/${sessionId.replace(/-/g, "")}`;
  const { stdout } = await run(cwd, ["rev-parse", "--git-common-dir"]);
  const exclude = join(resolve(cwd, stdout.trim()), "info", "exclude");
  const held = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!held.split(/\r?\n/).includes(".daedalus/")) {
    mkdirSync(dirname(exclude), { recursive: true });
    appendFileSync(exclude, `${held && !held.endsWith("\n") ? "\n" : ""}.daedalus/\n`);
  }
  await run(cwd, ["worktree", "add", rel, "-b", worktreeBranch(rel)]);
  return rel;
}

/**
 * Remove a thread's worktree. The branch is kept — its commits are the work —
 * so what removing can lose is only what is not committed, and that is refused
 * unless `force`, with the paths that would go named in the refusal.
 */
export async function removeWorktree(cwd: string, rel: string, force: boolean): Promise<void> {
  const dir = join(cwd, rel);
  if (!existsSync(dir)) {
    await run(cwd, ["worktree", "prune"]);
    return;
  }
  if (!force) {
    const { stdout } = await run(dir, ["status", "--porcelain", "--untracked-files=all"]);
    const dirty = stdout.split("\n").filter(Boolean);
    if (dirty.length > 0) {
      const shown = dirty.slice(0, 20).map((line) => line.slice(3));
      throw fail(
        409,
        `The worktree has ${dirty.length} uncommitted ${dirty.length === 1 ? "change" : "changes"} that removing it would lose: ${shown.join(", ")}${dirty.length > shown.length ? ", …" : ""}. Commit them to ${worktreeBranch(rel)}, or remove anyway.`,
      );
    }
  }
  await run(cwd, ["worktree", "remove", ...(force ? ["--force"] : []), rel]);
}
