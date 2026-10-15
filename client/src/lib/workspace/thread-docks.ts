/* ── Thread docks ──
   Every chat tab on a wide screen is a dock of its own (`workspace/thread-dock.tsx`):
   the transcript and the panels about that thread — its readings, its shell,
   its preview, its files — moved and resized inside the tab. This
   module is the part with no component in it: the door the app's openers use
   to reach the dock of the thread in front, and where each thread's
   arrangement is kept.

   **A closed world.** A thread dock's panels never cross into the outer dock
   or out of it — a shell rooted in this thread's worktree means nothing beside
   another thread. Dockview already refuses a drop from another instance
   (nothing accepts `onUnhandledDragOver`), so the rule costs no code. */
import type { SerializedDockview } from "dockview-react"

import { createLocalStore } from "@/lib/local-store"

export type ThreadPanelKind =
  | "transcript"
  | "changes"
  | "plan"
  | "agents"
  | "details"
  | "tokens"
  | "terminal"
  | "web"
  | "trajectory"

export interface ThreadDockHandle {
  /** Show the one there is (`reuse`) or open one — a fresh shell for a
      terminal, the only kind a thread holds more than one of. */
  open: (kind: ThreadPanelKind, reuse?: boolean) => void
  jump: (id?: string, turn?: { turnId: string; seq: number }) => void
}

const docks = new Map<string, ThreadDockHandle>()

export function registerThreadDock(sessionId: string, handle: ThreadDockHandle): () => void {
  docks.set(sessionId, handle)
  return () => {
    if (docks.get(sessionId) === handle) docks.delete(sessionId)
  }
}

/** The dock of this thread, if its tab is mounted wide. Null on a phone, where
    the readings are the transcript's sheet and a panel opens in the outer dock. */
export function threadDock(sessionId: string | null | undefined): ThreadDockHandle | undefined {
  return sessionId ? docks.get(sessionId) : undefined
}

/* ── Layouts ──
   Per thread. A thread nobody has arranged is its transcript alone — every
   other panel is asked for from the strip's +. Device-local: how a thread is
   laid out is the reader's, not the conversation's. */
interface ThreadLayouts {
  by: Record<string, SerializedDockview>
}

// ponytail: a save re-inserts its key, so the cap drops the thread arranged
// longest ago — never swept for deleted threads, which just age out.
const KEEP = 100

const layouts = createLocalStore<ThreadLayouts>(
  "daedalus.thread-dock.v1",
  (raw) => {
    const value = raw as Partial<ThreadLayouts> | null
    return value && typeof value.by === "object" && value.by
      ? { by: value.by }
      : { by: {} }
  },
  { by: {} }
)

export function threadLayout(sessionId: string): SerializedDockview | undefined {
  return layouts.get().by[sessionId]
}

export function saveThreadLayout(sessionId: string, layout: SerializedDockview): void {
  const { by } = layouts.get()
  const next = { ...by }
  delete next[sessionId]
  next[sessionId] = layout
  const keys = Object.keys(next)
  for (const key of keys.slice(0, Math.max(0, keys.length - KEEP))) delete next[key]
  layouts.set({ by: next })
}
