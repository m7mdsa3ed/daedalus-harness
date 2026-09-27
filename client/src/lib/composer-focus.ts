import { useSyncExternalStore } from "react"

const requests = new Map<string, number>()
const listeners = new Set<() => void>()
let revision = 0

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function notify() {
  for (const listener of listeners) listener()
}

export function requestComposerFocus(sessionId: string): void {
  requests.set(sessionId, ++revision)
  notify()
}

export function useComposerFocusRequest(sessionId: string): number {
  return useSyncExternalStore(
    subscribe,
    () => requests.get(sessionId) ?? 0,
    () => 0
  )
}

export function consumeComposerFocusRequest(sessionId: string, request: number): void {
  if (request !== 0 && requests.get(sessionId) === request) {
    requests.delete(sessionId)
    notify()
  }
}
