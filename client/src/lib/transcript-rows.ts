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
import type { SubagentItem, TextItem, ThreadItem, ToolItem } from "./store"
import { extractSubagent, isSubagentLaunch, subagentItemId } from "./tools"
import type { WorkflowPlanPhase } from "./tools"

/** A run of consecutive steps, folded into one row (view-options). The
 *  thoughts woven between the calls ride inside it: the reasoning belongs to
 *  the steps around it, so folding the run folds the thinking with it. */
export interface ToolRunGroup {
  kind: "run"
  id: string
  items: (ToolItem | TextItem)[]
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
  /** Whether this subagent is at work right now — the one reading of it, so
      the rail's shimmer, the count above the composer and the working line
      all agree. See `subagentActive`. */
  active: boolean
  children: Row[]
}

/**
 * A harness workflow run: every step the server spawned under one `runId`,
 * folded into one row. The steps are the same `SubagentGroup`s they would
 * have been on their own — the fold moves them, it does not reshape them —
 * so a step's rail, its `active` flag and its "Open thread" link all keep
 * working. Sits where the run's first step arrived; a second run is a
 * second group.
 */
export interface WorkflowGroup {
  kind: "workflow-group"
  /** `workflow:<runId>`. */
  id: string
  /** The workflow's name, from the server's `_meta` stamp. */
  name: string
  steps: SubagentGroup[]
  /** The definition's own shape — phases and the step names in them — when the
      server sent it, so the card can draw the steps that have not spawned yet.
      Taken from the first step that carries one: every spawn repeats it. */
  plan?: WorkflowPlanPhase[]
}

/**
 * N subagents the agent fired side by side, folded into one row.
 *
 * A runtime has no word for "these three Tasks are one act" — Claude Code
 * simply emits the launches back to back — so what a transcript showed was N
 * separate step rows, each folded, each with its own rail, and no reading of
 * the whole: how many are still working, which one failed, what is being
 * written right now. That is the same question a workflow run answers, and it
 * is answered by the same card (`RunCard` in thread-items), so the fold is
 * shaped like `mergeWorkflowRuns`': the steps are the very `SubagentGroup`s
 * they would have been on their own, moved rather than reshaped, so a step's
 * rail, its `active` flag and its report all keep working.
 *
 * Adjacency is the whole rule — a run of two or more top-level subagent groups
 * with nothing between them, exactly as `groupToolRuns` reads a run of tool
 * steps. Prose, a plan or a tool call between two launches means the agent did
 * something in between, which is a sequence and not a batch; a lone subagent
 * stays the step row it was, since a card around one worker says nothing the
 * row did not.
 */
export interface SubagentBatch {
  kind: "subagent-batch"
  /** `batch:<first step's id>`. */
  id: string
  steps: SubagentGroup[]
}

export type Row = ThreadItem | ToolRunGroup | SubagentGroup | WorkflowGroup | SubagentBatch

/** The id of the item a row stands for — for keys, scroll anchors and the
    "where does the Sources strip go" lookup, which is keyed by item id. A
    run's is its last step's, since that is the item that ends the turn; a
    workflow's is its last step's for the same reason. */
export function rowTailId(row: Row): string {
  if (row.kind === "run") return row.items[row.items.length - 1].id
  if (row.kind === "workflow-group" || row.kind === "subagent-batch")
    return rowTailId(row.steps[row.steps.length - 1])
  return row.id
}

/**
 * Answers only (view-options): the conversation with the work taken out.
 *
 * Kept: the user's messages, the agent's prose, the notices that carry an
 * interrupted turn's Continue button, and errors — a failure hidden reads as
 * an answer that never came, which is the one thing this option must not do.
 * Dropped: thoughts, tool calls, plans, compactions, subagent sessions.
 *
 * A `parentId` is dropped whatever its kind: a subagent's own prose is the
 * work, not the thread's answer, and its head is gone anyway — leaving it in
 * would put a worker's running commentary in the flow as if the thread had
 * said it. Filtering the ITEMS rather than the rows is the point: nesting and
 * grouping then have nothing to build out of, so nothing downstream — the
 * rail, the memos, the row views — learns a word about this option.
 */
export function isAnswerItem(item: ThreadItem): boolean {
  if (item.parentId) return false
  return (
    item.kind === "user" || item.kind === "agent" || item.kind === "notice" || item.kind === "error"
  )
}

/**
 * The transcript as rows: subagents nested, then (optionally) runs grouped.
 * Nesting does not depend on the grouping option — a subagent's rail is not
 * a preference, it is where its steps belong.
 */
export function buildRows(items: ThreadItem[], groupTools: boolean, turnActive = false): Row[] {
  const nested = mergeSubagentBatches(mergeWorkflowRuns(nestSubagents(items, groupTools, turnActive)))
  return groupTools ? groupToolRuns(nested) : nested
}

/**
 * Fold the steps of a workflow run into one `WorkflowGroup`. A step is a
 * top-level subagent group whose head session the server stamped with
 * `_meta.daedalus.workflow` (read by `lib/tools.workflowInfoOf` into
 * `SubagentItem.workflow`); an ordinary subagent carries no stamp and passes
 * through untouched. Runs merge by `runId` — the group sits where the run's
 * first step arrived, and steps keep arrival order, which is the runner's
 * schedule order. Runs after nesting so a step's own children are already
 * under it, and before `groupToolRuns`, which passes any non-tool row
 * through whole.
 */
function mergeWorkflowRuns(rows: Row[]): Row[] {
  const runs = new Map<string, WorkflowGroup>()
  const out: Row[] = []
  for (const row of rows) {
    if (row.kind !== "subagent-group" || row.head.kind !== "subagent" || !row.head.workflow) {
      out.push(row)
      continue
    }
    const wf = row.head.workflow
    const run = runs.get(wf.runId)
    if (run) {
      run.steps.push(row)
      run.plan ??= wf.plan
    } else {
      const group: WorkflowGroup = { kind: "workflow-group", id: `workflow:${wf.runId}`, name: wf.name, steps: [row], plan: wf.plan }
      runs.set(wf.runId, group)
      out.push(group)
    }
  }
  return out
}

/**
 * Fold a run of consecutive top-level subagent groups into one `SubagentBatch`
 * — see the interface for why adjacency is the rule and why a run of one is
 * left alone.
 *
 * After `mergeWorkflowRuns`, so a workflow's steps are already inside their
 * own group and can never be swept into a batch, and before `groupToolRuns`,
 * which passes any non-tool row through whole. Top level only: a worker's own
 * workers are read on its rail, where a card inside a rail inside a card is
 * exactly the nesting the run dialog exists to avoid.
 */
function mergeSubagentBatches(rows: Row[]): Row[] {
  const out: Row[] = []
  let run: SubagentGroup[] = []

  const flush = () => {
    if (run.length > 1) out.push({ kind: "subagent-batch", id: `batch:${run[0].id}`, steps: run })
    else out.push(...run)
    run = []
  }

  for (const row of rows) {
    if (row.kind === "subagent-group") run.push(row)
    else {
      flush()
      out.push(row)
    }
  }
  flush()
  return out
}

/** Every subagent at work, at any depth — a worker's worker is a worker. */
export function activeSubagents(rows: Row[]): SubagentGroup[] {
  const out: SubagentGroup[] = []
  for (const row of rows) {
    if (row.kind === "workflow-group" || row.kind === "subagent-batch") {
      // A run's steps are workers like any other; the run itself is not one.
      out.push(...activeSubagents(row.steps))
      continue
    }
    if (row.kind !== "subagent-group") continue
    if (row.active) out.push(row)
    out.push(...activeSubagents(row.children))
  }
  return out
}

const inFlight = (item: ThreadItem): boolean =>
  item.kind === "tool"
    ? item.status === "in_progress" || item.status === "pending"
    : item.kind === "subagent" && item.state === "running"

/**
 * Is this subagent still at work? Read off the transcript, because the
 * runtimes give the client no one signal for it:
 *
 * - Nothing runs outside a turn. Turn end is the one boundary every runtime
 *   shares (Claude Code holds the turn open until its background subagents
 *   settle), so an archived thread, or one whose turn ended, has no workers.
 * - A worker whose *child* is at work is at work — a nested group that is
 *   active, or a step under it still in flight.
 * - An RFD session says so itself: `state: "running"` until the terminal
 *   `subagent_state_update`.
 * - A launch call that is still open (a sync `Task`, OpenCode's `task`) is a
 *   child still working; one that failed is over; one that completed is over
 *   too — its report is in the result — *unless it was a background launch*.
 *   Claude Code's background `Task` answers "started" at once and the child's
 *   steps keep arriving under it, and the runtime never says when the child
 *   finishes (the CLI's task-notification never crosses ACP). What does
 *   cross is its consequence: the parent is idle while it waits, and only
 *   the notification wakes it — so the owner producing anything *after* the
 *   child's last word is the child's report having landed. Until the owner
 *   speaks, the child is running; a child whose next step arrives after all
 *   flips straight back, since its last word moves past the owner's.
 */
function subagentActive(
  head: ToolItem | SubagentItem,
  kids: ThreadItem[],
  children: Row[],
  items: ThreadItem[],
  indexOf: Map<ThreadItem, number>,
  turnActive: boolean
): boolean {
  if (!turnActive) return false
  if (kids.some(inFlight)) return true
  if (children.some((row) => row.kind === "subagent-group" && row.active)) return true
  if (head.kind === "subagent") return head.state === "running"
  if (inFlight(head)) return true
  if (head.status !== "completed") return false
  if (!extractSubagent(head)?.background) return false
  const last = kids.length > 0 ? Math.max(...kids.map((kid) => indexOf.get(kid) ?? -1)) : indexOf.get(head) ?? -1
  const owner = head.parentId
  for (let i = last + 1; i < items.length; i++) {
    const item = items[i]
    if (item.parentId !== owner) continue
    if (item.kind === "agent" || item.kind === "thought" || item.kind === "tool") return false
  }
  return true
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
function nestSubagents(items: ThreadItem[], groupTools: boolean, turnActive: boolean): Row[] {
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
  const indexOf = new Map<ThreadItem, number>()
  items.forEach((item, index) => indexOf.set(item, index))

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
      const head = item as ToolItem | SubagentItem
      rows.push({
        kind: "subagent-group",
        id: item.id,
        head,
        active: subagentActive(head, kids, children, items, indexOf, turnActive),
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
  // Positions, once: `items.indexOf` inside the find below was O(n) per
  // candidate per spawn — O(n²) on a transcript with many lifecycle rows.
  const indexOf = new Map<ThreadItem, number>()
  items.forEach((item, index) => indexOf.set(item, index))
  // A spawn with no receiver on record takes the next unclaimed start.
  const taken = new Set<string>()
  for (const spawn of spawns) {
    if ([...headByThread.values()].includes(spawn.id)) continue
    const after = indexOf.get(spawn)!
    const start = starts.find(
      (s) => !taken.has(s.threadId) && !headByThread.has(s.threadId) && indexOf.get(s.item)! > after
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
 * Consecutive tool steps — and the thoughts woven between them — become one
 * `ToolRunGroup`; everything else passes through untouched. A thought is the
 * reasoning behind the steps around it, so it belongs inside the group:
 * toggling the group shut hides the thinking too. A run still needs a tool —
 * two thoughts alone are two standalone rows, not a "group" with nothing in
 * it — and runs of one stay ungrouped, a lone step wrapped in a "1 step"
 * disclosure is strictly worse than the step. A subagent group breaks a run
 * like any other non-tool row: its rail inside a run's rail would be two
 * rails for one thing.
 */
export function groupToolRuns(rows: Row[]): Row[] {
  const out: Row[] = []
  let run: (ToolItem | TextItem)[] = []

  const flush = () => {
    if (run.length > 1 && run.some((item) => item.kind === "tool"))
      out.push({ kind: "run", id: `tools-${run[0].id}`, items: run })
    else out.push(...run)
    run = []
  }

  for (const row of rows) {
    if (row.kind === "tool" || row.kind === "thought") run.push(row)
    else {
      flush()
      out.push(row)
    }
  }
  flush()
  return out
}
