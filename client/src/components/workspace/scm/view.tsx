/* ── Source control ──
   The harness's own view of `git status`, over the project's existing git
   routes. Nothing here runs git: the server owns the worktree, and this view
   only ever asks it questions and hands back what it says.

   The decisions that shape it now live beside the code each one is about: this
   file is the list of repositories and the chrome that spans them,
   `repo-section.tsx` is one repository's whole panel, `working-list.tsx` the
   rows, `branch-picker.tsx` the branch control, and the stash and history
   lists are `scm-log.tsx`.

   **A project is not one repository.** It may hold several — a directory of
   checkouts, a `packages/` of them — or sit inside a larger one, so the view
   starts from `GET …/git/repos`. That is what git means: an index and a HEAD
   belong to one repository, and a commit box that spanned two would be a
   button with no single thing to do.

   **One repository is drawn at a time**, picked in the toolbar. They used to
   be stacked sections in a single scroller, which is what forced the commit
   box to scroll with the files: sections sharing a scroller cannot pin
   anything. A picker costs one click and gives each repository the full
   height — its own list, its own tabs, and a commit box fixed to the bottom
   edge. With one repository the picker is a label. */
import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import { FilterIcon, FolderTreeIcon, ListIcon, RefreshIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { ChevronDownIcon, GitBranchIcon } from "lucide-react"

import { Empty } from "@/components/empty"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { PanelRowsSkeleton } from "@/components/ui/skeletons"
import { PanelToolbar } from "@/components/workspace/primitives"
import { RepoSection } from "@/components/workspace/scm/repo-section"
import { IconAction, type RepoState } from "@/components/workspace/scm/shared"
import { describeError } from "@/lib/errors"
import { projectGitStatusKey, projectReposKey } from "@/lib/queries/keys"
import { idePrefs, setIdePref, type FileLayout } from "@/lib/ide/prefs"
import type { ScmFilter } from "@/lib/ide/scm-filter"
import { useServer } from "@/lib/server-context"
import { cn } from "@/lib/utils"
import {
  gitRepos,
  gitStatus,
  type Comparison,
  type GitRepo,
  type GitStatus,
} from "@/lib/workspace/git-api"
import { watchProject } from "@/lib/workspace/watch"

/** Reading a status per repository is one git process each. Beyond a handful,
    a monorepo of checkouts would spend them all on sections nobody opened — so
    past this many, a section reads its status when it is first expanded. */
const AUTO_STATUS_REPOS = 8

/** The panel before the repository walk answers: a section per repository in
    the shape a repository draws — header, then its files. */
function ReposSkeleton() {
  return (
    <div aria-busy="true" className="space-y-3 p-3">
      {[4, 2, 3].map((rowsFor, index) => (
        <div key={index} className="overflow-hidden rounded-xl border">
          <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
            <Skeleton className="size-4 shrink-0 rounded-sm" />
            <Skeleton className="h-3.5 w-40 max-w-full" />
            <Skeleton className="ml-auto h-3 w-16 shrink-0" />
          </div>
          <PanelRowsSkeleton rows={rowsFor} />
        </div>
      ))}
    </div>
  )
}

export function ScmView({
  projectId,
  filter,
  onClearFilter,
  onOpenDiff,
  onOpenFile,
  pinnedRepo,
}: {
  /** Draw this one repository (project-relative) and do not walk for others —
      a worktree thread's checkout, which the walk never finds: it lives under
      the project's own `.daedalus/`, inside a repository it does not descend
      through. */
  pinnedRepo?: string
  projectId: string
  /** Show only these paths, under a banner saying why (`lib/ide/scm-filter.ts`
      — a turn's changed files). The working set underneath is untouched: this
      narrows what is *drawn*, and every count, the commit button and "stage
      all" follow the narrowing, because a button that says "Stage all 12" over
      three visible rows is a lie. */
  filter?: ScmFilter | null
  onClearFilter?: () => void
  /** `path` is project-relative — see `projectPath`. Both sides are named: a
      staged row is HEAD ↔ index, an unstaged one index ↔ worktree. */
  onOpenDiff: (path: string, left: Comparison, right: Comparison, repo?: string) => void
  onOpenFile: (path: string) => void
}) {
  const settings = useServer()
  const qc = useQueryClient()
  const layout = idePrefs.use().scmLayout

  /* The composer's repo reading asks the same two routes through the query
     cache, so the panel opens on what it already knows and writes back what
     it learns: a mount is a repaint, not a skeleton, and a commit made here is
     the composer's "clean" too. The watch stream still owns freshness. */
  const cachedStatus = React.useCallback(
    (repo: string) => qc.getQueryData<GitStatus>(projectGitStatusKey(settings, projectId, repo)),
    [qc, settings, projectId]
  )
  const publishStatus = React.useCallback(
    (repo: string, status: GitStatus) => qc.setQueryData(projectGitStatusKey(settings, projectId, repo), status),
    [qc, settings, projectId]
  )

  const [repos, setRepos] = React.useState<GitRepo[] | null>(null)
  const [reposError, setReposError] = React.useState<string | null>(null)
  const [states, setStates] = React.useState<Record<string, RepoState>>({})
  const [open, setOpen] = React.useState<ReadonlySet<string>>(() => new Set())
  /** Which repository the panel is showing; "" is the project's own. */
  const [current, setCurrent] = React.useState<string | null>(null)

  const alive = React.useRef(true)
  React.useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  /* ── The repositories ──
     Read once per mount and again only when the watch stream says a `.git`
     appeared or went: a repository is not something that comes and goes while
     you are looking at it, and re-walking the project on every write would cost
     a directory walk per keystroke's worth of agent output. */
  const loadRepos = React.useCallback(async () => {
    try {
      const found =
        pinnedRepo !== undefined
          ? [{ path: pinnedRepo, name: pinnedRepo.split("/").pop() || "Project", branch: null }]
          : await gitRepos(settings, projectId)
      if (!alive.current) return
      if (pinnedRepo === undefined) qc.setQueryData(projectReposKey(settings, projectId), found)
      setRepos(found)
      setReposError(null)
      /* Everything open by default when there are few; with many, the project's
         own (or the first) only — the rest are one tap away and cost nothing
         until then. */
      setOpen((current) =>
        current.size > 0
          ? current
          : new Set(found.length <= AUTO_STATUS_REPOS ? found.map((repo) => repo.path) : found.slice(0, 1).map((repo) => repo.path))
      )
    } catch (err) {
      if (alive.current) setReposError(describeError(err).title)
    }
  }, [projectId, settings, pinnedRepo, qc])

  React.useEffect(() => {
    const seed =
      pinnedRepo !== undefined
        ? [{ path: pinnedRepo, name: pinnedRepo.split("/").pop() || "Project", branch: null }]
        : qc.getQueryData<GitRepo[]>(projectReposKey(settings, projectId))
    setRepos(pinnedRepo !== undefined ? null : (seed ?? null))
    const seeded: Record<string, RepoState> = {}
    for (const repo of seed ?? []) {
      const status = cachedStatus(repo.path)
      if (status) seeded[repo.path] = { status, error: null, loading: false }
    }
    setStates(seeded)
    setOpen(new Set())
    setCurrent(null)
    void loadRepos()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a reset per repository set, not per cache read
  }, [loadRepos])

  /* ── One status per repository ──
     Serialized per repository (a second request while one is in flight asks for
     exactly one more afterwards), because a watch burst is hundreds of events
     and would otherwise be hundreds of `git status` processes. */
  const reading = React.useRef(new Map<string, Promise<void>>())
  const again = React.useRef(new Set<string>())

  const refreshRepo = React.useCallback(
    (repo: string): Promise<void> => {
      const inFlight = reading.current.get(repo)
      if (inFlight) {
        again.current.add(repo)
        return inFlight
      }
      const run = (async () => {
        try {
          const status = await gitStatus(settings, projectId, { repo: repo || undefined })
          publishStatus(repo, status)
          if (!alive.current) return
          setStates((current) => ({ ...current, [repo]: { status, error: null, loading: false } }))
        } catch (err) {
          if (!alive.current) return
          const message = describeError(err).title
          setStates((current) => ({
            ...current,
            [repo]: { status: current[repo]?.status ?? null, error: message, loading: false },
          }))
        } finally {
          reading.current.delete(repo)
          if (again.current.delete(repo) && alive.current) void refreshRepo(repo)
        }
      })()
      reading.current.set(repo, run)
      return run
    },
    [projectId, settings, publishStatus]
  )

  /** Which repositories are being kept up to date right now. */
  const watched = React.useMemo(() => {
    if (!repos) return [] as string[]
    if (repos.length <= AUTO_STATUS_REPOS) return repos.map((repo) => repo.path)
    return repos.filter((repo) => open.has(repo.path)).map((repo) => repo.path)
  }, [repos, open])

  const watchedKey = watched.join(" ")
  React.useEffect(() => {
    if (watched.length === 0) return
    setStates((current) => {
      const next = { ...current }
      for (const repo of watched) if (!next[repo]) next[repo] = { status: null, error: null, loading: true }
      return next
    })
    for (const repo of watched) void refreshRepo(repo)
    // `watchedKey` is the value identity of `watched`; the array itself is new
    // on every render of this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedKey, refreshRepo])

  const watchedRef = React.useRef(watched)
  watchedRef.current = watched
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const stop = watchProject(projectId, (batch) => {
      /* A `.git` in the batch means a repository was created, cloned or
         removed — the one thing that changes the *list* rather than a status. */
      /* The `.git` entry itself, never what is inside it: every stage, commit
         and turn snapshot writes under `.git`, and treating those as
         structural re-walked the project on nearly every batch while an agent
         worked. */
      const structural =
        batch.overflow ||
        batch.events.some((event) => event.path === ".git" || event.path.endsWith("/.git"))
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        if (structural) void loadRepos()
        for (const repo of watchedRef.current) void refreshRepo(repo)
      }, 400)
    })
    return () => {
      if (timer) clearTimeout(timer)
      stop()
    }
  }, [projectId, loadRepos, refreshRepo])

  const refreshAll = React.useCallback(() => {
    void loadRepos()
    for (const repo of watchedRef.current) void refreshRepo(repo)
  }, [loadRepos, refreshRepo])

  if (reposError)
    return (
      <div className="p-2">
        <Empty>{reposError}</Empty>
      </div>
    )
  if (!repos) return <ReposSkeleton />
  if (repos.length === 0)
    return (
      <div className="p-3">
        <Empty size="lg" icon={GitBranchIcon}>
          Neither this project nor anything under it is a git repository, so there is nothing to
          review.
        </Empty>
      </div>
    )

  const single = repos.length === 1
  /* One repository is drawn at a time. They used to be stacked sections in one
     scroller, which is what made the commit box a thing that scrolled: eight
     repositories meant eight commit boxes somewhere down a single column, and
     none of them could be pinned because they shared the scroller. A picker
     costs one click and gives every repository the whole panel — its own list,
     its own tabs, and a commit box fixed to the bottom edge. */
  const active = repos.find((entry) => entry.path === current) ?? repos[0]!

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar>
        {single ? (
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">
            Source control
          </span>
        ) : (
          <RepoPicker
            repos={repos}
            active={active}
            states={states}
            onPick={(path) => {
              setCurrent(path)
              /* Picking is what makes a repository watched when there are many
                 — see `watched` — so its status is read on the way in. */
              setOpen((prior) => new Set(prior).add(path))
            }}
          />
        )}
        <LayoutToggle layout={layout} onChange={(next) => setIdePref("scmLayout", next)} />
        <IconAction label="Refresh" icon={RefreshIcon} onClick={refreshAll} />
      </PanelToolbar>

      {/* What the view is currently being asked, and the way back to all of it.
          Above the repositories rather than inside one: the question spans
          them, and the answer per repository is a section that may be empty. */}
      {filter && (
        <div className="flex items-center gap-2 border-b border-border/60 bg-primary/5 px-2 py-1.5">
          <HugeiconsIcon icon={FilterIcon} strokeWidth={2} className="size-3.5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-[11px] text-primary">{filter.label}</span>
          {onClearFilter && (
            <Button variant="ghost" size="xs" className="shrink-0 text-[11px]" onClick={onClearFilter}>
              Show everything
            </Button>
          )}
        </div>
      )}

      {/* No scroller here: the section owns its own, because its commit box is
          pinned outside it. */}
      <RepoSection
        key={active.path || "."}
        projectId={projectId}
        repo={active}
        state={states[active.path]}
        filter={filter ?? null}
        layout={layout}
        onRefresh={() => void refreshRepo(active.path)}
        onStatus={(status) => {
          publishStatus(active.path, status)
          setStates((prior) => ({
            ...prior,
            [active.path]: { status, error: null, loading: false },
          }))
        }}
        onOpenDiff={onOpenDiff}
        onOpenFile={onOpenFile}
      />
    </div>
  )
}

/** Which repository the panel is showing, with what each has outstanding —
    the count is why this is a menu and not a row of tabs: eight checkouts do
    not fit across a 320px column, and the number is the reason you switch. */
function RepoPicker({
  repos,
  active,
  states,
  onPick,
}: {
  repos: GitRepo[]
  active: GitRepo
  states: Record<string, RepoState>
  onPick: (path: string) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="min-w-0 flex-1 justify-start gap-1 px-1 text-[11px] font-medium"
          >
            <GitBranchIcon className="size-3 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{active.name}</span>
            <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-auto min-w-56">
        {repos.map((repo) => {
          const status = states[repo.path]?.status
          const count = status
            ? status.staged.length +
              status.unstaged.length +
              status.untracked.length +
              status.conflicted.length
            : null
          return (
            <DropdownMenuItem key={repo.path || "."} onClick={() => onPick(repo.path)}>
              <GitBranchIcon
                className={cn(
                  "size-3.5",
                  repo.path === active.path ? "text-foreground" : "text-muted-foreground"
                )}
              />
              <span className="min-w-0 flex-1 truncate">{repo.name}</span>
              {count !== null && count > 0 && (
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                  {count}
                </span>
              )}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function LayoutToggle({
  layout,
  onChange,
}: {
  layout: FileLayout
  onChange: (next: FileLayout) => void
}) {
  const next = layout === "tree" ? "list" : "tree"
  return (
    <IconAction
      label={next === "tree" ? "View as a tree" : "View as a list"}
      icon={layout === "tree" ? FolderTreeIcon : ListIcon}
      onClick={() => onChange(next)}
    />
  )
}
