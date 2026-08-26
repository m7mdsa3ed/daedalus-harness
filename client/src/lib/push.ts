import { api, type ServerSettings } from "./settings"

/**
 * Best-effort FCM registration. Silently a no-op when the server has no FCM
 * config, the browser lacks support, or the user declines notifications.
 */
export async function setupPush(settings: ServerSettings): Promise<void> {
  try {
    const config = await api<{ enabled: boolean; firebase?: Record<string, string>; vapidKey?: string }>(
      settings,
      "/api/push/config"
    )
    if (!config.enabled || !config.firebase) return
    if (!("serviceWorker" in navigator) || !("Notification" in window)) return
    // Never prompts. Asking belongs to a user gesture — the enable-notifications
    // alert in the thread view (components/notification-alert) or the settings
    // toggle — which calls back into setupPush once permission is granted.
    if (Notification.permission !== "granted") return

    const { initializeApp } = await import("firebase/app")
    const { getMessaging, getToken } = await import("firebase/messaging")
    // The service worker gets the firebase config via its registration URL —
    // the client has no build-time config at all.
    const registration = await navigator.serviceWorker.register(
      `/firebase-messaging-sw.js?config=${encodeURIComponent(JSON.stringify(config.firebase))}`
    )
    const messaging = getMessaging(initializeApp(config.firebase))
    const token = await getToken(messaging, {
      vapidKey: config.vapidKey,
      serviceWorkerRegistration: registration,
    })
    if (token) {
      await api(settings, "/api/push/register", { method: "POST", body: JSON.stringify({ token }) })
    }
  } catch (error) {
    console.warn("push setup skipped:", error)
  }
}
