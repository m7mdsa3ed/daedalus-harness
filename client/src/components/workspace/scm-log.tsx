/* ── The two lists beside the working set ──
   Stashes and history. Both were already on the server and in the git client
   (`/git/stashes`, `/git/log`) and neither had ever been drawn, so the panel
   could stage and commit but not park work or look at what it had committed.

   They share one shape, which is why they share a file: a collapsible section
   that reads **when it is first opened** and not before. A source-control panel
   is often open beside a running agent for an hour, and a log nobody expanded
   is a `git log` process per repository per watch burst. Expanding is the
   request; the Refresh beside the title is the only other one.

   Neither list is a place you can act from except in the ways git already
   names: a stash can be applied, popped or dropped, and a commit's hash can be
   copied. There is no per-commit diff, because there is no route for one — and
   inventing a client-side one would mean shipping a second, worse `git show`. */
import * as React from "react"
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Delete02Icon,
  GitCommitVerticalIcon,
  InboxDownloadIcon,
  InboxUploadIcon,
  ListIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { CommitGraph } from "@/components/workspace/scm/commit-graph"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { CopyButton } from "@/components/ui/copy-button"
import { PanelRowsSkeleton } from "@/components/ui/skeletons"
import { useConfirm } from "@/components/confirm-dialog"
import { describeError } from "@/lib/errors"
import { idePrefs, setIdePref } from "@/lib/ide/prefs"
import { useServer } from "@/lib/server-context"
import { writeClipboard } from "@/lib/clipboard"
import { shortAge } from "@/lib/time"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import {
  gitLog,
  stashAct,
  stashList,
  type GitCommit,
  type GitStatus,
  type StashEntry,
  type StashVerb,
} from "@/lib/workspace/git-api"

/** How many commits a section asks for. Enough to recognise where you are;
    anything more is what a terminal is for. */
const LOG_LIMIT = 30
/** The server's own ceiling on one `git log`. */
const LOG_MAX = 200

/* ── The shell both lists wear ──
   A disclosure whose content is fetched by the disclosure itself. `load` is
   called on the first open and by Refresh, never on a timer and never on the
   watch stream: a commit is not something that lands while you are reading. */
function Section({
  title,
  count,
  open,
  onToggle,
  onRefresh,
  coarse,
  busy,
  error,
  /** Anything the section itself offers, before the Refresh it always has. */
  actions,
  fixed = false,
  children,
}: {
  /** Drawn as a tab's heading rather than a disclosure — always open. */
  fixed?: boolean
  title: string
  count: number | null
  open: boolean
  onToggle: () => void
  onRefresh: () => void
  coarse: boolean
  busy: boolean
  error: string | null
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className={cn(!fixed && "border-t")}>
      <div
        className={cn(
          "group flex items-center gap-1 px-1 text-xs font-medium text-muted-foreground",
          coarse ? "min-h-10" : "min-h-7"
        )}
      >
        <button
          type="button"
          onClick={fixed ? undefined : onToggle}
          aria-expanded={fixed ? undefined : open}
          className={cn("flex min-w-0 flex-1 items-center gap-1 py-1 text-left", fixed && "pl-1.5 cursor-default")}
        >
          {!fixed && (
            <HugeiconsIcon
              icon={open ? ArrowDown01Icon : ArrowRight01Icon}
              strokeWidth={2}
              className="size-3.5 shrink-0"
            />
          )}
          <span className="min-w-0 truncate">{title}</span>
          {count !== null && count > 0 && (
            <span className="tabular-nums">{count}</span>
          )}
        </button>
        {open && actions}
        {open && (
          <SmallAction label={`Refresh ${title.toLowerCase()}`} icon={RefreshIcon} disabled={busy} onClick={onRefresh} coarse={coarse} />
        )}
      </div>
      {open && (
        <div className="pb-1">
          {error ? (
            /* A git failure is the one error in this panel worth a clipboard:
               it is usually the porcelain's own multi-line complaint, and the
               next thing anyone does with it is paste it somewhere. */
            <div className="flex items-start gap-1 px-2 py-1">
              <p className="min-w-0 flex-1 text-xs text-destructive">{error}</p>
              <CopyButton
                text={error}
                size="icon-xs"
                className="shrink-0 text-destructive"
              />
            </div>
          ) : (
            children
          )}
        </div>
      )}
    </div>
  )
}

/** The same icon button the file rows wear, in the one size this file uses. */
function SmallAction({
  label,
  icon,
  onClick,
  disabled,
  coarse,
  className,
}: {
  label: string
  icon: typeof RefreshIcon
  onClick: () => void
  disabled?: boolean
  coarse: boolean
  className?: string
}) {
  return (
    <Button
      title={label}
      variant="ghost"
      size="icon-xs"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      className={cn(coarse ? "size-11" : "size-6", "shrink-0", className)}
    >
      <HugeiconsIcon icon={icon} strokeWidth={2} className="size-3.5" />
    </Button>
  )
}

/** One list, read lazily. Both sections below are this hook plus their rows. */
function useLazyList<T>(read: () => Promise<T[]>, open: boolean) {
  const [items, setItems] = React.useState<T[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  /* The reader is rebuilt every render (it closes over the repo and the
     server), so the effect keys on `open` alone and the current reader is taken
     from a ref — otherwise every parent render would re-fetch. */
  const readRef = React.useRef(read)
  readRef.current = read

  const load = React.useCallback(() => {
    setBusy(true)
    let cancelled = false
    void readRef
      .current()
      .then((next) => {
        if (cancelled) return
        setItems(next)
        setError(null)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err).title)
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  React.useEffect(() => {
    if (!open || items !== null) return
    return load()
    // `items` is the "have we ever read this" flag; re-running on its value
    // would read again on every change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, load])

  /* "What you are holding is stale." Open, that is a re-read; closed, it is
     dropping the answer so the next open pays for a fresh one — which is the
     whole point of a section that reads only when asked. */
  const openRef = React.useRef(open)
  openRef.current = open
  const invalidate = React.useCallback(() => {
    if (openRef.current) load()
    else setItems(null)
  }, [load])

  return { items, error, busy, reload: load, invalidate }
}

/* ── Stashes ──
   Parking, git's own. `apply` keeps the entry, `pop` takes it, `drop` throws it
   away — the three verbs the server already exposes, and the only destructive
   one asks first. Every write answers the next status, which is what repaints
   the working set above. */
export function StashSection({
  projectId,
  repo,
  open,
  onToggle,
  onStatus,
  coarse,
  fixed,
}: {
  fixed?: boolean
  projectId: string
  repo: string
  open: boolean
  onToggle: () => void
  onStatus: (status: GitStatus) => void
  coarse: boolean
}) {
  const settings = useServer()
  const confirm = useConfirm()
  const [writing, setWriting] = React.useState(false)

  const list = useLazyList<StashEntry>(
    () => stashList(settings, projectId, repo || undefined),
    open
  )

  const act = async (verb: StashVerb, entry: StashEntry) => {
    if (verb === "drop") {
      const ok = await confirm({
        title: `Drop ${entry.ref}?`,
        description: `“${entry.message}” is thrown away. A dropped stash is not on any branch, so this cannot be undone.`,
        confirmLabel: "Drop",
        destructive: true,
      })
      if (!ok) return
    }
    setWriting(true)
    try {
      onStatus(await stashAct(settings, projectId, verb, entry.index, repo || undefined))
      list.reload()
    } catch (err) {
      toast.error(describeError(err).title)
    } finally {
      setWriting(false)
    }
  }

  return (
    <Section
      fixed={fixed}
      title="Stashes"
      count={list.items?.length ?? null}
      open={open}
      onToggle={onToggle}
      onRefresh={list.reload}
      coarse={coarse}
      busy={list.busy || writing}
      error={list.error}
    >
      {list.items === null ? (
        <PanelRowsSkeleton rows={3} className="space-y-1.5 p-1" />
      ) : list.items.length === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">Nothing is stashed.</p>
      ) : (
        list.items.map((entry) => (
          <ContextMenu key={entry.ref}>
          <ContextMenuTrigger
            render={<div
            className={cn(
              "group flex items-center gap-1 rounded-md pr-1 pl-2 text-sm hover:bg-muted",
              coarse ? "min-h-11" : "min-h-7"
            )}
          />}
          >
            <span className="min-w-0 flex-1 truncate" title={`${entry.ref} — ${entry.message}`}>
              {entry.message}
            </span>
            {entry.at !== null && (
              <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                {shortAge(entry.at * 1000)}
              </span>
            )}
            <div
              className={cn(
                "flex shrink-0 items-center transition-opacity",
                !coarse && "opacity-0 group-hover:opacity-100 has-focus-visible:opacity-100"
              )}
            >
              <SmallAction
                label={`Apply ${entry.ref} and keep it`}
                icon={InboxDownloadIcon}
                disabled={writing}
                coarse={coarse}
                onClick={() => void act("apply", entry)}
              />
              <SmallAction
                label={`Pop ${entry.ref}`}
                icon={InboxUploadIcon}
                disabled={writing}
                coarse={coarse}
                onClick={() => void act("pop", entry)}
              />
              <SmallAction
                label={`Drop ${entry.ref}`}
                icon={Delete02Icon}
                disabled={writing}
                coarse={coarse}
                className="hover:text-destructive"
                onClick={() => void act("drop", entry)}
              />
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem disabled={writing} onClick={() => void act("apply", entry)}>Apply (keep the stash)</ContextMenuItem>
            <ContextMenuItem disabled={writing} onClick={() => void act("pop", entry)}>Pop</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" disabled={writing} onClick={() => void act("drop", entry)}>Drop…</ContextMenuItem>
          </ContextMenuContent>
          </ContextMenu>
        ))
      )}
    </Section>
  )
}

/* ── History ──
   The last few commits on this branch, so "did that commit land?" is a glance
   rather than a terminal. A row copies its hash, which is the one thing a
   reader wants out of a log and cannot get by looking. */
export function HistorySection({
  projectId,
  repo,
  open,
  onToggle,
  coarse,
  /** Bumped by the parent after a commit, so the list it invalidates is this
      one — the only event that changes a log while the panel is open. */
  generation,
  fixed,
  onSelect,
}: {
  fixed?: boolean
  /** Open a commit. Without it a row copies its hash, as it always did. */
  onSelect?: (commit: GitCommit) => void
  projectId: string
  repo: string
  open: boolean
  onToggle: () => void
  coarse: boolean
  generation: number
}) {
  const settings = useServer()
  /* "Load more" widens the window rather than paging: the graph's lanes are
     a walk over the whole list, and a second page would start mid-lane. */
  const [limit, setLimit] = React.useState(LOG_LIMIT)
  const list = useLazyList<GitCommit>(
    () => gitLog(settings, projectId, { limit, repo: repo || undefined }),
    open
  )
  const reload = list.reload
  const widened = React.useRef(false)
  React.useEffect(() => {
    if (!widened.current) {
      widened.current = true
      return
    }
    reload()
  }, [limit, reload])

  /* A commit landed. `generation` is the only thing that moves a log while the
     panel is open, and the first run is the mount — where the lazy read above
     is already the one that fetches. */
  const invalidate = list.invalidate
  const mounted = React.useRef(false)
  React.useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    invalidate()
  }, [generation, invalidate])

  const layout = idePrefs.use().historyLayout
  const copy = (commit: GitCommit) =>
    onSelect
      ? onSelect(commit)
      : void writeClipboard(commit.hash)
          .then(() => toast.success(`Copied ${commit.short}`))
          .catch((err: unknown) => toast.error(describeError(err).title))
  const hint = onSelect ? "Click to open" : "Click to copy the full hash"

  return (
    <Section
      fixed={fixed}
      title="History"
      count={null}
      open={open}
      onToggle={onToggle}
      onRefresh={list.reload}
      coarse={coarse}
      busy={list.busy}
      error={list.error}
      actions={
        /* A log read beside a running agent is usually "which line did that
           land on", which is what the lanes answer — so the picture is the
           default and the rows are the option, not the other way round. */
        <SmallAction
          label={layout === "graph" ? "Show as a list" : "Draw the lanes"}
          icon={layout === "graph" ? ListIcon : GitCommitVerticalIcon}
          onClick={() => setIdePref("historyLayout", layout === "graph" ? "list" : "graph")}
          coarse={coarse}
        />
      }
    >
      {list.items === null ? (
        <PanelRowsSkeleton rows={4} className="space-y-1.5 p-1" />
      ) : list.items.length === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">No commits yet.</p>
      ) : layout === "graph" ? (
        <div className="py-1 pr-1">
          <CommitGraph commits={list.items} onCopy={copy} coarse={coarse} hint={hint} />
        </div>
      ) : (
        list.items.map((commit) => (
          <button
            key={commit.hash}
            type="button"
            onClick={() => copy(commit)}
            title={`${commit.short} · ${commit.author} · ${new Date(commit.at * 1000).toLocaleString()}\n${commit.subject}\n${commit.filesChanged} files changed\n\n${hint}`}
            className={cn(
              "flex w-full items-center gap-2 rounded-md pr-1 pl-2 text-left text-sm hover:bg-muted",
              coarse ? "min-h-11" : "min-h-7"
            )}
          >
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {commit.short}
            </span>
            <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
            {commit.refs.length > 0 && (
              <Badge variant="outline" className="hidden max-w-24 shrink-0 truncate @panel-sm:inline-flex">
                {commit.refs[0]}
              </Badge>
            )}
            <span className="hidden shrink-0 font-mono text-xs tabular-nums @panel-sm:inline">
              <span className="text-success">+{commit.insertions}</span>{" "}
              <span className="text-destructive">−{commit.deletions}</span>
            </span>
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
              {shortAge(commit.at * 1000)}
            </span>
          </button>
        ))
      )}
      {list.items !== null && list.items.length >= limit && limit < LOG_MAX && (
        <Button
          variant="ghost"
          size="xs"
          className="mt-1 w-full text-muted-foreground"
          disabled={list.busy}
          onClick={() => setLimit((current) => Math.min(LOG_MAX, current + LOG_LIMIT))}
        >
          Load more
        </Button>
      )}
    </Section>
  )
}
