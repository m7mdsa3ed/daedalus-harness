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
   without a project has no cwd to run in. */
import * as React from "react"
import { useNavigate } from "react-router"
import { FolderPlus, Loader2, RefreshCwIcon } from "lucide-react"
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
import type { Actions } from "@/lib/actions"
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
import { useStoreSelect } from "@/lib/store"
import { defaultToolPicks, loadThreadDefaults, resolveThreadStart } from "@/lib/thread-defaults"
import { shortAge } from "@/lib/time"
import { cn } from "@/lib/utils"

/** A directory's worth of conversations, and the project that owns it. */
interface CwdGroup {
  cwd: string
  project: Project | null
  sessions: ImportableSession[]
}

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
  /* Three catalogs, each on its own subscription. Named `all*` because the
     dialog narrows both down to the pairs that can actually be scanned. */
  const allProfiles = useStoreSelect((store) => store.profiles)
  const projects = useStoreSelect((store) => store.projects)
  const allAgents = useStoreSelect((store) => store.agents)
  const navigate = useNavigate()

  const [agentId, setAgentId] = React.useState("")
  const [profileId, setProfileId] = React.useState("")
  const [sessions, setSessions] = React.useState<ImportableSession[] | null>(null)
  const [unsupported, setUnsupported] = React.useState(false)
  const [truncated, setTruncated] = React.useState(false)
  const [scanning, setScanning] = React.useState(false)
  const [importing, setImporting] = React.useState(false)
  const [filter, setFilter] = React.useState("")
  const [picked, setPicked] = React.useState<Set<string>>(new Set())
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
     the answer away rather than leaving last runtime's list on screen. */
  const reset = () => {
    setSessions(null)
    setUnsupported(false)
    setTruncated(false)
    setPicked(new Set())
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

  const groups = React.useMemo<CwdGroup[]>(() => {
    if (!sessions) return []
    const needle = filter.trim().toLowerCase()
    const byCwd = new Map<string, ImportableSession[]>()
    for (const session of sessions) {
      if (
        needle &&
        !(session.title ?? "").toLowerCase().includes(needle) &&
        !session.cwd.toLowerCase().includes(needle)
      ) {
        continue
      }
      const cwd = normalizeCwd(session.cwd)
      const bucket = byCwd.get(cwd)
      if (bucket) bucket.push(session)
      else byCwd.set(cwd, [session])
    }
    const list = [...byCwd].map(([cwd, rows]) => ({
      cwd,
      project: projectByCwd.get(cwd) ?? null,
      sessions: rows,
    }))
    /* Known projects first (the ones that can actually be imported), the
       dialog's own project ahead of those, then by how much is in each. */
    return list.sort((a, b) => {
      const rank = (g: CwdGroup) =>
        g.project?.id === projectId ? 0 : g.project ? 1 : 2
      return rank(a) - rank(b) || b.sessions.length - a.sessions.length
    })
  }, [sessions, filter, projectByCwd, projectId])

  const toggle = (acpSessionId: string) =>
    setPicked((current) => {
      const next = new Set(current)
      if (!next.delete(acpSessionId)) next.add(acpSessionId)
      return next
    })

  /** Every row a group can actually import: not already here, and in a
      directory the harness has a project for. */
  const importable = (group: CwdGroup) =>
    group.project ? group.sessions.filter((s) => !s.existing) : []

  const toggleGroup = (group: CwdGroup) => {
    const rows = importable(group)
    const all = rows.length > 0 && rows.every((s) => picked.has(s.acpSessionId))
    setPicked((current) => {
      const next = new Set(current)
      for (const row of rows) {
        if (all) next.delete(row.acpSessionId)
        else next.add(row.acpSessionId)
      }
      return next
    })
  }

  const addProject = async (cwd: string) => {
    setScanError(null)
    try {
      await createProjectAt(cwd, baseName(cwd))
      await actions.refreshProjects()
    } catch (err) {
      // Shares the list's slot: it is the list's own button that failed, and
      // the rows it would have unlocked are what the user is looking at.
      setScanError(captureError(err, "Couldn't create the project"))
    }
  }

  const run = async () => {
    const chosen = groups.flatMap((group) =>
      group.project
        ? group.sessions
            .filter((s) => picked.has(s.acpSessionId) && !s.existing)
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
  const total = sessions?.length ?? 0

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

        <div className="flex flex-col gap-3">
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
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`Filter ${total} session${total === 1 ? "" : "s"}…`}
            />
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
              <Note>{filter ? "Nothing matches that." : "No past sessions."}</Note>
            ) : (
              <div className="flex flex-col gap-4">
                {groups.map((group) => (
                  <Group
                    key={group.cwd}
                    group={group}
                    picked={picked}
                    onToggle={toggle}
                    onToggleAll={() => toggleGroup(group)}
                    onAddProject={() => void addProject(group.cwd)}
                    onOpen={(sessionId) => {
                      onOpenChange(false)
                      void navigate(threadPath(sessionId))
                    }}
                  />
                ))}
                {truncated && (
                  <Note>
                    Only the most recent sessions are listed — narrow the filter or import
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

function Note({ children }: { children: React.ReactNode }) {
  return <p className="px-1 py-6 text-center text-sm text-muted-foreground">{children}</p>
}

/** One directory: its project (or the offer to make one), then its rows. */
function Group({
  group,
  picked,
  onToggle,
  onToggleAll,
  onAddProject,
  onOpen,
}: {
  group: CwdGroup
  picked: Set<string>
  onToggle: (acpSessionId: string) => void
  onToggleAll: () => void
  onAddProject: () => void
  onOpen: (sessionId: string) => void
}) {
  return (
    <section className="flex flex-col gap-1">
      <header className="flex items-center gap-2 px-1">
        {group.project ? (
          <>
            <ProjectIcon project={group.project} className="size-4" />
            <span className="truncate text-sm font-medium">{group.project.name}</span>
          </>
        ) : (
          <span className="truncate font-mono text-xs text-muted-foreground">{group.cwd}</span>
        )}
        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
          {group.sessions.length}
        </span>
        <div className="flex-1" />
        {group.project ? (
          <Button variant="ghost" size="sm" onClick={onToggleAll}>
            Select all
          </Button>
        ) : (
          /* A conversation needs a directory to run in, and that is what a
             project is — so an unknown cwd is one click from being importable
             rather than being hidden. */
          <Button variant="ghost" size="sm" onClick={onAddProject}>
            <FolderPlus /> Add project
          </Button>
        )}
      </header>
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
            disabled={!group.project}
            checked={picked.has(session.acpSessionId)}
            onToggle={() => onToggle(session.acpSessionId)}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </section>
  )
}

function Row({
  session,
  checked,
  disabled,
  onToggle,
  onOpen,
}: {
  session: ImportableSession
  checked: boolean
  disabled: boolean
  onToggle: () => void
  onOpen: (sessionId: string) => void
}) {
  const at = session.updatedAt ? Date.parse(session.updatedAt) : NaN
  const existing = session.existing
  const taken = Boolean(existing) || disabled
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
        (existing.deleted ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">In Trash</span>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => onOpen(existing.sessionId)}>
            Open
          </Button>
        ))}
    </li>
  )
}

