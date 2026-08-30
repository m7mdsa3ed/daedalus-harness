import * as React from "react"
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Link as LinkIcon,
  MoreVertical,
  Pin,
  PinOff,
  SearchIcon,
  FolderIcon,
  Check,
  ChevronsUpDown,
  Clock,
  ExternalLink,
  LogOut,
  Plus,
  ServerIcon,
  Settings2,
  SquareKanban,
  Trash2,
  Undo2,
} from "lucide-react"
import { toast } from "sonner"
import { reportError } from "@/lib/errors"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { CommandPalette, useCommandPalette } from "@/components/command-palette"
import { ShortcutsHelp, useShortcutsHelp } from "@/components/shortcuts-help"
import { Logo } from "@/components/ui/logo"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import { AgentIcon } from "@/components/agent-icon"
import { WorkspaceDock, useWorkspaceDock } from "@/components/workspace/dock"
import { OpenPanelMenu } from "@/components/workspace/open-panel-menu"
import { panelId, type PanelKind } from "@/lib/workspace/panels"
import { openTerminal } from "@/components/workspace/terminal-panel"
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
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import type { Actions } from "@/lib/actions"
import { useConfirm } from "@/components/confirm-dialog"
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router"
import {
  boardPath,
  currentThreadId,
  NavigationBridge,
  schedulePath,
  settingsFormPath,
  settingsPath,
  threadPath,
} from "@/lib/router"
import { consumeNewTab, markNewTab } from "@/lib/session-tabs"
import {
  ItemContextMenu,
  renderMenuItems,
  type MenuItemSpec,
} from "@/components/item-context-menu"
import { useHotkey } from "@/hooks/use-hotkey"
import { togglePin, usePins } from "@/lib/pins"
import { KEYS } from "@/lib/shortcuts"
import { teardownPush } from "@/lib/push"
import { defaultsForProfile, loadThreadDefaults } from "@/lib/thread-defaults"
import {
  loadServers,
  removeServer,
  setActiveServer,
  type ServerSettings,
  type SessionMeta,
} from "@/lib/settings"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { ProjectFormPage, ProjectsPage } from "@/components/settings/projects"
import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "@/components/settings/sections"
import { SettingsLayout } from "@/components/settings/layout"
import { GeneralPage } from "@/components/settings/general"
import { AppPage } from "@/components/settings/app"
import { AppearancePage } from "@/components/settings/appearance"
import { NotificationsPage } from "@/components/settings/notifications"
import { McpFormPage, McpImportPage, McpPage } from "@/components/settings/mcp"
import { SkillFormPage, SkillImportPage, SkillsPage } from "@/components/settings/skills"
import { CommandFormPage, CommandImportPage, CommandsPage } from "@/components/settings/commands"
import { ProfileFormPage, ProfilesPage } from "@/components/settings/profiles"
import { AgentsPage } from "@/components/settings/agents"
import { WebSearchPage } from "@/components/settings/web-search"
import { ThemeEditorPage } from "@/components/theme-builder"

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
  const { state } = useStore()
  const location = useLocation()
  const navigate = useNavigate()
  // Sidebar width overrides the shadcn default via the same CSS var it reads.
  const [sidebarWidth, setSidebarWidth] = React.useState(
    () => localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? SIDEBAR_WIDTH_DEFAULT
  )
  const [resizing, setResizing] = React.useState(false)
  const palette = useCommandPalette()
  const shortcuts = useShortcutsHelp()
  const inSettings = location.pathname.startsWith("/settings")
  const inSchedule = location.pathname.startsWith("/schedules/")
  const inBoard = location.pathname.startsWith("/board")
  const sessionId =
    inSettings || inSchedule || inBoard ? null : currentThreadId(location.pathname, location.search)
  const section = sectionOf(inSettings ? (location.pathname.split("/")[2] ?? "") : "")
  // Leaving settings returns to the thread it was opened from.
  const lastThread = React.useRef<string | null>(null)
  if (sessionId) lastThread.current = sessionId
  const active = state.sessions.find((s) => s.id === sessionId)
  const ready = !loading && state.projects.length > 0 && state.profiles.length > 0
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
    const meta = state.sessions.find((s) => s.id === sessionId)
    if (meta) {
      dock.openChat(sessionId, { newTab: consumeNewTab() })
      return
    }
    /* A route for a thread nobody knows about: an unsent draft after a reload
       (they only ever lived in the tab that made them) or one since purged.
       Either way an empty thread on that id beats a dead end — and if it is
       sent, the id in the URL bar is the id the server gets. Gated on `ready`
       so this cannot fire before bootstrap has filled state.sessions in. */
    if (!ready) return
    const defaults = loadThreadDefaults()
    const project = state.projects.find((p) => p.id === defaults.projectId) ?? state.projects[0]
    const profile = state.profiles.find((p) => p.id === defaults.profileId) ?? state.profiles[0]
    if (!project || !profile) return
    actions.newDraftThread({
      project,
      profile,
      ...defaultsForProfile(defaults, profile.id),
      id: sessionId,
    })
  }, [sessionId, state.sessions, state.projects, state.profiles, ready, actions, dock])

  React.useEffect(() => {
    if (loading) return
    dock.prunePanels({
      sessions: state.sessions.map((session) => session.id),
      projects: state.projects.map((project) => project.id),
    })
  }, [loading, state.sessions, state.projects, dock])

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
  useHotkey(KEYS.newThread, (event) => {
    event.preventDefault()
    startThreadRef.current()
  })

  const openSettings = (next?: SettingsSectionId) =>
    void navigate(settingsPath(next ?? section))
  /* A new thread is a route change, not a round trip: mint the id, put a draft
     row in the store and navigate. Nothing is created on the server and no
     agent is spawned until the first message — see actions.newDraftThread. The
     agent/profile/model picker moved onto the composer of the empty thread,
     which is where the choice is actually about to matter. */
  const startThread = () => {
    if (!ready) return openSettings("projects")
    const defaults = loadThreadDefaults()
    const project = state.projects.find((p) => p.id === defaults.projectId) ?? state.projects[0]
    const profile = state.profiles.find((p) => p.id === defaults.profileId) ?? state.profiles[0]
    if (!project || !profile) return openSettings("projects")
    const id = actions.newDraftThread({
      project,
      profile,
      ...defaultsForProfile(defaults, profile.id),
    })
    void navigate(threadPath(id))
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
      if (kind === "editor") {
        // No quick-open index yet; the explorer is where you pick a file.
        dock.openPanel({ kind: "explorer", projectId }, { direction: "left" })
        return
      }
      if (kind === "web") {
        dock.openPanel(
          { kind: "web", trust: "project", projectId, viewId: "default" },
          { direction: "right" }
        )
        return
      }
      if (kind === "ide") {
        /* Centre, not a side rail: it is a whole editor, and a full VS Code in
           a 280px column is not a workspace. It also does not toggle — closing
           the panel would leave the server process running with nothing on
           screen saying so, and reopening it is a fresh iframe load of an
           entire IDE. Focus what is there instead. */
        dock.openPanel({ kind: "ide", projectId })
        return
      }
      const descriptor =
        kind === "explorer"
          ? ({ kind: "explorer", projectId } as const)
          : kind === "source-control"
            ? ({ kind: "source-control", projectId } as const)
            : ({ kind: "output", projectId } as const)
      const id = panelId(descriptor)
      if (dock.isPanelOpen(id)) void dock.closePanel(id)
      else dock.openPanel(descriptor, { direction: kind === "output" ? "below" : "left" })
    },
    [dock]
  )

  useHotkey(KEYS.explorer, (event) => {
    event.preventDefault()
    openWorkspacePanel("explorer")
  })
  useHotkey(KEYS.sourceControl, (event) => {
    event.preventDefault()
    openWorkspacePanel("source-control")
  })
  useHotkey(KEYS.output, (event) => {
    event.preventDefault()
    openWorkspacePanel("output")
  })
  useHotkey(KEYS.terminal, (event) => {
    event.preventDefault()
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
      // No action here: New thread now lives in the sidebar header, and the
      // thread list starts directly under it. `New project` stays reachable
      // from /settings/projects and the command palette.
      body: loading ? <SidebarGroupsSkeleton /> : <ThreadGroups actions={actions} />,
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
              className="flex shrink-0 items-center gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Logo className="size-7 shrink-0" />
              <span className="brand-script text-xl leading-none group-data-[collapsible=icon]:hidden">
                Daedalus
              </span>
            </button>
            {/* New thread lives here, compact and with the brand — the one
                create affordance, beside search and the same ⌘N the palette
                advertises. Hidden when collapsed, like search. */}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => startThreadRef.current()}
              title="New thread (⌘N)"
              className="ml-auto shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden"
            >
              <Plus />
              <span className="sr-only">New thread</span>
            </Button>
            {/* Search sits with the brand, not in the thread header: it searches
                the whole app, so it belongs to the app's corner. */}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => palette.setOpen(true)}
              title="Search threads and commands (⌘K)"
              className="shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden"
            >
              <SearchIcon />
              <span className="sr-only">Search threads and commands</span>
            </Button>
          </div>
        </SidebarHeader>
        <SidebarContent className="gap-0">
          {panel.back ? (
            <SidebarGroup className="px-2 py-1">
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton tooltip={panel.back.label} onClick={panel.back.onClick}>
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
        <SidebarFooter className="p-3 group-data-[collapsible=icon]:p-2">
          <SidebarMenu>
            <ServerSwitcher settings={settings} onAddServer={onAddServer} />
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Tasks board"
                isActive={inBoard}
                onClick={() => void navigate(boardPath())}
              >
                <SquareKanban className="size-4" />
                <span>Tasks</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Settings"
                isActive={inSettings}
                onClick={() => openSettings()}
              >
                <Settings2 className="size-4" />
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
      <SidebarInset className="relative flex h-full min-h-0 flex-col overflow-hidden">
        {/* ponytail: no bg/blur/border — the header shares the inset surface, so
            under Electron vibrancy it shows the OS blur instead of its own band. */}
        <header
          data-drag-region
          className="relative z-30 flex h-12 shrink-0 items-center gap-1 bg-transparent px-2 sm:gap-2 sm:px-4"
        >
          <SidebarTrigger className="-ml-1 shrink-0" />
          <Separator orientation="vertical" className="mr-1 h-full shrink-0 sm:mr-2" />
          <div className="flex min-w-0 flex-1 items-center justify-between gap-2 sm:gap-3">
            <div className="flex min-w-0 items-baseline gap-2">
              {loading ? (
                <Skeleton className="h-4 w-32" />
              ) : (
                <h1 className="truncate text-sm font-medium">
                  {inSettings
                    ? (SETTINGS_SECTIONS.find((s) => s.id === section)?.label ?? "Settings")
                    : inSchedule
                      ? "New schedule"
                      : inBoard
                        ? "Tasks"
                        : (active?.title ?? "Daedalus")}
                </h1>
              )}
              {inSettings ? (
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">Settings</span>
              ) : inSchedule ? (
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">Scheduled messages</span>
              ) : inBoard ? (
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">Board</span>
              ) : (
                active && (
                  <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:inline">
                    {state.projects.find((p) => p.id === active.projectId)?.name}
                    {" · "}
                    {state.profiles.find((p) => p.id === active.profileId)?.name}
                  </span>
                )
              )}
            </div>
            {/* The workspace's one entry point. In the header rather than on the
                tab strip: there is exactly one of it however the dock is split,
                and it survives a narrow screen, which is where it matters —
                nothing else on a phone can reach these panels. */}
            {!inSettings && !inSchedule && !inBoard && (
              <OpenPanelMenu
                onNewTab={newThreadInTab}
                onOpen={openWorkspacePanel}
                canOpenPanels={!!active}
              />
            )}
          </div>
        </header>
        <Routes>
          <Route
            path="/settings"
            element={<SettingsLayout settings={settings} actions={actions} loading={loading} />}
          >
            <Route index element={<Navigate to="general" replace />} />
            <Route path="general" element={<GeneralPage />} />
            <Route path="app" element={<AppPage />} />
            <Route path="appearance" element={<AppearancePage />} />
            <Route path="appearance/themes/:themeId" element={<ThemeEditorPage />} />
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
            <Route path="profiles" element={<ProfilesPage />} />
            <Route path="profiles/:entryId" element={<ProfileFormPage />} />
            <Route path="agents" element={<AgentsPage />} />
            <Route path="web-search" element={<WebSearchPage />} />
            {/* /settings/<unknown> — the sidebar still needs a page to light up. */}
            <Route path="*" element={<Navigate to="/settings/general" replace />} />
          </Route>
          <Route
            path="/schedules/new"
            element={
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-16 sm:px-8">
                  <SchedulePage actions={actions} />
                </div>
              </div>
            }
          />
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
        onShortcuts={() => shortcuts.setOpen(true)}
      />
      <ShortcutsHelp open={shortcuts.open} onOpenChange={shortcuts.setOpen} />
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
        <SidebarGroup key={group.label} className="px-2 py-1">
          <SidebarGroupLabel className={GROUP_LABEL}>{group.label}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {SETTINGS_SECTIONS.filter((entry) =>
                group.sections.includes(entry.id)
              ).map((entry) => (
                <SidebarMenuItem key={entry.id}>
                  <SidebarMenuButton
                    tooltip={entry.label}
                    isActive={entry.id === section}
                    onClick={() => select(entry.id)}
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


/* ── Sidebar thread list ──
   Three tiers, and a thread appears in exactly one of them:

     Pinned   the ones you said matter, from every project
     Recent   the newest of what is left, project-agnostic
     <project>  everything older, grouped by where it runs
     Trash    deleted, still recoverable — last, folded shut, and only when it
              has something in it

   Recent exists because the thing you want next is almost always the thing you
   touched last, and hunting for it inside a project group costs a scan. Older
   work is the opposite — you look for it by *where* it was, so it stays
   grouped. Pins live on this device (lib/pins); the harness's session list is
   shared, and one person pinning a thread should not reorder anyone else's
   sidebar. */

/* Group titles, not rows. A label used to be the same size, weight and colour
   as the threads under it, so "Recent" scanned as a thread called Recent.
   Smaller, uppercase, tracked out, and darker than the rows beneath — /80 over
   the sidebar surface keeps it legible while the rows stay full-strength.
   Shared by every sidebar group so the whole panel has one title voice: one
   neutral, no per-group accents — wayfinding comes from position and the
   chevron, not from colour or icons. */
const GROUP_LABEL =
  "flex h-6 gap-1.5 px-2 text-[11px] font-bold tracking-[0.06em] uppercase text-sidebar-foreground/80"

const RECENT_COUNT = 6

/** Rows a long-tail group (a project, Trash) shows before its "Show more". */
const PROJECT_PAGE_SIZE = 5

function ThreadGroups({ actions }: { actions: Actions }) {
  const { state } = useStore()
  const pins = usePins()

  // Deleting is reversible, so a deleted thread leaves the tiers above but not
  // the sidebar: it drops into Trash until it is restored or purged.
  const live = state.sessions.filter((session) => !session.deletedAt)
  const trashed = state.sessions
    .filter((session) => !!session.deletedAt)
    .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))

  if (state.sessions.length === 0) {
    return (
      <SidebarGroup className="px-2 py-0">
        <SidebarGroupLabel className={GROUP_LABEL}>Threads</SidebarGroupLabel>
        <SidebarGroupContent>
          <p className="px-2 py-4 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
            No threads yet.
          </p>
        </SidebarGroupContent>
      </SidebarGroup>
    )
  }

  const newestFirst = [...live].sort((a, b) => b.createdAt - a.createdAt)
  // Pinned keeps the order pins were added in, not the order threads were
  // created: the group you built by hand should stay where you put it.
  const pinned = pins
    .map((id) => newestFirst.find((session) => session.id === id))
    .filter((session): session is SessionMeta => !!session)
  const rest = newestFirst.filter((session) => !pins.includes(session.id))
  const recent = rest.slice(0, RECENT_COUNT)
  const older = rest.slice(RECENT_COUNT)

  const byProject = new Map<string, SessionMeta[]>()
  for (const session of older) {
    const list = byProject.get(session.projectId) ?? []
    list.push(session)
    byProject.set(session.projectId, list)
  }

  /* Projects are the long tail — there can be many, and you are usually only
     interested in one. No count on the label: the number of old threads in a
     project is not a thing anyone acts on, and it competed with the disclosure
     arrow for the same corner. */
  const projectGroup = (projectId: string, sessions: SessionMeta[]) => (
    <FoldableGroup
      key={projectId}
      groupKey={projectId}
      icon={<FolderIcon className="size-3 shrink-0" />}
      label={state.projects.find((p) => p.id === projectId)?.name ?? "Other"}
    >
      <ThreadList sessions={sessions} actions={actions} limit={PROJECT_PAGE_SIZE} />
    </FoldableGroup>
  )

  return (
    <>
      {/* Every tier folds now — the sidebar is one uniform two-level tree of
          items and their subitems, and fold state is remembered per tier. */}
      {pinned.length > 0 && (
        <FoldableGroup
          groupKey="__pinned"
          label="Pinned"
          icon={<Pin className="size-3 shrink-0" />}
          count={pinned.length}
        >
          <ThreadList sessions={pinned} actions={actions} />
        </FoldableGroup>
      )}
      <ScheduledGroup actions={actions} />
      {recent.length > 0 && (
        <FoldableGroup
          groupKey="__recent"
          label="Recent"
          icon={<Clock className="size-3 shrink-0" />}
          count={recent.length}
        >
          <ThreadList sessions={recent} actions={actions} />
        </FoldableGroup>
      )}
      {[...byProject.entries()].map(([projectId, sessions]) =>
        projectGroup(projectId, sessions)
      )}
      {/* Trash folds, and folds shut by default: it is where things go, not
          where anyone works, and an install that deletes a lot of threads used
          to end up scrolling past all of them to reach nothing. */}
      {trashed.length > 0 && (
        <FoldableGroup
          groupKey="__trash"
          label="Trash"
          icon={<Trash2 className="size-3 shrink-0" />}
          count={trashed.length}
          defaultOpen={false}
        >
          <ThreadList sessions={trashed} actions={actions} trash limit={PROJECT_PAGE_SIZE} />
          <EmptyTrash sessions={trashed} actions={actions} />
        </FoldableGroup>
      )}
    </>
  )
}

/** Relative time for a thread row: "just now", "5m", "2h", "3d", else a short
    date. Nothing counts as a date prettier than the scannable index needs. */
function timeAgo(ts: number): string {
  const elapsed = Date.now() - ts
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (elapsed < minute) return "just now"
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m`
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h`
  if (elapsed < 7 * day) return `${Math.floor(elapsed / day)}d`
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** "In 3 days" / "every day" style line for a schedule. */
function scheduleWhen(nextAt: number, everyMs: number | null): string {
  const when = new Date(nextAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
  if (everyMs === null) return when
  const every =
    everyMs >= 7 * 24 * 60 * 60_000
      ? `${Math.round(everyMs / (7 * 24 * 60 * 60_000))} week(s)`
      : everyMs >= 24 * 60 * 60_000
        ? `${Math.round(everyMs / (24 * 60 * 60_000))} day(s)`
        : everyMs >= 60 * 60_000
          ? `${Math.round(everyMs / (60 * 60_000))} hour(s)`
          : `${Math.round(everyMs / 60_000)} min`
  return `${when} · every ${every}`
}

/** Upcoming prompts the server will deliver even with no browser open. Lives
    in the main sidebar, not settings: a schedule is something you watch for —
    it names the thread it will land in, so its row opens that thread. The
    group shows even when empty — a section that hides itself when there is
    nothing in it is also the one place nobody can find to create the first
    item — with the + on the label reusing the thread dialog and its picker,
    which is why it needs a live thread to exist at all. */
function ScheduledGroup({ actions }: { actions: Actions }) {
  const { state } = useStore()
  const navigate = useNavigate()
  const location = useLocation()
  const { isMobile, setOpenMobile } = useSidebar()
  const confirm = useConfirm()

  /* The picker offers the threads a schedule can legally target — the same
     set the old settings page offered. A draft has no server row to schedule
     against (createSchedule materializes it, but a picker row for a half
     written thread is a promise about a thread nobody has seen). */
  const live = state.sessions.filter((s) => !s.draft && !s.deletedAt)

  const cancel = async (id: string) => {
    if (
      !(await confirm({
        title: "Cancel this scheduled message?",
        destructive: true,
        confirmLabel: "Cancel schedule",
      }))
    )
      return
    actions.cancelSchedule(id).catch((err) => reportError(err, "Couldn't cancel the schedule"))
  }

  const open = (sessionId: string) => {
    if (isMobile) setOpenMobile(false)
    void navigate(threadPath(sessionId))
  }

  const titleOf = (sessionId: string) =>
    state.sessions.find((s) => s.id === sessionId)?.title ?? "Unknown thread"

  return (
      <FoldableGroup
        groupKey="__scheduled"
        label="Scheduled"
        icon={<CalendarClock className="size-3 shrink-0" />}
        count={state.scheduled.length > 0 ? state.scheduled.length : undefined}
        action={
          live.length > 0 && (
            <button
              type="button"
              title="New schedule"
              onClick={() => void navigate(schedulePath(live[0].id), {
                state: { returnTo: location.pathname + location.search },
              })}
              className="grid size-4 place-items-center rounded-sm text-muted-foreground transition-colors hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus className="size-3.5" />
              <span className="sr-only">New schedule</span>
            </button>
          )
        }
      >
        {state.scheduled.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
            {live.length > 0
              ? "Nothing scheduled. + adds a prompt the server sends later."
              : "Nothing scheduled — open a thread first."}
          </p>
        ) : (
          <SidebarMenu>
          {state.scheduled.map((item) => (
            <SidebarMenuItem key={item.id}>
              <SidebarMenuButton
                tooltip={`${titleOf(item.sessionId)} — ${scheduleWhen(item.nextAt, item.everyMs)}`}
                onClick={() => open(item.sessionId)}
                className="h-auto min-h-7 px-2 py-1"
              >
                {/* Two lines, because the message is the schedule's payload:
                    a row that showed only the thread could not tell two
                    schedules apart. The title line carries the thread, the
                    muted line carries what will be said, and when. */}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] leading-tight">{titleOf(item.sessionId)}</span>
                  <span className="block truncate text-[10px] leading-tight text-muted-foreground">
                    {item.text} · {scheduleWhen(item.nextAt, item.everyMs)}
                  </span>
                </span>
              </SidebarMenuButton>
              <SidebarMenuAction
                showOnHover
                title="Cancel schedule"
                onClick={() => void cancel(item.id)}
              >
                <Trash2 />
                <span className="sr-only">Cancel schedule</span>
              </SidebarMenuAction>
            </SidebarMenuItem>
          ))}
          </SidebarMenu>
        )}
      </FoldableGroup>
  )
}

/* Which groups are folded, on this device. One list for every foldable group —
   a project is keyed by its id, Trash by a name no project can have — so the
   sidebar has one fold memory rather than one per kind of group. The key is
   the old projects one: a group that was folded before this list grew stays
   folded. */
const COLLAPSED_KEY = "ui.collapsedProjects"

function collapsedGroups(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as unknown
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}

function rememberFold(key: string, open: boolean, defaultOpen: boolean) {
  /* Only the *departure* from the default is stored, so a group that defaults
     closed (Trash) does not need a row in the list to stay closed — and one
     that defaults open does not need one to stay open. */
  const collapsed = collapsedGroups().filter((id) => id !== key)
  if (open !== defaultOpen) collapsed.push(key)
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed))
  } catch {
    // A forgotten fold is not worth throwing out of a click handler.
  }
}

/** A foldable sidebar group. Open/closed is remembered per key. */
function FoldableGroup({
  groupKey,
  label,
  icon,
  count,
  defaultOpen = true,
  action,
  children,
}: {
  groupKey: string
  label: string
  icon?: React.ReactNode
  /** Printed next to the label when the number is something you act on. */
  count?: number
  /** Trash defaults closed: it is a place things go, not a place you work. */
  defaultOpen?: boolean
  /** A control that belongs to the group itself, not to a row in it — the
      Scheduled group's "+ new". Rendered over the chevron and only on hover:
      it cannot live inside the label, because the label is the fold trigger
      and a button in a button folds and fires at once. */
  action?: React.ReactNode
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(
    () => collapsedGroups().includes(groupKey) !== defaultOpen
  )

  const toggle = (next: boolean) => {
    setOpen(next)
    rememberFold(groupKey, next, defaultOpen)
  }

  return (
    <Collapsible open={open} onOpenChange={toggle}>
      {/* mt-4: generous separation between tiers — a collapsed label next to an
          expanded group needs a clear gap of its own, or two groups read as
          one. The label's own py carries the inner spacing. */}
      <SidebarGroup className="mt-4 px-2 py-0">
        {/* Scoped to the label row, not the whole group: hovering a row ten
            threads deep must not rearrange the header you can no longer see. */}
        {action && (
          <div className="absolute top-1 right-2 z-10 flex opacity-0 transition-opacity duration-150 group-hover/label:opacity-100 focus-within:opacity-100 group-data-[collapsible=icon]:hidden">
            {action}
          </div>
        )}
        <CollapsibleTrigger
          render={
            <SidebarGroupLabel
              className={cn(GROUP_LABEL, "group/label hover:text-sidebar-foreground/70")}
            />
          }
        >
          {icon}
          <span className="truncate">{label}</span>
          {count != null && (
            <span className="ml-auto tabular-nums opacity-70">{count}</span>
          )}
          <ChevronRight
            aria-hidden
            className={cn(
              "shrink-0 transition-[transform,opacity] duration-200",
              count == null && "ml-auto",
              action && "group-hover/label:opacity-0",
              open && "rotate-90"
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="harness-collapse">
          <SidebarGroupContent>{children}</SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  )
}

/** The one action that belongs to the Trash rather than to a thread in it.
    It sits at the foot of the list, not on the group label: the label is a
    disclosure trigger, and a destructive button inside a trigger is a click
    away from being hit by someone who only meant to fold the group. */
function EmptyTrash({ sessions, actions }: { sessions: SessionMeta[]; actions: Actions }) {
  const confirm = useConfirm()
  const [busy, setBusy] = React.useState(false)

  const empty = async () => {
    if (
      !(await confirm({
        title: sessions.length === 1 ? "Empty the Trash?" : `Delete ${sessions.length} threads forever?`,
        description:
          "The harness forgets them. Only each agent's own transcript file would still have the conversation.",
        confirmLabel: "Delete forever",
        destructive: true,
      }))
    )
      return
    setBusy(true)
    /* One at a time: purgeThread refreshes the session list after each, and a
       parallel burst would have several refreshes racing to describe a list
       that is still changing. There are never many. */
    try {
      for (const session of sessions) await actions.purgeThread(session.id)
    } catch (err) {
      reportError(err, "Couldn't empty the Trash")
    } finally {
      setBusy(false)
    }
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={empty}
          disabled={busy}
          tooltip="Delete every thread in the Trash"
          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="size-4" />
          <span className="truncate">{busy ? "Emptying…" : "Empty Trash"}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

function ThreadList({
  sessions,
  actions,
  trash = false,
  limit,
}: {
  sessions: SessionMeta[]
  actions: Actions
  /** Rendering the Trash group: these threads are deleted, so the row restores
      instead of opening and the menu offers the two ways back out. */
  trash?: boolean
  /** Show this many rows and a "Show more" toggle under them, instead of the
      whole list. For the long tail — a project with last winter's threads in
      it — not for Pinned or Recent, which are short by construction. */
  limit?: number
}) {
  /* Expansion is deliberately not persisted: the reveal answers "is what I am
     looking for down there?" and the answer resets the next visit, the same
     way the fold defaults do. */
  const [expanded, setExpanded] = React.useState(false)
  const visible = limit && !expanded ? sessions.slice(0, limit) : sessions
  const hidden = sessions.length - visible.length
  const { state } = useStore()
  const location = useLocation()
  const navigate = useNavigate()
  const activeThreadId = currentThreadId(location.pathname, location.search)
  const confirm = useConfirm()
  const pins = usePins()
  const { isMobile, setOpenMobile } = useSidebar()
  /* The live thread is the truth about a running turn: SessionMeta.promptActive
     is a server snapshot refetched only on bootstrap and on mutations, so on
     its own it never lights up mid-turn. Fall back to it for threads this
     client has not connected yet — for those it is the only signal there is. */
  const running = (session: SessionMeta) =>
    state.threads[session.id]?.turnActive ?? session.promptActive
  /* A thread is waiting on you when the agent has raised a question
     (elicitation) or an approval (permission) that is still open. Both live
     only on a thread this client has connected — there is no server snapshot
     for the same reason `promptActive` is only a running hint — so this is
     best-effort and correct whenever a tab has the thread open. */
  const waiting = (session: SessionMeta) => {
    const thread = state.threads[session.id]
    return !!thread && (!!thread.permission || !!thread.elicitation)
  }
  const projectNameOf = (projectId: string) =>
    state.projects.find((p) => p.id === projectId)?.name ?? "Other"

  /* Delete stops the agent and moves the thread to Trash. Recoverable, but not
     free — the process dies and a running turn dies with it — so it asks, and
     the toast still offers the one-click way back. Purge asks its own,
     harder question. */
  const remove = async (session: SessionMeta) => {
    /* A draft was never started: no process to stop, no server row, and nothing
       for Trash to hold. Discarding it is the whole operation — promising an
       Undo here would offer a button that cannot work. */
    if (session.draft) {
      if (
        !(await confirm({
          title: "Discard this thread?",
          description:
            "It was never started, so there is no agent to stop and nothing to restore afterwards.",
          confirmLabel: "Discard",
          destructive: true,
        }))
      )
        return
      if (activeThreadId === session.id) {
        void navigate("/")
      }
      void actions.deleteThread(session.id)
      return
    }
    if (
      !(await confirm({
        title: `Delete "${session.title}"?`,
        description:
          "The agent process is stopped and the thread moves to Trash, where it can be restored.",
        confirmLabel: "Delete",
        destructive: true,
      }))
    )
      return
    // Leave the route first: a deleted thread has no page to show.
    if (activeThreadId === session.id) {
      void navigate("/")
    }
    actions
      .deleteThread(session.id)
      .then(() =>
        toast("Moved to Trash", {
          description: session.title,
          action: {
            label: "Undo",
            onClick: () => {
              actions.restoreThread(session.id).catch((err) => reportError(err, "Couldn't restore the thread"))
            },
          },
        })
      )
      .catch((err) => reportError(err, "Couldn't delete the thread"))
  }

  const restore = (session: SessionMeta) => {
    actions.restoreThread(session.id).catch((err) => reportError(err, "Couldn't restore the thread"))
  }

  const purge = async (session: SessionMeta) => {
    if (
      !(await confirm({
        title: `Delete "${session.title}" forever?`,
        description:
          "The harness forgets this thread. Only the agent's own transcript file would still have the conversation.",
        confirmLabel: "Delete forever",
        destructive: true,
      }))
    )
      return
    actions.purgeThread(session.id).catch((err) => reportError(err, "Couldn't delete the thread"))
  }

  const open = (session: SessionMeta, newTab = false) => {
    if (isMobile) setOpenMobile(false)
    if (newTab) markNewTab()
    void navigate(threadPath(session.id))
  }

  return (
    <SidebarMenu>
      {visible.map((session) => {
        const pinned = pins.includes(session.id)
        /* One list feeds both the hover dropdown and the right-click menu. */
        const items = trash
          ? trashMenuItems(session, restore, purge)
          : threadMenuItems(session, pinned, {
              openInNewTab: () => open(session, true),
              onDelete: remove,
            })
        return (
          <ItemContextMenu key={session.id} items={items}>
            <SidebarMenuItem>
              {/* Two-line row: the title, then a muted context line that carries
                  the agent's mark (small), the project and then when it was
                  touched. Collapsed mode keeps only the mark. */}
              <SidebarMenuButton
                size="sm"
                tooltip={session.title}
                isActive={activeThreadId === session.id}
                onClick={(event) => open(session, event.metaKey || event.ctrlKey)}
                className="h-auto min-h-9 items-start px-2 py-1.5 text-[13px] group-data-[collapsible=icon]:items-center"
              >
                <span className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
                  <span
                    className={cn(
                      "block truncate",
                      (session.exited || trash) && "text-muted-foreground",
                      trash && "line-through"
                    )}
                  >
                    {session.title}
                  </span>
                  <span
                    className={cn(
                      "flex items-center gap-1 truncate text-[11px] leading-tight",
                      waiting(session) ? "font-medium text-amber-600 dark:text-amber-400" : "text-muted-foreground"
                    )}
                  >
                    <AgentIcon agentId={session.agentId} className="size-3" />
                    {/* The live/waiting badge rides the metadata line, not the
                        title: a running turn is a primary dot, a thread waiting
                        on the user is an amber dot — the one you must act on. A
                        removed thread stays quiet. */}
                    {running(session) && (
                      <span
                        aria-hidden
                        className="harness-node-active size-1.5 shrink-0 rounded-full bg-primary"
                      />
                    )}
                    <span className="truncate">
                      {waiting(session)
                        ? "Needs you"
                        : `${projectNameOf(session.projectId)} · ${timeAgo(session.createdAt)}`}
                    </span>
                  </span>
                </span>
                {/* Collapsed mode holds the mark — the text column below hides,
                    and the button is otherwise empty. */}
                <AgentIcon
                  agentId={session.agentId}
                  className="size-4 hidden group-data-[collapsible=icon]:inline-block"
                />
              </SidebarMenuButton>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuAction showOnHover title={`Actions for ${session.title}`}>
                      <MoreVertical />
                    </SidebarMenuAction>
                  }
                />
                <DropdownMenuContent side="right" align="start" className="w-44">
                  {renderMenuItems(items, {
                    Item: DropdownMenuItem,
                    Separator: DropdownMenuSeparator,
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </ItemContextMenu>
        )
      })}
      {/* One toggle row, styled as a quieter thread row rather than a button —
          it expands the index you are already scanning, so it borrows the
          list's own anatomy instead of presenting itself as a control. */}
      {hidden > 0 && (
        <SidebarMenuItem>
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              aria-hidden
              className={cn("size-3 shrink-0 transition-transform duration-200", expanded && "rotate-90")}
            />
            <span>{expanded ? "Show less" : `Show ${hidden} more`}</span>
          </button>
        </SidebarMenuItem>
      )}
    </SidebarMenu>
  )
}

/** The row menu for a live thread — Trash rows get their own two items. */
function threadMenuItems(
  session: SessionMeta,
  pinned: boolean,
  handlers: {
    openInNewTab: () => void
    onDelete: (session: SessionMeta) => void
  }
): MenuItemSpec[] {
  return [
    {
      label: pinned ? "Unpin" : "Pin to top",
      icon: pinned ? <PinOff /> : <Pin />,
      onClick: () => togglePin(session.id),
    },
    { label: "Open in new tab", icon: <ExternalLink />, onClick: handlers.openInNewTab },
    {
      label: "Copy link",
      icon: <LinkIcon />,
      onClick: () => {
        navigator.clipboard
          .writeText(new URL(threadPath(session.id), window.location.origin).toString())
          .then(() => toast.success("Link copied"))
          .catch((err) => reportError(err, "Couldn't copy the link"))
      },
    },
    { type: "separator" },
    {
      label: "Delete",
      icon: <Trash2 />,
      destructive: true,
      onClick: () => handlers.onDelete(session),
    },
  ]
}

function trashMenuItems(
  session: SessionMeta,
  restore: (session: SessionMeta) => void,
  purge: (session: SessionMeta) => void
): MenuItemSpec[] {
  return [
    { label: "Restore", icon: <Undo2 />, onClick: () => restore(session) },
    { type: "separator" },
    {
      label: "Delete forever",
      icon: <Trash2 />,
      destructive: true,
      onClick: () => purge(session),
    },
  ]
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
  const { state } = useStore()
  const steps = [
    {
      id: "projects" as const,
      title: "Projects",
      description: "Where a thread runs: directory, MCPs, skills.",
      count: state.projects.length,
    },
    {
      id: "profiles" as const,
      title: "Profiles",
      description: "What a thread runs: agent runtime, credentials, models.",
      count: state.profiles.length,
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
          <Button onClick={ready ? onNewThread : () => onOpenSettings("projects")}>
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

/* ── Server switcher ──
   Several harness servers can be stored side by side (lib/settings). Switching
   is a hard navigation: threads, the ACP sockets and the whole store belong to
   one server, so the cheapest correct swap is to re-boot the app against the
   newly-active connection. */
function ServerSwitcher({
  settings,
  onAddServer,
}: {
  settings: ServerSettings
  onAddServer: () => void
}) {
  const servers = React.useMemo(loadServers, [])
  const switchTo = (id: string) => {
    if (id === settings.id) return
    setActiveServer(id)
    location.assign("/")
  }

  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuButton
              tooltip={`${settings.name} · ${settings.url}`}
              className="data-popup-open:bg-sidebar-accent"
            >
              <ServerIcon className="size-4 shrink-0" />
              <span className="truncate">{settings.name}</span>
              <ChevronsUpDown className="ml-auto size-4 shrink-0 opacity-60" />
            </SidebarMenuButton>
          }
        />
        <DropdownMenuContent align="start" side="top" className="w-64">
          {/* Base UI: the label is a group part, so it has to live in a group. */}
          <DropdownMenuGroup>
            <DropdownMenuLabel>Servers</DropdownMenuLabel>
            {servers.map((server) => (
              <DropdownMenuItem key={server.id} onClick={() => switchTo(server.id)}>
                <span className="grid min-w-0 flex-1 leading-tight">
                  <span className="truncate">{server.name}</span>
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    {server.url}
                  </span>
                </span>
                {server.id === settings.id && <Check className="ml-2 size-4 shrink-0" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onAddServer}>
            <Plus className="size-4" />
            Add server…
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => {
              /* Forgetting a server has to drop this device from its push list
                 first — the token outlives the connection, so a server nobody
                 is connected to any more would go on notifying this device with
                 no way left in the UI to stop it. The navigation waits, because
                 unloading cancels the request in flight; but only briefly, since
                 an unreachable server is one of the reasons to disconnect. */
              void Promise.race([
                teardownPush(settings),
                new Promise((resolve) => setTimeout(resolve, 2000)),
              ]).finally(() => {
                removeServer(settings.id)
                location.assign("/")
              })
            }}
          >
            <LogOut className="size-4" />
            Disconnect {settings.name}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )
}
