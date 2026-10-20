/* ── The shell ──
   The layout every route is read in: the sidebar column, the app header and
   the dock, which is the main area on every route (a thread is a chat panel,
   every other page is a `page` panel rendering `pageRoutes` against its own
   path). What lives here is what has to be *above* all of that — the route
   effects that turn a URL into a tab, the one draft-minting front door every
   "new thread" gesture takes, the device-level dialogs, and the chords.

   The sidebar's own pieces are `components/sidebar/`; the route tree and the
   page titles are `components/routes.tsx`, the only importer of the pages. */
import { uuid } from "@/lib/uuid"
import * as React from "react"
import { GitBranch, SearchIcon, Settings, XIcon } from "lucide-react"
import { useLocation, useNavigate } from "react-router"
import type { DockviewApi } from "dockview-react"
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
import { type SettingsSectionId } from "@/components/settings/sections"
import { ShortcutsHelp, useShortcutsHelp } from "@/components/shortcuts-help"
import { useSidebarWidth } from "@/components/sidebar/resizer"
import { ServerIconButton } from "@/components/sidebar/server-menu"
import { SpaceIconButton } from "@/components/sidebar/space-menu"
import {
  FOOTER_ICON,
  SettingsNav,
  SidebarNav,
  ThreadSidebar,
} from "@/components/thread-sidebar"
import type { OpenerTarget } from "@/components/workspace/dock-context"
import { useWorkspaceDock } from "@/components/workspace/dock"
import { useIsMobile } from "@/hooks/use-device"
import { WorkspaceDock } from "@/components/workspace/dock-surface"
import { LayoutMenu } from "@/components/workspace/tab-actions"
import { PageRoutesProvider } from "@/components/workspace/page-panel"
import { useShortcut } from "@/hooks/use-hotkey"
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
import { homeSpace, type ServerSettings, type SessionMeta } from "@/lib/settings"
import { setSidebarOpen, useSidebarOpen } from "@/lib/sidebar-layout"
import { useLayoutOptions } from "@/lib/layout-options"
import { formatChord } from "@/lib/shortcuts"
import { useStoreHandle, useStoreSelect } from "@/lib/store"
import { cn } from "@/lib/utils"
import { openTerminal } from "@/lib/workspace/open-terminal"
import { threadDock } from "@/lib/workspace/thread-docks"
import { HOME_PROJECT_ID, panelId, type PanelKind } from "@/lib/workspace/panels"
import { loadActiveSpace } from "@/lib/spaces"
import { IS_POPOUT } from "@/lib/popout"
import { setNewTabHandler, useActiveChat } from "@/lib/workspace/open-threads"
import { consumeQueuedPanels } from "@/lib/workspace/pending-panels"

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

/** The thread the address bar names — only on a thread route. `currentThreadId`
    also reads a legacy `?session=` deep link, which a schedule form carries on
    its own path, so the read is gated on the two places a thread can be. A
    trace (`/t/<id>/trace`) docks no chat and names none. */
function routedThreadId(pathname: string, search: string): string | null {
  if (pathname !== "/" && !pathname.startsWith("/t/")) return null
  return currentThreadId(pathname, search)
}

export function AppShell({
  settings,
  actions,
  loading: bootLoading,
  failed,
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
  /* The sidebar layout is the device's (Settings › Appearance): the component
     takes the variant, and the stylesheet keys the card, the gutters and the
     ground off the same fact on <html>. index.html writes it before first paint. */
  const { sidebarVariant: variant, sidebarCompact, showTabDetails } = useLayoutOptions()
  React.useEffect(() => {
    document.documentElement.dataset.sidebarLayout = variant
  }, [variant])
  /* Shorter thread rows (`html[data-sidebar-density]`, index.css). */
  React.useEffect(() => {
    document.documentElement.dataset.sidebarDensity = sidebarCompact ? "compact" : "comfortable"
  }, [sidebarCompact])
  /* One row or two on every dock tab (`--dock-tab-h`, index.css). */
  React.useEffect(() => {
    document.documentElement.dataset.tabRows = showTabDetails ? "2" : "1"
  }, [showTabDetails])
  const palette = useCommandPalette()
  // Whatever this is bound to on this device — the tooltip has to say the
  // key that actually works, not the one the release shipped.
  const paletteChord = useChord("palette") ?? ""
  const shortcuts = useShortcutsHelp()
  const [importing, setImporting] = React.useState(false)
  /* The header's own dialog — device-global, so it belongs to the shell rather
     than to any route or dock group under it. */
  const dock = useWorkspaceDock()
  const isMobile = useIsMobile()
  const activeChat = useActiveChat()
  const headingFor = usePageHeading()

  /* The sidebar's content is the reader's choice, not a reading of the route:
     the gear swaps the thread list for the settings sections and "Back to
     threads" swaps it back, neither navigating anywhere. A section row is what
     opens a page (in the tab in front, `navigateActive`). */
  const [settingsNav, setSettingsNav] = React.useState(false)
  const sessionId = routedThreadId(location.pathname, location.search)
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

  /* "New tab" opens a tab of its own, always — on the New tab page, whose quick
     actions start a thread, a task, a project's page, anything — and is what ⌘N,
     the sidebar row, the strip's + and the palette do. A tab is an isolated
     outlet, so whatever it then opens stays in it.

     Starting a *thread* straight away is the other shape: `text` is ⌘K's ask
     row, `projectId` a project's own +. Those mint a draft and open it in a tab
     of its own. An empty draft is invisible to every list (`isListed`) until it
     is sent, so minting one per press costs nothing but the tab you asked for,
     and the row is persisted (`lib/draft-sessions`) so a reload brings the tab
     back. `actions.send` is what turns a draft into a session, and it does not
     need the composer mounted, so the thread is already spawning while its
     transcript is opening; a failure lands in that thread as a Retry row. */
  const startThread = (opts: { text?: string; projectId?: string } = {}) => {
    if (!opts.text?.trim() && !opts.projectId) return dock.openTab()
    if (!ready) return openSettings("projects")
    const id = openDraftThread({ projectId: opts.projectId })
    if (!id) return openSettings("projects")
    dock.openTab(threadPath(id))
    const text = opts.text?.trim()
    if (text) void actions.send(id, text).catch(() => {})
  }

  const startRef = React.useRef({ startThread, openDraftThread })
  startRef.current = { startThread, openDraftThread }

  /* ── The URL is the source of truth for the focused tab ──
     Each mounted chat owns its own ACP connection, so background tabs keep
     streaming while hidden. Every route that is not a thread is shown in a
     page tab (`workspace/page-panel.tsx`, `openPage` in the dock): the URL
     points the browsing tab at the place it names, or opens one. `location.key`
     is a dependency on purpose — a sidebar row clicked for a page whose tab was
     just closed is the same path again, and has to open it again. */
  const pagePath = sessionId ? null : location.pathname + location.search
  /* The dock object is rebuilt whenever any of its readings moves (a running
     tab publishes state constantly). Depending on it re-ran these effects with
     a URL still naming the tab just left, and navigateActive then turned the
     tab you switched to back into the previous one. Read it, don't depend on it. */
  const dockRef = React.useRef(dock)
  dockRef.current = dock
  React.useEffect(() => {
    if (!pagePath) return
    dockRef.current.navigateActive(pagePath)
  }, [pagePath, location.key])

  /* ── Which thread the tab follows ──
     The routed thread's *state*, never its row. `sessions` is rewritten by
     every message this device sends — `session-title` and `turn-active` each
     map the array, whether or not anything in it moved — so an effect keyed on
     it re-ran on every send and re-focused the routed tab. That is invisible
     while the address bar agrees with the panel in front, and a yank when it
     does not: focusing a terminal or an IDE writes no route on purpose
     ("focusing a terminal must not navigate away from the thread it belongs
     to"), so the URL can still name a thread that is not the one in front, and
     the send then pulled the dock back to it mid-sentence. Only a change that
     alters whether the tab is opened at all is a dependency: absent (mint a
     draft), draft (spend the console), known (open or focus it). `location.key`
     stays, for the sidebar row clicked for a tab that was just closed — the
     same path again, and it has to open it again. */
  const routed = sessions.find((session) => session.id === sessionId)
  const routedState = !routed ? "absent" : routed.draft ? "draft" : "known"
  /* draft → known is the agent spawning, not a navigation: keyed on it, the
     effect re-opened (focused) the thread seconds after the reader had moved
     to another tab. Only absent ↔ present re-runs it; `routedState` is still
     read fresh inside, since any run happens on a render that holds it. */
  const routedKnown = routedState !== "absent"
  /* Flips once, when the spaces list first answers — a dependency so a cold
     load at another space's thread is re-asked then, and never a switch's own
     id, or the switch below would bounce off the URL it is about to replace. */
  const spacesKnown = activeSpaceId !== null
  React.useEffect(() => {
    if (!sessionId) return
    if (location.search) void navigate(threadPath(sessionId), { replace: true }) // legacy ?session=
    /* A thread from another space (search, a notification, a pasted link)
       takes you to its space rather than landing in this one's dock; the
       switch effect opens it once that space's tabs are in. */
    const owner = homeSpace(projects.find((project) => project.id === routed?.projectId), activeSpaceId)
    if (owner && activeSpaceId && owner !== activeSpaceId) {
      keepRef.current = sessionId
      setActiveSpace(owner)
      return
    }
    if (routedState !== "absent") {
      /* A tab is an isolated outlet: the thread you go to takes the place of the
         tab in front (and nothing happens if it is already showing it). A new
         thread is a new *tab* — that is `startThread` and the + — so by the time
         its route arrives it is the tab in front already. */
      dockRef.current.navigateActive(threadPath(sessionId))
      /* Panels a page without a dock asked to open beside this thread. After
         the chat, so they split against it. */
      for (const entry of consumeQueuedPanels()) dockRef.current.openPanel(entry.panel, entry.options)
      return
    }
    /* A route for a thread nobody knows about: an unsent draft after a reload
       (they only ever lived in the tab that made them) or one since purged.
       Either way an empty thread on that id beats a dead end — and if it is
       sent, the id in the URL bar is the id the server gets. Gated on `ready`
       so this cannot fire before bootstrap has filled sessions in. */
    if (ready) startRef.current.openDraftThread({ id: sessionId })
    // `navigate` and `location.search` are read, not depended on: the legacy
    // redirect above clears the search, and re-running on that would only
    // open the same tab a second time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, routedKnown, ready, spacesKnown, location.key])

  /* Drop tabs whose thread or project is gone — but never against a session
     list that never arrived. `loading` alone is not that test: a failed
     bootstrap still resolves (`finally` sets it), and pruning every restored
     chat against an empty list closes the whole workspace, which the debounced
     layout save then writes to disk. */
  /* ── A tab belongs to its project's space ──
     A thread is its project's, and a project is its space's, so the tabs of
     the space in front of you are exactly those — anything else in the dock is
     a tab that landed in the wrong space (or was filed there when spaces
     arrived) and is *filed under its own space*, not closed — a project moved
     to another space takes its tabs with it (a project filed in several keeps
     its tabs in whichever of them is in front, `homeSpace`), and they open when that space is
     next in front (`switchSpace`). A thread or project with no space is everyone's,
     as in the sidebar. `spaceRef` is the space the *dock* holds: moved only by
     the switch effect, never by the click, so a prune between the click and
     the swap cannot close the outgoing space's tabs before they are filed. */
  const spaceRef = React.useRef<string | null>(null)
  /* A thread routed from another space, opened once its space is in front. */
  const keepRef = React.useRef<string | null>(null)
  const pruneDock = React.useCallback(() => {
    const live = storeHandle.getState().sessions
    if (live.length === 0) return
    const space = spaceRef.current
    /* The space a tab's project is filed under when it is not this one — the
       dock files the tab there rather than closing it (`prunePanels`). */
    const elsewhere = (projectId?: string) => {
      const owner = homeSpace(projects.find((project) => project.id === projectId), space)
      return space && owner && owner !== space ? owner : null
    }
    dock.prunePanels(
      {
        sessions: live.map((session) => session.id),
        projects: [HOME_PROJECT_ID, ...projects.map((project) => project.id)],
      },
      (panel) =>
        panel.kind === "chat"
          ? elsewhere(live.find((session) => session.id === panel.sessionId)?.projectId)
          : panel.kind === "terminal" || panel.kind === "web"
            ? elsewhere(panel.projectId)
            : null
    )
  }, [projects, dock, storeHandle])

  React.useEffect(() => {
    if (loading || failed) return
    /* The session list is read off the store rather than off this render's
       snapshot. `sessions` is a `useSyncExternalStore` value, and the store
       publishes its ref in a layout effect — so a commit that flips `loading`
       (the boot promise resolving) can render before that ref caught up, and
       this effect then runs holding an empty list while the store already holds
       every row. Pruning on that empty list closed the very tabs the restore had
       just put back, and the debounced layout save wrote the loss to disk — the
       same failure the `failed` gate above exists to prevent, arriving by a
       different door. The store is authoritative at the moment the effect runs,
       so it is what the prune is given; the guard below is the backstop for a
       genuinely empty one. */
    pruneDock()
  }, [loading, failed, sessions, pruneDock])

  /* ── Switching spaces swaps the dock ──
     Each space keeps its own tabs (the layout store is keyed by space), so a
     switch files the tabs you were looking at under the space you were in and
     brings in the next space's. */
  React.useEffect(() => {
    if (loading || failed) return
    const previous = spaceRef.current
    spaceRef.current = activeSpaceId
    if (previous === activeSpaceId) return
    dock.switchSpace(previous, activeSpaceId)
    pruneDock()
    const keep = keepRef.current
    keepRef.current = null
    if (keep) dock.openChat(keep, { newTab: true })
  }, [activeSpaceId, loading, failed, dock, pruneDock])

  const handleDockReady = React.useCallback(
    (api: DockviewApi) => {
      dock.onReady(api)
      /* Same bargain as the route effects above, said here too because they
         can run before the dock has an api (a cold load, a theme change
         remounting DockviewReact): whatever the route names — a thread, or a
         page — gets its tab once the layout is restored, and `newTab` keeps a
         thread from replacing whatever was in front of you. */
      const route = routeRef.current
      dock.navigateActive(route.sessionId ? threadPath(route.sessionId) : route.path)
      window.desktop?.signalWorkspaceReady?.()
    },
    [dock]
  )

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

  /* One opener for every workspace panel, so the tab strip's + menu, the
     chords below and the palette cannot drift apart.

     **A + opens a new one; a chord shows you the one you have.** Pressing the
     button that means "open a terminal" a second time and being handed the
     terminal already open is the dock refusing the thing the strip's + is for
     — and with groups there is a second place to put it. So the default mints
     a fresh instance (`viewId`, or a whole new terminal), and `reuse` is what
     the chords and the thread's own links pass: those mean "show me the IDE
     for this project", which is a different question. */
  const openWorkspacePanel = React.useCallback(
    (kind: PanelKind, reuse?: boolean, target?: OpenerTarget) => {
      const into = target?.into
      /* A thread in front owns its terminal and preview: they open in
         its own dock (`thread-dock.tsx`), rooted in its worktree. The outer
         kinds below are what is left for a page in front — a $HOME shell. */
      const inThread = threadDock(routeRef.current.sessionId)
      if (inThread && (kind === "terminal" || kind === "web")) {
        inThread.open(kind, reuse)
        return
      }
      /* Only ever the *second* panel's suffix. The first of a kind keeps the
         plain panel id every stored layout and
         every reusing caller already names, so nothing has to migrate and a
         chord still lands on the one the + opened. */
      const second = (existing: unknown) =>
        !reuse && existing ? { viewId: uuid().slice(0, 8) } : {}
      /* Boards are the server's, not a project's, so this one opens with no
         project at all — the only kind that does. Reopened with the board it
         was left on, not reset to "no board": the descriptor is where a tasks
         panel keeps its place. */
      if (kind === "tasks") {
        const existing = dock.listPanels().find((entry) => entry.panel.kind === "tasks")
        if (existing && reuse) dock.openPanel(existing.panel, { direction: "right" })
        else dock.openPanel({ kind: "tasks", ...second(existing) }, { direction: "right", into })
        return
      }
      /* Which project the new panel acts on is the panel *in front of you*,
         and only then the route: focusing a terminal or an IDE navigates
         nowhere, so the route still names the chat you were last reading and
         a + pressed over project A's terminal used to open project B's. Chats
         and pages write the route themselves, which is what the fallback
         answers for. */
      /* A caller that knows the project says so — a tab's own menu is about
         *that* tab, which need not be the one in front. */
      const focused = dock.activeDescriptor()
      const focusedProject =
        focused && "projectId" in focused ? (focused.projectId as string | undefined) : undefined
      const projectId =
        target?.projectId ??
        (focusedProject === HOME_PROJECT_ID
          ? HOME_PROJECT_ID
          : projects.find((candidate) => candidate.id === focusedProject)?.id) ??
        routeRef.current.projectId ??
        HOME_PROJECT_ID
      if (kind === "terminal") {
        /* A terminal is already one panel per shell — the only thing reuse
           changes here is whether a second shell is started at all. */
        const existing = dock
          .listPanels()
          .find((entry) => entry.panel.kind === "terminal" && entry.panel.projectId === projectId)
        if (existing && reuse) dock.openPanel(existing.panel)
        else void openTerminal(dock, projectId, into)
      } else if (kind === "web") {
        /* The stored preview URL rides on the descriptor, so a project panel
           opens on its dev server instead of an empty address bar — and an
           existing panel is re-pointed to it the same way. */
        const previewUrl = projects.find((candidate) => candidate.id === projectId)?.previewUrl ?? ""
        const existing = dock
          .listPanels()
          .find((entry) => entry.panel.kind === "web" && entry.panel.viewId === "default")
        dock.openPanel(
          {
            kind: "web",
            trust: "project",
            ...(projectId !== HOME_PROJECT_ID ? { projectId } : {}),
            viewId: "default",
            ...second(existing),
            ...(previewUrl ? { url: previewUrl } : {}),
          },
          { direction: "right", into }
        )
      }
    },
    [dock, projects]
  )

  /* Mirrors the palette's "New thread" entry — the palette advertises the
     shortcut, so something has to answer for it. The chords are named in
     lib/shortcuts, which is also what the help sheet prints. */
  useShortcut("newThread", () => startRef.current.startThread())
  useShortcut("terminal", () => openWorkspacePanel("terminal", true))
  /* changeModel / changeProject / chooseMcp are the composer's: they open its
     own menus (`Composer`, `ConfigPopover`), which list everything — a draft's
     agent and profile, effort, mode, MCPs — where the palette's pages list only
     a live agent's selectors. */
  useShortcut("threadSearch", () => {
    if (!sessionId) return false
    palette.openAt("thread-search")
  }, { enabled: !!sessionId })
  useShortcut("viewOptions", () => void navigate(settingsPath("appearance")))
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
      style={{
        "--sidebar-width": sidebar.width,
        height: "100dvh",
        // Both sides: a landscape notch is on the right as often as the left.
        paddingLeft: "env(safe-area-inset-left, 0px)",
        paddingRight: "env(safe-area-inset-right, 0px)",
      } as React.CSSProperties}
    >
      {/* First in the tree so its effect runs before any sibling subtree's:
          the dock fires onDidActivePanelChange while restoring its saved
          layout, and navigateTo must already have the router's navigate by
          then — the location.assign fallback would be a full reload. */}
      <NavigationBridge />
      <CloseSidebarOnNavigate />
      {/* A flush rail: shadcn's stock `sidebar` variant, a panel with a 1px
          edge and the column beside it filling the rest — no floating card, no
          outer gutters. `offcanvas`, not `icon`: a 3rem column of glyphs is
          still a column, and the toggle that brings it back lives in the app
          header, which is on every route. */}
      <Sidebar collapsible="offcanvas" variant={variant} className={variant === "inset" ? "p-0" : undefined}>
        {/* The brand row is the app header's own row: the same top offset (the
            status-bar inset, then the frame gap the column keeps above its
            header) and the same height (`--app-header-row-h`), so the brand
            and Search stand on one line with the tab strip's chips across the
            seam (the frame gap is zero in the flush layout, so the offset is the
            status-bar inset alone). */}
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
          {settingsNav ? (
            <SettingsNav onBack={() => setSettingsNav(false)} />
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
              onClick={() => setSettingsNav((on) => !on)}
              className={cn(
                FOOTER_ICON,
                settingsNav && "bg-sidebar-accent text-sidebar-accent-foreground",
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
      {/* The column the app is read in: a plain `<main>` beside the rail. The
          header row and the dock's strips stand on the rail's own tone (one
          band across the top of the window) and each group's content fills
          what is below its strip on `--background`.

          `min-h-0` has to be here: the provider is pinned to `100dvh`, and it
          is what lets the scrolling column inside shrink to it. */}
      <SidebarInset className="flex min-h-0 flex-col overflow-hidden">
        {/* An overlay spanning the whole top, INSIDE `SidebarInset` — it is the
            card's bar, not the window's. The dock's top groups join this row
            (`data-header-band`; `syncHeaderOverlap` in workspace/dock-header.ts measures
            how much of a panel it covers, which a constant answered wrongly
            for every group not at the top), and a strip cannot join a row
            above the box it is in. Standing it outside the sidebar wrapper as
            a full-width strip was tried and reverted: four surfaces
            re-pointed for one bar.

            `pointer-events-none`, with each occupant turning it back on: its
            own box is nothing but the ground its chips stand on plus the
            blur. Left live it swallows every press that lands between them —
            every tab of a group standing in this row, and every attempt to
            select the first line of a transcript scrolled under it.

            Below `md` the header is the same container as the transcript and
            the composer: `px-4`, the 16px gutter they keep, so the bar's box
            starts where the content below it does. (It was 9px — the glyph's
            own edge on the 16px line rather than the chip's — which lined up a
            control with the text but made the bar a wider container than
            everything under it.)
            `px-1` above `md`, where the chips stand on the card's own edge. The
            tab strip in the band pads by this box's content edge
            (`--dock-band-left`, workspace/dock-header.ts), so it follows. */}
        <header
          data-app-header
          data-drag-region
          className="pointer-events-none absolute inset-x-0 top-0 z-30 flex h-[var(--app-header-h)] items-center gap-1 bg-transparent px-4 pt-[var(--app-inset-top)] md:px-1"
        >
          {/* The strip is an overlay at every width (`index.css`) and the
              transcript scrolls up under the tabs and this bar, so the bar
              carries a progressive blur that takes those lines out of focus
              before they reach the chips. Caveat: a backdrop filter turns off
              the window's vibrancy/acrylic across the band. */}
          <ProgressiveBlur
            position="top"
            height="calc(100% + 1rem)"
            blurLevels={[0.4, 0.8, 1.4, 2.2, 3.4, 5.4, 8.6, 14]}
            className={cn("absolute inset-x-0 top-0 -z-10", variant === "inset" && "hidden")}
          />
          {/* The two device-level controls. No title and no crumb — every
              route is a tab, and the tab says the name; a thread keeps only
              its fork badge here. Wrapped and named so the dock can measure
              what a strip in this row has to reserve (`--dock-band-left`).
              Nothing on the right: the bell and the palette stand in the
              sidebar header. */}
          {/* One 4px gutter at every width, the same one the tab strip keeps
              between its tabs and its +/list buttons (`tab-actions.tsx`): this
              cluster stands in that row, and 8px here against 4px there read
              as two spacings on one line. */}
          <div data-header-left className="flex min-w-0 items-center gap-1">
              <SidebarTrigger className={cn(HEADER_CHIP, "pointer-events-auto shrink-0")} />
              {/* The dock's arrangement, once, beside the toggle: it is about the
                  whole dock, not one strip. Not on a phone, which has no splits. */}
              {!isMobile && (
                <LayoutMenu
                  onPick={dock.applyPreset}
                  className={cn(HEADER_CHIP, "pointer-events-auto shrink-0 [-webkit-app-region:no-drag]")}
                />
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
        </header>
        {/* The main area is the dock, on every route. The card is each group's
            content container (`index.css`), under its tabs. The dock outlives
            the route: background tabs keep their ACP connections and scroll
            positions while another tab is focused. */}
        <div className="flex min-h-0 flex-1">
          <PageRoutesProvider value={{ routes, headingFor }}>
            <WorkspaceDock
              actions={actions}
              dock={dock}
              onReady={handleDockReady}
              /* The strip's + is the app's "new tab": a new thread, in a tab of
                 its own. The landing console is where the dock lands when the
                 last tab closes, not what + opens. */
              onNewTab={() => dock.openTab()}
              onOpenPanel={openWorkspacePanel}
            />
          </PageRoutesProvider>
        </div>
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
        onViewOptions={() => void navigate(settingsPath("appearance"))}
        initialPage={palette.initialPage}
      />
      <ShortcutsHelp open={shortcuts.open} onOpenChange={shortcuts.setOpen} />
      {/* Owned here rather than by the palette, which unmounts as soon as a
          command runs. The project page mounts its own, scoped to itself. */}
      <ImportThreadsDialog open={importing} onOpenChange={setImporting} actions={actions} />
      {/* Opened by the sliders in the header. Here rather than beside that
          button so it is not unmounted with a header some routes draw
          differently. */}
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
function PersistedSidebarProvider(
  props: Omit<React.ComponentProps<typeof SidebarProvider>, "open" | "onOpenChange">
) {
  const open = useSidebarOpen()
  return <SidebarProvider {...props} open={open} onOpenChange={setSidebarOpen} />
}

