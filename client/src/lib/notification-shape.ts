/* ── What an OS notification looks like ──
   Shared by the two places that raise one from the web APIs: the page
   (lib/notifications.ts, for a window nobody is watching) and the service
   worker (sw.ts, for a push). They had drifted — the worker set an icon and a
   badge the page did not — and the options are not cosmetic on the platform
   this app is for.

   Android is the whole reason this file exists. Chrome posts a web notification
   into a channel whose importance decides whether it *peeks* (the heads-up
   banner) or merely lands silently in the shade, and the only levers a web
   caller has over that are these:

     - `silent` must not be true, and must be *stated*: an unset value is
       inherited from the notification's own tag history on some builds.
     - `vibrate` is what makes Android treat the notification as one that
       alerts. Without it Chrome posts it quietly, which on a locked phone is
       the difference between a banner over the lock screen and a line the user
       finds later.
     - `renotify` with a `tag` is what makes a REPLACEMENT alert again. All of
       ours are tagged per thread, so without it the second permission ask on a
       thread swaps the text of the first in silence.
     - `requireInteraction` keeps the ones the agent is BLOCKED on up until the
       user deals with them (desktop Chrome honours it; Android ignores it, and
       ignoring it is the correct no-op).

   What none of this can buy: Android 13+ withholds POST_NOTIFICATIONS from the
   installed PWA independently of the site permission, and a channel the user
   has silenced stays silenced. Both are the OS's answer, not ours. */

/** A short double buzz — long enough to be felt, short enough not to be rude. */
export const NOTIFICATION_VIBRATE = [200, 100, 200]

export interface NotificationShape {
  body: string
  /** One notification per thread per kind: a replacement, never a pile. */
  tag: string
  sessionId?: string
  /** The agent is blocked on the user (a permission, a question). */
  actionable?: boolean
}

export function notificationOptions({
  body,
  tag,
  sessionId,
  actionable = false,
}: NotificationShape): NotificationOptions {
  return {
    body,
    icon: "/icon-192.png",
    // Monochrome white-on-transparent, or Android's status bar shows nothing
    // (a coloured icon is rejected and replaced with a blank square).
    badge: "/icon-badge.png",
    tag,
    renotify: true,
    silent: false,
    vibrate: NOTIFICATION_VIBRATE,
    requireInteraction: actionable,
    timestamp: Date.now(),
    data: { sessionId },
  }
}
