/* ── Which thread this device is in a voice call with ──
   Device-local and in memory: one microphone, so one call, and a reload ends it
   (the realtime session dies with the page anyway), and so does the thread
   going away (`useVoiceCallLifetime`). The composer's button
   starts and ends it; the thread's foot draws the call while it is this one. */
import * as React from "react"

import { toast } from "@/lib/toast"

let active: string | null = null
const listeners = new Set<() => void>()

const set = (next: string | null) => {
  if (active === next) return
  active = next
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Start a call with this thread, ending any other — one mic, one call. */
export const startVoiceCall = (sessionId: string) => set(sessionId)

/** End the call, or only this thread's when one is named. */
export const endVoiceCall = (sessionId?: string) => {
  if (!sessionId || active === sessionId) set(null)
}

/** The call card's word for a call that dropped without being asked to: it
    ends it, and says so, because the card vanishing is otherwise the only sign. */
export const voiceCallLost = (sessionId: string, reason?: string) => {
  if (active !== sessionId) return
  set(null)
  toast.error("Voice call ended", { description: reason })
}

/* Views mounted per thread. A thread may stand in several tabs (and a hidden
   one is `display: none`, still mounted), so the call outlives any one view and
   ends only with the last. */
const views = new Map<string, number>()

/** Tie a call to its thread: ends it when the last mounted view of the thread
    goes, or when the thread is trashed or removed (`gone`). */
export const useVoiceCallLifetime = (sessionId: string, gone: boolean) => {
  React.useEffect(() => {
    views.set(sessionId, (views.get(sessionId) ?? 0) + 1)
    return () => {
      const left = (views.get(sessionId) ?? 1) - 1
      if (left > 0) return void views.set(sessionId, left)
      views.delete(sessionId)
      endVoiceCall(sessionId)
    }
  }, [sessionId])
  React.useEffect(() => {
    if (gone) endVoiceCall(sessionId)
  }, [sessionId, gone])
}

export const useVoiceCallActive = (sessionId: string): boolean =>
  React.useSyncExternalStore(subscribe, () => active === sessionId)
