/* A workflow run drawn as its graph: every phase a column of the steps that
   run side by side in it, joined to the next phase by the barrier between
   them. Only the phase joins are drawn — the outline the client receives
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
  let prev: string[] = []
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
        ]
          .filter(Boolean)
          .join(" · "),
        tone: TONE[step.state],
        shape: "box",
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
  return (
    <InteractiveFlowchart
      nodes={nodes}
      edges={edges}
      direction="right"
      readOnly
      selectedId={selectedId}
      onNodeClick={(id) => {
        if (!id.startsWith("pending:") && !id.startsWith("join:")) onSelect(id)
      }}
    />
  )
}
