/* ── Scrolling a transcript you are not inside ──
   A reading in the right panel (Agents, Changes) and the palette's in-thread
   search jump the transcript. Several transcripts can be mounted at once (every
   open thread tab keeps its own), so each has a ref of its own, by session id:
   the one `ThreadView`'s `PublishJump` writes into, and the one a reading for
   that thread reads. */
import type { MutableRefObject } from "react"

import type { ThreadJumpTarget } from "@/lib/inspector"

export type ThreadJump = (id?: string, turn?: ThreadJumpTarget) => void

const refs = new Map<string, MutableRefObject<ThreadJump | null>>()

export function jumpRefFor(sessionId: string): MutableRefObject<ThreadJump | null> {
  let ref = refs.get(sessionId)
  if (!ref) {
    ref = { current: null }
    refs.set(sessionId, ref)
  }
  return ref
}
