import * as React from "react"
import { AppWindowIcon, Check, ChevronDown, ChevronLeft, GitBranch, SearchIcon, ServerIcon, Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { CommandPalette, useCommandPalette } from "@/components/command-palette"
import { ImportThreadsDialog } from "@/components/import-threads"
import { ShortcutsHelp, useShortcutsHelp } from "@/components/shortcuts-help"
import { Logo } from "@/components/ui/logo"
import { LandingPage } from "@/components/landing/landing-page"
import { WorkspaceDock, useWorkspaceDock } from "@/components/workspace/dock"
import { ThreadHeaderMenu } from "@/components/thread-menu"
import { ProjectIcon } from "@/components/entity-icon"
import { NotificationBell } from "@/components/notifications/bell"
import { NotificationsInboxPage } from "@/components/notifications/page"
import { panelId, type PanelKind } from "@/lib/workspace/panels"
import { openTerminal } from "@/components/workspace/terminal-panel"
import { RoutinesPage } from "@/components/routines-page"
import { SchedulePage } from "@/components/schedule-page"
import { TasksWorkspace } from "@/components/tasks"
import type { DockviewApi } from "dockview-react"
import { SidebarGroupsSkeleton } from "@/components/ui/skeletons"
import { ProgressiveBlur } from "@/components/ui/progressive-blur"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import type { Actions } from "@/lib/actions"
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router"
import {
  currentThreadId,
  NavigationBridge,
  projectPath,
  settingsFormPath,
  settingsPath,
  settingsRootPath,
  threadPath,
} from "@/lib/router"
import { consumeNewTab, markNewTab } from "@/lib/session-tabs"
import { consumeQueuedPanels } from "@/lib/workspace/pending-panels"
import { useShortcut } from "@/hooks/use-hotkey"
import { useChord } from "@/lib/keybindings"
import { formatChord, KEYS } from "@/lib/shortcuts"
import { defaultsForProfile, loadThreadDefaults, resolveThreadStart } from "@/lib/thread-defaults"
import {
  loadServers,
  setActiveServer,
  type HelperCommand,
  type ServerSettings,
} from "@/lib/settings"
import { useCatalogLoaded, useProfiles, useProjects } from "@/lib/queries/catalog"
import { useRoutines } from "@/lib/queries/routines"
import { useStoreSelect } from "@/lib/store"
import { cn } from "@/lib/utils"
import { HEADER_BADGE, HEADER_CHIP } from "@/lib/header-chrome"
import { ProjectFormPage, ProjectsPage } from "@/components/settings/projects"
import { ProjectPage } from "@/components/project-page"
import { TracePage } from "@/components/trace-page"
import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_OVERVIEW,
  SETTINGS_SECTIONS,
  settingsMaxWidth,
  type SettingsSectionId,
} from "@/components/settings/sections"
import { SettingsLayout } from "@/components/settings/layout"
import { SettingsOverviewPage } from "@/components/settings/overview"
import { GeneralPage } from "@/components/settings/general"
import { KnowledgePage } from "@/components/settings/knowledge"
import { AppearancePage } from "@/components/settings/appearance"
import { KeyboardPage } from "@/components/settings/keyboard"
import { NotificationsPage } from "@/components/settings/notifications"
import { McpFormPage, McpImportPage, McpPage } from "@/components/settings/mcp"
import { SkillFormPage, SkillImportPage, SkillsPage } from "@/components/settings/skills"
import { CommandFormPage, CommandImportPage, CommandsPage } from "@/components/settings/commands"
import { PersonaFormPage, PersonasPage } from "@/components/settings/personas"
import { RulesPage } from "@/components/settings/rules"
import { ModelPromptFormPage, ModelPromptsPage } from "@/components/settings/model-prompts"
import { ProfileFormPage, ProfilesPage } from "@/components/settings/profiles"
import { AgentsPage } from "@/components/settings/agents"
import { QuotaPage } from "@/components/settings/quota"
import { WebSearchPage } from "@/components/settings/web-search"
import { BackupPage } from "@/components/settings/backup"
import { ThemeEditorPage } from "@/components/theme-builder"
import { GROUP, GROUP_LABEL, MENU, ROW, SidebarNav, ThreadSidebar, TIER } from "@/components/thread-sidebar"

/** The address without its scheme — what identifies a server on a footer row
    the width of a sidebar. */
function serverHost(url: string): string {
  try {
    const u = new URL(url)
    return u.host + (u.pathname !== "/" ? u.pathname.replace(/\/$/, "") : "")
  } catch {
    return url
  }
}

/** Swappable sidebar body. One panel per route family — see `panels` below. */
/** Closes the mobile sidebar sheet whenever the route changes. Desktop keeps
    its open/collapsed state — there it is a column, not an overlay. */
function CloseSidebarOnNavigate() {
  const { isMobile, setOpenMobile } = useSidebar()
  const location = useLocation()
  const key = location.pathname + location.search
  React.useEffect(() => {
    if (isMobile) setOpenMobile(false)
  }, [key, isMobile, setOpenMobile])
  return null
}

interface SidebarPanel {
  /** Row that leaves this panel for the root one; omit on the root panel. */
  back?: { label: string; onClick: () => void }
  /** Primary action pinned under the brand row. */
  action?: React.ReactNode
  body: React.ReactNode
}

const SIDEBAR_WIDTH_KEY = "sidebar_width"
const SIDEBAR_WIDTH_DEFAULT = "16rem"

/** URL segment → a section that exists. `null` is the overview (`/settings`
    itself) and every segment that names nothing — the route tree redirects
    those to the overview, so nothing lights up on the way. */
const sectionOf = (value: string): SettingsSectionId | null =>
  SETTINGS_SECTIONS.find((s) => s.id === value)?.id ?? null

export function AppShell({
  settings,
  actions,
  loading: bootLoading,
  onAddServer,
}: {
  settings: ServerSettings
  actions: Actions
  loading: boolean
  onAddServer: () => void
}) {
  /* Three slices, not the state: this shell wraps every panel, so on the wide
     hook it re-rendered — and re-ran the layout effects below — on every
     streamed token of every open thread. None of the three is touched by an
     `update`; `sessions` moves once per turn, at most. */
  const sessions = useStoreSelect((state) => state.sessions)
  const projects = useProjects()
  const profiles = useProfiles()
  /* Loaded at boot and read by the sidebar already — the header only names
     the routine the URL points at. */
  const routines = useRoutines().data ?? []
  /* `bootstrap` answers for the session list alone now — each catalog is its
     own query — so the shell's loading gate is the two together. Without it
     an empty catalog mid-read draws the "Finish the setup" screen at every
     boot. */
  const catalogLoaded = useCatalogLoaded()
  const loading = bootLoading || !catalogLoaded
  const location = useLocation()
  const navigate = useNavigate()
  /* The servers this device knows. Unlike everything else this comes from
     localStorage, not the store, and it only changes on Add/switch — both of
     which hard-reload the app — so read it once per shell mount is enough. */
  const servers = React.useMemo(loadServers, [])
  // Sidebar width overrides the shadcn default via the same CSS var it reads.
  const [sidebarWidth, setSidebarWidth] = React.useState(
    () => localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? SIDEBAR_WIDTH_DEFAULT
  )
  const [resizing, setResizing] = React.useState(false)
  const palette = useCommandPalette()
  // Whatever this is bound to on this device — the tooltip has to say the
  // key that actually works, not the one the release shipped.
  const paletteChord = useChord("palette") ?? ""
  const shortcuts = useShortcutsHelp()
  const [importing, setImporting] = React.useState(false)
  const inSettings = location.pathname.startsWith("/settings")
  const inSchedule = location.pathname.startsWith("/schedules")
  const inRoutines = location.pathname.startsWith("/routines")
  const inBoard = location.pathname.startsWith("/board")
  const inProject = location.pathname.startsWith("/projects")
  const inNotifications = location.pathname.startsWith("/notifications")
  /* The trace view borrows a thread's id in the URL but docks no chat — see
     `currentTraceId` — so the header menu and the dock keep whatever thread
     (or none) the route under it names. */
  const inTrace = location.pathname.endsWith("/trace")
  const sessionId =
    inSettings || inSchedule || inRoutines || inBoard || inProject || inNotifications || inTrace
      ? null
      : currentThreadId(location.pathname, location.search)
  const section = inSettings ? sectionOf(location.pathname.split("/")[2] ?? "") : null
  // Leaving settings returns to the thread it was opened from.
  const lastThread = React.useRef<string | null>(null)
  if (sessionId) lastThread.current = sessionId
  const active = sessions.find((s) => s.id === sessionId)
  /* Where the thread in front of us was branched from, if anywhere — drawn as
     a chip, followed only by a click. The list holds the trash too, so a
     parent still shows its title until it is purged, which is the honest
     answer for a branch whose origin is otherwise gone. */
  const forkedFrom = active?.forkedFromSessionId
    ? sessions.find((s) => s.id === active.forkedFromSessionId)
    : undefined
  const ready = !loading && projects.length > 0 && profiles.length > 0
  const dock = useWorkspaceDock()
  const currentProjectId = inProject ? location.pathname.split("/")[2] : undefined
  const currentProject = projects.find((p) => p.id === currentProjectId)
  const activeProject = projects.find((p) => p.id === active?.projectId)
  const effectiveProject = inProject ? currentProject : activeProject
  /* What the header says on a route that is not a thread: the section over the
     page's own name, which is the shape a thread already had. `null` means the
     thread branch draws it instead.

     The crumb is dropped where it would only repeat the title — the settings
     overview *is* "Settings", the schedule list *is* "Schedules" — so a page
     that is its own section stays one line rather than saying its name twice
     in two sizes. */
  const routeHeading: { crumb?: string; title: string } | null = (() => {
    if (loading) return null
    const seg = location.pathname.split("/")[2]
    if (inSettings)
      return {
        crumb: section ? "Settings" : undefined,
        title: SETTINGS_SECTIONS.find((s) => s.id === section)?.label ?? "Settings",
      }
    if (inSchedule)
      return {
        crumb: seg ? "Schedules" : undefined,
        title: location.pathname.endsWith("/new")
          ? "New schedule"
          : seg
            ? "Schedule"
            : "All schedules",
      }
    if (inRoutines)
      return {
        crumb: seg ? "Routines" : undefined,
        title: location.pathname.endsWith("/new")
          ? "New routine"
          : seg
            ? (routines.find((r) => r.id === seg)?.name ?? "Routine")
            : "All routines",
      }
    if (inBoard) return { crumb: "Workspace", title: "Tasks" }
    if (inNotifications) return { crumb: "Workspace", title: "Inbox" }
    if (inProject)
      return {
        crumb: "Projects",
        title: projects.find((p) => p.id === seg)?.name ?? "Project",
      }
    return null
  })()

  const routeSessionRef = React.useRef(sessionId)
  routeSessionRef.current = sessionId
  // The project the workspace panels act on: the routed thread's own or current project.
  const activeProjectRef = React.useRef<string | null>(null)
  activeProjectRef.current = effectiveProject?.id ?? null
  const activeSessionRef = React.useRef<string | null>(null)
  activeSessionRef.current = active?.id ?? null

  /* The route is the source of truth for the focused tab; each mounted chat owns
     its own ACP connection, so background tabs keep streaming while hidden. */
  React.useEffect(() => {
    if (!sessionId) return
    if (location.search) void navigate(threadPath(sessionId), { replace: true }) // legacy ?session=
    const meta = sessions.find((s) => s.id === sessionId)
    if (meta) {
      dock.openChat(sessionId, { newTab: consumeNewTab() })
      /* Panels a page without a dock asked to open beside this thread. After
         the chat, so they split against it. */
      for (const entry of consumeQueuedPanels()) dock.openPanel(entry.panel, entry.options)
      return
    }
    /* A route for a thread nobody knows about: an unsent draft after a reload
       (they only ever lived in the tab that made them) or one since purged.
       Either way an empty thread on that id beats a dead end — and if it is
       sent, the id in the URL bar is the id the server gets. Gated on `ready`
       so this cannot fire before bootstrap has filled sessions in. */
    if (!ready) return
    const defaults = loadThreadDefaults()
    const project = projects.find((p) => p.id === defaults.projectId) ?? projects[0]
    const start = resolveThreadStart(defaults, profiles)
    if (!project || !start) return
    actions.newDraftThread({
      project,
      ...start,
      ...defaultsForProfile(defaults, start.profile.id),
      id: sessionId,
    })
  }, [sessionId, sessions, projects, profiles, ready, actions, dock])

  React.useEffect(() => {
    if (loading) return
    dock.prunePanels({
      sessions: sessions.map((session) => session.id),
      projects: projects.map((project) => project.id),
    })
  }, [loading, sessions, projects, dock])

  const handleDockReady = React.useCallback(
    (api: DockviewApi) => {
      dock.onReady(api)
      if (routeSessionRef.current) dock.openChat(routeSessionRef.current)
    },
    [dock]
  )

  /* Mirrors the palette's "New thread" entry — the palette advertises the
     shortcut, so something has to answer for it. The chord itself is named in
     lib/shortcuts, which is also what the help sheet prints. */
  useShortcut("newThread", () => {
    startThreadRef.current()
  })

  /* A section opens that section; plain "Settings" opens the overview, which
     is the one page that lists them all — the sidebar does on a desktop, but
     on a phone it is a drawer that closed when you tapped Settings. */
  const openSettings = (next?: SettingsSectionId) =>
    void navigate(next ? settingsPath(next) : settingsRootPath())
  /* A new thread is a route change, not a round trip: mint the id, put a draft
     row in the store and navigate. Nothing is created on the server and no
     agent is spawned until the first message — see actions.newDraftThread. The
     agent/profile/model picker moved onto the composer of the empty thread,
     which is where the choice is actually about to matter.

     `text` is the one thing that changes the shape of this: the palette can
     hand over a first message, in which case the draft is created, routed to
     AND sent in the same gesture — `actions.send` is what turns a draft into a
     real session, and it does not need the composer to be mounted to do it, so
     the thread is already spawning while the transcript is still opening.
     A failure lands in that thread as a Retry row like any other send. */
  const startThread = (opts: { text?: string; projectId?: string } = {}) => {
    if (!ready) return openSettings("projects")
    const defaults = loadThreadDefaults()
    const project =
      (opts.projectId ? projects.find((p) => p.id === opts.projectId) : undefined) ??
      projects.find((p) => p.id === defaults.projectId) ??
      projects[0]
    const start = resolveThreadStart(defaults, profiles)
    if (!project || !start) return openSettings("projects")
    const id = actions.newDraftThread({
      project,
      ...start,
      ...defaultsForProfile(defaults, start.profile.id),
    })
    void navigate(threadPath(id))
    const text = opts.text?.trim()
    if (text) void actions.send(id, text).catch(() => {})
  }
  // The key handler is bound once; the ref keeps it pointed at the live closure.
  const startThreadRef = React.useRef(startThread)
  startThreadRef.current = startThread

  /* One opener for every workspace panel, so the tab strip's + menu, the
     chords below and the palette cannot drift apart. Toggling rather than
     stacking: pressing the same thing twice should put the transcript back.

     Which project? The routed thread's. There is no "active project" in this
     app — the dock is cross-project by design — so the thread in front of you
     is what names one. */
  const openWorkspacePanel = React.useCallback(
    (kind: PanelKind) => {
      /* Boards are the server's, not a project's, so this one opens with no
         project at all — the only kind that does, and the reason the check
         below comes after it rather than at the top. */
      if (kind === "tasks") {
        /* Reopened with the board it was left on, not reset to "no board": the
           descriptor is where a tasks panel keeps its place, so opening it
           again with a bare one would point it at nothing. Same shape as the
           terminal case below — ask the dock what is already there. */
        const existing = dock.listPanels().find((entry) => entry.panel.kind === "tasks")
        dock.openPanel(existing?.panel ?? { kind: "tasks" }, { direction: "right" })
        return
      }
      const projectId = activeProjectRef.current
      if (!projectId) return
      if (kind === "terminal") {
        const existing = dock
          .listPanels()
          .find((entry) => entry.panel.kind === "terminal" && entry.panel.projectId === projectId)
        if (existing) dock.openPanel(existing.panel)
        else void openTerminal(dock, projectId)
        return
      }
      if (kind === "web") {
        dock.openPanel(
          { kind: "web", trust: "project", projectId, viewId: "default" },
          { direction: "right" }
        )
      }
      if (kind === "ide") {
        dock.openPanel({ kind: "ide", projectId }, { direction: "right" })
      }
    },
    [dock]
  )

  useShortcut("terminal", () => {
    openWorkspacePanel("terminal")
  })

  useShortcut("ide", () => {
    openWorkspacePanel("ide")
  })

  /* The + on the tab strip. Same thread-creation path as ⌘N and the sidebar —
     `markNewTab` is the one-shot flag the route effect reads when it opens the
     panel, so "new tab" is decided here and honoured there rather than being a
     second way to create a thread. */
  const newThreadInTab = React.useCallback(() => {
    markNewTab()
    startThreadRef.current()
  }, [])

  /* The manifest's "New thread" app shortcut (see client/vite.config.ts) can
     only name a fixed URL, and a thread id is minted per thread — so it lands
     on `/?new=1` and this turns that into the same thing the ⌘N chord does.
     The marker is consumed before the thread is started, and only once: leaving
     it in the URL would mint a second thread on every Back. */
  const consumedNewParam = React.useRef(false)
  React.useEffect(() => {
    if (!ready || consumedNewParam.current) return
    if (!new URLSearchParams(location.search).has("new")) return
    consumedNewParam.current = true
    // Not `navigate`: startThread navigates too, and the two in one tick race.
    // This only has to keep Back off the marker, which replaceState does.
    window.history.replaceState(null, "", "/")
    startThreadRef.current()
  }, [ready, location.search])

  /* ── Sidebar panels ──
     The sidebar body is swappable: one entry per route family. To add a panel,
     add a route below and an entry here — the shell itself is generic. */
  const panels: Record<"threads" | "settings", SidebarPanel> = {
    threads: {
      // The fixed nav rows (New thread, Search, Tasks) sit above the list,
      // the way the Codex and Claude desktop sidebars open. `New project`
      // stays reachable from /settings/projects and the command palette.
      action: (
        <SidebarNav
          onNewThread={() => startThreadRef.current()}
          onNewThreadInTab={newThreadInTab}
        />
      ),
      body: loading ? <SidebarGroupsSkeleton /> : <ThreadSidebar actions={actions} />,
    },
    settings: {
      back: {
        label: "Back to threads",
        onClick: () =>
          void navigate(lastThread.current ? threadPath(lastThread.current) : "/"),
      },
      body: (
        <SettingsNav
          section={section}
          onSelect={(next) => void navigate(settingsPath(next))}
          onOverview={() => void navigate(settingsRootPath())}
        />
      ),
    },
  }
  const panel = panels[inSettings ? "settings" : "threads"]

  /* The non-settings main area. The dock outlives the route: background tabs
     keep their ACP connections and scroll positions while another thread is
     focused. */
  const threadMain = sessionId ? (
    <div className="flex min-h-0 flex-1">
      <WorkspaceDock actions={actions} dock={dock} onReady={handleDockReady} />
    </div>
  ) : (
    <LandingPage
      loading={loading}
      ready={ready}
      onNewThread={startThread}
      onOpenSettings={openSettings}
    />
  )

  return (
    <SidebarProvider
      data-resizing={resizing || undefined}
      style={{
        "--sidebar-width": sidebarWidth,
        height: "100dvh",
        paddingLeft: "env(safe-area-inset-left, 0px)",
      } as React.CSSProperties}
    >
      {/* First in the tree so its effect runs before any sibling subtree's:
          the dock fires onDidActivePanelChange while restoring its saved
          layout, and navigateTo must already have the router's navigate by
          then — the location.assign fallback would be a full reload. */}
      <NavigationBridge />
      {/* The mobile sidebar is a sheet over the content: navigating with it open
          leaves the destination hidden behind it. Closing lives here rather
          than on each row because rows are not the only thing that navigates —
          the palette, the dock and push deep links all land in the same place. */}
      <CloseSidebarOnNavigate />
      <Sidebar collapsible="icon">
        <SidebarHeader className="gap-2 p-3 group-data-[collapsible=icon]:p-2">
          <div data-drag-region className="flex items-center gap-2 px-1 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:px-0">
            <button
              type="button"
              onClick={() => void navigate("/")}
              aria-label="Go to homepage"
              /* Collapsed, the brand is one more icon in the rail and has to
                 sit on its axis: the nav rows below are 32px buttons inside a
                 group's 8px padding, so their glyph centres on 24px — the
                 rail's own centre. A bare 24px mark at the same 8px offset
                 centres on 20 and reads as if it had slipped left. So in the
                 rail the button becomes that same 32px box, centred. */
              className="flex shrink-0 items-center gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center"
            >
              <Logo idle className="size-6 shrink-0" />
              <span className="brand-script text-xl leading-none group-data-[collapsible=icon]:hidden">
                Daedalus
              </span>
            </button>
            {/* Search and the bell sit beside the brand; in the icon rail they
                stack under it. Both are the app's own, not a route's and not a
                dock group's — the sidebar is the one surface that is on every
                route and never splits, which is the whole reason they are here
                rather than in a header the workspace now shares with tabs. */}
            <div className="ml-auto flex items-center gap-0.5 group-data-[collapsible=icon]:ml-0 group-data-[collapsible=icon]:flex-col">
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground hover:text-foreground"
                title={`Search threads and commands (${formatChord(paletteChord)})`}
                aria-label="Search"
                onClick={() => palette.setOpen(true)}
              >
                <SearchIcon />
              </Button>
              <NotificationBell />
              {/* The app's one menu — the workspace's panels and arrangements,
                  and how transcripts are drawn on this device. Nothing in it is
                  about a route or a dock group, which is why it can stand on
                  the one surface that is neither. */}
              {!inSettings && !inSchedule && !inRoutines && !inBoard && !inNotifications && !inTrace && (
                <ThreadHeaderMenu
                  actions={actions}
                  session={active}
                  project={effectiveProject}
                  onNewTab={newThreadInTab}
                  onOpenPanel={openWorkspacePanel}
                  onOpenInNewTab={(thread) => dock.openChat(thread.id, { newTab: true })}
                  dock={dock}
                />
              )}
            </div>
          </div>
        </SidebarHeader>
        <SidebarContent className="gap-0">
          {panel.back ? (
            <SidebarGroup className={GROUP}>
              <SidebarGroupContent>
                <SidebarMenu className={MENU}>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      size="sm"
                      tooltip={panel.back.label}
                      onClick={panel.back.onClick}
                      className={ROW}
                    >
                      <ChevronLeft className="size-4" />
                      <span>{panel.back.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ) : (
            panel.action
          )}
          {panel.body}
        </SidebarContent>
        <SidebarFooter className="p-2">
          <SidebarMenu className={MENU}>
            {/* The "account" row, as both desktop apps end their sidebar: the
                server this client is on, name over address. Clicking it
                switches servers — everything this device knows is one menu
                away, plus Add and Settings › General for the rest (rename,
                forget, teardown before disconnect). */}
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuButton
                      size="lg"
                      tooltip={`${settings.name} · ${settings.url}`}
                      isActive={location.pathname === settingsPath("general")}
                      className="h-11 px-2"
                    >
                      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-sidebar-accent text-sidebar-foreground/80">
                        <ServerIcon className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
                        <span className="block truncate text-[13px] font-medium leading-tight">{settings.name}</span>
                        <span className="block truncate text-[11px] leading-tight text-muted-foreground">
                          {serverHost(settings.url)}
                        </span>
                      </span>
                      <span className="text-sidebar-foreground/40 group-data-[collapsible=icon]:hidden">
                        <ChevronDown className="size-3.5" />
                      </span>
                    </SidebarMenuButton>
                  }
                />
                {/* Solid, not glass: this is the one menu in the app that
                    opens over the sidebar rather than out across the main pane,
                    and frosted glass over another glass surface has nothing to
                    reveal — see the note in index.css. */}
                <DropdownMenuContent
                  align="start"
                  side="top"
                  sideOffset={8}
                  className="w-64"
                  data-surface="solid"
                >
                  {/* The known servers, active one ticked at the top; switching
                      is a state change (see App.tsx), which re-mounts the tree
                      against the newly-active connection.

                      Each label is Base UI's Menu.GroupLabel: it reads its
                      group from context and throws outside one, so it sits
                      inside the group it heads rather than loose in the
                      content. */}
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>
                      <span className="block text-xs">Servers</span>
                    </DropdownMenuLabel>
                    {servers.map((server) => {
                      const isActive = server.id === settings.id
                      return (
                        <DropdownMenuItem
                          key={server.id}
                          disabled={isActive}
                          onClick={() => {
                            setActiveServer(server.id)
                          }}
                        >
                          <span className="grid size-6 shrink-0 place-items-center rounded-md bg-sidebar-accent/70">
                            <ServerIcon className="size-3.5" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm leading-tight">{server.name}</span>
                            <span className="block truncate font-mono text-[11px] leading-tight text-muted-foreground">
                              {serverHost(server.url)}
                            </span>
                          </span>
                          {isActive && <Check className="size-4 shrink-0 text-foreground" />}
                        </DropdownMenuItem>
                      )
                    })}
                  </DropdownMenuGroup>
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>
                      <span className="block text-[11px]">Manage</span>
                    </DropdownMenuLabel>
                    <DropdownMenuItem onClick={onAddServer}>
                      <Settings2 className="size-4" />
                      <span className="min-w-0 flex-1">Add server…</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void navigate(settingsPath("general"))}>
                      <Settings2 className="size-4" />
                      <span className="min-w-0 flex-1">Manage servers</span>
                      <span className="ml-auto text-xs text-muted-foreground">{settingsPath("general")}</span>
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="sm"
                tooltip="Settings"
                isActive={inSettings}
                onClick={() => openSettings()}
                className={ROW}
              >
                <Settings2 />
                <span>Settings</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        {/* Resize handle: sits on the sidebar's right edge (the fixed container
            is its containing block). CSS hides it when collapsed — index.css. */}
        <div
          data-slot="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize · double-click to reset"
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.currentTarget.setPointerCapture(event.pointerId)
            setResizing(true)
          }}
          onPointerMove={(event) => {
            if (!resizing) return
            setSidebarWidth(`${Math.min(520, Math.max(180, Math.round(event.clientX)))}px`)
          }}
          onPointerUp={() => {
            setResizing(false)
            localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth)
          }}
          onDoubleClick={() => {
            setSidebarWidth(SIDEBAR_WIDTH_DEFAULT)
            localStorage.removeItem(SIDEBAR_WIDTH_KEY)
          }}
          className="absolute inset-y-0 right-0 z-20 hidden w-1.5 cursor-col-resize hover:bg-sidebar-border md:block"
        />
      </Sidebar>
      {/* The main surface: --surface (index.css) — the card colour, white on a
          light palette, over the sidebar's tinted ground the way both desktop
          apps separate the two; the darker --background in dark mode, where
          the card tone is the lighter one. It is the ground *under* the
          floating header too: what scrolls beneath the header's blur shows
          this colour wherever no content has scrolled up into it yet. */}
      <SidebarInset className="relative flex h-full min-h-0 flex-col overflow-hidden bg-surface text-card-foreground">
        {/* Edge-to-edge: the header is an overlay spanning the whole top —
            the status bar's inset above its own row — transparent, with the
            same progressive blur the OS bar gets running down through it, so
            whatever scrolls up the column goes out of focus beneath it the
            way a native top bar does. The inset is padding *inside* it (the
            full inset, no hair — the blur owns the cutout), so its controls
            sit below the status bar while the blur spans both. Everything
            below pads by --app-header-h (the inset plus this row) at the
            point it owns its own scrolling, which is what lets content pass
            under: the padding sits inside each scroller and scrolls away
            with it. */}
        <header
          /* Named so the dock can *measure* it: how much of a panel this
             floating header actually covers is a question about where that
             panel is, and a constant answered it wrongly for every group that
             is not at the top (see `headerOverlap` in workspace/dock.tsx). */
          data-app-header
          data-drag-region
          /* `px-4` is the app's gutter — the transcript's own padding
             (thread-view) and the composer's — so the two controls that touch
             the edge here, the sidebar toggle and the ⋯ menu, stand on the
             same line the conversation under them does. The badges' `px-2` is
             the capsule's, and sits inside it. */
          /* `pointer-events-none`, with each occupant turning it back on: the
             header is a transparent overlay spanning the whole column, and its
             own box is nothing but the ground its capsules stand on plus the
             blur. Left live it swallows every press that lands between them —
             which, once a dock group stands in this row (`data-header-band`),
             is every tab in that group, and was already every attempt to select
             the first line of a transcript scrolled under it. */
          className="pointer-events-none absolute inset-x-0 top-0 z-30 flex h-[var(--app-header-h)] items-center gap-1 bg-transparent px-4 pt-[max(0px,env(safe-area-inset-top,0px))] sm:gap-2"
        >
          {/* The strip is taller than the row it sits in: the ramp's weakest
              end lands *below* the header rather than at its edge, so the line
              of text passing under it goes out of focus gradually instead of
              meeting a seam where the blur stops. `inset-x-0 top-0` and not
              `inset-0`, because the height is now the header's plus a tail and
              a bottom of 0 would be fighting it. */}
          {/* Lighter, and longer for being lighter. The component's default
              ramp doubles band by band to 64px, which is far past the point
              where text stops being text — the top of the strip was a smear,
              and a smear reads as a bug rather than as depth. This one climbs
              by about half again per band and tops out at 14px, the same
              `--app-blur` every other glass surface in the app uses, so the
              header belongs to the same material as the composer and the
              cards. Losing the heavy end costs nothing but the mush; the
              longer tail below the row is what does the actual work of taking
              a line out of focus before it reaches the chrome. */}
          <ProgressiveBlur
            position="top"
            height="calc(100% + 1rem)"
            blurLevels={[0.4, 0.8, 1.4, 2.2, 3.4, 5.4, 8.6, 14]}
            className="absolute inset-x-0 top-0 -z-10"
          />
          <SidebarTrigger className={cn(HEADER_CHIP, "pointer-events-auto shrink-0")} />
          <div className="flex min-w-0 flex-1 items-center justify-between gap-2 sm:gap-3">
            {/* Named, like the header itself, so the dock can measure it: a tab
                strip standing in this row has to reserve the width of whatever
                is above it, and that is a *rect*, not a constant — see
                `syncHeaderOverlap`. The toggle sits to the left of this box and
                needs no mark of its own: reserving up to this cluster's right
                edge clears it on the way. */}
            <div
              data-header-left
              className="pointer-events-auto flex min-w-0 items-center gap-1.5 sm:gap-2"
            >
              {loading ? (
                <Skeleton className="h-4 w-32" />
              ) : routeHeading ? (
                /* Every route page: the section it belongs to over its own
                   name, in the same two capsules the thread gets. */
                <HeaderHeading
                  crumb={routeHeading.crumb && <HeaderCrumb>{routeHeading.crumb}</HeaderCrumb>}
                  title={routeHeading.title}
                />
              ) : (
                /* A thread — where it runs above its own name, the way a
                   window says its folder over its file. As a breadcrumb the
                   project sat *in front of* the title, pushing the one thing
                   being read off to the right and hiding its own name below
                   `sm` to make room; over it, it always has room.

                   The profile is not here: the composer already names the
                   provider and the model it is about to send to, which is
                   where that answer is acted on. Saying it twice made the
                   header a list of properties rather than a place. */
                <HeaderHeading
                  /* No crumb: the project is named on the tab now, in front of
                     the thread's own title (`workspace/panel-tab`). It only
                     ever appeared on this route — the landing page has no
                     `active` — so what stood here is what moved there, rather
                     than a second copy of it three inches away. */
                  title={active?.title ?? "Daedalus"}
                  /* Only where the dock is mounted to say it instead — the
                     landing page has no tab strip, so its title is drawn. */
                  quiet={!!sessionId}
                  trailing={
                    /* A branch says where it came from, once, next to its own
                       name — the one thing provenance is for. Clicking goes to
                       the parent thread as it is now, not to the turn it was
                       cut at: the parent has kept moving, and a transcript
                       scroll target is the rail's business, not a link's. */
                    active &&
                    forkedFrom && (
                      <button
                        type="button"
                        title={`Open ${forkedFrom.title}`}
                        className={cn(
                          HEADER_BADGE,
                          "hidden min-w-0 shrink-0 items-center gap-1 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:flex"
                        )}
                        onClick={() => void navigate(threadPath(forkedFrom.id))}
                      >
                        <GitBranch className="size-3 shrink-0" />
                        <span className="max-w-[140px] truncate">{forkedFrom.title}</span>
                      </button>
                    )
                  }
                />
              )}
            </div>
            {/* Nothing on the right any more. The bell and the ⋯ menu are the
                app's own and stand in the sidebar header, which is on every
                route and never splits; the context ring is a reading of one
                thread and stands on that thread's tab. What is left of this
                row is the ground the tabs sit on — so a group in the band runs
                to the window's edge, with no `[data-header-right]` for
                `syncHeaderOverlap` to find and nothing to reserve. */}
          </div>
        </header>
        <Routes>
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
            {/* The overview: every section as a link, in the sidebar's groups. */}
            <Route index element={<SettingsOverviewPage />} />
            <Route path="general" element={<GeneralPage />} />
            <Route path="knowledge" element={<KnowledgePage />} />
            <Route path="appearance" element={<AppearancePage />} />
            <Route path="appearance/themes/:themeId" element={<ThemeEditorPage />} />
            <Route path="keyboard" element={<KeyboardPage />} />
            <Route path="notifications" element={<NotificationsPage />} />
            <Route path="projects" element={<ProjectsPage />} />
            <Route path="projects/:entryId" element={<ProjectFormPage />} />
            <Route path="mcp" element={<McpPage />} />
            <Route path="mcp/import" element={<McpImportPage />} />
            <Route path="mcp/:entryId" element={<McpFormPage />} />
            <Route path="skills" element={<SkillsPage />} />
            <Route path="skills/import" element={<SkillImportPage />} />
            <Route path="skills/:entryId" element={<SkillFormPage />} />
            <Route path="commands" element={<CommandsPage />} />
            <Route path="commands/import" element={<CommandImportPage />} />
            <Route path="commands/:entryId" element={<CommandFormPage />} />
            {/* No import route: nothing in the agents' own configs is a
                persona to import — see settings/personas.tsx. */}
            <Route path="personas" element={<PersonasPage />} />
            <Route path="personas/:entryId" element={<PersonaFormPage />} />
            <Route path="rules" element={<RulesPage />} />
            <Route path="model-prompts" element={<ModelPromptsPage />} />
            <Route path="model-prompts/:entryId" element={<ModelPromptFormPage />} />
            <Route path="profiles" element={<ProfilesPage />} />
            <Route path="profiles/:entryId" element={<ProfileFormPage />} />
            <Route path="agents" element={<AgentsPage />} />
            <Route path="usage" element={<QuotaPage />} />
            <Route path="web-search" element={<WebSearchPage />} />
            <Route path="backup" element={<BackupPage />} />
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
                    className={cn(
                      "mx-auto w-full px-4 pt-6 pb-16 sm:px-8",
                      settingsMaxWidth(location.pathname)
                    )}
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
              path, ahead of the transcript routes that would swallow it. */}
          <Route path="/t/:sessionId/trace" element={<TracePage />} />
          {/* Both thread routes render the same element so the dock (and every
              mounted transcript in it) survives switching between threads. */}
          <Route path="/t?/:sessionId?" element={threadMain} />
          <Route path="*" element={threadMain} />
        </Routes>
      </SidebarInset>
      <CommandPalette
        open={palette.open}
        onOpenChange={palette.setOpen}
        actions={actions}
        dock={dock}
        onNewThread={startThread}
        onNewProject={() => void navigate(settingsFormPath("projects"))}
        onImportThreads={() => setImporting(true)}
        onShortcuts={() => shortcuts.setOpen(true)}
      />
      <ShortcutsHelp open={shortcuts.open} onOpenChange={shortcuts.setOpen} />
      {/* Owned here rather than by the palette, which unmounts as soon as a
          command runs. The project page mounts its own, scoped to itself. */}
      <ImportThreadsDialog open={importing} onOpenChange={setImporting} actions={actions} />
    </SidebarProvider>
  )
}

/**
 * The header's title block — the one shape every route wears.
 *
 * One line: the crumb capsule, then the title capsule, then whatever belongs
 * beside the name. Every route used to write its own `Section › Title` run of
 * text, where the separator was a chevron and the crumb was the first casualty
 * of a narrow screen (`hidden sm:inline` on all six of them). As two capsules
 * they are separated by the gap between them, and each truncates on its own
 * rather than one of them disappearing — and both carry the frosted ground the
 * transparent header needs (see `lib/header-chrome`).
 *
 * The crumb is a node rather than a string because the thread's is a button
 * with its project's icon in it; the route pages hand over `HeaderCrumb`.
 */
function HeaderHeading({
  crumb,
  title,
  trailing,
  quiet,
}: {
  crumb?: React.ReactNode
  title: React.ReactNode
  /** After the title — the fork badge. */
  trailing?: React.ReactNode
  /**
   * Something else on this line already says the title — the dock's own tab,
   * which carries the same name with the panel's icon and its reading beside
   * it. Said twice, three inches apart, it read as two different things.
   *
   * The heading is *silenced*, not dropped: it is still the document's `h1`,
   * and a route whose only title is a `div` in a third-party tab strip has
   * none for a screen reader or the tab-order to land on.
   */
  quiet?: boolean
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-foreground sm:gap-2">
      {crumb}
      <h1
        className={
          quiet
            ? "sr-only"
            : cn(
                HEADER_BADGE,
                "min-w-0 truncate px-2 py-0.5 text-sm leading-tight font-medium text-foreground"
              )
        }
      >
        {title}
      </h1>
      {trailing}
    </div>
  )
}

/** A plain crumb capsule: the section a title lives in, for the routes whose
    crumb is a word rather than a thing you can open. */
function HeaderCrumb({ children }: { children: React.ReactNode }) {
  return <span className={cn(HEADER_BADGE, "min-w-0 truncate px-2 py-0.5")}>{children}</span>
}

/** Settings sections as sidebar nav — the app has no horizontal tabs. The
    first row is the overview (`/settings`), lit when no section is. */
function SettingsNav({
  section,
  onSelect,
  onOverview,
}: {
  section: SettingsSectionId | null
  onSelect: (id: SettingsSectionId) => void
  onOverview: () => void
}) {
  const { isMobile, setOpenMobile } = useSidebar()

  const select = (id: SettingsSectionId | null) => {
    if (isMobile) setOpenMobile(false)
    if (id) onSelect(id)
    else onOverview()
  }

  return (
    <>
      <SidebarGroup className={cn(TIER, GROUP)}>
        <SidebarGroupContent>
          <SidebarMenu className={MENU}>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="sm"
                tooltip={SETTINGS_OVERVIEW.label}
                isActive={section === null}
                onClick={() => select(null)}
                className={ROW}
              >
                <SETTINGS_OVERVIEW.icon className="size-4" />
                <span>All settings</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      {SETTINGS_NAV_GROUPS.map((group) => (
        <SidebarGroup key={group.label} className={cn(TIER, GROUP)}>
          <SidebarGroupLabel className={GROUP_LABEL}>{group.label}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className={MENU}>
              {SETTINGS_SECTIONS.filter((entry) =>
                group.sections.includes(entry.id)
              ).map((entry) => (
                <SidebarMenuItem key={entry.id}>
                  <SidebarMenuButton
                    size="sm"
                    tooltip={entry.label}
                    isActive={entry.id === section}
                    onClick={() => select(entry.id)}
                    className={ROW}
                  >
                    <entry.icon className="size-4" />
                    <span>{entry.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  )
}


/** No thread open: a short "what now" with the two setup paths. This is the
    landing page now — see components/landing/landing-page.tsx. The shell's
    contract with it is exactly the one EmptyState had: the loading gate, the
    "ready" flag, a thread starter and a settings opener. */
