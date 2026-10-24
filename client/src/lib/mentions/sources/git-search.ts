/* The route behind the project-scoped kinds — `@commit:` / `@branch:` / `@tag:`
   / `@git:` (the thread's repository and the project's nested ones,
   `server/src/mentions/git-search.ts`) and `@kb:` / `@run:` / `@term:` (the
   project's own records, `local-search.ts`). Names and one-line facts, never
   content. Shared by the sources. */
import { api, loadSettings, ApiError } from "@/lib/settings"
import type { KindMatch, MentionCtx } from "../types"

export interface GitKindMatch extends KindMatch {
  /** Set when the project holds more than one repository. */
  repo?: string
}

export async function searchGit(
  kind: "commit" | "branch" | "tag" | "git" | "kb" | "run" | "term",
  query: string,
  ctx: MentionCtx,
  signal: AbortSignal,
): Promise<GitKindMatch[]> {
  const settings = loadSettings()
  if (!settings) throw new ApiError({ status: 0, path: "/api", serverMessage: "not connected" })
  const params = new URLSearchParams({ kind, q: query })
  if (ctx.sessionId) params.set("session", ctx.sessionId)
  const { matches } = await api<{ matches: GitKindMatch[] }>(
    settings,
    `/api/projects/${encodeURIComponent(ctx.projectId!)}/mentions/search?${params}`,
    { signal },
  )
  return matches
}

/** What the four sources share: the project is the scope, and a keystroke is
    a request, so one debounce. */
export const GIT_SOURCE = {
  debounceMs: 150,
  available: (ctx: MentionCtx) => !!ctx.projectId,
} as const

/** A match's row: the repository leads when there is more than one. */
export const gitRow = (match: GitKindMatch, kind: string) => ({
  label: match.label,
  description: match.description,
  aside: match.aside,
  badge: match.repo ? `${kind} · ${match.repo}` : kind,
})
