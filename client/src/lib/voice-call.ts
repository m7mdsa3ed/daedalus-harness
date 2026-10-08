/* ── Which thread this device is in a voice call with ──
   Device-local and in memory: one microphone, so one call, and a reload ends it
   (the realtime session dies with the page anyway). The composer's button
   starts and ends it; the thread's foot draws the call while it is this one. */
import * as React from "react"

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

export const useVoiceCallActive = (sessionId: string): boolean =>
  React.useSyncExternalStore(subscribe, () => active === sessionId)
