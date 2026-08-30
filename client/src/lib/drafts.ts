/* ── Composer drafts ──
   A half-written prompt survives a reload, a navigation to another thread and
   back, and an Electron restart. Per session, on this device only — the server
   never sees an unsent message.

   localStorage rather than the store: the draft is a property of this browser,
   not of the session everyone connected to the harness shares. */

const PREFIX = "ui.draft."
const SAVE_DEBOUNCE_MS = 300

/* The composer calls `saveDraft` on every keystroke and a localStorage write
   is synchronous on the main thread — so the write is debounced here, where
   every caller gets it for free. `pending` is the read-through buffer: a
   `loadDraft` or `clearDraft` inside the window must see what was just typed,
   not what last reached disk. */
const pending = new Map<string, string>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function write(sessionId: string, text: string): void {
  try {
    if (text) localStorage.setItem(PREFIX + sessionId, text)
    else localStorage.removeItem(PREFIX + sessionId)
  } catch {
    // A full or blocked storage costs the draft, never the message.
  }
}

/** Push everything buffered to disk now. The tab going away is the deadline
    the debounce must not miss: `pagehide` covers navigation and close, hidden
    covers a phone switching apps — where the process can be culled without
    `pagehide` ever firing. */
function flushDrafts(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  for (const [sessionId, text] of pending) write(sessionId, text)
  pending.clear()
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushDrafts)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushDrafts()
  })
}

export function loadDraft(sessionId: string): string {
  const buffered = pending.get(sessionId)
  if (buffered !== undefined) return buffered
  try {
    return localStorage.getItem(PREFIX + sessionId) ?? ""
  } catch {
    return ""
  }
}

export function saveDraft(sessionId: string, text: string): void {
  pending.set(sessionId, text)
  const timer = timers.get(sessionId)
  if (timer) clearTimeout(timer)
  timers.set(
    sessionId,
    setTimeout(() => {
      timers.delete(sessionId)
      const buffered = pending.get(sessionId)
      pending.delete(sessionId)
      if (buffered !== undefined) write(sessionId, buffered)
    }, SAVE_DEBOUNCE_MS)
  )
}

/** Immediate, not debounced: clearing rides a send, and a draft that
    resurrects 300ms after the message went out is the message twice. */
export function clearDraft(sessionId: string): void {
  const timer = timers.get(sessionId)
  if (timer) {
    clearTimeout(timer)
    timers.delete(sessionId)
  }
  pending.delete(sessionId)
  write(sessionId, "")
}

/** Drop drafts for sessions that no longer exist — deleting a thread here, or
    on another client, otherwise leaks its draft into storage forever. */
export function pruneDrafts(sessionIds: Iterable<string>): void {
  const live = new Set(sessionIds)
  for (const key of [...pending.keys()]) {
    if (live.has(key)) continue
    pending.delete(key)
    const timer = timers.get(key)
    if (timer) {
      clearTimeout(timer)
      timers.delete(key)
    }
  }
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
