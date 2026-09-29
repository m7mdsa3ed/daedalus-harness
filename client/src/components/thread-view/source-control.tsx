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
  SearchIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { CopyButton } from "@/components/ui/copy-button"
import { DiffTab, type DiffSide } from "@/components/workspace/diff-tab"
import { BranchPicker } from "@/components/workspace/scm/branch-picker"
import { CommitBox } from "@/components/workspace/scm/commit-box"
import { HistorySection, StashSection } from "@/components/workspace/scm-log"
import { CommitDetailView } from "@/components/workspace/scm/commit-detail"
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
import { setScmPanelView, useChangesMarks, type ScmPanelView } from "@/lib/changes-marks"
import { describeError } from "@/lib/errors"
import { useCoarsePointer } from "@/hooks/use-device"
import { projectGitStatusKey, projectReposKey } from "@/lib/queries/keys"
import { useGitStatus } from "@/lib/queries/surfaces"
import { useServer } from "@/lib/server-context"
import { cn } from "@/lib/utils"
import { countsOf, linesOf, scmGroups, workingSet, type GroupId, type WorkingFile } from "@/lib/workspace/working-set"
import { basename } from "@/lib/workspace/fs-api"
import {
  gitRepos,
  gitWrite,
  projectPath,
  stashPush,
  type GitAction,
  type GitCommit,
  type GitRepo,
  type GitStatus,
} from "@/lib/workspace/git-api"
import { watchProject } from "@/lib/workspace/watch"
import InspectorChanges from "./inspector-changes"

type Props = React.ComponentProps<typeof InspectorChanges>
type FileFilter = "all" | "staged" | "unstaged" | "conflicts"

const VIEWS: { value: ScmPanelView; label: string }[] = [
  { value: "git", label: "Changes" },
  { value: "review", label: "Review" },
]

export default function SourceControl(props: Props) {
  const view = useChangesMarks(props.sessionId).view ?? "git"

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label="Source control views" className="flex shrink-0 items-center gap-1 border-b border-border/60 px-3 py-2">
        {VIEWS.map((item) => (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={view === item.value}
            onClick={() => setScmPanelView(props.sessionId, item.value)}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium transition-colors",
              view === item.value ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className={cn("min-h-0 flex-1", view !== "git" && "hidden")}>
        <GitWorkspace projectId={props.projectId} pinnedRepo={props.repo} />
      </div>
      {view === "review" && <InspectorChanges {...props} />}
    </div>
  )
}

interface OpenDiff {
  path: string
  left: DiffSide
  right: DiffSide
  repo?: string
}

type Tab = "changes" | "history" | "stashes"

/* ── The Git half ──
   Top to bottom: which repository and branch, where it stands against its
   upstream (fetch, pull, push), a summary of what is outstanding in lines, the
   commit box, then three tabs — the working set grouped as VS Code groups it
   (Merge / Staged / Changes, each with its bulk verbs), the history (a commit
   opens to its message and files, a file to its diff against the parent), and
   the stashes. Every write answers the next status, which is what repaints. */
function GitWorkspace({ projectId, pinnedRepo }: { projectId: string; pinnedRepo?: string }) {
  const settings = useServer()
  const queryClient = useQueryClient()
  const coarse = useCoarsePointer()
  const confirm = useConfirm()
  const [repos, setRepos] = React.useState<GitRepo[] | null>(null)
  const [repoError, setRepoError] = React.useState<string | null>(null)
  const [repoPath, setRepoPath] = React.useState(pinnedRepo ?? "")
  const [filter, setFilter] = React.useState<FileFilter>("all")
  const [search, setSearch] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [tab, setTab] = React.useState<Tab>("changes")
  const [logGeneration, setLogGeneration] = React.useState(0)
  const [stashGeneration, setStashGeneration] = React.useState(0)
  const [stashMessage, setStashMessage] = React.useState("")
  const [diff, setDiff] = React.useState<OpenDiff | null>(null)
  const [commit, setCommit] = React.useState<GitCommit | null>(null)
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<GroupId>>(() => new Set())
  /* An undone commit's message, handed back to the box it came from. */
  const [prefill, setPrefill] = React.useState<{ text: string; id: number } | null>(null)
  const statusQuery = useGitStatus(projectId, repoPath)
  const status = statusQuery.data ?? null

  React.useEffect(() => {
    let active = true
    const read = pinnedRepo !== undefined
      ? Promise.resolve([{ path: pinnedRepo, name: pinnedRepo.split("/").pop() || "Project", branch: null }])
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
  const summary = React.useMemo(() => {
    const of = (id: GroupId) => groups.find((group) => group.id === id)?.files ?? []
    return {
      staged: linesOf(of("staged")),
      changed: linesOf(of("changes")),
      untracked: files.filter((file) => file.untracked).length,
    }
  }, [groups, files])

  /* The filter picks groups and the search narrows rows inside them — the
     headers' bulk verbs then act on what is drawn, never on hidden rows. */
  const visibleGroups = React.useMemo(() => {
    const needle = search.trim().toLowerCase()
    const shown: Record<FileFilter, GroupId[]> = {
      all: ["merge", "staged", "changes"],
      staged: ["staged"],
      unstaged: ["changes"],
      conflicts: ["merge"],
    }
    return groups
      .filter((group) => shown[filter].includes(group.id))
      .map((group) => ({
        ...group,
        files: needle ? group.files.filter((file) => file.path.toLowerCase().includes(needle)) : group.files,
      }))
      .filter((group) => group.files.length > 0)
  }, [groups, filter, search])

  const updateStatus = (next: GitStatus) => {
    queryClient.setQueryData(projectGitStatusKey(settings, projectId, repoPath), next)
  }

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
        setLogGeneration((current) => current + 1)
      } else if (DONE[action.action]) {
        setLogGeneration((current) => current + 1)
        setNotice(result.output?.split("\n").find((line) => line.trim())?.trim() ?? DONE[action.action]!)
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
    return write({ action: "commit", message, amend })
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

  const stash = async () => {
    setBusy(true)
    setError(null)
    try {
      const next = await stashPush(settings, projectId, { repo: repoPath || undefined, message: stashMessage.trim() || undefined })
      updateStatus(next)
      setNotice(next.created ? "Working tree stashed." : "Nothing to stash.")
      if (next.created) {
        setStashMessage("")
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
    if (file.untracked || file.conflicted || (group === "changes" && file.mark === "A")) setDiff({ path, left: "head", right: "worktree", repo: repoPath })
    else if (group === "staged") setDiff({ path, left: "head", right: "staged", repo: repoPath })
    else setDiff({ path, left: "staged", right: "worktree", repo: repoPath })
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

  if (commit) {
    return (
      <CommitDetailView
        projectId={projectId}
        repo={repoPath}
        commit={commit}
        coarse={coarse}
        onBack={() => setCommit(null)}
        onOpenFile={(file, detail) =>
          setDiff({
            path: projectPath(repoPath, file.path),
            left: { rev: file.status === "A" ? "" : (detail.parents[0] ?? "") },
            right: { rev: file.status === "D" ? "" : detail.hash },
          })
        }
      />
    )
  }

  const remote = !!status?.repository && !status.unborn
  const iconButton = coarse ? "size-10" : "size-7"

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border/60 px-3 py-2">
        <div className="mb-2 flex min-w-0 items-center gap-1">
          {repos.length > 1 ? (
            <select aria-label="Repository" value={repoPath} onChange={(event) => { setRepoPath(event.target.value); setDiff(null); setCommit(null) }} className="min-w-0 flex-1 truncate rounded-md border border-border/70 bg-background px-2 py-1.5 text-sm font-semibold">
              {repos.map((item) => <option key={item.path || "."} value={item.path}>{item.name}</option>)}
            </select>
          ) : <div className="min-w-0 flex-1 truncate text-sm font-semibold">{repo.name}</div>}
          <Button variant="ghost" size="icon-xs" title="Refresh repository status" aria-label="Refresh repository status" disabled={statusQuery.isFetching} onClick={() => void statusQuery.refetch()} className={iconButton}>
            <RefreshCwIcon className={cn("size-3.5", statusQuery.isFetching && "animate-spin")} />
          </Button>
          {status?.repository && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`More for ${repo.name}`} className={iconButton}><MoreHorizontalIcon className="size-3.5" /></Button>} />
              <DropdownMenuContent align="end" className="w-auto min-w-52">
                <DropdownMenuItem disabled={busy} onClick={() => void write({ action: "fetch" })}><CloudDownloadIcon />Fetch all remotes</DropdownMenuItem>
                <DropdownMenuItem disabled={busy || counts.staged === 0} onClick={() => void write({ action: "unstage", paths: files.filter((file) => file.staged !== "no").map((file) => file.path) })}><MinusIcon />Unstage everything</DropdownMenuItem>
                <DropdownMenuItem disabled={busy || counts.total === 0} onClick={() => void stash()}><ArchiveIcon />Stash everything</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={busy || status.unborn} onClick={() => void undo()}><Undo2Icon />Undo last commit</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <BranchPicker
            projectId={projectId}
            repo={repoPath}
            branch={branch}
            unborn={status?.unborn ?? false}
            disabled={busy || !status?.repository}
            onPick={(choice) => void write({ action: "checkout", branch: choice.branch, create: choice.create, track: choice.track })}
            className={cn("flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-border/70 bg-background px-2.5 py-1.5 font-mono text-xs", coarse && "min-h-11")}
          >
            <GitBranchIcon className="size-3.5 shrink-0" /><span className="truncate">{branch}</span>
          </BranchPicker>
          <Tracking status={status} />
          <div className="ml-auto flex shrink-0 gap-1">
            <Button variant="ghost" size="icon-xs" disabled={busy || !status?.repository} onClick={() => void write({ action: "fetch" })} title="Fetch all remotes (updates ahead/behind)" aria-label="Fetch" className={iconButton}>
              <CloudDownloadIcon className="size-3.5" />
            </Button>
            <Button variant="outline" size="xs" disabled={busy || !remote} onClick={() => void write({ action: "pull" })} title={status?.upstream ? `Pull from ${status.upstream} (fast-forward only)` : "Pull"} className={coarse ? "min-h-10" : ""}>
              <ArrowDownToLineIcon className="size-3.5" /><span className="hidden @panel-sm:inline">Pull{status?.behind ? ` ${status.behind}` : ""}</span>
            </Button>
            <Button variant="outline" size="xs" disabled={busy || !remote} onClick={() => void write({ action: "push" })} title={status?.upstream ? `Push to ${status.upstream}` : "Publish this branch to origin"} className={coarse ? "min-h-10" : ""}>
              <ArrowUpFromLineIcon className="size-3.5" /><span className="hidden @panel-sm:inline">{status?.upstream ? `Push${status.ahead ? ` ${status.ahead}` : ""}` : "Publish"}</span>
            </Button>
          </div>
        </div>
        {standing && <p className="mt-1.5 truncate text-[10px] text-muted-foreground" title={standing}>{standing}</p>}
      </header>

      {/* ── The summary ── how much is outstanding, and where, in lines. */}
      {status?.repository && (
        <div className="grid shrink-0 grid-cols-2 gap-px border-b border-border/60 bg-border/40 @panel-sm:grid-cols-4">
          <Figure label="Staged" value={counts.staged} lines={summary.staged} />
          <Figure label="Changed" value={counts.unstaged - summary.untracked} lines={summary.changed} />
          <Figure label="Untracked" value={summary.untracked} />
          <Figure label="Conflicts" value={counts.conflicted} tone={counts.conflicted > 0 ? "error" : undefined} />
        </div>
      )}

      {error && <PanelMessage title="Git operation failed" text={error} compact />}
      {notice && <div role="status" className="flex items-center gap-2 border-b border-border/50 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300"><CheckIcon className="size-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate" title={notice}>{notice}</span><button type="button" aria-label="Dismiss message" onClick={() => setNotice(null)}><XIcon className="size-3.5" /></button></div>}

      <CommitBox
        key={`${projectId}:${repoPath}`}
        projectId={projectId}
        repo={repoPath}
        repoName={repo.name}
        named={repos.length > 1}
        branch={branch}
        busy={busy}
        changeCount={counts.total}
        stagedCount={counts.staged}
        unstagedCount={counts.unstaged}
        canAmend={remote}
        prefill={prefill}
        onCommit={commitWith}
        onStageAll={() => void write({ action: "stage", paths: files.filter((file) => file.staged !== "yes" && !file.conflicted).map((file) => file.path) })}
        onError={setError}
      />

      <div role="tablist" aria-label="Repository views" className="flex shrink-0 items-center gap-1 border-b border-border/50 px-2 py-1">
        {([
          ["changes", "Changes", counts.total],
          ["history", "History", null],
          ["stashes", "Stashes", null],
        ] as const).map(([value, label, amount]) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)} className={cn("rounded-md px-2 py-1 text-[11px] font-medium", tab === value ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60", coarse && "min-h-10")}>
            {label}{amount ? <span className="ml-1 font-mono tabular-nums opacity-70">{amount}</span> : null}
          </button>
        ))}
      </div>

      {tab === "changes" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2">
            <div className="relative min-w-0 flex-1">
              <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a changed file" aria-label="Find a changed file" className="h-8 pl-7 text-xs" />
            </div>
          </div>
          <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/50 px-3 py-1.5">
            {(["all", "staged", "unstaged", "conflicts"] as FileFilter[]).map((item) => {
              const amount = item === "all" ? counts.total : item === "staged" ? counts.staged : item === "unstaged" ? counts.unstaged : counts.conflicted
              return <button key={item} type="button" aria-pressed={filter === item} onClick={() => setFilter(item)} className={cn("shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium capitalize", filter === item ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/70")}>{item} <span className="font-mono tabular-nums opacity-70">{amount}</span></button>
            })}
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-2 py-1.5">
            {statusQuery.isLoading && !status ? (
              <div className="grid h-24 place-items-center"><Spinner /></div>
            ) : statusQuery.error ? (
              <PanelMessage title="Status unavailable" text={describeError(statusQuery.error).title} compact />
            ) : visibleGroups.length === 0 ? (
              <div className="grid min-h-32 place-items-center px-4 text-center"><div><FileIcon className="mx-auto mb-2 size-5 text-muted-foreground/60" /><p className="text-xs font-medium">{counts.total === 0 ? "Working tree is clean" : "No files match"}</p><p className="mt-1 text-[10px] text-muted-foreground">{counts.total === 0 ? "Changes will appear here as the project moves." : "Try another filter or search."}</p></div></div>
            ) : (
              visibleGroups.map((group) => {
                const shut = collapsed.has(group.id)
                const paths = group.files.map((file) => file.path)
                const lines = linesOf(group.files)
                const tracked = group.files.filter((file) => !file.untracked).map((file) => file.path)
                return (
                  <section key={group.id} className="mb-1">
                    <div className={cn("group flex items-center gap-1 rounded-md pr-1 text-[11px] font-semibold text-muted-foreground hover:bg-muted/40", coarse ? "min-h-11" : "min-h-8")}>
                      <button type="button" aria-expanded={!shut} onClick={() => setCollapsed((current) => toggled(current, group.id))} className="flex min-w-0 flex-1 items-center gap-1 py-1 pl-1 text-left">
                        {shut ? <ChevronRightIcon className="size-3.5 shrink-0" /> : <ChevronDownIcon className="size-3.5 shrink-0" />}
                        <span className="truncate">{group.title}</span>
                        <span className="rounded-full bg-muted px-1.5 font-mono text-[10px] leading-4 tabular-nums">{group.files.length}</span>
                        <LineCounts insertions={lines.insertions} deletions={lines.deletions} className="font-normal" />
                      </button>
                      <RowVerbs coarse={coarse}>
                        {group.id === "staged" ? (
                          <Verb label={`Unstage all ${paths.length}`} disabled={busy} onClick={() => void write({ action: "unstage", paths })}><MinusIcon className="size-3.5" /></Verb>
                        ) : (
                          <>
                            {group.id === "changes" && tracked.length > 0 && (
                              <Verb label={`Discard all ${tracked.length}`} destructive disabled={busy} onClick={() => void discard(tracked, `all ${tracked.length} files`)}><Undo2Icon className="size-3.5" /></Verb>
                            )}
                            <Verb label={group.id === "merge" ? `Mark all ${paths.length} resolved` : `Stage all ${paths.length}`} disabled={busy} onClick={() => void write({ action: "stage", paths })}><PlusIcon className="size-3.5" /></Verb>
                          </>
                        )}
                      </RowVerbs>
                    </div>
                    {!shut && (
                      <div className="space-y-px">
                        {group.files.map((file) => (
                          <FileRow
                            key={file.path}
                            file={file}
                            group={group.id}
                            busy={busy}
                            coarse={coarse}
                            onOpen={() => openRow(file, group.id)}
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
        </div>
      )}

      {tab === "history" && (
        <div className="min-h-0 flex-1 overflow-auto">
          <HistorySection projectId={projectId} repo={repoPath} open fixed onToggle={() => {}} coarse={coarse} generation={logGeneration} onSelect={setCommit} />
        </div>
      )}

      {tab === "stashes" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <form className="flex shrink-0 items-center gap-1.5 border-b border-border/50 px-3 py-2" onSubmit={(event) => { event.preventDefault(); void stash() }}>
            <Input value={stashMessage} onChange={(event) => setStashMessage(event.target.value)} placeholder="Stash message (optional)" aria-label="Stash message" className="h-8 min-w-0 flex-1 text-xs" />
            <Button type="submit" size="xs" variant="outline" disabled={busy || counts.total === 0} className={coarse ? "min-h-10" : ""}>
              <ArchiveIcon className="size-3.5" /> Stash {counts.total > 0 ? counts.total : ""}
            </Button>
          </form>
          <div className="min-h-0 flex-1 overflow-auto">
            <StashSection key={stashGeneration} projectId={projectId} repo={repoPath} open fixed onToggle={() => {}} onStatus={updateStatus} coarse={coarse} />
          </div>
        </div>
      )}
    </div>
  )
}

/** One cell of the summary: a count, and its lines where git counted them. */
function Figure({ label, value, lines, tone }: { label: string; value: number; lines?: { insertions: number; deletions: number }; tone?: "error" }) {
  return (
    <div className="bg-background px-3 py-1.5">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="flex items-baseline gap-1.5">
        <span className={cn("font-mono text-sm font-semibold tabular-nums", value === 0 && "text-muted-foreground/60", tone === "error" && "text-red-600 dark:text-red-400")}>{value}</span>
        {lines && <LineCounts insertions={lines.insertions} deletions={lines.deletions} />}
      </p>
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

function FileRow({ file, group, busy, coarse, onOpen, onStage, onDiscard }: { file: WorkingFile; group: GroupId; busy: boolean; coarse: boolean; onOpen: () => void; onStage: () => void; onDiscard: () => void }) {
  const markColor = file.conflicted ? "text-red-600 dark:text-red-400" : file.mark === "A" || file.mark === "?" ? "text-emerald-600 dark:text-emerald-400" : file.mark === "D" ? "text-red-600 dark:text-red-400" : file.mark === "R" ? "text-sky-600 dark:text-sky-400" : "text-amber-600 dark:text-amber-400"
  const name = basename(file.path)
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""
  return (
    <div className={cn("group flex items-center gap-2 rounded-lg border border-transparent pl-5 pr-1 hover:border-border/60 hover:bg-muted/40", file.conflicted && "bg-destructive/5", coarse ? "min-h-11" : "min-h-8")}>
      <button type="button" onClick={onOpen} title={`Open diff: ${file.from ? `${file.from} → ${file.path}` : file.path}`} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span className={cn("w-3 shrink-0 text-center font-mono text-[10px] font-bold", markColor)}>{file.mark}</span>
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
