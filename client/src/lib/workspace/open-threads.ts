/* ── The threads with a tab open ──
   The dock is the authority on which panels are open, but it renders in a
   subtree the sidebar is not inside (both are siblings under the app shell), so
   the sidebar cannot reach it through context. It reads this store instead,
   which the dock publishes into on every panel add, remove and move — the same
   module-store bargain `panel-status.ts` and `panel-pins.ts` make, and for the
   same reason: a surface outside the dock's tree has to hear what the dock
   knows.

   What is held is the *session ids of open chat panels, in the order they were
   opened*, and nothing else. Other kinds are panels, not threads, and are not
   listed. It is derived state, not storage: a reload rebuilds it from the
   restored layout through the same `onDidAddPanel` path, so there is no second
   copy of the dock to fall out of step with the first. */
import * as React from "react"

const EMPTY: readonly string[] = Object.freeze([])
let open: readonly string[] = EMPTY
let activeChat: string | null = null
let focusChat: ((id: string) => boolean) | null = null
const listeners = new Set<() => void>()

/** Replace the list. A no-op when it says the same thing — the dock calls this
    on every layout change, and a sash drag fires one per pointer frame. */
export function setOpenThreads(ids: readonly string[]): void {
  if (open.length === ids.length && open.every((id, index) => id === ids[index])) return
  open = Object.freeze([...ids])
  for (const listener of [...listeners]) listener()
}

export function openThreadIds(): readonly string[] {
  return open
}

/** Publish the chat tab in front, or null when another panel is active. */
export function setActiveChat(id: string | null): void {
  if (activeChat === id) return
  activeChat = id
  for (const listener of [...listeners]) listener()
}

export function activeChatId(): string | null {
  return activeChat
}

/** Let sidebar rows focus an existing tab without depending on route changes. */
export function setChatFocusHandler(handler: ((id: string) => boolean) | null): void {
  focusChat = handler
}

export function focusOpenChat(id: string): boolean {
  return focusChat?.(id) ?? false
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The open threads, in tab order, for the sidebar's "Opened" tier. */
export function useOpenThreads(): readonly string[] {
  return React.useSyncExternalStore(subscribe, openThreadIds, openThreadIds)
}

/** The active chat id; null means a non-chat panel is in front. */
export function useActiveChat(): string | null {
  return React.useSyncExternalStore(subscribe, activeChatId, activeChatId)
}

/* ── "Open this one in a new tab" ──
   A tab is an outlet: going somewhere navigates the tab in front. A modified
   click (⌘/Ctrl, or the middle button) on a sidebar row is the one gesture that
   asks for a tab of its own, and it cannot ride the URL — so it is said here,
   once, and spent by the next route effect that opens something. */
let newTabNext = false

export function openNextInNewTab(): void {
  newTabNext = true
}

export function consumeNewTab(): boolean {
  const asked = newTabNext
  newTabNext = false
  return asked
}

/** Whether a click asks for a tab of its own. */
export function asksForNewTab(event: { metaKey: boolean; ctrlKey: boolean; button?: number }): boolean {
  return event.metaKey || event.ctrlKey || event.button === 1
}
