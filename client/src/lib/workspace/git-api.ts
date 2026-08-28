/* The source-control client. Mirrors `server/src/git.ts` one call per route.

   Every mutating call answers with the *new status*, so the panel never has to
   fire a second request to find out what it just did — and cannot render a
   state that disagrees with the repository because the follow-up raced a file
   watcher. */
import { api, loadSettings, ApiError, type ServerSettings } from "@/lib/settings"

export type GitState =
  | "unmodified"
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "ignored"
  | "conflicted"

export interface GitFile {
  path: string
  /** Where it moved from, for a rename. */
  from?: string
  index: GitState
  worktree: GitState
}

export interface GitStatus {
  repository: boolean
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  unborn: boolean
  staged: GitFile[]
  unstaged: GitFile[]
  untracked: GitFile[]
  conflicted: GitFile[]
}

export interface BranchList {
  current: string | null
  branches: string[]
}

export type Comparison = "worktree" | "staged" | "head"

function server(): ServerSettings {
  const settings = loadSettings()
  if (!settings) throw new ApiError({ status: 0, path: "/api", serverMessage: "not connected" })
  return settings
}

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/git`

export function gitStatus(projectId: string, signal?: AbortSignal): Promise<GitStatus> {
  return api<GitStatus>(server(), `${base(projectId)}/status`, { signal })
}

export function gitBranches(projectId: string): Promise<BranchList> {
  return api<BranchList>(server(), `${base(projectId)}/branches`)
}

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

const action = <T>(projectId: string, name: string, body: object): Promise<T> =>
  api<T>(server(), `${base(projectId)}/${name}`, { method: "POST", body: JSON.stringify(body) })

/** An empty `paths` stages everything; that is `git add --all`. */
export const gitStage = (projectId: string, paths: string[] = []) =>
  action<GitStatus>(projectId, "stage", { paths })

export const gitUnstage = (projectId: string, paths: string[] = []) =>
  action<GitStatus>(projectId, "unstage", { paths })

/** Never empty — the server refuses a discard with no paths, because the one
    destructive operation here should not have a form where "nothing" means
    "everything". */
export const gitDiscard = (projectId: string, paths: string[]) =>
  action<GitStatus>(projectId, "discard", { paths })

export const gitCommit = (projectId: string, message: string, options: { amend?: boolean } = {}) =>
  action<{ output: string; status: GitStatus }>(projectId, "commit", { message, ...options })

export const gitCheckout = (projectId: string, branch: string, options: { create?: boolean } = {}) =>
  action<GitStatus>(projectId, "checkout", { branch, ...options })
