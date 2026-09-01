/* ── The notification inbox (server-side) ──
   The server records the four thread events it also pushes (notifications.ts):
   a turn finished, a turn failed, the agent wants permission, the agent asked
   a question. This module is the wire half of that inbox — the reactive store
   that used to live beside it moved into the query cache
   (lib/queries/surfaces.ts, `useInbox`): the badge, the popover and the page
   read one cache whose freshness is refetch-on-focus, which is exactly the
   job the hand-rolled window listeners here used to do. */

import { api, type ServerSettings } from "./settings"

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

export interface InboxState {
  items: AppNotification[]
  unread: number
}

export const fetchInbox = (settings: ServerSettings, signal?: AbortSignal) =>
  api<InboxState>(settings, "/api/notifications", { signal })

/** Mark one notification (or all, when `id` is omitted) read; the server's
    answer carries the authoritative unread count. */
export const markRead = (settings: ServerSettings, id?: string) =>
  api<{ unread: number }>(settings, "/api/notifications/read", {
    method: "POST",
    body: JSON.stringify(id ? { ids: [id] } : {}),
  })

/** Empty the whole inbox (explicit user gesture — see the server route). */
export const clearInbox = (settings: ServerSettings) =>
  api(settings, "/api/notifications", { method: "DELETE" })
