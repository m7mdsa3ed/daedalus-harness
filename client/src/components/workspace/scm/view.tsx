/* ── Source control ──
   The harness's own view of `git status`, over the project's existing git
   routes. Nothing here runs git: the server owns the worktree, and this view
   only ever asks it questions and hands back what it says.

   The decisions that shape it now live beside the code each one is about: this
   file is the list of repositories and the chrome that spans them,
   `repo-section.tsx` is one repository's status, staging and commit box,
   `file-rows.tsx` the groups and the rows, `branch-menu.tsx` the header's
   branch control, and the two lists below the working set are `scm-log.tsx`.

   **A project is not one repository.** It may hold several — a directory of
   checkouts, a `packages/` of them — or sit inside a larger one, so the view
   starts from `GET …/git/repos` and draws a section per repository, each with
   its own status, its own staging and its own commit box. That is what git
   means: an index and a HEAD belong to one repository, and a commit box that
   spanned two would be a button with no single thing to do. With exactly one
   repository the sections' chrome disappears and it reads as one list. */
import * as React from "react"
import { FilterIcon, FolderTreeIcon, ListIcon, RefreshIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { GitBranchIcon } from "lucide-react"

import { Empty } from "@/components/empty"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { PanelRowsSkeleton } from "@/components/ui/skeletons"
import { PanelToolbar } from "@/components/workspace/primitives"
import { RepoSection } from "@/components/workspace/scm/repo-section"
import { IconAction, type RepoState } from "@/components/workspace/scm/shared"
import { describeError } from "@/lib/errors"
import { idePrefs, setIdePref, type FileLayout } from "@/lib/ide/prefs"
import type { ScmFilter } from "@/lib/ide/scm-filter"
import { useServer } from "@/lib/server-context"
import {
  gitRepos,
  gitStatus,
  type Comparison,
  type GitRepo,
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
}: {
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
  onOpenDiff: (path: string, left: Comparison, right: Comparison) => void
  onOpenFile: (path: string) => void
}) {
  const settings = useServer()
  const layout = idePrefs.use().scmLayout

  const [repos, setRepos] = React.useState<GitRepo[] | null>(null)
  const [reposError, setReposError] = React.useState<string | null>(null)
  const [states, setStates] = React.useState<Record<string, RepoState>>({})
  const [open, setOpen] = React.useState<ReadonlySet<string>>(() => new Set())

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
      const found = await gitRepos(settings, projectId)
      if (!alive.current) return
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
  }, [projectId, settings])

  React.useEffect(() => {
    setRepos(null)
    setStates({})
    setOpen(new Set())
    void loadRepos()
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
    [projectId, settings]
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
      const structural =
        batch.overflow || batch.events.some((event) => event.path.split("/").includes(".git"))
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

  const toggleRepo = React.useCallback((path: string) => {
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar>
        {/* The branch used to live here, and it could only be read. It is a
            control now, so it belongs on the repository it switches — one
            repository or eight. What is left is what is about the *view*. */}
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">
          {single ? "Source control" : `${repos.length} repositories`}
        </span>
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

      <ScrollArea className="min-h-0 flex-1">
        <div className="pb-2">
          {repos.map((repo) => (
            <RepoSection
              key={repo.path || "."}
              projectId={projectId}
              repo={repo}
              state={states[repo.path]}
              filter={filter ?? null}
              layout={layout}
              /* One repository has nothing to choose between, so it is always
                 open and its header carries no name and no disclosure — only
                 the branch and the actions, which it needs either way. */
              collapsible={!single}
              open={single || open.has(repo.path)}
              onToggle={() => toggleRepo(repo.path)}
              onRefresh={() => void refreshRepo(repo.path)}
              onStatus={(status) =>
                setStates((current) => ({
                  ...current,
                  [repo.path]: { status, error: null, loading: false },
                }))
              }
              onOpenDiff={onOpenDiff}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
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
