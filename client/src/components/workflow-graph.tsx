/* A workflow run drawn as a flowchart, top to bottom from Start to End: every
   phase a row of the steps that run side by side in it, joined to the next
   phase by the barrier between them, and a running step's node listing what
   it has been doing. It always fills the flex column it is put in — the caller
   sizes that box (the Agents panel, or a card's own height). Only the phase joins are drawn — the outline the client receives
   (`group.plan`) names phases and steps, not a step's own `dependsOn`, so an
   edge inside a phase is something this cannot know and does not guess.

   Its own module so `@xyflow/react` rides a lazy chunk: `workflow-run.tsx`
   is on every transcript, the graph only on one someone opened. */
import type { FlowchartEdge, FlowchartNode } from "@/lib/openui/interactive-flowchart"
import { InteractiveFlowchart } from "@/lib/openui/interactive-flowchart"
import { formatElapsed, useElapsed } from "@/components/step-row"

export interface GraphStep {
  /** The step's group id once spawned; a pending step has none to open. */
  id: string | null
  name: string
  state: "running" | "completed" | "failed" | "cancelled" | "disconnected" | "pending"
  /** When the step started — the running node's clock counts from it. */
  startedAt?: number
  /** A running step's latest calls, oldest first. */
  updates?: string[]
  /** A settled step's report, on one line. */
  result?: string
  /** What the step billed so far, already worded (`12.4k tokens`). */
  tokens?: string
}

const TONE = {
  running: "running",
  completed: "done",
  failed: "failed",
  cancelled: "failed",
  disconnected: "failed",
  pending: "pending",
} as const

export function WorkflowGraph({
  phases,
  selectedId,
  onSelect,
}: {
  phases: { name: string | null; steps: GraphStep[] }[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  /* One clock for the whole graph, ticking only while a step runs: elapsed
     since 0 is simply now, so every running node reads off the same second. */
  const now = useElapsed(0, phases.some((phase) => phase.steps.some((step) => step.state === "running")))
  const nodes: FlowchartNode[] = []
  const edges: FlowchartEdge[] = []
  const steps = phases.flatMap((phase) => phase.steps)
  const end = steps.some((step) => step.state === "running" || step.state === "pending")
    ? "pending"
    : steps.some((step) => step.state === "failed")
      ? "failed"
      : "done"
  nodes.push({ id: "start", label: "Start", shape: "round", tone: "done" })
  let prev: string[] = ["start"]
  phases.forEach((phase, p) => {
    const ids = phase.steps.map((step, i) => {
      const id = step.id ?? `pending:${p}:${i}`
      nodes.push({
        id,
        label: step.name || `step ${i + 1}`,
        hint: [
          phase.name,
          step.state === "running" && now !== null && step.startedAt
            ? `running ${formatElapsed(Math.max(0, now - step.startedAt))}`
            : step.state === "completed"
              ? "done"
              : step.state,
          step.tokens,
        ]
          .filter(Boolean)
          .join(" · "),
        tone: TONE[step.state],
        shape: "box",
        updates: step.state === "running" ? step.updates : undefined,
        result: step.state === "running" ? undefined : step.result,
      })
      return id
    })
    /* N×M edges between two wide phases is a hairball, so a many-to-many
       barrier goes through one join dot; one side of one step joins directly. */
    if (prev.length > 1 && ids.length > 1) {
      const join = `join:${p}`
      nodes.push({ id: join, shape: "dot" })
      prev.forEach((from) => edges.push({ from, to: join }))
      ids.forEach((to) => edges.push({ from: join, to }))
    } else {
      prev.forEach((from) => ids.forEach((to) => edges.push({ from, to })))
    }
    prev = ids
  })
  nodes.push({ id: "end", label: end === "pending" ? "End" : end === "failed" ? "Ended with failures" : "Done", shape: "round", tone: end })
  prev.forEach((from) => edges.push({ from, to: "end", dashed: end === "pending" }))
  return (
    <InteractiveFlowchart
      nodes={nodes}
      edges={edges}
      direction="down"
      fill
      readOnly
      selectedId={selectedId}
      onNodeClick={(id) => {
        if (!id.startsWith("pending:") && !id.startsWith("join:") && id !== "start" && id !== "end") onSelect(id)
      }}
    />
  )
}
