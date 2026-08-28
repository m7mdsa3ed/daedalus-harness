import { api, loadServers, type ServerSettings } from "./settings"
import { pushRegistration } from "./pwa"

/** Skip a re-POST when this device already told this server this token. Keyed
    per server: the same device against a second server is a second row. */
const tokenKey = (settings: ServerSettings) => `push.token:${settings.id}`

/** How long a registration is assumed to still be on the server. The row is not
    permanent — `server/src/push.ts` deletes tokens FCM reports dead, and the
    whole database can be reset — while `getToken` keeps handing back the same
    string, so a cache with no expiry is a device that goes dark silently and
    forever. Re-POSTing is one idempotent insert; a week is often enough to heal
    within a day of use and rare enough to cost nothing. */
const REREGISTER_AFTER_MS = 7 * 24 * 60 * 60 * 1000

interface CachedToken {
  token: string
  /** When this token was last accepted by this server. */
  at: number
}

function readCachedToken(settings: ServerSettings): CachedToken | null {
  try {
    const raw = JSON.parse(localStorage.getItem(tokenKey(settings)) ?? "null") as unknown
    if (!raw || typeof raw !== "object") return null
    const { token, at } = raw as Partial<CachedToken>
    return typeof token === "string" && typeof at === "number" ? { token, at } : null
  } catch {
    // Includes the shape an older build wrote (a bare token string): unreadable
    // is the same as unknown, and re-registering is harmless.
    return null
  }
}

type PushConfig = { enabled: boolean; firebase?: Record<string, string>; vapidKey?: string }

/**
 * The Firebase app for one server's config.
 *
 * **Named, not default.** Several servers can be connected at once and each
 * carries its own FCM project; `getApp()` returns whichever was initialised
 * first, so minting a token through it would use the wrong sender id — a
 * plausible-looking token registered against a project that will never send to
 * it, failing silently in both directions. One named app per project instead.
 */
async function firebaseAppFor(firebase: Record<string, string>) {
  const { initializeApp, getApps } = await import("firebase/app")
  const name = `daedalus:${firebase.projectId ?? "?"}:${firebase.appId ?? "?"}`
  return getApps().find((app) => app.name === name) ?? initializeApp(firebase, name)
}

/** The server's FCM config, or null when there is nothing to register with. */
async function pushConfig(settings: ServerSettings): Promise<PushConfig | null> {
  const config = await api<PushConfig>(settings, "/api/push/config")
  return config.enabled && config.firebase ? config : null
}

/**
 * Best-effort FCM registration. Silently a no-op when the server has no FCM
 * config, the browser lacks support, or the user declines notifications.
 *
 * Only the token is minted here. Receiving is the service worker's job and it
 * needs no Firebase at all — the push arrives as a standard Web Push event
 * (see src/sw.ts).
 */
export async function setupPush(settings: ServerSettings): Promise<void> {
  try {
    const config = await pushConfig(settings)
    if (!config?.firebase) return
    if (!("serviceWorker" in navigator) || !("Notification" in window)) return
    // Never prompts. Asking belongs to a user gesture — the enable-notifications
    // alert in the thread view (components/notification-alert) or the settings
    // toggle — which calls back into setupPush once permission is granted.
    if (Notification.permission !== "granted") return

    // Push needs a worker to subscribe through, and off https there is none.
    const registration = await pushRegistration()
    if (!registration) return

    const { getMessaging, getToken, isSupported } = await import("firebase/messaging")
    // Safari before 16.4, Firefox in a private window, embedded webviews: the
    // SDK's own answer for "can this browser do FCM at all".
    if (!(await isSupported())) return

    const app = await firebaseAppFor(config.firebase)
    const token = await getToken(getMessaging(app), {
      vapidKey: config.vapidKey,
      serviceWorkerRegistration: registration,
    })
    if (!token) return
    const cached = readCachedToken(settings)
    if (cached?.token === token && Date.now() - cached.at < REREGISTER_AFTER_MS) return
    await api(settings, "/api/push/register", { method: "POST", body: JSON.stringify({ token }) })
    localStorage.setItem(tokenKey(settings), JSON.stringify({ token, at: Date.now() } satisfies CachedToken))
  } catch (error) {
    console.warn("push setup skipped:", error)
  }
}

/**
 * Unregister this device from a server's push.
 *
 * The counterpart to `setupPush`, and not optional: turning system
 * notifications off, or forgetting a server, otherwise leaves the device
 * receiving that server's pushes for as long as the token lives — a preference
 * the user set that nothing acts on.
 *
 * Both halves are attempted independently. The server row is what actually
 * stops the sending, so it is dropped even when the local token cannot be
 * revoked (no worker, an unsupported browser); `deleteToken` then keeps the
 * browser from holding a subscription nothing will use.
 */
export async function teardownPush(settings: ServerSettings): Promise<void> {
  const cached = readCachedToken(settings)
  localStorage.removeItem(tokenKey(settings))
  try {
    if (cached) {
      await api(settings, "/api/push/register", {
        method: "DELETE",
        body: JSON.stringify({ token: cached.token }),
      })
    }
    // A token belongs to the Firebase project, not to the server that was told
    // about it, so two servers on one project share it — revoking here would
    // silently unsubscribe the other. Identical cached tokens is exactly that
    // case, and the row above is already gone, so leaving the token alive stops
    // this server's pushes without touching the other's.
    if (cached && loadServers().some((s) => s.id !== settings.id && readCachedToken(s)?.token === cached.token)) return
    const config = await pushConfig(settings)
    if (!config?.firebase) return
    if (!("serviceWorker" in navigator)) return
    const { getMessaging, deleteToken, isSupported } = await import("firebase/messaging")
    if (!(await isSupported())) return
    await deleteToken(getMessaging(await firebaseAppFor(config.firebase)))
  } catch (error) {
    console.warn("push teardown incomplete:", error)
  }
}
