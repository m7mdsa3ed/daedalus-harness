/* ── The thread dock ──
   A chat tab on a wide screen is a dock of its own: the transcript and every
   panel that is about *this* thread — Changes, Plan, Agents, Details, its
   shell, its preview — moved, split and resized inside the tab.
   **On a phone it is the same dock, stacked**: no room for a split, so every
   panel is a tab beside the transcript's own, and nothing drags.
   It opens as the transcript alone, with no strip: the thread is not a tab.
   The + over it opens the rest, each at its kind's own place (`SLOT`), and
   the panes are drawn flush — one surface cut by hairlines, not the outer
   dock's floating cards (`.dock-nested` in index.css).

   **A closed world** (`lib/workspace/thread-docks.ts`): nothing crosses into
   the outer dock or out of it. That is what separates this from the group
   panel that was removed (`docs/client.md`): the outer dock never has to look
   inside one, so there is no `attachNested`, no second place a panel can be,
   and no outer tab menu asked about an inner tab — the inner tab is its own.

   The panels that were outer kinds — terminal and preview — are the same
   components, unchanged: this dock hands them a `DockContext` of its own, so a
   terminal's restart, its close guard and a preview's helper run all land in
   here instead of the outer dock. */
import * as React from "react"
import {
  DockviewReact,
  themeAbyss,
  themeLight,
  type DockviewApi,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview-react"
import {
  AppWindowIcon,
  BotIcon,
  GitCompareIcon,
  InfoIcon,
  ListChecksIcon,
  CoinsIcon,
  PlusIcon,
  RouteIcon,
  SquareTerminalIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react"

import { AgentIcon } from "@/components/entity-icon"
import { useIsMobile } from "@/hooks/use-device"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ThreadSection, type ThreadSectionKind } from "@/components/thread-view/thread-inspector"
import { ThreadView } from "@/components/thread-view/thread-view"
import {
  DockContext,
  useDock,
  type CloseGuard,
  type WorkspaceDock,
} from "@/components/workspace/dock-context"
import { PanelContainer } from "@/components/workspace/panel-container"
import type { Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import { InspectorContext, ThreadJumpContext, type InspectorTab } from "@/lib/inspector"
import { useProjects } from "@/lib/queries/catalog"
import { useSessionMeta, useThread } from "@/lib/store"
import { useTheme } from "@/lib/theme"
import { cn } from "@/lib/utils"
import { HOME_PROJECT_ID, panelId, type PanelDescriptor } from "@/lib/workspace/panels"
import { createTerminal } from "@/lib/workspace/terminals"
import {
  registerThreadDock,
  saveThreadLayout,
  threadLayout,
  type ThreadDockHandle,
  type ThreadPanelKind,
} from "@/lib/workspace/thread-docks"

const TerminalPanel = React.lazy(async () => ({
  default: (await import("@/components/workspace/terminal-panel")).TerminalPanel as React.FC<IDockviewPanelProps>,
}))
const WebPanel = React.lazy(async () => ({
  default: (await import("@/components/workspace/web-panel")).WebPanel as React.FC<IDockviewPanelProps>,
}))

const Trajectory = React.lazy(async () => ({
  default: (await import("@/components/trajectory/trajectory")).Trajectory,
}))

const KINDS: Record<ThreadPanelKind, { title: string; icon: LucideIcon | null }> = {
  transcript: { title: "Thread", icon: null },
  changes: { title: "Source Control", icon: GitCompareIcon },
  plan: { title: "Plan", icon: ListChecksIcon },
  agents: { title: "Agents", icon: BotIcon },
  details: { title: "Details", icon: InfoIcon },
  tokens: { title: "Tokens", icon: CoinsIcon },
  terminal: { title: "Terminal", icon: SquareTerminalIcon },
  web: { title: "Preview", icon: AppWindowIcon },
  trajectory: { title: "Trajectory", icon: RouteIcon },
}

/** The readings — one panel each, the id is the kind. */
const SECTIONS: ThreadSectionKind[] = ["changes", "plan", "agents", "details", "tokens"]

/* ── Where each kind lives ──
   A panel opens at its kind's own place, not wherever the focus happens to be:
   the readings are one column down the right edge, the preview stands beside the transcript, a shell sits under it. Once a slot has a group,
   its kinds join that group as tabs; move one and the slot follows it. */
type Slot = "side" | "beside" | "below"
const SLOT: Record<Exclude<ThreadPanelKind, "transcript">, Slot> = {
  changes: "side",
  plan: "side",
  agents: "side",
  details: "side",
  tokens: "side",
  web: "beside",
  trajectory: "beside",
  terminal: "below",
}

/** Put a panel in, or show the one there is. Stacked (a phone), every panel is
    a tab in the transcript's group. */
function place(
  api: DockviewApi,
  id: string,
  kind: Exclude<ThreadPanelKind, "transcript">,
  params?: object,
  stacked = false
) {
  const existing = api.getPanel(id)
  if (existing) {
    if (params) existing.api.updateParameters(params as Record<string, unknown>)
    existing.api.setActive()
    return
  }
  if (stacked) {
    api.addPanel({
      id,
      component: kind,
      title: KINDS[kind].title,
      params: params as Record<string, unknown> | undefined,
      position: { referencePanel: "transcript" },
    })
    return
  }
  const slot = SLOT[kind]
  const home = api.panels.find(
    (panel) => panel.api.component !== "transcript" && SLOT[panel.api.component as keyof typeof SLOT] === slot
  )
  const position = home
    ? { referenceGroup: home.group.id }
    : slot === "side"
      ? { direction: "right" as const }
      : { referencePanel: "transcript", direction: slot === "below" ? ("below" as const) : ("right" as const) }
  api.addPanel({
    id,
    component: kind,
    title: KINDS[kind].title,
    params: params as Record<string, unknown> | undefined,
    position,
    ...(home ? {} : slot === "below" ? { initialHeight: 260 } : { initialWidth: slot === "side" ? 340 : 520 }),
  })
}

/** Fold every group into the transcript's — a layout split on a wide screen,
    read on a narrow one. */
function stack(api: DockviewApi) {
  const home = api.getPanel("transcript")?.group
  if (!home) return
  for (const panel of api.panels) if (panel.group !== home) panel.api.moveTo({ group: home })
  syncStrips(api)
}

/** The transcript's group wears no strip — it is the thread, not a tab — until
    something is dragged in beside it, when there are tabs to tell apart. */
function syncStrips(api: DockviewApi) {
  for (const group of api.groups) {
    const bare = group.panels.length === 1 && group.panels[0].id === "transcript"
    if (group.header.hidden !== bare) group.header.hidden = bare
  }
}

interface ThreadDockValue {
  sessionId: string
  handle: ThreadDockHandle
}
const ThreadDockContext = React.createContext<ThreadDockValue | null>(null)

/** The thread whose dock this panel is in, or null in the outer dock. */
export function useThreadDockSession(): string | null {
  return React.useContext(ThreadDockContext)?.sessionId ?? null
}

/** The dock's own handle, so a panel can bring a sibling pane forward — the
    Preview's "Send to agent" shows the transcript it just filled. Null in the
    outer dock. */
export function useThreadDockHandle(): ThreadDockHandle | null {
  return React.useContext(ThreadDockContext)?.handle ?? null
}

export function ThreadDock({ sessionId, actions }: { sessionId: string; actions: Actions }) {
  const outer = useDock()
  const meta = useSessionMeta(sessionId)
  const projects = useProjects()
  const { resolved } = useTheme()
  const stacked = useIsMobile()
  const stackedRef = React.useRef(stacked)
  stackedRef.current = stacked
  const apiRef = React.useRef<DockviewApi | null>(null)
  const guardsRef = React.useRef(new Map<string, CloseGuard>())
  const jumpRef = React.useRef<((id?: string, turn?: { turnId: string; seq: number }) => void) | null>(null)

  /* Read through refs by the handle, which has to stay one object: it is
     registered once and captured by every panel's context. */
  const metaRef = React.useRef(meta)
  metaRef.current = meta
  const projectsRef = React.useRef(projects)
  projectsRef.current = projects

  const handle = React.useMemo<ThreadDockHandle>(() => {
    const add = (id: string, kind: Exclude<ThreadPanelKind, "transcript">, params?: object) => {
      if (apiRef.current) place(apiRef.current, id, kind, params, stackedRef.current)
    }
    return {
      jump(id, turn) {
        apiRef.current?.getPanel("transcript")?.api.setActive()
        jumpRef.current?.(id, turn)
      },
      open(kind, reuse) {
        const api = apiRef.current
        const current = metaRef.current
        if (!api || !current) return
        const projectId = current.projectId ?? HOME_PROJECT_ID
        if (kind === "terminal") {
          const shell = api.panels.find((panel) => panel.api.component === "terminal")
          if (shell && reuse) return shell.api.setActive()
          const cwd = current.worktree?.path
          createTerminal(projectId, { cwd, sessionId: current.id }).then(
            (created) => {
              const panel: PanelDescriptor = {
                kind: "terminal",
                projectId,
                terminalId: created.id,
                sessionId: current.id,
                ...(cwd ? { cwd } : {}),
              }
              add(panelId(panel), "terminal", panel)
            },
            (err) => reportError(err, "Couldn't open a terminal")
          )
          return
        }
        if (kind === "web") {
          const url = projectsRef.current.find((p) => p.id === current.projectId)?.previewUrl
          const panel: PanelDescriptor = {
            kind: "web",
            trust: "project",
            viewId: "default",
            ...(current.projectId ? { projectId: current.projectId } : {}),
            ...(url ? { url } : {}),
          }
          return add(panelId(panel), "web", panel)
        }
        if (kind === "transcript") return api.getPanel("transcript")?.api.setActive()
        add(kind, kind)
      },
    }
  }, [])

  /* The `DockContext` every panel in here reads: the outer dock, with the
     doors a panel uses on *itself* pointed at this instance. Anything not in
     here (a chat, a page) still goes to the outer dock. */
  const inner = React.useMemo<WorkspaceDock>(() => {
    const own = (id: string) => apiRef.current?.getPanel(id)
    return {
      ...outer,
      openPanel: (panel, options) => {
        if (panel.kind === "terminal" || panel.kind === "web") {
          if (apiRef.current) place(apiRef.current, panelId(panel), panel.kind, panel, stackedRef.current)
          return
        }
        outer.openPanel(panel, options)
      },
      closePanel: async (id) => {
        const panel = own(id)
        if (!panel) return outer.closePanel(id)
        if (id === "transcript") return
        const guard = guardsRef.current.get(id)
        if (guard && !(await guard())) return
        apiRef.current?.removePanel(panel)
      },
      registerCloseGuard: (id, guard) => {
        guardsRef.current.set(id, guard)
        return () => {
          if (guardsRef.current.get(id) === guard) guardsRef.current.delete(id)
        }
      },
      isPanelOpen: (id) => !!own(id) || outer.isPanelOpen(id),
    }
  }, [outer])

  React.useEffect(() => registerThreadDock(sessionId, handle), [sessionId, handle])
  /* A window narrowed past the phone's width folds its splits the same way. */
  React.useEffect(() => {
    if (stacked && apiRef.current) stack(apiRef.current)
  }, [stacked])

  const onReady = React.useCallback(
    (api: DockviewApi) => {
      apiRef.current = api
      const layout = threadLayout(sessionId)
      if (layout) {
        try {
          api.fromJSON(layout)
        } catch (error) {
          console.warn("Could not restore the thread's layout", error)
          api.clear()
        }
      }
      /* The transcript is always there; everything else comes from the +. */
      if (!api.getPanel("transcript")) {
        const first = api.panels[0]
        api.addPanel({
          id: "transcript",
          component: "transcript",
          title: KINDS.transcript.title,
          ...(first ? { position: { referencePanel: first.id, direction: "left" as const } } : {}),
        })
      }
      if (stackedRef.current) stack(api)
      api.getPanel("transcript")?.api.setActive()
      syncStrips(api)

      let timer: ReturnType<typeof setTimeout> | undefined
      const strips = () => syncStrips(api)
      const disposables = [
        api.onDidLayoutChange(() => {
          clearTimeout(timer)
          timer = setTimeout(() => saveThreadLayout(sessionId, api.toJSON()), 400)
        }),
        api.onDidAddPanel(strips),
        api.onDidRemovePanel(strips),
        /* A drag runs under dockview's lock and raises neither of the two above. */
        api.onDidMovePanel(strips),
        api.onDidAddGroup(strips),
      ]
      return () => {
        clearTimeout(timer)
        saveThreadLayout(sessionId, api.toJSON())
        disposables.forEach((disposable) => disposable.dispose())
        if (apiRef.current === api) apiRef.current = null
      }
    },
    [sessionId]
  )

  const components = React.useMemo(() => {
    const contained =
      (Panel: React.FC<IDockviewPanelProps>): React.FC<IDockviewPanelProps> =>
      (props) => (
        <PanelContainer>
          <React.Suspense fallback={null}>
            <Panel {...props} />
          </React.Suspense>
        </PanelContainer>
      )
    const map: Record<string, React.FC<IDockviewPanelProps>> = {
      transcript: contained(() => (
        <div className="relative flex h-full min-h-0 flex-col">
          <ThreadView sessionId={sessionId} actions={actions} docked />
          <ThreadPanelsMenu />
        </div>
      )),
      terminal: contained(TerminalPanel),
      web: contained(WebPanel),
      trajectory: contained(() => <Trajectory sessionId={sessionId} variant="panel" />),
    }
    for (const section of SECTIONS)
      map[section] = contained(() => <SectionPanel section={section} sessionId={sessionId} actions={actions} />)
    return map
  }, [sessionId, actions])

  const theme = React.useMemo(
    () => ({
      ...(resolved === "dark" ? themeAbyss : themeLight),
      tabAnimation: "smooth" as const,
      dndTabIndicator: "line" as const,
    }),
    [resolved]
  )

  /* "Open in inspector" from the composer's readings: the reading's panel. */
  const openReading = React.useCallback((tab: InspectorTab) => handle.open(tab), [handle])
  const value = React.useMemo(() => ({ sessionId, handle }), [sessionId, handle])

  /* `DockviewReact` drops whatever `onReady` returns, so the teardown is kept
     here and run on the next ready (StrictMode mounts twice) and on unmount. */
  const teardownRef = React.useRef<(() => void) | undefined>(undefined)
  React.useEffect(() => () => teardownRef.current?.(), [])

  return (
    <DockContext.Provider value={inner}>
      <ThreadDockContext.Provider value={value}>
        <InspectorContext.Provider value={meta ? openReading : null}>
          <ThreadJumpContext.Provider value={jumpRef}>
            <DockviewReact
              className="dock-nested h-full min-h-0 flex-1"
              components={components}
              defaultRenderer="always"
              defaultTabComponent={ThreadTab}
              disableTabsOverflowList
              disableDnd={stacked}
              theme={theme}
              onReady={(event) => {
                teardownRef.current?.()
                teardownRef.current = onReady(event.api)
              }}
            />
          </ThreadJumpContext.Provider>
        </InspectorContext.Provider>
      </ThreadDockContext.Provider>
    </DockContext.Provider>
  )
}

function SectionPanel({
  section,
  sessionId,
  actions,
}: {
  section: ThreadSectionKind
  sessionId: string
  actions: Actions
}) {
  const meta = useSessionMeta(sessionId)
  const thread = useThread(sessionId)
  const jump = React.useContext(ThreadJumpContext)
  const dock = React.useContext(ThreadDockContext)
  if (!meta) return null
  return (
    <div className="flex h-full min-h-0 flex-col pt-[var(--dock-content-overlap,0px)]">
      <ThreadSection
        section={section}
        thread={thread}
        meta={meta}
        onSend={(text) => actions.send(sessionId, text)}
        onJump={(id) => {
          dock?.handle.open("transcript", true)
          jump?.current?.(id)
        }}
      />
    </div>
  )
}

/** A value dockview pushes — a read at render time would never change again. */
function useApiValue<T>(subscribe: (onChange: () => void) => { dispose: () => void }, read: () => T): T {
  const sub = React.useCallback(
    (onChange: () => void) => {
      const disposable = subscribe(onChange)
      return () => disposable.dispose()
    },
    [subscribe]
  )
  return React.useSyncExternalStore(sub, read, read)
}

/** The inner tab: the outer tab's material (`.dock-tab`), without its menu —
    every row of that menu is about the outer dock. Nothing inside it is
    focusable, for the reason `panel-tab.tsx` gives. */
function ThreadTab({ api }: IDockviewPanelHeaderProps) {
  const dock = useDock()
  const ctx = React.useContext(ThreadDockContext)
  const meta = useSessionMeta(ctx?.sessionId ?? "")
  const onActive = React.useCallback((fn: () => void) => api.onDidActiveChange(fn), [api])
  const onTitle = React.useCallback((fn: () => void) => api.onDidTitleChange(fn), [api])
  const active = useApiValue(onActive, () => api.isActive)
  const title = useApiValue(onTitle, () => api.title ?? "")
  const kind = api.component as ThreadPanelKind
  const Icon = KINDS[kind]?.icon
  const closable = api.id !== "transcript"
  return (
    <div className="flex h-full min-w-0 flex-1 items-center py-0.5">
      <div
        data-active={active || undefined}
        className={cn(
          "dock-tab relative mx-0.5 flex h-[var(--dock-chip-h)] min-w-0 flex-1 items-center gap-1.5 py-0 pr-2 pl-2.5 text-xs",
          active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
        )}
        onKeyDown={(event) => {
          if (closable && (event.key === "Delete" || event.key === "Backspace")) void dock.closePanel(api.id)
        }}
      >
        <span data-tab-mark aria-hidden className="grid size-4 shrink-0 place-items-center">
          {Icon ? <Icon className="size-3.5" /> : <AgentIcon agentId={meta?.agentId} className="size-3.5" />}
        </span>
        <span data-tab-title className="flex min-w-0 flex-1 items-center">
          <span className="truncate">{title}</span>
        </span>
        {closable && (
          <button
            type="button"
            tabIndex={-1}
            data-tab-action="close"
            aria-label={`Close ${title}`}
            title={`Close ${title}`}
            className="grid size-4 shrink-0 place-items-center rounded-sm opacity-60 hover:bg-foreground/10 hover:opacity-100"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              void dock.closePanel(api.id)
            }}
          >
            <XIcon className="size-3" />
          </button>
        )}
      </div>
    </div>
  )
}

/** The + over the transcript — the one door to the thread's panels, since the
    transcript wears no strip. A reading already open is shown,
    not doubled; a terminal is a new shell. */
function ThreadPanelsMenu() {
  const ctx = React.useContext(ThreadDockContext)
  if (!ctx) return null
  const row = (kind: ThreadPanelKind, label = KINDS[kind].title) => {
    const Icon = KINDS[kind].icon
    return (
      <DropdownMenuItem key={kind} onClick={() => ctx.handle.open(kind, kind !== "terminal")}>
        {Icon && <Icon />}
        {label}
      </DropdownMenuItem>
    )
  }
  return (
    <div className="absolute right-3 top-[var(--dock-content-overlap,0px)] z-30 mt-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Open a panel in this thread"
              title="Open a panel in this thread"
              className="size-7 rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            >
              <PlusIcon className="size-4" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-48">
          {SECTIONS.map((kind) => row(kind))}
          <DropdownMenuSeparator />
          {row("terminal", "New terminal")}
          {row("web")}
          {row("trajectory")}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
