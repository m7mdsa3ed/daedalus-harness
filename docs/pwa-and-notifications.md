# PWA, service worker & notifications

_Extracted from CLAUDE.md; the rationale behind the rules summarised there._

## One service worker, no Firebase inside it

- **One service worker, and no Firebase inside it.** `client/src/sw.ts` is the whole
  PWA: Workbox precache, an SPA navigation route bound to the precached shell, and the
  `push`/`notificationclick` handlers. vite-plugin-pwa builds it (`strategies:
  "injectManifest"`) and `lib/pwa.tsx` registers it through `virtual:pwa-register` —
  which is the only thing that knows the worker is `/dev-sw.js?dev-sw` as a module in
  dev and a classic `/sw.js` in a build. Updates are `registerType: "prompt"`, not
  auto: a new worker installs and waits, and `registerPwa` offers it as one pinned
  toast (fixed id, so an hourly re-check replaces rather than stacks) whose
  Reload calls `updateSW(true)` — the worker only `skipWaiting()`s on that message.
  **That one toast has three faces**, because a build is a whole precache and the
  install is a download, not an instant: `watchInstalling` (off `updatefound`, and off
  the worker already in flight when `onRegisteredSW` lands) puts a *loading* toast up
  while the new worker installs, `onNeedRefresh` replaces it in place with the
  Reload/Later offer, and Reload replaces it again with a loading toast while the
  handover and reload happen. Only when something already controls the page — on a
  first install there is no old version, nothing will be offered at the end of it, and
  the announcement would be a lie. A failed install (`redundant`) dismisses the toast
  rather than leaving a spinner turning against nothing.
  **The loading face carries a real bar, and the denominator is the hard half.**
  Nothing in Workbox reports install progress, so `sw.ts` counts it: `addPlugins`
  hangs a `cacheDidUpdate` on the default precache strategy, which fires exactly
  once per entry the install actually writes, and each one posts
  `{type: "PRECACHE_PROGRESS", done, total}` to every window client. The total is
  **not** the manifest's length — an update re-fetches only the entries whose
  revision changed, three files out of ninety after a small deploy, and Workbox
  only says which those were once it has finished — so an `install` listener
  registered *before* `precacheAndRoute` (listeners run in registration order, so
  it reads the cache's existing keys before Workbox starts writing new ones into
  it) diffs the manifest's cache keys, via the public `getCacheKeyForURL`, against
  what the precache already holds. It is still a race, so the page clamps `done`
  to the total; and until the count arrives — or if the cache read throws — there
  is no bar at all, because a spinner is how "not known yet" is said and a bar
  against a total of zero is a lie that jumps. Ticks go through `toast.update`,
  never a same-id `add`: an upsert re-creates a toast the user has closed and
  resets its timer, and a progress readout must not argue with a dismissal.
  Silently taking over would swap the precache under a page whose JS is already
  running, so a lazy chunk it asks for next is a hash that no longer exists, and it
  would reload the tab mid-turn. Reloading is cheap on purpose — drafts are in
  localStorage and the turn is the server's — but it is still the user's call. The reason FCM's SDK
  is *not* in the worker is the worker's lifecycle: the browser kills it when idle and
  restarts it per event, so only top-level code is guaranteed to have run when a push
  lands — and this client has no build-time config, so a config handed over at runtime
  (postMessage, IndexedDB) races that restart and loses. FCM on the web is Web Push
  underneath, so the worker reads the raw `push` event and needs no config at all.
  The page still uses the SDK, to mint a token — and `getToken` must be passed
  `serviceWorkerRegistration`, or it goes and registers a `firebase-messaging-sw.js`
  this app does not ship — and the app it *is* passed is a **named** app per Firebase
  project, never `getApp()`: several servers can be connected at once, each with its own
  FCM project, and the default app is whichever was reached first, so a token minted
  through it carries the wrong sender id and fails silently in both directions.
  `registerPwa` unregisters the retired `firebase-messaging-sw.js`, and does it
  **before** registering, not alongside: a registration is keyed `(origin, scope)` and
  the old worker held the same `/` that `/sw.js` claims, so they are one object — racing
  the two tears down the worker that just replaced it. **The payload is therefore a
  contract, not a convention**: `server/src/push.ts` sends **data-only** messages
  carrying `title`/`body`/`sessionId`, because a `notification` block is displayed by
  whatever FCM code is in a worker and a device with the retired one still installed
  would show two. It also sends them in batches of 500 (FCM rejects a larger multicast
  outright, so one extra device would cost *everyone* the notification) with a one-hour
  `TTL` and a `Topic` — the FNV hash of title+session, because the header caps at 32
  URL-safe characters and a truncated UUID would collide, which here means a dropped
  notification. Both exist for the phone that was off overnight: the push service keeps
  only the newest message per topic, so coming back means the state of each thread
  rather than a night of history, and nothing arrives about a turn already read.

## Unregistering push

- **Registering for push is reversible, and the reverse has to reach the server.**
  A token outlives the preference and the connection: turning off "System notifications"
  or forgetting a server leaves that server pushing to the device with nothing left in
  the UI to stop it. So `lib/push.ts` pairs `setupPush` with `teardownPush` — `DELETE
  /api/push/register` plus `deleteToken`, skipping the latter when another connected
  server shows the *same* cached token, since a token belongs to the Firebase project
  and revoking it would unsubscribe that server too. The client's "already registered"
  cache is `{token, at}` and re-POSTs weekly, because the server drops rows FCM reports
  dead while `getToken` keeps returning the same string — an unexpiring cache is a
  device that goes dark permanently and says nothing.

## `new Notification()` gaps

- **`new Notification()` is not available everywhere, and push does not cover the gap.**
  Chrome on Android forbids the constructor outright (worker-only), and the server pushes
  *only* while `peers.size === 0` — so the in-page path in `lib/notifications.ts`, which
  fires for a socket still attached from a window nobody is watching, is exactly the case
  push will never reach. It falls back to `registration.showNotification`, whose click the
  worker already routes on `data.sessionId`.
  **Both paths build their options in one place** (`lib/notification-shape.ts`, imported
  by `lib/notifications.ts` and by `sw.ts`), because on Android these are not cosmetic:
  `renotify` with a `tag` is what makes a *replacement* alert rather than swap the text
  in silence (a second permission ask otherwise goes unnoticed); `vibrate` plus a stated
  `silent: false` is the only lever a web caller has on whether Chrome peeks a heads-up
  banner over the lock screen or files the line away quietly; and `requireInteraction`
  keeps the ones the agent is blocked on up (honoured on the desktop, a correct no-op on
  Android). `renotify`, `vibrate` and `timestamp` are all declared in `vite-env.d.ts` —
  spec'd, shipping, and absent from TS's DOM lib. Whether a notification is *blocking* is
  the server's to say, so `push.send` carries the `ThreadEvent` in `data.event` and the
  worker reads it. What none of it buys, because it is not ours: Android 13+ withholds
  `POST_NOTIFICATIONS` from the installed PWA independently of the site permission, and a
  channel the user has silenced stays silenced.
  **In the desktop shell the OS layer is not the web API at all.** Electron answers both
  permission handlers, and that is still not enough — Chromium hands the notification to
  the OS, which drops it unless the binary is attributable to an installed app (Windows)
  or a notification daemon is reachable (Linux), and both failures are silent: the
  constructor succeeds and nothing is drawn. So `electron/main.cjs` raises Electron's own
  `Notification` over an IPC handler, preload exposes it as `desktop.notify` /
  `desktop.onNotificationClick` (the click focuses the window and tells the renderer
  which thread, which `installDesktopNotifications` routes), and `raiseSystemNotification`
  prefers it with **no permission check** — falling back to the web attempt only when the
  platform answers that it cannot show one at all. Which is also why
  `requestSystemNotifications` returns true there and the enable-notifications offer never
  shows: there is nothing to ask, and a browser-level "denied" must not switch off a
  channel that works regardless.

## Backgrounded pages

- **A backgrounded page is not a detached one, and only the page can say which it
  is.** The push above is raised for a turn ending on a thread nobody is watching,
  and an attached socket used to be the whole of that test — which on Android
  means the notification the PWA exists for is the one that never arrives. A
  backgrounded PWA keeps its socket open while its page is frozen, and the
  server's 30s heartbeat cannot tell: the browser answers a ping frame from its
  network stack whether or not the page is running (`index.ts` says so itself),
  so `peers.size` reports a watcher for a page that has stopped. Meanwhile the
  in-page `registration.showNotification` fallback above — the one written for
  exactly this platform — is code in a frozen page and does not run. Neither end
  can see the gap, so the page states it on the way into it: the answerless
  `background` command sets `Peer.background`, and the turn-end gate reads
  `watchers(session)` (peers not in the background) where it read `peers.size`.
  **Only that gate.** The fan-out, the idle sweep, the quota refresh and
  `attached`/`peerCount` all still count sockets, because a frozen peer is still
  sent everything — the browser hands it over when the page thaws — and a phone
  in a pocket must not have its thread retired under it. It is `freeze`/`resume`
  (Page Lifecycle) and deliberately **not** `visibilitychange`: a merely hidden
  page still runs the handler that raises its own notification, so claiming the
  background there would earn the user two of them, one from each end. The
  handler lives at module scope in `thread-socket.ts` and walks every live
  socket, since a freeze is a property of the page and not of a thread; a
  reconnect landing mid-freeze re-asserts it at `caught_up`. `resume` is the
  other half of the duplicate problem: everything journaled during the freeze is
  delivered in one go the moment the page comes back, the already-pushed
  `turn_ended` included, so `suppressSystemNotifications()` mutes the OS layer
  for five seconds while leaving the in-app toast — which is the right amount of
  saying "while you were away" to somebody now holding the phone. What this does
  not fix, because it is not ours: Android 13+ withholds `POST_NOTIFICATIONS`
  from the installed PWA independently of the site permission, and aggressive
  battery optimisation drops FCM delivery outright — both look identical to a
  bug from inside the app.
