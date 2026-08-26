import * as React from "react"

import type { Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import type { DependencyGraph } from "./types"

/* ── The board's dependency graph, fetched once ──
   `GET /api/boards/:id/dependencies` answers with the whole edge list plus the
   server's blocked set — one payload that four surfaces want at the same time
   (kanban/list/table blocked badges, the timeline's arrows, the picker inside
   the task editor). A fetch per card would be absurd, and a fetch per view is
   only slightly less so, so this is a module-level cache in the shape
   lib/pins.ts established: one map, a listener set, and an in-flight map so two
   mounts in the same frame make one request.

   It is deliberately NOT in the store: like comments and activity it is a
   derived log the board fetch does not carry, and it is invalidated by exactly
   one thing — a dependency added or removed (dependency-picker forces a
   reload), which is why nothing here tries to patch the edge list by hand. */

const EMPTY: DependencyGraph = { dependencies: [], blockedTaskIds: [] }

const cache = new Map<string, DependencyGraph>()
const inflight = new Map<string, Promise<DependencyGraph>>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** The cached graph for a board — a stable object, so it is a safe
    `useSyncExternalStore` snapshot and a safe `useMemo` dependency. */
export function dependencyGraph(boardId: string): DependencyGraph {
  return cache.get(boardId) ?? EMPTY
}

/**
 * Fetch the graph unless it is already cached (`force` to refetch after a
 * mutation). Concurrent callers share the one request.
 */
export function loadDependencyGraph(
  actions: Actions,
  boardId: string,
  opts: { force?: boolean } = {}
): Promise<DependencyGraph> {
  if (!boardId) return Promise.resolve(EMPTY)
  if (!opts.force) {
    const cached = cache.get(boardId)
    if (cached) return Promise.resolve(cached)
    const pending = inflight.get(boardId)
    if (pending) return pending
  }
  const request = actions
    .loadDependencies(boardId)
    .then((graph) => {
      cache.set(boardId, graph)
      notify()
      return graph
    })
    .finally(() => {
      if (inflight.get(boardId) === request) inflight.delete(boardId)
    })
  inflight.set(boardId, request)
  return request
}

/** Whether the board's graph has landed — the difference between "nothing
    blocks this" and "nothing is known yet". */
export function hasDependencyGraph(boardId: string): boolean {
  return cache.has(boardId)
}

/**
 * Optimistic edit of the cached graph — the picker paints an added/removed
 * edge before the round trip, then forces a reload so the server's
 * `blockedTaskIds` (which only it can compute) replaces the guess.
 */
export function patchDependencyGraph(
  boardId: string,
  update: (graph: DependencyGraph) => DependencyGraph
): void {
  if (!boardId) return
  cache.set(boardId, update(dependencyGraph(boardId)))
  notify()
}

/** Drop what a board knew — used when its tasks are reloaded wholesale. */
export function forgetDependencyGraph(boardId: string): void {
  if (!cache.delete(boardId)) return
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The board's graph, live, fetched on first use. Every consumer on the page
 * gets the same object — the badge in a lane, the arrows in the timeline and
 * the picker in the editor cannot disagree about what blocks what.
 */
export function useDependencyGraph(actions: Actions, boardId: string): DependencyGraph {
  const snapshot = React.useCallback(() => dependencyGraph(boardId), [boardId])
  const graph = React.useSyncExternalStore(subscribe, snapshot, snapshot)

  React.useEffect(() => {
    if (!boardId) return
    loadDependencyGraph(actions, boardId).catch((error) =>
      reportError(error, "Couldn't load the dependency graph")
    )
    /* A board is shared by every client of the harness and nothing pushes an
       added edge here, so — exactly like `usePmRefreshOnFocus` does for the
       board itself — the moment the tab comes back is the honest moment to
       ask again. A failure here is a stale graph, not a broken page: it warns
       rather than toasting over whatever the user came back to. */
    const refresh = () => {
      if (document.visibilityState === "hidden") return
      loadDependencyGraph(actions, boardId, { force: true }).catch((error) =>
        console.warn(`Couldn't refresh the dependencies of ${boardId}`, error)
      )
    }
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [actions, boardId])

  return graph
}

/** `blockedTaskIds` as a set — memoized on the array identity the cache keeps
    stable, so a lane's `memo` is not defeated by a fresh Set per render. */
export function useBlockedTaskIds(graph: DependencyGraph): ReadonlySet<string> {
  return React.useMemo(() => new Set(graph.blockedTaskIds), [graph.blockedTaskIds])
}
