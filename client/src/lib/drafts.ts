/* ── Composer drafts ──
   A half-written prompt survives a reload, a navigation to another thread and
   back, and an Electron restart. Per session, on this device only — the server
   never sees an unsent message.

   localStorage rather than the store: the draft is a property of this browser,
   not of the session everyone connected to the harness shares. */

const PREFIX = "ui.draft."

export function loadDraft(sessionId: string): string {
  try {
    return localStorage.getItem(PREFIX + sessionId) ?? ""
  } catch {
    return ""
  }
}

export function saveDraft(sessionId: string, text: string): void {
  try {
    if (text) localStorage.setItem(PREFIX + sessionId, text)
    else localStorage.removeItem(PREFIX + sessionId)
  } catch {
    // A full or blocked storage costs the draft, never the message.
  }
}

export const clearDraft = (sessionId: string): void => saveDraft(sessionId, "")

/** Drop drafts for sessions that no longer exist — deleting a thread here, or
    on another client, otherwise leaks its draft into storage forever. */
export function pruneDrafts(sessionIds: Iterable<string>): void {
  const live = new Set(sessionIds)
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(PREFIX) && !live.has(key.slice(PREFIX.length))) {
        localStorage.removeItem(key)
      }
    }
  } catch {
    // Nothing to prune if storage is unavailable.
  }
}
