/* ── Thread event notifications ──
   One place that decides how to tell the user something happened on a thread
   they are not looking at: a turn finished, a turn failed, the agent wants
   permission. Two channels, layered by how far away the user is:

     - looking at the thread            → nothing (the transcript/dialog says it)
     - app open, elsewhere              → in-app toast with an Open action
     - window hidden                    → system notification too (if granted)
     - no client attached at all        → the SERVER sends FCM push (push.ts on
                                          the server; this module is not involved)

   Preferences are device-local (localStorage), same pattern as view-options —
   what interrupts you on this device is not the server's business. */
import { useSyncExternalStore } from "react"
import { toast } from "sonner"
import { currentThreadId, navigateTo, threadPath } from "./router"

export type ThreadEvent = "turnFinished" | "turnFailed" | "permissionNeeded" | "questionAsked"

export interface NotificationPrefs {
  /** The agent finished answering. */
  turnFinished: boolean
  /** The prompt failed — agent error, crash, unreachable endpoint. */
  turnFailed: boolean
  /** The agent is waiting on a permission answer. */
  permissionNeeded: boolean
  /** The agent asked a question (AskUserQuestion / elicitation form). */
  questionAsked: boolean
  /** Also raise an OS notification when the window is hidden or unfocused. */
  system: boolean
}

export const NOTIFICATION_DEFAULTS: NotificationPrefs = {
  turnFinished: true,
  turnFailed: true,
  permissionNeeded: true,
  questionAsked: true,
  system: true,
}

const EVENT_LABELS: Record<ThreadEvent, string> = {
  turnFinished: "Turn finished",
  turnFailed: "Turn failed",
  permissionNeeded: "Permission needed",
  questionAsked: "The agent has a question",
}

const STORAGE_KEY = "ui.notifications"

function read(): NotificationPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as unknown
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...NOTIFICATION_DEFAULTS, ...(raw as Partial<NotificationPrefs>) }
      : { ...NOTIFICATION_DEFAULTS }
  } catch {
    return { ...NOTIFICATION_DEFAULTS }
  }
}

let cache = read()
const listeners = new Set<() => void>()

export function setNotificationPref<K extends keyof NotificationPrefs>(
  key: K,
  value: NotificationPrefs[K]
): void {
  cache = { ...cache, [key]: value }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  } catch {
    // A forgotten preference is not worth throwing out of a click handler.
  }
  for (const listener of listeners) listener()
}

export function useNotificationPrefs(): NotificationPrefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => cache,
    () => cache
  )
}

/** Ask the browser for OS-notification permission; true when granted. Called
    from a click — the thread alert or the settings toggle — never unprompted:
    browsers downgrade prompts that don't come from a gesture. */
export async function requestSystemNotifications(): Promise<boolean> {
  if (!("Notification" in window)) return false
  if (Notification.permission === "granted") return true
  if (Notification.permission === "denied") return false
  const granted = (await Notification.requestPermission()) === "granted"
  refreshNotificationOffer()
  return granted
}

/* ── The enable-notifications offer ──
   Whether the app should still be ASKING for permission: the browser has never
   been asked (permission is "default") and the user hasn't waved the offer
   away. Rendered as an alert above the composer (components/notification-alert)
   and re-checked whenever permission or the dismissal changes. */

const OFFER_DISMISSED_KEY = "ui.notifications.offerDismissed"

function computeOffer(): boolean {
  if (!("Notification" in window)) return false
  if (Notification.permission !== "default") return false
  try {
    return localStorage.getItem(OFFER_DISMISSED_KEY) === null
  } catch {
    return true
  }
}

let offerCache = computeOffer()
const offerListeners = new Set<() => void>()

/** Recompute after anything that can change the answer (a permission prompt
    settled, the dismissal was stored). */
export function refreshNotificationOffer(): void {
  const next = computeOffer()
  if (next === offerCache) return
  offerCache = next
  for (const listener of offerListeners) listener()
}

export function dismissNotificationOffer(): void {
  try {
    localStorage.setItem(OFFER_DISMISSED_KEY, "1")
  } catch {
    // Worst case the offer shows again next load.
  }
  refreshNotificationOffer()
}

export function useNotificationOffer(): boolean {
  return useSyncExternalStore(
    (listener) => {
      offerListeners.add(listener)
      return () => {
        offerListeners.delete(listener)
      }
    },
    () => offerCache,
    () => offerCache
  )
}

/** The user is looking at this thread right now — telling them is noise. */
function isViewing(sessionId: string): boolean {
  return (
    currentThreadId() === sessionId &&
    document.visibilityState === "visible" &&
    document.hasFocus()
  )
}

/**
 * Surface a thread event. `title` is the thread's title (the "where"); `detail`
 * is the event's own line — an error message, a tool wanting permission.
 */
export function notifyThreadEvent(
  event: ThreadEvent,
  sessionId: string,
  title: string,
  detail?: string
): void {
  if (!cache[event]) return
  if (isViewing(sessionId)) return

  const label = EVENT_LABELS[event]
  const body = [title, detail].filter(Boolean).join(" — ")
  const open = () => navigateTo(threadPath(sessionId))

  const show = event === "turnFailed" ? toast.error : toast
  show(label, {
    description: body,
    duration: 8000,
    action: { label: "Open", onClick: open },
  })

  // The toast can't be seen from another window or a minimized app; an OS
  // notification can. `tag` collapses repeats for the same thread+event.
  if (
    cache.system &&
    (document.visibilityState === "hidden" || !document.hasFocus()) &&
    "Notification" in window &&
    Notification.permission === "granted"
  ) {
    try {
      const notification = new Notification(label, { body, tag: `${sessionId}:${event}` })
      notification.onclick = () => {
        window.focus()
        open()
        notification.close()
      }
    } catch {
      // Some platforms (Android Chrome) only allow notifications via a service
      // worker registration — there FCM already covers the detached case.
    }
  }
}
