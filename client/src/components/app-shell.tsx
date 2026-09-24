/* ── The shell ──
   The layout every route is read in: the sidebar column, the app header and
   the dock, which is the main area on every route (a thread is a chat panel,
   every other page is a `page` panel rendering `pageRoutes` against its own
   path). What lives here is what has to be *above* all of that — the route
   effects that turn a URL into a tab, the one draft-minting front door every
   "new thread" gesture takes, the device-level dialogs, and the chords.

   The sidebar's own pieces are `components/sidebar/`; the route tree and the
   page titles are `components/routes.tsx`, the only importer of the pages. */
import * as React from "react"
import { GitBranch, SearchIcon, Settings, SlidersHorizontalIcon } from "lucide-react"
import { useLocation, useNavigate } from "react-router"
import type { DockviewApi } from "dockview-react"
import { BottomNav } from "@/components/bottom-nav"
import { Button } from "@/components/ui/button"
import { Logo } from "@/components/ui/logo"
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
import { sectionOf, type SettingsSectionId } from "@/components/settings/sections"
import { SessionSettingsDialog } from "@/components/session-settings"
import { ShortcutsHelp, useShortcutsHelp } from "@/components/shortcuts-help"
import { useSidebarWidth } from "@/components/sidebar/resizer"
import { ServerIconButton } from "@/components/sidebar/server-menu"
import {
  FOOTER_ICON,
  SettingsNav,
  SidebarNav,
  SidebarUsage,
  ThreadSidebar,
} from "@/components/thread-sidebar"
import { useWorkspaceDock } from "@/components/workspace/dock"
import { WorkspaceDock } from "@/components/workspace/dock-surface"
import { PageRoutesProvider } from "@/components/workspace/page-panel"
import { useIsMobile } from "@/hooks/use-device"
import { useShortcut } from "@/hooks/use-hotkey"
import type { Actions } from "@/lib/actions"
import { useDesktopBridge } from "@/lib/desktop"
import { HEADER_BADGE, HEADER_CHIP } from "@/lib/header-chrome"
import { useChord } from "@/lib/keybindings"
import { useCatalogLoaded, useProfiles, useProjects } from "@/lib/queries/catalog"
import {
  currentThreadId,
  NavigationBridge,
  settingsFormPath,
  settingsPath,
  settingsRootPath,
  threadPath,
} from "@/lib/router"
import type { ServerSettings } from "@/lib/settings"
import { setSidebarLayout, useSidebarLayout } from "@/lib/sidebar-layout"
import { formatChord } from "@/lib/shortcuts"
import { useStoreHandle, useStoreSelect } from "@/lib/store"
import { cn } from "@/lib/utils"
import { openTerminal } from "@/lib/workspace/open-terminal"
import { HOME_PROJECT_ID, type PanelKind } from "@/lib/workspace/panels"
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
  const dock = useWorkspaceDock()
  const headingFor = usePageHeading()
  const isMobile = useIsMobile()

  const inSettings = location.pathname.startsWith("/settings")
  const section = inSettings ? sectionOf(location.pathname.split("/")[2] ?? "") : null
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

  /* ── The URL is the source of truth for the focused tab ──
     Each mounted chat owns its own ACP connection, so background tabs keep
     streaming while hidden. Every route that is not a thread is shown in a
     page tab (`workspace/page-panel.tsx`, `openPage` in the dock): the URL
     points the browsing tab at the place it names, or opens one. `location.key`
     is a dependency on purpose — a sidebar row clicked for a page whose tab was
     just closed is the same path again, and has to open it again. */
  const pagePath = sessionId ? null : location.pathname + location.search
  React.useEffect(() => {
    if (!pagePath) return
    dock.openPage(pagePath)
  }, [pagePath, location.key, dock])

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
  React.useEffect(() => {
    if (!sessionId) return
    if (location.search) void navigate(threadPath(sessionId), { replace: true }) // legacy ?session=
    if (routedState !== "absent") {
      /* Always a tab of its own. Opening a thread used to *replace* the chat
         you were reading — the sidebar as navigation — and a new tab was the
         opt-in a ⌘-click or a menu row asked for. It is the other way round
         now: a thread you opened is a thread you meant to keep, and the one
         thing that closed a transcript you were mid-way through was clicking
         the next one. An already-open thread is still focused, not duplicated
         (`openPanel` answers on the panel id), so this only ever adds a tab
         for a thread that had none. */
      /* The console is spent by the thread it started. Asked before the open,
         because opening a chat is what makes it the active panel — after that
         the console is never what is in front of anyone. A routed *draft* is
         the signature: the console mints one and navigates to it before the
         send, so this can only ever spend a console you were just typing in,
         never a page tab you are merely reading. */
      if (routedState === "draft") dock.consumeConsole()
      dock.openChat(sessionId, { newTab: true })
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
    if (ready) startRef.current.openDraftThread({ id: sessionId })
    // `navigate` and `location.search` are read, not depended on: the legacy
    // redirect above clears the search, and re-running on that would only
    // open the same tab a second time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, routedState, ready, dock, location.key])

  /* Drop tabs whose thread or project is gone — but never against a session
     list that never arrived. `loading` alone is not that test: a failed
     bootstrap still resolves (`finally` sets it), and pruning every restored
     chat against an empty list closes the whole workspace, which the debounced
     layout save then writes to disk. */
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
    const live = storeHandle.getState().sessions
    if (live.length === 0) return
    dock.prunePanels({
      sessions: live.map((session) => session.id),
      projects: [HOME_PROJECT_ID, ...projects.map((project) => project.id)],
    })
  }, [loading, failed, sessions, projects, dock, storeHandle])

  const handleDockReady = React.useCallback(
    (api: DockviewApi) => {
      dock.onReady(api)
      /* Same bargain as the route effects above, said here too because they
         can run before the dock has an api (a cold load, a theme change
         remounting DockviewReact): whatever the route names — a thread, or a
         page — gets its tab once the layout is restored, and `newTab` keeps a
         thread from replacing whatever was in front of you. */
      const route = routeRef.current
      if (route.sessionId) dock.openChat(route.sessionId, { newTab: true })
      else dock.openPage(route.path)
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
    (kind: PanelKind, reuse?: boolean) => {
      /* Only ever the *second* panel's suffix. The first of a kind keeps the
         plain panel id every stored layout and
         every reusing caller already names, so nothing has to migrate and a
         chord still lands on the one the + opened. */
      const second = (existing: unknown) =>
        !reuse && existing ? { viewId: crypto.randomUUID().slice(0, 8) } : {}
      /* Boards are the server's, not a project's, so this one opens with no
         project at all — the only kind that does. Reopened with the board it
         was left on, not reset to "no board": the descriptor is where a tasks
         panel keeps its place. */
      if (kind === "tasks") {
        const existing = dock.listPanels().find((entry) => entry.panel.kind === "tasks")
        if (existing && reuse) dock.openPanel(existing.panel, { direction: "right" })
        else dock.openPanel({ kind: "tasks", ...second(existing) }, { direction: "right" })
        return
      }
      /* Which project the new panel acts on is the panel *in front of you*,
         and only then the route: focusing a terminal or an IDE navigates
         nowhere, so the route still names the chat you were last reading and
         a + pressed over project A's terminal used to open project B's. Chats
         and pages write the route themselves, which is what the fallback
         answers for. */
      const focused = dock.activeDescriptor()
      const focusedProject =
        focused && "projectId" in focused ? (focused.projectId as string | undefined) : undefined
      const projectId =
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
        else void openTerminal(dock, projectId)
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
          { direction: "right" }
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
  /* The two chords that open a chooser rather than doing a thing. They go
     through the palette's own pages — one list per question, whether it was
     reached by chord or by typing its row — and the palette answers for a
     thread that has nothing to offer (no model selector, no draft) by listing
     nothing, which is the same answer its row's absence gives. */
  useShortcut("changeModel", () => palette.openAt("model"))
  useShortcut("changeProject", () => palette.openAt("project"))
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

  const sidebarLayout = useSidebarLayout()

  return (
    <SidebarProvider
      /* Controlled, so the open state is the device store's and survives a
         reload. The primitive's own internal state — and the cookie it writes
         beside it — is left unused, which is deliberate: the vendored
         component is reinstallable and the memory belongs to the app. Mobile
         is unaffected: the sheet toggles `openMobile`, which this does not
         drive, so a phone never restores an open overlay. */
      open={sidebarLayout.open}
      onOpenChange={(open) => setSidebarLayout("open", open)}
      style={{
        "--sidebar-width": sidebar.width,
        height: "100dvh",
        paddingLeft: "env(safe-area-inset-left, 0px)",
      } as React.CSSProperties}
    >
      {/* First in the tree so its effect runs before any sibling subtree's:
          the dock fires onDidActivePanelChange while restoring its saved
          layout, and navigateTo must already have the router's navigate by
          then — the location.assign fallback would be a full reload. */}
      <NavigationBridge />
      <CloseSidebarOnNavigate />
      {/* shadcn's `inset` layout, less the column's own `p-2` frame (`p-0`):
          the provider paints the whole wrapper `bg-sidebar`, and the only
          inset is the 8px each group, the footer and the brand row carry, so
          a row ground is 8px from every edge — the same on the web, a desktop
          titlebar and the phone sheet. `SidebarInset` is the column the app
          is read in. `offcanvas`, not
          `icon`: a 3rem column of glyphs is still a column, and the toggle
          that brings it back lives in the app header, which is on every
          route. */}
      <Sidebar variant="inset" collapsible="offcanvas" className="p-0">
        {/* The same 8px on every side. The brand row used to be the app
            header row's height with its chips centred in it, so the two halves
            of the bar sat on one line across the seam — but that centring
            left a different gap above the chips on every platform, against
            the 8px every row ground and the footer keep from their edges. Now
            the row pads by the same `pt-2` (on the drag region, so macOS's own
            titlebar padding on this element still stacks under it) and is
            only as tall as its chips; the seam is a few px off, which is the
            price of one inset. The status-bar inset stays on the header
            itself. `px-2` here, `px-2` on every group, `p-2` on the footer
            and `pt-2` on the content, so the brand row's chips, every row's
            hover ground and the footer stand on the same 8px line. The brand
            button pads its own `pl-2`, which puts the logo on the row-icon
            line. */}
        <SidebarHeader className="gap-2 px-2 pt-[var(--app-inset-top)] pb-0">
          <div data-drag-region className="flex items-center gap-2 pt-2 group-data-[collapsible=icon]:flex-col">
            <button
              type="button"
              onClick={() => void navigate("/")}
              aria-label="Go to homepage"
              /* Collapsed, the brand is one more icon in the rail and has to
                 sit on its axis: the nav rows below are 32px buttons inside a
                 group's 8px padding, so their glyph centres on 24px — the
                 rail's own centre. So in the rail the button becomes that same
                 32px box, centred. */
              className="flex shrink-0 items-center gap-2 pl-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center"
            >
              <Logo idle className="size-4 shrink-0" />
              <span className="brand-script text-xl leading-none group-data-[collapsible=icon]:hidden">
                Daedalus
              </span>
            </button>
            {/* The palette, beside the brand. It is the app's own, not a
                route's and not a dock group's — the sidebar is the one surface
                that is on every route and never splits, which is why it is
                here rather than in a header the workspace shares with tabs.
                In the icon rail it stacks under the brand with the footer's
                icons, which is where every other control lives. */}
            <div className="ml-auto flex items-center gap-0.5 group-data-[collapsible=icon]:ml-0 group-data-[collapsible=icon]:flex-col">
              <Button
                variant="ghost"
                size="icon-xs"
                className={cn(HEADER_CHIP, "text-muted-foreground hover:text-foreground")}
                title={`Search threads and commands (${formatChord(paletteChord)})`}
                aria-label="Search"
                onClick={() => palette.setOpen(true)}
              >
                <SearchIcon className="size-3.5" />
              </Button>
            </div>
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
              {/* The fixed nav rows sit above the list, the way the Codex and
                  Claude desktop sidebars open. `New project` stays reachable
                  from /settings/projects and the command palette. */}
              <SidebarNav onNewThread={() => startRef.current.startThread()} />
              {loading ? <SidebarGroupsSkeleton /> : <ThreadSidebar actions={actions} />}
            </>
          )}
        </SidebarContent>
        <SidebarFooter className="p-2">
          {/* ── One row of icons ──
              The four things the panel itself needs, on one line: what is left
              of the plans this machine spends, the server it is talking to,
              what has arrived while you were away, and the way into every
              setting. They were two rows of labelled buttons, which cost the
              thread list their 128px and made the panel's furniture read as
              more places to go. Each is a control that opens something, and
              each says its own name in a tooltip. `SidebarUsage` draws itself
              away when nothing reports a plan, so a machine with no plan has
              three. */}
          <div className="flex items-center gap-0.5 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:gap-1">
            <SidebarUsage />
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
      {/* The column the app is read in — and not the card. The variant draws
          `m-2 ml-0 rounded-xl shadow-sm bg-background`, and `index.css` takes
          the radius, the shadow and the background back off it
          (`[data-slot="sidebar-inset"]`), keeping only the gutter: the header
          row stands on the wrapper's ground, and the card is what is *below*
          the header — each dock group's content container under its tabs.

          **No `h-full` here, and that is the whole reason the app has one
          scrollbar.** The provider is pinned to `height: 100dvh` above, and the
          variant gives this element `m-2` — so `h-full` asked for 100dvh of
          content *plus* 16px of margin inside a 100dvh box, and the 16px it
          could not fit went to the document, which grew a second scrollbar.
          The wrapper is a row flex container with the default `align-items:
          stretch`, which sizes an item's **margin box** to the container — so
          with no height declared this resolves to exactly `100dvh - 16px`.
          `min-h-0` still has to be here: stretch gives a definite height, and
          `min-h-0` is what lets the scrolling column inside shrink to it. */}
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
          className="pointer-events-none absolute inset-x-0 top-0 z-30 flex h-[var(--app-header-h)] items-center gap-1 bg-transparent px-4 pt-[var(--app-inset-top)] sm:gap-2 md:px-1"
        >
          {/* ── The header paints NOTHING, and carries no backdrop filter ──
              One bar on every device: no ground of its own, no ramp, no blur.
              The band it spans is the shell's ground (`body::before`,
              `--app-ground`), the same sheet the sidebar and the gutters are
              transparent down to, so the strip in this row and the sidebar
              beside it are one surface by construction — which is only true
              while nothing here paints over it.

              A `backdrop-blur` here is that paint, and under the window's own
              material it is the thing that turns the material off. A
              backdrop-filter composites its backdrop *from the page*, and
              macOS vibrancy / Windows acrylic live behind the **window**, not in
              the page — so the filtered box is drawn without them and the
              header's row comes out a flat slab across exactly the tab strip's
              band, against a sidebar two pixels away that still shows the
              desktop. The blur was there to soften a line of transcript
              passing under the chips, and nothing passes under them any more:
              the band is in flow above the card (`data-header-band`,
              index.css) and the transcript starts below it. A filter with
              nothing to filter, costing a compositing layer and the OS
              material. */}
          {/* The two device-level controls. No title and no crumb — every
              route is a tab, and the tab says the name; a thread keeps only
              its fork badge here. Wrapped and named so the dock can measure
              what a strip in this row has to reserve (`--dock-band-left`).
              Nothing on the right: the bell and the palette stand in the
              sidebar header. */}
          {/* `md`, not `sm`: below `md` this cluster stands *in the tab strip's
              row*, where the one gutter is 4px (the tab chip's `mx-0.5` twice
              over). At `sm` it widened to 8px while the tab 2px away from it
              did not, which is the row reading as two different spacings. */}
          <div data-header-left className="flex min-w-0 items-center gap-1 md:gap-2">
            {/* On a phone the bottom bar's Threads is this toggle, within
                thumb reach, so the header row gives its width to the tab. */}
            {!isMobile && <SidebarTrigger className={cn(HEADER_CHIP, "pointer-events-auto shrink-0")} />}
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
            {/* A branch says where it came from, once, beside the tab that
                names it — the one thing provenance is for. Clicking goes to the
                parent thread as it is now, not to the turn it was cut at. */}
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
              onNewTab={() => startRef.current.startThread()}
              onOpenPanel={openWorkspacePanel}
            />
          </PageRoutesProvider>
        </div>
        {/* The phone's bar, in flow under the dock (see bottom-nav.tsx). */}
        {isMobile && <BottomNav onNewThread={() => startRef.current.startThread()} />}
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
        onViewOptions={() => setViewSettings(true)}
        initialPage={palette.initialPage}
      />
      <ShortcutsHelp open={shortcuts.open} onOpenChange={shortcuts.setOpen} />
      {/* Owned here rather than by the palette, which unmounts as soon as a
          command runs. The project page mounts its own, scoped to itself. */}
      <ImportThreadsDialog open={importing} onOpenChange={setImporting} actions={actions} />
      {/* Opened by the sliders in the header. Here rather than beside that
          button so it is not unmounted with a header some routes draw
          differently. */}
      <SessionSettingsDialog open={viewSettings} onOpenChange={setViewSettings} />
    </SidebarProvider>
  )
}
