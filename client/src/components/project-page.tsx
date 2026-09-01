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
import * as React from "react"
import {
  ActivityIcon,
  AlertTriangleIcon,
  BookOpenIcon,
  BotIcon,
  CalendarClockIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  FolderIcon,
  MessagesSquareIcon,
  Pencil,
  Plus,
  RefreshCwIcon,
  Trash2,
  WorkflowIcon,
  XIcon,
} from "lucide-react"
import { Navigate, useNavigate, useParams } from "react-router"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Skeleton } from "@/components/ui/skeleton"
import { AgentIcon, ProfileIcon, ProjectIcon } from "@/components/entity-icon"
import { useConfirm } from "@/components/confirm-dialog"
import { ImportThreadsDialog } from "@/components/import-threads"
import { useStartThreadIn } from "@/components/thread-sidebar"
import type { Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import { toast } from "@/lib/toast"
import { settingsFormPath, settingsPath, schedulesPath, threadPath } from "@/lib/router"
import { scheduleWhen } from "@/lib/schedule"
import { activityAt, isTopLevel, type Project, type ScheduledMessage, type SessionMeta } from "@/lib/settings"
import { useAgents, useProfiles, useProjects } from "@/lib/queries/catalog"
import { useStoreSelect, type ThreadState } from "@/lib/store"
import { IDLE_PHASE, markFor, type ThreadActivity } from "@/lib/thread/phase"
import { shortAge } from "@/lib/time"
import { cn } from "@/lib/utils"
import { activityDays, type ProjectStats } from "@/lib/workspace/project-stats"
import { useProjectStats } from "@/lib/queries/surfaces"
import { useScheduled } from "@/lib/queries/routines"

/** Matches the server's `ACTIVITY_DAYS`. The strip is drawn as a fixed run of
    days whatever came back, so a shorter answer simply leaves empty bars. */
const ACTIVITY_DAYS = 30

/** Threads shown before "Show all" — a long-running project has hundreds, and
    the overview is a summary with a way in, not the sidebar again. */
const THREAD_PAGE = 12

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
     `scheduled` or `sessions` refresh no longer drags the rest in with it. */
  const sessions = useStoreSelect((store) => store.sessions)
  const allScheduled = useScheduled().data ?? []
  const liveThreads = useStoreSelect((store) => store.threads)
  const navigate = useNavigate()
  const startIn = useStartThreadIn(actions)
  const { stats, error, loading, refresh } = useProjectStats(project.id)
  const [importing, setImporting] = React.useState(false)

  /* The live half. Steps are excluded exactly as they are everywhere else —
     they are reached from their parent's transcript, never listed — and the
     trashed ones are counted but not listed: Trash is the sidebar's tier. */
  const { threads, trashed, running, waiting } = React.useMemo(() => {
    const mine = sessions.filter(isTopLevel).filter((s) => s.projectId === project.id)
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

  const scheduled = React.useMemo(() => {
    const ids = new Set(
      sessions.filter((s) => s.projectId === project.id).map((s) => s.id)
    )
    return allScheduled
      .filter((row) => ids.has(row.sessionId))
      .sort((a, b) => a.nextAt - b.nextAt)
  }, [allScheduled, sessions, project.id])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 pt-6 pb-16 sm:px-8">
        <ProjectHeader
          project={project}
          onNewThread={() => startIn(project)}
          onImport={() => setImporting(true)}
          onEdit={() => void navigate(settingsFormPath("projects", project.id))}
          onRefresh={refresh}
          refreshing={loading}
        />
        <ImportThreadsDialog
          open={importing}
          onOpenChange={setImporting}
          actions={actions}
          projectId={project.id}
        />

        {/* The one health answer the page can give. A project whose directory
            has moved or is not mounted spawns nothing, and the failure it
            produces otherwise arrives as an ENOENT inside a thread. */}
        {stats && !stats.cwdExists && (
          <Banner tone="destructive" icon={AlertTriangleIcon}>
            The working directory does not exist on the server. Threads started here will fail to
            spawn — check the path in the project's settings.
          </Banner>
        )}
        {error && (
          <Banner tone="muted" icon={AlertTriangleIcon}>
            {error}{" "}
            <button type="button" className="underline" onClick={refresh}>
              Try again
            </button>
          </Banner>
        )}

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile
            icon={MessagesSquareIcon}
            label="Threads"
            value={threads.length}
            hint={
              running > 0
                ? `${running} running now`
                : waiting > 0
                  ? `${waiting} waiting on you`
                  : trashed > 0
                    ? `${trashed} in trash`
                    : "none running"
            }
          />
          <Tile
            icon={ActivityIcon}
            label="Turns"
            value={stats?.turns}
            loading={!stats}
            hint="across every thread"
          />
          <Tile
            icon={CalendarClockIcon}
            label="Last active"
            value={stats?.lastActivityAt ? shortAge(stats.lastActivityAt) : "—"}
            loading={!stats}
            hint={
              stats?.lastActivityAt
                ? new Date(stats.lastActivityAt).toLocaleString()
                : "nothing has run here yet"
            }
          />
          <Tile
            icon={BookOpenIcon}
            label="Knowledge"
            value={stats?.knowledge}
            loading={!stats}
            hint={stats?.knowledge === 1 ? "entry saved" : "entries saved"}
          />
        </div>

        <ActivityStrip stats={stats} />

        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <ThreadsCard
            threads={threads}
            trashed={trashed}
            liveThreads={liveThreads}
            actions={actions}
            onOpen={(id) => void navigate(threadPath(id))}
            onNewThread={() => startIn(project)}
          />
          <div className="space-y-4">
            <RuntimesCard stats={stats} />
            <ScheduledCard
              scheduled={scheduled}
              sessions={sessions}
              onOpenSchedules={() => void navigate(schedulesPath())}
            />
            <GlanceCard stats={stats} trashed={trashed} />
          </div>
        </div>
      </div>
    </div>
  )
}

/** The same reading the sidebar and the dock tabs take — literally the same
    function, so three surfaces cannot drift into three answers about one
    thread. The live thread is the truth about a running turn, and
    `promptActive` is the only signal for one this client has never connected. */
function threadStatus(session: SessionMeta, thread: ThreadState | undefined): ThreadActivity {
  const waiting = !!thread && !!(thread.permission || thread.elicitation)
  return markFor(
    thread?.phase ?? IDLE_PHASE,
    thread?.turnActive ?? session.promptActive,
    waiting,
    !!session.lastTurnError
  )
}

/* ── Pieces ── */

function ProjectHeader({
  project,
  onNewThread,
  onImport,
  onEdit,
  onRefresh,
  refreshing,
}: {
  project: Project
  onNewThread: () => void
  onImport: () => void
  onEdit: () => void
  onRefresh: () => void
  refreshing: boolean
}) {
  const [copied, setCopied] = React.useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(project.cwd)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // A clipboard the browser refused is not worth an error card; the path
      // is on screen and selectable either way.
    }
  }

  return (
    <div className="flex flex-wrap items-start gap-4">
      <ProjectIcon project={project} className="size-11 shrink-0" />
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-xl font-semibold tracking-tight">{project.name}</h1>
        <button
          type="button"
          onClick={() => void copy()}
          title="Copy the working directory"
          className="mt-1 flex max-w-full items-center gap-1.5 rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="truncate font-mono">{project.cwd}</span>
          {copied ? (
            <CheckIcon className="size-3 shrink-0" />
          ) : (
            <CopyIcon className="size-3 shrink-0 opacity-60" />
          )}
        </button>
        {project.description && (
          <p className="mt-2 max-w-prose text-sm text-pretty text-muted-foreground">
            {project.description}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="ghost" size="icon" title="Refresh" onClick={onRefresh}>
          <RefreshCwIcon className={cn(refreshing && "animate-spin")} />
          <span className="sr-only">Refresh</span>
        </Button>
        {/* Work started in a terminal is still work in this project — the way
            in is beside the way to start new work. */}
        <Button variant="outline" onClick={onImport}>
          <DownloadIcon /> Import
        </Button>
        <Button variant="outline" onClick={onEdit}>
          <Pencil /> Edit
        </Button>
        <Button onClick={onNewThread}>
          <Plus /> New thread
        </Button>
      </div>
    </div>
  )
}

function Banner({
  tone,
  icon: Icon,
  children,
}: {
  tone: "destructive" | "muted"
  icon: typeof AlertTriangleIcon
  children: React.ReactNode
}) {
  return (
    <p
      className={cn(
        "mt-4 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
        tone === "destructive"
          ? "border-destructive/30 bg-destructive/5 text-destructive"
          : "text-muted-foreground"
      )}
    >
      <Icon className="mt-px size-3.5 shrink-0" />
      <span className="text-pretty">{children}</span>
    </p>
  )
}

/** One number, its name and a line saying what the number is about. The value
    is skeletoned rather than zeroed while the fetch is out: a 0 that turns
    into 400 is a statement the page made and then took back. */
function Tile({
  icon: Icon,
  label,
  value,
  hint,
  loading,
}: {
  icon: typeof ActivityIcon
  label: string
  value: React.ReactNode
  hint: string
  loading?: boolean
}) {
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className="mt-1.5 text-2xl font-semibold tabular-nums">
        {loading ? <Skeleton className="h-7 w-16" /> : value}
      </div>
      <p className="mt-0.5 truncate text-xs text-muted-foreground" title={hint}>
        {hint}
      </p>
    </div>
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
    <section className="mt-4 rounded-xl border bg-card p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">Activity</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {stats ? `${total} turns · last ${ACTIVITY_DAYS} days` : "…"}
        </span>
      </div>
      <div className="mt-3 flex h-16 items-end gap-[3px]">
        {(stats ? days : Array.from({ length: ACTIVITY_DAYS }, () => null)).map((day, i) =>
          day ? (
            <div
              key={day.day}
              title={`${day.day} · ${day.turns} ${day.turns === 1 ? "turn" : "turns"}`}
              className={cn(
                "min-h-[2px] flex-1 rounded-sm transition-colors",
                day.turns > 0 ? "bg-primary/70 hover:bg-primary" : "bg-muted"
              )}
              style={{ height: `${day.turns > 0 ? Math.max(8, (day.turns / peak) * 100) : 2}%` }}
            />
          ) : (
            <div key={i} className="h-[2px] flex-1 rounded-sm bg-muted" />
          )
        )}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground">
        <span>{ACTIVITY_DAYS} days ago</span>
        <span>today</span>
      </div>
    </section>
  )
}

function CardShell({
  title,
  count,
  action,
  children,
}: {
  title: string
  count?: number
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border bg-card">
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        <h2 className="text-sm font-medium">{title}</h2>
        {count != null && (
          <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
        )}
        {action && <div className="ml-auto">{action}</div>}
      </header>
      {children}
    </section>
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

  return (
    <CardShell
      title="Threads"
      count={threads.length}
      action={
        selecting ? (
          <div className="flex items-center gap-1">
            <span className="mr-1 text-xs text-muted-foreground tabular-nums">
              {selected.size} selected
            </span>
            <Button variant="ghost" size="sm" onClick={selectAll} disabled={busy}>
              {selected.size === shown.length ? "Select none" : "Select all"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void deleteSelected()}
              disabled={busy || selected.size === 0}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 /> {busy ? "Deleting…" : "Delete"}
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={cancel} disabled={busy} aria-label="Cancel selection">
              <XIcon />
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            {threads.length > 0 && (
              <Button variant="ghost" size="sm" onClick={startSelecting}>
                Select
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onNewThread}>
              <Plus /> New
            </Button>
          </div>
        )
      }
    >
      {threads.length === 0 ? (
        <p className="px-4 py-8 text-center text-xs text-muted-foreground">
          No threads in this project yet.
        </p>
      ) : (
        <ul className="divide-y">
          {shown.map((session) => {
            const status = threadStatus(session, liveThreads[session.id])
            const checked = selected.has(session.id)
            return (
              <li key={session.id}>
                <div
                  className={cn(
                    "flex w-full items-center gap-3 px-4 transition-colors",
                    selecting && checked && "bg-accent/30"
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
                    className="flex min-w-0 flex-1 items-center gap-3 py-2 text-left transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none disabled:opacity-60"
                  >
                    {!selecting && <StatusDot status={status} />}
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block truncate text-sm",
                          status === "running" && !selecting && "harness-shimmer"
                        )}
                      >
                        {session.title || "Untitled thread"}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <AgentIcon agentId={session.agentId} className="size-3" />
                        <span className="truncate">{session.model || session.agentId}</span>
                      </span>
                    </span>
                    <span
                      className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
                      title={new Date(activityAt(session)).toLocaleString()}
                    >
                      {shortAge(activityAt(session))}
                    </span>
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {(threads.length > THREAD_PAGE || trashed > 0) && (
        <footer className="flex items-center justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
          {threads.length > THREAD_PAGE ? (
            <button type="button" className="underline" onClick={() => setAll((v) => !v)}>
              {all ? "Show fewer" : `Show all ${threads.length}`}
            </button>
          ) : (
            <span />
          )}
          {trashed > 0 && (
            <span className="flex items-center gap-1">
              <Trash2 className="size-3" /> {trashed} in trash
            </span>
          )}
        </footer>
      )}
    </CardShell>
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

/** One dot, five colours: working, needs you, a turn that ended badly,
    something is wrong with the connection, and everything else. The connection tints are what a list could
    not say at all before — a thread mid-reconnect drew the same grey dot as one
    sitting quietly, which is the reading this page exists to give. */
function StatusDot({ status }: { status: ThreadActivity }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        status === "running"
          ? "bg-primary"
          : status === "waiting"
            ? "bg-amber-500"
            : status === "failed"
              ? "bg-destructive"
              : status === "reconnecting" || status === "offline" || status === "gone"
                ? "bg-muted-foreground/70 animate-pulse"
                : "bg-muted-foreground/30"
      )}
    >
      <span className="sr-only">{status}</span>
    </span>
  )
}

/** What this project is actually worked on with — threads per agent and per
    profile. Ids come down from the server; the names are in the store. */
function RuntimesCard({ stats }: { stats: ProjectStats | null }) {
  const agents = useAgents()
  const profiles = useProfiles()
  if (!stats) return <CardShell title="Worked on with"><CardSkeleton rows={2} /></CardShell>
  if (stats.byAgent.length === 0 && stats.byProfile.length === 0) return null

  return (
    <CardShell title="Worked on with">
      <ul className="divide-y">
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
      </ul>
    </CardShell>
  )
}

function ScheduledCard({
  scheduled,
  sessions,
  onOpenSchedules,
}: {
  scheduled: ScheduledMessage[]
  sessions: SessionMeta[]
  onOpenSchedules: () => void
}) {
  if (scheduled.length === 0) return null
  return (
    <CardShell
      title="Scheduled"
      count={scheduled.length}
      action={
        <Button variant="ghost" size="sm" onClick={onOpenSchedules}>
          Manage
        </Button>
      }
    >
      <ul className="divide-y">
        {scheduled.slice(0, 4).map((row) => (
          <li key={row.id} className="px-4 py-2">
            <p className="truncate text-xs" title={row.text}>
              {row.text}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {row.enabled ? scheduleWhen(row.nextAt, row.everyMs) : "Paused"} ·{" "}
              {sessions.find((s) => s.id === row.sessionId)?.title ?? "thread"}
            </p>
          </li>
        ))}
      </ul>
    </CardShell>
  )
}

/** The counts that are worth having but not worth a tile: what the workspace
    has accumulated beside its threads. Rows with nothing in them are left out
    — a column of zeroes says "this feature is off", which is not the reading. */
function GlanceCard({ stats, trashed }: { stats: ProjectStats | null; trashed: number }) {
  if (!stats) return <CardShell title="At a glance"><CardSkeleton rows={3} /></CardShell>

  const rows: { icon: React.ReactNode; label: string; value: React.ReactNode }[] = []
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
  if (stats.previews)
    rows.push({
      icon: <ActivityIcon className="size-4 text-muted-foreground" />,
      label: "Saved previews",
      value: stats.previews,
    })
  if (trashed)
    rows.push({
      icon: <Trash2 className="size-4 text-muted-foreground" />,
      label: "In trash",
      value: trashed,
    })
  if (rows.length === 0) return null

  return (
    <CardShell title="At a glance">
      <ul className="divide-y">
        {rows.map((row) => (
          <MiniRow key={row.label} icon={row.icon} label={row.label} value={row.value} />
        ))}
      </ul>
    </CardShell>
  )
}

function MiniRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
}) {
  return (
    <li className="flex items-center gap-2 px-4 py-2">
      {icon}
      <span className="min-w-0 flex-1 truncate text-xs">{label}</span>
      <span className="shrink-0 text-xs font-medium tabular-nums">{value}</span>
    </li>
  )
}

function CardSkeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-4 w-full" />
      ))}
    </div>
  )
}
