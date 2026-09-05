/* ── Import threads ──
   Conversations that already exist in an agent's own store — everything started
   in `claude`, `codex` or `opencode` outside the harness — offered as threads.

   The whole feature is a pointer: a harness thread is a row naming an ACP
   session, and reviving one is `session/load`. So nothing here copies a
   transcript. Importing writes rows; the first time one is opened it takes the
   ordinary revive path and the history streams in, is journaled, and is indexed
   for search exactly as if it had always been here.

   The list comes from ACP's own `session/list` (see server/src/session-list.ts),
   which all three runtimes implement — no runtime's files are read — and it is
   machine-wide, so it arrives grouped by the directory each conversation ran
   in. A directory the harness knows is a project and its rows are importable; a
   directory it does not is offered with a project to create, because a thread
   without a project has no cwd to run in.

   This is also the recovery surface: the agent's store outlives the harness's
   own rows, so a thread lost here — deleted, or a database restored from an
   older backup — is still in the runtime and comes back through this dialog.
   That is what the filters are for. A machine-wide list runs to hundreds of
   rows and a scan answers newest-first; finding the handful from the window
   that went missing means narrowing by *when* and by *what is still missing*,
   which is why "Not here yet" and a time window are the defaults rather than
   options. A row already in Trash is not re-imported (that would duplicate the
   conversation) — it is restored, from its own row. */
import * as React from "react"
import { useNavigate } from "react-router"
import {
  ChevronRightIcon,
  FolderPlus,
  Loader2,
  RefreshCwIcon,
  RotateCcwIcon,
  SearchIcon,
} from "lucide-react"
import { toast } from "@/lib/toast"
import { AgentIcon, ProfileIcon, ProjectIcon } from "@/components/entity-icon"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ErrorNote } from "@/components/error-note"
import { captureError, type InlineError } from "@/lib/errors"
import {
  baseName,
  createProjectAt,
  importSessions,
  listImportable,
  normalizeCwd,
  type ImportableSession,
} from "@/lib/import-sessions"
import { threadPath } from "@/lib/router"
import { profileSupports, type Project } from "@/lib/settings"
import type { Actions } from "@/lib/actions"
import { useAgents, useInvalidateCatalog, useProfiles, useProjects } from "@/lib/queries/catalog"
import { defaultToolPicks, loadThreadDefaults, resolveThreadStart } from "@/lib/thread-defaults"
import { shortAge } from "@/lib/time"
import { cn } from "@/lib/utils"

/** A directory's worth of conversations, and the project that owns it. */
interface CwdGroup {
  cwd: string
  project: Project | null
  sessions: ImportableSession[]
  /** How many of `sessions` this scan could actually import — the number every
      "Select all" acts on, and the one worth printing. */
  newCount: number
}

/** What a row's state is, in the one word the filters and the badge share. */
type RowState = "new" | "imported" | "trashed"

const rowState = (session: ImportableSession): RowState =>
  !session.existing ? "new" : session.existing.deleted ? "trashed" : "imported"

/* ── Filters ──
   Three narrow questions rather than one clever search box: which rows, from
   when, in what order. Each is a plain value so the whole filter state is
   comparable — `isFiltered` below is what lets an empty list say *why* it is
   empty and offer the way out. */
type StatusFilter = "new" | "trashed" | "imported" | "all"
type SinceFilter = "any" | "1d" | "7d" | "30d" | "90d"
type SortOrder = "recent" | "oldest" | "title"

const STATUS_LABEL: Record<StatusFilter, string> = {
  new: "Not here yet",
  trashed: "In Trash",
  imported: "Already here",
  all: "Everything",
}
const SINCE_LABEL: Record<SinceFilter, string> = {
  any: "Any time",
  "1d": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
}
const SORT_LABEL: Record<SortOrder, string> = {
  recent: "Newest first",
  oldest: "Oldest first",
  title: "By title",
}
/** How far back each window reaches, in ms. `any` has no bound. */
const SINCE_MS: Record<Exclude<SinceFilter, "any">, number> = {
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
}

/** The moment a row was last touched, or NaN — the runtimes are allowed to
    answer without one, and a row with no date is never filtered *out* by a
    window it cannot be compared against. */
const updatedAt = (session: ImportableSession) =>
  session.updatedAt ? Date.parse(session.updatedAt) : NaN

export function ImportThreadsDialog({
  open,
  onOpenChange,
  actions,
  /** Opened from a project: its group sorts first and is expanded. */
  projectId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  actions: Actions
  projectId?: string
}) {
  const invalidate = useInvalidateCatalog()
  /* Three catalogs, each on its own subscription. Named `all*` because the
     dialog narrows both down to the pairs that can actually be scanned. */
  const allProfiles = useProfiles()
  const projects = useProjects()
  const allAgents = useAgents()
  const navigate = useNavigate()

  const [agentId, setAgentId] = React.useState("")
  const [profileId, setProfileId] = React.useState("")
  const [sessions, setSessions] = React.useState<ImportableSession[] | null>(null)
  const [unsupported, setUnsupported] = React.useState(false)
  const [truncated, setTruncated] = React.useState(false)
  const [scanning, setScanning] = React.useState(false)
  const [importing, setImporting] = React.useState(false)
  const [filter, setFilter] = React.useState("")
  /* "Not here yet" by default: this dialog exists to add what is missing, and
     on a machine that has been used for a while the rows already here are most
     of the list. The other values are how you look at what you have. */
  const [status, setStatus] = React.useState<StatusFilter>("new")
  const [since, setSince] = React.useState<SinceFilter>("any")
  const [sort, setSort] = React.useState<SortOrder>("recent")
  const [picked, setPicked] = React.useState<Set<string>>(new Set())
  /** Directories folded shut, by cwd. Open is the default — a group is only
      worth hiding once you have seen it. */
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set())
  /** Threads restored out of Trash this session, so the row can say so without
      a rescan (which costs a spawn) or a lie (the listing still says deleted). */
  const [restored, setRestored] = React.useState<Set<string>>(new Set())
  /* Two failures, two places: the scan's stands where the list would have
     been, the import's over the button that started it. Neither is a toast —
     this dialog covers the corner one would appear in, and a scan that failed
     otherwise looks exactly like a scan that found nothing. */
  const [scanError, setScanError] = React.useState<InlineError | null>(null)
  const [importError, setImportError] = React.useState<InlineError | null>(null)

  /* Which pair to ask. The remembered new-thread pair is the habit worth
     following, but the scan defaults to the agent's *virtual Default* profile
     wherever one exists: a listing is about the machine's own login, and codex
     in particular filters its thread list by the spawned profile's model
     provider, so a gateway profile can answer with none of the CLI's work. */
  const profilesFor = React.useCallback(
    (id: string) => allProfiles.filter((p) => profileSupports(p, id)),
    [allProfiles]
  )
  React.useEffect(() => {
    if (!open) return
    const start = resolveThreadStart(loadThreadDefaults(), allProfiles)
    if (!start) return
    setAgentId((current) => current || start.agentId)
    setProfileId((current) => {
      if (current) return current
      const serving = profilesFor(start.agentId)
      return (serving.find((p) => p.virtual) ?? serving[0])?.id ?? start.profile.id
    })
  }, [open, allProfiles, profilesFor])

  /* Everything is about one (profile, agent) pair, so changing either throws
     the answer away rather than leaving last runtime's list on screen. The
     filters are deliberately NOT reset with it: they are how the user is
     reading, not what was read, and re-picking "Last 24 hours" for every
     runtime in turn is the whole of what makes a scan-and-narrow loop tedious. */
  const reset = () => {
    setSessions(null)
    setUnsupported(false)
    setTruncated(false)
    setPicked(new Set())
    setCollapsed(new Set())
    setRestored(new Set())
    setScanError(null)
    setImportError(null)
  }
  const pickAgent = (next: string) => {
    setAgentId(next)
    const serving = profilesFor(next)
    setProfileId((serving.find((p) => p.virtual) ?? serving[0])?.id ?? "")
    reset()
  }

  /* The agent has to be spawned *somewhere*; the listing itself is machine-wide
     and every row carries its own cwd. The project the dialog was opened from,
     else the first one — a harness with no projects has nothing to import into
     anyway. */
  const scanProject = projects.find((p) => p.id === projectId) ?? projects[0] ?? null

  const scan = async () => {
    if (!profileId || !agentId || !scanProject) return
    setScanning(true)
    reset()
    try {
      const listing = await listImportable({ profileId, agentId, projectId: scanProject.id })
      setSessions(listing.sessions)
      setUnsupported(!listing.supported)
      setTruncated(listing.truncated)
    } catch (err) {
      setScanError(captureError(err, "Couldn't list this agent's past sessions"))
    } finally {
      setScanning(false)
    }
  }

  const projectByCwd = React.useMemo(() => {
    const map = new Map<string, Project>()
    for (const project of projects) map.set(normalizeCwd(project.cwd), project)
    return map
  }, [projects])

  /** A row's state as the dialog knows it *now* — the listing's answer, except
      for the ones restored since, which are here rather than in Trash. */
  const stateOf = React.useCallback(
    (session: ImportableSession): RowState =>
      session.existing && restored.has(session.existing.sessionId)
        ? "imported"
        : rowState(session),
    [restored]
  )

  /** Is anything narrowing the list? What an empty result has to say, and what
      the Clear button is for. */
  const isFiltered = status !== "all" || since !== "any" || filter.trim() !== ""
  const clearFilters = () => {
    setStatus("all")
    setSince("any")
    setFilter("")
  }

  const groups = React.useMemo<CwdGroup[]>(() => {
    if (!sessions) return []
    const needle = filter.trim().toLowerCase()
    const floor = since === "any" ? 0 : Date.now() - SINCE_MS[since]
    const byCwd = new Map<string, ImportableSession[]>()
    for (const session of sessions) {
      if (
        needle &&
        !(session.title ?? "").toLowerCase().includes(needle) &&
        !session.cwd.toLowerCase().includes(needle)
      ) {
        continue
      }
      if (status !== "all" && stateOf(session) !== status) continue
      /* A row the runtime dated, against the window. An undated row is kept:
         "we don't know when" is not "older than that". */
      const at = updatedAt(session)
      if (floor && !Number.isNaN(at) && at < floor) continue
      const cwd = normalizeCwd(session.cwd)
      const bucket = byCwd.get(cwd)
      if (bucket) bucket.push(session)
      else byCwd.set(cwd, [session])
    }
    const list = [...byCwd].map(([cwd, rows]) => {
      const project = projectByCwd.get(cwd) ?? null
      /* Sorting inside the group, not across it: the groups are the structure
         and a directory's rows are what the eye actually compares. */
      const sorted = [...rows].sort((a, b) => {
        if (sort === "title") {
          return (a.title ?? "").localeCompare(b.title ?? "", undefined, { sensitivity: "base" })
        }
        const at = updatedAt(a) || 0
        const bt = updatedAt(b) || 0
        return sort === "oldest" ? at - bt : bt - at
      })
      return {
        cwd,
        project,
        sessions: sorted,
        // Importable means both halves: not already a row here, and in a
        // directory the harness has a project for.
        newCount: project ? sorted.filter((s) => stateOf(s) === "new").length : 0,
      }
    })
    /* Known projects first (the ones that can actually be imported), the
       dialog's own project ahead of those, then by how much is in each. */
    return list.sort((a, b) => {
      const rank = (g: CwdGroup) => (g.project?.id === projectId ? 0 : g.project ? 1 : 2)
      return rank(a) - rank(b) || b.sessions.length - a.sessions.length
    })
  }, [sessions, filter, status, since, sort, projectByCwd, projectId, stateOf])

  /** Every row on screen that could be imported — what the header's one-click
      "Select all" acts on, and the count it prints. Across groups on purpose:
      the recovery case is "everything from Tuesday", which is rarely one
      directory. */
  const visibleNew = React.useMemo(
    () =>
      groups.flatMap((group) =>
        group.project ? group.sessions.filter((s) => stateOf(s) === "new") : []
      ),
    [groups, stateOf]
  )

  const shown = groups.reduce((n, group) => n + group.sessions.length, 0)
  const total = sessions?.length ?? 0

  const toggle = (acpSessionId: string) =>
    setPicked((current) => {
      const next = new Set(current)
      if (!next.delete(acpSessionId)) next.add(acpSessionId)
      return next
    })

  /** Every row a group can actually import: not already here, and in a
      directory the harness has a project for. */
  const importable = (group: CwdGroup) =>
    group.project ? group.sessions.filter((s) => stateOf(s) === "new") : []

  const setMany = (rows: ImportableSession[], on: boolean) =>
    setPicked((current) => {
      const next = new Set(current)
      for (const row of rows) {
        if (on) next.add(row.acpSessionId)
        else next.delete(row.acpSessionId)
      }
      return next
    })

  const toggleGroup = (group: CwdGroup) => {
    const rows = importable(group)
    const all = rows.length > 0 && rows.every((s) => picked.has(s.acpSessionId))
    setMany(rows, !all)
  }

  const toggleCollapsed = (cwd: string) =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (!next.delete(cwd)) next.add(cwd)
      return next
    })

  const addProject = async (cwd: string) => {
    setScanError(null)
    try {
      await createProjectAt(cwd, baseName(cwd))
      await invalidate("projects")
    } catch (err) {
      // Shares the list's slot: it is the list's own button that failed, and
      // the rows it would have unlocked are what the user is looking at.
      setScanError(captureError(err, "Couldn't create the project"))
    }
  }

  /* A conversation already in Trash must not be imported a second time — the
     row that names it still exists, and a second one would be two threads on
     one conversation. Restoring the row it has is the whole of what "get it
     back" means here, so the dialog does it in place. */
  const restore = async (sessionId: string) => {
    setImportError(null)
    try {
      await actions.restoreThread(sessionId)
      await actions.refreshSessions()
      setRestored((current) => new Set(current).add(sessionId))
      toast.success("Restored from Trash", { description: "It is back in the thread list." })
    } catch (err) {
      setImportError(captureError(err, "Couldn't restore that thread"))
    }
  }

  const run = async () => {
    const chosen = groups.flatMap((group) =>
      group.project
        ? group.sessions
            .filter((s) => picked.has(s.acpSessionId) && stateOf(s) === "new")
            .map((s) => ({
              acpSessionId: s.acpSessionId,
              title: s.title,
              updatedAt: s.updatedAt,
              projectId: group.project!.id,
            }))
        : []
    )
    if (!chosen.length) return
    setImporting(true)
    setImportError(null)
    try {
      const result = await importSessions({
        profileId,
        agentId,
        sessions: chosen,
        ...defaultToolPicks(loadThreadDefaults()),
      })
      await actions.refreshSessions()
      const n = result.created.length
      toast.success(
        n === 1 ? "Imported 1 thread" : `Imported ${n} threads`,
        result.skipped.length
          ? { description: `${result.skipped.length} skipped — already here, or no project.` }
          : { description: "Open one to load its history." }
      )
      onOpenChange(false)
      // One import is a thread the user meant to open; several are a list.
      if (n === 1) void navigate(threadPath(result.created[0].id))
    } catch (err) {
      // The dialog stays open on a failure, so the note has somewhere to live
      // and the picks are still there to retry with.
      setImportError(captureError(err, "Couldn't import the threads"))
    } finally {
      setImporting(false)
    }
  }

  const agents = allAgents.filter((agent) => profilesFor(agent.id).length > 0)
  const profiles = profilesFor(agentId)
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id
  const profileName = (id: string) => profiles.find((p) => p.id === id)?.name ?? "Profile"
  const allVisiblePicked =
    visibleNew.length > 0 && visibleNew.every((s) => picked.has(s.acpSessionId))

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-2xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Import threads</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Conversations this agent already has on the server's machine. Importing one adds
            it to the list; its history loads the first time you open it.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <div className="flex min-h-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={agentId} onValueChange={(value) => value && pickAgent(value)}>
              <SelectTrigger className="w-full sm:w-44">
                <SelectValue>
                  <span className="flex items-center gap-2">
                    <AgentIcon agentId={agentId} className="size-4" />
                    {agentName(agentId)}
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    <span className="flex items-center gap-2">
                      <AgentIcon agentId={agent.id} className="size-4" />
                      {agent.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={profileId}
              onValueChange={(value) => {
                if (!value) return
                setProfileId(value)
                reset()
              }}
            >
              <SelectTrigger className="w-full sm:w-48">
                <SelectValue>
                  <span className="flex items-center gap-2">
                    <ProfileIcon
                      profile={profiles.find((p) => p.id === profileId)}
                      agentId={agentId}
                      className="size-4"
                    />
                    {profileName(profileId)}
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {profiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    <span className="flex items-center gap-2">
                      <ProfileIcon profile={profile} agentId={agentId} className="size-4" />
                      {profile.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              className="max-sm:w-full"
              disabled={scanning || !profileId || !scanProject}
              onClick={() => void scan()}
            >
              {scanning ? <Loader2 className="animate-spin" /> : <RefreshCwIcon />}
              {sessions ? "Scan again" : "Scan"}
            </Button>
          </div>

          {total > 0 && (
            <>
              {/* Search first and full width: it is the one control used on
                  every visit, and the three selects below it are the ones
                  used when it is not enough. */}
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="pl-8"
                  placeholder={`Search ${total} session${total === 1 ? "" : "s"} by title or path…`}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <FilterSelect
                  value={status}
                  onChange={(next) => setStatus(next)}
                  labels={STATUS_LABEL}
                  aria="Which threads"
                />
                <FilterSelect
                  value={since}
                  onChange={(next) => setSince(next)}
                  labels={SINCE_LABEL}
                  aria="How far back"
                />
                <FilterSelect
                  value={sort}
                  onChange={(next) => setSort(next)}
                  labels={SORT_LABEL}
                  aria="Order"
                />
                {isFiltered && (
                  <Button variant="ghost" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                )}
              </div>
              {/* One line of arithmetic, so "nothing here" is never ambiguous
                  between an empty store and a filter that hid everything. */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-muted-foreground">
                <span className="tabular-nums">
                  {shown === total ? `${total} sessions` : `${shown} of ${total} shown`}
                </span>
                {visibleNew.length > 0 && (
                  <>
                    <span className="tabular-nums">{visibleNew.length} can be imported</span>
                    <button
                      type="button"
                      className="font-medium text-foreground underline-offset-4 hover:underline"
                      onClick={() => setMany(visibleNew, !allVisiblePicked)}
                    >
                      {allVisiblePicked ? "Clear selection" : `Select all ${visibleNew.length}`}
                    </button>
                  </>
                )}
              </div>
            </>
          )}

          <div className="min-h-24 flex-1 space-y-3 overflow-y-auto">
            {/* Above whatever else the region holds: after a failed scan there
                is nothing else, and after a failed "Add project" the rows it
                was about are right underneath it. */}
            <ErrorNote error={scanError} onRetry={() => void scan()} retryLabel="Scan again" />
            {scanning ? (
              <Note>Asking {agentName(agentId)} what it has…</Note>
            ) : scanError && !sessions ? null : unsupported ? (
              <Note>
                {agentName(agentId)} on this machine can't list its past sessions, so there
                is nothing to import from it.
              </Note>
            ) : !scanProject ? (
              /* The agent has to be spawned somewhere, and an imported thread
                 has to land somewhere. Both are a project. */
              <Note>Make a project first — a thread needs a directory to run in.</Note>
            ) : !sessions ? (
              <Note>
                Scan to see what {agentName(agentId)} has worked on. It runs the agent once
                to ask — nothing is changed.
              </Note>
            ) : groups.length === 0 ? (
              /* An empty list under a filter is a filter's answer, not the
                 store's, and it says which — with the way out attached. */
              <div className="flex flex-col items-center gap-2 py-6">
                <Note>
                  {total === 0
                    ? "No past sessions."
                    : status === "new"
                      ? "Every session here is already a thread."
                      : "Nothing matches those filters."}
                </Note>
                {isFiltered && total > 0 && (
                  <Button variant="outline" size="sm" onClick={clearFilters}>
                    Show everything
                  </Button>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {groups.map((group) => (
                  <Group
                    key={group.cwd}
                    group={group}
                    picked={picked}
                    collapsed={collapsed.has(group.cwd)}
                    onCollapse={() => toggleCollapsed(group.cwd)}
                    stateOf={stateOf}
                    onToggle={toggle}
                    onToggleAll={() => toggleGroup(group)}
                    onAddProject={() => void addProject(group.cwd)}
                    onRestore={(sessionId) => void restore(sessionId)}
                    onOpen={(sessionId) => {
                      onOpenChange(false)
                      void navigate(threadPath(sessionId))
                    }}
                  />
                ))}
                {truncated && (
                  <Note>
                    Only the most recent sessions are listed — narrow the search or import
                    what you need.
                  </Note>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Not in the scrolling list: the button that failed is in the footer,
            and a note that can scroll out of sight is one the user can miss
            exactly as they miss a toast. */}
        <ErrorNote error={importError} />

        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={picked.size === 0 || importing} onClick={() => void run()}>
            {importing && <Loader2 className="animate-spin" />}
            {picked.size ? `Import ${picked.size}` : "Import"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

/** One of the three narrowing controls. They differ only in their labels, so
    they are one component — a fourth is a table entry, not another block. */
function FilterSelect<T extends string>({
  value,
  onChange,
  labels,
  aria,
}: {
  value: T
  onChange: (next: T) => void
  labels: Record<T, string>
  aria: string
}) {
  const options = Object.keys(labels) as T[]
  return (
    <Select value={value} onValueChange={(next) => next && onChange(next as T)}>
      <SelectTrigger size="sm" aria-label={aria} className="w-auto min-w-32">
        <SelectValue>{labels[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {labels[option]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="px-1 py-6 text-center text-sm text-muted-foreground">{children}</p>
}

/** One directory: its project (or the offer to make one), then its rows. */
function Group({
  group,
  picked,
  collapsed,
  onCollapse,
  stateOf,
  onToggle,
  onToggleAll,
  onAddProject,
  onRestore,
  onOpen,
}: {
  group: CwdGroup
  picked: Set<string>
  collapsed: boolean
  onCollapse: () => void
  stateOf: (session: ImportableSession) => RowState
  onToggle: (acpSessionId: string) => void
  onToggleAll: () => void
  onAddProject: () => void
  onRestore: (sessionId: string) => void
  onOpen: (sessionId: string) => void
}) {
  const rows = group.sessions.filter((s) => stateOf(s) === "new")
  const allPicked = rows.length > 0 && rows.every((s) => picked.has(s.acpSessionId))
  return (
    <section className="flex flex-col gap-1">
      <header className="flex items-center gap-2 px-1">
        {/* The name is the disclosure: a long list of directories is read by
            folding the ones you are not looking for. */}
        <button
          type="button"
          onClick={onCollapse}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-0.5 text-left hover:text-foreground"
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              !collapsed && "rotate-90"
            )}
          />
          {group.project ? (
            <>
              <ProjectIcon project={group.project} className="size-4 shrink-0" />
              <span className="truncate text-sm font-medium">{group.project.name}</span>
            </>
          ) : (
            <span className="truncate font-mono text-xs text-muted-foreground">{group.cwd}</span>
          )}
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {group.newCount > 0
              ? `${group.newCount} new · ${group.sessions.length}`
              : group.sessions.length}
          </span>
        </button>
        {group.project ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={rows.length === 0}
            onClick={onToggleAll}
            className="shrink-0"
          >
            {allPicked ? "Clear" : "Select all"}
          </Button>
        ) : (
          /* A conversation needs a directory to run in, and that is what a
             project is — so an unknown cwd is one click from being importable
             rather than being hidden. */
          <Button variant="ghost" size="sm" onClick={onAddProject} className="shrink-0">
            <FolderPlus /> Add project
          </Button>
        )}
      </header>
      {!collapsed && (
        <>
          {group.project && (
            <p className="truncate px-1 font-mono text-[11px] text-muted-foreground/70">
              {group.cwd}
            </p>
          )}
          <ul className="flex flex-col">
            {group.sessions.map((session) => (
              <Row
                key={session.acpSessionId}
                session={session}
                state={stateOf(session)}
                disabled={!group.project}
                checked={picked.has(session.acpSessionId)}
                onToggle={() => onToggle(session.acpSessionId)}
                onRestore={onRestore}
                onOpen={onOpen}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function Row({
  session,
  state,
  checked,
  disabled,
  onToggle,
  onRestore,
  onOpen,
}: {
  session: ImportableSession
  state: RowState
  checked: boolean
  disabled: boolean
  onToggle: () => void
  onRestore: (sessionId: string) => void
  onOpen: (sessionId: string) => void
}) {
  const at = updatedAt(session)
  const existing = session.existing
  const taken = state !== "new" || disabled
  return (
    <li
      className={cn(
        "flex items-center gap-2 rounded-md px-1 py-1.5",
        !taken && "hover:bg-accent/50"
      )}
    >
      <Checkbox
        checked={checked}
        disabled={taken}
        onCheckedChange={onToggle}
        aria-label={`Import ${session.title ?? "untitled thread"}`}
      />
      <button
        type="button"
        disabled={taken}
        onClick={onToggle}
        title={session.title ?? undefined}
        className="min-w-0 flex-1 truncate text-left text-sm disabled:opacity-60"
      >
        {session.title?.trim() || <span className="text-muted-foreground">Untitled</span>}
      </button>
      {!Number.isNaN(at) && (
        <span
          className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
          title={new Date(at).toLocaleString()}
        >
          {shortAge(at)}
        </span>
      )}
      {existing &&
        (state === "trashed" ? (
          /* The conversation is here already — importing it again would be a
             second row on one conversation. Bringing its own row back is the
             thing that was actually meant. */
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={() => onRestore(existing.sessionId)}
          >
            <RotateCcwIcon /> Restore
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={() => onOpen(existing.sessionId)}
          >
            Open
          </Button>
        ))}
    </li>
  )
}
