import { useSyncExternalStore } from "react"

/* ── Device-local stores ──
   The one shape under every module-level reactive store in this directory:
   a cached value, a listeners Set, and a useSyncExternalStore hook. Seven
   stores each hand-rolled it, and only pins.ts remembered the part that makes
   it correct across tabs — the `storage` listener that rebuilds the cache when
   another tab writes the same key. A keybinding or view option changed in tab
   A was silently stale in tab B until reload.

   Two layers, because two of the stores' backings differ:

   - `createStore(initial)` is the bare reactive cell — for state whose source
     is the server (boards, tasks, the notification inbox), where a `storage`
     event can never arrive because nothing is in localStorage.
   - `createLocalStore(key, parse, fallback)` persists the cell to one
     localStorage key and rebuilds it on cross-tab writes. `parse` receives the
     JSON-parsed raw and must validate it — the blob is user-editable and
     outlives any one release, so junk must not reach the cache. `fallback` is
     the value when the key is absent or unreadable.

   The cached value is referentially stable between writes, so `get` is safe as
   a useSyncExternalStore snapshot directly. A store whose *exposed* value is
   derived from what it persists (view-options, keybindings) memoises the
   derivation against the stored reference in its own module. */

export interface Store<T> {
  /** Current value — stable between writes, safe as a snapshot. */
  get: () => T
  set: (next: T) => void
  subscribe: (listener: () => void) => () => void
  /** The value, live. */
  use: () => T
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<() => void>()
  const get = () => state
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  return {
    get,
    subscribe,
    set(next: T) {
      state = next
      for (const listener of listeners) listener()
    },
    use: () => useSyncExternalStore(subscribe, get, get),
  }
}

export function createLocalStore<T>(
  key: string,
  parse: (raw: unknown) => T,
  fallback: T
): Store<T> {
  function read(): T {
    try {
      const item = localStorage.getItem(key)
      return item === null ? fallback : parse(JSON.parse(item) as unknown)
    } catch {
      return fallback
    }
  }

  const cell = createStore(read())

  /* Another tab writing the key wrote it for this device too. A null key is
     `storage.clear()`, which emptied this key with the rest. */
  if (typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
      if (event.key !== null && event.key !== key) return
      cell.set(read())
    })
  }

  return {
    ...cell,
    set(next: T) {
      cell.set(next)
      try {
        localStorage.setItem(key, JSON.stringify(next))
      } catch {
        // A forgotten preference is not worth throwing out of a click handler.
      }
    },
  }
}
