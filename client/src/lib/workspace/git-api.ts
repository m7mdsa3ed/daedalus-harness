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
  comparison: Comparison
): Promise<{ content: string; missing: boolean }> {
  const search = new URLSearchParams({ path, comparison })
  return api<{ content: string; missing: boolean }>(
    server(),
    `${base(projectId)}/file?${search.toString()}`
  )
}

/* ── What a turn did ──
   The per-turn summary the transcript's chips draw, and the one thing the
   client reads from the session's own changes routes. The scope's *files*,
   *patch* and per-file *sides* are still served (`/changes/files|patch|file`)
   and nothing here calls them any more: reviewing a turn is source control
   narrowed to its paths (`lib/ide/scm-filter.ts`), which reads `git status`
   through the project's git routes below and can act on what it shows. */

export type { ChangedFile, TurnChanges } from "@daedalus/protocol"
import type { TurnChanges } from "@daedalus/protocol"

const session = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/changes`

export function sessionChanges(settings: ServerSettings, sessionId: string, signal?: AbortSignal) {
  return api<{ turns: TurnChanges[] }>(settings, session(sessionId), { signal })
}

export interface GitFileState {
  path: string
  from?: string
  index: string
  worktree: string
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
}

export function gitLog(
  settings: ServerSettings,
  projectId: string,
  options: { limit?: number; repo?: string } = {},
  signal?: AbortSignal
) {
  const search = new URLSearchParams()
  if (options.limit) search.set("limit", String(options.limit))
  if (options.repo) search.set("repo", options.repo)
  return api<GitCommit[]>(settings, `${base(projectId)}/log?${search.toString()}`, { signal })
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
  /** Switch branches; `create` makes it a `-b`. */
  | { action: "checkout"; branch: string; create?: boolean }

/** Paths are relative to `repo`, the same way the status that listed them was. */
export type GitWrite = GitAction & { repo?: string }

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
