/* ── Full-text thread search ──
   The fetch half of the command palette's "Messages" group. The server owns
   the index (an FTS5 table over the journal's prose — server/src/search.ts);
   this file is only the call and the snippet decoding.

   A snippet arrives with each match bracketed by two private-use codepoints —
   characters, not markup, so decoding is a split and there is never any HTML
   to trust. The constants mirror SNIPPET_START/SNIPPET_END in
   server/src/search.ts (protocol.ts is imported type-only, so runtime values
   cannot live there). */
import { api, loadSettings } from "@/lib/settings"

const SNIPPET_START = "\u{E000}"
const SNIPPET_END = "\u{E001}"

export interface SearchResult {
  sessionId: string
  seq: number
  /** Prose with matches bracketed by the private-use markers. */
  snippet: string
  title: string
  projectId: string
  /** Resolved server-side — the project may not be in this client's store. */
  projectName: string
  at: number
}

/** Search every thread's transcript on the active server. Empty when no
    server is configured; throws ApiError like every other call (an abort
    surfaces as status 0). */
export async function searchThreads(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const settings = loadSettings()
  if (!settings) return []
  const { results } = await api<{ results: SearchResult[] }>(
    settings,
    `/api/search?q=${encodeURIComponent(query)}&limit=30`,
    { signal },
  )
  return results
}

export interface SnippetPart {
  text: string
  match: boolean
}

/** Decode a marked snippet into runs, for rendering as styled spans. Tolerant
    of an unpaired marker (treated as plain text with the marker dropped). */
export function snippetParts(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = []
  const [head, ...rest] = snippet.split(SNIPPET_START)
  if (head) parts.push({ text: head, match: false })
  for (const segment of rest) {
    const end = segment.indexOf(SNIPPET_END)
    if (end === -1) {
      if (segment) parts.push({ text: segment, match: false })
      continue
    }
    const matched = segment.slice(0, end)
    const tail = segment.slice(end + SNIPPET_END.length)
    if (matched) parts.push({ text: matched, match: true })
    if (tail) parts.push({ text: tail, match: false })
  }
  return parts
}
