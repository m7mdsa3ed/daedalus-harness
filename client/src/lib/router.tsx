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
   /projects/<id>        one project: overview, threads, metrics
   /settings             the settings overview: every section as a link
   /settings/<section>   settings, one page per section (components/settings/)
   /notifications        the inbox: every notice the server recorded
   /schedules            every scheduled message; /schedules/new the form, /schedules/<id> one
   /routines             every routine; /routines/new the form, /routines/<id> one routine
   /build                the app builder: a starter, a prompt, a project, a preview */
import * as React from "react"
import { matchPath, useNavigate, type NavigateFunction } from "react-router"

export const threadPath = (sessionId: string) => `/t/${encodeURIComponent(sessionId)}`
/** The overview — where "Settings" (not a section) opens. */
export const settingsRootPath = () => `/settings`
export const settingsPath = (section: string) => `/settings/${section}`
export const settingsFormPath = (section: string, id: string = "new") =>
  `/settings/${section}/${encodeURIComponent(id)}`
/** A project's own page — the overview, its threads and its numbers. Settings
    keeps the *form* (`settingsFormPath("projects", id)`); this is the workspace
    seen as a thing that has a history, which is not a settings screen. */
export const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`
export const schedulesPath = () => `/schedules`
export const schedulePath = (sessionId?: string) =>
  `/schedules/new${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ""}`
/** One scheduled message's own page — what it says, where it lands, when it
    fires next, and the form that changes any of those. */
export const scheduleDetailPath = (scheduleId: string) =>
  `/schedules/${encodeURIComponent(scheduleId)}`
/** The task workspace: one board, optionally with one task's detail open
    (`?task=<id>`), so a task is a URL that can be shared and reloaded. */
export const boardPath = (boardId?: string, taskId?: string) =>
  `/board${boardId ? `/${encodeURIComponent(boardId)}` : ""}${taskId ? `?task=${encodeURIComponent(taskId)}` : ""}`
/* The front door for making an app: pick a starter, say what to build, and
   the harness scaffolds a project, opens the thread and frames the preview.
   A place of its own — not a settings form, not a thread — because it ends
   in a thread that did not exist when the page was opened. */
export const buildPath = () => `/build`
/* The inbox as a place. The header's bell is the glance at it; this is the
   whole history, and it is not a settings screen — Settings › Notifications is
   where push is *configured*, which is a different question. */
export const notificationsPath = () => `/notifications`
/* Routines are a top-level place, not a settings section — the same call
   `/schedules` and `/board` make. Settings holds things you configure once; a
   routine has a history (its runs), fires on its own, and is opened to be read
   as much as to be edited. */
export const routinesPath = () => `/routines`
export const newRoutinePath = () => `/routines/new`
export const routinePath = (routineId: string) => `/routines/${encodeURIComponent(routineId)}`

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
