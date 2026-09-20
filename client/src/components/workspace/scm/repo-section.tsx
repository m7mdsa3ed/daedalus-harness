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

   **The commit box sits above the file list, not below it.** It is the thing
   the panel is for, and a repository with forty changed files put it off the
   bottom of a 320px column — you had to scroll past the work to say what the
   work was. The order now reads top to bottom as the sentence the panel is:
   which branch, what to call this, what is in it. */
import * as React from "react"
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Archive02Icon,
  Clock01Icon,
  GitBranchIcon,
  MoreHorizontalIcon,
  PackageIcon,
  PlusSignIcon,
  RefreshIcon,
  SparklesIcon,
  Tick02Icon,
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
import { Textarea } from "@/components/ui/textarea"
import { useConfirm } from "@/components/confirm-dialog"
import { HistorySection, StashSection } from "@/components/workspace/scm-log"
import { PanelRowsSkeleton } from "@/components/ui/skeletons"
import { Notice } from "@/components/notice"
import { Tracking } from "@/components/workspace/scm/branch-menu"
import { BranchPicker } from "@/components/workspace/scm/branch-picker"
import { Group } from "@/components/workspace/scm/file-rows"
import {
  IconAction,
  markOf,
  type RepoState,
  type Row,
  type Side,
} from "@/components/workspace/scm/shared"
import { useCoarsePointer } from "@/hooks/use-device"
import { describeError } from "@/lib/errors"
import { canUseAi, gitPick } from "@/lib/ai-picks"
import { useProfiles } from "@/lib/queries/catalog"
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

const changeCount = (status: GitStatus): number =>
  status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length

export function RepoSection({
  projectId,
  repo,
  state,
  filter,
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
  filter: ScmFilter | null
  layout: FileLayout
  collapsible: boolean
  open: boolean
  onToggle: () => void
  onRefresh: () => void
  onStatus: (status: GitStatus) => void
  onOpenDiff: (path: string, left: Comparison, right: Comparison) => void
  onOpenFile: (path: string) => void
}) {
  const settings = useServer()
  const confirm = useConfirm()
  const coarse = useCoarsePointer()

  const [busy, setBusy] = React.useState(false)
  const [drafting, setDrafting] = React.useState(false)
  const [message, setMessage] = React.useState("")
  const [output, setOutput] = React.useState<string | null>(null)
  /* Git's own refusal ("error: path … has unstaged changes"), held by the
     section it belongs to rather than raised as a toast with nowhere to go
     back to. Cleared by the next write that succeeds. */
  const [writeError, setWriteError] = React.useState<string | null>(null)
  const [collapsedDirs, setCollapsedDirs] = React.useState<ReadonlySet<string>>(() => new Set())
  /* The two lists below the working set, closed until asked for — each one
     costs a git process, and this panel is often open for an hour. */
  const [showStashes, setShowStashes] = React.useState(false)
  const [showHistory, setShowHistory] = React.useState(false)
  /* A commit is the one thing that changes the log while the panel is open. */
  const [commits, setCommits] = React.useState(0)

  /* The narrowing happens **once**, here, and everything below reads the
     narrowed status: the groups, the counts, the commit button's "stage all",
     the header badge. Filtering at the row level instead would leave the
     buttons describing files nobody can see — the reason this is a derivation
     and not four `.filter()`s. What the server sent is kept intact in `state`,
     so clearing the filter costs no round trip. */
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

  /* Draft a commit message. Source control has its own device-local pick
     (Settings › AI helpers), separate from the composer's enhancer: reading a
     diff and sharpening a prompt are different jobs, and the provider you want
     on your patches is not necessarily the one you want on your sentences. */
  const profiles = useProfiles()
  const draftProfile = React.useMemo(() => {
    const picked = gitPick.resolveProfile(profiles)
    return canUseAi(picked) ? picked : null
  }, [profiles])

  const draftMessage = React.useCallback(async () => {
    if (!draftProfile) return
    setDrafting(true)
    setWriteError(null)
    try {
      const { message: drafted } = await draftCommitMessage(settings, projectId, {
        profileId: draftProfile.id,
        model: gitPick.resolveModelId(draftProfile) || undefined,
        repo: repo.path || undefined,
      })
      setMessage(drafted)
    } catch (err) {
      /* A draft that failed is a failure *here*, beside the box it was meant to
         fill — not a toast over a panel the reader is looking at. */
      setWriteError(describeError(err).title)
    } finally {
      setDrafting(false)
    }
  }, [draftProfile, settings, projectId, repo.path])

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

  /* The rows a group draws are built **with** the group and not in the render
     below it, because a group's path tree is memoized on its `rows` array: a
     fresh one per render rebuilt every tree on every keystroke in the commit
     textarea. New rows mean the status changed, which is the only time a tree
     is worth building again. */
  const groups = React.useMemo(() => {
    if (!status) return []
    return (
      [
        { key: "merge", title: "Conflicts", side: "conflict", files: status.conflicted },
        { key: "staged", title: "Staged", side: "index", files: status.staged },
        { key: "changes", title: "Changes", side: "worktree", files: status.unstaged },
        { key: "untracked", title: "Untracked", side: "untracked", files: status.untracked },
      ] satisfies { key: string; title: string; side: Side; files: GitFileState[] }[]
    )
      .filter((group) => group.files.length > 0)
      .map((group) => ({
        key: group.key,
        title: group.title,
        side: group.side,
        rows: group.files.map((file): Row => ({ file, side: group.side })),
      }))
  }, [status])

  const branch = status?.branch ?? repo.branch ?? (status?.unborn ? "no commits yet" : "detached")
  const stagedCount = status?.staged.length ?? 0
  const unstaged = [...(status?.unstaged ?? []), ...(status?.untracked ?? [])]

  /* Which two sides a row's diff has. A **staged** row is what a commit would
     contain — HEAD against the index, and deliberately not against the working
     tree, or an unstaged edit made after staging would be drawn as part of the
     commit. An **unstaged** row is the other half: index against disk. Neither
     a new file nor an untracked one has a left side worth an empty pane, so
     those open as themselves. */
  const openRow = React.useCallback(
    (file: GitFileState, side: Side) => {
      const path = projectPath(repo.path, file.path)
      if (side === "untracked" || (side !== "index" && markOf(file, side) === "A")) onOpenFile(path)
      else if (side === "index") onOpenDiff(path, "head", "staged")
      else onOpenDiff(path, "staged", "worktree")
    },
    [onOpenDiff, onOpenFile, repo.path]
  )

  /* The callbacks each group is handed, memoized for the same reason `Group`
     is: they name the group's own side and key, and nothing that changes while
     a commit message is being typed. A fresh arrow per render is a `React.memo`
     that never hits. */
  const handlers = React.useMemo(
    () =>
      new Map(
        groups.map((group) => [
          group.key,
          {
            dirKey: (path: string) => `${group.key}:${path}`,
            onToggleDir: (path: string) =>
              setCollapsedDirs((current) => {
                const next = new Set(current)
                const key = `${group.key}:${path}`
                if (next.has(key)) next.delete(key)
                else next.add(key)
                return next
              }),
            onStage: (paths: string[]) =>
              void write({ action: group.side === "index" ? "unstage" : "stage", paths }),
            onDiscard: (paths: string[], what: string) =>
              void discard(paths, group.side === "untracked", what),
          },
        ])
      ),
    [groups, write, discard]
  )

  const stashAll = React.useCallback(async () => {
    setBusy(true)
    try {
      const next = await stashPush(settings, projectId, { repo: repo.path || undefined })
      onStatus(next)
      setWriteError(null)
      setOutput(next.created ? "Stashed the working tree." : "Nothing to stash.")
      /* Whatever was parked is only findable in the list, so open it. */
      if (next.created) setShowStashes(true)
    } catch (err) {
      const { title, detail } = describeError(err)
      setWriteError(detail ? `${title}: ${detail}` : title)
    } finally {
      setBusy(false)
    }
  }, [onStatus, projectId, repo.path, settings])

  return (
    <section className="border-b border-border/40 last:border-b-0">
      {/* ── The header ──
          A row, not a button: it holds three controls now (the disclosure, the
          branch, the overflow) and a button cannot contain them. With one
          repository the disclosure and the name are gone and what is left is
          the branch and the actions. */}
      <div
        className={cn(
          "flex items-center gap-1 px-1 text-xs",
          coarse ? "min-h-12" : "min-h-9"
        )}
      >
        {collapsible && (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="flex min-w-0 shrink items-center gap-1 py-1 text-left hover:text-foreground"
            title={repo.path || repo.name}
          >
            <HugeiconsIcon
              icon={open ? ArrowDown01Icon : ArrowRight01Icon}
              strokeWidth={2}
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 truncate font-medium">{repo.name}</span>
          </button>
        )}
        {/* The app's one branch switcher (`branch-picker.tsx`) — the same
            control the composer's popover draws, so switching, creating and
            checking out a remote behave identically in both places. The trigger
            stays the header's: a branch is a control, not a caption. */}
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
            "flex shrink items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground",
            coarse && "min-h-11"
          )}
        >
          <HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{branch}</span>
        </BranchPicker>
        <Tracking status={status} />
        <span className="flex-1" />
        {count !== null && count > 0 && (
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] tabular-nums">
            {count}
          </span>
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
              <DropdownMenuItem
                disabled={busy || (count ?? 0) === 0}
                onClick={() => void stashAll()}
              >
                <HugeiconsIcon icon={Archive02Icon} strokeWidth={2} />
                Stash everything
              </DropdownMenuItem>
              {/* The two lists live in the body, so offering to reveal one
                  while the body is collapsed would be a toggle with nothing to
                  show for it. */}
              {open && (
                <>
                  <DropdownMenuItem onClick={() => setShowStashes((current) => !current)}>
                    <HugeiconsIcon icon={PackageIcon} strokeWidth={2} />
                    {showStashes ? "Hide stashes" : "Show stashes"}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setShowHistory((current) => !current)}>
                    <HugeiconsIcon icon={Clock01Icon} strokeWidth={2} />
                    {showHistory ? "Hide history" : "Show history"}
                  </DropdownMenuItem>
                </>
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

      {open && (
        <div>
          {state?.error && (
            <div className="px-2 py-1.5">
              <Notice tone="error">{state.error}</Notice>
            </div>
          )}
          {writeError && (
            <div className="px-2 py-1.5">
              <Notice tone="error">{writeError}</Notice>
            </div>
          )}
          {output && (
            <div className="px-2 py-1.5">
              <Notice className="font-mono">{output}</Notice>
            </div>
          )}

          {/* The commit box comes *before* the files: it is what the panel is
              for, and forty changed files used to push it off the bottom. */}
          {status?.repository && (
            <form
              className="border-b border-border/60 p-2"
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
              {/* The commit button says what it will commit, because "commit"
                  with nothing staged silently means "stage everything first"
                  and that is not something a button should imply. */}
              <div className="mt-1.5 flex items-center gap-1.5">
                <Button
                  type="submit"
                  size="xs"
                  className="min-w-0 flex-1"
                  disabled={busy || !message.trim() || (count ?? 0) === 0}
                  title={`Commit on ${branch} (⌘Enter)`}
                >
                  <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-3.5" />
                  <span className="truncate">
                    {stagedCount > 0
                      ? `Commit ${stagedCount}`
                      : unstaged.length > 0
                        ? `Stage all & commit ${unstaged.length}`
                        : "Commit"}
                  </span>
                </Button>
                <IconAction
                  label={`Stage all ${unstaged.length}`}
                  icon={PlusSignIcon}
                  disabled={busy || unstaged.length === 0}
                  onClick={() =>
                    void write({ action: "stage", paths: unstaged.map((file) => file.path) })
                  }
                />
                <Count value={unstaged.length} />
                {/* Offered only where there is a profile that can do it: a
                    disabled wand nobody can enable is worse than no wand. */}
                {draftProfile && (
                  <IconAction
                    label={drafting ? "Drafting…" : "Draft the message with AI"}
                    icon={SparklesIcon}
                    disabled={drafting || busy || (count ?? 0) === 0}
                    onClick={() => void draftMessage()}
                  />
                )}
              </div>
            </form>
          )}

          {!status && !state?.error ? (
            <PanelRowsSkeleton rows={4} className="py-1" />
          ) : status && !status.repository ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              This directory is no longer a git repository.
            </p>
          ) : groups.length === 0 ? (
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
            <div className="p-1">
              {groups.map((group) => {
                const on = handlers.get(group.key)!
                return (
                  <Group
                    key={group.key}
                    title={group.title}
                    side={group.side}
                    rows={group.rows}
                    layout={layout}
                    coarse={coarse}
                    busy={busy}
                    collapsedDirs={collapsedDirs}
                    onToggleDir={on.onToggleDir}
                    dirKey={on.dirKey}
                    onOpen={openRow}
                    onStage={on.onStage}
                    onDiscard={on.onDiscard}
                  />
                )
              })}
            </div>
          )}

          {status?.repository && (
            <>
              <StashSection
                projectId={projectId}
                repo={repo.path}
                open={showStashes}
                onToggle={() => setShowStashes((current) => !current)}
                onStatus={onStatus}
                coarse={coarse}
              />
              <HistorySection
                projectId={projectId}
                repo={repo.path}
                open={showHistory}
                onToggle={() => setShowHistory((current) => !current)}
                coarse={coarse}
                generation={commits}
              />
            </>
          )}
        </div>
      )}
    </section>
  )
}

/** A count beside an icon action; nothing when there is nothing to count. */
function Count({ value }: { value: number }) {
  if (value === 0) return null
  return <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{value}</span>
}
