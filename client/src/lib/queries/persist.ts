/* ── The query cache, across reloads ──
   Every read this app caches is also one it can answer from the last visit:
   the catalog, the automations and the read surfaces all describe a server
   that rarely changes between two openings of the same tab. Persisted, a
   reload paints the app it had rather than a screen of skeletons, and the
   refetch that follows corrects it — which is the same bargain `staleTime`
   already makes within a session, extended across the reload.

   It matters most on the surface this client actually is: an installed PWA,
   opened cold on a phone, often on a connection that is the slow part.

   Four rules the dump has to obey.

   **One dump per server.** The client is per connection and the keys are
   server-scoped, so the storage key is too — otherwise the second server to
   close a tab would overwrite the first's cache with rows that key-scoping
   would then (correctly) refuse to match, leaving a dump that costs space and
   answers nothing.

   **A dump is only valid for the build that wrote it.** What a query's data
   *is* changes with a release, and rehydrating last week's shape into this
   week's components is the failure that has no error message — so `buster` is
   the build id and a deploy drops every device's dump exactly once.

   **Only successful, non-volatile reads.** A failure is not worth restoring
   (it would draw an error the next fetch immediately clears), and the
   notification inbox is deliberately excluded: its whole value is being
   current, and a badge that says "3 unread" from yesterday before dropping to
   0 is a wrong answer given confidently, which is worse than the moment of
   nothing it replaces.

   **localStorage is small and this data is not bounded.** A knowledge base or
   a long task list can be megabytes, and a `setItem` that throws would
   otherwise lose the whole dump; `removeOldestQuery` sheds the least recently
   used entries until it fits. */
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister"
/* Both from react-query-persist-client, which re-exports the core it is built
   on — pnpm does not link that core at the top level, so naming it directly
   (as its own docs do) would not resolve. */
import {
  removeOldestQuery,
  type PersistQueryClientOptions,
} from "@tanstack/react-query-persist-client"

import type { ServerSettings } from "@/lib/settings"
import { notificationsKey } from "./keys"

/** Injected by vite.config.ts, one value per build. */
declare const __QUERY_CACHE_BUSTER__: string

/** A dump older than this is dropped unread rather than shown. A day is the
    gap between two working sessions; past it, "what the server looked like"
    is a guess worth less than the skeleton it would replace. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000

const storageKey = (serverId: string) => `daedalus.query-cache:${serverId}`

export function persistOptionsFor(
  settings: ServerSettings
): Omit<PersistQueryClientOptions, "queryClient"> {
  const inboxKey = JSON.stringify(notificationsKey(settings))
  return {
    persister: createSyncStoragePersister({
      storage: window.localStorage,
      key: storageKey(settings.id),
      // Shed the least recently used queries until the dump fits, rather than
      // throwing the whole thing away on one oversized entry.
      retry: removeOldestQuery,
    }),
    maxAge: MAX_AGE_MS,
    buster: __QUERY_CACHE_BUSTER__,
    dehydrateOptions: {
      /* A query can also opt out by declaring `meta: { persist: false }` —
         the dev-server status does, because what it holds is a process state
         and a per-boot credential, neither of which means anything to the
         next page load. Declared on the query rather than listed here so a
         read that must not outlive the page says so where it is written. */
      shouldDehydrateQuery: (query) =>
        query.state.status === "success" &&
        query.meta?.persist !== false &&
        JSON.stringify(query.queryKey) !== inboxKey,
      /* A mutation is an action, not a reading. Resuming one from a previous
         page load would re-send a write the user has no memory of asking for. */
      shouldDehydrateMutation: () => false,
    },
  }
}

/** Forget one server's dump. Called from `removeServer`/`clearSettings` rather
    than from the buttons that disconnect, so every path that drops a server's
    credentials drops its cached description of that server with them — the
    rows are no use without a token to refresh them, and leaving a server's
    catalog on a device that can no longer reach it is the kind of thing a
    "forget this server" is asked for in order to avoid. */
export function clearPersistedCache(serverId: string): void {
  try {
    window.localStorage.removeItem(storageKey(serverId))
  } catch {
    /* Private mode, or a full disk. The cache is an optimization either way. */
  }
}
