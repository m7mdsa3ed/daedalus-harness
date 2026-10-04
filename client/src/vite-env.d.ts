/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * `renotify` is in the Notifications spec and shipping in Chrome (which is
 * where it matters — Android), but TypeScript's DOM lib has never had it. Both
 * places that raise a notification pass it, so it is declared once here rather
 * than cast at each call site.
 *
 * It is only meaningful alongside `tag`: it makes a notification that REPLACES
 * an existing one alert again instead of swapping the text in silence. Chrome
 * throws a TypeError on `renotify` without `tag`.
 *
 * `vibrate` and `timestamp` are the same story — spec'd, shipping on Android,
 * and dropped from the DOM lib because they are no-ops on the desktop. They are
 * exactly the two that decide whether Android alerts (see lib/notification-shape).
 */
interface NotificationOptions {
  renotify?: boolean
  vibrate?: number | number[]
  timestamp?: number
  /** `actions` is the same story once more: a Chromium extension (buttons on
      the notification, Android and desktop Chrome) that the DOM lib has never
      carried. The worker's `notificationclick` reads `event.action` against
      them, and a plain tap is the empty string. */
  actions?: NotificationAction[]
}

/** One button on a notification — `action` is the id reported on the click,
    `title` is the label drawn. */
interface NotificationAction {
  action: string
  title: string
  icon?: string
}

/** The app's version, defined by vite.config.ts from the root package.json —
    the build this device is running, shown beside the server's in Settings ›
    General's About group. */
declare const __APP_VERSION__: string
