/* ── A full workspace in its own window ──
   This window shares the origin and device-local storage with the main app, so
   its dock is scoped by a stable window id. `popout` remains the window's
   identity across route changes and reloads, independent of the URL: the
   desktop shell passes it through the preload, and a browser window opened
   with `?popout=1&windowId=…` (dock.tsx `popoutPanel`) keeps it in its own
   sessionStorage, because the first navigation drops the query. */
const BROWSER_KEY = "daedalus.popoutWindowId"

function browserWindowId(): string | null {
  const fromUrl = new URLSearchParams(window.location.search)
  const id = fromUrl.has("popout") ? fromUrl.get("windowId") : null
  try {
    if (id) sessionStorage.setItem(BROWSER_KEY, id)
    return id ?? sessionStorage.getItem(BROWSER_KEY)
  } catch {
    return id
  }
}

const BROWSER_ID = typeof window !== "undefined" && !window.desktop?.popout ? browserWindowId() : null

export const IS_POPOUT =
  typeof window !== "undefined" &&
  (!!window.desktop?.popout || !!BROWSER_ID || new URLSearchParams(window.location.search).has("popout"))

/** Stable for this window's lifetime; isolates its workspace layout. */
export const POPOUT_WINDOW_ID =
  typeof window !== "undefined" ? window.desktop?.popoutId ?? BROWSER_ID : null
