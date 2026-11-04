import * as React from "react"
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  ControlButton,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type FitViewOptions,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react"
import { RotateCcw } from "lucide-react"

import { PANEL_SM, useCoarsePointer } from "@/hooks/use-device"
import { layoutFlow } from "@/lib/openui/flow-layout"

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
type Size = { width: number; height: number }

/* Fit, but never blow a three-node chart up past its natural size, and let a
   big one shrink far enough to be seen whole (React Flow stops at 0.5). */
const FIT: FitViewOptions = { padding: 0.12, maxZoom: 1, minZoom: 0.1 }
const BACK = { source: "back-s", target: "back-t" } as const

/* A first-frame guess at a node's size, replaced by the measured one as soon as
   React Flow reports it. Mirrors FlowNodeView's classes: 12px text, ~6.6px a
   character, 208px at most with 32px of padding. */
function estimate(node: FlowchartNode): Size {
  if (node.shape === "dot") return { width: 12, height: 12 }
  const text = (node.label ?? node.id).length * 6.6
  const width = Math.min(208, Math.max(112, text + 34))
  const lines =
    Math.max(1, Math.ceil(text / 176)) + (node.hint ? 1 : 0) + (node.updates?.length ?? 0) + (node.result ? 3 : 0)
  const height = Math.max(48, lines * 16 + 18)
  if (node.shape === "diamond") return { width: Math.min(240, width * 1.4), height: Math.max(80, height * 1.6) }
  if (node.shape === "circle") return { width: Math.max(96, width), height: Math.max(96, width) }
  return { width, height }
}

function uniqueNodes(nodes: FlowchartNode[]) {
  return [...new Map(nodes.map((node) => [node.id, node])).values()]
}

function toNodes(nodes: FlowchartNode[], positions: Map<string, { x: number; y: number }>, direction: FlowDirection): FlowNode[] {
  return nodes.map((node) => ({
    id: node.id,
    type: "flowNode",
    position: positions.get(node.id) ?? { x: 0, y: 0 },
    data: {
      label: node.label ?? node.id,
      shape: node.shape ?? "box",
      direction,
      tone: node.tone,
      hint: node.hint,
      updates: node.updates,
      result: node.result,
    },
  }))
}

/* A loop's return edge leaves and enters by the side, so it runs beside the
   chain it closes instead of back up through the middle of it. */
function toEdges(nodes: FlowchartNode[], edges: FlowchartEdge[], back: Set<number>): Edge[] {
  const ids = new Set(nodes.map((node) => node.id))
  return edges.flatMap((edge, index) =>
    ids.has(edge.from) && ids.has(edge.to)
      ? [
          {
            id: `edge-${index}`,
            source: edge.from,
            target: edge.to,
            ...(back.has(index) || edge.from === edge.to ? { sourceHandle: BACK.source, targetHandle: BACK.target } : {}),
            type: "smoothstep" as const,
            pathOptions: { borderRadius: 10, offset: 20 },
            label: edge.label,
            labelBgPadding: [6, 3] as [number, number],
            labelBgBorderRadius: 4,
            style: edge.dashed ? { strokeDasharray: "5 4" } : undefined,
          },
        ]
      : []
  )
}

const TONE_FRAME = {
  plain: "border-border",
  done: "border-success",
  running: "border-primary ring-2 ring-primary/20",
  failed: "border-destructive bg-destructive/5",
  pending: "border-dashed border-border text-muted-foreground",
  selected: "border-primary ring-2 ring-primary/25",
}
const TONE_STROKE = {
  plain: "stroke-border",
  done: "stroke-success",
  running: "stroke-primary",
  failed: "stroke-destructive",
  pending: "stroke-border",
  selected: "stroke-primary",
}

function FlowNodeView({ data, selected, isConnectable }: NodeProps<FlowNode>) {
  const horizontal = data.direction === "right"
  const tone = selected ? "selected" : (data.tone ?? "plain")
  /* Hidden until wanted: shown on hover, and on a selected node so a finger
     that tapped it has something to drag from. */
  const handle = `!size-2.5 !border-2 !border-background !bg-primary transition-opacity ${
    isConnectable ? (selected ? "opacity-100" : "opacity-0 group-hover:opacity-100") : "!opacity-0"
  }`
  const handles = (
    <>
      <Handle type="target" position={horizontal ? Position.Left : Position.Top} className={handle} />
      <Handle type="source" position={horizontal ? Position.Right : Position.Bottom} className={handle} />
      <Handle id={BACK.target} type="target" position={horizontal ? Position.Bottom : Position.Right} isConnectable={false} className="!opacity-0" />
      <Handle id={BACK.source} type="source" position={horizontal ? Position.Bottom : Position.Right} isConnectable={false} className="!opacity-0" />
    </>
  )

  if (data.shape === "dot") {
    return (
      <div className={`size-3 rounded-full ${selected ? "bg-primary" : "bg-muted-foreground/40"}`}>
        {handles}
      </div>
    )
  }

  const body = (
    <span className="relative min-w-0 [overflow-wrap:anywhere]">
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
  )

  /* A diamond is drawn, not clipped: clip-path cut the border off with the corners. */
  if (data.shape === "diamond") {
    return (
      <div className="group relative flex min-h-20 min-w-36 max-w-60 items-center justify-center px-10 py-6 text-center text-xs leading-snug text-card-foreground">
        <svg className="absolute inset-0 size-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          <polygon
            points="50,0 100,50 50,100 0,50"
            vectorEffect="non-scaling-stroke"
            strokeWidth={selected || data.tone === "running" ? 2 : 1}
            strokeDasharray={tone === "pending" ? "4 3" : undefined}
            className={`fill-card ${TONE_STROKE[tone]}`}
          />
        </svg>
        {body}
        {handles}
      </div>
    )
  }

  const shape = {
    box: "rounded-lg min-w-28 max-w-52",
    round: "rounded-full min-w-28 max-w-52 px-5",
    circle: "aspect-square min-w-24 max-w-40 rounded-full",
  }[data.shape]
  return (
    <div
      className={`group relative flex min-h-12 items-center justify-center border bg-card px-4 py-2 text-center text-xs leading-snug text-card-foreground ${shape} ${TONE_FRAME[tone]}`}
    >
      {body}
      {handles}
    </div>
  )
}

const nodeTypes = { flowNode: FlowNodeView }

/* React Flow's own palette is light-only; point it at the theme's tokens. */
const THEME = {
  "--xy-edge-stroke": "var(--muted-foreground)",
  "--xy-edge-stroke-selected": "var(--primary)",
  "--xy-edge-label-background-color": "var(--background)",
  "--xy-edge-label-color": "var(--muted-foreground)",
  "--xy-connectionline-stroke": "var(--primary)",
} as React.CSSProperties

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
  /* Inline under a finger the figure is a picture the transcript scrolls past:
     React Flow's pane is `touch-action: none`, so an interactive one trapped
     the page. The full-screen reader is where it is edited. */
  const coarse = useCoarsePointer()
  const still = !fill && coarse
  const editable = !readOnly && !still

  /* Width belongs to the chart's containing panel, not the window. */
  const boxRef = React.useRef<HTMLDivElement>(null)
  const [width, setWidth] = React.useState(0)
  React.useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0)
      if (next > 0) setWidth(next)
    })
    observer.observe(box)
    return () => observer.disconnect()
  }, [])
  const layoutDirection: FlowDirection = direction === "right" && width > 0 && width < PANEL_SM ? "down" : direction
  // ponytail: wraps on an average node width; wrap on measured widths if rows overflow.
  const columns = layoutDirection === "down" && width > 0 ? Math.max(1, Math.floor((width - 48) / 200)) : Number.POSITIVE_INFINITY

  /* The inputs by content, not identity: a parse makes new arrays every chunk. */
  const signature = JSON.stringify([inputNodes, inputEdges])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const graph = React.useMemo(() => ({ nodes: uniqueNodes(inputNodes), edges: inputEdges }), [signature])

  const [sizes, setSizes] = React.useState<Record<string, Size>>({})
  const layout = React.useMemo(
    () =>
      layoutFlow(
        graph.nodes.map((node) => ({ id: node.id, ...(sizes[node.id] ?? estimate(node)) })),
        graph.edges,
        layoutDirection,
        columns
      ),
    [graph, sizes, layoutDirection, columns]
  )

  const [nodes, setNodes] = React.useState<FlowNode[]>(() => toNodes(graph.nodes, layout.positions, layoutDirection))
  const [edges, setEdges] = React.useState<Edge[]>(() => toEdges(graph.nodes, graph.edges, layout.back))
  const [resetTick, setResetTick] = React.useState(0)
  const dragged = React.useRef(new Set<string>())

  /* New inputs (a streamed chunk) or Reset rebuild the sketch in place, where
     a remount per chunk used to flash the whole canvas. A measurement or a
     panel resize only moves the nodes nobody has dragged. */
  const built = React.useRef({ graph, resetTick })
  React.useEffect(() => {
    if (readOnly) return
    const rebuild = built.current.graph !== graph || built.current.resetTick !== resetTick
    built.current = { graph, resetTick }
    if (rebuild) {
      dragged.current.clear()
      setEdges(toEdges(graph.nodes, graph.edges, layout.back))
    }
    setNodes((current) => {
      if (rebuild) {
        const prev = new Map(current.map((node) => [node.id, node]))
        return toNodes(graph.nodes, layout.positions, layoutDirection).map((node) => ({ ...node, measured: prev.get(node.id)?.measured }))
      }
      return current.map((node) => ({
        ...node,
        position: dragged.current.has(node.id) ? node.position : (layout.positions.get(node.id) ?? node.position),
        data: node.data.direction === layoutDirection ? node.data : { ...node.data, direction: layoutDirection },
      }))
    })
  }, [readOnly, graph, resetTick, layout, layoutDirection])

  // Read-only: derived every render, so a live run's states flow straight in.
  const liveNodes = React.useMemo(
    () =>
      readOnly
        ? toNodes(graph.nodes, layout.positions, layoutDirection).map((node) => ({ ...node, selected: node.id === selectedId }))
        : null,
    [readOnly, graph, layout, layoutDirection, selectedId]
  )
  const liveEdges = React.useMemo(
    () => (readOnly ? toEdges(graph.nodes, graph.edges, layout.back) : null),
    [readOnly, graph, layout.back]
  )

  const recordSizes = React.useCallback((changes: NodeChange<FlowNode>[]) => {
    setSizes((current) => {
      let next = current
      for (const change of changes) {
        if (change.type !== "dimensions" || !change.dimensions) continue
        const { width, height } = change.dimensions
        const old = current[change.id]
        if (old && Math.abs(old.width - width) < 1 && Math.abs(old.height - height) < 1) continue
        if (next === current) next = { ...current }
        next[change.id] = { width, height }
      }
      return next
    })
  }, [])

  const onNodesChange = React.useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      recordSizes(changes)
      if (readOnly) return
      for (const change of changes) if (change.type === "position" && change.dragging) dragged.current.add(change.id)
      setNodes((current) => applyNodeChanges(changes, current))
      const removed = new Set(changes.filter((change) => change.type === "remove").map((change) => change.id))
      if (removed.size) {
        setEdges((current) => current.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target)))
      }
    },
    [readOnly, recordSizes]
  )

  const onEdgesChange = React.useCallback((changes: EdgeChange[]) => {
    setEdges((current) => applyEdgeChanges(changes, current))
  }, [])

  const onConnect = React.useCallback((connection: Connection) => {
    setEdges((current) => addEdge(connection, current))
  }, [])

  /* Inline, the box is as tall as the drawing needs at the zoom that fits its
     width — a three-node chart no longer sits in 390px of empty canvas. */
  const pad = 32
  const scale = width > 0 && layout.width > 0 ? Math.min(1, (width - pad * 2) / layout.width) : 1
  const height = Math.round(Math.min(480, Math.max(200, layout.height * scale + pad * 2)))

  /* Refit when what is drawn changes shape — not on every live update, which
     would yank a reader's zoom while a run streams in. */
  const flowRef = React.useRef<ReactFlowInstance<FlowNode, Edge> | null>(null)
  const measured = graph.nodes.every((node) => sizes[node.id])
  const fitKey = `${layoutDirection}|${columns}|${width}|${fill ? 0 : height}|${measured}|${resetTick}|${graph.nodes.map((node) => node.id).join(",")}`
  React.useEffect(() => {
    const frame = requestAnimationFrame(() => void flowRef.current?.fitView(FIT))
    return () => cancelAnimationFrame(frame)
  }, [fitKey])

  return (
    <div
      ref={boxRef}
      className={`relative w-full min-w-0 self-stretch overflow-hidden bg-background ${fill ? "min-h-0 flex-1" : "rounded-md"}`}
      style={fill ? THEME : { ...THEME, height }}
      aria-label="Interactive flowchart"
    >
      {/* Absolute, so the canvas has a definite size whichever way the box got its own. */}
      <div className={`absolute inset-0 ${still ? "[&_.react-flow__pane]:touch-pan-y" : ""}`}>
        <ReactFlow
          nodes={liveNodes ?? nodes}
          edges={liveEdges ?? edges}
          nodeTypes={nodeTypes}
          nodeOrigin={[0.5, 0.5]}
          onNodesChange={onNodesChange}
          onEdgesChange={editable ? onEdgesChange : undefined}
          onConnect={editable ? onConnect : undefined}
          onNodeClick={onNodeClick ? (_, node) => onNodeClick(node.id) : undefined}
          onInit={(instance) => (flowRef.current = instance)}
          fitView
          fitViewOptions={FIT}
          minZoom={0.1}
          maxZoom={2}
          nodesConnectable={editable}
          nodesDraggable={editable}
          elementsSelectable={editable || Boolean(onNodeClick)}
          deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
          /* Inline, the wheel scrolls the transcript; zoom is the controls or a pinch. */
          zoomOnScroll={fill}
          preventScrolling={fill}
          zoomOnPinch={!still}
          zoomOnDoubleClick={fill}
          panOnDrag={!still}
          defaultMarkerColor="var(--muted-foreground)"
          defaultEdgeOptions={{
            type: "smoothstep",
            markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
          }}
          className="text-foreground"
        >
          <Background color="var(--border)" gap={18} size={1} />
          {!still && (
            <Controls
              showInteractive={false}
              fitViewOptions={FIT}
              className="!overflow-hidden !rounded-md !border !border-border !bg-card !shadow-none [&>button]:!border-border [&>button]:!bg-card [&>button]:!fill-foreground [&>button:hover]:!bg-muted"
            >
              {editable && (
                <ControlButton onClick={() => setResetTick((tick) => tick + 1)} title="Reset layout">
                  <RotateCcw className="!fill-none" />
                </ControlButton>
              )}
            </Controls>
          )}
        </ReactFlow>
      </div>
    </div>
  )
}
