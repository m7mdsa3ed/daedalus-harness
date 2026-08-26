import * as React from "react"
import {
  ChevronLeft,
  FolderIcon,
  FolderPlus,
  MessageSquareIcon,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react"
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
}: {
  settings: ServerSettings
  actions: Actions
  loading: boolean
}) {
  const { state } = useStore()
  const route = useRoute()
  const [newThreadOpen, setNewThreadOpen] = React.useState(false)
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
  const startThread = () => (ready ? setNewThreadOpen(true) : openSettings("projects"))

  /* ── Sidebar panels ──
     The sidebar body is swappable: one entry per route family. To add a panel,
     add a route in lib/router and an entry here — the shell itself is generic. */
  const panels: Record<"threads" | "settings", SidebarPanel> = {
    threads: {
      action: (
        <SidebarGroup>
          <SidebarGroupLabel>Create</SidebarGroupLabel>
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
          navigate(
            lastThread.current
              ? { name: "thread", sessionId: lastThread.current }
              : { name: "home" }
          ),
      },
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
        <SidebarHeader className="gap-2 p-3 group-data-[collapsible=icon]:p-2">
          <div className="flex items-center gap-2 px-1 group-data-[collapsible=icon]:px-0">
            <img src="/logo.svg" alt="" className="size-7 shrink-0" />
            <span className="text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
              Daedalus
            </span>
          </div>
        </SidebarHeader>
        <SidebarContent>
          {panel.back ? (
            <SidebarGroup>
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
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Settings"
                isActive={route.name === "settings"}
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
            onNewThread={startThread}
            onOpenSettings={openSettings}
          />
        )}
      </SidebarInset>
      <NewThreadDialog open={newThreadOpen} onOpenChange={setNewThreadOpen} actions={actions} />
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
  actions,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  actions: Actions
}) {
  const { state } = useStore()
  const { setOpenMobile } = useSidebar()
  const [projectId, setProjectId] = React.useState("")
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
            <Select value={project?.id ?? ""} onValueChange={(v) => v && setProjectId(v)}>
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

/** Threads grouped by project, newest first. */
function ThreadGroups({ actions }: { actions: Actions }) {
  const { state } = useStore()
  const groups = new Map<string, SessionMeta[]>()
  for (const session of [...state.sessions].sort((a, b) => b.createdAt - a.createdAt)) {
    const list = groups.get(session.projectId) ?? []
    list.push(session)
    groups.set(session.projectId, list)
  }

  if (state.sessions.length === 0) {
    return (
      <SidebarGroup>
        <SidebarGroupLabel>Threads</SidebarGroupLabel>
        <SidebarGroupContent>
          <p className="px-2 py-4 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
            No threads yet.
          </p>
        </SidebarGroupContent>
      </SidebarGroup>
    )
  }

  return (
    <>
      {[...groups.entries()].map(([projectId, sessions]) => (
        <SidebarGroup key={projectId}>
          <SidebarGroupLabel className="gap-1.5">
            <FolderIcon className="size-3 shrink-0" />
            <span className="truncate">
              {state.projects.find((p) => p.id === projectId)?.name ?? "Other"}
            </span>
            <span className="ml-auto tabular-nums opacity-60">{sessions.length}</span>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <ThreadList sessions={sessions} actions={actions} />
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
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
            tooltip={session.title}
            isActive={route.name === "thread" && route.sessionId === session.id}
            onClick={() => {
              if (isMobile) setOpenMobile(false)
              // Navigating is enough — the shell connects whatever the route names.
              navigate({ name: "thread", sessionId: session.id })
            }}
          >
            <MessageSquareIcon className={cn("size-4", session.exited && "opacity-50")} />
            <span className={cn("truncate", session.exited && "text-muted-foreground")}>
              {session.title}
            </span>
            {session.promptActive && (
              <span
                title="Turn running"
                className="ml-auto size-1.5 shrink-0 animate-pulse rounded-full bg-primary group-data-[collapsible=icon]:hidden"
              />
            )}
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
