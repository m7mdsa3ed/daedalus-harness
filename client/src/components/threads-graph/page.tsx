/* ── /graph — every running thread as one graph ──
   Who started whom, and who is waiting on you: threads under their projects,
   the asks and workflow runs each one started, and the subagents working
   inside it. The drawing is `threadGraph` (lib/thread/thread-graph), the same
   read-only `InteractiveFlowchart` a workflow run draws with; this page only
   gathers its inputs, holds the connections that bring transcripts, and opens
   a thread on a click. Lazy, like every page: `@xyflow/react` rides it. */
import * as React from "react"
import { NetworkIcon } from "lucide-react"
import { useNavigate } from "react-router"

import { Empty } from "@/components/empty"
import { ErrorNote } from "@/components/error-note"
import { SurfaceHeader } from "@/components/page-primitives"
import { Segmented } from "@/components/settings/primitives"
import { HoldThreads } from "@/components/threads-graph/hold-threads"
import { useGraphSnapshot } from "@/components/threads-graph/use-graph-snapshot"
import { Spinner } from "@/components/ui/spinner"
import type { Actions } from "@/lib/actions"
import { InteractiveFlowchart } from "@/lib/openui/interactive-flowchart"
import { useProjects } from "@/lib/queries/catalog"
import { threadPath } from "@/lib/router"
import { agentState, type AgentState } from "@/lib/thread/statuses"
import { isActiveState, threadGraph, type GraphScope } from "@/lib/thread/thread-graph"

/** How many threads the page opens a connection to for their workers: each
    one replays a window of its journal, so the cost is bounded here. */
const HOLD_LIMIT = 12

export function ThreadsGraphPage({ actions, loading }: { actions: Actions; loading: boolean }) {
  const navigate = useNavigate()
  const projects = useProjects()
  const [scope, setScope] = React.useState<GraphScope>("active")
  const { state, error, retry } = useGraphSnapshot(actions)

  const states = React.useMemo(() => {
    const map = new Map<string, AgentState>()
    for (const s of state.sessions) map.set(s.id, agentState(s, state.threads[s.id]))
    return map
  }, [state])

  const graph = React.useMemo(
    () => threadGraph({ sessions: state.sessions, threads: state.threads, states, projects, scope }),
    [state, states, projects, scope]
  )

  const active = React.useMemo(
    () => state.sessions.filter((s) => !s.draft && !s.deletedAt && isActiveState(states.get(s.id) ?? "idle")),
    [state.sessions, states]
  )
  /* Top-level threads at work: their transcripts are where workers live. A
     child's workers are its own thread's, reached by opening it. */
  const held = React.useMemo(
    () => active.filter((s) => !s.parentSessionId).slice(0, HOLD_LIMIT).map((s) => s.id),
    [active]
  )
  const opens = React.useMemo(() => new Map(graph.nodes.map((n) => [n.id, n.open])), [graph])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col pt-[var(--app-header-h)]">
      <HoldThreads ids={held} />
      <div className="flex min-h-0 flex-1 flex-col px-4 pt-6 pb-4 @panel-sm:px-8">
        <SurfaceHeader
          className="mb-4"
          icon={NetworkIcon}
          title="Thread graph"
          description="Every thread at work across your projects, the asks and workflow runs it started, and the subagents inside it. Select a node to open its thread."
          actions={
            <Segmented
              label="Which threads"
              value={scope}
              onChange={setScope}
              options={[
                { value: "active", label: "Active", count: active.length },
                { value: "all", label: "All" },
              ]}
            />
          }
        />
        <ErrorNote error={error} onRetry={retry} className="mb-4" />
        {loading && state.sessions.length === 0 ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
            <Spinner /> Loading threads…
          </div>
        ) : graph.nodes.length === 0 ? (
          <Empty size="lg" icon={NetworkIcon}>
            {scope === "active"
              ? "Nothing is running right now. Switch to All to see every thread with a live agent."
              : "No thread has a live agent right now."}
          </Empty>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border">
            <InteractiveFlowchart
              nodes={graph.nodes}
              edges={graph.edges}
              direction="down"
              fill
              readOnly
              onNodeClick={(id) => {
                const open = opens.get(id)
                if (open) void navigate(threadPath(open))
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
