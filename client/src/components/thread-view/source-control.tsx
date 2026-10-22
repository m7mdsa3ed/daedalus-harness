import { MENU_WIDTH } from "@/components/menu-row"
import * as React from "react"
import {
  ArchiveIcon,
  ArrowDownToLineIcon,
  ArrowLeftIcon,
  ArrowUpFromLineIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloudDownloadIcon,
  FileIcon,
  GitBranchIcon,
  MinusIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RefreshCwIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react"
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Empty } from "@/components/empty"
import { ErrorNote } from "@/components/error-note"
import { Notice } from "@/components/notice"
import { PanelRowsSkeleton } from "@/components/ui/skeletons"
import { PanelToolbar } from "@/components/workspace/primitives"
import { ActionIcon, actionClass, useActionState } from "@/components/ui/action-state"
import type { WebDiff } from "@/lib/workspace/panels"
import { DockContext } from "@/components/workspace/dock-context"
import { DiffTab, type DiffSide } from "@/components/workspace/diff-tab"
import { BranchPicker } from "@/components/workspace/scm/branch-picker"
import { CommitBox } from "@/components/workspace/scm/commit-box"
import { CommitDetailView } from "@/components/workspace/scm/commit-detail"
import { CommitTable } from "@/components/workspace/scm/commit-table"
import { HunkDiff, type DiffSource, type HunkVerb } from "@/components/workspace/scm/hunk-diff"
import { Locations } from "@/components/workspace/scm/locations"
import { ScmDock } from "@/components/workspace/scm/scm-dock"
import { LineCounts } from "@/components/workspace/scm/shared"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tracking } from "@/components/workspace/scm/branch-menu"
import { useConfirm } from "@/components/confirm-dialog"
import { captureError, inlineFromQuery, type InlineError } from "@/lib/errors"
import { useCoarsePointer } from "@/hooks/use-device"
import { projectGitBranchesKey, projectGitRefsKey, projectGitLogKey, projectGitStatusKey, projectReposKey } from "@/lib/queries/keys"
import { useGitStatus } from "@/lib/queries/surfaces"
import { useServer } from "@/lib/server-context"
import { cn } from "@/lib/utils"
import { countsOf, linesOf, scmGroups, workingSet, type GroupId, type WorkingFile } from "@/lib/workspace/working-set"
import { basename } from "@/lib/workspace/fs-api"
import {
  gitLog,
  gitRepos,
  gitWrite,
  projectPath,
  stashPush,
  type CommitFile,
  type GitAction,
  type GitCommit,
  type GitRepo,
  type GitStatus,
} from "@/lib/workspace/git-api"
import { watchProject } from "@/lib/workspace/watch"

/** Commits per page of the table; the server's own ceiling is 200. */
const LOG_PAGE = 50

/** The panel is the Git half and nothing else: the turn review it used to
    share the space with is gone, and a turn's files are the working
    directory's in the commit table's first row. `repo` is the thread's own
    checkout when it is not the project's. */
export default function SourceControl({ projectId, repo }: { projectId: string; repo?: string }) {
  return <GitWorkspace projectId={projectId} pinnedRepo={repo} />
}

interface OpenDiff {
  path: string
  left: DiffSide
  right: DiffSide
  repo?: string
}

/* ── The Git half ──
   Sublime Merge's shape: a Locations pane (branches, remotes, tags, stashes) at
   the left, the commit table above and a detail pane below. The table's first
   row is the Working Directory; selecting it makes the detail the staging area
   (files at the left, the file's hunks at the right, the commit box under the
   files), and selecting a commit makes it the commit's message, files and
   hunks. The header keeps the repository, branch and fetch/pull/push. Every
   write answers the next status, which is what repaints. */
function GitWorkspace({ projectId, pinnedRepo }: { projectId: string; pinnedRepo?: string }) {
  const settings = useServer()
  const queryClient = useQueryClient()
  const coarse = useCoarsePointer()
  const confirm = useConfirm()
  const [repos, setRepos] = React.useState<GitRepo[] | null>(null)
  const [repoError, setRepoError] = React.useState<InlineError | null>(null)
  const [repoPath, setRepoPath] = React.useState(pinnedRepo ?? "")
  const [busy, setBusy] = React.useState(false)
  const act = useActionState<"fetch" | "pull" | "push" | "commit">()
  const [error, setError] = React.useState<InlineError | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [stashGeneration, setStashGeneration] = React.useState(0)
  /* A commit, or null for the Working Directory. */
  const [selected, setSelected] = React.useState<GitCommit | null>(null)
  const [openFile, setOpenFile] = React.useState<{ path: string; staged: boolean } | null>(null)
  const [commitFile, setCommitFile] = React.useState<CommitFile | null>(null)
  /* The rows ticked for a bulk verb, `${group}\0${path}` - a path can stand in
     two groups, and each row is its own tick. Dropped with the repository, and
     read through `livePicks` so a tick on a row that moved or went is not acted on. */
  const [picks, setPicks] = React.useState<ReadonlySet<string>>(() => new Set())
  const pickAnchor = React.useRef<{ group: GroupId; index: number } | null>(null)
  const [diff, setDiff] = React.useState<OpenDiff | null>(null)
  /* The diff is read in the Preview panel, like a file; without a dock (a phone's
     stacked sheet) it falls back to replacing this view. */
  const dock = React.useContext(DockContext)
  const showDiff = (next: OpenDiff) =>
    dock
      ? dock.openPanel({ kind: "web", viewId: "default", projectId, file: undefined, diff: next as WebDiff })
      : setDiff(next)
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<GroupId>>(() => new Set())
  /* An undone commit's message, handed back to the box it came from. */
  const [prefill, setPrefill] = React.useState<{ text: string; id: number } | null>(null)
  const statusQuery = useGitStatus(projectId, repoPath)
  const status = statusQuery.data ?? null
  /* The history loads a page at a time as the table's foot scrolls into view. */
  const log = useInfiniteQuery({
    queryKey: projectGitLogKey(settings, projectId, repoPath).concat(["pages"]),
    queryFn: ({ pageParam, signal }) => gitLog(settings, projectId, { limit: LOG_PAGE, skip: pageParam, all: true, repo: repoPath || undefined }, signal),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.length < LOG_PAGE ? undefined : pages.reduce((sum, page) => sum + page.length, 0)),
    staleTime: 30_000,
  })
  const commits = React.useMemo(() => log.data?.pages.flat() ?? [], [log.data])
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = log
  const moreLog = React.useCallback(() => void fetchNextPage(), [fetchNextPage])

  React.useEffect(() => {
    let active = true
    const read = pinnedRepo !== undefined
      ? Promise.resolve([{ path: pinnedRepo, name: pinnedRepo.split("/").pop() || "Project", branch: null, worktree: false }])
      : gitRepos(settings, projectId)
    void read.then((found) => {
      if (!active) return
      setRepos(found)
      setRepoError(null)
      setRepoPath((current) => found.some((repo) => repo.path === current) ? current : (found[0]?.path ?? ""))
      queryClient.setQueryData(projectReposKey(settings, projectId), found)
    }).catch((err: unknown) => {
      if (active) setRepoError(captureError(err, "Repository scan failed"))
    })
    return () => { active = false }
  }, [projectId, pinnedRepo, queryClient, settings])

  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const stop = watchProject(projectId, (batch) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        if (batch.overflow || batch.events.some((event) => event.path === ".git" || event.path.endsWith("/.git"))) {
          if (pinnedRepo === undefined) {
            void gitRepos(settings, projectId).then((found) => {
              setRepos(found)
              queryClient.setQueryData(projectReposKey(settings, projectId), found)
              setRepoPath((current) => found.some((repo) => repo.path === current) ? current : (found[0]?.path ?? ""))
            }).catch((err: unknown) => setRepoError(captureError(err, "Repository scan failed")))
          }
        }
        void queryClient.invalidateQueries({ queryKey: projectGitStatusKey(settings, projectId, repoPath) })
      }, 350)
    })
    return () => {
      if (timer) clearTimeout(timer)
      stop()
    }
  }, [projectId, pinnedRepo, queryClient, repoPath, settings])

  const repo = repos?.find((item) => item.path === repoPath) ?? repos?.[0]
  const files = React.useMemo(() => status ? workingSet(status) : [], [status])
  const counts = React.useMemo(() => countsOf(files), [files])
  const groups = React.useMemo(() => status ? scmGroups(status) : [], [status])
  /* The file the diff shows: the one picked if it is still in the working set,
     else the same path in its other state, else the first. */
  const flat = groups.flatMap((group) => group.files.map((file) => ({ file, group: group.id })))
  const active =
    flat.find((row) => row.file.path === openFile?.path && (row.group === "staged") === openFile.staged) ??
    flat.find((row) => row.file.path === openFile?.path) ??
    flat[0] ??
    null

  const pickKey = (group: GroupId, path: string) => `${group}\0${path}`
  const picked = flat.filter((row) => picks.has(pickKey(row.group, row.file.path)))
  const togglePick = (group: GroupId, index: number, shift: boolean) => {
    const rows = groups.find((item) => item.id === group)?.files ?? []
    const anchor = pickAnchor.current
    const range = shift && anchor?.group === group ? rows.slice(Math.min(anchor.index, index), Math.max(anchor.index, index) + 1) : [rows[index]!]
    setPicks((current) => {
      const next = new Set(current)
      const on = !current.has(pickKey(group, rows[index]!.path))
      for (const file of range) {
        if (on) next.add(pickKey(group, file.path))
        else next.delete(pickKey(group, file.path))
      }
      return next
    })
    pickAnchor.current = { group, index }
  }
  const pickGroup = (group: GroupId, on: boolean) =>
    setPicks((current) => {
      const next = new Set(current)
      for (const file of groups.find((item) => item.id === group)?.files ?? []) {
        if (on) next.add(pickKey(group, file.path))
        else next.delete(pickKey(group, file.path))
      }
      return next
    })
  /* The bulk verbs act on what is ticked, per state: a ticked staged row is
     unstaged, a changed or conflicted one is staged (resolved), and only a
     tracked changed one can be discarded. */
  const bulk = async (verb: "stage" | "unstage" | "discard") => {
    const paths = picked
      .filter((row) => (verb === "unstage" ? row.group === "staged" : verb === "stage" ? row.group !== "staged" : row.group === "changes" && !row.file.untracked))
      .map((row) => row.file.path)
    if (paths.length === 0) return
    if (verb === "discard") await discard(paths, `${paths.length} files`)
    else if (!(await write({ action: verb, paths }))) return
    setPicks(new Set())
  }

  const updateStatus = (next: GitStatus) => {
    queryClient.setQueryData(projectGitStatusKey(settings, projectId, repoPath), next)
  }

  const LOG_MOVERS = new Set<GitAction["action"]>(["commit", "pull", "push", "fetch", "undo", "checkout", "merge", "rebase", "rename-branch", "delete-branch", "delete-tag"])
  const DONE: Partial<Record<GitAction["action"], string>> = {
    commit: "Commit created.",
    pull: "Pull complete.",
    push: "Push complete.",
    fetch: "Fetched.",
  }

  const write = async (action: GitAction) => {
    if ("paths" in action && action.paths.length === 0) return false
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await gitWrite(settings, projectId, { ...action, repo: repoPath || undefined })
      updateStatus(result)
      if (action.action === "undo") {
        const text = result.output?.trim() ?? ""
        setNotice(`Undid “${text.split("\n")[0]}” — its changes are staged.`)
        if (text) setPrefill({ text, id: Date.now() })
      } else if (DONE[action.action]) {
        setNotice(result.output?.split("\n").find((line) => line.trim())?.trim() ?? DONE[action.action]!)
      }
      /* These move HEAD or a ref, which is what the table draws. */
      if (LOG_MOVERS.has(action.action)) {
        void queryClient.invalidateQueries({ queryKey: projectGitLogKey(settings, projectId, repoPath) })
        void queryClient.invalidateQueries({ queryKey: projectGitBranchesKey(settings, projectId, repoPath) })
        void queryClient.invalidateQueries({ queryKey: projectGitRefsKey(settings, projectId, repoPath) })
      }
      return true
    } catch (err) {
      setError(captureError(err, "Git operation failed"))
      void queryClient.invalidateQueries({ queryKey: projectGitStatusKey(settings, projectId, repoPath) })
      return false
    } finally {
      setBusy(false)
    }
  }

  const discard = async (paths: string[], what: string) => {
    const ok = await confirm({
      title: `Discard changes in ${what}?`,
      description: "The working-tree changes are thrown away. Untracked files are left alone. This cannot be undone.",
      confirmLabel: "Discard",
      destructive: true,
    })
    if (ok) await write({ action: "discard", paths })
  }

  /* Nothing staged means "stage everything, then commit" — the button already
     says so — asked once, because it is a bigger commit than the list shows
     ticked. An amend needs nothing staged: rewording is an amend. */
  const commitWith = async (message: string, amend: boolean) => {
    if (counts.staged === 0 && !amend) {
      if (counts.unstaged === 0) return false
      const ok = await confirm({
        title: `Stage all ${counts.unstaged} ${counts.unstaged === 1 ? "change" : "changes"} and commit?`,
        description: "Nothing is staged yet, so everything changed goes into this commit.",
        confirmLabel: "Stage all and commit",
      })
      if (!ok) return false
      const staged = await write({ action: "stage", paths: files.filter((file) => file.staged !== "yes" && !file.conflicted).map((file) => file.path) })
      if (!staged) return false
    }
    return act.run("commit", () => write({ action: "commit", message, amend }))
  }

  /* Soft, so nothing on disk moves — but a commit already on the remote comes
     back as a rewrite the next push has to force, and that is worth saying. */
  const undo = async () => {
    const pushed = !!status?.upstream && status.ahead === 0
    const ok = await confirm({
      title: "Undo the last commit?",
      description: pushed
        ? `It is already on ${status?.upstream}, so pushing afterwards rewrites the remote's history. Its changes stay staged.`
        : "The commit is taken back, its changes stay staged, and its message goes back in the box.",
      confirmLabel: "Undo commit",
      destructive: pushed,
    })
    if (ok) await write({ action: "undo" })
  }

  const stash = async (stashMessage: string) => {
    setBusy(true)
    setError(null)
    try {
      const next = await stashPush(settings, projectId, { repo: repoPath || undefined, message: stashMessage || undefined })
      updateStatus(next)
      setNotice(next.created ? "Working tree stashed." : "Nothing to stash.")
      if (next.created) {
        setStashGeneration((current) => current + 1)
      }
    } catch (err) {
      setError(captureError(err, "Git operation failed"))
    } finally {
      setBusy(false)
    }
  }

  const openRow = (file: WorkingFile, group: GroupId) => {
    const path = projectPath(repoPath, file.path)
    if (file.untracked || file.conflicted || (group === "changes" && file.mark === "A")) showDiff({ path, left: "head", right: "worktree", repo: repoPath })
    else if (group === "staged") showDiff({ path, left: "head", right: "staged", repo: repoPath })
    else showDiff({ path, left: "staged", right: "worktree", repo: repoPath })
  }

  /* One hunk, or some of its lines, through the `apply` door: stage is
     `--cached`, unstage is `--cached --reverse`, discard is `--reverse` on the
     worktree. Only discard asks - the others are one click from undone. */
  const applyHunk = async (patch: string, verb: HunkVerb) => {
    if (verb === "discard") {
      const ok = await confirm({
        title: "Discard this change?",
        description: "It is thrown away from the working tree. This cannot be undone.",
        confirmLabel: "Discard",
        destructive: true,
      })
      if (!ok) return false
    }
    return write({ action: "apply", patch, cached: verb !== "discard", reverse: verb !== "stage" })
  }

  const branch = status?.branch ?? repo?.branch ?? (status?.unborn ? "no commits yet" : "detached")
  const standing = !status
    ? null
    : status.unborn
      ? "No commits yet"
      : !status.branch
        ? "Detached HEAD"
        : !status.upstream
          ? "Not published"
          : status.ahead === 0 && status.behind === 0
            ? `Up to date with ${status.upstream}`
            : [status.ahead > 0 && `${status.ahead} to push`, status.behind > 0 && `${status.behind} to pull`].filter(Boolean).join(" · ") + ` · ${status.upstream}`

  if (diff) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PanelToolbar className="gap-2">
          <Button variant="ghost" size="xs" onClick={() => setDiff(null)}>
            <ArrowLeftIcon data-icon="inline-start" /> Back
          </Button>
          <span className="truncate font-mono text-xs text-muted-foreground">{diff.path}</span>
        </PanelToolbar>
        <div className="min-h-0 flex-1"><DiffTab projectId={projectId} path={diff.path} left={diff.left} right={diff.right} repo={diff.repo} active /></div>
      </div>
    )
  }

  if (repoError) return <ErrorNote error={repoError} className="m-3" />
  if (!repos) return <PanelRowsSkeleton />
  if (repos.length === 0) return <Empty className="m-3" icon={GitBranchIcon}>No repository found. This project does not contain a Git repository.</Empty>
  if (!repo) return null

  const remote = !!status?.repository && !status.unborn
  const iconButton = coarse ? "size-10" : "size-6"

  /* The four panes, built here and handed to the dock: they all read the one
     selection (which commit, which file), which a dock cannot own. */
  const locationsPane = (
  <Locations
    projectId={projectId}
    repo={repoPath}
    head={status?.branch ?? null}
    coarse={coarse}
    busy={busy}
    canStash={counts.total > 0}
    stashGeneration={stashGeneration}
    onReveal={(ref) => {
      const found = commits.find((item) => item.refs.includes(ref))
      if (found) { setSelected(found); setCommitFile(null) }
    }}
    onCheckout={(name, remoteRef) => void write({ action: "checkout", branch: name, track: remoteRef })}
    onAction={write}
    onStash={(message) => void stash(message)}
    onStatus={updateStatus}
  />
  )

  const historyPane = (
  <CommitTable
    commits={commits}
    current={status?.branch ?? null}
    changes={counts.total}
    selected={selected?.hash ?? null}
    onSelect={(next) => { setSelected(next); setCommitFile(null) }}
    onMore={hasNextPage ? moreLog : undefined}
    loading={isFetchingNextPage || log.isPending}
  />
  )

  const filesPane = selected ? (
  <CommitDetailView
    projectId={projectId}
    repo={repoPath}
    commit={selected}
    coarse={coarse}
    selected={commitFile?.path}
    onOpenFile={setCommitFile}
  />
  ) : (
    <>
          <div className="min-h-0 flex-1 overflow-auto">
            {statusQuery.error ? (
              <ErrorNote error={inlineFromQuery(statusQuery.error, "Status unavailable")} onRetry={() => void statusQuery.refetch()} className="m-3" />
            ) : statusQuery.isLoading && !status ? (
              <PanelRowsSkeleton />
            ) : groups.length === 0 ? (
              <Empty className="m-3" icon={FileIcon}>Working tree is clean. Changes will appear here as the project moves.</Empty>
            ) : (
              groups.map((group) => {
                const shut = collapsed.has(group.id)
                const paths = group.files.map((file) => file.path)
                const lines = linesOf(group.files)
                const tracked = group.files.filter((file) => !file.untracked).map((file) => file.path)
                return (
                  <section key={group.id}>
                    <div className={cn("flex items-center gap-2 border-l-2 border-transparent bg-muted pl-2 pr-1 text-xs font-medium text-muted-foreground", coarse ? "min-h-11" : "min-h-6")}>
                      <Checkbox
                        aria-label={`Select all in ${group.title}`}
                        className="size-3.5 rounded-md"
                        checked={group.files.every((file) => picks.has(pickKey(group.id, file.path)))}
                        indeterminate={group.files.some((file) => picks.has(pickKey(group.id, file.path))) && !group.files.every((file) => picks.has(pickKey(group.id, file.path)))}
                        onCheckedChange={(on) => pickGroup(group.id, on)}
                      />
                      <button type="button" aria-expanded={!shut} onClick={() => setCollapsed((current) => toggled(current, group.id))} className="flex min-w-0 items-center gap-1 self-stretch text-left">
                        {shut ? <ChevronRightIcon className="size-4 shrink-0" /> : <ChevronDownIcon className="size-4 shrink-0" />}
                        <span className="truncate">{group.title}</span>
                        <span className="font-mono tabular-nums normal-case">({group.files.length})</span>
                        <LineCounts insertions={lines.insertions} deletions={lines.deletions} className="font-normal normal-case" />
                      </button>
                      {group.id === "staged" ? (
                        <TextVerb disabled={busy} onClick={() => void write({ action: "unstage", paths })}>Unstage All</TextVerb>
                      ) : (
                        <>
                          {group.id === "changes" && tracked.length > 0 && (
                            <TextVerb destructive disabled={busy} onClick={() => void discard(tracked, `all ${tracked.length} files`)}>Discard All</TextVerb>
                          )}
                          <TextVerb disabled={busy} onClick={() => void write({ action: "stage", paths })}>{group.id === "merge" ? "Mark Resolved" : "Stage All"}</TextVerb>
                        </>
                      )}
                      {/* The rest of the bar still folds the group, as the title did. */}
                      <button type="button" tabIndex={-1} aria-hidden onClick={() => setCollapsed((current) => toggled(current, group.id))} className="min-h-5 flex-1 self-stretch" />
                    </div>
                    {!shut && (
                      <div>
                        {group.files.map((file, index) => (
                          <FileRow
                            key={file.path}
                            file={file}
                            group={group.id}
                            picked={picks.has(pickKey(group.id, file.path))}
                            selecting={picked.length > 0}
                            onPick={(shift) => togglePick(group.id, index, shift)}
                            active={active?.file.path === file.path && active.group === group.id}
                            busy={busy}
                            coarse={coarse}
                            onOpen={() => setOpenFile({ path: file.path, staged: group.id === "staged" })}
                            onStage={() => void write({ action: group.id === "staged" ? "unstage" : "stage", paths: [file.path] })}
                            onDiscard={() => void discard([file.path], basename(file.path))}
                          />
                        ))}
                      </div>
                    )}
                  </section>
                )
              })
            )}
          </div>
          {picked.length > 0 && (
            <div role="toolbar" aria-label="Bulk actions" className="flex shrink-0 flex-wrap items-center gap-1 border-t bg-accent px-2 py-1 text-xs">
              <span className="mr-auto font-medium tabular-nums">{picked.length} selected</span>
              {picked.some((row) => row.group !== "staged") && <TextVerb disabled={busy} onClick={() => void bulk("stage")}>{picked.every((row) => row.group === "merge") ? "Mark Resolved" : "Stage"}</TextVerb>}
              {picked.some((row) => row.group === "staged") && <TextVerb disabled={busy} onClick={() => void bulk("unstage")}>Unstage</TextVerb>}
              {picked.some((row) => row.group === "changes" && !row.file.untracked) && <TextVerb destructive disabled={busy} onClick={() => void bulk("discard")}>Discard</TextVerb>}
              <Button variant="ghost" size="icon-xs" title="Clear selection" aria-label="Clear selection" onClick={() => setPicks(new Set())} className="text-muted-foreground"><XIcon /></Button>
            </div>
          )}
          <CommitBox
            key={`${projectId}:${repoPath}`}
            projectId={projectId}
            repo={repoPath}
            repoName={repo.name}
            named={repos.length > 1}
            branch={branch}
            busy={busy}
            commitPhase={act.phase("commit")}
            changeCount={counts.total}
            stagedCount={counts.staged}
            unstagedCount={counts.unstaged}
            canAmend={remote}
            prefill={prefill}
            onCommit={commitWith}
            onError={(message) => setError(message ? { title: message, kind: "unknown", context: "Git operation failed", text: `Git operation failed\n${message}` } : null)}
          />
    </>
  )

  const diffPane = selected
    ? commitFile && (
        <HunkDiff
          projectId={projectId}
          repo={repoPath}
          path={commitFile.path}
          from={commitFile.from}
          source={{ rev: selected.hash }}
          version={0}
          onOpenFull={() => showDiff({
            path: projectPath(repoPath, commitFile.path),
            left: { rev: commitFile.status === "A" ? "" : (selected.parents[0] ?? "") },
            right: { rev: commitFile.status === "D" ? "" : selected.hash },
          })}
        />
      )
    : active && (
        <HunkDiff
          projectId={projectId}
          repo={repoPath}
          path={active.file.path}
          from={active.file.from}
          untracked={active.file.untracked}
          source={(active.group === "staged" ? "staged" : "unstaged") satisfies DiffSource}
          version={statusQuery.dataUpdatedAt}
          busy={busy}
          onApply={active.group === "merge" ? undefined : applyHunk}
          onOpenFull={() => openRow(active.file, active.group)}
        />
      )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header title={standing ?? undefined} className="contents">
      <PanelToolbar className="flex-wrap">
        <div className="contents">
          {repos.length > 1 ? (
            <Select value={repoPath} onValueChange={(value) => { setRepoPath(value as string); setPicks(new Set()); setDiff(null); setSelected(null); setOpenFile(null) }}>
              <SelectTrigger size="sm" aria-label="Repository" className="order-1 h-6 min-w-0 max-w-44 shrink font-medium">
                <SelectValue>
                  <span className="truncate">{repo.name}</span>
                  {repo.worktree && <WorktreeBadge />}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {repos.map((item) => (
                  <SelectItem key={item.path || "."} value={item.path}>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{item.name}</span>
                      {item.worktree && <WorktreeBadge />}
                      {item.branch && <span className="truncate font-mono text-xs font-normal text-muted-foreground">{item.branch}</span>}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : <div className="order-1 flex min-w-0 max-w-44 shrink items-center gap-2 text-sm font-medium"><span className="truncate">{repo.name}</span>{repo.worktree && <WorktreeBadge />}</div>}
          <Button variant="ghost" size="icon-xs" title="Refresh repository status" aria-label="Refresh repository status" loading={statusQuery.isFetching} onClick={() => void statusQuery.refetch()} className={cn(iconButton, "order-5")}>
            <RefreshCwIcon className={cn(statusQuery.isFetching && "animate-spin")} />
          </Button>
          {status?.repository && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`More for ${repo.name}`} className={cn(iconButton, "order-6")}><MoreHorizontalIcon /></Button>} />
              <DropdownMenuContent align="end" className={MENU_WIDTH}>
                <DropdownMenuItem disabled={busy} onClick={() => void write({ action: "fetch" })}><CloudDownloadIcon />Fetch all remotes</DropdownMenuItem>
                <DropdownMenuItem disabled={busy || counts.staged === 0} onClick={() => void write({ action: "unstage", paths: files.filter((file) => file.staged !== "no").map((file) => file.path) })}><MinusIcon />Unstage everything</DropdownMenuItem>
                <DropdownMenuItem disabled={busy || counts.total === 0} onClick={() => void stash("")}><ArchiveIcon />Stash everything</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={busy || status.unborn} onClick={() => void undo()}><Undo2Icon />Undo last commit</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <div className="contents">
          <BranchPicker
            projectId={projectId}
            repo={repoPath}
            branch={branch}
            unborn={status?.unborn ?? false}
            disabled={busy || !status?.repository}
            onPick={(choice) => void write({ action: "checkout", branch: choice.branch, create: choice.create, track: choice.track })}
            className={cn("order-2 flex min-w-0 max-w-full items-center gap-1 rounded-md border bg-background px-2 py-0.5 font-mono text-sm", coarse && "min-h-11")}
          >
            <GitBranchIcon className="size-3.5 shrink-0" /><span className="truncate">{branch}</span>
          </BranchPicker>
          <div className="order-3"><Tracking status={status} /></div>
          <div className="order-4 ml-auto flex shrink-0 gap-1">
            <Button variant="ghost" size="icon-xs" disabled={busy || !status?.repository} onClick={() => void act.run("fetch", () => write({ action: "fetch" }))} title="Fetch all remotes (updates ahead/behind)" aria-label="Fetch" className={cn(iconButton, actionClass(act.phase("fetch")))}>
              <ActionIcon phase={act.phase("fetch")}><CloudDownloadIcon /></ActionIcon>
            </Button>
            <Button variant="outline" size="xs" disabled={busy || !remote} onClick={() => void act.run("pull", () => write({ action: "pull" }))} title={status?.upstream ? `Pull from ${status.upstream} (fast-forward only)` : "Pull"} className={cn(coarse && "min-h-10", actionClass(act.phase("pull")))}>
              <ActionIcon phase={act.phase("pull")}><ArrowDownToLineIcon data-icon="inline-start" /></ActionIcon><span className="hidden @panel-sm:inline">Pull{status?.behind ? ` ${status.behind}` : ""}</span>
            </Button>
            <Button variant="outline" size="xs" disabled={busy || !remote} onClick={() => void act.run("push", () => write({ action: "push" }))} title={status?.upstream ? `Push to ${status.upstream}` : "Publish this branch to origin"} className={cn(coarse && "min-h-10", actionClass(act.phase("push")))}>
              <ActionIcon phase={act.phase("push")}><ArrowUpFromLineIcon data-icon="inline-start" /></ActionIcon><span className="hidden @panel-sm:inline">{status?.upstream ? `Push${status.ahead ? ` ${status.ahead}` : ""}` : "Publish"}</span>
            </Button>
          </div>
        </div>
      </PanelToolbar>
      </header>

      <ErrorNote error={error} className="m-3" />
      {notice && (
        <Notice
          tone="info"
          role="status"
          icon={<CheckIcon className="text-success" />}
          className="m-3"
          action={<Button variant="ghost" size="icon-xs" aria-label="Dismiss message" title="Dismiss message" onClick={() => setNotice(null)}><XIcon /></Button>}
        >
          <p className="truncate" title={notice}>{notice}</p>
        </Notice>
      )}

      <ScmDock
        panes={{
          locations: locationsPane,
          history: historyPane,
          files: filesPane,
          diff: diffPane || <Empty className="m-3">Pick a file to see its changes.</Empty>,
        }}
      />
    </div>
  )
}

/** Hover-revealed with a mouse, always there on a finger. */
function RowVerbs({ coarse, children }: { coarse: boolean; children: React.ReactNode }) {
  return <div className={cn("flex shrink-0 items-center", !coarse && "opacity-0 group-hover:opacity-100 has-focus-visible:opacity-100")}>{children}</div>
}

function Verb({ label, onClick, disabled, destructive, children }: { label: string; onClick: () => void; disabled?: boolean; destructive?: boolean; children: React.ReactNode }) {
  return (
    <Button variant="ghost" size="icon-xs" title={label} aria-label={label} disabled={disabled} onClick={onClick} className={cn("text-muted-foreground", destructive && "hover:bg-destructive/10 hover:text-destructive")}>
      {children}
    </Button>
  )
}

/** This directory is a linked worktree (`git worktree add`), not a main checkout. */
function WorktreeBadge() {
  return <Badge variant="outline" title="A linked git worktree - it shares its repository with another checkout">worktree</Badge>
}

function TextVerb({ onClick, disabled, destructive, children }: { onClick: () => void; disabled?: boolean; destructive?: boolean; children: React.ReactNode }) {
  return (
    <Button variant="ghost" size="xs" disabled={disabled} onClick={onClick} className={cn(destructive && "hover:text-destructive")}>
      {children}
    </Button>
  )
}

function FileRow({ file, group, active, picked, selecting, onPick, busy, coarse, onOpen, onStage, onDiscard }: { file: WorkingFile; group: GroupId; active: boolean; picked: boolean; selecting: boolean; onPick: (shift: boolean) => void; busy: boolean; coarse: boolean; onOpen: () => void; onStage: () => void; onDiscard: () => void }) {
  const markColor = file.conflicted ? "text-destructive" : file.mark === "A" || file.mark === "?" ? "text-success" : file.mark === "D" ? "text-destructive" : file.mark === "R" ? "text-primary" : "text-warning"
  const name = basename(file.path)
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""
  return (
    <div className={cn("group flex items-center gap-2 border-l-2 border-transparent pl-2 pr-1 hover:bg-muted", file.conflicted && "bg-destructive/10", active && "border-primary bg-accent", picked && "bg-primary/10", coarse ? "min-h-11" : "min-h-6")}>
      {/* The tick shows on hover, and everywhere once something is ticked - so
          a second row is one click, and shift-click takes the range between. */}
      <Checkbox
        aria-label={`Select ${name}`}
        className={cn("size-3.5 rounded-md", !(picked || selecting || coarse) && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}
        checked={picked}
        onClick={(event) => onPick(event.shiftKey)}
      />
      <button type="button" onClick={onOpen} title={`Open diff: ${file.from ? `${file.from} → ${file.path}` : file.path}`} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span className={cn("grid size-4 shrink-0 place-items-center rounded-md bg-current/10 font-mono text-xs font-medium", markColor)}>{file.mark}</span>
        <span className={cn("min-w-0 shrink-0 truncate text-sm", file.mark === "D" && "line-through opacity-70")}>{name}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{file.from ? `← ${file.from}` : dir}</span>
        <LineCounts insertions={file.insertions} deletions={file.deletions} />
      </button>
      <RowVerbs coarse={coarse}>
        {group === "changes" && !file.untracked && <Verb label={`Discard ${name}`} destructive disabled={busy} onClick={onDiscard}><Undo2Icon /></Verb>}
        <Verb label={group === "staged" ? `Unstage ${name}` : group === "merge" ? `Mark ${name} resolved` : `Stage ${name}`} disabled={busy} onClick={onStage}>
          {group === "staged" ? <MinusIcon /> : <PlusIcon />}
        </Verb>
      </RowVerbs>
    </div>
  )
}

function toggled<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}
