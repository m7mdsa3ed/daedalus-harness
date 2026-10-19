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
import { Spinner } from "@/components/ui/spinner"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CopyButton } from "@/components/ui/copy-button"
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
import { describeError } from "@/lib/errors"
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
  const [repoError, setRepoError] = React.useState<string | null>(null)
  const [repoPath, setRepoPath] = React.useState(pinnedRepo ?? "")
  const [busy, setBusy] = React.useState(false)
  const act = useActionState<"fetch" | "pull" | "push" | "commit">()
  const [error, setError] = React.useState<string | null>(null)
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
      ? dock.openPanel({ kind: "web", trust: "project", viewId: "default", projectId, file: undefined, diff: next as WebDiff })
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
      if (active) setRepoError(describeError(err).title)
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
            }).catch((err: unknown) => setRepoError(describeError(err).title))
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
      const { title, detail } = describeError(err)
      setError(detail ? `${title}: ${detail}` : title)
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
      setError(describeError(err).title)
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
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
          <Button variant="ghost" size="xs" className="gap-1" onClick={() => setDiff(null)}>
            <ArrowLeftIcon className="size-3.5" /> Back
          </Button>
          <span className="truncate font-mono text-[11px] text-muted-foreground">{diff.path}</span>
        </div>
        <div className="min-h-0 flex-1"><DiffTab projectId={projectId} path={diff.path} left={diff.left} right={diff.right} repo={diff.repo} active /></div>
      </div>
    )
  }

  if (repoError) return <PanelMessage title="Repository scan failed" text={repoError} />
  if (!repos) return <div className="grid h-full place-items-center"><Spinner /></div>
  if (repos.length === 0) return <PanelMessage title="No repository found" text="This project does not contain a Git repository." />
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
            {statusQuery.isLoading && !status ? (
              <div className="grid h-24 place-items-center"><Spinner /></div>
            ) : statusQuery.error ? (
              <PanelMessage title="Status unavailable" text={describeError(statusQuery.error).title} compact />
            ) : groups.length === 0 ? (
              <div className="grid min-h-24 place-items-center px-4 text-center"><div><FileIcon className="mx-auto mb-2 size-5 text-muted-foreground/60" /><p className="text-xs font-medium">Working tree is clean</p><p className="mt-1 text-[10px] text-muted-foreground">Changes will appear here as the project moves.</p></div></div>
            ) : (
              groups.map((group) => {
                const shut = collapsed.has(group.id)
                const paths = group.files.map((file) => file.path)
                const lines = linesOf(group.files)
                const tracked = group.files.filter((file) => !file.untracked).map((file) => file.path)
                return (
                  <section key={group.id}>
                    <div className={cn("flex items-center gap-1 bg-muted/50 pr-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground", coarse ? "min-h-11" : "min-h-6")}>
                      <Checkbox
                        aria-label={`Select all in ${group.title}`}
                        className="ml-1.5 size-3.5 rounded-[4px]"
                        checked={group.files.every((file) => picks.has(pickKey(group.id, file.path)))}
                        indeterminate={group.files.some((file) => picks.has(pickKey(group.id, file.path))) && !group.files.every((file) => picks.has(pickKey(group.id, file.path)))}
                        onCheckedChange={(on) => pickGroup(group.id, on)}
                      />
                      <button type="button" aria-expanded={!shut} onClick={() => setCollapsed((current) => toggled(current, group.id))} className="flex min-w-0 items-center gap-1 py-0.5 text-left">
                        {shut ? <ChevronRightIcon className="size-3.5 shrink-0" /> : <ChevronDownIcon className="size-3.5 shrink-0" />}
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
            <div role="toolbar" aria-label="Bulk actions" className="flex shrink-0 flex-wrap items-center gap-1 border-t border-border/60 bg-accent/60 px-2 py-1 text-[11px]">
              <span className="mr-auto font-medium tabular-nums">{picked.length} selected</span>
              {picked.some((row) => row.group !== "staged") && <TextVerb disabled={busy} onClick={() => void bulk("stage")}>{picked.every((row) => row.group === "merge") ? "Mark Resolved" : "Stage"}</TextVerb>}
              {picked.some((row) => row.group === "staged") && <TextVerb disabled={busy} onClick={() => void bulk("unstage")}>Unstage</TextVerb>}
              {picked.some((row) => row.group === "changes" && !row.file.untracked) && <TextVerb destructive disabled={busy} onClick={() => void bulk("discard")}>Discard</TextVerb>}
              <button type="button" title="Clear selection" aria-label="Clear selection" onClick={() => setPicks(new Set())} className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"><XIcon className="size-3" /></button>
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
            onError={setError}
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
      <header title={standing ?? undefined} className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/60 bg-muted/30 px-2 py-1">
        <div className="contents">
          {repos.length > 1 ? (
            <Select value={repoPath} onValueChange={(value) => { setRepoPath(value as string); setPicks(new Set()); setDiff(null); setSelected(null); setOpenFile(null) }}>
              <SelectTrigger size="sm" aria-label="Repository" className="order-1 h-6 min-w-0 max-w-44 shrink rounded border-border/70 bg-background px-2 text-xs font-semibold">
                <SelectValue>
                  <span className="truncate">{repo.name}</span>
                  {repo.worktree && <WorktreeBadge />}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {repos.map((item) => (
                  <SelectItem key={item.path || "."} value={item.path}>
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate">{item.name}</span>
                      {item.worktree && <WorktreeBadge />}
                      {item.branch && <span className="truncate font-mono text-[10px] font-normal text-muted-foreground">{item.branch}</span>}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : <div className="order-1 flex min-w-0 max-w-44 shrink items-center gap-1.5 text-xs font-semibold"><span className="truncate">{repo.name}</span>{repo.worktree && <WorktreeBadge />}</div>}
          <Button variant="ghost" size="icon-xs" title="Refresh repository status" aria-label="Refresh repository status" loading={statusQuery.isFetching} onClick={() => void statusQuery.refetch()} className={cn(iconButton, "order-5")}>
            <RefreshCwIcon className={cn("size-3.5", statusQuery.isFetching && "animate-spin")} />
          </Button>
          {status?.repository && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`More for ${repo.name}`} className={cn(iconButton, "order-6")}><MoreHorizontalIcon className="size-3.5" /></Button>} />
              <DropdownMenuContent align="end" className="w-auto min-w-52">
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
            className={cn("order-2 flex min-w-0 max-w-full items-center gap-1.5 rounded border border-border/70 bg-background px-2 py-0.5 font-mono text-xs", coarse && "min-h-11")}
          >
            <GitBranchIcon className="size-3.5 shrink-0" /><span className="truncate">{branch}</span>
          </BranchPicker>
          <div className="order-3"><Tracking status={status} /></div>
          <div className="order-4 ml-auto flex shrink-0 gap-1">
            <Button variant="ghost" size="icon-xs" disabled={busy || !status?.repository} onClick={() => void act.run("fetch", () => write({ action: "fetch" }))} title="Fetch all remotes (updates ahead/behind)" aria-label="Fetch" className={cn(iconButton, actionClass(act.phase("fetch")))}>
              <ActionIcon phase={act.phase("fetch")}><CloudDownloadIcon className="size-3.5" /></ActionIcon>
            </Button>
            <Button variant="outline" size="xs" disabled={busy || !remote} onClick={() => void act.run("pull", () => write({ action: "pull" }))} title={status?.upstream ? `Pull from ${status.upstream} (fast-forward only)` : "Pull"} className={cn(coarse && "min-h-10", actionClass(act.phase("pull")))}>
              <ActionIcon phase={act.phase("pull")}><ArrowDownToLineIcon className="size-3.5" /></ActionIcon><span className="hidden @panel-sm:inline">Pull{status?.behind ? ` ${status.behind}` : ""}</span>
            </Button>
            <Button variant="outline" size="xs" disabled={busy || !remote} onClick={() => void act.run("push", () => write({ action: "push" }))} title={status?.upstream ? `Push to ${status.upstream}` : "Publish this branch to origin"} className={cn(coarse && "min-h-10", actionClass(act.phase("push")))}>
              <ActionIcon phase={act.phase("push")}><ArrowUpFromLineIcon className="size-3.5" /></ActionIcon><span className="hidden @panel-sm:inline">{status?.upstream ? `Push${status.ahead ? ` ${status.ahead}` : ""}` : "Publish"}</span>
            </Button>
          </div>
        </div>
      </header>

      {error && <PanelMessage title="Git operation failed" text={error} compact />}
      {notice && <div role="status" className="flex items-center gap-2 border-b border-border/50 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300"><CheckIcon className="size-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate" title={notice}>{notice}</span><button type="button" aria-label="Dismiss message" onClick={() => setNotice(null)}><XIcon className="size-3.5" /></button></div>}

      <ScmDock
        panes={{
          locations: locationsPane,
          history: historyPane,
          files: filesPane,
          diff: diffPane || <p className="px-3 py-6 text-center text-xs text-muted-foreground">Pick a file to see its changes.</p>,
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
    <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick} className={cn("grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-40", destructive && "hover:bg-destructive/10 hover:text-destructive")}>
      {children}
    </button>
  )
}

/** This directory is a linked worktree (`git worktree add`), not a main checkout. */
function WorktreeBadge() {
  return <span title="A linked git worktree - it shares its repository with another checkout" className="shrink-0 rounded-sm border border-violet-500/50 bg-violet-500/15 px-1 text-[9px] font-medium uppercase leading-4 tracking-wide text-violet-700 dark:text-violet-300">worktree</span>
}

function TextVerb({ onClick, disabled, destructive, children }: { onClick: () => void; disabled?: boolean; destructive?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-foreground/80 hover:bg-background hover:text-foreground disabled:opacity-40", destructive && "hover:text-destructive")}>
      {children}
    </button>
  )
}

function FileRow({ file, group, active, picked, selecting, onPick, busy, coarse, onOpen, onStage, onDiscard }: { file: WorkingFile; group: GroupId; active: boolean; picked: boolean; selecting: boolean; onPick: (shift: boolean) => void; busy: boolean; coarse: boolean; onOpen: () => void; onStage: () => void; onDiscard: () => void }) {
  const markColor = file.conflicted ? "text-red-600 dark:text-red-400" : file.mark === "A" || file.mark === "?" ? "text-emerald-600 dark:text-emerald-400" : file.mark === "D" ? "text-red-600 dark:text-red-400" : file.mark === "R" ? "text-sky-600 dark:text-sky-400" : "text-amber-600 dark:text-amber-400"
  const name = basename(file.path)
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""
  return (
    <div className={cn("group flex items-center gap-2 border-l-2 border-transparent pl-2 pr-1 hover:bg-muted/50", file.conflicted && "bg-destructive/5", active && "border-primary bg-accent", picked && "bg-sky-500/15", coarse ? "min-h-11" : "min-h-6")}>
      {/* The tick shows on hover, and everywhere once something is ticked - so
          a second row is one click, and shift-click takes the range between. */}
      <Checkbox
        aria-label={`Select ${name}`}
        className={cn("size-3.5 rounded-[4px]", !(picked || selecting || coarse) && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}
        checked={picked}
        onClick={(event) => onPick(event.shiftKey)}
      />
      <button type="button" onClick={onOpen} title={`Open diff: ${file.from ? `${file.from} → ${file.path}` : file.path}`} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span className={cn("grid size-4 shrink-0 place-items-center rounded-sm bg-current/10 font-mono text-[10px] font-bold", markColor)}>{file.mark}</span>
        <span className={cn("min-w-0 shrink-0 truncate text-xs", file.mark === "D" && "line-through opacity-70")}>{name}</span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{file.from ? `← ${file.from}` : dir}</span>
        <LineCounts insertions={file.insertions} deletions={file.deletions} />
      </button>
      <RowVerbs coarse={coarse}>
        {group === "changes" && !file.untracked && <Verb label={`Discard ${name}`} destructive disabled={busy} onClick={onDiscard}><Undo2Icon className="size-3.5" /></Verb>}
        <Verb label={group === "staged" ? `Unstage ${name}` : group === "merge" ? `Mark ${name} resolved` : `Stage ${name}`} disabled={busy} onClick={onStage}>
          {group === "staged" ? <MinusIcon className="size-3.5" /> : <PlusIcon className="size-3.5" />}
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

function PanelMessage({ title, text, compact = false }: { title: string; text: string; compact?: boolean }) {
  return <div className={cn("text-center", compact ? "flex items-start gap-2 px-3 py-2" : "grid h-full place-content-center px-5")}><div className="min-w-0 flex-1"><p className="text-xs font-semibold">{title}</p><p className="mt-1 break-words text-[11px] text-muted-foreground">{text}</p></div>{compact && <CopyButton text={`${title}: ${text}`} size="icon-xs" className="shrink-0" />}</div>
}
