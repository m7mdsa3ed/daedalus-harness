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
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import {
  DEFAULT_IGNORES,
  WorkspaceError,
  projectRoot,
  relativePath,
  resolveInProject,
} from "./workspace-fs.js";

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
function run(cwd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["--no-optional-locks", "-c", "core.quotepath=false", ...args],
      { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
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
