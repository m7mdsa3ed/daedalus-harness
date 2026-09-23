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

   ── The layout ──
   Three zones, and the outer two do not move:

     header      which repository, which branch, what it is tracking
     ─────────
     tabs        Changes · Stashes · History, each with its own scroller
     ─────────
     commit      pinned to the bottom edge

   **The commit box is pinned, not stacked.** It used to sit above the file
   list, because below it a repository with forty changed files pushed it off
   the bottom of a 320px column — you had to scroll past the work to say what
   the work was. Pinning is what actually answers that: the box is outside the
   scroller entirely, so no number of changed files can move it, and the panel
   reads the way the app's other write surface does — a transcript above, a
   composer fixed beneath it.

   **The working set is one list, not four groups** (`lib/workspace/working-set.ts`):
   a path that is staged and edited again was two rows in two groups with
   nothing saying they were one file. It is one row with an indeterminate tick.

   **Stashes and history are tabs, not collapsibles.** They are separate
   readings of the same repository, each wanting the full height and its own
   scroll position — three things folding open inside one column was a list
   that got longer the more you wanted to look at. Each still costs a git
   process only once its tab is opened. */
import * as React from "react"
import {
  Archive02Icon,
  GitBranchIcon,
  MoreHorizontalIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
import { describeError } from "@/lib/errors"
import type { FileLayout } from "@/lib/ide/prefs"
import type { ScmFilter } from "@/lib/ide/scm-filter"
import { useServer } from "@/lib/server-context"
import { cn } from "@/lib/utils"
import {
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
  flattenWorkingSet,
  workingSet,
  type WorkingFile,
} from "@/lib/workspace/working-set"

type Pane = "changes" | "stashes" | "history"

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
  onOpenDiff: (path: string, left: Comparison, right: Comparison) => void
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
  const [pane, setPane] = React.useState<Pane>("changes")
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

  /* Four lists folded into one entry per path. Memoized on the status, so a
     keystroke in the commit box below does not refold it. */
  const files = React.useMemo(() => (status ? workingSet(status) : []), [status])
  const counts = React.useMemo(() => countsOf(files), [files])
  const rows = React.useMemo(
    () => flattenWorkingSet(files, { layout, collapsed: collapsedDirs }),
    [files, layout, collapsedDirs]
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
    (file: WorkingFile) => {
      const path = projectPath(repo.path, file.path)
      if (file.untracked || (file.staged !== "yes" && file.mark === "A")) onOpenFile(path)
      else if (file.staged === "yes") onOpenDiff(path, "head", "staged")
      else onOpenDiff(path, "staged", "worktree")
    },
    [onOpenDiff, onOpenFile, repo.path]
  )

  /* One stable bundle, so the rows' `React.memo` survives a commit message
     being typed above them. */
  const actions = React.useMemo<WorkActions>(
    () => ({
      onOpen: openRow,
      onToggleDir: (path) =>
        setCollapsedDirs((current) => {
          const next = new Set(current)
          if (next.has(path)) next.delete(path)
          else next.add(path)
          return next
        }),
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
      /* Whatever was parked is only findable in the list, so go there. */
      if (next.created) setPane("stashes")
    } catch (err) {
      const { title, detail } = describeError(err)
      setWriteError(detail ? `${title}: ${detail}` : title)
    } finally {
      setBusy(false)
    }
  }, [onStatus, projectId, repo.path, settings])

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
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onRefresh}>
                <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
                Refresh
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {(state?.error || writeError || output) && (
        <div className="shrink-0 space-y-1.5 px-2 py-1.5">
          {state?.error && <Notice tone="error">{state.error}</Notice>}
          {writeError && <Notice tone="error">{writeError}</Notice>}
          {output && <Notice className="font-mono">{output}</Notice>}
        </div>
      )}

      {/* ── The three readings ── each with its own scroller and its own cost:
          a tab that has never been opened has run no git process. */}
      <Tabs
        value={pane}
        onValueChange={(next) => setPane(next as Pane)}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <TabsList variant="line" className="mx-2 mt-1.5 shrink-0 self-start">
          <TabsTrigger value="changes" className="text-xs">
            Changes
            {counts.total > 0 && (
              <span className="ml-1 font-mono text-[10px] tabular-nums opacity-70">
                {counts.total}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="stashes" className="text-xs">
            Stashes
          </TabsTrigger>
          <TabsTrigger value="history" className="text-xs">
            History
          </TabsTrigger>
        </TabsList>

        <TabsContent value="changes" className="flex min-h-0 flex-1 flex-col">
          {!status && !state?.error ? (
            <PanelRowsSkeleton rows={6} className="py-1" />
          ) : status && !status.repository ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              This directory is no longer a git repository.
            </p>
          ) : rows.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              {filter
                ? /* Not "clean": the worktree may be full of other work. What
                     is true is that none of the files asked about are still
                     uncommitted here — committed since, or another
                     repository's. */
                  "None of these files are uncommitted here."
                : "The worktree is clean."}
            </p>
          ) : (
            <WorkingList
              rows={rows}
              collapsed={collapsedDirs}
              coarse={coarse}
              busy={busy}
              actions={actions}
            />
          )}
        </TabsContent>

        {/* Mounted only once opened — each costs a git process, and this panel
            is often open for an hour. */}
        <TabsContent value="stashes" className="min-h-0 flex-1 overflow-auto">
          {status?.repository && (
            <StashSection
              projectId={projectId}
              repo={repo.path}
              open
              onToggle={() => {}}
              onStatus={onStatus}
              coarse={coarse}
            />
          )}
        </TabsContent>

        <TabsContent value="history" className="min-h-0 flex-1 overflow-auto">
          {status?.repository && (
            <HistorySection
              projectId={projectId}
              repo={repo.path}
              open
              onToggle={() => {}}
              coarse={coarse}
              generation={commits}
            />
          )}
        </TabsContent>
      </Tabs>

      {/* ── Pinned ── outside every scroller, so no number of changed files can
          push it off the bottom. Only over Changes: committing is about the
          working set, and a commit box under a list of old commits is a
          control pointing at the wrong thing. */}
      {status?.repository && pane === "changes" && (
        <div className="shrink-0 border-t border-border/60">
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
        </div>
      )}
    </div>
  )
}
