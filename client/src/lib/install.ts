/* ── Installing the app ──
   Everything the browser needs in order to OFFER an install — the manifest, the
   icons, a service worker with a fetch handler — is set up elsewhere (see
   vite.config.ts and lib/pwa.ts). This module is the other half, and without it
   the install never happens on the platform the PWA exists for.

   Chrome used to show a "mini-infobar" of its own the first time a site met the
   criteria. It does not any more: on Android the automatic banner is gone, and
   what remains is a `beforeinstallprompt` event fired AT THE PAGE, plus a menu
   item most people never look for. A page that ignores that event is installable
   and yet, from the user's side, offers no way to install — which reads exactly
   like a broken PWA. So the event is captured here, kept, and re-fired from a
   real click.

   Two constraints shape the whole file:

     - **The event fires early and only once**, shortly after load. Listening for
       it from a component that mounts after the settings route is opened means
       it has already come and gone, so `watchInstallability()` is called from
       main.tsx alongside the other boot installers, not from React.
     - **`prompt()` needs a user gesture**, and the deferred event is single-use.
       Calling it outside a click is refused by the browser, and once shown the
       same event cannot be shown again — Chrome fires a fresh one if the user
       dismisses it, which is why `deferred` is cleared on use rather than kept.

   iOS is the exception with no event at all: Safari has never implemented
   `beforeinstallprompt` and installs only through Share → Add to Home Screen.
   That is a real, reachable install, so it is reported as `manual` with
   instructions rather than lumped in with "you cannot install this". */
import { useSyncExternalStore } from "react"

/** Not in TypeScript's DOM lib — it is a Chrome extension to the spec. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

export type InstallStatus =
  /** Already running as an installed app (or the desktop shell). */
  | "installed"
  /** A prompt is in hand — `promptInstall()` will show the browser's dialog. */
  | "available"
  /** No event on this platform, but the user can still install by hand (iOS). */
  | "manual"
  /** Nothing to offer: criteria not met yet, or the browser has no install. */
  | "unavailable"

/** True on iPhone/iPad, including iPadOS, which reports itself as a Mac and is
    told apart only by the touch points. */
function isIos(): boolean {
  const ua = navigator.userAgent
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
}

/** Running as an installed app rather than in a browser tab. `minimal-ui` counts
    because the manifest's `display_override` allows falling back to it — an
    install that landed there is still an install. `navigator.standalone` is
    iOS's own, older answer and the only one Safari gives. */
function isStandalone(): boolean {
  const displayMode =
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    window.matchMedia?.("(display-mode: minimal-ui)").matches === true
  return displayMode || (navigator as { standalone?: boolean }).standalone === true
}

let deferred: BeforeInstallPromptEvent | null = null
let cache: InstallStatus = "unavailable"
const listeners = new Set<() => void>()

function publish(next: InstallStatus): void {
  if (next === cache) return
  cache = next
  for (const listener of listeners) listener()
}

/** The status implied by what is currently known. Kept in one place so the
    event handlers below only have to say "recompute". */
function computeStatus(): InstallStatus {
  // The desktop shell IS the installed app; it ships no service worker (see
  // lib/pwa.ts) and must never offer to install a second copy of itself.
  if (window.desktop?.isElectron) return "installed"
  if (isStandalone()) return "installed"
  if (deferred) return "available"
  if (isIos()) return "manual"
  return "unavailable"
}

const refresh = () => publish(computeStatus())

/**
 * Start listening. Must run at boot — see the note at the top of the file about
 * `beforeinstallprompt` firing before any component has mounted.
 */
export function watchInstallability(): void {
  cache = computeStatus()

  window.addEventListener("beforeinstallprompt", (event) => {
    // Chrome's own infobar is suppressed by this, which is the point: the offer
    // becomes ours to place, and `promptInstall()` shows the real dialog.
    event.preventDefault()
    deferred = event as BeforeInstallPromptEvent
    refresh()
  })

  // Installed from our button, from the browser menu, or from another tab.
  window.addEventListener("appinstalled", () => {
    deferred = null
    refresh()
  })

  // Launched-as-app can start true, but it also flips without a reload when the
  // user installs and the window is adopted, so the row updates in place.
  window
    .matchMedia?.("(display-mode: standalone)")
    .addEventListener?.("change", refresh)
}

export function useInstallStatus(): InstallStatus {
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

/**
 * Show the browser's install dialog. Call from a click — a browser refuses a
 * prompt that no gesture asked for.
 *
 * The deferred event is dropped as soon as it is used, whatever the user
 * answers: it cannot be shown twice, and Chrome fires a replacement if the
 * dialog was dismissed, so keeping a spent one only produces a button that
 * silently does nothing.
 */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const event = deferred
  if (!event) return "unavailable"
  deferred = null
  refresh()
  try {
    await event.prompt()
    return (await event.userChoice).outcome
  } catch {
    return "unavailable"
  }
}
