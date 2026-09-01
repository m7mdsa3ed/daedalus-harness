import * as React from "react"
import { Check, ChevronDown, ChevronLeft, Plus, ServerIcon, Settings2 } from "lucide-react"
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
import { WorkspaceDock, useWorkspaceDock } from "@/components/workspace/dock"
import { ThreadHeaderMenu } from "@/components/thread-menu"
import { NotificationBell } from "@/components/notifications/bell"
import { NotificationsInboxPage } from "@/components/notifications/page"
import type { PanelKind } from "@/lib/workspace/panels"
import { openTerminal } from "@/components/workspace/terminal-panel"
import { RoutinesPage } from "@/components/routines-page"
import { SchedulePage } from "@/components/schedule-page"
import { TasksBoard } from "@/components/tasks-board"
import type { DockviewApi } from "dockview-react"
import { SetupCardsSkeleton, SidebarGroupsSkeleton } from "@/components/ui/skeletons"
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
  threadPath,
} from "@/lib/router"
import { consumeNewTab, markNewTab } from "@/lib/session-tabs"
import { useShortcut } from "@/hooks/use-hotkey"
import { KEYS } from "@/lib/shortcuts"
import { defaultsForProfile, loadThreadDefaults, resolveThreadStart } from "@/lib/thread-defaults"
import {
  loadServers,
  setActiveServer,
  type ServerSettings,
} from "@/lib/settings"
import { useStoreSelect } from "@/lib/store"
import { cn } from "@/lib/utils"
import { ProjectFormPage, ProjectsPage } from "@/components/settings/projects"
import { ProjectPage } from "@/components/project-page"
import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_SECTIONS,
  settingsMaxWidth,
  type SettingsSectionId,
} from "@/components/settings/sections"
import { SettingsLayout } from "@/components/settings/layout"
import { GeneralPage } from "@/components/settings/general"
import { KnowledgePage } from "@/components/settings/knowledge"
import { AppearancePage } from "@/components/settings/appearance"
import { KeyboardPage } from "@/components/settings/keyboard"
import { NotificationsPage } from "@/components/settings/notifications"
import { McpFormPage, McpImportPage, McpPage } from "@/components/settings/mcp"
import { SkillFormPage, SkillImportPage, SkillsPage } from "@/components/settings/skills"
import { CommandFormPage, CommandImportPage, CommandsPage } from "@/components/settings/commands"
import { PersonaFormPage, PersonasPage } from "@/components/settings/personas"
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

/** URL segment → a section that exists; anything else falls back to General. */
const sectionOf = (value: string): SettingsSectionId =>
  SETTINGS_SECTIONS.find((s) => s.id === value)?.id ?? "general"

export function AppShell({
  settings,
  actions,
  loading,
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
  const projects = useStoreSelect((state) => state.projects)
  const profiles = useStoreSelect((state) => state.profiles)
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
  const shortcuts = useShortcutsHelp()
  const [importing, setImporting] = React.useState(false)
  const inSettings = location.pathname.startsWith("/settings")
  const inSchedule = location.pathname.startsWith("/schedules")
  const inBoard = location.pathname.startsWith("/board")
  const inProject = location.pathname.startsWith("/projects")
  const inNotifications = location.pathname.startsWith("/notifications")
  const sessionId =
    inSettings || inSchedule || inBoard || inProject || inNotifications
      ? null
      : currentThreadId(location.pathname, location.search)
  const section = sectionOf(inSettings ? (location.pathname.split("/")[2] ?? "") : "")
  // Leaving settings returns to the thread it was opened from.
  const lastThread = React.useRef<string | null>(null)
  if (sessionId) lastThread.current = sessionId
  const active = sessions.find((s) => s.id === sessionId)
  const ready = !loading && projects.length > 0 && profiles.length > 0
  const dock = useWorkspaceDock()
  const routeSessionRef = React.useRef(sessionId)
  routeSessionRef.current = sessionId
  // The project the workspace panels act on: the routed thread's own.
  const activeProjectRef = React.useRef<string | null>(null)
  activeProjectRef.current = active?.projectId ?? null

  /* The route is the source of truth for the focused tab; each mounted chat owns
     its own ACP connection, so background tabs keep streaming while hidden. */
  React.useEffect(() => {
    if (!sessionId) return
    if (location.search) void navigate(threadPath(sessionId), { replace: true }) // legacy ?session=
    const meta = sessions.find((s) => s.id === sessionId)
    if (meta) {
      dock.openChat(sessionId, { newTab: consumeNewTab() })
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

  const openSettings = (next?: SettingsSectionId) =>
    void navigate(settingsPath(next ?? section))
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
    },
    [dock]
  )

  useShortcut("terminal", () => {
    openWorkspacePanel("terminal")
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
          onSearch={() => palette.setOpen(true)}
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
    <EmptyState
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
        paddingTop: "env(safe-area-inset-top, 0px)",
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
          <div data-drag-region className="flex items-center gap-2 px-1 group-data-[collapsible=icon]:px-0">
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
                <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-64">
                  {/* The known servers, active one ticked at the top; switching
                      is a full reload (`location.assign`) because threads, the
                      sockets and the whole store belong to one server.

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
                            window.location.assign("/")
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
          the card tone is the lighter one. The header below has no colour of
          its own, so it takes this one. */}
      <SidebarInset className="relative flex h-full min-h-0 flex-col overflow-hidden bg-surface text-card-foreground">
        {/* ponytail: no bg/blur/border — the header shares the inset surface, so
            under Electron vibrancy it shows the OS blur instead of its own band. */}
        <header
          data-drag-region
          className="relative z-30 flex h-12 shrink-0 items-center gap-1 bg-transparent px-2 sm:gap-2 sm:px-4"
        >
          <SidebarTrigger className="-ml-1 shrink-0" />
          <div className="flex min-w-0 flex-1 items-center justify-between gap-2 sm:gap-3">
            <div className="flex min-w-0 items-baseline gap-2">
              {loading ? (
                <Skeleton className="h-4 w-32" />
              ) : (
                <h1 className="truncate text-sm font-medium">
                  {inSettings
                    ? (SETTINGS_SECTIONS.find((s) => s.id === section)?.label ?? "Settings")
                    : inSchedule
                      ? (location.pathname.endsWith("/new") ? "New schedule" : "Schedules")
                      : inBoard
                        ? "Tasks"
                        : inNotifications
                          ? "Notifications"
                        : inProject
                          ? (projects.find(
                              (p) => p.id === location.pathname.split("/")[2]
                            )?.name ?? "Project")
                          : (active?.title ?? "Daedalus")}
                </h1>
              )}
              {inSettings ? (
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">Settings</span>
              ) : inSchedule ? (
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">Scheduled messages</span>
              ) : inBoard ? (
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">Board</span>
              ) : inNotifications ? (
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">Inbox</span>
              ) : inProject ? (
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">Project</span>
              ) : (
                active && (
                  <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:inline">
                    {/* The project name is the way to its page: the thread
                        header already names the workspace, so the name is the
                        link rather than one more control beside it. */}
                    <button
                      type="button"
                      className="rounded-sm underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => void navigate(projectPath(active.projectId))}
                    >
                      {projects.find((p) => p.id === active.projectId)?.name}
                    </button>
                    {" · "}
                    {profiles.find((p) => p.id === active.profileId)?.name}
                  </span>
                )
              )}
            </div>
            {/* The workspace's one entry point. In the header rather than on the
                tab strip: there is exactly one of it however the dock is split,
                and it survives a narrow screen, which is where it matters —
                nothing else on a phone can reach these panels or this thread's
                own actions. */}
            <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
              {/* The bell is on every route, which is the whole reason it moved
                  off the sidebar's nav: a count is only useful where it is
                  always in view, and in the collapsed rail it was a capsule
                  pinned to the corner of a row. The sidebar keeps the row —
                  it goes to the inbox page. */}
              <NotificationBell />
              {/* One menu, not three icons. It holds what the + held (new
                  thread, the workspace panels), what the eye held (view
                  settings) and what the routed thread can be asked to do —
                  Refresh first. Three targets in a 12px header is a row you
                  have to learn rather than read, and on a phone it is three
                  targets in the space of one. */}
              {!inSettings && !inSchedule && !inBoard && !inProject && !inNotifications && (
                <ThreadHeaderMenu
                  actions={actions}
                  session={active}
                  onNewTab={newThreadInTab}
                  onOpenPanel={openWorkspacePanel}
                />
              )}
            </div>
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
            <Route index element={<Navigate to="general" replace />} />
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
            <Route path="profiles" element={<ProfilesPage />} />
            <Route path="profiles/:entryId" element={<ProfileFormPage />} />
            <Route path="agents" element={<AgentsPage />} />
            <Route path="usage" element={<QuotaPage />} />
            <Route path="web-search" element={<WebSearchPage />} />
            <Route path="backup" element={<BackupPage />} />
            {/* /settings/<unknown> — the sidebar still needs a page to light up. */}
            <Route path="*" element={<Navigate to="/settings/general" replace />} />
          </Route>
          {/* /schedules is the list, /schedules/new the creation form — one
              component reads the path (see SchedulePage). */}
          {["/schedules", "/schedules/new"].map((path) => (
            <Route
              key={path}
              path={path}
              element={
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-16 sm:px-8">
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
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <div
                    className={cn(
                      "mx-auto w-full px-4 pt-6 pb-16 sm:px-8",
                      settingsMaxWidth(location.pathname)
                    )}
                  >
                    <RoutinesPage actions={actions} settings={settings} />
                  </div>
                </div>
              }
            />
          ))}
          {/* The inbox as a place — the header's bell is the glance at it. */}
          <Route
            path="/notifications"
            element={
              <div className="min-h-0 flex-1 overflow-y-auto">
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
          <Route
            path="/board"
            element={
              <div className="flex min-h-0 flex-1 flex-col">
                <TasksBoard settings={settings} />
              </div>
            }
          />
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

/** Settings sections as sidebar nav — the app has no horizontal tabs. */
function SettingsNav({
  section,
  onSelect,
}: {
  section: SettingsSectionId
  onSelect: (id: SettingsSectionId) => void
}) {
  const { isMobile, setOpenMobile } = useSidebar()

  const select = (id: SettingsSectionId) => {
    if (isMobile) setOpenMobile(false)
    onSelect(id)
  }

  return (
    <>
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


/** No thread open: a short "what now" with the two setup paths. */
function EmptyState({
  loading,
  ready,
  onNewThread,
  onOpenSettings,
}: {
  loading: boolean
  ready: boolean
  onNewThread: () => void
  onOpenSettings: (section?: SettingsSectionId) => void
}) {
  const projects = useStoreSelect((state) => state.projects)
  const profiles = useStoreSelect((state) => state.profiles)
  const steps = [
    {
      id: "projects" as const,
      title: "Projects",
      description: "Where a thread runs: directory, MCPs, skills.",
      count: projects.length,
    },
    {
      id: "profiles" as const,
      title: "Profiles",
      description: "What a thread runs: agent runtime, credentials, models.",
      count: profiles.length,
    },
  ]

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
        <div aria-busy="true" className="w-full max-w-md text-center">
          <Skeleton className="mx-auto size-11 rounded-lg" />
          <Skeleton className="mx-auto mt-4 h-5 w-40" />
          <Skeleton className="mx-auto mt-2 h-3 w-72" />
          <Skeleton className="mx-auto mt-6 h-7 w-28 rounded-md" />
          <SetupCardsSkeleton />
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-md text-center">
        <Logo className="mx-auto size-11" />
        <h2 className="mt-4 text-lg font-semibold tracking-tight">
          {ready ? "Start a thread" : "Finish the setup"}
        </h2>
        <p className="mt-1.5 text-sm text-balance text-muted-foreground">
          {ready
            ? "Pick a project and a profile — the harness spawns the agent and streams it here."
            : "A thread needs one project and one profile before it can run."}
        </p>
        <div className="mt-5 flex justify-center">
          <Button onClick={ready ? () => onNewThread() : () => onOpenSettings("projects")}>
            {ready ? (
              <>
                <Plus className="size-4" /> New thread
              </>
            ) : (
              <>
                <Settings2 className="size-4" /> Open settings
              </>
            )}
          </Button>
        </div>
        <div className="mt-8 grid gap-2 text-left sm:grid-cols-2">
          {steps.map((step) => (
            <button
              key={step.id}
              type="button"
              onClick={() => onOpenSettings(step.id)}
              className="rounded-xl border bg-card p-3 text-left transition-colors hover:border-ring/50 hover:bg-accent/40"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{step.title}</span>
                <span
                  className={cn(
                    "rounded-md px-1.5 py-0.5 font-mono text-[11px] tabular-nums",
                    step.count ? "bg-muted text-muted-foreground" : "bg-destructive/10 text-destructive"
                  )}
                >
                  {step.count}
                </span>
              </div>
              <p className="mt-1 text-xs text-pretty text-muted-foreground">{step.description}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

