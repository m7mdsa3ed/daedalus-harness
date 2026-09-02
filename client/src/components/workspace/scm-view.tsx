/* ── Source control ──
   The harness's own view of `git status`, over the project's existing git
   routes. Nothing here runs git: the server owns the worktree, and this view
   only ever asks it questions and hands back what it says.

   Three decisions shape the file.

   **A project is not one repository.** It may hold several — a directory of
   checkouts, a `packages/` of them — or sit inside a larger one, so the view
   starts from `GET …/git/repos` and draws a section per repository, each with
   its own status, its own staging and its own commit box. That is what git
   means: an index and a HEAD belong to one repository, and a commit box that
   spanned two would be a button with no single thing to do. With exactly one
   repository the sections' chrome disappears and it reads as one list.

   **A working set is a tree, and the reader chooses.** Twelve files across four
   directories is unreadable as twelve full paths in a 320px column, so the tree
   is the default and single-child chains fold into one row (`src/lib/ide`
   rather than three rows holding one child each). The list is one toggle away
   and is remembered per device (`lib/ide/prefs.ts`), because how a set of files
   is *read* is a property of the reader and not of the panel.

   **Marks are read back, never inferred.** Every write answers with the next
   status and that is what repaints — staging a file the agent is still editing
   is a race the server wins, and the honest answer is whatever it says next.
   Refresh otherwise happens on the project watch stream, debounced because a
   checkout touches hundreds of files. Never on a timer. */
import * as React from "react"
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowTurnBackwardIcon,
  Folder01Icon,
  FolderTreeIcon,
  GitBranchIcon,
  ListIcon,
  MinusSignIcon,
  PlusSignIcon,
  RefreshIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useConfirm } from "@/components/confirm-dialog"
import { PanelEmptyState, PanelNotice, PanelToolbar } from "@/components/workspace/primitives"
import { useCoarsePointer } from "@/hooks/use-mobile"
import { describeError } from "@/lib/errors"
import { idePrefs, setIdePref, type FileLayout } from "@/lib/ide/prefs"
import { useServer } from "@/lib/server-context"
import { cn } from "@/lib/utils"
import { basename } from "@/lib/workspace/fs-api"
import {
  gitRepos,
  gitStatus,
  gitWrite,
  projectPath,
  type GitAction,
  type GitFileState,
  type GitRepo,
  type GitStatus,
} from "@/lib/workspace/git-api"
import {
  buildPathTree,
  countFiles,
  filesUnder,
  type PathDirNode,
  type PathFileNode,
} from "@/lib/workspace/git-tree"
import { watchProject } from "@/lib/workspace/watch"

/** Which list a row came out of. It decides the mark, the buttons and the
    comparison the row opens — one value rather than four booleans. */
type Side = "conflict" | "index" | "worktree" | "untracked"

interface Row {
  file: GitFileState
  side: Side
}

type Tree = PathDirNode<Row>
type Leaf = PathFileNode<Row>

const LABEL: Record<string, string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type changed",
  U: "Conflict",
  "?": "Untracked",
}

const MARK_CLASS: Record<string, string> = {
  A: "text-emerald-600 dark:text-emerald-400",
  "?": "text-emerald-600 dark:text-emerald-400",
  M: "text-amber-600 dark:text-amber-400",
  D: "text-red-600 dark:text-red-400",
  U: "text-red-600 dark:text-red-400",
  R: "text-sky-600 dark:text-sky-400",
}

const markOf = (file: GitFileState, side: Side): string =>
  side === "untracked" ? "?" : side === "conflict" ? "U" : side === "index" ? file.index : file.worktree

/** Reading a status per repository is one git process each. Beyond a handful,
    a monorepo of checkouts would spend them all on sections nobody opened — so
    past this many, a section reads its status when it is first expanded. */
const AUTO_STATUS_REPOS = 8

const changeCount = (status: GitStatus): number =>
  status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length

interface RepoState {
  status: GitStatus | null
  error: string | null
  loading: boolean
}

export function ScmView({
  projectId,
  onOpenDiff,
  onOpenFile,
}: {
  projectId: string
  /** `path` is project-relative — see `projectPath`. */
  onOpenDiff: (path: string, comparison: "head" | "staged") => void
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

  const watchedKey = watched.join(" ")
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

  if (reposError) return <PanelEmptyState>{reposError}</PanelEmptyState>
  if (!repos) return <PanelEmptyState>Looking for repositories…</PanelEmptyState>
  if (repos.length === 0)
    return (
      <PanelEmptyState>
        Neither this project nor anything under it is a git repository, so there is nothing to
        review.
      </PanelEmptyState>
    )

  const single = repos.length === 1

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar>
        <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-[11px] text-muted-foreground">
          <HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} className="size-3 shrink-0" />
          <span className="truncate font-mono">
            {single
              ? (states[repos[0].path]?.status?.branch ??
                repos[0].branch ??
                "Source control")
              : `${repos.length} repositories`}
          </span>
        </span>
        <LayoutToggle layout={layout} onChange={(next) => setIdePref("scmLayout", next)} />
        <IconAction label="Refresh" icon={RefreshIcon} onClick={refreshAll} />
      </PanelToolbar>

      <ScrollArea className="min-h-0 flex-1">
        <div className="pb-2">
          {repos.map((repo) => (
            <RepoSection
              key={repo.path || "."}
              projectId={projectId}
              repo={repo}
              state={states[repo.path]}
              layout={layout}
              /* One repository is not a section — there is nothing to choose
                 between, so it is always open and wears no header. */
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

/* ── One repository ──
   Its own status, its own staging, its own commit box. The section owns the
   writes because every one of them names this repository; the parent owns the
   status *value* so that a refresh triggered by the watch stream lands here
   too. */
function RepoSection({
  projectId,
  repo,
  state,
  layout,
  collapsible,
  open,
  onToggle,
  onRefresh,
  onStatus,
  onOpenDiff,
  onOpenFile,
}: {
  projectId: string
  repo: GitRepo
  state: RepoState | undefined
  layout: FileLayout
  collapsible: boolean
  open: boolean
  onToggle: () => void
  onRefresh: () => void
  onStatus: (status: GitStatus) => void
  onOpenDiff: (path: string, comparison: "head" | "staged") => void
  onOpenFile: (path: string) => void
}) {
  const settings = useServer()
  const confirm = useConfirm()
  const coarse = useCoarsePointer()

  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState("")
  const [output, setOutput] = React.useState<string | null>(null)
  /* Git's own refusal ("error: path … has unstaged changes"), held by the
     section it belongs to rather than raised as a toast with nowhere to go
     back to. Cleared by the next write that succeeds. */
  const [writeError, setWriteError] = React.useState<string | null>(null)
  const [collapsedDirs, setCollapsedDirs] = React.useState<ReadonlySet<string>>(() => new Set())

  const status = state?.status ?? null
  const count = status ? changeCount(status) : null

  const write = React.useCallback(
    async (action: GitAction): Promise<boolean> => {
      if ("paths" in action && action.paths.length === 0) return false
      setBusy(true)
      try {
        const next = await gitWrite(settings, projectId, { ...action, repo: repo.path || undefined })
        onStatus(next)
        setWriteError(null)
        if (action.action === "commit") {
          setMessage("")
          setOutput(next.output?.split("\n").find((line) => line.trim())?.trim() ?? null)
        }
        return true
      } catch (err) {
        setOutput(null)
        const { title, detail } = describeError(err)
        setWriteError(detail ? `${title}: ${detail}` : title)
        onRefresh()
        return false
      } finally {
        setBusy(false)
      }
    },
    [onRefresh, onStatus, projectId, repo.path, settings]
  )

  const discard = React.useCallback(
    async (paths: string[], untracked: boolean, what: string) => {
      const ok = await confirm({
        title: `Discard changes in ${what}?`,
        description: untracked
          ? "These files are untracked, so discarding reverts only what git is tracking — delete them from the explorer if they should go."
          : "Working-tree changes are thrown away. This cannot be undone.",
        confirmLabel: "Discard",
        destructive: true,
      })
      if (ok) await write({ action: "discard", paths })
    },
    [confirm, write]
  )

  const commit = React.useCallback(async () => {
    if (!status?.repository) return
    const text = message.trim()
    if (!text) return
    if (status.staged.length === 0) {
      const pending = status.unstaged.length + status.untracked.length
      if (pending === 0) return
      const ok = await confirm({
        title: `Stage all ${pending} ${pending === 1 ? "change" : "changes"} and commit?`,
        description: "Nothing is staged yet, so everything changed goes into this commit.",
        confirmLabel: "Stage all and commit",
      })
      if (!ok) return
      const staged = await write({
        action: "stage",
        paths: [...status.unstaged, ...status.untracked].map((file) => file.path),
      })
      if (!staged) return
    }
    await write({ action: "commit", message: text })
  }, [confirm, message, status, write])

  const groups = React.useMemo(() => {
    if (!status) return []
    return (
      [
        { key: "merge", title: "Conflicts", side: "conflict", files: status.conflicted },
        { key: "staged", title: "Staged", side: "index", files: status.staged },
        { key: "changes", title: "Changes", side: "worktree", files: status.unstaged },
        { key: "untracked", title: "Untracked", side: "untracked", files: status.untracked },
      ] satisfies { key: string; title: string; side: Side; files: GitFileState[] }[]
    ).filter((group) => group.files.length > 0)
  }, [status])

  const branch = status?.branch ?? repo.branch ?? (status?.unborn ? "no commits yet" : "detached")
  const stagedCount = status?.staged.length ?? 0
  const unstaged = [...(status?.unstaged ?? []), ...(status?.untracked ?? [])]

  const openRow = (file: GitFileState, side: Side) => {
    const path = projectPath(repo.path, file.path)
    if (side === "untracked" || markOf(file, side) === "A") onOpenFile(path)
    else onOpenDiff(path, side === "index" ? "head" : "staged")
  }

  return (
    <section className="border-b border-border/40 last:border-b-0">
      {collapsible && (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className={cn(
            "flex w-full items-center gap-1.5 px-1.5 text-left text-xs hover:bg-accent/40",
            coarse ? "min-h-11" : "min-h-8"
          )}
        >
          <HugeiconsIcon
            icon={open ? ArrowDown01Icon : ArrowRight01Icon}
            strokeWidth={2}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 truncate font-medium">{repo.name}</span>
          <span className="flex min-w-0 shrink items-center gap-1 truncate text-[10px] text-muted-foreground">
            <HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} className="size-3 shrink-0" />
            <span className="truncate font-mono">{branch}</span>
          </span>
          <span className="flex-1" />
          {count !== null && count > 0 && (
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] tabular-nums">
              {count}
            </span>
          )}
        </button>
      )}

      {open && (
        <div>
          {state?.error && <PanelNotice className="text-destructive">{state.error}</PanelNotice>}
          {writeError && <PanelNotice className="text-destructive">{writeError}</PanelNotice>}
          {output && <PanelNotice className="font-mono">{output}</PanelNotice>}

          {!status && !state?.error ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">Reading the repository…</p>
          ) : status && !status.repository ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              This directory is no longer a git repository.
            </p>
          ) : groups.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">The worktree is clean.</p>
          ) : (
            <div className="p-1">
              {groups.map((group) => (
                <Group
                  key={group.key}
                  title={group.title}
                  side={group.side}
                  rows={group.files.map((file) => ({ file, side: group.side }))}
                  layout={layout}
                  coarse={coarse}
                  busy={busy}
                  collapsedDirs={collapsedDirs}
                  onToggleDir={(path) =>
                    setCollapsedDirs((current) => {
                      const next = new Set(current)
                      const key = `${group.key}:${path}`
                      if (next.has(key)) next.delete(key)
                      else next.add(key)
                      return next
                    })
                  }
                  dirKey={(path) => `${group.key}:${path}`}
                  onOpen={openRow}
                  onStage={(paths) =>
                    void write({ action: group.side === "index" ? "unstage" : "stage", paths })
                  }
                  onDiscard={(paths, what) =>
                    void discard(paths, group.side === "untracked", what)
                  }
                />
              ))}
            </div>
          )}

          {status?.repository && (
            <form
              className="border-t border-border/60 p-2"
              onSubmit={(event) => {
                event.preventDefault()
                void commit()
              }}
            >
              <Textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder={collapsible ? `Commit to ${repo.name}` : "Commit message"}
                rows={2}
                className="min-h-0 text-xs"
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault()
                    void commit()
                  }
                }}
              />
              {/* One row of icons, the same ones the file rows wear: stage
                  everything on the left, commit what is staged on the right,
                  each with its count beside it. */}
              <div className="mt-1 flex items-center gap-1">
                <IconAction
                  label={`Stage all ${unstaged.length}`}
                  icon={PlusSignIcon}
                  disabled={busy || unstaged.length === 0}
                  onClick={() => void write({ action: "stage", paths: unstaged.map((file) => file.path) })}
                />
                <Count value={unstaged.length} />
                <span className="flex-1" />
                <Count value={stagedCount} />
                <IconAction
                  label={`Commit ${stagedCount > 0 ? `${stagedCount} staged` : ""} on ${branch} (⌘Enter)`}
                  icon={Tick02Icon}
                  variant="default"
                  disabled={busy || !message.trim()}
                  onClick={() => void commit()}
                />
              </div>
            </form>
          )}
        </div>
      )}
    </section>
  )
}

/* ── One group of rows ──
   Staged, changed, untracked, conflicted. The group is where the tree is built,
   because a file can be in two groups at once (staged *and* changed) and one
   tree over both would have to say which of the two a row was. */
function Group({
  title,
  side,
  rows,
  layout,
  coarse,
  busy,
  collapsedDirs,
  dirKey,
  onToggleDir,
  onOpen,
  onStage,
  onDiscard,
}: {
  title: string
  side: Side
  rows: Row[]
  layout: FileLayout
  coarse: boolean
  busy: boolean
  collapsedDirs: ReadonlySet<string>
  dirKey: (path: string) => string
  onToggleDir: (path: string) => void
  onOpen: (file: GitFileState, side: Side) => void
  onStage: (paths: string[]) => void
  onDiscard: (paths: string[], what: string) => void
}) {
  const tree = React.useMemo(
    () => (layout === "tree" ? buildPathTree(rows, (row) => row.file.path, { compact: true }) : null),
    [layout, rows]
  )

  const header = (
    <div
      className={cn(
        "flex items-center gap-1 px-1 text-[11px] font-medium text-muted-foreground",
        coarse ? "min-h-10" : "min-h-7"
      )}
    >
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span className="font-mono tabular-nums opacity-70">{rows.length}</span>
      {side !== "index" && (
        <IconAction
          label={`Discard all in ${title.toLowerCase()}`}
          icon={ArrowTurnBackwardIcon}
          disabled={busy}
          className="hover:text-destructive"
          onClick={() =>
            onDiscard(
              rows.map((row) => row.file.path),
              `${rows.length} ${rows.length === 1 ? "file" : "files"}`
            )
          }
        />
      )}
      <IconAction
        label={side === "index" ? "Unstage all" : "Stage all"}
        icon={side === "index" ? MinusSignIcon : PlusSignIcon}
        disabled={busy}
        onClick={() => onStage(rows.map((row) => row.file.path))}
      />
    </div>
  )

  return (
    <div className="mb-1">
      {header}
      {tree ? (
        <TreeRows
          node={tree}
          depth={0}
          side={side}
          coarse={coarse}
          busy={busy}
          collapsedDirs={collapsedDirs}
          dirKey={dirKey}
          onToggleDir={onToggleDir}
          onOpen={onOpen}
          onStage={onStage}
          onDiscard={onDiscard}
        />
      ) : (
        rows.map((row) => (
          <FileRow
            key={row.file.path}
            row={row}
            depth={0}
            showDir
            coarse={coarse}
            busy={busy}
            onOpen={onOpen}
            onStage={onStage}
            onDiscard={onDiscard}
          />
        ))
      )}
    </div>
  )
}

function TreeRows({
  node,
  depth,
  side,
  coarse,
  busy,
  collapsedDirs,
  dirKey,
  onToggleDir,
  onOpen,
  onStage,
  onDiscard,
}: {
  node: Tree
  depth: number
  side: Side
  coarse: boolean
  busy: boolean
  collapsedDirs: ReadonlySet<string>
  dirKey: (path: string) => string
  onToggleDir: (path: string) => void
  onOpen: (file: GitFileState, side: Side) => void
  onStage: (paths: string[]) => void
  onDiscard: (paths: string[], what: string) => void
}) {
  return (
    <>
      {node.dirs.map((dir) => {
        const collapsed = collapsedDirs.has(dirKey(dir.path))
        const under = filesUnder(dir).map((leaf) => leaf.item.file.path)
        return (
          <React.Fragment key={dir.path}>
            <div
              className={cn(
                "group flex items-center gap-1 rounded-md pr-1 text-xs text-muted-foreground hover:bg-accent/40",
                coarse ? "min-h-11" : "min-h-7"
              )}
              style={indent(depth)}
            >
              <button
                type="button"
                onClick={() => onToggleDir(dir.path)}
                aria-expanded={!collapsed}
                className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
                title={dir.path}
              >
                <HugeiconsIcon
                  icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon}
                  strokeWidth={2}
                  className="size-3.5 shrink-0"
                />
                <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate font-mono">{dir.name}</span>
                <span className="shrink-0 font-mono text-[10px] tabular-nums opacity-60">
                  {countFiles(dir)}
                </span>
              </button>
              {/* A folder acts on everything under it — the reason the tree is
                  worth having on a phone, where twelve taps is not a plan. */}
              <RowActions coarse={coarse}>
                {side !== "index" && (
                  <IconAction
                    label={`Discard everything in ${dir.name}`}
                    icon={ArrowTurnBackwardIcon}
                    disabled={busy}
                    className="hover:text-destructive"
                    onClick={() => onDiscard(under, dir.name)}
                  />
                )}
                <IconAction
                  label={side === "index" ? `Unstage ${dir.name}` : `Stage ${dir.name}`}
                  icon={side === "index" ? MinusSignIcon : PlusSignIcon}
                  disabled={busy}
                  onClick={() => onStage(under)}
                />
              </RowActions>
            </div>
            {!collapsed && (
              <TreeRows
                node={dir}
                depth={depth + 1}
                side={side}
                coarse={coarse}
                busy={busy}
                collapsedDirs={collapsedDirs}
                dirKey={dirKey}
                onToggleDir={onToggleDir}
                onOpen={onOpen}
                onStage={onStage}
                onDiscard={onDiscard}
              />
            )}
          </React.Fragment>
        )
      })}
      {node.files.map((leaf: Leaf) => (
        <FileRow
          key={leaf.path}
          row={leaf.item}
          depth={depth}
          coarse={coarse}
          busy={busy}
          onOpen={onOpen}
          onStage={onStage}
          onDiscard={onDiscard}
        />
      ))}
    </>
  )
}

function FileRow({
  row,
  depth,
  showDir,
  coarse,
  busy,
  onOpen,
  onStage,
  onDiscard,
}: {
  row: Row
  depth: number
  /** The list layout prints the directory beside the name; the tree drew it. */
  showDir?: boolean
  coarse: boolean
  busy: boolean
  onOpen: (file: GitFileState, side: Side) => void
  onStage: (paths: string[]) => void
  onDiscard: (paths: string[], what: string) => void
}) {
  const { file, side } = row
  const mark = markOf(file, side)
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""
  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-md pr-1 text-xs hover:bg-accent/50",
        coarse ? "min-h-11" : "min-h-7"
      )}
      style={indent(depth)}
    >
      <button
        type="button"
        onClick={() => onOpen(file, side)}
        className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
        title={`${LABEL[mark] ?? "Changed"} · ${file.from ? `${file.from} → ${file.path}` : file.path}`}
      >
        <span className={cn("min-w-0 truncate", mark === "D" && "line-through opacity-70")}>
          {basename(file.path)}
        </span>
        {showDir && dir && (
          <span className="hidden min-w-0 shrink truncate text-[10px] text-muted-foreground @panel-sm:block">
            {dir}
          </span>
        )}
        <span className="flex-1" />
        <span className={cn("w-3 shrink-0 text-center font-mono", MARK_CLASS[mark] ?? "text-muted-foreground")}>
          {mark}
        </span>
      </button>
      <RowActions coarse={coarse}>
        {side !== "index" && mark !== "D" && (
          <IconAction
            label="Discard"
            icon={ArrowTurnBackwardIcon}
            disabled={busy}
            className="hover:text-destructive"
            onClick={() => onDiscard([file.path], basename(file.path))}
          />
        )}
        <IconAction
          label={side === "index" ? "Unstage" : "Stage"}
          icon={side === "index" ? MinusSignIcon : PlusSignIcon}
          disabled={busy}
          onClick={() => onStage([file.path])}
        />
      </RowActions>
    </div>
  )
}

/** Row actions: revealed on hover with a mouse, **always shown** on a finger —
    there is no hover to reveal them with, and a button you have to long-press
    to discover is a button that is not there. */
function RowActions({ coarse, children }: { coarse: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center transition-opacity",
        !coarse && "opacity-0 group-hover:opacity-100 has-focus-visible:opacity-100"
      )}
    >
      {children}
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

/** An icon button with its label as a tooltip — the row actions are icon-only
    for room, and an icon with no name is a guess. The tap target is 44px on a
    finger and 24px with a mouse; both draw the same 14px glyph, so the row's
    rhythm does not change with the pointer. */
/** A count beside an icon action; nothing when there is nothing to count. */
function Count({ value }: { value: number }) {
  if (value === 0) return null
  return <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{value}</span>
}

function IconAction({
  label,
  icon,
  onClick,
  disabled,
  className,
  variant = "ghost",
}: {
  label: string
  icon: typeof PlusSignIcon
  onClick: () => void
  disabled?: boolean
  className?: string
  variant?: React.ComponentProps<typeof Button>["variant"]
}) {
  const coarse = useCoarsePointer()
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={variant}
            size="icon-xs"
            disabled={disabled}
            onClick={onClick}
            aria-label={label}
            className={cn(coarse ? "size-11" : "size-6", className)}
          >
            <HugeiconsIcon icon={icon} strokeWidth={2} className="size-3.5" />
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

const indent = (depth: number): React.CSSProperties => ({ paddingLeft: `${depth * 12 + 4}px` })
