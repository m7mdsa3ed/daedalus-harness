import * as React from "react"
import { ChevronLeft, ChevronRight, FolderPlus, Plus, Settings2, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { SettingsSectionSkeleton, SetupCardsSkeleton, SidebarGroupsSkeleton } from "@/components/ui/skeletons"
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
import { navigate, useRoute } from "@/lib/router"
import type { ServerSettings, SessionMeta } from "@/lib/settings"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import {
  ProjectForm,
  SETTINGS_NAV_GROUPS,
  SETTINGS_SECTIONS,
  SettingsPage,
  type SettingsSectionId,
} from "./settings-page"
import { ThreadView } from "./thread-view"

/** Swappable sidebar body. One panel per route family — see `panels` below. */
interface SidebarPanel {
  /** Row pinned under the brand: this panel's primary action, or its way out. */
  top: React.ReactNode
  body: React.ReactNode
}

const SIDEBAR_WIDTH_KEY = "sidebar_width"
const SIDEBAR_WIDTH_DEFAULT = "16rem"
/** Rows a group shows before it folds the rest behind "Show N more". */
const THREADS_SHOWN = 5

/** Compact age for a thread row: now, 5m, 3h, 2d, then a date. */
function ago(ts: number): string {
  const minutes = Math.round((Date.now() - ts) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`
  if (minutes < 60 * 24 * 7) return `${Math.floor(minutes / (60 * 24))}d`
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** URL segment → a section that exists; anything else falls back to General. */
const sectionOf = (value: string): SettingsSectionId =>
  SETTINGS_SECTIONS.find((s) => s.id === value)?.id ?? "general"

export function AppShell({
  settings,
  actions,
  loading,
}: {
  settings: ServerSettings
  actions: Actions
  loading: boolean
}) {
  const { state } = useStore()
  const route = useRoute()
  // The project the new-thread dialog is for; null while it's closed. "" means
  // "no project picked yet" — the dialog falls back to the first one.
  const [newThreadProject, setNewThreadProject] = React.useState<string | null>(null)
  const [newProjectOpen, setNewProjectOpen] = React.useState(false)
  // Sidebar width overrides the shadcn default via the same CSS var it reads.
  const [sidebarWidth, setSidebarWidth] = React.useState(
    () => localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? SIDEBAR_WIDTH_DEFAULT
  )
  const [resizing, setResizing] = React.useState(false)
  const sessionId = route.name === "thread" ? route.sessionId : null
  const section = sectionOf(route.name === "settings" ? route.section : "")
  // Leaving settings returns to the thread it was opened from.
  const lastThread = React.useRef<string | null>(null)
  if (sessionId) lastThread.current = sessionId
  const active = state.sessions.find((s) => s.id === sessionId)
  const ready = !loading && state.projects.length > 0 && state.profiles.length > 0

  /* The route is the source of truth: whatever thread the URL names gets
     connected — on click, on reload, on back/forward and on a push deep link. */
  React.useEffect(() => {
    if (!sessionId) return
    if (location.search) navigate({ name: "thread", sessionId }, { replace: true }) // legacy ?session=
    const meta = state.sessions.find((s) => s.id === sessionId)
    if (meta) actions.openThread(meta).catch((err) => toast.error(String(err)))
  }, [sessionId, state.sessions, actions])

  const openSettings = (next?: SettingsSectionId) =>
    navigate({ name: "settings", section: next ?? section })
  const startThread = (projectId = "") =>
    ready ? setNewThreadProject(projectId) : openSettings("projects")

  /* ── Sidebar panels ──
     The sidebar body is swappable: one entry per route family. To add a panel,
     add a route in lib/router and an entry here — the shell itself is generic. */
  const panels: Record<"threads" | "settings", SidebarPanel> = {
    threads: {
      // Threads start from a project (the + on each group), so the one action
      // that isn't per-project is the one pinned up here.
      top: (
        <SidebarMenuButton
          tooltip="New project"
          variant="outline"
          onClick={() => setNewProjectOpen(true)}
          disabled={loading}
        >
          <FolderPlus className="size-4" />
          <span className="font-medium">New project</span>
        </SidebarMenuButton>
      ),
      body: loading ? (
        <SidebarGroupsSkeleton />
      ) : (
        <ThreadGroups actions={actions} onNewThread={startThread} />
      ),
    },
    settings: {
      top: (
        <SidebarMenuButton
          tooltip="Back to threads"
          onClick={() =>
            navigate(
              lastThread.current
                ? { name: "thread", sessionId: lastThread.current }
                : { name: "home" }
            )
          }
        >
          <ChevronLeft className="size-4" />
          <span>Back to threads</span>
        </SidebarMenuButton>
      ),
      body: (
        <SettingsNav
          section={section}
          onSelect={(next) => navigate({ name: "settings", section: next })}
        />
      ),
    },
  }
  const panel = panels[route.name === "settings" ? "settings" : "threads"]

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
      <Sidebar collapsible="icon">
        {/* Brand + the panel's one primary action; the list below is all content. */}
        <SidebarHeader className="gap-2 p-2">
          <div
            data-drag-region
            className="flex h-8 items-center gap-2 px-1 group-data-[collapsible=icon]:px-0"
          >
            <img src="/logo.svg" alt="" className="size-6 shrink-0" />
            <span className="text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
              Daedalus
            </span>
          </div>
          <SidebarMenu>
            <SidebarMenuItem>{panel.top}</SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent className="py-1">{panel.body}</SidebarContent>
        <SidebarFooter className="border-t border-sidebar-border/60 p-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Settings"
                isActive={route.name === "settings"}
                onClick={() => openSettings()}
                className="text-sidebar-foreground/70 data-active:text-sidebar-accent-foreground"
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
          <div className="flex min-w-0 flex-1 items-center justify-between gap-2 sm:gap-3">
            <div className="flex min-w-0 items-baseline gap-2">
              {loading ? (
                <Skeleton className="h-4 w-32" />
              ) : (
                <h1 className="truncate text-sm font-medium">
                  {route.name === "settings"
                    ? (SETTINGS_SECTIONS.find((s) => s.id === section)?.label ?? "Settings")
                    : (active?.title ?? "Daedalus")}
                </h1>
              )}
              {route.name === "settings" ? (
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
        </header>
        {route.name === "settings" ? (
          loading ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-16 sm:px-8">
                <SettingsSectionSkeleton />
              </div>
            </div>
          ) : (
            <SettingsPage section={section} settings={settings} actions={actions} />
          )
        ) : sessionId ? (
          <ThreadView key={sessionId} sessionId={sessionId} actions={actions} />
        ) : (
          <EmptyState
            loading={loading}
            ready={ready}
            onNewThread={() => startThread()}
            onOpenSettings={openSettings}
          />
        )}
      </SidebarInset>
      <NewThreadDialog
        open={newThreadProject !== null}
        onOpenChange={(open) => !open && setNewThreadProject(null)}
        projectId={newThreadProject ?? ""}
        onProjectChange={setNewThreadProject}
        actions={actions}
      />
      {/* Same form the settings page uses — created from the sidebar too. */}
      <ResponsiveDialog open={newProjectOpen} onOpenChange={setNewProjectOpen}>
        <ResponsiveDialogContent>
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
        <SidebarGroup key={group.label}>
          <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
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

const DEFAULT_CHOICE = "__default__"

/** New session for a project: agent → profile → model → effort (reference flow). */
function NewThreadDialog({
  open,
  onOpenChange,
  projectId,
  onProjectChange,
  actions,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Owned by the shell: opening from a project's + is what preselects it. */
  projectId: string
  onProjectChange: (projectId: string) => void
  actions: Actions
}) {
  const { state } = useStore()
  const { setOpenMobile } = useSidebar()
  const [agentId, setAgentId] = React.useState("")
  const [profileId, setProfileId] = React.useState("")
  const [model, setModel] = React.useState<string | null>(null)
  const [effort, setEffort] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const project = state.projects.find((p) => p.id === projectId) ?? state.projects[0]
  const agent = state.agents.find((a) => a.id === agentId) ?? state.agents[0]
  const agentProfiles = state.profiles.filter((p) => p.agentId === agent?.id)
  const profile = agentProfiles.find((p) => p.id === profileId) ?? agentProfiles[0]
  const resolvedModel = profile?.models.find((m) => m.id === (model ?? profile.defaultModel))
  const efforts = resolvedModel?.reasoningEfforts ?? []

  const start = async () => {
    if (!project || !profile) return
    setBusy(true)
    try {
      setOpenMobile(false)
      const sessionId = await actions.newThread(project, profile, model ?? undefined, effort ?? undefined)
      navigate({ name: "thread", sessionId })
      onOpenChange(false)
      setModel(null)
      setEffort(null)
    } catch (err) {
      toast.error(String(err))
    } finally {
      setBusy(false)
    }
  }

  const pick = (label: string, node: React.ReactNode) => (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      {node}
    </div>
  )

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>New thread</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {pick(
            "Project",
            <Select value={project?.id ?? ""} onValueChange={(v) => v && onProjectChange(v)}>
              <SelectTrigger className="w-full">
                <SelectValue>{project?.name}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {state.projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {pick(
            "Agent",
            <Select
              value={agent?.id ?? ""}
              onValueChange={(v) => {
                if (!v) return
                setAgentId(v)
                setProfileId("")
                setModel(null)
                setEffort(null)
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue>{agent?.name}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {state.agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {pick(
            "Profile",
            <Select
              value={profile?.id ?? ""}
              onValueChange={(v) => {
                if (!v) return
                setProfileId(v)
                setModel(null)
                setEffort(null)
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue>{profile?.name ?? "No profile for this agent"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {agentProfiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {profile && profile.models.length > 0 &&
            pick(
              "Model",
              <Select
                value={model ?? DEFAULT_CHOICE}
                onValueChange={(v) => {
                  setModel(!v || v === DEFAULT_CHOICE ? null : v)
                  setEffort(null)
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {model === null
                      ? "Default model"
                      : (profile.models.find((m) => m.id === model)?.label ?? model)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_CHOICE}>
                    <span className="text-muted-foreground">Default model</span>
                  </SelectItem>
                  {profile.models.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          {efforts.length > 0 &&
            pick(
              "Reasoning effort",
              <Select
                value={effort ?? DEFAULT_CHOICE}
                onValueChange={(v) => setEffort(!v || v === DEFAULT_CHOICE ? null : v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {effort === null ? "Default effort" : <span className="capitalize">{effort}</span>}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_CHOICE}>
                    <span className="text-muted-foreground">Default effort</span>
                  </SelectItem>
                  {efforts.map((e) => (
                    <SelectItem key={e} value={e}>
                      <span className="capitalize">{e}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
        </div>
        {project && (
          <p className="truncate font-mono text-[11px] text-muted-foreground">{project.cwd}</p>
        )}
        <ResponsiveDialogFooter>
          <Button onClick={start} disabled={busy || !project || !profile}>
            {busy ? "Starting…" : "Start thread"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

/** Recent threads across everything, then one collapsible group per project. */
function ThreadGroups({
  actions,
  onNewThread,
}: {
  actions: Actions
  onNewThread: (projectId: string) => void
}) {
  const { state } = useStore()
  const newest = [...state.sessions].sort((a, b) => b.createdAt - a.createdAt)
  // Every project gets a group, threads or not — an empty one still needs its +.
  const groups = new Map<string, SessionMeta[]>(state.projects.map((p) => [p.id, []]))
  for (const session of newest) {
    const list = groups.get(session.projectId) ?? []
    list.push(session)
    groups.set(session.projectId, list)
  }

  if (groups.size === 0) {
    return (
      <p className="px-4 py-6 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
        No projects yet.
      </p>
    )
  }

  return (
    <>
      {/* Redundant while everything already fits on screen — only worth a section
          once the project groups stop showing you the thread you just left. */}
      {newest.length > THREADS_SHOWN && (
        <ThreadGroup label="Recent" sessions={newest.slice(0, THREADS_SHOWN)} actions={actions} />
      )}
      {[...groups.entries()].map(([projectId, sessions]) => (
        <ThreadGroup
          key={projectId}
          label={state.projects.find((p) => p.id === projectId)?.name ?? "Other"}
          sessions={sessions}
          actions={actions}
          onNewThread={() => onNewThread(projectId)}
        />
      ))}
    </>
  )
}

/** A foldable section of thread rows: heading, count, its own new-thread action. */
function ThreadGroup({
  label,
  sessions,
  actions,
  onNewThread,
}: {
  label: string
  sessions: SessionMeta[]
  actions: Actions
  onNewThread?: () => void
}) {
  const route = useRoute()
  const [open, setOpen] = React.useState(true)
  const [showAll, setShowAll] = React.useState(false)
  const overflow = sessions.slice(THREADS_SHOWN)
  // Never fold away the thread that's open — the cut would erase the active row.
  const expanded =
    showAll || (route.name === "thread" && overflow.some((s) => s.id === route.sessionId))
  const visible = expanded ? sessions : sessions.slice(0, THREADS_SHOWN)

  return (
    // Rows are text-only now, so a 3rem rail has nothing legible to show.
    <SidebarGroup className="py-0.5 group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel className="h-7 pe-1 text-[11px] font-semibold tracking-wider text-sidebar-foreground/80 uppercase">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-sm hover:text-sidebar-foreground"
        >
          <span className="truncate">{label}</span>
          <span className="ms-auto font-normal tabular-nums text-sidebar-foreground/45">
            {sessions.length}
          </span>
          <ChevronRight
            className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")}
          />
        </button>
        {onNewThread && (
          <button
            type="button"
            onClick={onNewThread}
            title={`New thread in ${label}`}
            className="flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <Plus className="size-3.5" />
            <span className="sr-only">New thread in {label}</span>
          </button>
        )}
      </SidebarGroupLabel>
      {open && (
        <SidebarGroupContent>
          <ThreadList sessions={visible} actions={actions} />
          {!expanded && overflow.length > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="w-full rounded-md px-2 py-1 text-start text-[11px] text-sidebar-foreground/50 hover:text-sidebar-foreground"
            >
              Show {overflow.length} more
            </button>
          )}
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  )
}

function ThreadList({ sessions, actions }: { sessions: SessionMeta[]; actions: Actions }) {
  const route = useRoute()
  const { isMobile, setOpenMobile } = useSidebar()
  return (
    <SidebarMenu>
      {sessions.map((session) => (
        <SidebarMenuItem key={session.id}>
          <SidebarMenuButton
            size="sm"
            tooltip={session.title}
            isActive={route.name === "thread" && route.sessionId === session.id}
            onClick={() => {
              if (isMobile) setOpenMobile(false)
              // Navigating is enough — the shell connects whatever the route names.
              navigate({ name: "thread", sessionId: session.id })
            }}
          >
            {/* Title carries the state itself: it shimmers while a turn runs and
                dims once the process is gone — no marker column needed. */}
            <span
              className={cn(
                "truncate",
                session.promptActive && "harness-shimmer",
                session.exited && "text-sidebar-foreground/50"
              )}
            >
              {session.title}
            </span>
            <span className="ms-auto shrink-0 text-[11px] tabular-nums text-sidebar-foreground/40">
              {ago(session.createdAt)}
            </span>
          </SidebarMenuButton>
          <SidebarMenuAction
            showOnHover
            onClick={() => {
              // Leave the route first: the deleted thread has no page to show.
              if (route.name === "thread" && route.sessionId === session.id) {
                navigate({ name: "home" })
              }
              actions.killThread(session.id).catch((err) => toast.error(String(err)))
            }}
            title="Delete thread"
          >
            <Trash2 />
          </SidebarMenuAction>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
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
        <img src="/logo.svg" alt="" className="mx-auto size-11 opacity-90" />
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
