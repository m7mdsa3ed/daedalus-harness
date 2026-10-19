/* The git client. `gitFileAt` feeds the IDE's diff tab and takes no `repo`: it
   is about one file, and a file names its repository by where it is — the
   server derives the owning worktree. Everything below it is the source-control
   view's surface and the turn-changes tab's: the per-turn reads, the
   working-tree status, the stash, the log and the branches. */
import { api, loadSettings, ApiError, type ServerSettings } from "@/lib/settings"

export type Comparison = "worktree" | "staged" | "head"

function server(): ServerSettings {
  const settings = loadSettings()
  if (!settings) throw new ApiError({ status: 0, path: "/api", serverMessage: "not connected" })
  return settings
}

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/git`

/** `path` is project-relative — the server derives which repository owns it,
    because a file belongs to exactly one. */
export function gitFileAt(
  projectId: string,
  path: string,
  comparison: Comparison | { rev: string }
): Promise<{ content: string; missing: boolean }> {
  const search = new URLSearchParams(
    typeof comparison === "string" ? { path, comparison } : { path, rev: comparison.rev }
  )
  return api<{ content: string; missing: boolean }>(
    server(),
    `${base(projectId)}/file?${search.toString()}`
  )
}

/* ── What a turn did ──
   The per-turn summary the footer chip draws, and the inspector's Changes
   tab's reads: a scope's files and each file's two sides, read by git on the
   server (`turn-changes.ts`). A scope is `turn:<id>`, `thread`, `uncommitted`
   or `branch`; its paths are relative to the thread's own cwd. */

export type { ChangedFile, TurnChanges } from "@daedalus/protocol"
import type { ChangedFile, TurnChanges } from "@daedalus/protocol"

const session = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/changes`

export function sessionChanges(settings: ServerSettings, sessionId: string, signal?: AbortSignal) {
  return api<{ turns: TurnChanges[] }>(settings, session(sessionId), { signal })
}

export interface GitFileState {
  path: string
  from?: string
  index: string
  worktree: string
  /** Lines on this side of the change; absent for untracked and binary files. */
  insertions?: number
  deletions?: number
}
export interface GitStatus {
  repository: boolean
  /** Project-relative position of the repository; `""` is the project itself. */
  repo: string
  branch: string | null
  /** Upstream the branch tracks, or null on a detached HEAD / no upstream. */
  upstream: string | null
  ahead: number
  behind: number
  /** True before the first commit — `HEAD` does not resolve yet. */
  unborn: boolean
  staged: GitFileState[]
  unstaged: GitFileState[]
  untracked: GitFileState[]
  conflicted: GitFileState[]
}

/* ── Which repository ──
   A project directory is not one git repository. It may hold several (a
   monorepo of checkouts, a `packages/` of them) or sit *inside* a larger one,
   so every read and every write names the repository it is about: `repo` is a
   **project-relative directory**, and `""` is the project's own — which is what
   every call that omits it means.

   The paths inside a `GitStatus` are relative to **that repository's
   directory**, not to the project. Prefixing them back with `repo` is what
   turns one into a path the file routes take, which is what `projectPath` below
   is for — so no caller writes that join by hand and gets it backwards. */

export interface GitRepo {
  /** Project-relative; `""` is the project directory itself. */
  path: string
  /** What to call it — the directory's own name, or "Project" at the root. */
  name: string
  branch: string | null
  /** A linked worktree (`git worktree add`), not a main checkout. */
  worktree: boolean
}

/** Every repository this project can see, the project's own first. */
export function gitRepos(settings: ServerSettings, projectId: string, signal?: AbortSignal) {
  return api<GitRepo[]>(settings, `${base(projectId)}/repos`, { signal })
}

/** A status path (repository-relative) as the file routes want it. */
export const projectPath = (repo: string, path: string): string =>
  repo ? `${repo}/${path}` : path

export function gitStatus(
  settings: ServerSettings,
  projectId: string,
  options: { repo?: string; signal?: AbortSignal } = {}
) {
  const search = new URLSearchParams()
  if (options.repo) search.set("repo", options.repo)
  const query = search.toString()
  return api<GitStatus>(settings, `${base(projectId)}/status${query ? `?${query}` : ""}`, {
    signal: options.signal,
  })
}

export interface BranchList {
  current: string | null
  branches: string[]
  /** Remote-tracking refs, `origin/main` shaped (`origin/HEAD` excluded).
      Checking one out is a create-with-tracking — see `track` below. */
  remotes: string[]
  tags: string[]
}

export function gitBranches(
  settings: ServerSettings,
  projectId: string,
  repo?: string,
  signal?: AbortSignal
) {
  const search = new URLSearchParams()
  if (repo) search.set("repo", repo)
  return api<BranchList>(settings, `${base(projectId)}/branches?${search.toString()}`, { signal })
}

export type RefKind = "local" | "remote" | "tag"

/** One page of branches or tags, newest first, for a list that loads as it
    scrolls. `total` counts what matches `q`, not what was returned. */
export function gitRefs(
  settings: ServerSettings,
  projectId: string,
  options: { kind: RefKind; offset: number; limit: number; q?: string; repo?: string },
  signal?: AbortSignal
) {
  const search = new URLSearchParams({ kind: options.kind, offset: String(options.offset), limit: String(options.limit) })
  if (options.q) search.set("q", options.q)
  if (options.repo) search.set("repo", options.repo)
  return api<{ items: string[]; total: number }>(settings, `${base(projectId)}/refs?${search.toString()}`, { signal })
}

export interface GitCommit {
  hash: string
  short: string
  subject: string
  author: string
  /** Unix seconds. */
  at: number
  filesChanged: number
  insertions: number
  deletions: number
  /** Parent hashes. Two or more means a merge; empty on a root commit. */
  parents: string[]
  /** Branch and tag names pointing here. */
  refs: string[]
}

export function gitLog(
  settings: ServerSettings,
  projectId: string,
  options: { limit?: number; repo?: string; all?: boolean; skip?: number } = {},
  signal?: AbortSignal
) {
  const search = new URLSearchParams()
  if (options.limit) search.set("limit", String(options.limit))
  if (options.all) search.set("all", "1")
  if (options.skip) search.set("skip", String(options.skip))
  if (options.repo) search.set("repo", options.repo)
  return api<GitCommit[]>(settings, `${base(projectId)}/log?${search.toString()}`, { signal })
}

/** One file's unified diff - the worktree against the index, the index against
    HEAD, or a commit against its first parent. Paths are repository-relative. */
export function gitDiff(
  settings: ServerSettings,
  projectId: string,
  options: {
    path: string
    from?: string
    comparison: "worktree" | "staged" | { rev: string }
    untracked?: boolean
    repo?: string
  },
  signal?: AbortSignal
) {
  const search = new URLSearchParams({ path: options.path })
  if (typeof options.comparison === "string") search.set("comparison", options.comparison)
  else search.set("rev", options.comparison.rev)
  if (options.from) search.set("from", options.from)
  if (options.untracked) search.set("untracked", "1")
  if (options.repo) search.set("repo", options.repo)
  return api<{ patch: string }>(settings, `${base(projectId)}/diff?${search.toString()}`, { signal })
}

export interface CommitFile {
  path: string
  from?: string
  /** A M D R C T, as `--name-status` spells it. */
  status: string
  /** Null for a binary file. */
  insertions: number | null
  deletions: number | null
}

export interface CommitDetail extends GitCommit {
  email: string
  body: string
  committer: string
  committedAt: number
  files: CommitFile[]
}

/** One commit opened — `hash` may be `"HEAD"`. Paths are repository-relative. */
export function gitCommit(
  settings: ServerSettings,
  projectId: string,
  hash: string,
  repo?: string,
  signal?: AbortSignal
) {
  const search = new URLSearchParams({ hash })
  if (repo) search.set("repo", repo)
  return api<CommitDetail>(settings, `${base(projectId)}/commit?${search.toString()}`, { signal })
}

export interface StashEntry {
  index: number
  ref: string
  message: string
  /** Unix seconds, or null when git omits the date. */
  at: number | null
}

export function stashList(settings: ServerSettings, projectId: string, repo?: string, signal?: AbortSignal) {
  const search = new URLSearchParams()
  if (repo) search.set("repo", repo)
  return api<StashEntry[]>(settings, `${base(projectId)}/stashes?${search.toString()}`, { signal })
}

/** Create a stash. Answers whether anything was stashed — a clean tree is not
    an error, it is "already stashed nothing". */
export function stashPush(
  settings: ServerSettings,
  projectId: string,
  options: { message?: string; repo?: string } = {}
): Promise<GitStatus & { created: boolean }> {
  return writeStatus(settings, projectId, "stash", {
    message: options.message ?? "",
    repo: options.repo,
  }).then((result) => ({ ...result, created: result.created ?? false }))
}

/** A stash belongs to one repository, the same way a status does — so every
    verb names it, and omitting it means the project's own. */
export type StashVerb = "apply" | "pop" | "drop"

export function stashAct(
  settings: ServerSettings,
  projectId: string,
  verb: StashVerb,
  index: number,
  repo?: string
) {
  return writeStatus(settings, projectId, `stash/${verb}`, { index, repo })
}

type WriteResult = (GitStatus & { output?: string }) & { created?: boolean }

function writeStatus(
  settings: ServerSettings,
  projectId: string,
  action: string,
  body: Record<string, unknown>
): Promise<WriteResult> {
  return api<GitStatus | { status: GitStatus; output?: string; created?: boolean }>(
    settings,
    `${base(projectId)}/${action}`,
    { method: "POST", body: JSON.stringify(body) },
  ).then((result) =>
    "status" in (result as object)
      ? { ...(result as { status: GitStatus }).status, output: (result as { output?: string }).output, created: (result as { created?: boolean }).created }
      : (result as GitStatus)
  )
}

export type GitAction =
  | { action: "stage" | "unstage" | "discard"; paths: string[] }
  | { action: "commit"; message: string; amend?: boolean }
  /** One hunk: `cached` stages it, `reverse` alone discards it. */
  | { action: "apply"; patch: string; cached?: boolean; reverse?: boolean }
  /** Switch branches; `create` makes it a `-b`, and `track` means `branch`
      names a remote ref (`origin/x`) to be checked out as a local branch of the
      same name tracking it. */
  | { action: "checkout"; branch: string; create?: boolean; track?: boolean }
  /** The remote. A pull is `--ff-only` and a push publishes an unpublished
      branch to `origin`; both answer what the remote said in `output`. */
  | { action: "pull" | "push" | "fetch" }
  /** The branch menu: `branch` names the ref acted on (a branch, a remote ref
      or a tag). Merge it into HEAD, rebase HEAD onto it (aborted if it
      conflicts), rename a local branch to `to`, or delete a branch or tag. */
  | { action: "merge" | "rebase" | "delete-branch" | "delete-tag"; branch: string }
  | { action: "rename-branch"; branch: string; to: string }
  /** Soft-reset the last commit; `output` is the message it had. */
  | { action: "undo" }

/** Paths are relative to `repo`, the same way the status that listed them was. */
export type GitWrite = GitAction & { repo?: string }

/** Draft a commit message — or, with `kind: "branch"`, a branch name — from the
    repository's own diff, through the picked profile's endpoint. The diff is
    read server-side: this sends a profile, not a patch. Both are the same
    question asked of the same diff, which is why they are one call. */
export function draftCommitMessage(
  settings: ServerSettings,
  projectId: string,
  input: {
    profileId: string
    agentId?: string
    model?: string
    repo?: string
    kind?: "commit" | "branch"
    /** What is already typed. Present asks for it to be sharpened against the
        diff rather than replaced; absent asks for one to be written. */
    draft?: string
  },
  signal?: AbortSignal
): Promise<{ message: string; files: number; staged: boolean }> {
  return api(settings, `${base(projectId)}/draft-message`, {
    method: "POST",
    body: JSON.stringify(input),
    signal,
  })
}

export function gitWrite(
  settings: ServerSettings,
  projectId: string,
  write: GitWrite
): Promise<GitStatus & { output?: string }> {
  const { action, ...body } = write
  return api(settings, `${base(projectId)}/${action}`, {
    method: "POST",
    body: JSON.stringify(body),
  }).then((result) =>
    /* `commit` answers `{output, status}`; the rest answer the status itself. */
    "status" in (result as object)
      ? { ...(result as { status: GitStatus }).status, output: (result as { output?: string }).output }
      : (result as GitStatus)
  )
}
