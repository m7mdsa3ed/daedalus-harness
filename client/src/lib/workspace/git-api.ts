/* The source-control client. Mirrors `server/src/git.ts` one call per route.

   Every mutating call answers with the *new status*, so the panel never has to
   fire a second request to find out what it just did — and cannot render a
   state that disagrees with the repository because the follow-up raced a file
   watcher.

   Every call about a *working set* also carries a `repo`: a project holds zero,
   one or many repositories (`gitRepos`), and which one a request is about is
   never implied by the project. `""` is the project directory itself, and a
   file's path is relative to its repo — `repoPath` is the join that makes it
   project-relative again, which is the form every other workspace route speaks.
   `gitFileAt` is the exception and takes no `repo`: it is about one file, and a
   file names its repository by where it is. */
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
  /** Project-relative position of this repository; `""` is the project itself. */
  repo: string
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

export interface GitRepo {
  /** Project-relative; `""` is the project directory itself. */
  path: string
  name: string
  branch: string | null
}

export type Comparison = "worktree" | "staged" | "head"

/** A repo-relative file path, back in the project's terms. */
export const repoPath = (repo: string, path: string): string =>
  repo === "" ? path : `${repo}/${path}`

function server(): ServerSettings {
  const settings = loadSettings()
  if (!settings) throw new ApiError({ status: 0, path: "/api", serverMessage: "not connected" })
  return settings
}

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/git`

/** `repo` is omitted from the query when it is the project's own, so the URL a
    single-repository project fetches is the one every earlier build fetched. */
const query = (repo: string, extra: Record<string, string> = {}): string => {
  const search = new URLSearchParams(extra)
  if (repo) search.set("repo", repo)
  const encoded = search.toString()
  return encoded ? `?${encoded}` : ""
}

export function gitRepos(projectId: string, signal?: AbortSignal): Promise<GitRepo[]> {
  return api<GitRepo[]>(server(), `${base(projectId)}/repos`, { signal })
}

export function gitStatus(projectId: string, repo = "", signal?: AbortSignal): Promise<GitStatus> {
  return api<GitStatus>(server(), `${base(projectId)}/status${query(repo)}`, { signal })
}

export function gitBranches(projectId: string, repo = ""): Promise<BranchList> {
  return api<BranchList>(server(), `${base(projectId)}/branches${query(repo)}`)
}

/** `path` is project-relative — the server derives which repository owns it,
    because a file belongs to exactly one. */
export function gitFileAt(
  projectId: string,
  path: string,
  comparison: Comparison
): Promise<{ content: string; missing: boolean }> {
  return api<{ content: string; missing: boolean }>(
    server(),
    `${base(projectId)}/file${query("", { path, comparison })}`
  )
}

const action = <T>(projectId: string, name: string, body: object): Promise<T> =>
  api<T>(server(), `${base(projectId)}/${name}`, { method: "POST", body: JSON.stringify(body) })

/** An empty `paths` stages everything the panel listed; that is `git add --all`
    over the repository's visible subtree. */
export const gitStage = (projectId: string, paths: string[] = [], repo = "") =>
  action<GitStatus>(projectId, "stage", { paths, repo })

export const gitUnstage = (projectId: string, paths: string[] = [], repo = "") =>
  action<GitStatus>(projectId, "unstage", { paths, repo })

/** Never empty — the server refuses a discard with no paths, because the one
    destructive operation here should not have a form where "nothing" means
    "everything". */
export const gitDiscard = (projectId: string, paths: string[], repo = "") =>
  action<GitStatus>(projectId, "discard", { paths, repo })

export const gitCommit = (
  projectId: string,
  message: string,
  options: { amend?: boolean; repo?: string } = {}
) => action<{ output: string; status: GitStatus }>(projectId, "commit", { message, ...options })

export const gitCheckout = (
  projectId: string,
  branch: string,
  options: { create?: boolean; repo?: string } = {}
) => action<GitStatus>(projectId, "checkout", { branch, ...options })
