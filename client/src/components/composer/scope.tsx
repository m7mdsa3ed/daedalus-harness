/* ── The scope bar and its panel ──
   The strip's foot: where the thread runs, what it carries and every reading of
   it, as one line of tinted segments — and, when a segment is picked, that
   segment's detail expanded in flow above the line (`ScopePanel`). Nothing here
   is a popover: the model, the tools, the checklist, the window all open *in*
   the strip and push the card down.

   Which segments exist is one answer (`useScopeReadings`), read by the bar to
   draw them and to fold a panel whose reading has gone quiet — a checklist
   that finished is not a panel left open onto nothing. */
import * as React from "react"
import {
  Bot,
  CheckIcon,
  FileDiff,
  Gauge,
  GitBranch,
  ListChecks,
  Loader2,
  PlusIcon,
  Wrench,
  XIcon,
} from "lucide-react"

import { ProjectIcon } from "@/components/entity-icon"
import { DraftConfigPanel, WorktreeChip, useDraft } from "@/components/draft-config"
import { SessionConfigPanel } from "@/components/session-config"
import { ThreadToolsPanel } from "@/components/thread-tools/menu"
import { useThreadToolCount } from "@/components/thread-tools/use-thread-tool-count"
import { AgentsPanel, runningAgents } from "@/components/composer/agents-indicator"
import { ChangesPanel } from "@/components/composer/changes-indicator"
import { ConfigPanel, configReading } from "@/components/composer/config-indicator"
import { ConnectionPanel, connectionNote } from "@/components/composer/connection-indicator"
import { ContextPanel } from "@/components/composer/context-indicator"
import { RepoPanel } from "@/components/composer/repo-indicator"
import { TodoPanel, threadTodos } from "@/components/composer/todo-indicator"
import type { Actions } from "@/lib/actions"
import { useNewProject } from "@/lib/catalog-add"
import { useProjectRepos } from "@/lib/queries/surfaces"
import type { SessionMeta } from "@/lib/settings"
import type { ThreadState } from "@/lib/store"
import type { TurnChanges } from "@/lib/workspace/git-api"
import { cn } from "@/lib/utils"

export type ScopeTab =
  | "connection"
  | "project"
  | "model"
  | "tools"
  | "config"
  | "todos"
  | "agents"
  | "changes"
  | "repo"
  | "context"

const TITLES: Record<ScopeTab, string> = {
  connection: "Connection",
  project: "Project",
  model: "Model",
  tools: "Tools",
  config: "Settings change",
  todos: "Checklist",
  agents: "Subagents",
  changes: "Last turn's changes",
  repo: "Repository",
  context: "Context window",
}

/** Every reading the bar can draw, or null where it has nothing to say. */
function useScopeReadings(meta: SessionMeta, thread: ThreadState, changes: TurnChanges | undefined, draft: boolean) {
  const toolCount = useThreadToolCount(meta)
  const branch = useProjectRepos(meta.projectId ?? "").data?.[0]?.branch ?? null
  const todos = threadTodos(thread)
  const agents = runningAgents(thread).length
  const context = thread.context
  return {
    connection: connectionNote(thread),
    tools: draft || toolCount > 0 ? toolCount : null,
    config: configReading(thread),
    todos: todos
      ? { done: todos.filter((todo) => todo.status === "completed").length, total: todos.length }
      : null,
    agents: agents > 0 ? agents : null,
    changes: changes && changes.files.length > 0 ? changes.files.length : null,
    repo: branch,
    context:
      context && context.size > 0
        ? Math.min(100, Math.max(0, Math.round((context.used / context.size) * 100)))
        : null,
  }
}

type ScopeReadings = ReturnType<typeof useScopeReadings>

/** Whether `tab` still has something to show. Project and model always do. */
function tabAvailable(tab: ScopeTab, readings: ScopeReadings): boolean {
  if (tab === "project" || tab === "model") return true
  return readings[tab] !== null
}

/* The ground every segment stands on, applied by the bar to its direct
   children — so a control that renders nothing (the worktree chip on a folder
   that is not a repository) leaves no empty segment behind. */
const SEGMENTS =
  "[&>*]:flex [&>*]:h-6 [&>*]:shrink-0 [&>*]:items-center [&>*]:gap-1 [&>*]:rounded-md! [&>*]:bg-foreground/[0.06] [&>*]:px-1.5 [&>*]:transition-colors [&>*:hover]:bg-foreground/[0.1] [&>[aria-pressed=true]]:bg-background [&>[aria-pressed=true]]:text-foreground [&>[aria-pressed=true]]:shadow-sm"

function Segment({
  tab,
  open,
  onOpen,
  title,
  className,
  children,
}: {
  tab: ScopeTab
  open: ScopeTab | null
  onOpen: (tab: ScopeTab | null) => void
  title: string
  className?: string
  children: React.ReactNode
}) {
  const active = open === tab
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-expanded={active}
      title={title}
      onClick={() => onOpen(active ? null : tab)}
      className={cn("tabular-nums", className)}
    >
      {children}
    </button>
  )
}

export function ScopeBar({
  meta,
  thread,
  changes,
  actions,
  draft,
  open,
  onOpen,
}: {
  meta: SessionMeta
  thread: ThreadState
  changes?: TurnChanges
  actions: Actions
  draft: boolean
  open: ScopeTab | null
  onOpen: (tab: ScopeTab | null) => void
}) {
  const { project, configure } = useDraft(meta, actions)
  const r = useScopeReadings(meta, thread, changes, draft)
  /* A panel onto a reading that has gone quiet folds itself. */
  const stale = open !== null && !tabAvailable(open, r)
  React.useEffect(() => {
    if (stale) onOpen(null)
  }, [stale, onOpen])
  const seg = { open, onOpen }
  return (
    <div
      role="toolbar"
      aria-label="Thread scope"
      className={cn(
        "flex min-w-0 items-center gap-1 overflow-x-auto px-0.5 text-[11px] text-muted-foreground [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        SEGMENTS
      )}
    >
      {r.connection && (
        <Segment {...seg} tab="connection" title={r.connection.title} className={CONNECTION_TONE[r.connection.tone]}>
          {r.connection.icon}
          <span className="max-w-32 truncate">{r.connection.label}</span>
        </Segment>
      )}
      <Segment {...seg} tab="project" title={project?.cwd ?? "Project"} className="min-w-0 shrink! font-medium text-foreground/80">
        <ProjectIcon project={project} className="size-3.5 shrink-0" />
        <span className="max-w-40 truncate">{project?.name ?? "No project"}</span>
      </Segment>
      <WorktreeChip meta={meta} editable={draft} onToggle={(isolate) => configure({ isolate })} />
      {r.tools !== null && (
        <Segment {...seg} tab="tools" title="Tools this thread carries">
          <Wrench className="size-3 shrink-0" />
          {r.tools > 0 ? r.tools : "Tools"}
        </Segment>
      )}
      <span aria-hidden className="ms-auto size-0! bg-transparent! p-0!" />
      {r.config && (
        <Segment {...seg} tab="config" title={r.config.title} className="text-primary">
          <Loader2 className={cn("size-3 shrink-0", r.config.label.startsWith("Applying") && "animate-spin")} />
          {r.config.label}
        </Segment>
      )}
      {r.todos && (
        <Segment {...seg} tab="todos" title={`Checklist — ${r.todos.done} of ${r.todos.total} done`}>
          <ListChecks className="size-3 shrink-0" />
          {r.todos.done}/{r.todos.total}
        </Segment>
      )}
      {r.agents !== null && (
        <Segment {...seg} tab="agents" title={`${r.agents} subagent${r.agents === 1 ? "" : "s"} running`} className="text-primary">
          <Bot className="size-3 shrink-0" />
          {r.agents}
        </Segment>
      )}
      {r.changes !== null && (
        <Segment {...seg} tab="changes" title={`The last turn changed ${r.changes} file${r.changes === 1 ? "" : "s"}`}>
          <FileDiff className="size-3 shrink-0" />
          {r.changes}
        </Segment>
      )}
      {r.repo !== null && (
        <Segment {...seg} tab="repo" title={`On branch ${r.repo}`}>
          <GitBranch className="size-3 shrink-0" />
          <span className="max-w-24 truncate">{r.repo}</span>
        </Segment>
      )}
      {r.context !== null && (
        <Segment
          {...seg}
          tab="context"
          title={`Context window ${r.context}% full`}
          className={cn(r.context >= 90 ? "text-destructive" : r.context >= 75 && "text-amber-600 dark:text-amber-400")}
        >
          <Gauge className="size-3 shrink-0" />
          {r.context}%
        </Segment>
      )}
    </div>
  )
}

const CONNECTION_TONE = {
  neutral: "text-muted-foreground",
  info: "text-sky-600 dark:text-sky-400",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-destructive",
} as const

/** One segment's detail, in flow: a title with a close, then the body. */
export function ScopePanel({
  tab,
  onClose,
  sessionId,
  meta,
  thread,
  actions,
  changes,
  draft,
}: {
  tab: ScopeTab
  onClose: () => void
  sessionId: string
  meta: SessionMeta
  thread: ThreadState
  actions: Actions
  changes?: TurnChanges
  draft: boolean
}) {
  const done = onClose
  return (
    <section aria-label={TITLES[tab]} className="flex flex-col">
      <header className="flex items-center gap-2 px-3 pt-2 pb-1">
        <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{TITLES[tab]}</h3>
        <button
          type="button"
          onClick={onClose}
          title="Close"
          className="ms-auto grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      </header>
      <div className="max-h-[min(45svh,24rem)] overflow-y-auto overscroll-contain px-2 pb-2 text-sm">
        {tab === "connection" && <ConnectionPanel thread={thread} sessionId={sessionId} actions={actions} onDone={done} />}
        {tab === "project" && <ProjectPanel meta={meta} actions={actions} draft={draft} onDone={done} />}
        {tab === "model" &&
          (draft ? (
            <DraftConfigPanel meta={meta} actions={actions} />
          ) : (
            <SessionConfigPanel sessionId={sessionId} actions={actions} thread={thread} />
          ))}
        {tab === "tools" && <ThreadToolsPanel meta={meta} actions={actions} editable={draft} />}
        {tab === "config" && <ConfigPanel thread={thread} sessionId={sessionId} actions={actions} onDone={done} />}
        {tab === "todos" && <TodoPanel thread={thread} onDone={done} />}
        {tab === "agents" && <AgentsPanel thread={thread} onDone={done} />}
        {tab === "changes" && changes && <ChangesPanel changes={changes} onDone={done} />}
        {tab === "repo" && <RepoPanel meta={meta} onDone={done} />}
        {tab === "context" && <ContextPanel thread={thread} meta={meta} actions={actions} onDone={done} />}
      </div>
    </section>
  )
}

/* Where the work lands. A draft picks from every project (and can make one);
   a started thread's project is its cwd and only reads out. */
function ProjectPanel({
  meta,
  actions,
  draft,
  onDone,
}: {
  meta: SessionMeta
  actions: Actions
  draft: boolean
  onDone: () => void
}) {
  const { projects, project, configure } = useDraft(meta, actions)
  const newProject = useNewProject()
  if (!draft) {
    return (
      <div className="flex flex-col gap-1 px-1 text-xs">
        <span className="flex items-center gap-2 font-medium">
          <ProjectIcon project={project} className="size-4" />
          {project?.name ?? "No project"}
        </span>
        {project?.cwd && <span className="font-mono text-[11px] text-muted-foreground">{project.cwd}</span>}
        {meta.worktree && (
          <span className="text-muted-foreground">
            Isolated on branch <span className="font-mono">{meta.worktree.branch}</span>
            {meta.worktree.exists === false && " (worktree removed)"}
          </span>
        )}
      </div>
    )
  }
  const pick = (id: string) => {
    configure({ projectId: id })
    onDone()
  }
  return (
    <div role="radiogroup" aria-label="Project" className="flex flex-col">
      {projects.map((p) => (
        <button
          key={p.id}
          type="button"
          role="radio"
          aria-checked={p.id === project?.id}
          onClick={() => pick(p.id)}
          className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-muted"
        >
          <ProjectIcon project={p} className="size-4 shrink-0" />
          <span className="min-w-0 truncate">{p.name}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">{p.cwd}</span>
          {p.id === project?.id && <CheckIcon className="size-3.5 shrink-0 text-primary" />}
        </button>
      ))}
      <button
        type="button"
        onClick={() => newProject((id) => pick(id))}
        className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <PlusIcon className="size-4" />
        New project…
      </button>
    </div>
  )
}
