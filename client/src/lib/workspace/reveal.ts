/* "Open this file *at line 42*." — or at lines 42 to 58, which is the more
   useful of the two: a call that read a window or rewrote a block was about a
   span, and an editor that only drops a caret at its first line leaves the
   reader to work out where it ended. The span is highlighted; the caret still
   lands at its start.

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
  /** Last line of the span, 1-based and inclusive. Absent for a point. */
  endLine?: number
}

export interface RevealOptions {
  column?: number
  endLine?: number
}

const pending = new Map<string, Reveal>()
const listeners = new Set<() => void>()

const key = (projectId: string, path: string) => `${projectId}:${path}`

export function markReveal(
  projectId: string,
  path: string,
  line: number,
  options?: RevealOptions
): void {
  pending.set(key(projectId, path), {
    line,
    ...(options?.column ? { column: options.column } : {}),
    /* A one-line "span" is a point: highlighting a single line that the caret
       is already on says nothing the active-line tint does not. */
    ...(options?.endLine && options.endLine > line ? { endLine: options.endLine } : {}),
  })
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
