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
import type { ReactNode } from "react"
import { toast } from "@/lib/toast"
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
   the update stays waiting and is applied by the next ordinary reload.

   That one toast has three faces, in the order they actually happen. A build
   is a whole precache, so the gap between "there is a new version" and "it is
   ready to swap in" is a download, not an instant — announcing only the
   *finished* install left that stretch silent, and offering a Reload button
   during it would be a button that cannot work yet. So: a **loading** toast
   while the new worker installs, replaced in place (same id) by the
   Reload/Later offer once it is waiting, and replaced again by a loading
   toast on Reload, because handing over and reloading is itself a round trip
   through the worker and the button would otherwise sit there looking
   unpressed. A failed install (`redundant`) takes the toast away rather than
   leaving it spinning forever. */

const UPDATE_TOAST_ID = "pwa-update"

const INSTALLING_TITLE = "Downloading a new version of Daedalus"
const INSTALLING_NOTE = "You can keep working — you'll be asked before anything reloads."

/* ── The download's progress ──
   src/sw.ts counts the precache entries it still has to fetch and posts one
   message per file written. The count is the honest unit here: a precache is a
   list of files and Workbox fetches them one at a time, while bytes are only
   knowable for the responses that carry a Content-Length. Until the worker has
   worked out its denominator (one cache read, so the first files can land
   before it does) there is no bar — a spinner is the right way to say "we do
   not know yet", and a bar drawn against a total of zero would be a lie that
   later jumps. `done` is clamped for the same reason: the total is a snapshot
   taken as the install begins, so a file that landed between the snapshot and
   its arithmetic would otherwise push the bar past its own end. */

interface PrecacheProgress {
  done: number
  total: number
}

let progress: PrecacheProgress | null = null

/** True between the first sign of an installing worker and the offer (or the
    failure) that replaces the toast — the window in which a progress message
    has somewhere to go. */
let installing = false

function installingDescription(): ReactNode {
  if (!progress || progress.total <= 0) return INSTALLING_NOTE
  const done = Math.min(progress.done, progress.total)
  const percent = Math.round((done / progress.total) * 100)
  return (
    // Spans, not divs: this lands inside the toast's <p> description.
    <span className="flex flex-col gap-1.5">
      <span className="flex justify-end tabular-nums">{percent}%</span>
      <span className="block h-1 w-full overflow-hidden rounded-pill bg-muted">
        <span
          className="block h-full rounded-pill bg-primary transition-[width] duration-300 ease-out"
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="block">{INSTALLING_NOTE}</span>
    </span>
  )
}

/** Set once a worker is waiting: hands over and reloads. */
let applyUpdate: (() => Promise<void>) | null = null

/** Apply a waiting update now. No-op when there is nothing waiting. */
export async function applyPwaUpdate(): Promise<void> {
  await applyUpdate?.()
}

/** Is there an installed-and-waiting worker? For a settings row that wants to
    say so after the toast has been dismissed. */
export const pwaUpdateReady = (): boolean => applyUpdate !== null

function announceInstalling(): void {
  installing = true
  toast.loading(INSTALLING_TITLE, {
    id: UPDATE_TOAST_ID,
    description: installingDescription(),
    duration: Infinity,
  })
}

/** A tick of the download. `update`, never `add`: raising the same id again
    would resurrect a toast the user had closed and reset its timer, and a
    progress readout is the last thing that should argue with a dismissal. It
    is a no-op when the toast is gone, which is exactly the wanted behaviour. */
function tickInstalling(): void {
  toast.update(UPDATE_TOAST_ID, INSTALLING_TITLE, {
    type: "loading",
    description: installingDescription(),
    duration: Infinity,
  })
}

/** Follow the installing worker's own report of how far it has got. Registered
    once, before `registerSW`, because the messages start as soon as the worker
    does — and kept even while nothing is installing, since the alternative is
    adding and removing a listener around a window that opens on an event we
    may see late. */
function watchProgress(): void {
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data as { type?: string; done?: number; total?: number } | undefined
    if (data?.type !== "PRECACHE_PROGRESS") return
    progress = { done: data.done ?? 0, total: data.total ?? 0 }
    // A first install draws nothing (see watchInstalling), so a message that
    // arrives with no toast up has nowhere to go.
    if (installing) tickInstalling()
  })
}

function offerUpdate(): void {
  installing = false
  progress = null
  toast("A new version of Daedalus is ready", {
    id: UPDATE_TOAST_ID,
    description: "Reload to pick it up — drafts are kept, and a running turn carries on.",
    duration: Infinity,
    action: {
      label: "Reload",
      onClick: () => {
        // Replaces the offer in place: the reload is one round trip through
        // the worker away, and a button that stays drawn after a click reads
        // as one that did not take.
        toast.loading("Updating Daedalus…", {
          id: UPDATE_TOAST_ID,
          description: "Reloading with the new version.",
          duration: Infinity,
        })
        void applyPwaUpdate()
      },
    },
    // "Later" is the toast's own close button now — the Base UI card carries
    // one on every toast, so a second dismiss control would be two ways to say
    // nothing sitting beside the one way to say yes.
  })
}

/**
 * Follow a worker that is installing, so the download has a face.
 *
 * Only when something is already controlling the page: on a first install
 * there is no old version to replace, nothing will be offered at the end of
 * it, and "downloading a new version" would be a lie told to someone opening
 * the app for the first time.
 *
 * The `installed` end of it is not handled here — that is exactly when
 * `onNeedRefresh` fires, and it replaces this toast with the offer.
 */
function watchInstalling(worker: ServiceWorker | null): void {
  if (!worker || !navigator.serviceWorker.controller) return
  if (worker.state === "activated" || worker.state === "redundant") return
  // Each install is its own download; the last one's numbers are not this
  // one's, and the worker re-states them within a cache read anyway.
  progress = null
  announceInstalling()
  worker.addEventListener("statechange", () => {
    // The install failed: there is no update to offer, so take the spinner
    // away rather than leaving it turning against nothing.
    if (worker.state === "redundant") {
      installing = false
      progress = null
      toast.dismiss(UPDATE_TOAST_ID)
    }
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
  watchProgress()
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
      // An update found by this very registration can beat the callback that
      // hands us the registration, so the worker already in flight is checked
      // as well as the ones announced later.
      watchInstalling(registration.installing)
      registration.addEventListener("updatefound", () => {
        watchInstalling(registration.installing)
      })
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
