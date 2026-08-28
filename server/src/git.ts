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
 */
import { execFile } from "node:child_process";

import { WorkspaceError, projectRoot } from "./workspace-fs.js";

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

/** The project's git root, or null when it is not a repository. */
export async function repositoryRoot(projectId: string): Promise<string | null> {
  const cwd = projectRoot(projectId);
  try {
    const { stdout } = await run(cwd, ["rev-parse", "--show-toplevel"]);
    return stdout.trim() || null;
  } catch (err) {
    /* "not a git repository" is a normal answer here, not a failure — the panel
       renders an initialize state for it. A missing binary still throws. */
    if (err instanceof WorkspaceError && err.status === 404) throw err;
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
 */
function parseStatus(stdout: string): Omit<GitStatus, "repository"> {
  const parts = stdout.split("\0");
  const status: Omit<GitStatus, "repository"> = {
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
      status.untracked.push({ path, index: "untracked", worktree: "untracked" });
      continue;
    }

    if (line.startsWith("! ")) continue; // ignored; only present if asked for

    if (line.startsWith("u ")) {
      // Unmerged: `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
      const fields = line.split(" ");
      const path = fields.slice(10).join(" ");
      status.conflicted.push({ path, index: "conflicted", worktree: "conflicted" });
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
      const index = stateOf(xy[0] ?? ".");
      const worktree = stateOf(xy[1] ?? ".");
      const file: GitFile = { path, ...(from ? { from } : {}), index, worktree };
      if (index !== "unmodified") status.staged.push(file);
      if (worktree !== "unmodified") status.unstaged.push(file);
      continue;
    }
  }

  return status;
}

export async function status(projectId: string): Promise<GitStatus> {
  const root = await repositoryRoot(projectId);
  if (!root)
    return {
      repository: false,
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

  const { stdout } = await run(root, [
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--untracked-files=all",
  ]);
  return { repository: true, ...parseStatus(stdout) };
}

async function repoOrThrow(projectId: string): Promise<string> {
  const root = await repositoryRoot(projectId);
  if (!root) throw fail(400, "this project is not a git repository");
  return root;
}

/** `--` before paths, always: a file called `-f` or `--cached` is a valid file
    and must not be read as a flag. */
const pathspec = (paths: string[]): string[] => ["--", ...paths];

export async function stage(projectId: string, paths: string[]): Promise<void> {
  const root = await repoOrThrow(projectId);
  if (paths.length === 0) await run(root, ["add", "--all"]);
  else await run(root, ["add", "--", ...paths]);
}

export async function unstage(projectId: string, paths: string[]): Promise<void> {
  const root = await repoOrThrow(projectId);
  /* `reset` and not `restore --staged`: before the first commit there is no
     HEAD to restore from, and `reset` handles the unborn branch. */
  await run(root, paths.length === 0 ? ["reset", "--quiet"] : ["reset", "--quiet", ...pathspec(paths)]);
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
export async function discard(projectId: string, paths: string[]): Promise<void> {
  const root = await repoOrThrow(projectId);
  if (paths.length === 0) throw fail(400, "discard needs an explicit list of paths");
  await run(root, ["restore", "--worktree", ...pathspec(paths)]);
}

export interface CommitResult {
  output: string;
}

export async function commit(
  projectId: string,
  message: string,
  options: { amend?: boolean } = {},
): Promise<CommitResult> {
  const root = await repoOrThrow(projectId);
  if (!message.trim() && !options.amend) throw fail(400, "a commit needs a message");
  const args = ["commit", "--message", message];
  if (options.amend) args.push("--amend");
  const { stdout, stderr } = await run(root, args);
  // Hooks write to both, and their output is the interesting part of a commit
  // that did something surprising.
  return { output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") };
}

export interface BranchList {
  current: string | null;
  branches: string[];
}

export async function branches(projectId: string): Promise<BranchList> {
  const root = await repoOrThrow(projectId);
  const { stdout } = await run(root, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  const { branch } = await status(projectId);
  return { current: branch, branches: stdout.split("\n").map((l) => l.trim()).filter(Boolean) };
}

export async function checkout(
  projectId: string,
  branch: string,
  options: { create?: boolean } = {},
): Promise<void> {
  const root = await repoOrThrow(projectId);
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
  await run(root, options.create ? ["checkout", "-b", branch, "--"] : ["checkout", branch, "--"]);
}

export type Comparison = "worktree" | "staged" | "head";

/**
 * The other side of a comparison — what the editor's diff mode puts on the
 * left. The right side is the working file, which the client already has.
 *
 * An empty string is a real answer (the file is new, or was deleted), so
 * "missing on that side" is not an error.
 */
export async function fileAt(
  projectId: string,
  path: string,
  comparison: Comparison,
): Promise<{ content: string; missing: boolean }> {
  const root = await repoOrThrow(projectId);
  const ref = comparison === "staged" ? `:${path}` : `HEAD:${path}`;
  if (comparison === "worktree") return { content: "", missing: true };
  try {
    const { stdout } = await run(root, ["show", ref]);
    return { content: stdout, missing: false };
  } catch {
    return { content: "", missing: true };
  }
}
