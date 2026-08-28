/* ── Unsaved buffers ──
   What you had typed, kept across a reload of the page.

   This is not a nicety here. The service worker updates by prompting, and
   taking that prompt reloads the tab — so "the renderer restarted" is a thing
   this app does to itself, on purpose, potentially while an editor is dirty.
   Losing the buffer to a version bump would be the app eating your work.

   Keyed by server + project + path, and stamped with the **base version** the
   buffer was edited from. That stamp is what makes restoring safe: a buffer
   whose base no longer matches the file on disk is not silently re-applied over
   somebody else's change — the panel restores it as dirty and shows the same
   conflict it would have shown had the change landed while the tab was open.

   Same shape as `drafts.ts`/`pins.ts`: a tiny device-local store, no server. */
import { loadSettings } from "@/lib/settings"

export interface StoredBuffer {
  content: string
  /** The file version this edit started from. */
  baseVersion: string
  at: number
}

const KEY = "daedalus.buffers.v1"
/** A buffer nobody came back for is not worth keeping forever. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

type Store = Record<string, StoredBuffer>

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Store) : {}
  } catch {
    return {}
  }
}

function write(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch (error) {
    // Quota. The editor still works; the buffer just will not survive a reload,
    // and a toast on every keystroke would be worse than the loss.
    console.warn("Could not persist the editor buffer", error)
  }
}

const bufferKey = (projectId: string, path: string): string =>
  `${loadSettings()?.id ?? "none"}:${projectId}:${path}`

export function loadBuffer(projectId: string, path: string): StoredBuffer | null {
  const store = read()
  const entry = store[bufferKey(projectId, path)]
  if (!entry) return null
  if (Date.now() - entry.at > MAX_AGE_MS) {
    clearBuffer(projectId, path)
    return null
  }
  return entry
}

export function saveBuffer(
  projectId: string,
  path: string,
  content: string,
  baseVersion: string
): void {
  const store = read()
  store[bufferKey(projectId, path)] = { content, baseVersion, at: Date.now() }
  write(prune(store))
}

export function clearBuffer(projectId: string, path: string): void {
  const store = read()
  delete store[bufferKey(projectId, path)]
  write(store)
}

/** Drop expired entries whenever the store is written. There is no other
    sweeper, and a store that only ever grows is the thing that eventually
    throws the quota error above. */
function prune(store: Store): Store {
  const cutoff = Date.now() - MAX_AGE_MS
  for (const [key, entry] of Object.entries(store)) {
    if (entry.at < cutoff) delete store[key]
  }
  return store
}

/** Every path with unsaved work, for the current server. Used to warn before
    the tab closes. */
export function dirtyPaths(): string[] {
  const prefix = `${loadSettings()?.id ?? "none"}:`
  return Object.keys(read())
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
}
