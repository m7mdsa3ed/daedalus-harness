/* ── Which thread is in front, and which you have been in ──
   There are no tabs, so "the thread in front of you" is the route: the address
   bar names it, and `useActiveChat` reads it. "Open threads" is what the dock
   used to publish — the chats with a tab — and is now the threads you have
   *visited*, most recent last, so the sidebar can keep their rows loaded and
   the quick switcher can walk them.

   Device-local and small: a thread you have not opened for a dozen others is
   just a row in the list. Written by `ThreadRoute` on arrival. */
import { useLocation } from "react-router"

import { createLocalStore } from "@/lib/local-store"
import { routedThreadId } from "@/lib/router"

const KEEP = 12

const recent = createLocalStore<string[]>(
  "daedalus.recent-threads.v1",
  (raw) =>
    Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string").slice(-KEEP) : [],
  []
)

/** Note that a thread was opened. Returns nothing: it is an effect's body. */
export function recordVisit(sessionId: string): void {
  if (!sessionId) return
  const current = recent.get()
  if (current.at(-1) === sessionId) return
  recent.set([...current.filter((id) => id !== sessionId), sessionId].slice(-KEEP))
}

export function recentThreadIds(): readonly string[] {
  return recent.get()
}

export function forgetVisit(sessionId: string): void {
  const current = recent.get()
  if (current.includes(sessionId)) recent.set(current.filter((id) => id !== sessionId))
}

export function clearRecentThreads(): void {
  recent.set([])
}

/** The threads you have been in, oldest first. Keeps their rows loaded in the
    sidebar and orders the quick switcher. */
export function useOpenThreads(): readonly string[] {
  return recent.use()
}

/** The thread the address bar names; null on any other page. */
export function useActiveChat(): string | null {
  const location = useLocation()
  return routedThreadId(location.pathname, location.search)
}

/** The thread `delta` steps along the ones you have been in — the walk behind
    Alt+↓/↑ and the palette's Next/Previous thread. Negative goes to an older
    one, as the sidebar reads (newest at the top, ↓ is older). `isLive` drops
    threads that no longer exist or are in the trash. */
export function adjacentThread(
  delta: number,
  current: string | null,
  isLive: (id: string) => boolean
): string | null {
  const ids = recent.get().filter(isLive)
  if (ids.length === 0) return null
  const at = ids.indexOf(current ?? "")
  return ids[(Math.max(at, 0) + delta + ids.length) % ids.length] ?? null
}
