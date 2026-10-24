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
import type { AsyncTaskItem, ShellItem, SubagentItem, TextItem, ThreadItem, ToolItem } from "./store"
import {
  ASK_AGENT,
  extractBackgroundTask,
  extractMcpCall,
  extractSubagent,
  isSubagentLaunch,
  mcpServerKey,
  subagentItemId,
  toolKindOf,
  toolViewOf,
} from "./tools"
import type { WorkflowPlanPhase } from "./tools"
import { batchSpanOf, layoutBatches } from "./tool-batches"
import type { WorkflowProgressEntry } from "@daedalus/protocol"

/** A transcript rule a run may hold: an interrupt notice, or a `config_notice`
 *  row (a setting changed mid-turn). The only `TextItem` there is room for. */
export type NoticeItem = TextItem & { kind: "notice" }

/** A thought: the reasoning that produced the calls it leads or sits between.
 *  It rides inside their run, so the group is the thinking and the work it
 *  explains; a thought nothing follows stands where it arrived. */
export type ThoughtItem = TextItem & { kind: "thought" }

/** What a run may hold — a call, the reasoning before or between calls, and a
 *  setting changed between two of them. Prose is not one: it ends the run it
 *  would have joined. */
export type RunItem = ToolItem | NoticeItem | ThoughtItem

/** A run of consecutive calls with the same resolved tool view, folded into
 *  one row (layout-options). A setting changed between two of them rides along,
 *  in its place. */
export interface ToolRunGroup {
  kind: "run"
  id: string
  items: RunItem[]
  /** These calls went out in one model response and ran side by side
   *  (`lib/tool-batches.ts`) — a group of its own inside the run, drawn marked. */
  parallel?: true
}

/** Consecutive tool calls collected under one parent, split into layout runs. */
export interface ToolGroup {
  kind: "tool-group"
  id: string
  items: RunItem[]
  /** A nested tool group is only ever a parallel batch of mixed kinds. */
  children: Array<RunItem | ToolRunGroup | ToolGroup>
  parallel?: true
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
  /** The tool call that launched a session head, folded into it — our
      runtime's `task` (its spawn names it in `_meta`) or OpenCode's `task`
      (its output names the child session). One subagent is one step, however
      many wire records announced it: the launch brings the brief and the
      report, the session the rail, the state and the usage. */
  launch?: ToolItem
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
  /** The run is over — nothing under it is still at work. A native run says so
      with its task's own state; a harness run has no item of its own, so it is
      read off its steps (`harnessRunFinished`). The transcript closes a
      finished one off with a hairline before whatever came next. */
  finished: boolean
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

/**
 * A run of `!` commands the reader ran back to back, folded into one row when
 * "Group `!` commands" is on. Adjacency is the rule, exactly as it is for a tool
 * run: anything between two commands — prose, a step, a turn — means the reader
 * went and did something else in between, and a run of one stays the block it
 * was. A command that is still running opens the group, the way a live step
 * opens a tool run.
 */
export interface ShellRun {
  kind: "shell-run"
  /** `shells:<first command's id>`. */
  id: string
  items: ShellItem[]
}

/**
 * The work between two things that were said, collected into one line you can
 * open (`answersOnly`, layout-options).
 *
 * Everything else on this list is a way of drawing items that are all the same
 * kind of thing; this one holds *rows*. That is the whole point: the transcript
 * keeps every fold it already had — a run, a subagent with its rail, a
 * workflow's card, a plan — and this only collects them, so opening the line
 * gives back the whole transcript with nothing re-shaped. It follows that the
 * fold is the LAST pass in `buildRows`: grouping has already done everything it
 * can, and the fold only has to take what is left.
 *
 * A stretch runs between two things said, and a stretch of ONE folds too —
 * the difference between this and every other fold here. A lone tool call
 * between two paragraphs is exactly the row the option exists to take out of
 * the conversation, so leaving it whole would put the work back.
 */
export interface WorkFold {
  kind: "work-fold"
  /** `work:<first row's id>`, so it is stable while work keeps arriving. */
  id: string
  rows: Row[]
}

export type Row =
  | ThreadItem
  | ToolRunGroup
  | ToolGroup
  | SubagentGroup
  | WorkflowGroup
  | SubagentBatch
  | ShellRun
  | WorkFold

/** The id of the item a row stands for — for keys, scroll anchors and the
    "where does the Sources strip go" lookup, which is keyed by item id. A
    run's is its last step's, since that is the item that ends the turn; a
    workflow's is its last step's for the same reason; a `!` run's is its last
    command's, which is the one that just finished. */
export function rowTailId(row: Row): string {
  if (row.kind === "run" || row.kind === "shell-run") return row.items[row.items.length - 1].id
  if (row.kind === "work-fold") return rowTailId(row.rows[row.rows.length - 1])
  if (row.kind === "tool-group") return rowTailId(row.children[row.children.length - 1])
  if (row.kind === "workflow-group" || row.kind === "subagent-batch")
    return rowTailId(row.steps[row.steps.length - 1])
  return row.id
}

/**
 * Which rows an open turn is still writing — the rows a view hands `streaming`
 * to. Ordinarily that is the one row whose tail is the thread's newest item
 * (`rowTailId`).
 *
 * **A trailing thought takes nothing away from the run it is about to join.**
 * Reasoning that arrives after the last call of a run stands outside the fold
 * until the next call lands (`groupToolRuns`: a thought nothing follows is the
 * live tail, and folding it away would hide the thinking in progress). Reading
 * "is this the tail" off `rowTailId` alone then went looking for the newest
 * item and found the thought where it wanted the run — so the group above it
 * stopped being the transcript's tail for exactly as long as the model was
 * thinking: it folded shut the moment the reasoning started and opened again
 * when the call after it arrived. That is the transcript rewriting itself
 * mid-read, at the one moment a reader is watching it.
 *
 * So a thought standing at the tail is live, and so is the group directly above
 * it — the fold it is being written for. Prose is deliberately not: a reply
 * already on screen does not become unfinished because the agent has started
 * thinking again after it.
 *
 * `last` is the id of the newest item *these* rows end in, so the same reading
 * works on a fold's own children (a work fold is a row like any other, and the
 * group inside it folds for the same reason).
 */
export function streamingRowIds(rows: Row[], last: string | undefined): ReadonlySet<string> {
  const live = new Set<string>()
  if (last === undefined || rows.length === 0) return live
  /* Only the row that ends these rows can be the one being written: a newer
     item drawn a level down (a subagent's step, a fold's child) leaves the top
     level with a tail that ends nothing, and answering for it here would mark
     whatever happens to be last as live. */
  if (rowTailId(rows[rows.length - 1]) !== last) return live

  let index = rows.length - 1
  while (index >= 0 && rows[index].kind === "thought") {
    live.add(rows[index].id)
    index--
  }
  const above = rows[index]
  if (!above) return live
  if (live.size === 0) {
    live.add(above.id)
    return live
  }
  /* Thinking at the tail: the group it is being written for is still live
     whatever its own last call settled at. A run never holds a trailing
     thought (`groupToolRuns`), so the fold it explains has to be told some
     other way — and this is that way. */
  if (above.kind === "run" || above.kind === "tool-group") live.add(above.id)
  return live
}

/** The row a stack of folds ends in — a `work-fold`'s last inner row, walked
    the same way `rowTailId` walks it. "Answers only" can put the workflow's
    card inside a fold, and the rule then hangs off the fold rather than off the
    card that is no longer a row of its own. */
function lastInnerRow(row: Row): Row {
  let last = row
  while (last.kind === "work-fold" && last.rows.length > 0) last = last.rows[last.rows.length - 1]
  return last
}

/** When the last tool call a row ends in settled, or undefined where that is
    unknown: a call still out, one with no recorded end (a `session/load`
    replay), or a row that is not tool calls at all. */
function toolsEndedAt(row: Row): number | undefined {
  const tools: ToolItem[] =
    row.kind === "tool" ? [row] : row.kind === "run" || row.kind === "tool-group" ? row.items.filter((item): item is ToolItem => item.kind === "tool") : []
  if (tools.length === 0 || tools.some((tool) => tool.endedAt === undefined)) return undefined
  return Math.max(...tools.map((tool) => tool.endedAt!))
}

/** The wait between a tool call settling and the agent's reply to it starting
    to be written — the model reading the result, mostly. `row` is the agent's
    prose and `above` the row before it; `layoutBatches` draws the waits between
    steps of a run, and this is the one it cannot, since prose ends the run it
    follows. Undefined when either end has no honest stamp.

    **The wait is measured to the last call, not to the row directly above it.**
    Reasoning that ends a step — a request whose last act was thinking, with no
    call after it — leaves its thought standing between the run and the reply,
    because a trailing thought is the live tail rather than part of the fold
    (`groupToolRuns`). Reading only `rows[index - 1]` then found a thought where
    it wanted a call and said nothing at all, so the whole wait — the thinking
    included — went unmeasured on exactly the steps where it was longest. The
    chain of thoughts is walked back to the run it followed, and the gap is the
    wall clock across it: the thought is part of the wait, and it says its own
    duration separately. Undefined when that walk reaches anything that is not a
    settled call, so a message from the person between them still breaks it. */
export function proseGapAfter(rows: Row[], index: number): number | undefined {
  const row = rows[index]
  if (!row || row.kind !== "agent" || row.parentId || row.at === undefined) return undefined
  for (let i = index - 1; i >= 0; i--) {
    const above = lastInnerRow(rows[i])
    if (above.kind === "thought" && !above.parentId) continue
    const end = toolsEndedAt(above)
    return end === undefined ? undefined : row.at - end
  }
  return undefined
}

/** Whether this row opens with the hairline that closes off a workflow run —
    the row above ended one and the thread went on. A run with nothing after it
    has no row to carry the rule, so nothing trails the transcript. Purely where
    a rule goes: no item, order or persistence is read differently for it. */
export function separatorAfterRun(rows: Row[], index: number): boolean {
  const above = rows[index - 1]
  if (!above) return false
  const tail = lastInnerRow(above)
  return tail.kind === "workflow-group" && tail.finished
}

/**
 * What "Answers only" (layout-options) keeps OUT of the fold: the conversation.
 *
 * Kept: the user's messages, the agent's prose, the notices that carry an
 * interrupted turn's Continue button, and errors — a failure hidden reads as
 * an answer that never came, which is the one thing this option must not do.
 * A `!` command is kept too: the user ran it, so it is part of the conversation
 * rather than work the agent did. Folded away (see `foldWork`): thoughts, tool
 * calls, plans, compactions, subagent sessions.
 *
 * A `parentId` is work whatever its kind: a subagent's own prose is the work,
 * not the thread's answer, and its head is inside the same fold anyway — the
 * one place an orphaned child can still reach is a fold's open body.
 */
export function isAnswerItem(item: ThreadItem): boolean {
  if (item.parentId) return false
  return (
    item.kind === "user" ||
    item.kind === "agent" ||
    item.kind === "notice" ||
    item.kind === "error" ||
    item.kind === "shell" ||
    item.kind === "voice"
  )
}

/**
 * The transcript as rows: subagents nested, then (optionally) runs grouped,
 * and — when "Answers only" is on — the work folded between the answers.
 * Nesting does not depend on the grouping option — a subagent's rail is not
 * a preference, it is where its steps belong. Three kinds fold: runs of tool
 * steps, runs of the reader's own `!` commands, and (last) the work itself.
 */
export function buildRows(
  items: ThreadItem[],
  groupTools: boolean,
  turnActive = false,
  groupShells = false,
  groupEdits = false,
  answersOnly = false,
  /** The burst window that makes a response's calls one parallel group of
      their own inside a run (`groupToolRuns`); unset, batches are not grouped. */
  parallelBurstMs?: number
): Row[] {
  const nested = mergeSubagentBatches(
    mergeWorkflowRuns(nestSubagents(withoutAsyncTasks(items), groupTools, turnActive, groupEdits, parallelBurstMs))
  )
  const placed = placeNativeWorkflows(nested, items)
  const grouped = groupTools ? groupToolRuns(placed, groupEdits, parallelBurstMs) : placed
  const shelled = groupShells ? groupShellRuns(grouped) : grouped
  return answersOnly ? foldWork(shelled) : shelled
}

/* An async-task item is a record, not a row: it is read into a `WorkflowGroup`
   by `placeNativeWorkflows` and never drawn on its own, so it is taken out
   before nesting rather than filtered from every consumer downstream. */
const withoutAsyncTasks = (items: ThreadItem[]): ThreadItem[] =>
  items.some((i) => i.kind === "async-task") ? items.filter((i) => i.kind !== "async-task") : items

/* ── Native (Claude Code) workflow runs ──
   A harness workflow's steps are real threads, so they arrive as `subagent`
   items and `mergeWorkflowRuns` folds them. A Claude Code dynamic workflow has
   no such thing: its agents live inside the CLI, have no session anyone can
   open, and what crosses the wire is a progress array restated on every beat
   (`AsyncTaskItem.progress`).

   So the steps are built here, at view time, and stamped with the very
   `_meta.daedalus.workflow` shape the harness's own runner stamps on a spawn —
   which is the whole point: from `WorkflowRun` down, a native run is not a
   special case. It gets the phases, the counts, the elapsed, the per-step
   tokens and the same row vocabulary, and none of that code learns a word
   about where the run came from. */

/** The runtime's per-agent state onto the step vocabulary. `blocked` is the
    safety classifier refusing an agent — an ending, and not a success. */
function nativeStepState(entry: WorkflowProgressEntry): SubagentItem["state"] {
  switch (entry.state) {
    case "done":
      return "completed"
    case "error":
      return "failed"
    case "blocked":
      return "cancelled"
    default:
      return "running"
  }
}

/**
 * The run's outline out of its progress array: the phases the script declared,
 * each holding the agents filed under it, in the order the runtime numbers
 * them.
 *
 * Step names must be unique — `phasesOf` joins the outline to the arrived steps
 * by name, so two agents a script labelled the same would collapse into one row
 * and leave the other drawn as forever pending. The runtime's own index is what
 * breaks the tie, and only for the names that actually repeat, so the common
 * case still reads as the script wrote it.
 */
function nativeOutline(entries: WorkflowProgressEntry[]): {
  plan: WorkflowPlanPhase[]
  nameOf: Map<WorkflowProgressEntry, string>
} {
  const agents = entries.filter((e) => e.type === "workflow_agent")
  const seen = new Map<string, number>()
  for (const agent of agents) {
    const label = agent.label ?? ""
    seen.set(label, (seen.get(label) ?? 0) + 1)
  }
  const nameOf = new Map<WorkflowProgressEntry, string>()
  for (const agent of agents) {
    const label = agent.label ?? `agent ${agent.index ?? nameOf.size + 1}`
    nameOf.set(agent, (seen.get(label) ?? 0) > 1 ? `${label} (${agent.index})` : label)
  }

  const phases = entries
    .filter((e) => e.type === "workflow_phase")
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  const stepsIn = (predicate: (agent: WorkflowProgressEntry) => boolean) =>
    agents.filter(predicate).map((agent) => nameOf.get(agent)!)

  /* No phases declared is one unnamed phase, which `phasesOf` draws without a
     heading — a heading over the whole list is a level with one child. */
  if (phases.length === 0) return { plan: [{ name: null, steps: stepsIn(() => true) }], nameOf }

  const plan: WorkflowPlanPhase[] = phases.map((phase) => ({
    name: phase.title ?? null,
    steps: stepsIn((agent) => agent.phaseIndex === phase.index),
  }))
  // An agent whose phase was never announced cannot be placed and must not
  // vanish; `phasesOf` appends such strays to the last phase, so name it there.
  const placed = new Set(phases.map((phase) => phase.index))
  const strays = stepsIn((agent) => !placed.has(agent.phaseIndex))
  if (strays.length > 0) plan[plan.length - 1].steps.push(...strays)
  return { plan, nameOf }
}

/** One agent of a run as the `SubagentGroup` every other step in the transcript
    is. No children: the CLI keeps its agents' transcripts to itself, and what
    it previews instead (the brief, the report, the tool it is on) rides on the
    head — see `SubagentItem.prompt`/`report`/`activity`. */
function nativeWorkflowRun(task: AsyncTaskItem, transcriptDir?: string): WorkflowGroup | null {
  const agents = task.progress.filter((e) => e.type === "workflow_agent")
  /* No agents is a run whose adapter never carried the array through (an
     unpatched claude-agent-acp) — there is nothing to draw, and the launch's
     own row keeps the journal panel it has always had. */
  if (agents.length === 0) return null

  const { plan, nameOf } = nativeOutline(task.progress)
  const running = task.state === "running" || task.state === "paused"

  const steps: SubagentGroup[] = agents.map((agent, position) => {
    const step = nameOf.get(agent)!
    const id = `subagent:wf:${task.taskId}:${agent.index ?? position}`
    const state = nativeStepState(agent)
    const tokens = agent.tokens ?? 0
    const head: SubagentItem = {
      kind: "subagent",
      id,
      /* Never a real session id, and deliberately unresolvable: `useStepThread`
         asks the store whether it knows this id, and the honest answer for an
         agent living inside the CLI is no — so the step draws without an
         "Open thread" link rather than offering one that goes nowhere. */
      sessionId: `wf:${task.taskId}:${agent.index ?? position}`,
      name: step,
      task: agent.promptPreview ?? step,
      state,
      capabilities: {},
      workflow: {
        runId: task.taskId,
        name: task.name,
        step,
        index: agent.index,
        total: agents.length,
        ...(agent.phaseIndex !== undefined && agent.phaseTitle !== undefined
          ? { phase: { index: agent.phaseIndex, name: agent.phaseTitle } }
          : {}),
        plan,
      },
      /* The runtime meters an agent as one number. The split is genuinely not
         reported, and zeroes are the only honest way to say so — `TokenFigure`
         prints the total, and `sumUsage` adds totals, so the run's cost is
         right either way. */
      usage: tokens > 0 ? { totalTokens: tokens, inputTokens: 0, outputTokens: 0 } : undefined,
      prompt: agent.promptPreview,
      report: agent.resultPreview ?? agent.error,
      activity: agent.lastToolSummary ?? agent.lastToolName,
      /* Its own history, when the launch told us where the run writes and the
         runtime has named this agent. Both are needed and both can be late, so
         a step without them simply draws without a rail rather than with an
         empty one. */
      ...(transcriptDir && agent.agentId
        ? { transcript: { dir: transcriptDir, agentId: agent.agentId } }
        : {}),
      startedAt: agent.startedAt ?? agent.queuedAt ?? task.startedAt,
      at: task.at,
      parentId: task.parentId,
    }
    return {
      kind: "subagent-group",
      id,
      head,
      /* Not `subagentActive`: that reads liveness off the parent's turn, and a
         dynamic workflow's whole nature is that it outlives the turn that
         launched it. The runtime says outright which agents are working, so
         that is what is believed — bounded by the run itself being live, so a
         killed run leaves nothing shimmering. */
      active: running && state === "running",
      children: [],
    }
  })

  return { kind: "workflow-group", id: `workflow:${task.taskId}`, name: task.name, steps, plan, finished: !running }
}

/**
 * Put each native run where it belongs: in place of the tool call that launched
 * it, which is where it happened and where a reader last saw it mentioned.
 *
 * **Matched two ways, because one of them is a race.** The adapter mentions the
 * launching `toolCallId` only when it happens to hold one at the moment it
 * publishes — for some runs that is the first beat, for others only the last,
 * and the ordering that decides which is the same unspecified level-vs-started
 * ordering that already cost this feature two silent failures. So the launch
 * row is also matched by the runtime's own task id, which the Workflow tool
 * result carries (`BackgroundTask.taskId`) from the instant the call returns.
 * Either key alone is enough; together the run lands in the right place from
 * the first beat rather than jumping there when it finishes.
 *
 * A run whose launch row is not on screen (the transcript was windowed past it)
 * falls back to where its item sits, so a run is never silently dropped.
 */
function placeNativeWorkflows(rows: Row[], items: ThreadItem[]): Row[] {
  const tasks = items.filter((i): i is AsyncTaskItem => i.kind === "async-task")
  if (tasks.length === 0) return rows

  /* The launches first, because the run needs one of them before it can be
     built: the transcript directory a step reads its own history out of is
     named in the tool result, and nowhere in the async-task stream. */
  const launches = new Map<string, { id: string; dir?: string }>()
  for (const item of items) {
    if (item.kind !== "tool") continue
    const background = extractBackgroundTask(item)
    if (background?.taskId) launches.set(background.taskId, { id: item.id, dir: background.transcriptDir })
  }

  const byLaunch = new Map<string, WorkflowGroup>()
  const byTaskId = new Map<string, WorkflowGroup>()
  const runs: WorkflowGroup[] = []
  for (const task of tasks) {
    const launch = launches.get(task.taskId)
    const run = nativeWorkflowRun(task, launch?.dir)
    if (!run) continue
    runs.push(run)
    byTaskId.set(task.taskId, run)
    if (task.toolCallId) byLaunch.set(task.toolCallId, run)
    if (launch) byLaunch.set(launch.id, run)
  }
  if (runs.length === 0) return rows

  /* The launch is a plain tool row: nothing claimed it as a subagent head,
     because the workflow's agents never arrive as this session's updates. */
  const launchOf = (row: Row): ToolItem | null =>
    row.kind === "tool" ? row : row.kind === "subagent-group" && row.head.kind === "tool" ? row.head : null

  const out: Row[] = []
  const used = new Set<WorkflowGroup>()
  for (const row of rows) {
    const launch = launchOf(row)
    const taskId = launch ? extractBackgroundTask(launch)?.taskId : undefined
    const run = launch ? (byLaunch.get(launch.id) ?? (taskId ? byTaskId.get(taskId) : undefined)) : undefined
    if (run && !used.has(run)) {
      out.push(run)
      used.add(run)
      continue
    }
    // A launch row whose run is already placed is dropped, not drawn twice.
    if (run) continue
    out.push(row)
  }
  for (const run of runs) if (!used.has(run)) out.push(run)
  return out
}

/**
 * The plan a run card draws from. Every spawn restates the outline as the
 * script had registered it by then, and a script only ever adds — steps it
 * discovers, phases it reaches — so the fullest plan is the newest one, and
 * keeping the first would file every later step under the last phase as a
 * stray. A tie goes to the later spawn, which is the same outline.
 */
function fuller(kept: WorkflowPlanPhase[] | undefined, next: WorkflowPlanPhase[] | undefined) {
  if (!next) return kept
  if (!kept) return next
  const size = (plan: WorkflowPlanPhase[]) => plan.length + plan.reduce((n, phase) => n + phase.steps.length, 0)
  return size(next) >= size(kept) ? next : kept
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
      run.plan = fuller(run.plan, wf.plan)
    } else {
      const group: WorkflowGroup = {
        kind: "workflow-group",
        id: `workflow:${wf.runId}`,
        name: wf.name,
        steps: [row],
        plan: wf.plan,
        finished: false,
      }
      runs.set(wf.runId, group)
      out.push(group)
    }
  }
  // Read off the whole run: a running step arriving at the end of the list is
  // what must un-finish it, so the flag is only settled after the loop.
  for (const run of runs.values()) run.finished = harnessRunFinished(run.steps)
  return out
}

/**
 * Whether a harness run has ended, read off its steps — the run has no item of
 * its own, so the steps' own terminal states are the only record of its end.
 *
 * Every step that arrived has settled, and the run is not held. The definition's
 * `total` is deliberately NOT part of the test: a run that failed or was stopped
 * never spawns the steps after the one that ended it, so waiting for the full
 * count would leave every such run reading as live for good. A held run is live
 * however quiet its steps are.
 */
function harnessRunFinished(steps: SubagentGroup[]): boolean {
  for (const step of steps) {
    const head = step.head
    const info = head.kind === "subagent" ? head.workflow : undefined
    if (info?.paused) return false
    if (head.kind === "subagent" && head.state === "running") return false
  }
  return true
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
    if (row.kind === "work-fold") {
      // The fold is a reading; the workers inside it are still the thread's.
      out.push(...activeSubagents(row.rows))
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
 * - Nothing runs outside a turn — or outside the background work the server
 *   says the thread still has (`ThreadState.background`: an `ask_agent` or a
 *   workflow run outlives the turn that launched it). The caller passes the
 *   two folded into `turnActive` (`workLive`), so an archived thread, or one
 *   whose turn ended with nothing left going, has no workers.
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
function nestSubagents(
  items: ThreadItem[],
  groupTools: boolean,
  turnActive: boolean,
  groupEdits: boolean,
  parallelBurstMs?: number
): Row[] {
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
  const launchOf = sessionLaunches(items)
  const absorbed = new Map<string, string>()
  for (const [session, tool] of launchOf) absorbed.set(tool.id, session)
  /* A launched session stands where its launch would have — under the launch's
     owner — and anything filed under the launch moves to the session. */
  const ownerOf = (item: ThreadItem): string | undefined =>
    launchOf.get(item.id)?.parentId ?? (item.parentId && absorbed.get(item.parentId)) ?? item.parentId
  for (const item of items) {
    if (absorbed.has(item.id)) continue
    const owner = ownerOf(item)
    if (owner && heads.has(owner)) claim(item, owner)
  }
  adoptProjectedChildren(items, heads, byParent, claimed)
  groupCodexLifecycle(items, byParent, claimed)
  // Anything the passes above filed under a folded launch belongs to its session.
  for (const [toolId, session] of absorbed) {
    const kids = byParent.get(toolId)
    if (!kids) continue
    byParent.delete(toolId)
    byParent.set(session, [...(byParent.get(session) ?? []), ...kids])
  }
  const indexOf = new Map<ThreadItem, number>()
  items.forEach((item, index) => indexOf.set(item, index))

  const build = (list: ThreadItem[], ancestry: Set<string>): Row[] => {
    const rows: Row[] = []
    for (const item of list) {
      // At the top level a claimed item is drawn under its owner, not here.
      if (list === items && claimed.has(item)) continue
      if (absorbed.has(item.id)) continue
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
      const launch = launchOf.get(item.id)
      rows.push({
        kind: "subagent-group",
        id: item.id,
        head,
        ...(launch ? { launch } : {}),
        active: subagentActive(head, kids, children, items, indexOf, turnActive),
        children: groupTools ? groupToolRuns(children, groupEdits, parallelBurstMs) : children,
      })
    }
    return rows
  }
  return build(items, new Set())
}

/**
 * Session heads that a tool call launched, keyed on the session item's id.
 * Two links say so: the spawn filed under a launch call (our runtime's
 * `subagent_spawned` carries `_meta.daedalus.parentToolUseId`), or a launch
 * call whose output names the child session (OpenCode's `task`, whose child
 * the server feeds as an RFD session). Claude Code and Codex never need it:
 * with native subagent sessions they withhold the launch call themselves.
 */
function sessionLaunches(items: ThreadItem[]): Map<string, ToolItem> {
  const tools = new Map<string, ToolItem>()
  const sessions = new Set<string>()
  for (const item of items) {
    if (item.kind === "tool") tools.set(item.id, item)
    else if (item.kind === "subagent") sessions.add(item.id)
  }
  const out = new Map<string, ToolItem>()
  const taken = new Set<ToolItem>()
  const link = (session: string, tool: ToolItem | undefined) => {
    if (!tool || taken.has(tool) || out.has(session) || !isSubagentLaunch(tool)) return
    out.set(session, tool)
    taken.add(tool)
  }
  /* A launch that names no child yet, waiting for the session it started.
     codex-acp in native mode may start a `spawnAgent` that never learns its
     receiver and never completes — the spawn's `task` is that call's prompt.
     OpenCode 2's `subagent` names its child only when it completes, and the
     child's title is the call's `description`. So the next unclaimed session,
     under the same owner, that says one of the call's words is its child. */
  const dangling: { tool: ToolItem; words: string[]; any: boolean }[] = []
  for (const item of items) {
    if (item.kind === "subagent") {
      if (item.parentId) link(item.id, tools.get(item.parentId))
      if (out.has(item.id)) continue
      const said = [item.name.trim(), item.task.trim()]
      const match = dangling.findIndex(
        (d) =>
          !taken.has(d.tool) &&
          d.tool.parentId === item.parentId &&
          (d.any || d.words.some((w) => said.includes(w)))
      )
      if (match >= 0) link(item.id, dangling.splice(match, 1)[0].tool)
    }
    if (item.kind === "tool") {
      const call = extractSubagent(item)
      const id = call?.sessionId ? subagentItemId(call.sessionId) : undefined
      if (id && sessions.has(id)) link(id, item)
      else if (call && !call.sessionId && isSubagentLaunch(item)) {
        const words = [call.description, call.prompt].filter((w): w is string => !!w?.trim()).map((w) => w.trim())
        const codexSpawn = call.tool === "spawnAgent"
        if (codexSpawn && call.receiverThreadIds?.length) continue
        /* An ask's child is titled after the pair, not the brief, so no word
           of the call's is said by it — the next session to start is it. */
        const ask = call.tool === ASK_AGENT
        dangling.push({ tool: item, words, any: ask || (codexSpawn && words.length === 0) })
      }
    }
  }
  return out
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
  /* With native subagent sessions codex-acp withholds the `spawnAgent` and
     makes the child a session whose id is its thread id (`:generation:N` on a
     re-open, the newest winning) — but the parent's `sendInput`/`wait`/
     `closeAgent` rows still arrive, naming that thread. They go under it. */
  for (const item of items) {
    if (item.kind === "subagent") headByThread.set(item.sessionId.replace(/:generation:\d+$/, ""), item.id)
  }
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
  if (starts.length === 0 && spawns.length === 0 && headByThread.size === 0) return
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

/** A setting the person changed mid-turn: the server's `config_notice`, kept as
    a `notice` row flagged `config` (store/items.ts) so a view option can hide
    it. Not a break in the conversation — a line about the run it landed in. */
const isThought = (row: Row): row is ThoughtItem => row.kind === "thought"
const isConfigNotice = (row: Row): row is NoticeItem => row.kind === "notice" && row.config === true

/**
 * A stretch of consecutive calls becomes one parent group. Its children split at
 * changes of `runKeyOf` — the resolved view, and for an MCP call the server that
 * took it — with repeated same-key calls folded into expandable subgroups. Other content stays outside these groups — prose, a plan, a
 * subagent, a `!` command: a row that is not a call or a thought ends the run it
 * would have joined. A call on its own remains ungrouped, including while a turn
 * is active.
 *
 * **A thought rides inside the run it explains.** The reasoning that leads a
 * run or sits between two of its calls is part of the work: left outside,
 * `think -> read -> read` was a thought hanging over a fold that did not own it.
 * The counting line still counts calls only (a thought is not a step it
 * summarises). One a call does not follow — trailing, before prose, a subagent
 * or an edit that is not grouped — stands where it arrived, like a trailing
 * setting change: it is the live tail, and folding it away would hide the
 * thinking in progress. What a group cannot be is a group of one call: that is
 * still a step, not a fold.
 *
 * A setting changed mid-turn goes *inside* the run when it is between two of
 * its calls, and nowhere else. Between them the agent changed nothing about the
 * work it was doing: drawn as a rule across the transcript it split one run in
 * two, so the same run was read as two and its counting lines said half each.
 * Before a run's first call or after its last it is still a break — trailing,
 * it is the last thing that happened, and it is also the item the turn's footer
 * anchors on (`turn-footers.ts`), so folding it into the run would both hide it
 * behind a counting line and move the strip that belongs under it.
 */
export function groupToolRuns(rows: Row[], groupEdits = false, parallelBurstMs?: number): Row[] {
  const out: Row[] = []
  let items: RunItem[] = []
  /* A setting change that arrived between two steps and has not been placed
     yet: it rides inside the run when it is between two of its calls, and is a
     break anywhere else (see `settle`). */
  let held: (NoticeItem | ThoughtItem)[] = []

  const flush = () => {
    const tools = items.filter((item): item is ToolItem => item.kind === "tool")
    if (tools.length > 1) {
      /* One fold standing for the whole stretch — every call of one kind, or
         one parallel batch — is the stretch's row; anything else is a group of
         the parts. */
      const children = foldStretch(items, parallelBurstMs)
      const only = children.length === 1 ? children[0] : undefined
      if (only && (only.kind === "run" || only.kind === "tool-group")) out.push(only)
      else out.push({ kind: "tool-group", id: items[0].id, items, children })
    } else out.push(...items)
    items = []
  }

  /* A setting change still waiting when a break arrives is trailing, not
     interior: it is drawn after the run, not folded into it. Only another call
     arriving puts one inside (the tool branch below), which is what "between two
     calls" means — the call that settles it is the one that proves it was in the
     middle and not at the end. */
  const settle = (): (NoticeItem | ThoughtItem)[] => {
    const waiting = held
    held = []
    return waiting
  }

  for (const row of rows) {
    if (row.kind === "tool" && (groupEdits || toolViewOf(row) !== "edit")) {
      /* Held before a run's first step, a notice is a break rather than a line
         inside the work: this run starts after it. */
      if (items.length === 0 && held.length > 0) {
        out.push(...held)
        held = []
      }
      items.push(...held, row)
      held = []
    } else if (isThought(row) && items.length === 0 && held.length === 0) {
      /* The reasoning that leads a run: it opens it. Alone (nothing follows) the
         flush hands it back as a plain row. */
      items.push(row)
    } else if (isConfigNotice(row) || isThought(row)) {
      held.push(row)
    } else {
      /* Prose, a plan, a subagent — everything that is not a call or the
         thinking around one — ends the run and is drawn where it arrived. */
      const outside = settle()
      flush()
      out.push(...outside, row)
    }
  }
  const outside = settle()
  flush()
  out.push(...outside)
  return out
}

/* Cached per item object, like `TOOL_VIEW_CACHE`: the store replaces an item
   whenever its content changes, so identity is an exact key and a hit can never
   be stale. Worth it because the fold asks this on every streamed chunk. */
const RUN_KEY_CACHE = new WeakMap<ToolItem, string>()

/**
 * What a run is a run OF.
 *
 * The resolved view — plus, for a call into an MCP server, *which* server. A
 * dozen calls to four integrations all resolve to the `mcp` view, and folding
 * them into one line said "Running 12 tools" about a stretch that was four
 * different integrations' work: the first thing a reader scans for is which
 * integration acted, and the ACP kind is the last thing that can say it. So the
 * server is part of the key, and each server's consecutive calls fold together
 * (`Clickup · 4 calls`) instead of all of them under one `mcp` heading.
 *
 * Consecutive is the whole rule, deliberately: a run never reorders the steps
 * it holds, because a call's result is often what the next call was for. Two
 * stretches to the same server with another server's calls between them are two
 * runs, and the fold's own line still counts them together (`summarise`).
 */
function runKeyOf(item: ToolItem): string {
  const cache = RUN_KEY_CACHE.get(item)
  if (cache !== undefined) return cache
  const view = toolViewOf(item)
  const call = view === "mcp" ? extractMcpCall(item) : null
  const key = call ? `mcp:${mcpServerKey(call.server)}` : view
  RUN_KEY_CACHE.set(item, key)
  return key
}

/**
 * A stretch's children. With a burst window, the calls one model response sent
 * together (`layoutBatches` — the runtime's step id, else timing) become one
 * group of their own, marked `parallel`: a run when they share a key, else a
 * tool group with the same by-key folding inside it. The calls around a batch,
 * and the whole stretch when there is no window, fold by key as before.
 */
function foldStretch(items: RunItem[], burstMs?: number): ToolGroup["children"] {
  const batches =
    burstMs === undefined
      ? null
      : layoutBatches(
          items.map((item) => (item.kind === "tool" ? batchSpanOf(item) : {})),
          { burstMs, gapMinMs: null }
        )
  const out: ToolGroup["children"] = []
  let i = 0
  while (i < items.length) {
    let end = i
    if (batches?.[i].edge === "start") {
      while (batches[end].edge !== "end") end++
      const members = items.slice(i, end + 1)
      const folded = groupSameViewRuns(members)
      const one = folded.length === 1 ? folded[0] : undefined
      out.push(
        one && one.kind === "run"
          ? { ...one, parallel: true }
          : { kind: "tool-group", id: members[0].id, items: members, children: folded, parallel: true }
      )
    } else {
      while (end + 1 < items.length && batches?.[end + 1].edge !== "start") end++
      out.push(...groupSameViewRuns(items.slice(i, end + 1)))
    }
    i = end + 1
  }
  return out
}

/** Split one consecutive sequence into same-key expandable subgroups. */
function groupSameViewRuns(items: RunItem[]): Array<RunItem | ToolRunGroup> {
  const out: Array<RunItem | ToolRunGroup> = []
  let run: RunItem[] = []
  let runKey: string | null = null

  const flush = () => {
    if (run.filter((item) => item.kind === "tool").length > 1)
      out.push({ kind: "run", id: run[0].id, items: run })
    else out.push(...run)
    run = []
    runKey = null
  }

  for (const item of items) {
    if (item.kind === "tool") {
      const key = runKeyOf(item)
      if (runKey !== null && runKey !== key) flush()
      run.push(item)
      runKey = key
    } else {
      run.push(item)
    }
  }
  flush()
  return out
}

/**
 * The same fold for the reader's own `!` commands: a run of two or more
 * consecutive shell blocks becomes one row, and a lone one is left alone.
 *
 * Adjacency here means something slightly different than it does for a tool
 * run. Two commands with a turn between them are two things the reader did at
 * two different moments, and a turn is a perfectly good separator; only commands
 * run back to back — which is the case grouping exists for — merge.
 */
export function groupShellRuns(rows: Row[]): Row[] {
  const out: Row[] = []
  let run: ShellItem[] = []

  const flush = () => {
    if (run.length > 1) out.push({ kind: "shell-run", id: `shells-${run[0].id}`, items: run })
    else out.push(...run)
    run = []
  }

  for (const row of rows) {
    if (row.kind === "shell") run.push(row)
    else {
      flush()
      out.push(row)
    }
  }
  flush()
  return out
}

/**
 * Whether a row is the agent's work — the thing "Answers only" folds away.
 *
 * Item rows are judged by `isAnswerItem` (a user message, the agent's prose, a
 * notice, an error and the reader's own `!` command all stay out); every
 * composite row is work by construction, a `!` run is the reader's act and
 * stays out with its commands. A nested `work-fold` cannot reach here — this
 * is the last pass, on rows nothing has folded.
 */
function isWorkRow(row: Row): boolean {
  switch (row.kind) {
    case "run":
    case "tool-group":
    case "subagent-group":
    case "workflow-group":
    case "subagent-batch":
      return true
    case "shell-run":
    case "work-fold":
      return false
    default:
      return !isAnswerItem(row)
  }
}

/**
 * The last pass when "Answers only" is on: the work between two things said,
 * collected into one `WorkFold` — see the interface for why a run of one folds
 * too, and why this runs after every other fold.
 *
 * Membership is read off the ROW, not the items: a folded run, a subagent with
 * its rail, a workflow's card and a plan are each one thing the reader can open,
 * so each is one thing this collects. A row that carries something said ends the
 * stretch, which is what makes the fold fall *between* the answers rather than
 * around them. Nested rows never reach here — a subagent's children are already
 * inside its group, a tool group's inside it.
 */
export function foldWork(rows: Row[]): Row[] {
  const out: Row[] = []
  let run: Row[] = []

  const flush = () => {
    if (run.length === 0) return
    out.push({ kind: "work-fold", id: `work:${run[0].id}`, rows: run })
    run = []
  }

  for (const row of rows) {
    if (isWorkRow(row)) run.push(row)
    else {
      flush()
      out.push(row)
    }
  }
  flush()
  return out
}

/* ── Keeping a row's identity through a rebuild ──
   `buildRows` runs on every streamed chunk and hands back a new object for
   every *group* it forms — a run, a subagent, a workflow, a fold — even when
   nothing in it moved, so each one re-rendered under `RowView`'s memo on every
   token. Items already keep theirs (the reducer replaces only what changed);
   this does the same for the groups: a rebuilt group whose every part is the
   same as last time is last time's object, and one that changed still shares
   the parts that did not (a fold's untouched runs, a subagent's older steps).

   Items are atoms — compared by identity, never opened — so the only work is
   walking the group structure, and what comes back is always equal to `next`
   with the same item objects in it. Top-level rows are matched by id, so a
   page prepended above does not set every row against a stranger. */
const GROUP_KINDS: ReadonlySet<string> = new Set<Row["kind"]>([
  "run",
  "tool-group",
  "subagent-group",
  "workflow-group",
  "subagent-batch",
  "shell-run",
  "work-fold",
])

/** A plain object that is not an item: a group row, or data inside one. */
function isStructure(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false
  const kind = (value as { kind?: unknown }).kind
  return typeof kind !== "string" || GROUP_KINDS.has(kind)
}

function share<T>(prev: T, next: T): T {
  if (prev === next) return prev
  if (Array.isArray(prev) && Array.isArray(next)) {
    let same = prev.length === next.length
    const out = next.map((value, index) => {
      const kept = share(prev[index], value)
      if (kept !== prev[index]) same = false
      return kept
    })
    return (same ? prev : out) as T
  }
  if (!isStructure(prev) || !isStructure(next)) return next
  const keys = Object.keys(next)
  let same = keys.length === Object.keys(prev).length
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    out[key] = share(prev[key], next[key])
    if (out[key] !== prev[key] || !(key in prev)) same = false
  }
  return (same ? prev : out) as T
}

export function shareRows(prev: Row[], next: Row[]): Row[] {
  const byId = new Map(prev.map((row) => [row.id, row]))
  let same = prev.length === next.length
  const out = next.map((row, index) => {
    const old = byId.get(row.id)
    const kept = old ? share(old, row) : row
    if (kept !== prev[index]) same = false
    return kept
  })
  return same ? prev : out
}
