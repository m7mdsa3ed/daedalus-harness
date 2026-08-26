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
   /tasks                the PM hub (board cards, my tasks, inbox)
   /b/<boardId>/<view>   one board in one view (kanban by default)
   /settings/<section>   settings, one page per section (components/settings/) */
import * as React from "react"
import { matchPath, useNavigate, type NavigateFunction } from "react-router"

export const threadPath = (sessionId: string) => `/t/${encodeURIComponent(sessionId)}`
export const settingsPath = (section: string) => `/settings/${section}`

/** The PM hub — every board, my tasks, the inbox. */
export const tasksPath = () => "/tasks"

/** One board. The view segment is optional: without it the board opens on its
    own `defaultView` (or the one this device left it on — lib/pm/prefs). */
export const boardPath = (boardId: string, view?: string) =>
  `/b/${encodeURIComponent(boardId)}${view ? `/${view}` : ""}`

/* "Create" from outside the PM module (⌘K, the sidebar) is a route, not a
   callback: the dialogs live inside the pages, so the palette asks for the page
   with `?new=` set and the page opens its own dialog and strips the param. */
export const newBoardPath = () => `${tasksPath()}?new=board`
export const newTaskPath = (boardId: string, view?: string) =>
  `${boardPath(boardId, view)}?new=task`

/** What `?new=` asks the page that just mounted to open. */
export const pendingCreate = (search: string = location.search): "board" | "task" | null => {
  const value = new URLSearchParams(search).get("new")
  return value === "board" || value === "task" ? value : null
}

/** The board the URL points at, if any — the palette and the sidebar both ask. */
export function currentBoardId(pathname: string = location.pathname): string | null {
  return matchPath("/b/:boardId/:view?", pathname)?.params.boardId ?? null
}

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
