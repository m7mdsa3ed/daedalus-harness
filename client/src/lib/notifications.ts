/* ── Thread event notifications ──
   One place that decides how to tell the user something happened on a thread
   they are not looking at: a turn finished, a turn failed, the agent wants
   permission. Two channels, layered by how far away the user is:

     - looking at the thread            → nothing (the transcript/dialog says it)
     - app open, elsewhere              → an in-app toast (this module)
     - window hidden                    → system notification too (if granted)
     - no client attached at all        → the SERVER sends FCM push (push.ts on
                                          the server; this module is not involved)

   The in-app toast is the same normal toast the rest of the app raises (the
   "Moved to Trash" one) — bottom-trailing corner, not a header takeover: a
   notification should not displace the thread title you are reading.

   Preferences are device-local (localStorage), same pattern as view-options —
   what interrupts you on this device is not the server's business. */
import { toast } from "@/lib/toast"
import { useSyncExternalStore } from "react"
import { notificationOptions, type NotificationShape } from "./notification-shape"
import { pushRegistration } from "./pwa"
import { currentThreadId, navigateTo, threadPath } from "./router"
import { loadSettings } from "./settings"

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

/** The events the agent is BLOCKED on — they get an "Open" affordance, and the
    OS notification stays up until it is dealt with where the platform allows. */
const ACTIONABLE = new Set<ThreadEvent>(["permissionNeeded", "questionAsked", "turnFailed"])

/** Which tone carries which event: the tinted disc on the toast. Actionable
    kinds are "info" (the agent is waiting), a finished turn is a quiet
    success, a failure is the one that gets the alert colour. */
const EVENT_TOAST_TONE: Partial<Record<ThreadEvent, "success" | "info" | "error">> = {
  turnFinished: "success",
  turnFailed: "error",
  permissionNeeded: "info",
  questionAsked: "info",
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
    from a click — the settings toggle — never unprompted: browsers downgrade
    prompts that don't come from a gesture. */
export async function requestSystemNotifications(): Promise<boolean> {
  // The desktop shell raises its notifications from the main process, which no
  // web permission gates — so there is nothing to ask, and asking would let a
  // browser-level "denied" turn off a channel that works regardless.
  if (desktopNotify) return true
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
   away. It surfaces as a persistent toast, and is re-checked whenever
   permission or the dismissal changes. */

const OFFER_DISMISSED_KEY = "ui.notifications.offerDismissed"
const OFFER_TOAST_ID = "enable-notifications-offer"

function computeOffer(): boolean {
  // The desktop shell needs no permission and has none to ask for — its
  // notifications go through the main process (electron/main.cjs).
  if (desktopNotify) return false
  if (!("Notification" in window)) return false
  if (Notification.permission !== "default") return false
  try {
    return localStorage.getItem(OFFER_DISMISSED_KEY) === null
  } catch {
    return true
  }
}

/** The persistent toast that stands in for the old header offer. One fixed id
    so a refresh replaces rather than stacks; an action rides a click so
    setupPush stays gesture-gated. */
function showNotificationOffer(): void {
  toast("Turn on notifications?", {
    id: OFFER_TOAST_ID,
    description: "Get told when a turn finishes, fails or needs you — even in the background.",
    duration: Infinity,
    action: {
      label: "Enable",
      onClick: () => {
        void requestSystemNotifications().then((granted) => {
          // Whether granted, denied or settled, the offer's answer changed —
          // recompute so the toast either clears (denied) or hands the OS
          // notification layer over (granted).
          refreshNotificationOffer()
          if (!granted) return
          // Permission is the gate for both layers: now that it is open,
          // register this device for server push too (a no-op if FCM isn't
          // configured). Imported lazily to avoid a cycle with push.ts.
          void import("./push").then(({ setupPush }) => {
            const settings = loadSettings()
            if (settings) void setupPush(settings)
          })
        })
      },
    },
  })
}

/** Recompute the offer and apply it — the toast shows when the offer is live
    and dismisses when it is not. Single place the cache and the toast are
    reconciled from, so the two never disagree. */
function syncOffer(): void {
  const next = computeOffer()
  if (next) showNotificationOffer()
  else toast.dismiss(OFFER_TOAST_ID)
}

/** Recompute after anything that can change the answer (a permission prompt
    settled, the dismissal was stored). */
export function refreshNotificationOffer(): void {
  syncOffer()
}

export function dismissNotificationOffer(): void {
  try {
    localStorage.setItem(OFFER_DISMISSED_KEY, "1")
  } catch {
    // Worst case the offer shows again next load.
  }
  syncOffer()
}

/** Un-dismiss the offer and forget the answer, so the persistent toast can be
    looked at again. Only clears OUR dismissal — a browser permission already
    granted or denied is the browser's to reset, and the console tells you when
    that is what is hiding the row. */
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
        "the offer stays dismissed until the site's notification permission is set back to Ask in browser settings."
    )
  }
}

/* ── The desktop shell ──
   Electron's renderer *can* be granted the web Notification permission (main.cjs
   answers both permission handlers), and that is still not enough: Chromium
   hands the notification to the OS, and Windows drops it unless the running
   binary is attributable to an installed app, while Linux needs a notification
   daemon Chromium can reach. Both failures are silent — the constructor
   succeeds, `onshow` never fires and nothing is drawn. Electron's own
   `Notification` is the surface those platforms accept, so in the shell the OS
   layer is one IPC call and there is no permission gate on it at all.

   Resolves false when the platform genuinely cannot show one (no daemon), which
   falls back to the web API rather than swallowing the notice. */
const desktopNotify = typeof window !== "undefined" ? window.desktop?.notify : undefined

/** Route a click on a shell notification to its thread. Called once from
    main.tsx; the handler lives here because this is what decides where a
    notification points. */
export function installDesktopNotifications(): void {
  window.desktop?.onNotificationClick?.((sessionId) => {
    if (sessionId) openThread(sessionId)
  })
}

/* ── The resume window ──
   While the page is frozen the SERVER raises the notification (it is told the
   page cannot — see `setBackground` in thread-socket.ts). Everything that
   happened during the freeze is then delivered to the page in one go the
   moment it resumes, so without this the same finished turn would be announced
   a second time, by the OS, on a device the user has just picked up and is
   looking at. The in-app toast still goes out: it is the one that says "while
   you were away" without interrupting anything.

   A window rather than a per-event mark because the events carry nothing to
   match a push against, and the only thing the two have in common is that they
   are about the same handful of seconds. */
const RESUME_QUIET_MS = 5_000
let systemQuietUntil = 0

export function suppressSystemNotifications(ms: number = RESUME_QUIET_MS): void {
  systemQuietUntil = Date.now() + ms
}

/** The user is looking at this thread right now — telling them is noise. */
function isViewing(sessionId: string): boolean {
  return (
    currentThreadId() === sessionId &&
    document.visibilityState === "visible" &&
    document.hasFocus()
  )
}

/** Open the thread a notice is about. */
function openThread(sessionId: string): void {
  navigateTo(threadPath(sessionId))
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
     that decide WHETHER to interrupt, so the toast and the OS notification
     can be looked at from the thread you are already on. Nothing about how they
     render changes — it is the same call the real events make. */
  force = false
): void {
  if (!force && !cache[event]) return
  if (!force && isViewing(sessionId)) return

  const label = EVENT_LABELS[event]
  const body = [title, detail].filter(Boolean).join(" — ")

  /* In-app, a normal toast. The actionable events — the ones that are
     waiting on the user — carry an "Open" affordance; a turn that merely
     finished needs no button. The tone says the kind (the tinted disc on the
     card's leading edge), the same language the inbox rows speak. */
  const actionable = ACTIONABLE.has(event)
  const toastOpts: Parameters<typeof toast>[1] = {
    description: body,
    ...(actionable
      ? { action: { label: "Open", onClick: () => openThread(sessionId) } }
      : {}),
  }
  const tone = EVENT_TOAST_TONE[event]
  if (tone === "error") toast.error(label, toastOpts)
  else if (tone === "success") toast.success(label, toastOpts)
  else if (tone === "info") toast.info(label, toastOpts)
  else toast(label, toastOpts)

  // The toast can't be seen from another window or a minimized app; an OS
  // notification can. `tag` collapses repeats for the same thread+event.
  const wanted = force || (cache.system && (document.visibilityState === "hidden" || !document.hasFocus()))
  const quiet = !force && Date.now() < systemQuietUntil
  if (wanted && !quiet) raiseSystemNotification(event, sessionId, label, body)
}

/** The OS layer: the desktop shell's native notification, else the web one.
    Split out of `notifyThreadEvent` because it is three fallbacks deep and none
    of them is about whether to interrupt — only about which surface can. */
function raiseSystemNotification(
  event: ThreadEvent,
  sessionId: string,
  label: string,
  body: string
): void {
  const tag = `${sessionId}:${event}`
  const actionable = ACTIONABLE.has(event)

  /* The desktop shell first, and with no permission check: it has no web
     permission worth consulting (main.cjs grants it) and the web API is the one
     that silently draws nothing there. `false` means the platform cannot show
     one at all, which falls through to the web attempt rather than swallowing
     the notice. */
  if (desktopNotify) {
    void desktopNotify({ title: label, body, sessionId }).then(
      (shown) => {
        if (!shown) showWebNotification(label, { body, tag, sessionId, actionable }, sessionId)
      },
      () => showWebNotification(label, { body, tag, sessionId, actionable }, sessionId)
    )
    return
  }
  showWebNotification(label, { body, tag, sessionId, actionable }, sessionId)
}

function showWebNotification(
  label: string,
  shape: NotificationShape,
  sessionId: string
): void {
  if (!("Notification" in window) || Notification.permission !== "granted") return
  const options = notificationOptions(shape)
  try {
    // `renotify` with a `tag`, exactly as the worker path does: a replacement
    // that swaps the text in silence is, for a second permission ask on the
    // same thread, the same as no notification at all.
    const notification = new Notification(label, options)
    notification.onclick = () => {
      window.focus()
      openThread(sessionId)
      notification.close()
    }
  } catch {
    /* Chrome on Android forbids the constructor outright ("Illegal
       constructor. Use ServiceWorkerRegistration.showNotification()") — and
       push does NOT cover this case, whatever it may look like: the server
       only pushes while `peers.size === 0`, and this branch is the opposite,
       a socket still attached from a window nobody is looking at. Left to
       throw, the platform the PWA exists for is the one that gets silence.
       The worker's `notificationclick` handler routes on `data.sessionId`,
       so the click lands on the same thread this window would have opened. */
    void pushRegistration().then((registration) => registration?.showNotification(label, options))
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
     daedalus.notify("questionAsked", { system: false })   // toast only
     daedalus.notifyAll()               // one of each, spaced out
     daedalus.resetNotificationOffer()  // bring back the enable toast

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
    // The toast alone: same call with the OS layer left to its normal rules,
    // which a focused window fails.
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
  }
  window.daedalus = { ...window.daedalus, ...api }
}

declare global {
  interface Window {
    daedalus?: Record<string, unknown>
  }
}
