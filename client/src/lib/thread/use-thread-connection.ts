import * as React from "react"

import { useStoreSelect, type State } from "../store"
import { currentRegistry } from "./registry"

/**
 * Everything about a thread that can change *whether or how it opens*, as one
 * string.
 *
 * This is the whole of the fix. The panel's open effect used to depend on the
 * row object, and `refreshSessions` replaces every row object on every poll — so
 * a list refresh re-fired an open for every mounted transcript, and an open
 * landing inside another open is two peers on one session, every message drawn
 * twice, and (when the second one lost the race) a `send` prompting into a
 * connection with no socket in it yet.
 *
 * A primitive rather than the row, because `useStoreSelect` compares with
 * `Object.is`: a string that has not changed does not wake the effect at all.
 * And only these fields, because only these are read by the guards in
 * `ThreadConnection.openNow`:
 *
 * - the row's existence (a route can resolve before the list lands),
 * - `draft` (nothing to connect to until the first message creates it),
 * - `deletedAt` (a refusal, and one worth saying in the thread),
 * - `exited` and whether there is an archive (read-only attach vs respawn),
 * - `projectId` (a thread whose project is gone cannot open at all).
 *
 * Notably *not* `cursor` itself, which moves on every streamed event, nor
 * `title`, `promptActive`, `peerCount` or `lastActivityAt`, which move
 * constantly and change nothing about how a thread is opened.
 */
function openKeyOf(state: State, sessionId: string): string {
  const meta = state.sessions.find((s) => s.id === sessionId)
  if (!meta) return "absent"
  if (meta.draft) return "draft"
  return [
    meta.deletedAt ? "trash" : "ok",
    meta.exited ? "exited" : "running",
    meta.cursor > 0 ? "archive" : "empty",
    meta.projectId,
  ].join(":")
}

/**
 * Hold this thread open for as long as the calling component is mounted.
 *
 * The entire dependency list is a session id and a decision key, so this fires
 * when the *answer* changes and never merely because the list was re-read. The
 * connection is the one thing that opens a thread — it owns the guards, its own
 * open chain, and the socket — and this is how a surface asks for one.
 *
 * Failures are deliberately swallowed here: `openFromStore` records them in the
 * thread itself, which is the surface the caller is already showing.
 */
export function useThreadConnection(sessionId: string): void {
  const key = useStoreSelect((state) => openKeyOf(state, sessionId))
  React.useEffect(() => {
    // Nothing to connect to: the list has not landed yet, or this is a draft
    // whose first message has still to bring it into existence. Either way the
    // key changes when that stops being true, and this runs again.
    if (key === "absent" || key === "draft") return
    const registry = currentRegistry()
    if (!registry) return
    void registry.for(sessionId).openFromStore()
  }, [sessionId, key])
}
