/* The git client — what is left of it. The source-control panel is gone, so
   the only route still read is `gitFileAt`, which feeds the editor panel's
   diff mode. It takes no `repo`: it is about one file, and a file names its
   repository by where it is — the server derives the owning worktree. */
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
