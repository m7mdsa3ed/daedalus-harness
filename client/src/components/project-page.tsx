/* ── The project overview ── /projects/<id>
 *
 * A project is the one entity in this app that had no page of its own: it was
 * a row in settings (a form), a folder in the sidebar (a list) and a name in
 * the header of a thread — three places that each say a *part* of what a
 * workspace is, and none that answers "what is this project, and what has
 * happened in it".
 *
 * The page is deliberately assembled from two sources, and the split is the
 * design. The **live** half comes from the store: threads, which of them are
 * running or waiting on an answer, what agent and model they are on, what is
 * scheduled against them. That state is already streaming into this client, so
 * it needs no request and it is right the moment a turn starts. The **settled**
 * half — turns taken, the last time anything ran, what the workspace has
 * accumulated — exists only in the database and arrives as one
 * `GET /api/projects/:id/stats` (lib/workspace/project-stats.ts). One route, so
 * the page paints once; refetched on mount and by the Refresh control, and not
 * on a timer: nothing here is worth a poll, and the half that does move
 * (threads, running turns) is the half that already moves on its own.
 */
import { MENU_WIDTH } from "@/components/menu-row"
import * as React from "react"
import {
  ActivityIcon,
  AppWindowIcon,
  BotIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  FolderIcon,
  GitBranchIcon,
  MessagesSquareIcon,
  RocketIcon,
  Pencil,
  Play,
  PlayIcon,
  Plus,
  RefreshCwIcon,
  SquareTerminal,
  TriangleAlert,
  Trash2,
  WorkflowIcon,
  XIcon,
} from "lucide-react"
import { Navigate, useNavigate, useParams } from "react-router"
import { PageFrame, SurfaceHeader } from "@/components/page-primitives"
import { useFocusedRow, useWindowedRows } from "@/lib/windowed-rows"
import { Count, Group, Row, Section, StatStrip, StatusBadge } from "@/components/settings/primitives"
import { ErrorNote } from "@/components/error-note"
import { GroupRowsSkeleton } from "@/components/ui/skeletons"
import { Empty } from "@/components/empty"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/busy-button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { AgentIcon, ProfileIcon, ProjectIcon } from "@/components/entity-icon"
import { Notice } from "@/components/notice"
import { useConfirm } from "@/components/confirm-dialog"
import { ImportThreadsDialog } from "@/components/import-threads"
import { useStartThreadIn } from "@/components/thread-sidebar"
import type { Actions } from "@/lib/actions"
import { inlineFromQuery, reportError } from "@/lib/errors"
import { toast } from "@/lib/toast"
import { automationPath, automationsPath, settingsFormPath, settingsPath, threadPath } from "@/lib/router"
import { activityAt, isListed, type HelperCommand, type Project, type Routine, type SessionMeta } from "@/lib/settings"
import { useAgents, useProfiles, useProjects } from "@/lib/queries/catalog"
import { useServer } from "@/lib/server-context"
import { StatusDot } from "@/components/status-dot"
import { useStoreSelect, type ThreadState } from "@/lib/store"
import type { ThreadActivity } from "@/lib/thread/phase"
import { threadStatus } from "@/lib/thread/statuses"
import { shortAge } from "@/lib/time"
import { cn } from "@/lib/utils"
import { activityDays, type ProjectStats } from "@/lib/workspace/project-stats"
import { useProjectRepos, useProjectStats } from "@/lib/queries/surfaces"
import { useRunHelper } from "@/lib/workspace/use-run-helper"
import { useAutomationReads, useAutomations } from "@/lib/queries/automations"
import { SavedWorkflows } from "@/components/workflow/saved-workflows"
import { nextFireOf, triggersLine, untilLabel } from "@/components/automations/trigger-summary"

/** Matches the server's `ACTIVITY_DAYS`. The strip is drawn as a fixed run of
    days whatever came back, so a shorter answer simply leaves empty bars. */
const ACTIVITY_DAYS = 30

/** Threads shown before "Show all" — a long-running project has hundreds, and
    the overview is a summary with a way in, not the sidebar again. */
const THREAD_PAGE = 12

/** The selected row's start bar — the DataTable's, so a picked row reads the
    same in every list. */
const SELECTED_BAR =
  "before:pointer-events-none before:absolute before:inset-y-0 before:start-0 before:w-0.5 before:bg-primary before:opacity-0"

export function ProjectPage({ actions }: { actions: Actions }) {
  const { projectId = "" } = useParams()
  const project = useProjects().find((entry) => entry.id === projectId)
  /* A project id that is not in the store is a deleted project or a stale
     bookmark. There is nothing to show and nothing to fetch — the list is the
     honest destination. */
  if (!project) return <Navigate to={settingsPath("projects")} replace />
  return <ProjectOverview key={project.id} project={project} actions={actions} />
}

function ProjectOverview({ project, actions }: { project: Project; actions: Actions }) {
  /* The live half of the page, split by what moves it. `threads` is the one
     slice a streamed token replaces, and this page genuinely draws from it
     (the running/waiting dots), so it is subscribed to — but on its own, so a
     `automations` or `sessions` refresh no longer drags the rest in with it. */
  const sessions = useStoreSelect((store) => store.sessions)
  const allAutomations = useAutomations().data
  const liveThreads = useStoreSelect((store) => store.threads)
  const navigate = useNavigate()
  const startIn = useStartThreadIn(actions)
  const { stats, error, loading, refresh } = useProjectStats(project.id)
  const statsError = React.useMemo(
    () => inlineFromQuery(error, "Couldn't read this project's numbers"),
    [error]
  )
  const [importing, setImporting] = React.useState(false)

  /* Somewhere for a queued *panel* to land. A helper's terminal and the rules
     editor are panels, panels live in the dock, and the dock only exists on a
     thread route — so with no thread in this project yet, this opens an empty
     one. It is the same door the + takes (`actions.startThreadIn`); the draft
     is invisible to every list (`isListed`) until it is sent. */
  const openWorkspaceThread = () => {
    const id = actions.startThreadIn({ projectId: project.id })
    void navigate(id ? threadPath(id) : settingsPath("projects"))
  }

  /* No dock on this route, so the helper's terminal is queued for the thread
     we then go to — the same trade `openRules` below makes for the editor. */
  const startHelper = useRunHelper(null)
  const runHelper = async (helper: HelperCommand) => {
    if (!(await startHelper(helper, project.id))) return
    const latest = threads[0]
    if (latest) void navigate(threadPath(latest.id))
    else openWorkspaceThread()
  }

  /* The live half. Steps and unsent drafts are excluded exactly as they are
     everywhere else (`isListed`) — the one is reached from its parent's
     transcript and the other does not exist yet — and the trashed ones are
     counted but not listed: Trash is the sidebar's tier. */
  const { threads, trashed, running, waiting } = React.useMemo(() => {
    const mine = sessions.filter(isListed).filter((s) => s.projectId === project.id)
    const threads = mine
      .filter((s) => !s.deletedAt)
      .sort((a, b) => activityAt(b) - activityAt(a))
    const statusOf = (s: SessionMeta) => threadStatus(s, liveThreads[s.id])
    return {
      threads,
      trashed: mine.filter((s) => !!s.deletedAt).length,
      running: threads.filter((s) => statusOf(s) === "running").length,
      waiting: threads.filter((s) => statusOf(s) === "waiting").length,
    }
  }, [sessions, liveThreads, project.id])

  /* The project's standing instructions to the agent — Lovable calls this the
     knowledge base; here it is a file the agent already reads every turn, so
     the honest surface is the editor open on it rather than a second store
     that would have to be kept in step with the file. */
  const automations = React.useMemo(
    () => (allAutomations ?? []).filter((row) => row.projectId === project.id),
    [allAutomations, project.id]
  )

  return (
    <PageFrame width="wide">
        <ProjectHeader
          project={project}
          onNewThread={() => startIn(project)}
          onImport={() => setImporting(true)}
          onEdit={() => void navigate(settingsFormPath("projects", project.id))}
          onRefresh={refresh}
          refreshing={loading}
          onRunHelper={(helper) => void runHelper(helper)}
        />
        <ImportThreadsDialog
          open={importing}
          onOpenChange={setImporting}
          actions={actions}
          projectId={project.id}
        />

        <StatStrip
          stats={[
            {
              label: "Threads",
              value: (
                <span className="inline-flex items-center gap-2">
                  {threads.length}
                  {running > 0 ? (
                    <StatusBadge tone="ok">Running</StatusBadge>
                  ) : waiting > 0 ? (
                    <StatusBadge tone="warn">Waiting</StatusBadge>
                  ) : null}
                </span>
              ),
              hint:
                running > 0
                  ? `${running} running now`
                  : waiting > 0
                    ? `${waiting} waiting on you`
                    : trashed > 0
                      ? `${trashed} in trash`
                      : "none running",
            },
            {
              label: "Turns",
              value: stats?.turns ?? "—",
              loading: !stats && !error,
              hint: "across every thread",
            },
            {
              label: "Last active",
              value: stats?.lastActivityAt ? shortAge(stats.lastActivityAt) : "—",
              loading: !stats && !error,
              hint: stats?.lastActivityAt
                ? new Date(stats.lastActivityAt).toLocaleString()
                : "nothing has run here yet",
            },
            {
              label: "Knowledge",
              value: stats?.knowledge ?? "—",
              loading: !stats && !error,
              hint: stats?.knowledge === 1 ? "entry saved" : "entries saved",
            },
          ]}
        />

        {/* The one health answer the page can give. A project whose directory
            has moved or is not mounted spawns nothing, and the failure it
            produces otherwise arrives as an ENOENT inside a thread. */}
        {stats && !stats.cwdExists && (
          <Section>
            <Notice tone="error">
              The working directory does not exist on the server. Threads started here will fail to
              spawn — check the path in the project's settings.
            </Notice>
          </Section>
        )}
        {statsError && (
          <Section>
            <ErrorNote error={statsError} onRetry={refresh} />
          </Section>
        )}

        <QuickHelpersBar project={project} onRunHelper={(helper) => void runHelper(helper)} />

        <ActivityStrip stats={stats} />

        <div data-kit-block className="mt-8 grid gap-8 @panel-lg:grid-cols-[minmax(0,1fr)_18rem]">
          <ThreadsCard
            threads={threads}
            trashed={trashed}
            liveThreads={liveThreads}
            actions={actions}
            onOpen={(id) => void navigate(threadPath(id))}
            onNewThread={() => startIn(project)}
          />
          <div className="min-w-0">
            <RuntimesCard stats={stats} failed={!!error} />
            <AutomationsCard
              automations={automations}
              sessions={sessions}
              onOpen={(id) => void navigate(automationPath(id))}
              onManage={() => void navigate(automationsPath())}
            />
            {/* A run hangs on a thread, so the Run button names the project's newest. */}
            <SavedWorkflows
              projectId={project.id}
              sessionId={threads[0]?.id}
              onStarted={(id) => void navigate(threadPath(id))}
            />
            <GlanceCard stats={stats} trashed={trashed} failed={!!error} />
          </div>
        </div>
    </PageFrame>
  )
}

/* ── Pieces ── */

/* The branches the project is standing on, beside its path.
 *
 * A project is a directory, not a repository, so this is a *list*: the
 * project's own checkout if it has one, plus the ones one walk down its
 * subdirectories — which is the answer `git/repos` already gives, branch
 * included, so there is nothing to derive here. A repo below the project
 * wears its own name, because "main" twice says nothing about which is which;
 * the project's own repo is just its branch. Past three, the rest is a count —
 * the SCM panel is where a long list is read.
 *
 * Nothing is drawn when there is no repository at all: absence of git is not
 * news on a project page. */
function ProjectBranches({ projectId }: { projectId: string }) {
  const { data } = useProjectRepos(projectId)
  const repos = data ?? []
  if (repos.length === 0) return null
  const shown = repos.slice(0, 3)

  return (
    <>
      {shown.map((repo) => (
        <Badge
          key={repo.path}
          variant="outline"
          title={`${repo.path || "Project"} — ${repo.branch ?? "detached HEAD"}`}
          className="max-w-full text-muted-foreground"
        >
          <GitBranchIcon />
          {repos.length > 1 && repo.path && <span className="truncate text-foreground">{repo.name}</span>}
          <span className="truncate font-mono font-normal">{repo.branch ?? "detached"}</span>
        </Badge>
      ))}
      {repos.length > shown.length && (
        <span className="text-xs text-muted-foreground">+{repos.length - shown.length} more</span>
      )}
    </>
  )
}

/* The header's "Run" dropdown — the project's own commands, and the way back
   to Settings › Projects to edit them, so the dropdown is self-contained even
   for a project with none yet. */
function HelpersMenu({
  project,
  onRunHelper,
}: {
  project: Project
  onRunHelper: (helper: HelperCommand) => void
}) {
  const navigate = useNavigate()
  const helpers = project.helpers ?? []

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" title="Run a command for this project">
            <SquareTerminal data-icon="inline-start" />
            <span>Run</span>
            {helpers.length > 0 && (
              <Count>{helpers.length}</Count>
            )}
          </Button>
        }
      />
      <DropdownMenuContent align="end" className={MENU_WIDTH}>
        {/* DropdownMenuLabel is Base UI's Menu.GroupLabel: it reads its group
            from context and throws outside one, so the label and its items are
            wrapped together rather than sitting loose in the content. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center justify-between">
            <span>Project commands</span>
            {helpers.length > 0 && <span className="tabular-nums">{helpers.length} configured</span>}
          </DropdownMenuLabel>
          {helpers.map((helper) => (
            <DropdownMenuItem
              key={helper.id}
              onClick={() => onRunHelper(helper)}
              title={helper.description ?? undefined}
            >
              <Play className="size-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{helper.name}</span>
              {helper.confirm && (
                <TriangleAlert className="size-3 shrink-0 text-warning" aria-hidden />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void navigate(settingsFormPath("projects", project.id))}>
          <Pencil className="size-4 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">Manage helpers…</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * A horizontal interactive strip of quick helper chips shown below the header
 * whenever the workspace has helpers configured.
 */
function QuickHelpersBar({
  project,
  onRunHelper,
}: {
  project: Project
  onRunHelper: (helper: HelperCommand) => void
}) {
  const navigate = useNavigate()
  const helpers = project.helpers ?? []

  if (helpers.length === 0) return null

  return (
    <Section
      label="Quick actions"
      action={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void navigate(settingsFormPath("projects", project.id))}
          title="Configure helper commands"
        >
          <Pencil data-icon="inline-start" />
          Edit
        </Button>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        {helpers.map((helper) => (
          <Button
            key={helper.id}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onRunHelper(helper)}
            title={helper.description ?? helper.command}
          >
            <Play data-icon="inline-start" className="text-primary" />
            <span>{helper.name}</span>
            {/* The same mark the Run menu carries: a chip is one tap from a
                destructive command, so "asks first" has to be visible before it. */}
            {helper.confirm && <TriangleAlert data-icon="inline-end" className="text-warning" aria-hidden />}
          </Button>
        ))}
      </div>
    </Section>
  )
}

function ProjectHeader({
  project,
  onNewThread,
  onImport,
  onEdit,
  onRefresh,
  refreshing,
  onRunHelper,
}: {
  project: Project
  onNewThread: () => void
  onImport: () => void
  onEdit: () => void
  onRefresh: () => void
  refreshing: boolean
  onRunHelper: (helper: HelperCommand) => void
}) {
  const [copied, setCopied] = React.useState(false)
  const copy = async () => {
    try {
      await writeClipboard(project.cwd)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // A clipboard the browser refused is not worth an error card; the path
      // is on screen and selectable either way.
    }
  }

  return (
    <SurfaceHeader
      icon={<ProjectIcon project={project} className="size-10" />}
      title={<span className="block truncate">{project.name}</span>}
      description={project.description || undefined}
      meta={
        <>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => void copy()}
            title="Copy working directory"
            className="max-w-full text-muted-foreground"
          >
            <span className="min-w-0 truncate font-mono font-normal">{project.cwd}</span>
            {copied ? <CheckIcon data-icon="inline-end" /> : <CopyIcon data-icon="inline-end" />}
          </Button>
          <ProjectBranches projectId={project.id} />
        </>
      }
      actions={
        <>
          <Button variant="ghost" size="icon" title="Refresh" loading={refreshing} onClick={onRefresh}>
            <RefreshCwIcon className={cn(refreshing && "animate-spin")} />
            <span className="sr-only">Refresh</span>
          </Button>
          <HelpersMenu project={project} onRunHelper={onRunHelper} />
          <Button variant="outline" onClick={onImport}>
            <DownloadIcon data-icon="inline-start" /> Import
          </Button>
          <Button variant="outline" onClick={onEdit}>
            <Pencil data-icon="inline-start" /> Edit
          </Button>
          <Button onClick={onNewThread}>
            <Plus data-icon="inline-start" /> New thread
          </Button>
        </>
      }
    />
  )
}

/** Turns per day for the last month. Dependency-free bars, one per day,
    heights normalised to the busiest day — the shape is the reading, the
    numbers are in each bar's title. */
function ActivityStrip({ stats }: { stats: ProjectStats | null }) {
  const days = React.useMemo(
    () => (stats ? activityDays(stats.activity, ACTIVITY_DAYS) : []),
    [stats]
  )
  const peak = Math.max(1, ...days.map((d) => d.turns))
  const total = days.reduce((sum, d) => sum + d.turns, 0)

  return (
    <Group
      label="Activity"
      hint={
        stats
          ? `${total} ${total === 1 ? "turn" : "turns"} in the last ${ACTIVITY_DAYS} days`
          : `The last ${ACTIVITY_DAYS} days`
      }
    >
      <div className="py-4">
        <div className="flex h-16 items-end gap-0.5">
          {(stats ? days : Array.from({ length: ACTIVITY_DAYS }, () => null)).map((day, i) =>
            day ? (
              <div
                key={day.day}
                title={`${day.day} · ${day.turns} ${day.turns === 1 ? "turn" : "turns"}`}
                className={cn(
                  "min-h-0.5 flex-1 rounded-t-sm transition-colors",
                  day.turns > 0 ? "bg-primary/80 hover:bg-primary" : "bg-muted"
                )}
                style={{ height: `${day.turns > 0 ? Math.max(8, (day.turns / peak) * 100) : 3}%` }}
              />
            ) : (
              <div key={i} className="h-0.5 flex-1 rounded-t-sm bg-muted" />
            )
          )}
        </div>
        <div className="mt-2 flex justify-between text-xs text-muted-foreground">
          <span>{ACTIVITY_DAYS} days ago</span>
          <span>today</span>
        </div>
      </div>
    </Group>
  )
}

function ThreadsCard({
  threads,
  trashed,
  liveThreads,
  actions,
  onOpen,
  onNewThread,
}: {
  threads: SessionMeta[]
  trashed: number
  liveThreads: Record<string, ThreadState>
  actions: Actions
  onOpen: (id: string) => void
  onNewThread: () => void
}) {
  const [all, setAll] = React.useState(false)
  const shown = all ? threads : threads.slice(0, THREAD_PAGE)
  const {
    selecting,
    selected,
    busy,
    toggle,
    start: startSelecting,
    cancel,
    selectAll,
    deleteSelected,
  } = useThreadSelection(threads, shown, actions)
  /* Only "Show all" can make this long; past 150 rows it is windowed against
     the page's own scroller, keeping the row focus last landed in mounted. */
  const ul = React.useRef<HTMLUListElement>(null)
  const [focus, onFocus] = useFocusedRow(shown.length, (i) => shown[i].id)
  const w = useWindowedRows({
    count: shown.length,
    threshold: 150,
    list: ul,
    estimateSize: () => 49,
    getItemKey: (i) => shown[i].id,
    measured: true,
    pin: [focus],
  })

  return (
    <Group
      label="Threads"
      count={threads.length}
      action={
        selecting ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground tabular-nums">
              {selected.size} selected
            </span>
            <Button variant="ghost" size="sm" onClick={selectAll} disabled={busy}>
              {selected.size === shown.length ? "Select none" : "Select all"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void deleteSelected()}
              disabled={selected.size === 0}
              loading={busy}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 data-icon="inline-start" /> Delete
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={cancel} disabled={busy} aria-label="Cancel selection">
              <XIcon />
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {threads.length > 0 && (
              <Button variant="ghost" size="sm" onClick={startSelecting}>
                Select
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onNewThread}>
              <Plus data-icon="inline-start" /> New
            </Button>
          </div>
        )
      }
    >
      {threads.length === 0 ? (
        <Empty
          size="sm"
          icon={MessagesSquareIcon}
          className="my-3"
          action={
            <Button size="sm" onClick={onNewThread}>
              <Plus data-icon="inline-start" /> Start thread
            </Button>
          }
        >
          No threads in this project yet. Start a new thread to begin working on this workspace with your AI agents.
        </Empty>
      ) : (
        <ul
          ref={ul}
          className="divide-y"
          onFocus={onFocus}
        >
          {w.rows.map(({ index, before }) => {
            const session = shown[index]
            const status = threadStatus(session, liveThreads[session.id])
            const checked = selected.has(session.id)
            return (
              <li
                key={session.id}
                data-index={index}
                ref={w.measure}
                style={{ marginTop: before || undefined }}
                aria-setsize={w.windowed ? shown.length : undefined}
                aria-posinset={w.windowed ? index + 1 : undefined}
              >
                <div
                  className={cn(
                    "relative -mx-3 flex items-center gap-3 px-3 transition-colors hover:bg-muted/50 @panel-sm:-mx-4 @panel-sm:px-4",
                    SELECTED_BAR,
                    selecting && checked && "bg-primary/5 before:opacity-100 hover:bg-primary/5"
                  )}
                >
                  {selecting && (
                    <Checkbox
                      checked={checked}
                      disabled={busy}
                      onCheckedChange={() => toggle(session.id)}
                      aria-label={`Select ${session.title || "untitled thread"}`}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => (selecting ? toggle(session.id) : onOpen(session.id))}
                    disabled={busy}
                    className="flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-lg py-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
                  >
                    {!selecting && <StatusDot status={status} />}
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block break-words text-sm font-medium @panel-sm:truncate",
                          status === "running" && !selecting && "harness-shimmer"
                        )}
                      >
                        {session.title || "Untitled thread"}
                      </span>
                      <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <AgentIcon agentId={session.agentId} className="size-3" />
                          <span className="truncate">{session.model || session.agentId}</span>
                        </span>
                      </span>
                    </span>
                    <span
                      className="shrink-0 text-xs text-muted-foreground tabular-nums"
                      title={new Date(activityAt(session)).toLocaleString()}
                    >
                      {shortAge(activityAt(session))}
                    </span>
                  </button>
                </div>
              </li>
            )
          })}
          {w.after > 0 && <li aria-hidden style={{ height: w.after }} />}
        </ul>
      )}
      {(threads.length > THREAD_PAGE || trashed > 0) && (
        <footer className="flex items-center justify-between gap-2 py-2 text-xs text-muted-foreground">
          {threads.length > THREAD_PAGE ? (
            <Button type="button" variant="link" size="xs" className="h-auto px-0" onClick={() => setAll((v) => !v)}>
              {all ? "Show fewer" : `Show all ${threads.length}`}
            </Button>
          ) : (
            <span />
          )}
          {trashed > 0 && (
            <span className="flex items-center gap-1">
              <Trash2 aria-hidden className="size-3" /> {trashed} in trash
            </span>
          )}
        </footer>
      )}
    </Group>
  )
}

/* ── Selecting several threads at once ──
   Deleting a project's threads was a per-row operation reached from the
   sidebar's context menu, which is fine for one and absurd for twenty — a
   project that has been worked in for a month is exactly where the tidying
   happens. Selection is a *mode* rather than a checkbox column that is always
   there: the ordinary reading of this list is one click per row into a thread,
   and a permanent column of checkboxes would put a target in front of that.

   "Select all" means the rows that are *shown*, never the whole list behind a
   "Show all" the reader has not pressed: a button that deletes rows nobody has
   seen is the one thing a bulk action must not do. Deletion is the reversible
   one (Trash, restorable) exactly as the single-row action is, so the undo is
   the Trash tier rather than a promise this card makes. */
function useThreadSelection(threads: SessionMeta[], shown: SessionMeta[], actions: Actions) {
  const confirm = useConfirm()
  const [selecting, setSelecting] = React.useState(false)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [busy, setBusy] = React.useState(false)

  /* A thread deleted elsewhere — or one that arrived while the mode was open —
     must not stay selected: the ids are what the delete is dispatched from. */
  const liveIds = React.useMemo(() => new Set(threads.map((s) => s.id)), [threads])
  React.useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => liveIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [liveIds])

  const cancel = React.useCallback(() => {
    setSelecting(false)
    setSelected(new Set())
  }, [])

  const toggle = React.useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  const selectAll = React.useCallback(() => {
    setSelected((prev) =>
      prev.size === shown.length ? new Set() : new Set(shown.map((s) => s.id))
    )
  }, [shown])

  const deleteSelected = React.useCallback(async () => {
    const ids = [...selected]
    if (ids.length === 0) return
    if (
      !(await confirm({
        title: ids.length === 1 ? "Delete this thread?" : `Delete ${ids.length} threads?`,
        description:
          "Their agent processes are stopped and they move to Trash, where they can be restored.",
        confirmLabel: "Delete",
        destructive: true,
      }))
    )
      return
    setBusy(true)
    try {
      await actions.deleteThreads(ids)
      toast("Moved to Trash", {
        description: ids.length === 1 ? "1 thread" : `${ids.length} threads`,
      })
      cancel()
    } catch (err) {
      reportError(err, "Couldn't delete the threads")
    } finally {
      setBusy(false)
    }
  }, [selected, confirm, actions, cancel])

  return {
    selecting,
    selected,
    busy,
    toggle,
    start: () => setSelecting(true),
    cancel,
    selectAll,
    deleteSelected,
  }
}

/** What this project is actually worked on with — threads per agent and per
    profile. Ids come down from the server; the names are in the store. */
function RuntimesCard({ stats, failed }: { stats: ProjectStats | null; failed: boolean }) {
  const agents = useAgents()
  const profiles = useProfiles()
  // A failed read is said once, above; a skeleton here would wait forever.
  if (!stats) return failed ? null : <GroupRowsSkeleton rows={2} label />
  if (stats.byAgent.length === 0 && stats.byProfile.length === 0) return null

  return (
    <Group label="Worked on with">
        {stats.byAgent.map((entry) => (
          <MiniRow
            key={`agent:${entry.id}`}
            icon={<AgentIcon agentId={entry.id} className="size-4" />}
            label={agents.find((a) => a.id === entry.id)?.name ?? entry.id}
            value={entry.threads}
          />
        ))}
        {stats.byProfile.map((entry) => {
          const profile = profiles.find((p) => p.id === entry.id)
          return (
            <MiniRow
              key={`profile:${entry.id}`}
              icon={<ProfileIcon profile={profile} className="size-4" />}
              label={profile?.name ?? entry.id}
              value={entry.threads}
            />
          )
        })}
    </Group>
  )
}

function AutomationsCard({
  automations,
  sessions,
  onOpen,
  onManage,
}: {
  automations: Routine[]
  sessions: SessionMeta[]
  onOpen: (id: string) => void
  onManage: () => void
}) {
  const { triggers } = useAutomationReads(automations)
  if (automations.length === 0) return null
  return (
    <Group
      label="Automations"
      count={automations.length}
      action={
        <Button variant="ghost" size="sm" onClick={onManage}>
          Manage
        </Button>
      }
    >
      <ul className="divide-y">
        {automations.slice(0, 4).map((row) => {
          const next = row.enabled ? nextFireOf(triggers[row.id]) : null
          return (
            <li key={row.id} className="-mx-3 @panel-sm:-mx-4">
              <button
                type="button"
                className="block min-h-12 w-full px-3 py-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50 @panel-sm:px-4"
                onClick={() => onOpen(row.id)}
              >
                <p className="truncate text-sm font-medium" title={row.name}>
                  {row.name}
                </p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {!row.enabled ? "Paused" : next !== null ? `Next ${untilLabel(next)}` : triggersLine(triggers[row.id]) || "…"} ·{" "}
                  {row.runsIn === "session"
                    ? (sessions.find((s) => s.id === row.sessionId)?.title ?? "thread")
                    : "new thread each time"}
                </p>
              </button>
            </li>
          )
        })}
      </ul>
    </Group>
  )
}

/** The counts that are worth having but not worth a tile: what the workspace
    has accumulated beside its threads. Rows with nothing in them are left out
    — a column of zeroes says "this feature is off", which is not the reading. */
function GlanceCard({ stats, trashed, failed }: { stats: ProjectStats | null; trashed: number; failed: boolean }) {
  if (!stats) return failed ? null : <GroupRowsSkeleton rows={3} label />

  const rows: { icon: React.ReactElement; label: string; value: React.ReactNode }[] = []
  if (stats.threads.firstAt)
    rows.push({
      icon: <FolderIcon className="size-4 text-muted-foreground" />,
      label: "First thread",
      value: shortAge(stats.threads.firstAt),
    })
  if (stats.workflows.total)
    rows.push({
      icon: <WorkflowIcon className="size-4 text-muted-foreground" />,
      label: "Workflow runs",
      value: stats.workflows.running
        ? `${stats.workflows.total} · ${stats.workflows.running} running`
        : stats.workflows.total,
    })
  if (stats.threads.steps)
    rows.push({
      icon: <BotIcon className="size-4 text-muted-foreground" />,
      label: "Workflow steps",
      value: stats.threads.steps,
    })
  if (stats.webSearch.searches || stats.webSearch.fetches)
    rows.push({
      icon: <ActivityIcon className="size-4 text-muted-foreground" />,
      label: "Web search",
      value: `${stats.webSearch.searches} · ${stats.webSearch.fetches} fetched`,
    })
  if (trashed)
    rows.push({
      icon: <Trash2 className="size-4 text-muted-foreground" />,
      label: "In trash",
      value: trashed,
    })
  if (rows.length === 0) return null

  return (
    <Group label="At a glance">
      {rows.map((row) => (
        <MiniRow key={row.label} icon={row.icon} label={row.label} value={row.value} />
      ))}
    </Group>
  )
}

function MiniRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactElement
  label: string
  value: React.ReactNode
}) {
  return (
    <Row icon={icon} title={label}>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </Row>
  )
}

import { writeClipboard } from "@/lib/clipboard"
