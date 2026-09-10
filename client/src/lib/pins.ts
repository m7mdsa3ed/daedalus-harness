import * as React from "react"
import { useStoreSelect } from "./store"
import type { SessionMeta } from "./settings"

/* ── Pinned threads ──
   A pin is a fact about the thread, not about this browser: it lives on the
   session row (`sessions.pinned_at`) and reaches every device the ordinary way
   the rest of the row does. It used to be localStorage next to drafts, which
   meant pinning on the laptop and finding nothing pinned on the phone.

   Order is the pin timestamp — oldest pin first, newest pin last — so the
   pinned group stays stable instead of reshuffling whenever the session list
   is refetched. */

export const pinnedIds = (sessions: SessionMeta[]): string[] =>
  sessions
    .filter((session) => session.pinnedAt)
    .sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0))
    .map((session) => session.id)

/** The pinned ids, live — the sidebar and the palette read the same list.
    Memoized on the session list, which the store replaces only on a refresh. */
export function usePins(): string[] {
  const sessions = useStoreSelect((state) => state.sessions)
  return React.useMemo(() => pinnedIds(sessions), [sessions])
}
