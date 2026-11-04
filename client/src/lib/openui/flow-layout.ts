/* A layered layout for a flowchart, pure so it can be checked under Node.
   Sugiyama, cut down: break cycles by reversing DFS back edges (a retry loop
   used to strand everything after it on one row), rank by longest path, order
   each rank by barycenter sweeps to cut crossings, then place every node by its
   own measured size — never a fixed grid that a tall node overlaps. Positions
   are node centres (the caller sets React Flow's `nodeOrigin` to [0.5, 0.5]). */

export type LayoutNode = { id: string; width: number; height: number }
export type LayoutEdge = { from: string; to: string }
export type Point = { x: number; y: number }

const RANK_GAP = { down: 64, right: 88 } as const
const NODE_GAP = 40
const SWEEPS = 8

export function layoutFlow(
  input: LayoutNode[],
  edges: LayoutEdge[],
  direction: "down" | "right",
  /** Down only: the most nodes a row holds before a rank wraps onto another. */
  columns = Number.POSITIVE_INFINITY
): { positions: Map<string, Point>; width: number; height: number; back: Set<number> } {
  const nodes = [...new Map(input.map((n) => [n.id, n])).values()]
  const index = new Map(nodes.map((n, i) => [n.id, i]))
  const out = nodes.map(() => [] as number[])
  const edgeIdx = nodes.map(() => [] as number[]) // edge indices leaving each node
  edges.forEach((e, k) => {
    const a = index.get(e.from)
    const b = index.get(e.to)
    if (a === undefined || b === undefined || a === b) return
    out[a].push(b)
    edgeIdx[a].push(k)
  })

  /* Back edges by DFS, roots (no incoming) first so the reading order wins. */
  const hasIn = new Set(out.flat())
  const order = [...nodes.keys()].sort((a, b) => Number(hasIn.has(a)) - Number(hasIn.has(b)) || a - b)
  const state = new Uint8Array(nodes.length) // 0 new, 1 on stack, 2 done
  const back = new Set<number>()
  const visit = (u: number) => {
    state[u] = 1
    out[u].forEach((v, j) => {
      if (state[v] === 1) back.add(edgeIdx[u][j])
      else if (state[v] === 0) visit(v)
    })
    state[u] = 2
  }
  for (const u of order) if (!state[u]) visit(u)

  /* The DAG: back edges reversed, so a loop's return still pulls ranks apart. */
  const succ = nodes.map(() => [] as number[])
  const pred = nodes.map(() => [] as number[])
  out.forEach((targets, u) =>
    targets.forEach((v, j) => {
      const [a, b] = back.has(edgeIdx[u][j]) ? [v, u] : [u, v]
      succ[a].push(b)
      pred[b].push(a)
    })
  )

  /* Longest path, Kahn over the now-acyclic graph. */
  const rank = new Array<number>(nodes.length).fill(0)
  const left = pred.map((p) => p.length)
  const queue = [...nodes.keys()].filter((i) => left[i] === 0)
  for (let c = 0; c < queue.length; c++) {
    const u = queue[c]
    for (const v of succ[u]) {
      rank[v] = Math.max(rank[v], rank[u] + 1)
      if (--left[v] === 0) queue.push(v)
    }
  }

  const ranks: number[][] = []
  nodes.forEach((_, i) => (ranks[rank[i]] ??= []).push(i))
  const layers = ranks.filter(Boolean)

  /* Barycenter: alternate sweeps, each rank sorted by its neighbours' mean slot.
     ponytail: no transpose pass; add one if crossings still show on real charts. */
  const slot = new Array<number>(nodes.length)
  const reslot = () => layers.forEach((layer) => layer.forEach((n, i) => (slot[n] = i / Math.max(1, layer.length - 1))))
  reslot()
  for (let s = 0; s < SWEEPS; s++) {
    const down = s % 2 === 0
    const seq = down ? layers.slice(1) : layers.slice(0, -1).reverse()
    for (const layer of seq) {
      const bary = new Map(
        layer.map((n) => {
          const near = down ? pred[n] : succ[n]
          return [n, near.length ? near.reduce((t, m) => t + slot[m], 0) / near.length : slot[n]]
        })
      )
      layer.sort((a, b) => bary.get(a)! - bary.get(b)!)
      layer.forEach((n, i) => (slot[n] = i / Math.max(1, layer.length - 1)))
    }
  }

  /* A rank wider than the panel continues on extra rows (down only). */
  const cap = direction === "down" ? Math.max(1, Math.floor(columns)) : Number.POSITIVE_INFINITY
  const rows = layers.flatMap((layer) => {
    const chunks: number[][] = []
    for (let i = 0; i < layer.length; i += cap) chunks.push(layer.slice(i, i + cap))
    return chunks
  })

  const along = (n: LayoutNode) => (direction === "down" ? n.height : n.width)
  const across = (n: LayoutNode) => (direction === "down" ? n.width : n.height)
  const positions = new Map<string, Point>()
  let cursor = 0
  let spread = 0
  for (const row of rows) {
    const thick = Math.max(...row.map((i) => along(nodes[i])))
    const total = row.reduce((t, i) => t + across(nodes[i]), 0) + NODE_GAP * (row.length - 1)
    spread = Math.max(spread, total)
    let at = -total / 2
    for (const i of row) {
      const a = cursor + thick / 2
      const b = at + across(nodes[i]) / 2
      positions.set(nodes[i].id, direction === "down" ? { x: b, y: a } : { x: a, y: b })
      at += across(nodes[i]) + NODE_GAP
    }
    cursor += thick + RANK_GAP[direction]
  }
  const length = Math.max(0, cursor - RANK_GAP[direction])
  return direction === "down"
    ? { positions, width: spread, height: length, back }
    : { positions, width: length, height: spread, back }
}
