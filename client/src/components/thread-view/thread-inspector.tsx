import type { ReactNode } from "react"
import {
  ActivityIcon,
  BotIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  CoinsIcon,
  FolderIcon,
  GaugeIcon,
  PanelRightCloseIcon,
  WorkflowIcon,
  XCircleIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { ProjectIcon } from "@/components/entity-icon"
import { stepNameOf, stepStateOf } from "@/components/workflow-run"
import type { SessionMeta } from "@/lib/settings"
import type { ThreadItem, ThreadState } from "@/lib/store"
import { formatDuration, formatRate, formatTokens, promptTokens } from "@/lib/tokens"
import { buildRows, type Row, type SubagentGroup, type WorkflowGroup } from "@/lib/transcript-rows"
import { extractSubagent, toolHeading } from "@/lib/tools"
import { useAgents, usePersonas, useProfiles, useProjects } from "@/lib/queries/catalog"

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
    const latest = [...group.children].reverse().find((row) => row.kind === "tool" || row.kind === "run")
    if (latest?.kind === "tool") return toolHeading(latest).title
    if (latest?.kind === "run") {
      const tool = [...latest.items].reverse().find((item) => item.kind === "tool")
      if (tool) return toolHeading(tool).title
    }
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

function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border border-border/60 bg-card/55">
      <h2 className="flex items-center gap-1.5 border-b border-border/50 px-2.5 py-1.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        <span className="grid size-4 place-items-center rounded bg-muted/70 text-foreground/75">{icon}</span>
        {title}
      </h2>
      <div className="p-2.5">{children}</div>
    </section>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2 border-b border-border/40 py-1 last:border-0">
      <dt className="min-w-0 truncate text-[10px] text-muted-foreground">{label}</dt>
      <dd className="shrink-0 truncate text-[11px] font-semibold tabular-nums text-foreground" title={value}>{value}</dd>
    </div>
  )
}

function RecentSteps({ groups }: { groups: SubagentGroup[] }) {
  const recent = [...groups].sort((a, b) => b.head.startedAt - a.head.startedAt).slice(0, 5)
  if (recent.length === 0) return <p className="text-xs text-muted-foreground">No subagent steps yet.</p>

  return (
    <ul className="divide-y divide-border/40">
      {recent.map((group) => (
        <li key={group.id} className="flex min-w-0 gap-2 px-0.5 py-1.5">
          <span className={`mt-1 size-1.5 shrink-0 rounded-full ${group.active ? "animate-pulse bg-primary" : "bg-border"}`} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="min-w-0 truncate font-medium">{stepNameOf(group)}</span>
              <span className={group.active ? "shrink-0 text-primary" : "shrink-0 text-muted-foreground"}>
                {group.active ? "Working" : stepStateOf(group)}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[10px] leading-4 text-muted-foreground">
              {recentStepText(group)}
            </p>
          </div>
        </li>
      ))}
    </ul>
  )
}

function WorkflowPreview({ workflows }: { workflows: WorkflowGroup[] }) {
  const recent = [...workflows].reverse().slice(0, 3)
  if (recent.length === 0) return <p className="text-xs text-muted-foreground">No workflow runs yet.</p>

  return (
    <ul className="space-y-1.5">
      {recent.map((workflow) => {
        const progress = workflowProgress(workflow)
        const status = progress.active ? "Running" : progress.failed ? "Failed" : "Complete"
        const percent = progress.total ? Math.min(100, (progress.completed / progress.total) * 100) : 0
        return (
          <li key={workflow.id} className="rounded-md border border-border/50 bg-background/35 px-2 py-1.5">
            <div className="flex min-w-0 items-center justify-between gap-2 text-[11px]">
              <span className="min-w-0 truncate font-medium">{workflow.name}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {progress.completed}/{progress.total}
              </span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`${workflow.name}: ${status}`} aria-valuenow={progress.completed} aria-valuemin={0} aria-valuemax={progress.total || 1}>
              <div
                className={`h-full rounded-full transition-[width] ${progress.failed ? "bg-destructive" : progress.active ? "bg-primary" : "bg-foreground/50"}`}
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="mt-1 text-[9px] text-muted-foreground">{status}{progress.failed ? ` · ${progress.failed} failed` : ""}</p>
          </li>
        )
      })}
    </ul>
  )
}

export function ThreadInspector({
  thread,
  meta,
  onClose,
}: {
  thread: ThreadState
  meta: SessionMeta
  onClose: () => void
}) {
  const agents = useAgents()
  const profiles = useProfiles()
  const projects = useProjects()
  const personas = usePersonas()
  const rows = buildRows(thread.items, false, thread.turnActive)
  const workflows = workflowGroups(rows)
  const groups = activityGroups(rows)
  const requests = thread.items.filter((item) => item.kind === "user").length
  const turns = thread.turns.length || requests
  const context = thread.context
  const contextPercent = context && context.size > 0 ? Math.min(100, Math.round((context.used / context.size) * 100)) : null
  const contextCapacity = context ? formatTokens(context.size) : null
  const measured = Object.entries(thread.turnUsage).filter(([id]) => thread.turnDuration[id] !== undefined)
  const measuredOutput = measured.reduce((sum, [, usage]) => sum + usage.outputTokens, 0)
  const measuredDuration = measured.reduce((sum, [id]) => sum + (thread.turnDuration[id] ?? 0), 0)
  const ownItems = thread.items.filter((item) => !item.parentId)
  const tools = ownItems.filter((item) => item.kind === "tool")
  const completedTools = tools.filter((item) => item.status === "completed").length
  const failedTools = tools.filter((item) => item.status === "failed").length
  const subagentUsage = groups.reduce((total, group) => {
    if (group.head.kind === "subagent" && group.head.usage) return total + group.head.usage.totalTokens
    return total
  }, 0)
  const queued = thread.queue.length
  const failedRows = ownItems.filter((item) => item.kind === "error").length
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
  const persona = personas.find((item) => item.id === meta.personaId)
  const model = profile?.models.find((item) => item.id === meta.model)?.label ?? meta.model
  const active = groups.filter((group) => group.active).length
  const state = thread.paused ? "Paused" : thread.turnActive ? "Working" : meta.lastTurnError ? "Last turn failed" : thread.archived ? "Archived" : "Ready"

  return (
    <aside className="hidden min-h-0 min-w-0 flex-col overflow-hidden border-l border-border/60 bg-background/35 @panel-xl:col-start-2 @panel-xl:row-start-1 @panel-xl:row-span-3 @panel-xl:flex">
      <header className="shrink-0 border-b border-border/60 bg-card/35 pl-3 pr-2.5 pb-2 pt-[var(--dock-content-overlap,0px)]">
        <div className="mt-2.5 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Thread details</p>
            <h2 className="mt-1 truncate text-sm font-semibold">{meta.title || "New thread"}</h2>
          </div>
          <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Hide thread sidebar" title="Hide thread sidebar">
            <PanelRightCloseIcon aria-hidden className="size-4" />
          </Button>
        </div>
        <div className="mt-2 flex min-w-0 flex-wrap gap-1">
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium ${thread.turnActive ? "bg-primary/10 text-primary" : meta.lastTurnError ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}>
            {thread.turnActive ? <CircleDashedIcon aria-hidden className="size-3 animate-spin" /> : meta.lastTurnError ? <XCircleIcon aria-hidden className="size-3" /> : <CheckCircle2Icon aria-hidden className="size-3" />}
            {state}
          </span>
          {active > 0 && <span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary">{active} active {active === 1 ? "agent" : "agents"}</span>}
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-2.5 py-2.5">
        <section className="overflow-hidden rounded-lg border border-border/60 bg-card shadow-sm">
          <div className="bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-2.5">
            <div className="flex items-center gap-2">
              <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-primary/10 bg-background/75 text-primary shadow-sm">
                <BotIcon aria-hidden className="size-3.5" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{agent?.name ?? meta.agentId}</p>
                <p className="truncate text-[11px] text-muted-foreground">{profile?.name ?? meta.profileId}</p>
              </div>
            </div>
          </div>
          <dl className="space-y-0 px-2.5 py-1 text-[11px]">
            <div className="flex min-w-0 justify-between gap-3 border-b border-border/40 py-1.5"><dt className="shrink-0 text-muted-foreground">Model</dt><dd className="truncate text-right font-medium" title={meta.model}>{model}</dd></div>
            {meta.effort && <div className="flex justify-between gap-3 border-b border-border/40 py-1.5 last:border-0"><dt className="text-muted-foreground">Effort</dt><dd className="font-medium capitalize">{meta.effort}</dd></div>}
            {persona && <div className="flex justify-between gap-3 py-1.5"><dt className="text-muted-foreground">Persona</dt><dd className="truncate font-medium">{persona.name}</dd></div>}
          </dl>
        </section>

        {project && (
          <Section title="Workspace" icon={<FolderIcon aria-hidden className="size-3.5" />}>
            <div className="flex min-w-0 items-start gap-2">
              <ProjectIcon project={project} className="size-7 rounded-lg" />
              <div className="min-w-0 pt-0.5">
                <p className="truncate text-[11px] font-medium">{project.name}</p>
                {project.cwd && <p className="mt-0.5 truncate font-mono text-[9px] leading-3.5 text-muted-foreground" title={project.cwd}>{project.cwd}</p>}
                {project.description && <p className="mt-1.5 line-clamp-3 text-[10px] leading-3.5 text-muted-foreground">{project.description}</p>}
              </div>
            </div>
          </Section>
        )}

        <Section title="Usage & performance" icon={<GaugeIcon aria-hidden className="size-3.5" />}>
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2 grid grid-cols-2 gap-2">
              <div className="rounded-md bg-muted/45 px-2 py-1.5">
                <p className="text-[9px] text-muted-foreground">Total tokens</p>
                <p className="mt-0.5 text-base font-semibold leading-none tabular-nums">{thread.usage ? formatTokens(thread.usage.totalTokens) : "—"}</p>
              </div>
              <div className="rounded-md bg-muted/45 px-2 py-1.5">
                <p className="text-[9px] text-muted-foreground">Context window</p>
                <p className="mt-0.5 text-base font-semibold leading-none tabular-nums">{contextPercent === null ? "—" : `${contextPercent}%`}</p>
                <p className="mt-0.5 truncate text-[9px] text-muted-foreground">{context ? `${formatTokens(context.used)} / ${contextCapacity}` : "Not reported"}</p>
              </div>
            </div>
            {contextPercent !== null && (
              <div className="col-span-2 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Context window used" aria-valuenow={contextPercent} aria-valuemin={0} aria-valuemax={100}>
                <div className={`h-full rounded-full transition-[width] ${contextPercent >= 85 ? "bg-destructive" : "bg-primary"}`} style={{ width: `${contextPercent}%` }} />
              </div>
            )}
          </div>
          <dl className="mt-1.5 divide-y divide-border/40">
            <Metric label="Turns / requests" value={`${turns} / ${requests}`} />
            <Metric label="Tools done / failed" value={`${completedTools} / ${failedTools}`} />
            <Metric label="Output / cached input" value={thread.usage ? `${formatTokens(thread.usage.outputTokens)} / ${formatTokens(cachedIn)}` : "—"} />
            <Metric label="Turn / tool time" value={`${elapsed ? formatDuration(elapsed) : "—"} / ${toolTime ? formatDuration(toolTime) : "—"}`} />
            <Metric label="Avg. speed / first response" value={`${formatRate(measuredOutput, measuredDuration) ?? "—"} / ${thread.ttftMs === null ? "—" : `${thread.ttftMs}ms`}`} />
            <Metric label="Cache hit rate" value={cacheRate === null ? "—" : `${cacheRate}%`} />
            <Metric label="Subagent tokens" value={subagentUsage ? formatTokens(subagentUsage) : "—"} />
            {queued > 0 && <Metric label="Queued messages" value={String(queued)} />}
            {failedRows > 0 && <Metric label="Turn errors" value={String(failedRows)} />}
            {context?.cost && <Metric label="Reported cost" value={`${context.cost.amount.toFixed(2)} ${context.cost.currency}`} />}
          </dl>
          {thread.usage && <p className="mt-1 flex items-center gap-1 text-[9px] text-muted-foreground"><CoinsIcon aria-hidden className="size-3" /> Runtime-reported totals</p>}
        </Section>

        <Section title="Recent subagents" icon={<BotIcon aria-hidden className="size-3.5" />}>
          <RecentSteps groups={groups} />
        </Section>

        <Section title="Workflow runs" icon={<WorkflowIcon aria-hidden className="size-3.5" />}>
          {activeWorkflow && activeWorkflowStep && (
            <div className="mb-2 rounded-md bg-primary/5 px-2 py-1.5">
              <p className="text-[9px] font-medium uppercase tracking-wide text-primary">Now running</p>
              <p className="mt-0.5 truncate text-[11px] font-medium">{activeWorkflow.name} / {stepNameOf(activeWorkflowStep)}</p>
              <p className="truncate text-[10px] text-muted-foreground">{recentStepText(activeWorkflowStep)}</p>
            </div>
          )}
          <WorkflowPreview workflows={workflows} />
        </Section>

        <Section title="Thread history" icon={<ActivityIcon aria-hidden className="size-3.5" />}>
          <dl className="divide-y divide-border/40">
            <Metric label="Created" value={new Date(meta.createdAt).toLocaleDateString()} />
            <Metric label="Last activity" value={new Date(meta.lastActivityAt ?? meta.createdAt).toLocaleString()} />
            {meta.peerCount !== undefined && <Metric label="Connected devices" value={String(meta.peerCount)} />}
          </dl>
          {meta.lastTurnError && (
            <p className="mt-2 flex gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-2.5 py-2 text-[11px] leading-4 text-destructive">
              <XCircleIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span className="line-clamp-3">{meta.lastTurnError}</span>
            </p>
          )}
        </Section>
      </div>
    </aside>
  )
}
