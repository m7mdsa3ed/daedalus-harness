/*
 * Which space this device is looking at.
 *
 * The spaces themselves are the server's (`GET /api/spaces`, cached in
 * `lib/queries/catalog`); what is device-local is only *which one you are in*,
 * exactly like `lib/view-options` and `lib/drafts` — how you are looking at the
 * work is the reader's property, not the conversation's. It is per server,
 * because a space id names a row the server that minted it holds, and one
 * device may talk to several.
 *
 * A plain module-level store with a subscription, read through
 * `useSyncExternalStore`: the only thing that changes is the id, and every
 * reader wants the same one.
 */
import * as React from "react"

/** `{ [serverId]: spaceId }` */
type Store = Record<string, string>

const KEY = "daedalus.space"

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" ? (parsed as Store) : {}
  } catch {
    return {}
  }
}

function write(store: Store): void {
  localStorage.setItem(KEY, JSON.stringify(store))
}

const listeners = new Set<() => void>()

function emit(): void {
  for (const fn of listeners) fn()
}

/** The space this device chose for a server, or null when it never chose —
    the caller resolves the first space as the fallback. */
export function loadActiveSpace(serverId: string): string | null {
  return read()[serverId] ?? null
}

export function setActiveSpace(serverId: string, spaceId: string): void {
  const store = read()
  if (store[serverId] === spaceId) return
  write({ ...store, [serverId]: spaceId })
  emit()
}

/** Forget a server's choice — its space ids name rows that server holds, so a
    forgotten server's selection is a key nothing can reach again. */
export function clearActiveSpace(serverId: string): void {
  const store = read()
  if (!(serverId in store)) return
  const { [serverId]: _drop, ...rest } = store
  write(rest)
  emit()
}

export function subscribeActiveSpace(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** The chosen space id for a server, re-rendering every reader on a switch.
    Null until a choice is made (see `useActiveSpace` for the resolution). */
export function useActiveSpaceId(serverId: string): string | null {
  return React.useSyncExternalStore(
    subscribeActiveSpace,
    () => loadActiveSpace(serverId),
    () => null
  )
}
