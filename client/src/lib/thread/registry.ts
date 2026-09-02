import { subscribePageFrozen } from "../thread-socket"
import { suppressSystemNotifications } from "../notifications"
import { ThreadConnection, type ThreadDeps } from "./connection"

/** The half of a connection's dependencies that `useActions` rebuilds — the
    other two (`onGone`, `onParked`) are the registry's own wiring. */
export type RepointableDeps = Omit<ThreadDeps, "onGone" | "onParked">

/**
 * Every thread this device holds a connection to, and the only place one is
 * made or ended.
 *
 * What this replaces is seven module-level `Map`s in `lib/actions.ts` — the
 * socket, the journal cursor, the open chain, the reconnect attempt count, its
 * timer, the parked set, and a `liveThreads` map exported from `thread-socket`
 * for the freeze handler to walk. Keyed by the same session id, swept by hand,
 * and *inconsistently*: `dropThreadRuntime` cleared six of them, while
 * `deleteThread` and `purgeThread` cleared only the socket. One entry per
 * thread means forgetting one is one call that cannot half-happen.
 */
export class ThreadRegistry {
  private entries = new Map<string, ThreadConnection>()
  /** One object, handed to every connection and mutated in place — never
      replaced. See `repoint`. */
  private shared: ThreadDeps
  private probe: () => Promise<boolean>
  private unsubscribeFrozen: () => void

  constructor(opts: {
    deps: RepointableDeps
    /** The shared "is anything listening" question, so every thread's ladder
        asks it once between them rather than once each per rung. */
    probe: () => Promise<boolean>
    /** Something parked: start the slow poll that un-parks everything at once. */
    onParked: () => void
  }) {
    this.shared = {
      ...opts.deps,
      onGone: (id) => this.destroy(id),
      onParked: opts.onParked,
    }
    this.probe = opts.probe
    /* A freeze is a property of the page, not of a thread, so it is announced
       once and applied here — the registry is what holds the sockets. */
    this.unsubscribeFrozen = subscribePageFrozen((frozen) => {
      for (const conn of this.entries.values()) conn.setBackground(frozen)
      if (!frozen) {
        /* Everything that arrived while the page was frozen is delivered now, in
           one go — including the `turn_ended` the server has already pushed a
           notification for. Announcing it again, on a device the user is by
           definition looking at, is the duplicate this window exists to
           prevent; the in-app toast still shows. */
        suppressSystemNotifications()
      }
    })
  }

  /** The connection for this thread, made if it does not exist. Every caller
      that is about to *do* something to a thread goes through here. */
  for(sessionId: string): ThreadConnection {
    const existing = this.entries.get(sessionId)
    if (existing) return existing
    const conn = new ThreadConnection(sessionId, this.shared)
    conn.probe = this.probe
    this.entries.set(sessionId, conn)
    return conn
  }

  /**
   * Aim the registry at a rebuilt dependency bag.
   *
   * `useActions` is a `useMemo`, so its `dispatch`, `getState` and `settings`
   * are rebuilt whenever its deps move — while the threads themselves are not,
   * and must not be: a second registry beside the first would hold the live
   * sockets while every new open went to the other one, which is the two-peers
   * bug in a different costume. So there is one registry per page (see
   * `threadRegistry`) and this updates the bag every connection already holds,
   * in place.
   *
   * A *different server* is a different world and does not come through here:
   * `Connected` is keyed on the server id, so switching one unmounts the whole
   * tree and `destroyAll` runs.
   */
  repoint(deps: RepointableDeps): void {
    Object.assign(this.shared, deps)
  }

  /** The connection, only if this device already has one — for readers that
      must not bring a thread into existence by asking about it. */
  get(sessionId: string): ThreadConnection | undefined {
    return this.entries.get(sessionId)
  }

  /** End one thread's connection and forget everything device-local about it. */
  destroy(sessionId: string): void {
    const conn = this.entries.get(sessionId)
    if (!conn) return
    conn.destroy()
    this.entries.delete(sessionId)
  }

  /**
   * Forget every thread the server no longer reports.
   *
   * The old maps leaked the same way the device-local stores did — a cursor, a
   * backoff timer or a live socket for a thread that is never coming back. Same
   * authority (the server's list, plus this device's drafts), same sweep, but
   * now one call per thread instead of six that could disagree.
   */
  sweep(live: Set<string>): void {
    for (const id of [...this.entries.keys()]) {
      if (!live.has(id)) this.destroy(id)
    }
  }

  /** Everything sitting out a ladder or parked — what the network watcher
      retries when the world comes back. */
  recovering(): ThreadConnection[] {
    return [...this.entries.values()].filter((conn) => conn.isRecovering)
  }

  hasParked(): boolean {
    return [...this.entries.values()].some((conn) => conn.isParked)
  }

  /** The connection is closing (a different server, or the app unmounting).
      The page's registry goes with it: this one has dropped its freeze
      subscription, so the next `threadRegistry` must build a new one rather
      than re-point this. */
  destroyAll(): void {
    this.unsubscribeFrozen()
    for (const conn of this.entries.values()) conn.destroy()
    this.entries.clear()
    if (pageRegistry === this) pageRegistry = null
  }
}

/**
 * The page's registry — one, made on first ask and re-pointed thereafter.
 *
 * Module-level for exactly the reason the maps it replaces were: it holds live
 * sockets, and it has to outlive React. `useActions` is a `useMemo` whose deps
 * (`settings`, `dispatch`, `getState`) can be rebuilt without the page having
 * changed servers — and building a second registry there would leave the first
 * one holding every open socket while every subsequent open went to the second,
 * which is the two-peers-on-one-session bug wearing a different hat.
 */
let pageRegistry: ThreadRegistry | null = null

/** The registry, if `useActions` has configured one — for surfaces that hold a
    thread open without being able to build one. `Connected` mounts above every
    such surface, so in practice this is only null before the app exists. */
export function currentRegistry(): ThreadRegistry | null {
  return pageRegistry
}

export function threadRegistry(opts: {
  deps: RepointableDeps
  probe: () => Promise<boolean>
  onParked: () => void
}): ThreadRegistry {
  if (pageRegistry) {
    pageRegistry.repoint(opts.deps)
    return pageRegistry
  }
  pageRegistry = new ThreadRegistry(opts)
  return pageRegistry
}
