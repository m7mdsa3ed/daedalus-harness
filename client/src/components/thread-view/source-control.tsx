import * as React from "react"
import {
  ArchiveIcon,
  ArrowDownToLineIcon,
  ArrowLeftIcon,
  ArrowUpFromLineIcon,
  CheckIcon,
  FileIcon,
  GitBranchIcon,
  HistoryIcon,
  RefreshCwIcon,
  SearchIcon,
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
import { HistorySection } from "@/components/workspace/scm-log"
import { Tracking } from "@/components/workspace/scm/branch-menu"
import { useConfirm } from "@/components/confirm-dialog"
import { setScmPanelView, useChangesMarks, type ScmPanelView } from "@/lib/changes-marks"
import { describeError } from "@/lib/errors"
import { useCoarsePointer } from "@/hooks/use-device"
import { projectGitStatusKey, projectReposKey } from "@/lib/queries/keys"
import { useGitStatus } from "@/lib/queries/surfaces"
import { useServer } from "@/lib/server-context"
import { cn } from "@/lib/utils"
import { countsOf, workingSet, type WorkingFile } from "@/lib/workspace/working-set"
import { gitRepos, gitWrite, stashPush, type Comparison, type GitRepo, type GitStatus } from "@/lib/workspace/git-api"
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
  const [showHistory, setShowHistory] = React.useState(false)
  const [logGeneration, setLogGeneration] = React.useState(0)
  const [diff, setDiff] = React.useState<OpenDiff | null>(null)
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
  const visibleFiles = React.useMemo(() => {
    const needle = search.trim().toLowerCase()
    return files.filter((file) => {
      const matchesFilter = filter === "all" ||
        (filter === "staged" && file.staged !== "no") ||
        (filter === "unstaged" && file.staged !== "yes" && !file.conflicted) ||
        (filter === "conflicts" && file.conflicted)
      return matchesFilter && (!needle || file.path.toLowerCase().includes(needle))
    })
  }, [files, filter, search])

  const updateStatus = (next: GitStatus) => {
    queryClient.setQueryData(projectGitStatusKey(settings, projectId, repoPath), next)
  }

  const write = async (action: Parameters<typeof gitWrite>[2]) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await gitWrite(settings, projectId, { ...action, repo: repoPath || undefined })
      updateStatus(result)
      if (action.action === "commit" || action.action === "pull" || action.action === "push") {
        setLogGeneration((current) => current + 1)
      }
      if (action.action === "commit" || action.action === "pull" || action.action === "push") {
        setNotice(result.output?.split("\n").find((line) => line.trim())?.trim() ?? (action.action === "commit" ? "Commit created." : action.action === "pull" ? "Pull complete." : "Push complete."))
      }
      return true
    } catch (err) {
      setError(describeError(err).title)
      void queryClient.invalidateQueries({ queryKey: projectGitStatusKey(settings, projectId, repoPath) })
      return false
    } finally {
      setBusy(false)
    }
  }

  const discard = async (file: WorkingFile) => {
    const ok = await confirm({
      title: `Discard changes in ${file.path}?`,
      description: file.untracked
        ? "This file is untracked. Git cannot delete it; discard only removes tracked changes."
        : "The working-tree changes will be thrown away. This cannot be undone.",
      confirmLabel: "Discard",
      destructive: true,
    })
    if (ok) await write({ action: "discard", paths: [file.path] })
  }

  const openFile = (file: WorkingFile) => {
    const path = repoPath ? `${repoPath}/${file.path}` : file.path
    if (file.untracked || file.conflicted || file.mark === "A") setDiff({ path, left: "head", right: "worktree", repo: repoPath })
    else if (file.staged === "yes") setDiff({ path, left: "head", right: "staged", repo: repoPath })
    else setDiff({ path, left: "staged", right: "worktree", repo: repoPath })
  }

  const branch = status?.branch ?? repo?.branch ?? (status?.unborn ? "no commits yet" : "detached")

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border/60 px-3 py-2">
        <div className="mb-2 flex min-w-0 items-center gap-2">
          {repos.length > 1 ? (
            <select aria-label="Repository" value={repoPath} onChange={(event) => { setRepoPath(event.target.value); setDiff(null) }} className="min-w-0 flex-1 truncate rounded-md border border-border/70 bg-background px-2 py-1.5 text-sm font-semibold">
              {repos.map((item) => <option key={item.path || "."} value={item.path}>{item.name}</option>)}
            </select>
          ) : <div className="min-w-0 flex-1 truncate text-sm font-semibold">{repo.name}</div>}
          <Button variant="ghost" size="icon-xs" title="Refresh repository status" aria-label="Refresh repository status" disabled={statusQuery.isFetching} onClick={() => void statusQuery.refetch()} className={coarse ? "size-10" : "size-7"}>
            <RefreshCwIcon className={cn("size-3.5", statusQuery.isFetching && "animate-spin")} />
          </Button>
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
            <Button variant="outline" size="xs" disabled={busy || !status?.repository || status?.unborn} onClick={() => void write({ action: "pull" })} title={status?.upstream ? `Pull from ${status.upstream}` : "Pull"} className={coarse ? "min-h-10" : ""}>
              <ArrowDownToLineIcon className="size-3.5" /><span className="hidden @panel-sm:inline">Pull</span>
            </Button>
            <Button variant="outline" size="xs" disabled={busy || !status?.repository || status?.unborn} onClick={() => void write({ action: "push" })} title={status?.upstream ? `Push to ${status.upstream}` : "Publish branch"} className={coarse ? "min-h-10" : ""}>
              <ArrowUpFromLineIcon className="size-3.5" /><span className="hidden @panel-sm:inline">Push</span>
            </Button>
          </div>
        </div>
      </header>

      {error && <PanelMessage title="Git operation failed" text={error} compact />}
      {notice && <div role="status" className="flex items-center gap-2 border-b border-border/50 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300"><CheckIcon className="size-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate">{notice}</span><button type="button" aria-label="Dismiss message" onClick={() => setNotice(null)}><XIcon className="size-3.5" /></button></div>}

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
        onCommit={(message) => write({ action: "commit", message })}
        onStageAll={() => void write({ action: "stage", paths: files.filter((file) => file.staged !== "yes" && !file.conflicted).map((file) => file.path) })}
        onError={setError}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2">
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a changed file" aria-label="Find a changed file" className="h-8 pl-7 text-xs" />
          </div>
          {counts.unstaged > 0 && <Button variant="ghost" size="xs" disabled={busy} onClick={async () => {
            setBusy(true)
            try {
              const next = await stashPush(settings, projectId, { repo: repoPath || undefined })
              updateStatus(next)
              setNotice(next.created ? "Working tree stashed." : "Nothing to stash.")
            } catch (err) { setError(describeError(err).title) } finally { setBusy(false) }
          }} title="Stash all working-tree changes" className="shrink-0"><ArchiveIcon className="size-3.5" /><span className="hidden @panel-sm:inline">Stash</span></Button>}
        </div>
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/50 px-3 py-1.5">
          {(["all", "staged", "unstaged", "conflicts"] as FileFilter[]).map((item) => {
            const amount = item === "all" ? counts.total : item === "staged" ? counts.staged : item === "unstaged" ? counts.unstaged : counts.conflicted
            return <button key={item} type="button" aria-pressed={filter === item} onClick={() => setFilter(item)} className={cn("shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium capitalize", filter === item ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/70")}>{item} <span className="font-mono tabular-nums opacity-70">{amount}</span></button>
          })}
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-2 py-1.5">
          {statusQuery.isLoading && !status ? <div className="grid h-24 place-items-center"><Spinner /></div> : statusQuery.error ? <PanelMessage title="Status unavailable" text={describeError(statusQuery.error).title} compact /> : visibleFiles.length === 0 ? <div className="grid min-h-32 place-items-center px-4 text-center"><div><FileIcon className="mx-auto mb-2 size-5 text-muted-foreground/60" /><p className="text-xs font-medium">{counts.total === 0 ? "Working tree is clean" : "No files match"}</p><p className="mt-1 text-[10px] text-muted-foreground">{counts.total === 0 ? "Changes will appear here as the project moves." : "Try another filter or search."}</p></div></div> : <div className="space-y-0.5">{visibleFiles.map((file) => <FileRow key={file.path} file={file} busy={busy} coarse={coarse} onOpen={() => openFile(file)} onStage={() => void write({ action: file.staged === "yes" ? "unstage" : "stage", paths: [file.path] })} onDiscard={() => void discard(file)} />)}</div>}
        </div>
        <div className="shrink-0 border-t border-border/60">
          {showHistory ? (
            <div className="max-h-40 overflow-auto">
              <HistorySection projectId={projectId} repo={repoPath} open onToggle={() => setShowHistory(false)} coarse={coarse} generation={logGeneration} />
            </div>
          ) : (
            <button type="button" aria-expanded={false} onClick={() => setShowHistory(true)} className="flex min-h-9 w-full items-center gap-2 px-3 text-xs font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground">
              <HistoryIcon className="size-3.5" /> Recent commits <span className="ml-auto">Show</span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function FileRow({ file, busy, coarse, onOpen, onStage, onDiscard }: { file: WorkingFile; busy: boolean; coarse: boolean; onOpen: () => void; onStage: () => void; onDiscard: () => void }) {
  const markColor = file.conflicted ? "text-red-600 dark:text-red-400" : file.mark === "A" || file.mark === "?" ? "text-emerald-600 dark:text-emerald-400" : file.mark === "D" ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"
  return (
    <div className={cn("group flex items-center gap-2 rounded-lg border border-transparent px-2 hover:border-border/60 hover:bg-muted/40", coarse ? "min-h-11" : "min-h-9")}>
      <button type="button" onClick={onOpen} title={`Open diff: ${file.path}`} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span className={cn("w-4 shrink-0 text-center font-mono text-[10px] font-bold", markColor)}>{file.mark}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={file.path}>{file.path}</span>
        {file.conflicted && <span className="shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 text-[9px] font-medium text-destructive">resolve</span>}
        {file.staged === "partial" && <span className="shrink-0 rounded bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-medium text-sky-700 dark:text-sky-300">partial</span>}
      </button>
      <button type="button" disabled={busy || file.conflicted} onClick={onStage} title={file.staged === "yes" ? "Unstage file" : "Stage file"} aria-label={file.staged === "yes" ? `Unstage ${file.path}` : `Stage ${file.path}`} className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-40"><span className={cn("grid size-4 place-items-center rounded border text-[10px]", file.staged === "yes" ? "border-primary bg-primary text-primary-foreground" : file.staged === "partial" ? "border-primary/70 bg-primary/15" : "border-border/80")}>{file.staged === "yes" ? <CheckIcon className="size-3" /> : file.staged === "partial" ? "-" : "+"}</span></button>
      {!file.untracked && <button type="button" disabled={busy} onClick={onDiscard} title="Discard tracked changes" aria-label={`Discard ${file.path}`} className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground opacity-100 hover:bg-destructive/10 hover:text-destructive disabled:opacity-40 @md:opacity-0 @md:group-hover:opacity-100"><XIcon className="size-3.5" /></button>}
    </div>
  )
}

function PanelMessage({ title, text, compact = false }: { title: string; text: string; compact?: boolean }) {
  return <div className={cn("text-center", compact ? "flex items-start gap-2 px-3 py-2" : "grid h-full place-content-center px-5")}><div className="min-w-0 flex-1"><p className="text-xs font-semibold">{title}</p><p className="mt-1 break-words text-[11px] text-muted-foreground">{text}</p></div>{compact && <CopyButton text={`${title}: ${text}`} size="icon-xs" className="shrink-0" />}</div>
}
