/* ── What a row's glyph and the rollups know beyond `ThreadActivity` ──
   Two readings the shared status does not carry: a turn *held* at a failure
   (`markFor` reads it as running, because a held turn is still `turnActive`)
   and a finished turn the reader has not looked at yet. The first is the
   dashboard's rule (`agentState`) asked of every session; the second is a
   fact about this device's eyes, so it is a tiny local store, never the
   server's. */
import * as React from "react"
import { createLocalStore } from "@/lib/local-store"
import { activityAt, type SessionMeta } from "@/lib/settings"
import { useStoreSelect } from "@/lib/store"

/** Every thread held at a failure. Identity-stable until a membership changes,
    for the reason `useThreadStatuses` is: `state.threads` moves per token. */
export function useHeldIds(): ReadonlySet<string> {
  const prev = React.useRef<ReadonlySet<string>>(new Set())
  return useStoreSelect((state) => {
    const next = new Set<string>()
    for (const session of state.sessions) {
      const thread = state.threads[session.id]
      const held =
        thread?.phase.kind === "live" ? thread.paused && thread.pausedReason === "error" : !!session.held
      if (held) next.add(session.id)
    }
    const same = next.size === prev.current.size && [...next].every((id) => prev.current.has(id))
    if (!same) prev.current = next
    return prev.current
  })
}

/* `seen[id]` is the `activityAt` the reader last had in front of them — the
   server's own number, so there is no clock skew to argue with. `since` is the
   first time this device looked at all: without it every thread the server has
   ever run would read unread on the first launch. */
interface Seen {
  since: number
  seen: Record<string, number>
}
const KEY = "ui.threadSeen"
const seenStore = createLocalStore<Seen>(
  KEY,
  (raw) => {
    const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Seen>
    const seen: Record<string, number> = {}
    for (const [id, at] of Object.entries(r.seen ?? {})) if (typeof at === "number") seen[id] = at
    return { since: typeof r.since === "number" ? r.since : Date.now(), seen }
  },
  { since: Date.now(), seen: {} }
)
// Persist the baseline once, or a reload would mint a new one.
if (typeof localStorage !== "undefined" && localStorage.getItem(KEY) === null) seenStore.set(seenStore.get())

/** Reading is not activity: this writes the device's store and nothing else. */
export function markSeen(session: SessionMeta) {
  const at = activityAt(session)
  const current = seenStore.get()
  if ((current.seen[session.id] ?? 0) >= at) return
  seenStore.set({ ...current, seen: { ...current.seen, [session.id]: at } })
}

/** Threads whose last turn ended after the reader last looked, and that are
    idle now — a running or asking thread says so louder than "finished".

    `activeId` is the thread in front of the reader. The caller passes null
    while the window is away (`useAway`): a thread left on screen and then
    walked away from has news too, and it is exactly the case "I sent it
    something and came back later" is about. */
export function useUnreadIds(
  sessions: readonly SessionMeta[],
  statuses: ReadonlyMap<string, string>,
  activeId: string | null
): ReadonlySet<string> {
  const { since, seen } = seenStore.use()
  return React.useMemo(() => {
    const out = new Set<string>()
    for (const session of sessions) {
      const at = activityAt(session)
      if (session.id !== activeId && statuses.get(session.id) === "idle" && at > Math.max(seen[session.id] ?? 0, since))
        out.add(session.id)
    }
    return out
  }, [sessions, statuses, activeId, since, seen])
}
