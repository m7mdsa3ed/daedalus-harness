/* ── Routes ──
   React Router owns navigation (BrowserRouter in main.tsx; the route tree is
   declared in app-shell.tsx — the shell is the layout, the main area is the
   <Routes>). What lives here is the part components don't need:

     - path builders, shared with the push service worker's deep links
     - a module-level navigate for code that runs outside React
       (lib/notifications fires from ACP callbacks, not from a render)
     - "which thread does the URL point at", for the same callers

   /                     home (no thread open); /?project=<id> aims its console
   /t/<sessionId>        one thread
   /projects/<id>        one project: overview, threads, metrics
   /settings             the settings overview: every section as a link
   /settings/<section>   settings, one page per section (components/settings/)
   /notifications        the inbox: every notice the server recorded
   /automations          every automation; /automations/new the gallery + form,
                         /automations/<id> one, /automations/<id>/runs/<runId> one run
                         (/routines* and /schedules* redirect here)
   /build                the app builder: a starter, a prompt, a project, a preview */
import * as React from "react"
import { matchPath, useNavigate, type NavigateFunction } from "react-router"

export const threadPath = (sessionId: string) => `/t/${encodeURIComponent(sessionId)}`
/** The landing console's address — where the dock lands with nothing open.
    Every "New thread" gesture mints a thread instead (`actions.startThreadIn`),
    so the optional project is a deep link's aim at a console, not a stop on the
    way to starting one. */
export const landingPath = (projectId?: string) =>
  projectId ? `/?project=${encodeURIComponent(projectId)}` : "/"
/** The overview — where "Settings" (not a section) opens. */
export const settingsRootPath = () => `/settings`
export const settingsPath = (section: string) => `/settings/${section}`
export const settingsFormPath = (section: string, id: string = "new") =>
  `/settings/${section}/${encodeURIComponent(id)}`
/** One MCP server seen as a thing that *offers* something — its tools, prompts
    and resources, each drawn as the contract it is. The form beside it
    (`settingsFormPath("mcp", id)`) is where the row is edited; this is what
    the row turned out to be. */
export const mcpDetailPath = (id: string) => `/settings/mcp/${encodeURIComponent(id)}/tools`
/** One entry of an MCP server (a tool, prompt, resource) on a page of its own. */
export const mcpEntryPath = (id: string, key: string) =>
  `${mcpDetailPath(id)}/${encodeURIComponent(key)}`
/** A project's own page — the overview, its threads and its numbers. Settings
    keeps the *form* (`settingsFormPath("projects", id)`); this is the workspace
    seen as a thing that has a history, which is not a settings screen. */
export const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`
/** The task workspace: one board, optionally with one task's detail open
    (`?task=<id>`), so a task is a URL that can be shared and reloaded. */
export const boardPath = (boardId?: string, taskId?: string) =>
  `/board${boardId ? `/${encodeURIComponent(boardId)}` : ""}${taskId ? `?task=${encodeURIComponent(taskId)}` : ""}`
/* The front door for making an app: pick a starter, say what to build, and
   the harness scaffolds a project, opens the thread and frames the preview.
   A place of its own — not a settings form, not a thread — because it ends
   in a thread that did not exist when the page was opened. */
/* The inbox as a place. The header's bell is the glance at it; this is the
   whole history, and it is not a settings screen — Settings › Notifications is
   where push is *configured*, which is a different question. */
export const notificationsPath = () => `/notifications`
/* Automations are a top-level place, not a settings section — the same call
   `/board` makes. Settings holds things you configure once; an automation has a
   history (its runs), fires on its own, and is opened to be read as much as to
   be edited. One noun for what used to be routines and scheduled messages. */
export const automationsPath = () => `/automations`
/** The creation page. `session` pins it to a thread ("Runs in: This thread"),
    which is how `/automate` and the thread footer reach it. */
export const newAutomationPath = (sessionId?: string) =>
  `/automations/new${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ""}`
export const automationRunPath = (automationId: string, runId: string) =>
  `/automations/${encodeURIComponent(automationId)}/runs/${encodeURIComponent(runId)}`
export const automationPath = (automationId: string) => `/automations/${encodeURIComponent(automationId)}`

/** The thread the URL points at, if any — legacy /?session= deep links too.
    */
export function currentThreadId(
  pathname: string = location.pathname,
  search: string = location.search
): string | null {
  const match = matchPath("/t/:sessionId", pathname)
  if (match?.params.sessionId) return match.params.sessionId
  return new URLSearchParams(search).get("session")
}

/** The thread the address bar *shows* — only on a thread route (or the legacy
    `?session=` on `/`). `currentThreadId` alone would
    also answer for any page carrying a `?session=` of its own (the automation form
    does), so the read is gated on the two places a thread can be. */
export function routedThreadId(pathname: string, search: string): string | null {
  if (pathname !== "/" && !pathname.startsWith("/t/")) return null
  return currentThreadId(pathname, search)
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
