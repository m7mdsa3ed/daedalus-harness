/* ── Routes ──
   React Router owns navigation (BrowserRouter in main.tsx; the route tree is
   declared in app-shell.tsx — the shell is the layout, the main area is the
   <Routes>). What lives here is the part components don't need:

     - path builders, shared with the push service worker's deep links
     - a module-level navigate for code that runs outside React
       (lib/notifications fires from ACP callbacks, not from a render)
     - "which thread does the URL point at", for the same callers

   /                     home (no thread open)
   /t/<sessionId>        one thread
   /settings/<section>   settings, one page per section (components/settings/) */
import * as React from "react"
import { matchPath, useNavigate, type NavigateFunction } from "react-router"

export const threadPath = (sessionId: string) => `/t/${encodeURIComponent(sessionId)}`
export const settingsPath = (section: string) => `/settings/${section}`
export const settingsFormPath = (section: string, id: string = "new") =>
  `/settings/${section}/${encodeURIComponent(id)}`
export const schedulePath = (sessionId?: string) =>
  `/schedules/new${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ""}`
export const boardPath = () => `/board`

/** The thread the URL points at, if any — legacy /?session= deep links too. */
export function currentThreadId(
  pathname: string = location.pathname,
  search: string = location.search
): string | null {
  const match = matchPath("/t/:sessionId", pathname)
  if (match?.params.sessionId) return match.params.sessionId
  return new URLSearchParams(search).get("session")
}

let navigateFn: NavigateFunction | null = null

/** Navigate from outside React (notifications, dock callbacks). Before the
    bridge mounts — or after it unmounts — a full page load still lands right. */
export function navigateTo(path: string, options?: { replace?: boolean }): void {
  if (navigateFn) void navigateFn(path, { replace: options?.replace })
  // assign() to the current URL is a full reload — and a caller that fires
  // before the bridge mounts (the dock restoring its layout) would loop it.
  else if (path !== location.pathname + location.search) location.assign(path)
}

/** Mounted once inside the router (see AppShell) to hand `navigateTo` the live
    navigate function. */
export function NavigationBridge() {
  const navigate = useNavigate()
  React.useEffect(() => {
    navigateFn = navigate
    return () => {
      if (navigateFn === navigate) navigateFn = null
    }
  }, [navigate])
  return null
}
