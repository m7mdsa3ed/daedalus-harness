/* ── Workspace filesystem client ──
   One typed wrapper per route in `server/src/workspace-fs.ts`. Nothing here
   invents a path: what the server returns is project-relative and is handed
   straight back, so the client never learns an absolute server path and cannot
   accidentally start sending one.

   Failures throw `ApiError` like every other call in the app, which is what
   `lib/errors` already knows how to describe. The status worth naming is 409
   (the file changed under an editor) — callers branch on it rather than on
   message text. */
import { api, loadSettings, ApiError } from "@/lib/settings"

export interface WorkspaceEntry {
  name: string
  /** Project-relative, POSIX-separated. "" is the project root. */
  path: string
  type: "dir" | "file"
  size?: number
  link?: boolean
  ignored?: boolean
  hidden?: boolean
}

export interface WorkspaceStat {
  path: string
  type: "dir" | "file"
  size: number
  /** Opaque; hand it back on write to detect a change made behind your back. */
  version: string
  binary: boolean
  tooLarge: boolean
}

export interface WorkspaceFile extends WorkspaceStat {
  /** Absent when `binary` or `tooLarge` — there is nothing safe to show. */
  content?: string
}

/** True when a write was refused because the file moved on underneath it. */
export const isConflict = (err: unknown): boolean =>
  err instanceof ApiError && err.status === 409

function server() {
  const settings = loadSettings()
  if (!settings) throw new ApiError({ status: 0, path: "/api", serverMessage: "not connected" })
  return settings
}

const q = (params: Record<string, string | undefined>) => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, value)
  const text = search.toString()
  return text ? `?${text}` : ""
}

export interface WorkspaceSearch {
  entries: WorkspaceEntry[]
  /** More matched than were sent, or the walk hit its budget. */
  truncated: boolean
}

/** Fuzzy path search across the whole project — what the composer's `@` menu
    reads. An empty query answers with the project root's own listing. */
export function searchFiles(
  projectId: string,
  query: string,
  options: { limit?: number; signal?: AbortSignal } = {}
): Promise<WorkspaceSearch> {
  return api<WorkspaceSearch>(
    server(),
    `/api/projects/${encodeURIComponent(projectId)}/files/search${q({
      q: query,
      limit: options.limit ? String(options.limit) : undefined,
    })}`,
    { signal: options.signal }
  )
}

export function readFile(
  projectId: string,
  path: string,
  signal?: AbortSignal
): Promise<WorkspaceFile> {
  return api<WorkspaceFile>(
    server(),
    `/api/projects/${encodeURIComponent(projectId)}/file${q({ path })}`,
    { signal }
  )
}

export function writeFile(
  projectId: string,
  path: string,
  content: string,
  options: { expectedVersion?: string; force?: boolean } = {}
): Promise<WorkspaceStat> {
  return api<WorkspaceStat>(
    server(),
    `/api/projects/${encodeURIComponent(projectId)}/file${q({ path })}`,
    { method: "PUT", body: JSON.stringify({ content, ...options }) }
  )
}

/**
 * A file's raw bytes as an object URL, for the editor's image preview.
 *
 * Not an `<img src>` pointing at the route: an image element cannot carry an
 * Authorization header, and the alternative is the bearer token in a URL that
 * ends up in history and in any proxy's logs — the same reason the watch
 * stream is `fetch` and not `EventSource`. So the bytes are fetched with the
 * header and handed to the DOM as a blob. The caller owns the URL and must
 * revoke it; an object URL lives until the document is discarded.
 */
export async function readFileObjectUrl(
  projectId: string,
  path: string,
  signal?: AbortSignal
): Promise<string> {
  const settings = server()
  const response = await fetch(
    new URL(
      `/api/projects/${encodeURIComponent(projectId)}/file-raw${q({ path })}`,
      settings.url
    ),
    { headers: { authorization: `Bearer ${settings.token}` }, signal }
  )
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    let message = body.trim() || undefined
    try {
      const parsed = JSON.parse(body) as { error?: unknown }
      if (typeof parsed.error === "string") message = parsed.error
    } catch {
      /* not JSON — the raw text is the message */
    }
    throw new ApiError({ status: response.status, path, serverMessage: message })
  }
  return URL.createObjectURL(await response.blob())
}

/* ── Path helpers ──────────────────────────────────────────────────────────── */

export const basename = (path: string): string => path.split("/").pop() ?? path
