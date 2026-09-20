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

   Nothing else in the app imports these page modules (this file is the one
   importer), which is what makes the split real: a second static import
   anywhere would pull the module straight back into the entry chunk, and
   Rollup would say so — `INEFFECTIVE_DYNAMIC_IMPORT`. Check the build output
   before adding one.

   `lazyPage` keeps the component's own prop types, so the route tree still
   type-checks the `actions`/`settings` it hands over; `React.lazy`'s own
   signature erases them to whatever the module's default export is. */
import * as React from "react"
import { Navigate, Route } from "react-router"
import { LandingPage } from "@/components/landing/landing-page"
import {
  sectionMeta,
  sectionOf,
  settingsMaxWidth,
  type SettingsSectionId,
} from "@/components/settings/sections"
import { settingsRootPath } from "@/lib/router"
import type { Actions } from "@/lib/actions"
import { useProjects } from "@/lib/queries/catalog"
import { useRoutines } from "@/lib/queries/routines"
import type { ServerSettings } from "@/lib/settings"
import { useStoreSelect } from "@/lib/store"
import { cn } from "@/lib/utils"

export interface PageHeading {
  crumb?: string
  title: string
}

function lazyPage<K extends string, M extends Record<K, React.ComponentType<any>>>(
  load: () => Promise<M>,
  key: K
): M[K] {
  return React.lazy(async () => ({ default: (await load())[key] })) as unknown as M[K]
}

const settingsModules = {
  layout: () => import("@/components/settings/layout"),
  overview: () => import("@/components/settings/overview"),
  general: () => import("@/components/settings/general"),
  knowledge: () => import("@/components/settings/knowledge"),
  appearance: () => import("@/components/settings/appearance"),
  keyboard: () => import("@/components/settings/keyboard"),
  notifications: () => import("@/components/settings/notifications"),
  projects: () => import("@/components/settings/projects"),
  mcp: () => import("@/components/settings/mcp"),
  skills: () => import("@/components/settings/skills"),
  commands: () => import("@/components/settings/commands"),
  personas: () => import("@/components/settings/personas"),
  rules: () => import("@/components/settings/rules"),
  modelPrompts: () => import("@/components/settings/model-prompts"),
  profiles: () => import("@/components/settings/profiles"),
  agents: () => import("@/components/settings/agents"),
  quota: () => import("@/components/settings/quota"),
  webSearch: () => import("@/components/settings/web-search"),
  backup: () => import("@/components/settings/backup"),
  ai: () => import("@/components/settings/ai"),
}

const SettingsLayout = lazyPage(settingsModules.layout, "SettingsLayout")
const SettingsOverviewPage = lazyPage(settingsModules.overview, "SettingsOverviewPage")
const GeneralPage = lazyPage(settingsModules.general, "GeneralPage")
const AiPage = lazyPage(settingsModules.ai, "AiPage")
const KnowledgePage = lazyPage(settingsModules.knowledge, "KnowledgePage")
const AppearancePage = lazyPage(settingsModules.appearance, "AppearancePage")
const KeyboardPage = lazyPage(settingsModules.keyboard, "KeyboardPage")
const NotificationsPage = lazyPage(settingsModules.notifications, "NotificationsPage")
const ProjectsPage = lazyPage(settingsModules.projects, "ProjectsPage")
const ProjectFormPage = lazyPage(settingsModules.projects, "ProjectFormPage")
const McpPage = lazyPage(settingsModules.mcp, "McpPage")
const McpImportPage = lazyPage(settingsModules.mcp, "McpImportPage")
const McpFormPage = lazyPage(settingsModules.mcp, "McpFormPage")
/* A chunk of its own: the playground and the schema rendering are a page
   somebody navigates to, and the library list must not carry them. */
const McpDetailPage = lazyPage(() => import("@/components/settings/mcp-detail"), "McpDetailPage")
const SkillsPage = lazyPage(settingsModules.skills, "SkillsPage")
const SkillImportPage = lazyPage(settingsModules.skills, "SkillImportPage")
const SkillFormPage = lazyPage(settingsModules.skills, "SkillFormPage")
const CommandsPage = lazyPage(settingsModules.commands, "CommandsPage")
const CommandImportPage = lazyPage(settingsModules.commands, "CommandImportPage")
const CommandFormPage = lazyPage(settingsModules.commands, "CommandFormPage")
const PersonasPage = lazyPage(settingsModules.personas, "PersonasPage")
const PersonaFormPage = lazyPage(settingsModules.personas, "PersonaFormPage")
const RulesPage = lazyPage(settingsModules.rules, "RulesPage")
const ModelPromptsPage = lazyPage(settingsModules.modelPrompts, "ModelPromptsPage")
const ModelPromptFormPage = lazyPage(settingsModules.modelPrompts, "ModelPromptFormPage")
const ProfilesPage = lazyPage(settingsModules.profiles, "ProfilesPage")
const ProfileFormPage = lazyPage(settingsModules.profiles, "ProfileFormPage")
const AgentsPage = lazyPage(settingsModules.agents, "AgentsPage")
const QuotaPage = lazyPage(settingsModules.quota, "QuotaPage")
const WebSearchPage = lazyPage(settingsModules.webSearch, "WebSearchPage")
const BackupPage = lazyPage(settingsModules.backup, "BackupPage")

/* The theme editor is its own chunk rather than Appearance's: it is the single
   largest page in the app, and Appearance is a section someone opens to change
   the mode. Settings › Appearance imports it too — statically, which is fine
   because that importer is itself inside this chunk group. */
const ThemeEditorPage = lazyPage(() => import("@/components/theme-builder"), "ThemeEditorPage")

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
   is in `workspace/dock.tsx`. */
const TasksWorkspace = lazyPage(() => import("@/components/tasks"), "TasksWorkspace")

/* ── The settings sections, once ──
   The sidebar nav and the `<Route>`s under /settings were two hand-kept lists
   of the same twenty-odd sections, so a new page was two edits and a forgotten
   one was a nav row that redirected straight back to the overview. Both are
   read off this array now: a section with no entry here has no route and no row
   — consistent rather than a dead link.

   `id` is the section id *and* the URL segment (`/settings/<id>`) — the two
   have never differed, and a section whose page needs a different word would be
   a different key on the metadata row, not a special case here. `sub` are the
   routes that hang off a section's own — its import screen and its form — with
   paths relative to it, declared as siblings because that is what they are:
   the list page is not their layout.

   Order is `SETTINGS_SECTIONS`', because the nav filters this array per group
   and the reader sees that order. Route *declaration* order carries no meaning:
   React Router ranks by specificity, so `mcp/import` beats `mcp/:entryId`
   wherever either stands.

   Elements are built once at module scope: none of the section pages takes a
   prop from the shell (the layout does, below), and a fresh element per render
   would only be a new object saying the same thing. */
const SETTINGS_PAGES: readonly {
  id: SettingsSectionId
  element: React.ReactNode
  sub?: readonly { path: string; element: React.ReactNode }[]
}[] = [
  { id: "general", element: <GeneralPage /> },
  { id: "ai", element: <AiPage /> },
  {
    id: "appearance",
    element: <AppearancePage />,
    sub: [{ path: "themes/:themeId", element: <ThemeEditorPage /> }],
  },
  { id: "notifications", element: <NotificationsPage /> },
  { id: "keyboard", element: <KeyboardPage /> },
  { id: "projects", element: <ProjectsPage />, sub: [{ path: ":entryId", element: <ProjectFormPage /> }] },
  { id: "knowledge", element: <KnowledgePage /> },
  {
    id: "mcp",
    element: <McpPage />,
    sub: [
      { path: "import", element: <McpImportPage /> },
      { path: ":entryId/tools", element: <McpDetailPage /> },
      { path: ":entryId", element: <McpFormPage /> },
    ],
  },
  {
    id: "skills",
    element: <SkillsPage />,
    sub: [
      { path: "import", element: <SkillImportPage /> },
      { path: ":entryId", element: <SkillFormPage /> },
    ],
  },
  {
    id: "commands",
    element: <CommandsPage />,
    sub: [
      { path: "import", element: <CommandImportPage /> },
      { path: ":entryId", element: <CommandFormPage /> },
    ],
  },
  { id: "rules", element: <RulesPage /> },
  /* No import route: nothing in the agents' own configs is a persona to
     import — see settings/personas.tsx. */
  { id: "personas", element: <PersonasPage />, sub: [{ path: ":entryId", element: <PersonaFormPage /> }] },
  {
    id: "model-prompts",
    element: <ModelPromptsPage />,
    sub: [{ path: ":entryId", element: <ModelPromptFormPage /> }],
  },
  { id: "profiles", element: <ProfilesPage />, sub: [{ path: ":entryId", element: <ProfileFormPage /> }] },
  { id: "agents", element: <AgentsPage /> },
  { id: "usage", element: <QuotaPage /> },
  { id: "backup", element: <BackupPage /> },
  { id: "web-search", element: <WebSearchPage /> },
]

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
      return { crumb: "Thread", title: sessions.find((s) => s.id === seg)?.title ?? "Trace" }
    if (!first) return { title: "New thread" }
    return null
  }
}

/** What the tree needs from the shell. `pathname` is the shell's location, not
    a page tab's: `settingsMaxWidth` is asked once, where the frame is built. */
export interface PageRoutesProps {
  settings: ServerSettings
  actions: Actions
  /** Boot gate — the settings layout and the landing console both draw a wait. */
  loading: boolean
  /** A project and a profile exist, so a thread can be started. */
  ready: boolean
  pathname: string
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
  pathname,
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
        {SETTINGS_PAGES.map((entry) => (
          <React.Fragment key={entry.id}>
            <Route path={entry.id} element={entry.element} />
            {entry.sub?.map((sub) => (
              <Route key={sub.path} path={`${entry.id}/${sub.path}`} element={sub.element} />
            ))}
          </React.Fragment>
        ))}
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
            <div className="min-h-0 flex-1 overflow-y-auto pt-[var(--app-header-h)]">
              <div
                className={cn(
                  "mx-auto w-full px-4 pt-6 pb-16 sm:px-8",
                  path === "/schedules/new" ? "max-w-3xl" : "max-w-5xl"
                )}
              >
                <SchedulePage actions={actions} />
              </div>
            </div>
          }
        />
      ))}
      {/* /routines is the list, /routines/new the form, /routines/<id> one
          routine — one component reads the path (see RoutinesPage). The
          frame is the settings frame's width rather than the schedules
          page's max-w-3xl: the autonomy control is ten labelled rows each
          with a three-way choice trailing it, and at a form's measure the
          label wraps under the control it belongs to. */}
      {["/routines", "/routines/new", "/routines/:routineId"].map((path) => (
        <Route
          key={path}
          path={path}
          element={
            <div className="min-h-0 flex-1 overflow-y-auto pt-[var(--app-header-h)]">
              <div
                className={cn("mx-auto w-full px-4 pt-6 pb-16 sm:px-8", settingsMaxWidth(pathname))}
              >
                <RoutinesPage actions={actions} />
              </div>
            </div>
          }
        />
      ))}
      {/* The inbox as a place — the header's bell is the glance at it. */}
      <Route
        path="/notifications"
        element={
          <div className="min-h-0 flex-1 overflow-y-auto pt-[var(--app-header-h)]">
            <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-16 sm:px-8">
              <NotificationsInboxPage />
            </div>
          </div>
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
            <TasksWorkspace />
          </div>
        }
      />
      {/* The trace is a thread's other view — the journal as a timeline
          rather than a transcript — so it sits under the thread's own
          path. */}
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
