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
let lastChat: string | null = null
let routeless = false
let focusChat: ((id: string) => boolean) | null = null
let leave: (() => boolean) | null = null
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
  if (id) lastChat = id
  for (const listener of [...listeners]) listener()
}

/** Publish whether the panel in front has no route (a terminal, a web view,
    the board). The URL then still names the last chat or page, so the sidebar
    must not read it as the panel in front. */
export function setRouteless(value: boolean): void {
  if (routeless === value) return
  routeless = value
  for (const listener of [...listeners]) listener()
}

export function activeChatId(): string | null {
  return activeChat
}

/** The chat that was last in front, kept while a page covers it: where "Back to
    threads" returns when the page replaced nothing. */
export function lastActiveChatId(): string | null {
  return lastChat
}

/** Let sidebar rows focus an existing tab without depending on route changes. */
export function setChatFocusHandler(handler: ((id: string) => boolean) | null): void {
  focusChat = handler
}

export function focusOpenChat(id: string): boolean {
  return focusChat?.(id) ?? false
}

/** Send the page in front back to the route it replaced (see `cameFrom` in dock.tsx). */
export function setLeaveHandler(handler: (() => boolean) | null): void {
  leave = handler
}

export function leavePage(): boolean {
  return leave?.() ?? false
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The open threads, in tab order, for the sidebar's "Opened" tier. */
export function useOpenThreads(): readonly string[] {
  return React.useSyncExternalStore(subscribe, openThreadIds, openThreadIds)
}

/** True while a panel with no route is in front: the route is stale. */
export function useRouteless(): boolean {
  return React.useSyncExternalStore(subscribe, () => routeless, () => routeless)
}

/** The active chat id; null means a non-chat panel is in front. */
export function useActiveChat(): string | null {
  return React.useSyncExternalStore(subscribe, activeChatId, activeChatId)
}

/* ── A new tab, from outside the dock ──
   The sidebar and the pages are not inside the dock's tree, but a "+" next to a
   project starts a thread in a tab of its own. The dock registers the door.
   Without a dock (a popout, before ready) the path is just navigated to. */
let newTabHandler: ((path?: string) => void) | null = null

export function setNewTabHandler(handler: ((path?: string) => void) | null): void {
  newTabHandler = handler
}

/** Open a tab of its own on a route (the New tab page when none is given). */
export function openInNewTab(path?: string): boolean {
  if (!newTabHandler) return false
  newTabHandler(path)
  return true
}

/* ── A column beside the tab in front, from outside the dock ──
   The same bargain, for the other shape a row can ask for: a thread or a page
   standing *beside* what you are reading rather than in place of it. Only the
   dock can make a column, so the row asks through here (`openInItems`, which
   every sidebar menu draws its two "open" rows from) and a caller with no dock
   falls back to navigating, which is the only thing a popout can do. */
let besideHandler: ((path: string) => void) | null = null

export function setBesideHandler(handler: ((path: string) => void) | null): void {
  besideHandler = handler
}

/** Open a route in a column beside the strip in front. False when there is no dock. */
export function openBeside(path: string): boolean {
  if (!besideHandler) return false
  besideHandler(path)
  return true
}
