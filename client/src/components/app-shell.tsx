/* ── The shell ──
   The layout every route is read in, chat-first: the sidebar rail on the left,
   the centre pane (`shell/outlet.tsx` — a thread, or any page, rendered
   straight from the route table), and one collapsible right panel for the tools
   about what is in front of you (`right-panel/`). There are no tabs: the address
   bar is the only state about "what is open". What lives here is what has to be
   *above* all of that — the one draft-minting front door every "new thread"
   gesture takes, the device-level dialogs, and the chords.

   The sidebar's own pieces are `components/sidebar/`; the route tree and the
   page titles are `components/routes.tsx`, the only importer of the pages. */
import * as React from "react"
import { FocusIcon, GitBranch, SearchIcon, Settings, SlidersHorizontalIcon, XIcon } from "lucide-react"
import { useLocation, useNavigate } from "react-router"
import { Button } from "@/components/ui/button"
import { Logo } from "@/components/ui/logo"
import { ProgressiveBlur } from "@/components/ui/progressive-blur"
import { SidebarGroupsSkeleton } from "@/components/ui/skeletons"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import { CommandPalette, useCommandPalette } from "@/components/command-palette"
import { ImportThreadsDialog } from "@/components/import-threads"
import { NotificationIconButton } from "@/components/notifications/bell"
import { pageRoutes, usePageHeading } from "@/components/routes"
import { RightPanelColumn, RightPanelSheet } from "@/components/right-panel/right-panel"
import { ScopeProvider, routedThreadId as routedThread, useRouteScope } from "@/components/right-panel/scope-dock"
import { ShellOutlet } from "@/components/shell/outlet"
import { TopBarActions, TopBarTitle } from "@/components/shell/top-bar"
import { sectionOf, type SettingsSectionId } from "@/components/settings/sections"
import { SessionSettingsDialog } from "@/components/session-settings"
import { ShortcutsHelp, useShortcutsHelp } from "@/components/shortcuts-help"
import { useSidebarWidth } from "@/components/sidebar/resizer"
import { ServerIconButton } from "@/components/sidebar/server-menu"
import { SpaceIconButton, SpaceSwitcher } from "@/components/sidebar/space-menu"
import {
  FOOTER_ICON,
  SettingsNav,
  SidebarNav,
  ThreadSidebar,
} from "@/components/thread-sidebar"
import { useShortcut } from "@/hooks/use-hotkey"
import { useIsMobile } from "@/hooks/use-device"
import type { Actions } from "@/lib/actions"
import { useDesktopBridge } from "@/lib/desktop"
import { HEADER_BADGE, HEADER_CHIP, STRIP_GROUND } from "@/lib/header-chrome"
import { useChord } from "@/lib/keybindings"
import { useActiveSpace, useCatalogLoaded, useProfiles, useProjects } from "@/lib/queries/catalog"
import {
  currentThreadId,
  NavigationBridge,
  settingsFormPath,
  settingsPath,
  settingsRootPath,
  threadPath,
} from "@/lib/router"
import type { ServerSettings, SessionMeta } from "@/lib/settings"
import { setSidebarLayout, useSidebarLayout } from "@/lib/sidebar-layout"
import { formatChord } from "@/lib/shortcuts"
import { useStoreHandle, useStoreSelect } from "@/lib/store"
import { cn } from "@/lib/utils"
import { IS_POPOUT } from "@/lib/popout"
import { setFocusMode, useFocusMode } from "@/lib/focus-mode"
import { openTerminal } from "@/lib/workspace/open-terminal"
import { openSection, rightSheet, scopeSession, toggleRightPanel, useRightPanel } from "@/lib/right-panel"
import { adjacentThread, useActiveChat } from "@/lib/workspace/open-threads"
import { HOME_PROJECT_ID } from "@/lib/workspace/panels"

/** Closes the mobile sidebar sheet whenever the route changes. Desktop keeps
    its open/collapsed state — there it is a column, not an overlay. Here
    rather than on each row because rows are not the only thing that navigates:
    the palette, the dock and push deep links all land in the same place. */
function CloseSidebarOnNavigate() {
  const { isMobile, setOpenMobile } = useSidebar()
  const location = useLocation()
  const key = location.pathname + location.search
  React.useEffect(() => {
    if (isMobile) setOpenMobile(false)
  }, [key, isMobile, setOpenMobile])
  return null
}

export function AppShell({
  settings,
  actions,
  loading: bootLoading,
  onAddServer,
}: {
  settings: ServerSettings
  actions: Actions
  loading: boolean
  /** The session list never arrived. The dock's prune is held back on it — see
      the effect below. */
  failed: boolean
  onAddServer: () => void
}) {
  /* Three slices, not the state: this shell wraps every panel, so on the wide
     hook it re-rendered — and re-ran the layout effects below — on every
     streamed token of every open thread. None of the three is touched by an
     `update`; `sessions` moves once per turn, at most. */
  const sessions = useStoreSelect((state) => state.sessions)
  const storeHandle = useStoreHandle()
  const projects = useProjects()
  const profiles = useProfiles()
  /* The space in front of you. Switching it swaps the dock (see the effect
     below) — each space keeps its own tabs. */
  const { id: activeSpaceId, setActive: setActiveSpace } = useActiveSpace()
  /* `bootstrap` answers for the session list alone — each catalog is its own
     query — so the loading gate is the two together. Without it an empty
     catalog mid-read draws the "Finish the setup" screen at every boot. */
  const catalogLoaded = useCatalogLoaded()
  const loading = bootLoading || !catalogLoaded
  const ready = !loading && projects.length > 0 && profiles.length > 0
  const location = useLocation()
  const navigate = useNavigate()
  const sidebar = useSidebarWidth()
  const palette = useCommandPalette()
  // Whatever this is bound to on this device — the tooltip has to say the
  // key that actually works, not the one the release shipped.
  const paletteChord = useChord("palette") ?? ""
  const shortcuts = useShortcutsHelp()
  const [importing, setImporting] = React.useState(false)
  /* The header's own dialog — device-global, so it belongs to the shell rather
     than to any route or dock group under it. */
  const [viewSettings, setViewSettings] = React.useState(false)
  /* Focus mode is a presentation over the workspace, never an edit of it: the
     sidebar is held shut without writing its saved state and the right panel is
     not drawn. It only applies while a thread is in front — a page gets the
     chrome back. */
  const activeChat = useActiveChat()
  const focused = useFocusMode() && !!activeChat
  const route = useRouteScope()
  const isMobileShell = useIsMobile()
  const rightView = useRightPanel(route.scope)
  const headingFor = usePageHeading()

  const inSettings = location.pathname.startsWith("/settings")
  const section = inSettings ? sectionOf(location.pathname.split("/")[2] ?? "") : null
  const sessionId = routedThread(location.pathname, location.search)
  const active = sessions.find((s) => s.id === sessionId)
  /* Where the thread in front of us was branched from, if anywhere — drawn as
     a chip, followed only by a click. The list holds the trash too, so a
     parent still shows its title until it is purged, which is the honest
     answer for a branch whose origin is otherwise gone. */
  const forkedFrom = active?.forkedFromSessionId
    ? sessions.find((s) => s.id === active.forkedFromSessionId)
    : undefined
  /* The project the workspace panels act on: a project page's own, else the
     routed thread's. There is no "active project" in this app — the dock is
     cross-project by design — so what is in front of you is what names one. */
  const projectId = location.pathname.startsWith("/projects")
    ? location.pathname.split("/")[2]
    : active?.projectId
  const activeProjectId = projects.find((p) => p.id === projectId)?.id ?? null

  /* Refs for the callbacks bound once (the dock's onReady, the chords): each
     keeps its handler pointed at the live closure. */
  const routeRef = React.useRef({ sessionId, path: "", projectId: activeProjectId })
  routeRef.current = { sessionId, path: location.pathname + location.search, projectId: activeProjectId }

  /* ── Every "new thread" gesture, one door ──
     Mint the draft: the id, the route and the transcript all exist before
     anything touches the network, and nothing is created on the server — no
     row, no agent process — until the first message (see actions.send). Null
     when there is nothing to start on, which is the "set up a project" case.
     The project resolution (the caller's, else the remembered default) lives
     in `actions.startThreadIn`, which the sidebar and a project's own page
     call directly — one implementation, every caller. */
  const openDraftThread = (opts: { projectId?: string; id?: string } = {}): string | null =>
    actions.startThreadIn(opts)

  /* A section opens that section; plain "Settings" opens the overview, which
     is the one page that lists them all — the sidebar does on a desktop, but
     on a phone it is a drawer that closed when you tapped Settings. */
  const openSettings = (next?: SettingsSectionId) =>
    void navigate(next ? settingsPath(next) : settingsRootPath())

  /* "New thread" always creates a new thread: a draft is minted, routed to and
     opened as a tab of its own, every time, whoever asked — ⌘N, the sidebar
     row, the strip's +, the palette, a project's own +, the app shortcut. An
     empty draft is invisible to every list (`isListed`) until it is sent, so
     minting one per press costs nothing but the tab you asked for, and the row
     is persisted (`lib/draft-sessions`) so a reload brings the tab back.

     `text` is what changes the shape of this: ⌘K's ask row and the console's
     composer hand over a first message, in which case the draft is minted,
     routed to AND sent in one gesture — `actions.send` is what turns a draft
     into a real session, and it does not need the composer to be mounted to do
     it, so the thread is already spawning while the transcript is still
     opening. A failure lands in that thread as a Retry row like any send. */
  const startThread = (opts: { text?: string; projectId?: string } = {}) => {
    if (!ready) return openSettings("projects")
    const id = openDraftThread({ projectId: opts.projectId })
    if (!id) return openSettings("projects")
    void navigate(threadPath(id))
    const text = opts.text?.trim()
    if (text) void actions.send(id, text).catch(() => {})
  }

  const startRef = React.useRef({ startThread, openDraftThread })
  startRef.current = { startThread, openDraftThread }

  /* A legacy `?session=<id>` deep link (a schedule form carries one on its own
     path) is a thread route in a different spelling. */
  React.useEffect(() => {
    if (location.pathname !== "/") return
    const legacy = new URLSearchParams(location.search).get("session")
    if (legacy) void navigate(threadPath(legacy), { replace: true })
  }, [location.pathname, location.search, navigate])

  /* The desktop shell reveals the window once the workspace has mounted. Said
     once the boot gate lifts, and once only, or the 4s reveal timeout fires on a
     blank frame. */
  const signalled = React.useRef(false)
  React.useEffect(() => {
    if (loading || signalled.current) return
    signalled.current = true
    window.desktop?.signalWorkspaceReady?.()
  }, [loading])

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
    startRef.current.startThread()
  }, [ready, location.search])

  /* Mirrors the palette's "New thread" entry — the palette advertises the
     shortcut, so something has to answer for it. The chords are named in
     lib/shortcuts, which is also what the help sheet prints. */
  useShortcut("newThread", () => startRef.current.startThread())
  useShortcut("terminal", () => {
    if (rightView.open && rightView.section === "terminal") return toggleRightPanel()
    if (rightView.terminals.length > 0) return openSection(route.scope, "terminal")
    const meta = sessions.find((session) => session.id === route.sessionId)
    void openTerminal(
      route.scope,
      meta?.projectId ?? route.projectId ?? HOME_PROJECT_ID,
      meta ? { cwd: meta.worktree?.path, sessionId: meta.id } : {}
    )
  })
  useShortcut("rightPanel", () => (isMobileShell ? rightSheet.set(true) : toggleRightPanel()))
  /* The threads you have been in: the tab walk's successor. */
  const walkThreads = (delta: number) => {
    const next = adjacentThread(delta, activeChat, (id) =>
      sessions.some((session) => session.id === id && !session.deletedAt)
    )
    if (next) void navigate(threadPath(next))
  }
  useShortcut("nextTab", () => walkThreads(-1))
  useShortcut("prevTab", () => walkThreads(1))
  /* changeModel / changeProject / chooseMcp are the composer's: they open its
     own menus (`Composer`, `ConfigPopover`), which list everything — a draft's
     agent and profile, effort, mode, MCPs — where the palette's pages list only
     a live agent's selectors. */
  useShortcut("threadSearch", () => {
    if (!sessionId) return false
    palette.openAt("thread-search")
  }, { enabled: !!sessionId })
  useShortcut("viewOptions", () => setViewSettings(true))
  // The desktop shell's tray, native menu and quick-entry hotkey (lib/desktop.ts).
  useDesktopBridge()

  /* The route tree — every page that is not the transcript — lives in
     `components/routes.tsx`, which is also the only module that imports those
     pages: a static import of one here would put all of them back in the entry
     chunk. It is a fragment of `<Route>`, not a `<Routes>`, because each page
     tab renders it against its own path (`workspace/page-panel.tsx`). */
  const routes = pageRoutes({
    settings,
    actions,
    loading,
    ready,
    onAddServer,
    onOpenSettings: openSettings,
  })

  return (
    <PersistedSidebarProvider
      focused={focused}
      style={{
        "--sidebar-width": sidebar.width,
        height: "100dvh",
        // Both sides: a landscape notch is on the right as often as the left.
        paddingLeft: "env(safe-area-inset-left, 0px)",
        paddingRight: "env(safe-area-inset-right, 0px)",
      } as React.CSSProperties}
    >
      {/* First in the tree so its effect runs before any sibling subtree's:
          `navigateTo` must already have the router's navigate by the time
          anything outside React (a notification click, a push deep link) asks
          for it — the location.assign fallback would be a full reload. */}
      <ScopeProvider>
      <NavigationBridge />
      <CloseSidebarOnNavigate />
      {/* A flush rail: shadcn's stock `sidebar` variant, a panel with a 1px
          edge and the column beside it filling the rest — no floating card, no
          outer gutters. `offcanvas`, not `icon`: a 3rem column of glyphs is
          still a column, and the toggle that brings it back lives in the app
          header, which is on every route. */}
      <Sidebar collapsible="offcanvas">
        {/* The brand row is the app header's own row: the same top offset (the
            status-bar inset) and the same height (`--app-header-row-h`), so the
            brand and Search stand on one line with the header's controls across
            the seam. */}
        <SidebarHeader className="gap-2 px-2 pt-[var(--app-inset-top)] pb-0 md:pt-[calc(var(--app-inset-top)+var(--app-frame-gap))]">
          <div data-drag-region className="flex h-[var(--app-header-row-h)] items-center gap-2">
            <button
              type="button"
              onClick={() => void navigate("/")}
              aria-label="Go to homepage"
              className="flex shrink-0 items-center gap-2 rounded-sm pl-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Logo idle className="size-4 shrink-0" />
              <span className="brand-script text-xl leading-none">Daedalus</span>
            </button>
            {/* The palette, beside the brand. It is the app's own, not a
                route's and not a dock group's — the sidebar is the one surface
                that is on every route and never splits. */}
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(HEADER_CHIP, "ml-auto text-muted-foreground hover:text-foreground")}
              title={`Search threads and commands (${formatChord(paletteChord)})`}
              aria-label="Search"
              onClick={() => palette.setOpen(true)}
            >
              <SearchIcon className="size-3.5" />
            </Button>
          </div>
        </SidebarHeader>
        {/* ── One sidebar, two contents, chosen by the panel in front of you ──
            Settings sections are this sidebar's content while the active panel
            is a settings page; the thread list is its content otherwise.

            This was tried before and reverted, because the sidebar followed
            the *route* while the panel you were reading could be a chat. What
            makes it correct now is that the dock writes the focused panel's
            path to the URL (`onDidActivePanelChange`), so the route IS the
            active panel's descriptor — focus the chat beside a settings tab
            and the sidebar is threads again, on the same gesture. Settings
            therefore carries no second sidebar of its own; see
            `sidebar/settings-nav.tsx`. */}
        <SidebarContent className="gap-0 pt-2">
          {inSettings ? (
            <SettingsNav />
          ) : (
            <>
              {/* The nav rows sit above the list, the way the Claude desktop
                  sidebar opens. `New project` stays reachable from
                  /settings/projects and the command palette. */}
              <SidebarNav onNewThread={() => startRef.current.startThread()} />
              {loading ? (
                <SidebarGroupsSkeleton />
              ) : (
                <ThreadSidebar actions={actions} />
              )}
            </>
          )}
        </SidebarContent>
        <SidebarFooter className="p-2">
          {/* ── One row of icons ──
              The things the panel itself needs, on one line: the space, the
              server it is talking to, what has arrived while you were away,
              and the way into every setting. They were two rows of labelled buttons, which cost the
              thread list their 128px and made the panel's furniture read as
              more places to go. Each is a control that opens something, and
              each says its own name in a tooltip. Plan usage is not here: the
              plans are listed on Settings › Usage and nowhere else. */}
          <div className="flex items-center gap-0.5 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:gap-1">
            <SpaceIconButton />
            <ServerIconButton settings={settings} onAddServer={onAddServer} />
            <NotificationIconButton />
            <Button
              variant="ghost"
              size="icon-sm"
              title="Settings"
              aria-label="Settings"
              onClick={() => openSettings()}
              className={cn(
                FOOTER_ICON,
                /* The row that opens the section you are in says so, exactly as
                   the labelled rows did. */
                inSettings && "bg-sidebar-accent text-sidebar-accent-foreground",
                "ml-auto group-data-[collapsible=icon]:ml-0"
              )}
            >
              {/* A bare gear, not the "cog with sliders": the two-tone glyph
                  reads as noise at 16px, and the sliders half of it is the
                  View-settings button this panel used to carry. */}
              <Settings />
            </Button>
          </div>
        </SidebarFooter>
        {sidebar.resizer}
      </Sidebar>
      {/* The column the app is read in, beside the rail: the centre pane and
          the right panel under one header row.

          `min-h-0` has to be here: the provider is pinned to `100dvh`, and it
          is what lets the scrolling column inside shrink to it. */}
      <SidebarInset data-focus-mode={focused || undefined} className="flex min-h-0 flex-col overflow-hidden">
        {/* An overlay spanning the whole top, INSIDE `SidebarInset`: the centre
            pane and the right panel both scroll up under it, softened by the
            progressive blur, and both pad by `--app-header-h` to start below it.

            `pointer-events-none`, with each occupant turning it back on: its
            own box is nothing but the blur. Left live it swallows every press
            that lands between the controls, and every attempt to select the
            first line of a transcript scrolled under it.

            Below `md` the header is the same container as the transcript and
            the composer: `px-4`, the 16px gutter they keep. `px-1` above `md`,
            where the chips stand on the edge of the column. */}
        <header
          data-app-header
          data-drag-region
          className="pointer-events-none absolute inset-x-0 top-0 z-30 flex h-[var(--app-header-h)] items-center gap-1 bg-transparent px-4 pt-[var(--app-inset-top)] md:px-1"
        >
          {/* The transcript scrolls up under this bar, so it carries a progressive
              blur that takes those lines out of focus before they reach the
              controls. Caveat: a backdrop filter turns off the window's
              vibrancy/acrylic across the band. */}
          <ProgressiveBlur
            position="top"
            height="calc(100% + 1rem)"
            blurLevels={[0.4, 0.8, 1.4, 2.2, 3.4, 5.4, 8.6, 14]}
            className="absolute inset-x-0 top-0 -z-10"
          />
          {/* The device-level controls on the left, where you are in the middle,
              and the right panel's doors at the end. */}
          <div data-header-left className="flex min-w-0 items-center gap-1">
            {focused ? (
              <Button
                variant="ghost"
                size="icon-sm"
                title="Exit focus mode"
                aria-label="Exit focus mode"
                className={cn(HEADER_CHIP, "pointer-events-auto shrink-0 [-webkit-app-region:no-drag]")}
                onClick={() => setFocusMode(false)}
              >
                <FocusIcon className="size-3.5" />
              </Button>
            ) : (
              <>
              <SidebarTrigger className={cn(HEADER_CHIP, "pointer-events-auto shrink-0")} />
              {/* Which space the app is showing — the one control in this row that
                  says where you are, beside the one that opens the list of where
                  you can go. */}
              {/* Height of the chip, width of its label: HEADER_CHIP is a square,
                  which clipped the name down to the glyph. */}
              <SpaceSwitcher
                className={cn(
                  "h-[var(--dock-chip-h)] shrink-0 px-2.5 max-md:size-[var(--dock-chip-h)] max-md:justify-center max-md:gap-0 max-md:px-0",
                  STRIP_GROUND
                )}
              />
              {/* How transcripts are drawn, on this device — beside the one other
                  control that is also this device's and not this route's.
                  Sliders, not a cog: a cog in this app means the *server's*
                  settings route. */}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="View settings"
                title="How transcripts are drawn, on this device"
                className={cn(HEADER_CHIP, "pointer-events-auto shrink-0")}
                onClick={() => setViewSettings(true)}
              >
                <SlidersHorizontalIcon className="size-3.5" />
              </Button>
              {activeChat && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title="Focus on this thread"
                  aria-label="Focus mode"
                  className={cn(HEADER_CHIP, "pointer-events-auto shrink-0")}
                  onClick={() => setFocusMode(true)}
                >
                  <FocusIcon className="size-3.5" />
                </Button>
              )}
              </>
            )}
            {/* A branch says where it came from, once, beside the tab that
                names it — the one thing provenance is for. Clicking goes to the
                parent thread as it is now, not to the turn it was cut at. */}
            {IS_POPOUT && window.desktop?.closeWindow && (
              <Button
                variant="ghost"
                size="icon-xs"
                className={cn(HEADER_CHIP, "pointer-events-auto shrink-0 [-webkit-app-region:no-drag]")}
                onClick={() => void window.desktop?.closeWindow?.()}
                title="Close window"
                aria-label="Close window"
              >
                <XIcon className="size-3.5" />
              </Button>
            )}
            {forkedFrom && (
              <button
                type="button"
                title={`Open ${forkedFrom.title}`}
                className={cn(
                  HEADER_BADGE,
                  "pointer-events-auto hidden min-w-0 shrink-0 items-center gap-1 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:flex"
                )}
                onClick={() => void navigate(threadPath(forkedFrom.id))}
              >
                <GitBranch className="size-3 shrink-0" />
                <span className="max-w-[140px] truncate">{forkedFrom.title}</span>
              </button>
            )}
          </div>
          <TopBarTitle heading={headingFor(location.pathname + location.search)} />
          {!focused && <TopBarActions />}
        </header>
        {/* The centre pane and the right panel. The centre renders the route
            table directly — a thread, or any page — and the panel is the one
            column of tools about it. Focus mode draws neither the panel nor the
            chrome around the thread. */}
        <div className="flex min-h-0 flex-1">
          <ShellOutlet
            routes={routes}
            headingFor={headingFor}
            actions={actions}
            ready={ready}
            openDraft={(opts) => startRef.current.openDraftThread(opts)}
          />
          {!focused && <RightPanelColumn actions={actions} />}
        </div>
      </SidebarInset>
      <CommandPalette
        open={palette.open}
        onOpenChange={palette.setOpen}
        actions={actions}
        onNewThread={startThread}
        onNewProject={() => void navigate(settingsFormPath("projects"))}
        onImportThreads={() => setImporting(true)}
        onShortcuts={() => shortcuts.setOpen(true)}
        onViewOptions={() => setViewSettings(true)}
        initialPage={palette.initialPage}
      />
      {!focused && <RightPanelSheet actions={actions} />}
      <ShortcutsHelp open={shortcuts.open} onOpenChange={shortcuts.setOpen} />
      {/* Owned here rather than by the palette, which unmounts as soon as a
          command runs. The project page mounts its own, scoped to itself. */}
      <ImportThreadsDialog open={importing} onOpenChange={setImporting} actions={actions} />
      {/* Opened by the sliders in the header. Here rather than beside that
          button so it is not unmounted with a header some routes draw
          differently. */}
      <SessionSettingsDialog open={viewSettings} onOpenChange={setViewSettings} />
      </ScopeProvider>
    </PersistedSidebarProvider>
  )
}

/** The provider, controlled, so the open state is the device store's and
    survives a reload. The primitive's own internal state — and the cookie it
    writes beside it — is left unused, which is deliberate: the vendored
    component is reinstallable and the memory belongs to the app. Mobile is
    unaffected: the sheet toggles `openMobile`, which this does not drive, so a
    phone never restores an open overlay.

    Its own component, so the subscription is its own: read in `AppShell`, a
    toggle re-rendered the whole shell — the dock, the sidebar, every panel.
    Here `children` are the same elements the shell last made, and React skips
    them; only what reads the sidebar's context re-renders. */
function PersistedSidebarProvider({
  focused,
  ...props
}: Omit<React.ComponentProps<typeof SidebarProvider>, "open" | "onOpenChange"> & { focused: boolean }) {
  const { open } = useSidebarLayout()
  return <SidebarProvider {...props} open={open && !focused} onOpenChange={setSidebarOpen} />
}

const setSidebarOpen = (open: boolean) => setSidebarLayout("open", open)
