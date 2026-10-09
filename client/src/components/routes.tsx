/* ── Every route that is not the transcript, in one file ──
   The whole route tree plus the lazy bindings it is made of. A thread is a
   chat panel and never a route; everything else — settings, the board, the
   routines, the schedules, the inbox, a project's page, a thread's trace and
   the landing console — is here, and adding a page is one edit in this file.

   `pageRoutes` returns a *fragment of `<Route>`*, not a component: the dock is
   the main area on every route, so this fragment is rendered by every page tab
   against that tab's own path (`workspace/page-panel.tsx`, `<Routes location>`)
   rather than once at the top of the app. A component here would break that —
   `<Routes>` reads its `<Route>` children directly.

   ── Why the pages are lazy ──
   They are bound below as lazy chunks rather than imported into the shell: a
   `<Route element={<X/>}>` whose `X` is a static import is an ordinary
   reference, so the shell was pulling all twenty-six settings pages, the theme
   builder and the task workspace into the entry chunk — a megabyte gzipped,
   downloaded by every reader who only ever opens a thread.

   Nothing else in the app imports these page modules statically (this file
   and `settings/sections.ts` bind them, both by dynamic import), which is
   what makes the split real: a second static import anywhere would pull the
   module straight back into the entry chunk, and Rollup would say so —
   `INEFFECTIVE_DYNAMIC_IMPORT`. Check the build output before adding one.

   `lazyPage` (`lib/lazy-page.ts`) keeps the component's own prop types, so the
   route tree still type-checks the `actions`/`settings` it hands over. The
   settings sections' pages are bound on their rows in `settings/sections.ts`,
   the other module allowed to name them — by dynamic import only. */
import * as React from "react"
import { Navigate, Route } from "react-router"
import { LandingPage } from "@/components/landing/landing-page"
import { PageFrame } from "@/components/page-primitives"
import {
  SETTINGS_SECTIONS,
  sectionMeta,
  sectionOf,
  type SettingsSectionId,
} from "@/components/settings/sections"
import { lazyPage } from "@/lib/lazy-page"
import { settingsRootPath } from "@/lib/router"
import type { Actions } from "@/lib/actions"
import { useProjects } from "@/lib/queries/catalog"
import { useRoutines } from "@/lib/queries/routines"
import type { ServerSettings } from "@/lib/settings"
import { useStoreSelect } from "@/lib/store"

export interface PageHeading {
  crumb?: string
  title: string
}

/* The settings frame and its index. Every section's page is bound on its own
   row in `settings/sections.ts`, the one table the sections are declared in. */
const SettingsLayout = lazyPage(() => import("@/components/settings/layout"), "SettingsLayout")
const SettingsOverviewPage = lazyPage(
  () => import("@/components/settings/overview"),
  "SettingsOverviewPage"
)

const ProjectPage = lazyPage(() => import("@/components/project-page"), "ProjectPage")
const TracePage = lazyPage(() => import("@/components/trace-page"), "TracePage")
const RoutinesPage = lazyPage(() => import("@/components/routines-page"), "RoutinesPage")
const SchedulePage = lazyPage(() => import("@/components/schedule-page"), "SchedulePage")
const NotificationsInboxPage = lazyPage(
  () => import("@/components/notifications/page"),
  "NotificationsInboxPage"
)
/* The board has two doors — this route and the dock's tasks panel — so both
   have to be lazy or neither is: a static import from either one puts the
   whole `components/tasks` tree back in the entry chunk. The panel's binding
   is in `workspace/dock-surface.tsx`. */
const TasksWorkspace = lazyPage(() => import("@/components/tasks"), "TasksWorkspace")

/* The routes under /settings, read off the one table (`SETTINGS_SECTIONS`).
   Built once at module scope: none of the section pages takes a prop from the
   shell (the layout does, below), and a fresh element per render would only be
   a new object saying the same thing. The cast widens the `as const` union so
   `sub` can be read on a row that has none. */
const SETTINGS_ROUTES = (
  SETTINGS_SECTIONS as readonly {
    id: SettingsSectionId
    page: React.ComponentType
    sub?: readonly { path: string; page: React.ComponentType }[]
  }[]
).map(({ id, page: Page, sub }) => (
  <React.Fragment key={id}>
    <Route path={id} element={<Page />} />
    {sub?.map(({ path, page: Sub }) => (
      <Route key={path} path={`${id}/${path}`} element={<Sub />} />
    ))}
  </React.Fragment>
))

/** What a page route is called — a page tab's title. Beside the route table
    because adding a page is adding a name for it: the section over the page's
    own name. `null` only for a path that is a thread's (the chat panel names
    itself); before the catalogs load a project or a routine is named by its
    kind, and the tab is renamed when the name arrives — never "Page".

    The crumb is dropped where it would only repeat the title — the settings
    overview *is* "Settings", the schedule list *is* "Schedules" — so a page
    that is its own section stays one line rather than saying its name twice
    in two sizes. */
export function usePageHeading(): (path: string) => PageHeading | null {
  const sessions = useStoreSelect((state) => state.sessions)
  const projects = useProjects()
  const routines = useRoutines().data ?? []
  return (path) => {
    const pathname = path.split("?")[0]
    const [, first = "", seg = ""] = pathname.split("/")
    if (first === "settings") {
      const which = sectionOf(seg)
      return {
        crumb: which ? "Settings" : undefined,
        title: which ? sectionMeta(which).label : "Settings",
      }
    }
    if (first === "schedules")
      return {
        crumb: seg ? "Schedules" : undefined,
        title: pathname.endsWith("/new") ? "New schedule" : seg ? "Schedule" : "All schedules",
      }
    if (first === "routines")
      return {
        crumb: seg ? "Routines" : undefined,
        title: pathname.endsWith("/new")
          ? "New routine"
          : seg
            ? (routines.find((r) => r.id === seg)?.name ?? "Routine")
            : "All routines",
      }
    if (first === "board") return { crumb: "Workspace", title: "Tasks" }
    if (first === "notifications") return { crumb: "Workspace", title: "Inbox" }
    if (first === "projects")
      return { crumb: "Projects", title: projects.find((p) => p.id === seg)?.name ?? "Project" }
    if (first === "t" && pathname.endsWith("/trace"))
      return { crumb: "Thread", title: sessions.find((s) => s.id === seg)?.title ?? "Trajectory" }
    if (!first) return { title: "New thread" }
    return null
  }
}

/** What the tree needs from the shell. */
export interface PageRoutesProps {
  settings: ServerSettings
  actions: Actions
  /** Boot gate — the settings layout and the landing console both draw a wait. */
  loading: boolean
  /** A project and a profile exist, so a thread can be started. */
  ready: boolean
  onAddServer: () => void
  onOpenSettings: (section?: SettingsSectionId) => void
}

/* The routes that are pages — everything but a thread, which is a chat
   panel and never a page. Rendered by every page tab against its own path
   (`workspace/page-panel.tsx`), which is why this is a fragment of routes
   and not a `<Routes>`. */
export function pageRoutes({
  settings,
  actions,
  loading,
  ready,
  onAddServer,
  onOpenSettings,
}: PageRoutesProps): React.ReactNode {
  return (
    <>
      <Route
        path="/settings"
        element={
          <SettingsLayout
            settings={settings}
            actions={actions}
            onAddServer={onAddServer}
            loading={loading}
          />
        }
      >
        <Route index element={<SettingsOverviewPage />} />
        {SETTINGS_ROUTES}
        {/* /settings/<unknown> — back to the overview, which lists what exists. */}
        <Route path="*" element={<Navigate to={settingsRootPath()} replace />} />
      </Route>
      {/* /schedules is the list, /schedules/new the creation form and
          /schedules/<id> one schedule — one component reads the path (see
          SchedulePage). The form keeps a form's measure; the list and the
          detail page carry tiles and two columns, so they get the width
          the project page has. */}
      {["/schedules", "/schedules/new", "/schedules/:scheduleId"].map((path) => (
        <Route
          key={path}
          path={path}
          element={
            <PageFrame width={path === "/schedules/new" ? "form" : "wide"}>
              <SchedulePage actions={actions} />
            </PageFrame>
          }
        />
      ))}
      {/* /routines is the list, /routines/new the form, /routines/<id> one
          routine — one component reads the path (see RoutinesPage). Every
          one of them is `wide`, the form included: the autonomy control is
          ten labelled rows each with a three-way choice trailing it, and at
          a form's measure the label wraps under the control it belongs to. */}
      {["/routines", "/routines/new", "/routines/:routineId"].map((path) => (
        <Route
          key={path}
          path={path}
          element={
            <PageFrame width="wide">
              <RoutinesPage actions={actions} />
            </PageFrame>
          }
        />
      ))}
      {/* The inbox as a place — the header's bell is the glance at it. */}
      <Route
        path="/notifications"
        element={
          <PageFrame width="form">
            <NotificationsInboxPage />
          </PageFrame>
        }
      />
      {/* A project's own page: the overview, its threads and its numbers.
          Outside /settings on purpose — settings holds the *form*, and a
          workspace with a history is not a settings screen. */}
      <Route path="/projects/:projectId" element={<ProjectPage actions={actions} />} />
      {/* The task workspace: one board per URL, a task's detail as a
          search param, so both survive a reload and can be shared. */}
      <Route
        path="/board/:boardId?"
        element={
          /* No scroll-under here: the board's scrollers are each view's
             own, so the wrapper pads and the views start below the header
             — under its tint the flat surface reads exactly as a solid
             band would. */
          <div className="flex min-h-0 flex-1 flex-col pt-[var(--app-header-h)]">
            <TasksWorkspace actions={actions} />
          </div>
        }
      />
      {/* The trajectory is a thread's other view — its spans as a
          waterfall rather than a transcript — so it sits under the thread's
          own path. */}
      <Route path="/t/:sessionId/trace" element={<TracePage />} />
      {/* The landing console — "New thread" — is the root and the catch-all. */}
      <Route
        path="*"
        element={
          <LandingPage
            loading={loading}
            ready={ready}
            actions={actions}
            onOpenSettings={onOpenSettings}
          />
        }
      />
    </>
  )
}
