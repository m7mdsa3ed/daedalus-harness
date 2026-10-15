/* ── What the right panel shows ──
   One body per section. The readings are `ThreadSection` — the same components
   the inspector and the thread dock drew — and the terminal and the preview are
   the same panels the dock hosted, handed a `PanelHandle` instead of dockview's
   api. Nothing here knows about tabs: the rail picks a section, and a section
   that has been opened stays mounted (hidden) so a shell keeps its scrollback
   and a preview its page while you read something else. */
import * as React from "react"
import { PlusIcon, SquareTerminalIcon, XIcon } from "lucide-react"

import { useScope, ScopeBoundary, useThreadJump } from "@/components/right-panel/scope-dock"
import { Empty } from "@/components/empty"
import { ThreadSection, type ThreadSectionKind } from "@/components/thread-view/thread-inspector"
import { Button } from "@/components/ui/button"
import { useDock } from "@/components/workspace/dock-context"
import type { Actions } from "@/lib/actions"
import { useProjects } from "@/lib/queries/catalog"
import {
  rightSheet,
  scopeProject,
  setActiveTerminal,
  setPreview,
  useRightPanel,
  type RightSection,
  type Scope,
} from "@/lib/right-panel"
import { useSessionMeta, useThread } from "@/lib/store"
import { cn } from "@/lib/utils"
import { openTerminal } from "@/lib/workspace/open-terminal"
import { clearPanelTitle, setPanelTitle, usePanelTitle, type PanelHandle } from "@/lib/workspace/panel-handle"
import { usePanelStatus } from "@/lib/workspace/panel-status"
import { HOME_PROJECT_ID, panelId } from "@/lib/workspace/panels"

const TerminalPanel = React.lazy(async () => ({
  default: (await import("@/components/workspace/terminal-panel")).TerminalPanel,
}))
const WebPanel = React.lazy(async () => ({
  default: (await import("@/components/workspace/web-panel")).WebPanel,
}))
const Trajectory = React.lazy(async () => ({
  default: (await import("@/components/trajectory/trajectory")).Trajectory,
}))

/** A query container with the panel's height published, so `@panel-*` rules and
    `--panel-h` (tool output caps) read the box the content is actually in. */
export function PanelBox({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => {
      const height = entry?.contentRect.height ?? 0
      // A hidden section measures 0 — writing that would cap its content to nothing.
      if (height > 0) node.style.setProperty("--panel-h", `${Math.round(height)}px`)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return (
    <div
      ref={ref}
      /* The panel's own rail already clears the header, so a section pads by
         nothing of its own (the sections read `--dock-content-overlap`). */
      style={{ "--dock-content-overlap": "0px" } as React.CSSProperties}
      className={cn("@container h-full min-h-0 w-full", className)}
    >
      <React.Suspense fallback={null}>{children}</React.Suspense>
    </div>
  )
}

/* ── The readings ── */

function Reading({ section, sessionId, actions }: { section: ThreadSectionKind; sessionId: string; actions: Actions }) {
  const meta = useSessionMeta(sessionId)
  const thread = useThread(sessionId)
  const jump = useThreadJump()
  if (!meta)
    return (
      <div className="p-3">
        <Empty>This thread is not loaded.</Empty>
      </div>
    )
  return (
    <ThreadSection
      section={section}
      thread={thread}
      meta={meta}
      onSend={(text) => actions.send(sessionId, text)}
      onJump={(id) => {
        // The sheet covers the transcript on a phone; get out of the way of the row.
        rightSheet.set(false)
        jump?.current?.(id)
      }}
    />
  )
}

/* ── Shells ── */

export function useNewTerminal(scope: Scope) {
  const { sessionId, projectId } = useScope()
  const meta = useSessionMeta(sessionId ?? "")
  return React.useCallback(() => {
    const project = scopeProject(scope) ?? projectId ?? HOME_PROJECT_ID
    // A thread's shell starts in its worktree and dies with the thread.
    void openTerminal(
      scope,
      meta?.projectId ?? project,
      meta ? { cwd: meta.worktree?.path, sessionId: meta.id } : {}
    )
  }, [scope, projectId, meta])
}

function ShellTab({
  id,
  active,
  onSelect,
  onClose,
}: {
  id: string
  active: boolean
  onSelect: () => void
  onClose: () => void
}) {
  const title = usePanelTitle(id) ?? "Shell"
  const status = usePanelStatus(id)
  return (
    <div
      className={cn(
        "group/shell flex h-6 max-w-40 min-w-0 shrink-0 items-center gap-1 rounded-md pr-0.5 pl-2 text-xs",
        active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"
      )}
    >
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={title}>
        {status && (
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 rounded-full", status.tone === "attention" ? "bg-amber-500" : "bg-destructive")}
          />
        )}
        <span className="truncate">{title}</span>
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label={`Close ${title}`}
        title={`Close ${title}`}
        className="grid size-4 shrink-0 place-items-center rounded-sm opacity-60 hover:bg-foreground/10 hover:opacity-100"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  )
}

function TerminalSection({ scope }: { scope: Scope }) {
  const view = useRightPanel(scope)
  const dock = useDock()
  const newTerminal = useNewTerminal(scope)
  const active = view.activeTerminal ?? view.terminals.at(-1)?.terminalId

  if (view.terminals.length === 0)
    return (
      <div className="grid h-full place-items-center p-4">
        <Empty
          size="lg"
          icon={SquareTerminalIcon}
          action={
            <Button size="sm" onClick={newTerminal}>
              <PlusIcon aria-hidden /> New terminal
            </Button>
          }
        >
          No shell yet.
        </Empty>
      </div>
    )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {view.terminals.map((terminal) => {
            const id = panelId({ kind: "terminal", projectId: terminal.projectId, terminalId: terminal.terminalId })
            return (
              <ShellTab
                key={terminal.terminalId}
                id={id}
                active={terminal.terminalId === active}
                onSelect={() => setActiveTerminal(scope, terminal.terminalId)}
                onClose={() => void dock.closePanel(id)}
              />
            )
          })}
        </div>
        <Button size="icon-xs" variant="ghost" onClick={newTerminal} aria-label="New terminal" title="New terminal">
          <PlusIcon aria-hidden className="size-3.5" />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        {view.terminals.map((terminal) => {
          const id = panelId({ kind: "terminal", projectId: terminal.projectId, terminalId: terminal.terminalId })
          return (
            <div key={terminal.terminalId} className={cn("absolute inset-0", terminal.terminalId !== active && "hidden")}>
              <ShellHost id={id} scope={scope} terminal={terminal} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ShellHost({
  id,
  scope,
  terminal,
}: {
  id: string
  scope: Scope
  terminal: { terminalId: string; projectId: string; sessionId?: string; cwd?: string; closeOnExit?: boolean }
}) {
  const api = React.useMemo<PanelHandle>(
    () => ({
      id,
      setTitle: (title) => setPanelTitle(id, title),
      updateParameters: () => {},
    }),
    [id]
  )
  React.useEffect(() => () => clearPanelTitle(id), [id])
  const { sessionId, projectId } = useScope()
  return (
    <ScopeBoundary scope={scope} sessionId={sessionId} projectId={projectId}>
      <PanelBox>
        <TerminalPanel api={api} params={terminal} />
      </PanelBox>
    </ScopeBoundary>
  )
}

/* ── Preview ── */

function PreviewSection({ scope }: { scope: Scope }) {
  const view = useRightPanel(scope)
  const { projectId } = useScope()
  const project = useProjects().find((candidate) => candidate.id === (scopeProject(scope) ?? projectId))
  const api = React.useMemo<PanelHandle>(
    () => ({
      id: `web:${scope}`,
      setTitle: () => {},
      updateParameters: (patch) => setPreview(scope, patch),
    }),
    [scope]
  )
  const url = view.preview?.url ?? project?.previewUrl
  return (
    <PanelBox>
      <WebPanel
        api={api}
        params={{
          trust: "project",
          viewId: "default",
          ...(project ? { projectId: project.id } : {}),
          ...(url ? { url } : {}),
          ...(view.preview?.file ? { file: view.preview.file } : {}),
          ...(view.preview?.diff ? { diff: view.preview.diff } : {}),
        }}
      />
    </PanelBox>
  )
}

/* ── One section ── */

export function SectionBody({
  section,
  scope,
  sessionId,
  actions,
}: {
  section: RightSection
  scope: Scope
  sessionId: string | null
  actions: Actions
}) {
  if (section === "terminal") return <TerminalSection scope={scope} />
  if (section === "preview") return <PreviewSection scope={scope} />
  if (!sessionId) return null
  if (section === "trajectory")
    return (
      <PanelBox>
        <Trajectory sessionId={sessionId} variant="panel" />
      </PanelBox>
    )
  return (
    <PanelBox>
      <Reading section={section} sessionId={sessionId} actions={actions} />
    </PanelBox>
  )
}

