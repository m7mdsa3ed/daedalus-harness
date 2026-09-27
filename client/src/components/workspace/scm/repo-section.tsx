/* ── One repository ──
   Its own status, its own staging, its own commit box. The section owns the
   writes because every one of them names this repository; the parent owns the
   status *value* so that a refresh triggered by the watch stream lands here
   too.

   **Marks are read back, never inferred.** Every write answers with the next
   status and that is what repaints — staging a file the agent is still editing
   is a race the server wins, and the honest answer is whatever it says next.
   Refresh otherwise happens on the project watch stream, debounced because a
   checkout touches hundreds of files. Never on a timer.

   ── The layout ── VS Code's source control view, top to bottom:

     header      which repository, which branch, ahead/behind, pull, push
     commit      the message and the button, above the files it commits
     ─────────
     groups      Merge Changes · Staged Changes · Changes — one scroller
     ─────────
     stashes     collapsible, capped
     history     collapsible, capped

   **The commit box is outside the scroller**, so no number of changed files
   moves it — at the top now, where VS Code keeps it, instead of pinned under.

   **Staged and unstaged are groups** (`scmGroups` in
   `lib/workspace/working-set.ts`), with + / − / ↺ on the rows.

   **Stashes and history fold at the foot and never take the whole column**:
   closed they are a header each, open they are capped and scroll inside, so
   the files above keep their room. Each costs a git process only once opened. */
import * as React from "react"
import {
  Archive02Icon,
  GitBranchIcon,
  MoreHorizontalIcon,
  RefreshIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowDownToLineIcon, ArrowUpFromLineIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useConfirm } from "@/components/confirm-dialog"
import { HistorySection, StashSection } from "@/components/workspace/scm-log"
import { PanelRowsSkeleton } from "@/components/ui/skeletons"
import { Notice } from "@/components/notice"
import { Tracking } from "@/components/workspace/scm/branch-menu"
import { BranchPicker } from "@/components/workspace/scm/branch-picker"
import { CommitBox } from "@/components/workspace/scm/commit-box"
import { WorkingList, type WorkActions } from "@/components/workspace/scm/working-list"
import { type RepoState } from "@/components/workspace/scm/shared"
import { useCoarsePointer } from "@/hooks/use-device"
import { canUseAi, gitPick } from "@/lib/ai-picks"
import { useProfiles } from "@/lib/queries/catalog"
import { describeError } from "@/lib/errors"
import type { FileLayout } from "@/lib/ide/prefs"
import type { ScmFilter } from "@/lib/ide/scm-filter"
import { useServer } from "@/lib/server-context"
import { cn } from "@/lib/utils"
import {
  draftCommitMessage,
  gitWrite,
  projectPath,
  stashPush,
  type Comparison,
  type GitAction,
  type GitFileState,
  type GitRepo,
  type GitStatus,
} from "@/lib/workspace/git-api"
import {
  countsOf,
  flattenGroups,
  scmGroups,
  workingSet,
  type GroupId,
  type WorkingFile,
} from "@/lib/workspace/working-set"

/** What a stash or history section may take when open, so the files keep theirs. */
const FOOT_MAX = "max-h-[40%]"

export function RepoSection({
  projectId,
  repo,
  state,
  filter,
  layout,
  onRefresh,
  onStatus,
  onOpenDiff,
  onOpenFile,
}: {
  projectId: string
  repo: GitRepo
  state: RepoState | undefined
  filter: ScmFilter | null
  layout: FileLayout
  onRefresh: () => void
  onStatus: (status: GitStatus) => void
  onOpenDiff: (path: string, left: Comparison, right: Comparison, repo?: string) => void
  onOpenFile: (path: string) => void
}) {
  const settings = useServer()
  const confirm = useConfirm()
  const coarse = useCoarsePointer()

  const [busy, setBusy] = React.useState(false)
  const [output, setOutput] = React.useState<string | null>(null)
  /* Git's own refusal ("error: path … has unstaged changes"), held by the
     section it belongs to rather than raised as a toast with nowhere to go
     back to. Cleared by the next write that succeeds. */
  const [writeError, setWriteError] = React.useState<string | null>(null)
  const [collapsedDirs, setCollapsedDirs] = React.useState<ReadonlySet<string>>(() => new Set())
  const [collapsedGroups, setCollapsedGroups] = React.useState<ReadonlySet<GroupId>>(() => new Set())
  const [stashesOpen, setStashesOpen] = React.useState(false)
  const [historyOpen, setHistoryOpen] = React.useState(false)
  /* A commit is the one thing that changes the log while the panel is open. */
  const [commits, setCommits] = React.useState(0)

  /* The narrowing happens **once**, here, and everything below reads the
     narrowed status: the list, the counts, the commit button's "stage all".
     Filtering at the row level instead would leave the buttons describing
     files nobody can see. What the server sent is kept intact in `state`, so
     clearing the filter costs no round trip. */
  const status = React.useMemo(() => {
    const raw = state?.status ?? null
    if (!raw || !filter) return raw
    const keep = (files: GitFileState[]) => files.filter((file) => filter.paths.has(file.path))
    return {
      ...raw,
      conflicted: keep(raw.conflicted),
      staged: keep(raw.staged),
      unstaged: keep(raw.unstaged),
      untracked: keep(raw.untracked),
    }
  }, [state?.status, filter])

  /* One entry per path for the counts (a file staged and edited again is one
     file to "stage all"); the groups for the rows. Memoized on the status, so
     a keystroke in the commit box does not refold either. */
  const files = React.useMemo(() => (status ? workingSet(status) : []), [status])
  const counts = React.useMemo(() => countsOf(files), [files])
  const groups = React.useMemo(() => (status ? scmGroups(status) : []), [status])
  const rows = React.useMemo(
    () => flattenGroups(groups, { layout, collapsedDirs, collapsedGroups }),
    [groups, layout, collapsedDirs, collapsedGroups]
  )

  const write = React.useCallback(
    async (action: GitAction): Promise<boolean> => {
      if ("paths" in action && action.paths.length === 0) return false
      setBusy(true)
      try {
        const next = await gitWrite(settings, projectId, { ...action, repo: repo.path || undefined })
        onStatus(next)
        setWriteError(null)
        if (action.action === "commit") {
          setOutput(next.output?.split("\n").find((line) => line.trim())?.trim() ?? null)
          setCommits((current) => current + 1)
        }
        /* The remote's own words are most of a pull or a push's answer —
           "Already up to date", the URL a branch was published to. A pull also
           moves the log, which is what the counter re-reads. */
        if (action.action === "pull" || action.action === "push") {
          setOutput(next.output?.trim() || (action.action === "pull" ? "Pulled." : "Pushed."))
          setCommits((current) => current + 1)
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
    async (paths: string[], what: string, untracked: boolean) => {
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

  /* Answers whether the commit happened, so the box knows whether to clear —
     a refused hook, a conflict or a cancelled "stage all" all leave the words
     where their author can fix them. */
  const commit = React.useCallback(
    async (text: string): Promise<boolean> => {
      if (!status?.repository || !text) return false
      if (counts.staged === 0) {
        if (counts.unstaged === 0) return false
        const ok = await confirm({
          title: `Stage all ${counts.unstaged} ${counts.unstaged === 1 ? "change" : "changes"} and commit?`,
          description: "Nothing is staged yet, so everything changed goes into this commit.",
          confirmLabel: "Stage all and commit",
        })
        if (!ok) return false
        const staged = await write({
          action: "stage",
          paths: files.filter((file) => file.staged !== "yes").map((file) => file.path),
        })
        if (!staged) return false
      }
      return write({ action: "commit", message: text })
    },
    [confirm, counts, files, status, write]
  )

  /* Which two sides a row's diff has. A **fully staged** row is what a commit
     would contain — HEAD against the index, deliberately not against the
     working tree, or an unstaged edit made after staging would be drawn as
     part of the commit. Anything with work on disk is the other half: index
     against disk. Neither a new file nor an untracked one has a left side
     worth an empty pane, so those open as themselves. */
  const openRow = React.useCallback(
    (file: WorkingFile, group: GroupId) => {
      const path = projectPath(repo.path, file.path)
      if (file.untracked || file.conflicted || (group === "changes" && file.mark === "A")) onOpenFile(path)
      else if (group === "staged") onOpenDiff(path, "head", "staged", repo.path)
      else onOpenDiff(path, "staged", "worktree", repo.path)
    },
    [onOpenDiff, onOpenFile, repo.path]
  )

  /* One stable bundle, so the rows' `React.memo` survives a commit message
     being typed above them. */
  const actions = React.useMemo<WorkActions>(
    () => ({
      onOpen: openRow,
      onToggleDir: (key) => setCollapsedDirs((current) => toggled(current, key)),
      onToggleGroup: (group) => setCollapsedGroups((current) => toggled(current, group)),
      onStage: (paths, stage) => void write({ action: stage ? "stage" : "unstage", paths }),
      onDiscard: (paths, what, untracked) => void discard(paths, what, untracked),
    }),
    [openRow, write, discard]
  )

  const stashAll = React.useCallback(async () => {
    setBusy(true)
    try {
      const next = await stashPush(settings, projectId, { repo: repo.path || undefined })
      onStatus(next)
      setWriteError(null)
      setOutput(next.created ? "Stashed the working tree." : "Nothing to stash.")
      /* Whatever was parked is only findable in the list, so open it. */
      if (next.created) setStashesOpen(true)
    } catch (err) {
      const { title, detail } = describeError(err)
      setWriteError(detail ? `${title}: ${detail}` : title)
    } finally {
      setBusy(false)
    }
  }, [onStatus, projectId, repo.path, settings])

  /* A branch named from the diff, on the commit box's own pick (Settings › AI
     helpers). Held as an editable row until accepted: a name nobody read is a
     ref nobody can find later — the composer's popover asks the same way. */
  const profiles = useProfiles()
  gitPick.useProfileId()
  gitPick.useModelId()
  const draftProfile = React.useMemo(() => {
    const picked = gitPick.resolveProfile(profiles)
    return canUseAi(picked) ? picked : null
  }, [profiles])
  const [suggested, setSuggested] = React.useState<string | null>(null)
  const [naming, setNaming] = React.useState(false)
  const suggestBranch = React.useCallback(async () => {
    if (!draftProfile) return
    setNaming(true)
    setSuggested("")
    setWriteError(null)
    try {
      const { message } = await draftCommitMessage(settings, projectId, {
        profileId: draftProfile.id,
        model: gitPick.resolveModelId(draftProfile) || undefined,
        repo: repo.path || undefined,
        kind: "branch",
      })
      setSuggested(message)
    } catch (err) {
      setSuggested(null)
      setWriteError(describeError(err).title)
    } finally {
      setNaming(false)
    }
  }, [draftProfile, projectId, repo.path, settings])

  const branch = status?.branch ?? repo.branch ?? (status?.unborn ? "no commits yet" : "detached")

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── The header ── the repository's identity and what it points at. */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-1 border-b border-border/60 px-1 text-xs",
          coarse ? "min-h-12" : "min-h-9"
        )}
      >
        {/* The app's one branch switcher (`branch-picker.tsx`) — the same
            control the composer's popover draws, so switching, creating and
            naming a branch behave identically in both places. */}
        <BranchPicker
          projectId={projectId}
          repo={repo.path}
          branch={branch}
          unborn={status?.unborn ?? false}
          disabled={busy || !status?.repository}
          onPick={(choice) =>
            void write({
              action: "checkout",
              branch: choice.branch,
              create: choice.create,
              track: choice.track,
            })
          }
          className={cn(
            "flex min-w-0 shrink items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground",
            coarse && "min-h-11"
          )}
        >
          <HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{branch}</span>
        </BranchPicker>
        <Tracking status={status} />
        <span className="flex-1" />
        {status?.repository && !status.unborn && (
          <>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={busy}
              onClick={() => void write({ action: "pull" })}
              title={status.upstream ? `Pull from ${status.upstream} (fast-forward only)` : "Pull"}
              className={cn("shrink-0", coarse ? "size-11" : "size-6")}
            >
              <ArrowDownToLineIcon className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={busy}
              onClick={() => void write({ action: "push" })}
              title={status.upstream ? `Push to ${status.upstream}` : "Publish this branch to origin"}
              className={cn("shrink-0", coarse ? "size-11" : "size-6")}
            >
              <ArrowUpFromLineIcon className="size-3.5" />
            </Button>
          </>
        )}
        {status?.repository && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`More for ${repo.name}`}
                  className={cn("shrink-0", coarse ? "size-11" : "size-6")}
                >
                  <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} className="size-3.5" />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="w-auto min-w-52">
              <DropdownMenuItem disabled={busy || counts.total === 0} onClick={() => void stashAll()}>
                <HugeiconsIcon icon={Archive02Icon} strokeWidth={2} />
                Stash everything
              </DropdownMenuItem>
              {draftProfile && (
                <DropdownMenuItem
                  disabled={busy || naming || counts.total === 0}
                  onClick={() => void suggestBranch()}
                >
                  <HugeiconsIcon icon={SparklesIcon} strokeWidth={2} />
                  Name a branch from the diff
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onRefresh}>
                <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
                Refresh
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {suggested !== null && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
          <Input
            value={suggested}
            onChange={(e) => setSuggested(e.target.value)}
            disabled={naming}
            placeholder={naming ? "Naming a branch…" : "Branch name"}
            aria-label="Suggested branch name"
            className="h-7 min-w-0 flex-1 font-mono text-xs"
          />
          <Button
            size="xs"
            disabled={busy || naming || !suggested.trim()}
            onClick={async () => {
              const ok = await write({ action: "checkout", branch: suggested.trim(), create: true })
              if (ok) setSuggested(null)
            }}
          >
            {naming && <Spinner />}
            Create
          </Button>
          <Button size="icon-xs" variant="ghost" onClick={() => setSuggested(null)} aria-label="Discard">
            <XIcon className="size-3.5" />
          </Button>
        </div>
      )}

      {(state?.error || writeError || output) && (
        <div className="shrink-0 space-y-1.5 px-2 py-1.5">
          {state?.error && <Notice tone="error">{state.error}</Notice>}
          {writeError && <Notice tone="error">{writeError}</Notice>}
          {output && <Notice className="font-mono">{output}</Notice>}
        </div>
      )}

      {/* ── Commit ── above the files it commits, outside their scroller. */}
      {status?.repository && (
        <CommitBox
          projectId={projectId}
          repo={repo.path}
          repoName={repo.name}
          named={false}
          branch={branch}
          busy={busy}
          changeCount={counts.total}
          stagedCount={counts.staged}
          unstagedCount={counts.unstaged}
          onCommit={commit}
          onStageAll={() =>
            void write({
              action: "stage",
              paths: files.filter((file) => file.staged !== "yes").map((file) => file.path),
            })
          }
          onError={setWriteError}
        />
      )}

      {/* ── The groups ── one windowed scroller. */}
      {!status && !state?.error ? (
        <PanelRowsSkeleton rows={6} className="flex-1 py-1" />
      ) : status && !status.repository ? (
        <p className="flex-1 px-3 py-2 text-xs text-muted-foreground">
          This directory is no longer a git repository.
        </p>
      ) : rows.length === 0 ? (
        <p className="flex-1 px-3 py-2 text-xs text-muted-foreground">
          {filter
            ? /* Not "clean": the worktree may be full of other work. What is
                 true is that none of the files asked about are still
                 uncommitted here — committed since, or another repository's. */
              "None of these files are uncommitted here."
            : "The worktree is clean."}
        </p>
      ) : (
        <WorkingList
          rows={rows}
          collapsedDirs={collapsedDirs}
          collapsedGroups={collapsedGroups}
          coarse={coarse}
          busy={busy}
          actions={actions}
        />
      )}

      {/* ── The foot ── folded by default; each mounts its read only once
          opened, because this panel is often open for an hour. */}
      {status?.repository && (
        <>
          <div className={cn("shrink-0", stashesOpen && `${FOOT_MAX} overflow-auto`)}>
            <StashSection
              projectId={projectId}
              repo={repo.path}
              open={stashesOpen}
              onToggle={() => setStashesOpen((open) => !open)}
              onStatus={onStatus}
              coarse={coarse}
            />
          </div>
          <div className={cn("shrink-0", historyOpen && `${FOOT_MAX} overflow-auto`)}>
            <HistorySection
              projectId={projectId}
              repo={repo.path}
              open={historyOpen}
              onToggle={() => setHistoryOpen((open) => !open)}
              coarse={coarse}
              generation={commits}
            />
          </div>
        </>
      )}
    </div>
  )
}

function toggled<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}
