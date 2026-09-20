/**
 * A deploy replaces every hashed chunk, so a tab that has been open across one
 * holds a bundle asking for filenames the server no longer has. The import
 * fails, `React.lazy` caches the rejection for the life of the page, and the
 * boundary that catches it offers a "Try again" that can only re-throw the same
 * cached error — the panel is stuck until someone reloads by hand.
 *
 * Vite raises `vite:preloadError` for exactly this and, by default, rethrows so
 * the failure surfaces as an ordinary error inside whatever boundary is around
 * the import. Preventing it and reloading is the one recovery that always
 * works: the reloaded page is a single build, and every hash in it matches the
 * one on the server, where the broken tab was half old bundle and half new.
 *
 * Reloading is safe for the reasons the update offer gives — drafts are kept
 * per device and a running turn lives on the server, reattached by the socket —
 * so this is the offer's own bargain, taken for the reader because there is no
 * offer to take: the surface is already broken, and a reload is what the
 * "Try again" card was going to tell them to do anyway.
 *
 * Guarded by a timestamp rather than a one-shot flag: an actual loop reloads
 * immediately and lands well inside the window, so it is refused, while a chunk
 * that goes stale minutes later recovers as it should.
 */

/** When the last recovery reload happened. `sessionStorage` because it is about
    this tab, and because the reload has to find it again. */
const RELOAD_AT_KEY = "daedalus.chunk-reload-at"

/** How recent a recovery reload disqualifies the next one. Any real loop is far
    inside this; a later, unrelated stale chunk is outside it. */
const RELOAD_GUARD_MS = 10_000

/** The event Vite's `__vitePreload` raises, carrying the failed import in a
    `payload` property the DOM type lib does not know about. */
type PreloadErrorEvent = Event & { payload?: unknown }

export function installChunkReload(): void {
  // `window`, not `document`: the helper dispatches on `window`.
  window.addEventListener("vite:preloadError", (event) => {
    const { payload } = event as PreloadErrorEvent

    let last = 0
    try {
      last = Number(sessionStorage.getItem(RELOAD_AT_KEY)) || 0
    } catch {
      /* Storage refused (private mode, a zero quota). Read as "no guard
         recorded": the worst case is a reload the browser's own throttle
         breaks, which is better than a page that can never come back. */
    }

    if (Date.now() - last < RELOAD_GUARD_MS) {
      // Reloaded for this already and it did not take, so the chunk is missing
      // rather than stale. Leave `preventDefault` uncalled: Vite rethrows, the
      // boundary draws it, and the console carries the real failure.
      console.error("[chunk] a lazily imported chunk failed again after a reload", payload)
      return
    }

    // Take the failure away from Vite, which would otherwise rethrow it and
    // land a module-resolution error in the boundary instead.
    event.preventDefault()
    try {
      sessionStorage.setItem(RELOAD_AT_KEY, String(Date.now()))
    } catch {
      /* See above. */
    }
    console.warn("[chunk] a lazily imported chunk is stale; reloading", payload)
    location.reload()
  })
}
