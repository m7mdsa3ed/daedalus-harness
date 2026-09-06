/* ── The composer's prompt history (server-side) ──
   Every message the user has actually sent, global across every thread. This
   module is the wire half; the cache that Up and the history page read is
   `lib/queries/surfaces.ts` (`useComposerHistory`), the way the inbox is split
   between `notifications-inbox.ts` and `useInbox`.

   Global is the whole point. Recall used to be the transcript of the thread you
   were standing in (`usePromptHistory` in composer.tsx), so the sentence you
   type into every new thread was the one thing Up could never give back. */

import { api, type ServerSettings } from "./settings"

export interface ComposerHistoryEntry {
  id: string
  /** The prompt as it was typed — before paste tokens are expanded, so
      recalling it puts the same short token back in the box. */
  text: string
  sessionId: string | null
  threadTitle: string | null
  createdAt: number
}

export interface ComposerHistoryState {
  items: ComposerHistoryEntry[]
}

export const fetchComposerHistory = (settings: ServerSettings, signal?: AbortSignal) =>
  api<ComposerHistoryState>(settings, "/api/composer-history", { signal })

/** Record a sent prompt. The server moves an exact repeat to the top rather
    than writing a second row, so this is safe to call on every send. Answers
    `{entry: null}` for a send with no words (an attachment on its own). */
export const recordComposerHistory = (
  settings: ServerSettings,
  entry: { text: string; sessionId?: string | null; threadTitle?: string | null }
) =>
  api<{ entry: ComposerHistoryEntry | null }>(settings, "/api/composer-history", {
    method: "POST",
    body: JSON.stringify(entry),
  })

/** Forget one line, or — with no id — the whole history. */
export const clearComposerHistory = (settings: ServerSettings, id?: string) =>
  api<{ ok: true; removed: number }>(
    settings,
    id ? `/api/composer-history?id=${encodeURIComponent(id)}` : "/api/composer-history",
    { method: "DELETE" }
  )
