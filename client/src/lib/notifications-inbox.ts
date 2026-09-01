import { createStore } from "./local-store"
import { api, loadSettings, type ServerSettings } from "./settings"
import { navigateTo, threadPath } from "./router"

/* ── The notification inbox (server-side) ──
   The server records the four thread events it also pushes (notifications.ts):
   a turn finished, a turn failed, the agent wants permission, the agent asked a
   question. This store is the pill's read of that inbox — the list plus the
   unread count the badge shows. Unlike pins/drafts it is NOT device-local: the
   server is the source of what happened, on every device, and "read" is "has
   anybody looked" (see the server module's comment on why the flag is shared).

   It fetches lazily — the badge on mount, and everything again when the pill is
   opened. There is deliberately no tight poll: a not-yet-noticed event still
   arrives the next time the user looks at the inbox or returns to the window,
   and a notification is not the kind of number the sidebar should be asking
   after on a timer. */

export type NotificationKind = "permission" | "question" | "turn_finished" | "turn_failed"

export interface AppNotification {
  id: string
  kind: NotificationKind
  sessionId: string | null
  threadTitle: string | null
  body: string | null
  read: boolean
  createdAt: number
}

interface InboxState {
  items: AppNotification[]
  unread: number
  /** Never populated with an error; a failed fetch leaves this false. */
  loaded: boolean
}

const store = createStore<InboxState>({ items: [], unread: 0, loaded: false })

const publish = store.set

export const inboxSnapshot = store.get

/** The inbox, live — the pill's badge and list read the same store. */
export const useNotifications = store.use

const parse = (data: { items: AppNotification[]; unread: number }): InboxState => ({
  items: data.items,
  unread: data.unread,
  loaded: true,
})

async function fetchInbox(settings: ServerSettings): Promise<void> {
  try {
    const data = await api<{ items: AppNotification[]; unread: number }>(settings, "/api/notifications")
    publish(parse(data))
  } catch {
    // A failed fetch is an empty pill, never an error row — the inbox is
    // secondary, and the global error net does not need to know about it.
  }
}

export function refreshNotifications(): void {
  const settings = loadSettings()
  if (settings) void fetchInbox(settings)
}

/* The app stays open for days (a PWA), and a notification recorded while it was
   hidden should be there when the user comes back. Refreshing on return to the
   window keeps the badge current without a poll — the one question this store
   needs answered is small, and it is asked only when somebody is looking. */
if (typeof window !== "undefined") {
  for (const event of ["focus", "visibilitychange"] as const) {
    window.addEventListener(event, () => {
      if (event === "visibilitychange" ? document.visibilityState === "visible" : document.hasFocus()) {
        refreshNotifications()
      }
    })
  }
}

/** Mark one notification (or all, when `id` is omitted) read, then republish
    with the server's authoritative count. */
export async function markNotificationRead(id?: string): Promise<void> {
  const settings = loadSettings()
  if (!settings) return
  try {
    const result = await api<{ unread: number }>(settings, "/api/notifications/read", {
      method: "POST",
      body: JSON.stringify(id ? { ids: [id] } : {}),
    })
    const state = store.get()
    publish({
      ...state,
      unread: result.unread,
      items: id
        ? state.items.map((n) => (n.id === id ? { ...n, read: true } : n))
        : state.items.map((n) => ({ ...n, read: true })),
    })
  } catch {
    // Swallow a failed acknowledgement; the server keeps the row and the badge
    // stays honest.
  }
}

/** Empty the whole inbox (explicit user gesture — see the server route). */
export async function clearNotificationsInbox(): Promise<void> {
  const settings = loadSettings()
  if (!settings) return
  try {
    await api(settings, "/api/notifications", { method: "DELETE" })
    publish({ items: [], unread: 0, loaded: true })
  } catch {
    // Same as above.
  }
}

/** Open the thread a notice is about, and mark it read on the way — reading a
    notification from the inbox is the acknowledgement. */
export function openNotification(n: AppNotification): void {
  if (n.sessionId) navigateTo(threadPath(n.sessionId))
  else refreshNotifications()
  if (!n.read) void markNotificationRead(n.id)
}
