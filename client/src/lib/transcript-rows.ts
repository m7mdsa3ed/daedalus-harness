/* ── Rows of a transcript ──
   The store keeps a thread FLAT: every item in arrival order, whether the
   thread's own or a subagent's (`ToolItem.parentId`). What the screen shows is
   a tree — a subagent's work under the step that launched it — and, when the
   option is on, runs of consecutive tool steps folded into one row. Both are
   ways of looking at the items, derived entirely from what is already there,
   so both are computed here rather than in the reducer: toggling either must
   not change a single item, and an item that did not change keeps its
   identity through the transform, which is what lets the row memos skip it.

   Its own module rather than a corner of thread-view because the rendering is
   recursive: a subagent step draws its children through the same row views
   that draw the top level (thread-items), and thread-view already imports
   those — the types have to live somewhere both can reach without a cycle. */
import type { SubagentItem, ThreadItem, ToolItem } from "./store"
import { extractSubagent, isSubagentLaunch, subagentItemId } from "./tools"

/** A run of consecutive tool steps, folded into one row (view-options). */
export interface ToolRunGroup {
  kind: "run"
  id: string
  items: ToolItem[]
}

/**
 * A subagent and everything it did. `head` is what announced it: the Task
 * tool call that launched it (Claude Code, OpenCode), a Codex `spawnAgent`
 * or "Start subagent" row, or the session the agent announced outright (the
 * ACP subagent RFD's `SubagentItem`). `children` are rows again — a child's
 * own steps can be grouped, and a child can have subagents of its own.
 */
export interface SubagentGroup {
  kind: "subagent-group"
  id: string
  head: ToolItem | SubagentItem
  children: Row[]
}

export type Row = ThreadItem | ToolRunGroup | SubagentGroup

/** The id of the item a row stands for — for keys, scroll anchors and the
    "where does the Sources strip go" lookup, which is keyed by item id. A
    run's is its last step's, since that is the item that ends the turn. */
export function rowTailId(row: Row): string {
  if (row.kind === "run") return row.items[row.items.length - 1].id
  return row.id
}

/**
 * The transcript as rows: subagents nested, then (optionally) runs grouped.
 * Nesting does not depend on the grouping option — a subagent's rail is not
 * a preference, it is where its steps belong.
 */
export function buildRows(items: ThreadItem[], groupTools: boolean): Row[] {
  const nested = nestSubagents(items, groupTools)
  return groupTools ? groupToolRuns(nested) : nested
}

/**
 * Fold every item that has an owner under that owner.
 *
 * Owners are keyed on the FULL id set before anything is placed, because a
 * child can precede its parent in the flat list — Claude Code attributes a
 * child's tool call to its Task best-effort, sometimes on a later update, and
 * the Task's own `tool_call` can land after a child that already knew. An
 * item whose owner is not in the list at all is an orphan and stays where it
 * is: flat, rather than dropped or wrapped in a head nobody announced.
 *
 * A subagent group sits at its head's position. A head is any item that has
 * children, plus any launch that has none yet (a Task the moment it starts
 * is a subagent step with an empty rail, not a generic tool row) and every
 * RFD session item, which is a subagent by definition.
 */
function nestSubagents(items: ThreadItem[], groupTools: boolean): Row[] {
  const heads = new Set<string>()
  for (const item of items) {
    if (item.kind === "tool" || item.kind === "subagent") heads.add(item.id)
  }
  const byParent = new Map<string, ThreadItem[]>()
  const claimed = new Set<ThreadItem>()
  const claim = (item: ThreadItem, owner: string) => {
    if (owner === item.id || claimed.has(item)) return
    const list = byParent.get(owner)
    if (list) list.push(item)
    else byParent.set(owner, [item])
    claimed.add(item)
  }
  for (const item of items) {
    if (item.parentId && heads.has(item.parentId)) claim(item, item.parentId)
  }
  adoptProjectedChildren(items, heads, byParent, claimed)
  groupCodexLifecycle(items, byParent, claimed)

  const build = (list: ThreadItem[], ancestry: Set<string>): Row[] => {
    const rows: Row[] = []
    for (const item of list) {
      // At the top level a claimed item is drawn under its owner, not here.
      if (list === items && claimed.has(item)) continue
      const isHead =
        item.kind === "subagent" ||
        (item.kind === "tool" && (byParent.has(item.id) || isSubagentLaunch(item)))
      if (!isHead || ancestry.has(item.id)) {
        rows.push(item)
        continue
      }
      const kids = byParent.get(item.id) ?? []
      const next = new Set(ancestry)
      next.add(item.id)
      const children = build(kids, next)
      rows.push({
        kind: "subagent-group",
        id: item.id,
        head: item as ToolItem | SubagentItem,
        children: groupTools ? groupToolRuns(children) : children,
      })
    }
    return rows
  }
  return build(items, new Set())
}

/**
 * OpenCode names a child session in `_meta` (`subagent:<sessionId>` owners)
 * but nothing announces it — no spawn update, no `SubagentItem` — until the
 * `task` tool that ran it completes and reports the session id in its output.
 * When it does, the children it accumulated move under it. Until then they
 * are orphans (their owner is not a head) and stay flat.
 */
function adoptProjectedChildren(
  items: ThreadItem[],
  heads: Set<string>,
  byParent: Map<string, ThreadItem[]>,
  claimed: Set<ThreadItem>
): void {
  for (const item of items) {
    if (item.kind !== "tool") continue
    const sessionId = extractSubagent(item)?.sessionId
    if (!sessionId) continue
    const owner = subagentItemId(sessionId)
    if (heads.has(owner)) continue
    for (const child of items) {
      if (child.parentId === owner && child !== item && !claimed.has(child)) {
        const list = byParent.get(item.id)
        if (list) list.push(child)
        else byParent.set(item.id, [child])
        claimed.add(child)
      }
    }
  }
}

/**
 * Codex without the RFD describes a subagent as a scatter of top-level tool
 * calls about a thread id: the model's `spawnAgent`/`sendInput`/`closeAgent`
 * calls (collaboration rows, naming the child in `receiverThreadIds` once it
 * exists) and the runtime's "Start/Interact with/Interrupt subagent x"
 * lifecycle rows (naming it in `threadId`). Best-effort grouping: the
 * `spawnAgent` is the head when there is one, else the "Start" row; every
 * other row that names the same thread goes under it. A spawn that never
 * learns its child's id claims the first unclaimed "Start" after it, which is
 * the order Codex emits them in. Rows Claude Code or the RFD already
 * attributed are left alone.
 */
function groupCodexLifecycle(
  items: ThreadItem[],
  byParent: Map<string, ThreadItem[]>,
  claimed: Set<ThreadItem>
): void {
  const headByThread = new Map<string, string>()
  const starts: { item: ToolItem; threadId: string }[] = []
  const spawns: ToolItem[] = []
  for (const item of items) {
    if (item.kind !== "tool" || item.parentId || claimed.has(item)) continue
    const call = extractSubagent(item)
    if (!call) continue
    if (call.tool === "spawnAgent") {
      spawns.push(item)
      for (const id of call.receiverThreadIds ?? []) headByThread.set(id, item.id)
    } else if (call.started && call.threadId) {
      starts.push({ item, threadId: call.threadId })
    }
  }
  if (starts.length === 0 && spawns.length === 0) return
  // A spawn with no receiver on record takes the next unclaimed start.
  const taken = new Set<string>()
  for (const spawn of spawns) {
    if ([...headByThread.values()].includes(spawn.id)) continue
    const after = items.indexOf(spawn)
    const start = starts.find(
      (s) => !taken.has(s.threadId) && !headByThread.has(s.threadId) && items.indexOf(s.item) > after
    )
    if (start) {
      headByThread.set(start.threadId, spawn.id)
      taken.add(start.threadId)
    }
  }
  for (const s of starts) if (!headByThread.has(s.threadId)) headByThread.set(s.threadId, s.item.id)

  for (const item of items) {
    if (item.kind !== "tool" || item.parentId || claimed.has(item)) continue
    const call = extractSubagent(item)
    if (!call) continue
    const thread =
      call.tool !== undefined && call.tool !== "spawnAgent"
        ? call.receiverThreadIds?.find((id) => headByThread.has(id))
        : call.threadId
    const head = thread ? headByThread.get(thread) : undefined
    if (!head || head === item.id) continue
    const list = byParent.get(head)
    if (list) list.push(item)
    else byParent.set(head, [item])
    claimed.add(item)
  }
}

/**
 * Consecutive tool steps become one `ToolRunGroup`; everything else passes
 * through untouched. Runs of one stay ungrouped — a lone step wrapped in a
 * "1 step" disclosure is strictly worse than the step. A subagent group
 * breaks a run like any other non-tool row: its rail inside a run's rail
 * would be two rails for one thing.
 */
export function groupToolRuns(rows: Row[]): Row[] {
  const out: Row[] = []
  let run: ToolItem[] = []

  const flush = () => {
    if (run.length > 1) out.push({ kind: "run", id: `tools-${run[0].id}`, items: run })
    else out.push(...run)
    run = []
  }

  for (const row of rows) {
    if (row.kind === "tool") run.push(row)
    else {
      flush()
      out.push(row)
    }
  }
  flush()
  return out
}
