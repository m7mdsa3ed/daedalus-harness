import * as React from "react"
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  FolderIcon,
  Link as LinkIcon,
  MoreVertical,
  Pin,
  PinOff,
  SearchIcon,
  FolderPlus,
  Check,
  ChevronsUpDown,
  ExternalLink,
  LogOut,
  MessageSquareIcon,
  Plus,
  ServerIcon,
  Settings2,
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
import {
  HeaderNotice,
  NotificationAlert,
  useHeaderNotice,
  useNotificationOffer,
} from "@/components/notification-alert"
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
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
} from "@/components/ui/responsive-dialog"
import { Separator } from "@/components/ui/separator"
import { SessionDock, useSessionDock } from "@/components/session-dock"
import { ThreadHero } from "@/components/thread-hero"
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
  currentThreadId,
  NavigationBridge,
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
import { loadThreadDefaults } from "@/lib/thread-defaults"
import { shortAge } from "@/lib/time"
import {
  loadServers,
  removeServer,
  setActiveServer,
  type ServerSettings,
  type SessionMeta,
} from "@/lib/settings"
import { emptyThread, threadIsEmpty, useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { ProjectForm } from "@/components/settings/projects"
import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "@/components/settings/sections"
import { SettingsLayout } from "@/components/settings/layout"
import { GeneralPage } from "@/components/settings/general"
import { AppearancePage } from "@/components/settings/appearance"
import { NotificationsPage } from "@/components/settings/notifications"
import { ProjectsPage } from "@/components/settings/projects"
import { McpPage } from "@/components/settings/mcp"
import { SkillsPage } from "@/components/settings/skills"
import { CommandsPage } from "@/components/settings/commands"
import { ProfilesPage } from "@/components/settings/profiles"
import { AgentsPage } from "@/components/settings/agents"

/** Swappable sidebar body. One panel per route family — see `panels` below. */
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
  const [newProjectOpen, setNewProjectOpen] = React.useState(false)
  // Sidebar width overrides the shadcn default via the same CSS var it reads.
  const [sidebarWidth, setSidebarWidth] = React.useState(
    () => localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? SIDEBAR_WIDTH_DEFAULT
  )
  const [resizing, setResizing] = React.useState(false)
  const palette = useCommandPalette()
  const shortcuts = useShortcutsHelp()
  const offer = useNotificationOffer()
  const notice = useHeaderNotice()
  const inSettings = location.pathname.startsWith("/settings")
  const sessionId = inSettings ? null : currentThreadId(location.pathname, location.search)
  const section = sectionOf(inSettings ? (location.pathname.split("/")[2] ?? "") : "")
  // Leaving settings returns to the thread it was opened from.
  const lastThread = React.useRef<string | null>(null)
  if (sessionId) lastThread.current = sessionId
  const active = state.sessions.find((s) => s.id === sessionId)
  const ready = !loading && state.projects.length > 0 && state.profiles.length > 0
  /* The homepage and an empty active thread share the same backdrop. A
     background tab going empty must not paint the foreground one. */
  const onHomepage = !inSettings && !sessionId
  const heroVisible =
    onHomepage ||
    (!!active && !!sessionId && threadIsEmpty(state.threads[sessionId] ?? emptyThread, active.draft))
  const dock = useSessionDock()
  const routeSessionRef = React.useRef(sessionId)
  routeSessionRef.current = sessionId

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
      model: defaults.model,
      effort: defaults.effort,
      id: sessionId,
    })
  }, [sessionId, state.sessions, state.projects, state.profiles, ready, actions, dock])

  React.useEffect(() => {
    if (loading) return
    dock.pruneMissingSessions(state.sessions.map((session) => session.id))
  }, [loading, state.sessions, dock])

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
      model: defaults.model,
      effort: defaults.effort,
    })
    void navigate(threadPath(id))
  }
  // The key handler is bound once; the ref keeps it pointed at the live closure.
  const startThreadRef = React.useRef(startThread)
  startThreadRef.current = startThread

  /* ── Sidebar panels ──
     The sidebar body is swappable: one entry per route family. To add a panel,
     add a route below and an entry here — the shell itself is generic. */
  const panels: Record<"threads" | "settings", SidebarPanel> = {
    threads: {
      action: (
        <SidebarGroup className="px-2 py-1">
          <SidebarGroupLabel className={GROUP_LABEL}>Create</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip="New thread" onClick={startThread} disabled={loading}>
                  <Plus className="size-4" />
                  <span>New thread</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip="New project" onClick={() => setNewProjectOpen(true)} disabled={loading}>
                  <FolderPlus className="size-4" />
                  <span>New project</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ),
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
      <SessionDock actions={actions} onReady={handleDockReady} />
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
      /* Tells the shell's surfaces to go translucent while the hero shows —
         see styles/thread-hero.css. */
      data-hero={heroVisible || undefined}
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
      {/* Outside the inset and under everything: the backdrop for an empty
          thread runs beneath the sidebar and the header, not just the
          transcript. `threadIsEmpty` is shared with the thread's own layout so
          the two can never disagree about when it shows. */}
      <ThreadHero visible={heroVisible} />
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
            {/* Search sits with the brand, not in the thread header: it searches
                the whole app, so it belongs to the app's corner. */}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => palette.setOpen(true)}
              title="Search threads and commands (⌘K)"
              className="ml-auto shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden"
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
          <Separator orientation="vertical" className="mr-1 h-4 shrink-0 sm:mr-2" />
          {/* Both of these stand IN the header while they last: one row, one
              subject. Nothing is stacked and nothing below moves when they go —
              see components/notification-alert. An event outranks the offer;
              it expires on its own, the offer waits. */}
          {notice ? (
            <HeaderNotice key={notice.id} />
          ) : offer ? (
            <NotificationAlert />
          ) : (
          <div className="flex min-w-0 flex-1 items-center justify-between gap-2 sm:gap-3">
            <div className="flex min-w-0 items-baseline gap-2">
              {loading ? (
                <Skeleton className="h-4 w-32" />
              ) : (
                <h1 className="truncate text-sm font-medium">
                  {inSettings
                    ? (SETTINGS_SECTIONS.find((s) => s.id === section)?.label ?? "Settings")
                    : (active?.title ?? "Daedalus")}
                </h1>
              )}
              {inSettings ? (
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">Settings</span>
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
          </div>
          )}
        </header>
        <Routes>
          <Route
            path="/settings"
            element={<SettingsLayout settings={settings} actions={actions} loading={loading} />}
          >
            <Route index element={<Navigate to="general" replace />} />
            <Route path="general" element={<GeneralPage />} />
            <Route path="appearance" element={<AppearancePage />} />
            <Route path="notifications" element={<NotificationsPage />} />
            <Route path="projects" element={<ProjectsPage />} />
            <Route path="mcp" element={<McpPage />} />
            <Route path="skills" element={<SkillsPage />} />
            <Route path="commands" element={<CommandsPage />} />
            <Route path="profiles" element={<ProfilesPage />} />
            <Route path="agents" element={<AgentsPage />} />
            {/* /settings/<unknown> — the sidebar still needs a page to light up. */}
            <Route path="*" element={<Navigate to="/settings/general" replace />} />
          </Route>
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
        onNewThread={startThread}
        onNewProject={() => setNewProjectOpen(true)}
        onShortcuts={() => shortcuts.setOpen(true)}
      />
      <ShortcutsHelp open={shortcuts.open} onOpenChange={shortcuts.setOpen} />
      {/* Same form the settings page uses — created from the sidebar too. */}
      <ResponsiveDialog open={newProjectOpen} onOpenChange={setNewProjectOpen}>
        <ResponsiveDialogContent className="sm:max-w-xl">
          {newProjectOpen && (
            <ProjectForm
              project={null}
              settings={settings}
              onDone={async (saved) => {
                setNewProjectOpen(false)
                if (saved) await actions.refreshProjects()
              }}
            />
          )}
        </ResponsiveDialogContent>
      </ResponsiveDialog>
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

/* Captions, not rows. A group label used to be the same size, weight and
   colour as the threads under it, so "Recent" scanned as a thread called
   Recent. Smaller, uppercase, tracked out and dimmer: it now reads as a label
   for the list rather than as the first thing in it. Shared by every sidebar
   group so the whole panel has one caption voice. */
const GROUP_LABEL =
  "h-6 gap-1.5 px-2 text-[10px] font-semibold tracking-[0.08em] uppercase text-sidebar-foreground/45 [&>svg]:size-3"

const RECENT_COUNT = 6

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

  /* The tiers that do not fold: they are short by construction (pins are what
     you chose, Recent is capped) and hiding them would hide the whole point of
     having them at the top. */
  const group = (
    key: string,
    label: React.ReactNode,
    sessions: SessionMeta[],
    icon?: React.ReactNode
  ) => (
    <SidebarGroup key={key} className="mt-2 px-2 py-0 first:mt-0">
      <SidebarGroupLabel className={GROUP_LABEL}>
        {icon}
        <span className="truncate">{label}</span>
        <span className="ml-auto tabular-nums opacity-70">{sessions.length}</span>
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <ThreadList sessions={sessions} actions={actions} />
      </SidebarGroupContent>
    </SidebarGroup>
  )

  /* Projects are the long tail — there can be many, and you are usually only
     interested in one. They fold, and stay folded across reloads. No count on
     the label: the number of old threads in a project is not a thing anyone
     acts on, and it competed with the disclosure arrow for the same corner. */
  const projectGroup = (projectId: string, sessions: SessionMeta[]) => (
    <FoldableGroup
      key={projectId}
      groupKey={projectId}
      icon={<FolderIcon className="shrink-0" />}
      label={state.projects.find((p) => p.id === projectId)?.name ?? "Other"}
    >
      <ThreadList sessions={sessions} actions={actions} />
    </FoldableGroup>
  )

  return (
    <>
      {pinned.length > 0 &&
        group("__pinned", "Pinned", pinned, <Pin className="size-3 shrink-0" />)}
      {recent.length > 0 &&
        group("__recent", "Recent", recent, <Clock className="size-3 shrink-0" />)}
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
          <ThreadList sessions={trashed} actions={actions} trash />
          <EmptyTrash sessions={trashed} actions={actions} />
        </FoldableGroup>
      )}
    </>
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
  children,
}: {
  groupKey: string
  label: string
  icon: React.ReactNode
  /** Printed next to the label when the number is something you act on. */
  count?: number
  /** Trash defaults closed: it is a place things go, not a place you work. */
  defaultOpen?: boolean
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
      <SidebarGroup className="mt-2 px-2 py-0">
        <CollapsibleTrigger
          render={
            <SidebarGroupLabel className={cn(GROUP_LABEL, "hover:text-sidebar-foreground/70")} />
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
              "shrink-0 transition-transform duration-200",
              count == null && "ml-auto",
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
}: {
  sessions: SessionMeta[]
  actions: Actions
  /** Rendering the Trash group: these threads are deleted, so the row restores
      instead of opening and the menu offers the two ways back out. */
  trash?: boolean
}) {
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
  /* Opening a thread is the list's news to report, not the transcript's: the
     transcript used to stand in a skeleton, which claimed a shape for content
     nobody had seen yet. Here it is one word next to the thread it belongs to. */
  const connecting = (session: SessionMeta) =>
    state.threads[session.id]?.status === "connecting"

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
      {sessions.map((session) => {
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
              <SidebarMenuButton
                tooltip={session.title}
                isActive={activeThreadId === session.id}
                onClick={(event) => open(session, event.metaKey || event.ctrlKey)}
              >
                <MessageSquareIcon
                  className={cn("size-4", (session.exited || trash) && "opacity-50")}
                />
                {/* A running thread says so in its own title — the same shimmer the
                    transcript's working line uses, so the two read as one state
                    rather than as two unrelated indicators. */}
                <span
                  title={`${session.title} · started ${new Date(session.createdAt).toLocaleString()}`}
                  className={cn(
                    "truncate",
                    (session.exited || trash) && "text-muted-foreground",
                    trash && "line-through",
                    running(session) && "harness-shimmer text-primary"
                  )}
                >
                  {session.title}
                </span>
                {/* The age sits where the row menu appears on hover, so it fades
                    out rather than fighting it for the same corner. */}
                <span
                  className={cn(
                    "ml-auto shrink-0 text-[10px] tabular-nums transition-opacity group-hover/menu-item:opacity-0 group-data-[collapsible=icon]:hidden",
                    connecting(session)
                      ? "harness-shimmer text-primary"
                      : "text-muted-foreground/60"
                  )}
                >
                  {connecting(session)
                    ? "connecting"
                    : shortAge(session.deletedAt ?? session.createdAt)}
                </span>
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
              removeServer(settings.id)
              location.assign("/")
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
