/* ── A directory of a project's working tree ──
   One read per directory, which is what the Preview panel's explorer expands
   into: the root is always asked for and every other listing is mounted only
   while its directory is open, so a repository the size of this one costs one
   request per branch the reader actually opened.

   `staleTime: Infinity` because nothing here polls: the watch stream is what
   says a directory changed (`project-tree.tsx` invalidates the family), and a
   read that has landed stays good until it does. An explorer that re-listed
   every open branch on focus was the fetch storm this avoids. */
import { useQuery } from "@tanstack/react-query"

import { useServer } from "@/lib/server-context"
import { listTree } from "@/lib/workspace/fs-api"
import { projectTreeKey } from "./keys"

export interface TreeFlags {
  /** Dotfiles. Off by default, and the explorer's own toggle. */
  hidden: boolean
  /** Everything `.gitignore` covers — `node_modules`, build output. */
  ignored: boolean
}

export function useProjectTree(
  projectId: string,
  path: string,
  flags: TreeFlags,
  enabled = true
) {
  const settings = useServer()
  return useQuery({
    queryKey: projectTreeKey(settings, projectId, path, flags),
    queryFn: ({ signal }) => listTree(projectId, path, { ...flags, signal }),
    enabled,
    staleTime: Infinity,
  })
}
