/* ── Per-thread view options ──
   How a transcript is *displayed* — not what it contains, and not anything the
   agent needs to know. Local to this device, per session, so a thread you read
   with timestamps on stays that way without imposing it on the next one or on
   anyone else connected to the same harness.

   Adding an option: extend DEFAULTS and add a row in session-settings.tsx.
   Nothing else needs to change; the dialog renders whatever is declared. */
import { useSyncExternalStore } from "react"

export interface ViewOptions {
  /** Wall-clock time beside each message and step. */
  showTimestamps: boolean
  /** Fold runs of consecutive tool steps into one expandable block. */
  groupTools: boolean
}

export const VIEW_DEFAULTS: ViewOptions = {
  showTimestamps: false,
  groupTools: false,
}

const STORAGE_KEY = "ui.viewOptions"

function read(): Record<string, Partial<ViewOptions>> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as unknown
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, Partial<ViewOptions>>)
      : {}
  } catch {
    return {}
  }
}

let cache = read()
const listeners = new Set<() => void>()

/* Resolved objects are memoised per session so useSyncExternalStore's snapshot
   is referentially stable — returning a fresh object each call is an infinite
   render loop, not a subtle inefficiency. */
let resolved = new Map<string, ViewOptions>()

function optionsFor(sessionId: string): ViewOptions {
  const hit = resolved.get(sessionId)
  if (hit) return hit
  const value = { ...VIEW_DEFAULTS, ...cache[sessionId] }
  resolved.set(sessionId, value)
  return value
}

function commit(next: Record<string, Partial<ViewOptions>>) {
  cache = next
  resolved = new Map()
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // A forgotten preference is not worth throwing out of a click handler.
  }
  for (const listener of listeners) listener()
}

export function setViewOption<K extends keyof ViewOptions>(
  sessionId: string,
  key: K,
  value: ViewOptions[K]
): void {
  commit({ ...cache, [sessionId]: { ...cache[sessionId], [key]: value } })
}

export function resetViewOptions(sessionId: string): void {
  const next = { ...cache }
  delete next[sessionId]
  commit(next)
}

/** Drop options for sessions the server no longer lists — as drafts and pins do. */
export function pruneViewOptions(sessionIds: Iterable<string>): void {
  const live = new Set(sessionIds)
  const kept = Object.fromEntries(Object.entries(cache).filter(([id]) => live.has(id)))
  if (Object.keys(kept).length !== Object.keys(cache).length) commit(kept)
}

export function useViewOptions(sessionId: string): ViewOptions {
  const snapshot = () => optionsFor(sessionId)
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    snapshot,
    snapshot
  )
}
