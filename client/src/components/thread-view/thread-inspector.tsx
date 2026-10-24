/* ── The thread inspector ── the column beside a transcript (`ThreadView`),
   with the thread's readings in full: Changes, Plan, Agents, Details. */
import * as React from "react"
import {
  ActivityIcon,
  BotIcon,
  CoinsIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  FolderIcon,
  GaugeIcon,
  LocateIcon,
  PanelRightCloseIcon,
  PlugZapIcon,
  WorkflowIcon,
  XCircleIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Notice } from "@/components/notice"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useTranscriptJump } from "@/components/thread-view/dormant"
import { PanelRowsSkeleton } from "@/components/ui/skeletons"
import { Empty } from "@/components/empty"
import { TodoChecklist } from "@/components/todo-checklist"
import { threadTodos } from "@/components/composer/todo-indicator"
import {
  INSPECTOR_DEFAULT,
  INSPECTOR_MAX,
  INSPECTOR_MIN,
  inspectorPrefs,
  setInspectorPref,
  type InspectorTab,
} from "@/lib/inspector"
import { cn } from "@/lib/utils"
import type { TurnChanges } from "@/lib/workspace/git-api"
import { ProjectIcon } from "@/components/entity-icon"
import {
  agentOutline,
  collectTools,
  RUN_VIEWS,
  RunLayout,
  RunViewTabs,
  SEGMENT,
  stepNameOf,
  stepStateOf,
  type StepRowComponent,
} from "@/components/workflow-run"
import { SubagentStep } from "@/components/thread-items/rows"
import { useLayoutOptions, LayoutOptionsContext } from "@/lib/layout-options"
import type { SessionMeta } from "@/lib/settings"
import { workLive, type ThreadItem, type ThreadState } from "@/lib/store"
import { formatDuration, formatTokens, formatTps, promptTokens, sumUsage } from "@/lib/tokens"
import { tpsAverage } from "@daedalus/tps"
import { INSPECTOR_TILE, InspectorCard } from "./inspector-card"
import { Count } from "@/components/settings/primitives"
import { PanelToolbar } from "@/components/workspace/primitives"

export { InspectorCard }
import { buildRows, type Row, type SubagentGroup, type WorkflowGroup } from "@/lib/transcript-rows"
import { extractSubagent, formatMcpName, loadedTools, parseMcpToolName, toolHeading, type LoadedTool } from "@/lib/tools"
import { useAgents, useProfiles, useProjects } from "@/lib/queries/catalog"
import { useFeature } from "@/lib/queries/surfaces"

function workflowProgress(workflow: WorkflowGroup) {
  const total = workflow.plan?.reduce((sum, phase) => sum + phase.steps.length, 0) ?? workflow.steps.length
  const completed = workflow.steps.filter((step) => stepStateOf(step) === "completed").length
  const failed = workflow.steps.filter((step) => stepStateOf(step) === "failed").length
  const active = workflow.steps.some((step) => step.active)
  return { total: Math.max(total, workflow.steps.length), completed, failed, active }
}

function recentStepText(group: SubagentGroup): string {
  const head = group.head
  if (head.kind === "subagent") {
    if (head.activity || head.report || head.task) return head.activity || head.report || head.task
  } else if (group.active) {
    const latest = [...group.children].reverse().find((row) => row.kind === "tool" || row.kind === "run" || row.kind === "tool-group")
    const tool = latest ? collectTools([latest]).at(-1) : undefined
    if (tool) return toolHeading(tool).title
  }
  return head.kind === "subagent" ? head.name : extractSubagent(head)?.description || head.title
}

function workflowGroups(rows: Row[]): WorkflowGroup[] {
  const workflows: WorkflowGroup[] = []
  for (const row of rows) {
    if (row.kind === "workflow-group") workflows.push(row)
    else if (row.kind === "subagent-group") workflows.push(...workflowGroups(row.children))
    else if (row.kind === "subagent-batch") workflows.push(...workflowGroups(row.steps))
  }
  return workflows
}

function activityGroups(rows: Row[]): SubagentGroup[] {
  const groups: SubagentGroup[] = []
  for (const row of rows) {
    if (row.kind === "workflow-group" || row.kind === "subagent-batch") {
      groups.push(...activityGroups(row.steps))
    } else if (row.kind === "subagent-group") {
      groups.push(row, ...activityGroups(row.children))
    }
  }
  return groups
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2 border-b py-1 last:border-0">
      <dt className="min-w-0 truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="shrink-0 truncate text-sm font-medium tabular-nums text-foreground" title={value}>{value}</dd>
    </div>
  )
}

/** A transcript row the Agents panel reads: a subagent, a workflow run or a
    batch of parallel subagents — the three shapes `agentOutline` folds into
    one outline. */
type AgentRow = Extract<Row, { kind: "subagent-group" | "workflow-group" | "subagent-batch" }>
const isAgentRow = (row: Row): row is AgentRow =>
  row.kind === "subagent-group" || row.kind === "workflow-group" || row.kind === "subagent-batch"
const stepsOf = (row: AgentRow): SubagentGroup[] => (row.kind === "subagent-group" ? [row] : row.steps)

type AgentFilter = "all" | "running" | "done" | "failed"
/* Per agent, so a filter means the same thing in every layout. */
const AGENT_FILTERS: Record<AgentFilter, (step: SubagentGroup) => boolean> = {
  all: () => true,
  running: (step) => step.active,
  done: (step) => !step.active && stepStateOf(step) === "completed",
  failed: (step) => !step.active && stepStateOf(step) !== "completed",
}

/** Scrolls the transcript to an agent's row — the panel's, read by `LocatableStep`. */
const AgentJumpContext = React.createContext<((id: string) => void) | null>(null)

/** A step row with a locate button beside it. Module-level, with the jump in
    context, so its identity is stable and an open row does not remount on
    every render. A `body` has no header to sit beside, so it gets none. */
function LocatableStep(props: React.ComponentProps<StepRowComponent>) {
  const jump = React.useContext(AgentJumpContext)
  if (props.variant === "body" || !jump) return <SubagentStep {...props} />
  return (
    <div className="group/agent flex min-w-0 items-start gap-1">
      <div className="min-w-0 flex-1">
        <SubagentStep {...props} />
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => jump(props.group.id)}
        className="opacity-0 group-hover/agent:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
        title="Show in the transcript"
      >
        <LocateIcon aria-hidden />
      </Button>
    </div>
  )
}

/** Each workflow run and each subagent has its own layout; only the workers
    within one workflow/batch share an outline. Rows use the reader's own view
    options, so a rail groups its tools here as it does in the transcript. */
function AgentsTab({ thread, groups, onJump }: { thread: ThreadState; groups: SubagentGroup[]; onJump: (id: string) => void }) {
  const options = useLayoutOptions()
  const { agentsView: view } = inspectorPrefs.use()
  const [filter, setFilter] = React.useState<AgentFilter>("all")
  const rows = React.useMemo(
    () =>
      buildRows(
        thread.items,
        options.groupTools,
        workLive(thread),
        false,
        !options.expandEdits
      ).filter(isAgentRow),
    [thread.items, thread.turnActive, thread.background, options.groupTools, options.expandEdits]
  )
  const entries = React.useMemo(
    () =>
      rows.flatMap((row) =>
        row.kind === "subagent-batch"
          ? row.steps.map((group) => ({ key: group.id, phases: agentOutline([group]) }))
          : [{ key: row.id, phases: agentOutline([row]) }]
      ),
    [rows]
  )
  if (rows.length === 0)
    return (
      <div className="p-3">
        <Empty>No subagents in this thread yet.</Empty>
      </div>
    )

  const steps = rows.flatMap(stepsOf)
  const tokens = sumUsage(groups.map((group) => (group.head.kind === "subagent" ? group.head.usage : null)))
  const match = AGENT_FILTERS[filter]
  /* "All" keeps a workflow's steps that have not started, so its shape stays whole. */
  const shownEntries = entries
    .map((entry) => ({
      ...entry,
      phases:
        filter === "all"
          ? entry.phases
          : entry.phases
              .map((phase) => ({ ...phase, steps: phase.steps.filter((step) => step.group && match(step.group)) }))
              .filter((phase) => phase.steps.length > 0),
    }))
    .filter((entry) => entry.phases.length > 0)

  return (
    <LayoutOptionsContext.Provider value={options}>
      <AgentJumpContext.Provider value={onJump}>
        <div className="flex min-h-0 flex-1 flex-col">
          <PanelToolbar className="flex-col items-stretch gap-2">
            <RunViewTabs views={RUN_VIEWS} value={view} onChange={(next) => setInspectorPref("agentsView", next)} label="Agents layout" iconOnly />
            <div className="flex flex-wrap items-center gap-1 text-xs tabular-nums">
              {(Object.keys(AGENT_FILTERS) as AgentFilter[]).map((key) => {
                const count = steps.filter(AGENT_FILTERS[key]).length
                if (key !== "all" && count === 0 && filter !== key) return null
                return (
                  <Button
                    key={key}
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-pressed={filter === key}
                    onClick={() => setFilter(key)}
                    className={cn("capitalize tabular-nums text-muted-foreground", filter === key && "bg-muted text-foreground")}
                  >
                    {key !== "all" && <span aria-hidden className={cn("size-1.5 rounded-full", SEGMENT[FILTER_STATE[key]])} />}
                    {key} {count}
                  </Button>
                )
              })}
              {tokens && <span className="ml-auto text-muted-foreground">{formatTokens(tokens.totalTokens)} tokens</span>}
            </div>
          </PanelToolbar>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {shownEntries.length === 0 ? (
              <Empty>No {filter} agents.</Empty>
            ) : (
              <div className="min-h-0 space-y-3">
                {shownEntries.map(({ key, phases }) => (
                  <RunLayout
                    key={`${filter}:${key}`}
                    phases={phases}
                    view={view}
                    active={phases.some((phase) => phase.steps.some((step) => step.group?.active))}
                    stepRow={LocatableStep}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </AgentJumpContext.Provider>
    </LayoutOptionsContext.Provider>
  )
}

const FILTER_STATE = { running: "running", done: "completed", failed: "failed" } as const

/** The thread's loaded tools in the panel's own row rhythm (`Metric`'s): name
    and server on one line, what the tool does under it. */
function LoadedToolRows({ tools }: { tools: LoadedTool[] }) {
  return (
    <ul className="max-h-64 divide-y overflow-y-auto">
      {tools.map((tool) => {
        const mcp = parseMcpToolName(tool.name)
        return (
          <li key={tool.name} className="min-w-0 py-1">
            <div className="flex min-w-0 items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-sm font-medium" title={tool.name}>
                {mcp?.tool ? formatMcpName(mcp.tool) : tool.name}
              </span>
              {mcp && <Badge variant="outline">{formatMcpName(mcp.server)}</Badge>}
            </div>
            {tool.description && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{tool.description}</p>}
          </li>
        )
      })}
    </ul>
  )
}

function WorkflowPreview({ workflows }: { workflows: WorkflowGroup[] }) {
  const recent = [...workflows].reverse().slice(0, 3)
  if (recent.length === 0) return <Empty>No workflow runs yet.</Empty>

  return (
    <ul className="space-y-2">
      {recent.map((workflow) => {
        const progress = workflowProgress(workflow)
        const status = progress.active ? "Running" : progress.failed ? "Failed" : "Complete"
        const percent = progress.total ? Math.min(100, (progress.completed / progress.total) * 100) : 0
        return (
          <li key={workflow.id} className="rounded-inner border px-3 py-2">
            <div className="flex min-w-0 items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate font-medium">{workflow.name}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {progress.completed}/{progress.total}
              </span>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`${workflow.name}: ${status}`} aria-valuenow={progress.completed} aria-valuemin={0} aria-valuemax={progress.total || 1}>
              <div
                className={`h-full rounded-full transition-[width] ${progress.failed ? "bg-destructive" : progress.active ? "bg-primary" : "bg-muted-foreground"}`}
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{status}{progress.failed ? ` · ${progress.failed} failed` : ""}</p>
            {workflow.steps.length > 0 && (
              <ul className="mt-2 space-y-1 border-t pt-2">
                {[...workflow.steps].slice(-3).reverse().map((step) => {
                  const state = stepStateOf(step)
                  const label = state === "completed" ? "Done" : state[0].toUpperCase() + state.slice(1)
                  return (
                    <li key={step.id} className="flex min-w-0 items-center gap-2 text-sm">
                      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", SEGMENT[state])} />
                      <span className="min-w-0 flex-1 truncate" title={stepNameOf(step)}>{stepNameOf(step)}</span>
                      <span className="shrink-0 text-muted-foreground">{label}</span>
                    </li>
                  )
                })}
              </ul>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** What the thread is running on and what it has cost — the inspector's
    Details tab, and what the whole column was before it had tabs. */
function DetailsTab({ thread, meta, rows }: { thread: ThreadState; meta: SessionMeta; rows: Row[] }) {
  const agents = useAgents()
  const profiles = useProfiles()
  const projects = useProjects()
  const workflows = workflowGroups(rows)
  const groups = activityGroups(rows)
  const requests = thread.items.filter((item) => item.kind === "user").length
  const turns = thread.turns.length || requests
  const context = thread.context
  const contextPercent = context && context.size > 0 ? Math.min(100, Math.round((context.used / context.size) * 100)) : null
  const contextCapacity = context ? formatTokens(context.size) : null
  const average = tpsAverage(thread.tps)
  const ownItems = thread.items.filter((item) => !item.parentId)
  const loaded = React.useMemo(() => loadedTools(thread.items), [thread.items])
  const tools = ownItems.filter((item) => item.kind === "tool")
  const completedTools = tools.filter((item) => item.status === "completed").length
  const failedTools = tools.filter((item) => item.status === "failed").length
  const subagentUsage = groups.reduce((total, group) => {
    if (group.head.kind === "subagent" && group.head.usage) return total + group.head.usage.totalTokens
    return total
  }, 0)
  const queued = thread.queue.length
  const failedRows = ownItems.filter((item) => item.kind === "error" && !item.severity).length
  const requestsIn = thread.usage ? promptTokens(thread.usage) : null
  const cachedIn = thread.usage?.cachedReadTokens ?? 0
  const cacheRate = requestsIn && requestsIn > 0 ? Math.round((cachedIn / requestsIn) * 100) : null
  const activeWorkflow = workflows.find((workflow) => workflow.steps.some((step) => step.active))
  const activeWorkflowStep = activeWorkflow?.steps.find((step) => step.active)
  const elapsed = Object.values(thread.turnDuration).reduce((sum, value) => sum + value, 0)
  const toolTime = Object.values(thread.turnToolDuration).reduce((sum, value) => sum + value, 0)
  const agent = agents.find((item) => item.id === meta.agentId)
  const profile = profiles.find((item) => item.id === meta.profileId)
  const project = projects.find((item) => item.id === meta.projectId)
  const model = profile?.models.find((item) => item.id === meta.model)?.label ?? meta.model
  const active = groups.filter((group) => group.active).length
  const state = thread.paused ? "Paused" : thread.turnActive ? "Working" : meta.lastTurnError ? "Last turn failed" : thread.archived ? "Archived" : "Ready"

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="border-b px-3 py-2">
        <h2 className="truncate font-heading text-base font-medium">{meta.title || "New thread"}</h2>
        <div className="mt-2 flex min-w-0 flex-wrap gap-1">
          <Badge
            variant={!thread.turnActive && meta.lastTurnError ? "destructive" : "secondary"}
            className={thread.turnActive ? "bg-primary/10 text-primary" : undefined}
          >
            {thread.turnActive ? <CircleDashedIcon aria-hidden className="animate-spin" /> : meta.lastTurnError ? <XCircleIcon aria-hidden /> : <CheckCircle2Icon aria-hidden />}
            {state}
          </Badge>
          {active > 0 && <Badge variant="secondary" className="bg-primary/10 text-primary">{active} active {active === 1 ? "agent" : "agents"}</Badge>}
        </div>
      </div>

      <div className="space-y-3 p-3">
        <Card size="sm" className="frame-2xl gap-0 py-0">
          <div className="frame-p-3 flex items-center gap-2 border-b">
            <span className="grid size-7 shrink-0 place-items-center rounded-inner bg-muted text-muted-foreground">
              <BotIcon aria-hidden className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{agent?.name ?? meta.agentId}</p>
              <p className="truncate text-xs text-muted-foreground">{profile?.name ?? meta.profileId}</p>
            </div>
          </div>
          <dl className="px-3 py-2">
            {/* Not `Metric`: there the value never shrinks, and a model id is the
                long half of this row, so here the label holds and the id truncates. */}
            <div className="flex min-w-0 items-baseline justify-between gap-2 border-b py-1 last:border-0"><dt className="shrink-0 text-xs text-muted-foreground">Model</dt><dd className="min-w-0 truncate text-right text-sm font-medium text-foreground" title={meta.model}>{model}</dd></div>
            {meta.effort && <Metric label="Effort" value={meta.effort[0].toUpperCase() + meta.effort.slice(1)} />}
          </dl>
        </Card>

        {project && (
          <InspectorCard title="Workspace" icon={<FolderIcon aria-hidden />}>
            <div className="flex min-w-0 items-start gap-2">
              <ProjectIcon project={project} className="size-7 rounded-inner" />
              <div className="min-w-0 pt-1">
                <p className="truncate text-sm font-medium">{project.name}</p>
                {project.cwd && <p className="mt-1 truncate font-mono text-xs text-muted-foreground" title={project.cwd}>{project.cwd}</p>}
                {project.description && <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">{project.description}</p>}
              </div>
            </div>
          </InspectorCard>
        )}

        {loaded.length > 0 && (
          <InspectorCard title={<>Loaded tools <Count>{loaded.length}</Count></>} icon={<PlugZapIcon aria-hidden />}>
            <LoadedToolRows tools={loaded} />
            <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><PlugZapIcon aria-hidden className="size-3" /> Loaded by tool searches in this thread</p>
          </InspectorCard>
        )}

        <InspectorCard title="Usage & performance" icon={<GaugeIcon aria-hidden />}>
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2 grid grid-cols-2 gap-2">
              <div className={INSPECTOR_TILE}>
                <p className="text-xs text-muted-foreground">Total tokens</p>
                <p className="mt-1 text-base font-medium leading-none tabular-nums">{thread.usage ? formatTokens(thread.usage.totalTokens) : "—"}</p>
              </div>
              <div className={INSPECTOR_TILE}>
                <p className="text-xs text-muted-foreground">Context window</p>
                <p className="mt-1 text-base font-medium leading-none tabular-nums">{contextPercent === null ? "—" : `${contextPercent}%`}</p>
                <p className="mt-1 truncate text-xs text-muted-foreground">{context ? `${formatTokens(context.used)} / ${contextCapacity}` : "Not reported"}</p>
              </div>
            </div>
            {contextPercent !== null && (
              <div className="col-span-2 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Context window used" aria-valuenow={contextPercent} aria-valuemin={0} aria-valuemax={100}>
                <div className={`h-full rounded-full transition-[width] ${contextPercent >= 85 ? "bg-destructive" : "bg-primary"}`} style={{ width: `${contextPercent}%` }} />
              </div>
            )}
          </div>
          <dl className="mt-2 divide-y">
            <Metric label="Turns / requests" value={`${turns} / ${requests}`} />
            <Metric label="Tools done / failed" value={`${completedTools} / ${failedTools}`} />
            <Metric label="Output / cached input" value={thread.usage ? `${formatTokens(thread.usage.outputTokens)} / ${formatTokens(cachedIn)}` : "—"} />
            <Metric label="Turn / tool time" value={`${elapsed ? formatDuration(elapsed) : "—"} / ${toolTime ? formatDuration(toolTime) : "—"}`} />
            <Metric
              label={average?.kind === "throughput" ? "Avg. throughput / first response" : "Avg. speed / first response"}
              value={`${(average && formatTps(average.rate)) ?? "—"} / ${thread.ttftMs === null ? "—" : `${thread.ttftMs}ms`}`}
            />
            <Metric label="Cache hit rate" value={cacheRate === null ? "—" : `${cacheRate}%`} />
            <Metric label="Subagent tokens" value={subagentUsage ? formatTokens(subagentUsage) : "—"} />
            {queued > 0 && <Metric label="Queued messages" value={String(queued)} />}
            {failedRows > 0 && <Metric label="Turn errors" value={String(failedRows)} />}
            {context?.cost && <Metric label="Reported cost" value={`${context.cost.amount.toFixed(2)} ${context.cost.currency}`} />}
          </dl>
          {thread.usage && <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><CoinsIcon aria-hidden className="size-3" /> Runtime-reported totals</p>}
        </InspectorCard>

        <InspectorCard title="Workflow runs" icon={<WorkflowIcon aria-hidden />}>
          {activeWorkflow && activeWorkflowStep && (
            <div className={cn("mb-2", INSPECTOR_TILE)}>
              <p className="text-xs font-medium text-primary">Now running</p>
              <p className="mt-1 truncate text-sm font-medium">{activeWorkflow.name} / {stepNameOf(activeWorkflowStep)}</p>
              <p className="truncate text-xs text-muted-foreground">{recentStepText(activeWorkflowStep)}</p>
            </div>
          )}
          <WorkflowPreview workflows={workflows} />
        </InspectorCard>

        <InspectorCard title="Thread history" icon={<ActivityIcon aria-hidden />}>
          <div className="space-y-2">
          <dl className="divide-y">
            <Metric label="Created" value={new Date(meta.createdAt).toLocaleDateString()} />
            <Metric label="Last activity" value={new Date(meta.lastActivityAt ?? meta.createdAt).toLocaleString()} />
            {meta.peerCount !== undefined && <Metric label="Connected devices" value={String(meta.peerCount)} />}
          </dl>
          {meta.lastTurnError && (
            <Notice tone="error" size="sm" copy={meta.lastTurnError}>
              <span className="line-clamp-3">{meta.lastTurnError}</span>
            </Notice>
          )}
          </div>
        </InspectorCard>
      </div>
    </div>
  )
}

/* Source control and the Monaco diff are a chunk of their own: a reader who
   never opens Changes never downloads either. */
const SourceControl = React.lazy(() => import("@/components/thread-view/source-control"))
const TracePanel = React.lazy(() => import("@/components/thread-view/trace-panel"))

/**
 * The thread inspector — the column beside the transcript that reads the thread
 * without scrolling it: what the last turn wrote, the plan, the subagents, and
 * what the thread runs on.
 *
 * **It is the chat panel's, never a dock split** — opening a panel never splits
 * the dock, and a column that belongs to one thread has no business being a
 * panel another thread could land beside. `docked` is a grid column of
 * `ThreadView` where the panel is wide; `sheet` is the same column laid over
 * the transcript where it is not. The composer's readings stay the readings;
 * this is where each is read in full.
 */
export function ThreadInspector({
  thread,
  meta,
  changes,
  mode,
  onClose,
  locate,
  maxWidth,
}: {
  thread: ThreadState
  meta: SessionMeta
  /** The newest gated turn's changes, picked by `ThreadView` — the same value
      `ChangesIndicator` draws. */
  changes?: TurnChanges
  mode: "docked" | "sheet"
  onClose: () => void
  /** The transcript row an item is drawn in — a subagent nested in a run or
      a workflow is inside a row of its own, and only rows can be scrolled to. */
  locate: (id: string) => string | undefined
  /** How wide the column may be dragged — the panel less a readable
      transcript. */
  maxWidth: number
}) {
  const prefs = inspectorPrefs.use()
  const modelCalls = useFeature("modelCalls")
  /* Rendered inside `ThreadView`'s scroller provider, so a jump is the rail's
     own gesture; a sheet gets out of the way of what it jumped to. */
  const scrollToMessage = useTranscriptJump()
  const onJump = (id: string) => {
    const row = locate(id)
    if (!row) return
    scrollToMessage(row, { align: "start", behavior: "smooth" })
    if (mode === "sheet") onClose()
  }
  const rows = React.useMemo(
    () => buildRows(thread.items, false, workLive(thread)),
    [thread.items, thread.turnActive, thread.background]
  )
  const groups = React.useMemo(() => activityGroups(rows), [rows])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the one field it reads
  const todos = React.useMemo(() => threadTodos(thread), [thread.items])
  const running = groups.filter((group) => group.active).length
  const done = todos?.filter((todo) => todo.status === "completed").length ?? 0

  /* The divider: the width is the device's (`lib/inspector.ts`), held here
     while dragging and written once on release — the IDE side view's bargain. */
  const [dragWidth, setDragWidth] = React.useState<number | null>(null)
  const clamp = (value: number) =>
    Math.round(
      Math.min(Math.max(INSPECTOR_MIN, value), Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, maxWidth)))
    )
  const width = clamp(dragWidth ?? prefs.width)

  /* The docked composer is an overlay of the grid root and has to stop at this
     column's edge, drag included — so the live width is published there. */
  const asideRef = React.useRef<HTMLElement>(null)
  React.useLayoutEffect(() => {
    const root = asideRef.current?.parentElement
    if (!root || mode !== "docked") return
    root.style.setProperty("--inspector-w", `${width}px`)
    return () => {
      root.style.removeProperty("--inspector-w")
    }
  }, [mode, width])

  return (
    <aside
      ref={asideRef}
      aria-label="Thread inspector"
      style={mode === "docked" ? { width } : undefined}
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden",
        mode === "docked"
          ? "relative col-start-2 row-span-3 row-start-1 border-l bg-background"
          : "absolute inset-y-0 right-0 z-40 w-[min(24rem,92%)] border-l bg-background"
      )}
    >
      {mode === "docked" && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the inspector"
          title="Drag to resize · double-click to reset"
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.currentTarget.setPointerCapture(event.pointerId)
            setDragWidth(width)
          }}
          onPointerMove={(event) => {
            if (dragWidth === null) return
            const right = event.currentTarget.parentElement?.getBoundingClientRect().right ?? event.clientX
            setDragWidth(clamp(right - event.clientX))
          }}
          onPointerUp={() => {
            if (dragWidth !== null) setInspectorPref("width", dragWidth)
            setDragWidth(null)
          }}
          onDoubleClick={() => setInspectorPref("width", INSPECTOR_DEFAULT)}
          className={cn(
            "absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none transition-colors hover:bg-primary/30",
            dragWidth !== null && "bg-primary/40"
          )}
        />
      )}
      <Tabs
        value={prefs.tab}
        onValueChange={(next) => setInspectorPref("tab", next as InspectorTab)}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <header className="flex shrink-0 items-center gap-1 border-b pt-[var(--dock-content-overlap,0px)] px-1">
          <TabsList variant="line" className="my-1 min-w-0 flex-1 justify-start overflow-x-auto">
            <TabsTrigger value="changes">
              Source Control
              {changes && changes.files.length > 0 && <Count>{changes.files.length}</Count>}
            </TabsTrigger>
            <TabsTrigger value="plan">
              Plan
              {todos && <Count>{`${done}/${todos.length}`}</Count>}
            </TabsTrigger>
            <TabsTrigger value="agents">
              Agents
              {groups.length > 0 && (
                <Count>{running > 0 ? `${running}/${groups.length}` : groups.length}</Count>
              )}
            </TabsTrigger>
            <TabsTrigger value="details">
              Details
            </TabsTrigger>
            {modelCalls && <TabsTrigger value="trace">Trace</TabsTrigger>}
          </TabsList>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onClose}
            aria-label="Hide the inspector"
            title="Hide the inspector"
          >
            <PanelRightCloseIcon aria-hidden />
          </Button>
        </header>

        {(["changes", "plan", "agents", "details", "trace"] as const).map((section) => (
          <TabsContent key={section} value={section} className="flex min-h-0 flex-1 flex-col">
            <ThreadSection section={section} thread={thread} meta={meta} onJump={onJump} />
          </TabsContent>
        ))}
      </Tabs>
    </aside>
  )
}

/** One of the inspector's readings on its own — a tab of the sheet here, a
    panel of its own in the thread dock (`workspace/thread-dock.tsx`), where
    each can be moved and resized beside the transcript. */
export type ThreadSectionKind = "changes" | "plan" | "agents" | "details" | "trace"

export function ThreadSection({
  section,
  thread,
  meta,
  onJump,
}: {
  section: ThreadSectionKind
  thread: ThreadState
  meta: SessionMeta
  /** Scroll the transcript to the row holding this item. */
  onJump: (id: string) => void
}) {
  const rows = React.useMemo(
    () => buildRows(thread.items, false, workLive(thread)),
    [thread.items, thread.turnActive, thread.background]
  )
  const groups = React.useMemo(() => activityGroups(rows), [rows])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the one field it reads
  const todos = React.useMemo(() => threadTodos(thread), [thread.items])

  if (section === "changes")
    return !meta.projectId ? (
      <div className="p-3">
        <Empty>This thread has no project, so there is no worktree to measure.</Empty>
      </div>
    ) : (
      <React.Suspense fallback={<PanelRowsSkeleton rows={5} className="py-1" />}>
        <SourceControl
          projectId={meta.projectId}
          repo={meta.worktree?.path}
        />
      </React.Suspense>
    )
  if (section === "plan")
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {todos ? <TodoChecklist items={todos} /> : <Empty>The agent has not written a plan in this thread.</Empty>}
      </div>
    )
  if (section === "agents") return <AgentsTab thread={thread} groups={groups} onJump={onJump} />
  if (section === "trace")
    return (
      <React.Suspense fallback={<PanelRowsSkeleton rows={5} className="py-1" />}>
        <TracePanel thread={thread} meta={meta} />
      </React.Suspense>
    )
  return <DetailsTab thread={thread} meta={meta} rows={rows} />
}
