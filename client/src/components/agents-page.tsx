/* ── /agents — every thread's live state in one list ──
   The dashboard the sidebar is too narrow to be: each listed thread with its
   project, agent, what it is doing right now, when it last spoke and how full
   its context is, filtered by state, project and agent.

   Nothing here is fetched for itself. The rows are the session list the store
   already holds (`isListed`, never a draft or a workflow step), and the state is
   the one reading every list draws (`agentState` over `threadStatus`) — the
   live thread where a tab holds one, else the server's snapshot of its bridge
   (`SessionMeta.waiting`/`held`/`context`). That snapshot moves only when the
   list is re-read, so the page re-reads it while it is on screen: on mount, on
   Refresh, and on a slow tick while the document is visible. */
import * as React from "react"
import { useNavigate } from "react-router"
import {
  AlertTriangleIcon,
  BotIcon,
  CirclePauseIcon,
  HandIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react"

import { AgentIcon, ProjectIcon } from "@/components/entity-icon"
import { Empty } from "@/components/empty"
import { StatGrid, StatTile, SurfaceHeader } from "@/components/page-primitives"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { Actions } from "@/lib/actions"
import { useAgents, useProjects } from "@/lib/queries/catalog"
import { threadPath } from "@/lib/router"
import { activityAt, isListed, type SessionMeta } from "@/lib/settings"
import { useStoreSelect } from "@/lib/store"
import { agentState, contextPercent, type AgentState } from "@/lib/thread/statuses"
import { shortAge } from "@/lib/time"
import { cn } from "@/lib/utils"

/** The server snapshot's refresh while the page is visible. ponytail: a poll;
    a list-level push from the server is the upgrade if this ever matters. */
const REFRESH_MS = 15_000

const STATE: Record<AgentState, { label: string; tone: string; dot: string }> = {
  waiting: {
    label: "Needs you",
    tone: "text-amber-700 dark:text-amber-400",
    dot: "bg-amber-500",
  },
  held: { label: "Held on error", tone: "text-destructive", dot: "bg-destructive" },
  running: { label: "Running", tone: "text-primary", dot: "bg-primary animate-pulse" },
  failed: { label: "Last turn failed", tone: "text-destructive", dot: "bg-destructive/70" },
  idle: { label: "Idle", tone: "text-muted-foreground", dot: "bg-muted-foreground/40" },
  archived: { label: "Archived", tone: "text-muted-foreground/70", dot: "bg-border" },
}

/** Most urgent first — the order the list is sorted in before activity. */
const ORDER: AgentState[] = ["waiting", "held", "running", "failed", "idle", "archived"]

interface Reading {
  state: AgentState
  context: number | null
}

/** Every listed thread's reading, as a map that keeps its identity until a
    reading actually moves — `state.threads` is replaced on every streamed
    token, and a page selecting it directly would re-render per token. */
function useReadings(): Map<string, Reading> {
  const prev = React.useRef<Map<string, Reading>>(new Map())
  return useStoreSelect((state) => {
    const next = new Map<string, Reading>()
    for (const session of state.sessions) {
      if (!isListed(session) || session.deletedAt) continue
      const thread = state.threads[session.id]
      next.set(session.id, { state: agentState(session, thread), context: contextPercent(session, thread) })
    }
    let same = next.size === prev.current.size
    if (same)
      for (const [id, reading] of next) {
        const old = prev.current.get(id)
        if (!old || old.state !== reading.state || old.context !== reading.context) {
          same = false
          break
        }
      }
    if (!same) prev.current = next
    return prev.current
  })
}

const ALL = "all"

export function AgentsPage({ actions }: { actions: Actions }) {
  const navigate = useNavigate()
  const sessions = useStoreSelect((state) => state.sessions)
  const readings = useReadings()
  const projects = useProjects()
  const agents = useAgents()

  const [query, setQuery] = React.useState("")
  const [stateFilter, setStateFilter] = React.useState<AgentState | typeof ALL>(ALL)
  const [projectFilter, setProjectFilter] = React.useState<string>(ALL)
  const [agentFilter, setAgentFilter] = React.useState<string>(ALL)

  const [refreshing, setRefreshing] = React.useState(false)
  const refresh = React.useCallback(() => {
    setRefreshing(true)
    void actions
      .refreshSessions()
      .catch(() => {})
      .finally(() => setRefreshing(false))
  }, [actions])
  React.useEffect(() => {
    refresh()
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh()
    }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const listed = React.useMemo(
    () => sessions.filter((session) => isListed(session) && !session.deletedAt),
    [sessions]
  )
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "Home"
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id

  const counts = React.useMemo(() => {
    const out: Record<AgentState, number> = { waiting: 0, held: 0, running: 0, failed: 0, idle: 0, archived: 0 }
    for (const reading of readings.values()) out[reading.state] += 1
    return out
  }, [readings])

  const needle = query.trim().toLowerCase()
  const rows = listed
    .filter((session) => {
      const reading = readings.get(session.id)
      if (stateFilter !== ALL && reading?.state !== stateFilter) return false
      if (projectFilter !== ALL && session.projectId !== projectFilter) return false
      if (agentFilter !== ALL && session.agentId !== agentFilter) return false
      if (!needle) return true
      return [session.title, projectName(session.projectId), agentName(session.agentId)]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    })
    .sort((a, b) => {
      const rank = (s: SessionMeta) => ORDER.indexOf(readings.get(s.id)?.state ?? "idle")
      return rank(a) - rank(b) || activityAt(b) - activityAt(a)
    })

  /* Only the projects and agents that some listed thread is in — a filter
     offering a choice that matches nothing is a dead end. */
  const projectIds = [...new Set(listed.map((s) => s.projectId))]
  const agentIds = [...new Set(listed.map((s) => s.agentId))]
  const filtered = needle || stateFilter !== ALL || projectFilter !== ALL || agentFilter !== ALL

  return (
    <>
      <SurfaceHeader
        title="Agents"
        description="Every thread, what it is doing now, and which ones are waiting on you."
        actions={
          <Button variant="outline" onClick={refresh} disabled={refreshing}>
            <RefreshCwIcon data-icon="inline-start" className={cn(refreshing && "animate-spin")} />
            Refresh
          </Button>
        }
      />

      <StatGrid>
        <StatTile
          icon={HandIcon}
          label="Needs you"
          value={counts.waiting}
          tone={counts.waiting > 0 ? STATE.waiting.tone : undefined}
          hint={counts.waiting > 0 ? "an approval or a question is open" : "nothing is waiting on you"}
        />
        <StatTile
          icon={LoaderCircleIcon}
          label="Running"
          value={counts.running}
          hint={counts.running === 1 ? "turn in progress" : "turns in progress"}
        />
        <StatTile
          icon={CirclePauseIcon}
          label="Held"
          value={counts.held}
          tone={counts.held > 0 ? STATE.held.tone : undefined}
          hint={counts.held > 0 ? "waiting for a model change and Continue" : "no turn is held"}
        />
        <StatTile
          icon={AlertTriangleIcon}
          label="Failed"
          value={counts.failed}
          tone={counts.failed > 0 ? STATE.failed.tone : undefined}
          hint={counts.failed > 0 ? "the last turn ended in an error" : "every last turn ended cleanly"}
        />
      </StatGrid>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-40 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search threads"
            aria-label="Search threads"
            className="pl-8"
          />
        </div>
        <Select value={stateFilter} onValueChange={(value) => setStateFilter((value ?? ALL) as AgentState | typeof ALL)}>
          <SelectTrigger className="w-auto min-w-32" aria-label="Filter by state">
            <SelectValue>{stateFilter === ALL ? "Any state" : STATE[stateFilter].label}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any state</SelectItem>
            {ORDER.map((state) => (
              <SelectItem key={state} value={state}>
                {STATE[state].label}
                <span className="ml-auto pl-2 text-xs tabular-nums text-muted-foreground">{counts[state]}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={projectFilter} onValueChange={(value) => setProjectFilter(value ?? ALL)}>
          <SelectTrigger className="w-auto min-w-32" aria-label="Filter by project">
            <SelectValue>{projectFilter === ALL ? "Any project" : projectName(projectFilter)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any project</SelectItem>
            {projectIds.map((id) => (
              <SelectItem key={id} value={id}>
                {projectName(id)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={agentFilter} onValueChange={(value) => setAgentFilter(value ?? ALL)}>
          <SelectTrigger className="w-auto min-w-32" aria-label="Filter by agent">
            <SelectValue>{agentFilter === ALL ? "Any agent" : agentName(agentFilter)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any agent</SelectItem>
            {agentIds.map((id) => (
              <SelectItem key={id} value={id}>
                {agentName(id)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-3">
        {rows.length === 0 ? (
          <Empty size="lg">
            {listed.length === 0 ? "No threads yet." : filtered ? "No thread matches these filters." : "No threads."}
          </Empty>
        ) : (
          /* A table where the panel has room, a stack of cards where it does
             not: the same rows, the columns folding under the title below
             `@panel-md` — measured on the panel, never the window. */
          <ul role="list" className="overflow-hidden rounded-xl border bg-card">
            <li
              aria-hidden
              className="hidden border-b px-4 py-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase @panel-md:grid @panel-md:grid-cols-[minmax(0,1fr)_9rem_8rem_8rem_4rem_4rem] @panel-md:gap-3"
            >
              <span>Thread</span>
              <span>Project</span>
              <span>Agent</span>
              <span>State</span>
              <span className="text-right">Active</span>
              <span className="text-right">Context</span>
            </li>
            {rows.map((session) => {
              const reading = readings.get(session.id) ?? { state: "idle" as const, context: null }
              const state = STATE[reading.state]
              const project = projects.find((p) => p.id === session.projectId)
              return (
                <li key={session.id} className="border-b last:border-b-0">
                  <button
                    type="button"
                    onClick={() => void navigate(threadPath(session.id))}
                    className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-2.5 text-left text-sm hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none @panel-md:grid-cols-[minmax(0,1fr)_9rem_8rem_8rem_4rem_4rem] @panel-md:items-center"
                  >
                    <span className="min-w-0 truncate font-medium" title={session.title}>
                      {session.title || "Untitled thread"}
                    </span>
                    <span className="order-last col-span-2 flex min-w-0 items-center gap-3 text-xs text-muted-foreground @panel-md:order-none @panel-md:col-span-1 @panel-md:contents">
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <ProjectIcon project={project} className="size-4 shrink-0" />
                        <span className="truncate">{projectName(session.projectId)}</span>
                      </span>
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <AgentIcon agentId={session.agentId} className="size-3.5 shrink-0" />
                        <span className="truncate">{agentName(session.agentId)}</span>
                      </span>
                      {/* On a card the two figures ride the meta line; in
                          the table they are columns of their own. */}
                      <span className="ml-auto shrink-0 tabular-nums @panel-md:hidden">
                        {shortAge(activityAt(session))}
                        {reading.context !== null && ` · ${reading.context}%`}
                      </span>
                    </span>
                    <span className={cn("inline-flex items-center gap-1.5 text-xs whitespace-nowrap", state.tone)}>
                      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", state.dot)} />
                      {state.label}
                    </span>
                    <span
                      className="hidden text-right text-xs tabular-nums text-muted-foreground @panel-md:block"
                      title={new Date(activityAt(session)).toLocaleString()}
                    >
                      {shortAge(activityAt(session))}
                    </span>
                    <span
                      className={cn(
                        "hidden text-right text-xs tabular-nums @panel-md:block",
                        reading.context !== null && reading.context >= 85 ? "text-destructive" : "text-muted-foreground"
                      )}
                    >
                      {reading.context === null ? "—" : `${reading.context}%`}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      {listed.length > 0 && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <BotIcon className="size-3.5" />
          {rows.length} of {listed.length} threads · states of threads with no open tab are the server's, re-read every{" "}
          {REFRESH_MS / 1000}s
        </p>
      )}
    </>
  )
}
