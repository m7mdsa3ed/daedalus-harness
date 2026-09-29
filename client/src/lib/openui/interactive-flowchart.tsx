import * as React from "react"
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react"

export type FlowchartNode = {
  id: string
  label?: string
  shape?: "box" | "round" | "diamond" | "circle"
}

export type FlowchartEdge = {
  from: string
  to: string
  label?: string
  dashed?: boolean
}

type FlowDirection = "down" | "right"
type FlowNodeData = {
  label: string
  shape: NonNullable<FlowchartNode["shape"]>
  direction: FlowDirection
}
type FlowNode = Node<FlowNodeData, "flowNode">

function layoutNodes(nodes: FlowchartNode[], edges: FlowchartEdge[], direction: FlowDirection): FlowNode[] {
  const unique = [...new Map(nodes.map((node) => [node.id, node])).values()]
  const ids = new Set(unique.map((node) => node.id))
  const next = new Map(unique.map((node) => [node.id, [] as string[]]))
  const incoming = new Map(unique.map((node) => [node.id, 0]))

  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue
    next.get(edge.from)?.push(edge.to)
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
  }

  const levels = new Map(unique.map((node) => [node.id, 0]))
  const remaining = new Map(incoming)
  const queue = unique.filter((node) => remaining.get(node.id) === 0).map((node) => node.id)
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor]
    for (const child of next.get(id) ?? []) {
      levels.set(child, Math.max(levels.get(child) ?? 0, (levels.get(id) ?? 0) + 1))
      const count = (remaining.get(child) ?? 1) - 1
      remaining.set(child, count)
      if (count === 0) queue.push(child)
    }
  }

  const maxLevel = Math.max(0, ...levels.values())
  let cycleIndex = 0
  for (const node of unique) {
    if ((remaining.get(node.id) ?? 0) > 0) {
      levels.set(node.id, maxLevel + Math.floor(cycleIndex / 3))
      cycleIndex++
    }
  }

  const rows = new Map<number, FlowchartNode[]>()
  for (const node of unique) {
    const level = levels.get(node.id) ?? 0
    rows.set(level, [...(rows.get(level) ?? []), node])
  }

  return unique.map((node) => {
    const level = levels.get(node.id) ?? 0
    const row = rows.get(level) ?? [node]
    const positionInRow = row.findIndex((entry) => entry.id === node.id)
    const across = (positionInRow - (row.length - 1) / 2) * 220
    const along = level * 150
    return {
      id: node.id,
      type: "flowNode",
      position: direction === "right" ? { x: along, y: across } : { x: across, y: along },
      data: { label: node.label ?? node.id, shape: node.shape ?? "box", direction },
    }
  })
}

function FlowNodeView({ data, selected }: NodeProps<FlowNode>) {
  const horizontal = data.direction === "right"
  const targetPosition = horizontal ? Position.Left : Position.Top
  const sourcePosition = horizontal ? Position.Right : Position.Bottom
  const shapeClass = {
    box: "rounded-lg",
    round: "rounded-full",
    diamond: "[clip-path:polygon(50%_0%,100%_50%,50%_100%,0%_50%)] px-8",
    circle: "aspect-square min-w-24 rounded-full",
  }[data.shape]

  return (
    <div
      className={`relative flex min-h-12 min-w-28 max-w-52 items-center justify-center border bg-card px-4 py-2 text-center text-xs leading-snug text-card-foreground shadow-sm ${shapeClass} ${selected ? "border-primary ring-2 ring-primary/25" : "border-border"}`}
    >
      <Handle type="target" position={targetPosition} className="!size-2 !border-2 !border-background !bg-primary" />
      <span className="break-words">{data.label}</span>
      <Handle type="source" position={sourcePosition} className="!size-2 !border-2 !border-background !bg-primary" />
    </div>
  )
}

const nodeTypes = { flowNode: FlowNodeView }

export function InteractiveFlowchart({
  nodes: inputNodes,
  edges: inputEdges,
  direction = "down",
}: {
  nodes: FlowchartNode[]
  edges: FlowchartEdge[]
  direction?: FlowDirection
}) {
  const [nodes, setNodes] = React.useState<FlowNode[]>(() => layoutNodes(inputNodes, inputEdges, direction))
  const [edges, setEdges] = React.useState<Edge[]>(() => {
    const validIds = new Set(inputNodes.map((node) => node.id))
    return inputEdges
      .filter((edge) => validIds.has(edge.from) && validIds.has(edge.to))
      .map((edge, index) => ({
        id: `edge-${index}`,
        source: edge.from,
        target: edge.to,
        label: edge.label,
        type: "smoothstep",
        animated: false,
        style: edge.dashed ? { strokeDasharray: "5 4" } : undefined,
      }))
  })

  const onNodesChange = React.useCallback((changes: NodeChange<FlowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current))
    const removed = new Set(changes.filter((change) => change.type === "remove").map((change) => change.id))
    if (removed.size) {
      setEdges((current) => current.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target)))
    }
  }, [])

  const onEdgesChange = React.useCallback((changes: EdgeChange[]) => {
    setEdges((current) => applyEdgeChanges(changes, current))
  }, [])

  const onConnect = React.useCallback((connection: Connection) => {
    setEdges((current) => addEdge({ ...connection, type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed } }, current))
  }, [])

  return (
    <div className="relative h-[min(55vh,390px)] min-h-64 w-full min-w-0 self-stretch overflow-hidden rounded-md bg-background" aria-label="Interactive flowchart">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        fitView
        fitViewOptions={{ padding: 0.22 }}
        nodesConnectable
        nodesDraggable
        elementsSelectable
        deleteKeyCode={["Backspace", "Delete"]}
        defaultEdgeOptions={{ type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed } }}
        className="text-foreground"
      >
        <Background color="var(--border)" gap={18} size={1} />
        <Controls showInteractive={false} className="!overflow-hidden !rounded-md !border !border-border !bg-card !shadow-sm [&>button]:!border-border [&>button]:!bg-card [&>button]:!fill-foreground [&>button:hover]:!bg-muted" />
      </ReactFlow>
    </div>
  )
}
