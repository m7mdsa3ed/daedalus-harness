/* ── Source control ──
   What a thread did to the project, as git saw it, and everything needed to
   ship it: the working set, the stash, and the history.

   Three tabs, because they answer three different questions and only the first
   one is about a *scope*:

   - **Changes** is the review surface. The scope is the one choice — a turn (its
     two recorded trees, or its start tree against the disk while it is still
     running) or everything uncommitted (HEAD against the disk, untracked files
     included). Both are diffs of trees the server computes, so a `sed` in a
     shell reads exactly like an edit tool; the transcript is never consulted
     (server turn-changes.ts). Files are drawn as a *tree* rather than a flat
     list, because a turn that touches twelve files across four directories is
     unreadable as twelve full paths.
   - **Stashes** is the parking spot: the working set set aside under a name,
     brought back with apply (keeps it) or pop (drops it).
   - **History** is the log plus the branch you are on.

   Staging, discarding, stashing and committing are the project's git routes.
   They act on the index and the worktree *as they are now*, whatever scope is
   being read: staging a file a turn touched stages the whole file, including
   what later turns did to it — which is what `git add` means, and the file
   list's staged mark is read back from `git status` so the panel never has to
   guess. The one hunk-level door is `apply`, which git refuses when the
   surrounding lines have moved on; that refusal is shown, not smoothed over. */
import * as React from "react"
import type { IDockviewPanelProps } from "dockview-react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Archive02Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowTurnBackwardIcon,
  Delete02Icon,
  Folder01Icon,
  GitBranchIcon,
  GitCommitIcon,
  PlusSignIcon,
  RefreshIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { PatchView, type PatchHunk } from "@/components/ui/patch-view"
import { useConfirm } from "@/components/confirm-dialog"
import { PanelEmptyState, PanelNotice, PanelToolbar } from "@/components/workspace/primitives"
import { describeError } from "@/lib/errors"
import { useServer } from "@/lib/server-context"
import { useSessionMeta, useThread } from "@/lib/store"
import { shortAge } from "@/lib/time"
import { cn } from "@/lib/utils"
import { buildTree, countFiles, type DirNode, type FileNode } from "@/lib/workspace/git-tree"
import {
  changePatch,
  changedFiles,
  gitBranches,
  gitLog,
  gitStatus,
  gitWrite,
  stashApply,
  stashDrop,
  stashList,
  stashPop,
  stashPush,
  type BranchList,
  type ChangedFile,
  type GitCommit,
  type GitStatus,
  type GitWrite,
  type ReviewScope,
  type StashEntry,
} from "@/lib/workspace/git-api"
import { watchProject } from "@/lib/workspace/watch"

const STATUS_MARK: Record<ChangedFile["status"], { mark: string; className: string }> = {
  added: { mark: "A", className: "text-emerald-600 dark:text-emerald-400" },
  modified: { mark: "M", className: "text-amber-600 dark:text-amber-400" },
  deleted: { mark: "D", className: "text-red-600 dark:text-red-400" },
  renamed: { mark: "R", className: "text-sky-600 dark:text-sky-400" },
}

type Tab = "changes" | "stashes" | "history"

/** An icon button with its label as a tooltip — the row actions are icon-only
    for room, and an icon with no name is a guess. */
function IconAction({
  label,
  icon,
  onClick,
  disabled,
  className,
}: {
  label: string
  icon: typeof Tick02Icon
  onClick: () => void
  disabled?: boolean
  className?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={disabled}
            onClick={onClick}
            aria-label={label}
            className={className}
          >
            <HugeiconsIcon icon={icon} strokeWidth={2} />
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/* ── The file tree ──
   Folders collapse; a file row carries its status mark, its counts and the
   three things you can do to it. Rows are indented by depth rather than nested
   in padded containers so a deep path does not walk off the right edge of a
   narrow panel. */

function FileRow({
  node,
  depth,
  selected,
  staged,
  busy,
  onSelect,
  onStage,
  onDiscard,
}: {
  node: FileNode
  depth: number
  selected: boolean
  staged: boolean
  busy: boolean
  onSelect: () => void
  onStage: () => void
  onDiscard: () => void
}) {
  const file = node.file
  const mark = STATUS_MARK[file.status]
  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-md pr-1 text-xs hover:bg-accent/50",
        selected && "bg-accent"
      )}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
        title={file.from ? `${file.from} → ${file.path}` : file.path}
      >
        <span className={cn("w-3 shrink-0 font-mono", mark.className)}>{mark.mark}</span>
        <span className="min-w-0 flex-1 truncate font-mono">{node.name}</span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          {file.binary ? "bin" : `+${file.additions} −${file.deletions}`}
        </span>
      </button>
      <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 has-focus-visible:opacity-100 data-[staged=true]:opacity-100" data-staged={staged}>
        <IconAction
          label={staged ? "Unstage" : "Stage"}
          icon={Tick02Icon}
          disabled={busy}
          onClick={onStage}
          className={cn(staged && "text-emerald-600 dark:text-emerald-400")}
        />
        {file.status !== "deleted" && (
          <IconAction
            label="Discard"
            icon={ArrowTurnBackwardIcon}
            disabled={busy}
            onClick={onDiscard}
            className="hover:text-destructive"
          />
        )}
      </div>
    </div>
  )
}

function DirRow({
  node,
  depth,
  collapsed,
  onToggle,
}: {
  node: DirNode
  depth: number
  collapsed: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className="flex w-full items-center gap-1.5 rounded-md py-1 pr-1 text-left text-xs text-muted-foreground hover:bg-accent/50"
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
    >
      <HugeiconsIcon
        icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon}
        strokeWidth={2}
        className="size-3.5 shrink-0"
      />
      <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate font-mono">{node.name}</span>
      <span className="shrink-0 font-mono text-[10px] tabular-nums opacity-60">
        {countFiles(node)}
      </span>
    </button>
  )
}

function FileTree({
  root,
  collapsed,
  onToggleDir,
  selected,
  staged,
  busy,
  onSelect,
  onStage,
  onDiscard,
}: {
  root: DirNode
  collapsed: ReadonlySet<string>
  onToggleDir: (path: string) => void
  selected: string | null
  staged: ReadonlySet<string>
  busy: boolean
  onSelect: (path: string) => void
  onStage: (file: ChangedFile, staged: boolean) => void
  onDiscard: (file: ChangedFile) => void
}) {
  const rows: React.ReactNode[] = []
  const walk = (node: DirNode, depth: number) => {
    for (const dir of node.dirs) {
      const isCollapsed = collapsed.has(dir.path)
      rows.push(
        <DirRow
          key={`d:${dir.path}`}
          node={dir}
          depth={depth}
          collapsed={isCollapsed}
          onToggle={() => onToggleDir(dir.path)}
        />
      )
      if (!isCollapsed) walk(dir, depth + 1)
    }
    for (const file of node.files) {
      rows.push(
        <FileRow
          key={`f:${file.path}`}
          node={file}
          depth={depth}
          selected={selected === file.path}
          staged={staged.has(file.path)}
          busy={busy}
          onSelect={() => onSelect(file.path)}
          onStage={() => onStage(file.file, staged.has(file.path))}
          onDiscard={() => onDiscard(file.file)}
        />
      )
    }
  }
  walk(root, 0)
  return <div className="p-1">{rows}</div>
}

export function SourceControlPanel({
  params,
  api,
}: IDockviewPanelProps<{ sessionId: string; scope?: string }>) {
  const { sessionId } = params
  const settings = useServer()
  const meta = useSessionMeta(sessionId)
  const thread = useThread(sessionId)
  const projectId = meta?.projectId
  const confirm = useConfirm()

  const [tab, setTab] = React.useState<Tab>("changes")

  /* Turns, newest first, for the scope menu. Only the ones that changed
     something (or are still running) are worth a row. */
  const turns = React.useMemo(() => {
    const seen = new Map<string, number>()
    thread.items.forEach((item, index) => {
      if (item.kind === "user" && item.turnId && !seen.has(item.turnId)) seen.set(item.turnId, index)
    })
    return Object.values(thread.turnChanges)
      .filter((turn) => turn.files.length > 0 || !turn.ended)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((turn) => {
        const at = seen.get(turn.turnId)
        const head = at !== undefined ? thread.items[at] : undefined
        const label = head && head.kind === "user" ? head.text.replace(/\s+/g, " ").slice(0, 48) : "turn"
        return { ...turn, label }
      })
  }, [thread.items, thread.turnChanges])

  const [scope, setScope] = React.useState<ReviewScope>(params.scope ?? "uncommitted")
  React.useEffect(() => {
    api.updateParameters({ sessionId, scope })
  }, [api, sessionId, scope])
  React.useEffect(() => {
    api.setTitle(scope === "uncommitted" ? "Changes" : "Turn changes")
  }, [api, scope])

  const [files, setFiles] = React.useState<ChangedFile[]>([])
  const [unavailable, setUnavailable] = React.useState<string | null>(null)
  const [status, setStatus] = React.useState<GitStatus | null>(null)
  const [selected, setSelected] = React.useState<string | null>(null)
  const [patch, setPatch] = React.useState<string>("")
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [generation, setGeneration] = React.useState(0)
  const refresh = React.useCallback(() => setGeneration((g) => g + 1), [])

  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(() => new Set())
  const toggleDir = React.useCallback((path: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  /* The list. Re-read on scope change, on a manual refresh, when the turn
     being looked at ends, and — debounced — whenever the project's files
     move, because the agent is usually still writing while this is open. */
  const scopeTurn = scope.startsWith("turn:") ? thread.turnChanges[scope.slice(5)] : undefined
  const scopeEnded = scopeTurn?.ended ?? true
  React.useEffect(() => {
    if (!projectId) return
    const controller = new AbortController()
    setLoading(true)
    Promise.all([
      changedFiles(settings, sessionId, scope, controller.signal),
      gitStatus(settings, projectId, controller.signal).catch(() => null),
    ])
      .then(([changes, gitState]) => {
        setFiles(changes.files)
        setUnavailable(changes.unavailable ?? null)
        setStatus(gitState)
        setError(null)
        setSelected((current) =>
          current && changes.files.some((f) => f.path === current) ? current : (changes.files[0]?.path ?? null)
        )
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        setError(describeError(err).title)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [settings, sessionId, projectId, scope, generation, scopeEnded])

  React.useEffect(() => {
    if (!projectId) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = watchProject(projectId, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(refresh, 400)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [projectId, refresh])

  /* The selected file's hunks. */
  React.useEffect(() => {
    if (!selected) {
      setPatch("")
      return
    }
    const controller = new AbortController()
    changePatch(settings, sessionId, scope, selected, controller.signal)
      .then((result) => setPatch(result.patch))
      .catch((err) => {
        if (!controller.signal.aborted) setError(describeError(err).title)
      })
    return () => controller.abort()
  }, [settings, sessionId, scope, selected, generation])

  const write = React.useCallback(
    async (input: GitWrite) => {
      if (!projectId) return
      setBusy(true)
      try {
        const result = await gitWrite(settings, projectId, input)
        setStatus(result)
        setError(null)
        if (input.action === "commit") {
          setMessage("")
          if (result.output) setCommitOutput(result.output)
        }
        refresh()
      } catch (err) {
        setError(describeError(err).title)
      } finally {
        setBusy(false)
      }
    },
    [projectId, settings, refresh]
  )

  const [message, setMessage] = React.useState("")
  const [amend, setAmend] = React.useState(false)
  const [commitOutput, setCommitOutput] = React.useState<string | null>(null)

  const staged = React.useMemo(() => new Set(status?.staged.map((f) => f.path) ?? []), [status])
  const untracked = React.useMemo(() => new Set(status?.untracked.map((f) => f.path) ?? []), [status])
  const stagedCount = status?.staged.length ?? 0
  const tree = React.useMemo(() => buildTree(files), [files])

  const discardFile = React.useCallback(
    async (file: ChangedFile) => {
      const ok = await confirm({
        title: `Discard changes to ${file.path}?`,
        description: untracked.has(file.path)
          ? "This file is untracked. Discarding here only reverts tracked changes — delete it from the editor if it should go."
          : "Working-tree changes to this file are thrown away. This cannot be undone.",
        confirmLabel: "Discard",
        destructive: true,
      })
      if (ok) void write({ action: "discard", paths: [file.path] })
    },
    [confirm, untracked, write]
  )

  /* ── Stashes ──
     Read when the tab is opened and after every write, never on a timer: a
     stash only moves because someone here moved it. */
  const [stashes, setStashes] = React.useState<StashEntry[]>([])
  const [stashesLoaded, setStashesLoaded] = React.useState(false)
  const [stashMessage, setStashMessage] = React.useState("")

  const loadStashes = React.useCallback(() => {
    if (!projectId) return
    stashList(settings, projectId)
      .then((entries) => {
        setStashes(entries)
        setStashesLoaded(true)
        setError(null)
      })
      .catch((err) => setError(describeError(err).title))
  }, [projectId, settings])

  React.useEffect(() => {
    if (tab === "stashes") loadStashes()
  }, [tab, loadStashes, generation])

  const stashAction = React.useCallback(
    async (run: () => Promise<GitStatus>) => {
      setBusy(true)
      try {
        setStatus(await run())
        setError(null)
        loadStashes()
        refresh()
      } catch (err) {
        setError(describeError(err).title)
      } finally {
        setBusy(false)
      }
    },
    [loadStashes, refresh]
  )

  const createStash = React.useCallback(async () => {
    if (!projectId) return
    setBusy(true)
    try {
      const result = await stashPush(settings, projectId, stashMessage)
      setStatus(result)
      setStashMessage("")
      setError(result.created ? null : "There was nothing to stash.")
      loadStashes()
      refresh()
    } catch (err) {
      setError(describeError(err).title)
    } finally {
      setBusy(false)
    }
  }, [projectId, settings, stashMessage, loadStashes, refresh])

  /* ── History ── */
  const [commits, setCommits] = React.useState<GitCommit[]>([])
  const [branchList, setBranchList] = React.useState<BranchList | null>(null)
  const [historyLoaded, setHistoryLoaded] = React.useState(false)
  const [newBranch, setNewBranch] = React.useState("")

  React.useEffect(() => {
    if (tab !== "history" || !projectId) return
    const controller = new AbortController()
    Promise.all([
      gitLog(settings, projectId, { limit: 100 }, controller.signal),
      gitBranches(settings, projectId, undefined, controller.signal).catch(() => null),
    ])
      .then(([log, branches]) => {
        setCommits(log)
        setBranchList(branches)
        setHistoryLoaded(true)
        setError(null)
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(describeError(err).title)
      })
    return () => controller.abort()
  }, [tab, projectId, settings, generation])

  if (!projectId) {
    return <PanelEmptyState>This thread has no project, so there is no repository to review.</PanelEmptyState>
  }

  const totals = files.reduce(
    (acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }),
    { add: 0, del: 0 }
  )
  const selectedFile = files.find((f) => f.path === selected) ?? null
  const scopeLabel =
    scope === "uncommitted"
      ? "All uncommitted changes"
      : (() => {
          const turn = turns.find((t) => `turn:${t.turnId}` === scope)
          if (!turn) return "Turn"
          return turn.ended ? `Turn · ${turn.label}` : `Running · ${turn.label}`
        })()

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar>
        <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="min-w-0 flex-1">
          <TabsList variant="line" className="h-7 justify-start">
            <TabsTrigger value="changes" className="flex-none px-2 text-xs">
              Changes
            </TabsTrigger>
            <TabsTrigger value="stashes" className="flex-none px-2 text-xs">
              Stashes
              {stashes.length > 0 && (
                <span className="ml-1 font-mono text-[10px] tabular-nums opacity-60">
                  {stashes.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="history" className="flex-none px-2 text-xs">
              History
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={refresh}
          disabled={loading}
          aria-label="Refresh"
        >
          <HugeiconsIcon
            icon={RefreshIcon}
            strokeWidth={2}
            className={cn("size-3.5", loading && "animate-spin")}
          />
        </Button>
      </PanelToolbar>

      {status?.branch && (
        <PanelNotice className="flex items-center gap-1.5">
          <HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} className="size-3.5 shrink-0" />
          <span className="font-mono">{status.branch}</span>
          {(status.ahead > 0 || status.behind > 0) && (
            <span className="font-mono tabular-nums">
              {status.ahead > 0 && `↑${status.ahead}`}
              {status.behind > 0 && `↓${status.behind}`}
            </span>
          )}
          {stagedCount > 0 && <span>· {stagedCount} staged</span>}
          {status.conflicted.length > 0 && (
            <span className="text-destructive">· {status.conflicted.length} conflicted</span>
          )}
          {tab === "changes" && scope !== "uncommitted" && (
            <span>· staging acts on the file as it is on disk now</span>
          )}
        </PanelNotice>
      )}
      {error && <PanelNotice className="text-destructive">{error}</PanelNotice>}

      {tab === "changes" && (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-2 py-1.5">
            <Select value={scope} onValueChange={(next) => setScope(String(next))}>
              <SelectTrigger size="sm" className="h-7 min-w-0 flex-1 text-xs">
                <SelectValue>{scopeLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="uncommitted">All uncommitted changes</SelectItem>
                {turns.map((turn) => (
                  <SelectItem key={turn.turnId} value={`turn:${turn.turnId}`}>
                    {turn.ended ? `Turn · ${turn.label}` : `Running · ${turn.label}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
              {files.length} {files.length === 1 ? "file" : "files"}{" "}
              <span className="text-emerald-600 dark:text-emerald-400">+{totals.add}</span>{" "}
              <span className="text-red-600 dark:text-red-400">−{totals.del}</span>
            </span>
          </div>

          {unavailable ? (
            <PanelEmptyState>{unavailable}</PanelEmptyState>
          ) : files.length === 0 && !loading ? (
            <PanelEmptyState>
              {scope === "uncommitted" ? "The worktree is clean." : "This turn changed nothing on disk."}
            </PanelEmptyState>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col @panel-md:flex-row">
              <ScrollArea className="max-h-48 shrink-0 border-b border-border/60 @panel-md:max-h-none @panel-md:w-64 @panel-md:border-b-0 @panel-md:border-r">
                <FileTree
                  root={tree}
                  collapsed={collapsed}
                  onToggleDir={toggleDir}
                  selected={selected}
                  staged={staged}
                  busy={busy}
                  onSelect={setSelected}
                  onStage={(file, isStaged) =>
                    void write({ action: isStaged ? "unstage" : "stage", paths: [file.path] })
                  }
                  onDiscard={(file) => void discardFile(file)}
                />
              </ScrollArea>
              <ScrollArea className="min-h-0 flex-1">
                {selectedFile ? (
                  <PatchView
                    patch={patch}
                    busy={busy}
                    onStageHunk={(hunk: PatchHunk) =>
                      void write({ action: "apply", patch: hunk.patch, cached: true })
                    }
                    onDiscardHunk={(hunk: PatchHunk) =>
                      void confirm({
                        title: "Discard this hunk?",
                        description: "These lines are reverted on disk. This cannot be undone.",
                        confirmLabel: "Discard",
                        destructive: true,
                      }).then((ok) => {
                        if (ok) void write({ action: "apply", patch: hunk.patch, reverse: true })
                      })
                    }
                  />
                ) : (
                  <PanelEmptyState>Pick a file to read its hunks.</PanelEmptyState>
                )}
              </ScrollArea>
            </div>
          )}

          {!unavailable && (
            <form
              className="shrink-0 border-t border-border/60 p-2"
              onSubmit={(event) => {
                event.preventDefault()
                void write({ action: "commit", message, amend })
              }}
            >
              <Textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder={stagedCount > 0 ? "Commit message" : "Stage something first, then describe it"}
                rows={2}
                className="min-h-0 text-xs"
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault()
                    void write({ action: "commit", message, amend })
                  }
                }}
              />
              <div className="mt-1.5 flex items-center gap-2">
                <Label className="text-[11px] font-normal text-muted-foreground">
                  <Checkbox
                    checked={amend}
                    onCheckedChange={(checked) => setAmend(checked === true)}
                    className="size-3.5"
                  />
                  Amend
                </Label>
                <Separator orientation="vertical" className="h-4" />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy || files.length === 0}
                  onClick={() => void write({ action: "stage", paths: [] })}
                >
                  Stage all
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void createStash()}
                >
                  <HugeiconsIcon icon={Archive02Icon} strokeWidth={2} data-icon="inline-start" />
                  Stash
                </Button>
                <span className="flex-1" />
                <Button
                  type="submit"
                  size="sm"
                  disabled={busy || (stagedCount === 0 && !amend) || (!message.trim() && !amend)}
                >
                  Commit{stagedCount > 0 ? ` ${stagedCount}` : ""}
                </Button>
              </div>
              {commitOutput && (
                <pre className="mt-1.5 max-h-24 overflow-auto rounded bg-muted/40 p-1.5 font-mono text-[10px] text-muted-foreground">
                  {commitOutput}
                </pre>
              )}
            </form>
          )}
        </>
      )}

      {tab === "stashes" && (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-2 py-1.5">
            <Input
              value={stashMessage}
              onChange={(event) => setStashMessage(event.target.value)}
              placeholder="Stash message"
              className="h-7 min-w-0 flex-1 text-xs"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  void createStash()
                }
              }}
            />
            <Button size="sm" disabled={busy} onClick={() => void createStash()}>
              <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
              Stash
            </Button>
          </div>
          {stashes.length === 0 ? (
            <PanelEmptyState>
              {stashesLoaded
                ? "Nothing is stashed. Setting the working set aside puts it here."
                : "Reading the stash…"}
            </PanelEmptyState>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <div className="p-1">
                {stashes.map((entry) => (
                  <div
                    key={entry.ref}
                    className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent/50"
                  >
                    <HugeiconsIcon
                      icon={Archive02Icon}
                      strokeWidth={2}
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 truncate" title={entry.message}>
                      {entry.message}
                    </span>
                    {entry.at !== null && (
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                        {shortAge(entry.at * 1000)}
                      </span>
                    )}
                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 has-focus-visible:opacity-100">
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={busy}
                        onClick={() => void stashAction(() => stashApply(settings, projectId, entry.index))}
                      >
                        Apply
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={busy}
                        onClick={() => void stashAction(() => stashPop(settings, projectId, entry.index))}
                      >
                        Pop
                      </Button>
                      <IconAction
                        label="Drop"
                        icon={Delete02Icon}
                        disabled={busy}
                        className="hover:text-destructive"
                        onClick={() =>
                          void confirm({
                            title: "Drop this stash?",
                            description: `"${entry.message}" is deleted. This cannot be undone.`,
                            confirmLabel: "Drop",
                            destructive: true,
                          }).then((ok) => {
                            if (ok) void stashAction(() => stashDrop(settings, projectId, entry.index))
                          })
                        }
                      />
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </>
      )}

      {tab === "history" && (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-2 py-1.5">
            <Select
              value={branchList?.current ?? ""}
              onValueChange={(next) => {
                const branch = String(next)
                if (branch && branch !== branchList?.current)
                  void write({ action: "checkout", branch })
              }}
            >
              <SelectTrigger size="sm" className="h-7 min-w-0 flex-1 text-xs">
                <SelectValue>{branchList?.current ?? "No branch"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(branchList?.branches ?? []).map((branch) => (
                  <SelectItem key={branch} value={branch}>
                    {branch}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={newBranch}
              onChange={(event) => setNewBranch(event.target.value)}
              placeholder="New branch"
              className="h-7 w-28 shrink-0 text-xs"
              onKeyDown={(event) => {
                if (event.key === "Enter" && newBranch.trim()) {
                  event.preventDefault()
                  void write({ action: "checkout", branch: newBranch.trim(), create: true })
                  setNewBranch("")
                }
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !newBranch.trim()}
              onClick={() => {
                void write({ action: "checkout", branch: newBranch.trim(), create: true })
                setNewBranch("")
              }}
            >
              Create
            </Button>
          </div>
          {commits.length === 0 ? (
            <PanelEmptyState>
              {historyLoaded ? "This repository has no commits yet." : "Reading the log…"}
            </PanelEmptyState>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <div className="p-1">
                {commits.map((commit) => (
                  <div
                    key={commit.hash}
                    className="flex items-start gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent/50"
                  >
                    <HugeiconsIcon
                      icon={GitCommitIcon}
                      strokeWidth={2}
                      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate" title={commit.subject}>
                        {commit.subject}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                        <span>{commit.short}</span>
                        <span className="truncate">{commit.author}</span>
                        <span className="tabular-nums">{shortAge(commit.at * 1000)}</span>
                        {commit.filesChanged > 0 && (
                          <span className="tabular-nums">
                            <span className="text-emerald-600 dark:text-emerald-400">
                              +{commit.insertions}
                            </span>{" "}
                            <span className="text-red-600 dark:text-red-400">−{commit.deletions}</span>
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </>
      )}
    </div>
  )
}
