/* The git client. `gitFileAt` feeds the editor panel's diff mode and takes no
   `repo`: it is about one file, and a file names its repository by where it is
   — the server derives the owning worktree. Everything below it is the
   source-control panel's surface: the per-turn reads, the working-tree status,
   the stash, the log and the branches. */
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

/* ── The review panel's reads and writes ──
   What a turn did is the *session's* question (the trees are recorded per
   turn, server turn-changes.ts); staging and committing are the *project's*
   (the existing git routes). The panel talks to both through here. */

export type { ChangedFile, TurnChanges } from "@daedalus/protocol"
import type { ChangedFile, TurnChanges } from "@daedalus/protocol"

/** `uncommitted` (HEAD → worktree, untracked files included) or `turn:<id>`. */
export type ReviewScope = string

const session = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/changes`

export function sessionChanges(settings: ServerSettings, sessionId: string, signal?: AbortSignal) {
  return api<{ turns: TurnChanges[] }>(settings, session(sessionId), { signal })
}

export function changedFiles(
  settings: ServerSettings,
  sessionId: string,
  scope: ReviewScope,
  signal?: AbortSignal
): Promise<{ files: ChangedFile[]; unavailable?: string }> {
  const search = new URLSearchParams({ scope })
  return api(settings, `${session(sessionId)}/files?${search}`, { signal })
}

export function changePatch(
  settings: ServerSettings,
  sessionId: string,
  scope: ReviewScope,
  path: string,
  signal?: AbortSignal
): Promise<{ patch: string; unavailable?: string }> {
  const search = new URLSearchParams({ scope, path })
  return api(settings, `${session(sessionId)}/patch?${search}`, { signal })
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

export function gitStatus(settings: ServerSettings, projectId: string, signal?: AbortSignal) {
  return api<GitStatus>(settings, `${base(projectId)}/status`, { signal })
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
  message?: string
): Promise<GitStatus & { created: boolean }> {
  return writeStatus(settings, projectId, "stash", { message: message ?? "" }).then((result) => ({
    ...result,
    created: result.created ?? false,
  }))
}

export function stashApply(settings: ServerSettings, projectId: string, index: number) {
  return writeStatus(settings, projectId, "stash/apply", { index })
}

export function stashPop(settings: ServerSettings, projectId: string, index: number) {
  return writeStatus(settings, projectId, "stash/pop", { index })
}

export function stashDrop(settings: ServerSettings, projectId: string, index: number) {
  return writeStatus(settings, projectId, "stash/drop", { index })
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

export type GitWrite =
  | { action: "stage" | "unstage" | "discard"; paths: string[] }
  | { action: "commit"; message: string; amend?: boolean }
  /** One hunk: `cached` stages it, `reverse` alone discards it. */
  | { action: "apply"; patch: string; cached?: boolean; reverse?: boolean }
  /** Switch branches; `create` makes it a `-b`. */
  | { action: "checkout"; branch: string; create?: boolean }

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
