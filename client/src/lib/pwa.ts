/**
 * Service worker registration (offline shell + push notifications) and the
 * update offer.
 *
 * Registration goes through vite-plugin-pwa's `virtual:pwa-register` rather
 * than a hand-written `navigator.serviceWorker.register`: it is the one place
 * that knows the worker's URL and type in both modes (`/sw.js` classic in a
 * build, `/dev-sw.js?dev-sw` as a module under `pnpm dev`).
 *
 * The worker needs nothing from us at runtime: it holds no Firebase config
 * (see src/sw.ts for why), so there is no channel to keep open.
 */
import { toast } from "sonner"
import { registerSW } from "virtual:pwa-register"

/** A long-lived tab never navigates, so it would never notice a deploy — and
    with a prompt-mode worker, never offer the update either. An hour is often
    enough to pick one up in a day's use and cheap enough to be invisible: the
    check is one conditional request for sw.js. */
const UPDATE_INTERVAL_MS = 60 * 60 * 1000

/** How long to wait for a worker to become active before giving up on push. */
const READY_TIMEOUT_MS = 10_000

/** Workers this app used to install. A registration outlives the file it was
    made from, so a device that ran the Firebase-owned worker keeps receiving
    pushes through it — a second notification for every event — until it is
    explicitly unregistered. */
const RETIRED_WORKERS = ["firebase-messaging-sw.js"]

/**
 * Drop the registrations of workers this app no longer ships.
 *
 * **This must finish before `registerSW` runs.** A registration is keyed by
 * (origin, scope), and the retired worker was registered at `/` — the same
 * scope `/sw.js` claims — so the two are the *same registration object*:
 * registering swaps the script inside it rather than making a second one.
 * Racing the unregister against that means reading a `scriptURL` that is still
 * the old one and then tearing down the worker that just replaced it, leaving
 * the tab with no worker at all until the next load.
 *
 * Unregistering first is safe precisely because they share a scope: the
 * registration that follows re-creates what this removed. It does cost the
 * device's `PushSubscription`, but `setupPush` runs after this and mints a
 * fresh token, and the stale one is pruned server-side on the first send.
 */
async function unregisterRetiredWorkers(): Promise<void> {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations()
    await Promise.all(
      registrations
        .filter((registration) => {
          const url = registration.active?.scriptURL ?? registration.installing?.scriptURL ?? ""
          if (!url) return false
          const { pathname } = new URL(url, location.origin)
          return RETIRED_WORKERS.some((name) => pathname.endsWith(name))
        })
        .map((registration) => registration.unregister())
    )
  } catch {
    // Worst case the old worker stays and duplicates a notification.
  }
}

/* ── The update offer ──
   A new worker installs and waits; nothing changes until the page reloads. So
   the user is told, once, with the reload behind a button — an app that
   refreshes itself mid-turn is worse than one that is a version behind.

   One toast, not a queue: it is pinned open (`duration: Infinity`) under a
   fixed id, so the hourly re-check replaces it rather than stacking a second
   copy on a tab that has been open all day. "Later" only dismisses the toast —
   the update stays waiting and is applied by the next ordinary reload. */

const UPDATE_TOAST_ID = "pwa-update"

/** Set once a worker is waiting: hands over and reloads. */
let applyUpdate: (() => Promise<void>) | null = null

/** Apply a waiting update now. No-op when there is nothing waiting. */
export async function applyPwaUpdate(): Promise<void> {
  await applyUpdate?.()
}

/** Is there an installed-and-waiting worker? For a settings row that wants to
    say so after the toast has been dismissed. */
export const pwaUpdateReady = (): boolean => applyUpdate !== null

function offerUpdate(): void {
  toast("A new version of Daedalus is ready", {
    id: UPDATE_TOAST_ID,
    description: "Reload to pick it up — drafts are kept, and a running turn carries on.",
    duration: Infinity,
    action: {
      label: "Reload",
      onClick: () => {
        void applyPwaUpdate()
      },
    },
    cancel: { label: "Later", onClick: () => toast.dismiss(UPDATE_TOAST_ID) },
  })
}

export function registerPwa(): void {
  if (!("serviceWorker" in navigator)) return
  /* The desktop shell serves dist over http://127.0.0.1 — a secure context, so
     a worker would happily install there. It should not: the files are already
     local, so the precache buys nothing, and the update offer would tell
     someone who just installed a new build of the app that a new version is
     ready. Electron updates through electron-builder, not through Workbox. */
  if (window.desktop?.isElectron) return
  // Sequential, not concurrent — see unregisterRetiredWorkers.
  void unregisterRetiredWorkers().then(registerAppWorker)
}

function registerAppWorker(): void {
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      // `true` = reload the page once the new worker has taken over, which is
      // the whole point: the running JS and the precache must not disagree.
      applyUpdate = () => updateSW(true)
      offerUpdate()
    },
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return
      setInterval(() => {
        // Offline, `update()` rejects — there is nothing to do about that but
        // wait for the next tick.
        void registration.update().catch(() => undefined)
      }, UPDATE_INTERVAL_MS)
    },
    onRegisterError(error) {
      // No worker means no offline shell and no push. Everything else still
      // works, so this is a warning, not an error surfaced to the user.
      console.warn("PWA service worker registration failed:", error)
    },
  })
}

/**
 * The registration FCM should subscribe through. Firebase otherwise goes and
 * registers a `/firebase-messaging-sw.js` of its own — a second worker, and
 * one this app does not ship.
 */
export async function pushRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!("serviceWorker" in navigator)) return undefined
  // Nothing was registered there (see registerPwa), so `ready` would only burn
  // the timeout below before answering what is already known.
  if (window.desktop?.isElectron) return undefined
  try {
    // `ready` never settles when registration failed or was never attempted —
    // off https, say — so it cannot be the only thing setupPush waits on. The
    // timeout is a way out of the call, not an answer: `ready` is left running,
    // so a worker that was merely slow is picked up by the next caller rather
    // than staying lost until the page reloads.
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<undefined>((resolve) => setTimeout(resolve, READY_TIMEOUT_MS)),
    ])
  } catch {
    return undefined
  }
}
