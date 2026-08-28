/* "Open this file *at line 42*."

   A one-shot flag, the same shape as `session-tabs.ts`'s `markNewTab`, and for
   the same reason: the line is not part of the panel's identity. Putting it in
   the descriptor would make `editor:{project}:{path}` and the same file at a
   different line two different panels, so every diagnostic you clicked would
   open another tab of a file you already had open.

   So the caller marks, `openPanel` focuses the existing panel, and the editor
   consumes the mark — whether it just mounted or was already there. */
interface Reveal {
  line: number
  column?: number
}

const pending = new Map<string, Reveal>()
const listeners = new Set<() => void>()

const key = (projectId: string, path: string) => `${projectId}:${path}`

export function markReveal(projectId: string, path: string, line: number, column?: number): void {
  pending.set(key(projectId, path), { line, ...(column ? { column } : {}) })
  for (const listener of listeners) listener()
}

/** Takes the mark if there is one. Reading it clears it — a reveal happens
    once, not on every re-render of the panel that answered it. */
export function consumeReveal(projectId: string, path: string): Reveal | null {
  const id = key(projectId, path)
  const reveal = pending.get(id)
  if (!reveal) return null
  pending.delete(id)
  return reveal
}

/** Notified when a mark is set, so an already-open editor answers it too. */
export function onReveal(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
