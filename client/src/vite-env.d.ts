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
 */
interface NotificationOptions {
  renotify?: boolean
}
