/* ── /graph — every running thread as one graph ──
   Who started whom, and who is waiting on you: threads under their projects,
   the asks and workflow runs each one started, and the subagents working
   inside it. The drawing is `threadGraph` (lib/thread/thread-graph), the same
   read-only `InteractiveFlowchart` a workflow run draws with; this page only
   gathers its inputs, holds the connections that bring transcripts, and says
   what the selected node is. A click selects, a double-click opens, and the
   card's buttons open the thread here, in a new tab or to the side. Lazy, like
   every page: `@xyflow/react` rides it. */
import * as React from "react"
import { ArrowDown, ArrowRight, Columns2, NetworkIcon, Search, SquareArrowOutUpRight, X } from "lucide-react"
import { useNavigate } from "react-router"

import { Empty } from "@/components/empty"
import { ErrorNote } from "@/components/error-note"
import { SurfaceHeader } from "@/components/page-primitives"
import { Segmented } from "@/components/settings/primitives"
import { HoldThreads } from "@/components/threads-graph/hold-threads"
import { useGraphSnapshot } from "@/components/threads-graph/use-graph-snapshot"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { useIsMobile } from "@/hooks/use-device"
import type { Actions } from "@/lib/actions"
import { InteractiveFlowchart } from "@/lib/openui/interactive-flowchart"
import { useAgents, useProjects } from "@/lib/queries/catalog"
import { projectPath, threadPath } from "@/lib/router"
import { activityAt, relativeAge, type SessionMeta } from "@/lib/settings"
import { agentState, type AgentState } from "@/lib/thread/statuses"
import {
  isActiveState,
  needsYouState,
  STATE_HINT,
  threadGraph,
  type GraphScope,
  type ThreadGraphNode,
} from "@/lib/thread/thread-graph"
import { openBeside, openInNewTab } from "@/lib/workspace/open-threads"

/** How many threads the page opens a connection to for their workers: each
    one replays a window of its journal, so the cost is bounded here. */
const HOLD_LIMIT = 12
const ALL_PROJECTS = "__all__"

type Direction = "down" | "right"

export function ThreadsGraphPage({ actions, loading }: { actions: Actions; loading: boolean }) {
  const navigate = useNavigate()
  const projects = useProjects()
  const agents = useAgents()
  const mobile = useIsMobile()
  const [scope, setScope] = React.useState<GraphScope>("active")
  const [query, setQuery] = React.useState("")
  const [projectId, setProjectId] = React.useState<string | null>(null)
  const [direction, setDirection] = React.useState<Direction>("down")
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const { state, error, retry } = useGraphSnapshot(actions)

  const states = React.useMemo(() => {
    const map = new Map<string, AgentState>()
    for (const s of state.sessions) map.set(s.id, agentState(s, state.threads[s.id]))
    return map
  }, [state])

  const graph = React.useMemo(
    () => threadGraph({ sessions: state.sessions, threads: state.threads, states, projects, scope, projectId, query }),
    [state, states, projects, scope, projectId, query]
  )

  const live = React.useMemo(
    () => state.sessions.filter((s) => !s.draft && !s.deletedAt && (!projectId || s.projectId === projectId)),
    [state.sessions, projectId]
  )
  const counts = React.useMemo(() => {
    let active = 0
    let needsYou = 0
    for (const s of live) {
      const st = states.get(s.id) ?? "idle"
      if (isActiveState(st)) active++
      if (needsYouState(st)) needsYou++
    }
    return { active, needsYou }
  }, [live, states])

  /* Top-level threads at work: their transcripts are where workers live. A
     child's workers are its own thread's, reached by opening it. */
  const held = React.useMemo(
    () =>
      live
        .filter((s) => !s.parentSessionId && isActiveState(states.get(s.id) ?? "idle"))
        .slice(0, HOLD_LIMIT)
        .map((s) => s.id),
    [live, states]
  )

  const byNode = React.useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph])
  const selected = selectedId ? byNode.get(selectedId) : undefined
  // A pick that left the drawing (filtered out, finished) is no pick.
  React.useEffect(() => {
    if (selectedId && !byNode.has(selectedId)) setSelectedId(null)
  }, [selectedId, byNode])

  const pathOf = (node: ThreadGraphNode | undefined): string | null =>
    node?.kind === "project" && node.projectId ? projectPath(node.projectId) : node?.open ? threadPath(node.open) : null

  const filtered = query.trim() !== "" || projectId !== null
  const projectName = projectId ? (projects.find((p) => p.id === projectId)?.name ?? "Project") : "All projects"

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col pt-[var(--app-header-h)]">
      <HoldThreads ids={held} />
      <div className="flex min-h-0 flex-1 flex-col px-4 pt-6 pb-4 @panel-sm:px-8">
        <SurfaceHeader
          className="mb-4"
          icon={NetworkIcon}
          title="Thread graph"
          description="Every thread at work across your projects, the asks and workflow runs it started, and the subagents inside it. Select a node to see it; double-click to open its thread."
          actions={
            <Segmented
              label="Which threads"
              value={scope}
              onChange={setScope}
              options={[
                { value: "active", label: "Active", count: counts.active },
                { value: "needs-you", label: "Needs you", count: counts.needsYou },
                { value: "all", label: "All" },
              ]}
            />
          }
        />
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-40 flex-1 @panel-sm:max-w-72">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by title…"
              aria-label="Filter threads by title"
              className="ps-9"
            />
          </div>
          <Select value={projectId ?? ALL_PROJECTS} onValueChange={(v) => setProjectId(!v || v === ALL_PROJECTS ? null : v)}>
            <SelectTrigger className="w-44" aria-label="Project">
              <SelectValue>{projectName}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setQuery("")
                setProjectId(null)
              }}
            >
              <X data-icon="inline-start" /> Clear
            </Button>
          )}
          <div className="ms-auto">
            <Segmented
              label="Layout"
              value={direction}
              onChange={setDirection}
              options={[
                { value: "down", label: "Down", icon: ArrowDown },
                { value: "right", label: "Across", icon: ArrowRight },
              ]}
            />
          </div>
        </div>
        <ErrorNote error={error} onRetry={retry} className="mb-4" />
        {loading && state.sessions.length === 0 ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
            <Spinner /> Loading threads…
          </div>
        ) : graph.nodes.length === 0 ? (
          <Empty size="lg" icon={NetworkIcon}>
            {filtered
              ? "No thread matches this filter."
              : scope === "active"
                ? "Nothing is running right now. Switch to All to see every thread with a live agent."
                : scope === "needs-you"
                  ? "Nothing is waiting on you."
                  : "No thread has a live agent right now."}
          </Empty>
        ) : (
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border">
            <InteractiveFlowchart
              nodes={graph.nodes}
              edges={graph.edges}
              direction={direction}
              fill
              readOnly
              selectedId={selectedId}
              onNodeClick={(id) => setSelectedId((current) => (current === id ? null : id))}
              onNodeDoubleClick={(id) => {
                const path = pathOf(byNode.get(id))
                if (path) void navigate(path)
              }}
              onPaneClick={() => setSelectedId(null)}
            />
            {selected && (
              <NodeCard
                node={selected}
                session={selected.open ? state.sessions.find((s) => s.id === selected.open) : undefined}
                state={selected.open ? (states.get(selected.open) ?? "idle") : undefined}
                agentName={(id) => agents.find((a) => a.id === id)?.name ?? id}
                childCount={graph.edges.filter((e) => e.from === selected.id).length}
                path={pathOf(selected)}
                beside={!mobile}
                onOpen={(path) => void navigate(path)}
                onClose={() => setSelectedId(null)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const KIND_LABEL: Record<ThreadGraphNode["kind"], string> = {
  project: "Project",
  thread: "Thread",
  run: "Workflow run",
  worker: "Subagent",
  pending: "Pending step",
  fold: "Subagent batch",
}

/** What the selected node is, over the canvas: its facts and the three ways to open it. */
function NodeCard({
  node,
  session,
  state,
  agentName,
  childCount,
  path,
  beside,
  onOpen,
  onClose,
}: {
  node: ThreadGraphNode
  /** The thread the node opens — its own, or the parent of a worker. */
  session: SessionMeta | undefined
  state: AgentState | undefined
  agentName: (id: string) => string
  childCount: number
  path: string | null
  beside: boolean
  onOpen: (path: string) => void
  onClose: () => void
}) {
  const own = node.kind === "thread"
  const facts: [string, string][] = []
  if (own && state) facts.push(["State", STATE_HINT[state]])
  else if (node.hint) facts.push(["State", node.hint])
  if (session && node.kind !== "project") {
    if (!own) facts.push(["In thread", session.title || "Thread"])
    facts.push(["Agent", agentName(session.agentId)])
    if (session.model) facts.push(["Model", session.model])
    facts.push(["Last activity", relativeAge(activityAt(session))])
  }
  if (childCount > 0) facts.push([node.kind === "project" ? "Threads" : "Started", String(childCount)])
  const error = own ? session?.lastTurnError : null
  const openLabel = node.kind === "project" ? "Open project" : own ? "Open thread" : "Open parent thread"

  return (
    <aside
      className="absolute inset-x-3 bottom-3 z-10 grid gap-3 rounded-lg border bg-card p-4 text-sm shadow-md @panel-sm:inset-x-auto @panel-sm:end-3 @panel-sm:top-3 @panel-sm:bottom-auto @panel-sm:w-72"
      aria-label="Selected node"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted-foreground">{KIND_LABEL[node.kind]}</div>
          <div className="font-medium [overflow-wrap:anywhere]">{node.label}</div>
        </div>
        <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close">
          <X />
        </Button>
      </div>
      {facts.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {facts.map(([key, value]) => (
            <React.Fragment key={key}>
              <dt className="text-muted-foreground">{key}</dt>
              <dd className="min-w-0 truncate" title={value}>
                {value}
              </dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      {error && <p className="line-clamp-3 text-xs text-destructive" title={error}>{error}</p>}
      {path && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => onOpen(path)}>
            {openLabel}
          </Button>
          <Button variant="outline" size="icon-sm" title="Open in new tab" aria-label="Open in new tab" onClick={() => openInNewTab(path) || onOpen(path)}>
            <SquareArrowOutUpRight />
          </Button>
          {beside && (
            <Button variant="outline" size="icon-sm" title="Open to the side" aria-label="Open to the side" onClick={() => openBeside(path) || onOpen(path)}>
              <Columns2 />
            </Button>
          )}
        </div>
      )}
    </aside>
  )
}
