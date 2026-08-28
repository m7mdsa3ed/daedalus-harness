/// <reference lib="webworker" />
/**
 * The one service worker. It does two jobs, and deliberately shares nothing
 * with Firebase to do the second:
 *
 *   1. Precache the built app and serve the SPA shell offline (Workbox).
 *   2. Turn a push into a notification, and a click on it into the thread.
 *
 * Why no `firebase/messaging/sw` here. A worker is not a process that stays
 * up: the browser kills it when idle and restarts it for each event, so only
 * TOP-LEVEL code is guaranteed to have run when a push arrives. FCM's SW SDK
 * has to be initialised with a config, and this client has no build-time
 * config — it fetches one from the server at runtime — so any handing-over
 * (postMessage, IndexedDB) races the restart and loses. FCM on the web is
 * plain Web Push underneath: the payload lands on the standard `push` event
 * below, which needs no config at all. The page still uses the Firebase SDK to
 * mint a token (lib/push.ts) — that part has a config, because it fetched it.
 */
import { clientsClaim } from "workbox-core"
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching"
import { NavigationRoute, registerRoute } from "workbox-routing"

declare let self: ServiceWorkerGlobalScope

// `registerType: "prompt"`: a new worker installs and then WAITS. Taking over
// on its own would swap the precache under a page whose JS is already running —
// a lazy chunk requested afterwards is a hash that no longer exists — and it
// would do it in the middle of whatever turn the user was watching. So the
// hand-over is the user's call: lib/pwa.ts offers it, and this is the message
// its "Reload" sends (the name is workbox-window's).
self.addEventListener("message", (event) => {
  if ((event.data as { type?: string } | undefined)?.type === "SKIP_WAITING") self.skipWaiting()
})
// First install still claims the page, so the app works offline on the visit
// that installed it rather than the one after.
clientsClaim()

precacheAndRoute(self.__WB_MANIFEST)
// Drop precaches written by earlier Workbox revisions; without this an upgrade
// leaves the old app's assets on disk forever.
cleanupOutdatedCaches()

// Client-side routes (/t/:id) are not files, so every navigation is answered
// with the precached shell. Precache entries are keyed by revision, so this
// must go through `createHandlerBoundToURL` — `caches.match("/index.html")`
// misses. In dev the shell is not precached at all, hence the allowlist.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("index.html"), {
    allowlist: import.meta.env.DEV ? [/^\/$/] : undefined,
    // The API and the thread socket live on another origin in the usual setup,
    // but a same-origin deployment must not have its API swallowed by the shell.
    denylist: [/^\/api\//, /^\/ws(\/|$)/],
  })
)

/* ── Push ──
   The server sends data-only messages (server/src/push.ts): `data` carries the
   title, body and the thread the event belongs to. Anything else that arrives
   — a notification-payload message from the Firebase console, say — is read
   too, so debugging by hand still shows something. */

interface PushPayload {
  title: string
  body: string
  sessionId?: string
}

function readPushPayload(data: PushMessageData | null): PushPayload {
  const fallback: PushPayload = { title: "Daedalus", body: "" }
  if (!data) return fallback
  let raw: unknown
  try {
    raw = data.json()
  } catch {
    // Not JSON: whatever it is, it is more informative than an empty body.
    return { ...fallback, body: data.text() }
  }
  if (!raw || typeof raw !== "object") return fallback
  const envelope = raw as {
    data?: Record<string, string>
    notification?: { title?: string; body?: string }
  }
  const fields = envelope.data ?? {}
  return {
    title: fields.title ?? envelope.notification?.title ?? fallback.title,
    body: fields.body ?? envelope.notification?.body ?? fallback.body,
    sessionId: fields.sessionId,
  }
}

self.addEventListener("push", (event) => {
  const { title, body, sessionId } = readPushPayload(event.data)
  // A push that shows nothing is a "this site was updated in the background"
  // notice from the browser, so always show one — and `waitUntil` it, or the
  // worker can be killed before the notification is on screen.
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // Same thread, same kind of event: replace rather than stack, matching
      // what lib/notifications.ts does for the in-app ones. `renotify` is what
      // makes the replacement announce itself — silently swapping the text of a
      // notification nobody is looking at is the same as not sending one.
      tag: sessionId ? `${sessionId}:${title}` : title,
      renotify: true,
      data: { sessionId },
    })
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const { sessionId } = (event.notification.data ?? {}) as { sessionId?: string }
  // One route per thread — see client/src/lib/router.ts.
  const url = new URL(sessionId ? `/t/${encodeURIComponent(sessionId)}` : "/", self.location.origin)
  event.waitUntil(focusOrOpen(url.href))
})

/** Prefer a window that is already open: focus it, and steer it to the thread
    if it is somewhere else. Opening a second one loses the user's place. */
async function focusOrOpen(href: string): Promise<void> {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
  const sameOrigin = clients.filter((client) => new URL(client.url).origin === self.location.origin)
  const exact = sameOrigin.find((client) => client.url === href)
  const target = exact ?? sameOrigin[0]
  if (exact) {
    await exact.focus()
    return
  }
  if (target) {
    await target.focus()
    // `navigate` rejects on a client this worker does not control — which
    // `includeUncontrolled` above deliberately lets through. Swallowing that
    // left a focused window sitting on the wrong thread, so a failure falls
    // through to opening the right one rather than pretending it arrived.
    if (await target.navigate(href).then(() => true, () => false)) return
  }
  await self.clients.openWindow(href)
}

export {}
