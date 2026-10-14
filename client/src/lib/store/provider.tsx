/* eslint-disable react-refresh/only-export-components */
import * as React from "react"
import type { SessionMeta } from "../settings"
import { reducer, type Action } from "./reducer"
import { emptyThread, type State, type ThreadState } from "./thread"

export const initialState: State = {
  sessions: [],
  sessionWindow: { ids: [], total: 0 },
  threads: {},
}

// ---- context ----

/**
 * The store is an external store now, not a state context, and **the reducer
 * lives in here** rather than in `App`.
 *
 * Both halves of that are load-bearing, and neither works without the other.
 *
 * *Why not a state context.* A context consumer is re-rendered on every
 * provider commit whatever it went on to read, so `StateContext` could never
 * say "only this thread" — and the dock keeps every opened transcript
 * mounted, so one streamed token in a background thread re-rendered every
 * open transcript and re-ran each one's derivations. `useSyncExternalStore`
 * moves the comparison to the value the consumer actually named:
 * `useStoreSelect` publishes a snapshot and React's own `Object.is` decides
 * whether that consumer renders. The reducer already keeps the identities
 * that makes true — `withThread` replaces exactly one thread's object, and
 * every case that edits `sessions` maps untouched rows through — so a token
 * in thread A leaves thread B's snapshot referentially equal, and B does not
 * render at all.
 *
 * *Why the reducer moved.* It was `useReducer` in `App`, which meant every
 * dispatch re-rendered `App` and so recreated the element for the entire
 * tree — subscriptions cannot help a subtree React has already decided to
 * re-render. Owning the reducer here makes `children` a prop this component
 * does not touch, so on a dispatch React sees the same element reference and
 * bails out of the subtree; only `DispatchContext` consumers (a stable value,
 * so never) and the selectors that actually changed are woken.
 *
 * The ref is written in a layout effect and never during render: a render
 * pass can be thrown away, and a snapshot published from one would let a
 * subscriber read state that never committed. Layout rather than passive so
 * subscribers render before paint.
 */
export const DispatchContext = React.createContext<React.Dispatch<Action>>(() => {})

export interface StoreHandle {
  getState: () => State
  subscribe: (listener: () => void) => () => void
}

const StoreHandleContext = React.createContext<StoreHandle | null>(null)

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = React.useReducer(reducer, initialState)
  const stateRef = React.useRef(state)
  const listeners = React.useRef(new Set<() => void>())
  const handle = React.useMemo<StoreHandle>(
    () => ({
      getState: () => stateRef.current,
      subscribe: (listener) => {
        listeners.current.add(listener)
        return () => listeners.current.delete(listener)
      },
    }),
    []
  )
  React.useLayoutEffect(() => {
    stateRef.current = state
    /* Copied before the walk: a listener that unsubscribes as it runs (a
       consumer unmounting on the state it was just told about) would
       otherwise mutate the set being iterated. */
    for (const listener of [...listeners.current]) listener()
  }, [state])
  return (
    <DispatchContext.Provider value={dispatch}>
      <StoreHandleContext.Provider value={handle}>{children}</StoreHandleContext.Provider>
    </DispatchContext.Provider>
  )
}

/** The handle itself, for a consumer that reads state without watching it —
    `useActions` is the one: every read there is out of an event handler, long
    after the render that would have subscribed. */
export function useStoreHandle(): StoreHandle {
  const handle = React.useContext(StoreHandleContext)
  if (!handle) throw new Error("useStoreHandle outside StoreProvider")
  return handle
}

/**
 * Subscribe to one reading of the state. The selector MUST return something
 * the state itself holds (a slice, a thread, a row) — a selector that builds
 * a fresh object returns a new identity per notify and re-renders on every
 * dispatch, which is exactly the wide hook this exists to replace.
 */
export function useStoreSelect<T>(selector: (state: State) => T): T {
  const handle = useStoreHandle()
  const ref = React.useRef(selector)
  ref.current = selector
  const getSnapshot = React.useCallback(() => ref.current(handle.getState()), [handle])
  return React.useSyncExternalStore(handle.subscribe, getSnapshot)
}

/** This thread's state and nothing else: re-renders exactly when the reducer
    replaces this thread's object. The one hook every transcript-path consumer
    should be on — the dock keeps every opened transcript mounted, and this is
    what keeps a streamed token in thread A from re-rendering thread B. */
export function useThread(sessionId: string): ThreadState {
  return useStoreSelect((state) => state.threads[sessionId] ?? emptyThread)
}

/** One session's row. Stable across other sessions' changes: every reducer
    case that edits the list maps `s.id === id ? {…s} : s`, so an untouched
    row keeps its identity and only a full list refresh replaces them all. */
export function useSessionMeta(sessionId: string): SessionMeta | undefined {
  return useStoreSelect((state) => state.sessions.find((s) => s.id === sessionId))
}

/**
 * Which threads are mid-turn, for a list that draws a running mark per row.
 *
 * `threads` is replaced on every streamed token, so a list that reads it to
 * answer one boolean per row re-rendered thousands of times a turn to draw
 * the same marks. The derivation runs on each notify (one pass, no parsing)
 * and the map is *reused by identity* while its contents are unchanged, so
 * the store's own `Object.is` stops the render at the subscription.
 *
 * A missing entry means this client has never connected the thread, which is
 * not the same as a connected thread sitting idle: the caller falls back to
 * the server's `promptActive` for the first and must not for the second.
 */
export function useLiveTurnActive(): Map<string, boolean> {
  const prev = React.useRef<Map<string, boolean>>(new Map())
  return useStoreSelect((state) => {
    const next = new Map<string, boolean>()
    for (const [id, thread] of Object.entries(state.threads)) next.set(id, thread.turnActive)
    let same = next.size === prev.current.size
    if (same) {
      for (const [id, value] of next) {
        if (prev.current.get(id) !== value) {
          same = false
          break
        }
      }
    }
    if (!same) prev.current = next
    return prev.current
  })
}

/** Stable for the life of the reducer, so a consumer that reads only this
    never re-renders on state. */
export function useDispatch(): React.Dispatch<Action> {
  return React.useContext(DispatchContext)
}
