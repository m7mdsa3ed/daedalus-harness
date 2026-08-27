/* ── Thread event notifications ──
   One place that decides how to tell the user something happened on a thread
   they are not looking at: a turn finished, a turn failed, the agent wants
   permission. Two channels, layered by how far away the user is:

     - looking at the thread            → nothing (the transcript/dialog says it)
     - app open, elsewhere              → the header becomes the notice
     - window hidden                    → system notification too (if granted)
     - no client attached at all        → the SERVER sends FCM push (push.ts on
                                          the server; this module is not involved)

   Preferences are device-local (localStorage), same pattern as view-options —
   what interrupts you on this device is not the server's business. */
import { useSyncExternalStore } from "react"
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

/** Un-dismiss the offer and forget the answer, so the header row that asks for
    permission can be looked at again. Only clears OUR dismissal — a browser
    permission already granted or denied is the browser's to reset, and the
    console tells you when that is what is hiding the row. */
export function resetNotificationOffer(): void {
  try {
    localStorage.removeItem(OFFER_DISMISSED_KEY)
  } catch {
    // Nothing to undo if it could not be stored in the first place.
  }
  refreshNotificationOffer()
  if ("Notification" in window && Notification.permission !== "default") {
    console.info(
      `[daedalus] Offer reset, but Notification.permission is "${Notification.permission}" — ` +
        "the row stays hidden until the site's notification permission is set back to Ask in browser settings."
    )
  }
}

/* ── The header notice ──
   One slot, not a queue: two events land a second apart and the second is the
   one worth reading, so a new notice replaces the one on screen rather than
   waiting behind it. It expires on its own — a notification you have to close
   is a chore — and the header goes back to being a title. */

export interface HeaderNotice {
  /** New identity per notice, so the row can re-animate when it is replaced. */
  id: number
  event: ThreadEvent
  label: string
  body: string
  sessionId: string
}

/** Long enough to read a thread title and an error line, short enough that the
    header is not a notification bar. Matches the old toast's duration. */
const NOTICE_MS = 8000

let noticeCache: HeaderNotice | null = null
let noticeSeq = 0
let noticeTimer: number | undefined
const noticeListeners = new Set<() => void>()

function emitNotice(): void {
  for (const listener of noticeListeners) listener()
}

export function pushHeaderNotice(notice: Omit<HeaderNotice, "id">): void {
  noticeCache = { ...notice, id: ++noticeSeq }
  window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(dismissHeaderNotice, NOTICE_MS)
  emitNotice()
}

export function dismissHeaderNotice(): void {
  window.clearTimeout(noticeTimer)
  noticeTimer = undefined
  if (noticeCache === null) return
  noticeCache = null
  emitNotice()
}

export function useHeaderNotice(): HeaderNotice | null {
  return useSyncExternalStore(
    (listener) => {
      noticeListeners.add(listener)
      return () => {
        noticeListeners.delete(listener)
      }
    },
    () => noticeCache,
    () => noticeCache
  )
}

/** Open the thread a notice is about, and clear it — the transcript is now
    saying what the header was standing in for. */
export function openHeaderNotice(notice: HeaderNotice): void {
  dismissHeaderNotice()
  navigateTo(threadPath(notice.sessionId))
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
  detail?: string,
  /* Testing only (see `installNotificationTestHelper`): skip the two checks
     that decide WHETHER to interrupt, so the header row and the OS notification
     can be looked at from the thread you are already on. Nothing about how they
     render changes — it is the same call the real events make. */
  force = false
): void {
  if (!force && !cache[event]) return
  if (!force && isViewing(sessionId)) return

  const label = EVENT_LABELS[event]
  const body = [title, detail].filter(Boolean).join(" — ")

  /* In-app, the header IS the notification. A toast floats over the transcript
     you are reading and takes a corner of the screen hostage; the header is one
     row that is always there, never scrolls, and is already saying which thread
     you are on — which is exactly what the notification is about. So the event
     borrows it, and the title comes back when the notice expires. */
  pushHeaderNotice({ event, label, body, sessionId })

  // The header can't be seen from another window or a minimized app; an OS
  // notification can. `tag` collapses repeats for the same thread+event.
  if (
    (force || (cache.system && (document.visibilityState === "hidden" || !document.hasFocus()))) &&
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

/* ── Test helper ──
   Notifications only fire on someone else's thread, from a window you are not
   looking at, after a permission prompt — which makes the UI they render hard
   to get on screen on purpose. `installNotificationTestHelper` puts a handle on
   `window.daedalus` so the console can raise each one directly:

     daedalus.notify()                  // turnFinished on the current thread
     daedalus.notify("turnFailed")      // any ThreadEvent, error styling and all
     daedalus.notify("permissionNeeded", { title: "Some thread", detail: "rm -rf" })
     daedalus.notify("questionAsked", { system: false })   // header row only
     daedalus.notifyAll()               // one of each, spaced out
     daedalus.resetNotificationOffer()  // bring back the header's enable row

   It forces past the "is the user already looking at this?" and preference
   checks — that is the whole point — so it is a way to SEE the UI, not a way to
   test the routing rules around it. Installed in every build: it is a handful
   of bytes on an object nobody calls, and the moment it is dev-only it stops
   being usable for the one thing anyone wants it for, which is checking how
   this looks on a real device. */

const TEST_DETAIL: Record<ThreadEvent, string> = {
  turnFinished: "Refactored the composer strip and ran the typechecker",
  turnFailed: "The agent's process exited before answering (code 1)",
  permissionNeeded: "Wants to run `rm -rf node_modules`",
  questionAsked: "Which package manager should this repo use?",
}

export function testThreadNotification(
  event: ThreadEvent = "turnFinished",
  options: { sessionId?: string; title?: string; detail?: string; system?: boolean } = {}
): void {
  const sessionId = options.sessionId ?? currentThreadId() ?? "test-thread"
  const detail = options.detail ?? TEST_DETAIL[event]
  const title = options.title ?? "Test thread"
  if (options.system === false) {
    // The header row alone: same call with the OS layer left to its normal
    // rules, which a focused window fails.
    const saved = cache.system
    cache = { ...cache, system: false }
    try {
      notifyThreadEvent(event, sessionId, title, detail, true)
    } finally {
      cache = { ...cache, system: saved }
    }
    return
  }
  notifyThreadEvent(event, sessionId, title, detail, true)
}

const ALL_EVENTS: ThreadEvent[] = [
  "turnFinished",
  "turnFailed",
  "permissionNeeded",
  "questionAsked",
]

export function installNotificationTestHelper(): void {
  const api = {
    notify: testThreadNotification,
    /** One of each, ~1.2s apart so the stack is readable rather than a pile. */
    notifyAll: (options?: Parameters<typeof testThreadNotification>[1]) => {
      ALL_EVENTS.forEach((event, index) =>
        window.setTimeout(() => testThreadNotification(event, options), index * 1200)
      )
    },
    events: ALL_EVENTS,
    prefs: () => ({ ...cache }),
    permission: () => ("Notification" in window ? Notification.permission : "unsupported"),
    requestSystemNotifications,
    resetNotificationOffer,
    dismissNotificationOffer,
    dismissHeaderNotice,
  }
  window.daedalus = { ...window.daedalus, ...api }
}

declare global {
  interface Window {
    daedalus?: Record<string, unknown>
  }
}
