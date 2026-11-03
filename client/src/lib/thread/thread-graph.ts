/* ── Every running thread as one graph ──
   The `/graph` page's drawing, built from what the client already holds: the
   session list for threads, asks and harness workflow steps (`parentSessionId`,
   `childKind`, `childRunId` — every device sees these), and each loaded
   thread's own transcript rows for the workers the server never interprets —
   a runtime's in-process subagents and its own workflows (`buildRows`'
   `subagent-group` / `workflow-group`). Pure, so the check can walk it.

   One worker is one node however many sources announce it: a transcript head
   whose `sessionId` is a listed session IS that session's node, and a harness
   run is `workflow:<runId>` from either side. */
import type { FlowchartEdge, FlowchartNode } from "../openui/interactive-flowchart"
import { childKindOf, type SessionMeta } from "../settings"
import type { ThreadItem } from "../store"
import { buildRows, subagentLabel, type Row, type SubagentGroup } from "../transcript-rows"
import type { AgentState } from "./statuses"

export type GraphScope = "active" | "all"

export interface ThreadGraphNode extends FlowchartNode {
  /** The thread a click opens: the node's own, or the parent of a worker
      that has no thread of its own. */
  open?: string
}

export interface ThreadGraph {
  nodes: ThreadGraphNode[]
  edges: FlowchartEdge[]
}

/** The slice of a live thread the builder reads. */
export interface GraphThread {
  items: ThreadItem[]
  turnActive: boolean
  background: boolean
}

/** A batch wider than this is one `N agents` node, not N. */
export const BATCH_FOLD = 6

const ACTIVE: ReadonlySet<AgentState> = new Set(["running", "waiting", "held"])
export const isActiveState = (state: AgentState): boolean => ACTIVE.has(state)

const STATE_TONE: Record<AgentState, FlowchartNode["tone"]> = {
  running: "running",
  waiting: "running",
  held: "failed",
  failed: "failed",
  idle: "pending",
  archived: "pending",
}
const STATE_HINT: Record<AgentState, string> = {
  running: "running",
  waiting: "waiting on you",
  held: "held at an error",
  failed: "last turn failed",
  idle: "idle",
  archived: "stopped",
}

const clip = (text: string, max = 60): string => {
  const line = text.split("\n")[0].trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function headTone(group: SubagentGroup): FlowchartNode["tone"] {
  if (group.active) return "running"
  const { head } = group
  const failed = head.kind === "subagent" ? head.state !== "completed" && head.state !== "running" : head.status === "failed"
  return failed ? "failed" : "done"
}

export function threadGraph({
  sessions,
  threads,
  states,
  projects,
  scope,
}: {
  sessions: SessionMeta[]
  threads: Record<string, GraphThread | undefined>
  /** `agentState` per session id; a session missing from it reads idle. */
  states: ReadonlyMap<string, AgentState>
  projects: { id: string; name: string }[]
  scope: GraphScope
}): ThreadGraph {
  const live = sessions.filter((s) => !s.draft && !s.deletedAt)
  const byId = new Map(live.map((s) => [s.id, s]))
  const stateOf = (s: SessionMeta): AgentState => states.get(s.id) ?? "idle"

  /* Who is drawn: Active is everything at work plus the chain above it, so a
     running step is never an orphan; All is every thread with a process. */
  const shown = new Set<string>()
  for (const s of live) {
    const state = stateOf(s)
    if (scope === "active" ? !isActiveState(state) : state === "archived") continue
    for (let at: SessionMeta | undefined = s; at && !shown.has(at.id); at = byId.get(at.parentSessionId ?? "")) {
      shown.add(at.id)
    }
  }

  const nodes = new Map<string, ThreadGraphNode>()
  const edges: FlowchartEdge[] = []
  const edgeKeys = new Set<string>()
  const link = (from: string, to: string, label?: string, dashed?: boolean) => {
    const key = `${from}>${to}`
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)
    edges.push({ from, to, ...(label ? { label } : {}), ...(dashed ? { dashed } : {}) })
  }
  const projectNode = (projectId: string): string => {
    const id = `p:${projectId}`
    if (!nodes.has(id)) {
      const name = projects.find((p) => p.id === projectId)?.name ?? "Project"
      nodes.set(id, { id, label: name, shape: "round" })
    }
    return id
  }
  const runNode = (runId: string, name: string | null | undefined, parent: string): string => {
    const id = `workflow:${runId}`
    if (!nodes.has(id)) nodes.set(id, { id, label: clip(name || "workflow run"), shape: "diamond", tone: "running" })
    link(parent, id, "workflow")
    return id
  }

  // ── threads, asks and harness steps, from the session list ──
  const threadId = (id: string) => `t:${id}`
  for (const id of shown) {
    const s = byId.get(id)!
    const state = stateOf(s)
    const kind = childKindOf(s)
    nodes.set(threadId(id), {
      id: threadId(id),
      label: clip(s.title || "Thread"),
      hint: [kind && kind !== "workflow" ? kind : null, STATE_HINT[state]].filter(Boolean).join(" · "),
      tone: STATE_TONE[state],
      open: id,
    })
  }
  for (const id of shown) {
    const s = byId.get(id)!
    const parent = s.parentSessionId && shown.has(s.parentSessionId) ? threadId(s.parentSessionId) : null
    const fork = s.forkedFromSessionId && shown.has(s.forkedFromSessionId) ? threadId(s.forkedFromSessionId) : null
    if (parent && childKindOf(s) === "workflow" && s.childRunId) {
      link(runNode(s.childRunId, s.childRunName, parent), threadId(id))
    } else if (parent) {
      link(parent, threadId(id), childKindOf(s) ?? undefined)
    } else if (fork) {
      link(fork, threadId(id), "fork", true)
    } else {
      // A top-level thread, or a child whose parent is gone: under its project.
      link(projectNode(s.projectId), threadId(id))
    }
  }

  // ── the workers inside each loaded thread, from its transcript ──
  const walk = (rows: Row[], parent: string, open: string) => {
    for (const row of rows) {
      if (row.kind === "work-fold") walk(row.rows, parent, open)
      else if (row.kind === "subagent-group") worker(row, parent, open)
      else if (row.kind === "subagent-batch") {
        const busy = row.steps.filter((step) => step.active && !listed(step))
        if (busy.length > BATCH_FOLD) {
          const id = `more:${row.id}`
          nodes.set(id, { id, label: `${busy.length} agents`, hint: "running", tone: "running", open })
          link(parent, id, "subagents")
          row.steps.filter(listed).forEach((step) => worker(step, parent, open))
        } else row.steps.forEach((step) => worker(step, parent, open))
      } else if (row.kind === "workflow-group" && !row.finished) {
        const run = runNode(row.id.slice("workflow:".length), row.name, parent)
        row.steps.forEach((step) => worker(step, run, open, true))
        // The steps the plan names that have not spawned yet.
        const spawned = new Set(row.steps.map((step) => (step.head.kind === "subagent" ? step.head.workflow?.step : undefined)))
        row.plan?.forEach((phase, p) =>
          phase.steps.forEach((name, i) => {
            if (spawned.has(name)) return
            const id = `pending:${row.id}:${p}:${i}`
            nodes.set(id, { id, label: clip(name), hint: "pending", tone: "pending" })
            link(run, id)
          })
        )
      }
    }
  }
  /* A head naming a listed session is that session — drawn by the list. */
  const listed = (group: SubagentGroup): boolean => group.head.kind === "subagent" && byId.has(group.head.sessionId)
  const worker = (group: SubagentGroup, parent: string, open: string, step = false) => {
    if (listed(group)) {
      const sid = (group.head as { sessionId: string }).sessionId
      // A run's step keeps its place under the run even when the list is behind.
      if (shown.has(sid)) link(parent, threadId(sid))
      else if (step) addWorker(group, parent, sid)
      return
    }
    // Finished workers are history, the transcript's to show; a step of a live run is its progress.
    if (!group.active && !step) return
    const id = addWorker(group, parent, open)
    walk(group.children, id, open)
  }
  const addWorker = (group: SubagentGroup, parent: string, open: string): string => {
    const id = `sa:${group.id}`
    const { task, name } = subagentLabel(group.head)
    const tone = headTone(group)
    nodes.set(id, {
      id,
      label: clip(task || name || "Agent"),
      hint: [name && name !== task ? clip(name, 30) : null, tone === "running" ? "running" : tone === "failed" ? "failed" : "done"]
        .filter(Boolean)
        .join(" · "),
      tone,
      open,
    })
    link(parent, id)
    return id
  }

  for (const id of shown) {
    const thread = threads[id]
    if (!thread?.items.length) continue
    walk(buildRows(thread.items, false, thread.turnActive || thread.background), threadId(id), id)
  }

  return { nodes: [...nodes.values()], edges }
}
