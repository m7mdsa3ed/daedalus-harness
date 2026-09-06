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
import { cacheNames, clientsClaim } from "workbox-core"
import {
  addPlugins,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  getCacheKeyForURL,
  precacheAndRoute,
} from "workbox-precaching"
import { NavigationRoute, registerRoute } from "workbox-routing"
import { notificationOptions } from "./lib/notification-shape"

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

const manifest = self.__WB_MANIFEST

/* ── Install progress ──
   A build is a whole precache, so installing a new worker is a download of a
   hundred-odd files — long enough on a phone that the page has to be able to
   say more than "working on it". Nothing in Workbox reports that, so it is
   counted here and posted to the page (lib/pwa.tsx draws the bar).

   Two counters, and the awkward one is the denominator. `done` is easy: the
   precache strategy writes each entry through `cachePut`, so `cacheDidUpdate`
   fires exactly once per file that actually came down. The TOTAL is not the
   manifest's length — an update re-fetches only the entries whose revision
   changed, which after a small deploy may be three files out of ninety — and
   Workbox only reports which those were once it has finished. So it is worked
   out here at install time: every manifest entry whose cache key is not
   already in the precache is one that has to be fetched.

   The install listener is registered BEFORE `precacheAndRoute` on purpose.
   Listeners run in registration order, so this one starts reading the cache's
   existing keys before Workbox's own handler starts writing new ones into it —
   otherwise the snapshot could count a file that had already landed as one
   that never needed fetching, and the total would come out under the count.
   It is still a race the page has to tolerate, which is why the bar clamps. */

let downloaded = 0
let outstanding = 0

function postProgress(): void {
  void self.clients
    .matchAll({ type: "window", includeUncontrolled: true })
    .then((clients) => {
      for (const client of clients) {
        client.postMessage({ type: "PRECACHE_PROGRESS", done: downloaded, total: outstanding })
      }
    })
    .catch(() => undefined)
}

self.addEventListener("install", (event) => {
  event.waitUntil(countOutstanding())
})

async function countOutstanding(): Promise<void> {
  try {
    const cache = await caches.open(cacheNames.precache)
    const held = new Set((await cache.keys()).map((request) => request.url))
    outstanding = manifest.filter((entry) => {
      const url = typeof entry === "string" ? entry : entry.url
      const key = getCacheKeyForURL(url)
      return !key || !held.has(new URL(key, self.location.href).href)
    }).length
  } catch {
    // No total is a spinner, not a wrong bar — the page falls back to it.
    outstanding = 0
  }
  postProgress()
}

addPlugins([
  {
    cacheDidUpdate: async () => {
      downloaded += 1
      postProgress()
    },
  },
])

precacheAndRoute(manifest)
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
    // `popout.html` is the empty room a popped-out dock panel is moved into
    // (client/public/popout.html): answering it with the shell would boot a
    // second copy of the whole app inside that window.
    denylist: [/^\/api\//, /^\/ws(\/|$)/, /^\/popout\.html$/],
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
  /** The ThreadEvent the server raised this for, when it said (see push.ts).
      Only used to decide whether the agent is blocked on an answer. */
  event?: string
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
    event: fields.event,
  }
}

/** The events the agent is blocked on — kept in step with ACTIONABLE in
    lib/notifications.ts, which is the other half of the same vocabulary. */
const BLOCKING_EVENTS = new Set(["permissionNeeded", "questionAsked", "turnFailed"])

self.addEventListener("push", (event) => {
  const { title, body, sessionId, event: kind } = readPushPayload(event.data)
  // A push that shows nothing is a "this site was updated in the background"
  // notice from the browser, so always show one — and `waitUntil` it, or the
  // worker can be killed before the notification is on screen.
  //
  // The options are lib/notification-shape's, shared with the in-page path:
  // the vibration, the stated `silent: false` and the `renotify` are what
  // decide whether Android peeks a banner over the lock screen or files the
  // line away silently, which is not something two copies should disagree on.
  event.waitUntil(
    self.registration.showNotification(
      title,
      notificationOptions({
        body,
        // Same thread, same kind of event: replace rather than stack.
        tag: sessionId ? `${sessionId}:${title}` : title,
        sessionId,
        actionable: kind ? BLOCKING_EVENTS.has(kind) : false,
      })
    )
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
