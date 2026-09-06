import { api, type ServerSettings } from "../settings"
import type { ThreadRegistry } from "./registry"

/**
 * How often a parked thread asks whether the server is back.
 *
 * `online` and `visibilitychange` are the only other things that un-park one,
 * and neither fires for the case that parks threads most often: the server
 * restarts while the tab stays focused and the network never drops. There is a
 * network the whole time, so `navigator.onLine` stays true and says nothing
 * about whether anything is listening — so without this, a thread that gave up
 * during a deploy stays parked until somebody clicks Reconnect.
 */
const HEALTH_POLL_MS = 20_000
/** One probe answers every caller for a moment: a server restart drops every
    thread the dock has open, and each of them would otherwise ask separately,
    in the same tick, on every rung of its own ladder. */
const HEALTH_PROBE_TTL_MS = 1_000

/**
 * The window-level half of staying connected: the `online` and
 * `visibilitychange` listeners, the shared health probe, and the slow poll that
 * un-parks threads a deploy left behind.
 *
 * Module-level state, because it outlives React and because there is exactly one
 * of each of these per page. The *registry* it acts on is not — a different
 * server is a different world — so it is re-pointed rather than rebuilt.
 */
let listenersInstalled = false
let current: {
  settings: ServerSettings
  registry: ThreadRegistry
} | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let probeCache: { at: number; promise: Promise<boolean> } | null = null

/** Whether anything is listening on the other end. Unauthenticated on purpose:
    `/api/health` exempts itself from the token check, so this answers on a
    server whose credentials have since changed — which is the right reading,
    since what it asks is only "is anything there". */
export function serverReachable(): Promise<boolean> {
  const settings = current?.settings
  // Nothing bound yet — assume reachable, so this can only ever remove work,
  // never gate a reconnect on a probe that cannot run.
  if (!settings) return Promise.resolve(true)
  const now = Date.now()
  if (probeCache && now - probeCache.at < HEALTH_PROBE_TTL_MS) return probeCache.promise
  const promise = api(settings, "/api/health").then(
    () => true,
    () => false
  )
  probeCache = { at: now, promise }
  return promise
}

/** Runs only while something is parked, and stops itself when nothing is —
    which is why no un-parking path has to remember to call it. */
export function startHealthPoll(): void {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    const registry = current?.registry
    if (!registry || !registry.hasParked()) {
      clearInterval(pollTimer!)
      pollTimer = null
      return
    }
    // Offline is already covered by the `online` listener, and a probe against a
    // network that cannot answer is a request nobody can act on.
    if (typeof navigator !== "undefined" && !navigator.onLine) return
    void serverReachable().then((ok) => {
      if (ok) retryWaiting()
    })
  }, HEALTH_POLL_MS)
}

/* The network (or the user's attention) came back. Everything parked — and
   everything still sitting out a backoff timer — gets its counter reset and one
   immediate try; a failure re-enters the ladder at rung one. */
function retryWaiting(): void {
  if (typeof navigator !== "undefined" && !navigator.onLine) return
  for (const conn of current?.registry.recovering() ?? []) conn.retryNow(serverReachable)
}

/**
 * Point the watchers at this connection's registry.
 *
 * Called once per `useActions` memo. The listeners themselves are installed on
 * the first call and never again: one page, one `online` handler, and the last
 * registry bound is the live one — exactly the rule the module-level bound
 * callbacks followed before, said once instead of three times.
 */
export function watchNetwork(next: {
  settings: ServerSettings
  registry: ThreadRegistry
}): void {
  current = next
  if (listenersInstalled || typeof window === "undefined") return
  listenersInstalled = true
  window.addEventListener("online", () => retryWaiting())
  /* The catalog half of coming back is not here any more: every catalog read
     is a query with a staleTime and `refetchOnWindowFocus`, so a profile added
     on the laptop — or an agent the server started offering after an upgrade —
     arrives on the phone the moment its tab is looked at, per slice and only
     for the slices something is drawing. This is left with the half that is
     genuinely the network's: the parked threads. */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return
    retryWaiting()
  })
}
