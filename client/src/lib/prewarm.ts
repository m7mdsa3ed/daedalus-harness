/* ── Warming a draft's agent, from this side ──
   A draft has no row and no process: the server is not told about it until the
   first message, so that message pays the whole cold start with the words
   already written and the button already pressed. `POST /api/prewarm` moves
   the spawn and the handshake behind the keystrokes instead
   (`docs/plans/prewarm.md`, `server/src/prewarm.ts`). **The draft still
   creates nothing**: no row, no journal, no prompt, no token.

   Nothing here may fail loudly or be waited on. A prewarm that did not happen
   sends exactly as it always did, and an abandoned one is the server's TTL and
   cap to bound — which is why every call in this file is fire and forget.

   The debounce lives here, at module scope, because it is a property of the
   draft rather than of a render: the composer remounts a draft's box on a tab
   switch, and a timer owned by a component would be cancelled with it. */
import { api, type ServerSettings } from "./settings"

/** How long the typing has to stop before a process is worth asking for. Long
    enough that a sentence is one spawn rather than one per keystroke, short
    enough that it is still behind the reader's own send. */
export const PREWARM_DEBOUNCE_MS = 400

const timers = new Map<string, ReturnType<typeof setTimeout>>()

/** Drop a queued ask. Every cancel path clears it first, so a keystroke's
    request cannot land after the DELETE that answered it. */
export function clearPrewarmTimer(id: string): void {
  const timer = timers.get(id)
  if (!timer) return
  clearTimeout(timer)
  timers.delete(id)
}

/** Ask once the typing stops. One pending ask per draft id: a keystroke
    replaces the last one, so a paragraph costs one process and not forty. */
export function schedulePrewarm(id: string, fire: () => void): void {
  clearPrewarmTimer(id)
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id)
      fire()
    }, PREWARM_DEBOUNCE_MS)
  )
}

/** Forget this draft's warm process: the box was emptied, the tab closed, the
    draft deleted, or a pick made the process a different one. Best effort in
    every sense — a cancel may arrive for a process that was claimed, swept,
    evicted or never started, and none of those is anything to report. The TTL
    and the cap in `prewarm.ts` are the guarantee; this is promptness.

    A request already on the wire when this lands is not a problem either: a
    warm process is only ever handed to a thread whose spawn it still matches
    (`specKeyFor` / `claim`), so the worst a lost race costs is one spawn that
    nobody claims. */
export function cancelPrewarm(settings: ServerSettings, id: string): void {
  clearPrewarmTimer(id)
  void api<{ ok: boolean }>(settings, `/api/prewarm/${encodeURIComponent(id)}`, {
    method: "DELETE",
  }).catch(() => {
    /* A server from before the route answers 404, and a dropped connection
       answers nothing: both mean no process is holding the id. */
  })
}
