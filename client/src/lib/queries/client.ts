/* The QueryClient factory. One client per server connection — `Connected` is
   keyed by `settings.id` and creates one here, so switching servers starts
   from a cold, correct cache and the keys in keys.ts never have to trust that
   (they carry the server id anyway, belt-and-braces).

   Defaults follow the app's freshness bargain: cached data is answered
   instantly and refreshed when it goes stale or the window regains focus —
   the same job the manual focus/visibility listeners did, now in one place.
   No polling: everything that moves while nobody is looking arrives over the
   per-thread WebSocket, and the server is a single small process.
   Retry never replays a 4xx (a refused token does not heal), and network /
   5xx failures get two quiet tries. */
import { QueryClient } from "@tanstack/react-query"

import { ApiError } from "@/lib/settings"

function retry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError) {
    if (error.status >= 400 && error.status < 500) return false
    // status === 0 is "never reached the server" (offline, DNS, TLS, CORS).
    return failureCount < 2
  }
  return failureCount < 2
}

/* What the TanStack Query devtools browser extension reads. It attaches to a
   client it finds on `window`, and this app never had a module-level one to
   find: the client is per connection (see above), so the newest one wins here
   and the global follows a server switch rather than pointing at the cache of
   a connection that is gone.

   Typed against `@tanstack/react-query` rather than the `@tanstack/query-core`
   the extension's docs name — query-core is react-query's own dependency and
   pnpm does not link it at the top level, so naming it here would be an
   unresolvable import for the same class. */
declare global {
  interface Window {
    __TANSTACK_QUERY_CLIENT__: import("@tanstack/react-query").QueryClient
  }
}

export function makeQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        retry,
      },
      mutations: { retry: false },
    },
  })
  // Not dev-only: the extension is how a cache is inspected on the device that
  // is actually misbehaving, which is routinely a phone against a built PWA.
  if (typeof window !== "undefined") window.__TANSTACK_QUERY_CLIENT__ = client
  return client
}
