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
  type ReactFlowInstance,
} from "@xyflow/react"

import { PANEL_SM } from "@/hooks/use-device"

export type FlowchartNode = {
  id: string
  label?: string
  shape?: "box" | "round" | "diamond" | "circle" | "dot"
  /** A run's step state, drawn as the node's border (read-only graphs). */
  tone?: "done" | "running" | "failed" | "pending"
  /** A second, quieter line under the label. */
  hint?: string
  /** What a live node has been doing, oldest first — a run's running step
      lists its latest calls here, and the newest shimmers. */
  updates?: string[]
  /** What a finished node came back with, clamped to three lines. */
  result?: string
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
  tone?: FlowchartNode["tone"]
  hint?: string
  updates?: string[]
  result?: string
}
type FlowNode = Node<FlowNodeData, "flowNode">

function layoutNodes(
  nodes: FlowchartNode[],
  edges: FlowchartEdge[],
  direction: FlowDirection,
  columns = Number.POSITIVE_INFINITY
): FlowNode[] {
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

  const levelsById = new Map(unique.map((node) => [node.id, levels.get(node.id) ?? 0]))
  const rows = new Map<number, FlowchartNode[]>()
  for (const node of unique) {
    const level = levelsById.get(node.id) ?? 0
    rows.set(level, [...(rows.get(level) ?? []), node])
  }

  /* In a vertical layout, cap siblings across to the measured panel width and
     continue them on extra rows. Shift later graph levels down to make room. */
  const rowPosition = new Map<string, { level: number; index: number; count: number }>()
  let levelOffset = 0
  const rowSize = Math.max(1, Math.floor(columns))
  for (const [level, row] of [...rows].sort(([a], [b]) => a - b)) {
    const chunks = direction === "down" ? Math.max(1, Math.ceil(row.length / rowSize)) : 1
    row.forEach((node, index) => {
      const chunk = direction === "down" ? Math.floor(index / rowSize) : 0
      rowPosition.set(node.id, {
        level: level + levelOffset + chunk,
        index: direction === "down" ? index % rowSize : index,
        count: direction === "down" ? Math.min(rowSize, row.length - chunk * rowSize) : row.length,
      })
    })
    levelOffset += chunks - 1
  }

  return unique.map((node) => {
    const position = rowPosition.get(node.id) ?? { level: levelsById.get(node.id) ?? 0, index: 0, count: 1 }
    const across = (position.index - (position.count - 1) / 2) * 220
    const along = position.level * 150
    return {
      id: node.id,
      type: "flowNode",
      position: direction === "right" ? { x: along, y: across } : { x: across, y: along },
      data: { label: node.label ?? node.id, shape: node.shape ?? "box", direction, tone: node.tone, hint: node.hint, updates: node.updates, result: node.result },
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
    dot: "!min-h-0 !min-w-0 size-3 rounded-full !p-0 bg-border",
  }[data.shape]
  const toneClass = {
    done: "border-success",
    running: "border-primary ring-2 ring-primary/20",
    failed: "border-destructive bg-destructive/5",
    pending: "border-dashed border-border text-muted-foreground",
  }[data.tone ?? "pending"]
  const border = selected ? "border-primary ring-2 ring-primary/25" : data.tone ? toneClass : "border-border"

  return (
    <div
      className={`relative flex min-h-12 min-w-28 max-w-52 items-center justify-center border bg-card px-4 py-2 text-center text-xs leading-snug text-card-foreground ${shapeClass} ${border}`}
    >
      <Handle type="target" position={targetPosition} className="!size-2 !border-2 !border-background !bg-primary" />
      {data.shape !== "dot" && (
        <span className="min-w-0 break-words">
          {data.label}
          {data.hint && <span className="block text-xs text-muted-foreground">{data.hint}</span>}
          {data.updates && data.updates.length > 0 && (
            <span className="mt-1 block space-y-px border-t pt-1 text-start text-xs text-muted-foreground">
              {data.updates.map((update, i) => (
                <span
                  key={i}
                  className={`block truncate ${i === data.updates!.length - 1 ? "text-foreground/80 harness-shimmer" : "opacity-70"}`}
                >
                  {update}
                </span>
              ))}
            </span>
          )}
          {data.result && (
            <span
              className={`mt-1 line-clamp-3 border-t pt-1 text-start text-xs leading-snug ${data.tone === "failed" ? "text-destructive" : "text-muted-foreground"}`}
              title={data.result}
            >
              {data.result}
            </span>
          )}
        </span>
      )}
      <Handle type="source" position={sourcePosition} className="!size-2 !border-2 !border-background !bg-primary" />
    </div>
  )
}

const nodeTypes = { flowNode: FlowNodeView }

function toEdges(nodes: FlowchartNode[], edges: FlowchartEdge[]): Edge[] {
  const validIds = new Set(nodes.map((node) => node.id))
  return edges
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
}

export function InteractiveFlowchart({
  nodes: inputNodes,
  edges: inputEdges,
  direction = "down",
  readOnly = false,
  onNodeClick,
  selectedId,
  fill = false,
}: {
  nodes: FlowchartNode[]
  edges: FlowchartEdge[]
  direction?: FlowDirection
  /** A drawing of live state rather than a sketch to edit: nothing moves,
      connects or deletes, and a change in the inputs redraws it. */
  readOnly?: boolean
  onNodeClick?: (id: string) => void
  /** Read-only: the node drawn as selected — the caller's pick, since a
      derived node list has no selection state of its own to keep. */
  selectedId?: string | null
  /** Take the height of a flex column instead of the inline figure's own. */
  fill?: boolean
}) {
  const [responsiveLayout, setResponsiveLayout] = React.useState<{ direction: FlowDirection; columns: number }>(
    () => ({ direction, columns: Number.POSITIVE_INFINITY })
  )
  const layoutDirection = responsiveLayout.direction
  const columns = responsiveLayout.columns
  const layoutKey = `${layoutDirection}:${columns}`
  const [nodes, setNodes] = React.useState<FlowNode[]>(() => layoutNodes(inputNodes, inputEdges, direction))
  const [edges, setEdges] = React.useState<Edge[]>(() => toEdges(inputNodes, inputEdges))
  const edgesRef = React.useRef(edges)
  edgesRef.current = edges
  // Read-only: derived every render, so a live run's states flow straight in.
  const liveNodes = React.useMemo(
    () =>
      readOnly
        ? layoutNodes(inputNodes, inputEdges, layoutDirection, columns).map((node) => ({ ...node, selected: node.id === selectedId }))
        : null,
    [readOnly, inputNodes, inputEdges, layoutDirection, columns, selectedId]
  )
  const liveEdges = React.useMemo(
    () => (readOnly ? toEdges(inputNodes, inputEdges) : null),
    [readOnly, inputNodes, inputEdges]
  )

  /* Width belongs to the chart's containing panel, not the window. */
  const boxRef = React.useRef<HTMLDivElement>(null)
  const flowRef = React.useRef<ReactFlowInstance<FlowNode, Edge> | null>(null)
  React.useEffect(() => {
    const box = boxRef.current
    if (!box) return
    let frame = 0
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry?.contentRect.width ?? 0)
      if (width <= 0) return
      const nextDirection: FlowDirection = direction === "right" && width < PANEL_SM ? "down" : direction
      const nextColumns = nextDirection === "down" ? Math.max(1, Math.floor((width - 80) / 220)) : Number.POSITIVE_INFINITY
      setResponsiveLayout((current) =>
        current.direction === nextDirection && current.columns === nextColumns
          ? current
          : { direction: nextDirection, columns: nextColumns }
      )
      if (readOnly) {
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => void flowRef.current?.fitView({ padding: 0.22 }))
      }
    })
    observer.observe(box)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [direction, readOnly])

  /* Reflow editable nodes only when their responsive layout changes, retaining
     all authored data and any nodes/edges the reader added. */
  const previousLayout = React.useRef(layoutKey)
  React.useEffect(() => {
    if (previousLayout.current === layoutKey) return
    previousLayout.current = layoutKey
    if (!readOnly) {
      setNodes((current) => {
        const currentNodes: FlowchartNode[] = current.map((node) => ({
          id: node.id,
          label: node.data.label,
          shape: node.data.shape,
          tone: node.data.tone,
          hint: node.data.hint,
          updates: node.data.updates,
          result: node.data.result,
        }))
        const positions = new Map(
          layoutNodes(
            currentNodes,
            edgesRef.current.map((edge) => ({ from: edge.source, to: edge.target })),
            layoutDirection,
            columns
          ).map((node) => [node.id, node.position])
        )
        return current.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position, data: { ...node.data, direction: layoutDirection } }))
      })
    }
    let frame = 0
    frame = requestAnimationFrame(() => void flowRef.current?.fitView({ padding: 0.22 }))
    return () => cancelAnimationFrame(frame)
  }, [layoutKey, layoutDirection, columns, readOnly])

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
    <div
      ref={boxRef}
      className={`relative w-full min-w-0 self-stretch overflow-hidden bg-background ${fill ? "min-h-0 flex-1" : "h-[min(55vh,390px)] min-h-64 rounded-md"}`}
      aria-label="Interactive flowchart"
    >
      {/* Absolute, so the canvas has a definite size whichever way the box got its own. */}
      <div className="absolute inset-0">
      <ReactFlow
        nodes={liveNodes ?? nodes}
        edges={liveEdges ?? edges}
        nodeTypes={nodeTypes}
        onNodesChange={readOnly ? undefined : onNodesChange}
        onEdgesChange={readOnly ? undefined : onEdgesChange}
        onConnect={readOnly ? undefined : onConnect}
        onNodeClick={onNodeClick ? (_, node) => onNodeClick(node.id) : undefined}
        onInit={(instance) => (flowRef.current = instance)}
        fitView
        fitViewOptions={{ padding: 0.22 }}
        nodesConnectable={!readOnly}
        nodesDraggable={!readOnly}
        elementsSelectable={!readOnly || Boolean(onNodeClick)}
        deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
        defaultEdgeOptions={{ type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed } }}
        className="text-foreground"
      >
        <Background color="var(--border)" gap={18} size={1} />
        <Controls showInteractive={false} className="!overflow-hidden !rounded-md !border !border-border !bg-card !shadow-none [&>button]:!border-border [&>button]:!bg-card [&>button]:!fill-foreground [&>button:hover]:!bg-muted" />
      </ReactFlow>
      </div>
    </div>
  )
}
