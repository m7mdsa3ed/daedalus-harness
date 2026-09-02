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
type DraftListener = (text: string) => void
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

/* Readers that follow the box as it is typed into — the build page derives a
   project name from it. Told on every `saveDraft`, ahead of the debounce,
   and never by `appendDraft`'s own listeners: those are the composer's, and
   they move the caret. */
const watchers = new Map<string, Set<DraftListener>>()

export function watchDraft(sessionId: string, listener: DraftListener): () => void {
  let set = watchers.get(sessionId)
  if (!set) {
    set = new Set()
    watchers.set(sessionId, set)
  }
  set.add(listener)
  return () => {
    const current = watchers.get(sessionId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) watchers.delete(sessionId)
  }
}

export function saveDraft(sessionId: string, text: string): void {
  pending.set(sessionId, text)
  for (const listener of [...(watchers.get(sessionId) ?? [])]) listener(text)
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

/* ── Writes from outside the composer ──
   The composer owns its own `text` state and only *writes* the draft, so a
   line another surface wants to put in the box — the preview's "Selected
   element" — has to be announced, or it would land in storage and never on
   screen. `appendDraft` writes and announces; the composer subscribes and
   adopts the text (and takes the caret). Per session, like everything here. */
const listeners = new Map<string, Set<DraftListener>>()

export function subscribeDraft(sessionId: string, listener: DraftListener): () => void {
  let set = listeners.get(sessionId)
  if (!set) {
    set = new Set()
    listeners.set(sessionId, set)
  }
  set.add(listener)
  return () => {
    const current = listeners.get(sessionId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listeners.delete(sessionId)
  }
}

/** Add a line under whatever is in the box (a blank box gets the line alone)
    and tell the mounted composer, if there is one. */
export function appendDraft(sessionId: string, line: string): string {
  const current = loadDraft(sessionId)
  const next = current.trim() ? `${current.replace(/\s+$/, "")}\n${line}` : line
  saveDraft(sessionId, next)
  for (const listener of [...(listeners.get(sessionId) ?? [])]) listener(next)
  return next
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
