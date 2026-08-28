/* ── Source control ──
   Its own panel, but deliberately not its own diff viewer: every comparison it
   opens is an `editor` in diff mode. Five things can ask for a diff (this
   panel, the explorer, the editor's conflict bar, an agent's edit, a transcript
   link) and one panel type answering all five is what keeps "open the working
   file" from being implemented five slightly different ways.

   It also does not merge into the explorer, which lists the same files. A tree
   is navigation — hierarchy, expansion, open — and this is a working set with
   staging, discard and a commit box. Different gestures on a different unit of
   work. What people mean by wanting them together is *stacking*, and Dockview's
   groups already do that: the IDE preset puts both in the left group. */
import * as React from "react"
import type { IDockviewPanelProps } from "dockview-react"
import {
  CheckIcon,
  ChevronDownIcon,
  GitBranchIcon,
  MinusIcon,
  PlusIcon,
  RefreshCwIcon,
  Undo2Icon,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useConfirm } from "@/components/confirm-dialog"
import { ItemContextMenu, type MenuItemSpec } from "@/components/item-context-menu"
import { useDock } from "@/components/workspace/dock"
import { describeError, reportError } from "@/lib/errors"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { basename } from "@/lib/workspace/fs-api"
import {
  gitBranches,
  gitCheckout,
  gitCommit,
  gitDiscard,
  gitStage,
  gitStatus,
  gitUnstage,
  type GitFile,
  type GitStatus,
} from "@/lib/workspace/git-api"
import { watchProject } from "@/lib/workspace/watch"

/** One letter per state, the way every git UI does it. */
const MARK: Record<GitFile["index"], string> = {
  unmodified: " ",
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  untracked: "U",
  ignored: "I",
  conflicted: "!",
}

const TONE: Partial<Record<GitFile["index"], string>> = {
  added: "text-emerald-600 dark:text-emerald-400",
  untracked: "text-emerald-600 dark:text-emerald-400",
  deleted: "text-destructive",
  conflicted: "text-destructive",
  renamed: "text-blue-600 dark:text-blue-400",
}

/** Coalesce bursts: a branch switch or an install fires hundreds of events, and
    each one would otherwise be a `git status`. */
const REFRESH_DEBOUNCE_MS = 400

export function SourceControlPanel({
  api,
  params,
}: IDockviewPanelProps<{ projectId: string }>) {
  const { projectId } = params
  const dock = useDock()
  const confirm = useConfirm()
  const { state } = useStore()
  const project = state.projects.find((candidate) => candidate.id === projectId)

  const [status, setStatus] = React.useState<GitStatus | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState("")
  const [branches, setBranches] = React.useState<string[]>([])
  /* Inline, not `window.prompt`: Electron removed `prompt()` entirely (it
     returns null there), and this app already replaced native dialogs with
     `useConfirm` for the same reason. The explorer names new files the same
     way. */
  const [newBranch, setNewBranch] = React.useState<string | null>(null)

  React.useEffect(() => {
    api.setTitle(project ? `Changes — ${project.name}` : "Source control")
  }, [api, project])

  const refresh = React.useCallback(async () => {
    try {
      setStatus(await gitStatus(projectId))
      setError(null)
    } catch (err) {
      const { title, detail } = describeError(err)
      setError(detail ? `${title} — ${detail}` : title)
    }
  }, [projectId])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  /* The watcher is what keeps this honest without a poll: every write in the
     project is a reason the status might have changed, including the ones the
     agent makes. Debounced, because a build makes thousands. */
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = watchProject(projectId, () => {
      clearTimeout(timer)
      timer = setTimeout(() => void refresh(), REFRESH_DEBOUNCE_MS)
    })
    return () => {
      clearTimeout(timer)
      off()
    }
  }, [projectId, refresh])

  /** Any mutation: run it, take the status it answers with, report what failed.
      git's own message is the useful one, so it goes through `reportError`
      rather than being flattened into "the request failed". */
  const mutate = React.useCallback(
    async (run: () => Promise<GitStatus>, context: string) => {
      setBusy(true)
      try {
        setStatus(await run())
        setError(null)
      } catch (err) {
        reportError(err, context)
      } finally {
        setBusy(false)
      }
    },
    []
  )

  const openDiff = (file: GitFile, comparison: "staged" | "head") => {
    dock.openPanel({ kind: "editor", projectId, path: file.path, comparison })
  }

  const discard = async (files: GitFile[]) => {
    const ok = await confirm({
      title: files.length === 1 ? `Discard changes to ${basename(files[0].path)}?` : `Discard ${files.length} files?`,
      description:
        "The working-tree changes are thrown away. Git keeps no record of them, so this cannot be undone from here.",
      confirmLabel: "Discard",
      destructive: true,
    })
    if (!ok) return
    await mutate(() => gitDiscard(projectId, files.map((file) => file.path)), "Couldn't discard")
  }

  const commit = async (amend = false) => {
    setBusy(true)
    try {
      const result = await gitCommit(projectId, message, { amend })
      setStatus(result.status)
      setMessage("")
      /* git's stdout is where a hook says what it did, and where the commit
         line itself is. Worth showing rather than a generic "done". */
      toast.success(result.output.split("\n")[0] || "Committed")
    } catch (err) {
      reportError(err, "Couldn't commit")
    } finally {
      setBusy(false)
    }
  }

  const openBranches = async () => {
    try {
      setBranches((await gitBranches(projectId)).branches)
    } catch (err) {
      reportError(err, "Couldn't list branches")
    }
  }

  if (!project) return <Centered>This project no longer exists.</Centered>
  if (error) {
    return (
      <Centered>
        <p className="max-w-sm">{error}</p>
        <Button size="sm" variant="outline" onClick={() => void refresh()}>
          Try again
        </Button>
      </Centered>
    )
  }
  if (!status) return <Centered>Loading…</Centered>
  if (!status.repository) {
    return (
      <Centered>
        <GitBranchIcon className="size-6" />
        <p className="max-w-xs">
          {project.name} isn't a git repository. Run <code className="font-mono">git init</code> in
          a terminal here and refresh.
        </p>
        <Button size="sm" variant="outline" onClick={() => void refresh()}>
          Refresh
        </Button>
      </Centered>
    )
  }

  const rows = (files: GitFile[], staged: boolean) =>
    files.map((file) => {
      const stateFor = staged ? file.index : file.worktree
      const menu: MenuItemSpec[] = [
        {
          label: "Open changes",
          onClick: () => openDiff(file, staged ? "head" : "staged"),
        },
        { label: "Open file", onClick: () => dock.openPanel({ kind: "editor", projectId, path: file.path }) },
        { type: "separator" },
        staged
          ? { label: "Unstage", onClick: () => void mutate(() => gitUnstage(projectId, [file.path]), "Couldn't unstage") }
          : { label: "Stage", onClick: () => void mutate(() => gitStage(projectId, [file.path]), "Couldn't stage") },
        ...(staged || file.worktree === "untracked"
          ? []
          : [{ label: "Discard changes", destructive: true, onClick: () => void discard([file]) } as MenuItemSpec]),
      ]
      return (
        <ItemContextMenu key={`${staged ? "s" : "w"}:${file.path}`} items={menu}>
          <div className="group/row flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-xs hover:bg-muted/60">
            <span className={cn("w-3 shrink-0 text-center font-mono", TONE[stateFor])}>
              {MARK[stateFor]}
            </span>
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left text-muted-foreground hover:text-foreground"
              title={file.from ? `${file.from} → ${file.path}` : file.path}
              onClick={() => openDiff(file, staged ? "head" : "staged")}
            >
              {basename(file.path)}
              <span className="ml-1.5 truncate text-[10px] opacity-60">
                {file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""}
              </span>
            </button>
            {!staged && file.worktree !== "untracked" && (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Discard ${file.path}`}
                className="size-5 opacity-0 group-hover/row:opacity-100"
                onClick={() => void discard([file])}
              >
                <Undo2Icon className="size-3" />
              </Button>
            )}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={staged ? `Unstage ${file.path}` : `Stage ${file.path}`}
              className="size-5 opacity-0 group-hover/row:opacity-100"
              onClick={() =>
                void mutate(
                  () => (staged ? gitUnstage(projectId, [file.path]) : gitStage(projectId, [file.path])),
                  staged ? "Couldn't unstage" : "Couldn't stage"
                )
              }
            >
              {staged ? <MinusIcon className="size-3" /> : <PlusIcon className="size-3" />}
            </Button>
          </div>
        </ItemContextMenu>
      )
    })

  const changes = [...status.unstaged, ...status.untracked]
  const nothing =
    status.staged.length === 0 && changes.length === 0 && status.conflicted.length === 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1">
        <DropdownMenu
          onOpenChange={(open) => {
            /* Loaded when the menu opens rather than from the trigger's click:
               the trigger's own handler is what opens it, and stacking a second
               one behind Base UI's `render` merge is a race nobody needs. */
            if (open) void openBranches()
          }}
        >
          <DropdownMenuTrigger
            render={
              <Button size="xs" variant="ghost" className="min-w-0 gap-1">
                <GitBranchIcon className="size-3.5 shrink-0" />
                <span className="truncate">{status.branch ?? "detached"}</span>
                <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
              </Button>
            }
          />
          <DropdownMenuContent align="start" className="max-h-72 overflow-auto">
            {branches.map((branch) => (
              <DropdownMenuItem
                key={branch}
                onClick={() =>
                  void mutate(() => gitCheckout(projectId, branch), `Couldn't switch to ${branch}`)
                }
              >
                {branch === status.branch && <CheckIcon className="size-3.5" />}
                <span className={cn("truncate", branch !== status.branch && "ms-5")}>{branch}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setNewBranch("")}>
              <PlusIcon className="size-3.5" />
              New branch…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {(status.ahead > 0 || status.behind > 0) && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {status.ahead > 0 && `↑${status.ahead}`}
            {status.behind > 0 && ` ↓${status.behind}`}
          </span>
        )}
        <span className="flex-1" />
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Refresh"
          className="size-6"
          onClick={() => void refresh()}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>

      {newBranch !== null && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
          <GitBranchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <Input
            autoFocus
            value={newBranch}
            onChange={(event) => setNewBranch(event.target.value)}
            placeholder="New branch name"
            aria-label="New branch name"
            className="h-6 min-w-0 flex-1 px-1.5 text-xs"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                const name = newBranch.trim()
                setNewBranch(null)
                if (name)
                  void mutate(
                    () => gitCheckout(projectId, name, { create: true }),
                    "Couldn't create the branch"
                  )
              } else if (event.key === "Escape") {
                // Claimed, so the thread's Escape chain does not also fire.
                event.preventDefault()
                event.stopPropagation()
                setNewBranch(null)
              }
            }}
            onBlur={() => setNewBranch(null)}
          />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-1">
        {status.conflicted.length > 0 && (
          <Section
            label="Conflicts"
            count={status.conflicted.length}
            tone="destructive"
          >
            {rows(status.conflicted, false)}
          </Section>
        )}

        {status.staged.length > 0 && (
          <Section
            label="Staged"
            count={status.staged.length}
            action={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Unstage all"
                className="size-5"
                onClick={() => void mutate(() => gitUnstage(projectId), "Couldn't unstage")}
              >
                <MinusIcon className="size-3" />
              </Button>
            }
          >
            {rows(status.staged, true)}
          </Section>
        )}

        {changes.length > 0 && (
          <Section
            label="Changes"
            count={changes.length}
            action={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Stage all"
                className="size-5"
                onClick={() => void mutate(() => gitStage(projectId), "Couldn't stage")}
              >
                <PlusIcon className="size-3" />
              </Button>
            }
          >
            {rows(changes, false)}
          </Section>
        )}

        {nothing && (
          <p className="p-4 text-center text-xs text-muted-foreground">
            {status.unborn ? "No commits yet." : "Nothing to commit — the tree is clean."}
          </p>
        )}
      </div>

      <div className="shrink-0 space-y-1.5 border-t border-border/60 p-2">
        <Textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={`Message (⌘Enter to commit${status.staged.length === 0 ? " — nothing staged" : ""})`}
          rows={2}
          className="min-h-14 resize-none text-xs"
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault()
              if (message.trim() && status.staged.length > 0) void commit()
            }
          }}
        />
        <div className="flex items-center gap-1.5">
          <Button
            size="xs"
            className="flex-1"
            disabled={busy || !message.trim() || status.staged.length === 0}
            onClick={() => void commit()}
          >
            <CheckIcon />
            Commit {status.staged.length > 0 && `(${status.staged.length})`}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy || status.unborn}
            title="Replace the last commit"
            onClick={() => void commit(true)}
          >
            Amend
          </Button>
        </div>
      </div>
    </div>
  )
}

function Section({
  label,
  count,
  tone,
  action,
  children,
}: {
  label: string
  count: number
  tone?: "destructive"
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="mb-1">
      <header className="flex h-6 items-center gap-1.5 px-1.5">
        <span
          className={cn(
            "text-[11px] font-medium tracking-wide uppercase",
            tone === "destructive" ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {label}
        </span>
        <span className="text-[11px] text-muted-foreground/60">{count}</span>
        <span className="flex-1" />
        {action}
      </header>
      {children}
    </section>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-8 text-center text-xs text-muted-foreground">
      {children}
    </div>
  )
}
